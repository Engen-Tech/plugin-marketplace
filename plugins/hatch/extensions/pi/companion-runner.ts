import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import { validateCandidateHooks, type HookValidationResult } from "./hook-runner.ts";
import { runManagedCommand } from "./managed-command.ts";
import { requirePackagePath, resolvePackagePath } from "./package-paths.ts";
import {
  HatchProcessManager,
  type BinderLifecycleOwner,
} from "./process-manager.ts";
import {
  captureRepositoryAuthority,
  hostGitArgs,
  restoreRepositoryAuthority,
  RepositoryHooksChangedError,
  snapshotWorkerAuthority,
  type RepositoryAuthorityBytes,
  type WorkerAuthoritySnapshot,
} from "./worker-attestation.ts";
import { isWriterWritablePath, type HatchWriterRole } from "./writer-profile.ts";
import {
  attestWriterAuthority,
  HatchWriterAuthorityError,
  HatchWriterRunner,
  KAIZEN_SEEDED_CACHE_RULE,
  type HatchUnattestedWriterResult,
  type HatchDocGardnerResult,
  type HatchKaizenResult,
  type HatchOverrideEvidence,
  type HatchResolvedWriterPack,
  type HatchWriterResult,
} from "./writer-runner.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;

export type HatchCompanionCheckpoint = (
  name:
    | "writer-worktree-created"
    | "writer-returned"
    | "writer-surface-attested"
    | "writer-checks-passed"
    | "writer-tree-staged"
    | "writer-hooks-passed"
    | "writer-commit-created"
    | "writer-ref-updated"
    | "writer-worktree-synced"
    | "archive-tree-staged"
    | "archive-hooks-passed"
    | "archive-commit-created"
    | "archive-ref-updated"
    | "archive-worktree-synced",
  details?: { role?: HatchWriterRole; commit?: string; tree?: string },
) => Promise<void> | void;

export interface HatchWriterCommitResult {
  role: HatchWriterRole;
  // `rejected` is a writer that ran and whose output the host refused. The guards
  // that produce it are not relaxed by this status — kaizen still never weakens a
  // rule — but a refused optional companion no longer destroys the delivery it
  // was appended to. It happened: a three-item delivery, every item built, gated,
  // merged and done, was reported as a failure because kaizen tried to weaken one
  // checklist rule at the very end.
  status: "disabled" | "no-change" | "committed" | "rejected";
  reason?: string;
  commit?: string;
  tree?: string;
  result?: HatchWriterResult;
  hookValidation?: HookValidationResult;
  // Set whenever the host refused anything, in turn order. A refused run keeps
  // the writer's envelope in `result` and what it tried to write in the final
  // round, so a refusal no longer discards the evidence with the worktree.
  refusals?: HatchWriterRefusalRound[];
  // Set when the host could not put back the repository config or hooks folder
  // the writer changed. The refusal above still stands.
  restoreFailure?: string;
  // What the host left as it was when it put the repository back, such as a
  // hooks folder outside the repository.
  restoreNotes?: string[];
}

// The closed set of reasons the host refuses a writer change. Each one either
// names a rule the writer could have followed, which earns one corrective turn,
// means confinement or host authority failed (`out-of-surface`, `authority`),
// or is a final check or failure that gets no turn.
export type HatchWriterRefusalCode =
  | "out-of-surface" | "authority" | "pack-path" | "packs-changed-mismatch" | "seed-not-exact"
  | "seed-provenance" | "seeded-cache-edited" | "reseed-provenance"
  | "project-pack-not-monotonic" | "config-invalid" | "pack-validation"
  | "files-changed-mismatch" | "corrected-count-mismatch" | "gitignore"
  | "whitespace" | "secret-scan" | "writer-error" | "host-check" | "restore-escape";

export interface HatchWriterRefusal {
  code: HatchWriterRefusalCode;
  path?: string;
  message: string;
}

export interface HatchWriterRefusalRound {
  turn: 1 | 2;
  final: boolean;
  refusals: HatchWriterRefusal[];
  paths: string[];
  restored?: string[];
  diff?: string;
  diffBytes?: number;
  truncated?: boolean;
  withheld?: "confinement" | "secret-scan" | "capture-failed";
}

// A refusal as the collector found it. `detail` is the validator's own text: it
// can repeat a line the writer wrote, so it goes to the corrective prompt only
// and never into a stored round.
type CollectedRefusal = HatchWriterRefusal & { detail?: string };

function storedRefusal({ code, path, message }: CollectedRefusal): HatchWriterRefusal {
  return path === undefined ? { code, message } : { code, path, message };
}

export class HatchWriterRefusedError extends Error {
  readonly rounds: HatchWriterRefusalRound[];
  readonly result?: HatchWriterResult;
  restoreFailure?: string;
  restoreNotes?: string[];

  constructor(rounds: HatchWriterRefusalRound[], result?: HatchWriterResult) {
    super(refusalReason(rounds));
    this.name = "HatchWriterRefusedError";
    this.rounds = rounds;
    this.result = result;
  }
}

export const REPOSITORY_AUTHORITY_NEXT_STEP =
  "Inspect .git/config and the repository's hooks folder by hand and remove anything the writer added, then run the delivery again. Hatch runs no further git command on this repository until then.";

// A writer broke the host's authority and the host could not put the repository
// config or hooks folder back. Every later phase would run host git under what
// the writer planted, so the delivery stops here. `result` is the writer's
// refusal, with `restoreFailure` set.
export class HatchRepositoryAuthorityError extends Error {
  readonly role: HatchWriterRole;
  readonly result: HatchWriterCommitResult;
  readonly restoreFailure: string;
  readonly nextStep: string;

  constructor(role: HatchWriterRole, result: HatchWriterCommitResult, nextStep = REPOSITORY_AUTHORITY_NEXT_STEP) {
    const restoreFailure = result.restoreFailure ?? "Hatch could not put back the repository config and hooks";
    super(`${restoreFailure}. The ${role} writer's refusal: ${result.reason ?? "none was recorded"}`);
    this.name = "HatchRepositoryAuthorityError";
    this.role = role;
    this.result = result;
    this.restoreFailure = restoreFailure;
    this.nextStep = nextStep;
  }
}

function refusedResult(role: HatchWriterRole, error: HatchWriterRefusedError): HatchWriterCommitResult {
  return {
    role,
    status: "rejected",
    reason: error.message,
    ...(error.result ? { result: error.result } : {}),
    refusals: error.rounds,
    ...(error.restoreFailure ? { restoreFailure: error.restoreFailure } : {}),
    ...(error.restoreNotes?.length ? { restoreNotes: error.restoreNotes } : {}),
  };
}

// Refusals found by the hard check after the session closed. Internal: the
// catch in #runWriter turns it into a final round with its evidence.
class WriterRefusals extends Error {
  readonly refusals: HatchWriterRefusal[];

  constructor(refusals: HatchWriterRefusal[]) {
    super(refusals[0]?.message ?? "Hatch writer change refused");
    this.refusals = refusals;
  }
}

export const MAX_REFUSED_DIFF_BYTES = 16 * 1024;
const MAX_VALIDATOR_LINES_BYTES = 2 * 1024;
const MAX_CORRECTION_LINES = 20;

// Codes that mean confinement or host authority failed. Nothing after one runs
// host tooling on the writer's worktree, and no diff text is kept.
// An authority refusal keeps no paths: listing them would take host git on a
// worktree whose repository authority the writer changed.
const AUTHORITY_WITHHELD = "its paths and diff were withheld because the writer changed the repository's authority";

function authorityRefusalFor(message: string): HatchWriterRefusal {
  return { code: "authority", message: `${message.replace(/\.+$/, "")}; ${AUTHORITY_WITHHELD}` };
}

// A restore-escape is a link the writer planted on a restored file's folder path.
const CONFINEMENT = new Set<HatchWriterRefusalCode>(["out-of-surface", "authority", "restore-escape"]);

// Codes that earn the corrective turn, and the ones whose path is restored to
// the integration tip's bytes before it.
const CORRECTABLE = new Set<HatchWriterRefusalCode>([
  "pack-path", "packs-changed-mismatch", "seed-not-exact", "seed-provenance",
  "seeded-cache-edited", "reseed-provenance", "project-pack-not-monotonic",
  "config-invalid", "pack-validation", "files-changed-mismatch",
  "corrected-count-mismatch", "gitignore",
]);
const RESTORED = new Set<HatchWriterRefusalCode>([
  "pack-path", "seed-not-exact", "seed-provenance", "seeded-cache-edited",
  "reseed-provenance", "project-pack-not-monotonic", "config-invalid",
  "pack-validation", "gitignore",
]);

