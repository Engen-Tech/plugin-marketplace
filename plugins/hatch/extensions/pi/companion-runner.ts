import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DispatchLockLease, DispatchLockManager } from "./dispatch-lock.ts";
import { validateCandidateHooks, type HookValidationResult } from "./hook-runner.ts";
import { runManagedCommand } from "./managed-command.ts";
import { requirePackagePath, resolvePackagePath } from "./package-paths.ts";
import {
  HatchProcessManager,
  type BinderLifecycleOwner,
} from "./process-manager.ts";
import { isWriterWritablePath, type HatchWriterRole } from "./writer-profile.ts";
import {
  HatchWriterRunner,
  type HatchDocGardnerResult,
  type HatchKaizenResult,
  type HatchOverrideEvidence,
  type HatchResolvedWriterPack,
  type HatchWriterResult,
} from "./writer-runner.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;

export type HatchCompanionCheckpoint = (
  name:
    | "writer-worktree-created"
    | "writer-returned"
    | "writer-surface-attested"
    | "writer-checks-passed"
    | "writer-tree-staged"
    | "writer-hooks-passed"
    | "writer-commit-created"
    | "writer-ref-updated"
    | "writer-worktree-synced"
    | "archive-tree-staged"
    | "archive-hooks-passed"
    | "archive-commit-created"
    | "archive-ref-updated"
    | "archive-worktree-synced",
  details?: { role?: HatchWriterRole; commit?: string; tree?: string },
) => Promise<void> | void;

export interface HatchWriterCommitResult {
  role: HatchWriterRole;
  // `rejected` is a writer that ran and whose output the host refused. The guards
  // that produce it are not relaxed by this status — kaizen still never weakens a
  // rule — but a refused optional companion no longer destroys the delivery it
  // was appended to. It happened: a three-item delivery, every item built, gated,
  // merged and done, was reported as a failure because kaizen tried to weaken one
  // checklist rule at the very end.
  status: "disabled" | "no-change" | "committed" | "rejected";
  reason?: string;
  commit?: string;
  tree?: string;
  result?: HatchWriterResult;
  hookValidation?: HookValidationResult;
}

export interface HatchCompanionResult {
  schema: "hatch-companions-v1";
  docGardner: HatchWriterCommitResult;
  kaizen: HatchWriterCommitResult;
  archive: { status: "already-archived" | "committed"; commit: string };
}

interface WriterConfig {
  enabled: boolean;
  focus?: string;
}

