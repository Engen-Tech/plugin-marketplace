import { randomUUID } from "node:crypto";
import type { HatchRunEvent } from "./run-events.ts";
import type { HatchModelRole, RoleModelSummaryEntry } from "./role-models.ts";

export type HatchRunAction = "deliverBinder" | "buildItem" | "runVerification";
export type HatchRunState = "running" | "finished" | "failed" | "cancelled" | "aborted";
export type HatchRunMode = "full" | "boundary-only";

export const RETAINED_FINISHED = 10;
export const RECENT_EVENTS = 20;

export interface HatchRunProgressSnapshot {
  phase: HatchRunEvent["kind"];
  total?: number;
  wave?: number;
  building: string[];
  built: string[];
  landed: string[];
  halted: { item: string; status: string; reason: string }[];
  pendingPrompt?: { prompt: string; title: string; since: string };
}

// The role table a run was launched with, keyed by role; pinned once and never re-read.
export type HatchRunRoleModels = Record<HatchModelRole, RoleModelSummaryEntry>;

export interface HatchRunSpec {
  action: HatchRunAction;
  binder: string;
  item?: string;
  mode?: HatchRunMode;
}

export interface HatchRunRecord {
  readonly runId: string;
  readonly action: HatchRunAction;
  readonly binder: string;
  readonly item?: string;
  readonly mode?: HatchRunMode;
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly model?: string;
  readonly roleModels?: HatchRunRoleModels;
  readonly roleModelNotes?: readonly string[];
  state: HatchRunState;
  started: boolean;
  attachedCount: number;
  cancelRequested: boolean;
  progress: HatchRunProgressSnapshot;
  recentEvents: { at: string; event: HatchRunEvent }[];
  finishedAt?: number;
  resultStatus?: string;
  message?: string;
  result?: unknown;
  error?: string;
  settled: Promise<void>;
}

export interface HatchRunSnapshot {
  runId: string;
  action: HatchRunAction;
  binder: string;
  item?: string;
  mode?: HatchRunMode;
  status: HatchRunState;
  startedAt: string;
  elapsedMs: number;
  model?: string;
  roleModels?: HatchRunRoleModels;
  roleModelNotes?: string[];
  cancelRequested?: boolean;
  progress: HatchRunProgressSnapshot;
  finishedAt?: string;
  resultStatus?: string;
  message?: string;
  result?: unknown;
  error?: string;
}

