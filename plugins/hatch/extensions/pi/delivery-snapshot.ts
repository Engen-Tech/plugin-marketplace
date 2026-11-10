import type { HatchGatePhase, HatchGateRole } from "./gate-attempts.ts";
import { deriveItemGitState, type HatchItemGitState } from "./git-state.ts";
import type { HaltView } from "./halt-record.ts";
import type { HatchHaltKind } from "./item-halt.ts";
import type { StateDiagnosis } from "./state-diagnosis.ts";
import type { HatchVerificationResult } from "./verification-runner.ts";

// The gate whose cap halted an item in this run: the runner's HaltGate, by shape.
interface SnapshotHaltGate {
  readonly role: HatchGateRole;
  readonly phase: HatchGatePhase;
  readonly verification?: HatchVerificationResult;
  readonly merge?: { readonly integrationTip: string; readonly mergeTree: string };
}

// One halt this run recorded, as the result's `halts` holds it.
interface SnapshotHaltEntry {
  readonly item: string;
  readonly phase: "build" | "merge";
  readonly status: string;
  readonly reason: string;
  readonly kind: HatchHaltKind;
  readonly nextStep?: string;
}

/** One binder item as a pass sees it. */
export interface SnapshotItem {
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly carried: boolean;
  // Carried, or derived `done` in Git.
  readonly done: boolean;
  // This run's deferral of the item, when it has one.
  readonly deferred?: { readonly status: string; readonly message: string };
  // This run's halt reason for the item, the one its fix/accept/defer prompt names, with
  // the details of the latest halt this run recorded for it. Absent when this run set no
  // reason: a discovery halt, a blocked build, or a hand fix that cleared it.
  readonly halt?: {
    readonly reason: string;
    readonly status?: string;
    readonly kind?: HatchHaltKind;
    readonly phase?: "build" | "merge";
    readonly nextStep?: string;
  };
  // The gate whose cap halted the item in this run, when a cap did.
  readonly haltGate?: SnapshotHaltGate;
  // The halt record's view, read for a failed item this run has no reason for.
  readonly record?: HaltView;
  // What the contradictory-state stop says about the item, read when it is inconsistent.
  readonly diagnosis?: StateDiagnosis;
}

/**
 * The delivery's state at the top of one pass: the Git reads the pass decides from, and a
 * copy of this run's memory. Read-only; an action that changes Git re-reads Git itself.
 */
export interface DeliverySnapshot {
  readonly binder: string;
  readonly pass: number;
  // The number the next wave would take.
  readonly wave: number;
  readonly archived: boolean;
  // Every active item's derived state. Carried items are never derived.
  readonly states: ReadonlyMap<string, HatchItemGitState>;
  readonly pending?: { binder: string; wave: number; base: string; baseTag: string };
  // Every binder item, in binder order.
  readonly items: readonly SnapshotItem[];
  // Done items, carried included, in binder order.
  readonly landed: readonly string[];
  readonly carried: readonly string[];
  readonly landedThisRun: readonly string[];
  // Not done, not deferred, every dependency done: the items a wave may take, in binder order.
  readonly frontier: readonly string[];
  // The items this run deferred, in the order it deferred them.
  readonly deferred: readonly string[];
  // Not done and waiting, directly or through others, on a deferred item that is not done:
  // direct dependents first, then theirs, each round in binder order.
  readonly stalled: readonly string[];
  readonly sendBackRefused: ReadonlyMap<string, string>;
}

interface SnapshotParts {
  binder: string;
  pass: number;
  wave: number;
  archived: boolean;
  items: readonly { id: string; depends_on: readonly string[] }[];
  carried: ReadonlySet<string>;
  states: ReadonlyMap<string, HatchItemGitState>;
  pending?: DeliverySnapshot["pending"];
  deferred: ReadonlyMap<string, { status: string; message: string }>;
  landedThisRun: readonly string[];
  sendBackRefused: ReadonlyMap<string, string>;
  // This run's halt memory; absent means none.
  haltReasons?: ReadonlyMap<string, string>;
  haltGates?: ReadonlyMap<string, SnapshotHaltGate>;
  halts?: readonly SnapshotHaltEntry[];
  records?: ReadonlyMap<string, HaltView>;
  diagnoses?: ReadonlyMap<string, StateDiagnosis>;
}

