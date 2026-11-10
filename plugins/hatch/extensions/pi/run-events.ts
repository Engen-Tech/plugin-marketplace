import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { HatchGateAttemptRecord } from "./gate-attempts.ts";
import { PACKAGE_ROOT } from "./package-paths.ts";

// The failing check behind a halt, when a check failed: what ran, how it ended, the tail
// of its output, and the install guidance a diagnosis found.
export interface HatchRunEventCheck {
  id: string;
  command: string;
  exitCode: number | null;
  excerpt: string;
  remediation?: string;
}

export type HatchWaveNext = "continue" | "prompt" | "stop";

export interface HatchFloorListReused {
  kind: "floor-list-reused";
  wave?: number;
  item: string;
  match: "same-tree" | "hand-fix";
  commands: number;
}

// A site bound receipts another site ran in this run instead of running its plan. `tree` is
// the tree both ran on; `checks` the number of receipts. At "merge", the proposed merge bound
// the parity probe's receipts on identical inputs. At "post-wave", the wave's lone landed
// merge is the tip and its merge checks covered the post-wave floor, so it was not rerun.
export type HatchChecksReused =
  | {
      kind: "checks-reused";
      wave?: number;
      item: string;
      site: "merge";
      source: "parity-probe";
      tree: string;
      checks: number;
    }
  | {
      kind: "checks-reused";
      wave: number;
      item: string;
      site: "post-wave";
      source: "merge-checks";
      tree: string;
      checks: number;
    };

export interface HatchRunGateAttempt {
  role: string;
  // The ledger's attempt number; absent when the ledger could not be read.
  attempt?: number;
  verdict: string;
  counted: boolean;
  findings: { severity: string; code: string }[];
  // Set on a row the host wrote without a gate run.
  source?: string;
}

// Progress a Hatch runner reports while it works. Runners never decide how an event is shown;
// the run host does. A sink must never break a run, so runners call it through safeProgress.
export type HatchRunEvent =
  | { kind: "run-started"; binder: string; item?: string }
  // `landed`: every item already done when the run loads the binder, carried ones included,
  // in binder order.
  | { kind: "binder-loaded"; items: string[]; carried: string[]; landed: string[] }
  | { kind: "wave-started"; wave: number; items: string[] }
  | { kind: "item-built"; wave?: number; item: string; status: string; attempts: number; phaseMs?: HatchPhaseMs }
  // A merge-time gate concern sent the item back to its own worker with the findings,
  // while that gate's shared attempt budget remains. `attempt` counts the gate's concerns
  // so far, out of `cap`. `authorized` marks the one attempt past a spent cap that the
  // human chose at the halt prompt.
  | { kind: "item-kicked-back"; wave?: number; item: string; gate: string; attempt: number; cap: number; authorized?: true }
  // A marked fix was committed past the item's failed ref: the stale ref is dropped and
  // the new tip re-validates without a prompt.
  | { kind: "item-hand-fixed"; item: string; failed: string; tip: string }
  // A stored floor list stood in for a worker. `match` says why it still applies.
  | HatchFloorListReused
  // A site bound receipts another site ran in this run; see HatchChecksReused.
  | HatchChecksReused
  // A merge-time or accept-time review's verdicts could not be written to the gate-attempt
  // ledger, because the ledger cannot be read or appended. Nothing was recorded; the
  // item's landing is decided as before. `file` is the ledger file, when known.
  | { kind: "gate-ledger-unrecorded"; wave?: number; item: string; file?: string; error: string }
  // The halt sink could not keep an item's halt. The halt itself, the result's `halts`
  // entry and the `item-halted` event are unchanged; only the kept record is missing.
  | { kind: "item-halt-unrecorded"; wave?: number; item: string; error: string }
  // One review's gate verdicts, as it happens: each gate's attempt number, effective
  // verdict and finding codes. Every attempt is reported, not only the last, so a
  // two-attempt halt shows what the first attempt found. `unrecorded` is set, with the
  // reason, when the gate-attempt ledger could not take the rows.
  | { kind: "gate-reviewed"; wave?: number; item: string; phase: "build" | "merge" | "accept"; gates: HatchRunGateAttempt[]; unrecorded?: string }
  | {
      kind: "item-halted";
      wave?: number;
      item: string;
      status: string;
      reason: string;
      check?: HatchRunEventCheck;
      // The halted build's own phase time, when a build halted.
      phaseMs?: HatchPhaseMs;
    }
  // Before any build: these items' oracles need installed dependencies and the
  // integration branch declares no environment setup.
  | { kind: "environment-preflight"; items: string[]; suggestedSetup: string; message: string }
  | { kind: "item-merged"; wave: number; item: string; accepted: boolean }
  | {
      kind: "wave-finished";
      wave: number;
      status: "passed" | "rolled-back" | "nothing-to-merge";
      landed: string[];
      // Items whose merge into this wave failed and that now hold a failed ref: the wave
      // finalization's own list, which a rollback decision reads.
      failed: string[];
      // Every item of this wave that did not land, in the order it was set aside, with the
      // status it halted on: a halted build (failed, blocked, no-change, already-present),
      // a failed merge or accept, or a deferred kickback. It includes every `failed` item,
      // so a summary that lists `halted` never reads "none" beside a halt.
      halted: { item: string; status: string }[];
      // What the runner decided to do next, so no reader infers it from the lists:
      // "continue" to the next wave, "prompt" the human to fix, accept or defer a failed
      // item, or "stop" the run.
      next: HatchWaveNext;
      // The run's phase time so far, set by the delivery runner on every wave-finished.
      phaseMs?: HatchPhaseMs;
    }
  | { kind: "companions-started" }
  // Clear kept these tips under refs/hatch-backup/ before deleting the branches that held them.
  // `lines` are the operator-facing restore instructions.
  | {
      kind: "clear-kept-backups";
      binder: string;
      kept: { backupRef: string; commits: number; restoreName: string }[];
      lines: string[];
    }
  | { kind: "prompt-opened"; prompt: "select" | "confirm" | "input" | "editor"; title: string }
  | {
      kind: "prompt-closed";
      prompt: "select" | "confirm" | "input" | "editor";
      title: string;
      answered: boolean;
    };

