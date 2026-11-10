// Every item halt in a Pi delivery goes through recordItemHalt: one place decides the
// halt's kind, findings and next step, and one place hands the halt to the sink that
// keeps it: the halt record at refs/hatch/<slug>/item-<id>/halt (halt-writer.ts). A build
// that halts failed keeps its record in the transaction that writes `failed`; the
// delivery then maps the same result again, with a sink that keeps nothing.
// The kinds and next steps are the keys of skills/hatch-status/references/halt-record.json,
// which the readers in halt-record.ts and hatch_next.py look up as data.
//
// A sink never changes a halt: whatever it throws is caught and returned as `sinkError`,
// and the record and event the caller reports are the same either way.

import type { HatchBuildItemResult } from "./build-runner.ts";
import type { HatchCheckDiagnosis } from "./check-environment.ts";
import type { CheckConvergenceResult } from "./check-convergence.ts";
import type { ChildFailure, ChildFailureKind } from "./child-outcome.ts";
import type { HatchDeliveryHalt } from "./delivery-runner.ts";
import type { HatchGateAttemptRecord, HatchGateRole } from "./gate-attempts.ts";
import { effectiveGateVerdict, type HatchGateFinding } from "./gate-runner.ts";
import { loadHaltRules, type LoadedHaltRules } from "./halt-record.ts";
import type { HookValidationResult } from "./hook-runner.ts";
import type { HatchIntegrationResult } from "./integration-runner.ts";
import type { HatchRunEvent, HatchRunEventCheck } from "./run-events.ts";
import type { HostRefusal } from "./secret-scan.ts";
import type { HatchVerificationResult } from "./verification-runner.ts";

export type HatchHaltKind =
  | "gate-cap" | "merge-check-failed" | "worker-blocked" | "provider-error" | "host-verdict"
  | "secret-match" | "protected-path" | "authority-violation";

export type HatchHaltNextStep = "human-decision" | "fix-and-rerun" | "rerun-delivery" | "replan" | "change-model";

export interface HatchHaltFinding {
  severity: "critical" | "major" | "minor";
  code: string;
  path: string | null;
  line: number | null;
}

export interface ItemHalt {
  binder: string;
  item: string;
  kind: HatchHaltKind;
  status: string; // the halt status the result already uses (blocked, failed, no-change, ...)
  phase: "build" | "merge" | "accept";
  gate: HatchGateRole | null;
  attempt: number | null; // that gate's counted attempts at the halt, else null
  findings: HatchHaltFinding[]; // severity, code, path and line only
  nextStep: HatchHaltNextStep;
  requiredCheckId: string | null; // the worker check the next worker must re-propose
  itemTip: string | null;
  integrationTip: string | null;
  specDigest: string | null; // item_spec_sha256; null when the item's plan could not be read
  reason: string; // operator text, unchanged from today
  nextStepText?: string; // today's free-text step, where a site has one
  diagnosis?: HatchCheckDiagnosis;
  wave?: number;
  cause?: ChildFailure | HostRefusal; // the child failure (its model, duration and last turn) or the host refusal behind the halt
}

export type ItemHaltSink = (halt: ItemHalt) => Promise<void>;

/** A sink that keeps nothing: where the halt's record is kept elsewhere, or not yet written. */
export const noItemHaltSink: ItemHaltSink = async () => {};

export type ItemHaltedEvent = Extract<HatchRunEvent, { kind: "item-halted" }>;

/** The structured check an `item-halted` event carries, from a halted check's diagnosis. */
export function eventCheck(diagnosis: HatchCheckDiagnosis | undefined): HatchRunEventCheck | undefined {
  if (!diagnosis) return undefined;
  return {
    id: diagnosis.checkId,
    command: diagnosis.command,
    exitCode: diagnosis.exitCode,
    excerpt: diagnosis.excerpt,
    ...(diagnosis.remediation ? { remediation: diagnosis.remediation } : {}),
  };
}

