import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HatchBuildFinalizer, type HatchBuildFinalizationResult } from "./build-finalizer.ts";
import type { HatchCheckPlanEntry } from "./check-convergence.ts";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import { itemSpecDigest, readAttempts, recordHostCheck, recordVerification } from "./gate-attempts.ts";
import { deriveItemGitState, type HatchItemRecoveryState } from "./git-state.ts";
import { safeProgress, type HatchRunProgress } from "./run-events.ts";
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

function retryKind(result: HatchBuildFinalizationResult): "acceptance" | "safety" | undefined {
  // The citation pre-check applies the safety auditor's rule without a gate run. A failed
  // check the worker proposed spends the same count: it is the worker's own floor.
  if (result.citationCheck || result.workerCheckFailure) return "safety";
  if (result.verification?.gates.acceptance?.verdict === "concerns") return "acceptance";
  // A visual gate concern is a fidelity kickback, retried under the same bounded
  // acceptance-attempt cap as an acceptance concern; on cap exhaustion the host writes the
  // failed ref exactly as a capped acceptance/safety concern does.
  if (result.verification?.gates.visual?.verdict === "concerns") return "acceptance";
  if (result.verification?.gates.safety?.verdict === "concerns") return "safety";
  return undefined;
}

export class HatchBuildItemRunner {
  readonly #locks: DispatchLockManager;
  readonly #workers: HatchBuildWorkerRunner;
  readonly #finalizer: HatchBuildFinalizer;
  readonly #processes: HatchProcessManager;
  readonly #checkpoint: HatchBuildCheckpoint;

  constructor(
    locks: DispatchLockManager,
    workers: HatchBuildWorkerRunner,
    finalizer: HatchBuildFinalizer,
    processes: HatchProcessManager,
    checkpoint: HatchBuildCheckpoint = () => {},
  ) {
    this.#locks = locks;
    this.#workers = workers;
    this.#finalizer = finalizer;
    this.#processes = processes;
    this.#checkpoint = checkpoint;
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
      return await this.#runLocked(ctx, binder, item, lease, owner, [item]);
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
    options?: { seedFeedback?: unknown[] },
  ): Promise<HatchBuildItemResult> {
    if (!(await this.#locks.owns(lease)) || owner.binder !== binder) {
      throw new Error("Hatch build item requires its delivery-owned binder lease and lifecycle");
    }
    return this.#runLocked(ctx, binder, item, lease, owner, waveMates, ledger, options?.seedFeedback);
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
      if (terminal) return terminal;

      const repoRoot = await git(ctx.cwd, ["rev-parse", "--show-toplevel"]);
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
      // The first round always runs, so a resumed run or a Fix and rerun validates once;
      // a further round needs budget in the gate that raised the concern, which the cap
      // test after each concern enforces. Each gate is capped on its own count only.
      while (attempts === 0 || acceptanceAttempts < acceptanceCap || safetyAttempts < safetyCap) {
        attempts += 1;
        const beforeWorker = await deriveItemGitState(worktree, binder, item);
        const recoverCommitted = beforeWorker.state === "committed-unmarked";
        const recoverMerged = beforeWorker.state === "merged-unmarked";
        await this.#checkpoint("before-worker");
        await session?.pause();
        let worker: HatchWorkerResult;
        try {
          worker = await this.#workers.run(
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
          );
        } finally {
          await session?.resume();
        }
        await this.#checkpoint("worker-attested");
        if (worker.outcome === "blocked") {
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
        const dropped = [...requiredCheckIds].filter((id) => !worker.checks.some((check) => check.id === id));
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
        const checks: HatchCheckPlanEntry[] = worker.checks.map((check) => ({
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
        if (!recoverMerged && feedback.length > 0 && afterWorker.state === "committed-unmarked") {
          // The worker was sent findings and changed nothing, so the committed tip is the
          // tip the gate already judged. Re-reviewing it would be a reviewer re-roll.
          if (previous?.status === "retry" && previous.commit) {
            const failed = await this.#finalizer.recordRecoveredFailedCandidate(
              binder,
              item,
              worktree,
              lease,
              previous,
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
        const recoveringExactCommit = afterWorker.state === "committed-unmarked";
        await this.#checkpoint("before-finalization");
        const finalization = recoverMerged
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
            );
        await this.#checkpoint("finalization-returned");
        // The finalizer sets `targetTree` with every verification: it is the tree the
        // gate evidence bound (the staged candidate tree or the committed tip's tree).
        // A staged candidate has no commit yet, so its item tip is the worktree HEAD.
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
        if (finalization.citationCheck && finalization.targetTree && !ledgerError) {
          await recordHostCheck(repoRoot, {
            binder,
            item,
            specDigest,
            phase: "build",
            itemTip: await git(worktree, ["rev-parse", "HEAD"]),
            reviewedTree: finalization.targetTree,
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
        const kind = retryKind(finalization);
        if (!kind) {
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
        if (kind === "acceptance") acceptanceAttempts += 1;
        else safetyAttempts += 1;
        const capped =
          Boolean(ledgerError) ||
          (kind === "acceptance" ? acceptanceAttempts >= acceptanceCap : safetyAttempts >= safetyCap);
        if (capped && (finalization.citationCheck || finalization.workerCheckFailure)) {
          // Both host checks are off on the last safety attempt and with an unreadable ledger.
          throw new Error("Hatch host check reached the safety cap");
        }
        if (capped) {
          const failed = recoveringExactCommit
            ? await this.#finalizer.recordRecoveredFailedCandidate(
                binder,
                item,
                worktree,
                lease,
                finalization,
              )
            : await this.#finalizer.recordFailedCandidate(
                ctx,
                binder,
                item,
                worktree,
                lease,
                finalization,
                { manager: this.#processes, owner },
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
