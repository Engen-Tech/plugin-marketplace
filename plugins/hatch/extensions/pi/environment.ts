import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_CONFIG_BYTES = 64 * 1024;

// A project may declare, in .hatch/environment.json, commands the host runs in each
// fresh check worktree before floor and oracle checks:
//   - `setup`: one provisioning command (install deps into a gitignored directory).
//     It exists because git worktrees do not share a gitignored dependency directory
//     (node_modules, .venv, target, ...): a build worker installs deps as a side
//     effect of self-checking, but the host's disposable proposed-integration and
//     post-wave worktrees get none.
//   - `preflight`: one cheap precondition probe (e.g. `docker info`) run BEFORE setup
//     and the floor. When it fails, the host halts cleanly instead of running the real
//     floor command into a wall of opaque tool errors (a DB-backed suite failing deep
//     inside pytest because the Docker daemon is unreachable). `on_unavailable` carries
//     the remediation text surfaced on that halt — the precondition the binder already
//     knows about, said once, up front, actionably.
// The declaration is stack-agnostic (the project names its own commands) and opt-in
// (absent means no setup and no preflight). It is read from a COMMITTED blob — the
// delivery's integration ref — never the mutable working tree: a build worker could
// poison a working-tree copy, but the integration ref carries only gate-approved,
// merged content, so the host never runs an unreviewed command.
//
// A project may additionally declare, under `visual_env`, how the host starts the
// project's app in a fresh check worktree so a browser can capture a rendered view.
// It is opt-in the same way: an absent `visual_env` is opt-out (no capture, the block
// stays), and every malformed shape fails closed with a field-named error rather than
// spawning a half-specified server. `parseVisualEnv` does that validation purely over
// an in-memory config object (the unit-test seam, no git), while the host reads the
// committed `.hatch/environment.json` blob from a pinned commit OID and feeds its
// bytes here — so the config matches the exact tree being captured, and a poisoned
// working-tree copy is never honored.
export interface VisualEnvConfig {
  command: string;
  portParam: string;
  startupTimeoutSeconds: number;
  cwd?: string;
  auth: "none";
}

export interface HatchEnvironmentConfig {
  setup?: string;
  preflight?: string;
  onUnavailable?: string;
  visualEnv?: VisualEnvConfig;
}

const ALLOWED_KEYS = new Set(["setup", "preflight", "on_unavailable", "visual_env"]);

const VISUAL_ENV_ALLOWED_KEYS = new Set([
  "command",
  "port_param",
  "startup_timeout_seconds",
  "cwd",
  "auth",
]);

// The port param names the environment variable the runtime injects an ephemeral
// loopback port into. It must be an uppercase env-var name that ends in PORT, and it
// must not name a reserved process or runtime variable, so injecting the port can
// never clobber the spawn environment (PATH, a loader path, ...).
const PORT_PARAM_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_PORT_PARAMS = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
]);

function requireCommand(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_096) {
    throw new Error(
      `Hatch .hatch/environment.json ${field} must be a non-empty string under 4096 chars`,
    );
  }
  return value;
}

function requirePortParam(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "Hatch .hatch/environment.json visual_env.port_param must be a non-empty string",
    );
  }
  if (!PORT_PARAM_PATTERN.test(value)) {
    throw new Error(
      "Hatch .hatch/environment.json visual_env.port_param must match ^[A-Z][A-Z0-9_]*$",
    );
  }
  if (RESERVED_PORT_PARAMS.has(value)) {
    throw new Error(
      `Hatch .hatch/environment.json visual_env.port_param must not name the reserved variable ${value}`,
    );
  }
  if (!value.endsWith("PORT")) {
    throw new Error(
      "Hatch .hatch/environment.json visual_env.port_param must end in PORT",
    );
  }
  return value;
}

function requireStartupTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 120) {
    throw new Error(
      "Hatch .hatch/environment.json visual_env.startup_timeout_seconds must be an integer from 1 to 120",
    );
  }
  return value;
}

