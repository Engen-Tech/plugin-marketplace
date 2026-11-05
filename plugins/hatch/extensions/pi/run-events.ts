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

// Progress a Hatch runner reports while it works. Runners never decide how an event is shown;
// the run host does. A sink must never break a run, so runners call it through safeProgress.
export type HatchRunEvent =
  | { kind: "run-started"; binder: string; item?: string }
  | { kind: "binder-loaded"; items: string[]; carried: string[] }
  | { kind: "wave-started"; wave: number; items: string[] }
  | { kind: "item-built"; wave?: number; item: string; status: string; attempts: number }
  // A merge-time gate concern sent the item back to its own worker with the findings,
  // while that gate's shared attempt budget remains. `attempt` counts the gate's concerns
  // so far, out of `cap`.
  | { kind: "item-kicked-back"; wave?: number; item: string; gate: string; attempt: number; cap: number }
  // A marked fix was committed past the item's failed ref: the stale ref is dropped and
  // the new tip re-validates without a prompt.
  | { kind: "item-hand-fixed"; item: string; failed: string; tip: string }
  // A merge-time or accept-time review's verdicts could not be written to the gate-attempt
  // ledger, because the ledger cannot be read or appended. Nothing was recorded; the
  // item's landing is decided as before. `file` is the ledger file, when known.
  | { kind: "gate-ledger-unrecorded"; wave?: number; item: string; file?: string; error: string }
  | {
      kind: "item-halted";
      wave?: number;
      item: string;
      status: string;
      reason: string;
      check?: HatchRunEventCheck;
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
