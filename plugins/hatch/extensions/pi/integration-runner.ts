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
import type { HatchGateFinding } from "./gate-runner.ts";
import { validateMergeHooks, type HookValidationResult } from "./hook-runner.ts";
import { requirePackagePath } from "./package-paths.ts";
import {
  HatchProcessManager,
  type BinderLifecycleOwner,
} from "./process-manager.ts";
import {
  blockedVerificationMessage,
  type HatchVerificationResult,
  type HatchVerificationRunner,
} from "./verification-runner.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;

// A merge-time verification that did not pass names its cause, then up to three citation
// defects with the required shape, as a blocked build finalization does. A host-written
// gate verdict leads with its cause and ends with the merge-time next step: the item is
// marked failed, and "Fix and rerun" re-validates it.
function verificationHaltMessage(verification: HatchVerificationResult): string {
  return blockedVerificationMessage(
    verification,
    "Proposed integration tree did not pass fresh verification.",
    "failed",
    verification.citationDefects ?? [],
  );
}

export type HatchIntegrationCheckpoint = (
  name:
    | "proposed-tree"
    | "checks-bound"
    | "gates-complete"
    | "merge-commit-created"
    | "integration-ref-updated"
    | "done-ref-updated"
    | "failed-ref-deleted"
    | "accepted-ref-updated"
    | "accept-merge-reverted",
) => Promise<void> | void;

export interface HatchIntegrationResult {
  schema: "hatch-integration-item-v1";
  binder: string;
  item: string;
  status: "integrated" | "retry" | "blocked";
  base: string;
  itemTip: string;
  targetTree?: string;
  mergeCommit?: string;
  checks?: HatchCheckManifest;
  checkFailure?: CheckConvergenceResult;
  plannedChecks?: HatchCheckPlanEntry[];
  verification?: HatchVerificationResult;
  safetyVerification?: HatchVerificationResult;
  hookValidation?: HookValidationResult;
  accepted?: boolean;
  message: string;
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during integration`);
  }
}

async function optionalCommitRef(cwd: string, ref: string): Promise<string | undefined> {
  try {
    await exec("git", ["-C", cwd, "show-ref", "--verify", "--quiet", ref], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
  } catch (error) {
    if ((error as { code?: number }).code === 1) return undefined;
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git show-ref failed for ${ref}`);
  }
  return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

