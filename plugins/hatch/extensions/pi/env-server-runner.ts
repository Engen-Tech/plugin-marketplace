import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { join } from "node:path";
import type { VisualEnvConfig } from "./environment.ts";
import type { BinderLifecycleOwner, HatchProcessManager } from "./process-manager.ts";

// A package-owned, per-item managed dev-server lifecycle.
//
// Given a committed `visual_env` declaration and the item-under-test's target route,
// this reserves an ephemeral loopback port, spawns the declared command detached in its
// own process group inside the item's candidate worktree, watches the child for an early
// exit while health-polling the real route, and always tears the process group down and
// frees the port on every exit path. It never returns a handle it cannot prove it owns,
// and it never kills a process this run did not start: teardown only ever signals the
// group of the pid it spawned, so a foreign holder of the port survives.
//
// It holds no durable state: the child is a transient of the run and resume stays
// git-derived.

// The registered teardown grace for a dev server. Passed explicitly at the
// registerProcess call site rather than churning the process manager's shared default,
// which every short-lived managed command relies on.
export const ENV_SERVER_GRACE_MS = 5_000;

const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_MAX_REDIRECT_HOPS = 5;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const OUTPUT_TAIL_LIMIT = 16 * 1024;
const CLOSE_DRAIN_MS = 500;
const LOOPBACK_HOST = "127.0.0.1";

// A 3xx whose Location resolves to one of these path prefixes is an auth wall, not a
// healthy route. Matched case-insensitively against the resolved pathname.
const AUTH_PATH_PATTERN = /^\/(login|signin|auth)(\/|$)/i;

export interface EnvServerHandle {
  /** The assigned URL: the loopback base plus the normalized target route. */
  readonly url: string;
  readonly port: number;
  readonly pid: number;
  /** Non-vetoable teardown of the owned process group. Idempotent. */
  stop(): Promise<void>;
}

export interface EnvServerHealthy {
  status: "healthy";
  handle: EnvServerHandle;
  url: string;
  port: number;
  pid: number;
}

export interface EnvServerStartupCrash {
  status: "startup-crash";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** The captured tail across both streams, the debugging entry point. */
  tail: string;
  remediation: string;
}

export interface EnvServerAuthRequired {
  status: "auth-required";
  location: string;
  url: string;
  remediation: string;
}

export interface EnvServerTimeout {
  status: "timeout";
  url: string;
  elapsedMs: number;
  remediation: string;
}

export interface EnvServerAborted {
  status: "aborted";
  remediation: string;
}

export type EnvServerOutcome =
  | EnvServerHealthy
  | EnvServerStartupCrash
  | EnvServerAuthRequired
  | EnvServerTimeout
  | EnvServerAborted;

export interface EnvServerContext {
  manager: HatchProcessManager;
  owner: BinderLifecycleOwner;
}

export interface StartEnvServerOptions {
  /** The committed, already-validated `visual_env` block. */
  config: VisualEnvConfig;
  /** The item's candidate worktree; the command's cwd resolves under it. */
  worktree: string;
  /** The target route to health-poll (the item-under-test's design_reference). */
  route: string;
  /** The item's process-lifecycle owner and its manager. */
  context: EnvServerContext;
  /** Aborts startup non-vetoably on every exit path, including mid health-poll. */
  signal?: AbortSignal;
  /**
   * The port-reservation seam. Defaults to reserving a real ephemeral loopback port.
   * Injectable so a test can exercise the reserve-to-spawn window (returning a port a
   * fixture already holds surfaces as the child's bind failure, not a separate outcome).
   */
  reservePort?: () => Promise<number>;
  /** The teardown grace handed to the process manager. Defaults to ENV_SERVER_GRACE_MS. */
  graceMs?: number;
  pollIntervalMs?: number;
  maxRedirectHops?: number;
  requestTimeoutMs?: number;
}

class RingBuffer {
  #chunks: Buffer[] = [];
  #size = 0;
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit && this.#chunks.length > 0) {
      const first = this.#chunks[0]!;
      if (this.#size - first.length >= this.#limit) {
        this.#chunks.shift();
        this.#size -= first.length;
      } else {
        const excess = this.#size - this.#limit;
        this.#chunks[0] = first.subarray(excess);
        this.#size -= excess;
        break;
      }
    }
  }

  toString(): string {
    return Buffer.concat(this.#chunks).toString("utf8");
  }
}

// Reserve an ephemeral loopback port by binding :0, reading the assigned number, and
// closing the socket. The number is injected into the child through port_param; the
// reserve-to-spawn window is inherent and testable through the injectable seam.
function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, LOOPBACK_HOST, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("Hatch could not reserve an ephemeral loopback port")));
      }
    });
  });
}