function refusalReason(rounds: HatchWriterRefusalRound[]): string {
  const final = rounds.at(-1);
  const refusals = final?.refusals ?? [];
  const first = refusals[0]?.message ?? "Hatch writer change refused";
  const more = refusals.length > 1 ? ` (and ${refusals.length - 1} more)` : "";
  // A writer that failed in its corrective turn was not refused again; its
  // message already says where it failed.
  const again = rounds.length > 1 && refusals[0]?.code !== "writer-error"
    ? "; refused again after one corrective turn"
    : "";
  return `${first}${more}${again}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface HatchCompanionResult {
  schema: "hatch-companions-v1";
  docGardner: HatchWriterCommitResult;
  kaizen: HatchWriterCommitResult;
  archive: { status: "already-archived" | "committed"; commit: string };
}

interface WriterConfig {
  enabled: boolean;
  focus?: string;
}

export interface ProcessContext {
  manager: HatchProcessManager;
  owner: BinderLifecycleOwner;
}

// Every host git call here runs with the hardened options: a hook or fsmonitor
// a writer set in the shared repository config runs nothing on the host, on the
// integration worktree as much as on the writer's own.
async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await exec("git", hostGitArgs(cwd, args), {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during companion finalization`);
  }
}

// Git on the writer's worktree, which the writer could have configured: no
// fsmonitor command or hook of its choosing runs.
async function writerGitRaw(worktree: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", hostGitArgs(worktree, args), {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  return stdout;
}

async function writerGit(worktree: string, args: string[]): Promise<string> {
  try {
    return (await writerGitRaw(worktree, args)).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during companion finalization`);
  }
}

async function gitNoMatch(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", hostGitArgs(cwd, args), {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during companion evidence collection`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseConfig(raw: string, path: string): WriterConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Hatch writer config is not valid JSON: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hatch writer config is not an object: ${path}`);
  }
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some((key) => !["enabled", "focus"].includes(key)) ||
    typeof config.enabled !== "boolean" ||
    (config.focus !== undefined && typeof config.focus !== "string")
  ) {
    throw new Error(`Hatch writer config has an invalid shape: ${path}`);
  }
  return { enabled: config.enabled, ...(config.focus === undefined ? {} : { focus: config.focus }) };
}

async function readConfig(worktree: string, writer: HatchWriterRole): Promise<WriterConfig> {
  const relative = writer === "doc-gardner" ? ".hatch/doc-gardner.json" : ".hatch/kaizen.json";
  const path = join(worktree, relative);
  if (!(await exists(path))) return { enabled: false };
  return parseConfig(await readFile(path, "utf8"), relative);
}

function splitNul(output: string): string[] {
  return output.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

async function changedPaths(worktree: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    writerGit(worktree, ["diff", "--name-only", "-z", "--"]),
    writerGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...splitNul(tracked), ...splitNul(untracked)])].sort();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(uniqueStrings(left)) === JSON.stringify(uniqueStrings(right));
}

function attestGitignore(before: string | undefined, after: string, scratchExists: boolean): void {
  if (!scratchExists) throw new Error("Hatch doc-gardner changed .gitignore without a superpowers folder to salvage");
  const oldLines = (before ?? "").split("\n");
  const newLines = after.split("\n");
  let oldIndex = 0;
  let additions = 0;
  for (const line of newLines) {
    if (oldIndex < oldLines.length && line === oldLines[oldIndex]) {
      oldIndex += 1;
    } else if (line === "superpowers/") {
      additions += 1;
    } else {
      throw new Error("Hatch doc-gardner may only add 'superpowers/' to .gitignore");
    }
  }
  if (oldIndex !== oldLines.length || additions !== 1) {
    throw new Error("Hatch doc-gardner .gitignore change is not the single salvage exception");
  }
}

function frontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function checklist(text: string): { active: Map<string, string>; retired: Set<string> } {
  const active = new Map<string, string>();
  const retired = new Set<string>();
  for (const line of text.split("\n")) {
    const item = line.match(/^- \[ \] ([a-z][a-z0-9-]*\.\d+) — (\S.*)$/);
    if (item) active.set(item[1], item[2]);
    const tombstone = line.match(/^- ~~([a-z][a-z0-9-]*\.\d+)~~ retired: \S.*$/);
    if (tombstone) retired.add(tombstone[1]);
  }
  return { active, retired };
}

function stripStamp(text: string): string {
  return text.split("\n")
    .filter((line) => !line.startsWith("seeded_from:") && !line.startsWith("base_sha256:"))
    .join("\n");
}

function parseStringList(value: string | undefined): Set<string> {
  if (value === undefined) return new Set();
  try {
    const parsed = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

// Prose surfaces: they describe the override mechanism rather than exercising it.
function isProse(path: string): boolean {
  return path.startsWith("docs/") ||
    path.startsWith("benchmarks/") ||
    path.startsWith(".hatch/binders/") ||
    path.startsWith("agents/") ||
    path.startsWith(".codex/") ||
    path.endsWith(".md");
}

// Generated projections of `skills/` (INV-19). Byte-equal by construction, so a
// marker in one is the same marker, not another occurrence of it.
function isGeneratedMirror(path: string): boolean {
  return path.startsWith(".agents/skills/") || path.startsWith("plugins/hatch/");
}

export function assertMonotonicProjectPack(path: string, before: string, after: string): void {
  const oldFrontmatter = frontmatter(before);
  const newFrontmatter = frontmatter(after);
  for (const key of ["name", "description", "match", "always", "disabled", "extends", "id_prefix", "see_also", "seeded_from", "base_sha256"]) {
    if (oldFrontmatter[key] !== newFrontmatter[key]) {
      throw new Error(`Hatch kaizen changed protected pack frontmatter '${key}' in ${path}`);
    }
  }
  const oldExcludes = parseStringList(oldFrontmatter.exclude_rules);
  const newExcludes = parseStringList(newFrontmatter.exclude_rules);
  for (const rule of oldExcludes) {
    if (!newExcludes.has(rule)) throw new Error(`Hatch kaizen removed exclusion '${rule}' from ${path}`);
  }
  const oldChecklist = checklist(before);
  const newChecklist = checklist(after);
  for (const [id, text] of oldChecklist.active) {
    const replacement = newChecklist.active.get(id);
    if (replacement === undefined) {
      throw new Error(
        `Hatch kaizen removed rule '${id}' from ${path}; an existing rule is never dropped`,
      );
    }
    // Byte equality, deliberately. The previous test was substring containment,
    // which let any weakening through as long as it was phrased as an appended
    // exception — the most natural way to widen a carve-out, and exactly the edit
    // that was attempted here on 2026-09-02. It also rejected rewordings that
    // strengthened a rule, and a typo fix, while reporting all of them as
    // "weakened". No mechanical test can tell a tightening from a loosening, so
    // this one stops pretending to: an existing rule's text does not change, and
    // sharpening happens by adding a rule beside it.
    if (replacement !== text) {
      throw new Error(
        `Hatch kaizen rewrote rule '${id}' in ${path}; an existing rule's text is immutable — ` +
          "add a new rule beside it and leave the wording of this one to a human",
      );
    }
  }
  for (const id of oldChecklist.retired) {
    if (!newChecklist.retired.has(id)) throw new Error(`Hatch kaizen removed tombstone '${id}' from ${path}`);
  }
  const durableBody = (text: string): string[] => {
    const lines = text.split("\n");
    const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
    return lines.slice(close + 1).filter((line) => !/^- \[ \] [a-z][a-z0-9-]*\.\d+ — /.test(line));
  };
  const oldBody = durableBody(before);
  const newBody = durableBody(after);
  let cursor = 0;
  for (const line of oldBody) {
    const found = newBody.indexOf(line, cursor);
    if (found < 0) throw new Error(`Hatch kaizen removed or rewrote existing pack guidance in ${path}`);
    cursor = found + 1;
  }
}

async function listProjectPacks(worktree: string): Promise<string[]> {
  const root = join(worktree, ".hatch", "sme");
  if (!(await exists(root))) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(root, entry.name))
    .sort();
}

async function runPackValidator(
  worktree: string,
  processContext: ProcessContext,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof runManagedCommand>> | null> {
  const packs = await listProjectPacks(worktree);
  if (packs.length === 0) return null;
  return runManagedCommand({
    command: "uv",
    args: ["run", "--script", requirePackagePath("skills/hatch-kaizen/scripts/validate_packs.py"), ...packs],
    cwd: worktree,
    signal,
    onProcessStart(pid) {
      processContext.manager.registerProcess(pid, {
        cwd: worktree,
        parentId: processContext.owner.id,
        label: "kaizen pack validation",
        role: "host-check",
      });
    },
    onProcessExit(pid) {
      processContext.manager.forgetProcess(pid);
    },
  });
}

async function validatePacks(
  worktree: string,
  processContext: ProcessContext,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runPackValidator(worktree, processContext, signal);
  if (result && result.status !== "passed") {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || "Hatch kaizen pack validation failed");
  }
}

