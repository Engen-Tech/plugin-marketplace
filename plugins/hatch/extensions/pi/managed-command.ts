import { spawn } from "node:child_process";

const MAX_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT = 10 * 60 * 1_000;

export interface ManagedCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  status: "passed" | "failed" | "aborted" | "timed-out";
}

export async function runManagedCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
  onProcessStart?: (pid: number) => void;
  onProcessExit?: (pid: number) => Promise<void> | void;
}): Promise<ManagedCommandResult> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("Hatch command timeout is invalid");
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let stopped: "aborted" | "timed-out" | undefined;
    let settled = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (overflow) return;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > MAX_OUTPUT) {
        overflow = true;
        stop("aborted");
        return;
      }
      if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    const killTree = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    let force: NodeJS.Timeout | undefined;
    const stop = (reason: "aborted" | "timed-out"): void => {
      if (stopped) return;
      stopped = reason;
      killTree("SIGTERM");
      force = setTimeout(() => killTree("SIGKILL"), 1_000);
      force.unref?.();
    };
    const timer = setTimeout(() => stop("timed-out"), timeout);
    timer.unref?.();
    const abort = () => stop("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (force) clearTimeout(force);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      void (async () => {
        clearTimeout(timer);
        if (force) clearTimeout(force);
        options.signal?.removeEventListener("abort", abort);
        if (child.pid) await options.onProcessExit?.(child.pid);
        if (overflow) throw new Error("Hatch managed command output exceeded its bound");
        resolve({
          code,
          stdout,
          stderr,
          status: stopped ?? (code === 0 ? "passed" : "failed"),
        });
      })().catch(reject);
    });
    if (child.pid) {
      try {
        options.onProcessStart?.(child.pid);
      } catch (error) {
        killTree("SIGKILL");
        reject(error);
      }
    }
  });
}
