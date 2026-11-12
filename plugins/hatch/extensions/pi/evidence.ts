import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ActionUnion } from "./action-union.ts";
import { requirePackagePath } from "./package-paths.ts";

const exec = promisify(execFile);
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_MAX_DIFF_BYTES = 5 * 1024 * 1024;
const MAX_BINDER_BYTES = 2 * 1024 * 1024;
const MAX_PACK_BYTES = 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 512 * 1024;
const MAX_EVIDENCE_FILES_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_CITATIONS = 8;
export const MAX_EVIDENCE_CITATION_DEFECTS = 20;
const MAX_CITATION_DEFECT_TEXT = 300;
// A repo-rule line counts as a citation attempt only this close below an override marker.
export const MARKER_WINDOW_LINES = 8;
const OVERRIDE_MARKER = "HATCH-SME-OVERRIDE(";
const STRICT_REPO_RULE = /repo-rule:\s+([^\s:]+):([^\]\n;]+)/i;
const LOOSE_REPO_RULE = /repo-rule:\s+(\S+)/i;

// The one citation grammar every runtime documents. It reads as a placeholder, so
// grammar documentation that quotes it is never taken for a citation.
export const REPO_RULE_CITATION_SHAPE = "repo-rule: <path>:<line-or-section>";
export const CITATION_DEFECT_CODES = {
  malformed: "repo-rule-citation-malformed",
  missing: "repo-rule-citation-file-missing",
  "not-a-file": "repo-rule-citation-not-a-file",
} as const;
const DEFAULT_DIFF_PAGE = 30_000;
export const MAX_DIFF_PAGE = 50_000;

// Rendered into the diff page itself. `offset`/`end` are string indices into the
// diff text, not byte offsets, and the wording says so — a reader told "bytes"
// would compute a wrong next offset on any diff carrying non-ASCII.
function diffPageFooter(
  offset: number,
  end: number,
  totalLength: number,
  nextOffset: number | undefined,
): string {
  const range = `[hatch_evidence] diff characters ${offset}-${end} of ${totalLength}.`;
  if (nextOffset === undefined) return `${range} End of diff; nothing follows.`;
  return `${range} TRUNCATED — ${totalLength - end} characters remain. Continue with` +
    ` {"action":"diff","offset":${nextOffset}} (optional "limit", max ${MAX_DIFF_PAGE}).`;
}

interface BinderDocument {
  slug: string;
  sme?: string[];
  work_items: Array<Record<string, unknown> & { id: string }>;
  [key: string]: unknown;
}

export interface EvidenceChecklistItem {
  id: string;
  text: string;
  source: string;
}

export interface EvidencePackDependency {
  id: string;
  path: string;
  sha256: string;
}

export interface EvidencePack {
  id: string;
  source: "project" | "package";
  path: string;
  blob?: string;
  sha256: string;
  dependencies: EvidencePackDependency[];
  checklist: EvidenceChecklistItem[];
}

export type HatchEvidenceTargetKind =
  | "candidate-tree"
  | "committed-tip"
  | "merge-tree"
  | "landed-merge-tip";

export interface EvidenceFile {
  index: number;
  path: string;
  state: "present" | "deleted" | "missing";
  sourceTree: string;
  mode?: string;
  objectType?: string;
  blob?: string;
  bytes?: number;
  binary: boolean;
  content?: string;
  omitted?: "too-large" | "non-blob";
}

export interface EvidenceCitation extends EvidenceFile {
  locator: string;
}

// A repo-rule line this item added next to an override marker that the host cannot
// resolve. Host observation about the reviewed bytes, bound by the evidence hash.
export interface EvidenceCitationDefect {
  path: string;
  line: number;
  text: string;
  problem: "malformed" | "missing" | "not-a-file";
  cited?: string;
  citation?: number;
}

export type RepoRuleLine =
  | { kind: "placeholder" }
  | { kind: "citation"; path: string; locator: string }
  | { kind: "malformed"; cited?: string };

