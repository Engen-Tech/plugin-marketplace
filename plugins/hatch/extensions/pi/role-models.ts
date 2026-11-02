import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readTrustedProviderHooks } from "./child-runtime.ts";
import type { HatchRoleId } from "./role-catalog.ts";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type HatchModelRole = HatchRoleId;

// Mirrors the rows of steward's routing table that cover each kind of child work.
// Hatch never parses that table at run time: it is prose, and a parse failure
// would be a silent re-route.
export const STEWARD_ROLE_DEFAULTS: Readonly<Record<HatchModelRole, string>> = Object.freeze({
  "build-worker": "steward.coder",
  "acceptance-gate": "steward.reviewer",
  "safety-gate": "steward.deep-reasoner",
  "visual-gate": "steward.reviewer",
  "doc-gardner": "steward.writer",
  "kaizen": "steward.writer",
});

export type SessionFallbackReason =
  | "steward-not-installed" | "profile-missing"
  | "hatch-config-session" | "hatch-config-default-session"
  | "unpinned-caller";                 // child built without a target; never on a production path
export type RoleModelSource =
  // For an agent remap, `model` names the setting in that agent's binding that chose the model.
  | { kind: "hatch-config"; file: string; key: string; agent?: string; agentFile?: string;
      model?: { file: string; key: string } }
  | { kind: "steward"; agent: string; agentFile: string; inheritsSession?: true;
      model?: { file: string; key: string }; thinking?: { file: string; key: string } }
  // `file` and `key` name the hatch-file setting when the hatch file chose the session model.
  | { kind: "session"; reason: SessionFallbackReason; agent?: string; file?: string; key?: string };
export interface RoleModelTarget {
  role: HatchModelRole;
  provider: string;
  id: string;
  thinkingLevel?: ThinkingLevel;      // requested; undefined = pinned session level
  source: RoleModelSource;
  advertisesImageInput: boolean;
}
export interface RoleModelPlan {
  schema: "hatch-role-models-v1";
  session: { provider: string; id: string; thinkingLevel?: ThinkingLevel };
  roles: Readonly<Record<HatchModelRole, RoleModelTarget>>;
  notes: readonly string[];
}
export interface RoleModelSummaryEntry {
  model: string; thinkingLevel?: ThinkingLevel;
  source: "steward" | "hatch-config" | "session";
  agent?: string; reason?: SessionFallbackReason | "profile-inherits-session"; imageInput?: boolean;
  // The file and key of the setting that chose the model, and the agent definition file
  // a steward or hatch-file agent binding was read from.
  file?: string; key?: string; agentFile?: string;
}

// Section 3 table order. The status token names the first flagged role in this order.
const ROLE_ORDER: readonly HatchModelRole[] = Object.keys(STEWARD_ROLE_DEFAULTS) as HatchModelRole[];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// pi-subagents' identifier pattern (pi-subagents/src/agents/identity.js).
const AGENT_NAME = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
// pi-subagents keys hatch reads past without mirroring; each becomes a plan note.
const UNMIRRORED_KEYS = ["defaultProvider", "maxThinking", "disableThinking", "modelScope", "agentScanDirs", "fast"] as const;

const HATCH_MODELS_DIR = "hatch";
const HATCH_MODELS_FILE = "models.json";

/** Path of the user-level role-model file, beside the trust file. Never read from the project. */
export function hatchModelsConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, HATCH_MODELS_DIR, HATCH_MODELS_FILE);
}

