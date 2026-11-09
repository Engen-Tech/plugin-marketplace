import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { effectiveGateVerdict, type HatchGateFinding, type HatchGateVerdict } from "./gate-runner.ts";
import type { HatchVerificationResult } from "./verification-runner.ts";
import { hostGitArgs } from "./worker-attestation.ts";

// The Pi twin of skills/hatch-verify/scripts/gate_attempts.py. It writes the same file
// at the same path with a superset of the script's row keys, so `gate_attempts.py check`
// reads Pi's rows (its state() reads only `item_spec_sha256` and `verdict`). It is a
// twin, not a shell-out, because the script's `record` needs a Git revision range for
// its diff digest and Pi reviews staged candidate trees and merge trees that are not
// commits. Build-time and merge-time verdicts of a gate share one count per item, gate
// and item spec; only an effective `concerns` spends; a changed diff keeps the count.
// The ledger never decides an item's outcome, refs do: losing the file refills a
// budget, it cannot mark anything done. It is ordinary files, not tamper-proof.

const exec = promisify(execFile);
const SCHEMA = "hatch-gate-attempt-v1";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type HatchGateRole = "acceptance-gate" | "safety-gate" | "visual-gate";
export type HatchGatePhase = "build" | "merge" | "accept";

export interface HatchGateAttemptRecord {
  item: string;
  attempt: number; // 1 + counted concerns before it, per gate file
  phase: HatchGatePhase;
  role: HatchGateRole;
  verdict: HatchGateVerdict; // effective
  reportedVerdict?: "concerns"; // minor-only acceptance/visual pass
  hostVerdict?: true; // the host wrote this blocked verdict: no gate child returned one
  counted: boolean;
  itemTip: string;
  reviewedTree: string;
  integrationTip?: string; // merge phase
  evidenceHash: string;
  findings: { severity: "critical" | "major" | "minor"; code: string; path?: string; line?: number }[];
  recordedAt: string;
  // Set on a row the host wrote without a gate run: the build-time citation pre-check,
  // or a failed check the worker proposed and the host reran.
  source?: HatchHostCheckSource;
}

export type HatchHostCheckSource = "host-citation-check" | "host-worker-check";
const HOST_CHECK_SOURCES = new Set<unknown>(["host-citation-check", "host-worker-check"]);

export const GATE_ATTEMPT_CAPS = { acceptance: 2, safety: 3 } as const;

export interface GateAttemptState {
  counted: number;
  cap: number;
  exhausted: boolean;
  file: string;
  // Set when the ledger file cannot be read or holds a malformed line. The gate then
  // reads as exhausted, so an unreadable count takes the cap path toward the human.
  error?: string;
}

type GateFile = keyof typeof GATE_ATTEMPT_CAPS;
type LedgerRow = Record<string, unknown>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False), as in
// gate_attempts.py item_spec(). JSON.stringify already escapes the same characters
// (quote, backslash, control characters) and leaves non-ASCII text raw. Known edge: a
// float literal such as 1.0 reads as 1 here, so that item digests differently in the
// two runtimes and each keeps its own sequence.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function itemSpecDigest(item: unknown): string {
  return sha256(canonicalJson(item));
}

// A visual verdict goes in the acceptance file: the visual gate retries under the
// acceptance cap.
export function gateFileFor(role: HatchGateRole): GateFile {
  return role === "safety-gate" ? "safety" : "acceptance";
}

export function safeName(kind: string, value: string): string {
  if (!SAFE_NAME.test(value) || value.includes("..")) {
    throw new Error(`Hatch gate-attempt ledger: ${kind} ${JSON.stringify(value)} is not a plain name (letters, digits, '.', '_', '-')`);
  }
  return value;
}

export async function binderDir(repoRoot: string, binder: string): Promise<string> {
  const { stdout } = await exec("git", hostGitArgs(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return join(stdout.trim(), "hatch", "attempts", safeName("binder slug", binder));
}

function ledgerFile(dir: string, item: string, gate: GateFile): string {
  return join(dir, `${safeName("item", item)}.${gate}.jsonl`);
}

// Throws naming the file and line on a malformed line, like the script's read_rows().
async function readRows(file: string): Promise<LedgerRow[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`${file} cannot be read: ${(error as Error).message}`);
  }
  const rows: LedgerRow[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${file}:${index + 1} is not JSON (${(error as Error).message}); the ledger was edited by hand — repair or remove that line deliberately`,
      );
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${file}:${index + 1} is not a JSON object`);
    }
    rows.push(row as LedgerRow);
  });
  return rows;
}

function countedIn(rows: readonly LedgerRow[], specDigest: string): number {
  return rows.filter((row) => row.item_spec_sha256 === specDigest && row.verdict === "concerns").length;
}

