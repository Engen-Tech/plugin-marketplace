/**
 * steward for pi: injects the delegation edict and runs the delegation gate. The prose gate and
 * the PR-body gate run in the steward-prose-gate extension.
 *
 * Every decision is made by hooks/delegation_hook.py, the same engine the Claude Code plugin runs.
 * This file only translates pi events into that script's JSON payloads (run as
 * `delegation_hook.py pi <subcommand>`) and maps its answers back onto pi's event results. Like the Claude Code hooks, it fails open:
 * if python3 is missing or the script errors, the tool call or reply goes through.
 *
 * For the model plan (docs/roadmap/pi-model-plan.md) it also reads pi's model registry and sends
 * those facts with the session-start payload, rebuilds the edict when the main model or its
 * thinking level changes, and adds the /steward-models command. `check` runs the hook's
 * `model-plan` subcommand and shows its report as a display-only session entry. `apply` runs
 * `model-plan-apply` as a dry run, shows the changes and asks (or needs `--yes` without a UI),
 * runs it again to write, then calls ctx.reload(); the reloaded instance shows a fresh check.
 *
 * Outcome log (Phase 4): one JSON line per finished steward.* launch to
 * $XDG_STATE_HOME/steward-delegation/pi-delegations.jsonl, from tool results and pi-subagents'
 * `subagent:async-complete` events; `/steward-models stats` runs the hook's `delegation-stats`
 * summarizer. No task text or output is logged, and every step fails open.
 *
 * Debugging: with STEWARD_DELEGATION_HOOK_LOG=<file>, every session-start, model-plan and model-plan-apply
 * hook call appends
 * one JSON line to that file ({kind: "hook", subcommand, payload, stdout, ms}, plus
 * `timedOut: true` or `error: <code>` when the call never finished), and each facts gathering one
 * line ({kind: "facts", ms, models, bytes}). Gate calls are never logged: their payloads carry
 * tool inputs and reply text. Unset, nothing is written.
 *
 * Delegation runs through the pi-subagents extension's `subagent` tool. Its foreground children
 * never load ambient extensions, and its background runner sets PI_SUBAGENT_CHILD=1, so this file
 * registers nothing in a child: the edict and its gates apply to the main thread only.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK_SCRIPT = resolve(PLUGIN_ROOT, "hooks", "delegation_hook.py");
/** Kill time for one hook call, and the budget for one edict load (the facts call plus its retry). */
export const HOOK_TIMEOUT_MS = 15_000;
/** Kill time for the session-start call that carries model_facts; the plain retry gets the rest. */
export const FACTS_TIMEOUT_MS = 5_000;

/** pi's built-in tools that write: the same set the Claude Code gate watches. */
const GATED_TOOLS = new Set(["bash", "edit", "write"]);
/** The delegation tool registered by pi-subagents, and its loader. */
const SUBAGENT_TOOL = "subagent";
const SUBAGENT_LOADER_TOOL = "subagents_enable";
/** System prompt section name; pi renders it as <steward>...</steward>. */
const SECTION = "steward";
const EDICT_MESSAGE_TYPE = "steward-edict";
const DELEGATION_GATE_PREFIX = "steward delegation gate";
const MODELS_COMMAND = "steward-models";
/** Custom entry type of the /steward-models report: shown in the transcript, never sent to the model. */
const MODELS_ENTRY_TYPE = "steward-models";
const MODELS_PLAN_SUBCOMMAND = "model-plan";
const MODELS_APPLY_SUBCOMMAND = "model-plan-apply";
const MODELS_USAGE = "Usage: /steward-models [check|apply [--yes]|stats [--days N]]";
const STATS_SUBCOMMAND = "delegation-stats";
/** Kill time for the writing apply call: long, so a slow disk never kills it mid-write. */
const APPLY_WRITE_TIMEOUT_MS = 60_000;
/**
 * Hand-off across ctx.reload(): the old extension instance is stale after reload, so it leaves
 * this process-wide note and the reloaded instance shows the fresh check at its session_start.
 */
const PENDING_CHECK_KEY = Symbol.for("steward.pi.pendingModelsCheck");
const PENDING_CHECK_MAX_AGE_MS = 120_000;

/** Hook calls STEWARD_DELEGATION_HOOK_LOG records; gate payloads carry commands, file contents and replies. */
const LOGGED_SUBCOMMANDS = new Set(["session-start", MODELS_PLAN_SUBCOMMAND, MODELS_APPLY_SUBCOMMAND]);

type HookOutput = Record<string, any> | undefined;

interface HookResult {
	output: HookOutput;
	/** Set when the python interpreter itself could not be started. */
	missingPython?: boolean;
}

