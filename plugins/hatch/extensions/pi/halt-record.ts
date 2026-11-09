import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { requirePackagePath } from "./package-paths.ts";
import { hostGitArgs } from "./worker-attestation.ts";

// The halt record: a JSON blob at refs/hatch/<slug>/item-<id>/halt saying why an item
// stopped. Twin of the parser and view in skills/hatch-status/scripts/hatch_next.py.
// skills/hatch-status/references/halt-record.json holds the rules and the words as data
// for both, and the rows of item-states.json hold the two equal. The bytes are untrusted,
// so reading never throws and a reason never echoes the record. The record changes the
// words a reader sees, never an item's state, the options offered, or any count.

const exec = promisify(execFile);
const RULES_PATH = "skills/hatch-status/references/halt-record.json";
const PROMPT_FINDINGS = 8;
const DISCLOSED_ITEMS = 5;
// A halt prompt shares HALT_REASON_LIMIT (delivery-runner.ts) with the attempt list.
const REASON_LIMIT = 600;

export interface HaltFinding {
  severity: string;
  code: string;
  path: string | null;
  line: number | null;
}

export interface HaltFields {
  item_spec_sha256: string;
  halt_kind: string;
  gate: string | null;
  phase: string;
  attempt: number | null;
  findings: HaltFinding[];
  next_step: string;
  required_check_id: string | null;
  item_tip: string | null;
  integration_tip: string | null;
  recorded_at: string;
  hatch_version: string;
}

export interface HaltRules {
  schema_version: number;
  max_bytes: number;
  max_findings: number;
  max_depth: number;
  patterns: Record<string, string>;
  severities: string[];
  gates: Record<string, string>;
  phases: Record<string, string>;
  kinds: Record<string, string>;
  next_steps: Record<string, string>;
  history: Record<string, string>;
  reasons: Record<string, string>;
  compiled: Record<string, RegExp>;
}

export type LoadedHaltRules = HaltRules | { broken: string };

export type ParsedHalt =
  | { status: "valid"; fields: HaltFields }
  | { status: "unsupported"; schema: number }
  | { status: "unreadable"; why: string; error?: string };