async function nullObjectId(cwd: string): Promise<string> {
  const format = await git(cwd, ["rev-parse", "--show-object-format"]);
  if (format === "sha1") return "0".repeat(40);
  if (format === "sha256") return "0".repeat(64);
  throw new Error(`Hatch does not support Git object format '${format}'`);
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

function failedCheckId(convergence: CheckConvergenceResult): string | undefined {
  return convergence.status === "stable" ? undefined : convergence.check?.id;
}

// The merge-time failure message. It names the worktree the check ran in, the command
// verbatim and its exit code, because the fresh merge worktree is provisioned only by
// .hatch/environment.json and that is the first thing a reader needs to know.
function proposedCheckFailureMessage(
  convergence: CheckConvergenceResult,
  plan: HatchCheckPlanEntry[],
): string {
  if (convergence.status === "stable") {
    return "Proposed integration checks passed in a fresh merge worktree but changed the exact merge tree.";
  }
  const diagnosis = convergence.diagnosis;
  const id = diagnosis?.checkId ?? convergence.check?.id;
  if (convergence.status === "non-converging" || !id) {
    return "Proposed integration checks kept changing the tree in a fresh merge worktree.";
  }
  const command = diagnosis?.command ?? plan.find((check) => check.id === id)?.command;
  const code = diagnosis?.exitCode ?? convergence.check?.result.code ?? null;
  const exited = code === null ? "exited without an exit code" : `exited ${code}`;
  const subject = command ? `: \`${command}\`` : "";
  switch (convergence.status) {
    case "failed":
      return `Proposed integration check '${id}' failed in a fresh merge worktree${subject} ${exited}.`;
    case "precondition-unmet":
      return `Proposed integration environment preflight '${id}' failed in a fresh merge worktree${subject} ${exited}.`;
    case "timed-out":
      return `Proposed integration check '${id}' timed out in a fresh merge worktree${subject}.`;
    case "aborted":
      return `Proposed integration check '${id}' was aborted in a fresh merge worktree${subject}.`;
  }
}

function plannedCheckSummary(plan: HatchCheckPlanEntry[]): HatchCheckPlanEntry[] {
  return plan.map(({ id, command, cwd, purpose }) => ({ id, command, cwd, purpose }));
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
      { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT },
    );
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ""}${(error as { stderr?: string }).stderr ?? ""}`.trim();
    throw new Error(output || "Hatch integration secret scan failed");
  }
}

export class HatchIntegrationRunner {
  readonly #locks: DispatchLockManager;
  readonly #verification: HatchVerificationRunner;
  readonly #checkpoint: HatchIntegrationCheckpoint;

  constructor(
    locks: DispatchLockManager,
    verification: HatchVerificationRunner,
    checkpoint: HatchIntegrationCheckpoint = () => {},
  ) {
    this.#locks = locks;
    this.#verification = verification;
    this.#checkpoint = checkpoint;
  }

  async recoverAccepted(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    floorChecks: HatchCheckPlanEntry[] = [],
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
  ): Promise<HatchIntegrationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch accepted recovery requires the active binder lock lease");
    }
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const itemRef = `refs/heads/hatch/${binder}/item-${item}`;
    const [mergeCommit, itemTip, failed, done, accepted] = await Promise.all([
      git(integrationWorktree, ["rev-parse", integrationRef]),
      git(integrationWorktree, ["rev-parse", itemRef]),
      optionalCommitRef(integrationWorktree, `refs/hatch/${binder}/item-${item}/failed`),
      optionalCommitRef(integrationWorktree, `refs/hatch/${binder}/item-${item}/done`),
      optionalCommitRef(integrationWorktree, `refs/hatch/${binder}/item-${item}/accepted`),
    ]);
    const parents = (await git(integrationWorktree, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      mergeCommit,
    ])).split(/\s+/).slice(1);
    const message = await git(integrationWorktree, ["show", "-s", "--format=%B", mergeCommit]);
    if (
      parents.length !== 2 ||
      parents[1] !== itemTip ||
      (failed !== undefined && failed !== itemTip) ||
      (done !== undefined && done !== mergeCommit) ||
      accepted !== undefined ||
      !/^Hatch-Accepted:\s*\S+/mi.test(message) ||
      !/^Hatch-Accept-Reason:\s*\S+/mi.test(message)
    ) {
      throw new Error("Hatch accepted recovery found contradictory merge or ref evidence");
    }
    const targetTree = await git(integrationWorktree, ["rev-parse", `${mergeCommit}^{tree}`]);
    const revertAccepted = async (
      reason: string,
      failure?: Pick<HatchIntegrationResult, "checkFailure" | "plannedChecks">,
    ): Promise<HatchIntegrationResult> => {
      await git(integrationWorktree, ["read-tree", "--reset", "-u", parents[0]]);
      await git(integrationWorktree, ["update-ref", integrationRef, parents[0], mergeCommit]);
      if (done) {
        await git(integrationWorktree, [
          "update-ref",
          "-d",
          `refs/hatch/${binder}/item-${item}/done`,
          mergeCommit,
        ]);
      }
      if (!failed) {
        await git(integrationWorktree, [
          "update-ref",
          `refs/hatch/${binder}/item-${item}/failed`,
          itemTip,
          await nullObjectId(integrationWorktree),
        ]);
      }
      await this.#checkpoint("accept-merge-reverted");
      return {
        schema: "hatch-integration-item-v1",
        binder,
        item,
        status: "blocked",
        base: parents[0],
        itemTip,
        targetTree,
        mergeCommit,
        accepted: false,
        checkFailure: failure?.checkFailure,
        plannedChecks: failure?.plannedChecks,
        message: reason,
      };
    };
    const preliminaryEvidence = await buildHatchEvidence({
      cwd: integrationWorktree,
      binder,
      item,
      target: "landed",
    });
    const oracle = oracleCheck(preliminaryEvidence.payload.workItem);
    const oracleKey = oracle ? `${oracle.cwd}\0${oracle.command}` : undefined;
    const plan: HatchCheckPlanEntry[] = floorChecks
      .filter((check) => `${check.cwd}\0${check.command}` !== oracleKey)
      .map((check) => ({ ...check, purpose: "floor" as const }));
    if (oracle) plan.push(oracle);
    let checks: HatchCheckManifest | undefined;
    if (plan.length > 0) {
      const convergence = await runStableTreeChecks({
        worktree: integrationWorktree,
        checks: plan,
        environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
        site: "integration",
        signal: ctx.signal,
        onProcessStart: processContext
          ? (pid) => processContext.manager.registerProcess(pid, {
              cwd: integrationWorktree,
              parentId: processContext.owner.id,
              label: `${item} accepted recovery floor`,
              role: "host-check",
            })
          : undefined,
        onProcessExit: processContext
          ? (pid) => processContext.manager.forgetProcess(pid)
          : undefined,
      });
      if (convergence.status !== "stable" || convergence.targetTree !== targetTree) {
        const failingId = failedCheckId(convergence);
        return revertAccepted(
          failingId
            ? `Accepted recovery check '${failingId}' failed; merge reverted and failed ref restored.`
            : "Accepted recovery floor failed; merge reverted and failed ref restored.",
          {
            checkFailure: convergence,
            plannedChecks: plannedCheckSummary(plan),
          },
        );
      }
      checks = convergence.manifest;
    }
    await scanSecrets(integrationWorktree, { base: parents[0], target: mergeCommit });
    const evidence = await buildHatchEvidence({
      cwd: integrationWorktree,
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
      { cwd: integrationWorktree, target: "landed", checkManifest: checks },
      processContext
        ? { processes: processContext, worktree: integrationWorktree, treeish: mergeCommit }
        : undefined,
    );
    let safetyVerification: HatchVerificationResult | undefined;
    let reviewPassed = verification.status === "pass" || verification.status === "skipped";
    if (verification.status === "concerns" && verification.gates.acceptance?.verdict === "concerns") {
      const waivedCodes = new Set(
        [...message.matchAll(/^Hatch-Accepted:\s*([^@\s]+)/gmi)].map((match) => match[1]),
      );
      reviewPassed = verification.gates.acceptance.findings.every((finding) =>
        waivedCodes.has(finding.code),
      );
      if (reviewPassed) {
        safetyVerification = await this.#verification.runWithLease(
          ctx,
          binder,
          item,
          "boundary-only",
          lease,
          { cwd: integrationWorktree, target: "landed", checkManifest: checks },
        );
        reviewPassed = safetyVerification.status === "pass" || safetyVerification.status === "skipped";
      }
    }
    if (!reviewPassed) {
      return revertAccepted(
        "Accepted recovery found new or unsafe findings; merge reverted and failed ref restored.",
      );
    }
    if (!done) {
      await git(integrationWorktree, [
        "update-ref",
        `refs/hatch/${binder}/item-${item}/done`,
        mergeCommit,
        await nullObjectId(integrationWorktree),
      ]);
      await this.#checkpoint("done-ref-updated");
    }
    if (failed) {
      await git(integrationWorktree, [
        "update-ref",
        "-d",
        `refs/hatch/${binder}/item-${item}/failed`,
        itemTip,
      ]);
      await this.#checkpoint("failed-ref-deleted");
    }
    await git(integrationWorktree, [
      "update-ref",
      `refs/hatch/${binder}/item-${item}/accepted`,
      itemTip,
      await nullObjectId(integrationWorktree),
    ]);
    await this.#checkpoint("accepted-ref-updated");
    return {
      schema: "hatch-integration-item-v1",
      binder,
      item,
      status: "integrated",
      base: parents[0],
      itemTip,
      targetTree,
      mergeCommit,
      checks,
      verification,
      safetyVerification,
      accepted: true,
      message: "Accepted merge recovery completed with accepted ref-last.",
    };
  }

  async integrate(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    floorChecks: HatchCheckPlanEntry[] = [],
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
    acceptance?: {
      authorize(findings: HatchGateFinding[]): Promise<{ reason: string } | undefined>;
    },
  ): Promise<HatchIntegrationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch integration requires the active binder lock lease");
    }
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const itemRef = `refs/heads/hatch/${binder}/item-${item}`;
    const [base, itemTip, built, failed, branch, status] = await Promise.all([
      git(integrationWorktree, ["rev-parse", integrationRef]),
      git(integrationWorktree, ["rev-parse", itemRef]),
      optionalCommitRef(integrationWorktree, `refs/hatch/${binder}/item-${item}/built`),
      optionalCommitRef(integrationWorktree, `refs/hatch/${binder}/item-${item}/failed`),
      git(integrationWorktree, ["branch", "--show-current"]),
      git(integrationWorktree, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    ]);
    if (acceptance) {
      if (failed !== itemTip || built) {
        throw new Error("Hatch acceptance requires failed ref at the item tip and no built ref");
      }
    } else if (built !== itemTip) {
      throw new Error("Hatch integration requires built ref at the item tip");
    }
    if (branch !== `hatch/${binder}/integration` || status) {
      throw new Error("Hatch integration worktree is not the clean owned integration branch");
    }
    const preliminaryEvidence = await buildHatchEvidence({
      cwd: integrationWorktree,
      binder,
      item,
      target: "merge",
    });
    const targetTree = preliminaryEvidence.payload.git.targetTree;
    await this.#checkpoint("proposed-tree");
    const oracle = oracleCheck(preliminaryEvidence.payload.workItem);
    const oracleKey = oracle ? `${oracle.cwd}\0${oracle.command}` : undefined;
    const plan: HatchCheckPlanEntry[] = floorChecks
      .filter((check) => `${check.cwd}\0${check.command}` !== oracleKey)
      .map((check) => ({ ...check, purpose: "floor" as const }));
    if (oracle) plan.push(oracle);

    const root = await mkdtemp(join(tmpdir(), "hatch-proposed-integration-"));
    const proposedWorktree = join(root, "worktree");
    let registered = false;
    try {
      await git(integrationWorktree, [
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        proposedWorktree,
        base,
      ]);
      registered = true;
      await git(proposedWorktree, ["read-tree", "--reset", "-u", targetTree]);
      let checks: HatchCheckManifest | undefined;
      if (plan.length > 0) {
        const convergence = await runStableTreeChecks({
          worktree: proposedWorktree,
          checks: plan,
          environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
          site: "fresh-merge",
          signal: ctx.signal,
          onProcessStart: processContext
            ? (pid) => processContext.manager.registerProcess(pid, {
                cwd: proposedWorktree,
                parentId: processContext.owner.id,
                label: `${item} proposed integration check`,
                role: "host-check",
              })
            : undefined,
          onProcessExit: processContext
            ? (pid) => processContext.manager.forgetProcess(pid)
            : undefined,
        });
        if (convergence.status !== "stable" || convergence.targetTree !== targetTree) {
          return {
            schema: "hatch-integration-item-v1",
            binder,
            item,
            status: convergence.status === "failed" ? "retry" : "blocked",
            base,
            itemTip,
            targetTree: convergence.targetTree,
            checkFailure: convergence,
            plannedChecks: plannedCheckSummary(plan),
            message: proposedCheckFailureMessage(convergence, plan),
          };
        }
        checks = convergence.manifest;
      }
      await this.#checkpoint("checks-bound");
      const protectedPaths = (await git(proposedWorktree, [
        "diff",
        "--cached",
        "--name-only",
        "-z",
      ])).split("\0").filter(Boolean).filter(
        (path) => path === ".hatch" || path.startsWith(".hatch/") || path === ".git" || path.startsWith(".git/"),
      );
      if (protectedPaths.length > 0) {
        throw new Error(`Hatch integration modifies protected state: ${protectedPaths[0]}`);
      }
      await scanSecrets(proposedWorktree);
      const evidence = await buildHatchEvidence({
        cwd: integrationWorktree,
        binder,
        item,
        target: "merge",
        checkManifest: checks,
      });
      await verifyEvidenceFreshness(evidence);
      const verification = await this.#verification.runWithLease(
        ctx,
        binder,
        item,
        "full",
        lease,
        { cwd: integrationWorktree, target: "merge", checkManifest: checks },
        processContext
          ? { processes: processContext, worktree: proposedWorktree, treeish: targetTree }
          : undefined,
      );
      await this.#checkpoint("gates-complete");
      let safetyVerification: HatchVerificationResult | undefined;
      let waiver: { reason: string; findings: HatchGateFinding[] } | undefined;
      if (acceptance) {
        let findings: HatchGateFinding[] = [];
        if (verification.status === "concerns") {
          if (verification.gates.acceptance?.verdict !== "concerns") {
            return {
              schema: "hatch-integration-item-v1",
              binder,
              item,
              status: "blocked",
              base,
              itemTip,
              targetTree,
              checks,
              verification,
              message: "Human acceptance cannot waive a safety-gate concern.",
            };
          }
          findings = verification.gates.acceptance.findings;
          safetyVerification = await this.#verification.runWithLease(
            ctx,
            binder,
            item,
            "boundary-only",
            lease,
            { cwd: integrationWorktree, target: "merge", checkManifest: checks },
          );
          if (safetyVerification.status !== "pass" && safetyVerification.status !== "skipped") {
            return {
              schema: "hatch-integration-item-v1",
              binder,
              item,
              status: "blocked",
              base,
              itemTip,
              targetTree,
              checks,
              verification,
              safetyVerification,
              message: blockedVerificationMessage(
                safetyVerification,
                "Human acceptance cannot waive a safety-gate failure.",
                "failed",
              ),
            };
          }
        } else if (verification.status !== "pass" && verification.status !== "skipped") {
          return {
            schema: "hatch-integration-item-v1",
            binder,
            item,
            status: "blocked",
            base,
            itemTip,
            targetTree,
            checks,
            verification,
            message: blockedVerificationMessage(
              verification,
              "Failed item could not be freshly reviewed for human acceptance.",
              "failed",
            ),
          };
        }
        const authorization = await acceptance.authorize(findings);
        const reason = authorization?.reason.replace(/\s+/g, " ").trim() ?? "";
        if (!reason || reason.length > 1_000) {
          return {
            schema: "hatch-integration-item-v1",
            binder,
            item,
            status: "blocked",
            base,
            itemTip,
            targetTree,
            checks,
            verification,
            safetyVerification,
            message: "Human acceptance was cancelled or supplied no bounded reason.",
          };
        }
        waiver = { reason, findings };
      } else if (verification.status !== "pass" && verification.status !== "skipped") {
        return {
          schema: "hatch-integration-item-v1",
          binder,
          item,
          status: verification.status === "concerns" ? "retry" : "blocked",
          base,
          itemTip,
          targetTree,
          checks,
          verification,
          message: verificationHaltMessage(verification),
        };
      }
      const acceptTrailers = waiver
        ? [
            ...(waiver.findings.length > 0
              ? waiver.findings.map((finding) =>
                  `Hatch-Accepted: ${finding.code}${finding.path ? `@${finding.path}${finding.line ? `:${finding.line}` : ""}` : ""}`,
                )
              : ["Hatch-Accepted: fresh-review-passed"]),
            `Hatch-Accept-Reason: ${waiver.reason}`,
          ]
        : [];
      const mergeSubject = waiver
        ? `Accept item ${item} into integration [hatch:item-${item}]`
        : `Merge item ${item} into integration [hatch:item-${item}]`;
      const proposedMessage = [
        mergeSubject,
        ...(acceptTrailers.length > 0 ? ["", ...acceptTrailers] : []),
      ].join("\n");
      const hookValidation = await validateMergeHooks({
        worktree: integrationWorktree,
        integrationTip: base,
        itemTip,
        candidateTree: targetTree,
        message: proposedMessage,
        signal: ctx.signal,
        onProcessStart: processContext
          ? (pid) => processContext.manager.registerProcess(pid, {
              cwd: integrationWorktree,
              parentId: processContext.owner.id,
              label: `${item} merge hook validation`,
            })
          : undefined,
        onProcessExit: processContext
          ? (pid) => processContext.manager.forgetProcess(pid)
          : undefined,
      });
      if (hookValidation.status !== "passed") {
        return {
          schema: "hatch-integration-item-v1",
          binder,
          item,
          status: "blocked",
          base,
          itemTip,
          targetTree,
          checks,
          verification,
          hookValidation,
          message: "Repository merge hooks failed or changed the verified merge tree.",
        };
      }
      const message = hookValidation.message ?? proposedMessage;
      const committedSubject = message.split("\n", 1)[0];
      if (
        !committedSubject.includes(mergeSubject) &&
        !committedSubject.includes(`[hatch:merge-item-${item}]`)
      ) {
        throw new Error("Hatch merge hooks removed the mandatory merge marker");
      }
      if (
        waiver &&
        (!/^Hatch-Accepted:\s*\S+/mi.test(message) ||
          !/^Hatch-Accept-Reason:\s*\S+/mi.test(message))
      ) {
        throw new Error("Hatch merge hooks removed mandatory human-accept trailers");
      }
      const mergeCommit = await git(integrationWorktree, [
        "commit-tree",
        targetTree,
        "-p",
        base,
        "-p",
        itemTip,
        "-m",
        message,
      ]);
      await this.#checkpoint("merge-commit-created");
      await git(integrationWorktree, ["update-ref", integrationRef, mergeCommit, base]);
      await this.#checkpoint("integration-ref-updated");
      await git(integrationWorktree, ["read-tree", "--reset", "-u", mergeCommit]);
      const actualTree = await git(integrationWorktree, ["rev-parse", "HEAD^{tree}"]);
      const parents = (await git(integrationWorktree, ["rev-list", "--parents", "-n", "1", "HEAD"]))
        .split(/\s+/).slice(1);
      if (
        actualTree !== targetTree ||
        parents.length !== 2 ||
        parents[0] !== base ||
        parents[1] !== itemTip
      ) {
        throw new Error("Hatch integration commit does not preserve the verified merge transaction");
      }
      if (waiver && plan.length > 0) {
        const postAccept = await runStableTreeChecks({
          worktree: integrationWorktree,
          checks: plan,
          environmentSetupRef: `refs/heads/hatch/${binder}/integration`,
          site: "integration",
          signal: ctx.signal,
          onProcessStart: processContext
            ? (pid) => processContext.manager.registerProcess(pid, {
                cwd: integrationWorktree,
                parentId: processContext.owner.id,
                label: `${item} post-accept floor`,
                role: "host-check",
              })
            : undefined,
          onProcessExit: processContext
            ? (pid) => processContext.manager.forgetProcess(pid)
            : undefined,
        });
        if (postAccept.status !== "stable" || postAccept.targetTree !== targetTree) {
          await git(integrationWorktree, ["read-tree", "--reset", "-u", base]);
          try {
            await git(integrationWorktree, ["update-ref", integrationRef, base, mergeCommit]);
          } catch (error) {
            await git(integrationWorktree, ["read-tree", "--reset", "-u", mergeCommit]);
            throw error;
          }
          await this.#checkpoint("accept-merge-reverted");
          const failingId = failedCheckId(postAccept);
          return {
            schema: "hatch-integration-item-v1",
            binder,
            item,
            status: "blocked",
            base,
            itemTip,
            targetTree,
            checks,
            verification,
            safetyVerification,
            hookValidation,
            checkFailure: postAccept,
            plannedChecks: plannedCheckSummary(plan),
            accepted: false,
            message: failingId
              ? `Post-accept check '${failingId}' failed; the accepted merge was reverted and failed ref preserved.`
              : "Post-accept floor failed; the accepted merge was reverted and failed ref preserved.",
          };
        }
      }
      await git(integrationWorktree, [
        "update-ref",
        `refs/hatch/${binder}/item-${item}/done`,
        mergeCommit,
        await nullObjectId(integrationWorktree),
      ]);
      await this.#checkpoint("done-ref-updated");
      if (waiver) {
        await git(integrationWorktree, [
          "update-ref",
          "-d",
          `refs/hatch/${binder}/item-${item}/failed`,
          itemTip,
        ]);
        await this.#checkpoint("failed-ref-deleted");
        await git(integrationWorktree, [
          "update-ref",
          `refs/hatch/${binder}/item-${item}/accepted`,
          itemTip,
          await nullObjectId(integrationWorktree),
        ]);
        await this.#checkpoint("accepted-ref-updated");
      }
      return {
        schema: "hatch-integration-item-v1",
        binder,
        item,
        status: "integrated",
        base,
        itemTip,
        targetTree,
        mergeCommit,
        checks,
        verification,
        safetyVerification,
        hookValidation,
        accepted: Boolean(waiver),
        message: waiver
          ? "Human-waived merge passed safety and post-accept floor; accepted ref written last."
          : "Verified no-ff merge committed and done ref written ref-last.",
      };
    } finally {
      if (registered) {
        await git(integrationWorktree, ["worktree", "remove", "--force", proposedWorktree], true)
          .catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  }
}