interface HatchRoleEntry {
  agent?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

interface HatchModelsConfig {
  path: string;
  default: "steward" | "session";
  roles: Partial<Record<HatchModelRole, HatchRoleEntry>>;
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the operator's role-model file. A missing file means "steward decides".
 * Anything else that is not exactly the documented shape fails closed with an
 * error that names the file, the same discipline as readTrustedProviderHooks:
 * explicit operator config never silently degrades.
 */
function readHatchModelsConfig(agentDir: string): HatchModelsConfig {
  const path = hatchModelsConfigPath(agentDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, default: "steward", roles: {} };
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Hatch cannot read role model file '${path}': ${reason}`);
  }
  const fail = (message: string): never => {
    throw new Error(`Hatch role model file '${path}' ${message}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("is not valid JSON");
  }
  if (!isRecord(parsed)) return fail('must be a JSON object with optional "default" and "roles"');
  const unknownKeys = Object.keys(parsed).filter((key) => key !== "default" && key !== "roles");
  if (unknownKeys.length > 0) fail(`has unknown key(s): ${unknownKeys.join(", ")}`);
  const fallback = "default" in parsed ? parsed.default : "steward";
  if (fallback !== "steward" && fallback !== "session") fail('"default" must be "steward" or "session"');
  const rolesValue = "roles" in parsed ? parsed.roles : {};
  if (!isRecord(rolesValue)) return fail('"roles" must be an object keyed by hatch role id');
  const unknownRoles = Object.keys(rolesValue).filter((role) => !(ROLE_ORDER as readonly string[]).includes(role));
  if (unknownRoles.length > 0) fail(`has unknown role(s): ${unknownRoles.join(", ")}`);
  const roles: Partial<Record<HatchModelRole, HatchRoleEntry>> = {};
  for (const [role, value] of Object.entries(rolesValue)) {
    const at = `roles["${role}"]`;
    if (!isRecord(value)) fail(`${at} must be an object`);
    const entry = value as Record<string, unknown>;
    const extra = Object.keys(entry).filter((key) => !["agent", "model", "thinkingLevel"].includes(key));
    if (extra.length > 0) fail(`${at} has unknown key(s): ${extra.join(", ")}`);
    if (("agent" in entry) === ("model" in entry)) fail(`${at} must set exactly one of "agent" or "model"`);
    if ("thinkingLevel" in entry && !isThinkingLevel(entry.thinkingLevel)) {
      fail(`${at}.thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`);
    }
    if ("agent" in entry && (typeof entry.agent !== "string" || !AGENT_NAME.test(entry.agent))) {
      fail(`${at}.agent ${JSON.stringify(entry.agent)} is not a valid agent name`);
    }
    if ("model" in entry && (typeof entry.model !== "string" || entry.model.trim().length === 0)) {
      fail(`${at}.model must be "session" or an exact provider/id`);
    }
    roles[role as HatchModelRole] = {
      ...(typeof entry.agent === "string" ? { agent: entry.agent } : {}),
      ...(typeof entry.model === "string" ? { model: entry.model } : {}),
      ...(isThinkingLevel(entry.thinkingLevel) ? { thinkingLevel: entry.thinkingLevel } : {}),
    };
  }
  return { path, default: fallback as "steward" | "session", roles };
}

interface DiscoveredAgent {
  name: string;
  file: string;
  model?: string;
  thinking?: string;
}

function frontmatterString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// pi-subagents normalizePackageName (pi-subagents/src/agents/identity.js).
function normalizePackageName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "")
    .replace(/-+/g, "-").replace(/\.+/g, ".").replace(/(?:^[-.]+|[-.]+$)/g, "");
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Find packaged pi-subagents agents through pi's own package list. Identity is by
 * frontmatter content (`package: steward`), never by where a package came from.
 * The manifest keys and `<package>.<name>` naming are pi-subagents conventions that
 * hatch mirrors; only `name`, `package`, `model` and `thinking` are read, so nothing
 * else from a profile reaches a child. Unlike pi-subagents this reads `*.md` files
 * directly in each manifest dir, not recursively, and it fails closed on conflicting
 * duplicates instead of reproducing pi-subagents' priority rules.
 */
