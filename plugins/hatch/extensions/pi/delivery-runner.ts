import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HatchBuildItemResult, HatchBuildItemRunner } from "./build-runner.ts";
import type { CheckConvergenceResult, HatchCheckPlanEntry } from "./check-convergence.ts";
import {
  environmentPreflight,
  formatCheckDiagnosis,
  type HatchCheckDiagnosis,
  type HatchEnvironmentFinding,
} from "./check-environment.ts";
import {
  validateRecoveredCompanionCommit,
  type HatchCompanionResult,
  type ProcessContext,
} from "./companion-runner.ts";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import { readEnvironmentConfig } from "./environment.ts";
import { deriveItemGitState, isItemMergeSubject } from "./git-state.ts";
import type { HatchIntegrationResult, HatchIntegrationRunner } from "./integration-runner.ts";
import { validateCandidateHooks, validateMergeHooks } from "./hook-runner.ts";
import { HatchProcessManager } from "./process-manager.ts";
import {
  safeProgress,
  type HatchRunEventCheck,
  type HatchRunProgress,
  type HatchWaveNext,
} from "./run-events.ts";
import { resolveHatchScript } from "./script-catalog.ts";
import type {
  HatchWaveFinalizationResult,
  HatchWaveRunner,
} from "./wave-runner.ts";
import { HatchBuildWorkerRunner } from "./worker-runner.ts";
import { WaveHostLedger } from "./wave-host-ledger.ts";

const exec = promisify(execFile);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;
/** Oracle types that run against the project's environment (deliver_preflight.py ENV_ORACLE_TYPES). */
const STATEFUL_ENV_ORACLES = new Set(["integration", "e2e", "visual"]);
const MAX_OUTPUT = 8 * 1024 * 1024;

export interface DeliveryItem extends Record<string, unknown> {
  id: string;
  depends_on: string[];
  surfaces: string[];
  serialize?: boolean;
  shared_resources?: string[];
}

/** A successor binder's top-level `supersedes`, shape-checked as validate_binder.py does. */
interface SupersedesSpec {
  slug: string;
  carried: string[];
  dropped: string[];
}

interface DeliveryDocument {
  slug: string;
  sme: string[];
  work_items: DeliveryItem[];
  supersedes?: SupersedesSpec;
}

/**
 * The successor-binder report, with the key names of deliver_preflight.py's `supersedes`
 * packet field, plus the predecessor's retirement commit.
 */
export interface HatchSupersedesReport {
  predecessor: string;
  predecessor_integration: { name: string; tip: string | null };
  carried: Record<string, Record<string, unknown>>;
  dropped: Record<string, string>;
  findings: string[];
  ok: boolean;
  archive?: { status: "already-archived" | "committed"; commit: string };
}

interface PreflightPacket {
  validator?: { exit_status?: number; output?: string };
  default_branch?: string | null;
  default_branch_error?: string | null;
  integration_base?: { ref?: string | null; sha?: string | null };
  supersedes?: HatchSupersedesReport | null;
  done_provenance?: Record<string, { ok?: boolean; checker_output?: string; first_parent_reachable?: boolean }>;
  halt?: boolean;
}

export interface HatchDeliveryWave {
  wave: number;
  items: string[];
  builds: HatchBuildItemResult[];
  integrations: HatchIntegrationResult[];
  finalization?: HatchWaveFinalizationResult;
}

/** One item that halted in this run, so a result reader need not dig through `waves`. */
export interface HatchDeliveryHalt {
  item: string;
  phase: "build" | "merge";
  status: string;
  reason: string;
  diagnosis?: HatchCheckDiagnosis;
}

export interface HatchDeliveryResult {
  schema: "hatch-delivery-v1";
  binder: string;
  status: "complete" | "blocked";
  integrationWorktree: string;
  waves: HatchDeliveryWave[];
  message: string;
  companions?: HatchCompanionResult;
  supersedes?: HatchSupersedesReport;
  halts?: HatchDeliveryHalt[];
  // Set when the environment preflight stopped the run before any build.
  environmentFinding?: HatchEnvironmentFinding;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during delivery`);
  }
}

async function updateRefsTransaction(cwd: string, commands: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, "update-ref", "--stdin"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(output.trim() || `git update-ref transaction failed (${code})`));
    });
    child.stdin.end(`start\n${commands.join("\n")}\nprepare\ncommit\n`);
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseBinder(raw: string, binder: string): DeliveryDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Hatch binder '${binder}' is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hatch binder '${binder}' is not an object`);
  }
  const document = value as { slug?: unknown; work_items?: unknown };
  if (document.slug !== binder || !Array.isArray(document.work_items)) {
    throw new Error(`Hatch binder '${binder}' has invalid identity or work_items`);
  }
  const ids = new Set<string>();
  // An oracle that needs a stateful environment the binder cannot isolate serializes
  // (skills/hatch-deliver/SKILL.md, deliver:env; deliver_preflight.py's stateful-env gate).
  const envContract = (value as { env_contract?: unknown }).env_contract;
  const supportsIsolation = Boolean(
    envContract && typeof envContract === "object" &&
      (envContract as { supports_isolation?: unknown }).supports_isolation === true,
  );
  const items = document.work_items.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Hatch binder '${binder}' contains a malformed work item`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.id !== "string" || !IDENTIFIER.test(item.id) || ids.has(item.id)) {
      throw new Error(`Hatch binder '${binder}' contains a duplicate or invalid item id`);
    }
    ids.add(item.id);
    const dependencies = item.depends_on ?? [];
    if (!Array.isArray(dependencies) || !dependencies.every((id) => typeof id === "string" && IDENTIFIER.test(id))) {
      throw new Error(`Hatch item '${item.id}' has invalid dependencies`);
    }
    const declared = Array.isArray(item.touches)
      ? item.touches
      : Array.isArray(item.files)
        ? item.files
        : [];
    const declaredSurfaces = declared.filter((path): path is string => typeof path === "string");
    const surfaces = declaredSurfaces.length > 0 ? [...new Set(declaredSurfaces)].sort() : ["*"];
    const oracleType = item.oracle && typeof item.oracle === "object"
      ? (item.oracle as { type?: unknown }).type
      : undefined;
    const statefulEnv = typeof oracleType === "string" &&
      STATEFUL_ENV_ORACLES.has(oracleType) && !supportsIsolation;
    const serialize = item.serialize === true || statefulEnv;
    const sharedResources = Array.isArray(item.shared_resources)
      ? [...new Set(
          item.shared_resources.filter(
            (resource): resource is string => typeof resource === "string",
          ),
        )].sort()
      : [];
    return {
      ...item,
      id: item.id,
      depends_on: [...dependencies] as string[],
      surfaces,
      serialize,
      shared_resources: sharedResources,
    };
  });
  for (const item of items) {
    for (const dependency of item.depends_on) {
      if (!ids.has(dependency) || dependency === item.id) {
        throw new Error(`Hatch item '${item.id}' has an unknown or self dependency '${dependency}'`);
      }
    }
  }
  const sme = (value as { sme?: unknown }).sme ?? [];
  if (!Array.isArray(sme) || !sme.every((id) => typeof id === "string" && IDENTIFIER.test(id))) {
    throw new Error(`Hatch binder '${binder}' has invalid sme pins`);
  }
  const supersedes = parseSupersedes((value as { supersedes?: unknown }).supersedes, binder, ids);
  return {
    slug: binder,
    sme: [...new Set(sme)] as string[],
    work_items: items,
    ...(supersedes ? { supersedes } : {}),
  };
}

/** The same cross-reference rules, and wording, as validate_binder.py's supersedes check. */
function parseSupersedes(raw: unknown, binder: string, ids: Set<string>): SupersedesSpec | undefined {
  if (raw === undefined) return undefined;
  const identifiers = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((id) => typeof id === "string" && IDENTIFIER.test(id));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Hatch binder '${binder}' has a malformed supersedes`);
  }
  const value = raw as { slug?: unknown; carried?: unknown; dropped?: unknown };
  const extra = Object.keys(value).filter((key) => !["slug", "carried", "dropped"].includes(key));
  if (
    typeof value.slug !== "string" ||
    !IDENTIFIER.test(value.slug) ||
    !identifiers(value.carried) ||
    value.carried.length === 0 ||
    (value.dropped !== undefined && !identifiers(value.dropped)) ||
    extra.length > 0
  ) {
    throw new Error(`Hatch binder '${binder}' has a malformed supersedes`);
  }
  const dropped = (value.dropped as string[] | undefined) ?? [];
  if (value.slug === binder) {
    throw new Error("supersedes: a binder cannot supersede its own slug");
  }
  for (const id of value.carried) {
    if (!ids.has(id)) throw new Error(`supersedes: carried id '${id}' is not a work item of this binder`);
  }
  for (const id of value.carried) {
    if (dropped.includes(id)) throw new Error(`supersedes: id '${id}' is both carried and dropped`);
  }
  return { slug: value.slug, carried: [...new Set(value.carried)], dropped: [...new Set(dropped)] };
}

