import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  runStableTreeChecks,
  type CheckConvergenceResult,
  type HatchCheckPlanEntry,
} from "./check-convergence.ts";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import {
  buildHatchEvidence,
  verifyEvidenceFreshness,
  type HatchCheckManifest,
} from "./evidence.ts";
import { validateCandidateHooks, type HookValidationResult } from "./hook-runner.ts";
import { requirePackagePath } from "./package-paths.ts";
import {
  HatchProcessManager,
  type BinderLifecycleOwner,
} from "./process-manager.ts";
import {
  visualBlockedMessage,
  type HatchVerificationResult,
  type HatchVerificationRunner,
} from "./verification-runner.ts";

const exec = promisify(execFile);
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

export type HatchBuildFinalizationStatus = "built" | "failed" | "retry" | "blocked" | "no-change";

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
  message: string;
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

async function nullObjectId(cwd: string): Promise<string> {
  const format = await git(cwd, ["rev-parse", "--show-object-format"]);
  if (format === "sha1") return "0".repeat(40);
  if (format === "sha256") return "0".repeat(64);
  throw new Error(`Hatch does not support Git object format '${format}'`);
}

async function scanSecrets(
  cwd: string,
  committedRange?: { base: string; target: string },
): Promise<void> {
  const args = [
    "run",
    "--script",
    requirePackagePath("skills/hatch-build/scripts/scan_secrets.py"),
  ];
  if (committedRange) args.push("--base", committedRange.base, "--target", committedRange.target);
  try {
    await exec(
      "uv",
      args,
      { cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT },
    );
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const stdout = (error as { stdout?: string }).stdout?.trim();
    throw new Error(stderr || stdout || "Hatch secret scan failed");
  }
}

async function rejectProtectedCandidate(cwd: string): Promise<void> {
  const changed = await git(cwd, ["diff", "--cached", "--name-only", "-z"]);
  const paths = changed.split("\0").filter(Boolean);
  const protectedPath = paths.find(
    (path) => path === ".git" || path.startsWith(".git/") || path === ".hatch" || path.startsWith(".hatch/"),
  );
  if (protectedPath) {
    throw new Error(`Hatch build candidate modifies protected orchestration state: ${protectedPath}`);
  }
}

function finalizationStatus(verification: HatchVerificationResult): HatchBuildFinalizationStatus {
  if (verification.status === "pass" || verification.status === "skipped") return "built";
  if (verification.status === "concerns") return "retry";
  return "blocked";
}

// A blocked verification names its cause. A typed visual prerequisite is a fail-closed
// unmet precondition, not a gate failure, so it gets the shared, actionable per-reason
// message; anything else keeps the site's fallback. It writes no completion ref either
// way — the caller keys on status, and there is no fall-through that moves a ref.
function blockedFinalizationMessage(
  verification: HatchVerificationResult,
  fallback: string,
): string {
  return verification.blockedReason ? visualBlockedMessage(verification.blockedReason) : fallback;
}

// A precondition-unmet convergence means the declared environment probe failed before
// any floor or oracle command ran. It maps to blocked — a missing daemon is not fixed by
// a worker retry — and echoes the project's own remediation so the halt is actionable
// instead of an opaque wall of tool errors from a command run into a wall.
function preconditionHaltMessage(convergence: { remediation?: string }): string {
  const base = "Declared environment precondition unmet; the floor was not run.";
  return convergence.remediation ? `${base} ${convergence.remediation}` : base;
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
      await rejectProtectedCandidate(worktree);
      await scanSecrets(worktree, { base: parents[0], target: integrationTip });
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
          message: blockedFinalizationMessage(
            verification,
            "Landed merge recovery did not pass fresh verification; done remains absent.",
          ),
        };
      }
      if ((await git(repository, ["rev-parse", integrationRef])) !== integrationTip) {
        throw new Error("Hatch integration tip moved during merged recovery");
      }
      await git(repository, [
        "update-ref",
        `refs/hatch/${binder}/item-${item}/done`,
        integrationTip,
        await nullObjectId(repository),
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
      checks = convergence.manifest;
    }
    await rejectProtectedCandidate(worktree);
    await scanSecrets(worktree, { base: parent, target: commit });
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
          : blockedFinalizationMessage(
              verification,
              "Committed candidate recovery was blocked by gate evidence.",
            ),
      };
    }
    const committedMessage = await git(worktree, ["show", "-s", "--format=%B", commit]);
    const hookValidation = await validateCandidateHooks({
      worktree,
      candidateTree: committedTree,
      parent,
      message: committedMessage,
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
    await git(worktree, [
      "update-ref",
      `refs/hatch/${binder}/item-${item}/failed`,
      head,
      await nullObjectId(worktree),
    ]);
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
    await git(worktree, [
      "update-ref",
      `refs/hatch/${binder}/item-${item}/failed`,
      commit,
      await nullObjectId(worktree),
    ]);
    await this.#checkpoint("failed-ref-updated");
    return {
      ...candidate,
      status: "failed",
      commit,
      hookValidation,
      message: "Gate-capped candidate committed and failed ref written ref-last.",
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
  ): Promise<HatchBuildFinalizationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch build finalization requires the active binder lock lease");
    }
    await git(worktree, ["add", "-A"]);
    await this.#checkpoint("candidate-staged");
    const stagedTree = await git(worktree, ["write-tree"]);
    const headTree = await git(worktree, ["rev-parse", "HEAD^{tree}"]);
    if (stagedTree === headTree) {
      return {
        status: "no-change",
        binder,
        item,
        targetTree: stagedTree,
        message: "Worker produced no candidate change; no completion ref was written.",
      };
    }
    await rejectProtectedCandidate(worktree);
    const preliminaryEvidence = await buildHatchEvidence({
      cwd: worktree,
      binder,
      item,
      target: "candidate",
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
                ? "A final floor check failed; return the candidate to the worker."
                : `Final checks stopped as ${convergence.status}; the candidate remains staged for recovery.`,
        };
      }
      checks = convergence.manifest;
    }
    await this.#checkpoint("checks-bound");
    await rejectProtectedCandidate(worktree);
    await scanSecrets(worktree);
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
            : blockedFinalizationMessage(
                verification,
                "Gate evidence blocked finalization; the candidate remains staged.",
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
