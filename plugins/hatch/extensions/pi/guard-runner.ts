import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { PACKAGE_ROOT, requirePackagePath } from "./package-paths.ts";

export const HATCH_GUARD_PATHS = {
  binderImmutability: "hooks/scripts/guard_binder_immutability.py",
  packWrite: "hooks/scripts/guard_pack_write.py",
  deliveryStop: "hooks/scripts/guard_delivery_stop.py",
  subagentWhiff: "hooks/scripts/guard_subagent_whiff.py",
  statusInjection: "hooks/scripts/inject_hatch_status.py",
} as const;

export type HatchGuard = keyof typeof HATCH_GUARD_PATHS;

export interface GuardFailure {
  kind: "spawn" | "timeout" | "aborted" | "exit" | "error";
  detail: string;
}

export interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
  failedOpen: boolean;
  failure?: GuardFailure;
}

export interface GuardRunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

const MAX_FAILURE_DETAIL = 200;

function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.length > 0 ? lines[lines.length - 1].trim() : "";
}

/**
 * Turns a finished guard process into a result. A crash or a kill is a fail-open,
 * so it resolves code 0 like every other failure — but it names what happened.
 */
export function guardExitResult(
  code: number | null,
  signal: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
): GuardResult {
  if (code === 0 || code === 2) {
    return { code, stdout, stderr, failedOpen: false };
  }
  if (code === null) {
    return {
      code: 0,
      stdout,
      stderr,
      failedOpen: true,
      failure: { kind: "exit", detail: `ended by signal ${signal ?? "unknown"}` },
    };
  }
  const line = lastNonEmptyLine(stderr);
  const detail = `exited ${code}${line ? `: ${line}` : ""}`;
  return {
    code: 0,
    stdout,
    stderr,
    failedOpen: true,
    failure: { kind: "exit", detail: detail.slice(0, MAX_FAILURE_DETAIL) },
  };
}

function spawnFailureDetail(error: NodeJS.ErrnoException, cwd: string): string {
  // Node reports a missing working directory as `spawn uv ENOENT` too, so check cwd first.
  if (!existsSync(cwd)) return `working directory ${cwd} does not exist`;
  if (error.code === "ENOENT") return "uv was not found on PATH";
  return error.message;
}

export function guardInvocation(guard: HatchGuard): { command: "uv"; args: string[] } {
  return {
    command: "uv",
    args: ["run", "--script", requirePackagePath(HATCH_GUARD_PATHS[guard])],
  };
}

function appendBounded(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= MAX_OUTPUT_BYTES) return current;
  const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(current);
  return current + Buffer.from(chunk).subarray(0, remaining).toString("utf8");
}

export async function runHatchGuard(
  guard: HatchGuard,
  payload: unknown,
  options: GuardRunOptions,
): Promise<GuardResult> {
  const invocation = guardInvocation(guard);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let failedOpen = false;
    let failure: GuardFailure | undefined;
    const environment = { ...process.env };
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    environment.CLAUDE_PLUGIN_ROOT = PACKAGE_ROOT;
    environment.PYTHONNOUSERSITE = "1";
    environment.PYTHONSAFEPATH = "1";
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let forceKill: NodeJS.Timeout | undefined;
    const stopChild = (reason: GuardFailure) => {
      if (failedOpen) return;
      failedOpen = true;
      failure = reason;
      child.kill();
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const timeoutMs = options.timeout ?? 35_000;
    const timeout = setTimeout(
      () => stopChild({ kind: "timeout", detail: `timed out after ${timeoutMs / 1000} s` }),
      timeoutMs,
    );
    const abort = () => stopChild({ kind: "aborted", detail: "cancelled" });
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      if (failedOpen) {
        resolve({ code: 0, stdout, stderr, failedOpen: true, failure });
        return;
      }
      resolve(guardExitResult(code, signal, stdout, stderr));
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      stopChild({ kind: "spawn", detail: spawnFailureDetail(error, options.cwd) });
      finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal));
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}