export function withCheck(check: HatchRunEventCheck | undefined): { check?: HatchRunEventCheck } {
  return check ? { check } : {};
}

let rules: Promise<LoadedHaltRules> | undefined;

// The record's own bounds: at most max_findings findings, a path the record's path
// pattern rejects is written as null, and a code its token pattern rejects is cut to the
// pattern's 80 characters or, when the cut still fails, written as the record's
// `withheld` word (a code is required), so neither a file name nor a model-written code
// makes a record unreadable.
async function bounded(findings: HatchHaltFinding[]): Promise<HatchHaltFinding[]> {
  rules ??= loadHaltRules();
  const loaded = await rules;
  const max = "broken" in loaded ? 50 : loaded.max_findings;
  const path = "broken" in loaded ? undefined : loaded.compiled.path;
  const code = (value: string): string => {
    if ("broken" in loaded) return value;
    const token = loaded.compiled.token;
    if (token.test(value)) return value;
    const cut = value.slice(0, 80);
    return token.test(cut) ? cut : loaded.withheld;
  };
  return findings.slice(0, max).map((finding) => ({
    ...finding,
    code: code(finding.code),
    path: finding.path !== null && path?.test(finding.path) ? finding.path : null,
  }));
}

/** Every item halt goes through here. A failing sink never changes the halt. */
export async function recordItemHalt(
  halt: ItemHalt,
  sink: ItemHaltSink = noItemHaltSink,
): Promise<{ record: HatchDeliveryHalt; event: ItemHaltedEvent; sinkError?: string }> {
  const kept: ItemHalt = { ...halt, findings: await bounded(halt.findings) };
  let sinkError: string | undefined;
  try {
    await sink(kept);
  } catch (error) {
    sinkError = error instanceof Error ? error.message : String(error);
  }
  const record: HatchDeliveryHalt = {
    item: halt.item,
    // The result has reported an accept-time halt as a merge halt since before the halt
    // kinds; the phase the record keeps says accept.
    phase: halt.phase === "accept" ? "merge" : halt.phase,
    status: halt.status,
    reason: halt.reason,
    kind: halt.kind,
    ...(halt.diagnosis ? { diagnosis: halt.diagnosis } : {}),
    ...(halt.nextStepText ? { nextStep: halt.nextStepText } : {}),
  };
  const event: ItemHaltedEvent = {
    kind: "item-halted",
    ...(halt.wave !== undefined ? { wave: halt.wave } : {}),
    item: halt.item,
    status: halt.status,
    reason: halt.reason,
    ...withCheck(eventCheck(halt.diagnosis)),
  };
  return { record, event, ...(sinkError !== undefined ? { sinkError } : {}) };
}

// ---- What caused a halt, read from the result that halted ----

const GATE_KEYS = { "acceptance-gate": "acceptance", "safety-gate": "safety", "visual-gate": "visual" } as const;
// The ledger file each gate's concerns are counted in.
const GATE_FILES = { "acceptance-gate": "acceptance", "visual-gate": "acceptance", "safety-gate": "safety" } as const;
const PROVIDER_CODES = new Set(["quota-exhausted", "provider-error"]);

export function checkDiagnosis(checkFailure: CheckConvergenceResult | undefined): HatchCheckDiagnosis | undefined {
  return checkFailure && checkFailure.status !== "stable" ? checkFailure.diagnosis : undefined;
}

function haltFindings(findings: readonly HatchGateFinding[]): HatchHaltFinding[] {
  return findings.map((finding) => ({
    severity: finding.severity,
    code: finding.code,
    path: finding.path ?? null,
    line: finding.line ?? null,
  }));
}

function hostFinding(code: string): HatchHaltFinding[] {
  return [{ severity: "major", code, path: null, line: null }];
}

