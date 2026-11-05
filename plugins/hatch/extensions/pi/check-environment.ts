import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { resolve } from "node:path";
import type { HatchEnvironmentConfig } from "./environment.ts";

// Why a check that passed in an item worktree can fail at merge: the host reruns the
// floor and oracle in a fresh worktree provisioned only by the integration ref's
// `.hatch/environment.json` setup, while the worker installed dependencies into its own
// item worktree. This module names that gap deterministically. `resolveInstallNeeds`
// maps a command onto the gitignored install directory it relies on, from a closed
// table of runners and the committed manifests; `diagnoseCheckFailure` stats that
// directory in the worktree a check just failed in; `environmentPreflight` applies the
// same rule to the binder's oracles before any build starts. No output text decides
// anything here: a diagnosis only adds words to a halt that already happened.

export type HatchCheckSite = "item" | "fresh-merge" | "fresh-parity" | "integration";

export type HatchCheckDiagnosisStatus =
  | "failed"
  | "timed-out"
  | "aborted"
  | "non-converging"
  | "precondition-unmet";

export interface HatchCheckDiagnosis {
  checkId: string; // plan id, or "environment-setup" / "environment-preflight"
  command: string; // verbatim (INV-27); clipped only when formatted for display
  cwd: string;
  status: HatchCheckDiagnosisStatus;
  exitCode: number | null;
  excerpt: string; // last <= 6 non-empty lines of stderr, else stdout, <= 360 chars
  site: HatchCheckSite;
  setupDeclared: boolean;
  missing?: { installDir: string; manifest: string }; // a stat result, not an output guess
  remediation?: string;
}

// Reads one file from the tree being judged (a committed ref for preflight, the check
// worktree for a diagnosis). Returns undefined when the path is absent.
export type ReadTreeFile = (path: string) => Promise<string | undefined>;

// Whether one path exists in that tree, without reading it.
export type TreeFileExists = (path: string) => Promise<boolean>;

export interface HatchInstallNeed {
  runner: string;
  command: string; // the command segment that matched
  dir: string; // worktree-relative directory the runner works in
  installDir: string; // worktree-relative install directory it relies on
  manifest: string; // the committed file that establishes the need
  lockfile?: string; // basename of the lockfile kind, when one was found
  // True when the install directory's location is fixed by the runner, so a stat of it
  // in the worktree is meaningful. Tool-managed environments (poetry, pipenv, pdm,
  // bundler) may live outside the worktree, so their absence proves nothing.
  statable: boolean;
}

const NODE_LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];
const PYTHON_LOCKFILES: Record<string, string[]> = {
  poetry: ["poetry.lock", "pyproject.toml"],
  pipenv: ["Pipfile.lock"],
  pdm: ["pdm.lock", "pyproject.toml"],
  venv: ["poetry.lock", "Pipfile.lock", "pdm.lock", "pyproject.toml"],
};

const EXCERPT_LINES = 6;
const EXCERPT_CHARS = 360;
const COMMAND_DISPLAY_CHARS = 200;

// Split on &&, ||, ;, | and newlines outside quotes. Each segment keeps the separator
// that ended it so a `cd` is followed only across `&&` and `;`.
function splitSegments(command: string): { text: string; next: string }[] {
  const segments: { text: string; next: string }[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += char + command[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      current += char;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += char + command[index + 1];
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = command.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      segments.push({ text: current, next: pair });
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "\n") {
      segments.push({ text: current, next: char === "\n" ? ";" : char });
      current = "";
      continue;
    }
    current += char;
  }
  segments.push({ text: current, next: "" });
  return segments.filter((segment) => segment.text.trim());
}

function words(segment: string): string[] {
  const out: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && index + 1 < segment.length) {
        current += segment[index + 1];
        index += 1;
      } else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\" && index + 1 < segment.length) {
      current += segment[index + 1];
      started = true;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) out.push(current);
      current = "";
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) out.push(current);
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripWrappers(argv: string[]): string[] {
  let rest = [...argv];
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    if (rest[0] === "env") {
      rest = rest.slice(1);
      continue;
    }
    if (rest[0] === "mise" && rest[1] === "exec") {
      const separator = rest.indexOf("--");
      if (separator < 0) return [];
      rest = rest.slice(separator + 1);
      continue;
    }
    return rest;
  }
}