/** Builds a snapshot from values already read. Pure: no Git, no clock. */
export function buildSnapshot(parts: SnapshotParts): DeliverySnapshot {
  const done = (id: string): boolean => parts.carried.has(id) || parts.states.get(id)?.state === "done";
  const items: SnapshotItem[] = parts.items.map((item) => {
    const deferred = parts.deferred.get(item.id);
    const reason = parts.haltReasons?.get(item.id);
    const latest = parts.halts?.findLast((halt) => halt.item === item.id);
    const gate = parts.haltGates?.get(item.id);
    const record = parts.records?.get(item.id);
    const diagnosis = parts.diagnoses?.get(item.id);
    return {
      id: item.id,
      dependsOn: [...item.depends_on],
      carried: parts.carried.has(item.id),
      done: done(item.id),
      ...(deferred ? { deferred: { ...deferred } } : {}),
      ...(reason !== undefined
        ? {
          halt: {
            reason,
            ...(latest
              ? {
                status: latest.status,
                kind: latest.kind,
                phase: latest.phase,
                ...(latest.nextStep !== undefined ? { nextStep: latest.nextStep } : {}),
              }
              : {}),
          },
        }
        : {}),
      ...(gate ? { haltGate: { ...gate } } : {}),
      ...(record ? { record } : {}),
      ...(diagnosis ? { diagnosis } : {}),
    };
  });
  // The deferred stop's "stalled behind them": grow the blocked set from the halted items
  // until no item joins, so a dependent's dependent follows it.
  const blocked = new Set([...parts.deferred.keys()].filter((id) => !done(id)));
  const stalled: string[] = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of items) {
      if (blocked.has(item.id) || item.done) continue;
      if (item.dependsOn.some((dependency) => blocked.has(dependency))) {
        blocked.add(item.id);
        stalled.push(item.id);
        grew = true;
      }
    }
  }
  return {
    binder: parts.binder,
    pass: parts.pass,
    wave: parts.wave,
    archived: parts.archived,
    states: new Map(parts.states),
    ...(parts.pending ? { pending: { ...parts.pending } } : {}),
    items,
    landed: items.filter((item) => item.done).map((item) => item.id),
    carried: items.filter((item) => item.carried).map((item) => item.id),
    landedThisRun: [...parts.landedThisRun],
    frontier: items
      .filter((item) => !item.done && !item.deferred && item.dependsOn.every(done))
      .map((item) => item.id),
    deferred: [...parts.deferred.keys()],
    stalled,
    sendBackRefused: new Map(parts.sendBackRefused),
  };
}

/**
 * The aggregate stop for a run whose remaining frontier is held by items halted in this
 * run: each halted item with its status and reason, what landed, and what stalls behind them.
 */
export function deferredHaltMessage(snapshot: DeliverySnapshot): string {
  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  const done = (id: string): boolean => byId.get(id)?.done === true;
  const halted = snapshot.deferred.filter((id) => !done(id));
  // An item that landed and was later rolled back has lost its done ref, so the
  // done check keeps the list to what is on the integration tip now.
  const landed = [...new Set(snapshot.landedThisRun)].filter(done);
  return [
    ...halted.map((id) => {
      const deferred = byId.get(id)?.deferred;
      return `${id} (${deferred?.status}): ${deferred?.message}`;
    }),
    `landed: ${landed.length > 0 ? landed.join(", ") : "none"}`,
    `stalled behind them: ${snapshot.stalled.length > 0 ? snapshot.stalled.join(", ") : "none"}`,
  ].join("\n");
}

/**
 * Reads Git for one pass and builds its snapshot: every active (not carried) item's state,
 * then the pending wave anchor, then, with `haltView`, the halt record of each failed item
 * this run has no reason for, then, with `diagnose`, the diagnosis of each inconsistent
 * item, in that order. The exit snapshot passes neither: `report()` reads only `done`.
 * The only Git reader of a snapshot.
 */
export async function takeSnapshot(
  io: {
    repoRoot: string;
    pendingAnchor(): Promise<DeliverySnapshot["pending"]>;
    derive?: typeof deriveItemGitState;
    haltView?(item: string): Promise<HaltView | undefined>;
    diagnose?(state: HatchItemGitState): Promise<StateDiagnosis>;
  },
  parts: Omit<SnapshotParts, "states" | "pending" | "records" | "diagnoses">,
): Promise<DeliverySnapshot> {
  const derive = io.derive ?? deriveItemGitState;
  const states = new Map(
    await Promise.all(parts.items.filter((item) => !parts.carried.has(item.id)).map(async (item) => [
      item.id,
      await derive(io.repoRoot, parts.binder, item.id),
    ] as const)),
  );
  const pending = await io.pendingAnchor();
  const records = new Map<string, HaltView>();
  if (io.haltView) {
    for (const [id, state] of states) {
      if (state.state !== "failed" || parts.haltReasons?.has(id)) continue;
      const view = await io.haltView(id);
      if (view) records.set(id, view);
    }
  }
  // A diagnosis only words the stop; when its reads fail, the stop still names the item
  // and its diagnostics, so a failure here never turns the stop into a thrown run.
  const diagnoses = new Map<string, StateDiagnosis>();
  if (io.diagnose) {
    for (const [id, state] of states) {
      if (state.state !== "inconsistent") continue;
      const diagnosis = await io.diagnose(state).catch(() => undefined);
      if (diagnosis) diagnoses.set(id, diagnosis);
    }
  }
  return buildSnapshot({ ...parts, states, ...(pending ? { pending } : {}), records, diagnoses });
}
