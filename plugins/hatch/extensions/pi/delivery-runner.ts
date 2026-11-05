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
  describeCompanionOutcome,
  HatchRepositoryAuthorityError,
  validateRecoveredCompanionCommit,
  type HatchCompanionResult,
  type HatchWriterCommitResult,
  type ProcessContext,
} from "./companion-runner.ts";
import { hostGitArgs } from "./worker-attestation.ts";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import { readEnvironmentConfig } from "./environment.ts";
import {
  clearBinderAttempts,
  gateFileFor,
  itemSpecDigest,
  readAttempts,
  recordVerification,
  type GateAttemptState,
  type HatchGateAttemptRecord,
  type HatchGatePhase,
  type HatchGateRole,
} from "./gate-attempts.ts";
import { effectiveGateVerdict, hostNextStepWithRerun } from "./gate-runner.ts";
import { deriveItemGitState, isItemMergeSubject } from "./git-state.ts";
import type { HatchIntegrationResult, HatchIntegrationRunner } from "./integration-runner.ts";
import { hostBlockedGate, type HatchVerificationResult } from "./verification-runner.ts";
import { validateCandidateHooks, validateMergeHooks } from "./hook-runner.ts";
import { HatchProcessManager, type BinderLifecycleOwner } from "./process-manager.ts";
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
  // Set when a gate child returned no verdict and the host wrote `blocked`: the exact
  // Pi request that resumes the run, then what to do first (wait, or pin a model).
  // Also set when the build worker itself returned `blocked`: the honest routes forward.
  nextStep?: string;
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
  // The current-spec gate-attempt ledger rows of every item that drew a counted
  // concern, was kicked back, or halted, including rows from earlier runs.
  gateAttempts?: HatchGateAttemptRecord[];
  // Set when a companion writer broke the host's authority and the host could
  // not put the repository config or hooks folder back. The run stopped there.
  authorityHalt?: HatchAuthorityHalt;
}