function discoverAgents(cwd: string, agentDir: string, settings: SettingsManager): Map<string, DiscoveredAgent> {
  const agents = new Map<string, DiscoveredAgent>();
  try {
    const packages = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings })
      .listConfiguredPackages();
    for (const { installedPath } of packages) {
      if (!installedPath) continue;
      const manifestPath = join(installedPath, "package.json");
      if (!existsSync(manifestPath)) continue;
      let manifest: unknown;
      try {
        manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        throw new Error(`package manifest '${manifestPath}' is not valid JSON`);
      }
      if (!isRecord(manifest)) {
        throw new Error(`package '${installedPath}' manifest '${manifestPath}' is not a JSON object`);
      }
      const roots: unknown[] = [manifest["pi-subagents"]];
      if (isRecord(manifest.pi)) roots.push(manifest.pi.subagents);
      const entries = roots.flatMap((root) =>
        isRecord(root) && Array.isArray(root.agents)
          ? root.agents.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          : [],
      );
      const realRoot = realpathSync(installedPath);
      for (const entry of entries) {
        const dir = resolve(installedPath, entry);
        if (isAbsolute(entry) || !inside(installedPath, dir)) {
          throw new Error(`agent dir '${entry}' in '${manifestPath}' is outside its package root`);
        }
        if (!existsSync(dir)) {
          throw new Error(`agent dir '${entry}' in '${manifestPath}' (package '${installedPath}') does not exist`);
        }
        if (!inside(realRoot, realpathSync(dir))) {
          throw new Error(`agent dir '${entry}' in '${manifestPath}' is outside its package root`);
        }
        for (const name of readdirSync(dir).sort()) {
          if (!name.endsWith(".md")) continue;
          const file = join(dir, name);
          if (!statSync(file).isFile()) continue;
          if (!inside(realRoot, realpathSync(file))) {
            throw new Error(`agent file '${file}' is outside its package root '${installedPath}'`);
          }
          const { frontmatter } = parseFrontmatter(readFileSync(file, "utf8"));
          const localName = frontmatterString(frontmatter.name);
          // pi-subagents skips a definition without name or description.
          if (!localName || !frontmatterString(frontmatter.description)) continue;
          const pkg = frontmatterString(frontmatter.package);
          const runtimeName = pkg ? `${normalizePackageName(pkg)}.${localName}` : localName;
          const found: DiscoveredAgent = {
            name: runtimeName,
            file,
            model: frontmatterString(frontmatter.model),
            thinking: frontmatterString(frontmatter.thinking),
          };
          const prior = agents.get(runtimeName);
          if (prior && (prior.model !== found.model || prior.thinking !== found.thinking)) {
            throw new Error(
              `agent '${runtimeName}' is defined twice with different model or thinking: '${prior.file}' and '${file}'`,
            );
          }
          if (!prior) agents.set(runtimeName, found);
        }
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Hatch cannot discover packaged agents: ${reason}; role models are not resolved`);
  }
  return agents;
}

interface SettingsLayer {
  path: string;
  subagents: Record<string, unknown>;
}

interface SourceRef {
  file: string;
  key: string;
}

interface Binding {
  agent: DiscoveredAgent;
  inherits: boolean;
  model?: string;
  modelSource?: SourceRef;
  thinking?: string;
  thinkingSource?: SourceRef;
}

function settingsString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A settings value hatch may read for `model` or `thinking`: a string, or `false`
 * (pi-subagents' documented way to clear a field). Anything else fails closed naming
 * the file and key, so a typo never silently drops to frontmatter or the session model.
 */
function settingsField(value: unknown, origin: SourceRef): string | undefined {
  if (typeof value === "string" || value === false) return settingsString(value);
  throw new Error(
    `Pi settings ${describeOrigin(origin)} must be a string or false, not ${JSON.stringify(value)}; role models are not resolved`,
  );
}

/** A settings entry hatch reads into: absent, or an object. Anything else fails closed. */
function settingsObject(
  container: Record<string, unknown>,
  name: string,
  origin: SourceRef,
): Record<string, unknown> | undefined {
  if (!(name in container)) return undefined;
  const value = container[name];
  if (isRecord(value)) return value;
  throw new Error(
    `Pi settings ${describeOrigin(origin)} must be an object, not ${JSON.stringify(value)}; role models are not resolved`,
  );
}

/**
 * The binding pi-subagents would launch `agent` with, mirrored from steward's
 * `_effective_binding` (steward-delegation/hooks/model_plan.py): frontmatter, then
 * defaults for absent fields (project else user), then user and project overrides
 * field by field, each plain entry overlaid by the entry scoped to the session
 * provider. `false` or `""` clears a field. A known `:level` suffix wins over
 * thinking. Unlike pi-subagents, the model string is never fuzzily resolved.
 * `modelSource` names the setting that chose the model, including one that chose
 * to inherit the session model, so a project override stays visible.
 */
function bindAgent(agent: DiscoveredAgent, layers: SettingsLayer[], sessionProvider: string): Binding {
  let model = agent.model;
  let modelSource: SourceRef | undefined = model ? { file: agent.file, key: "model" } : undefined;
  let thinking = agent.thinking;
  let thinkingSource: SourceRef | undefined = thinking ? { file: agent.file, key: "thinking" } : undefined;
  const pickDefault = (key: string): { value: string; file: string } | undefined => {
    for (const layer of [...layers].reverse()) {
      if (key in layer.subagents) {
        const value = settingsField(layer.subagents[key], { file: layer.path, key: `subagents.${key}` });
        return value ? { value, file: layer.path } : undefined;
      }
    }
    return undefined;
  };
  if (model === undefined) {
    const found = pickDefault("defaultModel");
    if (found) [model, modelSource] = [found.value, { file: found.file, key: "subagents.defaultModel" }];
  }
  if (thinking === undefined) {
    const found = pickDefault("defaultThinking");
    if (found) [thinking, thinkingSource] = [found.value, { file: found.file, key: "subagents.defaultThinking" }];
  }
  for (const layer of layers) {
    const fields = new Map<string, { value: unknown; key: string }>();
    const at = (key: string): SourceRef => ({ file: layer.path, key });
    const overrides = settingsObject(layer.subagents, "agentOverrides", at("subagents.agentOverrides"));
    const plain = overrides
      ? settingsObject(overrides, agent.name, at(`subagents.agentOverrides["${agent.name}"]`))
      : undefined;
    if (plain) {
      for (const field of ["model", "thinking"]) {
        if (field in plain) {
          fields.set(field, { value: plain[field], key: `subagents.agentOverrides["${agent.name}"].${field}` });
        }
      }
    }
    const byProvider = settingsObject(
      layer.subagents,
      "agentOverridesByProvider",
      at("subagents.agentOverridesByProvider"),
    );
    const scopedProvider = byProvider
      ? settingsObject(byProvider, sessionProvider, at(`subagents.agentOverridesByProvider.${sessionProvider}`))
      : undefined;
    const scoped = scopedProvider
      ? settingsObject(
          scopedProvider,
          agent.name,
          at(`subagents.agentOverridesByProvider.${sessionProvider}["${agent.name}"]`),
        )
      : undefined;
    if (scoped) {
      for (const field of ["model", "thinking"]) {
        if (field in scoped) {
          fields.set(field, {
            value: scoped[field],
            key: `subagents.agentOverridesByProvider.${sessionProvider}["${agent.name}"].${field}`,
          });
        }
      }
    }
    const modelField = fields.get("model");
    if (modelField) {
      modelSource = at(modelField.key);
      model = settingsField(modelField.value, modelSource);
    }
    const thinkingField = fields.get("thinking");
    if (thinkingField) {
      thinkingSource = at(thinkingField.key);
      thinking = settingsField(thinkingField.value, thinkingSource);
    }
  }
  const inherits = model === undefined || model.trim() === "inherit";
  if (!inherits && model !== undefined) {
    model = model.trim();
    const at = model.lastIndexOf(":");
    const tail = at > 0 ? model.slice(at + 1) : "";
    if (at > 0 && isThinkingLevel(tail)) {
      model = model.slice(0, at);
      thinking = tail;
      thinkingSource = modelSource ? { ...modelSource } : undefined;
    }
  }
  return {
    agent,
    inherits,
    ...(inherits ? {} : { model }),
    ...(modelSource ? { modelSource } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(thinking !== undefined && thinkingSource ? { thinkingSource } : {}),
  };
}

function policyFor(role: HatchModelRole): "gate" | "worker" {
  return role === "acceptance-gate" || role === "safety-gate" || role === "visual-gate" ? "gate" : "worker";
}

function describeOrigin(origin: SourceRef): string {
  return `'${origin.file}' ${origin.key}`;
}

// Where a model string came from, for an error: the setting that chose it, or Pi's
// session model when no setting did (steward absent or the mapped profile missing).
function describeChooser(origin: SourceRef | undefined): string {
  return origin ? `from ${describeOrigin(origin)}` : "(Pi's session model)";
}

/**
 * Resolve an exact `provider/id` the way the isolated child will: the string must
 * name a model in Pi's registry (requireAuth then checks its credential). A bare
 * or fuzzy id is never resolved to a nearby model; the error lists the exact
 * candidates instead.
 */
function exactModel(
  ctx: ExtensionContext,
  role: HatchModelRole,
  value: string,
  origin: SourceRef,
): NonNullable<ExtensionContext["model"]> {
  const slash = value.indexOf("/");
  const provider = slash > 0 ? value.slice(0, slash) : "";
  const id = slash > 0 ? value.slice(slash + 1) : "";
  const model = provider && id ? ctx.modelRegistry.find(provider, id) : undefined;
  if (!model) {
    const bare = slash > 0 ? id : value;
    const candidates = ctx.modelRegistry.getAll()
      .filter((candidate) => candidate.id === bare)
      .map((candidate) => `${candidate.provider}/${candidate.id}`);
    const hint = candidates.length > 0 ? `; exact candidates: ${candidates.join(", ")}` : "";
    throw new Error(
      `Hatch role '${role}' model '${value}' from ${describeOrigin(origin)} is not an exact provider/id in Pi's model registry${hint}`,
    );
  }
  return model;
}

