// The halt record's writer: the blob at refs/hatch/<slug>/item-<id>/halt that says why
// an item stopped. halt-record.ts and hatch_next.py read it; this writes the bytes they
// read, from the halt recordItemHalt (item-halt.ts) has already mapped and bounded.
//
// A record is prepared in four steps, and nothing reaches the object store before the
// last: build the exact bytes, check them with the readers' own parser, run the secret
// scan over them, then hash. A record that cannot be prepared throws; the caller's sink
// returns that as `sinkError`, so the halt, its `halts` entry and its event never change.
//
// Two ways to keep a record. `lines` gives the update-ref line for a transaction that
// writes `failed`, so the record and the state land together. `write` stands alone: it
// compares and swaps on the item branch and the outcome refs, and writes nothing beside
// built, done or accepted, where the readers would show the record as history at once.
//
// The record's scan has its own time limit and reports its own failures. A scan that
// times out or cannot run writes no record and says why; it never ends the run, as
// runSecretScan does for a candidate, and never reads as a validation failure or a match.

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadHaltRules, parseHaltRecord, type HaltRules } from "./halt-record.ts";
import type { ItemHalt } from "./item-halt.ts";
import { hatchProvenance } from "./run-events.ts";
import { resolveHatchScript } from "./script-catalog.ts";
import { readSecretScanOutput, type SecretScanResult } from "./secret-scan.ts";
import { hostGitArgs } from "./worker-attestation.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 4 * 1024 * 1024;
const SCAN_SCRIPT = "scan_secrets.py";
const MATCHED = "the halt record matched the secret scan; not written";
const OUTCOMES = ["built", "done", "accepted"] as const;

export interface HaltRecordStore {
  /** The update-ref line for a transaction that writes `failed`. Throws when no record can be kept. */
  lines(repoRoot: string, halt: ItemHalt): Promise<string[]>;
  /** Writes the record alone, compare-and-swap. Returns without writing beside built, done or accepted. */
  write(repoRoot: string, halt: ItemHalt): Promise<void>;
  clear(repoRoot: string, binder: string, item: string): Promise<void>;
}

export const noHaltRecordStore: HaltRecordStore = {
  lines: async () => [],
  write: async () => {},
  clear: async () => {},
};

function itemRoot(binder: string, item: string): string {
  return `refs/hatch/${binder}/item-${item}`;
}

export function haltDeleteLine(binder: string, item: string): string {
  return `delete ${itemRoot(binder, item)}/halt`;
}

function recordOf(halt: ItemHalt, at: { recordedAt: string; version: string }, rules: HaltRules, findings: ItemHalt["findings"]) {
  const check = halt.requiredCheckId;
  // Built in the readers' field order, every field present: the bytes are the contract
  // the skill route's writer (halt_record.py) matches.
  return {
    schema_version: rules.schema_version,
    binder: halt.binder,
    item: halt.item,
    item_spec_sha256: halt.specDigest,
    halt_kind: halt.kind,
    gate: halt.gate,
    phase: halt.phase,
    attempt: halt.attempt,
    findings: findings.map(({ severity, code, path, line }) => ({ severity, code, path, line })),
    next_step: halt.nextStep,
    required_check_id: check === null || rules.compiled.token.test(check) ? check : rules.withheld,
    item_tip: halt.itemTip,
    integration_tip: halt.integrationTip,
    recorded_at: at.recordedAt,
    hatch_version: at.version,
  };
}

/** The record's exact bytes. Pure. Over max_bytes, findings are dropped from the tail until it fits. */
export function haltRecordText(halt: ItemHalt, at: { recordedAt: string; version: string }, rules: HaltRules): string {
  let findings = halt.findings;
  for (;;) {
    const text = `${JSON.stringify(recordOf(halt, at, rules, findings), null, 1)}\n`;
    if (findings.length === 0 || Buffer.byteLength(text, "utf8") <= rules.max_bytes) return text;
    findings = findings.slice(0, -1);
  }
}

