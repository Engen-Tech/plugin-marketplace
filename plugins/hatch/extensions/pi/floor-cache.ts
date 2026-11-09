import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { binderDir, safeName } from "./gate-attempts.ts";
import { resolveHatchScript } from "./script-catalog.ts";
import { hostGitArgs } from "./worker-attestation.ts";
import { checkProposalsViolation, type HatchWorkerCheckProposal } from "./worker-runner.ts";

// The floor command cache: one file per item beside the gate-attempt ledger, at
// <git-common-dir>/hatch/attempts/<binder>/<item>.floor.json, so Clear removes it with the
// ledger folder. It holds the commands a worker proposed, verbatim and in order, never a
// result: the host reruns them at every site. A miss, a mismatch or an unreadable file
// means a worker is asked, which is what happens with no cache at all, and no function
// here throws, so the cache never halts anything.
//
// It is ordinary files, not tamper-proof, like the ledger.
// Any shell in the clone can write one, a worker's included: worker attestation does not
// cover <git-common-dir>/hatch/, and the host honours a valid file without asking who wrote
// it. A shorter list then drops a check: the command left out never runs for that item, at
// a recovery, an Accept or a merge. No signature guards this.
//
// A list is bound to the item spec digest and to the item tip's tree, not to a merge tree,
// because discovery has always run on the item branch. The file also keeps the merge base
// the tree was recorded on, because the current tip's base moves when integration is merged
// into the item. The same tree is identity by content. A hand fix moves the tree, and
// handFixApplies then decides whether the list still fits. That is a judgement, not
// identity, and this is what it cannot detect:
//
// cannot detect, H1: a hand fix adds an entry point inside a file FLOOR_SENSITIVE passes,
// which means a code, script or text file with no project name, such as tasks.py,
// scripts/test.sh or a plain notes.txt, or a project file the list does not name. A worker
// would propose the command; the reused list lacks it, and only the binder oracle or the
// gates can notice. Files FLOOR_SENSITIVE names, such as deno.jsonc, setup.py,
// CMakeLists.txt, vite.config.ts or a CI workflow, are not in this class.
// cannot detect, H2: the list was thin. An implement worker proposes what it used, and a
// recover worker is asked for the complete list, so a fresh sample might add a command.
// That thin list is reused as it was.

const exec = promisify(execFile);
const SCHEMA = "hatch-floor-cache-v1";
const KEYS = ["base", "binder", "checks", "item", "item_spec_sha256", "recorded_at", "schema", "tree"];
// The same limit as MAX_WORKER_CHECKS in worker-runner.ts: a longer list was never proposed.
const MAX_CHECKS = 16;
// Measured in bytes of the whole file, the size the halt record is capped at.
const MAX_FILE_BYTES = 16 * 1024;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// A hand fix keeps the list only when every changed path is a code or test file. A path
// misses by name (what the worker reads to choose a floor, and common runners and build
// entry points), by
// having no extension (Makefile, Dockerfile, BUILD, a dotfile), or by a data or config
// format. A false miss costs one worker run, which is the cost with no cache, while a false
// hit reruns a stale list, so a .json test fixture missing here is intended.
const FLOOR_SENSITIVE = {
  names: /^(agents\.md|claude\.md|package\.json|pyproject\.toml|.*requirements.*\.txt|constraints.*\.txt|go\.mod|go\.sum|cargo\.toml|gemfile|composer\.json|makefile|makefile\..+|dockerfile\..+|justfile|taskfile\.yml|tox\.ini|noxfile\.py|setup\.py|fabfile\.py|gulpfile\.[cm]?[jt]s|karma\.conf\.[cm]?[jt]s|mix\.exs|build\.zig|build\.sbt|conftest\.py|__init__\.py|build\.rs|cmakelists\.txt|meson\.build|\.env\..+|.+\.config\.[cm]?[jt]sx?)$/i,
  formats: new Set([
    ".json", ".jsonc", ".json5", ".toml", ".yml", ".yaml", ".ini", ".cfg", ".conf", ".xml",
    ".lock", ".mk", ".bazel", ".bzl", ".gradle", ".kts", ".properties",
    ".cmake", ".nix", ".tf", ".tfvars", ".hcl", ".csproj", ".fsproj", ".sln", ".gemspec", ".cabal", ".dockerfile",
  ]),
};

export type HatchFloorCacheLookup =
  | { hit: true; checks: HatchWorkerCheckProposal[]; match: "same-tree" | "hand-fix" }
  | { hit: false; reason: "no-file" | "unreadable" | "other-spec" | "other-tree" };

interface FloorCacheTarget {
  binder: string;
  item: string;
  specDigest: string;
  tree: string;
}

// The two refs whose merge base the file keeps: what the item had changed when it was stored.
interface FloorCacheOrigin {
  integrationRef: string;
  itemRef: string;
}

interface FloorCacheFile {
  item_spec_sha256: string;
  tree: string;
  base: string;
  checks: HatchWorkerCheckProposal[];
}

