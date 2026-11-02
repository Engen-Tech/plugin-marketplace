import type {
  ExtensionAPI,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { roleModelsToken } from "./role-models.ts";
import type { HatchRunEvent, HatchWaveNext } from "./run-events.ts";
import type { HatchRunAction, HatchRunRecord, HatchRunRoleModels } from "./run-registry.ts";

export const HATCH_RUN_PROGRESS_ENTRY = "hatch-run-progress";
export const HATCH_RUN_WAVE_MESSAGE = "hatch-run-wave";
export const HATCH_RUN_ATTENTION_MESSAGE = "hatch-run-attention";
export const HATCH_RUN_RESULT_MESSAGE = "hatch-run-result";
export const HATCH_STATUS_KEY = "hatch";
export const STATUS_MIN_INTERVAL_MS = 1_000;
export const STATUS_TICK_MS = 30_000;
export const PROGRESS_ENTRY_MIN_INTERVAL_MS = 15_000;
// Every runner prompt is answered by the human only, so waking the model would only let it say
// that a dialog is waiting. One constant, so the operator can choose the wake in one line.
export const WAKE_ON_PROMPT = false;

export interface HatchClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const systemClock: HatchClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

function unref(handle: unknown): void {
  (handle as { unref?: () => void } | undefined)?.unref?.();
}

export type HatchUiSource = () => ExtensionUIContext | undefined;

export interface HatchRunProgressEntry {
  runId: string;
  action: HatchRunAction;
  binder: string;
  lines: string[];
}

export interface HatchRunResultDetails {
  schema: "hatch-dispatch-run-v1";
  runId: string;
  action: HatchRunAction;
  binder: string;
  item?: string;
  mode?: string;
  status: "finished" | "failed" | "cancelled" | "aborted";
  resultStatus?: string;
  message?: string;
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  roleModels?: HatchRunRoleModels;
}

const SHORT_ACTION: Record<HatchRunAction, string> = {
  deliverBinder: "deliver",
  buildItem: "build",
  runVerification: "verify",
};

const RESULT_SCHEMA: Record<HatchRunAction, string> = {
  deliverBinder: "hatch-delivery-v1",
  buildItem: "hatch-build-item-v1",
  runVerification: "hatch-verification-v1",
};

const RESULT_SKILL: Record<HatchRunAction, string> = {
  deliverBinder: "hatch-deliver",
  buildItem: "hatch-build",
  runVerification: "hatch-verify",
};

export function runResultSchema(action: HatchRunAction): string {
  return RESULT_SCHEMA[action];
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${rest}s`;
  return `${rest}s`;
}

function runLabel(record: HatchRunRecord): string {
  return `${record.action} ${record.binder}${record.item ? ` ${record.item}` : ""}`;
}

const WAVE_NEXT_TEXT: Record<HatchWaveNext, string> = {
  continue: "The run continues.",
  prompt: "The run continues to the fix, accept or defer prompt for each failed item.",
  stop: "The run stops.",
};

function list(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

// One progress line per role: `model <role>: <provider/id>, <level>, <source>`, with the
// fallback or inheritance reason in parentheses and the file and key that chose the model.
export function describeRoleModels(roleModels: HatchRunRoleModels): string[] {
  return Object.entries(roleModels).map(([role, entry]) => {
    const parts = [entry.model];
    if (entry.thinkingLevel) parts.push(entry.thinkingLevel);
    parts.push(entry.reason ? `${entry.source} (${entry.reason})` : entry.source);
    if (entry.file && entry.key) parts.push(`from '${entry.file}' ${entry.key}`);
    return `model ${role}: ${parts.join(", ")}`;
  });
}

export function describeRunEvent(event: HatchRunEvent): string {
  switch (event.kind) {
    case "run-started":
      return `started${event.item ? ` ${event.item}` : ""}`;
    case "binder-loaded":
      return `binder loaded: ${event.items.length} items, ${event.carried.length} already landed`;
    case "wave-started":
      return `wave ${event.wave} started: ${list(event.items)}`;
    case "item-built":
      return `${event.item} ${event.status} (${event.attempts} attempt${event.attempts === 1 ? "" : "s"})`;
    case "item-halted": {
      const line = `${event.item} halted (${event.status}): ${event.reason}`;
      if (!event.check) return line;
      const check = event.check;
      const command = check.command.replace(/\s+/g, " ").trim();
      const shown = command.length > 200 ? `${command.slice(0, 199)}…` : command;
      const exit = check.exitCode === null ? "no exit code" : `exit ${check.exitCode}`;
      return `${line}\n  check ${check.id}: \`${shown}\` (${exit})${check.remediation ? ` · ${check.remediation}` : ""}`;
    }
    case "environment-preflight":
      return `environment preflight: ${list(event.items)} need installed dependencies and no setup is declared; suggested setup: \`${event.suggestedSetup}\``;
    case "item-merged":
      return `${event.item} merged${event.accepted ? " (accepted)" : ""}`;
    case "wave-finished":
      return `wave ${event.wave} ${event.status}: landed ${list(event.landed)}; failed ${list(event.failed)}`;
    case "companions-started":
      return "companions started";
    case "prompt-opened":
      return `waiting on you: ${event.title}`;
    case "prompt-closed":
      return `${event.title}: ${event.answered ? "answered" : "not answered"}`;
  }
}

