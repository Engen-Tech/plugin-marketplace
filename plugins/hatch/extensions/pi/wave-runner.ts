import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  runEnvironmentPreflight,
  runStableTreeChecks,
  setupBlobOf,
  type HatchCheckPlanEntry,
} from "./check-convergence.ts";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import { readEnvironmentConfig } from "./environment.ts";
import { hashCheckCommand } from "./evidence.ts";
import type { HatchIntegrationResult } from "./integration-runner.ts";
import { requirePackagePath } from "./package-paths.ts";
import {
  HatchProcessManager,
  type BinderLifecycleOwner,
} from "./process-manager.ts";
import { runProgress } from "./run-events.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;

export interface HatchWaveAnchor {
  binder: string;
  wave: number;
  base: string;
  baseTag: string;
}

export interface HatchWaveFinalizationResult {
  schema: "hatch-wave-finalization-v1";
  status: "passed" | "rolled-back";
  anchor: HatchWaveAnchor;
  tip: string;
  successTag?: string;
  /** Items that failed merge-time review in a wave that otherwise passed. */
  failedItems?: string[];
  message: string;
}

export type HatchWaveCheckpoint = (
  name:
    | "base-tag-updated"
    | "post-wave-checks-complete"
    | "rollback-worktree-prepared"
    | "rollback-refs-committed"
    | "rollback-tag-updated"
    | "success-tag-updated",
) => Promise<void> | void;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during wave finalization`);
  }
}

async function nullObjectId(cwd: string): Promise<string> {
  const format = await git(cwd, ["rev-parse", "--show-object-format"]);
  if (format === "sha1") return "0".repeat(40);
  if (format === "sha256") return "0".repeat(64);
  throw new Error(`Hatch does not support Git object format '${format}'`);
}

async function updateRefsTransaction(cwd: string, commands: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "update-ref", "--stdin"], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || stdout.trim() || `git update-ref transaction failed (${code})`));
    });
    child.stdin.end(`start\n${commands.join("\n")}\nprepare\ncommit\n`);
  });
}

function dedupeChecks(checks: HatchCheckPlanEntry[]): HatchCheckPlanEntry[] {
  const seen = new Set<string>();
  const result: HatchCheckPlanEntry[] = [];
  for (const check of checks) {
    const key = `${check.cwd}\0${check.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...check, purpose: "floor" });
  }
  return result;
}

// The lone landed merge whose merge checks already cover the post-wave floor, or undefined.
// Each rule is content, read now: the tip is that one merge on the wave base, its merge
// checks bound the tree the clean worktree holds, every post-wave command has a passing
// receipt there with the same cwd, and the setup the merge checks read is the setup at the
// tip. A recovered pending wave carries no merge checks, so it always reruns.
async function coveringMerge(
  worktree: string,
  anchor: HatchWaveAnchor,
  tip: string,
  integrated: HatchIntegrationResult[],
  plan: HatchCheckPlanEntry[],
): Promise<HatchIntegrationResult | undefined> {
  if (integrated.length !== 1) return undefined;
  const [lone] = integrated;
  const checks = lone.checks;
  if (lone.mergeCommit !== tip || lone.base !== anchor.base || !checks) return undefined;
  const { stdout: status } = await exec(
    "git",
    ["-C", worktree, "status", "--porcelain=v2", "-z", "--untracked-files=all"],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT },
  );
  if (status !== "") return undefined;
  if ((await git(worktree, ["rev-parse", "HEAD^{tree}"])) !== checks.targetTree) return undefined;
  const covered = plan.every((check) => checks.entries.some((entry) =>
    entry.receipt.status === "passed" &&
    entry.receipt.cwd === check.cwd &&
    entry.receipt.commandHash === hashCheckCommand(check.command)));
  if (!covered) return undefined;
  if ((await setupBlobOf(worktree, anchor.base)) !== (await setupBlobOf(worktree, tip))) return undefined;
  return lone;
}

