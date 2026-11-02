import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LifecycleRegistry, type LifecycleRole } from "./lifecycle-registry.ts";
import type { HatchModelRole, RoleModelSource, RoleModelTarget } from "./role-models.ts";

export type ChildRuntimePolicy = "probe" | "gate" | "worker";

type ThinkingLevel = NonNullable<RoleModelTarget["thinkingLevel"]>;

/**
 * The part of a resolved role model a child needs: which provider and model to
 * run, the thinking level the role asked for, and where that choice came from.
 * A structural subset of RoleModelTarget, so a pinned plan's target passes as is.
 */
export type ChildModelTarget = Pick<RoleModelTarget, "role" | "provider" | "id" | "source"> & {
  thinkingLevel?: ThinkingLevel;
};

// A child built without a target runs on the session model. Production callers
// always pass a target; this source makes any that does not visible in the report.
const UNPINNED_SOURCE: RoleModelSource = { kind: "session", reason: "unpinned-caller" };

function describeModelSource(source: RoleModelSource): string {
  switch (source.kind) {
    case "steward":
      return `steward ${source.agent}`;
    case "hatch-config":
      return `${source.file} ${source.key}`;
    case "session":
      return `session (${source.reason})`;
  }
}

export interface ChildRuntimeReport {
  provider: string;
  model: string;
  policy: ChildRuntimePolicy;
  exactModelResolved: boolean;
  parentAuthConfigured: boolean;
  parentAuthSource?: string;
  childAuthConfigured: boolean;
  copiedProvider: "builtin" | "config" | "native";
  copiedRuntimeCredential: boolean;
  unresolvedEnvironmentKeys: string[];
  // Whether the resolved child model advertises image input, and its full declared
  // input list. Populated from the resolved model so the vision-capability preflight
  // (used by the visual gate) can fail closed on a text-only gate model without
  // spawning a session. Optional so existing report fixtures stay valid.
  advertisesImageInput?: boolean;
  modelInputs?: string[];
  // The provider id whose executable hook the operator trusted in the user-level
  // trust file. Present only when a gate or worker child actually ran on such a
  // hook, so a report without it says no trust decision carried the run.
  trustedProviderHook?: string;
  // Which role the child serves and where its model came from. Optional so
  // existing report fixtures stay valid; a child built without a target records
  // the session source with reason "unpinned-caller" and no role.
  role?: HatchModelRole;
  modelSource?: RoleModelSource;
  // The thinking level the child asked for, and the level Pi actually applied
  // after clamping it to the model's capabilities.
  requestedThinkingLevel?: ThinkingLevel;
  thinkingLevel?: ThinkingLevel;
}

const TRUSTED_PROVIDER_HOOKS_DIR = "hatch";
const TRUSTED_PROVIDER_HOOKS_FILE = "trusted-provider-hooks.json";

/** Path of the user-level provider-hook trust file. Never read from the project. */
export function trustedProviderHooksPath(agentDir = getAgentDir()): string {
  return join(agentDir, TRUSTED_PROVIDER_HOOKS_DIR, TRUSTED_PROVIDER_HOOKS_FILE);
}

/**
 * Read the provider ids the operator trusted to carry gate and worker children.
 * A missing file trusts nothing. A malformed file fails closed with an error that
 * names it, because treating damage as an empty list would silently drop a grant
 * the operator believed was in place.
 */