/** One `git update-ref --stdin` transaction: every line lands, or none does. */
export async function updateRefsTransaction(cwd: string, commands: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("git", hostGitArgs(cwd, ["update-ref", "--stdin"]), {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(output.trim() || `git update-ref transaction failed (${code})`));
    });
    child.stdin.end(`start\n${commands.join("\n")}\nprepare\ncommit\n`);
  });
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", hostGitArgs(repoRoot, args), { encoding: "utf8", maxBuffer: MAX_OUTPUT });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed while writing a halt record`);
  }
}

// Read at call time, so a test can shorten it. Unset, invalid, or above the largest delay
// a Node timer accepts (Node would fire it after 1 ms) keeps the 30 s default.
function scanTimeoutMs(): number {
  const override = Number(process.env.HATCH_HALT_SCAN_UV_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0 && override <= 2_147_483_647 ? override : 30_000;
}

// Twin of evidence.ts uvFailure for the record's scan. `killed` is read before any exit
// code: a child execFile killed at the limit has none, and readSecretScanOutput would call
// it "failed (exit null)". The words name the limit, never a match or a validation.
function scanTimedOut(error: { stdout?: string; stderr?: string }, timeout: number): Error {
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  const limit = timeout % 1000 === 0 ? `${timeout / 1000} s` : `${timeout} ms`;
  const timedOut = `uv run --script ${SCAN_SCRIPT} did not finish in ${limit}`;
  return new Error(output ? `${timedOut}:\n${output}` : timedOut);
}

// scan_secrets.py --file over one scratch file, from the repository root so its allow-list
// applies. Throws on a timeout and on anything but a well-formed clean or blocked report.
async function scanFile(repoRoot: string, file: string): Promise<SecretScanResult> {
  const timeout = scanTimeoutMs();
  try {
    const { stdout } = await exec("uv", ["run", "--script", resolveHatchScript("scanSecrets"), "--file", file], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_OUTPUT,
    });
    return readSecretScanOutput(0, stdout);
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
    if (failed.killed === true) throw scanTimedOut(failed, timeout);
    if (failed.code === undefined || failed.code === null) throw error;
    try {
      return readSecretScanOutput(failed.code, failed.stdout ?? "");
    } catch (unread) {
      const stderr = failed.stderr?.trim();
      throw stderr ? new Error(`${(unread as Error).message}\n${stderr}`) : unread;
    }
  }
}

// The values a model wrote, in a fixed order, each with how to withhold it.
function modelValues(halt: ItemHalt): Array<{ value: string; withhold: (halt: ItemHalt, word: string) => ItemHalt }> {
  const values: Array<{ value: string; withhold: (halt: ItemHalt, word: string) => ItemHalt }> = [];
  halt.findings.forEach((finding, index) => {
    const replace = (field: "code" | "path") => (current: ItemHalt, word: string): ItemHalt => ({
      ...current,
      findings: current.findings.map((one, at) => (at === index ? { ...one, [field]: word } : one)),
    });
    values.push({ value: finding.code, withhold: replace("code") });
    if (finding.path !== null) values.push({ value: finding.path, withhold: replace("path") });
  });
  if (halt.requiredCheckId !== null) {
    values.push({ value: halt.requiredCheckId, withhold: (current, word) => ({ ...current, requiredCheckId: word }) });
  }
  return values;
}

function checked(text: string, halt: ItemHalt, rules: HaltRules): void {
  const parsed = parseHaltRecord(Buffer.from(text, "utf8"), halt.binder, halt.item, rules);
  if (parsed.status === "valid") return;
  const why = parsed.status === "unreadable" ? parsed.why : `unsupported schema ${parsed.schema}`;
  throw new Error(`the halt record is not valid: ${why}`);
}

