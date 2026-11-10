import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  rememberParity,
  runStableTreeChecks,
  type CheckConvergenceResult,
  type HaltedCheckConvergenceResult,
  type HatchCheckPlanEntry,
} from "./check-convergence.ts";
import { excerptOf } from "./check-environment.ts";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import {
  buildHatchEvidence,
  CITATION_DEFECT_CODES,
  REPO_RULE_CITATION_SHAPE,
  reviewedDiffOf,
  verifyEvidenceFreshness,
  type EvidenceCitationDefect,
  type HatchCheckManifest,
  type HatchReviewedDiff,
} from "./evidence.ts";
import type { HatchGateFinding } from "./gate-runner.ts";
import { haltDeleteLine, updateRefsTransaction } from "./halt-writer.ts";
import { validateCandidateHooks, type HookValidationResult } from "./hook-runner.ts";
import {
  HatchProcessManager,
  type BinderLifecycleOwner,
} from "./process-manager.ts";
import {
  protectedPathRefusal,
  runSecretScan,
  secretMatchRefusal,
  type HostRefusal,
} from "./secret-scan.ts";
import {
  blockedVerificationMessage,
  type HatchVerificationResult,
  type HatchVerificationRunner,
} from "./verification-runner.ts";

const exec = promisify(execFile);
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

// "no-change" is a whiff: the worker staged nothing and nothing proves the item's work is
// already on the base, so the item halts for re-dispatch. "already-present" is an empty
// candidate whose own diff against its merge base is empty AND whose oracle passes on
// HEAD: the change is already on the base, which needs a plan decision, not a rebuild.
// Neither writes any completion ref.
export type HatchBuildFinalizationStatus =
  | "built"
  | "failed"
  | "retry"
  | "blocked"
  | "no-change"
  | "already-present";

export type HatchFinalizationCheckpoint = (
  name:
    | "candidate-staged"
    | "checks-bound"
    | "gates-complete"
    | "candidate-commit-created"
    | "item-branch-updated"
    | "built-ref-updated"
    | "failed-ref-updated"
    | "done-ref-updated",
) => Promise<void> | void;

export interface HatchBuildFinalizationResult {
  status: HatchBuildFinalizationStatus;
  binder: string;
  item: string;
  targetTree?: string;
  commit?: string;
  checks?: HatchCheckManifest;
  checkFailure?: CheckConvergenceResult;
  hookValidation?: HookValidationResult;
  verification?: HatchVerificationResult;
  // Set when the citation pre-check sent the candidate back before any check or gate:
  // the preliminary evidence hash and diff, and one host-written finding per citation defect.
  citationCheck?: { evidenceHash: string; diff: HatchReviewedDiff; findings: HatchGateFinding[] };
  // Set when a check the worker itself proposed failed or timed out when the host reran
  // it, and the caller allowed the kickback: the worker wrote that check, so the worker
  // gets it back. The binder oracle and the environment checks never set it.
  workerCheckFailure?: HatchWorkerCheckFailure;
  // Set on an empty candidate whose already-present oracle probe changed the worktree
  // (tracked or untracked, not ignored); the host restored it to HEAD before returning.
  probeRestored?: boolean;
  // Set on a `blocked` result the host refused before any gate: a secret-scan match or a
  // change to protected orchestration state. No commit and no ref is written for it.
  refusal?: HostRefusal;
  message: string;
}