export interface HaltView {
  status: "current" | "history" | "unreadable" | "unsupported";
  why: string | null;
  labelKey: "halt" | "halt_history" | "halt_unread";
  lines: string[];
  error?: string;
  record?: HaltFields;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function own(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

function whole(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

export async function loadHaltRules(path?: string): Promise<LoadedHaltRules> {
  try {
    const rules = JSON.parse(await readFile(path ?? requirePackagePath(RULES_PATH), "utf8")) as HaltRules;
    for (const key of ["schema_version", "max_bytes", "max_findings", "max_depth", "severities", "gates", "phases", "kinds", "next_steps", "history", "reasons"]) {
      if ((rules as unknown as Record<string, unknown>)[key] === undefined) throw new TypeError(`no ${key}`);
    }
    const compiled = Object.fromEntries(
      Object.entries(rules.patterns).map(([name, source]) => [name, new RegExp(`^(?:${source})$`)]),
    );
    return { ...rules, compiled };
  } catch (error) {
    return { broken: errorName(error) };
  }
}

let loadedRules: Promise<LoadedHaltRules> | undefined;

function haltRules(): Promise<LoadedHaltRules> {
  loadedRules ??= loadHaltRules();
  return loadedRules;
}

class HaltDefect extends Error {}

function haltFields(doc: Record<string, unknown>, rules: HaltRules): HaltFields {
  const { compiled } = rules;
  const text = (name: string, pattern: string): string => {
    const value = doc[name];
    if (typeof value !== "string" || !compiled[pattern].test(value)) throw new HaltDefect(name);
    return value;
  };
  const optional = (name: string, pattern: string): string | null =>
    doc[name] === null || doc[name] === undefined ? null : text(name, pattern);
  const gate = doc.gate ?? null;
  if (gate !== null && (typeof gate !== "string" || own(rules.gates, gate) === undefined)) throw new HaltDefect("gate");
  const phase = doc.phase;
  if (typeof phase !== "string" || own(rules.phases, phase) === undefined) throw new HaltDefect("phase");
  let attempt: number | null = null;
  if (doc.attempt !== null && doc.attempt !== undefined) {
    const value = whole(doc.attempt);
    if (value === undefined || value < 1) throw new HaltDefect("attempt");
    attempt = value;
  }
  const found = doc.findings;
  if (!Array.isArray(found) || found.length > rules.max_findings) throw new HaltDefect("findings");
  const findings = found.map((one: unknown): HaltFinding => {
    const entry = (one !== null && typeof one === "object" && !Array.isArray(one) ? one : {}) as Record<string, unknown>;
    const { severity, code } = entry;
    if (
      typeof severity !== "string" ||
      !rules.severities.includes(severity) ||
      typeof code !== "string" ||
      !compiled.token.test(code)
    ) {
      throw new HaltDefect("findings");
    }
    const path = entry.path ?? null;
    if (path !== null && (typeof path !== "string" || !compiled.path.test(path))) throw new HaltDefect("findings");
    let line: number | null = null;
    if (entry.line !== null && entry.line !== undefined) {
      const value = whole(entry.line);
      if (value === undefined || value < 1) throw new HaltDefect("findings");
      line = value;
    }
    return { severity, code, path, line };
  });
  return {
    item_spec_sha256: text("item_spec_sha256", "sha256"),
    halt_kind: text("halt_kind", "token"),
    gate,
    phase,
    attempt,
    findings,
    next_step: text("next_step", "token"),
    required_check_id: optional("required_check_id", "token"),
    item_tip: optional("item_tip", "oid"),
    integration_tip: optional("integration_tip", "oid"),
    recorded_at: text("recorded_at", "timestamp"),
    hatch_version: text("hatch_version", "version"),
  };
}

// Twin of hatch_next.py's _nesting: JSON.parse has no depth limit and Python's parser
// raises at one that varies by version, so both cap it first.
function nesting(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      deepest = Math.max(deepest, ++depth);
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
    }
  }
  return deepest;
}

/** One record's bytes, read as hatch_next.py's parse_halt_record reads them. Never throws. */
export function parseHaltRecord(raw: Uint8Array, slug: string, item: string, rules: LoadedHaltRules): ParsedHalt {
  if ("broken" in rules) return { status: "unreadable", why: "no-rules", error: rules.broken };
  if (raw.length > rules.max_bytes) return { status: "unreadable", why: "too-large" };
  let doc: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    if (nesting(text) > rules.max_depth) return { status: "unreadable", why: "too-deep" };
    doc = JSON.parse(text);
  } catch (error) {
    return { status: "unreadable", why: "not-json", error: errorName(error) };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { status: "unreadable", why: "not-an-object" };
  const record = doc as Record<string, unknown>;
  const version = whole(record.schema_version);
  if (version === undefined) return { status: "unreadable", why: "bad-field:schema_version" };
  if (version !== rules.schema_version) return { status: "unsupported", schema: version };
  if (record.binder !== slug || record.item !== item) return { status: "unreadable", why: "wrong-item" };
  try {
    return { status: "valid", fields: haltFields(record, rules) };
  } catch (error) {
    if (error instanceof HaltDefect) return { status: "unreadable", why: `bad-field:${error.message}` };
    return { status: "unreadable", why: "not-json", error: errorName(error) };
  }
}

function headline(fields: HaltFields, rules: HaltRules): string {
  const kind = own(rules.kinds, fields.halt_kind) ?? `Kind "${fields.halt_kind}" (not known to this hatch version)`;
  const where = fields.gate ? [rules.gates[fields.gate]] : [];
  where.push(rules.phases[fields.phase]);
  if (fields.attempt) where.push(`attempt ${fields.attempt}`);
  return `${kind}: ${where.join(", ")}. Recorded ${fields.recorded_at}.`;
}

function findingLine(finding: HaltFinding): string {
  const where = finding.path ? (finding.line ? `${finding.path}:${finding.line}` : finding.path) : "";
  return [finding.severity, finding.code, where].filter(Boolean).join(" ");
}

function reasonText(why: string, rules: LoadedHaltRules): string {
  if ("broken" in rules || why === "no-rules") return "hatch's halt rules file could not be read";
  const [name, field] = why.split(":");
  return rules.reasons[name].replaceAll("{field}", field ?? "");
}

function nextLine(step: string, rules: HaltRules): string {
  const known = own(rules.next_steps, step);
  return known ? `Next: ${known}.` : `Next: "${step}" (not known to this hatch version).`;
}

/** Twin of hatch_next.py's halt_view: a pure function of the record and what Git holds now. */
export function haltView(
  parsed: ParsedHalt,
  rules: LoadedHaltRules,
  ref: string,
  spec: string | undefined,
  itemTip: string | null,
  outcome: boolean,
): HaltView {
  const tail = "The item's state does not depend on it.";
  if (parsed.status === "unreadable") {
    return {
      status: "unreadable",
      why: parsed.why,
      labelKey: "halt_unread",
      ...(parsed.error ? { error: parsed.error } : {}),
      lines: [`A halt record exists at ${ref} but hatch could not read it: ${reasonText(parsed.why, rules)}. ${tail}`],
    };
  }
  if (parsed.status === "unsupported") {
    return {
      status: "unsupported",
      why: null,
      labelKey: "halt_unread",
      lines: [`A halt record exists from another hatch version (schema ${parsed.schema}). This version does not read it. ${tail}`],
    };
  }
  const known = rules as HaltRules;
  const { fields } = parsed;
  const why =
    spec === undefined
      ? "spec-unknown"
      : fields.item_spec_sha256 !== spec
        ? "spec-changed"
        : fields.item_tip !== itemTip
          ? "tip-moved"
          : outcome
            ? "outcome-written"
            : null;
  const head = headline(fields, known);
  if (why) {
    const sentence = known.history[why]
      .replaceAll("{old}", fields.item_tip?.slice(0, 7) ?? "no branch")
      .replaceAll("{new}", itemTip?.slice(0, 7) ?? "no branch");
    return {
      status: "history",
      why,
      labelKey: "halt_history",
      record: fields,
      lines: [`History, not the present reason: ${sentence}.`, head],
    };
  }
  return {
    status: "current",
    why: null,
    labelKey: "halt",
    record: fields,
    lines: [head, ...fields.findings.map(findingLine), nextLine(fields.next_step, known)],
  };
}

/**
 * The view of one item's record, or undefined when it has none. Never throws. One
 * for-each-ref gives the record's type and size, the item tip and the outcome refs, so
 * a ref that is not a blob, or a blob over the cap, is never read. `specDigest` is only
 * asked for a valid record, and a rejection reads as spec-unknown.
 */
export async function readHaltView(
  repoRoot: string,
  binder: string,
  item: string,
  specDigest: () => Promise<string>,
): Promise<HaltView | undefined> {
  const ref = `refs/hatch/${binder}/item-${item}/halt`;
  const rules = await haltRules();
  let listed: string;
  try {
    const { stdout } = await exec(
      "git",
      hostGitArgs(repoRoot, [
        "for-each-ref",
        "--format=%(refname) %(objectname) %(objecttype) %(objectsize)",
        `refs/hatch/${binder}/item-${item}/`,
        `refs/heads/hatch/${binder}/item-${item}`,
      ]),
      { encoding: "utf8" },
    );
    listed = stdout;
  } catch (error) {
    // Nothing here says a record exists: git never answered.
    return {
      status: "unreadable",
      why: "not-checked",
      labelKey: "halt_unread",
      error: errorName(error),
      lines: [`Hatch could not check for a halt record at ${ref}: ${reasonText("not-checked", rules)}. The item's state does not depend on it.`],
    };
  }
  const refs = new Map(
    listed
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, oid, type, size] = line.split(" ");
        return [name, { oid, type, size: Number(size) }] as const;
      }),
  );
  const halt = refs.get(ref);
  if (!halt) return undefined;
  const itemTip = refs.get(`refs/heads/hatch/${binder}/item-${item}`)?.oid ?? null;
  const outcome = ["built", "done", "accepted"].some((name) => refs.has(`refs/hatch/${binder}/item-${item}/${name}`));
  try {
    let parsed: ParsedHalt;
    if ("broken" in rules) {
      parsed = parseHaltRecord(new Uint8Array(), binder, item, rules);
    } else if (halt.type !== "blob") {
      parsed = { status: "unreadable", why: "not-a-blob" };
    } else if (halt.size > rules.max_bytes) {
      parsed = { status: "unreadable", why: "too-large" };
    } else {
      const { stdout: raw } = await exec("git", hostGitArgs(repoRoot, ["cat-file", "blob", halt.oid]), {
        encoding: "buffer",
        maxBuffer: rules.max_bytes,
      });
      parsed = parseHaltRecord(raw, binder, item, rules);
    }
    const spec = parsed.status === "valid" ? await specDigest().catch(() => undefined) : undefined;
    return haltView(parsed, rules, ref, spec, itemTip, outcome);
  } catch (error) {
    return haltView({ status: "unreadable", why: "not-read", error: errorName(error) }, rules, ref, undefined, null, false);
  }
}