export interface HatchCheckReceipt {
  schema: "hatch-check-receipt-v1";
  targetTree: string;
  commandHash: string;
  cwd: string;
  status: "passed" | "failed";
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

export interface HatchCheckManifestEntry {
  id: string;
  sequence: number;
  purpose: "floor" | "oracle";
  required: true;
  preTree: string;
  postTree: string;
  environmentHash: string;
  receipt: HatchCheckReceipt;
}

export interface HatchCheckManifest {
  schema: "hatch-check-manifest-v1";
  targetTree: string;
  entries: HatchCheckManifestEntry[];
}

export interface HatchCheckManifestEvidence {
  status: "passed" | "failed" | "missing" | "not-required";
  targetTree: string;
  manifest?: HatchCheckManifest;
}

export interface HatchEvidenceRelation {
  id: string;
  touches: string[];
  shared_resources: string[];
}

export interface HatchEvidenceRelations {
  prerequisites: HatchEvidenceRelation[];
  dependents: HatchEvidenceRelation[];
}

export interface HatchEvidencePayload {
  binder: {
    slug: string;
    path: string;
    blob: string;
    sha256: string;
    document: BinderDocument;
  };
  workItem: Record<string, unknown> & { id: string };
  relations: HatchEvidenceRelations;
  git: {
    integrationRef: string;
    integrationTip: string;
    itemRef: string;
    itemTip: string;
    mergeBase: string;
    diffBase: string;
    targetKind: HatchEvidenceTargetKind;
    targetTree: string;
  };
  diff: {
    format: "git-binary-patch";
    sha256: string;
    bytes: number;
    touchedPaths: string[];
    content: string;
  };
  checks: { manifest: HatchCheckManifestEvidence };
  files: EvidenceFile[];
  citations: EvidenceCitation[];
  // Present only when non-empty, so a defect-free payload keeps its earlier shape.
  citationDefects?: EvidenceCitationDefect[];
  packs: EvidencePack[];
}

export interface HatchEvidenceManifest {
  schema: "hatch-evidence-v2";
  generatedAt: string;
  repositoryRoot: string;
  evidenceHash: string;
  payload: HatchEvidencePayload;
}

export interface BuildEvidenceOptions {
  cwd: string;
  binder: string;
  item: string;
  target?: "auto" | "candidate" | "committed" | "merge" | "landed";
  checkManifest?: HatchCheckManifest;
  maxDiffBytes?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function hashEvidencePayload(payload: HatchEvidencePayload): string {
  return sha256(canonicalJson(payload));
}

// The payload paths a reused review does not compare. The item tip and target kind
// differ between a build target and the merge of the same tree. Both are shown in the
// `hatch_evidence summary` (`git: manifest.payload.git`), but carry no reviewable
// content: the tip is an opaque SHA no reviewer tool can dereference, the commit's
// content is targetTree (compared), and the target kind is a label that neither role
// prompt nor the Pi gate contract branches on. Re-check this exclusion whenever a role
// prompt (agents/hatch-acceptance-reviewer.md, agents/hatch-safety-auditor.md) or the Pi
// contract names the target kind. The receipt fields are each run's own log and timing.
// Every other payload field is compared, so a field added later can only cause an extra
// review. `[]` walks every element of an array.
//
// Two gate-prompt inputs outside the payload are not keyed either. Pi's `<cwd>` section
// holds repositoryRoot, which always differs (the item worktree at build, the
// integration worktree at merge); it is inert text, because a gate child has no tool
// that opens a path. The APPEND_SYSTEM.md addendum no longer reaches a gate child at
// all (createIsolatedResourceLoader's noAppendSystemPrompt; see
// docs/bugs/pi-gate-child-loads-append-system.md). Revisit the key if gate children gain
// any path-based capability or Pi adds a cwd-derived prompt section.
export const REVIEW_INPUT_EXCLUDED_PATHS = [
  "git.itemTip",
  "git.targetKind",
  "checks.manifest.manifest.entries[].receipt.stdout",
  "checks.manifest.manifest.entries[].receipt.stderr",
  "checks.manifest.manifest.entries[].receipt.stdoutTruncated",
  "checks.manifest.manifest.entries[].receipt.stderrTruncated",
  "checks.manifest.manifest.entries[].receipt.durationMs",
] as const;

function deletePath(value: unknown, parts: readonly string[]): void {
  if (!value || typeof value !== "object") return;
  const [head, ...rest] = parts;
  const record = value as Record<string, unknown>;
  if (head.endsWith("[]")) {
    const list = record[head.slice(0, -2)];
    if (Array.isArray(list)) for (const entry of list) deletePath(entry, rest);
  } else if (rest.length === 0) {
    delete record[head];
  } else {
    deletePath(record[head], rest);
  }
}

// The SHA-256 of everything a gate reviewer can read in the evidence, less the excluded
// paths above. Equal digests mean a reviewer of either manifest sees the same inputs.
export function reviewInputDigest(manifest: HatchEvidenceManifest): string {
  const payload = structuredClone(manifest.payload);
  for (const path of REVIEW_INPUT_EXCLUDED_PATHS) deletePath(payload, path.split("."));
  return sha256(canonicalJson(payload));
}

// The diff an evidence manifest carries, named the way the gate ledger records it: the
// range's base (the tree is the reviewed tree) and the SHA-256 of the diff bytes.
export interface HatchReviewedDiff {
  base: string;
  sha256: string;
}

export function reviewedDiffOf(manifest: HatchEvidenceManifest): HatchReviewedDiff {
  return { base: manifest.payload.git.diffBase, sha256: manifest.payload.diff.sha256 };
}

export function hashCheckCommand(command: string): string {
  return sha256(command);
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed`);
  }
}

async function gitOptional(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

function validateIdentifier(kind: string, value: string): void {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid Hatch ${kind}: ${value}`);
}

// Read at call time, so a test can shorten it. Unset, invalid, or above the largest delay
// a Node timer accepts (Node would fire it after 1 ms) keeps the 30 s default.
function uvTimeoutMs(): number {
  const override = Number(process.env.HATCH_EVIDENCE_UV_TIMEOUT_MS);
  return Number.isInteger(override) && override > 0 && override <= 2_147_483_647 ? override : 30_000;
}

// A uv run that execFile killed for running past `timeout` names the command and the
// limit, then any output, so a slow host is not reported as a bad binder or pack.
// `killed` is the only field that tells this apart from a child that died of SIGTERM
// itself or a maxBuffer overflow. Any other failure gives its output, else `fallback`.
function uvFailure(error: unknown, script: string, timeout: number, fallback: string): Error {
  const { stdout, stderr, killed } = error as { stdout?: string; stderr?: string; killed?: boolean };
  const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
  const limit = timeout % 1000 === 0 ? `${timeout / 1000} s` : `${timeout} ms`;
  const timedOut = `uv run --script ${script} did not finish in ${limit}`;
  if (killed === true) return new Error(output ? `${timedOut}:\n${output}` : timedOut);
  return new Error(output || fallback);
}

async function validateBinderSource(raw: string, slug: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hatch-evidence-binder-"));
  const path = join(root, `${slug}.json`);
  const environment = { ...process.env };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  environment.PYTHONNOUSERSITE = "1";
  environment.PYTHONSAFEPATH = "1";
  await writeFile(path, raw);
  const timeout = uvTimeoutMs();
  try {
    await exec(
      "uv",
      [
        "run",
        "--script",
        requirePackagePath("skills/hatch-plan/scripts/validate_binder.py"),
        "--binder",
        path,
      ],
      { encoding: "utf8", env: environment, timeout, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (error) {
    throw uvFailure(error, "validate_binder.py", timeout, `Hatch binder '${slug}' failed package validation`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function byIdentifier(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

// Every item a `depends_on` path joins to this one, as validate_binder.py's `_reachable`
// walks it: the items this one waits for, and those that wait for it. An item starts only
// once every item it depends on is done, so either side builds on the other's landed change.
// A carried item counts as done without its prerequisites in this binder, so the walk never
// steps from a carried item to one that is not carried. `serialize` and a shared
// `shared_resources` entry are not followed: they keep two builds out of one wave but do not
// order two edits. The safety gate treats an overlap with any item listed here as planned.
export function resolveItemRelations(
  items: BinderDocument["work_items"],
  itemId: string,
  supersedes?: unknown,
): HatchEvidenceRelations {
  const carried = stringList((supersedes as { carried?: unknown } | undefined)?.carried);
  const relation = (item: Record<string, unknown> & { id: string }): HatchEvidenceRelation => ({
    id: item.id,
    touches: stringList(item.touches),
    shared_resources: stringList(item.shared_resources),
  });
  const reach = (next: (id: string) => string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = next(itemId);
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === itemId || seen.has(id)) continue;
      seen.add(id);
      stack.push(...next(id).filter((other) => !carried.includes(id) || carried.includes(other)));
    }
    return seen;
  };
  const prerequisites = reach((id) => stringList(items.find((item) => item.id === id)?.depends_on));
  const dependents = reach((id) => items.filter((item) => stringList(item.depends_on).includes(id)).map((item) => item.id));
  return {
    prerequisites: items
      .filter((item) => prerequisites.has(item.id))
      .map(relation)
      .sort(byIdentifier),
    dependents: items
      .filter((item) => dependents.has(item.id))
      .map(relation)
      .sort(byIdentifier),
  };
}

function parseBinder(raw: string, expectedSlug: string, item: string): {
  document: BinderDocument;
  workItem: BinderDocument["work_items"][number];
} {
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error(`Hatch binder '${expectedSlug}' is not valid JSON`);
  }
  if (!document || typeof document !== "object") {
    throw new Error(`Hatch binder '${expectedSlug}' is not an object`);
  }
  const binder = document as BinderDocument;
  if (binder.slug !== expectedSlug || !Array.isArray(binder.work_items)) {
    throw new Error(`Hatch binder '${expectedSlug}' has an invalid slug or work_items`);
  }
  const matches = binder.work_items.filter((candidate) => candidate?.id === item);
  if (matches.length !== 1) {
    throw new Error(`Hatch binder '${expectedSlug}' must contain item '${item}' exactly once`);
  }
  if (binder.sme !== undefined) {
    if (!Array.isArray(binder.sme) || !binder.sme.every((id) => typeof id === "string" && IDENTIFIER.test(id))) {
      throw new Error(`Hatch binder '${expectedSlug}' has invalid sme ids`);
    }
  }
  return { document: binder, workItem: matches[0] };
}

function isSafeGitPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return !(
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..")
  );
}

function validateGitPath(path: string): void {
  if (!isSafeGitPath(path)) {
    throw new Error(`Git returned an unsafe evidence path: ${path}`);
  }
}

// undefined: the line has no `repo-rule:` followed by whitespace and a token.
export function parseRepoRuleLine(line: string): RepoRuleLine | undefined {
  const strict = line.match(STRICT_REPO_RULE);
  if (strict) {
    const path = strict[1];
    if (path.startsWith("<")) return { kind: "placeholder" };
    if (!isSafeGitPath(path)) return { kind: "malformed", cited: path };
    return { kind: "citation", path, locator: strict[2].trim() };
  }
  const loose = line.match(LOOSE_REPO_RULE);
  if (!loose) return undefined;
  const cited = loose[1].replace(/[:.,;]+$/, "");
  if (cited.startsWith("<")) return { kind: "placeholder" };
  return cited ? { kind: "malformed", cited } : { kind: "malformed" };
}

// The tree the index holds, written from a private copy of the index. `git write-tree` on
// the index itself takes the index lock and fails while another process holds it, and the
// acceptance and safety gates check freshness on the same worktree at the same time.
async function indexTree(cwd: string): Promise<string> {
  const index = resolve(cwd, (await git(cwd, ["rev-parse", "--git-path", "index"])).trim());
  const dir = await mkdtemp(join(tmpdir(), "hatch-index-"));
  try {
    const copy = join(dir, "index");
    await writeFile(copy, await readFile(index));
    const { stdout } = await exec("git", ["-C", cwd, "write-tree"], {
      encoding: "utf8",
      env: { ...process.env, GIT_INDEX_FILE: copy },
    }).catch((error: { stderr?: string }) => {
      throw new Error(error.stderr?.trim() || "git write-tree failed");
    });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function candidateTree(
  cwd: string,
  expectedBranch: string,
): Promise<{ kind: "candidate-tree"; tree: string } | undefined> {
  const branch = (await git(cwd, ["branch", "--show-current"])).trim();
  if (branch !== expectedBranch) return undefined;
  const unstaged = await gitOptional(cwd, ["diff", "--quiet", "--no-ext-diff", "--"]);
  const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (unstaged === undefined || untracked.length > 0) {
    throw new Error(
      `Hatch candidate '${expectedBranch}' has unstaged or untracked changes; stage the exact candidate before verification`,
    );
  }
  const tree = await indexTree(cwd);
  const headTree = (await git(cwd, ["rev-parse", "HEAD^{tree}"])).trim();
  return tree === headTree ? undefined : { kind: "candidate-tree", tree };
}

async function mergeTree(cwd: string, integrationTip: string, itemTip: string): Promise<string> {
  const output = await git(cwd, ["merge-tree", "--write-tree", integrationTip, itemTip]);
  const tree = output.split("\n", 1)[0].trim();
  if (!/^[a-f0-9]{40,64}$/.test(tree)) {
    throw new Error("Hatch could not derive a clean proposed merge tree");
  }
  return tree;
}

async function resolveEvidenceTarget(
  cwd: string,
  expectedBranch: string,
  integrationTip: string,
  itemTip: string,
  requested: BuildEvidenceOptions["target"],
): Promise<{ kind: HatchEvidenceTargetKind; tree: string }> {
  if (requested === "merge") {
    return { kind: "merge-tree", tree: await mergeTree(cwd, integrationTip, itemTip) };
  }
  if (requested === "landed") {
    const parents = (await git(cwd, ["rev-list", "--parents", "-n", "1", integrationTip]))
      .trim()
      .split(/\s+/)
      .slice(1);
    if (parents.length !== 2 || parents[1] !== itemTip) {
      throw new Error("Hatch landed evidence requires integration to be the two-parent item merge");
    }
    return {
      kind: "landed-merge-tip",
      tree: (await git(cwd, ["rev-parse", `${integrationTip}^{tree}`])).trim(),
    };
  }
  if (requested !== "committed") {
    const candidate = await candidateTree(cwd, expectedBranch);
    if (candidate) return candidate;
    if (requested === "candidate") {
      throw new Error(`Hatch candidate '${expectedBranch}' has no staged tree distinct from HEAD`);
    }
  }
  return {
    kind: "committed-tip",
    tree: (await git(cwd, ["rev-parse", `${itemTip}^{tree}`])).trim(),
  };
}

async function treeFile(
  cwd: string,
  tree: string,
  path: string,
  index: number,
  state: EvidenceFile["state"],
): Promise<EvidenceFile> {
  const listing = await git(cwd, ["ls-tree", "-z", tree, "--", path]);
  if (!listing) {
    return { index, path, state: "missing", sourceTree: tree, binary: false };
  }
  const tab = listing.indexOf("\t");
  const metadata = listing.slice(0, tab).split(" ");
  const [mode, objectType, blob] = metadata;
  if (objectType !== "blob") {
    return {
      index,
      path,
      state,
      sourceTree: tree,
      mode,
      objectType,
      blob,
      binary: false,
      omitted: "non-blob",
    };
  }
  const bytes = Number((await git(cwd, ["cat-file", "-s", blob])).trim());
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Git returned an invalid blob size for evidence path: ${path}`);
  }
  if (bytes > MAX_EVIDENCE_FILE_BYTES) {
    return {
      index,
      path,
      state,
      sourceTree: tree,
      mode,
      objectType,
      blob,
      bytes,
      binary: false,
      omitted: "too-large",
    };
  }
  const content = await git(cwd, ["show", `${tree}:${path}`]);
  const binary = content.includes("\0");
  return {
    index,
    path,
    state,
    sourceTree: tree,
    mode,
    objectType,
    blob,
    bytes,
    binary,
    ...(binary ? {} : { content }),
  };
}

async function loadTouchedFiles(
  cwd: string,
  diffBase: string,
  targetTree: string,
  paths: string[],
): Promise<EvidenceFile[]> {
  const files: EvidenceFile[] = [];
  let includedBytes = 0;
  for (const [index, path] of paths.entries()) {
    let file = await treeFile(cwd, targetTree, path, index, "present");
    if (file.state === "missing") {
      file = await treeFile(cwd, diffBase, path, index, "deleted");
    }
    if (file.content !== undefined) {
      const nextBytes = Buffer.byteLength(file.content);
      if (includedBytes + nextBytes > MAX_EVIDENCE_FILES_BYTES) {
        file = { ...file, content: undefined, omitted: "too-large" };
      } else {
        includedBytes += nextBytes;
      }
    }
    files.push(file);
  }
  return files;
}

interface RepoRuleOccurrence {
  path: string;
  line: number;
  text: string;
  parsed: RepoRuleLine;
}

interface RepoRuleScan {
  requests: Array<{ path: string; locator: string }>;
  occurrences: RepoRuleOccurrence[];
  markers: Map<string, number[]>;
}

// File content numbers its own lines; `git grep -n` output carries each line number
// after the known `<tree>:<path>:` prefix.
function scanRepoRuleLines(
  file: EvidenceFile,
  text: string,
  source: "content" | "grep",
  scan: RepoRuleScan,
  seen: Set<string>,
): void {
  const grepPrefix = `${file.sourceTree}:${file.path}:`;
  for (const [index, raw] of text.split("\n").entries()) {
    let line = index + 1;
    let body = raw;
    if (source === "grep") {
      if (!raw.startsWith(grepPrefix)) continue;
      const rest = raw.slice(grepPrefix.length);
      const colon = rest.indexOf(":");
      line = Number(rest.slice(0, colon));
      if (colon < 0 || !Number.isSafeInteger(line)) continue;
      body = rest.slice(colon + 1);
    }
    if (body.includes(OVERRIDE_MARKER)) {
      const markers = scan.markers.get(file.path) ?? [];
      markers.push(line);
      scan.markers.set(file.path, markers);
    }
    const parsed = parseRepoRuleLine(body);
    if (!parsed) continue;
    scan.occurrences.push({ path: file.path, line, text: body.trim(), parsed });
    if (parsed.kind !== "citation") continue;
    const key = `${parsed.path}\0${parsed.locator}`;
    if (!seen.has(key)) {
      seen.add(key);
      scan.requests.push({ path: parsed.path, locator: parsed.locator });
    }
  }
}

async function grepOmittedFileForCitations(cwd: string, file: EvidenceFile): Promise<string> {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C",
        cwd,
        "grep",
        "-n",
        "-I",
        // Fixed strings: grep.patternType or grep.extendedRegexp in the user's config
        // would otherwise read the marker's "(" as an unmatched group and exit 128.
        "-F",
        "-e",
        "repo-rule:",
        "-e",
        OVERRIDE_MARKER,
        file.sourceTree,
        "--",
        file.path,
      ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    if ((error as { code?: number }).code === 1) return "";
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git grep failed for evidence path: ${file.path}`);
  }
}

async function scanCitations(cwd: string, files: EvidenceFile[]): Promise<RepoRuleScan> {
  const scan: RepoRuleScan = { requests: [], occurrences: [], markers: new Map() };
  const seen = new Set<string>();
  for (const file of files) {
    if (file.content !== undefined) {
      scanRepoRuleLines(file, file.content, "content", scan, seen);
    } else if (file.objectType === "blob" && file.omitted === "too-large") {
      scanRepoRuleLines(file, await grepOmittedFileForCitations(cwd, file), "grep", scan, seen);
    }
  }
  if (scan.requests.length > MAX_EVIDENCE_CITATIONS) {
    throw new Error(
      `Hatch evidence contains ${scan.requests.length} repo-rule citations; limit is ${MAX_EVIDENCE_CITATIONS}`,
    );
  }
  return scan;
}

async function loadCitations(
  cwd: string,
  diffBase: string,
  targetTree: string,
  requests: RepoRuleScan["requests"],
): Promise<EvidenceCitation[]> {
  const citations: EvidenceCitation[] = [];
  for (const [index, request] of requests.entries()) {
    let file = await treeFile(cwd, targetTree, request.path, index, "present");
    if (file.state === "missing") {
      file = await treeFile(cwd, diffBase, request.path, index, "present");
    }
    citations.push({ ...file, locator: request.locator });
  }
  return citations;
}

// Line ranges `[start, end)` this diff added to one file, read from the `-U0` hunk
// headers only, so diff prefix settings in the user's config cannot change them.
// `--inter-hunk-context=0` keeps diff.interHunkContext from merging unchanged lines
// into an added range, and `--text` keeps a `-diff` attribute from hiding the hunks.
async function addedLineRanges(
  cwd: string,
  diffBase: string,
  targetTree: string,
  path: string,
): Promise<Array<[number, number]>> {
  const diff = await git(cwd, [
    "diff",
    "-U0",
    "--inter-hunk-context=0",
    "--text",
    "--no-color",
    "--no-ext-diff",
    diffBase,
    targetTree,
    "--",
    path,
  ]);
  const ranges: Array<[number, number]> = [];
  for (const header of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    if (count > 0) ranges.push([start, start + count]);
  }
  return ranges;
}

// A defect is a repo-rule line the item added within the marker window below a
// HATCH-SME-OVERRIDE marker that the host cannot resolve: a line it cannot parse, or
// a citation whose path is missing or is not a file. Only present touched files are
// scanned, so every line number is a line in the reviewed tree.
async function loadCitationDefects(
  cwd: string,
  diffBase: string,
  targetTree: string,
  files: EvidenceFile[],
  scan: RepoRuleScan,
  citations: EvidenceCitation[],
): Promise<EvidenceCitationDefect[]> {
  const present = new Set(files.filter((file) => file.state === "present").map((file) => file.path));
  const byRequest = new Map(citations.map((citation) => [`${citation.path}\0${citation.locator}`, citation]));
  const candidates: EvidenceCitationDefect[] = [];
  for (const occurrence of scan.occurrences) {
    if (!present.has(occurrence.path)) continue;
    const { parsed } = occurrence;
    let defect: Pick<EvidenceCitationDefect, "problem" | "cited" | "citation">;
    if (parsed.kind === "malformed") {
      defect = { problem: "malformed", ...(parsed.cited ? { cited: parsed.cited } : {}) };
    } else if (parsed.kind === "citation") {
      const citation = byRequest.get(`${parsed.path}\0${parsed.locator}`);
      if (!citation) continue;
      const problem = citation.state === "missing"
        ? "missing"
        : citation.omitted === "non-blob"
          ? "not-a-file"
          : undefined;
      if (!problem) continue;
      defect = { problem, cited: parsed.path, citation: citation.index };
    } else {
      continue;
    }
    const markers = scan.markers.get(occurrence.path) ?? [];
    if (!markers.some((marker) => occurrence.line >= marker && occurrence.line - marker <= MARKER_WINDOW_LINES)) {
      continue;
    }
    candidates.push({
      path: occurrence.path,
      line: occurrence.line,
      text: occurrence.text.slice(0, MAX_CITATION_DEFECT_TEXT),
      ...defect,
    });
  }
  const added = new Map<string, Array<[number, number]>>();
  for (const path of new Set(candidates.map((candidate) => candidate.path))) {
    added.set(path, await addedLineRanges(cwd, diffBase, targetTree, path));
  }
  return candidates
    .filter((candidate) =>
      (added.get(candidate.path) ?? []).some(([start, end]) => candidate.line >= start && candidate.line < end),
    )
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line)
    .slice(0, MAX_EVIDENCE_CITATION_DEFECTS);
}

export interface CitationReviewState {
  // Citation indexes the host could not show although the file exists (too large or
  // binary): a host limit the worker cannot repair.
  tooLarge: number[];
  // Citation indexes whose path is missing from both trees or is not a file.
  unverifiable: number[];
  // payload.citationDefects length.
  defects: number;
}

// The single source of the safety gate's citation rules.
export function citationReviewState(manifest: HatchEvidenceManifest): CitationReviewState {
  const tooLarge: number[] = [];
  const unverifiable: number[] = [];
  for (const citation of manifest.payload.citations) {
    if (citation.state === "missing" || citation.omitted === "non-blob") {
      unverifiable.push(citation.index);
    } else if (citation.omitted !== undefined || citation.content === undefined) {
      tooLarge.push(citation.index);
    }
  }
  return { tooLarge, unverifiable, defects: manifest.payload.citationDefects?.length ?? 0 };
}

// Each defect as `<path>:<line> (<problem>)`, then each unverifiable citation as
// Up to three defects by path and line, then the required shape, for a halt message.
export function citationDefectSentence(defects: readonly EvidenceCitationDefect[]): string {
  const shown = defects.slice(0, 3).map((defect) => `${defect.path}:${defect.line} (${defect.problem})`);
  const more = defects.length > 3 ? `, and ${defects.length - 3} more` : "";
  return `The evidence lists ${defects.length} repo-rule citation problem(s): ${shown.join(", ")}${more}.` +
    ` The required shape is \`${REPO_RULE_CITATION_SHAPE}\`.`;
}

// `citation <index> (<state>)`, for the safety gate's corrective turn.
export function citationProblemLabels(manifest: HatchEvidenceManifest): string[] {
  return [
    ...(manifest.payload.citationDefects ?? []).map(
      (defect) => `${defect.path}:${defect.line} (${defect.problem})`,
    ),
    ...manifest.payload.citations
      .filter((citation) => citation.state === "missing" || citation.omitted === "non-blob")
      .map((citation) => `citation ${citation.index} (${citation.state === "missing" ? "missing" : "non-blob"})`),
  ];
}

function packExtends(content: string): string | undefined {
  if (!content.startsWith("---\n")) return undefined;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  const match = content.slice(4, end).match(/^extends:\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/m);
  return match?.[1];
}

async function resolvePackDependencies(
  content: string,
  seen = new Set<string>(),
): Promise<EvidencePackDependency[]> {
  const parent = packExtends(content);
  if (!parent) return [];
  if (seen.has(parent)) throw new Error(`Hatch pack dependency cycle includes '${parent}'`);
  seen.add(parent);
  const relativePath = `skills/hatch-plan/references/sme/${parent}.md`;
  const parentContent = await readFile(requirePackagePath(relativePath), "utf8");
  if (Buffer.byteLength(parentContent) > MAX_PACK_BYTES) {
    throw new Error(`Hatch package pack dependency '${parent}' exceeds ${MAX_PACK_BYTES} bytes`);
  }
  return [
    { id: parent, path: relativePath, sha256: sha256(parentContent) },
    ...(await resolvePackDependencies(parentContent, seen)),
  ];
}

async function resolvePackChecklist(
  id: string,
  content: string,
): Promise<EvidenceChecklistItem[]> {
  const root = await mkdtemp(join(tmpdir(), "hatch-evidence-pack-"));
  const path = join(root, `${id}.md`);
  const environment = { ...process.env };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  environment.CLAUDE_PLUGIN_ROOT = requirePackagePath(".");
  environment.PYTHONNOUSERSITE = "1";
  environment.PYTHONSAFEPATH = "1";
  await writeFile(path, content);
  const timeout = uvTimeoutMs();
  try {
    const { stdout } = await exec(
      "uv",
      [
        "run",
        "--script",
        requirePackagePath("skills/hatch-kaizen/scripts/resolve_pack_checklist.py"),
        path,
      ],
      { encoding: "utf8", env: environment, timeout, maxBuffer: 2 * 1024 * 1024 },
    );
    const checklist = JSON.parse(stdout) as unknown;
    if (
      !Array.isArray(checklist) ||
      !checklist.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof (item as EvidenceChecklistItem).id === "string" &&
          typeof (item as EvidenceChecklistItem).text === "string" &&
          typeof (item as EvidenceChecklistItem).source === "string",
      )
    ) {
      throw new Error(`Hatch pack '${id}' resolver returned an invalid checklist`);
    }
    return checklist as EvidenceChecklistItem[];
  } catch (error) {
    throw uvFailure(error, "resolve_pack_checklist.py", timeout, `Hatch pack '${id}' checklist resolution failed`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validReceipt(receipt: HatchCheckReceipt, targetTree: string): boolean {
  return (
    receipt.schema === "hatch-check-receipt-v1" &&
    receipt.targetTree === targetTree &&
    /^[a-f0-9]{64}$/.test(receipt.commandHash) &&
    typeof receipt.cwd === "string" &&
    !receipt.cwd.startsWith("/") &&
    !receipt.cwd.replaceAll("\\", "/").split("/").includes("..") &&
    ["passed", "failed"].includes(receipt.status) &&
    Number.isInteger(receipt.code) &&
    (receipt.status !== "passed" || receipt.code === 0) &&
    (receipt.status !== "failed" || receipt.code !== 0) &&
    typeof receipt.stdout === "string" &&
    typeof receipt.stderr === "string" &&
    typeof receipt.stdoutTruncated === "boolean" &&
    typeof receipt.stderrTruncated === "boolean" &&
    Number.isFinite(receipt.durationMs) &&
    receipt.durationMs >= 0 &&
    Buffer.byteLength(receipt.stdout) <= 64 * 1024 &&
    Buffer.byteLength(receipt.stderr) <= 64 * 1024
  );
}

function checkManifestEvidence(
  workItem: Record<string, unknown>,
  targetTree: string,
  manifest: HatchCheckManifest | undefined,
): HatchCheckManifestEvidence {
  const oracle = workItem.oracle;
  if (!oracle || typeof oracle !== "object" || Array.isArray(oracle)) {
    throw new Error("Hatch work item has no valid oracle after binder validation");
  }
  const command = (oracle as Record<string, unknown>).command;
  if (command !== undefined && (typeof command !== "string" || !command.trim())) {
    throw new Error("Hatch oracle command is invalid after binder validation");
  }
  if (!manifest) {
    return { status: command === undefined ? "not-required" : "missing", targetTree };
  }
  if (
    manifest.schema !== "hatch-check-manifest-v1" ||
    manifest.targetTree !== targetTree ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length === 0 ||
    manifest.entries.length > 32
  ) {
    throw new Error("Hatch check manifest does not bind to the candidate tree");
  }
  const ids = new Set<string>();
  for (const [index, entry] of manifest.entries.entries()) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) ||
      ids.has(entry.id) ||
      entry.sequence !== index ||
      !["floor", "oracle"].includes(entry.purpose) ||
      entry.required !== true ||
      entry.preTree !== targetTree ||
      entry.postTree !== targetTree ||
      !/^[a-f0-9]{64}$/.test(entry.environmentHash) ||
      !validReceipt(entry.receipt, targetTree)
    ) {
      throw new Error("Hatch check manifest contains a malformed, duplicate, reordered, or stale entry");
    }
    ids.add(entry.id);
  }
  const oracleEntries = manifest.entries.filter((entry) => entry.purpose === "oracle");
  if (typeof command === "string") {
    const expectedCwd = String((oracle as Record<string, unknown>).cwd ?? ".");
    if (
      oracleEntries.length !== 1 ||
      oracleEntries[0].receipt.commandHash !== hashCheckCommand(command) ||
      oracleEntries[0].receipt.cwd !== expectedCwd
    ) {
      throw new Error("Hatch check manifest does not contain the required binder oracle");
    }
  } else if (oracleEntries.length !== 0) {
    throw new Error("Hatch check manifest contains an oracle not required by the binder");
  }
  return {
    status: manifest.entries.some((entry) => entry.receipt.status === "failed")
      ? "failed"
      : "passed",
    targetTree,
    manifest,
  };
}

async function loadPacks(
  cwd: string,
  policyTip: string,
  ids: string[],
): Promise<EvidencePack[]> {
  const packs: EvidencePack[] = [];
  for (const id of ids) {
    const projectPath = `.hatch/sme/${id}.md`;
    const projectListing = await git(cwd, ["ls-tree", "-z", policyTip, "--", projectPath]);
    if (projectListing) {
      const projectContent = await git(cwd, ["show", `${policyTip}:${projectPath}`]);
      const blob = (await git(cwd, ["rev-parse", `${policyTip}:${projectPath}`])).trim();
      if (Buffer.byteLength(projectContent) > MAX_PACK_BYTES) {
        throw new Error(`Hatch project pack '${id}' exceeds ${MAX_PACK_BYTES} bytes`);
      }
      packs.push({
        id,
        source: "project",
        path: projectPath,
        blob,
        sha256: sha256(projectContent),
        dependencies: await resolvePackDependencies(projectContent),
        checklist: await resolvePackChecklist(id, projectContent),
      });
      continue;
    }
    const packagePath = requirePackagePath(`skills/hatch-plan/references/sme/${id}.md`);
    const packageContent = await readFile(packagePath, "utf8");
    if (Buffer.byteLength(packageContent) > MAX_PACK_BYTES) {
      throw new Error(`Hatch package pack '${id}' exceeds ${MAX_PACK_BYTES} bytes`);
    }
    packs.push({
      id,
      source: "package",
      path: relative(requirePackagePath("."), packagePath).split(sep).join("/"),
      sha256: sha256(packageContent),
      dependencies: await resolvePackDependencies(packageContent),
      checklist: await resolvePackChecklist(id, packageContent),
    });
  }
  return packs;
}

export async function buildHatchEvidence(
  options: BuildEvidenceOptions,
): Promise<HatchEvidenceManifest> {
  validateIdentifier("binder slug", options.binder);
  validateIdentifier("item id", options.item);
  const repositoryRoot = resolve(
    (await git(options.cwd, ["rev-parse", "--show-toplevel"])).trim(),
  );
  const integrationRef = `refs/heads/hatch/${options.binder}/integration`;
  const itemBranch = `hatch/${options.binder}/item-${options.item}`;
  const itemRef = `refs/heads/${itemBranch}`;
  const [integrationTip, itemTip] = await Promise.all([
    git(repositoryRoot, ["rev-parse", "--verify", `${integrationRef}^{commit}`]),
    git(repositoryRoot, ["rev-parse", "--verify", `${itemRef}^{commit}`]),
  ]).then((values) => values.map((value) => value.trim()));
  const target = await resolveEvidenceTarget(
    repositoryRoot,
    itemBranch,
    integrationTip,
    itemTip,
    options.target ?? "auto",
  );
  const mergeBase = target.kind === "landed-merge-tip"
    ? (await git(repositoryRoot, ["rev-parse", `${integrationTip}^1`])).trim()
    : (await git(repositoryRoot, ["merge-base", integrationTip, itemTip])).trim();
  const policyTip = target.kind === "landed-merge-tip" ? mergeBase : integrationTip;
  // The reviewed diff must show only the item's own effect. Against the current
  // integration tip that is `tip..itemTree`, but when the item was committed on an
  // older base and the tip has since moved, the two-dot range shows the tip's newer
  // changes as if the item reverted them (a host commit to `.hatch/environment.json`
  // reads as an out-of-scope revert). `mergeBase` is the item's true base; the merge
  // tree already contains the tip's changes, so it keeps the tip as its base.
  const diffBase = target.kind === "merge-tree" ? integrationTip : mergeBase;
  const binderPath = `.hatch/binders/${options.binder}.json`;
  const binderRaw = await git(repositoryRoot, ["show", `${policyTip}:${binderPath}`]);
  if (Buffer.byteLength(binderRaw) > MAX_BINDER_BYTES) {
    throw new Error(`Hatch binder '${options.binder}' exceeds ${MAX_BINDER_BYTES} bytes`);
  }
  const parsedBinder = parseBinder(binderRaw, options.binder, options.item);
  await validateBinderSource(binderRaw, options.binder);
  const binderBlob = (await git(repositoryRoot, ["rev-parse", `${policyTip}:${binderPath}`])).trim();
  const { document, workItem } = parsedBinder;
  const [diffContent, touchedRaw] = await Promise.all([
    git(repositoryRoot, [
      "diff",
      "--binary",
      "--no-color",
      "--no-ext-diff",
      diffBase,
      target.tree,
      "--",
    ]),
    git(repositoryRoot, [
      "diff",
      "--name-only",
      "-z",
      "--no-ext-diff",
      diffBase,
      target.tree,
      "--",
    ]),
  ]);
  const diffBytes = Buffer.byteLength(diffContent);
  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES;
  if (diffBytes > maxDiffBytes) {
    throw new Error(`Hatch evidence diff is ${diffBytes} bytes; limit is ${maxDiffBytes}`);
  }
  const touchedPaths = touchedRaw.split("\0").filter(Boolean).sort();
  touchedPaths.forEach(validateGitPath);
  const [packs, files] = await Promise.all([
    loadPacks(repositoryRoot, policyTip, document.sme ?? []),
    loadTouchedFiles(repositoryRoot, diffBase, target.tree, touchedPaths),
  ]);
  const citationScan = await scanCitations(repositoryRoot, files);
  const citations = await loadCitations(
    repositoryRoot,
    diffBase,
    target.tree,
    citationScan.requests,
  );
  const citationDefects = await loadCitationDefects(
    repositoryRoot,
    diffBase,
    target.tree,
    files,
    citationScan,
    citations,
  );
  const checks = {
    manifest: checkManifestEvidence(workItem, target.tree, options.checkManifest),
  };
  const payload: HatchEvidencePayload = {
    binder: {
      slug: options.binder,
      path: binderPath,
      blob: binderBlob,
      sha256: sha256(binderRaw),
      document,
    },
    workItem,
    relations: resolveItemRelations(document.work_items, workItem.id, document.supersedes),
    git: {
      integrationRef,
      integrationTip,
      itemRef,
      itemTip,
      mergeBase,
      diffBase,
      targetKind: target.kind,
      targetTree: target.tree,
    },
    diff: {
      format: "git-binary-patch",
      sha256: sha256(diffContent),
      bytes: diffBytes,
      touchedPaths,
      content: diffContent,
    },
    checks,
    files,
    citations,
    ...(citationDefects.length > 0 ? { citationDefects } : {}),
    packs,
  };
  return {
    schema: "hatch-evidence-v2",
    generatedAt: new Date().toISOString(),
    repositoryRoot,
    evidenceHash: hashEvidencePayload(payload),
    payload,
  };
}

export function verifyEvidenceIntegrity(manifest: HatchEvidenceManifest): void {
  if (manifest.schema !== "hatch-evidence-v2") throw new Error("Unknown Hatch evidence schema");
  const actual = hashEvidencePayload(manifest.payload);
  if (actual !== manifest.evidenceHash) {
    throw new Error(`Hatch evidence hash mismatch: expected ${manifest.evidenceHash}, found ${actual}`);
  }
}

export async function verifyEvidenceFreshness(manifest: HatchEvidenceManifest): Promise<void> {
  verifyEvidenceIntegrity(manifest);
  const { git: evidenceGit } = manifest.payload;
  const [integrationTip, itemTip] = await Promise.all([
    git(manifest.repositoryRoot, ["rev-parse", "--verify", `${evidenceGit.integrationRef}^{commit}`]),
    git(manifest.repositoryRoot, ["rev-parse", "--verify", `${evidenceGit.itemRef}^{commit}`]),
  ]).then((values) => values.map((value) => value.trim()));
  if (integrationTip !== evidenceGit.integrationTip || itemTip !== evidenceGit.itemTip) {
    throw new Error("Hatch evidence is stale because a bound Git tip moved");
  }
  const expectedDiffBase = evidenceGit.targetKind === "merge-tree"
    ? integrationTip
    : evidenceGit.targetKind === "landed-merge-tip"
      ? (await git(manifest.repositoryRoot, ["rev-parse", `${integrationTip}^1`])).trim()
      : (await git(manifest.repositoryRoot, ["merge-base", integrationTip, itemTip])).trim();
  if (evidenceGit.diffBase !== expectedDiffBase) {
    throw new Error("Hatch evidence is stale because its diff base changed");
  }
  if (evidenceGit.targetKind === "candidate-tree") {
    const expectedBranch = evidenceGit.itemRef.replace(/^refs\/heads\//, "");
    const candidate = await candidateTree(manifest.repositoryRoot, expectedBranch);
    if (!candidate || candidate.tree !== evidenceGit.targetTree) {
      throw new Error("Hatch evidence is stale because the staged candidate tree changed");
    }
  } else if (evidenceGit.targetKind === "committed-tip") {
    const tree = (await git(manifest.repositoryRoot, ["rev-parse", `${itemTip}^{tree}`])).trim();
    if (tree !== evidenceGit.targetTree) {
      throw new Error("Hatch evidence is stale because the committed item tree changed");
    }
  } else if (evidenceGit.targetKind === "merge-tree") {
    const tree = await mergeTree(manifest.repositoryRoot, integrationTip, itemTip);
    if (tree !== evidenceGit.targetTree) {
      throw new Error("Hatch evidence is stale because the proposed merge tree changed");
    }
  } else if (evidenceGit.targetKind === "landed-merge-tip") {
    const parents = (await git(manifest.repositoryRoot, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      integrationTip,
    ])).trim().split(/\s+/).slice(1);
    const tree = (await git(manifest.repositoryRoot, ["rev-parse", `${integrationTip}^{tree}`])).trim();
    if (parents.length !== 2 || parents[1] !== itemTip || tree !== evidenceGit.targetTree) {
      throw new Error("Hatch evidence is stale because the landed item merge changed");
    }
  }
}

const evidenceReadParameters = ActionUnion([
  Type.Object({ action: Type.Literal("summary") }),
  Type.Object({ action: Type.Literal("binder") }),
  Type.Object({ action: Type.Literal("workItem") }),
  Type.Object({
    action: Type.Literal("diff"),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIFF_PAGE })),
  }),
  Type.Object({
    action: Type.Literal("touchedFile"),
    index: Type.Integer({ minimum: 0 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIFF_PAGE })),
  }),
  Type.Object({
    action: Type.Literal("citation"),
    index: Type.Integer({ minimum: 0 }),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_DIFF_PAGE })),
  }),
  Type.Object({ action: Type.Literal("pack"), id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }) }),
]);

