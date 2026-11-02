import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBackgroundContext } from "./background-context.ts";
import { pinRoleModels, summarizeRoleModels, type RoleModelPlan } from "./role-models.ts";
import { safeProgress, type HatchRunEvent, type HatchRunProgress } from "./run-events.ts";
import {
  HatchRunFeedback,
  systemClock,
  type HatchClock,
  type HatchUiSource,
} from "./run-feedback.ts";
import type {
  HatchRunRecord,
  HatchRunRegistry,
  HatchRunSnapshot,
  HatchRunSpec,
} from "./run-registry.ts";

export type { HatchClock } from "./run-feedback.ts";

export const CANCEL_SETTLE_MS = 10_000;
// Before 1.4.0 a second dialog replaced the first and the first promise never settled, so a
// background dialog beside a foreground one could hang a run with its lock held.
export const MIN_BACKGROUND_PI_VERSION = "1.4.0";

export type HatchLaunchOutcome<R> =
  | { kind: "started" | "attached"; snapshot: HatchRunSnapshot }
  | { kind: "returned"; result: R }
  | { kind: "threw"; error: unknown };

type RunnerOutcome<R> = { ok: true; result: R } | { ok: false; error: unknown };

export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
  };
  const actual = parse(version);
  const wanted = parse(minimum);
  if (!actual || !wanted) return false;
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== wanted[index]) return actual[index] > wanted[index];
  }
  return true;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The timer is ref'd on purpose. The wait is bounded, and the caller's next steps (a cancel
// reply, the shutdown lock release) must run: an unref'd timer lets Node exit before the bound
// fires when nothing else holds the loop. Callers cancel it once the race settles, so a run
// that settles first adds no exit delay.
function delay(clock: HatchClock, ms: number): { promise: Promise<void>; cancel(): void } {
  let handle: unknown;
  const promise = new Promise<void>((resolve) => {
    handle = clock.setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clock.clearTimeout(handle) };
}

// Runs long Hatch actions after the tool call returns, so the session stays free while a
// delivery works. The registry holds what is live; this host owns how a run starts and ends.
export class HatchRunHost {
  readonly #registry: HatchRunRegistry;
  readonly #feedback: HatchRunFeedback;
  readonly #clock: HatchClock;
  readonly #version: string;
  readonly #quietPollMs?: number;
  readonly #ui = new Map<string, HatchUiSource>();

  constructor(options: {
    extension: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
    registry: HatchRunRegistry;
    feedback?: HatchRunFeedback;
    clock?: HatchClock;
    piVersion?: string;
    quietPollMs?: number;
  }) {
    this.#registry = options.registry;
    this.#clock = options.clock ?? systemClock;
    this.#feedback = options.feedback ?? new HatchRunFeedback(options.extension, this.#clock);
    this.#version = options.piVersion ?? VERSION;
    this.#quietPollMs = options.quietPollMs;
  }

  // Print and JSON modes exit at turn end and their shutdown would abort the run, so only a
  // session with a dialog-capable UI can host one.
  supportsBackground(ctx: ExtensionContext | undefined): boolean {
    return ctx?.hasUI === true && versionAtLeast(this.#version, MIN_BACKGROUND_PI_VERSION);
  }

  async launch<R extends { status: string; message?: string }>(
    ctx: ExtensionContext,
    spec: HatchRunSpec,
    toolSignal: AbortSignal | undefined,
    start: (runCtx: ExtensionContext, progress: HatchRunProgress) => Promise<R>,
    options: { roleModels?: RoleModelPlan } = {},
  ): Promise<HatchLaunchOutcome<R>> {
    const existing = this.#registry.liveForBinder(spec.binder);
    if (existing) {
      existing.attachedCount += 1;
      return { kind: "attached", snapshot: this.#registry.snapshot(existing) };
    }
    const controller = new AbortController();
    const model = ctx.model;
    const thinkingLevel = ctx.thinkingLevel;
    const plan = options.roleModels;
    const record = this.#registry.open({
      ...spec,
      controller,
      ...(model ? { model: `${model.provider}/${model.id}` } : {}),
      ...(plan ? { roleModels: summarizeRoleModels(plan), roleModelNotes: plan.notes } : {}),
    });
    const ui: HatchUiSource = () => {
      try {
        return ctx.ui;
      } catch {
        return undefined;
      }
    };
    this.#ui.set(record.runId, ui);

    let markStarted!: () => void;
    const startedSignal = new Promise<"started">((resolve) => {
      markStarted = () => resolve("started");
    });
    // Esc on the launching turn may stop a run that has not started; after the receipt the run
    // belongs to the host, and only cancelRun or shutdown stops it.
    // An interrupted launch is the operator's stop, so its result must not wake the model.
    const onToolAbort = () => {
      record.cancelRequested = true;
      controller.abort();
    };
    const unlinkTool = () => toolSignal?.removeEventListener("abort", onToolAbort);
    if (toolSignal?.aborted) onToolAbort();
    else toolSignal?.addEventListener("abort", onToolAbort, { once: true });

    const progress = safeProgress((event: HatchRunEvent) => {
      if (event.kind === "run-started") {
        if (record.started) return;
        record.started = true;
        unlinkTool();
        markStarted();
      }
      if (record.state !== "running") return;
      this.#registry.record(record, event);
      this.#feedback.event(record, event, ui);
    });
    const runCtx = createBackgroundContext(ctx, {
      signal: controller.signal,
      model,
      thinkingLevel,
      onPrompt: progress,
      abort: () => controller.abort(),
      clock: this.#clock,
      ...(this.#quietPollMs !== undefined ? { quietPollMs: this.#quietPollMs } : {}),
    });
    // The run's children read their models from this pin, never from settings mid-run.
    if (plan) pinRoleModels(runCtx, plan);

    const runner: Promise<RunnerOutcome<R>> = Promise.resolve()
      .then(() => start(runCtx, progress))
      .then(
        (result): RunnerOutcome<R> => ({ ok: true, result }),
        (error: unknown): RunnerOutcome<R> => ({ ok: false, error }),
      );
    void runner.then((outcome) => this.#settle(record, outcome));

    const first = await Promise.race([startedSignal, runner]);
    if (first === "started") {
      return { kind: "started", snapshot: this.#registry.snapshot(record) };
    }
    unlinkTool();
    return first.ok
      ? { kind: "returned", result: first.result }
      : { kind: "threw", error: first.error };
  }

  #settle<R extends { status: string; message?: string }>(
    record: HatchRunRecord,
    outcome: RunnerOutcome<R>,
  ): void {
    this.#registry.markSettled(record);
    const ui = this.#ui.get(record.runId) ?? (() => undefined);
    this.#ui.delete(record.runId);
    // A run that ended before it started answers its own tool call directly; only a caller that
    // attached in that window is waiting for a message.
    if (!record.started && record.attachedCount === 0) {
      this.#registry.discard(record);
      if (record.cancelRequested) {
        record.state = "cancelled";
        record.finishedAt = this.#clock.now();
      }
      return;
    }
    const state = record.cancelRequested ? "cancelled" : outcome.ok ? "finished" : "failed";
    const fields = outcome.ok
      ? {
          resultStatus: outcome.result.status,
          ...(typeof outcome.result.message === "string" ? { message: outcome.result.message } : {}),
          result: outcome.result,
        }
      : { error: errorText(outcome.error) };
    // Leaving the live set comes first: the turn this message wakes must see no live run.
    if (!this.#registry.finish(record, state, fields)) return;
    this.#feedback.finished(record, ui, () => this.#registry.snapshot(record));
  }

  status(query: { runId?: string; binder?: string } = {}): HatchRunSnapshot[] {
    if (query.runId) {
      const record = this.#registry.get(query.runId);
      return record ? [this.#registry.snapshot(record)] : [];
    }
    const all = this.#registry.snapshots();
    return query.binder ? all.filter((snapshot) => snapshot.binder === query.binder) : all;
  }

  async cancel(runId: string): Promise<HatchRunSnapshot | undefined> {
    const record = this.#registry.get(runId);
    if (!record) return undefined;
    if (record.state === "running") {
      record.cancelRequested = true;
      record.controller.abort();
      const wait = delay(this.#clock, CANCEL_SETTLE_MS);
      await Promise.race([record.settled, wait.promise]);
      wait.cancel();
    }
    return this.#registry.snapshot(record);
  }

  abortAll(_reason: "shutdown"): void {
    for (const record of this.#registry.live()) {
      const ui = this.#ui.get(record.runId) ?? (() => undefined);
      if (!this.#registry.finish(record, "aborted")) continue;
      record.controller.abort();
      try {
        this.#feedback.aborted(record, ui, () => this.#registry.snapshot(record));
      } catch {
        // The session is going away; Git holds the run's checkpoints either way.
      }
    }
    this.#feedback.dispose();
  }

  async settled(timeoutMs: number): Promise<void> {
    const pending = this.#registry.unsettled();
    if (pending.length === 0) return;
    const wait = delay(this.#clock, timeoutMs);
    await Promise.race([Promise.all(pending).then(() => undefined), wait.promise]);
    wait.cancel();
  }

  hasLiveRuns(): boolean {
    return this.#registry.hasLiveRuns();
  }

  liveSummaries(): string[] {
    return this.#registry.liveSummaries();
  }
}