function summaryOf(view: HaltView): string {
  if (view.status === "history") return view.lines[0];
  if (view.status === "current") {
    const count = view.record?.findings.length ?? 0;
    const findings = count ? ` ${count} finding${count === 1 ? "" : "s"}.` : "";
    return `${view.lines[0]}${findings} ${view.lines[view.lines.length - 1]}`;
  }
  // The dialog names the item beside the line, and says nothing about the state there.
  return view.lines[0].replace(/ at \S+ but /, " but ").replace(/ The item's state does not depend on it\.$/, "");
}

/**
 * The Resume dialog's lines for the leftovers that are halt records, or "" with none.
 * Names five at most and then says how many more there are, as the unlanded list does.
 */
export async function haltDisclosure(
  repoRoot: string,
  binder: string,
  leftovers: readonly string[],
  specDigest: (item: string) => Promise<string>,
): Promise<string> {
  const prefix = `refs/hatch/${binder}/item-`;
  const items = leftovers
    .filter((ref) => ref.startsWith(prefix) && ref.endsWith("/halt"))
    .map((ref) => ref.slice(prefix.length, -"/halt".length));
  const shown = items.slice(0, DISCLOSED_ITEMS);
  const views = await Promise.all(shown.map((item) => readHaltView(repoRoot, binder, item, () => specDigest(item))));
  const lines = shown.flatMap((item, index) => {
    const view = views[index];
    return view ? [`  ${item}: ${summaryOf(view)}`] : [];
  });
  if (items.length > shown.length) lines.push(`  and ${items.length - shown.length} more`);
  return lines.length ? `\n\nWhy items stopped, from the records in Git:\n${lines.join("\n")}` : "";
}

function clip(text: string, room = REASON_LIMIT): string {
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

/**
 * The reason a halt prompt shows for an item this run did not halt. `fallback` is the
 * sentence for an item with no record, and a record changes the words only.
 */
export function haltReason(view: HaltView | undefined, fallback: string): string {
  if (!view) return fallback;
  if (view.status === "history") {
    return clip(`it was halted by an earlier run and no current record says why. ${view.lines[0]}`);
  }
  if (view.status !== "current") return clip(`${fallback}. ${view.lines[0]}`);
  const findings = view.record?.findings ?? [];
  const named = findings.slice(0, PROMPT_FINDINGS).map((finding) => {
    const where = finding.path ? ` at ${finding.path}${finding.line ? `:${finding.line}` : ""}` : "";
    return `[${finding.severity}] ${finding.code}${where}`;
  });
  if (findings.length > named.length) named.push(`and ${findings.length - named.length} more`);
  // The next step is what the operator acts on, so the clip takes findings, never it.
  const next = view.lines[view.lines.length - 1];
  return `${clip([view.lines[0], ...named].join("\n"), REASON_LIMIT - next.length - 1)}\n${next}`;
}