const ROLES = new Set<unknown>(["acceptance-gate", "safety-gate", "visual-gate"]);
const PHASES = new Set<unknown>(["build", "merge", "accept"]);

// Rows written by the skill path carry no phase or role; they still count toward the
// cap, but only Pi rows become attempt records.
function toRecord(row: LedgerRow): HatchGateAttemptRecord | undefined {
  if (!ROLES.has(row.role) || !PHASES.has(row.phase)) return undefined;
  return {
    item: String(row.item),
    attempt: Number(row.attempt),
    phase: row.phase as HatchGatePhase,
    role: row.role as HatchGateRole,
    verdict: row.verdict as HatchGateVerdict,
    ...(row.reported_verdict === "concerns" ? { reportedVerdict: "concerns" as const } : {}),
    ...(row.host_verdict === true ? { hostVerdict: true as const } : {}),
    counted: row.counted === true,
    itemTip: String(row.item_tip),
    reviewedTree: String(row.reviewed_tree),
    ...(typeof row.integration_tip === "string" ? { integrationTip: row.integration_tip } : {}),
    evidenceHash: String(row.evidence_hash),
    findings: Array.isArray(row.findings) ? (row.findings as HatchGateAttemptRecord["findings"]) : [],
    recordedAt: String(row.recorded_at),
    ...(HOST_CHECK_SOURCES.has(row.source) ? { source: row.source as HatchHostCheckSource } : {}),
  };
}

export async function readAttempts(
  repoRoot: string,
  binder: string,
  item: string,
  specDigest: string,
): Promise<{ acceptance: GateAttemptState; safety: GateAttemptState; records: HatchGateAttemptRecord[] }> {
  const dir = await binderDir(repoRoot, binder);
  const records: HatchGateAttemptRecord[] = [];
  const read = async (gate: GateFile): Promise<GateAttemptState> => {
    const file = ledgerFile(dir, item, gate);
    const cap = GATE_ATTEMPT_CAPS[gate];
    try {
      const rows = (await readRows(file)).filter((row) => row.item_spec_sha256 === specDigest);
      for (const row of rows) {
        const record = toRecord(row);
        if (record) records.push(record);
      }
      const counted = countedIn(rows, specDigest);
      return { counted, cap, exhausted: counted >= cap, file };
    } catch (error) {
      // No count can be trusted, so the gate reports its cap as spent.
      return { counted: cap, cap, exhausted: true, file, error: (error as Error).message };
    }
  };
  const acceptance = await read("acceptance");
  const safety = await read("safety");
  records.sort((a, b) => (a.recordedAt < b.recordedAt ? -1 : a.recordedAt > b.recordedAt ? 1 : 0));
  return { acceptance, safety, records };
}

function utcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface RowTarget {
  binder: string;
  item: string;
  specDigest: string;
  phase: HatchGatePhase;
  itemTip: string;
  reviewedTree: string;
  integrationTip?: string;
}

// One ledger row: the attempt number is read from the gate file at write time.
async function appendRow(
  dir: string,
  target: RowTarget,
  entry: {
    role: HatchGateRole;
    verdict: HatchGateVerdict;
    reportedVerdict?: "concerns";
    hostVerdict?: true;
    evidenceHash: string;
    findings: readonly HatchGateFinding[];
    source?: HatchHostCheckSource;
  },
): Promise<HatchGateAttemptRecord> {
  const gate = gateFileFor(entry.role);
  const file = ledgerFile(dir, target.item, gate);
  const rows = await readRows(file);
  const record: HatchGateAttemptRecord = {
    item: target.item,
    attempt: countedIn(rows, target.specDigest) + 1,
    phase: target.phase,
    role: entry.role,
    verdict: entry.verdict,
    ...(entry.reportedVerdict ? { reportedVerdict: entry.reportedVerdict } : {}),
    ...(entry.hostVerdict ? { hostVerdict: true as const } : {}),
    // A host-written verdict is always `blocked`, so it never counts toward the cap.
    counted: entry.verdict === "concerns",
    itemTip: target.itemTip,
    reviewedTree: target.reviewedTree,
    ...(target.integrationTip ? { integrationTip: target.integrationTip } : {}),
    evidenceHash: entry.evidenceHash,
    findings: entry.findings.map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      ...(finding.path !== undefined ? { path: finding.path } : {}),
      ...(finding.line !== undefined ? { line: finding.line } : {}),
    })),
    recordedAt: utcStamp(),
    ...(entry.source ? { source: entry.source } : {}),
  };
  // A verification result carries the evidence hash, not the diff bytes the evidence
  // reviewed (those live in the evidence manifest's payload.diff), so diff_sha256 here
  // is the SHA-256 of the reviewed tree id. It changes exactly when the reviewed
  // content changes; the script's state() does not read it.
  const row = {
    schema: SCHEMA,
    gate,
    attempt: record.attempt,
    verdict: record.verdict,
    counted: record.counted,
    range: `${target.integrationTip ?? target.itemTip}..${target.reviewedTree}`,
    diff_sha256: sha256(target.reviewedTree),
    item_spec_sha256: target.specDigest,
    item: target.item,
    binder_slug: target.binder,
    recorded_at: record.recordedAt,
    phase: record.phase,
    role: record.role,
    ...(record.reportedVerdict ? { reported_verdict: record.reportedVerdict } : {}),
    ...(record.hostVerdict ? { host_verdict: true } : {}),
    item_tip: record.itemTip,
    reviewed_tree: record.reviewedTree,
    ...(record.integrationTip ? { integration_tip: record.integrationTip } : {}),
    evidence_hash: record.evidenceHash,
    findings: record.findings,
    ...(record.source ? { source: record.source } : {}),
  };
  await mkdir(dirname(file), { recursive: true });
  const handle = await open(file, "a", 0o644);
  try {
    await handle.write(`${canonicalJson(row)}\n`);
  } finally {
    await handle.close();
  }
  return record;
}