type EvidenceReadParameters = Static<typeof evidenceReadParameters>;

interface EvidenceReadDetails {
  action: EvidenceReadParameters["action"];
  evidenceHash: string;
  totalLength?: number;
  nextOffset?: number;
}

export function createEvidenceReadTool(
  manifest: HatchEvidenceManifest,
): ToolDefinition<typeof evidenceReadParameters, EvidenceReadDetails> {
  verifyEvidenceIntegrity(manifest);
  return {
    name: "hatch_evidence",
    label: "Hatch evidence",
    description:
      "Read fixed, hash-bound Hatch evidence. It cannot read arbitrary files, paths, refs, or commands.",
    parameters: evidenceReadParameters,
    async execute(_toolCallId, params) {
      try {
        let value: unknown;
        let totalLength: number | undefined;
        let nextOffset: number | undefined;
        switch (params.action) {
          case "summary":
            value = {
              schema: manifest.schema,
              evidenceHash: manifest.evidenceHash,
              binder: manifest.payload.binder.slug,
              item: manifest.payload.workItem.id,
              git: manifest.payload.git,
              diff: {
                sha256: manifest.payload.diff.sha256,
                bytes: manifest.payload.diff.bytes,
                touchedPaths: manifest.payload.diff.touchedPaths,
              },
              files: manifest.payload.files.map(({ content: _content, ...metadata }) => metadata),
              citations: manifest.payload.citations.map(({ content: _content, ...metadata }) => metadata),
              citationDefects: manifest.payload.citationDefects ?? [],
              packs: manifest.payload.packs.map(({ id, source, path, blob, sha256: packHash, checklist }) => ({
                id,
                source,
                path,
                blob,
                sha256: packHash,
                checklistItems: checklist.length,
              })),
            };
            break;
          case "binder":
            value = manifest.payload.binder.document;
            break;
          case "workItem":
            // The gate prompt requires this action, so the path direction travels with
            // it: a gate that read the item cannot report a planned overlap between two
            // items joined by a `depends_on` path as an undeclared edit.
            value = { ...manifest.payload.workItem, relations: manifest.payload.relations };
            break;
          case "diff": {
            const offset = params.offset ?? 0;
            const limit = params.limit ?? DEFAULT_DIFF_PAGE;
            totalLength = manifest.payload.diff.content.length;
            const page = manifest.payload.diff.content.slice(offset, offset + limit);
            const end = offset + page.length;
            if (end < totalLength) nextOffset = end;
            // The page is the only thing the reviewing model sees; `details` is host
            // telemetry it never reads. Without an in-band range line a truncated page
            // is indistinguishable from a whole diff, and a gate that cannot tell the
            // difference either blocks on evidence it was handed or passes on a
            // fraction of it. State the range every time, so "I read all of it" is a
            // fact the page carries rather than an inference from the absence of a
            // marker.
            value = `${page}\n${diffPageFooter(offset, end, totalLength, nextOffset)}`;
            break;
          }
          case "touchedFile":
          case "citation": {
            const entries =
              params.action === "touchedFile" ? manifest.payload.files : manifest.payload.citations;
            const entry = entries[params.index];
            if (!entry) throw new Error(`${params.action} index ${params.index} is not in this evidence manifest`);
            const content = entry.content ?? "";
            const offset = params.offset ?? 0;
            const limit = params.limit ?? DEFAULT_DIFF_PAGE;
            totalLength = content.length;
            const page = content.slice(offset, offset + limit);
            const end = offset + page.length;
            if (end < totalLength) nextOffset = end;
            value = {
              ...entry,
              content: page,
              pageOffset: offset,
              pageEnd: end,
              totalLength,
              truncated: nextOffset !== undefined,
              ...(nextOffset === undefined ? {} : { nextOffset }),
            };
            break;
          }
          case "pack": {
            const pack = manifest.payload.packs.find((candidate) => candidate.id === params.id);
            if (!pack) throw new Error(`Pack '${params.id}' is not in this evidence manifest`);
            value = pack;
            break;
          }
        }
        return {
          content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
          details: {
            action: params.action,
            evidenceHash: manifest.evidenceHash,
            totalLength,
            nextOffset,
          },
          isError: false,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { action: params.action, evidenceHash: manifest.evidenceHash },
          isError: true,
        };
      }
    },
  };
}