/** Why a successor's preflight packet is a stop, or undefined when it may proceed. */
function successorHalt(packet: PreflightPacket, planned: SupersedesSpec): string | undefined {
  const reasons: string[] = [];
  if (packet.validator?.exit_status !== 0) {
    reasons.push(`binder validation failed: ${packet.validator?.output ?? "no validator output"}`);
  }
  if (packet.default_branch_error) reasons.push(packet.default_branch_error);
  const report = packet.supersedes;
  if (!report) {
    if (reasons.length === 0) reasons.push("preflight returned no supersedes report for a successor binder");
  } else {
    reasons.push(...report.findings);
    for (const [id, record] of Object.entries(report.carried)) {
      if (record.ok === true) continue;
      const detail = typeof record.finding === "string"
        ? record.finding
        : record.first_parent_reachable === false
          ? `refs/hatch/${report.predecessor}/item-${id}/done is not first-parent reachable on ${report.predecessor_integration.name}`
          : String(record.checker_output ?? "provenance check failed");
      reasons.push(`carried item '${id}': ${detail}`);
    }
    if (
      report.predecessor !== planned.slug ||
      !sameStrings(Object.keys(report.carried), planned.carried)
    ) {
      reasons.push("the preflight supersedes report disagrees with the binder's supersedes");
    }
    if (reasons.length === 0 && !report.ok) reasons.push("the successor's carried work is unproven");
  }
  for (const [id, record] of Object.entries(packet.done_provenance ?? {})) {
    if (record.ok !== true) {
      reasons.push(`done ref for '${id}' failed provenance: ${record.checker_output ?? "not first-parent reachable"}`);
    }
  }
  if (reasons.length === 0 && packet.halt) reasons.push("preflight set halt");
  return reasons.length > 0 ? reasons.join("; ") : undefined;
}

/**
 * The halt for a wave build that produced no mergeable checkpoint. An empty build is
 * either a whiff (re-dispatch) or a change already on the base (a plan change through a
 * per docs/how-to/binder-repair.md, with the oracle receipt as its evidence); neither writes a completion ref.
 * A blocked or failed build's reason comes from buildHaltReason; this text is its fallback.
 */
function buildHaltMessage(item: string, status: string): string {
  if (status === "already-present") {
    return (
      `Item '${item}' is already present on the base: its diff against the merge base is empty ` +
      "and its oracle passes on HEAD, so there is nothing to build or merge and no done ref was written. " +
      "The way forward is a plan change per docs/how-to/binder-repair.md: a successor binder that drops " +
      "or amends the item when other items are done, or withdrawing the binder when none is. " +
      "The oracle receipt in the build result is the evidence for " +
      "that decision, and it is only as strong as the item's oracle."
    );
  }
  if (status === "no-change") {
    return (
      `Item '${item}' produced no change, and its work is not proven present on the base; ` +
      "no completion ref was written. Re-dispatch the item's worker."
    );
  }
  return `Item '${item}' did not produce a mergeable built checkpoint (${status}).`;
}

/** Build statuses that leave no mergeable checkpoint; every other status is merged serially. */
const BUILD_HALT_STATUSES = ["failed", "blocked", "no-change", "already-present"];

interface DeferredItem {
  status: string;
  message: string;
}

/**
 * The reason recorded for an item whose build halted. A blocked build carries the
 * worker's own words; a failed build carries the host's message plus the gate findings
 * that capped it, in the same shape as a merge-time failure; an empty build keeps its
 * specific text.
 */
function buildHaltReason(build: HatchBuildItemResult): string {
  const detail = build.message?.trim();
  const checkFailure = build.finalization?.checkFailure;
  if (build.status === "failed") {
    const reason = haltReasonWithFindings(build.message ?? "", checkFailure, [build.finalization?.verification]);
    if (reason.trim()) return reason;
  }
  // A blocked build is how a failing floor, oracle, or setup check halts, so its
  // diagnosis follows the message here too.
  if (build.status === "blocked" && detail) return haltReasonWithFindings(detail, checkFailure, []);
  return buildHaltMessage(build.item, build.status);
}

/** The diagnosis of a halted check, when the convergence carries one. */
function checkDiagnosis(checkFailure: CheckConvergenceResult | undefined): HatchCheckDiagnosis | undefined {
  return checkFailure && checkFailure.status !== "stable" ? checkFailure.diagnosis : undefined;
}

function withCheck(check: HatchRunEventCheck | undefined): { check?: HatchRunEventCheck } {
  return check ? { check } : {};
}

function haltRecord(
  item: string,
  phase: HatchDeliveryHalt["phase"],
  status: string,
  reason: string,
  checkFailure: CheckConvergenceResult | undefined,
): HatchDeliveryHalt {
  const diagnosis = checkDiagnosis(checkFailure);
  return { item, phase, status, reason, ...(diagnosis ? { diagnosis } : {}) };
}

/** The structured check an `item-halted` event carries, from a halted check's diagnosis. */
function eventCheck(diagnosis: HatchCheckDiagnosis | undefined): HatchRunEventCheck | undefined {
  if (!diagnosis) return undefined;
  return {
    id: diagnosis.checkId,
    command: diagnosis.command,
    exitCode: diagnosis.exitCode,
    excerpt: diagnosis.excerpt,
    ...(diagnosis.remediation ? { remediation: diagnosis.remediation } : {}),
  };
}

/**
 * The aggregate stop for a run whose remaining frontier is held by items halted in this
 * run: each halted item with its status and reason, what landed, and what stalls behind them.
 */
function deferredHaltMessage(
  items: DeliveryItem[],
  deferred: Map<string, DeferredItem>,
  landedThisRun: readonly string[],
  done: (item: string) => boolean,
): string {
  const halted = [...deferred].filter(([item]) => !done(item));
  // An item that landed and was later rolled back has lost its done ref, so the
  // done check keeps the list to what is on the integration tip now.
  const landed = [...new Set(landedThisRun)].filter((item) => done(item));
  const blocked = new Set(halted.map(([item]) => item));
  const waiting: string[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (blocked.has(item.id) || done(item.id)) continue;
      if (item.depends_on.some((dependency) => blocked.has(dependency))) {
        blocked.add(item.id);
        waiting.push(item.id);
        grew = true;
      }
    }
  }
  return [
    ...halted.map(([item, value]) => `${item} (${value.status}): ${value.message}`),
    `landed: ${landed.length > 0 ? landed.join(", ") : "none"}`,
    `stalled behind them: ${waiting.length > 0 ? waiting.join(", ") : "none"}`,
  ].join("\n");
}

/** The finding text of a failed merge-time integration, bounded for a prompt. */
function integrationHaltReason(result: HatchIntegrationResult): string {
  return haltReasonWithFindings(result.message, result.checkFailure, [
    result.verification,
    result.safetyVerification,
  ]);
}

const HALT_REASON_LIMIT = 1_500;
// The environment preflight's prompt title keeps this much of the finding.
const PREFLIGHT_TITLE_LIMIT = 700;

function clipText(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
const DIAGNOSIS_BUDGET = 700;

/**
 * A halt message, then the failing check's diagnosis and any project remediation, then
 * every gate finding of the given verifications, bounded for a prompt. The diagnosis
 * keeps its own budget and comes before the findings, so findings give way first.
 */
function haltReasonWithFindings(
  message: string,
  checkFailure: CheckConvergenceResult | undefined,
  verifications: (HatchIntegrationResult["verification"] | undefined)[],
): string {
  const halted = checkFailure && checkFailure.status !== "stable" ? checkFailure : undefined;
  const diagnosis = halted?.diagnosis ? formatCheckDiagnosis(halted.diagnosis, DIAGNOSIS_BUDGET) : "";
  // The project's own on_unavailable text, set only on precondition-unmet; the
  // diagnosis's remediation (install guidance) is already inside its block.
  const projectRemediation = halted?.remediation?.trim()
    ? `Project remediation: ${halted.remediation.trim()}`.slice(0, 300)
    : "";
  const findings = verifications
    .flatMap((verification) => Object.values(verification?.gates ?? {}))
    .flatMap(
      (gate) =>
        (gate as { findings?: { severity?: string; code?: string; message?: string }[] } | undefined)
          ?.findings ?? [],
    )
    // The severity leads each finding: advisory and blocking must not read the same at
    // the halt, where the human decides whether to fix, accept, or defer.
    .map((finding) =>
      `[${finding.severity ?? "unknown"}] ${finding.code ?? "finding"}: ${finding.message ?? ""}`.trim(),
    );
  // With a diagnosis present the message gets what the diagnosis and remediation leave,
  // so a long verbatim command in the message cannot push the diagnosis out.
  const room = HALT_REASON_LIMIT - diagnosis.length - projectRemediation.length - 2;
  const text = message.trim();
  const lead = diagnosis && text.length > room ? `${text.slice(0, Math.max(0, room - 3))}...` : text;
  const head = [lead, diagnosis, projectRemediation].filter(Boolean).join("\n");
  const reason = [head, findings.join(" ")].filter(Boolean).join("\n").trim();
  return reason.length > HALT_REASON_LIMIT ? `${reason.slice(0, HALT_REASON_LIMIT - 3)}...` : reason;
}

function supersedesReport(packet: PreflightPacket): HatchSupersedesReport | undefined {
  const report = packet.supersedes;
  if (!report) return undefined;
  return {
    predecessor: report.predecessor,
    predecessor_integration: report.predecessor_integration,
    carried: report.carried,
    dropped: report.dropped,
    findings: report.findings,
    ok: report.ok,
  };
}

function splitNul(output: string): string[] {
  return output.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort());
}

function worktreeMap(porcelain: string): Map<string, string> {
  const result = new Map<string, string>();
  let path: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line.startsWith("branch ") && path) result.set(line.slice("branch ".length), path);
    if (!line) path = undefined;
  }
  return result;
}