function newRunId(): string {
  return `hatch-run-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

function remove(list: string[], value: string): string[] {
  return list.filter((entry) => entry !== value);
}

function addOnce(list: string[], value: string): string[] {
  return list.includes(value) ? list : [...list, value];
}

export function foldRunEvent(
  progress: HatchRunProgressSnapshot,
  event: HatchRunEvent,
  at: string,
): HatchRunProgressSnapshot {
  const next: HatchRunProgressSnapshot = { ...progress, phase: event.kind };
  switch (event.kind) {
    case "binder-loaded":
      next.total = event.items.length;
      next.landed = event.carried.reduce(addOnce, next.landed);
      break;
    case "wave-started":
      next.wave = event.wave;
      next.building = [...event.items];
      break;
    // A kicked-back item's worker is running again until it builds or halts.
    case "item-kicked-back":
      next.building = addOnce(next.building, event.item);
      break;
    case "item-built":
      next.building = remove(next.building, event.item);
      next.built = addOnce(next.built, event.item);
      break;
    case "item-halted":
      next.building = remove(next.building, event.item);
      next.halted = [
        ...next.halted.filter((entry) => entry.item !== event.item),
        { item: event.item, status: event.status, reason: event.reason },
      ];
      break;
    case "item-merged":
      next.building = remove(next.building, event.item);
      next.landed = addOnce(next.landed, event.item);
      break;
    case "wave-finished":
      next.wave = event.wave;
      next.building = [];
      // A rolled-back wave resets integration to its base, so its merges no longer count.
      if (event.status === "passed") next.landed = event.landed.reduce(addOnce, next.landed);
      if (event.status === "rolled-back") {
        next.landed = next.landed.filter((item) => !event.landed.includes(item));
      }
      break;
    case "prompt-opened":
      next.pendingPrompt = { prompt: event.prompt, title: event.title, since: at };
      break;
    case "prompt-closed":
      delete next.pendingPrompt;
      break;
    default:
      break;
  }
  return next;
}

// One live run per binder per process, so a second long action can attach instead of
// contending for the lock its own process already holds.
export class HatchRunRegistry {
  readonly #live = new Map<string, HatchRunRecord>();
  readonly #finished: HatchRunRecord[] = [];
  readonly #settle = new Map<string, () => void>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  open(
    spec: HatchRunSpec & {
      controller?: AbortController;
      model?: string;
      roleModels?: HatchRunRoleModels;
      roleModelNotes?: readonly string[];
    },
  ): HatchRunRecord {
    if (this.liveForBinder(spec.binder)) {
      throw new Error(`A Hatch run is already live for binder '${spec.binder}'`);
    }
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let runId = newRunId();
    while (this.get(runId)) runId = newRunId();
    const record: HatchRunRecord = {
      runId,
      action: spec.action,
      binder: spec.binder,
      ...(spec.item !== undefined ? { item: spec.item } : {}),
      ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
      controller: spec.controller ?? new AbortController(),
      startedAt: this.#now(),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.roleModels !== undefined ? { roleModels: spec.roleModels } : {}),
      ...(spec.roleModelNotes !== undefined && spec.roleModelNotes.length > 0
        ? { roleModelNotes: spec.roleModelNotes }
        : {}),
      state: "running",
      started: false,
      attachedCount: 0,
      cancelRequested: false,
      progress: { phase: "run-started", building: [], built: [], landed: [], halted: [] },
      recentEvents: [],
      settled,
    };
    this.#live.set(runId, record);
    this.#settle.set(runId, resolveSettled);
    return record;
  }

  record(record: HatchRunRecord, event: HatchRunEvent): void {
    const at = new Date(this.#now()).toISOString();
    record.progress = foldRunEvent(record.progress, event, at);
    record.recentEvents.push({ at, event });
    if (record.recentEvents.length > RECENT_EVENTS) {
      record.recentEvents.splice(0, record.recentEvents.length - RECENT_EVENTS);
    }
  }

  // Leaves the live set and is retained for runStatus. Returns false when the record had
  // already left, so a late settle after a shutdown abort never posts a second result.
  finish(
    record: HatchRunRecord,
    state: Exclude<HatchRunState, "running">,
    fields: { resultStatus?: string; message?: string; result?: unknown; error?: string } = {},
  ): boolean {
    if (this.#live.get(record.runId) !== record) return false;
    this.#live.delete(record.runId);
    record.state = state;
    record.finishedAt = this.#now();
    Object.assign(record, fields);
    this.#finished.unshift(record);
    if (this.#finished.length > RETAINED_FINISHED) this.#finished.length = RETAINED_FINISHED;
    return true;
  }

  // A run that never started and that nobody attached to leaves no trace.
  discard(record: HatchRunRecord): void {
    if (this.#live.get(record.runId) === record) this.#live.delete(record.runId);
  }

  markSettled(record: HatchRunRecord): void {
    const resolve = this.#settle.get(record.runId);
    this.#settle.delete(record.runId);
    resolve?.();
  }

  unsettled(): Promise<void>[] {
    return [...this.#live.values(), ...this.#finished]
      .filter((record) => this.#settle.has(record.runId))
      .map((record) => record.settled);
  }

  get(runId: string): HatchRunRecord | undefined {
    return this.#live.get(runId) ?? this.#finished.find((record) => record.runId === runId);
  }

  liveForBinder(binder: string): HatchRunRecord | undefined {
    for (const record of this.#live.values()) {
      if (record.binder === binder) return record;
    }
    return undefined;
  }

  live(): HatchRunRecord[] {
    return [...this.#live.values()];
  }

  hasLiveRuns(): boolean {
    return this.#live.size > 0;
  }

  liveSummaries(): string[] {
    return this.live().map((record) =>
      `${record.action} ${record.binder}${record.item ? ` ${record.item}` : ""} (${record.runId})`,
    );
  }

  snapshot(record: HatchRunRecord): HatchRunSnapshot {
    const end = record.finishedAt ?? this.#now();
    return {
      runId: record.runId,
      action: record.action,
      binder: record.binder,
      ...(record.item !== undefined ? { item: record.item } : {}),
      ...(record.mode !== undefined ? { mode: record.mode } : {}),
      status: record.state,
      startedAt: new Date(record.startedAt).toISOString(),
      elapsedMs: Math.max(0, end - record.startedAt),
      ...(record.model !== undefined ? { model: record.model } : {}),
      ...(record.roleModels !== undefined ? { roleModels: structuredClone(record.roleModels) } : {}),
      ...(record.roleModelNotes !== undefined ? { roleModelNotes: [...record.roleModelNotes] } : {}),
      ...(record.cancelRequested ? { cancelRequested: true } : {}),
      progress: structuredClone(record.progress),
      ...(record.finishedAt !== undefined
        ? { finishedAt: new Date(record.finishedAt).toISOString() }
        : {}),
      ...(record.resultStatus !== undefined ? { resultStatus: record.resultStatus } : {}),
      ...(record.message !== undefined ? { message: record.message } : {}),
      ...(record.result !== undefined ? { result: record.result } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
    };
  }

  // Live first, then the newest finished.
  snapshots(): HatchRunSnapshot[] {
    return [...this.live(), ...this.#finished].map((record) => this.snapshot(record));
  }
}
