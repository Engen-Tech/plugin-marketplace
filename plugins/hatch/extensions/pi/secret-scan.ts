// The host's two refusals of a candidate or a proposed merge: a credential the secret
// scan finds, and a change to protected orchestration state (.git or .hatch). Neither is
// a child failure; the model wrote the bytes, but the host decides they cannot land.
//
// A refusal halts the one item that carries it. A scan that could not run is not a
// refusal: runSecretScan throws, and the run ends, because no scan means no proof that
// nothing secret is staged. Only an exit-0 "SECRET SCAN: CLEAN" is clean, and only a
// well-formed "SECRET SCAN: BLOCKED" report is a match; any other output throws, so a
// reworded report fails closed for the run instead of reading as clean.
//
// A refusal carries the pattern name, path and line of each match, never the matched
// text: scan_secrets.py prints no value, and nothing here reads one.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requirePackagePath } from "./package-paths.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 4 * 1024 * 1024;

export interface SecretMatch {
  pattern: string;
  path: string;
  line: number;
}

export type SecretScanResult = { status: "clean" } | { status: "match"; matches: SecretMatch[] };

export type HostRefusal =
  | { kind: "secret-match"; matches: SecretMatch[]; message: string }
  | { kind: "protected-path"; paths: string[]; message: string };

const CLEAN = "SECRET SCAN: CLEAN";
const BLOCKED = "SECRET SCAN: BLOCKED";
const BLOCKED_ADVICE = "Remove or rotate the secret, or add a reviewed allow-list entry, before retry.";
// "  - <path>:<line>: <pattern>"; the path may itself hold a colon, so it is matched greedily.
const FINDING = /^ {2}- (.+):(\d+): ([a-z0-9-]+)$/;

function unreadable(exitCode: number | string, stdout: string): Error {
  const text = stdout.trim();
  return new Error(
    text
      ? `Hatch secret scan output could not be read (exit ${exitCode}): ${text}`
      : `Hatch secret scan failed (exit ${exitCode}) with no report`,
  );
}

/** Reads scan_secrets.py's stdout and exit code. Throws on anything but the two known reports. */
export function readSecretScanOutput(exitCode: number | string, stdout: string): SecretScanResult {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (exitCode === 0) {
    if (lines.length === 1 && lines[0] === CLEAN) return { status: "clean" };
    throw unreadable(exitCode, stdout);
  }
  if (exitCode !== 1 || lines[0] !== BLOCKED || lines.at(-1) !== BLOCKED_ADVICE) {
    throw unreadable(exitCode, stdout);
  }
  const findings = lines.slice(1, -1);
  if (findings.length === 0) throw unreadable(exitCode, stdout);
  return {
    status: "match",
    matches: findings.map((line) => {
      const parsed = FINDING.exec(line);
      if (!parsed) throw unreadable(exitCode, stdout);
      return { pattern: parsed[3]!, path: parsed[1]!, line: Number(parsed[2]) };
    }),
  };
}

/** Runs scan_secrets.py over the staged diff, or over a committed range when one is given. */
export async function runSecretScan(
  cwd: string,
  committedRange?: { base: string; target: string },
): Promise<SecretScanResult> {
  const args = ["run", "--script", requirePackagePath("skills/hatch-build/scripts/scan_secrets.py")];
  if (committedRange) args.push("--base", committedRange.base, "--target", committedRange.target);
  try {
    const { stdout } = await exec("uv", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT });
    return readSecretScanOutput(0, stdout);
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string };
    if (failed.code === undefined) throw error;
    try {
      return readSecretScanOutput(failed.code, failed.stdout ?? "");
    } catch (unread) {
      const stderr = failed.stderr?.trim();
      throw stderr ? new Error(`${(unread as Error).message}\n${stderr}`) : unread;
    }
  }
}

// A delivery halt reason is cut at 1,500 characters (delivery-runner.ts HALT_REASON_LIMIT),
// so a refusal names its matches or paths within this budget and counts the rest: the
// advice after the list always survives the cut. The refusal's own fields keep them all.
const REFUSAL_LIST_BUDGET = 600;

function listed(entries: readonly string[]): string {
  const shown: string[] = [];
  let used = 0;
  for (const entry of entries) {
    const cost = entry.length + (shown.length > 0 ? 2 : 0);
    if (used + cost > REFUSAL_LIST_BUDGET) break;
    shown.push(entry);
    used += cost;
  }
  if (shown.length === 0 && entries.length > 0) shown.push(`${entries[0].slice(0, REFUSAL_LIST_BUDGET - 1)}…`);
  const rest = entries.length - shown.length;
  return `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/** The paths, of those given, that are protected orchestration state. */
export function protectedPathsOf(paths: readonly string[]): string[] {
  return paths.filter(
    (path) => path === ".git" || path.startsWith(".git/") || path === ".hatch" || path.startsWith(".hatch/"),
  );
}

/** The refusal of a change that touches protected state, or undefined. `subject` names what was refused. */
export function protectedPathRefusal(paths: readonly string[], subject: string): HostRefusal | undefined {
  const refused = protectedPathsOf(paths);
  if (refused.length === 0) return undefined;
  return {
    kind: "protected-path",
    paths: refused,
    message:
      `${subject} modifies protected orchestration state: ${listed(refused)}. ` +
      "hatch owns .git and .hatch, so the item halts; remove the change to those paths (a check that writes under .hatch must write somewhere else), then deliver the binder again.",
  };
}

/** The refusal of a scan that found a credential, or undefined. `subject` names what was refused. */
export function secretMatchRefusal(scan: SecretScanResult, subject: string): HostRefusal | undefined {
  if (scan.status === "clean") return undefined;
  const where = listed(scan.matches.map((match) => `${match.path}:${match.line} (${match.pattern})`));
  return {
    kind: "secret-match",
    matches: scan.matches,
    message:
      `${subject} failed the secret scan: ${where}. ` +
      "Remove or rotate the secret, or add a reviewed entry to .hatch/secret-scan-allowlist, then deliver the binder again.",
  };
}