async function floorFile(repoRoot: string, binder: string, item: string): Promise<string> {
  return join(await binderDir(repoRoot, binder), `${safeName("item", item)}.floor.json`);
}

// A file that fails here must never reach a check plan: validatePlan throws on a malformed
// entry, which would end the run.
function parseFile(bytes: Buffer, binder: string, item: string): FloorCacheFile | undefined {
  if (bytes.byteLength > MAX_FILE_BYTES) return undefined;
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const file = value as Record<string, unknown>;
  const valid =
    Object.keys(file).sort().join() === KEYS.join() &&
    file.schema === SCHEMA &&
    file.binder === binder &&
    file.item === item &&
    typeof file.item_spec_sha256 === "string" && /^[0-9a-f]{64}$/.test(file.item_spec_sha256) &&
    typeof file.tree === "string" && OBJECT_ID.test(file.tree) &&
    typeof file.base === "string" && OBJECT_ID.test(file.base) &&
    typeof file.recorded_at === "string" &&
    Array.isArray(file.checks) && file.checks.length > 0 && file.checks.length <= MAX_CHECKS &&
    checkProposalsViolation(file.checks) === null;
  return valid ? (file as unknown as FloorCacheFile) : undefined;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", hostGitArgs(repoRoot, args), { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT });
  return stdout;
}

export function floorSensitive(path: string): boolean {
  const name = posix.basename(path);
  const extension = posix.extname(name).toLowerCase();
  return FLOOR_SENSITIVE.names.test(name) || extension === "" || FLOOR_SENSITIVE.formats.has(extension);
}

// T3: every changed path is a modification (a, so an added package misses), of a file the
// item already changed (b, because a list fits what it was proposed for), and none is
// floor-sensitive (c). Any git error is a miss.
async function handFixApplies(
  repoRoot: string,
  { tree: recorded, base }: FloorCacheFile,
  current: string,
): Promise<boolean> {
  try {
    const entries = (await git(repoRoot, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", recorded, current]))
      .split("\0").slice(0, -1);
    const changed: string[] = [];
    for (let index = 0; index < entries.length; index += 2) {
      if (entries[index] !== "M") return false;
      changed.push(entries[index + 1]);
    }
    const own = new Set(
      (await git(repoRoot, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", base, recorded])).split("\0"),
    );
    return changed.length > 0 && changed.every((path) => own.has(path) && !floorSensitive(path));
  } catch {
    return false;
  }
}

export async function lookupFloorCache(
  repoRoot: string,
  target: FloorCacheTarget & { handFix?: boolean },
): Promise<HatchFloorCacheLookup> {
  let file: FloorCacheFile | undefined;
  try {
    const bytes = await readFile(await floorFile(repoRoot, target.binder, target.item));
    file = parseFile(bytes, target.binder, target.item);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hit: false, reason: "no-file" };
    return { hit: false, reason: "unreadable" };
  }
  if (!file) return { hit: false, reason: "unreadable" };
  if (file.item_spec_sha256 !== target.specDigest) return { hit: false, reason: "other-spec" };
  if (file.tree === target.tree) return { hit: true, checks: file.checks, match: "same-tree" };
  if (target.handFix && (await handFixApplies(repoRoot, file, target.tree))) {
    return { hit: true, checks: file.checks, match: "hand-fix" };
  }
  return { hit: false, reason: "other-tree" };
}

// Writes the list only when it is one a lookup would accept and it passes the secret scan.
// A list that fails is not written at all: a marker in place of a command would be a command
// that runs. Any failure leaves no file, which is a miss. The rename means a reader sees
// the old file or the new one, never a torn one.
export async function recordFloorCache(
  repoRoot: string,
  { binder, item, specDigest, tree, integrationRef, itemRef }: FloorCacheTarget & FloorCacheOrigin,
  checks: readonly HatchWorkerCheckProposal[],
): Promise<void> {
  if (checks.length === 0 || checks.length > MAX_CHECKS || checkProposalsViolation([...checks]) !== null) return;
  let temp: string | undefined;
  try {
    const file = await floorFile(repoRoot, binder, item);
    const base = (await git(repoRoot, ["merge-base", integrationRef, itemRef])).trim();
    const text = `${JSON.stringify({
      schema: SCHEMA,
      binder,
      item,
      item_spec_sha256: specDigest,
      tree,
      base,
      recorded_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      checks,
    }, null, 2)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return;
    await mkdir(dirname(file), { recursive: true });
    temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, text);
    await exec("uv", ["run", "--script", resolveHatchScript("scanSecrets"), "--file", temp], { cwd: repoRoot });
    await rename(temp, file);
    temp = undefined;
  } catch {
    // A miss on the next lookup.
  } finally {
    if (temp) await rm(temp, { force: true }).catch(() => {});
  }
}

export async function dropFloorCache(repoRoot: string, binder: string, item: string): Promise<void> {
  try {
    await rm(await floorFile(repoRoot, binder, item), { recursive: true, force: true });
  } catch {
    // A file that cannot be removed still has to match the spec and the tree to be read.
  }
}
