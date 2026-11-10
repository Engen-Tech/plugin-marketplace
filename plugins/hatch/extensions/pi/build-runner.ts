import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HatchBuildFinalizer, type HatchBuildFinalizationResult } from "./build-finalizer.ts";
import type { HatchCheckPlanEntry } from "./check-convergence.ts";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import { dropFloorCache, lookupFloorCache, recordFloorCache } from "./floor-cache.ts";
import { itemSpecDigest, readAttempts, recordHostCheck, recordVerification, type HatchGateRole } from "./gate-attempts.ts";
import { effectiveGateVerdict, type HatchGateResult } from "./gate-runner.ts";
import { deriveItemGitState, type HatchItemRecoveryState } from "./git-state.ts";
import { KICKBACK_BUDGET, type ChildFailure, type ChildOutcome, type KickbackSource } from "./child-outcome.ts";
import { noHaltRecordStore, type HaltRecordStore } from "./halt-writer.ts";
import { haltOfBuild, recordItemHalt, workerFailureReason } from "./item-halt.ts";
import {
  hatchProvenance,
  runProgress,
  safeProgress,
  timePhase,
  trackRun,
  type HatchFloorListReused,
  type HatchPhaseMs,
  type HatchProvenance,
  type HatchRunEvent,
  type HatchRunGateAttempt,
  type HatchRunProgress,
} from "./run-events.ts";
import {
  HatchProcessManager,
  type BinderLifecycleOwner,
} from "./process-manager.ts";
import { HatchBuildWorkerRunner, type HatchWorkerResult } from "./worker-runner.ts";
import type { WaveHostLedger } from "./wave-host-ledger.ts";

const exec = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

export type HatchBuildCheckpoint = (
  name:
    | "lock-acquired"
    | "owner-created"
    | "state-derived"
    | "worktree-ready"
    | "before-worker"
    | "first-worker-edit"
    | "worker-attested"
    | "before-finalization"
    | "finalization-returned",
) => Promise<void> | void;

export interface HatchBuildItemResult {
  schema: "hatch-build-item-v1";
  binder: string;
  item: string;
  status: "built" | "failed" | "blocked" | "no-change" | "already-present" | "recovered";
  recoveryState: HatchItemRecoveryState;
  attempts: number;
  worktree?: string;
  commit?: string;
  message: string;
  worker?: HatchWorkerResult;
  finalization?: HatchBuildFinalizationResult;
  /**
   * Set on a `failed` result written by the no-change guard: the worker was sent a gate's
   * findings and changed nothing, so the tip that gate already judged is marked failed.
   * The halt is that unchanged attempt, not a spent attempt cap.
   */
  noChange?: true;
  /**
   * Set on a `blocked` result whose worker child failed: a provider error, or no usable
   * envelope after its corrective turn. Nothing was committed and no ref was written.
   */
  failure?: ChildFailure;
  // What a halt record needs, set once the build has read them: the item tip (the commit,
  // or the worktree HEAD of a candidate that was never committed), the item's spec
  // digest, the worker checks every later worker must re-propose, and each gate file's
  // counted attempts when the build returned.
  itemTip?: string;
  specDigest?: string;
  requiredCheckIds?: string[];
  gateAttempts?: { acceptance: number; safety: number };
  /**
   * Set on a `failed` result whose gate cap ran out: the gate whose cap this build's last
   * round spent. One round can carry concerns from more gates than the one it spent.
   */
  capGate?: HatchGateRole;
  /**
   * Set when the build halted and its halt record could not be kept: why. A `failed` ref
   * was written all the same, alone; any other halt is unchanged. The delivery reports
   * this as an `item-halt-unrecorded` event.
   */
  haltUnrecorded?: string;
  /** This build's phase time: worker, checks (finalization less its gates) and gates. */
  phaseMs?: HatchPhaseMs;
  /** Set on a standalone build's result: the hatch version and commit that ran it. */
  hatch?: HatchProvenance;
}

// Filled by a build as it reads each value, so the result can carry them whichever
// return the build took.
interface BuildTrace {
  // Set when the build only re-reported a state an earlier run decided (terminalRecovery).
  reReport?: boolean;
  specDigest?: string;
  requiredCheckIds?: ReadonlySet<string>;
  gateAttempts?: () => { acceptance: number; safety: number };
  // Why the halt record of a `failed` write could not be kept, set by the write's callback.
  haltUnrecorded?: string;
}

// The trace's values as result fields, read when called.
function traceFields(trace: BuildTrace): Partial<HatchBuildItemResult> {
  return {
    ...(trace.specDigest ? { specDigest: trace.specDigest } : {}),
    ...(trace.requiredCheckIds ? { requiredCheckIds: [...trace.requiredCheckIds] } : {}),
    ...(trace.gateAttempts ? { gateAttempts: trace.gateAttempts() } : {}),
    ...(trace.haltUnrecorded !== undefined ? { haltUnrecorded: trace.haltUnrecorded } : {}),
  };
}

