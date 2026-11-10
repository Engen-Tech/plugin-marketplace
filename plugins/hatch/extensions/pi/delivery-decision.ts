import type { HatchDeliveryResult, HatchDeliveryWave } from "./delivery-runner.ts";
import { deferredHaltMessage, type DeliverySnapshot } from "./delivery-snapshot.ts";
import type { HatchItemRecoveryState } from "./git-state.ts";
import type { HatchWaveNext } from "./run-events.ts";
import { inconsistentMessage } from "./state-diagnosis.ts";

/** What a pass decides from besides the snapshot. */
export interface DecisionHost {
  readonly hasUI: boolean;
  // The run was asked to stop (a cancel or a session shutdown): its own abort signal.
  readonly stopping: boolean;
}

/** The first thing a pass does. Each kind is one branch of the runner's pass loop. */
export type PassAction =
  | { readonly kind: "stop-requested" }
  | { readonly kind: "recover-merged-unmarked"; readonly item: string; readonly wave: number }
  | { readonly kind: "recover-pending-wave"; readonly pending: NonNullable<DeliverySnapshot["pending"]> }
  | { readonly kind: "complete" }
  | { readonly kind: "finish-delivery" }
  | { readonly kind: "stop-inconsistent" }
  | { readonly kind: "recover-accept"; readonly item: string }
  | { readonly kind: "hand-fixed"; readonly item: string }
  | { readonly kind: "stop-failed-headless"; readonly item: string }
  | { readonly kind: "prompt-failed"; readonly item: string }
  | { readonly kind: "build-wave"; readonly frontier: readonly string[] }
  | { readonly kind: "stop-deferred" }
  | { readonly kind: "stop-stuck" };

/** One row of the pass table. Two rows may share an action kind; the id names the row. */
export interface PassRow {
  readonly id: string;
  match(snapshot: DeliverySnapshot, host: DecisionHost): PassAction | undefined;
}

// The first active (not carried) item, in binder order, whose derived state is one of `states`.
function firstIn(snapshot: DeliverySnapshot, ...states: HatchItemRecoveryState[]): string | undefined {
  return snapshot.items.find((item) => {
    if (item.carried) return false;
    const value = snapshot.states.get(item.id)?.state;
    return value !== undefined && states.includes(value);
  })?.id;
}

const allDone = (snapshot: DeliverySnapshot): boolean => snapshot.items.every((item) => item.done);

/** The pass rows. Priority is array order; the last row always matches. */
export const PASS_ROWS: readonly PassRow[] = [
  // A stop asked for since the last pass wins over every other row: the pass starts nothing.
  { id: "stop-requested", match: (_snapshot, host) => host.stopping ? { kind: "stop-requested" } : undefined },
  // An accept a crash interrupted while its wave was open: recover the accept first. Its
  // recovery lands the item and closes that wave; the pending-wave recovery takes only items
  // that have `done`, so run first it stops on the open wave or closes it under the accept.
  {
    id: "accept-in-pending-wave",
    match: (snapshot) => {
      if (!snapshot.pending) return undefined;
      const item = firstIn(snapshot, "accept-merge-pending", "accept-ref-pending");
      return item === undefined ? undefined : { kind: "recover-accept", item };
    },
  },
  // A merge a crash left with no `done` ref while its wave was open: re-validate it first.
  // Its recovery writes `done` at the landed merge, so the pending-wave recovery that follows
  // lands it in the wave it merged in; run first, that recovery takes only items with `done`.
  {
    id: "merged-unmarked-in-pending-wave",
    match: (snapshot) => {
      if (!snapshot.pending) return undefined;
      const item = firstIn(snapshot, "merged-unmarked");
      return item === undefined ? undefined : { kind: "recover-merged-unmarked", item, wave: snapshot.pending.wave };
    },
  },
  // Recover a pending wave anchor before deriving a new frontier, whether or not every item
  // is done: a fresh wave over an unfinalized anchor could later be rolled back with it.
  {
    id: "pending-wave",
    match: (snapshot) => snapshot.pending ? { kind: "recover-pending-wave", pending: snapshot.pending } : undefined,
  },
  { id: "complete", match: (snapshot) => allDone(snapshot) && snapshot.archived ? { kind: "complete" } : undefined },
  { id: "finish-delivery", match: (snapshot) => allDone(snapshot) ? { kind: "finish-delivery" } : undefined },
  {
    id: "inconsistent",
    match: (snapshot) => firstIn(snapshot, "inconsistent") !== undefined ? { kind: "stop-inconsistent" } : undefined,
  },
  {
    id: "accept-pending",
    match: (snapshot) => {
      const item = firstIn(snapshot, "accept-merge-pending", "accept-ref-pending");
      return item === undefined ? undefined : { kind: "recover-accept", item };
    },
  },
  {
    id: "hand-fixed",
    match: (snapshot) => {
      const item = firstIn(snapshot, "failed-superseded");
      return item === undefined ? undefined : { kind: "hand-fixed", item };
    },
  },
  {
    id: "failed-headless",
    match: (snapshot, host) => {
      const item = firstIn(snapshot, "failed");
      return item === undefined || host.hasUI ? undefined : { kind: "stop-failed-headless", item };
    },
  },
  {
    id: "failed-prompt",
    match: (snapshot) => {
      const item = firstIn(snapshot, "failed");
      return item === undefined ? undefined : { kind: "prompt-failed", item };
    },
  },
  {
    id: "frontier",
    match: (snapshot) => snapshot.frontier.length > 0 ? { kind: "build-wave", frontier: [...snapshot.frontier] } : undefined,
  },
  { id: "deferred", match: (snapshot) => snapshot.deferred.length > 0 ? { kind: "stop-deferred" } : undefined },
  { id: "stuck", match: () => ({ kind: "stop-stuck" }) },
];

