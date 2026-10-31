import { spawn } from "node:child_process";
import { PACKAGE_ROOT, requirePackagePath } from "./package-paths.ts";

export const HATCH_GUARD_PATHS = {
  binderImmutability: "hooks/scripts/guard_binder_immutability.py",
  packWrite: "hooks/scripts/guard_pack_write.py",
  deliveryStop: "hooks/scripts/guard_delivery_stop.py",
  subagentWhiff: "hooks/scripts/guard_subagent_whiff.py",
  statusInjection: "hooks/scripts/inject_hatch_status.py",
} as const;

export type HatchGuard = keyof typeof HATCH_GUARD_PATHS;

export interface GuardResult {
  code: number;
  stdout: string;
  stderr: string;
  failedOpen: boolean;
}

export interface GuardRunOptions {
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

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
    const stopChild = () => {
      failedOpen = true;
      child.kill();
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    const timeout = setTimeout(stopChild, options.timeout ?? 35_000);
    const abort = () => stopChild();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code: failedOpen ? 0 : code, stdout, stderr, failedOpen });
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.once("error", () => {
      failedOpen = true;
      finish(0);
    });
    child.once("close", (code) => finish(code ?? 0));
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(payload));
  });
}