function resultStatusOf(record: HatchRunRecord): HatchRunResultDetails["status"] {
  if (record.state === "running") return "finished";
  return record.state;
}

export function runResultDetails(record: HatchRunRecord): HatchRunResultDetails {
  const finishedAt = record.finishedAt ?? record.startedAt;
  return {
    schema: "hatch-dispatch-run-v1",
    runId: record.runId,
    action: record.action,
    binder: record.binder,
    ...(record.item !== undefined ? { item: record.item } : {}),
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    status: resultStatusOf(record),
    ...(record.resultStatus !== undefined ? { resultStatus: record.resultStatus } : {}),
    ...(record.message !== undefined ? { message: record.message } : {}),
    startedAt: new Date(record.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    elapsedMs: Math.max(0, finishedAt - record.startedAt),
    ...(record.roleModels !== undefined ? { roleModels: structuredClone(record.roleModels) } : {}),
  };
}

function fenced(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

// The JSON in the fence is the same stringify the sync path returns as tool text, because the
// model handles the result exactly as the skill describes for a direct tool result.
export function runResultContent(record: HatchRunRecord, snapshot: () => unknown): string {
  const details = runResultDetails(record);
  const elapsed = formatDuration(details.elapsedMs);
  const head = `hatch run ${record.runId} · ${runLabel(record)}`;
  const skill = RESULT_SKILL[record.action];
  if (record.state === "failed") {
    return [
      `${head} · failed: ${record.error ?? "unknown error"} · ${elapsed}`,
      `Git holds every checkpoint written before the error. Treat this like the hatch_dispatch tool error the ${skill} skill describes.`,
      "",
      fenced(snapshot()),
    ].join("\n");
  }
  if (record.state === "aborted") {
    return [
      `${head} · aborted · ${elapsed}`,
      "Stopped by session shutdown; rerun the same action to resume from Git.",
    ].join("\n");
  }
  if (record.state === "cancelled" && record.result === undefined) {
    return [
      `${head} · cancelled · ${elapsed}`,
      "Stopped at the operator's request; rerun the same action to resume from Git.",
      "",
      fenced(snapshot()),
    ].join("\n");
  }
  const lines = [
    `${head} · ${record.state === "cancelled" ? "cancelled" : "finished"}: ${record.resultStatus ?? "unknown"} · ${elapsed}`,
  ];
  if (record.message) lines.push(record.message);
  lines.push(
    `This is the ${runResultSchema(record.action)} result of a background hatch_dispatch call. Handle it exactly as the ${skill} skill describes for that result.`,
    "",
    fenced(record.result),
  );
  return lines.join("\n");
}

interface RunFeedbackState {
  record: HatchRunRecord;
  ui: HatchUiSource;
  buffer: string[];
  lastFlushAt: number;
  flushTimer?: unknown;
}

// Decides how each run event is shown. Only the wave, attention and result messages reach the
// model; per-item progress goes to custom entries, which never enter its context.
export class HatchRunFeedback {
  readonly #extension: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
  readonly #clock: HatchClock;
  readonly #runs = new Map<string, RunFeedbackState>();
  #ui?: HatchUiSource;
  #lastStatusAt = Number.NEGATIVE_INFINITY;
  #statusTimer?: unknown;
  #tick?: unknown;
  #statusShown = false;

  constructor(
    extension: Pick<ExtensionAPI, "sendMessage" | "appendEntry">,
    clock: HatchClock = systemClock,
  ) {
    this.#extension = extension;
    this.#clock = clock;
  }

  event(record: HatchRunRecord, event: HatchRunEvent, ui: HatchUiSource): void {
    const state = this.#state(record, ui);
    state.buffer.push(describeRunEvent(event));
    // The host passes run-started once per run, so the table is listed once.
    if (event.kind === "run-started" && record.roleModels) {
      state.buffer.push(...describeRoleModels(record.roleModels));
    }
    switch (event.kind) {
      case "environment-preflight":
        this.#flush(state);
        this.#notify(ui, `hatch ${SHORT_ACTION[record.action]} ${record.binder}: environment preflight found oracles with no setup`);
        break;
      case "item-halted":
        this.#flush(state);
        this.#notify(ui, `hatch ${SHORT_ACTION[record.action]} ${record.binder}: ${event.item} halted (${event.status})`);
        break;
      case "wave-finished":
        this.#flush(state);
        this.#send(
          HATCH_RUN_WAVE_MESSAGE,
          this.#waveText(record, event),
          { runId: record.runId, binder: record.binder, ...event },
          false,
        );
        break;
      case "prompt-opened": {
        this.#flush(state);
        const text = `hatch run ${record.runId} · ${runLabel(record)} needs you: ${event.title}. The dialog opens once the editor is empty.`;
        this.#send(
          HATCH_RUN_ATTENTION_MESSAGE,
          text,
          { runId: record.runId, binder: record.binder, prompt: event.prompt, title: event.title },
          WAKE_ON_PROMPT,
        );
        this.#notify(ui, text);
        break;
      }
      default:
        this.#scheduleFlush(state);
    }
    this.#scheduleStatus();
  }

  finished(record: HatchRunRecord, ui: HatchUiSource, snapshot: () => unknown): void {
    const state = this.#state(record, ui);
    this.#flush(state);
    this.#drop(state);
    const wake = record.state !== "cancelled";
    this.#send(
      HATCH_RUN_RESULT_MESSAGE,
      runResultContent(record, snapshot),
      runResultDetails(record),
      wake,
      wake ? "followUp" : undefined,
    );
    this.#scheduleStatus();
  }

  // Shutdown path: the session is about to go, so nothing waits on a throttle.
  aborted(record: HatchRunRecord, ui: HatchUiSource, snapshot: () => unknown): void {
    const state = this.#runs.get(record.runId);
    if (state) this.#drop(state);
    this.#ui = ui;
    this.#renderStatus();
    this.#send(
      HATCH_RUN_RESULT_MESSAGE,
      runResultContent(record, snapshot),
      runResultDetails(record),
      false,
    );
  }

  dispose(): void {
    for (const state of this.#runs.values()) {
      if (state.flushTimer !== undefined) this.#clock.clearTimeout(state.flushTimer);
    }
    this.#runs.clear();
    if (this.#statusTimer !== undefined) this.#clock.clearTimeout(this.#statusTimer);
    this.#statusTimer = undefined;
    this.#stopTick();
  }

  #state(record: HatchRunRecord, ui: HatchUiSource): RunFeedbackState {
    this.#ui = ui;
    let state = this.#runs.get(record.runId);
    if (!state) {
      state = { record, ui, buffer: [], lastFlushAt: Number.NEGATIVE_INFINITY };
      this.#runs.set(record.runId, state);
      this.#startTick();
    }
    return state;
  }

  #drop(state: RunFeedbackState): void {
    if (state.flushTimer !== undefined) this.#clock.clearTimeout(state.flushTimer);
    this.#runs.delete(state.record.runId);
    if (this.#runs.size === 0) this.#stopTick();
  }

  #scheduleFlush(state: RunFeedbackState): void {
    if (state.flushTimer !== undefined) return;
    const wait = state.lastFlushAt + PROGRESS_ENTRY_MIN_INTERVAL_MS - this.#clock.now();
    if (wait <= 0) {
      this.#flush(state);
      return;
    }
    state.flushTimer = this.#clock.setTimeout(() => {
      state.flushTimer = undefined;
      this.#flush(state);
    }, wait);
    unref(state.flushTimer);
  }

  #flush(state: RunFeedbackState): void {
    if (state.flushTimer !== undefined) {
      this.#clock.clearTimeout(state.flushTimer);
      state.flushTimer = undefined;
    }
    if (state.buffer.length === 0) return;
    const entry: HatchRunProgressEntry = {
      runId: state.record.runId,
      action: state.record.action,
      binder: state.record.binder,
      lines: state.buffer.splice(0),
    };
    state.lastFlushAt = this.#clock.now();
    try {
      this.#extension.appendEntry(HATCH_RUN_PROGRESS_ENTRY, entry);
    } catch {
      // Progress display never changes what a run does.
    }
  }

  #send(
    customType: string,
    content: string,
    details: unknown,
    triggerTurn: boolean,
    deliverAs?: "followUp",
  ): void {
    try {
      this.#extension.sendMessage(
        { customType, content, display: true, details },
        deliverAs ? { triggerTurn, deliverAs } : { triggerTurn },
      );
    } catch {
      // A stale session cannot take the message; runStatus still holds the result.
    }
  }

  #notify(ui: HatchUiSource, text: string): void {
    try {
      ui()?.notify(text, "warning");
    } catch {
      // A toast that cannot be shown changes nothing about the run.
    }
  }

  #waveText(record: HatchRunRecord, event: Extract<HatchRunEvent, { kind: "wave-finished" }>): string {
    const halted = record.progress.halted.map((entry) => `${entry.item} (${entry.status}: ${entry.reason})`);
    const parts = [`hatch run ${record.runId} · ${runLabel(record)} · wave ${event.wave} ${event.status}.`];
    const rolledBack = event.status === "rolled-back";
    if (rolledBack && event.landed.length === 0) parts.push("Nothing landed.");
    else if (rolledBack) parts.push(`Rolled back to wave-${event.wave}-base: ${list(event.landed)}.`);
    else parts.push(`Landed ${list(event.landed)}.`);
    if (event.failed.length > 0) parts.push(`Failed ${list(event.failed)}.`);
    if (halted.length > 0) parts.push(`Halted so far: ${halted.join("; ")}.`);
    // The runner's own decision, carried in the event; never inferred from the lists.
    parts.push(WAVE_NEXT_TEXT[event.next]);
    return parts.join(" ");
  }

  #statusText(): string | undefined {
    const now = this.#clock.now();
    const texts = [...this.#runs.values()].map(({ record }) => {
      const head = `hatch ${SHORT_ACTION[record.action]} ${record.binder}${record.item ? ` ${record.item}` : ""}`;
      const progress = record.progress;
      if (progress.pendingPrompt) return `${head} · waiting on you: ${progress.pendingPrompt.title}`;
      const parts = [head];
      // The footer is shared by every run, so it gets one provenance token, never the table.
      if (record.roleModels) parts.push(roleModelsToken(record.roleModels));
      if (progress.wave !== undefined) parts.push(`wave ${progress.wave}`);
      if (progress.total !== undefined) parts.push(`${progress.landed.length}/${progress.total} landed`);
      if (progress.building.length > 0) parts.push(`building ${progress.building.join(", ")}`);
      parts.push(formatDuration(now - record.startedAt));
      return parts.join(" · ");
    });
    return texts.length > 0 ? texts.join(" | ") : undefined;
  }

  #scheduleStatus(): void {
    if (this.#statusTimer !== undefined) return;
    const wait = this.#lastStatusAt + STATUS_MIN_INTERVAL_MS - this.#clock.now();
    if (wait <= 0) {
      this.#renderStatus();
      return;
    }
    this.#statusTimer = this.#clock.setTimeout(() => {
      this.#statusTimer = undefined;
      this.#renderStatus();
    }, wait);
    unref(this.#statusTimer);
  }

  #renderStatus(): void {
    if (this.#statusTimer !== undefined) {
      this.#clock.clearTimeout(this.#statusTimer);
      this.#statusTimer = undefined;
    }
    const text = this.#statusText();
    if (text === undefined && !this.#statusShown) return;
    this.#lastStatusAt = this.#clock.now();
    this.#statusShown = text !== undefined;
    try {
      this.#ui?.()?.setStatus(HATCH_STATUS_KEY, text);
    } catch {
      // The footer is a convenience; a stale UI must not break the run.
    }
  }

  #startTick(): void {
    if (this.#tick !== undefined) return;
    this.#tick = this.#clock.setInterval(() => this.#scheduleStatus(), STATUS_TICK_MS);
    unref(this.#tick);
  }

  #stopTick(): void {
    if (this.#tick === undefined) return;
    this.#clock.clearInterval(this.#tick);
    this.#tick = undefined;
  }
}