// Table 1.1, worker column: the halt kind and finding code of each way a worker child
// fails. A worker never reports a protocol lapse; that row is here so the table is total.
const WORKER_FAILURE_HALTS: Record<ChildFailureKind, { kind: HatchHaltKind; code: string }> = {
  "provider-quota": { kind: "provider-error", code: "quota-exhausted" },
  "provider-error": { kind: "provider-error", code: "provider-error" },
  "no-reply": { kind: "host-verdict", code: "worker-no-result" },
  "cut-off": { kind: "host-verdict", code: "worker-result-cut-off" },
  malformed: { kind: "host-verdict", code: "worker-result-malformed" },
  "protocol-lapse": { kind: "host-verdict", code: "protocol-lapse" },
  "authority-violation": { kind: "authority-violation", code: "worker-authority" },
};

// A secret match names each pattern, path and line (never the matched text); a protected
// path names each path.
function refusalCause(refusal: HostRefusal, failedRef: boolean): HaltCause {
  const findings: HatchHaltFinding[] = refusal.kind === "secret-match"
    ? refusal.matches.map((match) => ({ severity: "critical", code: `secret:${match.pattern}`, path: match.path, line: match.line }))
    : refusal.paths.map((path) => ({ severity: "critical", code: "protected-path", path, line: null }));
  return { kind: refusal.kind, gate: null, findings, nextStep: failedRef ? "human-decision" : "fix-and-rerun" };
}

function workerFailureCause(failure: ChildFailure, failedRef: boolean): HaltCause {
  const { kind, code } = WORKER_FAILURE_HALTS[failure.kind];
  const kept: HatchHaltNextStep =
    kind === "provider-error" ? "change-model" : kind === "authority-violation" ? "fix-and-rerun" : "rerun-delivery";
  return { kind, gate: null, findings: hostFinding(code), nextStep: failedRef ? "human-decision" : kept };
}

/** The operator's reason for a worker child that failed: the model and what went wrong. */
export function workerFailureReason(failure: ChildFailure, binder: string, item: string): string {
  const subject = `The build-worker child for item '${item}' (binder '${binder}')`;
  if (failure.kind === "provider-quota" || failure.kind === "provider-error") {
    const error = failure.kind === "provider-quota" ? "a quota error" : "a provider error";
    return `${subject} got ${error} from ${failure.model} and returned no result: ${failure.problem}. ` +
      "hatch sent no corrective turn, because it would meet the same error. Nothing was committed; the candidate stays in the item worktree.";
  }
  if (failure.kind === "authority-violation") {
    return `${subject} on ${failure.model} changed what the host owns: ${failure.problem}. ` +
      "Nothing was committed; the candidate stays in the item worktree.";
  }
  const cut = failure.kind === "cut-off" ? " The reply was cut at the model's output limit." : "";
  return `${subject} on ${failure.model} returned no usable result: ${failure.problem}.${cut} ` +
    "Nothing was committed; the candidate stays in the item worktree.";
}

/** The operator's reason for a floor-discovery worker that returned `blocked`: its own words. */
export function discoveryBlockedReason(summary: string, binder: string, item: string): string {
  return `The floor-discovery worker for item '${item}' (binder '${binder}') returned blocked: ${summary} ` +
    "No ref was written or removed.";
}

/** The gate whose effective verdict is a concern: acceptance before visual before safety. */
function concernGate(verification: HatchVerificationResult | undefined): HatchGateRole | undefined {
  if (!verification) return undefined;
  return (["acceptance-gate", "visual-gate", "safety-gate"] as const).find((role) => {
    const gate = verification.gates[GATE_KEYS[role]];
    return gate ? effectiveGateVerdict(role, gate.verdict, gate.findings) === "concerns" : false;
  });
}

/** The first gate, host-written or not, whose verdict is blocked. */
function blockedGate(
  verifications: readonly (HatchVerificationResult | undefined)[],
): { role: HatchGateRole; findings: HatchGateFinding[]; host: boolean } | undefined {
  for (const verification of verifications) {
    if (!verification) continue;
    for (const role of ["acceptance-gate", "safety-gate", "visual-gate"] as const) {
      const gate = verification.gates[GATE_KEYS[role]];
      if (gate?.verdict !== "blocked") continue;
      return { role, findings: gate.findings, host: "verdictSource" in gate && gate.verdictSource === "host" };
    }
  }
  return undefined;
}

