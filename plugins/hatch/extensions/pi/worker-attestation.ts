import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during worker attestation`);
  }
}

async function gitOptional(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    const result = await exec("git", ["-C", cwd, ...args], {
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

export async function snapshotWorkerAuthority(
  worktree: string,
  binder?: string,
  waveMates?: readonly string[],
): Promise<WorkerAuthoritySnapshot> {
  const physical = await realpath(worktree);
  const [branch, head, index, refs, localConfig, worktreeConfig, registry, protectedPaths, hooks] =
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
      git(physical, ["config", "--local", "--null", "--list", "--show-origin"]),
      worktreeConfigIdentity(physical),
      git(physical, ["worktree", "list", "--porcelain"]),
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
    config: hash(`${localConfig}\0${worktreeConfig}`),
    hooks,
    worktrees: hash(
      binder ? excludeMateWorktrees(registry, mateBranchRefs(binder, mates)) : registry,
    ),
    protectedPaths: hash(protectedPaths),
    siblings,
    mates: mateSurfaces,
  };
}

function authorityIssues(
  before: WorkerAuthoritySnapshot,
  after: WorkerAuthoritySnapshot,
): string[] {
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
  for (const mate of mateIds(before, after)) {
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
  for (const mate of mateIds(before, after)) {
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