async function sharedTermsPass(worktree: string, binder: string): Promise<boolean> {
  try {
    await exec(
      "uv",
      [
        "run",
        "--script",
        requirePackagePath("skills/hatch-plan/scripts/check_shared_terms.py"),
        "--binder",
        `.hatch/binders/${binder}.json`,
        worktree,
      ],
      { cwd: worktree, encoding: "utf8", maxBuffer: MAX_OUTPUT },
    );
    return true;
  } catch (error) {
    if (typeof (error as { code?: unknown }).code === "number") return false;
    throw error;
  }
}

export class HatchWaveRunner {
  readonly #locks: DispatchLockManager;
  readonly #checkpoint: HatchWaveCheckpoint;

  constructor(
    locks: DispatchLockManager,
    checkpoint: HatchWaveCheckpoint = () => {},
  ) {
    this.#locks = locks;
    this.#checkpoint = checkpoint;
  }

  async start(
    binder: string,
    wave: number,
    integrationWorktree: string,
    lease: DispatchLockLease,
  ): Promise<HatchWaveAnchor> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch wave start requires the active binder lock lease");
    }
    const base = await git(integrationWorktree, ["rev-parse", "HEAD"]);
    const baseTag = `refs/tags/hatch/${binder}/wave-${wave}-base`;
    await git(integrationWorktree, [
      "update-ref",
      baseTag,
      base,
      await nullObjectId(integrationWorktree),
    ]);
    await this.#checkpoint("base-tag-updated");
    return { binder, wave, base, baseTag };
  }

  async finish(
    ctx: ExtensionContext,
    anchor: HatchWaveAnchor,
    integrationWorktree: string,
    lease: DispatchLockLease,
    integrations: HatchIntegrationResult[],
    checks: HatchCheckPlanEntry[],
    processContext?: { manager: HatchProcessManager; owner: BinderLifecycleOwner },
  ): Promise<HatchWaveFinalizationResult> {
    if (!(await this.#locks.owns(lease))) {
      throw new Error("Hatch wave finish requires the active binder lock lease");
    }
    const tip = await git(integrationWorktree, ["rev-parse", "HEAD"]);
    // Roll back the failure, not the wave. Merges are serial, so an item that failed its
    // merge-time review never moved the tip: the merges before and after it stand, and the
    // failed item carries its own failed ref. Only a wave in which nothing landed, or whose
    // assembled tip fails the post-wave checks below, is rolled back whole (Revert-the-wave).
    const integrated = integrations.filter((integration) => integration.status === "integrated");
    const failedItems = integrations
      .filter((integration) => integration.status !== "integrated")
      .map((integration) => integration.item);
    let failure = failedItems.length > 0 && integrated.length === 0;
    const plan = dedupeChecks(checks);
    const environmentSetupRef = `refs/heads/hatch/${anchor.binder}/integration`;
    const processHooks = {
      signal: ctx.signal,
      onProcessStart: processContext
        ? (pid: number) => processContext.manager.registerProcess(pid, {
            cwd: integrationWorktree,
            parentId: processContext.owner.id,
            label: `wave-${anchor.wave} post-wave check`,
            role: "host-check",
          })
        : undefined,
      onProcessExit: processContext
        ? (pid: number) => processContext.manager.forgetProcess(pid)
        : undefined,
    };
    // Exactly one item landed, on the tree its merge checks ran: those receipts stand in for
    // the post-wave floor. The declared preflight still runs here, and the shared terms below
    // always run. The post-accept floor runs inside integrate and is never skipped (INV-10).
    // An abort already raised takes the run below, which returns it as aborted.
    const covering = !failure && plan.length > 0 && !ctx.signal?.aborted
      ? await coveringMerge(integrationWorktree, anchor, tip, integrated, plan)
      : undefined;
    let notRerun: string | undefined;
    if (covering?.checks) {
      notRerun = `the post-wave floor was not rerun: ${covering.item}'s merge checks covered it on the same tree`;
      const preflight = (await readEnvironmentConfig(integrationWorktree, environmentSetupRef))?.preflight;
      if (preflight) {
        const probe = await runEnvironmentPreflight({ worktree: integrationWorktree, ...processHooks }, preflight);
        failure = probe.status !== "passed";
        if (failure) {
          notRerun += `, and the declared preflight ${probe.status === "failed" ? "failed" : `stopped as ${probe.status}`}`;
        }
      }
      if (!failure) {
        runProgress()({
          kind: "checks-reused",
          wave: anchor.wave,
          item: covering.item,
          site: "post-wave",
          source: "merge-checks",
          tree: covering.checks.targetTree,
          checks: covering.checks.entries.length,
        });
      }
    } else if (!failure && plan.length > 0) {
      const convergence = await runStableTreeChecks({
        worktree: integrationWorktree,
        checks: plan,
        environmentSetupRef,
        site: "integration",
        ...processHooks,
      });
      const committedTree = await git(integrationWorktree, ["rev-parse", "HEAD^{tree}"]);
      failure = convergence.status !== "stable" || convergence.targetTree !== committedTree;
    }
    if (!failure) failure = !(await sharedTermsPass(integrationWorktree, anchor.binder));
    await this.#checkpoint("post-wave-checks-complete");
    if (!failure) {
      const successTag = `refs/tags/hatch/${anchor.binder}/wave-${anchor.wave}`;
      await git(integrationWorktree, [
        "update-ref",
        successTag,
        tip,
        await nullObjectId(integrationWorktree),
      ]);
      await this.#checkpoint("success-tag-updated");
      return {
        schema: "hatch-wave-finalization-v1",
        status: "passed",
        anchor,
        tip,
        successTag,
        ...(failedItems.length > 0 ? { failedItems } : {}),
        message: notRerun
          ? `Shared-term checks passed and ${notRerun}; success tag written.${failedItems.length > 0 ? ` Kept out of the wave, each with its failed ref: ${failedItems.join(", ")}.` : ""}`
          : failedItems.length > 0
            ? `Post-wave floor and shared-term checks passed on the merged items; success tag written. Kept out of the wave, each with its failed ref: ${failedItems.join(", ")}.`
            : "Post-wave floor and shared-term checks passed; success tag written.",
      };
    }

    await git(integrationWorktree, ["read-tree", "--reset", "-u", anchor.base]);
    await this.#checkpoint("rollback-worktree-prepared");
    const commands = [
      `update refs/heads/hatch/${anchor.binder}/integration ${anchor.base} ${tip}`,
    ];
    for (const integration of integrated) {
      if (!integration.mergeCommit) throw new Error("Hatch rollback lacks an integrated merge commit");
      commands.push(
        `delete refs/hatch/${anchor.binder}/item-${integration.item}/done ${integration.mergeCommit}`,
      );
      if (integration.accepted) {
        commands.push(
          `delete refs/hatch/${anchor.binder}/item-${integration.item}/accepted ${integration.itemTip}`,
          `create refs/hatch/${anchor.binder}/item-${integration.item}/failed ${integration.itemTip}`,
        );
      } else {
        commands.push(
          `delete refs/hatch/${anchor.binder}/item-${integration.item}/built ${integration.itemTip}`,
        );
      }
    }
    try {
      await updateRefsTransaction(integrationWorktree, commands);
    } catch (error) {
      await git(integrationWorktree, ["read-tree", "--reset", "-u", tip]);
      throw error;
    }
    await this.#checkpoint("rollback-refs-committed");
    const rollbackTag = `refs/tags/hatch/${anchor.binder}/wave-${anchor.wave}-rolled-back`;
    await git(integrationWorktree, [
      "update-ref",
      rollbackTag,
      anchor.base,
      await nullObjectId(integrationWorktree),
    ]);
    await this.#checkpoint("rollback-tag-updated");
    const branchTip = await git(integrationWorktree, ["rev-parse", "HEAD"]);
    const indexTree = await git(integrationWorktree, ["write-tree"]);
    const baseTree = await git(integrationWorktree, ["rev-parse", `${anchor.base}^{tree}`]);
    if (branchTip !== anchor.base || indexTree !== baseTree) {
      throw new Error("Hatch wave rollback did not restore the exact base state");
    }
    return {
      schema: "hatch-wave-finalization-v1",
      status: "rolled-back",
      anchor,
      tip: anchor.base,
      // The items whose merges failed, so a reader can tell a wave where nothing landed
      // from one whose landed merges were undone.
      ...(failedItems.length > 0 ? { failedItems } : {}),
      message: `Post-wave validation failed${notRerun ? ` (${notRerun})` : ""}; integration and item completion refs were rolled back exactly.`,
    };
  }
}
