import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DeliverySnapshot } from "./delivery-snapshot.ts";
import { hasItemMarker, type HatchItemGitState } from "./git-state.ts";
import { hostGitArgs } from "./worker-attestation.ts";

const exec = promisify(execFile);

// The six repair shapes of the contradictory-state stop, as classes. Each printed command
// creates or moves a branch or a worktree; none deletes or rewrites.
type RepairClass = "A" | "B" | "C" | "D" | "E" | "F";

// Every diagnostic deriveItemGitState pushes, with the class its stop is judged from when
// it is the item's only kind of diagnostic. `${}` stands for a substituted value. "A" holds
// only when one item tip qualifies, and "B" splits into B and C by the commits' markers;
// a mix of kinds, or a diagnostic not listed here, is F. tests/pi/state-diagnosis.test.ts
// fails when git-state.ts pushes a diagnostic this list does not hold.
const DIAGNOSTIC_CLASSES: readonly (readonly [string, RepairClass])[] = [
  ["integration branch is missing", "F"],
  ["item markers or worktree exist without an item branch", "A"],
  ["item commit ${} has no item-${} marker", "B"],
  ["built ref does not match the item tip", "E"],
  ["failed ref does not match the item tip", "D"],
  ["accepted ref does not match the item tip", "F"],
  ["done merge has incomplete Hatch accept trailers", "F"],
  ["built and failed refs both exist", "F"],
  ["done and failed refs both exist", "F"],
  ["accepted and built refs both exist", "F"],
  ["accepted and failed refs both exist", "F"],
  ["accepted exists without done", "F"],
  ["done ref is not first-parent-reachable from integration", "F"],
  ["done ref does not name a two-parent merge commit", "F"],
  ["done ref does not name the first-parent merge whose second parent is the item tip", "F"],
  ["clean done state is missing its built ref", "F"],
  ["accepted done merge is missing complete Hatch accept trailers", "F"],
  ["integrated item has no first-parent two-parent merge with the item tip as second parent", "F"],
];

const CLASS_PATTERNS = DIAGNOSTIC_CLASSES.map(([text, repair]) => ({
  pattern: new RegExp(`^${text.replace(/[.*+?^()|[\]\\]/g, "\\$&").replaceAll("${}", "(\\S+)")}$`),
  repair,
}));

const MAX_COMMITS = 5;
const MAX_ITEMS = 5;
const SUBJECT_LENGTH = 60;

/** One commit the item branch has and the integration branch does not. */
interface DiagnosedCommit {
  readonly sha: string;
  // The subject on one line, without backticks or control characters, at most 60 characters.
  readonly subject: string;
  // The binder items whose marker the commit carries, by id, in binder order.
  readonly markers: readonly string[];
}

/** What the contradictory-state stop says about one inconsistent item. */
export interface StateDiagnosis {
  readonly item: string;
  readonly binder: string;
  // git-state's diagnostics, verbatim.
  readonly diagnostics: readonly string[];
  readonly itemTip?: string;
  readonly integrationTip?: string;
  readonly refs: HatchItemGitState["refs"];
  readonly worktree?: string;
  readonly dirty: HatchItemGitState["dirty"];
  // Newest first, at most five; `more` counts the rest.
  readonly commits: readonly DiagnosedCommit[];
  readonly more: number;
  // A line about where the branch starts, when that is the cause.
  readonly note?: string;
  readonly repair: {
    readonly class: RepairClass;
    // The `Repair:` line.
    readonly line: string;
    // Commands printed under it, each verbatim and runnable as printed.
    readonly commands: readonly string[];
  };
}