interface HaltCauseInput {
  status: string;
  // A failed ref is written at the item tip: the next step is always the human's.
  failedRef: boolean;
  checkFailure?: CheckConvergenceResult;
  hookValidation?: HookValidationResult;
  verifications: (HatchVerificationResult | undefined)[];
  workerBlocked?: boolean;
  noChange?: boolean; // a send-back or kickback whose worker changed nothing
  droppedCheckId?: string;
  // A host check that still sent the candidate back once the safety cap was spent.
  hostCheckAtCap?: "host-citation-check" | "host-worker-check";
  merge?: boolean; // the halt is the proposed merge's, not the item build's
  // The gate whose cap ran out, when the site already names it; else it is read from the
  // verifications.
  capGate?: HatchGateRole;
  failure?: ChildFailure; // the worker child failed, so there is nothing else to read
  refusal?: HostRefusal; // the host refused the candidate or the proposed merge before any gate
}

type HaltCause = Pick<ItemHalt, "kind" | "gate" | "findings" | "nextStep">;

// One reading of mapping table 6.2 for every halt site.
function haltCause(input: HaltCauseInput): HaltCause {
  const step = (kept: HatchHaltNextStep): HatchHaltNextStep => (input.failedRef ? "human-decision" : kept);
  if (input.noChange) {
    return { kind: "host-verdict", gate: concernGate(input.verifications[0]) ?? null, findings: hostFinding("kickback-unchanged"), nextStep: "human-decision" };
  }
  if (input.status === "no-change") return { kind: "host-verdict", gate: null, findings: hostFinding("no-change"), nextStep: "rerun-delivery" };
  if (input.status === "already-present") return { kind: "host-verdict", gate: null, findings: hostFinding("already-present"), nextStep: "replan" };
  if (input.failure) return workerFailureCause(input.failure, input.failedRef);
  if (input.refusal) return refusalCause(input.refusal, input.failedRef);
  if (input.workerBlocked) return { kind: "worker-blocked", gate: null, findings: hostFinding("worker-blocked"), nextStep: "fix-and-rerun" };
  if (input.droppedCheckId) return { kind: "host-verdict", gate: null, findings: hostFinding("worker-check-dropped"), nextStep: "fix-and-rerun" };
  // Before the check failure: a worker-check kickback carries the failed check too.
  if (input.hostCheckAtCap) return { kind: "gate-cap", gate: "safety-gate", findings: hostFinding(input.hostCheckAtCap), nextStep: "fix-and-rerun" };
  if (input.checkFailure && input.checkFailure.status !== "stable") {
    const code = input.checkFailure.status === "precondition-unmet" ? "precondition-unmet" : "check-failed";
    return input.merge
      ? { kind: "merge-check-failed", gate: null, findings: hostFinding(code), nextStep: "human-decision" }
      : { kind: "host-verdict", gate: null, findings: hostFinding(code), nextStep: step("fix-and-rerun") };
  }
  if (input.hookValidation && input.hookValidation.status !== "passed") {
    return { kind: "host-verdict", gate: null, findings: hostFinding("hook-refused"), nextStep: step("fix-and-rerun") };
  }
  const blocked = blockedGate(input.verifications);
  if (blocked?.host && PROVIDER_CODES.has(blocked.findings[0]?.code ?? "")) {
    return { kind: "provider-error", gate: blocked.role, findings: haltFindings(blocked.findings), nextStep: step("change-model") };
  }
  if (blocked) return { kind: "host-verdict", gate: blocked.role, findings: haltFindings(blocked.findings), nextStep: step("rerun-delivery") };
  const concern = input.capGate ?? input.verifications.map(concernGate).find((role) => role !== undefined);
  if (concern && input.status === "failed") {
    const verification = input.verifications.find((entry) => entry?.gates[GATE_KEYS[concern]]) ?? input.verifications[0];
    return {
      kind: "gate-cap",
      gate: concern,
      findings: haltFindings(verification?.gates[GATE_KEYS[concern]]?.findings ?? []),
      nextStep: "human-decision",
    };
  }
  return { kind: "host-verdict", gate: null, findings: hostFinding(input.merge ? "merge-refused" : "item-blocked"), nextStep: step("fix-and-rerun") };
}