export interface ProcessContext {
  manager: HatchProcessManager;
  owner: BinderLifecycleOwner;
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during companion finalization`);
  }
}

async function gitNoMatch(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT,
    });
    return stdout.trim();
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during companion evidence collection`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseConfig(raw: string, path: string): WriterConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Hatch writer config is not valid JSON: ${path}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Hatch writer config is not an object: ${path}`);
  }
  const config = value as Record<string, unknown>;
  if (
    Object.keys(config).some((key) => !["enabled", "focus"].includes(key)) ||
    typeof config.enabled !== "boolean" ||
    (config.focus !== undefined && typeof config.focus !== "string")
  ) {
    throw new Error(`Hatch writer config has an invalid shape: ${path}`);
  }
  return { enabled: config.enabled, ...(config.focus === undefined ? {} : { focus: config.focus }) };
}

async function readConfig(worktree: string, writer: HatchWriterRole): Promise<WriterConfig> {
  const relative = writer === "doc-gardner" ? ".hatch/doc-gardner.json" : ".hatch/kaizen.json";
  const path = join(worktree, relative);
  if (!(await exists(path))) return { enabled: false };
  return parseConfig(await readFile(path, "utf8"), relative);
}

function splitNul(output: string): string[] {
  return output.split("\0").filter(Boolean).map((path) => path.replaceAll("\\", "/"));
}

async function changedPaths(worktree: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    git(worktree, ["diff", "--name-only", "-z", "--"]),
    git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  return [...new Set([...splitNul(tracked), ...splitNul(untracked)])].sort();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify(uniqueStrings(left)) === JSON.stringify(uniqueStrings(right));
}

function attestGitignore(before: string | undefined, after: string, scratchExists: boolean): void {
  if (!scratchExists) throw new Error("Hatch doc-gardner changed .gitignore without a superpowers folder to salvage");
  const oldLines = (before ?? "").split("\n");
  const newLines = after.split("\n");
  let oldIndex = 0;
  let additions = 0;
  for (const line of newLines) {
    if (oldIndex < oldLines.length && line === oldLines[oldIndex]) {
      oldIndex += 1;
    } else if (line === "superpowers/") {
      additions += 1;
    } else {
      throw new Error("Hatch doc-gardner may only add 'superpowers/' to .gitignore");
    }
  }
  if (oldIndex !== oldLines.length || additions !== 1) {
    throw new Error("Hatch doc-gardner .gitignore change is not the single salvage exception");
  }
}

function frontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  if (lines[0] !== "---") return {};
  const end = lines.indexOf("---", 1);
  if (end < 0) return {};
  const result: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function checklist(text: string): { active: Map<string, string>; retired: Set<string> } {
  const active = new Map<string, string>();
  const retired = new Set<string>();
  for (const line of text.split("\n")) {
    const item = line.match(/^- \[ \] ([a-z][a-z0-9-]*\.\d+) — (\S.*)$/);
    if (item) active.set(item[1], item[2]);
    const tombstone = line.match(/^- ~~([a-z][a-z0-9-]*\.\d+)~~ retired: \S.*$/);
    if (tombstone) retired.add(tombstone[1]);
  }
  return { active, retired };
}

function stripStamp(text: string): string {
  return text.split("\n")
    .filter((line) => !line.startsWith("seeded_from:") && !line.startsWith("base_sha256:"))
    .join("\n");
}

function parseStringList(value: string | undefined): Set<string> {
  if (value === undefined) return new Set();
  try {
    const parsed = JSON.parse(value);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

// Prose surfaces: they describe the override mechanism rather than exercising it.
function isProse(path: string): boolean {
  return path.startsWith("docs/") ||
    path.startsWith("benchmarks/") ||
    path.startsWith(".hatch/binders/") ||
    path.startsWith("agents/") ||
    path.startsWith(".codex/") ||
    path.endsWith(".md");
}

// Generated projections of `skills/` (INV-19). Byte-equal by construction, so a
// marker in one is the same marker, not another occurrence of it.
function isGeneratedMirror(path: string): boolean {
  return path.startsWith(".agents/skills/") || path.startsWith("plugins/hatch/");
}

export function assertMonotonicProjectPack(path: string, before: string, after: string): void {
  const oldFrontmatter = frontmatter(before);
  const newFrontmatter = frontmatter(after);
  for (const key of ["name", "description", "match", "always", "disabled", "extends", "id_prefix", "see_also", "seeded_from", "base_sha256"]) {
    if (oldFrontmatter[key] !== newFrontmatter[key]) {
      throw new Error(`Hatch kaizen changed protected pack frontmatter '${key}' in ${path}`);
    }
  }
  const oldExcludes = parseStringList(oldFrontmatter.exclude_rules);
  const newExcludes = parseStringList(newFrontmatter.exclude_rules);
  for (const rule of oldExcludes) {
    if (!newExcludes.has(rule)) throw new Error(`Hatch kaizen removed exclusion '${rule}' from ${path}`);
  }
  const oldChecklist = checklist(before);
  const newChecklist = checklist(after);
  for (const [id, text] of oldChecklist.active) {
    const replacement = newChecklist.active.get(id);
    if (replacement === undefined) {
      throw new Error(
        `Hatch kaizen removed rule '${id}' from ${path}; an existing rule is never dropped`,
      );
    }
    // Byte equality, deliberately. The previous test was substring containment,
    // which let any weakening through as long as it was phrased as an appended
    // exception — the most natural way to widen a carve-out, and exactly the edit
    // that was attempted here on 2026-09-02. It also rejected rewordings that
    // strengthened a rule, and a typo fix, while reporting all of them as
    // "weakened". No mechanical test can tell a tightening from a loosening, so
    // this one stops pretending to: an existing rule's text does not change, and
    // sharpening happens by adding a rule beside it.
    if (replacement !== text) {
      throw new Error(
        `Hatch kaizen rewrote rule '${id}' in ${path}; an existing rule's text is immutable — ` +
          "add a new rule beside it and leave the wording of this one to a human",
      );
    }
  }
  for (const id of oldChecklist.retired) {
    if (!newChecklist.retired.has(id)) throw new Error(`Hatch kaizen removed tombstone '${id}' from ${path}`);
  }
  const durableBody = (text: string): string[] => {
    const lines = text.split("\n");
    const close = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
    return lines.slice(close + 1).filter((line) => !/^- \[ \] [a-z][a-z0-9-]*\.\d+ — /.test(line));
  };
  const oldBody = durableBody(before);
  const newBody = durableBody(after);
  let cursor = 0;
  for (const line of oldBody) {
    const found = newBody.indexOf(line, cursor);
    if (found < 0) throw new Error(`Hatch kaizen removed or rewrote existing pack guidance in ${path}`);
    cursor = found + 1;
  }
}