interface RenderTheme {
  fg(color: "dim" | "customMessageLabel" | "customMessageText", text: string): string;
}

type TextComponent = typeof import("@earendil-works/pi-tui").Text;

// pi-tui is a pi virtual module; a pi without it still loads Hatch and only loses the renderers,
// so the result falls back to pi's default Markdown rendering.
export async function registerHatchRunRenderers(extension: ExtensionAPI): Promise<boolean> {
  let Text: TextComponent;
  try {
    ({ Text } = await import("@earendil-works/pi-tui"));
  } catch {
    return false;
  }
  if (typeof extension.registerEntryRenderer === "function") {
    extension.registerEntryRenderer<HatchRunProgressEntry>(
      HATCH_RUN_PROGRESS_ENTRY,
      (entry, _options, theme: RenderTheme) => {
        const data = entry.data;
        if (!data || !Array.isArray(data.lines)) return undefined;
        const lines = data.lines.map((line) => theme.fg("dim", `${data.runId} · ${line}`));
        return new Text(lines.join("\n"), 1, 0);
      },
    );
  }
  if (typeof extension.registerMessageRenderer === "function") {
    // Without a renderer pi prints the whole result as Markdown, which for a long delivery is
    // hundreds of lines; collapsed shows the headline and summary, Ctrl+O shows all of it.
    extension.registerMessageRenderer<HatchRunResultDetails>(
      HATCH_RUN_RESULT_MESSAGE,
      (message, options, theme: RenderTheme) => {
        const content = typeof message.content === "string"
          ? message.content
          : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n");
        const label = theme.fg("customMessageLabel", `[${HATCH_RUN_RESULT_MESSAGE}]`);
        if (options.expanded) {
          return new Text(`${label}\n${theme.fg("customMessageText", content)}`, 1, 0);
        }
        const [headline = "", second = ""] = content.split("\n");
        const summary = message.details?.message ?? (second.startsWith("This is the") ? "" : second);
        const shown = [headline, summary].filter((line) => line.length > 0).join("\n");
        return new Text(
          `${label}\n${theme.fg("customMessageText", shown)}\n${theme.fg("dim", "(Ctrl+O to expand)")}`,
          1,
          0,
        );
      },
    );
  }
  return true;
}