/** The required check a worker left out, when that is why a build halted. */
function droppedCheck(build: HatchBuildItemResult): string | undefined {
  if (build.status !== "blocked" || build.finalization || !build.worker) return undefined;
  return build.requiredCheckIds?.find((id) => !build.worker?.checks.some((check) => check.id === id));
}

/** A halted build's halt, without the operator's reason and wave, which the site adds. */
export function haltOfBuild(
  build: HatchBuildItemResult,
  // `capGate`: the gate the site names as the one whose cap ran out (failedBuildHalt's);
  // the build's own, set where its cap test fired, comes first.
  at: { integrationTip: string | null; capGate?: HatchGateRole },
): Omit<ItemHalt, "reason" | "wave"> {
  const droppedCheckId = droppedCheck(build);
  const cause = haltCause({
    status: build.status,
    failedRef: build.status === "failed",
    checkFailure: build.finalization?.checkFailure,
    hookValidation: build.finalization?.hookValidation,
    verifications: [build.finalization?.verification],
    workerBlocked: build.status === "blocked" && build.worker?.outcome === "blocked",
    noChange: build.noChange,
    droppedCheckId,
    ...(build.status === "blocked" && build.finalization?.citationCheck
      ? { hostCheckAtCap: "host-citation-check" as const }
      : build.status === "blocked" && build.finalization?.workerCheckFailure
        ? { hostCheckAtCap: "host-worker-check" as const }
        : {}),
    ...(build.failure ? { failure: build.failure } : {}),
    ...(build.finalization?.refusal ? { refusal: build.finalization.refusal } : {}),
    ...(build.capGate ?? at.capGate ? { capGate: build.capGate ?? at.capGate } : {}),
  });
  const counted = cause.kind === "gate-cap" && cause.gate ? build.gateAttempts?.[GATE_FILES[cause.gate]] : undefined;
  const diagnosis = checkDiagnosis(build.finalization?.checkFailure);
  return {
    binder: build.binder,
    item: build.item,
    status: build.status,
    phase: "build",
    ...cause,
    attempt: counted !== undefined && counted >= 1 ? counted : null,
    requiredCheckId: droppedCheckId ?? build.requiredCheckIds?.at(-1) ?? null,
    itemTip: build.itemTip ?? build.commit ?? null,
    integrationTip: at.integrationTip,
    specDigest: build.specDigest ?? null,
    ...(diagnosis ? { diagnosis } : {}),
    ...(build.failure ? { cause: build.failure } : build.finalization?.refusal ? { cause: build.finalization.refusal } : {}),
  };
}

/**
 * A floor-discovery worker's failure, or its own `blocked` outcome, at merge or accept,
 * without the reason and wave.
 */
export function haltOfWorkerFailure(
  failure: ChildFailure | "blocked",
  at: Pick<ItemHalt, "binder" | "item" | "status" | "itemTip" | "integrationTip" | "specDigest"> & {
    phase: "merge" | "accept";
    // The item keeps a failed ref it already had (an Accept), so the step is the human's.
    failedRef: boolean;
  },
): Omit<ItemHalt, "reason" | "wave"> {
  const { failedRef, ...rest } = at;
  if (failure === "blocked") {
    const nextStep: HatchHaltNextStep = failedRef ? "human-decision" : "fix-and-rerun";
    return { ...rest, kind: "worker-blocked", gate: null, findings: hostFinding("worker-blocked"), nextStep, attempt: null, requiredCheckId: null };
  }
  return { ...rest, ...workerFailureCause(failure, failedRef), attempt: null, requiredCheckId: null, cause: failure };
}

