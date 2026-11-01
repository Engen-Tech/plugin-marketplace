import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentSettledEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  runHatchGuard,
  type GuardResult,
  type GuardRunOptions,
  type HatchGuard,
} from "./guard-runner.ts";

export type GuardExecutor = (
  guard: HatchGuard,
  payload: unknown,
  options: GuardRunOptions,
) => Promise<GuardResult>;

// pi-subagents marks the async runner process that hosts child sessions, and descendants inherit it.
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";

export function isSubagentChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SUBAGENT_CHILD_ENV] === "1";
}

const GUARD_LABELS: Record<HatchGuard, string> = {
  binderImmutability: "committed-binder guard",
  packWrite: "stack-pack guard",
  deliveryStop: "dirty-delivery check",
  subagentWhiff: "whiffed-item check",
  statusInjection: "status context",
};

const BINDER_PATH = /(?:^|\/)\.hatch\/binders\/(?:archive\/)?[^/]+\.json$/;
const PACK_PATH = /(?:^|\/)\.hatch\/sme\/.+\.md$/;

function hookToolInput(event: ToolCallEvent | ToolResultEvent): Record<string, unknown> | undefined {
  const input = event.input as Record<string, unknown>;
  if (event.toolName === "write") {
    return { file_path: input.path, content: input.content };
  }
  if (event.toolName === "edit") {
    return { file_path: input.path, edits: input.edits };
  }
  return undefined;
}

