import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { captureMateSurface, type WaveHostLedger } from "./wave-host-ledger.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 16 * 1024 * 1024;
const MAX_HOOK_FILES = 256;
const MAX_HOOK_BYTES = 2 * 1024 * 1024;

export interface WorkerAuthoritySnapshot {
  schema: "hatch-worker-authority-snapshot-v1";
  worktree: string;
  branch: string;
  head: string;
  index: string;
  refs: string;
  config: string;
  hooks: string;
  worktrees: string;
  protectedPaths: string;
  siblings: string;
  mates: Record<string, string>;
  // Set when the config no longer matched the baseline the snapshot was taken
  // against. The snapshot then stopped after reading the config, so every field
  // but `config` is unread and holds an empty string.
  unread?: "config-changed";
}

export interface WorkerAuthorityAttestation {
  schema: "hatch-worker-authority-attestation-v1";
  passed: boolean;
  issues: string[];
  before: WorkerAuthoritySnapshot;
  after: WorkerAuthoritySnapshot;
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

// Every host git call aimed at a worktree a child could write to runs with
// these: command-line config wins over every config file, so no fsmonitor
// command or hook the child configured runs. System config still applies, so a
// system-level safe.directory keeps working; a child cannot write that file.
export const HOST_GIT_CONFIG: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

export function hostGitArgs(cwd: string, args: readonly string[]): string[] {
  return ["-C", cwd, ...HOST_GIT_CONFIG, ...args];
}

// A config read keeps the plain invocation: the override would read back as the
// configured hooks path, and the snapshot must see what the repository holds.
function gitInvocation(cwd: string, args: string[]): string[] {
  return args[0] === "config" ? ["-C", cwd, ...args] : hostGitArgs(cwd, args);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const argv = gitInvocation(cwd, args);
    const { stdout } = await exec("git", argv, {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during worker attestation`);
  }
}

const LISTING_RACE = /failed to read '\.git\/worktrees\/[^']*\/locked'/;
const LISTING_RETRY_MS = [50, 150];

// `git worktree list` dies when a wave-mate's worktree entry loses its `locked`
// file between git's existence check and its read. Retry only that listing and
// only that error, at most three attempts, then rethrow the last error unchanged.
async function worktreeList(cwd: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await git(cwd, ["worktree", "list", "--porcelain"]);
    } catch (error) {
      if (attempt >= LISTING_RETRY_MS.length || !LISTING_RACE.test((error as Error).message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, LISTING_RETRY_MS[attempt]));
    }
  }
}

async function gitOptional(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    const argv = gitInvocation(cwd, args);
    const result = await exec("git", argv, {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    }).catch((failure) => failure as { code?: number; stderr?: string });
    if ((result as { code?: number }).code === 1) return "";
    throw error;
  }
}

async function worktreeConfigIdentity(worktree: string): Promise<string> {
  const enabled = (await gitOptional(worktree, [
    "config",
    "--local",
    "--bool",
    "--get",
    "extensions.worktreeConfig",
  ])).trim();
  if (!enabled || enabled === "false") return "worktree-config-disabled";
  if (enabled !== "true") throw new Error("Git returned an invalid extensions.worktreeConfig value");
  return git(worktree, ["config", "--worktree", "--null", "--list", "--show-origin"]);
}

async function hooksRoot(worktree: string): Promise<string> {
  const configured = (await gitOptional(worktree, ["config", "--path", "--get", "core.hooksPath"])).trim();
  if (configured) return isAbsolute(configured) ? configured : resolve(worktree, configured);
  const common = (await git(worktree, ["rev-parse", "--git-common-dir"])).trim();
  return resolve(worktree, common, "hooks");
}

async function hashHookTree(root: string): Promise<string> {
  const records: string[] = [];
  let files = 0;
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const repoPath = relative(root, path).replaceAll("\\", "/");
      const stat = await lstat(path);
      if (entry.isDirectory()) {
        records.push(`d\0${repoPath}\0${stat.mode.toString(8)}`);
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        records.push(`l\0${repoPath}\0${await readlink(path)}`);
      } else if (entry.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > MAX_HOOK_FILES || bytes > MAX_HOOK_BYTES) {
          throw new Error("Hatch hook identity exceeds the attestation bound");
        }
        records.push(`f\0${repoPath}\0${stat.mode.toString(8)}\0${hash(await readFile(path))}`);
      } else {
        records.push(`o\0${repoPath}\0${stat.mode.toString(8)}`);
      }
    }
  }
  await visit(root);
  return hash(records.join("\n"));
}

function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

async function siblingIdentity(
  worktree: string,
  registry: string,
  binder?: string,
  mates?: readonly string[],
): Promise<string> {
  const current = await realpath(worktree);
  // Wave-mates are captured separately as their own surface (`mates`), because
  // the host authors their refs and worktree while the wave is in flight. Every
  // other sibling — foreign worktrees, other/prior-wave item worktrees, stale
  // leftovers — keeps full HEAD, branch, and status checking, so a worker
  // reaching outside its concurrent batch is caught.
  const mateBranches = binder && mates && mates.length > 0
    ? new Set(mates.map((id) => `hatch/${binder}/item-${id}`))
    : undefined;
  const records: string[] = [];
  for (const path of worktreePaths(registry).sort()) {
    let physical: string;
    try {
      physical = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        records.push(`${path}\0missing`);
        continue;
      }
      throw error;
    }
    if (physical === current) continue;
    const [head, branch, status] = await Promise.all([
      git(path, ["rev-parse", "HEAD"]),
      git(path, ["branch", "--show-current"]),
      git(path, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    ]);
    if (mateBranches?.has(branch.trim())) continue;
    records.push(`${physical}\0${head.trim()}\0${branch.trim()}\0${hash(status)}`);
  }
  return hash(records.join("\n"));
}

function mateRefPrefixes(binder: string, mates: readonly string[]): string[] {
  return mates.flatMap((id) => [
    `refs/heads/hatch/${binder}/item-${id}`,
    `refs/hatch/${binder}/item-${id}`,
  ]);
}

function mateBranchRefs(binder: string, mates: readonly string[]): Set<string> {
  return new Set(mates.map((id) => `refs/heads/hatch/${binder}/item-${id}`));
}

/** Drop mate refs — the host owns their churn — from the protected-refs hash. */
function excludeMateRefs(refs: string, prefixes: readonly string[]): string {
  if (prefixes.length === 0) return refs;
  return refs
    .split("\n")
    .filter((line) => {
      const ref = line.split("\0")[0];
      return !prefixes.some((prefix) => ref === prefix || ref.startsWith(`${prefix}/`));
    })
    .join("\n");
}

/** Split a `git worktree list --porcelain` listing into its per-worktree blocks. */
function porcelainBlocks(porcelain: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

/** Drop mate worktree blocks — the host adds their checkouts mid-wave. */
function excludeMateWorktrees(porcelain: string, branchRefs: ReadonlySet<string>): string {
  if (branchRefs.size === 0) return porcelain;
  return porcelainBlocks(porcelain)
    .filter((block) => {
      const branch = block.split("\n").find((line) => line.startsWith("branch "));
      return !(branch && branchRefs.has(branch.slice("branch ".length)));
    })
    .join("\n\n");
}

async function captureMateSurfaces(
  repository: string,
  binder: string | undefined,
  mates: readonly string[],
): Promise<Record<string, string>> {
  const surfaces: Record<string, string> = {};
  if (!binder || mates.length === 0) return surfaces;
  for (const mate of mates) surfaces[mate] = await captureMateSurface(repository, binder, mate);
  return surfaces;
}

// The repository config file and hooks folder exactly as they were before a
// child ran, bytes and modes, so that what the child changed can be put back
// before any further host git reads the config or runs a hook. It stays out of
// the snapshot: a config can hold credentials, and the snapshot travels with
// the attestation.
type HookEntry =
  | { kind: "file"; bytes: Buffer; mode: number }
  | { kind: "link"; target: string }
  | { kind: "dir"; mode: number };

export interface RepositoryAuthorityBytes {
  config: { path: string; bytes: Buffer | null; mode: number };
  // `real` is the root's real path when it was captured. A root outside the
  // repository's common git folder, such as a global core.hooksPath, is never
  // captured or restored: `outside` is set and the entries are empty.
  // For a root outside the repository only its identity hash is kept, so a
  // change there can be told apart from no change.
  hooks: {
    root: string;
    real: string;
    outside: boolean;
    exists: boolean;
    entries: Map<string, HookEntry>;
    hash?: string;
  };
}

// The hooks folder outside the repository changed while the child ran. The
// host does not write there, so a person has to look at it.
export class RepositoryHooksChangedError extends Error {
  readonly root: string;

  constructor(root: string) {
    super(`the hooks folder ${root} is outside the repository and changed while the writer ran, so Hatch did not put it back`);
    this.name = "RepositoryHooksChangedError";
    this.root = root;
  }
}

export interface RepositoryAuthorityRestore {
  changed: boolean;
  notes: string[];
}

async function readOptional(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function lstatOptional(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Every entry below the hooks root, read with lstat so no link is followed,
// within the same bound the authority snapshot holds the hooks to.
async function readHookEntries(root: string): Promise<{ exists: boolean; entries: Map<string, HookEntry> }> {
  const entries = new Map<string, HookEntry>();
  if (!(await lstatOptional(root))) return { exists: false, entries };
  let files = 0;
  let bytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const key = relative(root, path);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        entries.set(key, { kind: "link", target: await readlink(path) });
      } else if (stat.isDirectory()) {
        entries.set(key, { kind: "dir", mode: stat.mode & 0o7777 });
        await visit(path);
      } else {
        files += 1;
        bytes += stat.size;
        if (files > MAX_HOOK_FILES || bytes > MAX_HOOK_BYTES) {
          throw new Error("Hatch hook identity exceeds the attestation bound");
        }
        entries.set(key, { kind: "file", bytes: await readFile(path), mode: stat.mode & 0o7777 });
      }
    }
  }
  await visit(root);
  return { exists: true, entries };
}

function sameEntry(left: HookEntry | undefined, right: HookEntry | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "link") return left.target === (right as typeof left).target;
  if (left.kind === "dir") return left.mode === (right as typeof left).mode;
  const other = right as typeof left;
  return left.mode === other.mode && left.bytes.equals(other.bytes);
}

export async function captureRepositoryAuthority(worktree: string): Promise<RepositoryAuthorityBytes> {
  const physical = await realpath(worktree);
  const common = (await git(physical, ["rev-parse", "--git-common-dir"])).trim();
  const path = resolve(physical, common, "config");
  const stat = await lstatOptional(path);
  const root = await hooksRoot(physical);
  const realCommon = await realpath(resolve(physical, common));
  const real = await realOrPlanned(root);
  const outside = !real.startsWith(`${realCommon}${sep}`);
  return {
    config: { path, bytes: await readOptional(path), mode: stat ? stat.mode & 0o7777 : 0o644 },
    hooks: outside
      ? { root, real, outside, exists: false, entries: new Map(), hash: await hashHookTree(root) }
      : { root, real, outside, ...(await readHookEntries(root)) },
  };
}

// The real path of a folder, or of where it would be when it does not exist yet.
async function realOrPlanned(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await realOrPlanned(dirname(path)), basename(path));
  }
}

// The new file is written beside the config and renamed over it, with the
// config's own mode, so a link planted at the config path is replaced rather
// than written through and an owner-only config stays owner-only.
async function restoreConfigFile(saved: RepositoryAuthorityBytes["config"]): Promise<boolean> {
  const stat = await lstatOptional(saved.path);
  if (stat && !stat.isSymbolicLink() && (stat.mode & 0o7777) === saved.mode) {
    const current = await readOptional(saved.path);
    if (current !== null && saved.bytes !== null && current.equals(saved.bytes)) return false;
  }
  if (!stat && saved.bytes === null) return false;
  if (saved.bytes === null) {
    await rm(saved.path, { force: true });
    return true;
  }
  const staged = join(dirname(saved.path), `config.hatch-restore-${process.pid}-${Date.now()}`);
  await writeFile(staged, saved.bytes, { flag: "wx", mode: saved.mode });
  try {
    await chmod(staged, saved.mode);
    await rename(staged, saved.path);
  } catch (error) {
    await rm(staged, { force: true });
    throw error;
  }
  return true;
}

async function restoreHooks(saved: RepositoryAuthorityBytes["hooks"]): Promise<boolean> {
  // The root itself first: a link or a non-folder there is removed as one
  // entry, never recursed into, and the folder is made again. Nothing below the
  // root is read, removed or written until its real path is the captured one.
  const rootStat = await lstatOptional(saved.root);
  let rootChanged = false;
  if (rootStat && (rootStat.isSymbolicLink() || !rootStat.isDirectory())) {
    await rm(saved.root);
    rootChanged = true;
  }
  if (!saved.exists) return rootChanged || (await removeRoot(saved));
  if (rootChanged || !rootStat) {
    await mkdir(saved.root);
    rootChanged = true;
  }
  if ((await realpath(saved.root)) !== saved.real) {
    throw new Error(`Hatch could not put back the hooks folder: ${saved.root} no longer resolves to ${saved.real}`);
  }
  return (await restoreHookEntries(saved)) || rootChanged;
}

// A hooks folder that did not exist before the child ran is removed again.
async function removeRoot(saved: RepositoryAuthorityBytes["hooks"]): Promise<boolean> {
  if (!(await lstatOptional(saved.root))) return false;
  await rm(saved.root, { recursive: true, force: true });
  return true;
}

async function restoreHookEntries(saved: RepositoryAuthorityBytes["hooks"]): Promise<boolean> {
  const current = await readHookEntries(saved.root);
  const changed = current.entries.size !== saved.entries.size ||
    [...saved.entries].some(([key, entry]) => !sameEntry(entry, current.entries.get(key)));
  if (!changed) return false;
  // Remove what the child added or changed, deepest first; nothing is followed.
  for (const key of [...current.entries.keys()].sort().reverse()) {
    const entry = current.entries.get(key);
    const wanted = saved.entries.get(key);
    if (wanted && sameEntry(entry, wanted)) continue;
    if (wanted?.kind === "dir" && entry?.kind === "dir") continue;
    await rm(join(saved.root, key), { recursive: true, force: true });
  }
  // Put back what was there, shallowest first, with its mode.
  for (const key of [...saved.entries.keys()].sort()) {
    const entry = saved.entries.get(key) as HookEntry;
    const path = join(saved.root, key);
    if (sameEntry(entry, current.entries.get(key))) continue;
    if (entry.kind === "dir") {
      await mkdir(path, { recursive: true });
      await chmod(path, entry.mode);
    } else if (entry.kind === "link") {
      await symlink(entry.target, path);
    } else {
      await writeFile(path, entry.bytes, { flag: "wx", mode: entry.mode });
      await chmod(path, entry.mode);
    }
  }
  return true;
}

/**
 * Put the config and the hooks folder back. A hooks folder outside the
 * repository is never written: unchanged, the result says it was left as it
 * is; changed, the restore fails with RepositoryHooksChangedError.
 */
export async function restoreRepositoryAuthority(saved: RepositoryAuthorityBytes): Promise<RepositoryAuthorityRestore> {
  const config = await restoreConfigFile(saved.config);
  if (saved.hooks.outside) {
    if ((await hashHookTree(saved.hooks.root)) !== saved.hooks.hash) {
      throw new RepositoryHooksChangedError(saved.hooks.root);
    }
    return {
      changed: config,
      notes: [`The hooks folder ${saved.hooks.root} was not restored because it is outside the repository.`],
    };
  }
  return { changed: (await restoreHooks(saved.hooks)) || config, notes: [] };
}

/**
 * Snapshot the host's authority over a worktree. With `options.before`, the
 * config is read and compared first: when it changed, the snapshot stops there,
 * so no `status` or other host git runs under a config a child chose — a clean
 * filter or other command it configured never runs on the host.
 */
export async function snapshotWorkerAuthority(
  worktree: string,
  binder?: string,
  waveMates?: readonly string[],
  options: { before?: WorkerAuthoritySnapshot } = {},
): Promise<WorkerAuthoritySnapshot> {
  const physical = await realpath(worktree);
  const [localConfig, worktreeConfig] = await Promise.all([
    git(physical, ["config", "--local", "--null", "--list", "--show-origin"]),
    worktreeConfigIdentity(physical),
  ]);
  const config = hash(`${localConfig}\0${worktreeConfig}`);
  if (options.before && options.before.config !== config) {
    return {
      schema: "hatch-worker-authority-snapshot-v1",
      worktree: physical,
      branch: "",
      head: "",
      index: "",
      refs: "",
      config,
      hooks: "",
      worktrees: "",
      protectedPaths: "",
      siblings: "",
      mates: {},
      unread: "config-changed",
    };
  }
  const [branch, head, index, refs, registry, protectedPaths, hooks] =
    await Promise.all([
      git(physical, ["branch", "--show-current"]),
      git(physical, ["rev-parse", "HEAD"]),
      git(physical, ["ls-files", "--stage", "-v", "-z"]),
      git(physical, [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(objecttype)",
        "refs/heads/hatch",
        "refs/hatch",
        "refs/tags",
      ]),
      worktreeList(physical),
      git(physical, [
        "status",
        "--porcelain=v2",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--",
        ".hatch",
      ]),
      hooksRoot(physical).then(hashHookTree),
    ]);
  // Own item comes from the branch the worker was dispatched on; every other
  // wave-mate is tracked as its own surface instead of a shared repo surface.
  const branchName = branch.trim();
  const ownItem = binder && branchName.startsWith(`hatch/${binder}/item-`)
    ? branchName.slice(`hatch/${binder}/item-`.length)
    : undefined;
  const mates = binder && waveMates && ownItem
    ? waveMates.filter((id) => id !== ownItem)
    : [];
  const [siblings, mateSurfaces] = await Promise.all([
    siblingIdentity(physical, registry, binder, mates),
    captureMateSurfaces(physical, binder, mates),
  ]);
  return {
    schema: "hatch-worker-authority-snapshot-v1",
    worktree: physical,
    branch: branchName,
    head: head.trim(),
    index: hash(index),
    refs: hash(excludeMateRefs(refs, binder ? mateRefPrefixes(binder, mates) : [])),
    config,
    hooks,
    worktrees: hash(
      binder ? excludeMateWorktrees(registry, mateBranchRefs(binder, mates)) : registry,
    ),
    protectedPaths: hash(protectedPaths),
    siblings,
    mates: mateSurfaces,
  };
}

const CONFIG_CHANGED = "worker changed protected authority surface: config";

function authorityIssues(
  before: WorkerAuthoritySnapshot,
  after: WorkerAuthoritySnapshot,
): string[] {
  // A snapshot that stopped at a changed config read nothing else, so the
  // config is the one finding it can stand behind.
  if (before.unread || after.unread) return [CONFIG_CHANGED];
  const issues: string[] = [];
  const fields: Array<Exclude<keyof WorkerAuthoritySnapshot, "mates">> = [
    "worktree",
    "branch",
    "head",
    "index",
    "refs",
    "config",
    "hooks",
    "worktrees",
    "protectedPaths",
    "siblings",
  ];
  for (const field of fields) {
    if (before[field] !== after[field]) issues.push(`worker changed protected authority surface: ${field}`);
  }
  return issues;
}

function mateIds(before: WorkerAuthoritySnapshot, after: WorkerAuthoritySnapshot): string[] {
  return [...new Set([...Object.keys(before.mates), ...Object.keys(after.mates)])].sort();
}

export function attestWorkerAuthority(
  before: WorkerAuthoritySnapshot,
  after: WorkerAuthoritySnapshot,
): WorkerAuthorityAttestation {
  const issues = authorityIssues(before, after);
  const mates = before.unread || after.unread ? [] : mateIds(before, after);
  for (const mate of mates) {
    if (before.mates[mate] !== after.mates[mate]) {
      issues.push(`worker changed protected authority surface: wave-mate ${mate}`);
    }
  }
  return {
    schema: "hatch-worker-authority-attestation-v1",
    passed: issues.length === 0,
    issues,
    before,
    after,
  };
}

/**
 * Like `attestWorkerAuthority`, but a mate surface the host itself authored
 * during the wave is reconciled against the ledger's record for that item.
 * Anything a worker moved on a mate's behalf outside a host phase matches no
 * record and still fails.
 */
export async function attestWaveWorkerAuthority(
  before: WorkerAuthoritySnapshot,
  after: WorkerAuthoritySnapshot,
  ledger: WaveHostLedger,
): Promise<WorkerAuthorityAttestation> {
  const issues = authorityIssues(before, after);
  const mates = before.unread || after.unread ? [] : mateIds(before, after);
  for (const mate of mates) {
    if (before.mates[mate] === after.mates[mate]) continue;
    if (after.mates[mate] !== undefined && after.mates[mate] === ledger.record(mate)) continue;
    issues.push(`worker changed protected authority surface: wave-mate ${mate}`);
  }
  return {
    schema: "hatch-worker-authority-attestation-v1",
    passed: issues.length === 0,
    issues,
    before,
    after,
  };
}