/** Counted attempts of a gate's ledger file, from the item's current-spec rows. */
function countedAttempts(records: readonly HatchGateAttemptRecord[] | undefined, gate: HatchGateRole | null): number | null {
  if (!records || !gate) return null;
  const counted = records.filter((record) => record.counted && GATE_FILES[record.role] === GATE_FILES[gate]).length;
  return counted >= 1 ? counted : null;
}

/** A merge- or accept-time halt, without the operator's reason and wave. */
export function haltOfIntegration(
  result: HatchIntegrationResult,
  at: {
    status: string;
    failedRef: boolean;
    phase: "merge" | "accept";
    specDigest: string | null;
    records?: readonly HatchGateAttemptRecord[];
    // The check that halted the item, when the site has its own (a kickback's); else the
    // integration's.
    checkFailure?: CheckConvergenceResult;
    // A merge kickback whose rebuild halted: the rebuild's own verification and worker, or
    // its whole build result, which then decides the halt; `capGate` is the gate the site
    // names as the one whose cap ran out.
    rebuild?: { verification?: HatchVerificationResult; workerBlocked?: boolean; build?: HatchBuildItemResult; capGate?: HatchGateRole };
    // The gate whose cap the site found spent, when no rebuild decides the halt (a merge
    // kickback's ledger-cap halt); else it is read from the verifications.
    capGate?: HatchGateRole;
  },
): Omit<ItemHalt, "reason" | "wave"> {
  const rebuild = at.rebuild?.build;
  if (rebuild) {
    // A rebuild that changed nothing leaves the merge-time verdict standing (table 6.2),
    // so its gate is the one whose concern sent the item back.
    const unchanged = rebuild.status === "no-change" || rebuild.noChange === true;
    const halt = haltOfBuild(unchanged ? { ...rebuild, noChange: true } : rebuild, {
      integrationTip: result.base || null,
      ...(at.rebuild?.capGate ? { capGate: at.rebuild.capGate } : {}),
    });
    return {
      ...halt,
      status: at.status,
      phase: at.phase,
      gate: halt.gate ?? (unchanged ? concernGate(result.verification) ?? concernGate(result.safetyVerification) ?? null : null),
      itemTip: halt.itemTip ?? (result.itemTip || null),
      specDigest: at.specDigest,
    };
  }
  const checkFailure = "checkFailure" in at ? at.checkFailure : result.checkFailure;
  const cause = at.phase === "accept" && !result.checkFailure && !result.refusal && !blockedGate([result.verification, result.safetyVerification])
    ? { kind: "host-verdict" as const, gate: null, findings: hostFinding("accept-declined"), nextStep: "human-decision" as const }
    : haltCause({
        status: at.status,
        failedRef: at.failedRef,
        checkFailure,
        hookValidation: at.rebuild ? undefined : result.hookValidation,
        verifications: at.rebuild ? [at.rebuild.verification] : [result.verification, result.safetyVerification],
        workerBlocked: at.rebuild?.workerBlocked,
        merge: !at.rebuild,
        ...(!at.rebuild && result.refusal ? { refusal: result.refusal } : {}),
        ...(at.capGate ? { capGate: at.capGate } : {}),
      });
  const diagnosis = checkDiagnosis(checkFailure);
  return {
    binder: result.binder,
    item: result.item,
    status: at.status,
    phase: at.phase,
    ...cause,
    attempt: cause.kind === "gate-cap" ? countedAttempts(at.records, cause.gate) : null,
    requiredCheckId: null,
    itemTip: result.itemTip || null,
    integrationTip: result.base || null,
    specDigest: at.specDigest,
    ...(diagnosis ? { diagnosis } : {}),
    ...(!at.rebuild && result.refusal ? { cause: result.refusal } : {}),
  };
}