async function listProjectPacks(worktree: string): Promise<string[]> {
  const root = join(worktree, ".hatch", "sme");
  if (!(await exists(root))) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => join(root, entry.name))
    .sort();
}

async function validatePacks(
  worktree: string,
  processContext: ProcessContext,
  signal?: AbortSignal,
): Promise<void> {
  const packs = await listProjectPacks(worktree);
  if (packs.length === 0) return;
  const result = await runManagedCommand({
    command: "uv",
    args: ["run", "--script", requirePackagePath("skills/hatch-kaizen/scripts/validate_packs.py"), ...packs],
    cwd: worktree,
    signal,
    onProcessStart(pid) {
      processContext.manager.registerProcess(pid, {
        cwd: worktree,
        parentId: processContext.owner.id,
        label: "kaizen pack validation",
        role: "host-check",
      });
    },
    onProcessExit(pid) {
      processContext.manager.forgetProcess(pid);
    },
  });
  if (result.status !== "passed") {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || "Hatch kaizen pack validation failed");
  }
}

async function scanSecrets(
  worktree: string,
  processContext: ProcessContext,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runManagedCommand({
    command: "uv",
    args: ["run", "--script", requirePackagePath("skills/hatch-build/scripts/scan_secrets.py")],
    cwd: worktree,
    signal,
    onProcessStart(pid) {
      processContext.manager.registerProcess(pid, {
        cwd: worktree,
        parentId: processContext.owner.id,
        label: "companion secret scan",
        role: "host-check",
      });
    },
    onProcessExit(pid) {
      processContext.manager.forgetProcess(pid);
    },
  });
  if (result.status !== "passed") {
    throw new Error(`${result.stdout}${result.stderr}`.trim() || "Hatch companion secret scan failed");
  }
}

async function commitFile(cwd: string, commit: string, path: string): Promise<string | undefined> {
  const listed = splitNul(await git(cwd, ["ls-tree", "--name-only", "-z", commit, "--", path]));
  if (!listed.includes(path)) return undefined;
  const { stdout } = await exec("git", ["-C", cwd, "show", `${commit}:${path}`], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  return stdout;
}

export async function validateRecoveredCompanionCommit(options: {
  worktree: string;
  binder: string;
  writer: HatchWriterRole;
  parent: string;
  commit: string;
  processContext: ProcessContext;
  signal?: AbortSignal;
}): Promise<boolean> {
  const paths = splitNul(await git(options.worktree, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    "-z",
    options.parent,
    options.commit,
  ]));
  if (!paths.every((path) => isWriterWritablePath(options.writer, path))) return false;
  if (options.writer === "doc-gardner") {
    if (paths.includes(".gitignore")) {
      const before = await commitFile(options.worktree, options.parent, ".gitignore");
      const after = await commitFile(options.worktree, options.commit, ".gitignore");
      if (after === undefined) return false;
      const scratchExists =
        (await git(options.worktree, ["ls-tree", "--name-only", options.commit, "--", "superpowers", "docs/superpowers"]))
          .split("\n").filter(Boolean).length > 0;
      try {
        attestGitignore(before, after, scratchExists);
      } catch {
        return false;
      }
    }
    return true;
  }
  if (paths.length === 0) return false;
  for (const path of paths.filter((candidate) => candidate.startsWith(".hatch/sme/"))) {
    if (!/^\.hatch\/sme\/[a-z0-9][a-z0-9-]*\.md$/.test(path)) return false;
    const before = await commitFile(options.worktree, options.parent, path);
    const after = await commitFile(options.worktree, options.commit, path);
    if (after === undefined) return false;
    const id = basename(path, ".md");
    const builtin = resolvePackagePath(`skills/hatch-plan/references/sme/${id}.md`);
    const canonical = await exists(builtin) ? await readFile(builtin, "utf8") : undefined;
    try {
      if (before === undefined || frontmatter(before).seeded_from) {
        if (canonical === undefined || stripStamp(after) !== canonical) return false;
        const fields = frontmatter(after);
        const canonicalHash = createHash("sha256").update(canonical).digest("hex");
        if (fields.seeded_from !== id || fields.base_sha256 !== canonicalHash) return false;
      } else {
        assertMonotonicProjectPack(path, before, after);
      }
    } catch {
      return false;
    }
  }
  const root = await mkdtemp(join(tmpdir(), "hatch-kaizen-recovery-"));
  const disposable = join(root, "worktree");
  let registered = false;
  try {
    await git(options.worktree, ["worktree", "add", "--detach", disposable, options.commit]);
    registered = true;
    await readConfig(disposable, "kaizen");
    await validatePacks(disposable, options.processContext, options.signal);
    return true;
  } catch {
    return false;
  } finally {
    if (registered) await git(options.worktree, ["worktree", "remove", "--force", disposable], true);
    await rm(root, { recursive: true, force: true });
  }
}