export interface HatchWorkerCheckFailure {
  // The preliminary evidence hash and diff of the candidate the check ran on.
  evidenceHash: string;
  diff: HatchReviewedDiff;
  check: {
    id: string;
    command: string;
    cwd: string;
    status: "failed" | "timed-out";
    exitCode: number | null;
    excerpt: string;
  };
  findings: HatchGateFinding[];
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed`);
  }
}

function oracleCheck(workItem: Record<string, unknown>): HatchCheckPlanEntry | undefined {
  const oracle = workItem.oracle;
  if (!oracle || typeof oracle !== "object" || Array.isArray(oracle)) return undefined;
  const command = (oracle as Record<string, unknown>).command;
  if (typeof command !== "string" || !command.trim()) return undefined;
  const cwd = (oracle as Record<string, unknown>).cwd;
  return {
    id: "oracle",
    purpose: "oracle",
    command: command.trim(),
    cwd: typeof cwd === "string" ? cwd : ".",
  };
}

function oracleOptsOut(workItem: Record<string, unknown>): boolean {
  const oracle = workItem.oracle;
  return Boolean(oracle) && typeof oracle === "object" && !Array.isArray(oracle) &&
    (oracle as Record<string, unknown>).opt_out === true;
}

async function nullObjectId(cwd: string): Promise<string> {
  const format = await git(cwd, ["rev-parse", "--show-object-format"]);
  if (format === "sha1") return "0".repeat(40);
  if (format === "sha256") return "0".repeat(64);
  throw new Error(`Hatch does not support Git object format '${format}'`);
}

/**
 * The halt record's update line for the commit `failed` will name, so the record and the
 * state land in one transaction. The build runner's callback never throws; a record it
 * cannot keep gives no line, and the build says why.
 */
export type FailedHaltLines = (commit: string) => Promise<readonly string[]>;

// `create` refuses a `failed` ref that already stands, as the old null-old-value update did.
// The record's line rides the same transaction, so both land or neither does; a line git
// refuses fails the whole write, as a refused `failed` write always has. A callback that
// throws anyway is a record not kept, never a reason to leave `failed` unwritten.
async function writeFailed(
  worktree: string,
  binder: string,
  item: string,
  commit: string,
  haltLines: FailedHaltLines | undefined,
): Promise<void> {
  const lines = haltLines ? await haltLines(commit).catch((): readonly string[] => []) : [];
  await updateRefsTransaction(worktree, [`create refs/hatch/${binder}/item-${item}/failed ${commit}`, ...lines]);
}

const CANDIDATE = "The build candidate";

// The host's refusal of a staged change to .git or .hatch, or undefined.
async function protectedCandidate(cwd: string, subject = CANDIDATE): Promise<HostRefusal | undefined> {
  const changed = await git(cwd, ["diff", "--cached", "--name-only", "-z"]);
  return protectedPathRefusal(changed.split("\0").filter(Boolean), subject);
}

// The protected-path check, then the secret scan of the staged diff or the committed
// range. A refusal is returned; a scan that could not run throws (secret-scan.ts).
async function candidateRefusal(
  cwd: string,
  subject: string,
  committedRange?: { base: string; target: string },
): Promise<HostRefusal | undefined> {
  return (await protectedCandidate(cwd, subject)) ??
    secretMatchRefusal(await runSecretScan(cwd, committedRange), subject);
}

function refused(binder: string, item: string, refusal: HostRefusal, commit?: string): HatchBuildFinalizationResult {
  return { status: "blocked", binder, item, ...(commit ? { commit } : {}), refusal, message: refusal.message };
}

// Tracked or untracked changes in a worktree; ignored files do not count.
async function worktreeChanges(worktree: string): Promise<boolean> {
  return (await git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) !== "";
}

// Put a worktree that entered a probe clean back to HEAD: index, tracked files, and any
// untracked file the probe wrote. Ignored files (installed dependencies) are kept.
// Returns whether anything had to be restored.
async function restoreProbedWorktree(worktree: string): Promise<boolean> {
  if (!(await worktreeChanges(worktree))) return false;
  await git(worktree, ["reset", "--hard", "--quiet", "HEAD"]);
  await git(worktree, ["clean", "-f", "-d", "--quiet"]);
  if (await worktreeChanges(worktree)) {
    throw new Error("Hatch could not restore the item worktree after the already-present oracle probe");
  }
  return true;
}

function finalizationStatus(verification: HatchVerificationResult): HatchBuildFinalizationStatus {
  if (verification.status === "pass" || verification.status === "skipped") return "built";
  if (verification.status === "concerns") return "retry";
  return "blocked";
}

// One host-written finding per citation defect the item added. The rule is the safety
// auditor's own: a citation that does not check out leaves its override undeclared.
function citationDefectFindings(defects: readonly EvidenceCitationDefect[]): HatchGateFinding[] {
  return defects.map((defect) => ({
    severity: "major",
    code: CITATION_DEFECT_CODES[defect.problem],
    path: defect.path,
    line: defect.line,
    message:
      `\`${defect.text}\` at ${defect.path}:${defect.line} is not a repo-rule citation the host can resolve ` +
      `(${defect.problem}). The shape is \`${REPO_RULE_CITATION_SHAPE}\`, with a colon directly after the path. ` +
      "Until it resolves, the HATCH-SME-OVERRIDE it supports is undeclared.",
    nextStep:
      `Rewrite it as \`repo-rule: ${defect.cited ?? "<path>"}:<line-or-section>\`, or remove the citation and the ` +
      "override if no repo rule supports it.",
  }));
}