/** Every worktree path in the listing, including ones sitting on a detached HEAD. */
function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/**
 * How many items of one wave may build at the same time.
 *
 * A collision batch is every dependency-ready item whose `touches` do not overlap, which
 * for a wide or thinly-declared binder can be most of the binder. Starting them all at once
 * is a burst against the model provider and against the machine — the same hazard the
 * project's own fan-out discipline works in waves to avoid — so the batch is still admitted
 * in dependency order but built with a bounded number of workers.
 */
export const MAX_PARALLEL_BUILDS = 4;

/** Run `fn` over `items` with at most `limit` calls in flight, preserving result order. */
export async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function collisionBatch(items: DeliveryItem[]): DeliveryItem[] {
  const selected: DeliveryItem[] = [];
  const occupied = new Set<string>();
  for (const item of items) {
    const resources = Array.isArray(item.shared_resources)
      ? item.shared_resources.filter((resource): resource is string => typeof resource === "string")
      : [];
    // A serialize item (and a wildcard item) runs alone: when it is not first in
    // this batch it waits for a later wave rather than sharing a batch.
    if (item.serialize === true || item.surfaces.includes("*")) {
      if (selected.length === 0) return [item];
      continue;
    }
    if (
      occupied.has("*") ||
      item.surfaces.some((surface) => occupied.has(surface)) ||
      resources.some((resource) => occupied.has(`\0resource\0${resource}`))
    ) continue;
    selected.push(item);
    item.surfaces.forEach((surface) => occupied.add(surface));
    resources.forEach((resource) => occupied.add(`\0resource\0${resource}`));
  }
  return selected;
}

interface CompanionRunner {
  finishDelivery(
    ctx: ExtensionContext,
    binder: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    processContext: { manager: HatchProcessManager; owner: { id: string; binder: string; cwd: string } },
    options: { diffBase: string; sme: string[] },
  ): Promise<HatchCompanionResult>;
}

export class HatchDeliveryRunner {
  readonly #locks: DispatchLockManager;
  readonly #processes: HatchProcessManager;
  readonly #builds: HatchBuildItemRunner;
  readonly #integrations: HatchIntegrationRunner;
  readonly #workers: HatchBuildWorkerRunner;
  readonly #waves: HatchWaveRunner;
  readonly #companions: CompanionRunner;

  constructor(
    locks: DispatchLockManager,
    processes: HatchProcessManager,
    builds: HatchBuildItemRunner,
    integrations: HatchIntegrationRunner,
    workers: HatchBuildWorkerRunner,
    waves: HatchWaveRunner,
    companions: CompanionRunner,
  ) {
    this.#locks = locks;
    this.#processes = processes;
    this.#builds = builds;
    this.#integrations = integrations;
    this.#workers = workers;
    this.#waves = waves;
    this.#companions = companions;
  }