// URL-normalize the target route against the loopback base rather than string-
// concatenating, and force the loopback host/port so a route that claims another host
// can never move the poll off-loopback.
function resolveTargetUrl(port: number, route: string): string {
  const base = new URL(`http://${LOOPBACK_HOST}:${port}`);
  let ref: URL;
  try {
    ref = new URL(route, base);
  } catch {
    ref = base;
  }
  base.pathname = ref.pathname;
  base.search = ref.search;
  base.hash = "";
  return base.toString();
}

function isAuthLocation(location: string, base: string): boolean {
  if (!location) return false;
  let path: string;
  try {
    path = new URL(location, base).pathname;
  } catch {
    path = location;
  }
  return AUTH_PATH_PATTERN.test(path);
}

interface ProbeResponse {
  status: number;
  location?: string;
}

function httpGet(target: string, signal: AbortSignal, timeoutMs: number): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(target, { method: "GET", signal }, (res) => {
      const status = res.statusCode ?? 0;
      const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
      res.resume();
      resolve({ status, location });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("Hatch env-server probe timed out"));
    });
    req.once("error", (error) => reject(error));
    req.end();
  });
}

type ProbeOutcome =
  | { kind: "healthy" }
  | { kind: "auth"; location: string }
  | { kind: "not-ready" }
  | { kind: "unreachable" };

// One health probe, following non-auth redirects up to a bounded hop count and never
// leaving the loopback host. A 2xx is healthy, a 3xx to /login|/signin|/auth is an auth
// wall, everything else is "keep polling".
async function probeTarget(
  url: string,
  signal: AbortSignal,
  maxHops: number,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  let current = url;
  for (let hop = 0; hop <= maxHops; hop += 1) {
    let res: ProbeResponse;
    try {
      res = await httpGet(current, signal, timeoutMs);
    } catch {
      return { kind: "unreachable" };
    }
    if (res.status >= 200 && res.status < 300) return { kind: "healthy" };
    if (res.status >= 300 && res.status < 400) {
      const location = res.location ?? "";
      if (isAuthLocation(location, current)) return { kind: "auth", location };
      if (!location) return { kind: "not-ready" };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { kind: "not-ready" };
      }
      if (next.hostname !== LOOPBACK_HOST) return { kind: "not-ready" };
      current = next.toString();
      continue;
    }
    return { kind: "not-ready" };
  }
  return { kind: "not-ready" };
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const ABORT_REMEDIATION =
  "Hatch aborted the dev server before it became healthy; nothing was left running.";

function crashOutcome(
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined,
  stderr: string,
  stdout: string,
  config: VisualEnvConfig,
  targetUrl: string,
): EnvServerStartupCrash {
  const tail = `${stderr}${stdout}`.slice(-OUTPUT_TAIL_LIMIT) || stderr || stdout;
  return {
    status: "startup-crash",
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    stdout,
    stderr,
    tail,
    remediation:
      `The dev server '${config.command}' exited during startup before answering ${targetUrl}. ` +
      `Inspect the captured output tail; an EADDRINUSE tail means the port injected through ` +
      `${config.portParam} was already bound when the child tried to listen.`,
  };
}

// Linux only: Node delivers a child's exit event some time after the kernel ends it, so
// read the kernel's view. It is trusted only when /proc shows this process's own pid
// namespace and the task's parent is this process. Z counts only with one thread left,
// because a leader whose main thread alone exited shows Z while other threads serve.
// Any read error, or any other platform, reports not-exited and leaves the exit flag.
function childExitedInKernel(pid: number): boolean {
  if (process.platform !== "linux") return false;
  try {
    if (readFileSync("/proc/self/stat", "utf8").split(" ", 1)[0] !== String(process.pid)) return false;
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // proc(5) fields 3 (state), 4 (ppid) and 20 (num_threads), counted after the comm.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const exited = fields[0] === "Z" || fields[0] === "X";
    return exited && fields[1] === String(process.pid) && fields[17] === "1";
  } catch {
    return false;
  }
}

function settleClose(closed: Promise<void>): Promise<void> {
  return Promise.race([
    closed,
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_DRAIN_MS);
      timer.unref?.();
    }),
  ]);
}

