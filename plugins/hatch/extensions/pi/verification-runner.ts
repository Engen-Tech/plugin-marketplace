import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ChildRegistry,
  runGateAuthProbe,
  type ChildModelTarget,
  type ChildRuntimeReport,
  type GateProviderPreflightReport,
} from "./child-runtime.ts";
import { DispatchLockManager, type DispatchLockLease } from "./dispatch-lock.ts";
import type { EnvServerContext } from "./env-server-runner.ts";
import {
  buildHatchEvidence,
  type BuildEvidenceOptions,
  type HatchEvidenceManifest,
} from "./evidence.ts";
import {
  effectiveGateVerdict,
  executeGateOnEvidence,
  type GateModelInvoker,
  type HatchGateResult,
} from "./gate-runner.ts";
import { requireRoleModel } from "./role-models.ts";
import { safeProgress, type HatchRunProgress } from "./run-events.ts";
import {
  captureVisualEvidence,
  type CaptureVisualEvidenceOptions,
  type VisualCaptureOutcome,
  type VisualEvidence,
} from "./visual-capture-runner.ts";
import {
  createFileCurrencySource,
  judgeVisualEvidence,
  visionModelRemediation,
  type VisualGateOutcome,
  type VisualGateResult,
  type VisualTreeRange,
} from "./visual-gate-runner.ts";

export type HatchVerificationMode = "full" | "boundary-only";
export type HatchVerificationStatus = "pass" | "concerns" | "blocked" | "skipped";
// A closed, package-owned typed union of fail-closed visual prerequisites. Callers may
// never supply or widen it, so free text can never spoof a block. Each value names a
// distinct unmet precondition of the visual acceptance path; none is free text.
export type HatchVerificationBlockedReason =
  // The item declares design_reference none, or the binder's design_facts.source is null
  // or unresolvable — there is no view to capture against.
  | "visual-no-design"
  // No visual_env is declared at the candidate tree, so the host cannot bring the app up.
  | "visual-no-env"
  // The configured gate model does not accept image input; no capture is attempted.
  | "visual-no-vision-model"
  // Capture failed closed: dev-server startup-crash, playwright-cli absent, or an
  // unhealthy/shell render.
  | "visual-capture-failed"
  // The visual gate could not return a verdict (dispatch error/timeout, or evidence that
  // was unjudgeable).
  | "visual-gate-error"
  // The context-less run() path has no lifecycle owner, so it cannot run capture.
  | "visual-no-context";

export interface HatchVerificationResult {
  schema: "hatch-verification-v1";
  binder: string;
  item: string;
  requestedMode: HatchVerificationMode;
  effectiveMode: HatchVerificationMode | "skipped";
  evidenceHash: string;
  status: HatchVerificationStatus;
  // Reserved for oracle opt-out prose only — never a typed prerequisite. A spoof-proof
  // split: a machine-typed block uses blockedReason, human opt-out text uses reason.
  reason?: string;
  // Set only for a blocked status whose cause is a typed visual prerequisite, never
  // opt-out prose. The free-text reason field stays reserved for opt-out.
  blockedReason?: HatchVerificationBlockedReason;
  // The operator fix for a typed visual block when the cause names one, such as the
  // visual-gate role's model, the file and key that chose it, and how to change it.
  remediation?: string;
  gates: {
    acceptance?: HatchGateResult;
    safety?: HatchGateResult;
    visual?: VisualGateResult;
  };
}

interface GatePreflight {
  ensure(
    ctx: ExtensionContext,
    registry: ChildRegistry,
    target?: ChildModelTarget,
  ): Promise<GateProviderPreflightReport>;
}

export type EvidenceBuilder = (options: BuildEvidenceOptions) => Promise<HatchEvidenceManifest>;

export type EvidenceGateExecutor = typeof executeGateOnEvidence;
export type VerificationEvidenceOptions = Pick<BuildEvidenceOptions, "target" | "checkManifest"> & {
  cwd?: string;
};

