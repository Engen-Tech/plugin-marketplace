/**
 * Hatch plan runner — package-owned enforcement for the plan phase on Pi.
 *
 * On Claude Code and Codex the plan phase is carried by skill prose, with one
 * exception that matters: `validate_binder.py` must pass before a binder is
 * committed. Pi had no plan action at all, so every rule in the phase — the
 * validator, the cross-item shared-term check, and the "commit only on the
 * `commit` verb" rule — rested on the model's discipline. A binder is the input
 * to every later phase, so that is the one place a slip is expensive.
 *
 * Two rules are enforced here instead of described:
 *
 *   1. A binder cannot be committed unless it validates — `validate_binder.py`
 *      and `check_shared_terms.py` both have to pass, and the pack provenance
 *      classification rides along on the review card.
 *   2. The commit happens only on the human's own decision, taken at a host
 *      prompt. Worker text is never consulted, exactly as with the accept
 *      waiver. The caller cannot supply the verb.
 *
 * A set of binders commits together, in one commit, the way the skill requires.
 *
 * The survey action covers the half of Phase 1 the repository can answer from
 * facts, so a Pi session does not improvise stack detection.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveHatchScript, type HatchScriptAction } from "./script-catalog.ts";

const exec = promisify(execFile);
const MAX_OUTPUT = 8 * 1024 * 1024;
const SCRIPT_TIMEOUT = 120_000;
const BINDER_ID = /^[a-z0-9][a-z0-9-]*$/;
const BINDER_ROOT = ".hatch/binders";
const ROUNDTABLE_ROOT = ".hatch/roundtable/";
const ROUNDTABLE_CONFIG = ".hatch/roundtable.json";

export const HATCH_PLAN_COMMIT_SUBJECT = (binder: string): string => `hatch: commit binder ${binder}`;

export interface HatchPlanScriptRun {
  action: HatchScriptAction;
  code: number;
  stdout: string;
  stderr: string;
}

export interface HatchPlanSurveyResult {
  schema: "hatch-plan-survey-v1";
  root: string;
  runs: HatchPlanScriptRun[];
}

export interface HatchPlanCommitResult {
  schema: "hatch-plan-commit-v1";
  binder: string;
  binders: string[];
  paths: string[];
  status: "committed" | "blocked" | "cancelled";
  card: string;
  runs: HatchPlanScriptRun[];
  commit?: string;
  message: string;
}

function output(run: HatchPlanScriptRun): string {
  return `${run.stdout}${run.stderr}`.trim();
}

async function git(cwd: string, args: string[], allowFailure = false): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_OUTPUT });
    return stdout.trim();
  } catch (error) {
    if (allowFailure) return "";
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message || "Hatch git command failed",
    );
  }
}

/**
 * A binder commit is the plan of record plus that binder's own review record, and nothing
 * else. A set commits together, so every binder in the set belongs to the same commit.
 *
 * The record allowance names the exact files the recorder writes for these slugs — never the
 * `.hatch/roundtable/` directory. Accepting the prefix let a commit for one binder sweep in
 * another binder's record, or any file at all that someone had staged under that path, which
 * is the opposite of "and nothing else".
 */