function requireAuth(
  ctx: ExtensionContext,
  role: HatchModelRole,
  value: string,
  origin: SourceRef | undefined,
  model: NonNullable<ExtensionContext["model"]>,
): void {
  if (ctx.modelRegistry.hasConfiguredAuth(model)) return;
  throw new Error(
    `Hatch role '${role}' model '${value}' ${describeChooser(origin)}: provider '${model.provider}' has no configured auth in Pi`,
  );
}

/**
 * The same decision createMirroredModelRuntime (child-runtime.ts) makes when it
 * builds a gate or worker child, taken here at launch so a delivery fails before
 * any work rather than at its first child. createMirroredModelRuntime still
 * enforces it again at child creation; this check never replaces that one.
 */
function checkProviderTrust(
  ctx: ExtensionContext,
  role: HatchModelRole,
  providerId: string,
  trusted: () => ReadonlySet<string>,
  value: string,
  origin: SourceRef | undefined,
): void {
  const nativeProvider = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
  const providerConfig = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
  const executableConfigHooks = Boolean(
    providerConfig &&
      (providerConfig.streamSimple || providerConfig.refreshModels || providerConfig.oauth),
  );
  if (nativeProvider === undefined && !executableConfigHooks) return;
  if (trusted().has(providerId)) return;
  const policy = policyFor(role);
  const chosen = `role ${role}, model '${value}' ${describeChooser(origin)}`;
  if (nativeProvider) {
    throw new Error(
      `Hatch ${policy} children do not inherit dynamic native provider '${providerId}' because it contains ambient extension code (${chosen})`,
    );
  }
  throw new Error(
    `Hatch ${policy} children do not inherit executable provider hooks for '${providerId}' from an ambient extension (${chosen})`,
  );
}