// Join a relative directory onto the current one; undefined when it is absolute or
// leaves the worktree, which stops resolution rather than guessing.
function joinDir(base: string, target: string): string | undefined {
  if (!target || target.startsWith("/") || target.startsWith("~") || target.includes("$")) {
    return undefined;
  }
  const joined = posix.normalize(posix.join(base, target.replaceAll("\\", "/")));
  if (joined === ".." || joined.startsWith("../")) return undefined;
  return joined === "" ? "." : joined.replace(/\/$/, "");
}

function inDir(dir: string, name: string): string {
  return dir === "." ? name : `${dir}/${name}`;
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let current = dir;
  for (;;) {
    out.push(current);
    if (current === ".") return out;
    const parent = posix.dirname(current);
    current = parent === "" ? "." : parent;
  }
}

// The resolver's view of the tree: file content where a rule reads it (package.json),
// and existence alone where presence is the rule (lockfiles), so a lockfile too large to
// read still counts. Either failing counts as absent.
interface TreeAccess {
  read: ReadTreeFile;
  exists: TreeFileExists;
}

async function safeRead(tree: TreeAccess, path: string): Promise<string | undefined> {
  try {
    return await tree.read(path);
  } catch {
    return undefined;
  }
}

async function safeExists(tree: TreeAccess, path: string): Promise<boolean> {
  try {
    return await tree.exists(path);
  } catch {
    return false;
  }
}

function declaresDependencies(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return ["dependencies", "devDependencies"].some((key) => {
      const value = parsed[key];
      return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
    });
  } catch {
    return false;
  }
}

// The nearest node manifest at `dir` or an ancestor: a lockfile, else a package.json
// that declares dependencies.
async function nodeManifest(
  dir: string,
  tree: TreeAccess,
): Promise<{ manifest: string; lockfile?: string } | undefined> {
  for (const candidate of ancestors(dir)) {
    for (const lockfile of NODE_LOCKFILES) {
      const path = inDir(candidate, lockfile);
      if (await safeExists(tree, path)) return { manifest: path, lockfile };
    }
    const packageJson = inDir(candidate, "package.json");
    if (declaresDependencies(await safeRead(tree, packageJson))) {
      return { manifest: packageJson };
    }
  }
  return undefined;
}

async function firstFile(
  dir: string,
  names: string[],
  tree: TreeAccess,
): Promise<{ manifest: string; lockfile: string } | undefined> {
  for (const candidate of ancestors(dir)) {
    for (const name of names) {
      const path = inDir(candidate, name);
      if (await safeExists(tree, path)) return { manifest: path, lockfile: name };
    }
  }
  return undefined;
}