function decisionReason(result: GuardResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

interface GuardToolResult {
  content?: ToolResultEvent["content"];
  isError?: boolean;
}

function appendFinding(event: ToolResultEvent, reason: string): GuardToolResult {
  return {
    content: [...event.content, { type: "text", text: `\n${reason}` }],
    isError: true,
  };
}

function piDirtyDeliveryMessage(reason: string): string {
  return reason
    .replace("this session is stopping", "this Pi turn settled")
    .replace(
      "This stop is blocked once per state — an identical stop will pass, so fix it now or stop again to defer to the resume flow.",
      "Pi queued this corrective turn once for the exact Git state. Fix it now or end the session again to defer to the Git-native resume flow.",
    );
}

export class HatchGuardAdapter {
  readonly extension: ExtensionAPI;
  readonly executeGuard: GuardExecutor;
  readonly isChildSession: () => boolean;
  #stopped = false;
  #settledCheckRunning = false;
  #lastWhiff?: string;
  readonly #reportedFailures = new Set<string>();
  readonly #shutdownController = new AbortController();

  constructor(
    extension: ExtensionAPI,
    executeGuard: GuardExecutor = runHatchGuard,
    isChildSession: () => boolean = () => isSubagentChildProcess(),
  ) {
    this.extension = extension;
    this.executeGuard = executeGuard;
    this.isChildSession = isChildSession;
  }

  // A guard that could not run still lets the action through, but the operator hears it once
  // per cause per session instead of the failure passing silently.
  #reportFailure(guard: HatchGuard, result: GuardResult, ctx: ExtensionContext): void {
    const failure = result.failure;
    if (!result.failedOpen || !failure || failure.kind === "aborted") return;
    // Every guard shares the launcher, so one spawn message covers them all.
    const key = failure.kind === "spawn" ? `spawn:${failure.detail}` : `${guard}:${failure.kind}`;
    if (this.#reportedFailures.has(key)) return;
    this.#reportedFailures.add(key);
    const message =
      failure.kind === "spawn"
        ? `hatch: Hatch guards could not start: ${failure.detail}. Every Hatch guard is letting actions through without checking them.` +
          (failure.detail === "uv was not found on PATH"
            ? " Install uv or put it on PATH, then restart Pi."
            : "")
        : `hatch: the ${GUARD_LABELS[guard]} did not run (${failure.detail}). Hatch skipped it rather than block your work, so nothing was checked this time.`;
    try {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else process.stderr.write(`${message}\n`);
    } catch {
      // Reporting a failure must never be the thing that breaks the action.
    }
  }

  async #runGuard(
    guard: HatchGuard,
    payload: unknown,
    options: GuardRunOptions,
    ctx: ExtensionContext,
  ): Promise<GuardResult> {
    let result: GuardResult;
    try {
      result = await this.executeGuard(guard, payload, options);
    } catch (error) {
      result = {
        code: 0,
        stdout: "",
        stderr: "",
        failedOpen: true,
        failure: {
          kind: "error",
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
    this.#reportFailure(guard, result, ctx);
    return result;
  }

  async beforeToolCall(
    event: ToolCallEvent,
    ctx: ExtensionContext,
  ): Promise<ToolCallEventResult | undefined> {
    if (event.toolName.startsWith("hatch_") && !ctx.isProjectTrusted()) {
      return { block: true, reason: "Hatch actions are disabled in untrusted projects" };
    }
    const toolInput = hookToolInput(event);
    if (!toolInput) return undefined;
    const target = String(toolInput.file_path ?? "").replaceAll("\\", "/");
    const guardsBinder = BINDER_PATH.test(target);
    const guardsPack = PACK_PATH.test(target);
    if (!guardsBinder && !guardsPack) return undefined;
    const payload = {
      hook_event_name: "PreToolUse",
      tool_name: event.toolName === "write" ? "Write" : "Edit",
      tool_input: toolInput,
      cwd: ctx.cwd,
    };
    if (guardsBinder) {
      const immutable = await this.#runGuard(
        "binderImmutability",
        payload,
        { cwd: ctx.cwd, signal: ctx.signal },
        ctx,
      );
      if (immutable.code === 2) {
        return {
          block: true,
          reason: decisionReason(immutable, "Hatch denied a committed-binder mutation"),
        };
      }
    }
    if (guardsPack && event.toolName === "write") {
      const pack = await this.#runGuard(
        "packWrite",
        payload,
        { cwd: ctx.cwd, signal: ctx.signal },
        ctx,
      );
      if (pack.code === 2) {
        return { block: true, reason: decisionReason(pack, "Hatch denied an invalid stack pack") };
      }
    }
    return undefined;
  }

  async afterToolResult(
    event: ToolResultEvent,
    ctx: ExtensionContext,
  ): Promise<GuardToolResult | undefined> {
    if (event.isError) return undefined;
    const toolInput = hookToolInput(event);
    if (!toolInput) return undefined;
    const target = String(toolInput.file_path ?? "").replaceAll("\\", "/");
    if (!PACK_PATH.test(target)) return undefined;
    const result = await this.#runGuard(
      "packWrite",
      {
        hook_event_name: "PostToolUse",
        tool_name: event.toolName === "write" ? "Write" : "Edit",
        tool_input: toolInput,
        cwd: ctx.cwd,
      },
      { cwd: ctx.cwd, signal: ctx.signal },
      ctx,
    );
    if (result.code !== 2) return undefined;
    return appendFinding(event, decisionReason(result, "Hatch found an invalid stack pack"));
  }

  async beforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): Promise<{ systemPrompt: string } | undefined> {
    if (!ctx.isProjectTrusted() || !existsSync(join(ctx.cwd, ".hatch", "binders"))) {
      return undefined;
    }
    const result = await this.#runGuard(
      "statusInjection",
      { hook_event_name: "SessionStart", cwd: ctx.cwd },
      { cwd: ctx.cwd, signal: ctx.signal },
      ctx,
    );
    const status = result.code === 0 && !result.failedOpen ? result.stdout.trim() : "";
    if (!status) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${status}` };
  }

  async agentSettled(
    _event: AgentSettledEvent,
    ctx: ExtensionContext,
  ): Promise<void> {
    if (
      this.#stopped ||
      this.#settledCheckRunning ||
      // A child session owns no delivery, and pi-subagents marks children with PI_SUBAGENT_CHILD=1.
      this.isChildSession() ||
      !ctx.isProjectTrusted() ||
      !existsSync(join(ctx.cwd, ".hatch", "binders"))
    ) {
      return;
    }
    this.#settledCheckRunning = true;
    try {
      const whiff = await this.#runGuard(
        "subagentWhiff",
        {
          hook_event_name: "SubagentStop",
          agent_type: "hatch-pi",
          cwd: ctx.cwd,
          stop_hook_active: false,
        },
        { cwd: ctx.cwd, signal: this.#shutdownController.signal },
        ctx,
      );
      const whiffReason = whiff.code === 2 ? decisionReason(whiff, "Hatch found a whiffed item") : "";
      const corrections: string[] = [];
      if (whiffReason && whiffReason !== this.#lastWhiff) corrections.push(whiffReason);
      this.#lastWhiff = whiffReason || undefined;

      const dirty = await this.#runGuard(
        "deliveryStop",
        {
          hook_event_name: "Stop",
          session_id: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          stop_hook_active: false,
        },
        { cwd: ctx.cwd, signal: this.#shutdownController.signal },
        ctx,
      );
      if (dirty.code === 2) {
        corrections.push(
          piDirtyDeliveryMessage(
            decisionReason(dirty, "Hatch found a dirty delivery after the turn settled"),
          ),
        );
      }
      if (corrections.length > 0 && !this.#stopped) {
        this.extension.sendUserMessage(corrections.join("\n\n"), { deliverAs: "followUp" });
      }
    } catch {
      return;
    } finally {
      this.#settledCheckRunning = false;
    }
  }

  shutdown(): void {
    this.#stopped = true;
    this.#shutdownController.abort();
  }
}

export function registerGuardAdapters(extension: ExtensionAPI): HatchGuardAdapter {
  const adapter = new HatchGuardAdapter(extension);
  extension.on("tool_call", (event, ctx) => adapter.beforeToolCall(event, ctx));
  extension.on("tool_result", (event, ctx) => adapter.afterToolResult(event, ctx));
  extension.on("before_agent_start", (event, ctx) => adapter.beforeAgentStart(event, ctx));
  extension.on("agent_settled", (event, ctx) => adapter.agentSettled(event, ctx));
  return adapter;
}