export interface HatchAuthorityHalt {
  role: HatchWriterCommitResult["role"];
  restoreFailure: string;
  refusal?: string;
  nextStep: string;
  result: HatchWriterCommitResult;
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

/** Work Clear would delete that no surviving ref reaches: a hatch branch, or an owned worktree's detached HEAD. */
interface UnlandedBranch {
  /** What the dialog names: the branch path after `hatch/<binder>/`, or `detached HEAD in <dir>`. */
  label: string;
  /** The branch name the restore command creates. */
  restoreName: string;
  tip: string;
  /** How many commits only this tip reaches. */
  count: number;
  /** Up to `UNLANDED_SAMPLE` of those commits, newest first. */
  sample: string[];
  backupRef: string;
}

/** How many unlanded shas the dialog shows per branch. */
const UNLANDED_SAMPLE = 3;
/** How many unlanded branches the dialog names in detail; the report always names all. */
const UNLANDED_SHOWN = 5;

/** A UTC stamp for the backup namespace: `YYYYMMDDTHHMMSSZ`. */
function backupStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function commitCount(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

/** The sampled shas oldest first; a leading `…` marks older commits left out. */
function shaSpan(branch: UnlandedBranch): string {
  const shown = [...branch.sample].reverse().map((sha) => sha.slice(0, 7)).join(", ");
  return branch.count > branch.sample.length ? `… ${shown}` : shown;
}

function unlandedDisclosure(branch: UnlandedBranch): string {
  return `Clear will delete ${branch.label}: ${branch.count} commit(s) on it exist on no other branch (${shaSpan(branch)}); Clear keeps a copy at ${branch.backupRef}.`;
}

/** The dialog's lines for unlanded work, bounded to the first `UNLANDED_SHOWN` entries. */
function unlandedDisclosures(unlanded: UnlandedBranch[]): string {
  const lines = unlanded.slice(0, UNLANDED_SHOWN).map(unlandedDisclosure);
  const more = unlanded.length - UNLANDED_SHOWN;
  if (more > 0) lines.push(`… and ${more} more branch(es) with unlanded commits; Clear keeps a copy of each.`);
  return lines.join("\n");
}

function keptReport(branch: UnlandedBranch): string {
  return `kept unlanded work at ${branch.backupRef} (${commitCount(branch.count)}); restore with: git branch ${branch.restoreName} ${branch.backupRef}`;
}

/** Detached HEADs in a `worktree list --porcelain` listing, by worktree path. */
function detachedHeads(porcelain: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    const head = lines.find((line) => line.startsWith("HEAD "))?.slice("HEAD ".length);
    if (path && head && lines.includes("detached")) result.set(path, head);
  }
  return result;
}

// A read-only git call with the hardened options, for the result's report: it
// can run after a companion halted on repository authority the host could not
// put back, so no hook or fsmonitor in that config may run.
async function readGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", hostGitArgs(cwd, args), {
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

/**
 * The halt for a kickback whose worker changed nothing: the review of the unchanged tip
 * stands, no automatic retry follows, and the worker's own reason is quoted as its words.
 * It names no attempt count, because no cap was spent.
 */
function noChangeHaltReason(
  item: string,
  phase: "build" | "merge",
  role: HatchGateRole | undefined,
  tip: string,
  words: string,
): string {
  const gate = role ? ` ${GATE_NAMES[role]}` : "";
  return (
    `Item '${item}' ${phase}-time${gate} kickback changed nothing, so the review of ` +
    `${shortSha(tip)} stands and no automatic retry follows. The worker said: "${clipText(words.replace(/\s+/g, " ").trim(), 500)}"`
  );
}

/** A failed build's halt reason and the gate whose cap it spent; a no-change halt spent none. */
function failedBuildHalt(build: HatchBuildItemResult): { reason: string; gate?: HaltGate } {
  const role = verificationConcern(build.finalization?.verification);
  if (build.noChange) {
    const words = build.worker?.summary ?? build.message;
    return { reason: noChangeHaltReason(build.item, "build", role, build.commit ?? "", words) };
  }
  return { reason: buildHaltReason(build), ...(role ? { gate: { role, phase: "build" } } : {}) };
}

/** The diagnosis of a halted check, when the convergence carries one. */
function checkDiagnosis(checkFailure: CheckConvergenceResult | undefined): HatchCheckDiagnosis | undefined {
  return checkFailure && checkFailure.status !== "stable" ? checkFailure.diagnosis : undefined;
}

function withCheck(check: HatchRunEventCheck | undefined): { check?: HatchRunEventCheck } {
  return check ? { check } : {};
}

/**
 * At most one acceptance and two safety kickbacks per item, across build and merge:
 * (2 - 1) + (3 - 1) rounds. Each round needs a new counted concern, so a further round
 * means the accounting itself is wrong.
 */
const MAX_KICKBACK_ROUNDS = 3;

const GATE_NAMES: Record<HatchGateRole, string> = {
  "acceptance-gate": "acceptance",
  "safety-gate": "safety",
  "visual-gate": "visual",
};

const GATE_KEYS = {
  "acceptance-gate": "acceptance",
  "safety-gate": "safety",
  "visual-gate": "visual",
} as const;

type HatchItemAttempts = Awaited<ReturnType<typeof readAttempts>>;

/** An item's ledger as read for a prompt or a result: the attempts, or why they could not be read. */
type ItemAttemptsRead = HatchItemAttempts | { error: string };

/** The gate whose spent cap halted an item, named where the halt happened. */
interface HaltGate {
  role: HatchGateRole;
  phase: HatchGatePhase;
}

/**
 * The gate a verification's effective `concerns` came from, classified as the build loop
 * does (acceptance, then visual, then safety), read from the verdicts themselves for when
 * no ledger row could be written.
 */
function verificationConcern(verification: HatchIntegrationResult["verification"]): HatchGateRole | undefined {
  if (!verification) return undefined;
  return (["acceptance-gate", "visual-gate", "safety-gate"] as const).find((role) => {
    const gate = verification.gates[GATE_KEYS[role]];
    return gate ? effectiveGateVerdict(role, gate.verdict, gate.findings) === "concerns" : false;
  });
}

/**
 * The gate a merge-time retry kicks back on: the one whose ledger row just written is a
 * counted concern, acceptance before visual before safety as the build loop classifies
 * it. The rows carry the effective verdict, so a minor-only acceptance concern spends
 * nothing and is not a kickback.
 */
function countedConcern(rows: readonly HatchGateAttemptRecord[]): HatchGateRole | undefined {
  return (["acceptance-gate", "visual-gate", "safety-gate"] as const).find((role) =>
    rows.some((row) => row.role === role && row.counted),
  );
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function findingLabel(finding: HatchGateAttemptRecord["findings"][number]): string {
  const where = finding.path ? ` ${finding.path}${finding.line !== undefined ? `:${finding.line}` : ""}` : "";
  return `[${finding.severity}] ${finding.code}${where}`;
}

/**
 * One attempt per gate review of the same bytes: rows of one phase, item tip, reviewed
 * tree and integration tip, one row per role. Two reviews of the same bytes stay two
 * attempts, because a role already present starts the next one.
 */
function attemptGroups(records: readonly HatchGateAttemptRecord[]): HatchGateAttemptRecord[][] {
  const groups: { key: string; rows: HatchGateAttemptRecord[] }[] = [];
  for (const record of records) {
    const key = [record.phase, record.itemTip, record.reviewedTree, record.integrationTip ?? ""].join(" ");
    const group = groups.find((entry) => entry.key === key && !entry.rows.some((row) => row.role === record.role));
    if (group) group.rows.push(record);
    else groups.push({ key, rows: [record] });
  }
  return groups.map((group) => group.rows);
}

const ATTEMPT_LINE_LIMIT = 300;

function attemptLine(index: number, rows: readonly HatchGateAttemptRecord[]): string {
  const [first] = rows;
  const where = first.integrationTip
    ? `${shortSha(first.itemTip)} onto ${shortSha(first.integrationTip)}`
    : shortSha(first.itemTip);
  const verdicts = rows.map((row) => {
    const findings = row.verdict === "concerns" && row.findings.length > 0
      ? `: ${row.findings.map(findingLabel).join(", ")}`
      : "";
    const label = row.source === "host-citation-check" ? `${GATE_NAMES[row.role]} (host citation check)` : GATE_NAMES[row.role];
    return `${label} ${row.verdict}${findings}`;
  }).join(" · ");
  return clipText(`  ${index}. ${first.phase.padEnd(5)}  ${where.padEnd(22)}  ${verdicts}`, ATTEMPT_LINE_LIMIT);
}

/**
 * Every recorded attempt, newest last, within `budget` characters: the oldest give way
 * first and the heading says how many were dropped. Empty when nothing is recorded or
 * not even the newest attempt fits.
 */
function attemptsBlock(records: readonly HatchGateAttemptRecord[], budget: number): string {
  const lines = attemptGroups(records).map((rows, index) => attemptLine(index + 1, rows));
  for (let dropped = 0; dropped < lines.length; dropped += 1) {
    const heading = dropped > 0
      ? `Attempts (newest last; ${dropped} earlier attempt${dropped === 1 ? "" : "s"} not shown):`
      : "Attempts (newest last):";
    const text = [heading, ...lines.slice(dropped)].join("\n");
    if (text.length <= budget) return text;
  }
  return "";
}

/** A computed fact, offered without interpretation: every concern of the gate named a code no other one did. */
function distinctCodesLine(records: readonly HatchGateAttemptRecord[], role: HatchGateRole): string {
  const file = gateFileFor(role);
  const concerns = records.filter((record) => record.counted && gateFileFor(record.role) === file);
  if (concerns.length < 2) return "";
  const seen = new Set<string>();
  for (const concern of concerns) {
    const codes = new Set(concern.findings.map((finding) => finding.code));
    if (codes.size === 0 || [...codes].some((code) => seen.has(code))) return "";
    for (const code of codes) seen.add(code);
  }
  return `Each ${file} concern above names a different finding code.`;
}

/**
 * The fix/accept/defer prompt: why the item halted, every recorded attempt, and what each
 * of the three choices does. The labels stay fixed, because the run compares them by string.
 * `halt` is the gate whose cap halted the item, passed from where the halt happened; a halt
 * with no gate (a failed check, a worker that changed nothing, an earlier run) gets the
 * plain heading. The reason and the attempt list share the halt-reason budget.
 */
export function failedPrompt(
  binder: string,
  item: string,
  reason: string,
  attempts: ItemAttemptsRead | undefined,
  halt?: HaltGate,
): string {
  const branch = `hatch/${binder}/item-${item}`;
  const ledger = attempts && "records" in attempts ? attempts : undefined;
  const gate = halt ? GATE_NAMES[halt.role] : undefined;
  const state = halt && ledger ? ledger[gateFileFor(halt.role)] : undefined;
  const counts = halt && state && !state.error
    ? ` after ${state.counted} of ${state.cap} ${gateFileFor(halt.role)} attempts`
    : "";
  const head = halt
    ? `Hatch item '${item}' halted at the ${halt.phase}-time ${gate} gate${counts}.\n${reason}`
    : `Hatch item '${item}' halted: ${reason}`;
  // integrate() waives only acceptance-gate concerns; a safety or visual concern blocks an accept.
  const accept = !halt
    ? "  Accept exact current findings: re-runs the gates once. An acceptance finding is waived exactly as the fresh review returns it, with the reason you type; a safety or visual finding cannot be waived, so the item lands only if that review raises none."
    : halt.role === "safety-gate"
      ? "  Accept exact current findings: a safety finding cannot be waived. Accept re-runs both gates once and lands the item only if that fresh review raises no safety finding."
      : halt.role === "visual-gate"
        ? "  Accept exact current findings: a visual finding cannot be waived. Accept re-runs the gates once and lands the item only if that fresh review raises no visual or safety finding."
        : "  Accept exact current findings: records a waiver for exactly the findings a fresh review returns, with the reason you type, then merges and runs the floor again; a new or different finding blocks it.";
  let history = "";
  if (attempts && !ledger) {
    history = `The attempt list could not be read: ${(attempts as { error: string }).error}`;
  } else if (ledger) {
    const codes = halt ? distinctCodesLine(ledger.records, halt.role) : "";
    // The reason and the history are joined by a blank line, inside one budget.
    const room = HALT_REASON_LIMIT - reason.length - 2 - (codes ? codes.length + 1 : 0);
    const block = attemptsBlock(ledger.records, room);
    history = block ? [block, codes].filter(Boolean).join("\n") : "";
  }
  return [
    head,
    history,
    [
      "What each choice does:",
      `  Fix and rerun: re-validates the branch tip (checks, then both gates) after you commit a fix on ${branch}. It edits nothing itself${
        gate ? `, and no automatic retry remains for the ${gate} gate` : ""
      }.`,
      accept,
      `  Defer and stop delivery: stops the run and keeps the failed ref. To fix it by hand, commit the fix on ${branch} with [hatch:item-${item}] in the subject, then run the delivery again; hatch treats the moved tip as your fix and re-validates it without asking.`,
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

/** A halt reason followed by the attempt list, the whole bounded by the halt-reason limit. */
function withAttempts(reason: string, records: readonly HatchGateAttemptRecord[]): string {
  const block = attemptsBlock(records, HALT_REASON_LIMIT - reason.length - 1);
  return block ? `${reason}\n${block}` : reason;
}

/** A seeded kickback that came back, routed by the delivery loop. */
type KickbackOutcome =
  | { status: "integrated"; integration: HatchIntegrationResult; checks: HatchCheckPlanEntry[] }
  // A failed ref is at the item tip and the next pass asks the human. `gate` names the
  // gate whose cap halted it, when a cap did.
  | { status: "failed"; integration: HatchIntegrationResult; reason: string; checkFailure?: CheckConvergenceResult; gate?: HaltGate }
  // No ref was written: the item sits out the rest of this run, as a blocked build does.
  // `verification` is the rebuild's own, the one whose gate halted it.
  // `nextStep` is set when the rebuild's own worker returned `blocked`.
  | { status: "deferred"; integration: HatchIntegrationResult; buildStatus: string; reason: string; checkFailure?: CheckConvergenceResult; verification?: HatchVerificationResult; nextStep?: string };

function haltRecord(
  item: string,
  phase: HatchDeliveryHalt["phase"],
  status: string,
  reason: string,
  checkFailure: CheckConvergenceResult | undefined,
  nextStep?: string,
): HatchDeliveryHalt {
  const diagnosis = checkDiagnosis(checkFailure);
  return { item, phase, status, reason, ...(diagnosis ? { diagnosis } : {}), ...(nextStep ? { nextStep } : {}) };
}

/**
 * How the item stands after a halt, which decides what the rerun does. `kept`: no ref
 * was written (a blocked build, a deferred kickback, a blocked recovery), so the rerun
 * resumes from Git. `failed`: a failed ref was written at merge or accept time, so the
 * rerun stops at the fix, accept or defer prompt and only "Fix and rerun" re-validates it.
 */
type HaltRerun = "kept" | "failed";

/**
 * The next step for a halt whose gate child returned no verdict. Pi has no `hatch
 * deliver` command: an operator asks in plain language and the skill calls
 * `hatch_dispatch deliverBinder`, so the step names both. The gate's own remedy (wait,
 * or pin another model) keeps its place before or after the rerun.
 */
function hostVerdictNextStep(
  binder: string,
  rerun: HaltRerun,
  ...verifications: Array<HatchVerificationResult | undefined>
): string | undefined {
  const request = `ask Pi to \`Deliver binder ${binder}.\` again (\`hatch_dispatch\` action \`deliverBinder\`)`;
  const sentence = rerun === "failed"
    ? `${request} in a session that can show its prompt, and choose "Fix and rerun". The item is marked failed, and that choice re-validates it.`
    : `${request}. The candidate is kept and the rerun resumes from Git.`;
  for (const verification of verifications) {
    const step = hostBlockedGate(verification)?.findings[0]?.nextStep;
    if (step) return hostNextStepWithRerun(step, sentence);
  }
  return undefined;
}

/**
 * The next step for a build whose worker returned `blocked` itself, with no check or
 * gate behind it. A check that can pass only after the item lands or deploys is a plan
 * gap, so the step names the replan routes and why a hand landing is not one. The
 * runner does not settle here whether any item has landed, so both routes are named.
 */
function workerBlockedNextStep(binder: string, build: HatchBuildItemResult): string | undefined {
  if (build.status !== "blocked" || build.worker?.outcome !== "blocked") return undefined;
  return (
    `Fix what stopped the worker, then ask Pi to \`Deliver binder ${binder}.\` again (\`hatch_dispatch\` action \`deliverBinder\`); ` +
    "if the item's check can pass only after the item lands or deploys, replan it with a later drill stage (hatch-plan `plan:prelanding`): " +
    "withdraw the binder if none of its items has landed, otherwise plan a successor binder (docs/how-to/binder-repair.md). " +
    "Landing the work by hand bypasses the gates and leaves the item with no done ref, so a later run cannot see it."
  );
}

function withNextStep(nextStep: string | undefined): { nextStep?: string } {
  return nextStep ? { nextStep } : {};
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
    // A finding the message already states (a host verdict's cause leads the message)
    // is not repeated.
    .filter((finding) => !finding.message?.trim() || !message.includes(finding.message.trim()))
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
  async #ownedWorktrees(
    repoRoot: string,
    binder: string,
  ): Promise<{ path: string; dirty: boolean; detachedHead?: string }[]> {
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
    const detached = detachedHeads(porcelain);
    const found: { path: string; dirty: boolean; detachedHead?: string }[] = [];
    for (const path of paths) {
      const head = detached.get(path);
      found.push({ path, dirty: await this.#dirty(path), ...(head ? { detachedHead: head } : {}) });
    }
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

  /**
   * Every `refs/heads/hatch/<binder>/*` branch, the integration branch included, and every
   * owned worktree's detached HEAD, that holds commits no ref surviving Clear reaches.
   * Surviving means a branch, tag, or remote-tracking ref outside this binder's namespace. Each
   * `--exclude` applies only to the next `--branches`/`--tags`/`--remotes`, and is matched
   * without the `refs/heads/` or `refs/tags/` prefix, so it is given twice; `refs/hatch/<binder>/`
   * state refs are never branches or tags, so they never count as surviving. A detached HEAD
   * also counts the binder's branch tips as surviving, because each of those is backed up
   * itself when it needs to be. The count and a bounded sample are read separately, so a long
   * branch cannot overflow the output buffer. Throws, with git's stderr, when git cannot answer.
   */
  async #unlandedBranches(repoRoot: string, binder: string, stamp: string): Promise<UnlandedBranch[]> {
    const prefix = `refs/heads/hatch/${binder}/`;
    const exclude = `--exclude=hatch/${binder}/*`;
    const surviving = ["--not", exclude, "--branches", exclude, "--tags", "--remotes"];
    const unlanded = async (tip: string, extra: string[] = []): Promise<{ count: number; sample: string[] }> => {
      const count = Number(await git(repoRoot, ["rev-list", "--count", tip, ...surviving, ...extra]));
      if (!Number.isInteger(count)) throw new Error(`git rev-list --count gave no count for ${tip}`);
      const sample = count === 0
        ? []
        : (await git(repoRoot, ["rev-list", `--max-count=${UNLANDED_SAMPLE}`, tip, ...surviving, ...extra]))
          .split("\n")
          .map((sha) => sha.trim())
          .filter(Boolean);
      return { count, sample };
    };
    const lines = (await git(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname)", prefix]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const found: UnlandedBranch[] = [];
    const branchTips = new Set<string>();
    for (const line of lines) {
      const [ref, tip] = line.split(" ");
      branchTips.add(tip);
      const { count, sample } = await unlanded(tip);
      if (count === 0) continue;
      const rest = ref.slice(prefix.length);
      found.push({
        label: rest,
        restoreName: ref.slice("refs/heads/".length),
        tip,
        count,
        sample,
        backupRef: `refs/hatch-backup/${binder}/${stamp}/${rest}`,
      });
    }
    for (const worktree of await this.#ownedWorktrees(repoRoot, binder)) {
      const head = worktree.detachedHead;
      if (!head || branchTips.has(head)) continue;
      const { count, sample } = await unlanded(head, [...branchTips]);
      if (count === 0) continue;
      const dir = basename(worktree.path);
      found.push({
        label: `the detached HEAD in ${dir}`,
        restoreName: dir,
        tip: head,
        count,
        sample,
        backupRef: `refs/hatch-backup/${binder}/${stamp}/detached-${dir}`,
      });
    }
    return found;
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
   *
   * Committed work gets the same care. A hatch branch whose commits no surviving ref reaches is
   * kept under `refs/hatch-backup/<binder>/<stamp>/`, outside every pattern Clear deletes, before
   * anything is removed. The check runs again here rather than trusting the prompt's answer, and
   * a backup that cannot be written stops the clear with nothing removed.
   */
  async #clearDelivery(
    repoRoot: string,
    binder: string,
    discardDirty: boolean,
    stamp: string,
    onKept: (kept: UnlandedBranch[]) => void,
  ): Promise<{ removed: string[]; kept: UnlandedBranch[] }> {
    if (!discardDirty) {
      for (const worktree of await this.#ownedWorktrees(repoRoot, binder)) {
        if (worktree.dirty) {
          throw new Error(
            `Hatch refuses to clear ${worktree.path}: it holds uncommitted work. Commit, stash, or remove it, then clear again.`,
          );
        }
      }
    }
    let kept: UnlandedBranch[];
    try {
      kept = await this.#unlandedBranches(repoRoot, binder, stamp);
    } catch (error) {
      throw new Error(
        `Hatch refuses to clear binder '${binder}': it could not check its branches for unlanded commits (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    for (const branch of kept) {
      try {
        // The empty old value makes this create-only, so an existing backup is never overwritten.
        await git(repoRoot, ["update-ref", branch.backupRef, branch.tip, ""]);
      } catch (error) {
        throw new Error(
          `Hatch refuses to clear binder '${binder}': it could not keep a backup of ${branch.restoreName} at ${branch.backupRef} (${error instanceof Error ? error.message : String(error)}). Nothing was removed.`,
        );
      }
    }
    // Every backup exists before anything is deleted; the caller reports them from here on,
    // so a sweep or a later step that throws cannot lose the restore commands.
    if (kept.length > 0) onKept(kept);
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
    // Start over restarts the gate-attempt counts too.
    await clearBinderAttempts(repoRoot, binder);
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
    return { removed, kept };
  }

  /**
   * The gate-attempt ledger's key for an item: the digest of the raw binder item at the
   * integration tip, read exactly as the build runner reads it, so build-time and
   * merge-time verdicts share one count. An archived binder is read from the archive.
   */
  async #specDigest(repoRoot: string, binder: string, item: string): Promise<string> {
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const raw = await readGit(repoRoot, ["show", `${integrationRef}:.hatch/binders/${binder}.json`])
      .catch(() => readGit(repoRoot, ["show", `${integrationRef}:.hatch/binders/archive/${binder}.json`]));
    const document = JSON.parse(raw) as { work_items?: unknown };
    const matches = Array.isArray(document.work_items)
      ? document.work_items.filter((entry) =>
          Boolean(entry) && typeof entry === "object" && (entry as { id?: unknown }).id === item,
        )
      : [];
    if (matches.length !== 1) throw new Error(`Hatch binder '${binder}' must contain item '${item}' exactly once`);
    return itemSpecDigest(matches[0]);
  }

  /** The item's current-spec ledger, or why it could not be read, so a prompt can say so. */
  async #itemAttempts(repoRoot: string, binder: string, item: string): Promise<ItemAttemptsRead> {
    try {
      return await readAttempts(repoRoot, binder, item, await this.#specDigest(repoRoot, binder, item));
    } catch (error) {
      return { error: (error as Error).message };
    }
  }

  /**
   * Record the gate verdicts a merge-time or accept-time integration returned, at the
   * merge tree it judged. It never throws: it runs after integrate(), which may already
   * have landed the item. A ledger that cannot be read or appended is returned as an
   * error and nothing is appended, so a retry takes the cap path naming it; the error is
   * also reported as a `gate-ledger-unrecorded` event, so a pass that lands still says so.
   */
  async #recordReview(
    repoRoot: string,
    binder: string,
    result: HatchIntegrationResult,
    phase: HatchGatePhase,
    report: { emit: HatchRunProgress; wave?: number },
  ): Promise<{ rows: HatchGateAttemptRecord[]; error?: string }> {
    const unrecorded = (error: string, file?: string): { rows: HatchGateAttemptRecord[]; error: string } => {
      report.emit({
        kind: "gate-ledger-unrecorded",
        ...(report.wave !== undefined ? { wave: report.wave } : {}),
        item: result.item,
        ...(file ? { file } : {}),
        error,
      });
      return { rows: [], error };
    };
    if (!result.verification || !result.targetTree) return { rows: [] };
    try {
      const specDigest = await this.#specDigest(repoRoot, binder, result.item);
      const attempts = await readAttempts(repoRoot, binder, result.item, specDigest);
      const broken = attempts.acceptance.error ? attempts.acceptance : attempts.safety.error ? attempts.safety : undefined;
      if (broken?.error) return unrecorded(broken.error, broken.file);
      const rows: HatchGateAttemptRecord[] = [];
      // An accept after an acceptance concern re-runs the safety gate alone; that
      // verdict is recorded beside the full review's, under the same phase.
      for (const verification of [result.verification, result.safetyVerification]) {
        if (!verification) continue;
        rows.push(...await recordVerification(repoRoot, {
          binder,
          item: result.item,
          specDigest,
          phase,
          itemTip: result.itemTip,
          reviewedTree: result.targetTree,
          integrationTip: result.base,
          verification,
        }));
      }
      return { rows };
    } catch (error) {
      return unrecorded((error as Error).message);
    }
  }

  /**
   * The gate a merge-time review kicks back on, after recording its verdicts. Only a
   * gate's concern qualifies; a failed check and a blocked review keep today's halt. When
   * the ledger cannot be trusted the concern is read from the verdicts and carries the
   * ledger error, so the kickback takes its cap path instead of a worker run.
   */
  async #mergeConcern(
    repoRoot: string,
    binder: string,
    result: HatchIntegrationResult,
    report: { emit: HatchRunProgress; wave?: number },
  ): Promise<{ role: HatchGateRole; ledgerError?: string } | undefined> {
    const { rows, error } = await this.#recordReview(repoRoot, binder, result, "merge", report);
    if (result.status !== "retry" || result.checkFailure) return undefined;
    const role = error ? verificationConcern(result.verification) : countedConcern(rows);
    if (!role) return undefined;
    return error ? { role, ledgerError: error } : { role };
  }

  /**
   * The doctrine's kickback loop at the point where Pi runs the merge-time gate. While the
   * faulted gate's shared budget remains, the reviewed built ref is dropped, the item's
   * own worker edits its earlier attempt with the current findings seeded as feedback,
   * the unchanged build-time finalization re-gates it, and the new tip integrates again.
   * Runs after the wave's merge pass, one item at a time, on the same lease and with no
   * wave-host ledger, as the serial recovery does. Only integrate() moves the tip, and it
   * is never given an acceptance, so nothing here can waive a finding.
   */
  async #kickBack(input: {
    ctx: ExtensionContext;
    repoRoot: string;
    binder: string;
    item: DeliveryItem;
    lease: DispatchLockLease;
    owner: BinderLifecycleOwner;
    integrationWorktree: string;
    wave: number;
    first: HatchIntegrationResult;
    role: HatchGateRole;
    ledgerError?: string;
    checks: HatchCheckPlanEntry[];
    emit: HatchRunProgress;
  }): Promise<KickbackOutcome> {
    const { ctx, repoRoot, binder, item, lease, owner, integrationWorktree } = input;
    const root = `refs/hatch/${binder}/item-${item.id}`;
    let current = input.first;
    let role = input.role;
    let ledgerError = input.ledgerError;
    let checks = input.checks;
    for (let round = 1; ; round += 1) {
      let state: GateAttemptState | undefined;
      if (!ledgerError) {
        try {
          const attempts = await readAttempts(repoRoot, binder, item.id, await this.#specDigest(repoRoot, binder, item.id));
          ledgerError = attempts.acceptance.error ?? attempts.safety.error;
          state = attempts[gateFileFor(role)];
        } catch (error) {
          ledgerError = (error as Error).message;
        }
      }
      if (ledgerError || !state || state.exhausted) {
        // The cap is spent, or the count cannot be trusted: the halt shape as today.
        await this.#markIntegrationFailed(repoRoot, binder, item.id, current.itemTip);
        const ledger = ledgerError
          ? `\nNo automatic retry: the gate-attempt ledger cannot be trusted (${ledgerError}).`
          : "";
        return {
          status: "failed",
          integration: current,
          reason: `${integrationHaltReason(current)}${ledger}`,
          gate: { role, phase: "merge" },
        };
      }
      if (round > MAX_KICKBACK_ROUNDS) {
        throw new Error("Hatch kickback accounting reached an impossible state");
      }
      const verification = current.verification;
      if (!verification || !current.targetTree) {
        throw new Error("Hatch kickback accounting reached an impossible state");
      }
      const brief = {
        kind: "merge-gate-kickback",
        gate: role,
        attempt: state.counted,
        cap: state.cap,
        itemTip: current.itemTip,
        integrationTip: current.base,
        mergeBase: await git(repoRoot, ["merge-base", current.base, current.itemTip]),
        mergeTree: current.targetTree,
        evidenceHash: verification.evidenceHash,
        // The current attempt's structured findings only: no gate summary, no earlier
        // attempt, no worker narrative.
        findings: (verification.gates[GATE_KEYS[role]]?.findings ?? []).map((finding) => ({
          severity: finding.severity,
          code: finding.code,
          ...(finding.path !== undefined ? { path: finding.path } : {}),
          ...(finding.line !== undefined ? { line: finding.line } : {}),
          message: finding.message,
          ...(finding.nextStep !== undefined ? { nextStep: finding.nextStep } : {}),
        })),
        // The host-proven citation defects of the reviewed merge tree, as the build-time
        // feedback carries them, so the worker sees the exact lines when a finding is vague.
        ...(verification.citationDefects && verification.citationDefects.length > 0
          ? { citationDefects: verification.citationDefects }
          : {}),
      };
      // finalizeCandidate creates built against the null id, and a built item is
      // recovered without a worker, so the reviewed checkpoint goes first.
      await updateRefsTransaction(repoRoot, [`delete ${root}/built ${current.itemTip}`]);
      input.emit({
        kind: "item-kicked-back",
        wave: input.wave,
        item: item.id,
        gate: role,
        attempt: state.counted,
        cap: state.cap,
      });
      const build = await this.#builds.runWithLease(
        ctx,
        binder,
        item.id,
        lease,
        owner,
        [item.id],
        undefined,
        { seedFeedback: [brief] },
      );
      if (build.status === "no-change") {
        // Nothing changed, so the verdict on these bytes stands: halt rather than
        // re-review them. Built is already gone, so failed is created at the same tip.
        const tip = build.commit ?? current.itemTip;
        await updateRefsTransaction(repoRoot, [
          `verify refs/heads/hatch/${binder}/item-${item.id} ${current.itemTip}`,
          `create ${root}/failed ${tip}`,
        ]);
        const reason = noChangeHaltReason(item.id, "merge", role, current.itemTip, build.worker?.summary ?? build.message);
        return {
          status: "failed",
          integration: current,
          reason,
        };
      }
      if (build.status === "failed") {
        // The build-time loop spent the shared cap, or its retry worker changed nothing;
        // either way the finalizer wrote failed.
        const { reason, gate } = failedBuildHalt(build);
        return {
          status: "failed",
          integration: current,
          reason,
          checkFailure: build.finalization?.checkFailure,
          ...(gate ? { gate } : {}),
        };
      }
      if (build.status !== "built") {
        return {
          status: "deferred",
          integration: current,
          buildStatus: build.status,
          reason: buildHaltReason(build),
          checkFailure: build.finalization?.checkFailure,
          verification: build.finalization?.verification,
          ...withNextStep(workerBlockedNextStep(binder, build)),
        };
      }
      const proposed = build.worker?.checks.map((check): HatchCheckPlanEntry => ({ ...check, purpose: "floor" })) ?? [];
      if (proposed.length > 0) checks = proposed;
      const next = await this.#integrations.integrate(
        ctx,
        binder,
        item.id,
        integrationWorktree,
        lease,
        checks,
        { manager: this.#processes, owner },
      );
      const concern = await this.#mergeConcern(repoRoot, binder, next, { emit: input.emit, wave: input.wave });
      current = next;
      if (next.status === "integrated") return { status: "integrated", integration: next, checks };
      if (!concern) {
        await this.#markIntegrationFailed(repoRoot, binder, item.id, next.itemTip);
        return {
          status: "failed",
          integration: next,
          reason: integrationHaltReason(next),
          checkFailure: next.checkFailure,
        };
      }
      role = concern.role;
      ledgerError = concern.ledgerError;
    }
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
    // Backups Clear wrote in this run. Every exit after Clear names them: a result through
    // `report()`, a thrown error through the catch below.
    let keptByClear: UnlandedBranch[] = [];
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
      // One stamp per run, so the backup ref the prompt names is the one Clear writes.
      const clearStamp = backupStamp();
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
        const worktreeDisclosure = dirtyWorktrees.length
          ? `\n\nClear will also delete these worktrees, losing any uncommitted work in them:\n${dirtyWorktrees
              .map((worktree) => `  ${worktree.path}`)
              .join("\n")}`
          : "";
        // Committed work that only a hatch branch holds is named too. A check that fails says
        // so rather than staying silent; Clear itself re-checks and refuses on failure.
        let unlandedDisclosureText: string;
        try {
          const unlanded = await this.#unlandedBranches(repoRoot, binder, clearStamp);
          unlandedDisclosureText = unlanded.length
            ? `\n\n${unlandedDisclosures(unlanded)}`
            : "";
        } catch {
          unlandedDisclosureText = "\n\nHatch could not check for unlanded commits on this binder's branches.";
        }
        const choice = await ctx.ui.select(
          `Binder '${binder}' carries state from an earlier run${worktreeDisclosure}${unlandedDisclosureText}`,
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
        if (choice === "Clear") {
          await this.#clearDelivery(repoRoot, binder, dirtyWorktrees.length > 0, clearStamp, (kept) => {
            keptByClear = kept;
            emit({
              kind: "clear-kept-backups",
              binder,
              kept: kept.map((branch) => ({ backupRef: branch.backupRef, commits: branch.count, restoreName: branch.restoreName })),
              lines: kept.map(keptReport),
            });
          });
        }
      }
      const processContext = { manager: this.#processes, owner };
      // A successor binder (`supersedes`) inherits its predecessor's delivered work. Every
      // result from here on carries the preflight's supersedes report.
      let successorReport: HatchSupersedesReport | undefined;
      // Every halt recorded in this run, in order. The result reports the latest halt per
      // item and drops an item that is done when the run returns, so an item that halted
      // and then landed after Fix and rerun is not reported as halted.
      const halts: HatchDeliveryHalt[] = [];
      // Items kicked back in this run, and the binder's items once it is read: the
      // result's gateAttempts comes from their ledgers.
      const kickedBack = new Set<string>();
      let ledgerItems: string[] = [];
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
        const halted = new Set(halts.map((halt) => halt.item));
        const gateAttempts: HatchGateAttemptRecord[] = [];
        for (const item of ledgerItems) {
          const attempts = await this.#itemAttempts(repoRoot, binder, item);
          if (!("records" in attempts)) continue;
          if (kickedBack.has(item) || halted.has(item) || attempts.records.some((record) => record.counted)) {
            gateAttempts.push(...attempts.records);
          }
        }
        return {
          ...result,
          // Clear's backups go in the message the operator reads, with the command that restores each.
          ...(keptByClear.length > 0
            ? { message: [result.message, ...keptByClear.map(keptReport)].filter(Boolean).join("\n") }
            : {}),
          ...(successorReport ? { supersedes: successorReport } : {}),
          ...(open.length > 0 ? { halts: open } : {}),
          ...(gateAttempts.length > 0 ? { gateAttempts } : {}),
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
      ledgerItems = activeItems.map((item) => item.id);
      emit({
        kind: "binder-loaded",
        items: document.work_items.map((item) => item.id),
        carried: [...carried],
      });
      // Why each item halted in this run, shown at the human's fix/accept/defer prompt,
      // and the gate whose cap halted it, when a cap did. Every halt sets both, so a later
      // halt of another cause never inherits an earlier halt's gate.
      const haltReasons = new Map<string, string>();
      const haltGates = new Map<string, HaltGate>();
      const setHalt = (item: string, reason: string, gate?: HaltGate): void => {
        haltReasons.set(item, reason);
        if (gate) haltGates.set(item, gate);
        else haltGates.delete(item);
      };
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
          const diffBase = await this.#deliveryBase(repoRoot, binder);
          let companions: HatchCompanionResult;
          try {
            companions = await this.#companions.finishDelivery(
              ctx,
              binder,
              integrationWorktree,
              lease,
              { manager: this.#processes, owner },
              { diffBase, sme: document.sme },
            );
          } catch (error) {
            if (!(error instanceof HatchRepositoryAuthorityError)) throw error;
            // The repository may still hold what the writer planted, so no
            // further host git runs: the person checks it by hand first.
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: `${error.message}. Next: ${error.nextStep}`,
              authorityHalt: {
                role: error.role,
                restoreFailure: error.restoreFailure,
                ...(error.result.reason ? { refusal: error.result.reason } : {}),
                nextStep: error.nextStep,
                result: error.result,
              },
            });
          }
          // A refused companion never downgrades a delivery whose items are all
          // done and archived, but it is never silent either: it is named in the
          // message a person actually reads.
          const message = describeCompanionOutcome(companions);
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
        // A marked fix committed past the failed ref is the human's decision: take the
        // Fix-and-rerun route without asking, so the new tip re-validates (checks and
        // both gates, one pass, no waiver). A worker cannot produce this shape, because
        // attestation forbids it to move HEAD.
        const superseded = activeItems.find((item) => states.get(item.id)?.state === "failed-superseded");
        if (superseded) {
          const supersededState = states.get(superseded.id);
          const stale = supersededState?.refs.failed;
          if (!stale || !supersededState?.itemTip) throw new Error("Hatch superseded failed item has no failed ref or item tip");
          await git(repoRoot, ["update-ref", "-d", `refs/hatch/${binder}/item-${superseded.id}/failed`, stale]);
          deferred.delete(superseded.id);
          haltReasons.delete(superseded.id);
          haltGates.delete(superseded.id);
          emit({ kind: "item-hand-fixed", item: superseded.id, failed: stale, tip: supersededState.itemTip });
          continue;
        }
        const failed = activeItems.find((item) => states.get(item.id)?.state === "failed");
        if (failed) {
          const attempts = await this.#itemAttempts(repoRoot, binder, failed.id);
          const haltGate = haltGates.get(failed.id);
          if (!ctx.hasUI) {
            const ledger = "records" in attempts ? attempts : undefined;
            const files = !ledger
              ? []
              : haltGate
                ? [ledger[gateFileFor(haltGate.role)].file]
                : ledger.records.length > 0
                  ? [ledger.acceptance.file, ledger.safety.file]
                  : [];
            return report({
              schema: "hatch-delivery-v1",
              binder,
              status: "blocked",
              integrationWorktree,
              waves,
              message: `Item '${failed.id}' is failed; rerun interactively to choose fix, accept, or defer.${
                files.length > 0 ? ` Its gate attempts are recorded in ${files.join(" and ")}.` : ""
              }${"error" in attempts ? ` Its gate attempts could not be read: ${attempts.error}` : ""}`,
            });
          }
          const choice = await ctx.ui.select(
            failedPrompt(
              binder,
              failed.id,
              haltReasons.get(failed.id) ??
                "it was halted by an earlier run, whose result named the finding; the halt reason is not stored in Git",
              attempts,
              haltGate,
            ),
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
          // The accept-time review is one more verdict on the item's spec: it goes in the
          // ledger with phase accept, and, like a merge-time record, never throws.
          await this.#recordReview(repoRoot, binder, integrated, "accept", { emit, wave: waveNumber });
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
            setHalt(failed.id, reason);
            halts.push(haltRecord(failed.id, "merge", "failed", reason, integrated.checkFailure, hostVerdictNextStep(binder, "failed", integrated.safetyVerification, integrated.verification)));
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
          const halt = build.status === "failed" ? failedBuildHalt(build) : undefined;
          const reason = halt?.reason ?? buildHaltReason(build);
          deferred.set(item.id, { status: build.status, message: reason });
          halts.push(haltRecord(
            item.id,
            "build",
            build.status,
            reason,
            build.finalization?.checkFailure,
            hostVerdictNextStep(binder, "kept", build.finalization?.verification) ?? workerBlockedNextStep(binder, build),
          ));
          // A failed build leaves a failed ref, so the next pass asks the human about
          // it; the prompt names this run's reason rather than an earlier run's.
          if (halt) setHalt(item.id, reason, halt.gate);
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
        // Items whose merge-time review drew a gate's counted concern, kicked back after
        // the pass so no wave-mate's merge waits on another item's worker.
        const kickbacks: { item: DeliveryItem; role: HatchGateRole; ledgerError?: string; first: HatchIntegrationResult }[] = [];
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
          let recovery: HatchBuildItemResult | undefined;
          if (state.state === "merged-unmarked") {
            // Serial recovery after the wave barrier: nothing is building concurrently,
            // so only this item's own worktree may churn.
            recovery = await this.#builds.runWithLease(ctx, binder, item.id, lease, owner, [item.id]);
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
            // A recovery that halted names its own cause, as a halted build does; the
            // generic line is for a state no recovery explains.
            const recovered = recovery && BUILD_HALT_STATUSES.includes(recovery.status) ? recovery : undefined;
            const reason = recovered
              ? buildHaltReason(recovered)
              : `Item '${item.id}' is not in a serially mergeable built state.`;
            deferred.set(item.id, { status: state.state, message: reason });
            halts.push(haltRecord(
              item.id,
              "merge",
              state.state,
              reason,
              recovered?.finalization?.checkFailure,
              hostVerdictNextStep(binder, "kept", recovered?.finalization?.verification),
            ));
            // Should that state be failed, the next pass's prompt names this run's reason.
            setHalt(item.id, reason);
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
          const concern = await this.#mergeConcern(repoRoot, binder, integrated, { emit, wave: waveNumber });
          if (integrated.status === "integrated") {
            landed.add(item.id);
            emit({
              kind: "item-merged",
              wave: waveNumber,
              item: item.id,
              accepted: Boolean(integrated.accepted),
            });
          } else if (concern) {
            // A gate concern, not a failed check: the item keeps its built ref until
            // its kickback runs, and no failed ref is written while budget remains.
            kickbacks.push({ item, role: concern.role, ledgerError: concern.ledgerError, first: integrated });
            kickedBack.add(item.id);
          } else {
            // The documented halt shape for a merge-time review failure: the committed
            // item branch plus a failed ref at its tip, with built gone. That routes the
            // item to the orchestrator's own fix/accept/defer prompt instead of leaving
            // it built, where every later run would re-integrate it and fail the same way.
            // The rest of the wave keeps merging: only this item halts.
            await this.#markIntegrationFailed(repoRoot, binder, item.id, integrated.itemTip);
            const reason = integrationHaltReason(integrated);
            setHalt(item.id, reason);
            // The item now holds a failed ref and waits for the human: "failed", never
            // the integration's retry, since nothing retries it.
            halts.push(haltRecord(item.id, "merge", "failed", reason, integrated.checkFailure, hostVerdictNextStep(binder, "failed", integrated.safetyVerification, integrated.verification)));
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
        for (const kickback of kickbacks) {
          const { item } = kickback;
          const outcome = await this.#kickBack({
            ctx,
            repoRoot,
            binder,
            item,
            lease,
            owner,
            integrationWorktree,
            wave: waveNumber,
            first: kickback.first,
            role: kickback.role,
            ledgerError: kickback.ledgerError,
            checks: itemChecks.get(item.id) ?? [],
            emit,
          });
          // One integration entry per item: the wave's failedItems derives from every
          // entry that did not integrate, so the earlier retry gives way to the final result.
          // A deferred kickback holds no ref and is set aside as a blocked build is, which
          // never has an entry, so its entry is dropped and the wave is not rolled back.
          const entry = waveResult.integrations.indexOf(kickback.first);
          if (outcome.status === "deferred") waveResult.integrations.splice(entry, 1);
          else waveResult.integrations[entry] = outcome.integration;
          if (outcome.status === "integrated") {
            itemChecks.set(item.id, outcome.checks);
            landed.add(item.id);
            emit({
              kind: "item-merged",
              wave: waveNumber,
              item: item.id,
              accepted: Boolean(outcome.integration.accepted),
            });
            continue;
          }
          // The prompt lists the attempts itself; the result and the event carry them
          // after the reason.
          const ledger = await this.#itemAttempts(repoRoot, binder, item.id);
          const reason = withAttempts(outcome.reason, "records" in ledger ? ledger.records : []);
          if (outcome.status === "failed") {
            setHalt(item.id, outcome.reason, outcome.gate);
            halts.push(haltRecord(item.id, "merge", "failed", reason, outcome.checkFailure, hostVerdictNextStep(binder, "failed", outcome.integration.safetyVerification, outcome.integration.verification)));
            integrationFailed = true;
          } else {
            deferred.set(item.id, { status: outcome.buildStatus, message: reason });
            halts.push(haltRecord(item.id, "merge", outcome.buildStatus, reason, outcome.checkFailure, hostVerdictNextStep(binder, "kept", outcome.verification) ?? outcome.nextStep));
          }
          emit({
            kind: "item-halted",
            wave: waveNumber,
            item: item.id,
            status: outcome.status === "failed" ? "failed" : outcome.buildStatus,
            reason,
            ...withCheck(eventCheck(checkDiagnosis(outcome.checkFailure))),
          });
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
    } catch (error) {
      if (keptByClear.length === 0) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error([message, ...keptByClear.map(keptReport)].join("\n"), { cause: error });
    } finally {
      try {
        await this.#processes.stopOwner(owner);
      } finally {
        await this.#locks.release(lease);
      }
    }
  }
}