// The optional, backwards-compatible lifecycle/process context a build-finalizer or
// integration caller threads in so a visual oracle can run its real acceptance path: a
// HatchProcessManager owner (servers are registered under it and reaped on abort), the
// candidate worktree the dev server runs in, and the candidate tree-ish the capture reads
// visual_env from and binds evidence to — the staged target tree for a candidate target,
// the committed OID for a committed or merged target, never a commit OID that does not
// exist yet. Absent (the context-less run() path) a visual oracle blocks visual-no-context.
export interface HatchVisualLifecycleContext {
  processes: EnvServerContext;
  worktree: string;
  treeish: string;
}

// The vision-capability preflight seam: resolve the exact gate model and read whether it
// advertises image input. Default probes the mirrored gate runtime without spawning a
// session; a test injects both branches.
export type VisionPreflightProbe = (
  ctx: ExtensionContext,
  registry: ChildRegistry,
  target?: ChildModelTarget,
) => Promise<ChildRuntimeReport>;

// The capture-orchestration seam: bring the app up over the candidate tree-ish, capture
// the live and design views, and emit one hash-bound visual-evidence artifact (or a typed
// fail-closed outcome). Default is the real pi-visual-capture orchestrator.
export type VisualCaptureRunner = (
  options: CaptureVisualEvidenceOptions,
) => Promise<VisualCaptureOutcome>;

export interface VisualAcceptanceJudgeInput {
  registry: ChildRegistry;
  evidence: VisualEvidence;
  treeRange: VisualTreeRange;
  oracleAssertions: string[];
}

// The visual-gate seam: judge one captured artifact perceptually and return a strict
// verdict outcome. Default builds a file-backed currency source from the capture's
// screenshots and calls the real pi-visual-capture judge.
export type VisualAcceptanceJudge = (
  ctx: ExtensionContext,
  input: VisualAcceptanceJudgeInput,
) => Promise<VisualGateOutcome>;

interface VisualDerivation {
  status: HatchVerificationStatus;
  blockedReason?: HatchVerificationBlockedReason;
  remediation?: string;
  visual?: VisualGateResult;
}

const VISUAL_BLOCKED_MESSAGES: Record<HatchVerificationBlockedReason, string> = {
  "visual-no-design":
    "Visual acceptance needs a view: the item declares no design_reference, or the binder's design_facts.source is null or unresolvable. Set both and rebuild; no ref moved.",
  "visual-no-env":
    "Visual acceptance needs a running app: declare visual_env in .hatch/environment.json at the candidate tree. No capture ran and no ref moved.",
  "visual-no-vision-model":
    "Visual acceptance needs a vision-capable gate model, but the visual-gate role's model does not accept image input. Fix the role's model and rebuild; no ref moved.",
  "visual-capture-failed":
    "Visual capture failed closed (dev-server startup, playwright-cli availability, or an unhealthy render). Inspect the capture remediation and rebuild; no ref moved.",
  "visual-gate-error":
    "The visual gate could not return a verdict (dispatch error/timeout, or evidence that was unjudgeable). Rerun; the host decides whether to retry, never the gate. No ref moved.",
  "visual-no-context":
    "Visual acceptance requires the build or integration lifecycle context; the context-less verification path cannot bring an app up. Run this through buildItem or deliverBinder. No ref moved.",
};

// The actionable, package-owned message for each typed visual block, shared by the
// build-finalizer and integration-runner consumers so both hold by default with the same
// wording and neither falls through to move a ref on a blocked seam.
// A remediation the block carries (the visual-gate model's fix) follows the message.
export function visualBlockedMessage(reason: HatchVerificationBlockedReason, remediation?: string): string {
  const message = VISUAL_BLOCKED_MESSAGES[reason];
  return remediation ? `${message}\n\n${remediation}` : message;
}

function oracle(manifest: HatchEvidenceManifest): Record<string, unknown> {
  const value = manifest.payload.workItem.oracle;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Hatch work item has no valid oracle after binder validation");
  }
  return value as Record<string, unknown>;
}