function formatKaizenMessage(binder: string, result: HatchKaizenResult): string {
  const subject = result.seeded.length > 0
    ? `kaizen: seed ${result.seeded.length} packs into .hatch/sme/`
    : `kaizen: ${result.summary.split("\n", 1)[0].slice(0, 64)}`;
  const sections = [
    result.summary,
    `Binder: ${binder}`,
    ...([
      ["Candidates", result.candidates],
      ["Erosion notes", result.erosionNotes],
      ["Upstream candidates", result.upstreamCandidates],
      ["Proposed scaffolds", result.proposedScaffolds],
      ["Residual", result.residual],
    ] as const).flatMap(([heading, entries]) => entries.length > 0
      ? [`${heading}:\n${entries.map((entry) => `- ${entry}`).join("\n")}`]
      : []),
  ];
  return `${subject}\n\n${sections.join("\n\n")}`;
}

function formatDocMessage(binder: string, diffRange: string, result: HatchDocGardnerResult): string {
  const body = [result.summary, `Range: ${diffRange}`];
  if (result.residual.length > 0) body.push(`Residual:\n${result.residual.map((entry) => `- ${entry}`).join("\n")}`);
  else if (result.correctedCount === 0) body.push("no drift found");
  if (result.focusStale) body.push(result.focusStale);
  return `docs: gardner ${binder}\n\n${body.join("\n\n")}`;
}

export class HatchCompanionRunner {
  readonly #locks: DispatchLockManager;
  readonly #writers: HatchWriterRunner;
  readonly #checkpoint: HatchCompanionCheckpoint;

  constructor(
    locks: DispatchLockManager,
    writers: HatchWriterRunner,
    checkpoint: HatchCompanionCheckpoint = () => {},
  ) {
    this.#locks = locks;
    this.#writers = writers;
    this.#checkpoint = checkpoint;
  }