function isCommittablePath(repoPath: string, binderPaths: string[], recordPaths: string[]): boolean {
  return binderPaths.includes(repoPath) || recordPaths.includes(repoPath);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordPathsFor(slugs: string[]): string[] {
  return slugs.flatMap((slug) => [
    `${ROUNDTABLE_ROOT}${slug}.json`,
    `${ROUNDTABLE_ROOT}${slug}.rounds.json`,
  ]);
}

interface BinderCardFacts {
  slug: string;
  title: string;
  summary: string;
  items: number;
  after: string[];
  sme: string[];
}

function cardFacts(slug: string, raw: string): BinderCardFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Hatch binder '${slug}' is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Hatch binder '${slug}' is not a JSON object`);
  }
  const document = parsed as Record<string, unknown>;
  const declared = typeof document.slug === "string" ? document.slug : "";
  if (declared !== slug) {
    throw new Error(`Hatch binder '${slug}' declares slug '${declared || "(none)"}'`);
  }
  const workItems = Array.isArray(document.work_items) ? document.work_items : [];
  const after = Array.isArray(document.after)
    ? document.after.filter((value): value is string => typeof value === "string")
    : [];
  const sme = Array.isArray(document.sme)
    ? document.sme.filter((value): value is string => typeof value === "string")
    : [];
  return {
    slug,
    title: typeof document.title === "string" && document.title.trim() ? document.title.trim() : slug,
    summary: typeof document.summary === "string" ? document.summary.trim() : "",
    items: workItems.length,
    after,
    sme,
  };
}

function buildCard(
  facts: BinderCardFacts[],
  sme: string[],
  validation: string,
  provenance: string,
): string {
  const set = facts.length > 1;
  const lines: string[] = [
    set
      ? `Binder set — ${facts.length} binders, committed together:`
      : `Binder: ${facts[0].title} (${facts[0].slug})`,
  ];
  for (const binder of facts) {
    const shape = binder.after.length ? `after ${binder.after.join(", ")}` : "no `after` edge";
    if (set) {
      lines.push(`  - ${binder.slug} — ${binder.title} (${binder.items} work items, ${shape})`);
      lines.push(`    ${binder.summary || "(no summary recorded)"}`);
    } else {
      lines.push(`Goal: ${binder.summary || "(no summary recorded)"}`);
      lines.push(`Work items: ${binder.items}`);
      lines.push(
        `Shape: ${
          binder.after.length ? `a set — this binder runs after ${binder.after.join(", ")}` : "one binder — no `after` edge"
        }`,
      );
    }
  }
  lines.push(
    `Experts applied (sme): ${sme.length ? sme.join(", ") : "none"}`,
    "",
    "Validation passed. Recorded escapes:",
    validation || "(the validator printed no escape summary)",
    "",
    "Stack-pack provenance:",
    provenance || "(no .hatch/sme/ packs to classify)",
  );
  return lines.join("\n");
}

export class HatchPlanRunner {
  async #script(
    ctx: ExtensionContext,
    action: HatchScriptAction,
    args: string[],
  ): Promise<HatchPlanScriptRun> {
    const script = resolveHatchScript(action);
    const environment = { ...process.env };
    delete environment.PYTHONHOME;
    delete environment.PYTHONPATH;
    environment.PYTHONNOUSERSITE = "1";
    environment.PYTHONSAFEPATH = "1";
    try {
      const { stdout, stderr } = await exec("uv", ["run", "--script", script, ...args], {
        cwd: ctx.cwd,
        encoding: "utf8",
        env: environment,
        timeout: SCRIPT_TIMEOUT,
        maxBuffer: MAX_OUTPUT,
      });
      return { action, code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
      return {
        action,
        code: typeof failure.code === "number" ? failure.code : 1,
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message ?? "",
      };
    }
  }

  async survey(ctx: ExtensionContext): Promise<HatchPlanSurveyResult> {
    const detectStack = await this.#script(ctx, "detectStack", [ctx.cwd]);
    if (detectStack.code !== 0) {
      throw new Error(`Hatch stack detection failed:\n${output(detectStack)}`);
    }
    const checkPackProvenance = await this.#script(ctx, "checkPackProvenance", [ctx.cwd]);
    return {
      schema: "hatch-plan-survey-v1",
      root: ctx.cwd,
      runs: [detectStack, checkPackProvenance],
    };
  }

  /**
   * When a repository opts into the roundtable at its plan-commit point, that binder's own
   * record — and its ledger, when the config keeps one — must be staged in the same commit.
   * That is the rule the review gate enforces in a hooked harness; Pi has no such hook, so
   * without this check a binder could land here with no review record at all. The hatch is the
   * same one the gate honours, for when the review environment is down.
   */
  async #roundtableRecords(
    root: string,
    slugs: string[],
    staged: string[],
  ): Promise<{ required: string[]; missing: string[] }> {
    const none = { required: [], missing: [] };
    if (process.env.HATCH_SKIP_ROUNDTABLE === "1") return none;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(await readFile(join(root, ROUNDTABLE_CONFIG), "utf8")) as Record<string, unknown>;
    } catch {
      return none;
    }
    if (config.enabled !== true) return none;
    const points = (config.points ?? {}) as Record<string, unknown>;
    if (points.plan_commit !== true) return none;
    const required = slugs.flatMap((slug) => [
      `${ROUNDTABLE_ROOT}${slug}.json`,
      ...(config.ledger === true ? [`${ROUNDTABLE_ROOT}${slug}.rounds.json`] : []),
    ]);
    return { required, missing: required.filter((path) => !staged.includes(path)) };
  }

  async commit(
    ctx: ExtensionContext,
    binder: string,
    set: string[] = [],
  ): Promise<HatchPlanCommitResult> {
    const slugs = [binder, ...set];
    for (const slug of slugs) {
      if (!BINDER_ID.test(slug)) throw new Error(`Invalid Hatch binder slug: ${slug}`);
    }
    if (new Set(slugs).size !== slugs.length) {
      throw new Error("A Hatch binder set cannot repeat a slug");
    }
    const root = ctx.cwd;
    const paths = slugs.map((slug) => `${BINDER_ROOT}/${slug}.json`);
    for (const path of paths) {
      if (!existsSync(join(root, path))) {
        throw new Error(`Hatch has no draft binder at ${path} to commit`);
      }
    }

    const runs: HatchPlanScriptRun[] = [];
    const escapeBlocks: string[] = [];
    // The bytes that validated are the bytes that must commit, so each binder is hashed across
    // its own validation and the hash is re-checked before the commit is created.
    const validated = new Map<string, string>();
    for (const [index, slug] of slugs.entries()) {
      const path = paths[index];
      const before = sha256(await readFile(join(root, path)));
      const validation = await this.#script(ctx, "validateBinder", ["--binder", path]);
      runs.push(validation);
      if (validation.code !== 0) {
        throw new Error(`Hatch binder '${slug}' failed validation; fix it and re-commit:\n${output(validation)}`);
      }
      const terms = await this.#script(ctx, "checkSharedTerms", ["--binder", path, root]);
      runs.push(terms);
      if (terms.code !== 0) {
        throw new Error(`Hatch binder '${slug}' failed its shared-term check:\n${output(terms)}`);
      }
      if (sha256(await readFile(join(root, path))) !== before) {
        throw new Error(`Hatch binder '${slug}' changed while it was being validated; re-run the commit`);
      }
      validated.set(path, before);
      escapeBlocks.push(slugs.length > 1 ? `--- ${slug} ---\n${output(validation)}` : output(validation));
    }
    const provenance = await this.#script(ctx, "checkPackProvenance", [root]);
    runs.push(provenance);
    // Nothing may be staged except the plan of record and its own review record.
    const recordPaths = recordPathsFor(slugs);
    const stagedBefore = (await git(root, ["diff", "--cached", "--name-only"], true))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    const strayBefore = stagedBefore.filter((line) => !isCommittablePath(line, paths, recordPaths));
    if (strayBefore.length > 0) {
      throw new Error(
        `Hatch refuses to commit a binder with unrelated changes staged: ${strayBefore.join(", ")}`,
      );
    }
    const roundtable = await this.#roundtableRecords(root, slugs, stagedBefore);
    if (roundtable.missing.length > 0) {
      throw new Error(
        `Hatch refuses to commit binder '${binder}' without its review record staged: ` +
          `${roundtable.missing.join(", ")}. Record the roundtable ` +
          `(python3 scripts/roundtable/run_review.py --record --target ${binder}) and stage it, ` +
          `or set HATCH_SKIP_ROUNDTABLE=1 if the review environment is down.`,
      );
    }

    const facts: BinderCardFacts[] = [];
    for (const [index, slug] of slugs.entries()) {
      facts.push(cardFacts(slug, await readFile(join(root, paths[index]), "utf8")));
    }
    const sme = [...new Set(facts.flatMap((binder) => binder.sme))];
    const card = `${buildCard(facts, sme, escapeBlocks.join("\n\n"), output(provenance))}\n\n${
      roundtable.required.length
        ? `Review record staged: ${roundtable.required.join(", ")}`
        : "Review record: this repository's roundtable settings require none for a plan commit."
    }`;

    if (!ctx.hasUI) {
      return {
        schema: "hatch-plan-commit-v1",
        binder,
        binders: slugs,
        paths,
        status: "blocked",
        card,
        runs,
        message: `Binder '${binder}' validated and is ready; committing needs a human at a prompt.`,
      };
    }

    const reviewed = await ctx.ui.confirm(`Review binder '${binder}' before committing`, card);
    if (!reviewed) {
      return {
        schema: "hatch-plan-commit-v1",
        binder,
        binders: slugs,
        paths,
        status: "cancelled",
        card,
        runs,
        message: "The binder was not committed: the review was declined.",
      };
    }

    // The verb is the human's. It never comes from the model, and an absent
    // answer is a refusal rather than a default.
    const verb = await ctx.ui.select(`Commit binder '${binder}'?`, ["commit", "cancel"]);
    if (verb !== "commit") {
      return {
        schema: "hatch-plan-commit-v1",
        binder,
        binders: slugs,
        paths,
        status: "cancelled",
        card,
        runs,
        message: "The binder was not committed: the `commit` verb was not given.",
      };
    }

    await git(root, ["add", "--", ...paths]);
    const staged = (await git(root, ["diff", "--cached", "--name-only"], true))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    for (const path of paths) {
      if (!staged.includes(path)) throw new Error(`Hatch could not stage ${path} for commit`);
    }
    const stray = staged.filter((line) => !isCommittablePath(line, paths, recordPaths));
    if (stray.length > 0) {
      throw new Error(`Hatch refuses to commit a binder with unrelated changes staged: ${stray.join(", ")}`);
    }
    const stillMissing = roundtable.required.filter((path) => !staged.includes(path));
    if (stillMissing.length > 0) {
      throw new Error(
        `Hatch refuses to commit binder '${binder}' without its review record staged: ${stillMissing.join(", ")}`,
      );
    }
    // The review prompt is a window. `git add` staged whatever is on disk once it ran, so prove
    // the index still holds the bytes that validated — first that the file is unchanged, then
    // that the index matches the file. Without this, anything edited while the human was looking
    // at the card would be committed behind a validated-looking name.
    for (const path of paths) {
      if (sha256(await readFile(join(root, path))) !== validated.get(path)) {
        throw new Error(`Hatch refuses to commit ${path}: the file changed after it was validated`);
      }
      if ((await git(root, ["diff", "--name-only", "--", path], true)).trim() !== "") {
        throw new Error(`Hatch refuses to commit ${path}: the index does not hold the validated bytes`);
      }
    }

    const subject = HATCH_PLAN_COMMIT_SUBJECT(binder);
    await git(root, ["commit", "-m", subject]);
    const commit = await git(root, ["rev-parse", "HEAD"]);
    return {
      schema: "hatch-plan-commit-v1",
      binder,
      binders: slugs,
      paths,
      status: "committed",
      card,
      runs,
      commit,
      message: `Committed binder '${binder}' as ${commit.slice(0, 12)}.`,
    };
  }
}
