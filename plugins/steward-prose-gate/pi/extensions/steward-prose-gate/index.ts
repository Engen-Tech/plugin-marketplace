/**
 * steward-prose-gate for pi: runs the PR-body gate and the prose gate.
 *
 * Every decision is made by hooks/prose_gate_hook.py in this plugin, called as
 * `prose_gate_hook.py pi pr-gate|prose-gate`. This file only translates pi events into that
 * script's JSON payloads and maps its answers back onto pi's event results. It fails open: if
 * python3 cannot start (one notice) or the script errors, the tool call or reply goes through.
 *
 * The interpreter is $STEWARD_PROSE_GATE_PYTHON, else python3.
 *
 * pi-subagents' background runner sets PI_SUBAGENT_CHILD=1, so this file registers nothing in a
 * child: the gates apply to the main thread only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const HOOK_SCRIPT = resolve(PLUGIN_ROOT, "hooks", "prose_gate_hook.py");
/** Kill time for one hook call. */
export const HOOK_TIMEOUT_MS = 15_000;

const PROSE_GATE_MESSAGE_TYPE = "steward-prose-gate";

type HookOutput = Record<string, any> | undefined;

interface HookResult {
	output: HookOutput;
	/** Set when the python interpreter itself could not be started. */
	missingPython?: boolean;
}

export function runHook(
	mode: string,
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
		let child;
		try {
			child = spawn(process.env.STEWARD_PROSE_GATE_PYTHON || "python3", [HOOK_SCRIPT, "pi", mode], {
				env: { ...process.env },
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			finish({ output: undefined, missingPython: true });
			return;
		}
		const chunks: Buffer[] = [];
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ output: undefined });
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		child.on("error", (err: NodeJS.ErrnoException) => {
			clearTimeout(timer);
			finish({ output: undefined, missingPython: err.code === "ENOENT" });
		});
		child.on("close", () => {
			clearTimeout(timer);
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) return finish({ output: undefined });
			try {
				const parsed = JSON.parse(text);
				finish({ output: parsed && typeof parsed === "object" ? parsed : undefined });
			} catch {
				finish({ output: undefined });
			}
		});
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
	});
}

/** Text of the most recent assistant message, or undefined when it has none. */
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; content?: unknown };
		if (message?.role !== "assistant") continue;
		const { content } = message;
		if (typeof content === "string") return content.trim() ? content : undefined;
		if (!Array.isArray(content)) return undefined;
		const text = content
			.filter((part) => part && part.type === "text" && typeof part.text === "string")
			.map((part) => part.text as string)
			.join("");
		return text.trim() ? text : undefined;
	}
	return undefined;
}

/**
 * True when the latest reply answers a prose-gate message, so it is already the one revision the
 * gate allows. Walks back from the end: the gate's own message means yes; a user message or any
 * other custom message (a new prompt, a background-completion notice) means no.
 */
export function isProseRevision(messages: readonly unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; customType?: string };
		if (message?.role === "user") return false;
		if (message?.role === "custom") return message.customType === PROSE_GATE_MESSAGE_TYPE;
	}
	return false;
}

export default function proseGate(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	let warnedMissingPython = false;

	async function gate(mode: string, payload: Record<string, unknown>, ctx: ExtensionContext): Promise<HookOutput> {
		const { output, missingPython } = await runHook(mode, payload);
		if (missingPython && ctx.hasUI && !warnedMissingPython) {
			warnedMissingPython = true;
			ctx.ui.notify("steward-prose-gate: python3 was not found, so the prose and PR gates are off.", "warning");
		}
		return output;
	}

	pi.on("tool_call", async (event, ctx) => {
		try {
			if (event.toolName !== "bash") return undefined;
			const output = await gate("pr-gate", { tool_name: event.toolName, tool_input: event.input, cwd: ctx.cwd }, ctx);
			const decision = output?.hookSpecificOutput;
			if (decision?.permissionDecision === "deny") {
				return { block: true, reason: String(decision.permissionDecisionReason ?? "steward PR gate") };
			}
		} catch {
			// fail open: pi blocks a tool when its handler throws
		}
		return undefined;
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		try {
			// No canContinue check: it describes the context before this handler's entries, and a
			// finished reply always ends on the assistant turn. The custom message added below is what
			// makes the next request runnable.
			if (event.outcome !== "completed") return undefined;
			const messages = event.context.contextMessages;
			const text = lastAssistantText(messages);
			if (!text) return undefined;
			const output = await gate(
				"prose-gate",
				{
					last_assistant_message: text,
					// One revision per reply, like Claude Code's stop_hook_active.
					stop_hook_active: isProseRevision(messages),
				},
				ctx,
			);
			if (output?.decision !== "block" || typeof output.reason !== "string") return undefined;
			return {
				entries: [
					...event.entries,
					{ type: "custom_message" as const, customType: PROSE_GATE_MESSAGE_TYPE, content: output.reason, display: true },
				],
				continue: true,
			};
		} catch {
			return undefined;
		}
	});
}