// Whether a build's halt record is written alone, after the build returns. A `failed` build
// kept its record in the `failed` write; a build that only re-reports a state an earlier
// run decided (failed, failed-superseded, inconsistent, accept-pending) writes nothing, so
// the halt the item holds stays.
function writesHaltAlone(result: HatchBuildItemResult, trace: BuildTrace): boolean {
  return !trace.reReport && result.status !== "built" && result.status !== "recovered" && result.status !== "failed";
}

async function traced(result: HatchBuildItemResult, trace: BuildTrace): Promise<HatchBuildItemResult> {
  const itemTip = result.commit ??
    (result.worktree ? await git(result.worktree, ["rev-parse", "HEAD"]).catch(() => undefined) : undefined);
  return { ...result, ...(itemTip ? { itemTip } : {}), ...traceFields(trace) };
}

// One build attempt's gate verdicts and host-check rows. Built from the finalization, not
// the ledger, so it is reported even when the ledger cannot be read or written. `counted`
// is the ledger's own count per gate file before this attempt; each row is then numbered
// as the ledger numbers it (1 + the file's counted concerns before the row). Without it,
// as when `unrecorded` names why no row was written, no attempt number is given.
function finalizationReview(
  item: string,
  finalization: HatchBuildFinalizationResult,
  counted: { acceptance: number; safety: number } | undefined,
  unrecorded: string | undefined,
): Extract<HatchRunEvent, { kind: "gate-reviewed" }> | undefined {
  const gates: HatchRunGateAttempt[] = [];
  const add = (
    role: "acceptance-gate" | "safety-gate" | "visual-gate",
    verdict: string,
    findings: readonly { severity: string; code: string }[],
    source?: string,
  ) => {
    const file = role === "safety-gate" ? "safety" : "acceptance";
    const isConcern = verdict === "concerns";
    gates.push({
      role,
      ...(counted ? { attempt: counted[file] + 1 } : {}),
      verdict,
      counted: isConcern,
      findings: findings.map((finding) => ({ severity: finding.severity, code: finding.code })),
      ...(source ? { source } : {}),
    });
    if (counted && isConcern) counted[file] += 1;
  };
  const verdicts = finalization.verification?.gates;
  if (verdicts && finalization.targetTree) {
    if (verdicts.acceptance) add("acceptance-gate", effectiveGateVerdict("acceptance-gate", verdicts.acceptance.verdict, verdicts.acceptance.findings), verdicts.acceptance.findings);
    if (verdicts.safety) add("safety-gate", effectiveGateVerdict("safety-gate", verdicts.safety.verdict, verdicts.safety.findings), verdicts.safety.findings);
    if (verdicts.visual) add("visual-gate", effectiveGateVerdict("visual-gate", verdicts.visual.verdict, verdicts.visual.findings), verdicts.visual.findings);
  }
  if (finalization.citationCheck && finalization.targetTree) add("safety-gate", "concerns", finalization.citationCheck.findings, "host-citation-check");
  if (finalization.workerCheckFailure && finalization.targetTree) add("safety-gate", "concerns", finalization.workerCheckFailure.findings, "host-worker-check");
  if (gates.length === 0) return undefined;
  return { kind: "gate-reviewed", item, phase: "build", gates, ...(unrecorded ? { unrecorded } : {}) };
}