  async #recoverableCompanionCommit(
    worktree: string,
    binder: string,
    commit: string,
    parent: string,
    subject: string,
    processContext: ProcessContext,
  ): Promise<boolean> {
    const changed = splitNul(await git(worktree, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      parent,
      commit,
    ]));
    if (subject === `docs: gardner ${binder}`) {
      return validateRecoveredCompanionCommit({
        worktree,
        binder,
        writer: "doc-gardner",
        parent,
        commit,
        processContext,
      });
    }
    if (subject.startsWith("kaizen: ")) {
      return validateRecoveredCompanionCommit({
        worktree,
        binder,
        writer: "kaizen",
        parent,
        commit,
        processContext,
      });
    }
    const retired = subject.match(
      new RegExp(`^chore\\(hatch\\): archive binder ([a-z0-9][a-z0-9-]*) — superseded by ${binder}$`),
    )?.[1];
    if (!retired && subject !== `chore(hatch): archive binder ${binder} — delivered`) return false;
    const live = `.hatch/binders/${retired ?? binder}.json`;
    const archived = `.hatch/binders/archive/${retired ?? binder}.json`;
    if (!sameStrings(changed, [live, archived])) return false;
    const [oldBlob, newBlob] = await Promise.all([
      git(worktree, ["rev-parse", `${parent}:${live}`]),
      git(worktree, ["rev-parse", `${commit}:${archived}`]),
    ]);
    return oldBlob === newBlob;
  }

  /**
   * Run deliver_preflight.py, the script the other runtimes deliver from, rather than
   * re-deriving its successor rules here. A spawn failure, a nonzero exit, or output that
   * is not a packet is a stop: a delivery that cannot prove inheritance must not guess.
   */
  async #preflight(repoRoot: string, binderPath: string): Promise<PreflightPacket> {
    const environment = { ...process.env };
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    environment.PYTHONNOUSERSITE = "1";
    environment.PYTHONSAFEPATH = "1";
    let stdout: string;
    try {
      ({ stdout } = await exec(
        "uv",
        ["run", "--script", resolveHatchScript("deliverPreflight"), "--binder", binderPath, "--repo", repoRoot],
        { cwd: repoRoot, encoding: "utf8", env: environment, maxBuffer: MAX_OUTPUT, timeout: 600_000 },
      ));
    } catch (error) {
      const failure = error as { stderr?: string; stdout?: string; message?: string };
      throw new Error(
        `Hatch successor preflight failed to run: ${(failure.stderr || failure.stdout || failure.message || "").trim()}`,
      );
    }
    try {
      const packet = JSON.parse(stdout) as unknown;
      if (!packet || typeof packet !== "object" || Array.isArray(packet)) throw new Error("not an object");
      return packet as PreflightPacket;
    } catch {
      throw new Error("Hatch successor preflight did not print a JSON packet");
    }
  }

  /**
   * The committed binder a run is about to deliver, read before any worktree exists: from
   * the integration branch when it exists, else from the checkout's HEAD, which is where a
   * first run branches from. A binder that is missing or unreadable here is left for the
   * existing integration-worktree read to report.
   */
  async #plannedBinder(repoRoot: string, binder: string, integrationExists: boolean): Promise<DeliveryDocument | undefined> {
    const source = integrationExists ? `refs/heads/hatch/${binder}/integration` : "HEAD";
    for (const path of [`.hatch/binders/${binder}.json`, `.hatch/binders/archive/${binder}.json`]) {
      const raw = await git(repoRoot, ["show", `${source}:${path}`]).catch(() => undefined);
      if (raw !== undefined) return parseBinder(raw, binder);
    }
    return undefined;
  }

  /**
   * A successor's first run: start the integration branch at the predecessor's tip, then
   * merge the default branch in with --no-ff so the successor binder's own commit is
   * present, exactly as the deliver skill does. The merge is validated through the
   * repository's merge hooks and the branch ref is created once, at the finished commit.
   */
  async #createSuccessorBranch(
    ctx: ExtensionContext,
    repoRoot: string,
    binder: string,
    predecessor: string,
    packet: PreflightPacket,
    processContext: ProcessContext,
  ): Promise<string | undefined> {
    const predecessorTip = packet.integration_base?.sha;
    const defaultBranch = packet.default_branch;
    if (packet.integration_base?.ref !== `hatch/${predecessor}/integration` || !predecessorTip || !defaultBranch) {
      return `Preflight named no predecessor integration tip and default branch to start ${binder} from.`;
    }
    const defaultTip = await git(repoRoot, ["rev-parse", `refs/heads/${defaultBranch}^{commit}`]);
    // The successor binder reaches its integration branch only through the merge of the
    // default branch, as the deliver skill's first-run step says. A binder committed
    // anywhere else would leave a branch with no binder, which no later run can read.
    const binderPath = `.hatch/binders/${binder}.json`;
    const [committed, onDefault] = await Promise.all([
      git(repoRoot, ["rev-parse", `HEAD:${binderPath}`]).catch(() => undefined),
      git(repoRoot, ["rev-parse", `${defaultTip}:${binderPath}`]).catch(() => undefined),
    ]);
    if (!committed || committed !== onDefault) {
      return `Successor binder '${binder}' is not committed on the default branch '${defaultBranch}'. ` +
        `Its first run starts from hatch/${predecessor}/integration and merges ${defaultBranch} in to bring the binder, ` +
        `so commit the binder on ${defaultBranch} (or set git config hatch.defaultBranch) before delivering.`;
    }
    let start = predecessorTip;
    const upToDate = await git(repoRoot, ["merge-base", "--is-ancestor", defaultTip, predecessorTip])
      .then(() => true, () => false);
    if (!upToDate) {
      let tree: string;
      try {
        tree = (await git(repoRoot, ["merge-tree", "--write-tree", predecessorTip, defaultTip])).split("\n", 1)[0];
      } catch {
        return `Merging ${defaultBranch} into hatch/${predecessor}/integration conflicts; resolve it before delivering ${binder}.`;
      }
      const message = `Merge branch '${defaultBranch}' into hatch/${binder}/integration`;
      const hooks = await validateMergeHooks({
        worktree: repoRoot,
        integrationTip: predecessorTip,
        itemTip: defaultTip,
        candidateTree: tree,
        message,
        signal: ctx.signal,
        onProcessStart: (pid) => processContext.manager.registerProcess(pid, {
          cwd: repoRoot,
          parentId: processContext.owner.id,
          label: "successor default-branch merge hooks",
        }),
        onProcessExit: (pid) => processContext.manager.forgetProcess(pid),
      });
      if (hooks.status !== "passed") {
        return `Repository merge hooks failed or changed the ${defaultBranch} merge for ${binder}.`;
      }
      start = await git(repoRoot, [
        "commit-tree",
        tree,
        "-p",
        predecessorTip,
        "-p",
        defaultTip,
        "-m",
        hooks.message ?? message,
      ]);
    }
    if (await git(repoRoot, ["rev-parse", `${start}:${binderPath}`]).catch(() => undefined) !== committed) {
      return `The ${defaultBranch} merge for '${binder}' does not carry the committed successor binder.`;
    }
    const format = await git(repoRoot, ["rev-parse", "--show-object-format"]);
    await git(repoRoot, [
      "update-ref",
      `refs/heads/hatch/${binder}/integration`,
      start,
      "0".repeat(format === "sha256" ? 64 : 40),
    ]);
    return undefined;
  }

  /**
   * Retire the predecessor exactly once with the sanctioned archive move, committed on the
   * successor's integration branch. Idempotent: a branch that already carries the archive
   * path and not the live one is reported, never moved again.
   */
  async #retirePredecessor(
    ctx: ExtensionContext,
    binder: string,
    predecessor: string,
    integrationWorktree: string,
    processContext: ProcessContext,
  ): Promise<{ status: "already-archived" | "committed"; commit: string }> {
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const base = await git(integrationWorktree, ["rev-parse", `${integrationRef}^{commit}`]);
    const live = `.hatch/binders/${predecessor}.json`;
    const archived = `.hatch/binders/archive/${predecessor}.json`;
    const present = (path: string) =>
      git(integrationWorktree, ["cat-file", "-e", `${base}:${path}`]).then(() => true, () => false);
    const [liveAt, archivedAt] = await Promise.all([present(live), present(archived)]);
    if (!liveAt) {
      if (!archivedAt) throw new Error(`Hatch predecessor binder '${predecessor}' is missing from live and archive paths`);
      const commit = await git(integrationWorktree, [
        "log", "-1", "--format=%H", "--diff-filter=A", integrationRef, "--", archived,
      ]);
      return { status: "already-archived", commit: commit || base };
    }
    if (archivedAt) throw new Error(`Hatch predecessor binder '${predecessor}' is at both live and archive paths`);
    const root = await mkdtemp(join(tmpdir(), "hatch-retire-"));
    const worktree = join(root, "worktree");
    let registered = false;
    try {
      await git(integrationWorktree, ["worktree", "add", "--detach", worktree, base]);
      registered = true;
      await mkdir(join(worktree, ".hatch", "binders", "archive"), { recursive: true });
      await git(worktree, ["mv", live, archived]);
      const tree = await git(worktree, ["write-tree"]);
      const message = `chore(hatch): archive binder ${predecessor} — superseded by ${binder}`;
      const hooks = await validateCandidateHooks({
        worktree,
        parent: base,
        candidateTree: tree,
        message,
        signal: ctx.signal,
        onProcessStart: (pid) => processContext.manager.registerProcess(pid, {
          cwd: worktree,
          parentId: processContext.owner.id,
          label: "predecessor archive hooks",
        }),
        onProcessExit: (pid) => processContext.manager.forgetProcess(pid),
      });
      if (hooks.status !== "passed" || hooks.hookTree !== tree) {
        throw new Error("Hatch predecessor archive hooks failed or changed the exact move tree");
      }
      const refined = hooks.message ?? message;
      if (refined.split("\n", 1)[0] !== message) throw new Error("Hatch predecessor archive hook changed the required subject");
      const commit = await git(worktree, ["commit-tree", tree, "-p", base, "-m", refined]);
      const changed = splitNul(await git(worktree, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", base, commit]));
      const [oldBlob, newBlob] = await Promise.all([
        git(worktree, ["rev-parse", `${base}:${live}`]),
        git(worktree, ["rev-parse", `${commit}:${archived}`]),
      ]);
      if (!sameStrings(changed, [live, archived]) || oldBlob !== newBlob) {
        throw new Error("Hatch predecessor archive is not an exact move");
      }
      await git(integrationWorktree, ["update-ref", integrationRef, commit, base]);
      await git(integrationWorktree, ["read-tree", "--reset", "-u", commit]);
      return { status: "committed", commit };
    } finally {
      if (registered) await git(integrationWorktree, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }

  async #ensureIntegrationWorktree(
    repoRoot: string,
    binder: string,
    processContext: ProcessContext,
  ): Promise<string> {
    const branchRef = `refs/heads/hatch/${binder}/integration`;
    const root = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
    const expected = resolve(root, `hatch-${binder}-integration`);
    await mkdir(root, { recursive: true });
    const registered = worktreeMap(await git(repoRoot, ["worktree", "list", "--porcelain"])).get(branchRef);
    if (registered && resolve(registered) !== expected) {
      throw new Error(`Hatch integration branch is checked out in a foreign worktree: ${registered}`);
    }
    if (!registered) {
      if (await exists(expected)) throw new Error(`Hatch refuses to clobber integration path: ${expected}`);
      const branchExists = await git(repoRoot, ["show-ref", "--verify", "--quiet", branchRef])
        .then(() => true)
        .catch(() => false);
      await git(
        repoRoot,
        branchExists
          ? ["worktree", "add", expected, `hatch/${binder}/integration`]
          : ["worktree", "add", "-b", `hatch/${binder}/integration`, expected, "HEAD"],
      );
    }
    const [branch, unstaged, untracked, indexTree, headTree] = await Promise.all([
      git(expected, ["branch", "--show-current"]),
      git(expected, ["diff", "--quiet", "--no-ext-diff", "--"]).then(() => true).catch(() => false),
      git(expected, ["ls-files", "--others", "--exclude-standard", "-z"]),
      git(expected, ["write-tree"]),
      git(expected, ["rev-parse", "HEAD^{tree}"]),
    ]);
    if (branch !== `hatch/${binder}/integration` || !unstaged || untracked) {
      throw new Error(
        `Hatch refuses to alter a dirty or foreign integration worktree (branch=${branch}, unstagedClean=${unstaged}, untracked=${Boolean(untracked)})`,
      );
    }
    if (indexTree !== headTree) {
      const parents = (await git(expected, ["rev-list", "--parents", "-n", "1", "HEAD"]))
        .split(/\s+/).slice(1);
      const subject = await git(expected, ["show", "-s", "--format=%s", "HEAD"]);
      const baseTags = (await git(expected, [
        "for-each-ref",
        "--format=%(objectname)",
        `refs/tags/hatch/${binder}/wave-*-base`,
      ])).split("\n").filter(Boolean);
      const recoverableTrees = new Set<string>();
      if (parents[0]) recoverableTrees.add(await git(expected, ["rev-parse", `${parents[0]}^{tree}`]));
      for (const tag of baseTags) {
        recoverableTrees.add(await git(expected, ["rev-parse", `${tag}^{tree}`]));
      }
      const recoverableMerge =
        parents.length === 2 &&
        recoverableTrees.has(indexTree) &&
        isItemMergeSubject(subject);
      const recoverableCompanion =
        parents.length === 1 &&
        indexTree === await git(expected, ["rev-parse", `${parents[0]}^{tree}`]) &&
        await this.#recoverableCompanionCommit(
          expected,
          binder,
          "HEAD",
          parents[0],
          subject,
          processContext,
        );
      if (!recoverableMerge && !recoverableCompanion) {
        throw new Error("Hatch integration index differs from HEAD outside a recoverable ref-first transaction");
      }
      await git(expected, ["read-tree", "--reset", "-u", "HEAD"]);
    }
    return expected;
  }

  /**
   * The environment preflight over committed bytes: every item not yet done, its oracle
   * resolved against `source`'s tree and `.hatch/environment.json`. A lockfile counts by
   * existence (`git cat-file -e`), so its size never matters; a file whose content cannot
   * be read counts as absent, since the rule only decides whether to ask. A malformed
   * environment file throws, failing closed before any build.
   */
  async #environmentPreflight(
    repoRoot: string,
    binder: string,
    items: DeliveryItem[],
    source: string,
  ): Promise<HatchEnvironmentFinding | undefined> {
    const pending: DeliveryItem[] = [];
    for (const item of items) {
      if ((await deriveItemGitState(repoRoot, binder, item.id)).state !== "done") pending.push(item);
    }
    if (pending.length === 0) return undefined;
    const config = await readEnvironmentConfig(repoRoot, source);
    const fileExists = async (path: string): Promise<boolean> => {
      try {
        await exec("git", ["-C", repoRoot, "cat-file", "-e", `${source}:${path}`]);
        return true;
      } catch {
        return false;
      }
    };
    return environmentPreflight(
      pending,
      config,
      async (path) => {
        if (!await fileExists(path)) return undefined;
        try {
          const { stdout } = await exec("git", ["-C", repoRoot, "show", `${source}:${path}`], {
            encoding: "utf8",
            maxBuffer: MAX_OUTPUT,
          });
          return stdout;
        } catch {
          return undefined;
        }
      },
      fileExists,
    );
  }

  /**
   * Every worktree this binder owns, found by branch ref *or* by the path the runner gives it.
   * Matching on the ref alone misses a worktree left detached by an interrupted operation —
   * which is precisely the one that would later trip `#ensureIntegrationWorktree`.
   */
  async #ownedWorktrees(repoRoot: string, binder: string): Promise<{ path: string; dirty: boolean }[]> {
    const worktreesRoot = resolve(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
    const ownedByPath = (candidate: string): boolean => {
      const path = resolve(candidate);
      return (
        path === join(worktreesRoot, `hatch-${binder}-integration`) ||
        path.startsWith(join(worktreesRoot, `hatch-${binder}-item-`))
      );
    };
    const ownedByRef = (ref: string): boolean =>
      ref === `refs/heads/hatch/${binder}/integration` ||
      ref.startsWith(`refs/heads/hatch/${binder}/item-`);
    const porcelain = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    const paths = new Set<string>([
      ...worktreePaths(porcelain).filter(ownedByPath),
      ...[...worktreeMap(porcelain).entries()]
        .filter(([ref]) => ownedByRef(ref))
        .map(([, path]) => path),
    ]);
    const found: { path: string; dirty: boolean }[] = [];
    for (const path of paths) found.push({ path, dirty: await this.#dirty(path) });
    return found;
  }

  async #dirty(path: string): Promise<boolean> {
    if (!await exists(path)) return false;
    try {
      return (await git(path, ["status", "--porcelain"])).trim() !== "";
    } catch {
      // Unreadable is not the same as clean: never force-remove a worktree we could not read.
      return true;
    }
  }

  async #tryClear(cwd: string, args: string[]): Promise<boolean> {
    try {
      await git(cwd, args);
      return true;
    } catch {
      // A ref or a worktree that is already gone is not a failure to clear; the re-read after
      // the sweep is what decides whether clearing actually worked.
      return false;
    }
  }

  /**
   * Doctrine: leftovers from an earlier run are never resumed or cleared silently — the human
   * chooses. Clearing removes the wave tags, the item state refs, the item branches, and the
   * integration branch with its worktrees, so the run below starts from wave 1 with nothing
   * remembered.
   *
   * `discardDirty` is the human's informed consent. With it false, a worktree holding uncommitted
   * work stops the clear instead of losing that work; the caller discloses the dirty worktrees in
   * the prompt, so this is the safety net for one that turns dirty between the prompt and the
   * sweep. It used to run `worktree remove --force` unconditionally, which deleted uncommitted
   * work without saying so, destroyed it before the survivor check could fail, and left a
   * detached worktree invisible to that check entirely.
   */
  async #clearDelivery(repoRoot: string, binder: string, discardDirty: boolean): Promise<string[]> {
    if (!discardDirty) {
      for (const worktree of await this.#ownedWorktrees(repoRoot, binder)) {
        if (worktree.dirty) {
          throw new Error(
            `Hatch refuses to clear ${worktree.path}: it holds uncommitted work. Commit, stash, or remove it, then clear again.`,
          );
        }
      }
    }
    const removed: string[] = [];
    // A branch cannot be deleted while a worktree still has it checked out.
    for (const worktree of await this.#ownedWorktrees(repoRoot, binder)) {
      const force = worktree.dirty ? ["--force"] : [];
      if (await this.#tryClear(repoRoot, ["worktree", "remove", ...force, worktree.path])) {
        removed.push(worktree.path);
      }
    }
    await this.#tryClear(repoRoot, ["worktree", "prune"]);
    const patterns = [
      `refs/tags/hatch/${binder}/`,
      `refs/hatch/${binder}/`,
      `refs/heads/hatch/${binder}/`,
    ];
    const refs = (await git(repoRoot, ["for-each-ref", "--format=%(refname)", ...patterns]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const ref of refs) {
      if (await this.#tryClear(repoRoot, ["update-ref", "-d", ref])) removed.push(ref);
    }
    // Verify both halves. A sweep that leaves a worktree behind still deletes the branch ref,
    // reports success, and then wedges the next run on `Hatch refuses to clobber integration path`.
    const refSurvivors = (await git(repoRoot, ["for-each-ref", "--format=%(refname)", ...patterns]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const worktreeSurvivors = (await this.#ownedWorktrees(repoRoot, binder)).map((worktree) => worktree.path);
    if (refSurvivors.length > 0 || worktreeSurvivors.length > 0) {
      throw new Error(
        `Hatch could not clear the earlier run's state: ${[...refSurvivors, ...worktreeSurvivors].join(", ")}`,
      );
    }
    return removed;
  }

  /** Swap an item's built ref for a failed ref at the same tip, atomically. */
  async #markIntegrationFailed(
    repoRoot: string,
    binder: string,
    item: string,
    itemTip: string,
  ): Promise<void> {
    const root = `refs/hatch/${binder}/item-${item}`;
    await updateRefsTransaction(repoRoot, [
      `delete ${root}/built ${itemTip}`,
      `create ${root}/failed ${itemTip}`,
    ]);
  }

  async #ensureItemWorktree(repoRoot: string, binder: string, item: string): Promise<string> {
    const branchRef = `refs/heads/hatch/${binder}/item-${item}`;
    const registered = worktreeMap(await git(repoRoot, ["worktree", "list", "--porcelain"])).get(branchRef);
    if (registered) return resolve(registered);
    const root = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
    const expected = resolve(root, `hatch-${binder}-item-${item}`);
    await mkdir(root, { recursive: true });
    if (await exists(expected)) throw new Error(`Hatch refuses to clobber item path: ${expected}`);
    await git(repoRoot, ["worktree", "add", expected, `hatch/${binder}/item-${item}`]);
    return expected;
  }

  async #deliveryBase(repoRoot: string, binder: string): Promise<string> {
    // The earliest wave base is the delivery's start. Sort the wave-*-base tags by
    // wave NUMBER, not refname — lexical order puts wave-10-base before wave-2-base.
    const bases = (await git(repoRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `refs/tags/hatch/${binder}/wave-*-base`,
    ])).split("\n").filter(Boolean).map((line) => {
      const [ref, object] = line.split(" ");
      return { object, wave: Number(ref.match(/\/wave-(\d+)-base$/)?.[1] ?? Infinity) };
    }).sort((left, right) => left.wave - right.wave);
    if (bases[0]) return bases[0].object;
    // Degenerate fallback (no wave tags): the integration branch's root. Take the
    // first of a multi-root history rather than crashing the delivery.
    const roots = (await git(repoRoot, [
      "rev-list",
      "--max-parents=0",
      `refs/heads/hatch/${binder}/integration`,
    ])).split("\n").filter(Boolean);
    if (roots.length === 0) throw new Error("Hatch cannot derive one delivery diff base");
    return roots[0];
  }

  async #pendingWaveAnchor(
    repoRoot: string,
    binder: string,
  ): Promise<{ binder: string; wave: number; base: string; baseTag: string } | undefined> {
    const refs = (await git(repoRoot, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `refs/tags/hatch/${binder}/wave-*-base`,
    ])).split("\n").filter(Boolean).map((line) => {
      const [ref, object] = line.split(" ");
      return {
        ref,
        object,
        wave: Number(ref.match(/\/wave-(\d+)-base$/)?.[1] ?? 0),
      };
    }).sort((left, right) => right.wave - left.wave);
    const currentTip = await git(repoRoot, ["rev-parse", `refs/heads/hatch/${binder}/integration`]);
    for (const candidate of refs) {
      const terminalRefs = [
        `refs/tags/hatch/${binder}/wave-${candidate.wave}`,
        `refs/tags/hatch/${binder}/wave-${candidate.wave}-rolled-back`,
      ];
      const terminal = await Promise.all(terminalRefs.map((ref) =>
        git(repoRoot, ["show-ref", "--verify", "--quiet", ref])
          .then(() => true)
          .catch(() => false),
      ));
      if (!terminal.some(Boolean) && candidate.object !== currentTip) {
        return {
          binder,
          wave: candidate.wave,
          base: candidate.object,
          baseTag: candidate.ref,
        };
      }
    }
    return undefined;
  }

  async #discoverFloorChecks(
    ctx: ExtensionContext,
    repoRoot: string,
    binder: string,
    item: DeliveryItem,
    ownerId: string,
    mode: "recover-committed" | "recover-merged",
  ): Promise<HatchCheckPlanEntry[]> {
    const worktree = await this.#ensureItemWorktree(repoRoot, binder, item.id);
    const discovery = await this.#workers.run(
      ctx,
      worktree,
      `hatch/${binder}/item-${item.id}`,
      binder,
      item.id,
      item,
      [],
      ownerId,
      mode,
    );
    if (discovery.outcome === "blocked") {
      throw new Error(`Hatch floor discovery was blocked for item '${item.id}'`);
    }
    return discovery.checks.map((check): HatchCheckPlanEntry => ({
      ...check,
      purpose: "floor",
    }));
  }

  async run(
    ctx: ExtensionContext,
    binder: string,
    progress?: HatchRunProgress,
  ): Promise<HatchDeliveryResult> {
    const emit = safeProgress(progress);
    const lease = await this.#locks.acquire(ctx.cwd, binder);
    let owner;
    try {
      owner = this.#processes.createBinderOwner(ctx.cwd, binder);
    } catch (error) {
      await this.#locks.release(lease);
      throw error;
    }
    // Only now does the run own the binder; a run refused the lock never reports a start.
    emit({ kind: "run-started", binder });
    try {
      const repoRoot = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
      const integrationRef = `refs/heads/hatch/${binder}/integration`;
      // Doctrine: leftovers from an earlier run — wave tags and item refs — are neither
      // resumed nor cleared silently. The integration branch alone is not a leftover: a
      // first run creates it a few lines below, and it carries no wave state on its own.
      const leftoverPatterns = [
        `refs/tags/hatch/${binder}/`,
        `refs/hatch/${binder}/`,
        `refs/heads/hatch/${binder}/`,
      ];
      const leftovers = (
        await git(repoRoot, ["for-each-ref", "--format=%(refname)", ...leftoverPatterns])
      )
        .split("\n")
        .map((line) => line.trim())
        .filter((ref) => ref !== "" && ref !== integrationRef);
      if (leftovers.length > 0) {
        if (!ctx.hasUI) {
          return {
            schema: "hatch-delivery-v1",
            binder,
            status: "blocked",
            integrationWorktree: "",
            waves: [],
            message: `Binder '${binder}' carries state from an earlier run (${leftovers.length} refs); rerun interactively to choose resume or clear.`,
          };
        }
        const ownedWorktrees = await this.#ownedWorktrees(repoRoot, binder);
        const dirtyWorktrees = ownedWorktrees.filter((worktree) => worktree.dirty);
        const disclosure = dirtyWorktrees.length
          ? `\n\nClear will also delete these worktrees, losing any uncommitted work in them:\n${dirtyWorktrees
              .map((worktree) => `  ${worktree.path}`)
              .join("\n")}`
          : "";
        const choice = await ctx.ui.select(
          `Binder '${binder}' carries state from an earlier run${disclosure}`,
          ["Resume", "Clear"],
        );
        if (choice !== "Resume" && choice !== "Clear") {
          return {
            schema: "hatch-delivery-v1",
            binder,
            status: "blocked",
            integrationWorktree: "",
            waves: [],
            message: `Binder '${binder}' was neither resumed nor cleared; choose Resume or Clear to continue.`,
          };
        }
        if (choice === "Clear") await this.#clearDelivery(repoRoot, binder, dirtyWorktrees.length > 0);
      }
      const processContext = { manager: this.#processes, owner };
      // A successor binder (`supersedes`) inherits its predecessor's delivered work. Every
      // result from here on carries the preflight's supersedes report.
      let successorReport: HatchSupersedesReport | undefined;
      // Every halt recorded in this run, in order. The result reports the latest halt per
      // item and drops an item that is done when the run returns, so an item that halted
      // and then landed after Fix and rerun is not reported as halted.
      const halts: HatchDeliveryHalt[] = [];
      const report = async (result: HatchDeliveryResult): Promise<HatchDeliveryResult> => {
        const latest = new Map<string, HatchDeliveryHalt>();
        for (const halt of halts) {
          latest.delete(halt.item);
          latest.set(halt.item, halt);
        }
        const open: HatchDeliveryHalt[] = [];
        for (const halt of latest.values()) {
          if ((await deriveItemGitState(repoRoot, binder, halt.item)).state !== "done") open.push(halt);
        }
        return {
          ...result,
          ...(successorReport ? { supersedes: successorReport } : {}),
          ...(open.length > 0 ? { halts: open } : {}),
        };
      };
      const integrationExists = await git(repoRoot, ["show-ref", "--verify", "--quiet", integrationRef])
        .then(() => true, () => false);
      const planned = await this.#plannedBinder(repoRoot, binder, integrationExists);
      // Before any build, and before this run writes any branch, worktree, ref or tag: an
      // oracle that needs installed dependencies cannot pass in the fresh merge worktree
      // unless the integration branch declares a setup. A first run reads the tree it is
      // about to branch from (HEAD); a later run reads the integration branch. The human
      // decides each run; nothing is stored.
      if (planned) {
        const carriedByPlan = new Set(planned.supersedes?.carried ?? []);
        const finding = await this.#environmentPreflight(
          repoRoot,
          binder,
          planned.work_items.filter((item) => !carriedByPlan.has(item.id)),
          integrationExists ? integrationRef : "HEAD",
        );
        if (finding) {
          emit({
            kind: "environment-preflight",
            items: [...new Set(finding.needs.map((need) => need.item))],
            suggestedSetup: finding.suggestedSetup,
            message: finding.message,
          });
          // The prompt title is bounded; the event and the result keep the full finding.
          const choice = ctx.hasUI
            ? await ctx.ui.select(
              `Hatch binder '${binder}' environment preflight:\n${clipText(finding.message, PREFLIGHT_TITLE_LIMIT)}`,
              ["Stop to add the setup", "Build anyway"],
            )
            : undefined;
          if (choice !== "Build anyway") {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree: "",
              waves: [],
              message: `Delivery stopped before any build: ${finding.message}`,
              environmentFinding: finding,
            });
          }
        }
      }
      if (planned?.supersedes && !integrationExists) {
        const plannedPath = `.hatch/binders/${binder}.json`;
        const blocked = (message: string): Promise<HatchDeliveryResult> => report({
          schema: "hatch-delivery-v1",
          binder,
          status: "blocked",
          integrationWorktree: "",
          waves: [],
          message,
        });
        const uncommitted = await git(repoRoot, ["diff", "--quiet", "HEAD", "--", plannedPath])
          .then(() => false, () => true);
        if (uncommitted) {
          return blocked(`Successor binder '${binder}' differs from its committed copy; commit it before delivering.`);
        }
        const packet = await this.#preflight(repoRoot, join(repoRoot, plannedPath));
        successorReport = supersedesReport(packet);
        const halt = successorHalt(packet, planned.supersedes);
        if (halt) return blocked(`Successor binder '${binder}' cannot start: ${halt}`);
        const refused = await this.#createSuccessorBranch(
          ctx,
          repoRoot,
          binder,
          planned.supersedes.slug,
          packet,
          processContext,
        );
        if (refused) return blocked(refused);
      }
      const integrationWorktree = await this.#ensureIntegrationWorktree(
        repoRoot,
        binder,
        processContext,
      );
      const liveBinder = join(integrationWorktree, ".hatch", "binders", `${binder}.json`);
      const archivedBinder = join(integrationWorktree, ".hatch", "binders", "archive", `${binder}.json`);
      const archived = !await exists(liveBinder);
      if (archived && !await exists(archivedBinder)) {
        throw new Error(`Hatch binder '${binder}' is missing from live and archive paths`);
      }
      const document = parseBinder(await readFile(archived ? archivedBinder : liveBinder, "utf8"), binder);
      // Proven carried items count as done and never enter the frontier.
      const carried = new Set<string>();
      if (document.supersedes) {
        const supersedes = document.supersedes;
        const binderPath = archived ? archivedBinder : liveBinder;
        let archive: HatchSupersedesReport["archive"];
        // Preflight proves the carried work on every run, as the deliver skill re-runs it.
        const prove = async (): Promise<string | undefined> => {
          const packet = await this.#preflight(repoRoot, binderPath);
          const proven = supersedesReport(packet);
          successorReport = proven && (archive ? { ...proven, archive } : proven);
          return successorHalt(packet, supersedes);
        };
        const blocked = (halt: string): Promise<HatchDeliveryResult> => report({
          schema: "hatch-delivery-v1",
          binder,
          status: "blocked",
          integrationWorktree,
          waves: [],
          message: `Successor binder '${binder}' cannot continue: ${halt}`,
        });
        let halt = await prove();
        if (halt) return blocked(halt);
        archive = await this.#retirePredecessor(
          ctx,
          binder,
          supersedes.slug,
          integrationWorktree,
          processContext,
        );
        if (successorReport) successorReport = { ...successorReport, archive };
        if (archive.status === "committed") {
          halt = await prove();
          if (halt) return blocked(halt);
        }
        for (const id of supersedes.carried) carried.add(id);
      }
      // After a wave that leaves an item failed, the next pass prompts the human, or with
      // no host to ask, stops naming the item.
      const afterWave = (leftFailed: boolean): HatchWaveNext =>
        leftFailed ? (ctx.hasUI ? "prompt" : "stop") : "continue";
      const isDone = (states: Map<string, { state: string }>, id: string): boolean =>
        carried.has(id) || states.get(id)?.state === "done";
      const activeItems = document.work_items.filter((item) => !carried.has(item.id));
      emit({
        kind: "binder-loaded",
        items: document.work_items.map((item) => item.id),
        carried: [...carried],
      });
      // Why each item halted in this run, shown at the human's fix/accept/defer prompt.
      const haltReasons = new Map<string, string>();
      // Items whose build halted in this run, with the status and reason. In memory only:
      // Git refs stay the record, and a later run rebuilds the frontier from them.
      const deferred = new Map<string, DeferredItem>();
      // Items merged during this run, for the aggregate stop's "landed" line.
      const landedThisRun: string[] = [];
      const waves: HatchDeliveryWave[] = [];
      const existingTags = await git(repoRoot, [
        "for-each-ref",
        "--format=%(refname)",
        `refs/tags/hatch/${binder}/wave-*`,
      ]);
      let waveNumber = Math.max(
        0,
        ...existingTags.split("\n").map((ref) =>
          Number(ref.match(/\/wave-(\d+)(?:-base)?$/)?.[1] ?? 0),
        ),
      ) + 1;
      for (let pass = 1; pass <= document.work_items.length * 4 + 4; pass += 1) {
        const states = new Map(
          await Promise.all(activeItems.map(async (item) => [
            item.id,
            await deriveItemGitState(repoRoot, binder, item.id),
          ] as const)),
        );
        // Recover a pending wave anchor BEFORE deriving a new frontier, whether or not
        // every item is done: starting a fresh wave over an unfinalized anchor lets the
        // later all-done recovery roll that anchor back and destroy the newer wave's work.
        const pending = await this.#pendingWaveAnchor(repoRoot, binder);
        if (
          document.work_items.every((item) => isDone(states, item.id)) || pending
        ) {
          if (pending) {
            const landed = new Set((await git(repoRoot, [
              "rev-list",
              "--first-parent",
              `${pending.base}..refs/heads/hatch/${binder}/integration`,
            ])).split("\n").filter(Boolean));
            const integrations: HatchIntegrationResult[] = [];
            const checks: HatchCheckPlanEntry[] = [];
            for (const item of activeItems) {
              const state = states.get(item.id);
              if (!state?.refs.done || !state.itemTip || !landed.has(state.refs.done)) continue;
              const parents = (await git(repoRoot, [
                "rev-list",
                "--parents",
                "-n",
                "1",
                state.refs.done,
              ])).split(/\s+/).slice(1);
              integrations.push({
                schema: "hatch-integration-item-v1",
                binder,
                item: item.id,
                status: "integrated",
                base: parents[0],
                itemTip: state.itemTip,
                mergeCommit: state.refs.done,
                accepted: Boolean(state.refs.accepted),
                message: "Recovered pending wave integration.",
              });
              checks.push(...await this.#discoverFloorChecks(
                ctx,
                repoRoot,
                binder,
                item,
                owner.id,
                "recover-merged",
              ));
            }
            if (integrations.length === 0) {
              return report({
                schema: "hatch-delivery-v1",
                binder,
                status: "blocked",
                integrationWorktree,
                waves,
                message: "Pending wave tag has no recoverable first-parent item merges.",
              });
            }
            const waveResult: HatchDeliveryWave = {
              wave: pending.wave,
              items: integrations.map((integration) => integration.item),
              builds: [],
              integrations,
            };
            waves.push(waveResult);
            const finalization = await this.#waves.finish(
              ctx,
              pending,
              integrationWorktree,
              lease,
              integrations,
              checks,
              { manager: this.#processes, owner },
            );
            waveResult.finalization = finalization;
            emit({
              kind: "wave-finished",
              wave: pending.wave,
              status: finalization.status,
              landed: waveResult.integrations
                .filter((integration) => integration.status === "integrated")
                .map((integration) => integration.item),
              failed: finalization.failedItems ?? [],
              next: finalization.status === "passed" ? "continue" : "stop",
            });
            if (finalization.status !== "passed") {
              return report({
                schema: "hatch-delivery-v1",
                binder,
                status: "blocked",
                integrationWorktree,
                waves,
                message: "Recovered pending wave failed validation and was rolled back.",
              });
            }
            landedThisRun.push(...integrations.map((integration) => integration.item));
            continue;
          }
          if (archived) {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "complete",
              integrationWorktree,
              waves,
              message: "Every binder item is durably done and the binder is archived.",
            });
          }
          emit({ kind: "companions-started" });
          const companions = await this.#companions.finishDelivery(
            ctx,
            binder,
            integrationWorktree,
            lease,
            { manager: this.#processes, owner },
            { diffBase: await this.#deliveryBase(repoRoot, binder), sme: document.sme },
          );
          // A refused companion never downgrades a delivery whose items are all
          // done and archived, but it is never silent either: it is named in the
          // message a person actually reads.
          const refused = [companions.docGardner, companions.kaizen]
            .filter((writer) => writer.status === "rejected");
          const message = refused.length === 0
            ? "Every binder item is durably done, companion writers finished, and the binder is archived."
            : `Every binder item is durably done and the binder is archived. ${
              refused.map((writer) => `The ${writer.role} companion was refused: ${writer.reason}`).join(" ")
            } Its changes were not committed; the delivery is unaffected.`;
          return report({
            schema: "hatch-delivery-v1",
            binder,
            status: "complete",
            integrationWorktree,
            waves,
            message,
            companions,
          });
        }
        const inconsistent = activeItems.find(
          (item) => states.get(item.id)?.state === "inconsistent",
        );
        if (inconsistent) {
          return report({
            schema: "hatch-delivery-v1",
            binder,
            status: "blocked",
            integrationWorktree,
            waves,
            message: `Item '${inconsistent.id}' has contradictory Git state requiring manual recovery.`,
          });
        }
        const acceptPending = activeItems.find((item) =>
          ["accept-merge-pending", "accept-ref-pending"].includes(states.get(item.id)?.state ?? ""),
        );
        if (acceptPending) {
          const checks = await this.#discoverFloorChecks(
            ctx,
            repoRoot,
            binder,
            acceptPending,
            owner.id,
            "recover-merged",
          );
          const recovered = await this.#integrations.recoverAccepted(
            ctx,
            binder,
            acceptPending.id,
            integrationWorktree,
            lease,
            checks,
            { manager: this.#processes, owner },
          );
          const anchor = await this.#pendingWaveAnchor(repoRoot, binder);
          if (!anchor) {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: "Accepted merge recovered, but its pending wave base tag is missing.",
            });
          }
          const waveResult: HatchDeliveryWave = {
            wave: anchor.wave,
            items: [acceptPending.id],
            builds: [],
            integrations: [recovered],
          };
          waves.push(waveResult);
          if (recovered.status !== "integrated") {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: "Interrupted human-accepted merge could not be recovered.",
            });
          }
          const finalization = await this.#waves.finish(
            ctx,
            anchor,
            integrationWorktree,
            lease,
            [recovered],
            checks,
            { manager: this.#processes, owner },
          );
          waveResult.finalization = finalization;
          emit({
            kind: "wave-finished",
            wave: anchor.wave,
            status: finalization.status,
            landed: [recovered.item],
            failed: finalization.failedItems ?? [],
            next: finalization.status === "passed" ? "continue" : "stop",
          });
          if (finalization.status !== "passed") {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: "Recovered accepted merge failed post-wave validation and was rolled back.",
            });
          }
          landedThisRun.push(acceptPending.id);
          continue;
        }
        const failed = activeItems.find((item) => states.get(item.id)?.state === "failed");
        if (failed) {
          if (!ctx.hasUI) {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: `Item '${failed.id}' is failed; rerun interactively to choose fix, accept, or defer.`,
            });
          }
          const choice = await ctx.ui.select(
            `Hatch item '${failed.id}' halted: ${
              haltReasons.get(failed.id) ??
                "it was halted by an earlier run, whose result named the finding; the halt reason is not stored in Git"
            }`,
            ["Fix and rerun", "Accept exact current findings", "Defer and stop delivery"],
          );
          if (choice === "Fix and rerun") {
            const itemTip = states.get(failed.id)?.itemTip;
            if (!itemTip) throw new Error("Hatch failed item has no item tip");
            // A rerun is the human's decision, so a build-time halt recorded earlier in
            // this run no longer keeps the item out of the frontier.
            deferred.delete(failed.id);
            await git(repoRoot, [
              "update-ref",
              "-d",
              `refs/hatch/${binder}/item-${failed.id}/failed`,
              itemTip,
            ]);
            continue;
          }
          if (choice !== "Accept exact current findings") {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: `Item '${failed.id}' remains deferred with its failed ref intact.`,
            });
          }
          const checks = await this.#discoverFloorChecks(
            ctx,
            repoRoot,
            binder,
            failed,
            owner.id,
            "recover-committed",
          );
          if ((await deriveItemGitState(repoRoot, binder, failed.id)).state !== "failed") {
            throw new Error("Hatch failed item changed during human-accept floor discovery");
          }
          const anchor = await this.#waves.start(binder, waveNumber, integrationWorktree, lease);
          const integrated = await this.#integrations.integrate(
            ctx,
            binder,
            failed.id,
            integrationWorktree,
            lease,
            checks,
            { manager: this.#processes, owner },
            {
              authorize: async (findings) => {
                const details = findings.length > 0
                  ? findings.map((finding) =>
                      `[${finding.severity}] ${finding.code}${finding.path ? ` — ${finding.path}${finding.line ? `:${finding.line}` : ""}` : ""}: ${finding.message}`,
                    ).join("\n")
                  : "Fresh acceptance and safety review now pass; record why this failed checkpoint is being accepted.";
                const confirmed = await ctx.ui.confirm(
                  `Accept exact findings for '${failed.id}'?`,
                  details,
                );
                if (!confirmed) return undefined;
                const reason = await ctx.ui.input(
                  "Human acceptance reason",
                  "Why is accepting this exact gap appropriate?",
                );
                return reason?.trim() ? { reason } : undefined;
              },
            },
          );
          const waveResult: HatchDeliveryWave = {
            wave: waveNumber,
            items: [failed.id],
            builds: [],
            integrations: [integrated],
          };
          waves.push(waveResult);
          const finalization = await this.#waves.finish(
            ctx,
            anchor,
            integrationWorktree,
            lease,
            [integrated],
            checks,
            { manager: this.#processes, owner },
          );
          waveResult.finalization = finalization;
          if (integrated.status !== "integrated") {
            // Accept did not land the item: the human declined at the confirm or reason
            // prompt, or the accepted integration itself failed. The item keeps its failed
            // ref, and the run stops naming why.
            const reason = integrationHaltReason(integrated);
            haltReasons.set(failed.id, reason);
            halts.push(haltRecord(failed.id, "merge", "failed", reason, integrated.checkFailure));
            emit({
              kind: "item-halted",
              wave: waveNumber,
              item: failed.id,
              status: "failed",
              reason,
              ...withCheck(eventCheck(checkDiagnosis(integrated.checkFailure))),
            });
          }
          const acceptLanded = integrated.status === "integrated" && finalization.status === "passed";
          emit({
            kind: "wave-finished",
            wave: waveNumber,
            status: finalization.status,
            landed: integrated.status === "integrated" ? [failed.id] : [],
            failed: finalization.failedItems ?? [],
            next: acceptLanded ? "continue" : "stop",
          });
          if (!acceptLanded) {
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: `Human acceptance for '${failed.id}' was cancelled, blocked, or rolled back.`,
            });
          }
          landedThisRun.push(failed.id);
          waveNumber += 1;
          continue;
        }
        const ready = activeItems.filter((item) =>
          !isDone(states, item.id) &&
          !deferred.has(item.id) &&
          item.depends_on.every((dependency) => isDone(states, dependency)),
        );
        const batch = collisionBatch(ready);
        const waveMates = batch.map((waveItem) => waveItem.id);
        // One host ledger per wave: every build's host phase records what it
        // authored for its own item, so a wave-mate's worker is not blamed for
        // this host's mid-wave branch, ref, and worktree writes.
        const ledger = new WaveHostLedger(repoRoot, binder);
        if (batch.length === 0 && deferred.size > 0) {
          return report({
            schema: "hatch-delivery-v1",
            binder,
            status: "blocked",
            integrationWorktree,
            waves,
            message: deferredHaltMessage(
              activeItems,
              deferred,
              landedThisRun,
              (item) => isDone(states, item),
            ),
          });
        }
        if (batch.length === 0) {
          return report({
            schema: "hatch-delivery-v1",
            binder,
            status: "blocked",
            integrationWorktree,
            waves,
            message: "No dependency-ready item exists; the binder graph or Git state is stuck.",
          });
        }
        emit({ kind: "wave-started", wave: waveNumber, items: waveMates });
        const builds = await mapWithConcurrencyLimit(
          batch,
          MAX_PARALLEL_BUILDS,
          (item) =>
            this.#builds
              .runWithLease(ctx, binder, item.id, lease, owner, waveMates, ledger)
              // Reported as each build settles, not at the wave barrier, so a long wave shows motion.
              .then((build) => {
                emit(
                  BUILD_HALT_STATUSES.includes(build.status)
                    ? {
                        kind: "item-halted",
                        wave: waveNumber,
                        item: item.id,
                        status: build.status,
                        reason: buildHaltReason(build),
                        ...withCheck(eventCheck(checkDiagnosis(build.finalization?.checkFailure))),
                      }
                    : {
                        kind: "item-built",
                        wave: waveNumber,
                        item: item.id,
                        status: build.status,
                        attempts: build.attempts,
                      },
                );
                return build;
              }),
        );
        const waveResult: HatchDeliveryWave = {
          wave: waveNumber,
          items: batch.map((item) => item.id),
          builds,
          integrations: [],
        };
        waves.push(waveResult);
        // Each item's own build decides that item. A halted build writes no ref and is
        // set aside for the rest of this run; its dependents stall because it has no done
        // ref. The wave-mates that built still merge, serially, in batch order.
        const pairs = batch.map((item, index) => ({ item, build: builds[index] }));
        for (const { item, build } of pairs) {
          if (!BUILD_HALT_STATUSES.includes(build.status)) continue;
          const reason = buildHaltReason(build);
          deferred.set(item.id, { status: build.status, message: reason });
          halts.push(haltRecord(item.id, "build", build.status, reason, build.finalization?.checkFailure));
          // A failed build leaves a failed ref, so the next pass asks the human about
          // it; the prompt names this run's reason rather than an earlier run's.
          if (build.status === "failed") haltReasons.set(item.id, reason);
        }
        // A failed build holds a failed ref, so the next pass asks the human about it.
        const buildFailed = pairs.some(({ build }) => build.status === "failed");
        const mergeable = pairs.filter(({ build }) => !BUILD_HALT_STATUSES.includes(build.status));
        if (mergeable.length === 0) {
          emit({
            kind: "wave-finished",
            wave: waveNumber,
            status: "nothing-to-merge",
            landed: [],
            failed: [],
            next: afterWave(buildFailed),
          });
          continue;
        }
        // The anchor is written only when a merge follows: a started wave that never
        // finishes leaves an anchor the pending-wave recovery cannot resolve.
        const anchor = await this.#waves.start(
          binder,
          waveNumber,
          integrationWorktree,
          lease,
        );
        // Post-wave checks come only from items that are on the tip at the end of the wave.
        // A check proposed by an item that failed its merge-time review describes code that
        // never landed; running it would roll back the wave-mates that did.
        const itemChecks = new Map<string, HatchCheckPlanEntry[]>();
        const landed = new Set<string>();
        let integrationFailed = false;
        for (const { item, build } of mergeable) {
          itemChecks.set(item.id, build.worker?.checks.map((check) => ({
            ...check,
            purpose: "floor" as const,
          })) ?? []);
          let state = await deriveItemGitState(repoRoot, binder, item.id);
          if (state.state === "done") {
            landed.add(item.id);
            emit({
              kind: "item-merged",
              wave: waveNumber,
              item: item.id,
              accepted: Boolean(state.refs.accepted),
            });
            continue;
          }
          if (state.state === "merged-unmarked") {
            // Serial recovery after the wave barrier: nothing is building concurrently,
            // so only this item's own worktree may churn.
            await this.#builds.runWithLease(ctx, binder, item.id, lease, owner, [item.id]);
            state = await deriveItemGitState(repoRoot, binder, item.id);
            if (state.state === "done") {
              landed.add(item.id);
              emit({
                kind: "item-merged",
                wave: waveNumber,
                item: item.id,
                accepted: Boolean(state.refs.accepted),
              });
              continue;
            }
          }
          if (state.state !== "built") {
            const reason = `Item '${item.id}' is not in a serially mergeable built state.`;
            deferred.set(item.id, { status: state.state, message: reason });
            halts.push(haltRecord(item.id, "merge", state.state, reason, undefined));
            // Should that state be failed, the next pass's prompt names this run's reason.
            haltReasons.set(item.id, reason);
            continue;
          }
          let checks: HatchCheckPlanEntry[] = itemChecks.get(item.id) ?? [];
          if (checks.length === 0) {
            const worktree = await this.#ensureItemWorktree(repoRoot, binder, item.id);
            const discovery = await this.#workers.run(
              ctx,
              worktree,
              `hatch/${binder}/item-${item.id}`,
              binder,
              item.id,
              item,
              [],
              owner.id,
              "recover-committed",
            );
            checks = discovery.checks.map((check): HatchCheckPlanEntry => ({
              ...check,
              purpose: "floor",
            }));
            itemChecks.set(item.id, checks);
          }
          const integrated = await this.#integrations.integrate(
            ctx,
            binder,
            item.id,
            integrationWorktree,
            lease,
            checks,
            { manager: this.#processes, owner },
          );
          waveResult.integrations.push(integrated);
          if (integrated.status === "integrated") {
            landed.add(item.id);
            emit({
              kind: "item-merged",
              wave: waveNumber,
              item: item.id,
              accepted: Boolean(integrated.accepted),
            });
          }
          if (integrated.status !== "integrated") {
            // The documented halt shape for a merge-time review failure: the committed
            // item branch plus a failed ref at its tip, with built gone. That routes the
            // item to the orchestrator's own fix/accept/defer prompt instead of leaving
            // it built, where every later run would re-integrate it and fail the same way.
            // The rest of the wave keeps merging: only this item halts.
            await this.#markIntegrationFailed(repoRoot, binder, item.id, integrated.itemTip);
            const reason = integrationHaltReason(integrated);
            haltReasons.set(item.id, reason);
            // The item now holds a failed ref and waits for the human: "failed", never
            // the integration's retry, since nothing retries it.
            halts.push(haltRecord(item.id, "merge", "failed", reason, integrated.checkFailure));
            emit({
              kind: "item-halted",
              wave: waveNumber,
              item: item.id,
              status: "failed",
              reason,
              ...withCheck(eventCheck(checkDiagnosis(integrated.checkFailure))),
            });
            integrationFailed = true;
          }
        }
        const waveChecks = batch.flatMap((item) =>
          landed.has(item.id) ? itemChecks.get(item.id) ?? [] : [],
        );
        const waveFinalization = await this.#waves.finish(
          ctx,
          anchor,
          integrationWorktree,
          lease,
          waveResult.integrations,
          waveChecks,
          { manager: this.#processes, owner },
        );
        waveResult.finalization = waveFinalization;
        const landedAny = waveResult.integrations.some((value) => value.status === "integrated");
        // A rollback stops the run unless it undid nothing: no merge landed and the
        // failures were merge-time ones, which the next pass puts to the human.
        const waveStops = waveFinalization.status === "rolled-back" && (landedAny || !integrationFailed);
        emit({
          kind: "wave-finished",
          wave: waveNumber,
          status: waveFinalization.status,
          landed: [...landed],
          failed: waveFinalization.failedItems ?? [],
          next: waveStops ? "stop" : afterWave(integrationFailed || buildFailed),
        });
        if (waveStops) {
          return report({
            schema: "hatch-delivery-v1",
            binder,
            status: "blocked",
            integrationWorktree,
            waves,
            message: "Post-wave validation failed; the wave was rolled back.",
          });
        }
        landedThisRun.push(...landed);
        // A merge-time failure is not a stop by itself: the next pass finds the item
        // failed and asks the human (or, with no host to ask, blocks naming it).
        // Every pass progresses: a batch with nothing to merge has just deferred every
        // item, and each mergeable item either lands, is deferred, or is marked failed.
        waveNumber += 1;
      }
      throw new Error("Hatch delivery exceeded its deterministic orchestration bound");
    } finally {
      try {
        await this.#processes.stopOwner(owner);
      } finally {
        await this.#locks.release(lease);
      }
    }
  }
}