/** The action of the first row that matches. Pure: no Git, no clock. */
export function decide(snapshot: DeliverySnapshot, host: DecisionHost): PassAction {
  for (const row of PASS_ROWS) {
    const action = row.match(snapshot, host);
    if (action) return action;
  }
  throw new Error("Hatch pass table matched no row; its last row always matches");
}

/**
 * What a wave line says the next pass does, by the action the pass table picks after the
 * wave: a stop row stops, a failed item asks the human, every other row continues. A last
 * wave followed by companions or completion continues, since the run does. It names the
 * next pass's action, not that action's outcome: a pass that continues can still end the
 * run, as a recovery that halts, a missing anchor or the loop's bound does.
 */
export const WAVE_NEXT: Readonly<Record<PassAction["kind"], HatchWaveNext>> = {
  "stop-requested": "stop",
  "recover-merged-unmarked": "continue",
  "recover-pending-wave": "continue",
  complete: "continue",
  "finish-delivery": "continue",
  "stop-inconsistent": "stop",
  "recover-accept": "continue",
  "hand-fixed": "continue",
  "stop-failed-headless": "stop",
  "prompt-failed": "prompt",
  "build-wave": "continue",
  "stop-deferred": "stop",
  "stop-stuck": "stop",
};

// ---- Dialog answers ----
//
// Each select the runner opens maps its answer through one table to one outcome. The keys
// are the select's option labels, in the order it lists them, plus `undefined` for a
// dismissed (or headless) dialog. The labels stay literal in the runner's select call,
// where the scenario coverage check reads them; `delivery-decision.test.ts` holds each
// table's keys equal to those option lists.

/** The earlier-run dialog: the binder carries refs from a run before this one. */
export type EarlierRunOutcome = "resume" | "clear" | "clear-and-stop" | "dismissed";
export const EARLIER_RUN_ANSWERS: ReadonlyMap<string | undefined, EarlierRunOutcome> = new Map<string | undefined, EarlierRunOutcome>([
  ["Resume", "resume"],
  ["Clear", "clear"],
  ["Clear and stop", "clear-and-stop"],
  [undefined, "dismissed"],
]);

/** The environment preflight dialog. Headless, the runner asks nothing and passes `undefined`. */
export type PreflightOutcome = "stop" | "build";
export const PREFLIGHT_ANSWERS: ReadonlyMap<string | undefined, PreflightOutcome> = new Map<string | undefined, PreflightOutcome>([
  ["Stop to add the setup", "stop"],
  ["Build anyway", "build"],
  [undefined, "stop"],
]);

/** The failed-item prompt. Send back is offered only on a condition; the runner checks the offer. */
export type FailedPromptOutcome = "fix" | "send-back" | "accept" | "defer";
export const FAILED_PROMPT_ANSWERS: ReadonlyMap<string | undefined, FailedPromptOutcome> = new Map<string | undefined, FailedPromptOutcome>([
  ["Fix and rerun", "fix"],
  ["Send back to the worker once", "send-back"],
  ["Accept exact current findings", "accept"],
  ["Defer and stop delivery", "defer"],
  [undefined, "defer"],
]);

// An answer no option names reads as a dismissal.
function outcomeOf<T>(table: ReadonlyMap<string | undefined, T>, choice: string | undefined): T {
  const outcome = table.get(choice) ?? table.get(undefined);
  if (outcome === undefined) throw new Error("Hatch answer table has no outcome for a dismissed dialog");
  return outcome;
}

