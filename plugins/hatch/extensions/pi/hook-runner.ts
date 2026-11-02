import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_HOOK_OUTPUT = 2 * 1024 * 1024;

export interface HookValidationResult {
  status: "passed" | "failed" | "drifted";
  candidateTree: string;
  // The exit code of the `git commit` that ran the hooks, when it failed.
  exitCode?: number;
  hookTree?: string;
  message?: string;
  stdout: string;
  stderr: string;
}

interface HookProcessOptions {
  onProcessStart?: (pid: number) => void;
  onProcessExit?: (pid: number) => Promise<void> | void;
}

async function git(
  cwd: string,
  args: string[],
  options: {
    signal?: AbortSignal;
    allowFailure?: boolean;
    onProcessStart?: HookProcessOptions["onProcessStart"];
    onProcessExit?: HookProcessOptions["onProcessExit"];
  } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (options.onProcessStart || options.onProcessExit) {
    return new Promise((resolve, reject) => {
      const child = spawn("git", ["-C", cwd, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
        detached: process.platform !== "win32",
      });
      let stdout = "";
      let stderr = "";
      let overflow = false;
      let settled = false;
      const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
        if (overflow) return;
        if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > MAX_HOOK_OUTPUT) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        if (target === "stdout") stdout += chunk.toString();
        else stderr += chunk.toString();
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        void (async () => {
          if (child.pid) await options.onProcessExit?.(child.pid);
          if (overflow) throw new Error("Hatch hook output exceeded its bound");
          const exitCode = code ?? 1;
          if (exitCode === 0 || options.allowFailure) {
            resolve({ stdout, stderr, code: exitCode });
            return;
          }
          reject(new Error(stderr.trim() || `git ${args[0] ?? "command"} failed during hook validation`));
        })().catch(reject);
      });
      if (child.pid) {
        try {
          options.onProcessStart?.(child.pid);
        } catch (error) {
          child.kill("SIGKILL");
          reject(error);
        }
      }
    });
  }
  try {
    const { stdout, stderr } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_HOOK_OUTPUT,
      signal: options.signal,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const value = error as { stdout?: string; stderr?: string; code?: number | string };
    if (options.allowFailure && typeof value.code === "number") {
      return { stdout: value.stdout ?? "", stderr: value.stderr ?? "", code: value.code };
    }
    const stderr = value.stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during hook validation`);
  }
}

export async function validateMergeHooks(options: {
  worktree: string;
  integrationTip: string;
  itemTip: string;
  candidateTree: string;
  message: string;
  signal?: AbortSignal;
  onProcessStart?: HookProcessOptions["onProcessStart"];
  onProcessExit?: HookProcessOptions["onProcessExit"];
}): Promise<HookValidationResult> {
  for (const object of [options.integrationTip, options.itemTip, options.candidateTree]) {
    if (!/^[a-f0-9]{40,64}$/.test(object)) {
      throw new Error("Hatch merge-hook validation requires valid object ids");
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hatch-merge-hook-validation-"));
  const disposable = join(root, "worktree");
  let registered = false;
  try {
    await git(options.worktree, [
      "worktree",
      "add",
      "--detach",
      disposable,
      options.integrationTip,
    ]);
    registered = true;
    const merged = await git(
      disposable,
      ["merge", "--no-ff", "--no-commit", options.itemTip],
      {
        signal: options.signal,
        allowFailure: true,
        onProcessStart: options.onProcessStart,
        onProcessExit: options.onProcessExit,
      },
    );
    if (merged.code !== 0) {
      return {
        status: "failed",
        candidateTree: options.candidateTree,
        stdout: merged.stdout,
        stderr: merged.stderr,
      };
    }
    const stagedTree = (await git(disposable, ["write-tree"])).stdout.trim();
    if (stagedTree !== options.candidateTree) {
      return {
        status: "drifted",
        candidateTree: options.candidateTree,
        hookTree: stagedTree,
        stdout: merged.stdout,
        stderr: merged.stderr,
      };
    }
    const committed = await git(
      disposable,
      ["commit", "--no-gpg-sign", "-m", options.message],
      {
        signal: options.signal,
        allowFailure: true,
        onProcessStart: options.onProcessStart,
        onProcessExit: options.onProcessExit,
      },
    );
    if (committed.code !== 0) {
      return {
        status: "failed",
        candidateTree: options.candidateTree,
        stdout: `${merged.stdout}${committed.stdout}`,
        stderr: `${merged.stderr}${committed.stderr}`,
      };
    }
    const hookTree = (await git(disposable, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const parents = (await git(disposable, ["rev-list", "--parents", "-n", "1", "HEAD"]))
      .stdout.trim().split(/\s+/).slice(1);
    const message = (await git(disposable, ["log", "-1", "--format=%B"])).stdout.trimEnd();
    const dirty = (await git(disposable, ["status", "--porcelain=v1", "-z"])).stdout;
    if (
      hookTree !== options.candidateTree ||
      parents.length !== 2 ||
      parents[0] !== options.integrationTip ||
      parents[1] !== options.itemTip ||
      dirty.length > 0
    ) {
      return {
        status: "drifted",
        candidateTree: options.candidateTree,
        hookTree,
        message,
        stdout: `${merged.stdout}${committed.stdout}`,
        stderr: `${merged.stderr}${committed.stderr}`,
      };
    }
    return {
      status: "passed",
      candidateTree: options.candidateTree,
      hookTree,
      message,
      stdout: `${merged.stdout}${committed.stdout}`,
      stderr: `${merged.stderr}${committed.stderr}`,
    };
  } finally {
    if (registered) {
      await git(options.worktree, ["worktree", "remove", "--force", disposable], {
        allowFailure: true,
      }).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}

export async function validateCandidateHooks(options: {
  worktree: string;
  candidateTree: string;
  parent: string;
  message: string;
  allowEmpty?: boolean;
  signal?: AbortSignal;
  onProcessStart?: HookProcessOptions["onProcessStart"];
  onProcessExit?: HookProcessOptions["onProcessExit"];
}): Promise<HookValidationResult> {
  if (!/^[a-f0-9]{40,64}$/.test(options.candidateTree) || !/^[a-f0-9]{40,64}$/.test(options.parent)) {
    throw new Error("Hatch hook validation requires valid candidate and parent object ids");
  }
  const root = await mkdtemp(join(tmpdir(), "hatch-hook-validation-"));
  const disposable = join(root, "worktree");
  let registered = false;
  try {
    await git(options.worktree, [
      "worktree",
      "add",
      "--detach",
      "--no-checkout",
      disposable,
      options.parent,
    ]);
    registered = true;
    await git(disposable, ["read-tree", "--reset", "-u", options.candidateTree]);
    const committed = await git(
      disposable,
      ["commit", "--no-gpg-sign", ...(options.allowEmpty ? ["--allow-empty"] : []), "-m", options.message],
      {
        signal: options.signal,
        allowFailure: true,
        onProcessStart: options.onProcessStart,
        onProcessExit: options.onProcessExit,
      },
    );
    if (committed.code !== 0) {
      return {
        status: "failed",
        candidateTree: options.candidateTree,
        exitCode: committed.code,
        stdout: committed.stdout,
        stderr: committed.stderr,
      };
    }
    const hookTree = (await git(disposable, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
    const message = (await git(disposable, ["log", "-1", "--format=%B"])).stdout.trimEnd();
    const dirty = (await git(disposable, ["status", "--porcelain=v1", "-z"])).stdout;
    if (hookTree !== options.candidateTree || dirty.length > 0) {
      return {
        status: "drifted",
        candidateTree: options.candidateTree,
        hookTree,
        message,
        stdout: committed.stdout,
        stderr: committed.stderr,
      };
    }
    return {
      status: "passed",
      candidateTree: options.candidateTree,
      hookTree,
      message,
      stdout: committed.stdout,
      stderr: committed.stderr,
    };
  } finally {
    if (registered) {
      await git(options.worktree, ["worktree", "remove", "--force", disposable], {
        allowFailure: true,
      }).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
}