export function readTrustedProviderHooks(agentDir = getAgentDir()): ReadonlySet<string> {
  const path = trustedProviderHooksPath(agentDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set<string>();
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Hatch cannot read trusted provider hook file '${path}': ${reason}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Hatch trusted provider hook file '${path}' is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Hatch trusted provider hook file '${path}' must be a JSON object with a "providers" array`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => key !== "providers");
  if (unknownKeys.length > 0) {
    throw new Error(
      `Hatch trusted provider hook file '${path}' has unknown key(s): ${unknownKeys.join(", ")}`,
    );
  }
  const providers = record.providers;
  if (
    !Array.isArray(providers) ||
    providers.some((id) => typeof id !== "string" || id.trim().length === 0)
  ) {
    throw new Error(
      `Hatch trusted provider hook file '${path}' must list provider ids as strings in "providers"`,
    );
  }
  return new Set(providers as string[]);
}

interface ManagedSession {
  abort(): Promise<void>;
  dispose(): void;
}

export class ChildRegistry {
  readonly #sessions = new Map<ManagedSession, string>();
  readonly lifecycles: LifecycleRegistry;

  constructor(lifecycles = new LifecycleRegistry()) {
    this.lifecycles = lifecycles;
  }

  add(
    session: ManagedSession,
    options: { cwd?: string; role?: LifecycleRole; label?: string; parentId?: string } = {},
  ): void {
    if (this.#sessions.has(session)) throw new Error("Hatch child session is already registered");
    const id = this.lifecycles.register({
      role: options.role ?? "phase0-probe",
      cwd: options.cwd ?? process.cwd(),
      label: options.label,
      parentId: options.parentId,
      resource: session,
    });
    this.#sessions.set(session, id);
  }

  delete(session: ManagedSession): void {
    const id = this.#sessions.get(session);
    if (!id) return;
    this.lifecycles.forget(id);
    this.#sessions.delete(session);
  }

  get size(): number {
    return this.#sessions.size;
  }

  async abortAll(): Promise<void> {
    await this.lifecycles.shutdown();
    this.#sessions.clear();
  }
}

export async function createIsolatedResourceLoader(
  cwd: string,
  systemPrompt: string,
  agentDir = getAgentDir(),
): Promise<{ loader: DefaultResourceLoader; settings: SettingsManager }> {
  const settings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
  });
  await loader.reload();
  return { loader, settings };
}

export async function createMirroredModelRuntime(
  ctx: ExtensionContext,
  policy: ChildRuntimePolicy = "probe",
  target?: ChildModelTarget,
): Promise<{
  runtime: ModelRuntime;
  model: NonNullable<ExtensionContext["model"]>;
  report: ChildRuntimeReport;
}> {
  // The session model stays required even with a target: it anchors fallbacks
  // and the provider overrides the role resolution read.
  if (!ctx.model) {
    throw new Error("Pi has no active model");
  }

  const providerId = target?.provider ?? ctx.model.provider;
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
  const isolatedPolicy = policy === "gate" || policy === "worker";
  // Only an isolated child needs the trust decision, and the file is read here as
  // well as by the gate preflight cache key, so the probe policy is unchanged.
  const executableConfigHooks = Boolean(
    providerConfig &&
      (providerConfig.streamSimple || providerConfig.refreshModels || providerConfig.oauth),
  );
  const trustedProviderHook =
    isolatedPolicy &&
    (nativeProvider !== undefined || executableConfigHooks) &&
    readTrustedProviderHooks().has(providerId)
      ? providerId
      : undefined;
  if (isolatedPolicy && nativeProvider && !trustedProviderHook) {
    throw new Error(
      `Hatch ${policy} children do not inherit dynamic native provider '${providerId}' because it contains ambient extension code`,
    );
  }
  if (isolatedPolicy && executableConfigHooks && !trustedProviderHook) {
    throw new Error(
      `Hatch ${policy} children do not inherit executable provider hooks for '${providerId}' from an ambient extension`,
    );
  }

  const parentModel = target ? ctx.modelRegistry.find(target.provider, target.id) : ctx.model;
  if (!parentModel) {
    throw new Error(
      `Hatch ${policy} runtime cannot find '${target?.provider}/${target?.id}' (role ${target?.role}, from ${target ? describeModelSource(target.source) : "session"}) in Pi's model registry`,
    );
  }
  const modelId = parentModel.id;

  const runtime = await ModelRuntime.create({ allowModelNetwork: false });
  let copiedProvider: ChildRuntimeReport["copiedProvider"] = "builtin";

  if (nativeProvider) {
    runtime.registerNativeProvider(nativeProvider);
    copiedProvider = "native";
  }
  if (providerConfig) {
    runtime.registerProvider(providerId, providerConfig);
    copiedProvider = "config";
  }

  const parentAuthStatus = ctx.modelRegistry.getProviderAuthStatus(providerId);
  const resolvedParentAuth = await ctx.modelRegistry.getApiKeyAndHeaders(parentModel);
  let copiedRuntimeCredential = false;
  let unresolvedEnvironmentKeys: string[] = [];

  if (resolvedParentAuth.ok) {
    unresolvedEnvironmentKeys = Object.keys(resolvedParentAuth.env ?? {});
    if (parentAuthStatus.source === "runtime" && resolvedParentAuth.apiKey) {
      await runtime.setRuntimeApiKey(providerId, resolvedParentAuth.apiKey);
      copiedRuntimeCredential = true;
    }
  }

  const exactModel = runtime.getModel(providerId, modelId);
  if (isolatedPolicy && !exactModel) {
    throw new Error(
      `Hatch ${policy} runtime cannot resolve exact model '${providerId}/${modelId}' without the parent runtime`,
    );
  }
  const childModel = exactModel ?? parentModel;
  const childAuthStatus = runtime.getProviderAuthStatus(providerId);
  const modelInputs = Array.isArray(childModel.input) ? [...childModel.input] : [];
  return {
    runtime,
    model: childModel,
    report: {
      provider: providerId,
      model: modelId,
      policy,
      exactModelResolved: exactModel !== undefined,
      parentAuthConfigured: parentAuthStatus.configured,
      parentAuthSource: parentAuthStatus.source,
      childAuthConfigured: childAuthStatus.configured,
      copiedProvider,
      copiedRuntimeCredential,
      unresolvedEnvironmentKeys,
      advertisesImageInput: modelInputs.includes("image"),
      modelInputs,
      ...(trustedProviderHook ? { trustedProviderHook } : {}),
      ...(target ? { role: target.role } : {}),
      modelSource: target?.source ?? UNPINNED_SOURCE,
      ...(target?.thinkingLevel ? { requestedThinkingLevel: target.thinkingLevel } : {}),
    },
  };
}

