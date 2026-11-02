import type {
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import { safeProgress, type HatchRunProgress } from "./run-events.ts";
import { systemClock, type HatchClock } from "./run-feedback.ts";

export const QUIET_POLL_MS = 750;

type PromptKind = "select" | "confirm" | "input" | "editor";

export interface BackgroundContextOptions {
  signal: AbortSignal;
  model: ExtensionContext["model"];
  thinkingLevel: ExtensionContext["thinkingLevel"];
  onPrompt: HatchRunProgress;
  abort?: () => void;
  clock?: HatchClock;
  quietPollMs?: number;
}

function sleep(clock: HatchClock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clock.clearTimeout(handle);
      resolve();
    };
    const handle = clock.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, unanswered: T): Promise<T> {
  if (signal.aborted) return Promise.resolve(unanswered);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => resolve(unanswered);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// A dialog takes the editor slot and focus at once, so it waits until the operator is not
// typing: two consecutive empty reads, or at once when the UI cannot report editor text.
async function waitForQuietEditor(
  readUi: () => ExtensionUIContext,
  signal: AbortSignal,
  clock: HatchClock,
  pollMs: number,
): Promise<void> {
  let quietReads = 0;
  while (!signal.aborted) {
    const ui = readUi();
    if (typeof ui.getEditorText !== "function") return;
    quietReads = ui.getEditorText().trim() === "" ? quietReads + 1 : 0;
    if (quietReads >= 2) return;
    await sleep(clock, pollMs, signal);
  }
}

const STALE_UI_FALLBACK: Partial<ExtensionUIContext> = {
  notify() {},
  setStatus() {},
  setWidget() {},
  setWorkingMessage() {},
  getEditorText: () => "",
};

// The tool's own context is the wrong context for a run that outlives the tool call: its
// `signal` is a live getter over whatever turn is running, so a later Esc would abort the
// run's children. Copying descriptors keeps every other getter lazy, the way pi copies a context.
export function createBackgroundContext(
  base: ExtensionContext,
  options: BackgroundContextOptions,
): ExtensionContext {
  const descriptors = Object.getOwnPropertyDescriptors(base) as PropertyDescriptorMap;
  delete descriptors.tools;
  delete descriptors.executeTool;
  const runSignal = options.signal;
  const clock = options.clock ?? systemClock;
  const pollMs = options.quietPollMs ?? QUIET_POLL_MS;
  const emit = safeProgress(options.onPrompt);
  const readUi = (): ExtensionUIContext => base.ui;

  async function dialog<T>(
    prompt: PromptKind,
    title: string,
    unanswered: T,
    open: (live: ExtensionUIContext) => Promise<T>,
    isAnswered: (value: T) => boolean,
  ): Promise<T> {
    if (runSignal.aborted) return unanswered;
    // Announced before the quiet-editor wait: an operator with a draft in the editor must
    // still hear that the run is waiting on them.
    emit({ kind: "prompt-opened", prompt, title });
    let answered = false;
    try {
      try {
        await waitForQuietEditor(readUi, runSignal, clock, pollMs);
        if (runSignal.aborted) return unanswered;
        const value = await raceAbort(open(readUi()), runSignal, unanswered);
        if (runSignal.aborted) return unanswered;
        answered = isAnswered(value);
        return value;
      } finally {
        emit({ kind: "prompt-closed", prompt, title, answered });
      }
    } catch {
      // A context replaced under the run reads as an unanswered prompt; the runners turn that
      // into a blocked result with Git state intact.
      return unanswered;
    }
  }

  function withSignal(opts: ExtensionUIDialogOptions | undefined): ExtensionUIDialogOptions {
    return { ...opts, signal: runSignal };
  }

  function wrapUi(): ExtensionUIContext {
    let live: Partial<ExtensionUIContext>;
    try {
      live = readUi();
    } catch {
      live = STALE_UI_FALLBACK;
    }
    return {
      ...live,
      select: (title: string, choices: string[], opts?: ExtensionUIDialogOptions) =>
        dialog<string | undefined>(
          "select",
          title,
          undefined,
          (ui) => ui.select(title, choices, withSignal(opts)),
          (value) => value !== undefined,
        ),
      confirm: (title: string, message: string, opts?: ExtensionUIDialogOptions) =>
        dialog<boolean>(
          "confirm",
          title,
          false,
          (ui) => ui.confirm(title, message, withSignal(opts)),
          () => true,
        ),
      input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) =>
        dialog<string | undefined>(
          "input",
          title,
          undefined,
          (ui) => ui.input(title, placeholder, withSignal(opts)),
          (value) => value !== undefined,
        ),
      // pi's editor takes no dialog options, so only the race against the run signal closes it.
      editor: (title: string, prefill?: string) =>
        dialog<string | undefined>(
          "editor",
          title,
          undefined,
          (ui) => ui.editor(title, prefill),
          (value) => value !== undefined,
        ),
    } as ExtensionUIContext;
  }

  Object.assign(descriptors, {
    signal: { get: () => runSignal, enumerable: true, configurable: true },
    ui: { get: wrapUi, enumerable: true, configurable: true },
    model: { get: () => options.model, enumerable: true, configurable: true },
    thinkingLevel: { get: () => options.thinkingLevel, enumerable: true, configurable: true },
    abort: {
      value: () => options.abort?.(),
      enumerable: true,
      configurable: true,
      writable: true,
    },
  });
  return Object.create(Object.getPrototypeOf(base), descriptors) as ExtensionContext;
}