function oracleAssertions(itemOracle: Record<string, unknown>): string[] {
  const value = itemOracle.assertions;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

// The app route the item under test declares. "none", empty, or a non-string is unresolved.
function resolveDesignReference(workItem: Record<string, unknown>): string | undefined {
  const value = workItem.design_reference;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}

// The design path the binder's design_facts declares. Null, empty, "none", or a missing
// design_facts block is unresolvable.
function resolveDesignSource(document: Record<string, unknown>): string | undefined {
  const facts = document.design_facts;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return undefined;
  const source = (facts as Record<string, unknown>).source;
  if (typeof source !== "string") return undefined;
  const trimmed = source.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return undefined;
  return trimmed;
}

function requireScreenshotPath(target: { screenshot?: string | null }, role: string): string {
  if (typeof target.screenshot !== "string" || !target.screenshot) {
    throw new Error(`Hatch visual gate ${role} capture has no screenshot to judge`);
  }
  return target.screenshot;
}

// The default visual-gate seam: build a file-backed currency source from the capture's
// two screenshots and the candidate tree range, then judge. Kept behind the injectable
// seam so the deterministic floor drives a pass/concerns/blocked verdict with no browser.
const defaultJudgeVisual: VisualAcceptanceJudge = (ctx, input) =>
  judgeVisualEvidence(ctx, {
    registry: input.registry,
    evidence: input.evidence,
    oracleAssertions: input.oracleAssertions,
    currency: createFileCurrencySource({
      appScreenshotPath: requireScreenshotPath(input.evidence.captures.app, "app"),
      designScreenshotPath: requireScreenshotPath(input.evidence.captures.design, "design"),
      resolveTreeRange: () => input.treeRange,
    }),
  });

function gateStatus(gate: HatchGateResult): HatchVerificationStatus {
  // The aggregate reads the effective verdict, so a gate executor the caller injected
  // cannot make a minor-only acceptance or design concern read as a blocking one.
  return effectiveGateVerdict(gate.role, gate.verdict, gate.findings);
}

export class HatchVerificationRunner {
  readonly #preflight: GatePreflight;
  readonly #children: ChildRegistry;
  readonly #locks: DispatchLockManager;
  readonly #buildEvidence: EvidenceBuilder;
  readonly #executeGate: EvidenceGateExecutor;
  readonly #invoke?: GateModelInvoker;
  readonly #visionPreflight: VisionPreflightProbe;
  readonly #captureVisual: VisualCaptureRunner;
  readonly #judgeVisual: VisualAcceptanceJudge;

  constructor(
    preflight: GatePreflight,
    children: ChildRegistry,
    locks: DispatchLockManager,
    options: {
      buildEvidence?: EvidenceBuilder;
      executeGate?: EvidenceGateExecutor;
      invoke?: GateModelInvoker;
      visionPreflight?: VisionPreflightProbe;
      captureVisual?: VisualCaptureRunner;
      judgeVisual?: VisualAcceptanceJudge;
    } = {},
  ) {
    this.#preflight = preflight;
    this.#children = children;
    this.#locks = locks;
    this.#buildEvidence = options.buildEvidence ?? buildHatchEvidence;
    this.#executeGate = options.executeGate ?? executeGateOnEvidence;
    this.#invoke = options.invoke;
    this.#visionPreflight =
      options.visionPreflight ?? ((ctx, _registry, target) => runGateAuthProbe(ctx, target));
    this.#captureVisual = options.captureVisual ?? captureVisualEvidence;
    this.#judgeVisual = options.judgeVisual ?? defaultJudgeVisual;
  }

  async run(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    requestedMode: HatchVerificationMode,
    progress?: HatchRunProgress,
  ): Promise<HatchVerificationResult> {
    if (ctx.signal?.aborted) throw new Error("Hatch verification was cancelled before dispatch");
    const lease = await this.#locks.acquire(ctx.cwd, binder);
    try {
      // Only now does the run own the binder; a run refused the lock never reports a start.
      safeProgress(progress)({ kind: "run-started", binder, item });
      // The context-less entrypoint (hatch_dispatch runVerification / the index.ts
      // construction) has no lifecycle owner, so a visual oracle blocks visual-no-context.
      return await this.#runLocked(ctx, binder, item, requestedMode, {}, undefined);
    } finally {
      await this.#locks.release(lease);
    }
  }

  async runWithLease(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    requestedMode: HatchVerificationMode,
    lease: DispatchLockLease,
    evidenceOptions: VerificationEvidenceOptions = {},
    visualContext?: HatchVisualLifecycleContext,
  ): Promise<HatchVerificationResult> {
    if (!this.#locks.owns(lease) || lease.owner.binder !== binder) {
      throw new Error(`Hatch verification does not own the supplied lock for binder '${binder}'`);
    }
    if (ctx.signal?.aborted) throw new Error("Hatch verification was cancelled before dispatch");
    return this.#runLocked(ctx, binder, item, requestedMode, evidenceOptions, visualContext);
  }

  async #runLocked(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    requestedMode: HatchVerificationMode,
    evidenceOptions: VerificationEvidenceOptions,
    visualContext: HatchVisualLifecycleContext | undefined,
  ): Promise<HatchVerificationResult> {
    const { cwd = ctx.cwd, ...targetOptions } = evidenceOptions;
    const evidence = await this.#buildEvidence({
      cwd,
      binder,
      item,
      ...targetOptions,
    });
    const itemOracle = oracle(evidence);
    if (itemOracle.opt_out === true) {
      return {
        schema: "hatch-verification-v1",
        binder,
        item,
        requestedMode,
        effectiveMode: "skipped",
        evidenceHash: evidence.evidenceHash,
        status: "skipped",
        reason:
          typeof itemOracle.reason === "string"
            ? `oracle opt-out: ${itemOracle.reason}`
            : "oracle opt-out",
        gates: {},
      };
    }
    // A full visual oracle dispatches no acceptance gate (acceptance stays skipped): it
    // runs the boundary safety gate, then — if safety passes and a lifecycle context is
    // present — the ordered visual acceptance path below. The mode is never downgraded — a
    // full request stays full, so callers see requestedMode and effectiveMode as "full".
    const isVisualOracle = itemOracle.type === "visual";
    const effectiveMode: HatchVerificationMode = requestedMode;
    const gates: HatchVerificationResult["gates"] = {};
    if (effectiveMode === "full" && !isVisualOracle) {
      gates.acceptance = await this.#executeGate(
        ctx,
        "acceptance-gate",
        evidence,
        this.#preflight,
        this.#children,
        this.#invoke,
      );
      if (gateStatus(gates.acceptance) !== "pass") {
        return {
          schema: "hatch-verification-v1",
          binder,
          item,
          requestedMode,
          effectiveMode,
          evidenceHash: evidence.evidenceHash,
          status: gateStatus(gates.acceptance),
          gates,
        };
      }
    }
    gates.safety = await this.#executeGate(
      ctx,
      "safety-gate",
      evidence,
      this.#preflight,
      this.#children,
      this.#invoke,
    );
    // Ordered, package-owned result derivation. Callers key on the top-level
    // status/blockedReason, never on gates.safety.verdict as the overall verdict.
    // 1. A non-pass safety verdict is the overall failure and is never overwritten — a
    //    safety failure is surfaced as itself, never folded into a visual reason.
    if (gateStatus(gates.safety) !== "pass") {
      return {
        schema: "hatch-verification-v1",
        binder,
        item,
        requestedMode,
        effectiveMode,
        evidenceHash: evidence.evidenceHash,
        status: gateStatus(gates.safety),
        gates,
      };
    }
    // 2. Safety passed. A full visual oracle now runs the real visual acceptance path:
    //    vision preflight, then capture, then the visual gate — lifting the block only on
    //    a genuine pass, and fail-closing every unmet precondition to a typed reason.
    if (effectiveMode === "full" && isVisualOracle) {
      const derivation = await this.#runVisualAcceptance(ctx, evidence, itemOracle, visualContext);
      if (derivation.visual) gates.visual = derivation.visual;
      return {
        schema: "hatch-verification-v1",
        binder,
        item,
        requestedMode,
        effectiveMode,
        evidenceHash: evidence.evidenceHash,
        status: derivation.status,
        ...(derivation.blockedReason ? { blockedReason: derivation.blockedReason } : {}),
        ...(derivation.remediation ? { remediation: derivation.remediation } : {}),
        gates,
      };
    }
    // 3. Otherwise the passing safety verdict is the overall verdict.
    return {
      schema: "hatch-verification-v1",
      binder,
      item,
      requestedMode,
      effectiveMode,
      evidenceHash: evidence.evidenceHash,
      status: gateStatus(gates.safety),
      gates,
    };
  }

  // The ordered visual acceptance derivation, run only after safety passes for a full
  // visual oracle. Each unmet precondition returns a distinct typed blockedReason and
  // never a silent pass; a genuine gate pass lifts the block; a gate concern retries.
  async #runVisualAcceptance(
    ctx: ExtensionContext,
    evidence: HatchEvidenceManifest,
    itemOracle: Record<string, unknown>,
    visualContext: HatchVisualLifecycleContext | undefined,
  ): Promise<VisualDerivation> {
    // No lifecycle owner (the context-less run() path) cannot bring an app up.
    if (!visualContext) {
      return { status: "blocked", blockedReason: "visual-no-context" };
    }
    // FIRST the vision-capability preflight on the pinned visual-gate model, before any
    // capture. A text-only model fails closed here with no capture attempted.
    const visualTarget = requireRoleModel(ctx, "visual-gate");
    const visionReport = await this.#visionPreflight(ctx, this.#children, visualTarget);
    if (visionReport.advertisesImageInput !== true) {
      return {
        status: "blocked",
        blockedReason: "visual-no-vision-model",
        remediation: visionModelRemediation(visualTarget, visionReport),
      };
    }
    // Resolve the design path (binder design_facts.source) and app route (item
    // design_reference). Either unresolved is a fail-closed visual-no-design.
    const designPath = resolveDesignSource(evidence.payload.binder.document);
    const route = resolveDesignReference(evidence.payload.workItem);
    if (!designPath || !route) {
      return { status: "blocked", blockedReason: "visual-no-design" };
    }
    // Capture the candidate tree-ish under the lifecycle owner so servers are reaped on
    // abort. A thrown fault (playwright-cli absent, a git/spawn error) fails closed with a
    // typed reason rather than crashing the finalizer.
    let capture: VisualCaptureOutcome;
    try {
      capture = await this.#captureVisual({
        binder: evidence.payload.binder.slug,
        item: String(evidence.payload.workItem.id),
        worktree: visualContext.worktree,
        candidateCommit: visualContext.treeish,
        route,
        designPath,
        context: visualContext.processes,
        signal: ctx.signal,
      });
    } catch {
      return { status: "blocked", blockedReason: "visual-capture-failed" };
    }
    if (capture.status !== "captured") {
      return {
        status: "blocked",
        blockedReason:
          capture.status === "no-visual-env" ? "visual-no-env" : "visual-capture-failed",
      };
    }
    // Judge the captured artifact under the same lifecycle owner. A thrown fault (a
    // malformed verdict, moved currency, or a missing screenshot) fails closed as a gate
    // error rather than crashing.
    let outcome: VisualGateOutcome;
    try {
      outcome = await this.#judgeVisual(ctx, {
        registry: this.#children,
        evidence: capture.evidence,
        treeRange: {
          base: evidence.payload.git.diffBase,
          target: evidence.payload.git.targetTree,
        },
        oracleAssertions: oracleAssertions(itemOracle),
      });
    } catch {
      return { status: "blocked", blockedReason: "visual-gate-error" };
    }
    if (outcome.status === "vision-unsupported") {
      return { status: "blocked", blockedReason: "visual-no-vision-model", remediation: outcome.remediation };
    }
    if (outcome.status === "dispatch-failed") {
      return { status: "blocked", blockedReason: "visual-gate-error" };
    }
    // A judged verdict: pass lifts the block, concerns retries under the acceptance cap,
    // blocked (unjudgeable evidence) fails closed as a gate error. The verdict is recorded
    // in gates.visual either way so callers can classify the retry and surface findings.
    // The effective verdict applies the design reviewer's own rule: a minor-only concern
    // is a pass with notes, so it lifts the block like any other pass.
    const verdict = effectiveGateVerdict(outcome.role, outcome.verdict, outcome.findings);
    if (verdict === "pass") {
      return { status: "pass", visual: outcome };
    }
    if (verdict === "concerns") {
      return { status: "concerns", visual: outcome };
    }
    return { status: "blocked", blockedReason: "visual-gate-error", visual: outcome };
  }
}