async function createChild(
  ctx: ExtensionContext,
  systemPrompt: string,
  customTools: ToolDefinition[] = [],
  policy: ChildRuntimePolicy = "probe",
  cwd = ctx.cwd,
  target?: ChildModelTarget,
): Promise<{ session: AgentSession; report: ChildRuntimeReport }> {
  const { runtime, model, report } = await createMirroredModelRuntime(ctx, policy, target);
  const { loader, settings } = await createIsolatedResourceLoader(cwd, systemPrompt);
  const requestedThinkingLevel = target?.thinkingLevel ?? ctx.thinkingLevel ?? "minimal";
  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    model,
    thinkingLevel: requestedThinkingLevel,
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(ctx.cwd),
    noTools: "all",
    tools: customTools.map((tool) => tool.name),
    customTools,
  });
  // Pi clamps the requested level to what the model supports; record both.
  report.requestedThinkingLevel = requestedThinkingLevel;
  report.thinkingLevel = session.thinkingLevel;
  return { session, report };
}

export async function createGateChildSession(
  ctx: ExtensionContext,
  systemPrompt: string,
  customTools: ToolDefinition[],
  cwd: string,
  target?: ChildModelTarget,
): Promise<{ session: AgentSession; report: ChildRuntimeReport }> {
  if (customTools.length === 0) throw new Error("Hatch gate child requires explicit tools");
  return createChild(ctx, systemPrompt, customTools, "gate", cwd, target);
}

export async function createWorkerChildSession(
  ctx: ExtensionContext,
  systemPrompt: string,
  customTools: ToolDefinition[],
  cwd: string,
  target?: ChildModelTarget,
): Promise<{ session: AgentSession; report: ChildRuntimeReport }> {
  if (customTools.length === 0) throw new Error("Hatch worker child requires explicit tools");
  return createChild(ctx, systemPrompt, customTools, "worker", cwd, target);
}

