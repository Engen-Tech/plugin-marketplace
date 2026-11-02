// What a Pi child's last turn looked like, read from the session's own messages.
//
// A gate child that returns no verdict has a reason, and Pi holds it: the last
// assistant message carries a stop reason, a provider error text, usage, and the
// kinds of content it produced. Reading only the assistant text loses all of it,
// which is how a quota error used to surface as an empty, unnamed malformed verdict.
//
// The reader is structural: it copies a field only when it has the expected
// primitive type, so a Pi release that drops a field drops it from the record
// instead of throwing. It imports nothing from pi-ai or pi-agent-core, and no value
// from the rest of the Pi runtime, so any runner can use it.

import type { ChildRuntimeReport } from "./child-runtime.ts";

const MAX_ERROR_TEXT = 500;

export type ProviderErrorKind = "quota" | "rate-limit" | "other";
type ContentKind = "text" | "thinking" | "toolCall";

export interface ChildLastTurn {
  prompts: number; // prompts the host sent this child: 1, or 2 with the corrective turn
  assistantMessages: number; // assistant entries in session.messages
  toolCalls?: number; // getSessionStats().toolCalls
  sessionTokens?: number; // getSessionStats().tokens.total
  providerRetries: number; // auto_retry_start events Pi emitted in this child
  stopReason?: string; // last assistant entry; absent when there is none
  rawStopReason?: string; // the provider's own value, when Pi kept it
  errorMessage?: string; // at most 500 characters
  providerError?: ProviderErrorKind; // only with stopReason "error"
  textChars: number; // text content length of the last assistant entry
  contentKinds: ContentKind[]; // in order, deduplicated
  endedOnToolCall: boolean; // stopReason "toolUse" or a toolCall item in the last entry
  usage?: { input: number; output: number; reasoning?: number; cacheRead: number; totalTokens: number };
  durationMs?: number; // the last response's own duration, from Pi
  responseModel?: string;
}

// Quota exhaustion: an account or subscription limit that resets in hours, not
// seconds. A copy of Pi's own non-retryable list (pi-ai/dist/utils/retry.js,
// NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN, Pi 1.4.0) plus OpenAI's own sentence.
// It is a duplicate because pi-ai is not a hatch dependency. Drift only lowers the
// name from quota to other; the routing (no retry, blocked) does not depend on it.
// Checked first, because an OpenAI quota error is also a 429.
const QUOTA_PATTERN = new RegExp(
  [
    "insufficient_quota",
    "exceeded your current quota",
    "quota exceeded",
    "out of budget",
    "billing",
    "usage limit",
    "available balance",
    "GoUsageLimitError",
    "FreeUsageLimitError",
    "subscription_sharing_usage_limit_exceeded",
    "subscription_sharing_workplace_individual_usage_limit_exceeded",
  ].join("|"),
  "i",
);

const RATE_LIMIT_PATTERN = new RegExp(
  [
    "rate.?limit",
    "too many requests",
    // A bare status code, never part of a longer word or number such as a request id.
    "(?<![a-z0-9])429(?![a-z0-9])",
    "ResourceExhausted",
    "overloaded",
  ].join("|"),
  "i",
);

