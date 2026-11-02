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
      failed: string[];
      // What the runner decided to do next, so no reader infers it from the lists:
      // "continue" to the next wave, "prompt" the human to fix, accept or defer a failed
      // item, or "stop" the run.
      next: HatchWaveNext;
    }
  | { kind: "companions-started" }
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