function bindAbort(session: AgentSession, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => undefined;
  const abort = () => void session.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

export async function runAuthProbe(ctx: ExtensionContext): Promise<ChildRuntimeReport> {
  const { session, report } = await createChild(ctx, "Reply only when prompted.");
  session.dispose();
  return report;
}

export async function runGateAuthProbe(
  ctx: ExtensionContext,
  target?: ChildModelTarget,
): Promise<ChildRuntimeReport> {
  const { report } = await createMirroredModelRuntime(ctx, "gate", target);
  return report;
}

const GATE_PREFLIGHT_RESPONSE = "HATCH_GATE_RUNTIME_OK";

export interface GateProviderPreflightReport extends ChildRuntimeReport {
  cached: boolean;
}

export async function runGateResponseProbe(
  ctx: ExtensionContext,
  registry: ChildRegistry,
  target?: ChildModelTarget,
): Promise<ChildRuntimeReport> {
  const { session, report } = await createChild(
    ctx,
    `Reply with exactly ${GATE_PREFLIGHT_RESPONSE} and no other text.`,
    [],
    "gate",
    ctx.cwd,
    target,
  );
  registry.add(session, {
    cwd: ctx.cwd,
    role: "provider-preflight",
    label: `${report.provider}/${report.model}`,
  });
  const unbind = bindAbort(session, ctx.signal);
  try {
    await session.prompt("Run the isolated Hatch gate provider preflight.");
    const response = session.getLastAssistantText()?.trim() ?? "";
    if (response !== GATE_PREFLIGHT_RESPONSE) {
      throw new Error(
        `Hatch gate provider preflight returned an unexpected response for '${report.provider}/${report.model}'`,
      );
    }
    return report;
  } finally {
    unbind();
    registry.delete(session);
    session.dispose();
  }
}

export type GatePreflightProbe = (
  ctx: ExtensionContext,
  registry: ChildRegistry,
  target?: ChildModelTarget,
) => Promise<ChildRuntimeReport>;

// Roles that resolve to the same model share one probe, so a shared report is
// handed back under the requesting role. The effective thinking level belongs to
// the probe that ran; it is dropped when the requesting role asked for another.
function forRole(
  ctx: ExtensionContext,
  report: ChildRuntimeReport,
  target?: ChildModelTarget,
): ChildRuntimeReport {
  const { role: _role, modelSource: _source, requestedThinkingLevel, thinkingLevel, ...rest } = report;
  const requested = target?.thinkingLevel ?? ctx.thinkingLevel ?? "minimal";
  return {
    ...rest,
    ...(target ? { role: target.role } : {}),
    modelSource: target?.source ?? UNPINNED_SOURCE,
    requestedThinkingLevel: requested,
    ...(thinkingLevel && requestedThinkingLevel === requested ? { thinkingLevel } : {}),
  };
}

export class GateProviderPreflight {
  readonly #successful = new Map<string, ChildRuntimeReport>();
  readonly #pending = new Map<string, Promise<ChildRuntimeReport>>();
  readonly #probe: GatePreflightProbe;
  #generation = 0;

  constructor(probe: GatePreflightProbe = runGateResponseProbe) {
    this.#probe = probe;
  }

  // Keyed on the provider, model, credential path, provider identity and trust
  // decision the probe proved. The thinking level is not part of it: it does not
  // change which provider, model or credential carries the child.
  #key(ctx: ExtensionContext, target?: ChildModelTarget): string {
    if (!ctx.model) throw new Error("Pi has no active model");
    const provider = target?.provider ?? ctx.model.provider;
    const modelId = target?.id ?? ctx.model.id;
    const auth = ctx.modelRegistry.getProviderAuthStatus(provider);
    const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig?.(provider);
    const providerIdentity = createHash("sha256")
      .update(
        JSON.stringify(providerConfig ?? null, (_key, value) =>
          typeof value === "function" ? `[function:${value.name || "anonymous"}]` : value,
        ),
      )
      .digest("hex");
    return [
      provider,
      modelId,
      auth.source ?? "unconfigured",
      providerIdentity,
      // The trust decision is part of the identity, so trusting or untrusting a
      // provider re-arms a cached success instead of reusing it.
      readTrustedProviderHooks().has(provider) ? "trusted" : "untrusted",
    ].join("\u0000");
  }

  async ensure(
    ctx: ExtensionContext,
    registry: ChildRegistry,
    target?: ChildModelTarget,
  ): Promise<GateProviderPreflightReport> {
    const key = this.#key(ctx, target);
    const successful = this.#successful.get(key);
    if (successful) return { ...forRole(ctx, successful, target), cached: true };
    const pending = this.#pending.get(key);
    if (pending) return { ...forRole(ctx, await pending, target), cached: true };

    const generation = this.#generation;
    const probe = this.#probe(ctx, registry, target);
    this.#pending.set(key, probe);
    try {
      const report = await probe;
      if (generation === this.#generation) this.#successful.set(key, report);
      return { ...forRole(ctx, report, target), cached: false };
    } finally {
      this.#pending.delete(key);
    }
  }

  clear(): void {
    this.#generation += 1;
    this.#successful.clear();
    this.#pending.clear();
  }

  get size(): number {
    return this.#successful.size;
  }
}

export async function runResponseProbe(
  ctx: ExtensionContext,
  registry: ChildRegistry,
): Promise<ChildRuntimeReport & { response: string }> {
  const { session, report } = await createChild(
    ctx,
    "Reply with exactly HATCH_PHASE0_OK and no other text.",
  );
  registry.add(session, { cwd: ctx.cwd, label: "response probe" });
  const unbind = bindAbort(session, ctx.signal);
  try {
    await session.prompt("Run the response probe.");
    return { ...report, response: session.getLastAssistantText() ?? "" };
  } finally {
    unbind();
    registry.delete(session);
    session.dispose();
  }
}

export async function runMultiChildShutdownProbe(ctx: ExtensionContext): Promise<{
  children: number;
  toolCallsStarted: number;
  toolSignalsAborted: number;
  modelStreamsStarted: number;
  activeAfterShutdown: number;
}> {
  const registry = new ChildRegistry();
  if (ctx.signal?.aborted) throw new Error("multi-child shutdown probe was already aborted");
  const abort = () => void registry.abortAll();
  ctx.signal?.addEventListener("abort", abort, { once: true });
  const states = [
    { started: false, aborted: false, resolveStarted: undefined as (() => void) | undefined },
    { started: false, aborted: false, resolveStarted: undefined as (() => void) | undefined },
  ];
  const started = states.map(
    (state) =>
      new Promise<void>((resolve) => {
        state.resolveStarted = resolve;
      }),
  );
  const sessions: AgentSession[] = [];
  const prompts: Promise<void>[] = [];
  const unsubscribers: Array<() => void> = [];
  let modelStreamsStarted = 0;
  let resolveStreamStarted: (() => void) | undefined;
  const streamStarted = new Promise<void>((resolve) => {
    resolveStreamStarted = resolve;
  });
  let startTimer: NodeJS.Timeout | undefined;
  try {
    for (const [index, state] of states.entries()) {
      const toolName = `phase0_wait_${index + 1}`;
      const waitTool: ToolDefinition = {
        name: toolName,
        label: `Phase 0 wait ${index + 1}`,
        description: `Required multi-child shutdown probe. Call ${toolName} exactly once.`,
        parameters: Type.Object({}),
        async execute(_id, _params, signal) {
          state.started = true;
          state.resolveStarted?.();
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 60_000);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                state.aborted = true;
                reject(new Error(`${toolName} aborted`));
              },
              { once: true },
            );
          });
          return { content: [{ type: "text", text: "wait completed" }], details: undefined };
        },
      };
      const { session } = await createChild(
        ctx,
        `Call ${toolName} exactly once. Do not emit text before calling it.`,
        [waitTool],
        "gate",
      );
      sessions.push(session);
      registry.add(session, {
        cwd: ctx.cwd,
        role: "provider-preflight",
        label: `multi-child active ${index + 1}`,
      });
      prompts.push(session.prompt("Run the multi-child shutdown probe."));
    }
    const { session: streaming } = await createChild(
      ctx,
      "Write a long continuous response until interrupted. Do not call tools.",
      [],
      "gate",
    );
    sessions.push(streaming);
    registry.add(streaming, {
      cwd: ctx.cwd,
      role: "provider-preflight",
      label: "multi-child streaming",
    });
    unsubscribers.push(
      streaming.subscribe((event) => {
        if (event.type === "message_update" && modelStreamsStarted === 0) {
          modelStreamsStarted = 1;
          resolveStreamStarted?.();
        }
      }),
    );
    prompts.push(streaming.prompt("Begin the streaming shutdown probe now."));

    const { session: idle } = await createChild(ctx, "Remain idle.", [], "gate");
    sessions.push(idle);
    registry.add(idle, {
      cwd: ctx.cwd,
      role: "provider-preflight",
      label: "multi-child idle",
    });

    await Promise.race([
      Promise.all([...started, streamStarted]),
      Promise.all(prompts).then(() => {
        throw new Error("a child settled before both wait tools started");
      }),
      new Promise<never>((_, reject) => {
        startTimer = setTimeout(
          () => reject(new Error("multi-child active states did not start within 45 seconds")),
          45_000,
        );
      }),
    ]);
    await registry.abortAll();
    await Promise.allSettled(prompts);
    return {
      children: sessions.length,
      toolCallsStarted: states.filter((state) => state.started).length,
      toolSignalsAborted: states.filter((state) => state.aborted).length,
      modelStreamsStarted,
      activeAfterShutdown: registry.size,
    };
  } finally {
    ctx.signal?.removeEventListener("abort", abort);
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (startTimer) clearTimeout(startTimer);
    if (registry.size > 0) await registry.abortAll();
    await Promise.allSettled(prompts);
  }
}