/** Appends one JSON line to $STEWARD_DELEGATION_HOOK_LOG when it is set. Never throws. */
function debugLog(entry: Record<string, unknown>): void {
	const path = process.env.STEWARD_DELEGATION_HOOK_LOG;
	if (!path) return;
	try {
		appendFileSync(path, `${JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
	} catch {
		// debugging only
	}
}

export function runHook(
	subcommand: string,
	payload: Record<string, unknown>,
	timeoutMs: number = HOOK_TIMEOUT_MS,
): Promise<HookResult> {
	return new Promise((done) => {
		let settled = false;
		const finish = (result: HookResult) => {
			if (!settled) {
				settled = true;
				done(result);
			}
		};
		const started = Date.now();
		const logged = (result: HookResult, stdout: string, extra: Record<string, unknown> = {}) => {
			if (!settled && LOGGED_SUBCOMMANDS.has(subcommand)) debugLog({ kind: "hook", subcommand, payload, stdout, ms: Date.now() - started, ...extra });
			finish(result);
		};
		let child;
		try {
			child = spawn(process.env.STEWARD_DELEGATION_PYTHON || "python3", [HOOK_SCRIPT, "pi", subcommand], {
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch (err) {
			logged({ output: undefined, missingPython: true }, "", { error: (err as NodeJS.ErrnoException)?.code ?? "spawn" });
			return;
		}
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			logged({ output: undefined }, Buffer.concat(chunks).toString("utf8"), { timedOut: true });
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			logged({ output: undefined, missingPython: err.code === "ENOENT" }, "", { error: err.code ?? "spawn" });
		});
		child.on("close", () => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) return logged({ output: undefined }, text);
			try {
				const parsed = JSON.parse(text);
				logged({ output: parsed && typeof parsed === "object" ? parsed : undefined }, text);
			} catch {
				logged({ output: undefined }, text);
			}
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
	});
}

/**
 * True when a `subagent` call starts work, so it counts as a delegation: a direct child
 * (`agent`), top-level parallel `tasks` or a `chain` (pi-subagents 0.83.0
 * `src/extension/schemas.js:279-281`), a workflow, or `action: "resume"` of a retained child.
 * Other management calls
 * (`action: "list"`, `"status"`, `"guide"`, ...) and the `subagents_enable` loader do not.
 */
export function launchesWork(input: unknown): boolean {
	if (!input || typeof input !== "object") return false;
	const args = input as Record<string, unknown>;
	if (args.action === "resume") return true;
	if (args.action !== undefined) return false;
	const nonEmpty = (v: unknown) => Array.isArray(v) && v.length > 0;
	return Boolean(args.agent) || Boolean(args.workflow) || nonEmpty(args.tasks) || nonEmpty(args.chain);
}

/** What the extension needs from `@earendil-works/pi-ai`. */
export interface PiAi {
	getSupportedThinkingLevels?: (model: any) => unknown;
}

/** pi's extension loader aliases pi packages, so this import works without node_modules. */
const defaultLoadPiAi = () => import("@earendil-works/pi-ai") as Promise<PiAi>;

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * The registry facts hooks/model_plan.py reads (its docstring is the contract): main model and
 * thinking level, every catalog model with whether its provider has configured auth, supported
 * thinking levels and max output tokens, project trust and the absolute cwd. Returns undefined
 * when anything is missing or throws, so the caller sends no facts and the hook falls back to the
 * plain edict.
 */
export function gatherModelFacts(ctx: ExtensionContext, piAi: PiAi | undefined): Record<string, unknown> | undefined {
	try {
		const levelsOf = piAi?.getSupportedThinkingLevels;
		if (typeof levelsOf !== "function") return undefined;
		const registry = ctx.modelRegistry;
		if (!registry || typeof registry.getAll !== "function" || typeof registry.hasConfiguredAuth !== "function") {
			return undefined;
		}
		const all = registry.getAll();
		if (!Array.isArray(all)) return undefined;
		const auth = new Map<string, boolean>();
		const models: Record<string, unknown>[] = [];
		for (const model of all) {
			if (!model || !nonEmpty(model.provider) || !nonEmpty(model.id)) continue;
			let available = auth.get(model.provider);
			if (available === undefined) {
				available = registry.hasConfiguredAuth(model) === true;
				auth.set(model.provider, available);
			}
			const entry: Record<string, unknown> = { provider: model.provider, id: model.id, available };
			const levels = levelsOf(model);
			if (Array.isArray(levels) && levels.every((level) => typeof level === "string")) entry.thinkingLevels = [...levels];
			if (Number.isInteger(model.maxTokens) && model.maxTokens > 0) entry.maxTokens = model.maxTokens;
			models.push(entry);
		}
		if (models.length === 0) return undefined;
		let main: Record<string, string> | null = null;
		const current = ctx.model;
		if (current) {
			const thinkingLevel = ctx.thinkingLevel;
			if (!nonEmpty(current.provider) || !nonEmpty(current.id) || !nonEmpty(thinkingLevel)) return undefined;
			main = { provider: current.provider, id: current.id, thinkingLevel };
		}
		const projectTrusted = ctx.isProjectTrusted();
		if (typeof projectTrusted !== "boolean") return undefined;
		if (!nonEmpty(ctx.cwd)) return undefined;
		return { main, models, projectTrusted, cwd: resolve(ctx.cwd) };
	} catch {
		return undefined;
	}
}

function sessionId(ctx: ExtensionContext): string {
	try {
		const id = ctx.sessionManager.getSessionId();
		if (id) return `pi-${id}`;
	} catch {
		// fall through
	}
	// Per process, so two sessions without an id never share one edit counter.
	return `pi-pid-${process.pid}`;
}

const MISSING_SUBAGENTS_WARNING =
	"STEWARD WARNING: the pi-subagents extension is not loaded, so there is no subagent tool and " +
	"the edict cannot be followed. Install it with `pi install npm:pi-subagents`. Until then " +
	"the delegation gate only reminds instead of blocking. Tell the operator before starting " +
	"non-trivial work.";

const SUBAGENT_NOT_ACTIVE_WARNING =
	"STEWARD WARNING: the pi-subagents extension is installed, but the subagent tool is not available " +
	"in this session, so the delegation gate only reminds instead of blocking. Tell the operator: " +
	'setting `"toolActivation": "eager"` in ~/.pi/agent/extensions/subagent/config.json and running ' +
	"/reload, or starting a new session, makes it available. Restarting pi and resuming this " +
	"conversation does not, because pi restores the conversation's recorded tools on resume.";

/** Rotate the outcome log to `<file>.<stamp>-<pid>` when it grows past this size. */
export const DELEGATION_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DELEGATION_LOG_NAME = "pi-delegations.jsonl";
/** pi-subagents 0.83.0 events (`PS/src/shared/types.js:11,15`). */
const ASYNC_STARTED_EVENT = "subagent:async-started";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const STEWARD_PREFIX = "steward.";
/** Bound on the per-session maps the logger keeps between launch and completion. */
const MAX_TRACKED = 500;

/** Per profile, the exact model strings the block names for a relaunch and an escalation. */
export type LaunchStrings = Record<string, { relaunch?: string | null; escalation?: string | null }>;

export function delegationLogPath(env: NodeJS.ProcessEnv = process.env): string {
	const state = env.XDG_STATE_HOME || resolve(env.HOME || homedir(), ".local", "state");
	return resolve(state, "steward-delegation", DELEGATION_LOG_NAME);
}

/**
 * `kind` of a logged launch: no model param is plain; the profile's relaunch or escalation
 * string from the session-start data is relaunch or escalation; any other model is operator.
 */
export function classifyKind(agent: string, modelParam: string | undefined, strings: LaunchStrings): string {
	if (!modelParam) return "plain";
	const entry = strings[agent];
	if (entry?.relaunch && modelParam === entry.relaunch) return "relaunch";
	if (entry?.escalation && modelParam === entry.escalation) return "escalation";
	return "operator";
}

/** An HTTP status in an error line: at the start, or after "HTTP", "status", "code" or "error". */
const PROVIDER_STATUS = /(?:^|\n)\s*(?:(?:error|http|status(?: code)?|code)\s*[:=]?\s*)?(?:408|429|5\d\d)\b(?!\s*(?:items?|tests?|lines?|ms|bytes)\b)/i;
/** Transport and provider phrases as SDKs and pi-ai word them. */
const PROVIDER_PHRASE =
	/rate[ _-]?limit|too many requests|overloaded|insufficient_quota|quota exceeded|timed out|\btimeout\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|service unavailable|bad gateway|gateway timeout|internal server error|api error|unauthori[sz]ed|invalid api key|stream (?:error|ended)|first token/i;

/**
 * "provider" when an error text reads as a provider or transport failure, else "other". Callers
 * pass pi-subagents' structured `error` field only, never the child's output.
 */
export function errorClass(text: unknown): "provider" | "other" {
	return typeof text === "string" && (PROVIDER_STATUS.test(text) || PROVIDER_PHRASE.test(text)) ? "provider" : "other";
}

/** Model-supplied strings in the log: at most 100 characters of `[\w.:/@+-]`. */
export function cleanLogField(value: string): string {
	return value.slice(0, 100).replace(/[^\w.:/@+-]/g, "_");
}

/** Directories in the log: control characters stripped, at most 4096 characters. */
export function cleanLogPath(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 4096);
}

/** Keep this many rotated log files; older ones are removed. */
const ROTATED_KEEP = 2;

/** Tightens a path to `mode` when its group or other bits are set. */
function tighten(path: string, mode: number): void {
	try {
		if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, mode);
	} catch {
		// missing or not ours: leave it
	}
}

/** Splits "provider/id:level" into model and thinking; a non-level suffix stays in the model. */
function splitModel(value: unknown, thinking: unknown): { model: string | null; thinking: string | null } {
	const level = typeof thinking === "string" && thinking ? thinking : null;
	if (typeof value !== "string" || !value) return { model: null, thinking: level };
	const i = value.lastIndexOf(":");
	if (i > 0 && THINKING_LEVELS.has(value.slice(i + 1))) return { model: value.slice(0, i), thinking: level ?? value.slice(i + 1) };
	return { model: value, thinking: level };
}

function finiteMs(...values: unknown[]): number | null {
	for (const v of values) if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
	return null;
}

/** Appends one line to the outcome log, rotating above `maxBytes`. Never throws. */
function appendDelegationLine(entry: Record<string, unknown>, maxBytes: number): void {
	try {
		const path = delegationLogPath();
		const dir = dirname(path);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		tighten(dir, 0o700);
		try {
			if (statSync(path).size >= maxBytes) {
				// A unique name per rotation, so two sessions rotating at once never overwrite
				// each other's file; the loser only moves a fresh, small file aside.
				const stamp = new Date().toISOString().replace(/[-:.]/g, "");
				renameSync(path, `${path}.${stamp}-${process.pid}`);
				const base = `${DELEGATION_LOG_NAME}.`;
				const rotated = readdirSync(dir).filter((n) => n.startsWith(base)).sort();
				for (const old of rotated.slice(0, Math.max(0, rotated.length - ROTATED_KEEP))) {
					try {
						unlinkSync(resolve(dir, old));
					} catch {
						// another session removed it
					}
				}
			}
		} catch {
			// no file yet
		}
		appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		tighten(path, 0o600);
	} catch {
		// fail open: the log never affects the session
	}
}

/** What the extension needs from `@earendil-works/pi-tui` to draw the /steward-models entry. */
export interface PiTui {
	Text?: new (text?: string, paddingX?: number, paddingY?: number) => { render(width: number): string[]; invalidate(): void };
}

/** pi aliases pi-tui for extensions too. */
const defaultLoadPiTui = () => import("@earendil-works/pi-tui") as Promise<PiTui>;

export interface StewardOptions {
	/** Loads `@earendil-works/pi-ai`; tests pass a stand-in. */
	loadPiAi?: () => Promise<PiAi>;
	/** Loads `@earendil-works/pi-tui`; tests pass a stand-in. */
	loadPiTui?: () => Promise<PiTui>;
	/** Kill time for one hook call; tests shorten it. */
	hookTimeoutMs?: number;
	/** Kill time for the session-start call carrying model_facts; tests shorten it. */
	factsTimeoutMs?: number;
	/** Writes /steward-models output to stdout in print mode; tests capture it. */
	writeStdout?: (text: string) => void;
	/** Size at which the outcome log rotates; tests shrink it. */
	delegationLogMaxBytes?: number;
}

/**
 * pi 1.1.0 takes over process.stdout in every non-interactive mode (main.js calls
 * takeOverStdout, which sends process.stdout.write to stderr), so print-mode output goes
 * straight to fd 1. A non-blocking pipe can refuse a write; retry with a short blocking
 * sleep, then give up and say so on stderr.
 */
function defaultWriteStdout(text: string): void {
	writeAllSync(text);
}

export interface WriteAllDeps {
	/** Writes buf[off, off+len) and returns the bytes written; throws like fs.writeSync. */
	write?: (buf: Buffer, off: number, len: number) => number;
	/** Blocks for ms milliseconds. */
	sleep?: (ms: number) => void;
	/** Receives the one-line give-up notice. */
	notice?: (text: string) => void;
	/** Refused writes (EAGAIN) tolerated before giving up. */
	maxTries?: number;
}

const WRITE_RETRY_SLEEP_MS = 5;
const WRITE_MAX_TRIES = 400; // about 2 s of refusals in all

function blockingSleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeAllSync(text: string, deps: WriteAllDeps = {}): void {
	const write = deps.write ?? ((buf: Buffer, off: number, len: number) => writeSync(1, buf, off, len));
	const sleep = deps.sleep ?? blockingSleep;
	const notice =
		deps.notice ??
		((t: string) => {
			try {
				writeSync(2, t);
			} catch {
				// Nowhere left to report it.
			}
		});
	const maxTries = deps.maxTries ?? WRITE_MAX_TRIES;
	const buf = Buffer.from(text, "utf8");
	let off = 0;
	let tries = 0;
	while (off < buf.length) {
		try {
			off += write(buf, off, buf.length - off);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			const retry = code === "EAGAIN" || code === "EWOULDBLOCK";
			if (retry && tries < maxTries) {
				tries++;
				sleep(WRITE_RETRY_SLEEP_MS);
				continue;
			}
			const why = retry ? `stdout refused writes ${tries} times` : `stdout write failed (${code ?? "error"})`;
			notice(`steward: ${why}; ${buf.length - off} of ${buf.length} bytes of the report were not written.\n`);
			return;
		}
	}
}

export function createSteward(options: StewardOptions = {}): (pi: ExtensionAPI) => void {
	return (pi) =>
		register(
			pi,
			options.loadPiAi ?? defaultLoadPiAi,
			options.loadPiTui ?? defaultLoadPiTui,
			options.hookTimeoutMs ?? HOOK_TIMEOUT_MS,
			options.factsTimeoutMs ?? FACTS_TIMEOUT_MS,
			options.writeStdout ?? defaultWriteStdout,
			options.delegationLogMaxBytes ?? DELEGATION_LOG_MAX_BYTES,
		);
}

/** Splits text into lines of at most `width` characters, for a TUI without pi-tui. */
function wrapLines(text: string, width: number): string[] {
	const max = Math.max(1, width);
	const out: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) out.push("");
		for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
	}
	return out;
}

const steward = createSteward();
export default steward;

function register(
	pi: ExtensionAPI,
	loadPiAi: () => Promise<PiAi>,
	loadPiTui: () => Promise<PiTui>,
	hookTimeoutMs: number,
	factsTimeoutMs: number,
	writeStdout: (text: string) => void,
	logMaxBytes: number,
): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	/** The last edict that loaded. A rebuild replaces it only when it succeeds and is the newest. */
	let edict: string | undefined;
	/** Bumped by every load; the load whose number is still `generation` when it ends may land. */
	let generation = 0;
	/** The newest load still running, shared by before_agent_start instead of a second load. */
	let inflight: Promise<void> | undefined;
	/**
	 * A session-start call with model_facts gave no edict (timeout, bad output, crash) since the
	 * last session start or model/thinking switch: load the plain edict without facts until then.
	 */
	let factsFailed = false;
	let warnedMissingPython = false;
	/** True while the current run's system prompt carries the edict (set by before_agent_start). */
	let edictInPrompt = false;
	const softNotes = new Map<string, string>();
	/** Relaunch and escalation strings of the newest edict that loaded, for the outcome log. */
	let launchStrings: LaunchStrings = {};

	function hasDelegationTool(names: readonly string[]): boolean {
		return names.includes(SUBAGENT_TOOL) || names.includes(SUBAGENT_LOADER_TOOL);
	}

	/** pi-subagents is registered. On error, assume it is, so no false warning is shown. */
	function subagentsInstalled(): boolean {
		try {
			return hasDelegationTool(pi.getAllTools().map((tool) => tool.name));
		} catch {
			return true;
		}
	}

	/**
	 * The model can call a delegation tool right now. pi-subagents can leave `subagent` registered
	 * but inactive (a resumed conversation recorded before it was installed), so check the active
	 * tools. On error, return false: the gate then reminds instead of blocking.
	 */
	function canDelegateNow(): boolean {
		try {
			const getActiveTools = (pi as Partial<ExtensionAPI>).getActiveTools;
			if (typeof getActiveTools !== "function") return subagentsInstalled();
			return hasDelegationTool(getActiveTools.call(pi));
		} catch {
			return false;
		}
	}

	/** Why the model cannot delegate in this session. */
	function cannotDelegateNote(): string {
		return subagentsInstalled() ? SUBAGENT_NOT_ACTIVE_WARNING : MISSING_SUBAGENTS_WARNING;
	}

	let piAi: Promise<PiAi | undefined> | undefined;
	function piAiModule(): Promise<PiAi | undefined> {
		piAi ??= loadPiAi().catch(() => undefined);
		return piAi;
	}

	/** Registry facts for the hook, or undefined (the hook then gives the plain edict). */
	async function modelFacts(ctx: ExtensionContext): Promise<Record<string, unknown> | undefined> {
		try {
			const started = Date.now();
			const facts = gatherModelFacts(ctx, await piAiModule());
			if (facts && process.env.STEWARD_DELEGATION_HOOK_LOG) {
				debugLog({
					kind: "facts",
					ms: Date.now() - started,
					models: (facts.models as unknown[]).length,
					bytes: Buffer.byteLength(JSON.stringify(facts)),
				});
			}
			return facts;
		} catch {
			return undefined;
		}
	}

	/** One session-start call; the edict text, or undefined. */
	async function sessionStart(
		ctx: ExtensionContext,
		payload: Record<string, unknown>,
		timeoutMs: number,
	): Promise<{ text?: string; missingPython?: boolean; launches?: LaunchStrings }> {
		const { output, missingPython } = await runHook("session-start", payload, timeoutMs);
		if (missingPython && ctx.hasUI && !warnedMissingPython) {
			warnedMissingPython = true;
			ctx.ui.notify("steward: python3 was not found, so the edict and its gates are off.", "warning");
		}
		const text = output?.hookSpecificOutput?.additionalContext;
		const launches = output?.hookSpecificOutput?.stewardLaunches;
		return {
			text: typeof text === "string" && text ? text : undefined,
			missingPython,
			launches: launches && typeof launches === "object" && !Array.isArray(launches) ? launches : undefined,
		};
	}

	/**
	 * The edict for the current model, or undefined. A call with model_facts that gives no edict
	 * is retried once without them, so a facts problem costs the block, never the edict. The
	 * facts call gets `factsTimeoutMs` and the retry the rest of `hookTimeoutMs`, so a load never
	 * runs longer than one hook call did in 0.10.0. A plain-only call gets `hookTimeoutMs`.
	 */
	async function loadEdict(ctx: ExtensionContext): Promise<{ text: string; launches: LaunchStrings } | undefined> {
		const base = { session_id: sessionId(ctx) };
		const started = Date.now();
		const facts = factsFailed ? undefined : await modelFacts(ctx);
		let result = facts
			? await sessionStart(ctx, { ...base, model_facts: facts }, Math.min(factsTimeoutMs, hookTimeoutMs))
			: await sessionStart(ctx, base, hookTimeoutMs);
		if (!result.text && facts && !result.missingPython) {
			factsFailed = true;
			const left = hookTimeoutMs - (Date.now() - started);
			if (left > 0) result = await sessionStart(ctx, base, left);
		}
		if (!result.text) return undefined;
		const text = subagentsInstalled() ? result.text : `${MISSING_SUBAGENTS_WARNING}\n\n${result.text}`;
		return { text, launches: result.launches ?? {} };
	}

	/**
	 * Starts a load as the newest generation. The previous edict stays in place until this load
	 * succeeds; an older load that ends later, or a load that fails, changes nothing. A failed
	 * load is not retried by later prompts: the next load comes with the next switch or session.
	 */
	function rebuild(ctx: ExtensionContext): Promise<void> {
		const mine = ++generation;
		const run = (async () => {
			let loaded: { text: string; launches: LaunchStrings } | undefined;
			try {
				loaded = await loadEdict(ctx);
			} catch {
				loaded = undefined;
			}
			if (mine === generation && loaded) {
				edict = loaded.text;
				launchStrings = loaded.launches;
			}
		})();
		inflight = run;
		void run.finally(() => {
			if (inflight === run) inflight = undefined;
		});
		return run;
	}

	/** Waits for the newest load, including one started while waiting. */
	async function settleLoads(): Promise<void> {
		for (let i = 0; inflight && i < 8; i++) await inflight;
	}

	pi.on("session_start", async (event, ctx) => {
		noteSession(ctx);
		softNotes.clear();
		edictInPrompt = false;
		factsFailed = false;
		await rebuild(ctx);
		if ((event as { reason?: string } | undefined)?.reason === "reload") await showPendingCheck(ctx);
	});

	// The main model changed (set, cycle or restore), or its thinking level did: rebuild so the
	// next run's system prompt carries a block for the new values. pi updates both before it emits
	// either event, so ctx reads the new values. A switch also gives the facts another try.
	// Both handlers start the load and return: pi awaits model_select handlers (setModel waits for
	// them), so waiting for the hook here would hold up the switch for as long as the hook runs.
	// before_agent_start waits for the load instead.
	pi.on("model_select", async (_event, ctx) => {
		factsFailed = false;
		void rebuild(ctx);
	});
	pi.on("thinking_level_select", async (_event, ctx) => {
		factsFailed = false;
		void rebuild(ctx);
	});

	// pi 1.2.0 also fires this for an idle sendMessage({ triggerTurn: true }) run
	// (BeforeAgentStartEvent is a union on messageType: "user" | "custom"). Both kinds get the
	// same section, so the system prompt and its prompt cache match a user run, and the run is
	// marked as carrying the edict, so the context handler below adds no second copy. The handler
	// reads neither `prompt` nor `message`.
	pi.on("before_agent_start", async (event, ctx) => {
		try {
			// Share a running load. With none running, keep the last good edict even when the newest
			// load failed: the next load comes with the next switch, so a hanging hook costs at most
			// the one load. Only with no edict at all does the prompt try again, as 0.10.0 did
			// (without facts if a facts call failed).
			if (inflight) await settleLoads();
			else if (edict === undefined) await rebuild(ctx);
			if (!edict) return undefined;
			edictInPrompt = true;
			const options = event.systemPromptOptions;
			// An earlier handler replaced the whole prompt, so a section would be ignored: append to
			// the replacement instead. A later handler that replaces the prompt starts from
			// event.systemPrompt, which already renders this section.
			if (options.forceSystemPrompt != null) {
				if (options.forceSystemPrompt.includes(`<${SECTION}>`)) return undefined;
				return { systemPrompt: `${event.systemPrompt}\n\n<${SECTION}>\n${edict}\n</${SECTION}>` };
			}
			options.sections[SECTION] = edict;
		} catch {
			// fail open
		}
		return undefined;
	});

	// A run that pi starts without before_agent_start (on pi 1.1.0, a sendMessage triggerTurn run
	// such as a background-completion notice) uses the base system prompt, which has no edict. For
	// those runs, add the edict to the end of each request's messages. Request-local: nothing is
	// stored in the session.
	pi.on("context", async (event) => {
		try {
			if (edictInPrompt || !edict) return undefined;
			const reminder = {
				role: "custom" as const,
				customType: EDICT_MESSAGE_TYPE,
				content:
					`<${SECTION}>\nThis turn started without a user prompt, so the steward edict is ` +
					`repeated here. It is standing instructions, not a new request.\n\n${edict}\n</${SECTION}>`,
				display: false,
				timestamp: Date.now(),
			};
			return { messages: [...event.messages, reminder] };
		} catch {
			return undefined;
		}
	});

	// Outcome log (docs/roadmap/pi-model-plan.md, Phase 4): one line per finished steward.*
	// launch. A sync result carries the finished rows in details.results[]; an async launch
	// returns results: [] and finishes later as a `subagent:async-complete` event, and a
	// workflow's children finish inside the workflow's completion. Never logs task text,
	// outputs or file contents; every step fails open.
	let session: { id?: string; cwd?: string } = {};
	/** Where one launch item runs: `ownCwd` is the item's own `cwd`, `remote` its cleaned machine name. */
	type ItemPlace = { cwd?: string; ownCwd?: string; remote: string | null; modelParam?: string; kind: string };
	type LaunchRecord = { modelParam?: string; kind: string; at: number; cwd?: string; remote: string | null; items?: ItemPlace[] };
	// Launch-time record of an async or detached run: its kind uses the relaunch and escalation
	// strings current at launch. In memory only, so a completion after /reload logs as plain.
	const asyncLaunches = new Map<string, LaunchRecord>();
	const started = new Map<string, number>();
	// The run directory pi-subagents reports on `subagent:async-started`, by run id.
	const startedCwd = new Map<string, string>();
	const ended = new Map<string, number>();
	const logged = new Set<string>();

	function noteSession(ctx: ExtensionContext): void {
		try {
			session = { id: sessionId(ctx), cwd: typeof ctx.cwd === "string" ? resolve(ctx.cwd) : undefined };
		} catch {
			// keep the last one
		}
	}

	/** An absolute directory pi-subagents reported, or undefined. */
	function reportedCwd(value: unknown): string | undefined {
		return typeof value === "string" && isAbsolute(value) ? resolve(value) : undefined;
	}

	/**
	 * Where a launch runs by its input: the top-level `cwd` against the session directory, then a
	 * per-item `cwd` against that, as pi-subagents 0.83.0 resolves them (src/shared/utils.js:111,
	 * src/runs/shared/child-launch-plan.js:70). Undefined when nothing anchors a relative path.
	 */
	function inputCwd(input: Record<string, any>, item?: Record<string, any>): string | undefined {
		let dir = session.cwd;
		for (const value of [input?.cwd, item?.cwd]) {
			if (typeof value !== "string" || !value) continue;
			if (isAbsolute(value)) dir = resolve(value);
			else if (dir !== undefined) dir = resolve(dir, value);
			else return undefined;
		}
		return dir;
	}

	const isObject = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

	/**
	 * The launch's items in the order pi-subagents numbers its result rows: `tasks` as given, or
	 * `chain` with each parallel group's tasks in place and a dynamic group as one slot
	 * (pi-subagents 0.83.0 src/runs/background/async-execution.js:1455-1471). A group's `machine`
	 * passes to its tasks (async-execution.js:1117). Undefined for a single launch.
	 */
	function flatItems(input: Record<string, any>): (Record<string, any> | undefined)[] | undefined {
		if (Array.isArray(input.tasks)) return input.tasks.map((t: unknown) => (isObject(t) ? t : undefined));
		if (!Array.isArray(input.chain)) return undefined;
		const out: (Record<string, any> | undefined)[] = [];
		for (const step of input.chain) {
			if (isObject(step) && Array.isArray(step.parallel)) {
				for (const t of step.parallel) out.push(isObject(t) ? { ...t, machine: t.machine ?? step.machine } : undefined);
			} else if (isObject(step) && isObject(step.parallel)) out.push(step.parallel);
			else out.push(isObject(step) ? step : undefined);
		}
		return out;
	}

	/**
	 * Where a launch item runs. With a `machine` its `cwd` is the directory on that machine
	 * (pi-subagents 0.83.0 src/extension/schemas.js:230, subagent-executor.js:6389-6395), so the
	 * local directory logged is the session's and `remote` names the machine.
	 */
	function placeOf(input: Record<string, any>, item?: Record<string, any>): { cwd?: string; ownCwd?: string; remote: string | null } {
		const machine = item?.machine ?? input.machine;
		if (typeof machine === "string" && machine) return { cwd: session.cwd, remote: cleanLogField(machine) };
		const own = typeof item?.cwd === "string" && item.cwd ? item.cwd : undefined;
		return { cwd: inputCwd(input, item), ownCwd: own, remote: null };
	}

	/** The launch-time record of an async or detached run, one entry per item for tasks and chains. */
	function launchRecord(input: Record<string, any>, modelParam: string | undefined, agent: unknown): LaunchRecord {
		const items = flatItems(input)?.map((item) => {
			const param = typeof item?.model === "string" && item.model ? item.model : modelParam;
			return { ...placeOf(input, item), modelParam: param, kind: classifyKind(typeof item?.agent === "string" ? item.agent : "", param, launchStrings) };
		});
		const place = placeOf(input);
		const name = typeof agent === "string" ? agent : "";
		return { modelParam, kind: classifyKind(name, modelParam, launchStrings), at: Date.now(), cwd: place.cwd, remote: place.remote, items };
	}

	function remember<V>(map: Map<string, V> | Set<string>, key: string, value?: V): void {
		if (map.size >= MAX_TRACKED) {
			const first = map.keys().next().value;
			if (first !== undefined) map.delete(first);
		}
		if (map instanceof Set) map.add(key);
		else map.set(key, value as V);
	}

	function writeLaunch(fields: {
		key: string;
		agent: unknown;
		runId?: unknown;
		modelParam?: string;
		model?: unknown;
		thinking?: unknown;
		ok: boolean;
		errorText?: unknown;
		durationMs: number | null;
		mode: "sync" | "async" | "workflow-child";
		kind?: string;
		cwd?: string;
		remote?: string | null;
	}): void {
		if (typeof fields.agent !== "string" || !fields.agent.startsWith(STEWARD_PREFIX)) return;
		if (logged.has(fields.key)) return;
		remember(logged, fields.key);
		const resolved = splitModel(fields.model, fields.thinking);
		appendDelegationLine(
			{
				v: 2,
				ts: new Date().toISOString(),
				sessionId: session.id ?? null,
				cwd: cleanNullable(fields.cwd ?? session.cwd),
				sessionCwd: cleanNullable(session.cwd),
				remote: fields.remote ?? null,
				agent: cleanLogField(fields.agent),
				runId: typeof fields.runId === "string" ? cleanLogField(fields.runId) : null,
				modelParam: fields.modelParam !== undefined ? cleanLogField(fields.modelParam) : null,
				model: resolved.model,
				thinking: resolved.thinking,
				status: fields.ok ? "ok" : "error",
				isError: !fields.ok,
				errorClass: fields.ok ? null : errorClass(fields.errorText),
				durationMs: fields.durationMs,
				mode: fields.mode,
				kind: fields.kind ?? classifyKind(fields.agent, fields.modelParam, launchStrings),
			},
			logMaxBytes,
		);
	}

	function cleanNullable(value: string | undefined): string | null {
		return typeof value === "string" ? cleanLogPath(value) : null;
	}

	function textOf(content: unknown): string | undefined {
		if (!Array.isArray(content)) return undefined;
		return content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\n");
	}

	function logLaunchResult(event: { input?: unknown; details?: unknown; isError?: boolean; content?: unknown; toolCallId?: string }): void {
		try {
			const input = (event.input && typeof event.input === "object" ? event.input : {}) as Record<string, any>;
			if (!launchesWork(input)) return;
			const details = (event.details && typeof event.details === "object" ? event.details : {}) as Record<string, any>;
			const modelParam = typeof input.model === "string" && input.model ? input.model : undefined;
			const asyncId = typeof details.asyncId === "string" ? details.asyncId : undefined;
			if (asyncId && !event.isError) {
				remember(asyncLaunches, asyncId, launchRecord(input, modelParam, input.agent));
				return;
			}
			const steps = flatItems(input);
			const rows = Array.isArray(details.results) ? details.results : [];
			if (rows.length > 0) {
				rows.forEach((row: Record<string, any>, i: number) => {
					if (!row || typeof row !== "object") return;
					const index = Number.isInteger(row.index) ? row.index : i;
					const task = steps ? steps[index] : undefined;
					const param = typeof task?.model === "string" && task.model ? task.model : modelParam;
					// Sync results carry no cwd (pi-subagents 0.83.0 SingleResult, src/shared/types.d.ts:1133).
					const { cwd, remote } = placeOf(input, task);
					// Not finished: a detached child keeps running and an interrupted one waits for
					// the next action (pi-subagents 0.83.0 src/runs/foreground/execution.js:519,1467,
					// subagent-executor.js:4042-4063); a stop without an error is the same. The real
					// outcome arrives later under the same run id, so keep the launch-time record.
					if (row.detached || row.interrupted || (row.stopped && !row.error)) {
						const runId = typeof details.runId === "string" ? details.runId : undefined;
						if (runId && !asyncLaunches.has(runId)) {
							remember(asyncLaunches, runId, launchRecord(input, modelParam, row.agent));
						}
						return;
					}
					const ok = row.exitCode === 0 && !row.error && event.isError !== true;
					writeLaunch({
						key: `${details.runId ?? event.toolCallId}:${index}`,
						agent: row.agent,
						runId: details.runId,
						modelParam: param,
						model: row.model,
						thinking: row.thinking,
						ok,
						errorText: row.error,
						durationMs: finiteMs(row.progressSummary?.durationMs, row.durationMs),
						mode: "sync",
						cwd,
						remote,
					});
				});
				return;
			}
			if (event.isError && typeof input.agent === "string") {
				// Rejected before it ran (unknown model, launch failure): no resolved model.
				const place = placeOf(input);
				writeLaunch({
					key: `rejected:${event.toolCallId ?? Date.now()}`,
					agent: input.agent,
					modelParam,
					ok: false,
					// pi-subagents' own rejection text: no child ran, so there is no child output.
					errorText: textOf(event.content),
					durationMs: null,
					mode: input.async === true ? "async" : "sync",
					cwd: place.cwd,
					remote: place.remote,
				});
			}
		} catch {
			// fail open
		}
	}

	function onAsyncStarted(data: unknown): void {
		try {
			const d = data as Record<string, any> | null;
			if (d && typeof d.id === "string" && !started.has(d.id)) remember(started, d.id, Date.now());
			// pi-subagents 0.83.0 reports the resolved run directory here (src/runs/background/
			// async-execution.js:1524,2115; workflows src/runs/foreground/subagent-executor.js:5379).
			const cwd = d ? reportedCwd(d.cwd) : undefined;
			if (d && typeof d.id === "string" && cwd && !startedCwd.has(d.id)) remember(startedCwd, d.id, cwd);
		} catch {
			// fail open
		}
	}

	function onAsyncComplete(data: unknown): void {
		try {
			const d = data as Record<string, any> | null;
			if (!d || typeof d !== "object") return;
			const id = typeof d.runId === "string" ? d.runId : typeof d.id === "string" ? d.id : undefined;
			if (!id) return;
			const now = Date.now();
			if (d.awaitedByWorkflow) {
				// A workflow child: its model arrives with the workflow's own completion.
				remember(ended, id, now);
				return;
			}
			// The completion spreads the run's result file, which records its directory as `cwd`
			// (pi-subagents 0.83.0 src/runs/background/result-watcher.js:548 over
			// src/runs/background/subagent-runner.js:4800; workflows subagent-executor.js:6014,6076).
			const runCwd = startedCwd.get(id) ?? reportedCwd(d.cwd) ?? asyncLaunches.get(id)?.cwd;
			const rows: Record<string, any>[] = Array.isArray(d.results) ? d.results.filter((r: unknown) => r && typeof r === "object") : [];
			const children = d.workflowChildren?.children;
			if (d.mode === "workflow" || Array.isArray(children)) {
				const byRun = new Map(rows.filter((r) => typeof r.runId === "string").map((r) => [r.runId, r]));
				for (const child of Array.isArray(children) ? children : []) {
					if (!child || typeof child !== "object") continue;
					const childId = typeof child.runId === "string" ? child.runId : undefined;
					const row = childId ? byRun.get(childId) : undefined;
					const ok = child.state === "completed" && row?.success !== false;
					const start = childId ? started.get(childId) : undefined;
					const end = childId ? ended.get(childId) : undefined;
					writeLaunch({
						key: `${id}:${childId ?? child.childId}`,
						agent: child.agent,
						runId: childId,
						model: child.model ?? row?.model,
						thinking: row?.thinking,
						ok,
						errorText: row?.error ?? child.error,
						durationMs: finiteMs(row?.durationMs, start !== undefined ? (end ?? now) - start : undefined),
						mode: "workflow-child",
						// Child records carry no cwd (src/workflows/scripted-workflow.d.ts:23); an async
						// child reports its own on async-started, the rest ran in the workflow's.
						cwd: (childId ? startedCwd.get(childId) : undefined) ?? runCwd,
					});
				}
				return;
			}
			const launch = asyncLaunches.get(id);
			const start = launch?.at ?? started.get(id);
			const list = rows.length > 0 ? rows : [{ agent: d.agent, success: d.success, error: d.error }];
			list.forEach((row, i) => {
				const ok = row.success !== false && d.success !== false && !row.error;
				const index = Number.isInteger(row.index) ? row.index : i;
				// The reported run directory is the top-level one only (async-execution.js:1524); an
				// item with its own cwd resolves that against it (child-launch-plan.js:70).
				const item = launch?.items?.[index];
				const remote = item ? item.remote : (launch?.remote ?? null);
				let cwd = runCwd;
				if (remote) cwd = session.cwd;
				else if (item?.ownCwd) cwd = isAbsolute(item.ownCwd) ? resolve(item.ownCwd) : runCwd ? resolve(runCwd, item.ownCwd) : item.cwd;
				writeLaunch({
					key: `${id}:${index}`,
					agent: row.agent ?? d.agent,
					runId: id,
					modelParam: item ? item.modelParam : launch?.modelParam,
					kind: item ? item.kind : launch?.kind,
					model: row.model,
					thinking: row.thinking,
					ok,
					errorText: row.error ?? d.error,
					durationMs: finiteMs(row.durationMs, d.durationMs, start !== undefined ? now - start : undefined),
					mode: "async",
					cwd,
					remote,
				});
			});
		} catch {
			// fail open
		}
	}

	try {
		const events = (pi as Partial<ExtensionAPI>).events as { on?: (channel: string, fn: (data: unknown) => void) => unknown } | undefined;
		if (events && typeof events.on === "function") {
			events.on(ASYNC_STARTED_EVENT, onAsyncStarted);
			events.on(ASYNC_COMPLETE_EVENT, onAsyncComplete);
		}
	} catch {
		// no event bus: sync launches are still logged
	}

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (!GATED_TOOLS.has(event.toolName)) return undefined;
			const { output } = await runHook("gate", {
				session_id: sessionId(ctx),
				tool_name: event.toolName,
				tool_input: event.input,
				cwd: ctx.cwd,
			});
			const decision = output?.hookSpecificOutput;
			if (decision?.permissionDecision === "deny") {
				const reason = String(decision.permissionDecisionReason ?? "steward gate");
				// Without a delegation tool the model cannot delegate, so a delegation-gate denial
				// could never be cleared. Downgrade it to a reminder. A PR body is blocked by the
				// steward-prose-gate extension, not here.
				if (reason.startsWith(DELEGATION_GATE_PREFIX) && !canDelegateNow()) {
					softNotes.set(event.toolCallId, `${reason}\n\n${cannotDelegateNote()}`);
					return undefined;
				}
				return { block: true, reason };
			}
			if (typeof decision?.additionalContext === "string") {
				// Soft mode: let the call run and attach the reminder to its result.
				const note = canDelegateNow()
					? decision.additionalContext
					: `${decision.additionalContext}\n\n${cannotDelegateNote()}`;
				softNotes.set(event.toolCallId, note);
			}
		} catch {
			// fail open: pi blocks a tool when its handler throws
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.toolName === SUBAGENT_TOOL) {
				noteSession(ctx);
				logLaunchResult(event);
				// Only a launch that pi-subagents accepted counts as a delegation.
				if (!event.isError && launchesWork(event.input)) {
					await runHook("delegated", { session_id: sessionId(ctx) });
				}
				return undefined;
			}
			const note = softNotes.get(event.toolCallId);
			if (note === undefined || !Array.isArray(event.content)) return undefined;
			softNotes.delete(event.toolCallId);
			return {
				content: [...event.content, { type: "text" as const, text: note }],
				structuredContent: event.structuredContent,
			};
		} catch {
			return undefined;
		}
	});

	pi.on("agent_settled", async () => {
		edictInPrompt = false;
		// Notes for calls that never produced a result (blocked by another extension, aborted).
		softNotes.clear();
	});

	let piTui: PiTui | undefined;
	loadPiTui().then(
		(mod) => {
			piTui = mod;
		},
		() => {},
	);

	/**
	 * Shows a /steward-models result. A custom entry is display-only: pi stores it in the session
	 * but never sends it to the model (sendMessage would add a model-visible message), and pi
	 * emits it as an `entry_appended` event, which JSON and RPC mode stream on stdout. Per mode:
	 * tui draws the entry; rpc also notifies, which the RPC extension UI protocol forwards;
	 * print has no UI and prints only assistant text, so the text goes to stdout; json leaves
	 * stdout to pi's JSONL. A host without `ctx.mode` gets the entry plus a notice when it has
	 * no UI.
	 */
	function show(ctx: ExtensionContext, text: string): void {
		const append = (pi as Partial<ExtensionAPI>).appendEntry;
		if (typeof append === "function") append.call(pi, MODELS_ENTRY_TYPE, { text });
		const mode = (ctx as { mode?: string }).mode;
		if (mode === "print") writeStdout(text.endsWith("\n") ? text : `${text}\n`);
		else if (mode === "rpc" || !ctx.hasUI || typeof append !== "function") ctx.ui.notify(text, "info");
	}

	function registerModelsRenderer(): void {
		const registerRenderer = (pi as Partial<ExtensionAPI>).registerEntryRenderer;
		if (typeof registerRenderer !== "function") return;
		registerRenderer.call(pi, MODELS_ENTRY_TYPE, (entry: { data?: unknown }) => {
			const data = entry?.data as { text?: unknown } | undefined;
			const text = typeof data?.text === "string" ? data.text : "";
			if (!text) return undefined;
			const Text = piTui?.Text;
			if (typeof Text === "function") return new Text(text, 1, 0);
			return { render: (width: number) => wrapLines(text, width), invalidate: () => {} };
		});
	}

	/** `stats`: the hook's summarizer reads the outcome log; this only shows its text. */
	async function statsReport(days: number): Promise<string> {
		const { output, missingPython } = await runHook(STATS_SUBCOMMAND, { days, path: delegationLogPath() }, hookTimeoutMs);
		if (missingPython) return "steward: /steward-models stats failed: python3 was not found.";
		if (typeof output?.report === "string" && output.report) return output.report;
		const reason = typeof output?.error === "string" && output.error ? output.error.slice(0, 200) : "the hook gave no report";
		return `steward: /steward-models stats failed: ${reason}`;
	}

	async function checkReport(ctx: ExtensionContext): Promise<string> {
		const facts = await modelFacts(ctx);
		if (!facts) return "steward: /steward-models check could not read pi's model registry, so no check ran.";
		const { output, missingPython } = await runHook(MODELS_PLAN_SUBCOMMAND, { model_facts: facts, cwd: facts.cwd }, hookTimeoutMs);
		if (missingPython) return "steward: /steward-models check failed: python3 was not found.";
		if (typeof output?.report === "string" && output.report) return output.report;
		const reason = typeof output?.error === "string" && output.error ? output.error.slice(0, 200) : "the hook gave no report";
		return `steward: /steward-models check failed: ${reason}`;
	}

	/** After `apply` reloaded pi: the fresh check, shown by the new instance with the new ctx. */
	async function showPendingCheck(ctx: ExtensionContext): Promise<void> {
		const store = globalThis as Record<symbol, unknown>;
		const pending = store[PENDING_CHECK_KEY] as { at?: number } | undefined;
		if (!pending) return;
		delete store[PENDING_CHECK_KEY];
		if (typeof pending.at !== "number" || Date.now() - pending.at > PENDING_CHECK_MAX_AGE_MS) return;
		try {
			show(ctx, `steward: pi reloaded after /steward-models apply. Fresh check:\n\n${await checkReport(ctx)}`);
		} catch {
			// display only
		}
	}

	function applyFailed(output: HookOutput, missingPython: boolean | undefined): string {
		if (missingPython) return "steward: /steward-models apply failed: python3 was not found; nothing was written.";
		const reason = typeof output?.error === "string" && output.error ? output.error.slice(0, 300) : "the hook gave no result";
		return `steward: /steward-models apply failed: ${reason}`;
	}

	/**
	 * `apply`: a dry run first, shown in full; then confirmation through pi's UI (or `--yes`
	 * when there is no UI); then the writing call, which refuses when either file changed since
	 * the dry run; then ctx.reload(). All decisions and every write are in the hook.
	 */
	async function applyPlan(ctx: ExtensionCommandContext, yes: boolean): Promise<void> {
		const facts = await modelFacts(ctx);
		if (!facts) {
			show(ctx, "steward: /steward-models apply could not read pi's model registry, so nothing was written.");
			return;
		}
		const preview = await runHook(MODELS_APPLY_SUBCOMMAND, { model_facts: facts, dryRun: true }, hookTimeoutMs);
		const draft = preview.output;
		if (typeof draft?.report !== "string" || draft.error || typeof draft.hashes !== "object") {
			show(ctx, applyFailed(draft, preview.missingPython));
			return;
		}
		if (!draft.changed) {
			show(ctx, draft.report);
			return;
		}
		if (!yes) {
			if (!ctx.hasUI) {
				show(ctx, `${draft.report}\n\nNothing was written. Run /steward-models apply --yes to write these changes.`);
				return;
			}
			const ok = await ctx.ui.confirm("Apply the steward model plan?", draft.report);
			if (!ok) {
				show(ctx, "steward: /steward-models apply cancelled; nothing was written.");
				return;
			}
		}
		const done = await runHook(
			MODELS_APPLY_SUBCOMMAND,
			{ model_facts: facts, dryRun: false, expect: draft.hashes },
			Math.max(hookTimeoutMs, APPLY_WRITE_TIMEOUT_MS),
		);
		const result = done.output;
		if (typeof result?.report !== "string" || result.error) {
			show(ctx, applyFailed(result, done.missingPython));
			return;
		}
		show(ctx, result.report);
		if (typeof ctx.reload !== "function") {
			show(ctx, "steward: run /reload so pi-subagents reads the new settings, then /steward-models check.");
			return;
		}
		const store = globalThis as Record<symbol, unknown>;
		store[PENDING_CHECK_KEY] = { at: Date.now() };
		try {
			await ctx.reload();
		} catch {
			delete store[PENDING_CHECK_KEY];
			show(ctx, "steward: the settings were written, but pi did not reload; run /reload.");
		}
	}

	// A host without commands (or a registration error) leaves the edict and gates as they are.
	try {
		registerModelsRenderer();
	} catch {
		// no renderer: the entry is stored but not drawn
	}
	try {
		registerModelsCommand();
	} catch {
		// no command
	}

	function registerModelsCommand(): void {
		if (typeof pi.registerCommand !== "function") return;
		pi.registerCommand(MODELS_COMMAND, {
			description: "Check the steward model plan (check), write it into pi-subagents user settings (apply), or summarize steward launches (stats)",
			getArgumentCompletions: (prefix: string) =>
				["check", "apply", "apply --yes", "stats", "stats --days"].filter((sub) => sub.startsWith(prefix.trim())).map((sub) => ({ value: sub, label: sub })),
			handler: async (args, ctx) => {
				try {
					const [sub = "check", ...flags] = (args ?? "").trim().split(/\s+/).filter(Boolean);
					const yes = flags.length === 1 && (flags[0] === "--yes" || flags[0] === "-y");
					const days = flags.length === 0 ? 7 : flags.length === 2 && flags[0] === "--days" && /^\d{1,4}$/.test(flags[1]) ? Number(flags[1]) : 0;
					if (sub === "check" && flags.length === 0) show(ctx, await checkReport(ctx));
					else if (sub === "apply" && (flags.length === 0 || yes)) await applyPlan(ctx, yes);
					else if (sub === "stats" && days >= 1) show(ctx, await statsReport(days));
					else show(ctx, MODELS_USAGE);
				} catch {
					try {
						show(ctx, "steward: /steward-models failed with an internal error.");
					} catch {
						// never crash the command
					}
				}
			},
		});
	}
}
