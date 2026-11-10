import type { Parsed } from "./child-outcome.ts";

export interface EnvelopePrompter {
  prompt(message: string): Promise<unknown>;
  getLastAssistantText(): string | undefined;
}

// Strict JSON: the text must be exactly one JSON value. The defect is the parser's own.
export function readJson(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

// Locate the JSON envelope in a child agent's final message: try the trimmed text,
// then a stripped Markdown code fence, then the outermost brace-delimited object.
// On failure the defect names the child role and a bounded snippet of what it
// actually said, so a malformed result is diagnosable rather than blind.
export function readJsonEnvelope(text: string, label: string): Parsed<unknown> {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) candidates.push(fence[1].trim());
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = readJson(candidate);
    if (parsed.ok) return parsed;
    // fall through to the next candidate
  }
  const snippet = trimmed.slice(0, 200).replace(/\s+/g, " ");
  return {
    ok: false,
    problem: `Hatch ${label} returned malformed JSON (last assistant text: ${
      snippet ? `"${snippet}"` : "<empty>"
    })`,
  };
}

// The throwing form of readJsonEnvelope, for a caller whose own contract is to throw.
export function parseJsonEnvelope(text: string, label: string): unknown {
  const parsed = readJsonEnvelope(text, label);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.value;
}

// A child agent that has finished its work sometimes ends on a prose summary
// instead of the required JSON envelope. One corrective turn recovers the work
// rather than discarding it; a second failure falls through to the caller's
// strict parse, which reports a diagnostic snippet.
//
// `isValid` must be as strict as that later parse. A predicate that accepts what
// the parse will reject spends the corrective turn on nothing and then discards
// the work anyway. `repairPrompt` may be a function so the turn can name the
// specific violation instead of restating the format in general.
//
// `canRepair` lets a caller skip that turn when it knows the first one cannot be
// repaired, such as a turn that already ended in a provider error: the repair would
// meet the same quota and spend one more failed call. It gets the reply's text.
export async function promptForJsonEnvelope(
  session: EnvelopePrompter,
  userPrompt: string,
  isValid: (text: string) => boolean,
  repairPrompt: string | ((text: string) => string),
  canRepair?: (text: string) => boolean,
): Promise<string> {
  await session.prompt(userPrompt);
  let text = session.getLastAssistantText() ?? "";
  if (!isValid(text) && (canRepair?.(text) ?? true)) {
    await session.prompt(typeof repairPrompt === "function" ? repairPrompt(text) : repairPrompt);
    text = session.getLastAssistantText() ?? text;
  }
  return text;
}