export async function runCancellationProbe(
  ctx: ExtensionContext,
  registry: ChildRegistry,
): Promise<ChildRuntimeReport & { toolStarted: boolean; toolSignalAborted: boolean }> {
  let toolStarted = false;
  let toolSignalAborted = false;
  let resolveStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const waitTool: ToolDefinition = {
    name: "phase0_wait",
    label: "Phase 0 wait",
    description: "Required Phase 0 cancellation probe. Call exactly once.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      toolStarted = true;
      resolveStarted?.();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 60_000);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            toolSignalAborted = true;
            reject(new Error("phase0 wait aborted"));
          },
          { once: true },
        );
      });
      return { content: [{ type: "text", text: "wait completed" }], details: undefined };
    },
  };
  const { session, report } = await createChild(
    ctx,
    "Call phase0_wait exactly once. Do not emit text before calling it.",
    [waitTool],
  );
  registry.add(session, { cwd: ctx.cwd, label: "cancellation probe" });
  const prompt = session.prompt("Run the cancellation probe.");
  let startTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      started,
      prompt.then(() => {
        throw new Error("child settled without calling phase0_wait");
      }),
      new Promise<never>((_, reject) => {
        startTimer = setTimeout(
          () => reject(new Error("model did not call phase0_wait within 30 seconds")),
          30_000,
        );
      }),
    ]);
    await session.abort();
    await prompt.catch(() => undefined);
    return { ...report, toolStarted, toolSignalAborted };
  } finally {
    if (startTimer) clearTimeout(startTimer);
    await session.abort().catch(() => undefined);
    await prompt.catch(() => undefined);
    registry.delete(session);
    session.dispose();
  }
}