export const earlierRunOutcome = (choice: string | undefined): EarlierRunOutcome => outcomeOf(EARLIER_RUN_ANSWERS, choice);
export const preflightOutcome = (choice: string | undefined): PreflightOutcome => outcomeOf(PREFLIGHT_ANSWERS, choice);
export const failedPromptOutcome = (choice: string | undefined): FailedPromptOutcome => outcomeOf(FAILED_PROMPT_ANSWERS, choice);

/** The arm a switch over an outcome reaches only when an outcome has no branch. */
export function unhandledAnswer(outcome: never): never {
  throw new Error(`Hatch dialog outcome '${String(outcome)}' has no branch in the runner`);
}

// ---- Stops ----
//
// Every blocked result the runner returns is one of these stops, built by `stopResult`.
// Each entry renders the stop's message and declares where the operator finds the next
// step: in the message itself, in the result's `halts`, or nowhere yet (`none`).
// `halts` promises less than `message`: the stop's item halts are in the result's `halts`,
// and a halt carries a next step only when its writer set one (`recordItemHalt` keeps
// `nextStepText` when it is given). A halt with no host-written verdict and no blocked
// worker, such as a landed merge whose checks fail at recovery, carries none.

/** Where a stopped run's next step is written. */
export type StopNextStep = "message" | "halts" | "none";

// What each stop's message is rendered from, besides the binder.
interface StopArgs {
  // Before any snapshot: the earlier-run dialog, the preflights and a successor's start.
  "earlier-run-headless": { readonly refs: number };
  "earlier-run-unanswered": {};
  "environment-preflight": { readonly finding: string };
  "gate-probe-refused": { readonly refused: string };
  "successor-uncommitted": {};
  "successor-cannot-start": { readonly halt: string };
  "successor-no-predecessor-tip": {};
  "successor-binder-not-on-default": { readonly predecessor: string; readonly defaultBranch: string };
  "successor-merge-conflicts": { readonly predecessor: string; readonly defaultBranch: string };
  "successor-merge-hooks-failed": { readonly defaultBranch: string };
  "successor-merge-lacks-binder": { readonly defaultBranch: string };
  "successor-cannot-continue": { readonly halt: string };
  // A pass row's stop, or an outcome of the action a row chose.
  "discovery-halted": { readonly reason: string };
  "merged-unmarked-recovery-halted": { readonly reason: string };
  "pending-wave-unrecoverable": {};
  "pending-wave-rolled-back": {};
  "authority-broken": { readonly reason: string; readonly step: string };
  "inconsistent": { readonly snapshot: DeliverySnapshot };
  "accept-anchor-missing": {};
  "accept-recovery-failed": {};
  "accept-recovery-rolled-back": {};
  "failed-headless": { readonly item: string; readonly files: readonly string[]; readonly readError?: string };
  "failed-deferred": { readonly item: string };
  "accept-not-landed": { readonly item: string };
  "wave-rolled-back": {};
  "deferred": { readonly snapshot: DeliverySnapshot };
  "stuck": {};
}

/** The name of a stop. */
export type DeliveryStop = keyof StopArgs;

/** A stop with what its message is rendered from. */
export type NamedStop = { [K in DeliveryStop]: { readonly stop: K } & StopArgs[K] }[DeliveryStop];

interface StopEntry<S> {
  readonly nextStep: StopNextStep;
  message(stop: S, binder: string): string;
}

