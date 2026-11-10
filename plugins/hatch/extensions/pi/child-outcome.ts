// What a Pi child returns to the host, and what the host does when it fails.
//
// The contract: a child runner that returns `ChildOutcome<T>` reports every
// model-caused failure as a value, and throws only on cancellation and on host
// faults (moved evidence, a moved role file or runtime, an unpinned role, a lost
// lease, git state the runner cannot trust). A total parser of model-written text
// returns `Parsed<T>`: a value or a named defect, never a throw and never silence.
// Not every runner returns an outcome yet; until one does, it still throws.
//
// The policy table below decides, per role family and failure kind, whether the
// child gets its one corrective turn, whether a gate call spends its second child,
// and what the host does after that. The worker, gate and writer runners read it:
// their corrective turn through `correctiveTurnAllowed`, the gate's second child
// through `CHILD_FAILURE_POLICY.gate[kind].freshChild`.

import type { ChildLastTurn } from "./child-last-turn.ts";
import type { GATE_ATTEMPT_CAPS } from "./gate-attempts.ts";

export type ChildRole = "build-worker" | "acceptance-gate" | "safety-gate" | "doc-gardner" | "kaizen";

// Every way a child can fail that the model, not the host, caused. Closed.
export const CHILD_FAILURE_KINDS = [
  "provider-quota", // last turn stopReason "error", classified quota
  "provider-error", // last turn stopReason "error", any other provider text
  "no-reply", // no assistant message, no text, or a turn that ended on a tool call
  "cut-off", // stopReason "length": the reply hit the model's output limit
  "malformed", // text present but not the envelope: JSON, keys, types, identity or hashes
  "protocol-lapse", // gates only: a parsed verdict that breaks a role rule
  "authority-violation", // worker and writer only: attestation found a changed surface the item owns
] as const;

export type ChildFailureKind = (typeof CHILD_FAILURE_KINDS)[number];

export interface ChildFailure {
  kind: ChildFailureKind;
  role: ChildRole;
  problem: string; // host-written, at most 300 characters
  model: string; // "<provider>/<model>" the child ran on
  prompts: number; // prompts sent, corrective turns included
  children: number; // 1, or 2 after a fresh child
  durationMs: number; // host wall time across them
  lastTurn?: ChildLastTurn; // absent only when an injected invoker cannot read the session
}

export type ChildOutcome<T> = { ok: true; value: T } | { ok: false; failure: ChildFailure };

export type Parsed<T> = { ok: true; value: T } | { ok: false; problem: string };

// One classifier for every role, from how the child's last turn ended and the text
// it left. Cancellation (stopReason "aborted" with the run's signal set) is the
// caller's to throw before it classifies; here an aborted turn is read by its text
// like any other, so the function stays total.
export function classifyChildFailure(
  turn: ChildLastTurn | undefined,
  text: string,
): Exclude<ChildFailureKind, "protocol-lapse" | "authority-violation"> {
  if (turn?.stopReason === "error") return turn.providerError === "quota" ? "provider-quota" : "provider-error";
  if (turn?.stopReason === "length") return "cut-off";
  if (turn && (turn.stopReason === "toolUse" || turn.endedOnToolCall || turn.textChars === 0)) return "no-reply";
  return text.trim() ? "malformed" : "no-reply";
}

export interface FailurePolicy {
  correctiveTurn: boolean; // spends the child's one corrective turn
  freshChild: boolean; // spends the gate call's second child
  then: "item-halt" | "host-verdict" | "writer-refusal";
}

const halt = (correctiveTurn: boolean): FailurePolicy => ({ correctiveTurn, freshChild: false, then: "item-halt" });
const hostVerdict = (correctiveTurn: boolean, freshChild: boolean): FailurePolicy => ({
  correctiveTurn,
  freshChild,
  then: "host-verdict",
});
const refusal = (correctiveTurn: boolean): FailurePolicy => ({ correctiveTurn, freshChild: false, then: "writer-refusal" });

// `null` marks a kind the family cannot produce.
export const CHILD_FAILURE_POLICY = {
  worker: {
    "provider-quota": halt(false),
    "provider-error": halt(false),
    "no-reply": halt(true),
    "cut-off": halt(true),
    malformed: halt(true),
    "protocol-lapse": null,
    "authority-violation": halt(false),
  },
  gate: {
    "provider-quota": hostVerdict(false, false),
    "provider-error": hostVerdict(false, false),
    "no-reply": hostVerdict(true, true),
    // The same model with the same output budget would be cut again.
    "cut-off": hostVerdict(true, false),
    malformed: hostVerdict(true, true),
    "protocol-lapse": hostVerdict(true, true),
    "authority-violation": null,
  },
  writer: {
    "provider-quota": refusal(false),
    "provider-error": refusal(false),
    "no-reply": refusal(true),
    "cut-off": refusal(true),
    malformed: refusal(true),
    "protocol-lapse": null,
    "authority-violation": refusal(false),
  },
} as const satisfies Record<"worker" | "gate" | "writer", Record<ChildFailureKind, FailurePolicy | null>>;

// Whether a child whose reply is not yet usable gets its one corrective turn. A turn that
// ended `aborted` is cancellation, outside the table: it gets none, and the caller throws.
// Every other turn gets what the table gives the kind `classifyChildFailure` reads from it.
export function correctiveTurnAllowed(
  family: "worker" | "gate" | "writer",
  turn: ChildLastTurn | undefined,
  text: string,
): boolean {
  if (turn?.stopReason === "aborted") return false;
  return CHILD_FAILURE_POLICY[family][classifyChildFailure(turn, text)].correctiveTurn;
}

export type KickbackSource =
  | "acceptance-concern"
  | "visual-concern"
  | "safety-concern"
  | "host-citation-check"
  | "host-worker-check";

// Which gate cap each kind of kickback spends, and whether it may spend the last
// attempt. A host check never does: it would leave no review of the rebuilt item.
export const KICKBACK_BUDGET = {
  "acceptance-concern": { cap: "acceptance", lastAttempt: true },
  "visual-concern": { cap: "acceptance", lastAttempt: true },
  "safety-concern": { cap: "safety", lastAttempt: true },
  "host-citation-check": { cap: "safety", lastAttempt: false },
  "host-worker-check": { cap: "safety", lastAttempt: false },
} as const satisfies Record<KickbackSource, { cap: keyof typeof GATE_ATTEMPT_CAPS; lastAttempt: boolean }>;
