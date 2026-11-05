import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  hashCheckCommand,
  type HatchCheckManifest,
  type HatchCheckManifestEntry,
  type HatchCheckReceipt,
} from "./evidence.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT = 10 * 60 * 1000;

export const CHECK_ENVIRONMENT_HASH = createHash("sha256")
  .update(
    JSON.stringify({
      inherit: "host",
      remove: [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      ],
      ci: "default-1",
    }),
  )
  .digest("hex");

export interface UnboundCheckResult {
  commandHash: string;
  cwd: string;
  status: "passed" | "failed" | "timed-out" | "aborted";
  code: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface RunCheckOptions {
  worktree: string;
  command: string;
  cwd?: string;
  signal?: AbortSignal;
  timeout?: number;
  onProcessStart?: (pid: number) => void;
  onProcessExit?: (pid: number) => Promise<void> | void;
}

interface BoundedOutput {
  text: string;
  truncated: boolean;
}

function appendBounded(output: BoundedOutput, chunk: Buffer | string): void {
  const currentBytes = Buffer.byteLength(output.text);
  const bytes = Buffer.from(chunk);
  if (currentBytes >= MAX_OUTPUT_BYTES) {
    output.truncated = true;
    return;
  }
  const remaining = MAX_OUTPUT_BYTES - currentBytes;
  output.text += bytes.subarray(0, remaining).toString("utf8");
  if (bytes.byteLength > remaining) output.truncated = true;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateRelativeCwd(cwd: string): void {
  const normalized = cwd.replaceAll("\\", "/");
  if (!normalized || isAbsolute(cwd) || normalized.split("/").some((part) => part === "..")) {
    throw new Error(`Hatch check cwd must stay inside the worktree: ${cwd}`);
  }
}

async function stopProcessTree(pid: number | undefined, force = false): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveStop) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolveStop());
      killer.once("close", () => resolveStop());
    });
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function cwdFailure(command: string, cwd: string, problem: string): UnboundCheckResult {
  return {
    commandHash: hashCheckCommand(command),
    cwd,
    status: "failed",
    code: null,
    stdout: "",
    stderr: `Hatch did not run the command: ${problem}.`,
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 0,
  };
}

export async function runBoundCheck(options: RunCheckOptions): Promise<UnboundCheckResult> {
  if (!options.command.trim() || options.command.length > 16 * 1024) {
    throw new Error("Hatch check command is empty or too long");
  }
  const commandCwd = options.cwd ?? ".";
  validateRelativeCwd(commandCwd);
  const worktree = await realpath(options.worktree);
  // A cwd missing from the worktree, or one that is not a directory, is a failed check
  // with no exit code, not a host error: the command could not run where it was told to.
  // A worker that proposed it gets it back; a binder oracle with it halts cleanly. A cwd
  // that resolves outside the worktree stays a hard error below.
  let cwd: string;
  try {
    cwd = await realpath(resolve(worktree, commandCwd));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    return cwdFailure(options.command, commandCwd, `cwd '${commandCwd}' does not exist in the worktree`);
  }
  if (!isInside(worktree, cwd)) throw new Error(`Hatch check cwd escapes the worktree: ${commandCwd}`);
  if (!(await stat(cwd)).isDirectory()) {
    return cwdFailure(options.command, commandCwd, `cwd '${commandCwd}' is not a directory in the worktree`);
  }
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("Hatch check timeout must be a positive integer");
  }
  const startedAt = Date.now();
  const stdout: BoundedOutput = { text: "", truncated: false };
  const stderr: BoundedOutput = { text: "", truncated: false };
  const shell = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", options.command]
    : ["-lc", options.command];
  return new Promise((resolveRun, rejectRun) => {
    let stopped: "timed-out" | "aborted" | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const environment = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
      delete environment[key];
    }
    environment.CI = environment.CI ?? "1";
    const child = spawn(shell, args, {
      cwd,
      env: environment,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stop = (reason: "timed-out" | "aborted") => {
      if (stopped) return;
      stopped = reason;
      void stopProcessTree(child.pid).catch(() => undefined);
      forceKill = setTimeout(() => void stopProcessTree(child.pid, true).catch(() => undefined), 1_000);
      forceKill.unref?.();
    };
    const timer = setTimeout(() => stop("timed-out"), timeout);
    timer.unref?.();
    const abort = () => stop("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    if (child.pid) options.onProcessStart?.(child.pid);
    child.stdout.on("data", (chunk) => appendBounded(stdout, chunk));
    child.stderr.on("data", (chunk) => appendBounded(stderr, chunk));
    child.once("error", (error) => {
      void (async () => {
        clearTimeout(timer);
        if (forceKill) clearTimeout(forceKill);
        options.signal?.removeEventListener("abort", abort);
        if (child.pid) await options.onProcessExit?.(child.pid);
        rejectRun(error);
      })().catch(rejectRun);
    });
    child.once("close", (code) => {
      void (async () => {
        clearTimeout(timer);
        if (forceKill) clearTimeout(forceKill);
        options.signal?.removeEventListener("abort", abort);
        if (stopped) await stopProcessTree(child.pid, true);
        if (child.pid) await options.onProcessExit?.(child.pid);
        resolveRun({
          commandHash: hashCheckCommand(options.command),
          cwd: commandCwd,
          status: stopped ?? (code === 0 ? "passed" : "failed"),
          code,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          durationMs: Date.now() - startedAt,
        });
      })().catch(rejectRun);
    });
  });
}

export function bindCheckReceipt(
  result: UnboundCheckResult,
  targetTree: string,
): HatchCheckReceipt {
  if (result.status === "timed-out" || result.status === "aborted" || result.code === null) {
    throw new Error(`Hatch cannot bind an incomplete ${result.status} check to a candidate tree`);
  }
  if (!/^[a-f0-9]{40,64}$/.test(targetTree)) {
    throw new Error("Hatch check receipt target tree is invalid");
  }
  return {
    schema: "hatch-check-receipt-v1",
    targetTree,
    commandHash: result.commandHash,
    cwd: result.cwd,
    status: result.status,
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
  };
}

export function bindCheckManifestEntry(
  result: UnboundCheckResult,
  options: {
    id: string;
    sequence: number;
    purpose: "floor" | "oracle";
    targetTree: string;
    preTree?: string;
    postTree?: string;
  },
): HatchCheckManifestEntry {
  return {
    id: options.id,
    sequence: options.sequence,
    purpose: options.purpose,
    required: true,
    preTree: options.preTree ?? options.targetTree,
    postTree: options.postTree ?? options.targetTree,
    environmentHash: CHECK_ENVIRONMENT_HASH,
    receipt: bindCheckReceipt(result, options.targetTree),
  };
}

export function createCheckManifest(
  targetTree: string,
  entries: HatchCheckManifestEntry[],
): HatchCheckManifest {
  return {
    schema: "hatch-check-manifest-v1",
    targetTree,
    entries,
  };
}