async function gitResult(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    // Read-only, with the hardened options git-state.ts uses.
    const { stdout } = await exec("git", hostGitArgs(cwd, args), { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (error) {
    const value = error as { code?: number | string; stdout?: string; stderr?: string };
    if (typeof value.code === "number" && value.code === 1) return { code: 1, stdout: value.stdout ?? "" };
    throw error;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await gitResult(cwd, args);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed with ${result.code}`);
  return result.stdout;
}

const short = (sha: string): string => sha.slice(0, 7);

// One line, no backticks, control or format characters, cut to SUBJECT_LENGTH code points:
// the message reaches the model in hatch-delivery-v1, so a subject must not shape it. Controls
// and line separators become spaces; format characters (bidi overrides, zero-width) are
// dropped. The cut counts code points, so it never leaves half a surrogate pair.
function cleanSubject(raw: string): string {
  const flat = Array.from(raw
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replaceAll("`", "")
    .replace(/\s+/g, " ")
    .trim());
  return flat.length > SUBJECT_LENGTH ? `${flat.slice(0, SUBJECT_LENGTH - 1).join("").trimEnd()}…` : flat.join("");
}

// A word as a shell reads it: as is when it holds only safe characters, else single-quoted.
function shellWord(word: string): string {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

const command = (...words: string[]): string => words.map(shellWord).join(" ");

function listing(parts: readonly string[], conjunction: string): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} ${conjunction} ${parts.at(-1)}`;
}

const MARKER_REFS = ["built", "failed", "done", "accepted"] as const;

function presentMarkerRefs(refs: HatchItemGitState["refs"]): string[] {
  return MARKER_REFS.filter((name) => refs[name]).map((name) => `${name} at ${short(refs[name] as string)}`);
}

function clearSentence(binder: string): string {
  return `Clear resets every item of the binder and keeps a backup ref of each unlanded branch under refs/hatch-backup/${binder}/.`;
}

// Classes C and E name Clear here; a keep line (class D, class E off history) has named it already.
function inspectAndClear(item: string, binder: string, clearNamed = false): string {
  const clear = clearNamed ? "" : ", or deliver again and choose Clear";
  return `Run inspectItemState for '${item}' to see its full state${clear}. ${clearSentence(binder)}`;
}

// The earlier-run dialog appears only when the binder has leftovers; without it the run resumes.
const RESUME = "deliver again and choose Resume if Hatch asks about an earlier run";

async function isAncestor(repoRoot: string, ancestor: string, tip: string): Promise<boolean> {
  return (await gitResult(repoRoot, ["merge-base", "--is-ancestor", ancestor, tip])).code === 0;
}

// Shape 6: a branch that holds the commit a marker ref names, since Clear backs up branches
// only and deletes every marker ref. Class D for `failed`; class E for `built` off history.
// When a `keep/<b>/item-<id>-<ref>[-n]` name already holds that sha (the line ran on an
// earlier stop), the repair names that branch and prints no second line.
async function keepRepair(
  repoRoot: string,
  binder: string,
  item: string,
  ref: "failed" | "built",
  sha: string,
): Promise<{ lead: string; commands: string[] }> {
  let kept: string | undefined;
  const keep = await firstFree(`keep/${binder}/item-${item}-${ref}`, async (name) => {
    const at = await branchSha(repoRoot, name);
    if (at === sha) kept = name;
    return at === undefined || kept !== undefined;
  });
  if (kept) {
    return {
      lead: `Repair: no command. ${kept} already holds ${short(sha)}, the commit the ${ref} ref names; deliver again and choose Clear.`,
      commands: [],
    };
  }
  return {
    lead: `Repair: keep the commit the ${ref} ref names on a branch with the command below, then deliver again and choose Clear.`,
    commands: [command("git", "branch", keep, sha)],
  };
}

async function branchSha(repoRoot: string, name: string): Promise<string | undefined> {
  const result = await gitResult(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function branchExists(repoRoot: string, name: string): Promise<boolean> {
  return (await branchSha(repoRoot, name)) !== undefined;
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

// The first name `free` accepts: `base`, then `base-2`, `base-3`, and so on. Hatch never
// overwrites: git refuses a rename onto an existing branch, and a worktree moved onto an
// existing directory lands inside it.
async function firstFree(base: string, free: (name: string) => Promise<boolean>): Promise<string> {
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (await free(name)) return name;
  }
}

async function trailersComplete(repoRoot: string, commit: string): Promise<boolean> {
  const values = await Promise.all(["Hatch-Accepted", "Hatch-Accept-Reason"].map(async (key) =>
    (await git(repoRoot, ["show", "-s", `--format=%(trailers:key=${key},valueonly)`, commit])).trim()));
  return values.every(Boolean);
}

// Class A: the one sha the item branch can be put back at. With `done`, the item tip its
// merge names (`done^2`), when `built` equals it, or on an accept-stamped merge `accepted`
// equals it and there is no `built`; without `done`, `built` when there is no `accepted`.
// Never with `failed`, and only a commit that carries this item's marker.
async function itemTipCandidate(
  repoRoot: string,
  state: HatchItemGitState,
): Promise<{ sha?: string; disagree?: string }> {
  const { built, failed, done, accepted } = state.refs;
  if (failed) return {};
  let candidate: string | undefined;
  if (done) {
    const second = await gitResult(repoRoot, ["rev-parse", "--verify", "--quiet", `${done}^2^{commit}`]);
    if (second.code !== 0) return {};
    const tip = second.stdout.trim();
    if (built && !accepted) {
      if (built !== tip) return { disagree: `built names ${short(built)} and done's merge names ${short(tip)}` };
      candidate = tip;
    } else if (accepted && !built && await trailersComplete(repoRoot, done)) {
      if (accepted !== tip) return { disagree: `accepted names ${short(accepted)} and done's merge names ${short(tip)}` };
      candidate = tip;
    }
  } else if (built && !accepted) {
    candidate = built;
  }
  if (!candidate || candidate === done || !(await hasItemMarker(repoRoot, candidate, state.item))) return {};
  return { sha: candidate };
}