function requireRelativeCwd(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      "Hatch .hatch/environment.json visual_env.cwd must be a non-empty string",
    );
  }
  // Platform-independent absolute-path rejection: a POSIX root, a Windows drive, or a
  // UNC prefix. macOS/Linux is the supported surface, but the parse must not depend on
  // which platform runs it — a committed config is captured once and read anywhere.
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(
      "Hatch .hatch/environment.json visual_env.cwd must be worktree-relative, not an absolute path",
    );
  }
  if (value.split(/[\\/]+/).includes("..")) {
    throw new Error(
      "Hatch .hatch/environment.json visual_env.cwd must not traverse outside the worktree with ..",
    );
  }
  return value;
}

function requireAuth(value: unknown): "none" {
  if (value !== "none") {
    throw new Error(
      'Hatch .hatch/environment.json visual_env.auth must be "none"',
    );
  }
  return value;
}

// Pure over an in-memory config object: no git, no filesystem. Given the parsed
// `.hatch/environment.json` object, validate its `visual_env` block and return the
// typed shape, or undefined when the block is absent (opt-out). Every malformed field
// throws a field-named error so the host fails closed instead of starting a
// half-specified server. `backend_ports` (and any other stray key) is rejected in v1.
export function parseVisualEnv(config: unknown): VisualEnvConfig | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  const value = (config as Record<string, unknown>).visual_env;
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hatch .hatch/environment.json visual_env must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !VISUAL_ENV_ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Hatch .hatch/environment.json visual_env has unknown keys: ${unknown.sort().join(", ")}`,
    );
  }
  const parsed: VisualEnvConfig = {
    command: requireCommand(record.command, "visual_env.command"),
    portParam: requirePortParam(record.port_param),
    startupTimeoutSeconds: requireStartupTimeout(record.startup_timeout_seconds),
    auth: record.auth === undefined ? "none" : requireAuth(record.auth),
  };
  if (record.cwd !== undefined) {
    parsed.cwd = requireRelativeCwd(record.cwd);
  }
  return parsed;
}

export async function readEnvironmentConfig(
  worktree: string,
  integrationRef: string,
): Promise<HatchEnvironmentConfig | undefined> {
  let raw: string;
  try {
    const { stdout } = await exec(
      "git",
      ["-C", worktree, "show", `${integrationRef}:.hatch/environment.json`],
      { encoding: "utf8", maxBuffer: MAX_CONFIG_BYTES },
    );
    raw = stdout;
  } catch (error) {
    // `git show` fails with a recognizable message when the ref or the path is absent
    // — that is the opt-out. Any other failure (repository corruption, permissions, a
    // blob overflowing maxBuffer) must fail closed rather than silently skip setup.
    const stderr = ((error as { stderr?: string }).stderr ?? "").trim();
    if (/does not exist|exists on disk, but not in|invalid object name|unknown revision/i.test(stderr)) {
      return undefined;
    }
    throw new Error(
      `Hatch could not read .hatch/environment.json from ${integrationRef}: ${
        stderr || (error as Error).message
      }`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Hatch .hatch/environment.json is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hatch .hatch/environment.json must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`Hatch .hatch/environment.json has unknown keys: ${unknown.sort().join(", ")}`);
  }
  const config: HatchEnvironmentConfig = {};
  if (record.setup !== undefined) config.setup = requireCommand(record.setup, "setup");
  if (record.preflight !== undefined) config.preflight = requireCommand(record.preflight, "preflight");
  if (record.on_unavailable !== undefined) {
    config.onUnavailable = requireCommand(record.on_unavailable, "on_unavailable");
  }
  const visualEnv = parseVisualEnv(record);
  if (visualEnv !== undefined) config.visualEnv = visualEnv;
  return config;
}

export async function readEnvironmentSetup(
  worktree: string,
  integrationRef: string,
): Promise<string | undefined> {
  return (await readEnvironmentConfig(worktree, integrationRef))?.setup;
}
