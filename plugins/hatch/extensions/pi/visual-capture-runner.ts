import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { readEnvironmentConfig, type VisualEnvConfig } from "./environment.ts";
import {
  startEnvServer,
  type EnvServerContext,
  type EnvServerOutcome,
  type StartEnvServerOptions,
} from "./env-server-runner.ts";
import { requirePackagePath } from "./package-paths.ts";

// A package-owned capture orchestrator.
//
// Given a built item worktree and the pinned OID of its candidate commit, this reads the
// committed `visual_env` from that exact commit (never a moving branch or the mutable
// working tree), brings the app up through the env-server lifecycle, captures the live
// view, serves and captures the design reference, runs the package-owned structured diff
// over the two captures, and emits one schema-pinned `hatch-visual-evidence-v1` artifact
// bound to the candidate tree hash — written outside the candidate worktree.
//
// It is built around an injectable capture boundary so the deterministic floor exercises
// the whole orchestration over fake `captureView`/`serveDesign` (the parts that need a
// browser and the running app) while running the REAL `diffCapture` over fixture capture
// artifacts. Only the opt-in live path drives playwright-cli end to end.
//
// It writes no verdict and moves no ref: per the shipped block-unrun-visual contract only
// the later screenshot-judgement binder may lift the visual-required block. Producing this
// evidence never unblocks a full visual verification.

export const VISUAL_EVIDENCE_SCHEMA = "hatch-visual-evidence-v1";
export const CAPTURE_ARTIFACT_SCHEMA = "hatch.validate.capture.v1";
export const RENDER_HEALTH_SCHEMA = "hatch-render-health-v1";
export const STRUCTURED_DIFF_SCHEMA = "hatch-structured-diff-v1";