export type HatchRunProgress = (event: HatchRunEvent) => void;

export function safeProgress(progress?: HatchRunProgress): HatchRunProgress {
  if (!progress) return () => {};
  return (event) => {
    try {
      progress(event);
    } catch {
      // A progress sink never changes what a run does.
    }
  };
}

// The event for the ledger rows one review wrote, or undefined when it wrote none.
export function gateReviewedEvent(
  rows: readonly HatchGateAttemptRecord[],
  wave?: number,
): Extract<HatchRunEvent, { kind: "gate-reviewed" }> | undefined {
  const first = rows[0];
  if (!first) return undefined;
  return {
    kind: "gate-reviewed",
    ...(wave !== undefined ? { wave } : {}),
    item: first.item,
    phase: first.phase,
    gates: rows.map((row) => ({
      role: row.role,
      attempt: row.attempt,
      verdict: row.verdict,
      counted: row.counted,
      findings: row.findings.map((finding) => ({ severity: finding.severity, code: finding.code })),
      ...(row.source ? { source: row.source } : {}),
    })),
  };
}

// ---- Which hatch ran ----

// `commit` is null only with `commitNote` saying why; a reader never has to guess.
export interface HatchProvenance {
  version: string;
  commit: string | null;
  commitSource: "git-checkout" | "marketplace-lock" | "unknown";
  commitNote?: string;
}

const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readVersion(root: string): string {
  try {
    const version = (readJson(join(root, "package.json")) as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : "unknown";
  } catch {
    return "unknown";
  }
}

function readRef(gitDir: string, commonDir: string, ref: string): string | undefined {
  for (const dir of [gitDir, commonDir]) {
    try {
      return readFileSync(join(dir, ref), "utf8").trim();
    } catch {
      // Not a loose ref here; packed-refs is next.
    }
  }
  try {
    for (const line of readFileSync(join(commonDir, "packed-refs"), "utf8").split("\n")) {
      const [id, name] = line.trim().split(" ");
      if (name === ref && id) return id;
    }
  } catch {
    // No packed-refs either.
  }
  return undefined;
}

// Reads the Git files directly, with no git process, so the lookup is fast and cannot hang.
// Only a `.git` at the package root counts: a package unpacked inside some other repository
// must not report that repository's commit.
function readCheckoutCommit(root: string): { commit: string } | { note: string } {
  const dotGit = join(root, ".git");
  const entry = statSync(dotGit);
  let gitDir = dotGit;
  if (!entry.isDirectory()) {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!pointer) return { note: `${dotGit} names no git directory` };
    gitDir = resolve(root, pointer[1]);
  }
  let commonDir = gitDir;
  try {
    commonDir = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    // A main checkout has no commondir file.
  }
  let head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  for (let hop = 0; hop < 5 && head.startsWith("ref: "); hop += 1) {
    const ref = head.slice(5).trim();
    const target = readRef(gitDir, commonDir, ref);
    if (!target) return { note: `${ref} has no commit in ${commonDir}` };
    head = target;
  }
  return COMMIT_ID.test(head) ? { commit: head } : { note: `HEAD in ${gitDir} is not a commit id` };
}

// A Pi git package of the Engen-Tech marketplace holds hatch at plugins/hatch, and the
// clone's plugins.lock.json pins the hatch commit that release was cut from.
function readMarketplaceCommit(root: string, version: string): { commit: string } | { note: string } | undefined {
  if (basename(dirname(root)) !== "plugins") return undefined;
  const lockPath = join(dirname(dirname(root)), "plugins.lock.json");
  let lock: unknown;
  try {
    lock = readJson(lockPath);
  } catch {
    return undefined;
  }
  const entry = (lock as { hatch?: { version?: unknown; commit?: unknown } } | null)?.hatch;
  if (!entry || typeof entry.commit !== "string" || !COMMIT_ID.test(entry.commit)) {
    return { note: `${lockPath} pins no hatch commit` };
  }
  if (entry.version !== version) {
    return { note: `${lockPath} pins hatch ${String(entry.version)}, not ${version}` };
  }
  return { commit: entry.commit };
}