export function gitHaltRecordStore(options: { now?: () => Date } = {}): HaltRecordStore {
  const now = options.now ?? (() => new Date());

  async function loadedRules(): Promise<HaltRules> {
    const loaded = await loadHaltRules();
    if ("broken" in loaded) throw new Error(`the halt rules file could not be read: ${loaded.broken}`);
    return loaded;
  }

  // The blob of a record that passed the readers' parser and the secret scan. Every scan
  // and the hash read the same scratch file, so the bytes scanned are the bytes stored.
  async function prepare(repoRoot: string, halt: ItemHalt): Promise<{ blob: string; root: string }> {
    const rules = await loadedRules();
    for (const [name, value] of [["binder", halt.binder], ["item", halt.item]] as const) {
      if (!rules.compiled.slug.test(value)) throw new Error(`the halt record's ${name} is not a slug`);
    }
    if (halt.specDigest === null) throw new Error("the halt record has no spec digest");
    const at = { recordedAt: now().toISOString().replace(/\.\d{3}Z$/, "Z"), version: hatchProvenance().version };
    let text = haltRecordText(halt, at, rules);
    checked(text, halt, rules);
    const scratch = join(await git(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), "hatch");
    await mkdir(scratch, { recursive: true });
    const record = join(scratch, `halt-${randomUUID()}.json.tmp`);
    const values = join(scratch, `halt-${randomUUID()}.values.tmp`);
    try {
      await writeFile(record, text);
      if ((await scanFile(repoRoot, record)).status === "match") {
        const candidates = modelValues(halt);
        await writeFile(values, candidates.map(({ value }) => `${value}\n`).join(""));
        const scan = await scanFile(repoRoot, values);
        let withheld = halt;
        const lines = new Set(scan.status === "match" ? scan.matches.map(({ line }) => line) : []);
        candidates.forEach((candidate, index) => {
          if (lines.has(index + 1)) withheld = candidate.withhold(withheld, rules.withheld);
        });
        text = haltRecordText(withheld, at, rules);
        checked(text, halt, rules);
        await writeFile(record, text);
        if ((await scanFile(repoRoot, record)).status === "match") throw new Error(MATCHED);
      }
      const blob = await git(repoRoot, ["hash-object", "-w", "--no-filters", "--", record]);
      return { blob, root: itemRoot(halt.binder, halt.item) };
    } finally {
      await rm(record, { force: true }).catch(() => {});
      await rm(values, { force: true }).catch(() => {});
    }
  }

  return {
    async lines(repoRoot, halt) {
      const { blob, root } = await prepare(repoRoot, halt);
      return [`update ${root}/halt ${blob}`];
    },

    async write(repoRoot, halt) {
      const root = itemRoot(halt.binder, halt.item);
      const branch = `refs/heads/hatch/${halt.binder}/item-${halt.item}`;
      const listed = await git(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname)", `${root}/`, branch]);
      const refs = new Map(listed.split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
      if (OUTCOMES.some((name) => refs.has(`${root}/${name}`))) return;
      const failed = refs.get(`${root}/failed`);
      if (halt.status === "failed" && (halt.itemTip === null || failed !== halt.itemTip)) {
        throw new Error(`a failed halt's record needs ${root}/failed at its item tip`);
      }
      if (halt.status !== "failed" && failed !== undefined) {
        throw new Error(`${root}/failed stands, so a ${halt.status} halt does not replace its record`);
      }
      const { blob } = await prepare(repoRoot, halt);
      const zero = "0".repeat(blob.length);
      await updateRefsTransaction(repoRoot, [
        `verify ${branch} ${halt.itemTip ?? zero}`,
        `verify ${root}/failed ${halt.status === "failed" ? halt.itemTip : zero}`,
        ...OUTCOMES.map((name) => `verify ${root}/${name} ${zero}`),
        `update ${root}/halt ${blob}`,
      ]);
    },

    async clear(repoRoot, binder, item) {
      await updateRefsTransaction(repoRoot, [haltDeleteLine(binder, item)]);
    },
  };
}