// A command as a halt message shows it: whitespace collapsed, clipped to 200 characters.
// The verbatim command travels in the check failure's diagnosis.
function shownCommand(command: string): string {
  const text = command.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

// A precondition-unmet convergence means the declared environment probe failed before
// any floor or oracle command ran. It maps to blocked — a missing daemon is not fixed by
// a worker retry. The message names the preflight command and its exit; the project's
// own remediation (on_unavailable) travels in `checkFailure.remediation`, and the
// delivery runner adds it to the halt reason once.
function preconditionHaltMessage(convergence: HaltedCheckConvergenceResult): string {
  const command = convergence.diagnosis?.command;
  const exit = convergence.diagnosis?.exitCode ?? convergence.check?.result.code ?? null;
  const code = exit === null ? "without an exit code" : `exited ${exit}`;
  const probe = command ? `the preflight \`${shownCommand(command)}\` ${code}` : `the preflight ${code}`;
  return `Declared environment precondition unmet: ${probe}; the floor was not run.`;
}

// "`<command>` exited <code>." for a halted check, from its diagnosis or its plan entry.
// The formatted diagnosis is not repeated here: it travels in `checkFailure`, and the
// delivery runner renders it once into the halt reason.
function checkOutcome(convergence: HaltedCheckConvergenceResult, plan: HatchCheckPlanEntry[]): string {
  const id = convergence.check?.id ?? convergence.diagnosis?.checkId;
  const command = convergence.diagnosis?.command ?? plan.find((check) => check.id === id)?.command;
  const exit = convergence.check?.result.code ?? convergence.diagnosis?.exitCode ?? null;
  const code = exit === null ? "without an exit code" : `exited ${exit}`;
  return command ? `\`${shownCommand(command)}\` ${code}.` : `It ${code}.`;
}

// A final check that failed in the item worktree and is not going back to the worker:
// the binder oracle, or a worker-proposed check once the kickback is off (the last safety
// attempt, or an unreadable ledger). build-runner halts any finalization no gate or host
// check classified as retryable, so the message says the item halts blocked and names
// the check, its command and exit code.
function finalCheckFailedMessage(
  convergence: HaltedCheckConvergenceResult,
  plan: HatchCheckPlanEntry[],
): string {
  const id = convergence.check?.id ?? convergence.diagnosis?.checkId ?? "check-plan";
  return (
    `Final check '${id}' failed in the item worktree: ${checkOutcome(convergence, plan)} ` +
    "The item halts blocked, and no worker retry follows."
  );
}

// A check the worker proposed that failed or timed out in the item worktree, described
// for the worker. Only a plan entry with purpose "floor" qualifies: the host adds the
// oracle with purpose "oracle", and the environment checks are never plan entries (the
// worker envelope rejects an `environment-` id, so none can shadow one). Precondition-
// unmet, aborted and non-converging halts are not a failing command the worker can correct.
export function workerCheckFailureOf(
  convergence: HaltedCheckConvergenceResult,
  plan: HatchCheckPlanEntry[],
  evidenceHash: string,
  diff: HatchReviewedDiff,
): HatchWorkerCheckFailure | undefined {
  if (convergence.status !== "failed" && convergence.status !== "timed-out") return undefined;
  const id = convergence.check?.id;
  const entry = plan.find((check) => check.id === id);
  if (!id || !entry || entry.purpose !== "floor") return undefined;
  const exitCode = convergence.check?.result.code ?? convergence.diagnosis?.exitCode ?? null;
  const excerpt = convergence.diagnosis?.excerpt ?? excerptOf(convergence.check?.result);
  const ran = exitCode === null ? "stopped without an exit code" : `exited ${exitCode}`;
  return {
    evidenceHash,
    diff,
    check: { id, command: entry.command, cwd: entry.cwd, status: convergence.status, exitCode, excerpt },
    findings: [{
      severity: "major",
      code: "worker-check-failed",
      message:
        `Check '${id}', which the worker proposed, ${convergence.status === "timed-out" ? "timed out" : "failed"} ` +
        `when the host reran it: \`${shownCommand(entry.command)}\` in cwd "${entry.cwd}" ${ran}.` +
        (excerpt ? ` Output: ${excerpt}` : ""),
      nextStep:
        `The host runs the command through the shell with cwd as its working directory, relative to the worktree ` +
        `root. A command that sets its own directory (--directory, --prefix, -C, cd) uses cwd ".". Fix the code, or ` +
        `correct only how the check is invoked (its cwd or directory flag) so it runs what it ran before; never weaken ` +
        `or replace what the check verifies. Run it exactly as you will propose it, and re-propose a check with id "${id}".`,
    }],
  };
}

// The kickback's own message: the item does not halt, the worker gets the check back.
export function workerCheckKickbackMessage(failure: HatchWorkerCheckFailure): string {
  const { id, command, exitCode, status } = failure.check;
  const code = exitCode === null ? "without an exit code" : `exited ${exitCode}`;
  const outcome = status === "timed-out" ? "timed out" : "failed";
  return (
    `Final check '${id}', which the worker proposed, ${outcome} in the item worktree: ` +
    `\`${shownCommand(command)}\` ${code}. It goes back to the worker as a counted safety attempt; ` +
    "the next worker must re-propose a check with the same id."
  );
}

// The parity probe's halt. The carrier phrase "would fail at merge" is registered as
// INV-37 in docs/conventions/invariants.md; reword it there in the same diff. It is
// said only when the check really failed or moved the tree in the fresh worktree; a
// probe that stopped short (aborted, precondition unmet) says so instead.
function parityHaltMessage(parity: CheckConvergenceResult, plan: HatchCheckPlanEntry[]): string {
  if (parity.status === "stable") {
    return (
      "The check plan passed in a fresh worktree set up only by .hatch/environment.json but " +
      "changed the converged tree there, so it would fail at merge."
    );
  }
  const id = parity.check?.id ?? parity.diagnosis?.checkId ?? "check-plan";
  switch (parity.status) {
    case "failed":
    case "non-converging": {
      const base =
        `Check '${id}' passed in the item worktree but fails in a fresh worktree set up only by ` +
        ".hatch/environment.json, so it would fail at merge.";
      return parity.status === "failed" ? `${base} ${checkOutcome(parity, plan)}` : base;
    }
    case "precondition-unmet": {
      const base: string =
        "Final checks stopped as precondition-unmet in a fresh worktree set up only by " +
        ".hatch/environment.json: the declared environment preflight failed there, so no floor or " +
        "oracle check ran and no built ref was written.";
      // The project's on_unavailable text travels in checkFailure.remediation; the
      // delivery runner adds it to the halt reason once.
      return base;
    }
    case "timed-out":
      // runStableTreeChecks exposes no timeout option, so this status cannot occur in the
      // parity probe today; it is worded here so a later timeout cannot fall through to
      // the "would fail at merge" text.
    case "aborted":
      return (
        `Final checks stopped as ${parity.status} in a fresh worktree set up only by ` +
        ".hatch/environment.json; no built ref was written."
      );
  }
}

export class HatchBuildFinalizer {
  readonly #locks: DispatchLockManager;
  readonly #verification: HatchVerificationRunner;
  readonly #checkpoint: HatchFinalizationCheckpoint;

  constructor(
    locks: DispatchLockManager,
    verification: HatchVerificationRunner,
    checkpoint: HatchFinalizationCheckpoint = () => {},
  ) {
    this.#locks = locks;
    this.#verification = verification;
    this.#checkpoint = checkpoint;
  }

  async recoverMergedCandidate(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    repository: string,
    lease: DispatchLockLease,
    floorChecks: HatchCheckPlanEntry[] = [],
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
  ): Promise<HatchBuildFinalizationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch merged recovery requires the active binder lock lease");
    }
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const itemRef = `refs/heads/hatch/${binder}/item-${item}`;
    const [integrationTip, itemTip, built] = await Promise.all([
      git(repository, ["rev-parse", "--verify", `${integrationRef}^{commit}`]),
      git(repository, ["rev-parse", "--verify", `${itemRef}^{commit}`]),
      git(repository, ["rev-parse", "--verify", `refs/hatch/${binder}/item-${item}/built`]),
    ]);
    if (built !== itemTip) throw new Error("Hatch merged recovery requires built ref at the item tip");
    const parents = (await git(repository, ["rev-list", "--parents", "-n", "1", integrationTip]))
      .split(/\s+/)
      .slice(1);
    if (parents.length !== 2 || parents[1] !== itemTip) {
      throw new Error("Hatch merged recovery requires integration tip to be the item merge");
    }
    const targetTree = await git(repository, ["rev-parse", `${integrationTip}^{tree}`]);
    const root = await mkdtemp(join(tmpdir(), "hatch-merged-recovery-"));
    const worktree = join(root, "worktree");
    let registered = false;
    try {
      await git(repository, ["worktree", "add", "--detach", worktree, integrationTip]);
      registered = true;
      const preliminaryEvidence = await buildHatchEvidence({
        cwd: worktree,
        binder,
        item,
        target: "landed",
      });
      const oracle = oracleCheck(preliminaryEvidence.payload.workItem);
      const oracleKey = oracle ? `${oracle.cwd}\0${oracle.command}` : undefined;
      const checkPlan: HatchCheckPlanEntry[] = floorChecks
        .filter((check) => `${check.cwd}\0${check.command}` !== oracleKey)
        .map((check) => ({ ...check, purpose: "floor" as const }));
      if (oracle) checkPlan.push(oracle);
      let checks: HatchCheckManifest | undefined;
      if (checkPlan.length > 0) {
        const convergence = await runStableTreeChecks({
          worktree,
          checks: checkPlan,
          environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
          site: "fresh-merge",
          signal: ctx.signal,
          onProcessStart: processContext
            ? (pid) => processContext.manager.registerProcess(pid, {
                cwd: worktree,
                parentId: processContext.owner.id,
                label: `${item} landed-merge check`,
                role: "host-check",
              })
            : undefined,
          onProcessExit: processContext
            ? (pid) => processContext.manager.forgetProcess(pid)
            : undefined,
        });
        if (convergence.status !== "stable" || convergence.targetTree !== targetTree) {
          return {
            status: convergence.status === "failed" ? "retry" : "blocked",
            binder,
            item,
            targetTree: convergence.targetTree,
            commit: integrationTip,
            checkFailure: convergence,
            message: convergence.status === "precondition-unmet"
              ? preconditionHaltMessage(convergence)
              : "Landed merge recovery checks failed or changed the committed merge tree.",
          };
        }
        checks = convergence.manifest;
      }
      // These bytes are already on the integration branch, so a refusal here ends the run.
      const landed = await candidateRefusal(worktree, "The landed merge", { base: parents[0], target: integrationTip });
      if (landed) throw new Error(`Hatch landed merge recovery refused: ${landed.message}`);
      const evidence = await buildHatchEvidence({
        cwd: worktree,
        binder,
        item,
        target: "landed",
        checkManifest: checks,
      });
      await verifyEvidenceFreshness(evidence);
      const verification = await this.#verification.runWithLease(
        ctx,
        binder,
        item,
        "full",
        lease,
        { cwd: worktree, target: "landed", checkManifest: checks },
        processContext
          ? { processes: processContext, worktree, treeish: integrationTip }
          : undefined,
      );
      if (finalizationStatus(verification) !== "built") {
        return {
          status: "blocked",
          binder,
          item,
          targetTree,
          commit: integrationTip,
          checks,
          verification,
          message: blockedVerificationMessage(
            verification,
            "Landed merge recovery did not pass fresh verification; done remains absent.",
            "kept",
            evidence.payload.citationDefects,
          ),
        };
      }
      if ((await git(repository, ["rev-parse", integrationRef])) !== integrationTip) {
        throw new Error("Hatch integration tip moved during merged recovery");
      }
      // The halt record leaves in the transaction that writes `done`.
      await updateRefsTransaction(repository, [
        `create refs/hatch/${binder}/item-${item}/done ${integrationTip}`,
        haltDeleteLine(binder, item),
      ]);
      await this.#checkpoint("done-ref-updated");
      return {
        status: "built",
        binder,
        item,
        targetTree,
        commit: integrationTip,
        checks,
        verification,
        message: "Landed item merge revalidated and done ref written ref-last.",
      };
    } finally {
      if (registered) {
        await git(repository, ["worktree", "remove", "--force", worktree], true).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  }

  async recoverCommittedCandidate(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    worktree: string,
    lease: DispatchLockLease,
    floorChecks: HatchCheckPlanEntry[] = [],
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
  ): Promise<HatchBuildFinalizationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch committed recovery requires the active binder lock lease");
    }
    const expectedBranch = `hatch/${binder}/item-${item}`;
    const branch = await git(worktree, ["branch", "--show-current"]);
    if (branch !== expectedBranch) {
      throw new Error(`Hatch recovery expected branch '${expectedBranch}', found '${branch}'`);
    }
    const statusOutput = await git(worktree, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (statusOutput) throw new Error("Hatch committed recovery refuses a dirty item worktree");
    const commit = await git(worktree, ["rev-parse", "HEAD"]);
    const parent = await git(worktree, ["rev-parse", "HEAD^"]);
    const committedTree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
    const preliminaryEvidence = await buildHatchEvidence({
      cwd: worktree,
      binder,
      item,
      target: "committed",
    });
    if (preliminaryEvidence.payload.git.itemTip !== commit) {
      throw new Error("Hatch item branch moved during committed recovery");
    }
    const oracle = oracleCheck(preliminaryEvidence.payload.workItem);
    const oracleKey = oracle ? `${oracle.cwd}\0${oracle.command}` : undefined;
    const checkPlan: HatchCheckPlanEntry[] = floorChecks
      .filter((check) => `${check.cwd}\0${check.command}` !== oracleKey)
      .map((check) => ({ ...check, purpose: "floor" as const }));
    if (oracle) checkPlan.push(oracle);
    let checks: HatchCheckManifest | undefined;
    if (checkPlan.length > 0) {
      const convergence = await runStableTreeChecks({
        worktree,
        checks: checkPlan,
        environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
        site: "item",
        signal: ctx.signal,
        onProcessStart: processContext
          ? (pid) => processContext.manager.registerProcess(pid, {
              cwd: worktree,
              parentId: processContext.owner.id,
              label: `${item} recovery check`,
              role: "host-check",
            })
          : undefined,
        onProcessExit: processContext
          ? (pid) => processContext.manager.forgetProcess(pid)
          : undefined,
      });
      if (convergence.status !== "stable") {
        return {
          status: convergence.status === "failed" ? "retry" : "blocked",
          binder,
          item,
          targetTree: convergence.targetTree,
          checkFailure: convergence,
          message: convergence.status === "precondition-unmet"
            ? preconditionHaltMessage(convergence)
            : "Committed candidate recovery checks did not pass on the exact item tip.",
        };
      }
      if (convergence.targetTree !== committedTree) {
        return {
          status: "retry",
          binder,
          item,
          targetTree: convergence.targetTree,
          checkFailure: convergence,
          message: "Recovery checks generated changes; a new exact candidate commit is required.",
        };
      }
      const parity = await this.#parityProbe(
        ctx, binder, item, worktree, committedTree, checkPlan, lease, processContext,
      );
      if (parity) {
        return {
          status: "blocked",
          binder,
          item,
          targetTree: committedTree,
          commit,
          checkFailure: parity,
          message: parityHaltMessage(parity, checkPlan),
        };
      }
      checks = convergence.manifest;
    }
    const refusal = await candidateRefusal(worktree, "The committed candidate", { base: parent, target: commit });
    if (refusal) return refused(binder, item, refusal, commit);
    const evidence = await buildHatchEvidence({
      cwd: worktree,
      binder,
      item,
      target: "committed",
      checkManifest: checks,
    });
    if (evidence.payload.git.targetTree !== committedTree) {
      throw new Error("Hatch committed recovery evidence does not bind the item tip tree");
    }
    await verifyEvidenceFreshness(evidence);
    const verification = await this.#verification.runWithLease(
      ctx,
      binder,
      item,
      "full",
      lease,
      { cwd: worktree, target: "committed", checkManifest: checks },
      processContext ? { processes: processContext, worktree, treeish: commit } : undefined,
    );
    const finalStatus = finalizationStatus(verification);
    if (finalStatus !== "built") {
      return {
        status: finalStatus,
        binder,
        item,
        targetTree: committedTree,
        commit,
        checks,
        verification,
        message: finalStatus === "retry"
          ? "Committed candidate still has gate concerns."
          : blockedVerificationMessage(
              verification,
              "Committed candidate recovery was blocked by gate evidence.",
              "kept",
              evidence.payload.citationDefects,
            ),
      };
    }
    const committedMessage = await git(worktree, ["show", "-s", "--format=%B", commit]);
    // A committed tip may be empty (its tree is its parent's); reproducing it then needs
    // --allow-empty, or git answers "nothing to commit" before any hook decides.
    const parentTree = await git(worktree, ["rev-parse", `${parent}^{tree}`]);
    const hookValidation = await validateCandidateHooks({
      worktree,
      candidateTree: committedTree,
      parent,
      message: committedMessage,
      allowEmpty: committedTree === parentTree,
      signal: ctx.signal,
      onProcessStart: processContext
        ? (pid) => processContext.manager.registerProcess(pid, {
            cwd: worktree,
            parentId: processContext.owner.id,
            label: `${item} committed hook validation`,
          })
        : undefined,
      onProcessExit: processContext
        ? (pid) => processContext.manager.forgetProcess(pid)
        : undefined,
    });
    if (hookValidation.status !== "passed" || hookValidation.message !== committedMessage) {
      return {
        status: "blocked",
        binder,
        item,
        targetTree: committedTree,
        commit,
        checks,
        verification,
        hookValidation,
        message: "Current repository hook policy does not reproduce the committed checkpoint.",
      };
    }
    if ((await git(worktree, ["rev-parse", "HEAD"])) !== commit) {
      throw new Error("Hatch item branch moved after committed recovery verification");
    }
    await git(worktree, [
      "update-ref",
      `refs/hatch/${binder}/item-${item}/built`,
      commit,
      await nullObjectId(worktree),
    ]);
    await this.#checkpoint("built-ref-updated");
    return {
      status: "built",
      binder,
      item,
      targetTree: committedTree,
      commit,
      checks,
      verification,
      hookValidation,
      message: "Committed item tip revalidated and built ref written ref-last.",
    };
  }

  async recordRecoveredFailedCandidate(
    binder: string,
    item: string,
    worktree: string,
    lease: DispatchLockLease,
    candidate: HatchBuildFinalizationResult,
    haltLines?: FailedHaltLines,
  ): Promise<HatchBuildFinalizationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch recovered-failure recording requires the active binder lock lease");
    }
    if (
      candidate.status !== "retry" ||
      !candidate.commit ||
      !candidate.targetTree ||
      !candidate.verification
    ) {
      throw new Error("Hatch recovered failure requires a rechecked committed retry candidate");
    }
    const [head, tree, branch, statusOutput] = await Promise.all([
      git(worktree, ["rev-parse", "HEAD"]),
      git(worktree, ["rev-parse", "HEAD^{tree}"]),
      git(worktree, ["branch", "--show-current"]),
      git(worktree, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    ]);
    if (
      head !== candidate.commit ||
      tree !== candidate.targetTree ||
      branch !== `hatch/${binder}/item-${item}` ||
      statusOutput
    ) {
      throw new Error("Hatch recovered committed candidate changed before failed ref update");
    }
    await writeFailed(worktree, binder, item, head, haltLines);
    await this.#checkpoint("failed-ref-updated");
    return {
      ...candidate,
      status: "failed",
      message: "Revalidated committed item tip marked failed after bounded gate retries.",
    };
  }

  async recordFailedCandidate(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    worktree: string,
    lease: DispatchLockLease,
    candidate: HatchBuildFinalizationResult,
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
    haltLines?: FailedHaltLines,
  ): Promise<HatchBuildFinalizationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch failed-candidate recording requires the active binder lock lease");
    }
    if (candidate.status !== "retry" || !candidate.targetTree || !candidate.verification) {
      throw new Error("Hatch can record failed only from a scanned, gate-reviewed retry candidate");
    }
    const currentTree = await git(worktree, ["write-tree"]);
    if (currentTree !== candidate.targetTree) {
      throw new Error("Hatch failed candidate changed after its gate verdict");
    }
    if (candidate.checks && candidate.checks.targetTree !== currentTree) {
      throw new Error("Hatch failed candidate check manifest is stale");
    }
    const parent = await git(worktree, ["rev-parse", "HEAD"]);
    const expectedBranch = `hatch/${binder}/item-${item}`;
    const branch = await git(worktree, ["branch", "--show-current"]);
    if (branch !== expectedBranch) {
      throw new Error(`Hatch finalizer expected branch '${expectedBranch}', found '${branch}'`);
    }
    const proposedMessage = `[hatch:item-${item}] halted after bounded gate retries`;
    const hookValidation = await validateCandidateHooks({
      worktree,
      candidateTree: currentTree,
      parent,
      message: proposedMessage,
      signal: ctx.signal,
      onProcessStart: processContext
        ? (pid) => processContext.manager.registerProcess(pid, {
            cwd: worktree,
            parentId: processContext.owner.id,
            label: `${item} failed hook validation`,
          })
        : undefined,
      onProcessExit: processContext
        ? (pid) => processContext.manager.forgetProcess(pid)
        : undefined,
    });
    if (hookValidation.status !== "passed") {
      return {
        ...candidate,
        status: "blocked",
        hookValidation,
        message: "Repository hooks blocked the failed-candidate checkpoint.",
      };
    }
    const message = hookValidation.message ?? proposedMessage;
    if (
      !message.split("\n", 1)[0].includes(`[hatch:item-${item}]`) &&
      !new RegExp(`^Hatch-Item:\\s*item-${item}$`, "mi").test(message)
    ) {
      throw new Error("Hatch commit hooks removed the mandatory item marker");
    }
    const commit = await git(worktree, ["commit-tree", currentTree, "-p", parent, "-m", message]);
    await this.#checkpoint("candidate-commit-created");
    await git(worktree, ["update-ref", `refs/heads/${expectedBranch}`, commit, parent]);
    await this.#checkpoint("item-branch-updated");
    if ((await git(worktree, ["rev-parse", "HEAD^{tree}"])) !== currentTree) {
      throw new Error("Hatch failed checkpoint does not preserve the reviewed tree");
    }
    await writeFailed(worktree, binder, item, commit, haltLines);
    await this.#checkpoint("failed-ref-updated");
    return {
      ...candidate,
      status: "failed",
      commit,
      hookValidation,
      message: "Gate-capped candidate committed and failed ref written ref-last.",
    };
  }

  // Build/merge parity (INV-37). The item worktree carries whatever the worker
  // installed; the merge reruns the same plan in a fresh worktree provisioned only by
  // the integration ref's .hatch/environment.json. Run the plan once more on the
  // converged tree, in such a worktree, before any gate call and before built is
  // written. A worker cannot change .hatch/, so a failure here halts blocked.
  // Cost: one worktree materialization, one setup run, and one more run of the floor
  // and oracle per finalization, repeated on every gate retry.
  // Returns undefined when the tree passes unchanged; otherwise the probe's result.
  async #parityProbe(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    worktree: string,
    tree: string,
    plan: HatchCheckPlanEntry[],
    lease: DispatchLockLease,
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
  ): Promise<CheckConvergenceResult | undefined> {
    const root = await mkdtemp(join(tmpdir(), "hatch-build-parity-"));
    const parity = join(root, "worktree");
    let registered = false;
    try {
      await git(worktree, ["worktree", "add", "--detach", "--no-checkout", parity, "HEAD"]);
      registered = true;
      await git(parity, ["read-tree", "--reset", "-u", tree]);
      const result = await runStableTreeChecks({
        worktree: parity,
        checks: plan,
        environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
        site: "fresh-parity",
        singlePass: true,
        signal: ctx.signal,
        onProcessStart: processContext
          ? (pid) => processContext.manager.registerProcess(pid, {
              cwd: parity,
              parentId: processContext.owner.id,
              label: `${item} build/merge parity check`,
              role: "host-check",
            })
          : undefined,
        onProcessExit: processContext
          ? (pid) => processContext.manager.forgetProcess(pid)
          : undefined,
      });
      if (result.status !== "stable" || result.targetTree !== tree) return result;
      // Kept for this run only: the proposed merge binds it when every input is equal.
      rememberParity(lease, item, result);
      return undefined;
    } finally {
      if (registered) {
        await git(worktree, ["worktree", "remove", "--force", parity], true).catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  }

  // The staged tree equals HEAD. Tell a whiff from a change already on the base before
  // halting: already-present needs the item's own diff against its merge base (the base
  // the evidence builder uses) to be empty AND its oracle to pass on HEAD's exact tree.
  // Anything less — a diff of its own, no runnable oracle, an oracle that fails or moves
  // the tree — stays no-change. This path never commits and never writes a ref: a done or
  // built ref with no item merge behind it is the forged-done shape provenance rejects.
  async #classifyEmptyCandidate(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    worktree: string,
    headTree: string,
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
  ): Promise<HatchBuildFinalizationResult> {
    const whiff = (extra: Partial<HatchBuildFinalizationResult> = {}): HatchBuildFinalizationResult => ({
      status: "no-change",
      binder,
      item,
      targetTree: headTree,
      ...extra,
      message:
        "Worker produced no candidate change, and the item's work is not proven present on the base " +
        "(its own diff is not empty, or it has no oracle that passes on HEAD); no completion ref was " +
        "written. Re-dispatch the worker.",
    });
    const evidence = await buildHatchEvidence({ cwd: worktree, binder, item, target: "committed" });
    if (evidence.payload.git.targetTree !== headTree || evidence.payload.diff.touchedPaths.length > 0) {
      return whiff();
    }
    const oracle = oracleCheck(evidence.payload.workItem);
    if (!oracle) return whiff();
    // The probe runs in the worker's worktree, and the convergence loop stages what the
    // oracle writes. Enter clean and leave clean: a file the oracle generates must not sit
    // staged for the re-dispatch this halt may ask for, where it would be finalized as
    // the item's candidate.
    if (await worktreeChanges(worktree)) return whiff();
    let probeRestored = false;
    let convergence: CheckConvergenceResult;
    try {
      convergence = await runStableTreeChecks({
      worktree,
      checks: [oracle],
      environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
      site: "item",
      signal: ctx.signal,
      onProcessStart: processContext
        ? (pid) =>
            processContext.manager.registerProcess(pid, {
              cwd: worktree,
              parentId: processContext.owner.id,
              label: `${item} already-present oracle`,
              role: "host-check",
            })
        : undefined,
      onProcessExit: processContext
        ? (pid) => processContext.manager.forgetProcess(pid)
        : undefined,
      });
    } finally {
      probeRestored = await restoreProbedWorktree(worktree);
    }
    const restored = probeRestored ? { probeRestored } : {};
    if (convergence.status === "precondition-unmet") {
      return {
        status: "blocked",
        binder,
        item,
        targetTree: convergence.targetTree,
        checkFailure: convergence,
        ...restored,
        message: preconditionHaltMessage(convergence),
      };
    }
    if (convergence.status !== "stable" || convergence.targetTree !== headTree || probeRestored) {
      return whiff({ checkFailure: convergence, ...restored });
    }
    if ((await git(worktree, ["rev-parse", "HEAD^{tree}"])) !== headTree) {
      throw new Error("Hatch item HEAD moved while proving an already-present change");
    }
    return {
      status: "already-present",
      binder,
      item,
      targetTree: headTree,
      checks: convergence.manifest,
      message:
        "The item's change is already on the base: its diff against the merge base is empty and its " +
        "oracle passes on HEAD. No completion ref was written; a plan change per docs/how-to/binder-repair.md " +
        "decides the item (a successor binder that drops or amends it when other items are done, or " +
        "withdrawing the binder when none is), with this oracle receipt as its evidence.",
    };
  }

  async finalizeCandidate(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    worktree: string,
    lease: DispatchLockLease,
    floorChecks: HatchCheckPlanEntry[] = [],
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
    options: { citationPrecheck?: boolean; workerCheckKickback?: boolean } = {},
  ): Promise<HatchBuildFinalizationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch build finalization requires the active binder lock lease");
    }
    await git(worktree, ["add", "-A"]);
    await this.#checkpoint("candidate-staged");
    const stagedTree = await git(worktree, ["write-tree"]);
    const headTree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
    if (stagedTree === headTree) {
      return this.#classifyEmptyCandidate(ctx, binder, item, worktree, headTree, processContext);
    }
    const staged = await protectedCandidate(worktree);
    if (staged) return refused(binder, item, staged);
    const preliminaryEvidence = await buildHatchEvidence({
      cwd: worktree,
      binder,
      item,
      target: "candidate",
    });
    // The citation pre-check: a repo-rule citation this item added that the host cannot
    // resolve goes back to the worker before the floor, the oracle, the parity probe or
    // any gate runs. An oracle opt-out runs no gate to judge the override, so it is
    // skipped there; the caller turns it off on the last safety attempt.
    const citationDefects = preliminaryEvidence.payload.citationDefects ?? [];
    if (options.citationPrecheck && !oracleOptsOut(preliminaryEvidence.payload.workItem) && citationDefects.length > 0) {
      return {
        status: "retry",
        binder,
        item,
        targetTree: preliminaryEvidence.payload.git.targetTree,
        citationCheck: {
          evidenceHash: preliminaryEvidence.evidenceHash,
          diff: reviewedDiffOf(preliminaryEvidence),
          findings: citationDefectFindings(citationDefects),
        },
        message:
          "A repo-rule citation this item added cannot be resolved; it goes back to the worker before any check or gate runs.",
      };
    }
    const oracle = oracleCheck(preliminaryEvidence.payload.workItem);
    const oracleKey = oracle ? `${oracle.cwd}\0${oracle.command}` : undefined;
    const checkPlan: HatchCheckPlanEntry[] = floorChecks
      .filter((check) => `${check.cwd}\0${check.command}` !== oracleKey)
      .map((check) => ({ ...check, purpose: "floor" as const }));
    if (oracle) checkPlan.push(oracle);

    let checks: HatchCheckManifest | undefined;
    if (checkPlan.length > 0) {
      const convergence = await runStableTreeChecks({
        worktree,
        checks: checkPlan,
        environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
        site: "item",
        signal: ctx.signal,
        onProcessStart: processContext
          ? (pid) =>
              processContext.manager.registerProcess(pid, {
                cwd: worktree,
                parentId: processContext.owner.id,
                label: `${item} final check`,
                role: "host-check",
              })
          : undefined,
        onProcessExit: processContext
          ? (pid) => processContext.manager.forgetProcess(pid)
          : undefined,
      });
      if (convergence.status !== "stable") {
        // The caller turns the kickback off on the last safety attempt and with an
        // unreadable ledger; then a failed worker check halts below like any other.
        const workerCheckFailure = options.workerCheckKickback
          ? workerCheckFailureOf(convergence, checkPlan, preliminaryEvidence.evidenceHash, reviewedDiffOf(preliminaryEvidence))
          : undefined;
        if (workerCheckFailure) {
          return {
            status: "retry",
            binder,
            item,
            targetTree: convergence.targetTree,
            checkFailure: convergence,
            workerCheckFailure,
            message: workerCheckKickbackMessage(workerCheckFailure),
          };
        }
        return {
          status: convergence.status === "failed" ? "retry" : "blocked",
          binder,
          item,
          targetTree: convergence.targetTree,
          checkFailure: convergence,
          message:
            convergence.status === "precondition-unmet"
              ? preconditionHaltMessage(convergence)
              : convergence.status === "failed"
                ? finalCheckFailedMessage(convergence, checkPlan)
                : `Final checks stopped as ${convergence.status}; the candidate remains staged for recovery.`,
        };
      }
      const parity = await this.#parityProbe(
        ctx, binder, item, worktree, convergence.targetTree, checkPlan, lease, processContext,
      );
      if (parity) {
        return {
          status: "blocked",
          binder,
          item,
          targetTree: convergence.targetTree,
          checkFailure: parity,
          message: parityHaltMessage(parity, checkPlan),
        };
      }
      checks = convergence.manifest;
    }
    await this.#checkpoint("checks-bound");
    const refusal = await candidateRefusal(worktree, CANDIDATE);
    if (refusal) return refused(binder, item, refusal);
    const evidence = await buildHatchEvidence({
      cwd: worktree,
      binder,
      item,
      target: "candidate",
      checkManifest: checks,
    });
    if (checks && evidence.payload.git.targetTree !== checks.targetTree) {
      throw new Error("Hatch stable check manifest does not match the final candidate tree");
    }
    await verifyEvidenceFreshness(evidence);
    const verification = await this.#verification.runWithLease(
      ctx,
      binder,
      item,
      "full",
      lease,
      { cwd: worktree, target: "candidate", checkManifest: checks },
      processContext
        ? { processes: processContext, worktree, treeish: evidence.payload.git.targetTree }
        : undefined,
    );
    await this.#checkpoint("gates-complete");
    const status = finalizationStatus(verification);
    if (status !== "built") {
      return {
        status,
        binder,
        item,
        targetTree: evidence.payload.git.targetTree,
        checks,
        verification,
        message:
          status === "retry"
            ? "Gate concerns require another bounded worker attempt."
            : blockedVerificationMessage(
                verification,
                "Gate evidence blocked finalization; the candidate remains staged.",
                "kept",
                evidence.payload.citationDefects,
              ),
      };
    }

    const currentTree = await git(worktree, ["write-tree"]);
    if (currentTree !== evidence.payload.git.targetTree) {
      throw new Error("Hatch candidate tree changed after verification");
    }
    const parent = await git(worktree, ["rev-parse", "HEAD"]);
    const expectedBranch = `hatch/${binder}/item-${item}`;
    const branch = await git(worktree, ["branch", "--show-current"]);
    if (branch !== expectedBranch) {
      throw new Error(`Hatch finalizer expected branch '${expectedBranch}', found '${branch}'`);
    }
    const proposedMessage = `[hatch:item-${item}] ${String(evidence.payload.workItem.title ?? item)}`;
    const hookValidation = await validateCandidateHooks({
      worktree,
      candidateTree: evidence.payload.git.targetTree,
      parent,
      message: proposedMessage,
      signal: ctx.signal,
      onProcessStart: processContext
        ? (pid) => processContext.manager.registerProcess(pid, {
            cwd: worktree,
            parentId: processContext.owner.id,
            label: `${item} candidate hook validation`,
          })
        : undefined,
      onProcessExit: processContext
        ? (pid) => processContext.manager.forgetProcess(pid)
        : undefined,
    });
    if (hookValidation.status !== "passed") {
      return {
        status: "blocked",
        binder,
        item,
        targetTree: evidence.payload.git.targetTree,
        checks,
        verification,
        hookValidation,
        message:
          hookValidation.status === "failed"
            ? "A repository commit hook failed in the disposable finalization worktree."
            : "A repository commit hook changed the reviewed tree; finalization stopped.",
      };
    }
    const message = hookValidation.message ?? proposedMessage;
    if (
      !message.split("\n", 1)[0].includes(`[hatch:item-${item}]`) &&
      !new RegExp(`^Hatch-Item:\\s*item-${item}$`, "mi").test(message)
    ) {
      throw new Error("Hatch commit hooks removed the mandatory item marker");
    }
    const commit = await git(worktree, [
      "commit-tree",
      evidence.payload.git.targetTree,
      "-p",
      parent,
      "-m",
      message,
    ]);
    await this.#checkpoint("candidate-commit-created");
    await git(worktree, [
      "update-ref",
      `refs/heads/${expectedBranch}`,
      commit,
      parent,
    ]);
    await this.#checkpoint("item-branch-updated");
    const committedHead = await git(worktree, ["rev-parse", "HEAD"]);
    if (committedHead !== commit) {
      throw new Error("Hatch item branch did not advance to the exact-tree commit");
    }
    const commitTree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
    if (commitTree !== evidence.payload.git.targetTree) {
      throw new Error("Hatch committed tree does not match the verified candidate tree");
    }
    await git(worktree, [
      "update-ref",
      `refs/hatch/${binder}/item-${item}/built`,
      commit,
      await nullObjectId(worktree),
    ]);
    await this.#checkpoint("built-ref-updated");
    return {
      status: "built",
      binder,
      item,
      targetTree: commitTree,
      commit,
      checks,
      hookValidation,
      verification,
      message: "Candidate committed and built ref written after exact-tree verification.",
    };
  }
}