// Read a runner's options: the first positional word is its subcommand, and a recognized
// directory option counts wherever it appears (`npm run lint --prefix frontend`), up to a
// bare `--`, after which the words belong to the script.
function parseRunner(
  args: string[],
  dirOptions: string[],
  valueOptions: string[],
): { subcommand?: string; target?: string } {
  let target: string | undefined;
  let subcommand: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    const [name, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (dirOptions.includes(name)) {
      target = inline ?? args[index + 1];
      if (inline === undefined) index += 1;
      continue;
    }
    if (subcommand === undefined && valueOptions.includes(name)) {
      if (inline === undefined) index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    subcommand ??= arg;
  }
  return { subcommand, target };
}

// The directory an install command provisions, from a closed list; undefined for
// anything else. A later segment of the same command that needs that directory's
// install is then satisfied (`npm ci && npm test`).
function installedDir(argv: string[], dir: string): string | undefined {
  const [argv0, ...args] = argv;
  const at = (target: string | undefined) => (target ? joinDir(dir, target) : dir);
  switch (argv0) {
    case "npm": {
      const parsed = parseRunner(args, ["--prefix", "-C", "-w", "--workspace"], []);
      return ["ci", "install", "i"].includes(parsed.subcommand ?? "") ? at(parsed.target) : undefined;
    }
    case "pnpm": {
      const parsed = parseRunner(args, ["-C", "--dir"], ["--filter", "-F"]);
      return ["install", "i"].includes(parsed.subcommand ?? "") ? at(parsed.target) : undefined;
    }
    case "yarn":
    case "bun": {
      const parsed = parseRunner(args, ["--cwd"], []);
      return parsed.subcommand === "install" ? at(parsed.target) : undefined;
    }
    case "uv": {
      const parsed = parseRunner(args, ["--directory", "--project"], []);
      return parsed.subcommand === "sync" ? at(parsed.target) : undefined;
    }
    case "poetry": {
      const parsed = parseRunner(args, ["-C", "--directory"], []);
      return parsed.subcommand === "install" ? at(parsed.target) : undefined;
    }
    case "bundle":
      return args[0] === "install" ? dir : undefined;
    default:
      return undefined;
  }
}

async function nodeNeed(
  runner: string,
  segment: string,
  dir: string | undefined,
  tree: TreeAccess,
): Promise<HatchInstallNeed | undefined> {
  if (dir === undefined) return undefined;
  const found = await nodeManifest(dir, tree);
  if (!found) return undefined;
  return {
    runner,
    command: segment,
    dir,
    installDir: inDir(dir, "node_modules"),
    manifest: found.manifest,
    lockfile: found.lockfile,
    statable: true,
  };
}

async function matchSegment(
  argv: string[],
  segment: string,
  dir: string,
  tree: TreeAccess,
): Promise<HatchInstallNeed | undefined> {
  const [argv0, ...args] = argv;
  if (!argv0) return undefined;
  const normalized = argv0.replaceAll("\\", "/");
  const binIndex = normalized.indexOf("node_modules/.bin/");
  if (binIndex >= 0) {
    const installDir = joinDir(dir, normalized.slice(0, binIndex + "node_modules".length));
    if (installDir === undefined) return undefined;
    const owner = posix.dirname(installDir) === "" ? "." : posix.dirname(installDir);
    const found = await nodeManifest(owner, tree);
    return {
      runner: "node_modules/.bin",
      command: segment,
      dir,
      installDir,
      manifest: found?.manifest ?? inDir(owner, "package.json"),
      lockfile: found?.lockfile,
      statable: true,
    };
  }
  const venvIndex = normalized.indexOf(".venv/bin/");
  if (venvIndex >= 0) {
    const installDir = joinDir(dir, normalized.slice(0, venvIndex + ".venv".length));
    if (installDir === undefined) return undefined;
    const owner = posix.dirname(installDir) === "" ? "." : posix.dirname(installDir);
    const found = await firstFile(owner, PYTHON_LOCKFILES.venv, tree);
    return {
      runner: ".venv/bin",
      command: segment,
      dir,
      installDir,
      manifest: found?.manifest ?? inDir(owner, "pyproject.toml"),
      lockfile: found?.lockfile,
      statable: true,
    };
  }
  switch (argv0) {
    case "npm": {
      const parsed = parseRunner(args, ["--prefix", "-C", "-w", "--workspace"], []);
      if (!["run", "run-script", "test", "t", "start", "exec", "x"].includes(parsed.subcommand ?? "")) {
        return undefined;
      }
      return nodeNeed("npm", segment, parsed.target ? joinDir(dir, parsed.target) : dir, tree);
    }
    case "npx":
    case "bunx":
      return nodeNeed(argv0, segment, dir, tree);
    case "pnpm": {
      const parsed = parseRunner(args, ["-C", "--dir"], ["--filter", "-F"]);
      if (!parsed.subcommand || ["install", "i", "add", "ci"].includes(parsed.subcommand)) return undefined;
      return nodeNeed("pnpm", segment, parsed.target ? joinDir(dir, parsed.target) : dir, tree);
    }
    case "yarn": {
      const parsed = parseRunner(args, ["--cwd"], []);
      if (!parsed.subcommand || ["install", "add"].includes(parsed.subcommand)) return undefined;
      return nodeNeed("yarn", segment, parsed.target ? joinDir(dir, parsed.target) : dir, tree);
    }
    case "bun": {
      const parsed = parseRunner(args, ["--cwd"], []);
      if (!["run", "test", "x"].includes(parsed.subcommand ?? "")) return undefined;
      return nodeNeed("bun", segment, parsed.target ? joinDir(dir, parsed.target) : dir, tree);
    }
    case "poetry":
    case "pipenv":
    case "pdm": {
      const parsed = parseRunner(args, argv0 === "poetry" ? ["-C", "--directory"] : [], []);
      if (parsed.subcommand !== "run") return undefined;
      const target = parsed.target ? joinDir(dir, parsed.target) : dir;
      if (target === undefined) return undefined;
      const found = await firstFile(target, PYTHON_LOCKFILES[argv0], tree);
      if (!found) return undefined;
      return {
        runner: argv0,
        command: segment,
        dir: target,
        installDir: inDir(posix.dirname(found.manifest) || ".", ".venv"),
        manifest: found.manifest,
        lockfile: found.lockfile,
        statable: false,
      };
    }
    case "bundle": {
      if (args[0] !== "exec") return undefined;
      const found = await firstFile(dir, ["Gemfile.lock"], tree);
      if (!found) return undefined;
      return {
        runner: "bundle",
        command: segment,
        dir,
        installDir: inDir(posix.dirname(found.manifest) || ".", "vendor/bundle"),
        manifest: found.manifest,
        lockfile: found.lockfile,
        statable: false,
      };
    }
    default:
      return undefined;
  }
}

// Every install a command relies on, from a closed table of runners. Opaque commands
// (make, just, scripts, bare tool names) and self-provisioning ones (uv, cargo, go,
// mvn, gradle) never match: they are this rule's false negatives, and the diagnosis
// on a real halt covers them.
export async function resolveInstallNeeds(
  command: string,
  cwd: string,
  readTreeFile: ReadTreeFile,
  fileExists?: TreeFileExists,
): Promise<HatchInstallNeed[]> {
  const tree: TreeAccess = {
    read: readTreeFile,
    exists: fileExists ?? (async (path) => (await readTreeFile(path)) !== undefined),
  };
  const needs: HatchInstallNeed[] = [];
  const installed = new Set<string>();
  let dir: string | undefined = joinDir(".", cwd || ".");
  let followCd = true;
  for (const segment of splitSegments(command)) {
    if (dir === undefined) break;
    const argv = stripWrappers(words(segment.text));
    if (argv[0] === "cd") {
      dir = followCd && argv.length === 2 ? joinDir(dir, argv[1]) : undefined;
    } else {
      const provisioned = installedDir(argv, dir);
      if (provisioned !== undefined) installed.add(provisioned);
      const need = await matchSegment(argv, segment.text.trim(), dir, tree);
      if (
        need &&
        !installed.has(need.dir) &&
        !needs.some((seen) => seen.installDir === need.installDir && seen.runner === need.runner)
      ) {
        needs.push(need);
      }
    }
    followCd = segment.next === "&&" || segment.next === ";";
  }
  return needs;
}

export function excerptOf(result: { stdout?: string; stderr?: string } | undefined): string {
  const pick = (text: string | undefined) =>
    (text ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  const stderr = pick(result?.stderr);
  const lines = (stderr.length > 0 ? stderr : pick(result?.stdout)).slice(-EXCERPT_LINES);
  const text = lines.join("\n");
  return text.length > EXCERPT_CHARS ? text.slice(text.length - EXCERPT_CHARS) : text;
}

function branchName(ref: string | undefined): string {
  if (!ref) return "the integration branch";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// Node resolution walks up from the package, so a hoisted workspace install counts.
async function installPresent(worktree: string, need: HatchInstallNeed): Promise<boolean> {
  if (await exists(resolve(worktree, need.installDir))) return true;
  if (!need.installDir.endsWith("node_modules")) return false;
  const manifestDir = posix.dirname(need.manifest) || ".";
  for (const candidate of ancestors(need.dir)) {
    if (await exists(resolve(worktree, inDir(candidate, "node_modules")))) return true;
    if (candidate === manifestDir) break;
  }
  return false;
}

export interface DiagnoseCheckFailureInput {
  worktree: string;
  checkId: string;
  command: string;
  cwd: string;
  status: HatchCheckDiagnosisStatus;
  result?: { code: number | null; stdout?: string; stderr?: string };
  site: HatchCheckSite;
  setupDeclared: boolean;
  environmentSetupRef?: string;
}

export async function diagnoseCheckFailure(
  input: DiagnoseCheckFailureInput,
): Promise<HatchCheckDiagnosis> {
  const diagnosis: HatchCheckDiagnosis = {
    checkId: input.checkId,
    command: input.command,
    cwd: input.cwd,
    status: input.status,
    exitCode: input.result?.code ?? null,
    excerpt: excerptOf(input.result),
    site: input.site,
    setupDeclared: input.setupDeclared,
  };
  let needs: HatchInstallNeed[] = [];
  try {
    needs = await resolveInstallNeeds(input.command, input.cwd, async (path) => {
      try {
        return await readFile(resolve(input.worktree, path), "utf8");
      } catch {
        return undefined;
      }
    });
  } catch {
    needs = [];
  }
  for (const need of needs) {
    if (!need.statable || (await installPresent(input.worktree, need))) continue;
    diagnosis.missing = { installDir: need.installDir, manifest: need.manifest };
    diagnosis.remediation = input.setupDeclared
      ? `The declared setup did not create \`${need.installDir}\`; extend it.`
      : `\`${need.installDir}\` does not exist in this check worktree and \`${branchName(input.environmentSetupRef)}\` declares no \`.hatch/environment.json\` setup. Commit a setup that installs it on that branch, then choose Fix and rerun; Fix and rerun fails the same way until then.`;
    break;
  }
  return diagnosis;
}

const SITE_TEXT: Record<HatchCheckSite, string> = {
  item: "the item worktree",
  "fresh-merge": "a fresh merge worktree",
  "fresh-parity": "a fresh parity worktree",
  integration: "the integration worktree",
};

function clip(text: string, limit: number): string {
  if (limit <= 0) return "";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

// Keep the end of the text: a command's last output line is usually the error.
function clipTail(text: string, limit: number): string {
  if (limit <= 0) return "";
  return text.length > limit ? `…${text.slice(text.length - Math.max(0, limit - 1))}` : text;
}

// One block of text for a halt reason or prompt. The header and remediation come
// first so the excerpt is what gives way when the budget is tight.
export function formatCheckDiagnosis(diagnosis: HatchCheckDiagnosis, budget = 700): string {
  const command = clip(diagnosis.command.replace(/\s+/g, " ").trim(), COMMAND_DISPLAY_CHARS);
  const outcome = diagnosis.status === "failed"
    ? `exited ${diagnosis.exitCode ?? "without a code"}`
    : diagnosis.status === "non-converging"
      ? "kept changing the tree"
      : diagnosis.status === "precondition-unmet"
        ? `precondition failed (exit ${diagnosis.exitCode ?? "none"})`
        : diagnosis.status;
  let header = `Check '${diagnosis.checkId}' in ${SITE_TEXT[diagnosis.site]}: \`${command}\` ${outcome}`;
  if (diagnosis.cwd && diagnosis.cwd !== ".") header += ` (cwd ${diagnosis.cwd})`;
  header += ".";
  if (diagnosis.exitCode === 127) header += " Exit 127: the shell could not find the command.";
  const parts = [header];
  if (diagnosis.remediation) parts.push(diagnosis.remediation);
  const fixed = parts.join("\n");
  if (diagnosis.excerpt) {
    const room = budget - fixed.length - "\nOutput:\n".length;
    if (room > 20) parts.push(`Output:\n${clipTail(diagnosis.excerpt, room)}`);
  }
  return clip(parts.join("\n"), budget);
}

export interface HatchEnvironmentFindingNeed {
  item: string;
  command: string;
  runner: string;
  installDir: string;
  manifest: string;
  lockfile?: string;
}

export interface HatchEnvironmentFinding {
  needs: HatchEnvironmentFindingNeed[];
  suggestedSetup: string;
  remediation: string;
  message: string;
}

function suggestedInstall(need: HatchInstallNeed): string {
  const dir = posix.dirname(need.manifest) || ".";
  const inside = (cmd: string) => (dir === "." ? cmd : `cd ${dir} && ${cmd}`);
  switch (need.lockfile) {
    case "package-lock.json":
    case "npm-shrinkwrap.json":
      return dir === "." ? "npm ci --no-audit --no-fund" : `npm --prefix ${dir} ci --no-audit --no-fund`;
    case "pnpm-lock.yaml":
      return inside("pnpm install --frozen-lockfile");
    case "yarn.lock":
      return inside("yarn install --immutable");
    case "bun.lock":
    case "bun.lockb":
      return inside("bun install --frozen-lockfile");
    case "poetry.lock":
      return inside("poetry install");
    case "Pipfile.lock":
      return inside("pipenv sync");
    case "pdm.lock":
      return inside("pdm sync");
    case "Gemfile.lock":
      return inside("bundle install");
    case "pyproject.toml":
      return inside(need.runner === "pdm" ? "pdm install" : "poetry install");
    default:
      // A package.json with dependencies and no lockfile: do not create a tracked
      // lockfile, or the host refuses the setup for mutating the tree.
      return dir === "." ? "npm install --no-package-lock" : `npm --prefix ${dir} install --no-package-lock`;
  }
}

// The preflight rule over committed bytes. `items` are the binder items still to be
// built; only their oracles are knowable before build (floor commands come from
// workers). Returns a finding when some oracle relies on an install and the
// integration ref declares no setup; undefined otherwise.
export async function environmentPreflight(
  items: readonly Record<string, unknown>[],
  config: HatchEnvironmentConfig | undefined,
  readTreeFile: ReadTreeFile,
  fileExists?: TreeFileExists,
): Promise<HatchEnvironmentFinding | undefined> {
  if (config?.setup) return undefined;
  const needs: HatchEnvironmentFindingNeed[] = [];
  const installs: string[] = [];
  for (const item of items) {
    const oracle = item.oracle;
    if (!oracle || typeof oracle !== "object" || Array.isArray(oracle)) continue;
    const command = (oracle as Record<string, unknown>).command;
    const cwd = (oracle as Record<string, unknown>).cwd;
    if (typeof command !== "string" || !command.trim()) continue;
    const found = await resolveInstallNeeds(
      command,
      typeof cwd === "string" ? cwd : ".",
      readTreeFile,
      fileExists,
    );
    for (const need of found) {
      needs.push({
        item: String(item.id),
        command,
        runner: need.runner,
        installDir: need.installDir,
        manifest: need.manifest,
        lockfile: need.lockfile,
      });
      const install = suggestedInstall(need);
      if (!installs.includes(install)) installs.push(install);
    }
  }
  if (needs.length === 0) return undefined;
  const suggestedSetup = installs.join(" && ");
  const remediation =
    `The merge checks run in a fresh worktree that only .hatch/environment.json's setup provisions, and the integration branch declares none. Commit {"setup": ${JSON.stringify(suggestedSetup)}} as .hatch/environment.json on the default branch and on the integration branch, then run the delivery again.`;
  const lines = needs.map(
    (need) =>
      `- ${need.item}: \`${clip(need.command, COMMAND_DISPLAY_CHARS)}\` uses ${need.runner}, which needs ${need.installDir} (from ${need.manifest}).`,
  );
  const message = [
    "These oracles need installed dependencies that no environment setup provides:",
    ...lines,
    remediation,
  ].join("\n");
  return { needs, suggestedSetup, remediation, message };
}