function checkThinking(role: HatchModelRole, value: string | undefined, origin: SourceRef | undefined): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (isThinkingLevel(value)) return value;
  const where = origin ? ` from ${describeOrigin(origin)}` : "";
  throw new Error(
    `Hatch role '${role}' thinking level '${value}'${where} is not one of ${THINKING_LEVELS.join(", ")}`,
  );
}

/**
 * Resolve the model and thinking level for every hatch role, once, at launch.
 * Precedence per role: hatch-file `model`, hatch-file `agent`, hatch-file
 * `default: "session"`, the steward profile in STEWARD_ROLE_DEFAULTS, and only on
 * absence (no steward agent, or the mapped profile missing) the session model.
 * Every other problem throws; nothing here falls back to the session model on error.
 */
export function resolveRoleModelPlan(ctx: ExtensionContext, options: { agentDir?: string } = {}): RoleModelPlan {
  if (!ctx.model) throw new Error("Pi has no active model; hatch role models are not resolved");
  const sessionModel = ctx.model;
  const agentDir = options.agentDir ?? getAgentDir();
  const hatchConfig = readHatchModelsConfig(agentDir);

  // Settings and packages decide only steward and hatch-file agent bindings. With
  // "default": "session" and no role naming an agent, nothing reads them, so a broken
  // settings file or package cannot block the rollback.
  const needsSettings = hatchConfig.default !== "session" ||
    Object.values(hatchConfig.roles).some((entry) => entry?.agent !== undefined);
  const layers: SettingsLayer[] = [];
  const notes: string[] = [];
  let agents = new Map<string, DiscoveredAgent>();
  if (needsSettings) {
    const projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
    const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted });
    const userPath = join(agentDir, "settings.json");
    const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "settings.json");
    const settingsErrors = settings.drainErrors();
    if (settingsErrors.length > 0) {
      const described = settingsErrors.map((item) => {
        const path = item.path ?? (item.scope === "project" ? projectPath : userPath);
        return `'${path}': ${item.error.message}`;
      });
      throw new Error(`Hatch cannot read Pi settings ${described.join("; ")}; role models are not resolved`);
    }
    layers.push(
      { path: userPath, subagents: subagentsOf(settings.getGlobalSettings()) },
      ...(projectTrusted ? [{ path: projectPath, subagents: subagentsOf(settings.getProjectSettings()) }] : []),
    );
    for (const layer of layers) {
      for (const key of UNMIRRORED_KEYS) {
        if (key in layer.subagents) {
          notes.push(
            `Pi settings '${layer.path}' sets subagents.${key}, which hatch does not mirror; a role model may differ from what pi-subagents would launch`,
          );
        }
      }
    }
    agents = discoverAgents(ctx.cwd, agentDir, settings);
  }
  const stewardInstalled = [...agents.keys()].some((name) => name.startsWith("steward."));
  let trustedProviders: ReadonlySet<string> | undefined;
  const trusted = (): ReadonlySet<string> => (trustedProviders ??= readTrustedProviderHooks(agentDir));
  const sessionPin = {
    provider: sessionModel.provider,
    id: sessionModel.id,
    ...(isThinkingLevel(ctx.thinkingLevel) ? { thinkingLevel: ctx.thinkingLevel } : {}),
  };

  const sessionTarget = (
    role: HatchModelRole,
    source: RoleModelSource,
    origin: SourceRef | undefined,
    thinkingLevel?: ThinkingLevel,
  ): RoleModelTarget => {
    const value = `${sessionModel.provider}/${sessionModel.id}`;
    checkProviderTrust(ctx, role, sessionModel.provider, trusted, value, origin);
    requireAuth(ctx, role, value, origin, sessionModel);
    return {
      role,
      provider: sessionModel.provider,
      id: sessionModel.id,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      source,
      advertisesImageInput: advertisesImage(sessionModel),
    };
  };
  const modelTarget = (
    role: HatchModelRole,
    value: string,
    origin: SourceRef,
    source: RoleModelSource,
    thinkingLevel?: ThinkingLevel,
  ): RoleModelTarget => {
    const model = exactModel(ctx, role, value, origin);
    // Trust first: whether a provider may carry a child at all outranks its credential.
    checkProviderTrust(ctx, role, model.provider, trusted, value, origin);
    requireAuth(ctx, role, value, origin, model);
    return {
      role,
      provider: model.provider,
      id: model.id,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      source,
      advertisesImageInput: advertisesImage(model),
    };
  };
  const bindingTarget = (
    role: HatchModelRole,
    agent: DiscoveredAgent,
    source: (binding: Binding) => RoleModelSource,
    hatchThinking?: ThinkingLevel,
  ): RoleModelTarget => {
    const binding = bindAgent(agent, layers, sessionModel.provider);
    const thinking = hatchThinking ?? checkThinking(role, binding.thinking, binding.thinkingSource);
    if (binding.inherits) return sessionTarget(role, source(binding), binding.modelSource, thinking);
    return modelTarget(role, binding.model!, binding.modelSource!, source(binding), thinking);
  };

  const roles = {} as Record<HatchModelRole, RoleModelTarget>;
  for (const role of ROLE_ORDER) {
    const entry = hatchConfig.roles[role];
    if (entry?.model !== undefined) {
      const key = `roles["${role}"].model`;
      const origin = { file: hatchConfig.path, key };
      const source: RoleModelSource = { kind: "hatch-config", ...origin };
      roles[role] = entry.model === "session"
        ? sessionTarget(role, { kind: "session", reason: "hatch-config-session", ...origin }, origin, entry.thinkingLevel)
        : modelTarget(role, entry.model, origin, source, entry.thinkingLevel);
      continue;
    }
    if (entry?.agent !== undefined) {
      const agent = agents.get(entry.agent);
      if (!agent) {
        throw new Error(
          `Hatch role '${role}' agent '${entry.agent}' from '${hatchConfig.path}' roles["${role}"].agent was not found among Pi's configured packages`,
        );
      }
      const source = (binding: Binding): RoleModelSource => ({
        kind: "hatch-config",
        file: hatchConfig.path,
        key: `roles["${role}"].agent`,
        agent: entry.agent,
        agentFile: agent.file,
        ...(binding.modelSource ? { model: binding.modelSource } : {}),
      });
      roles[role] = bindingTarget(role, agent, source, entry.thinkingLevel);
      continue;
    }
    if (hatchConfig.default === "session") {
      const origin = { file: hatchConfig.path, key: "default" };
      roles[role] = sessionTarget(role, { kind: "session", reason: "hatch-config-default-session", ...origin }, origin);
      continue;
    }
    if (!stewardInstalled) {
      roles[role] = sessionTarget(role, { kind: "session", reason: "steward-not-installed" }, undefined);
      continue;
    }
    const agentName = STEWARD_ROLE_DEFAULTS[role];
    const agent = agents.get(agentName);
    if (!agent) {
      roles[role] = sessionTarget(role, { kind: "session", reason: "profile-missing", agent: agentName }, undefined);
      continue;
    }
    roles[role] = bindingTarget(role, agent, (binding) => ({
      kind: "steward",
      agent: agentName,
      agentFile: agent.file,
      ...(binding.inherits ? { inheritsSession: true as const } : {}),
      ...(binding.modelSource ? { model: binding.modelSource } : {}),
      ...(binding.thinkingSource ? { thinking: binding.thinkingSource } : {}),
    }));
  }
  return { schema: "hatch-role-models-v1", session: sessionPin, roles, notes };
}

