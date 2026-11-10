import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  bindCheckManifestEntry,
  createCheckManifest,
  runBoundCheck,
  type UnboundCheckResult,
} from "./check-runner.ts";
import {
  diagnoseCheckFailure,
  type HatchCheckDiagnosis,
  type HatchCheckSite,
} from "./check-environment.ts";
import type { HatchCheckManifest } from "./evidence.ts";
import { readEnvironmentConfig } from "./environment.ts";

const exec = promisify(execFile);
const DEFAULT_MAX_PASSES = 3;

export interface HatchCheckPlanEntry {
  id: string;
  purpose: "floor" | "oracle";
  command: string;
  cwd: string;
}

export type CheckConvergenceCheckpoint =
  | "candidate-staged"
  | "stabilization-checks-complete"
  | "final-checks-complete"
  | "tree-drifted"
  | "manifest-bound";

export interface RunCheckConvergenceOptions {
  worktree: string;
  checks: HatchCheckPlanEntry[];
  environmentSetupRef?: string;
  signal?: AbortSignal;
  maxPasses?: number;
  // Where the worktree sits. It labels the diagnosis on a halt, is a term of the reuse key
  // below, and is recorded in a stable result's inputs.site. Default "item".
  site?: HatchCheckSite;
  // Run the plan once on the staged tree instead of converging: stable only when the
  // run leaves the tree unchanged, otherwise "non-converging". A confirming probe on a
  // tree another worktree already converged.
  singlePass?: boolean;
  // The parity probe's result for this item in this run. At a fresh-merge site, after the
  // declared preflight, it is bound instead of running setup and the plan when every input
  // the checks see is equal (see the reuse test below). Otherwise it is ignored.
  reuse?: StableCheckConvergenceResult;
  onProcessStart?: (pid: number) => void;
  onProcessExit?: (pid: number) => Promise<void> | void;
  checkpoint?: (
    point: CheckConvergenceCheckpoint,
    details: { pass: number; tree: string },
  ) => Promise<void> | void;
}

// What the integration ref's .hatch/environment.json declared for this run.
export interface CheckEnvironmentDeclaration {
  setupDeclared: boolean;
  preflightDeclared: boolean;
}

// What the checks saw, besides the target tree. `setupBlob` is the integration ref's
// .hatch/environment.json blob, "none" when there is none, and null when it moved while
// the site ran, which never matches.
export interface CheckRunInputs {
  site: HatchCheckSite;
  head: string;
  planHash: string;
  setupBlob: string | null;
  envDigest: string;
}

export interface StableCheckConvergenceResult {
  status: "stable";
  passes: number;
  targetTree: string;
  manifest: HatchCheckManifest;
  environment: CheckEnvironmentDeclaration;
  inputs: CheckRunInputs;
  // Set when this site bound another site's receipts instead of running the plan.
  reused?: "fresh-parity";
}

type HaltedUnboundCheckResult = UnboundCheckResult & {
  status: "failed" | "timed-out" | "aborted";
};

export interface HaltedCheckConvergenceResult {
  status: "failed" | "timed-out" | "aborted" | "non-converging" | "precondition-unmet";
  passes: number;
  targetTree: string;
  check?: { id: string; result: HaltedUnboundCheckResult };
  // Set only on "precondition-unmet": the project's own remediation text
  // (environment.json on_unavailable), surfaced verbatim so the halt names the fix.
  remediation?: string;
  environment: CheckEnvironmentDeclaration;
  // Computed before the halt returns, while the worktree still exists. Absent only
  // when the diagnosis itself could not be built.
  diagnosis?: HatchCheckDiagnosis;
}