function classesOf(state: HatchItemGitState): (RepairClass | undefined)[] {
  return state.diagnostics.map((diagnostic) => CLASS_PATTERNS.find(({ pattern }) => pattern.test(diagnostic))?.repair);
}

const UNMARKED = CLASS_PATTERNS.find(({ repair }) => repair === "B")!.pattern;

function genericF(state: HatchItemGitState, binder: string): string {
  const present = [
    ...(state.itemTip ? [`hatch/${binder}/item-${state.item} at ${short(state.itemTip)}`] : []),
    ...(state.integrationTip ? [`hatch/${binder}/integration at ${short(state.integrationTip)}`] : []),
    ...presentMarkerRefs(state.refs),
  ];
  return present.length > 0
    ? `Repair: no command. These refs disagree: ${listing(present, "and")}; hatch cannot tell which one is true.`
    : "Repair: no command. Hatch finds no ref it could confirm this state from.";
}

async function repairFor(
  repoRoot: string,
  binder: string,
  binderItems: readonly string[],
  state: HatchItemGitState,
): Promise<{ repair: StateDiagnosis["repair"]; note?: string }> {
  const { item } = state;
  const classes = classesOf(state);
  const only = (wanted: RepairClass): boolean => classes.length > 0 && classes.every((found) => found === wanted);
  const itemBranch = `hatch/${binder}/item-${item}`;
  const hasMarkerRef = MARKER_REFS.some((name) => state.refs[name]);
  const none = (line: string) => ({ repair: { class: "F" as const, line, commands: [] } });

  if (only("A")) {
    const candidate = state.worktree ? {} : await itemTipCandidate(repoRoot, state);
    if (candidate.sha) {
      return {
        repair: {
          class: "A",
          line: `Repair: put the item branch back at ${short(candidate.sha)}, the item tip its refs name, then ${RESUME}:`,
          commands: [command("git", "branch", itemBranch, candidate.sha)],
        },
      };
    }
    if (state.worktree) {
      return none(
        `Repair: no command. The item branch is gone, and the worktree at ${state.worktree} still names it; ` +
          "hatch prints no command while a worktree holds the item ref.",
      );
    }
    const left = presentMarkerRefs(state.refs);
    const from = left.length > 0 ? listing(left, "and") : "the state left";
    return none(
      `Repair: no command. The item branch is gone, and hatch cannot confirm the item tip from ${from}` +
        `${candidate.disagree ? `; ${candidate.disagree}, which disagree` : ""}.`,
    );
  }

  if (only("B")) {
    // The commits the diagnostics name, oldest first, and the other items' markers each carries.
    const named = state.diagnostics.map((diagnostic) => UNMARKED.exec(diagnostic)?.[1]).filter((sha): sha is string => Boolean(sha)).reverse();
    let seededOn: { sha: string; other: string } | undefined;
    for (const sha of named) {
      for (const other of binderItems) {
        if (other !== item && await hasItemMarker(repoRoot, sha, other)) {
          seededOn = { sha, other };
          break;
        }
      }
      if (seededOn) break;
    }
    if (!seededOn) {
      return {
        repair: {
          class: "C",
          line:
            `Repair: no command. Hatch takes a commit as this item's work only when its first line holds [hatch:item-${item}] ` +
            `or its message holds a Hatch-Item: item-${item} trailer, and adding one rewrites the commit. ${inspectAndClear(item, binder)}`,
          commands: [],
        },
      };
    }
    if (hasMarkerRef) return none(genericF(state, binder));
    const note = `The branch starts on ${seededOn.other}'s commit ${short(seededOn.sha)}, which is not on the integration branch yet.`;
    const commands: string[] = [];
    if (state.worktree) {
      // git cannot move the main working tree; the rename alone then stands.
      const main = (await git(repoRoot, ["worktree", "list", "--porcelain"])).split("\n")[0]?.slice("worktree ".length);
      if (state.worktree !== main) {
        const root = resolve(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
        const target = await firstFree(join(root, `keep-${binder}-item-${item}`), async (path) => !(await pathExists(path)));
        commands.push(command("git", "worktree", "move", state.worktree, target));
      }
    }
    const keep = await firstFree(`keep/${binder}/item-${item}`, async (name) => !(await branchExists(repoRoot, name)));
    commands.push(command("git", "branch", "-m", itemBranch, keep));
    return {
      note,
      repair: {
        class: "B",
        line:
          `Repair: move this branch aside, then ${RESUME}; ${item} then builds from the integration branch, ` +
          "and its commits stay on the new name:",
        commands,
      },
    };
  }

  if (only("D") && state.refs.failed) {
    const failed = state.refs.failed;
    const where = state.itemTip && await isAncestor(repoRoot, failed, state.itemTip)
      ? "which is behind the item tip"
      : "which the item branch no longer holds";
    const { lead, commands } = await keepRepair(repoRoot, binder, item, "failed", failed);
    return {
      repair: {
        class: "D",
        line:
          `${lead} ` +
          `The failed ref names ${short(failed)}, ${where}, and the only fixes move or delete that ref; ` +
          `the keep branch holds ${short(failed)}, since Clear backs up branches only. ${inspectAndClear(item, binder, true)}`,
        commands,
      },
    };
  }

  if (only("E") && state.refs.built && state.itemTip && !(await isAncestor(repoRoot, state.refs.built, state.itemTip))) {
    // An amended or rebased item branch: built is on no branch, so Clear would lose it.
    const built = state.refs.built;
    const { lead, commands } = await keepRepair(repoRoot, binder, item, "built", built);
    return {
      repair: {
        class: "E",
        line:
          `${lead} ` +
          `The built ref names ${short(built)} and the item branch is at ${short(state.itemTip)}, which disagree: built is not on the item branch, ` +
          `and the only fixes move or delete that ref; the keep branch holds ${short(built)}, since Clear backs up branches only. ` +
          inspectAndClear(item, binder, true),
        commands,
      },
    };
  }

  if (only("E") && state.refs.built && state.itemTip) {
    const built = state.refs.built;
    const later = Number((await git(repoRoot, ["rev-list", "--count", `${built}..${state.itemTip}`])).trim());
    return {
      repair: {
        class: "E",
        line:
          `Repair: no command. The built ref names ${short(built)}, the branch holds ${later} later commit(s) that built does not cover, ` +
          `and the only fixes move or delete that ref. ${inspectAndClear(item, binder)}`,
        commands: [],
      },
    };
  }

  return none(genericF(state, binder));
}

/**
 * Reads what the contradictory-state stop says about one `inconsistent` item: the commits
 * its branch has past integration with the binder markers each carries, and the one repair
 * that is safe, when there is one. Read-only.
 */
export async function diagnoseItem(
  repoRoot: string,
  binder: string,
  binderItems: readonly string[],
  state: HatchItemGitState,
): Promise<StateDiagnosis> {
  let commits: DiagnosedCommit[] = [];
  let more = 0;
  if (state.itemTip && state.integrationTip) {
    const range = `${state.integrationTip}..${state.itemTip}`;
    const shas = (await git(repoRoot, ["rev-list", `--max-count=${MAX_COMMITS}`, range])).split("\n").filter(Boolean);
    more = Math.max(0, Number((await git(repoRoot, ["rev-list", "--count", range])).trim()) - shas.length);
    commits = await Promise.all(shas.map(async (sha) => ({
      sha,
      subject: cleanSubject(await git(repoRoot, ["show", "-s", "--format=%s", sha])),
      markers: (await Promise.all(binderItems.map(async (id) => (await hasItemMarker(repoRoot, sha, id)) ? id : undefined)))
        .filter((id): id is string => Boolean(id)),
    })));
  }
  const { repair, note } = await repairFor(repoRoot, binder, binderItems, state);
  return {
    item: state.item,
    binder,
    diagnostics: [...state.diagnostics],
    ...(state.itemTip ? { itemTip: state.itemTip } : {}),
    ...(state.integrationTip ? { integrationTip: state.integrationTip } : {}),
    refs: { ...state.refs },
    ...(state.worktree ? { worktree: state.worktree } : {}),
    dirty: { ...state.dirty },
    commits,
    more,
    ...(note ? { note } : {}),
    repair,
  };
}

function refsLine(diagnosis: StateDiagnosis): string {
  const itemBranch = `hatch/${diagnosis.binder}/item-${diagnosis.item}`;
  const integration = `hatch/${diagnosis.binder}/integration`;
  const present = [
    ...(diagnosis.itemTip ? [`${itemBranch} at ${short(diagnosis.itemTip)}`] : []),
    ...(diagnosis.integrationTip ? [`${integration} at ${short(diagnosis.integrationTip)}`] : []),
    ...presentMarkerRefs(diagnosis.refs),
  ];
  const absentBranches = [
    ...(diagnosis.itemTip ? [] : [itemBranch]),
    ...(diagnosis.integrationTip ? [] : [integration]),
  ];
  const absentMarkers = MARKER_REFS.filter((name) => !diagnosis.refs[name]);
  const absent = [
    ...(absentBranches.length > 0 ? [`no branch ${listing(absentBranches, "or")}`] : []),
    ...(absentMarkers.length > 0 ? [`no ${listing(absentMarkers, "or")} ref`] : []),
  ];
  return `Refs: ${[present.join(", "), ...absent].filter(Boolean).join("; ")}.`;
}

function commitLine(item: string, commit: DiagnosedCommit): string {
  const markers = commit.markers.length === 0
    ? "no item marker"
    : `${commit.markers.map((id) => `item-${id}`).join(", ")}${commit.markers.includes(item) ? "" : ", not this item"}`;
  return `  ${short(commit.sha)}  ${markers}  ${commit.subject}`;
}

// One `Why:` line per diagnostic, verbatim, except that the commits without this item's
// marker (one diagnostic each) show at most five, then one line for the rest; every other
// diagnostic is printed, since it can decide the class.
function whyLines(item: string, diagnostics: readonly string[]): string[] {
  const lines: string[] = [];
  let unmarked = 0;
  for (const diagnostic of diagnostics) {
    if (UNMARKED.test(diagnostic) && (unmarked += 1) > MAX_COMMITS) continue;
    lines.push(`Why: ${diagnostic}`);
  }
  if (unmarked > MAX_COMMITS) {
    const at = lines.findLastIndex((line) => UNMARKED.test(line.slice("Why: ".length)));
    lines.splice(at + 1, 0, `Why: and ${unmarked - MAX_COMMITS} more commits without the item-${item} marker`);
  }
  return lines;
}

/**
 * The contradictory-state stop's message: for each inconsistent item, at most five, its
 * diagnostics, and its one `Repair:` line with any command under it; the first item also
 * gets its refs and its commits past integration. Pure. Throws when no item is inconsistent.
 */
export function inconsistentMessage(snapshot: DeliverySnapshot): string {
  const inconsistent = snapshot.items.filter((item) => snapshot.states.get(item.id)?.state === "inconsistent");
  if (inconsistent.length === 0) throw new Error("inconsistentMessage: no item is inconsistent");
  const lines: string[] = [];
  inconsistent.slice(0, MAX_ITEMS).forEach((item, index) => {
    const state = snapshot.states.get(item.id) as HatchItemGitState;
    lines.push(`Item '${item.id}' has contradictory Git state requiring manual recovery.`);
    lines.push(...whyLines(item.id, state.diagnostics));
    const diagnosis = item.diagnosis;
    if (!diagnosis) {
      lines.push(`Repair: no command. Hatch could not read this item's commits. Run inspectItemState for '${item.id}' to see its full state.`);
      return;
    }
    if (index === 0) {
      lines.push(refsLine(diagnosis));
      if (diagnosis.commits.length > 0) {
        lines.push("Commits on the item branch that the integration branch does not have, newest first:");
        for (const commit of diagnosis.commits) lines.push(commitLine(item.id, commit));
        if (diagnosis.more > 0) lines.push(`  and ${diagnosis.more} more`);
      }
      if (diagnosis.note) lines.push(diagnosis.note);
    }
    lines.push(diagnosis.repair.line, ...diagnosis.repair.commands.map((line) => `  ${line}`));
  });
  if (inconsistent.length > MAX_ITEMS) lines.push(`and ${inconsistent.length - MAX_ITEMS} more items`);
  // The stop's own scope: a run can reach it after a wave, so Hatch may have changed refs earlier.
  lines.push("This stop changed nothing.");
  return lines.join("\n");
}