// Runs a build as a phase-time collector and stamps its own phase time on the result.
async function withPhaseMs(
  progress: HatchRunProgress | undefined,
  build: () => Promise<HatchBuildItemResult>,
): Promise<HatchBuildItemResult> {
  const { value, phaseMs } = await trackRun(progress, build);
  return { ...value, phaseMs };
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during build orchestration`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sameExistingPath(left: string, right: string): Promise<boolean> {
  const [leftReal, rightReal] = await Promise.all([realpath(left), realpath(right)]);
  return process.platform === "win32"
    ? leftReal.toLowerCase() === rightReal.toLowerCase()
    : leftReal === rightReal;
}

function parseAssignment(raw: string, binder: string, item: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Hatch binder '${binder}' is not valid JSON at the integration tip`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hatch binder '${binder}' is not an object`);
  }
  const document = value as { slug?: unknown; work_items?: unknown };
  if (document.slug !== binder || !Array.isArray(document.work_items)) {
    throw new Error(`Hatch binder '${binder}' has invalid identity or work_items`);
  }
  const matches = document.work_items.filter(
    (candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).id === item,
  );
  if (matches.length !== 1) {
    throw new Error(`Hatch binder '${binder}' must contain item '${item}' exactly once`);
  }
  return matches[0];
}

function terminalRecovery(
  binder: string,
  item: string,
  state: Awaited<ReturnType<typeof deriveItemGitState>>,
): HatchBuildItemResult | undefined {
  if (state.state === "done" || state.state === "built") {
    return {
      schema: "hatch-build-item-v1",
      binder,
      item,
      status: "recovered",
      recoveryState: state.state,
      attempts: 0,
      worktree: state.worktree,
      commit: state.state === "built" ? state.refs.built : state.itemTip,
      message: state.nextAction,
    };
  }
  if (
    state.state === "failed" ||
    state.state === "accept-merge-pending" ||
    state.state === "accept-ref-pending"
  ) {
    return {
      schema: "hatch-build-item-v1",
      binder,
      item,
      status: "blocked",
      recoveryState: state.state,
      attempts: 0,
      worktree: state.worktree,
      commit: state.itemTip,
      message: state.nextAction,
    };
  }
  if (state.state === "failed-superseded") {
    return {
      schema: "hatch-build-item-v1",
      binder,
      item,
      status: "blocked",
      recoveryState: state.state,
      attempts: 0,
      worktree: state.worktree,
      commit: state.itemTip,
      message:
        "A marked fix was committed past the failed ref; run the delivery to re-validate it. " +
        "The delivery runner owns that transition.",
    };
  }
  if (state.state === "inconsistent") {
    return {
      schema: "hatch-build-item-v1",
      binder,
      item,
      status: "blocked",
      recoveryState: state.state,
      attempts: 0,
      worktree: state.worktree,
      commit: state.itemTip,
      message: state.nextAction,
    };
  }
  return undefined;
}

// Every gate cap a retry spends, read from the policy table. Acceptance and safety run in
// parallel, so one round can spend both, each against its own cap.
function retryKinds(result: HatchBuildFinalizationResult): ("acceptance" | "safety")[] {
  // The citation pre-check applies the safety auditor's rule without a gate run. A failed
  // check the worker proposed spends the cap its row in the table names: it is the
  // worker's own floor.
  if (result.citationCheck) return [KICKBACK_BUDGET["host-citation-check"].cap];
  if (result.workerCheckFailure) return [KICKBACK_BUDGET["host-worker-check"].cap];
  const gates = result.verification?.gates;
  // The effective verdict, as the ledger counts it: a minor-only acceptance or visual
  // concern is a pass with notes and spends nothing.
  const concerns = (role: HatchGateResult["role"], gate?: { verdict: HatchGateResult["verdict"]; findings: HatchGateResult["findings"] }) =>
    gate !== undefined && effectiveGateVerdict(role, gate.verdict, gate.findings) === "concerns";
  const sources: KickbackSource[] = [];
  // A visual gate concern is a fidelity kickback, retried under the same bounded
  // acceptance-attempt cap as an acceptance concern; on cap exhaustion the host writes the
  // failed ref exactly as a capped acceptance/safety concern does.
  if (concerns("acceptance-gate", gates?.acceptance)) sources.push("acceptance-concern");
  if (concerns("visual-gate", gates?.visual)) sources.push("visual-concern");
  if (concerns("safety-gate", gates?.safety)) sources.push("safety-concern");
  // Acceptance and visual share one cap, so a round with both spends it once.
  return [...new Set(sources.map((source) => KICKBACK_BUDGET[source].cap))];
}

// The gate whose cap a round spent, in the order item-halt.ts concernGate reads them:
// acceptance, then visual (the two share the acceptance cap), then safety.
function spentCapGate(
  result: HatchBuildFinalizationResult,
  spent: { acceptance: boolean; safety: boolean },
): HatchGateRole | undefined {
  const gates = result.verification?.gates;
  const concerns = (role: HatchGateRole, gate?: { verdict: HatchGateResult["verdict"]; findings: HatchGateResult["findings"] }) =>
    gate !== undefined && effectiveGateVerdict(role, gate.verdict, gate.findings) === "concerns";
  if (spent.acceptance && concerns("acceptance-gate", gates?.acceptance)) return "acceptance-gate";
  if (spent.acceptance && concerns("visual-gate", gates?.visual)) return "visual-gate";
  if (spent.safety && concerns("safety-gate", gates?.safety)) return "safety-gate";
  return undefined;
}

export class HatchBuildItemRunner {
  readonly #locks: DispatchLockManager;
  readonly #workers: HatchBuildWorkerRunner;
  readonly #finalizer: HatchBuildFinalizer;
  readonly #processes: HatchProcessManager;
  readonly #checkpoint: HatchBuildCheckpoint;
  readonly #probeGates: (ctx: ExtensionContext) => Promise<string | undefined>;
  readonly #haltStore: HaltRecordStore;

  constructor(
    locks: DispatchLockManager,
    workers: HatchBuildWorkerRunner,
    finalizer: HatchBuildFinalizer,
    processes: HatchProcessManager,
    checkpoint: HatchBuildCheckpoint = () => {},
    probeGates: (ctx: ExtensionContext) => Promise<string | undefined> = async () => undefined,
    // Keeps a halted build's record: in the finalizer's `failed` transaction, or alone once
    // the build has returned. index.ts passes the Git store.
    haltStore: HaltRecordStore = noHaltRecordStore,
  ) {
    this.#haltStore = haltStore;
    this.#locks = locks;
    this.#workers = workers;
    this.#finalizer = finalizer;
    this.#processes = processes;
    this.#checkpoint = checkpoint;
    this.#probeGates = probeGates;
  }

  async run(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    progress?: HatchRunProgress,
  ): Promise<HatchBuildItemResult> {
    const lease = await this.#locks.acquire(ctx.cwd, binder);
    let owner: BinderLifecycleOwner;
    try {
      await this.#checkpoint("lock-acquired");
      owner = this.#processes.createBinderOwner(ctx.cwd, binder);
      await this.#checkpoint("owner-created");
    } catch (error) {
      await this.#locks.release(lease);
      throw error;
    }
    // Only now does the run own the binder; a run refused the lock never reports a start.
    safeProgress(progress)({ kind: "run-started", binder, item });
    try {
      // Before the worker and any check, so a gate model that cannot answer costs neither.
      const refused = await this.#probeGates(ctx);
      if (refused) {
        const { state } = await deriveItemGitState(ctx.cwd, binder, item);
        return { schema: "hatch-build-item-v1", binder, item, status: "blocked", recoveryState: state, attempts: 0, message: `Build stopped before the worker: ${refused}`, hatch: hatchProvenance() };
      }
      const trace: BuildTrace = {};
      // The run-start probe above is a whole-run stop, not an item halt; a build that
      // halted is one, and its record is written while this run still holds the binder.
      // A standalone build has no wave-mates, so no host session.
      const result = await this.#writeHalt(
        ctx.cwd,
        await traced(
          await withPhaseMs(progress, () =>
            this.#runLocked(ctx, binder, item, lease, owner, [item], undefined, undefined, safeProgress(progress), trace)),
          trace,
        ),
        trace,
      );
      // A halted build kept its record, or says here why it could not.
      if (result.haltUnrecorded !== undefined) {
        safeProgress(progress)({ kind: "item-halt-unrecorded", item, error: result.haltUnrecorded });
      }
      return { ...result, hatch: hatchProvenance() };
    } finally {
      try {
        await this.#processes.stopOwner(owner);
      } finally {
        await this.#locks.release(lease);
      }
    }
  }

  async runWithLease(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    lease: DispatchLockLease,
    owner: BinderLifecycleOwner,
    waveMates: readonly string[] = [item],
    ledger?: WaveHostLedger,
    options?: { seedFeedback?: unknown[]; onFloorListReused?: (event: HatchFloorListReused) => void },
  ): Promise<HatchBuildItemResult> {
    if (!(await this.#locks.owns(lease)) || owner.binder !== binder) {
      throw new Error("Hatch build item requires its delivery-owned binder lease and lifecycle");
    }
    const trace: BuildTrace = {};
    const result = await traced(
      await withPhaseMs(undefined, () =>
        this.#runLocked(ctx, binder, item, lease, owner, waveMates, ledger, options?.seedFeedback, options?.onFloorListReused, trace)),
      trace,
    );
    if (!writesHaltAlone(result, trace)) return result;
    // The record is a write under this item's root while wave-mates' workers may run, so it
    // is made in a host session: the ledger then records it as this host's, not a worker's.
    const session = ledger?.session(item);
    await session?.resume();
    try {
      return await this.#writeHalt(ctx.cwd, result, trace);
    } finally {
      await session?.close();
    }
  }

  // Writes the record of a build that halted with no `failed`, alone, mapped from the
  // result the build returns: the same mapping the delivery makes of it again
  // (delivery-runner.ts buildHaltOf; build-runner.test.ts pins them equal). Never throws:
  // a record that cannot be kept leaves the halt unchanged, and the result carries why on
  // `haltUnrecorded`.
  async #writeHalt(cwd: string, result: HatchBuildItemResult, trace: BuildTrace): Promise<HatchBuildItemResult> {
    if (!writesHaltAlone(result, trace)) return result;
    const integrationTip = await git(cwd, ["rev-parse", "--verify", `refs/heads/hatch/${result.binder}/integration`])
      .catch(() => null);
    const { sinkError } = await recordItemHalt(
      { ...haltOfBuild(result, { integrationTip }), reason: result.message },
      (halt) => this.#haltStore.write(cwd, halt),
    );
    return sinkError === undefined ? result : { ...result, haltUnrecorded: sinkError };
  }

  // The halt record's line for the finalizer's `failed` write, mapped from the result this
  // build returns once `failed` stands at `commit`: the same mapping the delivery makes of
  // it again (delivery-runner.ts buildHaltOf; build-runner.test.ts pins them equal). Never
  // throws: a record that cannot be kept gives no line, `failed` is written alone, and the
  // result carries why on `haltUnrecorded`.
  #failedHaltLines(
    repoRoot: string,
    trace: BuildTrace,
    provisional: (commit: string) => HatchBuildItemResult,
  ): (commit: string) => Promise<readonly string[]> {
    return async (commit) => {
      const build: HatchBuildItemResult = { ...provisional(commit), itemTip: commit, ...traceFields(trace) };
      const integrationTip = await git(repoRoot, ["rev-parse", "--verify", `refs/heads/hatch/${build.binder}/integration`])
        .catch(() => null);
      let lines: readonly string[] = [];
      const { sinkError } = await recordItemHalt(
        { ...haltOfBuild(build, { integrationTip }), reason: build.message },
        async (halt) => {
          lines = await this.#haltStore.lines(repoRoot, halt);
        },
      );
      if (sinkError !== undefined) trace.haltUnrecorded = sinkError;
      return lines;
    };
  }

  async #runLocked(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    lease: DispatchLockLease,
    owner: BinderLifecycleOwner,
    waveMates: readonly string[],
    ledger?: WaveHostLedger,
    seedFeedback?: unknown[],
    onFloorListReused?: (event: HatchFloorListReused) => void,
    trace: BuildTrace = {},
  ): Promise<HatchBuildItemResult> {
      // The whole of a build's host work is a host phase for its item, except the
      // worker invocation itself. The ledger records the surface the host authored
      // before pausing for the worker and again after finalization, so a wave-mate
      // is not blamed for this host's mid-wave writes. The host never waits on a
      // worker or an attestation; only worker snapshots wait on host phases.
      const session = ledger?.session(item);
      await session?.resume();
      try {
      let state = await deriveItemGitState(ctx.cwd, binder, item);
      await this.#checkpoint("state-derived");
      const terminal = terminalRecovery(binder, item, state);
      if (terminal) {
        trace.reReport = true;
        return terminal;
      }

      const repoRoot = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
      // A new attempt: the last halt's record no longer says why the item is stopped.
      // Deleted here, inside this item's host phase; a re-report above keeps it.
      await this.#haltStore.clear(repoRoot, binder, item);
      const integrationRef = `refs/heads/hatch/${binder}/integration`;
      const assignment = parseAssignment(
        await git(repoRoot, ["show", `${integrationRef}:.hatch/binders/${binder}.json`]),
        binder,
        item,
      );
      const branch = `hatch/${binder}/item-${item}`;
      let worktree = state.worktree;
      if (!worktree) {
        const worktreeRoot = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
        worktree = join(worktreeRoot, branch.replaceAll("/", "-"));
        await mkdir(worktreeRoot, { recursive: true });
        if (await pathExists(worktree)) {
          throw new Error(`Hatch refuses to clobber existing worktree path: ${worktree}`);
        }
        if (state.state === "not-started") {
          await git(repoRoot, ["worktree", "add", worktree, "-b", branch, integrationRef]);
        } else {
          await git(repoRoot, ["worktree", "add", worktree, branch]);
        }
        state = await deriveItemGitState(repoRoot, binder, item);
        if (!state.worktree || !(await sameExistingPath(state.worktree, worktree))) {
          throw new Error("Hatch could not prove ownership of the item worktree it created");
        }
      }
      await this.#checkpoint("worktree-ready");

      // The gate-attempt ledger is shared with merge-time verdicts and survives the
      // process, so the counts start from what it holds for this item spec. A malformed
      // ledger reads as exhausted with an error; then nothing is appended and the first
      // concern halts, naming the file.
      const specDigest = itemSpecDigest(assignment);
      const persisted = await readAttempts(repoRoot, binder, item, specDigest);
      const ledgerError = persisted.acceptance.error ?? persisted.safety.error;
      const acceptanceCap = persisted.acceptance.cap;
      const safetyCap = persisted.safety.cap;
      let feedback: unknown[] = seedFeedback ?? [];
      let attempts = 0;
      let acceptanceAttempts = persisted.acceptance.counted;
      let safetyAttempts = persisted.safety.counted;
      let previous: HatchBuildFinalizationResult | undefined;
      // Ids of worker-proposed checks that failed at the host and went back to the worker.
      // Every later worker must propose a check with each id, so a worker can never pass
      // its own floor by deleting the check that failed.
      const requiredCheckIds = new Set<string>();
      trace.specDigest = specDigest;
      trace.requiredCheckIds = requiredCheckIds;
      trace.gateAttempts = () => ({ acceptance: acceptanceAttempts, safety: safetyAttempts });
      // The first round always runs, so a resumed run or a Fix and rerun validates once;
      // a further round needs budget in the gate that raised the concern, which the cap
      // test after each concern enforces. Each gate is capped on its own count only.
      while (attempts === 0 || acceptanceAttempts < acceptanceCap || safetyAttempts < safetyCap) {
        attempts += 1;
        const beforeWorker = await deriveItemGitState(worktree, binder, item);
        const recoverCommitted = beforeWorker.state === "committed-unmarked";
        const recoverMerged = beforeWorker.state === "merged-unmarked";
        // The first round of a recovery only needs a worker for its floor list, so a stored
        // list for this spec stands in for it, on this item tree or after a hand fix that
        // floor-cache.ts judges still fits it. A round with feedback edits,
        // so it always runs a worker.
        const stored = feedback.length === 0 && (recoverCommitted || recoverMerged)
          ? await lookupFloorCache(repoRoot, {
              binder,
              item,
              specDigest,
              tree: await git(repoRoot, ["rev-parse", `refs/heads/${branch}^{tree}`]),
              // Only a committed recovery can follow a hand fix: a landed tree already merged.
              handFix: recoverCommitted,
            })
          : undefined;
        const reused = stored?.hit ? stored : undefined;
        if (reused) {
          onFloorListReused?.({ kind: "floor-list-reused", item, match: reused.match, commands: reused.checks.length });
        }
        await this.#checkpoint("before-worker");
        await session?.pause();
        let outcome: ChildOutcome<HatchWorkerResult> | undefined;
        try {
          outcome = reused ? undefined : await timePhase("worker", () => this.#workers.run(
            ctx,
            worktree,
            branch,
            binder,
            item,
            assignment,
            feedback,
            owner.id,
            // A run that follows a gate concern always edits; a landed item never does.
            recoverMerged
              ? "recover-merged"
              : feedback.length > 0
                ? "implement"
                : recoverCommitted ? "recover-committed" : "implement",
            () => this.#checkpoint("first-worker-edit"),
            waveMates,
            ledger,
          ));
        } finally {
          await session?.resume();
        }
        if (outcome && !outcome.ok) {
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            message: workerFailureReason(outcome.failure, binder, item),
            failure: outcome.failure,
          };
        }
        const worker = outcome?.value;
        if (worker) await this.#checkpoint("worker-attested");
        if (worker?.outcome === "blocked") {
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            message: worker.summary,
            worker,
          };
        }
        const proposed = worker?.checks ?? reused?.checks ?? [];
        const dropped = [...requiredCheckIds].filter((id) => !proposed.some((check) => check.id === id));
        if (dropped.length > 0) {
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            message:
              `Worker check ${dropped.map((id) => `'${id}'`).join(", ")} failed at the host and went back to the ` +
              "worker, and the next worker's checks left it out: the failing check was not re-proposed. A worker " +
              "cannot drop a failing check from its own floor, so the item halts blocked.",
            worker,
          };
        }
        const checks: HatchCheckPlanEntry[] = proposed.map((check) => ({
          ...check,
          purpose: "floor",
        }));
        const afterWorker = await deriveItemGitState(worktree, binder, item);
        if (recoverMerged && afterWorker.state !== "merged-unmarked") {
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            message: "Worker changed the item worktree during landed-merge recovery.",
            worker,
          };
        }
        if (worker && !recoverMerged && feedback.length > 0 && afterWorker.state === "committed-unmarked") {
          // The worker was sent findings and changed nothing, so the committed tip is the
          // tip the gate already judged. Re-reviewing it would be a reviewer re-roll.
          if (previous?.status === "retry" && previous.commit) {
            const reviewed = previous;
            const failed = await this.#finalizer.recordRecoveredFailedCandidate(
              binder,
              item,
              worktree,
              lease,
              previous,
              this.#failedHaltLines(repoRoot, trace, (commit) => ({
                schema: "hatch-build-item-v1",
                binder,
                item,
                status: "failed",
                recoveryState: state.state,
                attempts,
                worktree,
                commit,
                message: reviewed.message,
                worker,
                finalization: { ...reviewed, status: "failed", commit },
                noChange: true,
              })),
            );
            if (failed.status !== "failed") {
              return {
                schema: "hatch-build-item-v1",
                binder,
                item,
                status: "blocked",
                recoveryState: state.state,
                attempts,
                worktree,
                commit: failed.commit,
                message: failed.message,
                worker,
                finalization: failed,
              };
            }
            return {
              schema: "hatch-build-item-v1",
              binder,
              item,
              status: "failed",
              recoveryState: state.state,
              attempts,
              worktree,
              commit: failed.commit,
              message:
                "The worker was sent the gate's findings and changed nothing, so the reviewed tip " +
                "is marked failed with that review.",
              worker,
              finalization: failed,
              noChange: true,
            };
          }
          // A seeded merge kickback: no new verdict, so no ledger row.
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "no-change",
            recoveryState: state.state,
            attempts,
            worktree,
            commit: afterWorker.itemTip,
            message: worker.summary,
            worker,
          };
        }
        // A round that goes to finalization clears the floor cache file, and one that reaches
        // the gates writes it back below. So a crash leaves no list, and a list that fails is
        // gone: the next run asks a worker instead of halting on a stale command. A landed
        // item's round finalizes on the merge tree, so it neither drops nor writes.
        if (!recoverMerged) await dropFloorCache(repoRoot, binder, item);
        const recoveringExactCommit = afterWorker.state === "committed-unmarked";
        await this.#checkpoint("before-finalization");
        // Finalization time less its gate reviews is the build's check time.
        const finalization = await timePhase("checks", async () => recoverMerged
          ? await this.#finalizer.recoverMergedCandidate(
              ctx,
              binder,
              item,
              worktree,
              lease,
              checks,
              { manager: this.#processes, owner },
            )
          : recoveringExactCommit
            ? await this.#finalizer.recoverCommittedCandidate(
              ctx,
              binder,
              item,
              worktree,
              lease,
              checks,
              { manager: this.#processes, owner },
            )
          : await this.#finalizer.finalizeCandidate(
              ctx,
              binder,
              item,
              worktree,
              lease,
              checks,
              { manager: this.#processes, owner },
              // The citation pre-check never spends the last safety attempt, and neither
              // does the worker-check kickback: on that attempt the pre-check yields to the
              // gates, and a failed worker check halts blocked with no worker retry.
              {
                citationPrecheck: !ledgerError && safetyAttempts + 1 < safetyCap,
                workerCheckKickback: !ledgerError && safetyAttempts + 1 < safetyCap,
              },
            ));
        await this.#checkpoint("finalization-returned");
        // The finalizer sets `targetTree` with every verification: it is the tree the
        // gate evidence bound (the staged candidate tree or the committed tip's tree).
        // A staged candidate has no commit yet, so its item tip is the worktree HEAD.
        // Every attempt's verdicts and codes are reported from the finalization itself,
        // before and whatever the ledger write, so an unreadable ledger hides nothing.
        // The numbers come from the ledger, read before this attempt's rows are written (the
        // finalizer writes none). The gates run in parallel since G2, so a round reports both
        // verdicts, and the loop's own counters raise each gate that had concerns.
        let counted: { acceptance: number; safety: number } | undefined;
        if (!ledgerError) {
          try {
            const before = await readAttempts(repoRoot, binder, item, specDigest);
            if (!before.acceptance.error && !before.safety.error) {
              counted = { acceptance: before.acceptance.counted, safety: before.safety.counted };
            }
          } catch {
            // No numbers then; the verdicts and codes are still reported.
          }
        }
        const review = finalizationReview(item, finalization, counted, ledgerError);
        if (review) runProgress()(review);
        if (finalization.verification && finalization.targetTree && !ledgerError) {
          await recordVerification(repoRoot, {
            binder,
            item,
            specDigest,
            phase: "build",
            itemTip: finalization.commit ?? (await git(worktree, ["rev-parse", "HEAD"])),
            reviewedTree: finalization.targetTree,
            verification: finalization.verification,
          });
        }
        // Only a finalization that reached the gates carries a verification, so every stored
        // list passed the host checks and the parity probe on this exact tree. Unlike the
        // ledger row this ignores `ledgerError`: the file says nothing about attempt counts.
        if (finalization.verification && finalization.targetTree && !recoverMerged) {
          await recordFloorCache(
            repoRoot,
            { binder, item, specDigest, tree: finalization.targetTree, integrationRef, itemRef: `refs/heads/${branch}` },
            proposed,
          );
        }
        if (finalization.citationCheck && finalization.targetTree && !ledgerError) {
          await recordHostCheck(repoRoot, {
            binder,
            item,
            specDigest,
            phase: "build",
            itemTip: await git(worktree, ["rev-parse", "HEAD"]),
            reviewedTree: finalization.targetTree,
            diff: finalization.citationCheck.diff,
            evidenceHash: finalization.citationCheck.evidenceHash,
            findings: finalization.citationCheck.findings,
          });
        }
        if (finalization.workerCheckFailure && finalization.targetTree && !ledgerError) {
          await recordHostCheck(repoRoot, {
            binder,
            item,
            specDigest,
            phase: "build",
            itemTip: await git(worktree, ["rev-parse", "HEAD"]),
            reviewedTree: finalization.targetTree,
            diff: finalization.workerCheckFailure.diff,
            evidenceHash: finalization.workerCheckFailure.evidenceHash,
            findings: finalization.workerCheckFailure.findings,
            source: "host-worker-check",
          });
        }
        if (
          finalization.status === "built" ||
          finalization.status === "no-change" ||
          finalization.status === "already-present"
        ) {
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: recoverMerged || recoveringExactCommit ? "recovered" : finalization.status,
            recoveryState: state.state,
            attempts,
            worktree,
            commit: finalization.commit,
            message: finalization.message,
            worker,
            finalization,
          };
        }
        if (recoverMerged) {
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            commit: finalization.commit,
            message: finalization.message,
            worker,
            finalization,
          };
        }
        if (finalization.status !== "retry") {
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: finalization.status === "failed" ? "failed" : "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            commit: finalization.commit,
            message: finalization.message,
            worker,
            finalization,
          };
        }
        const kinds = retryKinds(finalization);
        if (kinds.length === 0) {
          // The oracle, an environment-setup check, or a worker check past its kickback
          // failed — not a gate or host check raising a retryable concern. A failing
          // environment or a broken merged tip is not fixed by re-prompting, so halt
          // cleanly with the check diagnostic instead of looping or crashing.
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            commit: finalization.commit,
            message: finalization.message,
            worker,
            finalization,
          };
        }
        if (kinds.includes("acceptance")) acceptanceAttempts += 1;
        if (kinds.includes("safety")) safetyAttempts += 1;
        const spent = {
          acceptance: kinds.includes("acceptance") && acceptanceAttempts >= acceptanceCap,
          safety: kinds.includes("safety") && safetyAttempts >= safetyCap,
        };
        const capped = Boolean(ledgerError) || spent.acceptance || spent.safety;
        if (capped && (finalization.citationCheck || finalization.workerCheckFailure)) {
          // Both host checks are off on the last safety attempt and with an unreadable ledger,
          // so a finalizer broke that contract. The candidate has no commit and no gate
          // verdict, so nothing is committed and no failed ref is written: the item halts
          // blocked as a spent safety cap and the run goes on.
          const check = finalization.citationCheck ? "repo-rule citation check" : "worker-check kickback";
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            message: `The host's ${check} reached the safety cap (${safetyAttempts} of ${safetyCap} safety attempts); the candidate is not committed and no failed ref is written. Fix it by hand and rerun.`,
            worker,
            finalization,
          };
        }
        if (capped) {
          // The gate whose cap ran out, from the cap test itself; none when the ledger
          // cannot be trusted, since no cap was read.
          const capGate = ledgerError ? undefined : spentCapGate(finalization, spent);
          const named = capGate ? { capGate } : {};
          const haltLines = this.#failedHaltLines(repoRoot, trace, (commit) => ({
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: "failed",
            recoveryState: state.state,
            attempts,
            worktree,
            commit,
            message: finalization.message,
            worker,
            finalization: { ...finalization, status: "failed", commit },
            ...named,
          }));
          const failed = recoveringExactCommit
            ? await this.#finalizer.recordRecoveredFailedCandidate(
                binder,
                item,
                worktree,
                lease,
                finalization,
                haltLines,
              )
            : await this.#finalizer.recordFailedCandidate(
                ctx,
                binder,
                item,
                worktree,
                lease,
                finalization,
                { manager: this.#processes, owner },
                haltLines,
              );
          return {
            schema: "hatch-build-item-v1",
            binder,
            item,
            status: failed.status === "failed" ? "failed" : "blocked",
            recoveryState: state.state,
            attempts,
            worktree,
            commit: failed.commit,
            message: ledgerError
              ? `${failed.message} No retry: the gate-attempt ledger cannot be trusted (${ledgerError}).`
              : failed.message,
            worker,
            finalization: failed,
            ...(failed.status === "failed" ? named : {}),
          };
        }
        if (finalization.citationCheck) {
          // A pre-check result has no commit and no verification, so it never becomes the
          // result the no-change guard acts on.
          feedback = [{
            kind: "repo-rule-citation-check",
            gate: "safety-gate",
            attempt: safetyAttempts,
            cap: safetyCap,
            evidenceHash: finalization.citationCheck.evidenceHash,
            findings: finalization.citationCheck.findings,
          }];
          continue;
        }
        if (finalization.workerCheckFailure) {
          // Like the pre-check, a kickback has no commit and no verification.
          requiredCheckIds.add(finalization.workerCheckFailure.check.id);
          feedback = [{
            kind: "worker-check-failure",
            gate: "safety-gate",
            attempt: safetyAttempts,
            cap: safetyCap,
            evidenceHash: finalization.workerCheckFailure.evidenceHash,
            check: finalization.workerCheckFailure.check,
            findings: finalization.workerCheckFailure.findings,
          }];
          continue;
        }
        previous = finalization;
        feedback = [finalization.verification];
      }
      throw new Error("Hatch build retry accounting reached an impossible state");
      } finally {
        await session?.close();
      }
  }
}