export async function recordVerification(
  repoRoot: string,
  input: RowTarget & { verification: HatchVerificationResult },
): Promise<HatchGateAttemptRecord[]> {
  const dir = await binderDir(repoRoot, input.binder);
  const gates = input.verification.gates;
  // A host-written verdict (a gate child returned none) is one row like any other
  // `blocked`, marked as the host's and never counted; the children before it are not
  // verdicts and write nothing.
  const verdicts: { role: HatchGateRole; verdict: HatchGateVerdict; reported?: HatchGateVerdict; host?: boolean; findings: readonly HatchGateFinding[]; evidenceHash: string }[] = [];
  if (gates.acceptance) verdicts.push({ role: "acceptance-gate", verdict: gates.acceptance.verdict, reported: gates.acceptance.reportedVerdict, host: gates.acceptance.verdictSource === "host", findings: gates.acceptance.findings, evidenceHash: gates.acceptance.evidenceHash });
  if (gates.safety) verdicts.push({ role: "safety-gate", verdict: gates.safety.verdict, reported: gates.safety.reportedVerdict, host: gates.safety.verdictSource === "host", findings: gates.safety.findings, evidenceHash: gates.safety.evidenceHash });
  // A visual gate result carries a dispatch hash, not an evidence hash, so its row
  // names the verification's evidence hash.
  if (gates.visual) verdicts.push({ role: "visual-gate", verdict: gates.visual.verdict, reported: gates.visual.reportedVerdict, findings: gates.visual.findings, evidenceHash: input.verification.evidenceHash });

  const written: HatchGateAttemptRecord[] = [];
  for (const entry of verdicts) {
    // The gate runners already return the effective verdict; re-deriving it is
    // idempotent and keeps a caller-built result from spending on a minor-only concern.
    const verdict = effectiveGateVerdict(entry.role, entry.verdict, entry.findings);
    const reported = entry.reported ?? entry.verdict;
    written.push(
      await appendRow(dir, input, {
        role: entry.role,
        verdict,
        ...(reported !== verdict && reported === "concerns" ? { reportedVerdict: "concerns" as const } : {}),
        ...(entry.host ? { hostVerdict: true as const } : {}),
        evidenceHash: entry.evidenceHash,
        findings: entry.findings,
      }),
    );
  }
  return written;
}

// Two host checks send an item back before any gate runs, and each spends one safety
// attempt like a gate concern: one counted row with every key a gate row has, marked by
// `source`. The citation pre-check (the default) applies the safety auditor's own rule (a
// citation that does not check out leaves its override undeclared) to bytes the host
// parsed. `host-worker-check` is a check the worker proposed that failed when the host
// reran it; the worker wrote it, so the worker gets it back instead of the item halting.
export async function recordHostCheck(
  repoRoot: string,
  input: RowTarget & {
    evidenceHash: string;
    findings: readonly HatchGateFinding[];
    source?: HatchHostCheckSource;
  },
): Promise<HatchGateAttemptRecord> {
  return appendRow(await binderDir(repoRoot, input.binder), input, {
    role: "safety-gate",
    verdict: "concerns",
    evidenceHash: input.evidenceHash,
    findings: input.findings,
    source: input.source ?? "host-citation-check",
  });
}

// The human's "start over" restarts the counts for every item of the binder, and removes
// each item's floor cache file, which lives in the same folder (floor-cache.ts).
export async function clearBinderAttempts(repoRoot: string, binder: string): Promise<void> {
  await rm(await binderDir(repoRoot, binder), { recursive: true, force: true });
}