export type CheckConvergenceResult =
  | StableCheckConvergenceResult
  | HaltedCheckConvergenceResult;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed during check convergence`);
  }
}

function validatePlan(checks: HatchCheckPlanEntry[]): void {
  if (checks.length === 0 || checks.length > 32) {
    throw new Error("Hatch stable-tree check plan must contain between 1 and 32 commands");
  }
  const ids = new Set<string>();
  for (const check of checks) {
    const cwd = check.cwd.replaceAll("\\", "/");
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(check.id) ||
      ids.has(check.id) ||
      !["floor", "oracle"].includes(check.purpose) ||
      !check.command.trim() ||
      check.command.length > 16 * 1024 ||
      !cwd ||
      cwd.startsWith("/") ||
      cwd.split("/").includes("..")
    ) {
      throw new Error("Hatch stable-tree check plan is malformed or contains duplicates");
    }
    ids.add(check.id);
  }
  if (checks.filter((check) => check.purpose === "oracle").length > 1) {
    throw new Error("Hatch stable-tree check plan contains more than one oracle");
  }
}

// The plan as the checks run it: order, id, purpose, command and cwd, as given.
export function checkPlanHash(checks: HatchCheckPlanEntry[]): string {
  const tuples = checks.map((check) => [check.id, check.purpose, check.command, check.cwd]);
  return createHash("sha256").update(JSON.stringify(tuples)).digest("hex");
}

function environmentDigest(): string {
  const entries = Object.entries(process.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export async function setupBlobOf(worktree: string, ref: string | undefined): Promise<string> {
  if (!ref) return "none";
  try {
    const { stdout } = await exec(
      "git",
      ["-C", worktree, "rev-parse", "--verify", "--quiet", `${ref}:.hatch/environment.json`],
      { encoding: "utf8" },
    );
    return stdout.trim() || "none";
  } catch (error) {
    // --quiet exits 1 with no output when the ref or the path is absent: the opt-out.
    // Any other failure (not a repository, git missing) is not an absent file, so two of
    // them must never compare equal as "none".
    if ((error as { code?: unknown }).code === 1) return "none";
    throw error;
  }
}

// Run the declared preflight once, at the worktree root, before anything else at a site.
// The caller decides what a failure means: runStableTreeChecks halts precondition-unmet; the
// post-wave site that did not rerun its floor rolls the wave back.
export async function runEnvironmentPreflight(
  options: Pick<RunCheckConvergenceOptions, "worktree" | "signal" | "onProcessStart" | "onProcessExit">,
  preflight: string,
): Promise<UnboundCheckResult> {
  return runBoundCheck({
    worktree: options.worktree,
    command: preflight,
    cwd: ".",
    signal: options.signal,
    onProcessStart: options.onProcessStart,
    onProcessExit: options.onProcessExit,
  });
}

async function stageTree(worktree: string): Promise<string> {
  await git(worktree, ["add", "-A"]);
  return git(worktree, ["write-tree"]);
}

// The index with per-file flags. `-v` reveals a skip-worktree/assume-unchanged
// toggle, which would otherwise hide a working-tree mutation from `git add -A` and
// let a setup command tamper with tracked content without changing write-tree's output.
async function indexIdentity(worktree: string): Promise<string> {
  return git(worktree, ["ls-files", "--stage", "-v", "-z"]);
}

async function runPlan(
  options: RunCheckConvergenceOptions,
): Promise<
  | { status: "passed"; results: UnboundCheckResult[] }
  | { status: "halted"; id: string; result: HaltedUnboundCheckResult }
> {
  const results: UnboundCheckResult[] = [];
  for (const check of options.checks) {
    const result = await runBoundCheck({
      worktree: options.worktree,
      command: check.command,
      cwd: check.cwd,
      signal: options.signal,
      onProcessStart: options.onProcessStart,
      onProcessExit: options.onProcessExit,
    });
    if (result.status !== "passed") {
      return { status: "halted", id: check.id, result: result as HaltedUnboundCheckResult };
    }
    results.push(result);
  }
  return { status: "passed", results };
}

function bindManifest(
  options: RunCheckConvergenceOptions,
  results: UnboundCheckResult[],
  tree: string,
): HatchCheckManifest {
  const entries = results.map((result, sequence) =>
    bindCheckManifestEntry(result, {
      id: options.checks[sequence].id,
      sequence,
      purpose: options.checks[sequence].purpose,
      targetTree: tree,
      preTree: tree,
      postTree: tree,
    }),
  );
  return createCheckManifest(tree, entries);
}

export async function runStableTreeChecks(
  options: RunCheckConvergenceOptions,
): Promise<CheckConvergenceResult> {
  validatePlan(options.checks);
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  if (!Number.isInteger(maxPasses) || maxPasses < 1 || maxPasses > 10) {
    throw new Error("Hatch check convergence maxPasses must be an integer from 1 to 10");
  }
  const head = await git(options.worktree, ["rev-parse", "HEAD"]);
  const envDigest = environmentDigest();
  const entryBlob = await setupBlobOf(options.worktree, options.environmentSetupRef);
  const environmentConfig = options.environmentSetupRef
    ? await readEnvironmentConfig(options.worktree, options.environmentSetupRef)
    : undefined;
  const environment: CheckEnvironmentDeclaration = {
    setupDeclared: Boolean(environmentConfig?.setup),
    preflightDeclared: Boolean(environmentConfig?.preflight),
  };
  // Every halted return goes through here, so the diagnosis is computed while the
  // worktree (and its install directories) still exists. A diagnosis is advisory: a
  // failure to build one never replaces the halt it describes.
  const halt = async (
    halted: Omit<HaltedCheckConvergenceResult, "environment" | "diagnosis">,
    subject: { id: string; command: string; cwd: string },
  ): Promise<HaltedCheckConvergenceResult> => {
    let diagnosis: HatchCheckDiagnosis | undefined;
    try {
      diagnosis = await diagnoseCheckFailure({
        worktree: options.worktree,
        checkId: subject.id,
        command: subject.command,
        cwd: subject.cwd,
        status: halted.status,
        result: halted.check?.result,
        site: options.site ?? "item",
        setupDeclared: environment.setupDeclared,
        environmentSetupRef: options.environmentSetupRef,
      });
    } catch {
      diagnosis = undefined;
    }
    return { ...halted, environment, ...(diagnosis ? { diagnosis } : {}) };
  };
  const planCheck = (id: string) => {
    const check = options.checks.find((entry) => entry.id === id);
    return { id, command: check?.command ?? "", cwd: check?.cwd ?? "." };
  };
  // A drifting tree has no single failing command; the diagnosis names the whole plan.
  const wholePlan = () => {
    const cwds = new Set(options.checks.map((check) => check.cwd));
    return {
      id: "check-plan",
      command: options.checks.map((check) => check.command).join("\n"),
      cwd: cwds.size === 1 ? options.checks[0].cwd : ".",
    };
  };
  if (environmentConfig?.preflight) {
    // Probe the declared precondition BEFORE setup and the floor. On failure, halt
    // clean with the project's remediation rather than running the real floor command
    // into the wall — a distinct "precondition-unmet" the caller maps to blocked (not a
    // worker retry: a missing daemon is not fixed by re-prompting an implementer).
    const probe = await runEnvironmentPreflight(options, environmentConfig.preflight);
    if (probe.status !== "passed") {
      return halt(
        {
          status: "precondition-unmet",
          passes: 0,
          targetTree: await stageTree(options.worktree),
          check: { id: "environment-preflight", result: probe as HaltedUnboundCheckResult },
          remediation: environmentConfig.onUnavailable,
        },
        { id: "environment-preflight", command: environmentConfig.preflight, cwd: "." },
      );
    }
  }
  // Reuse, after the preflight and before setup: the preflight is the project's live-service
  // probe and always runs. The parity probe's receipts stand in for this site's run only when
  // each input the checks see is equal: the site class (a fresh worktree set up by setup
  // alone), the staged tree, the worktree HEAD, the plan, the setup blob and process.env.
  // The run lease that holds the probe result is a scope, not identity; identity is this
  // content key (INV-3, INV-37). An abort already raised is never answered with a reused
  // result: the plan run below returns it as aborted.
  const reuse = options.reuse;
  if (
    reuse &&
    !options.signal?.aborted &&
    reuse.status === "stable" &&
    reuse.inputs.site === "fresh-parity" &&
    options.site === "fresh-merge" &&
    reuse.inputs.head === head &&
    reuse.inputs.planHash === checkPlanHash(options.checks) &&
    reuse.inputs.setupBlob !== null &&
    reuse.inputs.setupBlob === entryBlob &&
    reuse.inputs.envDigest === envDigest &&
    reuse.targetTree === (await stageTree(options.worktree))
  ) {
    return { ...reuse, reused: "fresh-parity" };
  }
  const environmentSetup = environmentConfig?.setup;
  if (environmentSetup) {
    // Provision the check worktree's declared environment (install deps into a
    // gitignored directory) once, before staging. The command is read from the
    // integration ref's committed, gate-approved blob. It must touch only gitignored
    // paths: we stage before and after and require the tree be unchanged, so a setup
    // that mutates a tracked file cannot ride unreviewed into the merged tree and
    // the target-tree stability invariant is preserved.
    const setupSubject = { id: "environment-setup", command: environmentSetup, cwd: "." };
    const preSetupTree = await stageTree(options.worktree);
    const preSetupIndex = await indexIdentity(options.worktree);
    const setup = await runBoundCheck({
      worktree: options.worktree,
      command: environmentSetup,
      cwd: ".",
      signal: options.signal,
      onProcessStart: options.onProcessStart,
      onProcessExit: options.onProcessExit,
    });
    if (setup.status !== "passed") {
      return halt(
        {
          status: setup.status,
          passes: 0,
          targetTree: preSetupTree,
          check: { id: "environment-setup", result: setup as HaltedUnboundCheckResult },
        },
        setupSubject,
      );
    }
    const postSetupTree = await stageTree(options.worktree);
    const postSetupIndex = await indexIdentity(options.worktree);
    if (postSetupTree !== preSetupTree || postSetupIndex !== preSetupIndex) {
      return halt(
        {
          status: "failed",
          passes: 0,
          targetTree: postSetupTree,
          check: {
            id: "environment-setup",
            result: {
              ...setup,
              status: "failed",
              stderr:
                `${setup.stderr}\nHatch environment setup mutated tracked files; it must provision only gitignored paths.`
                  .trim(),
            } as HaltedUnboundCheckResult,
          },
        },
        setupSubject,
      );
    }
  }
  const inputs: CheckRunInputs = {
    site: options.site ?? "item",
    head,
    planHash: checkPlanHash(options.checks),
    setupBlob: (await setupBlobOf(options.worktree, options.environmentSetupRef)) === entryBlob ? entryBlob : null,
    envDigest,
  };
  if (options.singlePass) {
    const candidateTree = await stageTree(options.worktree);
    await options.checkpoint?.("candidate-staged", { pass: 1, tree: candidateTree });
    const run = await runPlan(options);
    if (run.status === "halted") {
      return halt(
        {
          status: run.result.status,
          passes: 1,
          targetTree: candidateTree,
          check: { id: run.id, result: run.result },
        },
        planCheck(run.id),
      );
    }
    await options.checkpoint?.("final-checks-complete", { pass: 1, tree: candidateTree });
    const finalTree = await stageTree(options.worktree);
    if (finalTree !== candidateTree) {
      await options.checkpoint?.("tree-drifted", { pass: 1, tree: finalTree });
      return halt({ status: "non-converging", passes: 1, targetTree: finalTree }, wholePlan());
    }
    const manifest = bindManifest(options, run.results, candidateTree);
    await options.checkpoint?.("manifest-bound", { pass: 1, tree: candidateTree });
    return { status: "stable", passes: 1, targetTree: candidateTree, manifest, environment, inputs };
  }
  let lastTree = "";
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const candidateTree = await stageTree(options.worktree);
    lastTree = candidateTree;
    await options.checkpoint?.("candidate-staged", { pass, tree: candidateTree });
    const stabilization = await runPlan(options);
    if (stabilization.status === "halted") {
      return halt(
        {
          status: stabilization.result.status,
          passes: pass,
          targetTree: candidateTree,
          check: { id: stabilization.id, result: stabilization.result },
        },
        planCheck(stabilization.id),
      );
    }
    await options.checkpoint?.("stabilization-checks-complete", {
      pass,
      tree: candidateTree,
    });
    const stabilizedTree = await stageTree(options.worktree);
    if (stabilizedTree !== candidateTree) {
      lastTree = stabilizedTree;
      await options.checkpoint?.("tree-drifted", { pass, tree: stabilizedTree });
      continue;
    }
    // The first pass that started and ended on the same tree is bound; there is no
    // confirming rerun. A check that passes once and would fail on a rerun in the same
    // worktree slips through here; the parity probe's fresh-worktree run still reruns it.
    const manifest = bindManifest(options, stabilization.results, candidateTree);
    await options.checkpoint?.("manifest-bound", { pass, tree: candidateTree });
    return { status: "stable", passes: pass, targetTree: candidateTree, manifest, environment, inputs };
  }
  return halt(
    {
      status: "non-converging",
      passes: maxPasses,
      targetTree: lastTree,
    },
    wholePlan(),
  );
}

// The parity probe's passing result per item, kept for the run that ran it. The key is the
// run's dispatch lease: a resumed run holds a new lease and finds nothing, and the entries
// go when the lease does. Nothing is written to disk.
const parityRuns = new WeakMap<object, Map<string, StableCheckConvergenceResult>>();

export function rememberParity(run: object, item: string, result: StableCheckConvergenceResult): void {
  let items = parityRuns.get(run);
  if (!items) {
    items = new Map();
    parityRuns.set(run, items);
  }
  items.set(item, result);
}

export function parityResult(run: object, item: string): StableCheckConvergenceResult | undefined {
  return parityRuns.get(run)?.get(item);
}