// The allowlist is the integration tip's, never the worktree's: a writer that
// planted a permissive allowlist must not be able to clear its own diff.
async function scanSecrets(
  worktree: string,
  base: string,
  processContext: ProcessContext,
  signal?: AbortSignal,
): Promise<void> {
  const allowlist = await commitFile(worktree, base, ".hatch/secret-scan-allowlist");
  const root = await mkdtemp(join(tmpdir(), "hatch-secret-allowlist-"));
  try {
    // A missing file reads as an empty allowlist.
    const path = join(root, "allowlist");
    if (allowlist !== undefined) await writeFile(path, allowlist);
    const result = await runManagedCommand({
      command: "uv",
      args: ["run", "--script", requirePackagePath("skills/hatch-build/scripts/scan_secrets.py"), "--allowlist", path],
      cwd: worktree,
      signal,
      onProcessStart(pid) {
        processContext.manager.registerProcess(pid, {
          cwd: worktree,
          parentId: processContext.owner.id,
          label: "companion secret scan",
          role: "host-check",
        });
      },
      onProcessExit(pid) {
        processContext.manager.forgetProcess(pid);
      },
    });
    if (result.status !== "passed") {
      throw new Error(`${result.stdout}${result.stderr}`.trim() || "Hatch companion secret scan failed");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commitFile(cwd: string, commit: string, path: string): Promise<string | undefined> {
  const listed = splitNul(await writerGit(cwd, ["ls-tree", "--name-only", "-z", commit, "--", path]));
  if (!listed.includes(path)) return undefined;
  return writerGitRaw(cwd, ["show", `${commit}:${path}`]);
}

export async function validateRecoveredCompanionCommit(options: {
  worktree: string;
  binder: string;
  writer: HatchWriterRole;
  parent: string;
  commit: string;
  processContext: ProcessContext;
  signal?: AbortSignal;
}): Promise<boolean> {
  const paths = splitNul(await git(options.worktree, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    options.parent,
    options.commit,
  ]));
  if (!paths.every((path) => isWriterWritablePath(options.writer, path))) return false;
  if (options.writer === "doc-gardner") {
    if (paths.includes(".gitignore")) {
      const before = await commitFile(options.worktree, options.parent, ".gitignore");
      const after = await commitFile(options.worktree, options.commit, ".gitignore");
      if (after === undefined) return false;
      const scratchExists =
        (await git(options.worktree, ["ls-tree", "--name-only", options.commit, "--", "superpowers", "docs/superpowers"]))
          .split("\n").filter(Boolean).length > 0;
      try {
        attestGitignore(before, after, scratchExists);
      } catch {
        return false;
      }
    }
    return true;
  }
  if (paths.length === 0) return false;
  for (const path of paths.filter((candidate) => candidate.startsWith(".hatch/sme/"))) {
    if (!/^\.hatch\/sme\/[a-z0-9][a-z0-9-]*\.md$/.test(path)) return false;
    const before = await commitFile(options.worktree, options.parent, path);
    const after = await commitFile(options.worktree, options.commit, path);
    if (after === undefined) return false;
    const id = basename(path, ".md");
    const builtin = resolvePackagePath(`skills/hatch-plan/references/sme/${id}.md`);
    const canonical = await exists(builtin) ? await readFile(builtin, "utf8") : undefined;
    try {
      if (before === undefined || frontmatter(before).seeded_from) {
        if (canonical === undefined || stripStamp(after) !== canonical) return false;
        const fields = frontmatter(after);
        const canonicalHash = createHash("sha256").update(canonical).digest("hex");
        if (fields.seeded_from !== id || fields.base_sha256 !== canonicalHash) return false;
      } else {
        assertMonotonicProjectPack(path, before, after);
      }
    } catch {
      return false;
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hatch-kaizen-recovery-"));
  const disposable = join(root, "worktree");
  let registered = false;
  try {
    await git(options.worktree, ["worktree", "add", "--detach", disposable, options.commit]);
    registered = true;
    await readConfig(disposable, "kaizen");
    await validatePacks(disposable, options.processContext, options.signal);
    return true;
  } catch {
    return false;
  } finally {
    if (registered) await git(options.worktree, ["worktree", "remove", "--force", disposable], true);
    await rm(root, { recursive: true, force: true });
  }
}

interface WriterRefusalInput {
  writer: HatchWriterRole;
  worktree: string;
  result: HatchUnattestedWriterResult | HatchWriterResult;
  paths: string[];
  beforePacks: Map<string, string>;
  beforeIgnore: string | undefined;
  packs: HatchResolvedWriterPack[];
  processContext: ProcessContext;
  signal?: AbortSignal;
}

async function readChanged(worktree: string, path: string): Promise<string> {
  try {
    return await readFile(join(worktree, path), "utf8");
  } catch (error) {
    // A deleted file reads as empty, so the pack rules judge the deletion.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

// The validator prints `<absolute path>: INVALID` and then its findings, each
// indented. Map those blocks to repository paths.
function invalidPackBlocks(output: string, worktree: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const prefix = `${worktree}${sep}`;
  let current: { path: string; lines: string[] } | undefined;
  for (const line of output.split("\n")) {
    const header = line.match(/^(.*): INVALID$/);
    if (header) {
      const absolute = header[1];
      const path = (absolute.startsWith(prefix) ? absolute.slice(prefix.length) : absolute).replaceAll("\\", "/");
      current = { path, lines: [line] };
      blocks.set(path, "");
    } else if (current && /^\s+- /.test(line)) {
      current.lines.push(line);
    } else {
      current = undefined;
    }
    if (current) blocks.set(current.path, current.lines.join("\n"));
  }
  return blocks;
}

// Every rule the writer's change breaks, in the order the host has always
// checked them, so the first message is the reason a caller has always read.
// It throws only for a host failure: a git error, or a validator that failed
// without naming a file the writer changed. The soft review and the hard check
// both call it, so the review is exactly as strict as the check.
async function collectWriterRefusals(input: WriterRefusalInput): Promise<CollectedRefusal[]> {
  const { writer, worktree, paths } = input;
  const refusals: CollectedRefusal[] = [];
  // Confinement failed: stop at the first path outside the surface, before any
  // file is read or any host tool runs on the writer's worktree.
  const outside = paths.find((path) => !isWriterWritablePath(writer, path));
  if (outside !== undefined) {
    return [{ code: "out-of-surface", path: outside, message: `Hatch ${writer} mutated an out-of-surface path: ${outside}` }];
  }
  if (writer === "doc-gardner") {
    const docResult = input.result as HatchDocGardnerResult;
    if (!sameStrings(docResult.filesChanged, paths)) {
      refusals.push({
        code: "files-changed-mismatch",
        message: "Hatch doc-gardner result does not match the host-observed changed paths",
      });
    }
    if (docResult.correctedCount !== paths.filter((path) => path !== ".gitignore").length) {
      refusals.push({
        code: "corrected-count-mismatch",
        message: "Hatch doc-gardner correctedCount does not match the host-observed doc changes",
      });
    }
    if (paths.includes(".gitignore")) {
      const scratch = await exists(join(worktree, "superpowers")) || await exists(join(worktree, "docs", "superpowers"));
      try {
        attestGitignore(input.beforeIgnore, await readChanged(worktree, ".gitignore"), scratch);
      } catch (error) {
        refusals.push({ code: "gitignore", path: ".gitignore", message: errorMessage(error) });
      }
    }
    return refusals;
  }
  const kaizenResult = input.result as HatchKaizenResult;
  const changedPackPaths = paths.filter((path) => path.startsWith(".hatch/sme/"));
  const packPath = (path: string) => /^\.hatch\/sme\/[a-z0-9][a-z0-9-]*\.md$/.test(path);
  for (const path of changedPackPaths.filter((candidate) => !packPath(candidate))) {
    refusals.push({
      code: "pack-path",
      path,
      message: "Hatch kaizen pack changes must use lowercase top-level .hatch/sme/<id>.md paths",
    });
  }
  if (!sameStrings(kaizenResult.packsChanged, changedPackPaths)) {
    refusals.push({
      code: "packs-changed-mismatch",
      message: "Hatch kaizen result does not match the host-observed pack changes",
    });
  }
  const resolved = new Map(input.packs.map((pack) => [`${pack.id}.md`, pack]));
  for (const path of changedPackPaths.filter(packPath)) {
    const name = basename(path);
    const after = await readChanged(worktree, path);
    const before = input.beforePacks.get(name);
    const source = resolved.get(name);
    const exactSeed = !!source?.canonicalContent && stripStamp(after) === source.canonicalContent;
    const fields = frontmatter(after);
    const provenance = fields.seeded_from === source?.id && fields.base_sha256 === source?.canonicalSha256;
    if (before === undefined) {
      if (!exactSeed) {
        refusals.push({ code: "seed-not-exact", path, message: `Hatch kaizen created a pack that is not an exact pinned seed: ${path}` });
      } else if (!provenance) {
        refusals.push({ code: "seed-provenance", path, message: `Hatch kaizen seed has invalid provenance: ${path}` });
      }
    } else if (frontmatter(before).seeded_from) {
      if (!exactSeed) {
        refusals.push({
          code: "seeded-cache-edited",
          path,
          message: `Hatch kaizen edited a seeded cache instead of reseeding exactly: ${path}`,
        });
      } else if (!provenance) {
        refusals.push({ code: "reseed-provenance", path, message: `Hatch kaizen reseed has invalid provenance: ${path}` });
      }
    } else {
      try {
        assertMonotonicProjectPack(path, before, after);
      } catch (error) {
        refusals.push({ code: "project-pack-not-monotonic", path, message: errorMessage(error) });
      }
    }
  }
  try {
    await readConfig(worktree, writer);
  } catch (error) {
    refusals.push({ code: "config-invalid", path: ".hatch/kaizen.json", message: errorMessage(error) });
  }
  const validation = await runPackValidator(worktree, input.processContext, input.signal);
  if (validation && validation.status !== "passed") {
    const output = `${validation.stdout}${validation.stderr}`.trim();
    const named = validation.status === "failed"
      ? [...invalidPackBlocks(output, worktree)].filter(([path]) => paths.includes(path))
      : [];
    // The base passed this validator before the writer ran, so a failure that
    // names no file the writer changed is the host's, not the writer's.
    if (named.length === 0) throw new Error(output || "Hatch kaizen pack validation failed");
    for (const [path, lines] of named) {
      refusals.push({ code: "pack-validation", path, message: `Hatch kaizen pack validation failed: ${path}`, detail: lines });
    }
  }
  return refusals;
}

// A restore that would act through a link the writer planted on the folder
// path, or through something that is not a folder. Nothing was changed.
class RestoreEscape extends Error {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`Hatch cannot restore ${path}: ${reason}; nothing was restored`);
    this.path = path;
  }
}

interface RestorePlan {
  path: string;
  // The deepest folder on the path that exists, as a real path inside the worktree.
  parent: string;
  // Folders below `parent` that do not exist yet, outermost first.
  missing: string[];
  name: string;
  entry?: { mode: string; object: string };
}

// Walk every folder on the path below the worktree root with lstat. A link, or
// anything that is not a folder, refuses the restore before anything changes.
async function restoreFolder(root: string, path: string): Promise<Pick<RestorePlan, "parent" | "missing" | "name">> {
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new RestoreEscape(path, "its path is not a plain path inside the worktree");
  }
  const name = parts.pop() as string;
  let parent = root;
  for (let index = 0; index < parts.length; index += 1) {
    const next = join(parent, parts[index]);
    let stat;
    try {
      stat = await lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { parent, missing: parts.slice(index), name };
    }
    if (stat.isSymbolicLink()) throw new RestoreEscape(path, `its folder ${parts.slice(0, index + 1).join("/")} is a link`);
    if (!stat.isDirectory()) throw new RestoreEscape(path, `${parts.slice(0, index + 1).join("/")} is not a folder`);
    parent = next;
  }
  return { parent, missing: [], name };
}

// Check every refused path before any is touched: the folder walk first, for
// all of them, then the integration tip's entry for each.
async function planRestores(worktree: string, base: string, paths: string[]): Promise<RestorePlan[]> {
  const root = await realpath(worktree);
  const folders = [];
  for (const path of paths) folders.push({ path, ...(await restoreFolder(root, path)) });
  const plans: RestorePlan[] = [];
  for (const folder of folders) {
    const entry = (await writerGitRaw(worktree, ["--literal-pathspecs", "ls-tree", "-z", base, "--", folder.path]))
      .split("\0")
      .find((line) => line.slice(line.indexOf("\t") + 1) === folder.path);
    if (entry === undefined) {
      plans.push(folder);
      continue;
    }
    const [mode, type, object] = entry.slice(0, entry.indexOf("\t")).split(" ");
    if (type !== "blob" || !["100644", "100755", "120000"].includes(mode)) {
      throw new Error(`Hatch cannot restore ${folder.path}: unsupported base entry ${mode} ${type}`);
    }
    plans.push({ ...folder, entry: { mode, object } });
  }
  return plans;
}

// Put a refused file back to the integration tip's exact blob bytes and mode,
// or remove it when the tip has none. The bytes are written by the host, not by
// a checkout, so no filter or hook runs. Every change goes through the checked
// real folder joined with the file's name: whatever the writer left at the
// path itself is removed, so a planted link there is replaced, never followed.
async function restoreToBase(worktree: string, plan: RestorePlan): Promise<void> {
  let parent = plan.parent;
  if (plan.entry !== undefined) {
    for (const folder of plan.missing) {
      parent = join(parent, folder);
      try {
        await mkdir(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // An earlier restore in this pass made it; anything else refuses.
        const stat = await lstat(parent);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`Hatch cannot restore ${plan.path}: its folder changed during the restore`);
        }
      }
    }
  } else if (plan.missing.length > 0) {
    return;
  }
  const target = join(parent, plan.name);
  await rm(target, { recursive: true, force: true });
  if (plan.entry === undefined) return;
  const { mode, object } = plan.entry;
  const { stdout } = await exec("git", hostGitArgs(worktree, ["cat-file", "blob", object]), {
    encoding: "buffer",
    maxBuffer: MAX_OUTPUT,
  });
  if (mode === "120000") {
    await symlink(stdout.toString("utf8"), target);
    return;
  }
  await writeFile(target, stdout, { flag: "wx" });
  await chmod(target, mode === "100755" ? 0o755 : 0o644);
}

interface ProjectPackSurface {
  id: string;
  extends?: string;
}

function projectPackSurfaces(beforePacks: Map<string, string>): ProjectPackSurface[] {
  return [...beforePacks].flatMap(([name, text]) => {
    const fields = frontmatter(text);
    if (fields.seeded_from) return [];
    const extended = fields.extends?.replace(/^["']|["']$/g, "");
    return [{ id: basename(name, ".md"), ...(extended ? { extends: extended } : {}) }];
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function listOrNone(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function seededCacheGuidance(path: string, surfaces: ProjectPackSurface[]): string {
  const id = basename(path, ".md");
  const extenders = surfaces.filter((surface) => surface.extends === id).map((surface) => `\`${surface.id}\``);
  const others = surfaces.map((surface) => `\`${surface.id}\``);
  const narrowing = extenders.length > 0
    ? `Project pack ${extenders.join(", ")} extends \`${id}\`: a narrowing of a \`${id}\` rule goes there as an \`exclude_rules\` entry plus a rule beginning \`Narrows <rule-id>:\`.`
    : `No project pack here extends \`${id}\`, and kaizen may not add \`extends\` or create a pack, so a narrowing of a \`${id}\` rule goes in \`proposedScaffolds\`.`;
  const addition = others.length > 0
    ? ` A new rule may go beside the rules of an existing project pack: ${others.join(", ")}.`
    : " There is no project pack here, so a new rule also goes in `proposedScaffolds`.";
  return `${KAIZEN_SEEDED_CACHE_RULE} ${narrowing}${addition}`;
}

function refusalGuidance(
  refusal: HatchWriterRefusal,
  context: { surfaces: ProjectPackSurface[]; declared: string[]; observed: string[] },
): string {
  switch (refusal.code) {
    case "seeded-cache-edited":
    case "reseed-provenance":
      return seededCacheGuidance(refusal.path ?? "", context.surfaces);
    case "seed-not-exact":
    case "seed-provenance":
      return "Kaizen creates a pack file only as an exact, stamped seed of a pinned built-in; a new pack goes in `proposedScaffolds`.";
    case "project-pack-not-monotonic":
      return "An existing rule's text, its tombstones, its exclusions, its protected frontmatter and its existing guidance stay exactly as they are; add a new rule beside the old one.";
    case "pack-validation":
      return "Fix what the pack validator reports, or leave the file unchanged.";
    case "pack-path":
      return "Pack files are lowercase top-level `.hatch/sme/<id>.md` paths.";
    case "config-invalid":
      return "`.hatch/kaizen.json` holds only `enabled` (a boolean) and `focus` (a string).";
    case "packs-changed-mismatch":
      return `\`packsChanged\` lists exactly the pack files that differ from the integration tip. You listed: ${listOrNone(context.declared)}. The host sees: ${listOrNone(context.observed.filter((path) => path.startsWith(".hatch/sme/")))}.`;
    case "files-changed-mismatch":
    case "corrected-count-mismatch":
      return `\`filesChanged\` lists exactly the files that differ from the integration tip, and \`correctedCount\` counts them without \`.gitignore\`. You listed: ${listOrNone(context.declared)}. The host sees: ${listOrNone(context.observed)}.`;
    case "gitignore":
      return "Doc-gardner may add only one `superpowers/` line to `.gitignore`, and only when a superpowers folder exists.";
    default:
      return "";
  }
}

function clipBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  return `${bytes.subarray(0, limit).toString("utf8")}\n(cut at ${limit} bytes)`;
}

export function writerCorrectionPrompt(
  writer: HatchWriterRole,
  refusals: CollectedRefusal[],
  restored: string[],
  kept: string[],
  context: { surfaces: ProjectPackSurface[]; declared: string[] },
): string {
  const perFile = refusals.some((refusal) => refusal.path !== undefined);
  // A list mismatch beside a per-file refusal is not its own line: the restore
  // changes what differs, and the reply has to list it afresh either way.
  const shown = refusals.filter((refusal) => !(perFile && refusal.code === "packs-changed-mismatch"));
  const lines = shown.slice(0, MAX_CORRECTION_LINES).map((refusal) => {
    const message = refusal.detail !== undefined
      ? clipBytes(refusal.detail, MAX_VALIDATOR_LINES_BYTES)
      : refusal.message;
    const guidance = refusalGuidance(refusal, { ...context, observed: kept });
    return `- ${refusal.path ?? "(envelope)"} [${refusal.code}]: ${message}${guidance ? `\n  ${guidance}` : ""}`;
  });
  if (shown.length > MAX_CORRECTION_LINES) lines.push(`- and ${shown.length - MAX_CORRECTION_LINES} more`);
  const list = writer === "kaizen"
    ? "`packsChanged`"
    : "`filesChanged` and `correctedCount`";
  return [
    restored.length > 0
      ? `The host refused part of your change and restored these files to the integration tip's bytes: ${restored.join(", ")}.`
      : "The host refused part of your change. No file was restored.",
    "",
    "Refusals:",
    ...lines,
    "",
    `Your changes that stand: ${listOrNone(kept)}.`,
    restored.length > 0
      ? "Read each restored file again before you change it: your session still holds the text you wrote, not what is on disk now."
      : "",
    "This is your only corrective turn. A second refusal discards the whole run.",
    "Leaving the files unchanged and recording the lesson in the envelope is a valid answer.",
    "",
    `Reply with ONLY the JSON writer-result object, with ${list} describing exactly what differs from the integration tip now.`,
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
}

// Cut a diff at the last newline at or before the byte cap.
function cutDiff(diff: string): { diff: string; diffBytes: number; truncated: boolean } {
  const bytes = Buffer.from(diff);
  if (bytes.length <= MAX_REFUSED_DIFF_BYTES) return { diff, diffBytes: bytes.length, truncated: false };
  const head = bytes.subarray(0, MAX_REFUSED_DIFF_BYTES);
  const cut = head.lastIndexOf(0x0a);
  return {
    diff: head.subarray(0, cut + 1).toString("utf8"),
    diffBytes: bytes.length,
    truncated: true,
  };
}

// The evidence of a final refusal, read before the worktree is removed. The
// host's authority is attested first: after an authority refusal, or when the
// attestation fails here, no host git runs on the worktree and no path or diff
// is kept. After any other confinement refusal only the paths are kept. Any
// other candidate is staged in the disposable worktree and secret-scanned with
// the integration tip's allowlist before any diff text is kept; a capture
// failure never replaces the refusal.
async function captureFinalRound(
  worktree: string,
  base: string,
  turn: 1 | 2,
  refusals: HatchWriterRefusal[],
  authority: () => Promise<HatchWriterRefusal | null>,
  processContext: ProcessContext,
  signal?: AbortSignal,
): Promise<HatchWriterRefusalRound> {
  const round: HatchWriterRefusalRound = { turn, final: true, refusals, paths: [] };
  try {
    if (refusals.some((refusal) => refusal.code === "authority")) return { ...round, withheld: "confinement" };
    const broken = await authority();
    if (broken) return { ...round, refusals: [...refusals, broken], withheld: "confinement" };
    const unstaged = await changedPaths(worktree);
    if (refusals.some((refusal) => CONFINEMENT.has(refusal.code))) {
      return { ...round, paths: unstaged, withheld: "confinement" };
    }
    if (unstaged.length > 0) await writerGit(worktree, ["add", "--all", "--", ...unstaged]);
    // A check that failed after staging leaves nothing unstaged, so the paths
    // are what the index holds against the integration tip.
    round.paths = splitNul(await writerGit(worktree, ["diff", "--cached", "--name-only", "-z", "--no-renames", base, "--"]));
    if (refusals.some((refusal) => refusal.code === "secret-scan")) return { ...round, withheld: "secret-scan" };
    try {
      await scanSecrets(worktree, base, processContext, signal);
    } catch {
      return { ...round, withheld: "secret-scan" };
    }
    const diff = await writerGitRaw(worktree, [
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      base,
    ]);
    return { ...round, ...cutDiff(diff) };
  } catch {
    return { ...round, withheld: "capture-failed" };
  }
}

// `git diff --check` prints each offending line after its `<path>:<line>:`
// header, so its text can carry whatever the writer wrote. A final refusal has
// no prompt to carry it: the stored refusal names only the files.
async function whitespaceCheck(writer: HatchWriterRole, worktree: string, paths: string[]): Promise<void> {
  let output: string;
  try {
    await writerGitRaw(worktree, ["-c", "core.quotePath=false", "diff", "--cached", "--check"]);
    return;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    // Exit 2 is the check's own finding; anything else is a host failure, kept unworded.
    if (failure.code !== 2) throw new Error(`Hatch ${writer} whitespace check could not run`);
    output = failure.stdout ?? "";
  }
  const lines = output.split("\n");
  const named = paths.filter((path) => lines.some((line) => line.startsWith(`${path}:`)));
  throw new WriterRefusals(named.length > 0
    ? named.map((path) => ({ code: "whitespace", path, message: `Hatch ${writer} whitespace check failed: ${path}` }))
    : [{ code: "whitespace", message: `Hatch ${writer} whitespace check failed` }]);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function refusalSentence(writer: HatchWriterCommitResult, key: string): string {
  const rounds = writer.refusals ?? [];
  const final = rounds.find((round) => round.final);
  if (!final) return `The ${writer.role} companion was refused: ${writer.reason}`;
  // The reason already says whether a corrective turn ran; it ends in exactly one period here.
  const reason = (writer.reason ?? "").replace(/\.+$/, "");
  const outcome = final.refusals[0]?.code === "writer-error" ? "stopped on an error" : "was refused";
  if (final.refusals.some((refusal) => refusal.code === "authority")) {
    return `The ${writer.role} companion ${outcome}: ${reason}. Nothing it tried to write is kept: ${AUTHORITY_WITHHELD}.`;
  }
  const detail = final.withheld
    ? `; diff withheld: ${final.withheld}`
    : final.truncated
    ? `; diff cut at ${MAX_REFUSED_DIFF_BYTES / 1024} KiB`
    : "";
  return `The ${writer.role} companion ${outcome}: ${reason}. What it tried to write is kept in ` +
    `companions.${key}.refusals (${plural(final.paths.length, "file", "files")}${detail}).`;
}

// The message a person reads at the end of a delivery. A refused companion
// never downgrades the delivery, but its refusal, the evidence the host kept,
// a corrected first attempt, and kaizen notes that reached no commit are all
// named here rather than left in the expanded JSON.
export function describeCompanionOutcome(companions: HatchCompanionResult): string {
  const writers = [
    { key: "docGardner", writer: companions.docGardner },
    { key: "kaizen", writer: companions.kaizen },
  ];
  const refused = writers.filter(({ writer }) => writer.status === "rejected");
  const sentences = refused.length === 0
    ? ["Every binder item is durably done, companion writers finished, and the binder is archived."]
    : [
      "Every binder item is durably done and the binder is archived.",
      ...refused.map(({ key, writer }) => refusalSentence(writer, key)),
      "Its changes were not committed; the delivery is unaffected.",
    ];
  for (const { writer } of writers) {
    const first = writer.refusals?.[0];
    if (writer.status === "rejected" || !first || first.final) continue;
    const named = first.refusals.map((refusal) => refusal.path ? `${refusal.code}: ${refusal.path}` : refusal.code);
    sentences.push(`The ${writer.role} companion's first change was refused (${named.join(", ")}) and it corrected it in one turn.`);
  }
  const kaizen = companions.kaizen;
  if ((kaizen.status === "no-change" || kaizen.status === "rejected") && kaizen.result?.role === "kaizen") {
    const { proposedScaffolds, upstreamCandidates, erosionNotes } = kaizen.result;
    if (proposedScaffolds.length + upstreamCandidates.length + erosionNotes.length > 0) {
      sentences.push(
        `Kaizen left notes that are in no commit: ${plural(proposedScaffolds.length, "proposed scaffold", "proposed scaffolds")}, ` +
          `${plural(upstreamCandidates.length, "upstream candidate", "upstream candidates")}, ` +
          `${plural(erosionNotes.length, "erosion note", "erosion notes")}, in companions.kaizen.result.`,
      );
    }
  }
  return sentences.join(" ");
}

function formatKaizenMessage(binder: string, result: HatchKaizenResult): string {
  const subject = result.seeded.length > 0
    ? `kaizen: seed ${result.seeded.length} packs into .hatch/sme/`
    : `kaizen: ${result.summary.split("\n", 1)[0].slice(0, 64)}`;
  const sections = [
    result.summary,
    `Binder: ${binder}`,
    ...([
      ["Candidates", result.candidates],
      ["Erosion notes", result.erosionNotes],
      ["Upstream candidates", result.upstreamCandidates],
      ["Proposed scaffolds", result.proposedScaffolds],
      ["Residual", result.residual],
    ] as const).flatMap(([heading, entries]) => entries.length > 0
      ? [`${heading}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`]
      : []),
  ];
  return `${subject}\n\n${sections.join("\n\n")}`;
}

function formatDocMessage(binder: string, diffRange: string, result: HatchDocGardnerResult): string {
  const body = [result.summary, `Range: ${diffRange}`];
  if (result.residual.length > 0) body.push(`Residual:\n${result.residual.map((entry) => `- ${entry}`).join("\n")}`);
  else if (result.correctedCount === 0) body.push("no drift found");
  if (result.focusStale) body.push(result.focusStale);
  return `docs: gardner ${binder}\n\n${body.join("\n\n")}`;
}

export class HatchCompanionRunner {
  readonly #locks: DispatchLockManager;
  readonly #writers: HatchWriterRunner;
  readonly #checkpoint: HatchCompanionCheckpoint;

  constructor(
    locks: DispatchLockManager,
    writers: HatchWriterRunner,
    checkpoint: HatchCompanionCheckpoint = () => {},
  ) {
    this.#locks = locks;
    this.#writers = writers;
    this.#checkpoint = checkpoint;
  }

  async #resolvePacks(worktree: string, ids: string[]): Promise<HatchResolvedWriterPack[]> {
    return Promise.all(uniqueStrings(ids).map(async (id) => {
      if (!IDENTIFIER.test(id)) throw new Error(`Hatch binder contains an invalid pack id: ${id}`);
      const local = join(worktree, ".hatch", "sme", `${id}.md`);
      const builtin = resolvePackagePath(`skills/hatch-plan/references/sme/${id}.md`);
      const hasLocal = await exists(local);
      const hasBuiltin = await exists(builtin);
      if (!hasLocal && !hasBuiltin) throw new Error(`Hatch cannot resolve pinned pack '${id}'`);
      const path = hasLocal ? local : builtin;
      const content = await readFile(path, "utf8");
      const canonicalContent = hasBuiltin ? await readFile(builtin, "utf8") : undefined;
      return {
        id,
        path,
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
        ...(canonicalContent === undefined ? {} : {
          canonicalContent,
          canonicalSha256: createHash("sha256").update(canonicalContent).digest("hex"),
        }),
      };
    }));
  }

  async #overrideEvidence(
    worktree: string,
    binder: string,
    blastRadius: string[],
  ): Promise<HatchOverrideEvidence[]> {
    const output = await gitNoMatch(worktree, [
      "grep",
      "-n",
      "-I",
      "-E",
      "HATCH-SME-OVERRIDE\\([^)]+\\):",
      "HEAD",
      "--",
    ]);
    if (!output) return [];
    const records = output.split("\n").flatMap((entry) => {
      const match = entry.match(/^HEAD:(.*):(\d+):(.*)$/);
      if (!match) return [];
      const marker = match[3].match(/HATCH-SME-OVERRIDE\(([^)]+)\):\s*(.+)$/);
      if (!marker) return [];
      const path = match[1];
      const rule = marker[1].trim();
      // A repo-wide grep for the marker finds the prose that documents the marker
      // grammar as readily as it finds an override. Measured on this repo, 45 of
      // 60 hits were `<rule-id>` placeholders from READMEs, agent files and
      // benchmark fixtures. Only a real rule id counts.
      if (!/^[a-z][a-z0-9-]*\.\d+$/.test(rule)) return [];
      // Documentation and benchmark corpora explain overrides using real ids.
      if (isProse(path)) return [];
      // The generated skill mirrors are byte-equal to their canonical source
      // (INV-19), so one marker in a skill script appeared three times and
      // cleared the "two or more occurrences" threshold on its own. A projection
      // is never the source: count the canonical path and drop the copies.
      if (isGeneratedMirror(path)) return [];
      return [{ path, line: Number(match[2]), rule, reason: marker[2].trim() }];
    }).slice(0, 500);
    if (records.length === 0) return [];
    // Attribution keys on the durable `done` refs, not on item branches, and on
    // each item's own narrow range rather than everything its tip can reach.
    //
    // The previous version asked `rev-list --first-parent <item-tip>`, which
    // returns the whole history the branch was cut from. Item branches are also
    // short-lived: this repo had run 20 deliveries and kept item branches for
    // one, so every marker in the repository was credited to that single
    // delivery. Where several survived, `deliveries[0]` after a sort awarded the
    // marker to whichever delivery name sorted first. The "across two or more
    // distinct deliveries" threshold cannot be evaluated on a field like that.
    //
    // `<done>^1..<done>` is the range hatch already treats as an item's own
    // commits, and `refs/hatch/` outlives the branches.
    const doneRefs = (await git(worktree, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)",
      "refs/hatch",
    ])).split("\n").filter(Boolean).flatMap((line) => {
      const [ref, tip] = line.split("\t");
      const match = ref.match(/^refs\/hatch\/([^/]+)\/item-[^/]+\/done$/);
      return match ? [{ delivery: match[1], tip }] : [];
    });
    const introducedBy = new Map<string, string>();
    for (const { delivery, tip } of doneRefs) {
      // A `done` with no second parent is an unmerged item tip; its own commit is
      // the range. allowFailure keeps a pruned or malformed ref from failing the
      // whole companion phase.
      const range = await git(worktree, ["rev-list", `${tip}^1..${tip}`], true) ||
        await git(worktree, ["rev-list", "-1", tip], true);
      for (const commit of range.split("\n").filter(Boolean)) {
        if (!introducedBy.has(commit)) introducedBy.set(commit, delivery);
      }
    }
    const commits = new Map<string, { date: string; delivery: string }>();
    const evidence: HatchOverrideEvidence[] = [];
    for (const record of records) {
      const blame = await git(worktree, [
        "blame",
        "--porcelain",
        `-L${record.line},${record.line}`,
        "HEAD",
        "--",
        record.path,
      ]);
      const commit = blame.split(/\s+/, 1)[0];
      let identity = commits.get(commit);
      if (!identity) {
        identity = {
          date: await git(worktree, ["show", "-s", "--format=%cs", commit]),
          // A marker whose commit belongs to no recorded item is honestly
          // unknown. Saying so beats naming a delivery that did not write it:
          // the threshold counts distinct deliveries, and a wrong name is a
          // miscount in the direction of acting.
          delivery: introducedBy.get(commit) ??
            (blastRadius.includes(record.path) ? binder : "unknown"),
        };
        commits.set(commit, identity);
      }
      evidence.push({
        ...record,
        commit,
        date: identity.date,
        delivery: identity.delivery,
        inBlastRadius: blastRadius.includes(record.path),
      });
    }
    return evidence;
  }

  async #runWriter(
    ctx: ExtensionContext,
    writer: HatchWriterRole,
    binder: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    processContext: ProcessContext,
    input: {
      diffRange: string;
      changedPaths: string[];
      focus?: string;
      packs?: HatchResolvedWriterPack[];
      migrationPacks?: HatchResolvedWriterPack[];
      overrideEvidence?: HatchOverrideEvidence[];
    },
  ): Promise<HatchWriterCommitResult> {
    if (!(await this.#locks.owns(lease))) throw new Error("Hatch companion writer requires the active binder lock lease");
    const config = await readConfig(integrationWorktree, writer);
    if (!config.enabled) return { role: writer, status: "disabled" };
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const base = await git(integrationWorktree, ["rev-parse", `${integrationRef}^{commit}`]);
    const root = await mkdtemp(join(tmpdir(), `hatch-${writer}-`));
    const worktree = join(root, "worktree");
    let registered = false;
    // The shared repository config and hooks folder before the writer ran, and
    // whether an authority refusal means they must be put back before the next
    // host git.
    let savedAuthority: RepositoryAuthorityBytes | undefined;
    let authorityBroken = false;
    // The refusal this run throws, so a restore failure can be attached to it.
    let refused: HatchWriterRefusedError | undefined;
    try {
      await git(integrationWorktree, ["worktree", "add", "--detach", worktree, base]);
      registered = true;
      savedAuthority = await captureRepositoryAuthority(worktree);
      await this.#checkpoint("writer-worktree-created", { role: writer });
      if (writer === "kaizen") await validatePacks(worktree, processContext, ctx.signal);
      const beforePacks = new Map<string, string>();
      if (writer === "kaizen") {
        for (const path of await listProjectPacks(worktree)) {
          beforePacks.set(basename(path), await readFile(path, "utf8"));
        }
      }
      const beforeIgnore = writer === "doc-gardner" && await exists(join(worktree, ".gitignore"))
        ? await readFile(join(worktree, ".gitignore"), "utf8")
        : undefined;
      const packs = [...(input.packs ?? []), ...(input.migrationPacks ?? [])];
      const collect = (result: HatchUnattestedWriterResult | HatchWriterResult, paths: string[]) =>
        collectWriterRefusals({
          writer,
          worktree,
          result,
          paths,
          beforePacks,
          beforeIgnore,
          packs,
          processContext,
          signal: ctx.signal,
        });
      const rounds: HatchWriterRefusalRound[] = [];
      // The host's authority over the worktree, attested against the snapshot
      // taken before the writer ran. It runs before any other host git, validator
      // or scan touches the worktree, so a hook or fsmonitor the writer
      // configured is caught before git could run it.
      let before: WorkerAuthoritySnapshot | undefined;
      let authorityRefusal: HatchWriterRefusal | undefined;
      const attestAuthority = async (): Promise<HatchWriterRefusal | null> => {
        if (authorityRefusal) return authorityRefusal;
        if (!before) throw new Error(`Hatch ${writer} authority was checked before its snapshot`);
        const after = await snapshotWorkerAuthority(worktree, undefined, undefined, { before });
        const attestation = attestWriterAuthority(writer, before, after);
        if (attestation.passed) return null;
        authorityBroken = true;
        authorityRefusal = authorityRefusalFor(`Hatch writer violated host authority: ${attestation.issues.join("; ")}`);
        return authorityRefusal;
      };
      // The host's review while the writer's session is still open. A refusal
      // the writer could have avoided restores the refused files and earns one
      // corrective turn; any refusal that means confinement or authority failed
      // returns null, and the hard check below decides.
      const review = async (draft: HatchUnattestedWriterResult): Promise<string | null> => {
        if (await attestAuthority()) return null;
        const paths = await changedPaths(worktree);
        const refusals = await collect(draft, paths);
        if (refusals.length === 0 || refusals.some((refusal) => !CORRECTABLE.has(refusal.code))) return null;
        const restored = uniqueStrings(refusals.flatMap((refusal) =>
          RESTORED.has(refusal.code) && refusal.path !== undefined ? [refusal.path] : []
        ));
        let plans: RestorePlan[];
        try {
          plans = await planRestores(worktree, base, restored);
        } catch (error) {
          if (!(error instanceof RestoreEscape)) throw error;
          throw new WriterRefusals([{ code: "restore-escape", path: error.path, message: error.message }]);
        }
        for (const plan of plans) await restoreToBase(worktree, plan);
        const kept = await changedPaths(worktree);
        if (restored.some((path) => kept.includes(path))) return null;
        rounds.push({ turn: 1, final: false, refusals: refusals.map(storedRefusal), paths, restored });
        return writerCorrectionPrompt(writer, refusals, restored, kept, {
          surfaces: projectPackSurfaces(beforePacks),
          declared: draft.role === "kaizen" ? draft.packsChanged : draft.filesChanged,
        });
      };
      // A host failure inside the review is the host's, not the writer's.
      let reviewFailure: unknown;
      const surfaceReview = async (draft: HatchUnattestedWriterResult): Promise<string | null> => {
        try {
          return await review(draft);
        } catch (error) {
          reviewFailure = error;
          throw error;
        }
      };
      // Everything from the writer's run to the ref update is inside this try,
      // so a refusal there is a writer outcome; one before it keeps the plain shape.
      let refUpdated = false;
      let parsed: HatchWriterResult | undefined;
      try {
        let result: HatchWriterResult;
        try {
          before = await snapshotWorkerAuthority(worktree);
          result = await this.#writers.run(
            ctx,
            writer,
            worktree,
            binder,
            { ...input, focus: config.focus, packs: input.packs },
            processContext.owner.id,
            surfaceReview,
          );
        } catch (error) {
          if (ctx.signal?.aborted || error === reviewFailure) throw error;
          if (authorityRefusal) throw new WriterRefusals([authorityRefusal]);
          if (error instanceof HatchWriterAuthorityError) {
            authorityBroken = true;
            throw new WriterRefusals([authorityRefusalFor(error.message)]);
          }
          // An error before the first prompt, or one that left nothing behind,
          // stays the plain error: there is no refusal and nothing to keep.
          if (rounds.length === 0 && (await changedPaths(worktree)).length === 0) throw error;
          const where = rounds.length > 0 ? " in its corrective turn" : "";
          throw new WriterRefusals([{
            code: "writer-error",
            message: `Hatch ${writer} writer failed${where}: ${errorMessage(error)}`,
          }]);
        }
        parsed = result;
        await this.#checkpoint("writer-returned", { role: writer });
        const broken = await attestAuthority();
        if (broken) throw new WriterRefusals([broken]);
        const paths = await changedPaths(worktree);
        const refusals = await collect(result, paths);
        if (refusals.length > 0) throw new WriterRefusals(refusals.map(storedRefusal));
        await this.#checkpoint("writer-surface-attested", { role: writer });
        const staging = await attestAuthority();
        if (staging) throw new WriterRefusals([staging]);
        await writerGit(worktree, ["add", "--all", "--", ...paths]);
        const unstaged = await writerGit(worktree, ["diff", "--name-only", "-z", "--"]);
        const untracked = await writerGit(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
        if (unstaged || untracked) throw new Error("Hatch writer left unattested changes after staging");
        const tree = await writerGit(worktree, ["write-tree"]);
        // The host staged the index itself, with the writer's session closed, so
        // that index is the baseline the later evidence capture attests against.
        before = await snapshotWorkerAuthority(worktree);
        await this.#checkpoint("writer-tree-staged", { role: writer, tree });
        await whitespaceCheck(writer, worktree, paths);
        try {
          await scanSecrets(worktree, base, processContext, ctx.signal);
        } catch (error) {
          if (ctx.signal?.aborted) throw error;
          throw new WriterRefusals([{ code: "secret-scan", message: errorMessage(error) }]);
        }
        await this.#checkpoint("writer-checks-passed", { role: writer, tree });
        const corrected = rounds.length > 0 ? { refusals: rounds } : {};
        if (writer === "kaizen" && paths.length === 0) {
          return { role: writer, status: "no-change", tree, result, ...corrected };
        }
        const message = writer === "doc-gardner"
          ? formatDocMessage(binder, input.diffRange, result as HatchDocGardnerResult)
          : formatKaizenMessage(binder, result as HatchKaizenResult);
        const hookValidation = await validateCandidateHooks({
          worktree,
          parent: base,
          candidateTree: tree,
          message,
          allowEmpty: paths.length === 0,
          signal: ctx.signal,
          onProcessStart: (pid) => processContext.manager.registerProcess(pid, {
            cwd: worktree,
            parentId: processContext.owner.id,
            label: `${writer} commit hooks`,
          }),
          onProcessExit: (pid) => processContext.manager.forgetProcess(pid),
        });
        if (hookValidation.status !== "passed" || hookValidation.hookTree !== tree) {
          throw new Error(`Hatch ${writer} commit hooks failed or changed the attested tree`);
        }
        const refinedMessage = hookValidation.message ?? message;
        const subject = refinedMessage.split("\n", 1)[0];
        if (
          (writer === "doc-gardner" && subject !== `docs: gardner ${binder}`) ||
          (writer === "kaizen" && !subject.startsWith("kaizen: "))
        ) {
          throw new Error(`Hatch ${writer} commit hook changed the required subject`);
        }
        await this.#checkpoint("writer-hooks-passed", { role: writer, tree });
        const commit = await writerGit(worktree, ["commit-tree", tree, "-p", base, "-m", refinedMessage]);
        await this.#checkpoint("writer-commit-created", { role: writer, commit, tree });
        await git(integrationWorktree, ["update-ref", integrationRef, commit, base]);
        refUpdated = true;
        await this.#checkpoint("writer-ref-updated", { role: writer, commit, tree });
        await git(integrationWorktree, ["read-tree", "--reset", "-u", commit]);
        await this.#checkpoint("writer-worktree-synced", { role: writer, commit, tree });
        return { role: writer, status: "committed", commit, tree, result, hookValidation, ...corrected };
      } catch (error) {
        // Once the writer has run and before the ref moves, a refusal keeps its
        // evidence: read it here, before `finally` removes the worktree.
        if (refUpdated || ctx.signal?.aborted) throw error;
        // No round, no envelope, no refusal and no changed path: nothing
        // happened that a refusal could describe, so the plain error stands.
        // The changed paths are read only once the host's authority holds.
        if (!(error instanceof WriterRefusals) && rounds.length === 0 && parsed === undefined) {
          if (before === undefined) throw error;
          const broken = await attestAuthority().catch(() => undefined);
          if (broken === undefined) throw error;
          if (broken === null && (await changedPaths(worktree).catch(() => [])).length === 0) throw error;
        }
        const refusals: HatchWriterRefusal[] = error instanceof WriterRefusals
          ? error.refusals
          : [{ code: "host-check", message: errorMessage(error) }];
        const final = await captureFinalRound(
          worktree,
          base,
          rounds.length > 0 ? 2 : 1,
          refusals,
          attestAuthority,
          processContext,
          ctx.signal,
        );
        refused = new HatchWriterRefusedError([...rounds, final], parsed);
        throw refused;
      }
    } finally {
      // A config or hook the writer changed is put back before any further
      // host git reads or runs it: the worktree removal here, and every later
      // phase. A failed restore never skips the removal, and it stops every
      // later phase: the error carries the refusal along with the failure.
      let restoreFailure: string | undefined;
      let nextStep = REPOSITORY_AUTHORITY_NEXT_STEP;
      if (authorityBroken && savedAuthority) {
        try {
          const restore = await restoreRepositoryAuthority(savedAuthority);
          if (refused && restore.notes.length > 0) refused.restoreNotes = restore.notes;
        } catch (error) {
          restoreFailure = `Hatch could not put back the repository config and hooks the ${writer} writer changed: ${errorMessage(error)}`;
          if (error instanceof RepositoryHooksChangedError) {
            nextStep = `Inspect the hooks folder ${error.root} by hand and remove any hook the writer added. ${REPOSITORY_AUTHORITY_NEXT_STEP}`;
          }
          if (refused) refused.restoreFailure = restoreFailure;
        }
      }
      if (registered) {
        await git(integrationWorktree, ["worktree", "remove", "--force", worktree], true);
      }
      await rm(root, { recursive: true, force: true });
      if (restoreFailure !== undefined) {
        throw new HatchRepositoryAuthorityError(writer, refused
          ? refusedResult(writer, refused)
          : { role: writer, status: "rejected", restoreFailure }, nextStep);
      }
    }
  }

  async #archive(
    ctx: ExtensionContext,
    binder: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    processContext: ProcessContext,
  ): Promise<{ status: "already-archived" | "committed"; commit: string }> {
    if (!(await this.#locks.owns(lease))) throw new Error("Hatch archive requires the active binder lock lease");
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const base = await git(integrationWorktree, ["rev-parse", `${integrationRef}^{commit}`]);
    const live = `.hatch/binders/${binder}.json`;
    const archived = `.hatch/binders/archive/${binder}.json`;
    if (!await exists(join(integrationWorktree, live))) {
      if (!await exists(join(integrationWorktree, archived))) throw new Error("Hatch binder is missing from live and archive paths");
      return { status: "already-archived", commit: base };
    }
    const root = await mkdtemp(join(tmpdir(), "hatch-archive-"));
    const worktree = join(root, "worktree");
    let registered = false;
    try {
      await git(integrationWorktree, ["worktree", "add", "--detach", worktree, base]);
      registered = true;
      await mkdir(join(worktree, ".hatch", "binders", "archive"), { recursive: true });
      await git(worktree, ["mv", live, archived]);
      const tree = await git(worktree, ["write-tree"]);
      await this.#checkpoint("archive-tree-staged", { tree });
      const message = `chore(hatch): archive binder ${binder} — delivered`;
      const hookValidation = await validateCandidateHooks({
        worktree,
        parent: base,
        candidateTree: tree,
        message,
        signal: ctx.signal,
        onProcessStart: (pid) => processContext.manager.registerProcess(pid, {
          cwd: worktree,
          parentId: processContext.owner.id,
          label: "archive commit hooks",
        }),
        onProcessExit: (pid) => processContext.manager.forgetProcess(pid),
      });
      if (hookValidation.status !== "passed" || hookValidation.hookTree !== tree) {
        throw new Error("Hatch archive hooks failed or changed the exact move tree");
      }
      const refined = hookValidation.message ?? message;
      if (refined.split("\n", 1)[0] !== message) throw new Error("Hatch archive hook changed the required subject");
      await this.#checkpoint("archive-hooks-passed", { tree });
      const commit = await git(worktree, ["commit-tree", tree, "-p", base, "-m", refined]);
      await this.#checkpoint("archive-commit-created", { commit, tree });
      await git(integrationWorktree, ["update-ref", integrationRef, commit, base]);
      await this.#checkpoint("archive-ref-updated", { commit, tree });
      await git(integrationWorktree, ["read-tree", "--reset", "-u", commit]);
      await this.#checkpoint("archive-worktree-synced", { commit, tree });
      return { status: "committed", commit };
    } finally {
      if (registered) await git(integrationWorktree, ["worktree", "remove", "--force", worktree], true);
      await rm(root, { recursive: true, force: true });
    }
  }

  async finishDelivery(
    ctx: ExtensionContext,
    binder: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    processContext: ProcessContext,
    options: { diffBase: string; sme: string[] },
  ): Promise<HatchCompanionResult> {
    const tip = await git(integrationWorktree, ["rev-parse", `refs/heads/hatch/${binder}/integration`]);
    const diffRange = `${options.diffBase}..${tip}`;
    const blastRadius = splitNul(await git(integrationWorktree, ["diff", "--name-only", "-z", options.diffBase, tip]));
    // A companion writer works in a throwaway worktree and touches the
    // integration ref only on its final update-ref, so a refusal leaves the
    // branch exactly as it was. Record it and carry on: the skill's contract is
    // that these phases never halt the delivery, and until now the code did.
    const optional = async (
      role: HatchWriterRole,
      run: () => Promise<HatchWriterCommitResult>,
    ): Promise<HatchWriterCommitResult> => {
      try {
        return await run();
      } catch (error) {
        // An abort is the operator stopping the run, not a writer misbehaving.
        // A repository the host could not put back stops every later phase.
        if (ctx.signal?.aborted || error instanceof HatchRepositoryAuthorityError) throw error;
        if (error instanceof HatchWriterRefusedError) return refusedResult(role, error);
        return {
          role,
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    };
    const docGardner = await optional("doc-gardner", () =>
      this.#runWriter(
        ctx,
        "doc-gardner",
        binder,
        integrationWorktree,
        lease,
        processContext,
        { diffRange, changedPaths: blastRadius },
      ));
    const packs = await this.#resolvePacks(integrationWorktree, options.sme);
    const migrationIds = (await listProjectPacks(integrationWorktree))
      .map((path) => basename(path, ".md"));
    const migrationPacks = await this.#resolvePacks(integrationWorktree, migrationIds);
    const overrideEvidence = await this.#overrideEvidence(integrationWorktree, binder, blastRadius);
    const kaizen = await optional("kaizen", () =>
      this.#runWriter(
        ctx,
        "kaizen",
        binder,
        integrationWorktree,
        lease,
        processContext,
        { diffRange, changedPaths: blastRadius, packs, migrationPacks, overrideEvidence },
      ));
    const archive = await this.#archive(ctx, binder, integrationWorktree, lease, processContext);
    return { schema: "hatch-companions-v1", docGardner, kaizen, archive };
  }
}