  async #resolvePacks(worktree: string, ids: string[]): Promise<HatchResolvedWriterPack[]> {
    return Promise.all(uniqueStrings(ids).map(async (id) => {
      if (!IDENTIFIER.test(id)) throw new Error(`Hatch binder contains an invalid pack id: ${id}`);
      const local = join(worktree, ".hatch", "sme", `${id}.md`);
      const builtin = resolvePackagePath(`skills/hatch-plan/references/sme/${id}.md`);
      const hasLocal = await exists(local);
      const hasBuiltin = await exists(builtin);
      if (!hasLocal && !hasBuiltin) throw new Error(`Hatch cannot resolve pinned pack '${id}'`);
      const path = hasLocal ? local : builtin;
      const content = await readFile(path, "utf8");
      const canonicalContent = hasBuiltin ? await readFile(builtin, "utf8") : undefined;
      return {
        id,
        path,
        content,
        sha256: createHash("sha256").update(content).digest("hex"),
        ...(canonicalContent === undefined ? {} : {
          canonicalContent,
          canonicalSha256: createHash("sha256").update(canonicalContent).digest("hex"),
        }),
      };
    }));
  }

  async #overrideEvidence(
    worktree: string,
    binder: string,
    blastRadius: string[],
  ): Promise<HatchOverrideEvidence[]> {
    const output = await gitNoMatch(worktree, [
      "grep",
      "-n",
      "-I",
      "-E",
      "HATCH-SME-OVERRIDE\\([^)]+\\):",
      "HEAD",
      "--",
    ]);
    if (!output) return [];
    const records = output.split("\n").flatMap((entry) => {
      const match = entry.match(/^HEAD:(.*):(\d+):(.*)$/);
      if (!match) return [];
      const marker = match[3].match(/HATCH-SME-OVERRIDE\(([^)]+)\):\s*(.+)$/);
      if (!marker) return [];
      const path = match[1];
      const rule = marker[1].trim();
      // A repo-wide grep for the marker finds the prose that documents the marker
      // grammar as readily as it finds an override. Measured on this repo, 45 of
      // 60 hits were `<rule-id>` placeholders from READMEs, agent files and
      // benchmark fixtures. Only a real rule id counts.
      if (!/^[a-z][a-z0-9-]*\.\d+$/.test(rule)) return [];
      // Documentation and benchmark corpora explain overrides using real ids.
      if (isProse(path)) return [];
      // The generated skill mirrors are byte-equal to their canonical source
      // (INV-19), so one marker in a skill script appeared three times and
      // cleared the "two or more occurrences" threshold on its own. A projection
      // is never the source: count the canonical path and drop the copies.
      if (isGeneratedMirror(path)) return [];
      return [{ path, line: Number(match[2]), rule, reason: marker[2].trim() }];
    }).slice(0, 500);
    if (records.length === 0) return [];
    // Attribution keys on the durable `done` refs, not on item branches, and on
    // each item's own narrow range rather than everything its tip can reach.
    //
    // The previous version asked `rev-list --first-parent <item-tip>`, which
    // returns the whole history the branch was cut from. Item branches are also
    // short-lived: this repo had run 20 deliveries and kept item branches for
    // one, so every marker in the repository was credited to that single
    // delivery. Where several survived, `deliveries[0]` after a sort awarded the
    // marker to whichever delivery name sorted first. The "across two or more
    // distinct deliveries" threshold cannot be evaluated on a field like that.
    //
    // `<done>^1..<done>` is the range hatch already treats as an item's own
    // commits, and `refs/hatch/` outlives the branches.
    const doneRefs = (await git(worktree, [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)",
      "refs/hatch",
    ])).split("\n").filter(Boolean).flatMap((line) => {
      const [ref, tip] = line.split("\t");
      const match = ref.match(/^refs\/hatch\/([^/]+)\/item-[^/]+\/done$/);
      return match ? [{ delivery: match[1], tip }] : [];
    });
    const introducedBy = new Map<string, string>();
    for (const { delivery, tip } of doneRefs) {
      // A `done` with no second parent is an unmerged item tip; its own commit is
      // the range. allowFailure keeps a pruned or malformed ref from failing the
      // whole companion phase.
      const range = await git(worktree, ["rev-list", `${tip}^1..${tip}`], true) ||
        await git(worktree, ["rev-list", "-1", tip], true);
      for (const commit of range.split("\n").filter(Boolean)) {
        if (!introducedBy.has(commit)) introducedBy.set(commit, delivery);
      }
    }
    const commits = new Map<string, { date: string; delivery: string }>();
    const evidence: HatchOverrideEvidence[] = [];
    for (const record of records) {
      const blame = await git(worktree, [
        "blame",
        "--porcelain",
        `-L${record.line},${record.line}`,
        "HEAD",
        "--",
        record.path,
      ]);
      const commit = blame.split(/\s+/, 1)[0];
      let identity = commits.get(commit);
      if (!identity) {
        identity = {
          date: await git(worktree, ["show", "-s", "--format=%cs", commit]),
          // A marker whose commit belongs to no recorded item is honestly
          // unknown. Saying so beats naming a delivery that did not write it:
          // the threshold counts distinct deliveries, and a wrong name is a
          // miscount in the direction of acting.
          delivery: introducedBy.get(commit) ??
            (blastRadius.includes(record.path) ? binder : "unknown"),
        };
        commits.set(commit, identity);
      }
      evidence.push({
        ...record,
        commit,
        date: identity.date,
        delivery: identity.delivery,
        inBlastRadius: blastRadius.includes(record.path),
      });
    }
    return evidence;
  }

  async #runWriter(
    ctx: ExtensionContext,
    writer: HatchWriterRole,
    binder: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    processContext: ProcessContext,
    input: {
      diffRange: string;
      changedPaths: string[];
      focus?: string;
      packs?: HatchResolvedWriterPack[];
      migrationPacks?: HatchResolvedWriterPack[];
      overrideEvidence?: HatchOverrideEvidence[];
    },
  ): Promise<HatchWriterCommitResult> {
    if (!(await this.#locks.owns(lease))) throw new Error("Hatch companion writer requires the active binder lock lease");
    const config = await readConfig(integrationWorktree, writer);
    if (!config.enabled) return { role: writer, status: "disabled" };
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const base = await git(integrationWorktree, ["rev-parse", `${integrationRef}^{commit}`]);
    const root = await mkdtemp(join(tmpdir(), `hatch-${writer}-`));
    const worktree = join(root, "worktree");
    let registered = false;
    try {
      await git(integrationWorktree, ["worktree", "add", "--detach", worktree, base]);
      registered = true;
      await this.#checkpoint("writer-worktree-created", { role: writer });
      if (writer === "kaizen") await validatePacks(worktree, processContext, ctx.signal);
      const beforePacks = new Map<string, string>();
      if (writer === "kaizen") {
        for (const path of await listProjectPacks(worktree)) {
          beforePacks.set(basename(path), await readFile(path, "utf8"));
        }
      }
      const beforeIgnore = writer === "doc-gardner" && await exists(join(worktree, ".gitignore"))
        ? await readFile(join(worktree, ".gitignore"), "utf8")
        : undefined;
      const result = await this.#writers.run(
        ctx,
        writer,
        worktree,
        binder,
        { ...input, focus: config.focus, packs: input.packs },
        processContext.owner.id,
      );
      await this.#checkpoint("writer-returned", { role: writer });
      const paths = await changedPaths(worktree);
      for (const path of paths) {
        if (!isWriterWritablePath(writer, path)) {
          throw new Error(`Hatch ${writer} mutated an out-of-surface path: ${path}`);
        }
      }
      if (writer === "doc-gardner") {
        const docResult = result as HatchDocGardnerResult;
        if (!sameStrings(docResult.filesChanged, paths)) {
          throw new Error("Hatch doc-gardner result does not match the host-observed changed paths");
        }
        if (docResult.correctedCount !== paths.filter((path) => path !== ".gitignore").length) {
          throw new Error("Hatch doc-gardner correctedCount does not match the host-observed doc changes");
        }
        if (paths.includes(".gitignore")) {
          const scratch = await exists(join(worktree, "superpowers")) || await exists(join(worktree, "docs", "superpowers"));
          attestGitignore(beforeIgnore, await readFile(join(worktree, ".gitignore"), "utf8"), scratch);
        }
      } else {
        const kaizenResult = result as HatchKaizenResult;
        const changedPackPaths = paths.filter((path) => path.startsWith(".hatch/sme/"));
        if (changedPackPaths.some((path) => !/^\.hatch\/sme\/[a-z0-9][a-z0-9-]*\.md$/.test(path))) {
          throw new Error("Hatch kaizen pack changes must use lowercase top-level .hatch/sme/<id>.md paths");
        }
        if (!sameStrings(kaizenResult.packsChanged, changedPackPaths)) {
          throw new Error("Hatch kaizen result does not match the host-observed pack changes");
        }
        const resolved = new Map(
          [...(input.packs ?? []), ...(input.migrationPacks ?? [])]
            .map((pack) => [`${pack.id}.md`, pack]),
        );
        for (const path of changedPackPaths) {
          const name = basename(path);
          const after = await readFile(join(worktree, path), "utf8");
          const before = beforePacks.get(name);
          if (before === undefined) {
            const source = resolved.get(name);
            if (!source?.canonicalContent || stripStamp(after) !== source.canonicalContent) {
              throw new Error(`Hatch kaizen created a pack that is not an exact pinned seed: ${path}`);
            }
            const fields = frontmatter(after);
            if (fields.seeded_from !== source.id || fields.base_sha256 !== source.canonicalSha256) {
              throw new Error(`Hatch kaizen seed has invalid provenance: ${path}`);
            }
          } else if (frontmatter(before).seeded_from) {
            const source = resolved.get(name);
            if (!source?.canonicalContent || stripStamp(after) !== source.canonicalContent) {
              throw new Error(`Hatch kaizen edited a seeded cache instead of reseeding exactly: ${path}`);
            }
            const fields = frontmatter(after);
            if (fields.seeded_from !== source.id || fields.base_sha256 !== source.canonicalSha256) {
              throw new Error(`Hatch kaizen reseed has invalid provenance: ${path}`);
            }
          } else {
            assertMonotonicProjectPack(path, before, after);
          }
        }
        await readConfig(worktree, writer);
        await validatePacks(worktree, processContext, ctx.signal);
      }
      await this.#checkpoint("writer-surface-attested", { role: writer });
      await git(worktree, ["add", "--all", "--", ...paths]);
      const unstaged = await git(worktree, ["diff", "--name-only", "-z", "--"]);
      const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]);
      if (unstaged || untracked) throw new Error("Hatch writer left unattested changes after staging");
      const tree = await git(worktree, ["write-tree"]);
      await this.#checkpoint("writer-tree-staged", { role: writer, tree });
      await git(worktree, ["diff", "--cached", "--check"]);
      await scanSecrets(worktree, processContext, ctx.signal);
      await this.#checkpoint("writer-checks-passed", { role: writer, tree });
      if (writer === "kaizen" && paths.length === 0) {
        return { role: writer, status: "no-change", tree, result };
      }
      const message = writer === "doc-gardner"
        ? formatDocMessage(binder, input.diffRange, result as HatchDocGardnerResult)
        : formatKaizenMessage(binder, result as HatchKaizenResult);
      const hookValidation = await validateCandidateHooks({
        worktree,
        parent: base,
        candidateTree: tree,
        message,
        allowEmpty: paths.length === 0,
        signal: ctx.signal,
        onProcessStart: (pid) => processContext.manager.registerProcess(pid, {
          cwd: worktree,
          parentId: processContext.owner.id,
          label: `${writer} commit hooks`,
        }),
        onProcessExit: (pid) => processContext.manager.forgetProcess(pid),
      });
      if (hookValidation.status !== "passed" || hookValidation.hookTree !== tree) {
        throw new Error(`Hatch ${writer} commit hooks failed or changed the attested tree`);
      }
      const refinedMessage = hookValidation.message ?? message;
      const subject = refinedMessage.split("\n", 1)[0];
      if (
        (writer === "doc-gardner" && subject !== `docs: gardner ${binder}`) ||
        (writer === "kaizen" && !subject.startsWith("kaizen: "))
      ) {
        throw new Error(`Hatch ${writer} commit hook changed the required subject`);
      }
      await this.#checkpoint("writer-hooks-passed", { role: writer, tree });
      const commit = await git(worktree, ["commit-tree", tree, "-p", base, "-m", refinedMessage]);
      await this.#checkpoint("writer-commit-created", { role: writer, commit, tree });
      await git(integrationWorktree, ["update-ref", integrationRef, commit, base]);
      await this.#checkpoint("writer-ref-updated", { role: writer, commit, tree });
      await git(integrationWorktree, ["read-tree", "--reset", "-u", commit]);
      await this.#checkpoint("writer-worktree-synced", { role: writer, commit, tree });
      return { role: writer, status: "committed", commit, tree, result, hookValidation };
    } finally {
      if (registered) {
        await git(integrationWorktree, ["worktree", "remove", "--force", worktree], true);
      }
      await rm(root, { recursive: true, force: true });
    }
  }

  async #archive(
    ctx: ExtensionContext,
    binder: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    processContext: ProcessContext,
  ): Promise<{ status: "already-archived" | "committed"; commit: string }> {
    if (!(await this.#locks.owns(lease))) throw new Error("Hatch archive requires the active binder lock lease");
    const integrationRef = `refs/heads/hatch/${binder}/integration`;
    const base = await git(integrationWorktree, ["rev-parse", `${integrationRef}^{commit}`]);
    const live = `.hatch/binders/${binder}.json`;
    const archived = `.hatch/binders/archive/${binder}.json`;
    if (!await exists(join(integrationWorktree, live))) {
      if (!await exists(join(integrationWorktree, archived))) throw new Error("Hatch binder is missing from live and archive paths");
      return { status: "already-archived", commit: base };
    }
    const root = await mkdtemp(join(tmpdir(), "hatch-archive-"));
    const worktree = join(root, "worktree");
    let registered = false;
    try {
      await git(integrationWorktree, ["worktree", "add", "--detach", worktree, base]);
      registered = true;
      await mkdir(join(worktree, ".hatch", "binders", "archive"), { recursive: true });
      await git(worktree, ["mv", live, archived]);
      const tree = await git(worktree, ["write-tree"]);
      await this.#checkpoint("archive-tree-staged", { tree });
      const message = `chore(hatch): archive binder ${binder} — delivered`;
      const hookValidation = await validateCandidateHooks({
        worktree,
        parent: base,
        candidateTree: tree,
        message,
        signal: ctx.signal,
        onProcessStart: (pid) => processContext.manager.registerProcess(pid, {
          cwd: worktree,
          parentId: processContext.owner.id,
          label: "archive commit hooks",
        }),
        onProcessExit: (pid) => processContext.manager.forgetProcess(pid),
      });
      if (hookValidation.status !== "passed" || hookValidation.hookTree !== tree) {
        throw new Error("Hatch archive hooks failed or changed the exact move tree");
      }
      const refined = hookValidation.message ?? message;
      if (refined.split("\n", 1)[0] !== message) throw new Error("Hatch archive hook changed the required subject");
      await this.#checkpoint("archive-hooks-passed", { tree });
      const commit = await git(worktree, ["commit-tree", tree, "-p", base, "-m", refined]);
      await this.#checkpoint("archive-commit-created", { commit, tree });
      await git(integrationWorktree, ["update-ref", integrationRef, commit, base]);
      await this.#checkpoint("archive-ref-updated", { commit, tree });
      await git(integrationWorktree, ["read-tree", "--reset", "-u", commit]);
      await this.#checkpoint("archive-worktree-synced", { commit, tree });
      return { status: "committed", commit };
    } finally {
      if (registered) await git(integrationWorktree, ["worktree", "remove", "--force", worktree], true);
      await rm(root, { recursive: true, force: true });
    }
  }

  async finishDelivery(
    ctx: ExtensionContext,
    binder: string,
    integrationWorktree: string,
    lease: DispatchLockLease,
    processContext: ProcessContext,
    options: { diffBase: string; sme: string[] },
  ): Promise<HatchCompanionResult> {
    const tip = await git(integrationWorktree, ["rev-parse", `refs/heads/hatch/${binder}/integration`]);
    const diffRange = `${options.diffBase}..${tip}`;
    const blastRadius = splitNul(await git(integrationWorktree, ["diff", "--name-only", "-z", options.diffBase, tip]));
    // A companion writer works in a throwaway worktree and touches the
    // integration ref only on its final update-ref, so a refusal leaves the
    // branch exactly as it was. Record it and carry on: the skill's contract is
    // that these phases never halt the delivery, and until now the code did.
    const optional = async (
      role: HatchWriterRole,
      run: () => Promise<HatchWriterCommitResult>,
    ): Promise<HatchWriterCommitResult> => {
      try {
        return await run();
      } catch (error) {
        // An abort is the operator stopping the run, not a writer misbehaving.
        if (ctx.signal?.aborted) throw error;
        return {
          role,
          status: "rejected",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    };
    const docGardner = await optional("doc-gardner", () =>
      this.#runWriter(
        ctx,
        "doc-gardner",
        binder,
        integrationWorktree,
        lease,
        processContext,
        { diffRange, changedPaths: blastRadius },
      ));
    const packs = await this.#resolvePacks(integrationWorktree, options.sme);
    const migrationIds = (await listProjectPacks(integrationWorktree))
      .map((path) => basename(path, ".md"));
    const migrationPacks = await this.#resolvePacks(integrationWorktree, migrationIds);
    const overrideEvidence = await this.#overrideEvidence(integrationWorktree, binder, blastRadius);
    const kaizen = await optional("kaizen", () =>
      this.#runWriter(
        ctx,
        "kaizen",
        binder,
        integrationWorktree,
        lease,
        processContext,
        { diffRange, changedPaths: blastRadius, packs, migrationPacks, overrideEvidence },
      ));
    const archive = await this.#archive(ctx, binder, integrationWorktree, lease, processContext);
    return { schema: "hatch-companions-v1", docGardner, kaizen, archive };
  }
}