export const STOPS: { readonly [K in DeliveryStop]: StopEntry<Extract<NamedStop, { stop: K }>> } = {
  "earlier-run-headless": {
    nextStep: "message",
    message: ({ refs }, binder) =>
      `Binder '${binder}' carries state from an earlier run (${refs} refs); rerun interactively to choose resume or clear.`,
  },
  "earlier-run-unanswered": {
    nextStep: "message",
    message: (_, binder) =>
      `Binder '${binder}' was neither resumed nor cleared; choose Resume, Clear, or Clear and stop to continue.`,
  },
  "environment-preflight": {
    nextStep: "message",
    message: ({ finding }) => `Delivery stopped before any build: ${finding}`,
  },
  "gate-probe-refused": {
    nextStep: "message",
    message: ({ refused }) => `Delivery stopped before any build: ${refused}`,
  },
  "successor-uncommitted": {
    nextStep: "message",
    message: (_, binder) => `Successor binder '${binder}' differs from its committed copy; commit it before delivering.`,
  },
  "successor-cannot-start": {
    nextStep: "none",
    message: ({ halt }, binder) => `Successor binder '${binder}' cannot start: ${halt}`,
  },
  "successor-no-predecessor-tip": {
    nextStep: "none",
    message: (_, binder) => `Preflight named no predecessor integration tip and default branch to start ${binder} from.`,
  },
  "successor-binder-not-on-default": {
    nextStep: "message",
    message: ({ predecessor, defaultBranch }, binder) =>
      `Successor binder '${binder}' is not committed on the default branch '${defaultBranch}'. ` +
      `Its first run starts from hatch/${predecessor}/integration and merges ${defaultBranch} in to bring the binder, ` +
      `so commit the binder on ${defaultBranch} (or set git config hatch.defaultBranch) before delivering.`,
  },
  "successor-merge-conflicts": {
    nextStep: "message",
    message: ({ predecessor, defaultBranch }, binder) =>
      `Merging ${defaultBranch} into hatch/${predecessor}/integration conflicts; resolve it before delivering ${binder}.`,
  },
  "successor-merge-hooks-failed": {
    nextStep: "none",
    message: ({ defaultBranch }, binder) => `Repository merge hooks failed or changed the ${defaultBranch} merge for ${binder}.`,
  },
  "successor-merge-lacks-binder": {
    nextStep: "none",
    message: ({ defaultBranch }, binder) => `The ${defaultBranch} merge for '${binder}' does not carry the committed successor binder.`,
  },
  "successor-cannot-continue": {
    nextStep: "none",
    message: ({ halt }, binder) => `Successor binder '${binder}' cannot continue: ${halt}`,
  },
  "discovery-halted": { nextStep: "halts", message: ({ reason }) => reason },
  "merged-unmarked-recovery-halted": { nextStep: "halts", message: ({ reason }) => reason },
  "pending-wave-unrecoverable": {
    nextStep: "none",
    message: () => "Pending wave tag has no recoverable first-parent item merges.",
  },
  "pending-wave-rolled-back": {
    nextStep: "none",
    message: () => "Recovered pending wave failed validation and was rolled back.",
  },
  "authority-broken": { nextStep: "message", message: ({ reason, step }) => `${reason}. Next: ${step}` },
  "inconsistent": { nextStep: "message", message: ({ snapshot }) => inconsistentMessage(snapshot) },
  "accept-anchor-missing": {
    nextStep: "none",
    message: () => "Accepted merge recovered, but its pending wave base tag is missing.",
  },
  "accept-recovery-failed": {
    nextStep: "none",
    message: () => "Interrupted human-accepted merge could not be recovered.",
  },
  "accept-recovery-rolled-back": {
    nextStep: "none",
    message: () => "Recovered accepted merge failed post-wave validation and was rolled back.",
  },
  "failed-headless": {
    nextStep: "message",
    message: (stop) => `Item '${stop.item}' is failed; rerun interactively to choose fix, accept, or defer.${
      stop.files.length > 0 ? ` Its gate attempts are recorded in ${stop.files.join(" and ")}.` : ""
    }${"readError" in stop ? ` Its gate attempts could not be read: ${stop.readError}` : ""}`,
  },
  "failed-deferred": {
    nextStep: "none",
    message: ({ item }) => `Item '${item}' remains deferred with its failed ref intact.`,
  },
  "accept-not-landed": {
    nextStep: "none",
    message: ({ item }) => `Human acceptance for '${item}' was cancelled, blocked, or rolled back.`,
  },
  "wave-rolled-back": {
    nextStep: "none",
    message: () => "Post-wave validation failed; the wave was rolled back.",
  },
  "deferred": { nextStep: "halts", message: ({ snapshot }) => deferredHaltMessage(snapshot) },
  "stuck": {
    nextStep: "none",
    message: () => "No dependency-ready item exists; the binder graph or Git state is stuck.",
  },
};

/** Where a stop happened: the run's integration worktree and waves so far (none before the loop). */
export interface StopPlace {
  readonly integrationWorktree: string;
  readonly waves: HatchDeliveryWave[];
}

/** The fields one stop adds to its result after the message. */
export type StopFields = Pick<HatchDeliveryResult, "environmentFinding" | "authorityHalt">;

/** The blocked result of a stop. The only place a blocked delivery result is written. */
export function stopResult(binder: string, stop: NamedStop, at: StopPlace, fields: StopFields = {}): HatchDeliveryResult {
  const entry = STOPS[stop.stop] as StopEntry<NamedStop>;
  return {
    schema: "hatch-delivery-v1",
    binder,
    status: "blocked",
    integrationWorktree: at.integrationWorktree,
    waves: at.waves,
    message: entry.message(stop, binder),
    ...fields,
  };
}