export function readHatchProvenance(root: string): HatchProvenance {
  const version = readVersion(root);
  try {
    let found: { commit: string } | { note: string } | undefined;
    let source: HatchProvenance["commitSource"] = "git-checkout";
    let checkout = true;
    try {
      statSync(join(root, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      checkout = false;
    }
    // Only a missing .git means "not a checkout"; a .git that exists but cannot be read
    // reaches the outer catch and is reported as broken, never as an npm install.
    if (checkout) {
      found = readCheckoutCommit(root);
    } else {
      source = "marketplace-lock";
      found = readMarketplaceCommit(root, version);
    }
    if (found && "commit" in found) return { version, commit: found.commit, commitSource: source };
    return {
      version,
      commit: null,
      commitSource: "unknown",
      commitNote: found?.note ?? `no git checkout or marketplace lock at ${root}; an installed npm package carries no commit`,
    };
  } catch (error) {
    return { version, commit: null, commitSource: "unknown", commitNote: `git metadata at ${root} could not be read: ${errorText(error)}` };
  }
}

let packageProvenance: HatchProvenance | undefined;

// Read once per process: the code that runs is the code loaded, whatever the clone holds later.
export function hatchProvenance(): HatchProvenance {
  packageProvenance ??= readHatchProvenance(PACKAGE_ROOT);
  return packageProvenance;
}

export function describeHatchProvenance(provenance: HatchProvenance): string {
  const source = provenance.commitSource === "git-checkout" ? "git checkout" : "marketplace lock";
  return provenance.commit
    ? `hatch ${provenance.version}, commit ${provenance.commit.slice(0, 12)} (${source})`
    : `hatch ${provenance.version}, commit unknown: ${provenance.commitNote ?? "no reason recorded"}`;
}

// ---- Phase time ----

export type HatchPhase = "worker" | "checks" | "gates" | "merge" | "postWave";
export type HatchPhaseMs = Record<HatchPhase, number>;

export function emptyPhaseMs(): HatchPhaseMs {
  return { worker: 0, checks: 0, gates: 0, merge: 0, postWave: 0 };
}

// The time a timed region spent inside nested timed regions, as the union of their
// intervals, so two gates running at once are not subtracted twice.
interface NestedTime {
  active: number;
  since: number;
  covered: number;
}

interface RunFrame {
  emit: HatchRunProgress;
  totals: HatchPhaseMs[];
  nested?: NestedTime;
}

const runFrames = new AsyncLocalStorage<RunFrame>();
const noProgress: HatchRunProgress = () => {};

// Runs `work` as a tracked run, or as a collector inside the current one. Phase time inside
// it is added to `into` and to every enclosing collector. `progress`, when given, becomes the
// sink `runProgress()` returns to code that has no progress parameter of its own.
export async function trackRun<T>(
  progress: HatchRunProgress | undefined,
  work: () => Promise<T>,
  into: HatchPhaseMs = emptyPhaseMs(),
): Promise<{ value: T; phaseMs: HatchPhaseMs }> {
  const parent = runFrames.getStore();
  const frame: RunFrame = {
    emit: progress ? safeProgress(progress) : parent?.emit ?? noProgress,
    totals: [...(parent?.totals ?? []), into],
    ...(parent?.nested ? { nested: parent.nested } : {}),
  };
  const value = await runFrames.run(frame, work);
  return { value, phaseMs: into };
}

export function runProgress(): HatchRunProgress {
  return runFrames.getStore()?.emit ?? noProgress;
}

function enter(nested: NestedTime | undefined, now: number): void {
  if (!nested) return;
  if (nested.active === 0) nested.since = now;
  nested.active += 1;
}

function leave(nested: NestedTime | undefined, now: number): void {
  if (!nested) return;
  nested.active -= 1;
  if (nested.active === 0) nested.covered += now - nested.since;
}

async function timed<T>(phase: HatchPhase | undefined, work: () => Promise<T>): Promise<T> {
  const frame = runFrames.getStore();
  if (!frame) return work();
  const started = Date.now();
  const inner: NestedTime = { active: 0, since: started, covered: 0 };
  enter(frame.nested, started);
  try {
    return await runFrames.run({ ...frame, nested: inner }, work);
  } finally {
    const ended = Date.now();
    leave(frame.nested, ended);
    if (phase) {
      const own = Math.max(0, ended - started - inner.covered);
      for (const totals of frame.totals) totals[phase] += own;
    }
  }
}

// Adds the wall time of `work`, less the time spent in phases nested inside it, to `phase`.
// Outside a tracked run it only runs `work`.
export function timePhase<T>(phase: HatchPhase, work: () => Promise<T>): Promise<T> {
  return timed(phase, work);
}

// Time no phase owns, such as a human answering a prompt: taken out of the enclosing phase.
export function untimed<T>(work: () => Promise<T>): Promise<T> {
  return timed(undefined, work);
}