// A git OID (or abbreviation) is interpolated into git plumbing argv; pin it to hex so a
// value beginning with `-` can never masquerade as an option.
const OID_PATTERN = /^[0-9a-f]{7,64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_VIEWPORT = "1440x900";
const SUBPROCESS_TIMEOUT_MS = 300_000;

const execFileAsync = promisify(execFile);

export interface RenderHealthRecord {
  schema: string;
  result: "healthy" | "degraded" | "blocked";
  readySelector: string | null;
  visibleTextChars: number;
  visibleLeafElements: number;
  styledElementCount: number;
  consoleErrorCount: number;
  failedRequestCount: number;
  consoleErrors: string[];
  failedRequests: string[];
}

export interface RenderHealthSummary {
  result: RenderHealthRecord["result"];
  readySelector: string | null;
  consoleErrorCount: number;
  failedRequestCount: number;
}

// One capture target as `capture_view.py` records it (design or app). Typed loosely: the
// diff consumes the raw record, and the orchestrator only reads `render_health`.
export interface CaptureTarget {
  url: string;
  health: string;
  render_health: RenderHealthRecord | null;
  extracted_data: unknown;
  screenshot?: string | null;
  dom_snapshot?: string | null;
  [key: string]: unknown;
}

// The `hatch.validate.capture.v1` artifact carrying both targets.
export interface CaptureArtifact {
  schema: string;
  design: CaptureTarget;
  app: CaptureTarget;
  APP_HEALTH?: string | null;
  compare_ready?: boolean;
  [key: string]: unknown;
}

// The `hatch-structured-diff-v1` document `diff_capture.py` emits.
export interface StructuredDiff {
  schema: string;
  status: "ok" | "blocked";
  blockedReason: string | null;
  renderHealth: unknown;
  summary: {
    discrepancyCount: number;
    tokenDriftCount: number;
    missingCount: number;
    extraCount: number;
    byDimension: Record<string, number>;
  };
  discrepancies: Array<Record<string, unknown>>;
  tokenDrift: Array<Record<string, unknown>>;
  missingElements: Array<Record<string, unknown>>;
  extraElements: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface VisualEvidence {
  schema: typeof VISUAL_EVIDENCE_SCHEMA;
  binder: string;
  item: string;
  route: string;
  designReference: string;
  candidateCommit: string;
  // The pinned candidate tree hash this evidence is bound to. Re-verified across capture.
  candidateTree: string;
  generatedAt: string;
  captures: { design: CaptureTarget; app: CaptureTarget };
  renderHealth: { design: RenderHealthSummary; app: RenderHealthSummary };
  structuredDiff: StructuredDiff;
}

export type VisualCaptureOutcome =
  | { status: "captured"; evidencePath: string; evidence: VisualEvidence; candidateTree: string }
  | { status: "no-visual-env"; reason: string }
  | { status: "render-unhealthy"; target: "design" | "app"; result: "blocked"; remediation: string }
  | { status: "auth-required"; remediation: string; location?: string }
  | { status: "startup-crash"; exitCode: number | null; tail: string; remediation: string }
  | { status: "timeout"; remediation: string }
  | { status: "aborted"; remediation: string }
  | { status: "tree-mutated"; boundTree: string; before: string; after: string; remediation: string };

export interface ServeDesignRequest {
  designPath: string;
  scratchDir: string;
  signal?: AbortSignal;
}

// A served design reference. `stop()` is non-vetoable and idempotent; the orchestrator
// calls it on every exit path so no static server process leaks.
export interface DesignServerHandle {
  url: string;
  stop(): Promise<void>;
}

export interface CaptureViewRequest {
  designUrl: string;
  appUrl: string;
  scratchDir: string;
  viewport?: string;
  signal?: AbortSignal;
}

export interface DiffCaptureRequest {
  artifact: CaptureArtifact;
  scratchDir: string;
  signal?: AbortSignal;
}

// The injectable capture boundary. Defaults resolve to the real, subprocess-backed
// implementations; a test overrides `captureView`, `serveDesign`, and `startEnvServer`
// (the parts needing a browser and the running app) while leaving `diffCapture` real.
export interface VisualCaptureBoundary {
  startEnvServer(options: StartEnvServerOptions): Promise<EnvServerOutcome>;
  serveDesign(request: ServeDesignRequest): Promise<DesignServerHandle>;
  captureView(request: CaptureViewRequest): Promise<CaptureArtifact>;
  diffCapture(request: DiffCaptureRequest): Promise<StructuredDiff>;
}

export interface CaptureVisualEvidenceOptions {
  binder: string;
  item: string;
  // The item's candidate worktree. The scratch and artifact are written outside it.
  worktree: string;
  // The pinned candidate commit OID. `visual_env` and the bound tree are read from here.
  candidateCommit: string;
  // The item-under-test's design_reference route (the app path to bring up and capture).
  route: string;
  // The design reference to serve and capture against (an HTML file or a directory).
  designPath: string;
  // The env-server lifecycle owner and its manager.
  context: EnvServerContext;
  // Where captures, scratch, and the evidence artifact are written. Must be outside the
  // worktree. Defaults to a fresh temp directory (cleaned up on failure, kept on success).
  scratchDir?: string;
  viewport?: string;
  signal?: AbortSignal;
  boundary?: Partial<VisualCaptureBoundary>;
}

export const PLAYWRIGHT_CLI_MISSING_REMEDIATION = [
  "playwright-cli is not available on PATH, so Hatch cannot capture the live app or design for visual evidence.",
  "",
  "To enable it (one-time):",
  "  1. npm install -g @playwright/cli@latest",
  "  2. playwright-cli install --skills",
  "",
  "Docs: https://github.com/microsoft/playwright-cli",
].join("\n");

// A fail-closed host-gate for the live capture path, the same idiom `capture_view.py`'s
// uv/playwright preflight uses: the browser dependency is never installed by Hatch, only
// checked, and its absence halts with the install remediation before any capture runs.
export class PlaywrightCliUnavailableError extends Error {
  readonly remediation = PLAYWRIGHT_CLI_MISSING_REMEDIATION;
  constructor() {
    super(PLAYWRIGHT_CLI_MISSING_REMEDIATION);
    this.name = "PlaywrightCliUnavailableError";
  }
}

function whichOnPath(command: string, path: string): string | undefined {
  const dirs = path.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, command + extension);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

// Resolve playwright-cli on PATH or fail closed with the install remediation. The PATH and
// the lookup are both injectable so the gate is exercised deterministically off the live
// path — no browser required to prove the fail-closed behavior.
export function resolvePlaywrightCli(
  options: { path?: string; lookup?: (command: string) => string | undefined } = {},
): string {
  const path = options.path ?? process.env.PATH ?? "";
  const lookup = options.lookup ?? ((command: string) => whichOnPath(command, path));
  const resolved = lookup("playwright-cli");
  if (!resolved) throw new PlaywrightCliUnavailableError();
  return resolved;
}

function pythonEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  env.PYTHONNOUSERSITE = "1";
  env.PYTHONSAFEPATH = "1";
  return env;
}

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : undefined,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed`);
  }
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(resolve(root), resolve(target));
  return fromRoot === "" || (!isAbsolute(fromRoot) && !fromRoot.startsWith(".."));
}

function assertOutsideWorktree(worktree: string, target: string): void {
  if (isInside(worktree, target)) {
    throw new Error(
      `Hatch visual capture writes outside the candidate worktree, never into it: ${target}`,
    );
  }
}

async function resolveScratchDir(provided: string | undefined, worktree: string): Promise<string> {
  if (provided !== undefined) {
    assertOutsideWorktree(worktree, provided);
    await mkdir(provided, { recursive: true });
    return resolve(provided);
  }
  return await mkdtemp(join(tmpdir(), "hatch-visual-capture-"));
}

// The tracked-content tree hash of the worktree right now, computed against a scratch
// index seeded from the candidate commit so the real index and the working tree are never
// touched. Untracked files (like the capture's own output, which lives outside the
// worktree anyway) are never staged, so only a mutation of a tracked file moves the hash.
async function trackedTreeHash(
  worktree: string,
  baseCommit: string,
  scratchDir: string,
): Promise<string> {
  const indexFile = join(scratchDir, `index-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await runGit(worktree, ["read-tree", baseCommit], env);
    await runGit(worktree, ["add", "-u"], env);
    return (await runGit(worktree, ["write-tree"], env)).trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

function summarizeRenderHealth(record: RenderHealthRecord | null): RenderHealthSummary {
  if (!record) {
    return { result: "blocked", readySelector: null, consoleErrorCount: 0, failedRequestCount: 0 };
  }
  return {
    result: record.result,
    readySelector: record.readySelector,
    consoleErrorCount: record.consoleErrorCount,
    failedRequestCount: record.failedRequestCount,
  };
}

// Fail closed on a shell or otherwise unhealthy render, or an auth-degraded app, rather
// than diffing a blank page. A `degraded` render still compares (its evidence surfaces in
// the diff); only a `blocked` render — or a missing health record — halts here.
function renderHealthGate(artifact: CaptureArtifact): VisualCaptureOutcome | undefined {
  if (artifact.compare_ready === false || artifact.APP_HEALTH === "DEGRADED_AUTH") {
    return {
      status: "auth-required",
      remediation:
        "The app target did not reach the requested view (an authentication screen); " +
        "capture an unauthenticated route or the visual block stays.",
    };
  }
  for (const target of ["design", "app"] as const) {
    const record = artifact[target]?.render_health ?? null;
    if (!record || record.result === "blocked") {
      return {
        status: "render-unhealthy",
        target,
        result: "blocked",
        remediation:
          `The ${target} render is blocked (an empty shell), per ${RENDER_HEALTH_SCHEMA}. ` +
          "Capture fails closed rather than diffing a blank page.",
      };
    }
  }
  return undefined;
}

function mapEnvServerFailure(outcome: Exclude<EnvServerOutcome, { status: "healthy" }>): VisualCaptureOutcome {
  switch (outcome.status) {
    case "startup-crash":
      return {
        status: "startup-crash",
        exitCode: outcome.exitCode,
        tail: outcome.tail,
        remediation: outcome.remediation,
      };
    case "auth-required":
      return { status: "auth-required", remediation: outcome.remediation, location: outcome.location };
    case "timeout":
      return { status: "timeout", remediation: outcome.remediation };
    case "aborted":
      return { status: "aborted", remediation: outcome.remediation };
  }
}

function resolveBoundary(partial: Partial<VisualCaptureBoundary> = {}): VisualCaptureBoundary {
  return {
    startEnvServer: partial.startEnvServer ?? startEnvServer,
    serveDesign: partial.serveDesign ?? realServeDesign,
    captureView: partial.captureView ?? realCaptureView,
    diffCapture: partial.diffCapture ?? realDiffCapture,
  };
}

// Bring both views up, capture them, run the real structured diff, and emit one
// hash-bound hatch-visual-evidence-v1 artifact — or a typed fail-closed outcome. The
// design server and the env server are torn down on every exit path (completion, a render
// or diff failure, an error, or an abort), and the candidate tree is re-verified after
// capture so a tracked-file mutation fails closed while the capture's own out-of-worktree
// output never trips the check.
export async function captureVisualEvidence(
  options: CaptureVisualEvidenceOptions,
): Promise<VisualCaptureOutcome> {
  const { binder, item, worktree, candidateCommit, route, designPath, context, viewport, signal } =
    options;
  if (!IDENTIFIER.test(binder)) throw new Error(`Invalid Hatch binder slug: ${binder}`);
  if (!IDENTIFIER.test(item)) throw new Error(`Invalid Hatch item id: ${item}`);
  if (!OID_PATTERN.test(candidateCommit)) {
    throw new Error(`Hatch candidate commit must be a hex OID: ${candidateCommit}`);
  }
  const boundary = resolveBoundary(options.boundary);

  // Read visual_env from the pinned candidate commit OID — not the moving integration
  // branch and not the mutable working tree. An absent block is opt-out: no capture, no
  // evidence, and the block stays.
  const environment = await readEnvironmentConfig(worktree, candidateCommit);
  const config: VisualEnvConfig | undefined = environment?.visualEnv;
  if (!config) {
    return {
      status: "no-visual-env",
      reason:
        "the candidate commit declares no visual_env; visual capture is opt-out and the block stays",
    };
  }

  const boundTree = (await runGit(worktree, ["rev-parse", `${candidateCommit}^{tree}`])).trim();
  const scratchDir = await resolveScratchDir(options.scratchDir, worktree);
  let keepScratch = false;

  try {
    if (signal?.aborted) {
      return { status: "aborted", remediation: "Hatch aborted before visual capture began." };
    }

    // Baseline the tracked tree before anything is brought up, so a mid-capture mutation
    // is caught by comparing this to the post-capture hash.
    const treeBefore = await trackedTreeHash(worktree, candidateCommit, scratchDir);

    const started = await boundary.startEnvServer({ config, worktree, route, context, signal });
    if (started.status !== "healthy") {
      return mapEnvServerFailure(started);
    }
    const handle = started.handle;

    let capture: { artifact: CaptureArtifact; diff: StructuredDiff } | { failure: VisualCaptureOutcome };
    try {
      const design = await boundary.serveDesign({ designPath, scratchDir, signal });
      try {
        const artifact = await boundary.captureView({
          designUrl: design.url,
          appUrl: handle.url,
          scratchDir,
          viewport: viewport ?? DEFAULT_VIEWPORT,
          signal,
        });
        const gate = renderHealthGate(artifact);
        if (gate) {
          capture = { failure: gate };
        } else {
          const diff = await boundary.diffCapture({ artifact, scratchDir, signal });
          capture = { artifact, diff };
        }
      } finally {
        await design.stop();
      }
    } finally {
      await handle.stop();
    }

    if ("failure" in capture) return capture.failure;

    // Re-verify the candidate tree after capture. The capture's own output lives outside
    // the worktree, so it never moves this hash; a mutated tracked file does.
    const treeAfter = await trackedTreeHash(worktree, candidateCommit, scratchDir);
    if (treeAfter !== treeBefore) {
      return {
        status: "tree-mutated",
        boundTree,
        before: treeBefore,
        after: treeAfter,
        remediation:
          "A tracked file in the candidate worktree changed during capture, so the evidence " +
          "would not bind to the candidate tree. Capture fails closed.",
      };
    }

    const evidence: VisualEvidence = {
      schema: VISUAL_EVIDENCE_SCHEMA,
      binder,
      item,
      route,
      designReference: designPath,
      candidateCommit,
      candidateTree: boundTree,
      generatedAt: new Date().toISOString(),
      captures: { design: capture.artifact.design, app: capture.artifact.app },
      renderHealth: {
        design: summarizeRenderHealth(capture.artifact.design.render_health),
        app: summarizeRenderHealth(capture.artifact.app.render_health),
      },
      structuredDiff: capture.diff,
    };
    const evidencePath = join(scratchDir, "visual-evidence.json");
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    keepScratch = true;
    return { status: "captured", evidencePath, evidence, candidateTree: boundTree };
  } finally {
    // Keep the artifact and captures on success; a caller that supplied its own scratch
    // dir owns cleanup. Only clean a temp dir this call created on a failure path.
    if (!keepScratch && options.scratchDir === undefined) {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }
}

// --------------------------------------------------------------------- real boundary

// Serve the design reference with the package-owned static server. `serve_design.py`
// prints its metadata (including the served design_url) then blocks serving; this reads
// that first line and returns a handle whose stop() reaps the process group.
export function realServeDesign(request: ServeDesignRequest): Promise<DesignServerHandle> {
  const script = requirePackagePath("skills/hatch-validate/scripts/serve_design.py");
  const metadataOut = join(request.scratchDir, `design-server-${randomUUID()}.json`);
  return new Promise<DesignServerHandle>((resolvePromise, reject) => {
    const child = spawn(
      "uv",
      ["run", "--script", script, "--design-path", request.designPath, "--metadata-out", metadataOut],
      {
        cwd: request.scratchDir,
        detached: process.platform !== "win32",
        env: pythonEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let settled = false;
    let stdout = "";
    let stderr = "";
    const pid = child.pid;

    const stop = async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === "win32" || !pid) child.kill("SIGTERM");
        else process.kill(-pid, "SIGTERM");
      } catch {
        // already gone
      }
      await new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        const timer = setTimeout(() => {
          try {
            if (process.platform === "win32" || !pid) child.kill("SIGKILL");
            else process.kill(-pid, "SIGKILL");
          } catch {
            // already gone
          }
          done();
        }, 2_000);
        timer.unref?.();
        child.once("close", () => {
          clearTimeout(timer);
          done();
        });
      });
    };

    const onAbort = (): void => {
      void stop();
      if (!settled) {
        settled = true;
        reject(new Error("Hatch design server was aborted before it came up"));
      }
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (settled) return;
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        try {
          const metadata = JSON.parse(trimmed) as { design_url?: unknown };
          if (typeof metadata.design_url === "string") {
            settled = true;
            request.signal?.removeEventListener("abort", onAbort);
            resolvePromise({ url: metadata.design_url, stop });
            return;
          }
        } catch {
          // partial line; wait for more
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      request.signal?.removeEventListener("abort", onAbort);
      reject(
        new Error(
          `Hatch design server exited before serving (code ${code ?? "null"})` +
            (stderr.trim() ? `: ${stderr.trim()}` : ""),
        ),
      );
    });
  });
}