export function classifyProviderError(text: string): ProviderErrorKind {
  if (QUOTA_PATTERN.test(text)) return "quota";
  if (RATE_LIMIT_PATTERN.test(text)) return "rate-limit";
  return "other";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lastAssistant(messages: readonly unknown[]): Record<string, unknown> | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = record(messages[index]);
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

// True when the child's last assistant entry ended in a provider error or an abort,
// so a corrective turn would meet the same wall.
export function lastTurnEndedInError(messages: readonly unknown[]): boolean {
  const stop = lastAssistant(messages)?.stopReason;
  return stop === "error" || stop === "aborted";
}

function readUsage(value: unknown): ChildLastTurn["usage"] {
  const usage = record(value);
  if (!usage) return undefined;
  const input = finite(usage.input);
  const output = finite(usage.output);
  const cacheRead = finite(usage.cacheRead);
  const totalTokens = finite(usage.totalTokens);
  if (input === undefined || output === undefined || cacheRead === undefined || totalTokens === undefined) {
    return undefined;
  }
  const reasoning = finite(usage.reasoning);
  return { input, output, ...(reasoning !== undefined ? { reasoning } : {}), cacheRead, totalTokens };
}

export function readLastTurn(input: {
  messages: readonly unknown[];
  prompts: number;
  providerRetries: number;
  stats?: { toolCalls: number; tokens: { total: number } };
}): ChildLastTurn {
  const assistantMessages = input.messages.filter((message) => record(message)?.role === "assistant").length;
  const toolCalls = finite(input.stats?.toolCalls);
  const sessionTokens = finite(input.stats?.tokens?.total);
  const base = {
    prompts: input.prompts,
    assistantMessages,
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(sessionTokens !== undefined ? { sessionTokens } : {}),
    providerRetries: input.providerRetries,
  };
  const last = lastAssistant(input.messages);
  if (!last) return { ...base, textChars: 0, contentKinds: [], endedOnToolCall: false };

  const stopReason = typeof last.stopReason === "string" ? last.stopReason : undefined;
  const rawStopReason = typeof last.rawStopReason === "string" ? last.rawStopReason : undefined;
  const fullError = typeof last.errorMessage === "string" ? last.errorMessage : undefined;
  const content = Array.isArray(last.content) ? last.content.map(record) : [];
  const kinds: ContentKind[] = [];
  let textChars = 0;
  let lastKind: ContentKind | undefined;
  for (const item of content) {
    const type = item?.type;
    if (type !== "text" && type !== "thinking" && type !== "toolCall") continue;
    if (!kinds.includes(type)) kinds.push(type);
    lastKind = type;
    if (type === "text" && typeof item?.text === "string") textChars += item.text.trim().length;
  }
  const usage = readUsage(last.usage);
  const durationMs = finite(last.durationMs);
  const responseModel = typeof last.responseModel === "string" ? last.responseModel : undefined;
  return {
    ...base,
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(rawStopReason !== undefined ? { rawStopReason } : {}),
    ...(fullError !== undefined ? { errorMessage: fullError.slice(0, MAX_ERROR_TEXT) } : {}),
    ...(stopReason === "error" ? { providerError: classifyProviderError(fullError ?? "") } : {}),
    textChars,
    contentKinds: kinds,
    endedOnToolCall: stopReason === "toolUse" || lastKind === "toolCall",
    ...(usage ? { usage } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(responseModel !== undefined ? { responseModel } : {}),
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// One plain line, for a finding message or a preflight error.
export function describeLastTurn(turn: ChildLastTurn): string {
  const head = turn.stopReason
    ? `stop reason ${turn.stopReason} after ${plural(turn.prompts, "prompt")}`
    : `no assistant message after ${plural(turn.prompts, "prompt")}`;
  const text = turn.textChars === 0 ? "no text" : `${turn.textChars} characters of text`;
  const output = `${turn.usage?.output ?? 0} output tokens`;
  const tool = turn.endedOnToolCall ? "ended on a tool call" : "did not end on a tool call";
  const retries = `Pi retried the provider ${plural(turn.providerRetries, "time")}`;
  return `${head}, ${text}, ${output}, ${tool}, ${retries}`;
}

// The provider answered a gate's preflight probe with an error instead of the probe
// reply. A distinct class so the gate runner can turn exactly this cause into a
// named blocked verdict, while every other preflight failure still throws.
export class GateProviderUnavailableError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly runtime: ChildRuntimeReport;
  readonly lastTurn: ChildLastTurn;

  constructor(runtime: ChildRuntimeReport, lastTurn: ChildLastTurn) {
    const cause = lastTurn.providerError === "quota" ? "a quota error" : "a provider error";
    super(
      `Hatch gate provider preflight for '${runtime.provider}/${runtime.model}' failed: the provider returned ${cause}: ${
        lastTurn.errorMessage ?? "no error text"
      }`,
    );
    this.name = "GateProviderUnavailableError";
    this.provider = runtime.provider;
    this.model = runtime.model;
    this.runtime = runtime;
    this.lastTurn = lastTurn;
  }
}