// Start the declared dev server and resolve once its fate is known: a healthy owned
// handle, or a typed failure (startup-crash / auth-required / timeout / aborted) after
// tearing down whatever was started. On every non-healthy outcome the process group is
// reaped and the port is freed before this resolves.
export async function startEnvServer(options: StartEnvServerOptions): Promise<EnvServerOutcome> {
  const {
    config,
    worktree,
    route,
    context,
    signal,
    reservePort = reserveEphemeralPort,
    graceMs = ENV_SERVER_GRACE_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    maxRedirectHops = DEFAULT_MAX_REDIRECT_HOPS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;

  if (signal?.aborted) {
    return { status: "aborted", remediation: ABORT_REMEDIATION };
  }

  const port = await reservePort();
  const targetUrl = resolveTargetUrl(port, route);
  const cwd = config.cwd ? join(worktree, config.cwd) : worktree;

  const child = spawn(config.command, [], {
    cwd,
    detached: process.platform !== "win32",
    shell: true,
    env: { ...process.env, [config.portParam]: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const stdout = new RingBuffer(OUTPUT_TAIL_LIMIT);
  const stderr = new RingBuffer(OUTPUT_TAIL_LIMIT);
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: Error | undefined;
  // The life controller aborts the instant the child exits or the caller aborts, so an
  // in-flight probe or a poll delay wakes immediately rather than burning the timeout.
  const life = new AbortController();
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.once("exit", (code, exitSignal) => {
    exit = { code, signal: exitSignal };
    life.abort();
  });
  child.once("error", (error) => {
    spawnError = error;
    exit ??= { code: null, signal: null };
    life.abort();
  });
  const onExternalAbort = (): void => life.abort();
  const detachAbort = (): void => signal?.removeEventListener("abort", onExternalAbort);
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  const pid = child.pid;
  if (!pid) {
    detachAbort();
    await settleClose(closed);
    return crashOutcome(exit, stderr.toString(), stdout.toString(), config, targetUrl);
  }

  try {
    context.manager.registerProcess(pid, {
      cwd,
      parentId: context.owner.id,
      label: `env-server ${config.command}`,
      role: "env-server",
      graceMs,
    });
  } catch (error) {
    // Registration failed after the child is already alive: kill it directly so the
    // spawn never leaks, then surface the registration fault.
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
    detachAbort();
    throw error;
  }

  let stopped = false;
  const teardown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    detachAbort();
    await context.manager.stopProcess(pid);
  };

  const crash = async (): Promise<EnvServerStartupCrash> => {
    await settleClose(closed);
    await teardown();
    return crashOutcome(exit, stderr.toString(), stdout.toString(), config, targetUrl);
  };

  const startedAt = Date.now();
  const deadline = startedAt + config.startupTimeoutSeconds * 1_000;

  try {
    while (true) {
      // A dead child cannot own the port: its exit aborts polling here, before any
      // response from a squatter answering the same port could be read as healthy.
      if (exit || spawnError) return await crash();
      if (signal?.aborted) {
        await teardown();
        return { status: "aborted", remediation: ABORT_REMEDIATION };
      }
      if (Date.now() >= deadline) {
        await teardown();
        return {
          status: "timeout",
          url: targetUrl,
          elapsedMs: Date.now() - startedAt,
          remediation:
            `The dev server '${config.command}' did not answer ${targetUrl} within ` +
            `${config.startupTimeoutSeconds}s. Increase visual_env.startup_timeout_seconds or ` +
            `confirm the command serves that route.`,
        };
      }

      const probe = await probeTarget(targetUrl, life.signal, maxRedirectHops, requestTimeoutMs);

      if (probe.kind === "healthy") {
        // Re-check liveness: a 2xx is accepted only while the spawned child is alive. On
        // Linux this also asks the kernel, since the exit event can lag the child's death.
        if (exit || spawnError || childExitedInKernel(pid)) return await crash();
        detachAbort();
        const handle: EnvServerHandle = {
          url: targetUrl,
          port,
          pid,
          stop: () => teardown(),
        };
        return { status: "healthy", handle, url: targetUrl, port, pid };
      }
      if (probe.kind === "auth") {
        await teardown();
        return {
          status: "auth-required",
          location: probe.location,
          url: targetUrl,
          remediation:
            `The target route ${targetUrl} redirected to an auth wall (${probe.location}). ` +
            `visual_env.auth is 'none'; capture an unauthenticated route or the block stays.`,
        };
      }

      await abortableDelay(pollIntervalMs, life.signal);
    }
  } catch (error) {
    await teardown();
    throw error;
  }
}

export class EnvServerStartupError extends Error {
  readonly outcome: Exclude<EnvServerOutcome, EnvServerHealthy>;

  constructor(outcome: Exclude<EnvServerOutcome, EnvServerHealthy>) {
    super(
      outcome.status === "startup-crash"
        ? `${outcome.remediation}${outcome.tail ? `\n${outcome.tail}` : ""}`
        : outcome.remediation,
    );
    this.name = "EnvServerStartupError";
    this.outcome = outcome;
  }
}

// The scoped-resource form: bring the dev server up, run `use` against an owned handle,
// and tear the process group down afterward no matter how `use` settles. A non-healthy
// startup throws EnvServerStartupError carrying the typed outcome and its remediation.
export async function withEnvServer<T>(
  options: StartEnvServerOptions,
  use: (handle: EnvServerHandle) => Promise<T>,
): Promise<T> {
  const outcome = await startEnvServer(options);
  if (outcome.status !== "healthy") {
    throw new EnvServerStartupError(outcome);
  }
  try {
    return await use(outcome.handle);
  } finally {
    await outcome.handle.stop();
  }
}