// Capture the design and live app with the package-owned playwright capture. The
// playwright-cli host gate fails closed here, before any capture is attempted.
export async function realCaptureView(request: CaptureViewRequest): Promise<CaptureArtifact> {
  resolvePlaywrightCli();
  const script = requirePackagePath("skills/hatch-validate/scripts/capture_view.py");
  const outPath = join(request.scratchDir, `capture-${randomUUID()}.json`);
  const artifactsDir = join(request.scratchDir, `artifacts-${randomUUID()}`);
  await mkdir(artifactsDir, { recursive: true });
  await execFileAsync(
    "uv",
    [
      "run",
      "--script",
      script,
      "--design-url",
      request.designUrl,
      "--app-url",
      request.appUrl,
      "--out",
      outPath,
      "--artifacts-dir",
      artifactsDir,
      "--viewport",
      request.viewport ?? DEFAULT_VIEWPORT,
    ],
    { encoding: "utf8", env: pythonEnv(), timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal: request.signal },
  );
  const raw = await readFile(outPath, "utf8");
  return JSON.parse(raw) as CaptureArtifact;
}

// Run the package-owned structured diff over the two captures. This is the REAL diff on
// every path — floor and live — so the discrepancy checks exercise the actual structured
// comparison, not stub plumbing. It reads no app or design source and needs no browser.
export async function realDiffCapture(request: DiffCaptureRequest): Promise<StructuredDiff> {
  const script = requirePackagePath("skills/hatch-validate/scripts/diff_capture.py");
  const capturePath = join(request.scratchDir, `capture-for-diff-${randomUUID()}.json`);
  const diffPath = join(request.scratchDir, `diff-${randomUUID()}.json`);
  await writeFile(capturePath, `${JSON.stringify(request.artifact)}\n`, "utf8");
  try {
    await execFileAsync(
      "uv",
      ["run", "--script", script, "--capture", capturePath, "--out", diffPath],
      { encoding: "utf8", env: pythonEnv(), timeout: SUBPROCESS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, signal: request.signal },
    );
  } catch (error) {
    // diff_capture.py writes --out before exiting non-zero on a fail-closed document, so
    // fall through to read it. Only a genuinely missing artifact rethrows.
    try {
      const raw = await readFile(diffPath, "utf8");
      return JSON.parse(raw) as StructuredDiff;
    } catch {
      throw error;
    }
  }
  const raw = await readFile(diffPath, "utf8");
  return JSON.parse(raw) as StructuredDiff;
}