function subagentsOf(settings: unknown): Record<string, unknown> {
  const value = isRecord(settings) ? settings.subagents : undefined;
  return isRecord(value) ? value : {};
}

function advertisesImage(model: { input?: readonly string[] }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

// The pin is keyed by the context object itself, so a run's context carries its
// table and a context hatch never pinned carries none. No runner signature changes.
const pins = new WeakMap<ExtensionContext, RoleModelPlan>();

/**
 * Pin `plan` on a fresh descriptor copy of `ctx` (the copy technique of
 * createBackgroundContext). Pinning the tool's own context would leak a stale table
 * into a later tool call that reuses that object.
 */
export function withPinnedRoleModels(ctx: ExtensionContext, plan: RoleModelPlan): ExtensionContext {
  const descriptors = Object.getOwnPropertyDescriptors(ctx) as PropertyDescriptorMap;
  const copy = Object.create(Object.getPrototypeOf(ctx), descriptors) as ExtensionContext;
  pins.set(copy, plan);
  return copy;
}

/** Pin `plan` on a context hatch built for one run, such as the background context. */
export function pinRoleModels(ctx: ExtensionContext, plan: RoleModelPlan): void {
  pins.set(ctx, plan);
}

export function roleModelsOf(ctx: ExtensionContext): RoleModelPlan | undefined {
  return pins.get(ctx);
}

/** The pinned target for `role`. Runners never re-read settings or the hatch file mid-run. */
export function requireRoleModel(ctx: ExtensionContext, role: HatchModelRole): RoleModelTarget {
  const plan = pins.get(ctx);
  if (!plan) throw new Error("Hatch role models are not pinned for this run");
  return plan.roles[role];
}

export function summarizeRoleModels(plan: RoleModelPlan): Record<HatchModelRole, RoleModelSummaryEntry> {
  const summary = {} as Record<HatchModelRole, RoleModelSummaryEntry>;
  for (const role of ROLE_ORDER) {
    const target = plan.roles[role];
    const thinkingLevel = target.thinkingLevel ?? plan.session.thinkingLevel;
    const source = target.source;
    const entry: RoleModelSummaryEntry = {
      model: `${target.provider}/${target.id}`,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      source: source.kind,
    };
    if (source.kind === "steward") {
      entry.agent = source.agent;
      entry.agentFile = source.agentFile;
      if (source.model) [entry.file, entry.key] = [source.model.file, source.model.key];
      if (source.inheritsSession) entry.reason = "profile-inherits-session";
    } else if (source.kind === "hatch-config") {
      const chooser = source.model ?? { file: source.file, key: source.key };
      [entry.file, entry.key] = [chooser.file, chooser.key];
      if (source.agent) entry.agent = source.agent;
      if (source.agentFile) entry.agentFile = source.agentFile;
    } else if (source.kind === "session") {
      if (source.agent) entry.agent = source.agent;
      if (source.file && source.key) [entry.file, entry.key] = [source.file, source.key];
      entry.reason = source.reason;
    }
    if (role === "visual-gate") entry.imageInput = target.advertisesImageInput;
    summary[role] = entry;
  }
  return summary;
}

// The prose each session reason reads as in the status token. Only the absence
// reasons and unpinned callers are flagged; a session model the hatch file chose
// reads as config.
const REASON_PROSE: Readonly<Record<SessionFallbackReason, string>> = {
  "steward-not-installed": "steward not installed",
  "profile-missing": "profile missing",
  "hatch-config-session": "pinned to session",
  "hatch-config-default-session": "default session",
  "unpinned-caller": "unpinned caller",
};
const FLAGGED_REASONS: ReadonlySet<SessionFallbackReason> = new Set([
  "steward-not-installed",
  "profile-missing",
  "unpinned-caller",
]);

/**
 * One provenance token for the shared status line: `models steward`,
 * `models steward+config`, `models config`, `models session (steward not
 * installed)`, or a head followed by the first role that fell back on absence,
 * e.g. `models steward, safety-gate on session (profile missing) +1`. A session
 * model the hatch file chose reads as config; only absence and unpinned callers
 * are flagged.
 */
export function roleModelsToken(summary: Record<HatchModelRole, RoleModelSummaryEntry>): string {
  let steward = false;
  let config = false;
  const flagged: Array<{ role: HatchModelRole; reason: string }> = [];
  for (const role of ROLE_ORDER) {
    const entry = summary[role];
    if (!entry) continue;
    if (entry.source === "steward") steward = true;
    else if (entry.source === "hatch-config") config = true;
    else {
      const reason = entry.reason as SessionFallbackReason | undefined;
      if (reason && FLAGGED_REASONS.has(reason)) flagged.push({ role, reason: REASON_PROSE[reason] });
      else config = true;
    }
  }
  const first = flagged[0];
  if (first && !steward && !config && flagged.every((item) => item.reason === first.reason)) {
    return `models session (${first.reason})`;
  }
  const head = steward && config ? "steward+config" : steward ? "steward" : config ? "config" : "session";
  if (!first) return `models ${head}`;
  const more = flagged.length > 1 ? ` +${flagged.length - 1}` : "";
  return `models ${head}, ${first.role} on session (${first.reason})${more}`;
}
