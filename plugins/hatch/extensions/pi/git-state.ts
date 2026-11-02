import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostGitArgs } from "./worker-attestation.ts";

const exec = promisify(execFile);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;

export type HatchItemRecoveryState =
  | "not-started"
  | "branch-only"
  | "worktree-dirty"
  | "committed-unmarked"
  | "built"
  | "failed"
  | "failed-superseded"
  | "merged-unmarked"
  | "accept-merge-pending"
  | "accept-ref-pending"
  | "done"
  | "inconsistent";

export interface HatchItemGitState {
  binder: string;
  item: string;
  state: HatchItemRecoveryState;
  nextAction: string;
  objectFormat: "sha1" | "sha256";
  nullObjectId: string;
  integrationRef: string;
  integrationTip?: string;
  itemRef: string;
  itemTip?: string;
  worktree?: string;
  mergeCommit?: string;
  dirty: {
    staged: boolean;
    unstaged: boolean;
    untracked: boolean;
  };
  refs: {
    built?: string;
    failed?: string;
    done?: string;
    accepted?: string;
  };
  diagnostics: string[];
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function gitResult(cwd: string, args: string[]): Promise<GitResult> {
  try {
    // Read-only, and run with the hardened options: a hook or fsmonitor a
    // writer planted in the repository config runs nothing here.
    const { stdout, stderr } = await exec("git", hostGitArgs(cwd, args), {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const value = error as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof value.code === "number") {
      return { code: value.code, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
    }
    throw error;
  }
}

function gitFailure(args: string[], result: GitResult): Error {
  return new Error(result.stderr.trim() || `git ${args[0] ?? "command"} failed with ${result.code}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitResult(cwd, args);
  if (result.code !== 0) throw gitFailure(args, result);
  return result.stdout;
}

async function referenceSnapshot(cwd: string): Promise<Map<string, string>> {
  const shown = await gitResult(cwd, ["show-ref"]);
  if (shown.code === 1 && !shown.stderr.trim()) return new Map();
  if (shown.code !== 0) throw gitFailure(["show-ref"], shown);
  const refs = new Map<string, string>();
  for (const line of shown.stdout.split("\n").filter(Boolean)) {
    const separator = line.indexOf(" ");
    if (separator <= 0) throw new Error("git show-ref returned malformed output");
    refs.set(line.slice(separator + 1), line.slice(0, separator));
  }
  return refs;
}

async function commitRef(
  cwd: string,
  refs: Map<string, string>,
  ref: string,
): Promise<string | undefined> {
  const hash = refs.get(ref);
  if (!hash) return undefined;
  return (await git(cwd, ["rev-parse", "--verify", `${hash}^{commit}`])).trim();
}

async function predicate(cwd: string, args: string[]): Promise<boolean> {
  const result = await gitResult(cwd, args);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw gitFailure(args, result);
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  return predicate(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

async function isFirstParentReachable(cwd: string, commit: string, tip: string): Promise<boolean> {
  const commits = new Set(
    (await git(cwd, ["rev-list", "--first-parent", tip])).split("\n").filter(Boolean),
  );
  return commits.has(commit);
}

async function worktreeForBranch(cwd: string, branchRef: string): Promise<string | undefined> {
  const output = await git(cwd, ["worktree", "list", "--porcelain"]);
  let path: string | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    if (line === `branch ${branchRef}`) return path;
    if (line === "") path = undefined;
  }
  return undefined;
}

async function dirtyState(worktree: string | undefined): Promise<HatchItemGitState["dirty"]> {
  if (!worktree) return { staged: false, unstaged: false, untracked: false };
  const [staged, unstaged, untracked] = await Promise.all([
    predicate(worktree, ["diff", "--cached", "--quiet", "--"]).then((clean) => !clean),
    predicate(worktree, ["diff", "--quiet", "--no-ext-diff", "--"]).then((clean) => !clean),
    git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).then(
      (output) => output.length > 0,
    ),
  ]);
  return { staged, unstaged, untracked };
}

async function hasItemMarker(cwd: string, commit: string, item: string): Promise<boolean> {
  const message = await git(cwd, ["show", "-s", "--format=%s%n%b", commit]);
  return (
    message.split("\n", 1)[0].includes(`[hatch:item-${item}]`) ||
    new RegExp(`^Hatch-Item:\\s*item-${item}$`, "mi").test(message)
  );
}

/**
 * Whether a commit subject is an integration item MERGE — never an item commit.
 * The runtime writes the documented `Merge item <id> into integration [hatch:item-<id>]`
 * (or, for a human-waived accept, `Accept item <id> into integration [hatch:item-<id>]`);
 * merges made before that form carry the legacy `[hatch:merge-item-<id>]` subject. An
 * item commit's `[hatch:item-<id>]` subject lacks the merge prefix and must not match,
 * so recovery never reads a plain item commit as a landed merge.
 */
export function isItemMergeSubject(subject: string): boolean {
  return (
    subject.startsWith("[hatch:merge-item-") ||
    ((subject.startsWith("Merge item ") || subject.startsWith("Accept item ")) &&
      / into integration \[hatch:item-[^\]]+\]/.test(subject))
  );
}

async function commitParents(cwd: string, commit: string): Promise<string[]> {
  const line = (await git(cwd, ["rev-list", "--parents", "-n", "1", commit])).trim();
  return line.split(/\s+/).slice(1);
}

async function landedItemMerge(
  cwd: string,
  integrationTip: string,
  itemTip: string,
): Promise<string | undefined> {
  const firstParent = (await git(cwd, ["rev-list", "--first-parent", integrationTip]))
    .split("\n")
    .filter(Boolean);
  for (const commit of firstParent) {
    const parents = await commitParents(cwd, commit);
    if (parents.length === 2 && parents[1] === itemTip) return commit;
  }
  return undefined;
}

async function trailer(cwd: string, commit: string, key: string): Promise<string> {
  return (await git(cwd, ["show", "-s", `--format=%(trailers:key=${key},valueonly)`, commit])).trim();
}

function result(
  base: Omit<HatchItemGitState, "state" | "nextAction">,
  state: HatchItemRecoveryState,
  nextAction: string,
): HatchItemGitState {
  return { ...base, state, nextAction };
}

export async function deriveItemGitState(
  cwd: string,
  binder: string,
  item: string,
): Promise<HatchItemGitState> {
  if (!IDENTIFIER.test(binder)) throw new Error(`Invalid Hatch binder slug: ${binder}`);
  if (!IDENTIFIER.test(item)) throw new Error(`Invalid Hatch item id: ${item}`);
  const format = (await git(cwd, ["rev-parse", "--show-object-format"])).trim();
  if (format !== "sha1" && format !== "sha256") {
    throw new Error(`Hatch does not support Git object format '${format}'`);
  }
  const objectFormat = format as "sha1" | "sha256";
  const nullObjectId = "0".repeat(objectFormat === "sha1" ? 40 : 64);
  const integrationRef = `refs/heads/hatch/${binder}/integration`;
  const itemRef = `refs/heads/hatch/${binder}/item-${item}`;
  const markerRoot = `refs/hatch/${binder}/item-${item}`;
  const refs = await referenceSnapshot(cwd);
  const [integrationTip, itemTip, built, failed, done, accepted, worktree] = await Promise.all([
    commitRef(cwd, refs, integrationRef),
    commitRef(cwd, refs, itemRef),
    commitRef(cwd, refs, `${markerRoot}/built`),
    commitRef(cwd, refs, `${markerRoot}/failed`),
    commitRef(cwd, refs, `${markerRoot}/done`),
    commitRef(cwd, refs, `${markerRoot}/accepted`),
    worktreeForBranch(cwd, itemRef),
  ]);
  const dirty = await dirtyState(worktree);
  const itemMerged = Boolean(itemTip && integrationTip && await isAncestor(cwd, itemTip, integrationTip));
  const mergeCommit = itemMerged && itemTip && integrationTip
    ? await landedItemMerge(cwd, integrationTip, itemTip)
    : undefined;
  const diagnostics: string[] = [];
  const base = {
    binder,
    item,
    objectFormat,
    nullObjectId,
    integrationRef,
    integrationTip,
    itemRef,
    itemTip,
    worktree,
    mergeCommit,
    dirty,
    refs: { built, failed, done, accepted },
    diagnostics,
  };

  if (!integrationTip) {
    diagnostics.push("integration branch is missing");
    return result(base, "inconsistent", "recover the binder integration branch without resetting unowned state");
  }
  if (!itemTip) {
    if (built || failed || done || accepted || worktree) {
      diagnostics.push("item markers or worktree exist without an item branch");
      return result(base, "inconsistent", "preserve and inspect the orphaned item state; do not reset it");
    }
    return result(base, "not-started", "create the item branch and worktree from integration");
  }

  const ahead = (await git(cwd, ["rev-list", `${integrationTip}..${itemTip}`]))
    .split("\n")
    .filter(Boolean);
  const markerCommits = ahead.length > 0 ? ahead : built || failed || done || accepted ? [itemTip] : [];
  for (const commit of markerCommits) {
    if (!(await hasItemMarker(cwd, commit, item))) {
      diagnostics.push(`item commit ${commit} has no item-${item} marker`);
    }
  }
  if (built && built !== itemTip) diagnostics.push("built ref does not match the item tip");
  // A marked hand fix committed past a halted tip: failed stays on the item's history, no
  // other marker ref exists, and the marker loop above has already required every commit
  // after integration to carry the item marker. The stale failed sha stays in refs.failed.
  const failedSuperseded = Boolean(
    failed &&
      failed !== itemTip &&
      !built &&
      !done &&
      !accepted &&
      !itemMerged &&
      await isAncestor(cwd, failed, itemTip),
  );
  if (failed && failed !== itemTip && !failedSuperseded) {
    diagnostics.push("failed ref does not match the item tip");
  }
  if (accepted && accepted !== itemTip) diagnostics.push("accepted ref does not match the item tip");
  const acceptedTrailer = done ? await trailer(cwd, done, "Hatch-Accepted") : "";
  const acceptReasonTrailer = done ? await trailer(cwd, done, "Hatch-Accept-Reason") : "";
  const acceptStampedMerge = Boolean(acceptedTrailer && acceptReasonTrailer);
  if (Boolean(acceptedTrailer) !== Boolean(acceptReasonTrailer)) {
    diagnostics.push("done merge has incomplete Hatch accept trailers");
  }
  if (built && failed) diagnostics.push("built and failed refs both exist");
  if (done && failed && !acceptStampedMerge) diagnostics.push("done and failed refs both exist");
  if (accepted && built) diagnostics.push("accepted and built refs both exist");
  if (accepted && failed) diagnostics.push("accepted and failed refs both exist");
  if (accepted && !done) diagnostics.push("accepted exists without done");
  if (done) {
    if (!(await isFirstParentReachable(cwd, done, integrationTip))) {
      diagnostics.push("done ref is not first-parent-reachable from integration");
    }
    if ((await commitParents(cwd, done)).length !== 2) {
      diagnostics.push("done ref does not name a two-parent merge commit");
    }
    if (mergeCommit !== done) {
      diagnostics.push("done ref does not name the first-parent merge whose second parent is the item tip");
    }
    if (!accepted && !built && !acceptStampedMerge) {
      diagnostics.push("clean done state is missing its built ref");
    }
  }
  if (accepted && done && !acceptStampedMerge) {
    diagnostics.push("accepted done merge is missing complete Hatch accept trailers");
  }
  if ((built || failed || done || accepted) && itemMerged && !mergeCommit) {
    diagnostics.push("integrated item has no first-parent two-parent merge with the item tip as second parent");
  }
  if (diagnostics.length > 0) {
    return result(base, "inconsistent", "preserve current state and repair contradictory Git evidence manually");
  }
  if (done && acceptStampedMerge && !accepted) {
    return result(base, "accept-ref-pending", "finish failed-ref removal and write accepted ref-last");
  }
  if (done) return result(base, "done", "skip this completed item");
  if (failedSuperseded) {
    return result(
      base,
      "failed-superseded",
      "a marked fix was committed past the failed ref; re-validate the new tip",
    );
  }
  if (failed && itemMerged) {
    return result(
      base,
      "accept-merge-pending",
      "recover or revert the interrupted human-accept merge without discarding the item worktree",
    );
  }
  if (built && itemMerged) {
    return result(base, "merged-unmarked", "revalidate the landed merge and write done ref-last");
  }
  if (failed) return result(base, "failed", "route the halted item to the existing human decision flow");
  if (built) return result(base, "built", "enqueue the committed item for serial integration");
  if (dirty.staged || dirty.unstaged || dirty.untracked) {
    return result(base, "worktree-dirty", "resume the existing item worktree without resetting or clobbering it");
  }
  if (ahead.length > 0) {
    return result(
      base,
      "committed-unmarked",
      "re-run final checks and gates, then write built or failed ref-last",
    );
  }
  return result(base, "branch-only", "resume implementation in the existing clean worktree");
}
