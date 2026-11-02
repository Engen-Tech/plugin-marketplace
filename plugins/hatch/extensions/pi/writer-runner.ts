import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  ChildRegistry,
  createWorkerChildSession,
  type ChildModelTarget,
  type ChildRuntimeReport,
} from "./child-runtime.ts";
import { requireRoleModel } from "./role-models.ts";
import { clampSummary } from "./worker-runner.ts";
import {
  attestWorkerAuthority,
  snapshotWorkerAuthority,
  type WorkerAuthorityAttestation,
  type WorkerAuthoritySnapshot,
} from "./worker-attestation.ts";
import { loadWorkerProjectInstructions } from "./worker-instructions.ts";
import {
  createWriterCapabilityProfile,
  type HatchWriterRole,
  type WriterCapabilityProfile,
} from "./writer-profile.ts";
import { parseJsonEnvelope, promptForJsonEnvelope, type EnvelopePrompter } from "./child-envelope.ts";
import { lastTurnEndedInError } from "./child-last-turn.ts";

const WRITER_SCHEMA = "hatch-writer-result-v1";

// The seeded-cache rule, stated once: the kaizen brief carries it, and the
// corrective prompt after a seeded-cache refusal starts with it.
export const KAIZEN_SEEDED_CACHE_RULE =
  "A pack file whose frontmatter carries `seeded_from` is a seeded cache and is never edited: " +
  "a narrowing of one of its rules goes into a project pack that already `extends` that built-in " +
  "(its `exclude_rules` plus a rule beginning `Narrows <rule-id>:`), a new rule goes beside the " +
  "rules of an existing project pack (a pack file without `seeded_from`), and anything else goes " +
  "into `proposedScaffolds` with no file changed.";

// The writer changed host authority (refs, index, config, hooks, protected
// paths). Typed so the companion runner records it as a confinement refusal.
export class HatchWriterAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HatchWriterAuthorityError";
  }
}

const WRITER_ENVELOPE_REPAIR_PROMPT =
  'Your previous message was not the required result. Reply now with ONLY the single JSON writer-result object described in your instructions (schema "hatch-writer-result-v1") — no prose, no headings, no code fence, and nothing before or after the object.';

// The reason this result would be rejected, or null when it survives the same
// parse the host runs afterwards. Delegating to that parse is the point: a
// predicate that only recognised `schema` let every other rule — the summary
// cap, the per-writer key set, the string-array bounds — be enforced after the
// one corrective turn had already passed, so a writer that finished its work and
// broke one of them lost the work with nothing said.
export function writerEnvelopeViolation(
  text: string,
  expected: { binder: string; profile: WriterCapabilityProfile; runtime: ChildRuntimeReport } | null,
): string | null {
  try {
    const value = parseJsonEnvelope(text, "writer");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "the result must be a single JSON object";
    }
    const record = value as Record<string, unknown>;
    if (record.schema !== WRITER_SCHEMA) return `"schema" must be "${WRITER_SCHEMA}"`;
    if (typeof record.summary === "string" && record.summary.length > 2_000) {
      return `"summary" is ${record.summary.length} characters; the limit is 2000 — shorten it` +
        " and resend the same result, keeping every other field byte-identical";
    }
    // Without the dispatch's own binder and profile only the shape is knowable;
    // the rest then belongs to the strict parse alone.
    if (!expected) return null;
    parseWriterResult(text, expected.binder, expected.profile, expected.runtime);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export interface HatchResolvedWriterPack {
  id: string;
  path: string;
  sha256: string;
  content: string;
  canonicalSha256?: string;
  canonicalContent?: string;
}

export interface HatchOverrideEvidence {
  rule: string;
  reason: string;
  path: string;
  line: number;
  commit: string;
  date: string;
  delivery: string;
  inBlastRadius: boolean;
}

interface WriterResultBase {
  schema: typeof WRITER_SCHEMA;
  role: HatchWriterRole;
  binder: string;
  roleDefinitionHash: string;
  profileHash: string;
  summary: string;
  runtime: ChildRuntimeReport;
  attestation: WorkerAuthorityAttestation;
}

export interface HatchDocGardnerResult extends WriterResultBase {
  role: "doc-gardner";
  correctedCount: number;
  filesChanged: string[];
  residual: string[];
  focusStale?: string;
}

export interface HatchKaizenResult extends WriterResultBase {
  role: "kaizen";
  seeded: string[];
  packsChanged: string[];
  candidates: string[];
  erosionNotes: string[];
  upstreamCandidates: string[];
  proposedScaffolds: string[];
  residual: string[];
}

export type HatchWriterResult = HatchDocGardnerResult | HatchKaizenResult;
export type HatchUnattestedWriterResult =
  | Omit<HatchDocGardnerResult, "attestation">
  | Omit<HatchKaizenResult, "attestation">;

export interface WriterInvocation {
  ctx: ExtensionContext;
  registry: ChildRegistry;
  profile: WriterCapabilityProfile;
  // The pinned model for this writer's role (doc-gardner or kaizen).
  target: ChildModelTarget;
  // Carried so the corrective turn can apply the strict parse's own rules rather
  // than a looser stand-in for them.
  binder: string;
  systemPrompt: string;
  userPrompt: string;
  parentId?: string;
  surfaceReview?: WriterSurfaceReview;
}

// The host's review of the writer's changes, run while the session is open. A
// string is the corrective prompt, sent once; null means no turn.
export type WriterSurfaceReview = (result: HatchUnattestedWriterResult) => Promise<string | null>;

export interface WriterSession extends EnvelopePrompter {
  readonly messages: readonly unknown[];
}

// At most four prompts: the request, an envelope repair, the correction, an
// envelope repair. A provider error skips every repair and the correction. The
// review runs only on an envelope the strict parse accepts, so it judges exactly
// what the host will parse after the session closes.
export async function promptWriterChild(
  session: WriterSession,
  invocation: Pick<WriterInvocation, "userPrompt" | "binder" | "profile" | "surfaceReview">,
  runtime: ChildRuntimeReport,
): Promise<string> {
  const expected = { binder: invocation.binder, profile: invocation.profile, runtime };
  const canRepair = () => !lastTurnEndedInError(session.messages);
  const ask = (message: string) =>
    promptForJsonEnvelope(
      session,
      message,
      (candidate) => writerEnvelopeViolation(candidate, expected) === null,
      (candidate) => {
        const violation = writerEnvelopeViolation(candidate, expected);
        return violation === null
          ? WRITER_ENVELOPE_REPAIR_PROMPT
          : `${WRITER_ENVELOPE_REPAIR_PROMPT} The result you sent was rejected because: ${violation}.`;
      },
      canRepair,
    );
  const text = await ask(invocation.userPrompt);
  if (!invocation.surfaceReview || writerEnvelopeViolation(text, expected) !== null || !canRepair()) {
    return text;
  }
  const correction = await invocation.surfaceReview(
    parseWriterResult(text, invocation.binder, invocation.profile, runtime),
  );
  return correction === null ? text : ask(correction);
}

export type WriterModelInvoker = (
  invocation: WriterInvocation,
) => Promise<{ text: string; runtime: ChildRuntimeReport }>;

async function invokeWriter(
  invocation: WriterInvocation,
): Promise<{ text: string; runtime: ChildRuntimeReport }> {
  const { session, report } = await createWorkerChildSession(
    invocation.ctx,
    invocation.systemPrompt,
    invocation.profile.tools,
    invocation.profile.worktree,
    invocation.target,
  );
  invocation.registry.add(session, {
    cwd: invocation.profile.worktree,
    role: invocation.profile.writer,
    label: invocation.profile.writer,
    parentId: invocation.parentId,
  });
  const abort = () => void session.abort();
  invocation.ctx.signal?.addEventListener("abort", abort, { once: true });
  if (invocation.ctx.signal?.aborted) abort();
  try {
    const text = await promptWriterChild(session, invocation, report);
    return { text, runtime: report };
  } finally {
    invocation.ctx.signal?.removeEventListener("abort", abort);
    invocation.registry.delete(session);
    session.dispose();
  }
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Malformed Hatch writer result: unexpected or missing keys");
  }
}

function stringArray(value: unknown, field: string, max = 256): string[] {
  if (
    !Array.isArray(value) || value.length > max ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 4_096)
  ) {
    throw new Error(`Malformed Hatch writer result field '${field}'`);
  }
  return [...value];
}

function parseWriterResult(
  text: string,
  binder: string,
  profile: WriterCapabilityProfile,
  runtime: ChildRuntimeReport,
): HatchUnattestedWriterResult {
  const parsed = parseJsonEnvelope(text, "writer");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hatch writer returned a non-object result");
  }
  const value = parsed as Record<string, unknown>;
  const common = ["schema", "role", "binder", "roleDefinitionHash", "profileHash", "summary"];
  // Name the field. One blanket message covered seven rules, so a discarded
  // writer run told its operator nothing about which one to look at.
  const envelopeFault = value.schema !== WRITER_SCHEMA
    ? `"schema" must be "${WRITER_SCHEMA}"`
    : value.role !== profile.writer
    ? `"role" must be "${profile.writer}"`
    : value.binder !== binder
    ? `"binder" must be "${binder}"`
    : value.roleDefinitionHash !== profile.role.definitionHash
    ? '"roleDefinitionHash" does not match the hash given in your instructions'
    : value.profileHash !== profile.profileHash
    ? '"profileHash" does not match the hash given in your instructions'
    : typeof value.summary !== "string" || !value.summary.trim()
    ? '"summary" must be a non-empty string'
    : null;
  if (envelopeFault !== null) {
    throw new Error(`Malformed or stale Hatch writer result envelope: ${envelopeFault}`);
  }
  // Length alone never voids finished writer work; the summary is display prose
  // carried into a report line and a commit body. The turn asks for a shorter
  // one first, and the host clamps only if that is refused.
  const summary = clampSummary(value.summary as string, 2_000);
  if (profile.writer === "doc-gardner") {
    exactKeys(value, [...common, "correctedCount", "filesChanged", "residual"], ["focusStale"]);
    if (!Number.isInteger(value.correctedCount) || Number(value.correctedCount) < 0) {
      throw new Error("Malformed Hatch doc-gardner correctedCount");
    }
    if (value.focusStale !== undefined && (typeof value.focusStale !== "string" || value.focusStale.length > 2_000)) {
      throw new Error("Malformed Hatch doc-gardner focusStale");
    }
    return {
      schema: WRITER_SCHEMA,
      role: "doc-gardner",
      binder,
      roleDefinitionHash: profile.role.definitionHash,
      profileHash: profile.profileHash,
      summary,
      correctedCount: Number(value.correctedCount),
      filesChanged: stringArray(value.filesChanged, "filesChanged"),
      residual: stringArray(value.residual, "residual"),
      ...(value.focusStale === undefined ? {} : { focusStale: value.focusStale }),
      runtime,
    };
  }
  exactKeys(value, [
    ...common,
    "seeded",
    "packsChanged",
    "candidates",
    "erosionNotes",
    "upstreamCandidates",
    "proposedScaffolds",
    "residual",
  ]);
  return {
    schema: WRITER_SCHEMA,
    role: "kaizen",
    binder,
    roleDefinitionHash: profile.role.definitionHash,
    profileHash: profile.profileHash,
    summary,
    seeded: stringArray(value.seeded, "seeded"),
    packsChanged: stringArray(value.packsChanged, "packsChanged"),
    candidates: stringArray(value.candidates, "candidates"),
    erosionNotes: stringArray(value.erosionNotes, "erosionNotes"),
    upstreamCandidates: stringArray(value.upstreamCandidates, "upstreamCandidates"),
    proposedScaffolds: stringArray(value.proposedScaffolds, "proposedScaffolds"),
    residual: stringArray(value.residual, "residual"),
    runtime,
  };
}

export function attestWriterAuthority(
  writer: HatchWriterRole,
  before: WorkerAuthoritySnapshot,
  after: WorkerAuthoritySnapshot,
): WorkerAuthorityAttestation {
  const base = attestWorkerAuthority(before, after);
  const allowed = writer === "kaizen" ? new Set(["protectedPaths"]) : new Set<string>();
  const issues = base.issues.filter((issue) => ![...allowed].some((field) => issue.endsWith(`: ${field}`)));
  return { ...base, passed: issues.length === 0, issues };
}

function writerSystemPrompt(profile: WriterCapabilityProfile, instructions: string): string {
  const output = profile.writer === "doc-gardner"
    ? `{"schema":"${WRITER_SCHEMA}","role":"doc-gardner","binder":"<bound binder>","roleDefinitionHash":"${profile.role.definitionHash}","profileHash":"${profile.profileHash}","correctedCount":0,"filesChanged":[],"residual":[],"summary":"plain-language outcome","focusStale":"optional advisory"}`
    : `{"schema":"${WRITER_SCHEMA}","role":"kaizen","binder":"<bound binder>","roleDefinitionHash":"${profile.role.definitionHash}","profileHash":"${profile.profileHash}","seeded":[],"packsChanged":[],"candidates":[],"erosionNotes":[],"upstreamCandidates":[],"proposedScaffolds":[],"residual":[],"summary":"plain-language outcome"}`;
  return `${profile.role.prompt}

## Committed project instructions

${instructions || "No committed AGENTS.md or CLAUDE.md files were present at this integration tip."}

## Pi writer execution contract — authoritative

You are an isolated ${profile.writer} writer in a disposable worktree. You have only ${profile.toolNames.join(", ")}; there is no shell or Git tool. The host supplied the delivery blast-radius paths because this isolated profile cannot run git diff. Package pack contents supplied in the request are authoritative installed-package inputs.

Edit only your declared surface. Never stage, commit, create refs, or modify Git administration. The host independently attests every changed path, validates applicable files, scans the exact candidate, reproduces hooks, and alone creates or moves commits.${
    profile.writer === "kaizen"
      ? "\n\nAn existing checklist rule's text is immutable and the host compares it byte for byte. Any change to a rule already in the pack — a reword, an appended clause, a typo fix — is refused: the host restores the file and gives you one corrective turn, and a second refusal discards the run. Sharpen by adding a new rule beside the old one; leave the wording of an existing rule to a human. The host cannot tell a tightening from a loosening, so it permits neither. Existing prose outside the checklist must also survive in order, and pack frontmatter is fixed. " +
        KAIZEN_SEEDED_CACHE_RULE
      : ""
  }

Return exactly one JSON object and no prose using this envelope:
${output}`;
}

export class HatchWriterRunner {
  readonly #registry: ChildRegistry;
  readonly #invoke: WriterModelInvoker;

  constructor(registry: ChildRegistry, invoke: WriterModelInvoker = invokeWriter) {
    this.#registry = registry;
    this.#invoke = invoke;
  }

  async run(
    ctx: ExtensionContext,
    writer: HatchWriterRole,
    worktree: string,
    binder: string,
    input: {
      diffRange: string;
      changedPaths: string[];
      focus?: string;
      packs?: HatchResolvedWriterPack[];
      migrationPacks?: HatchResolvedWriterPack[];
      overrideEvidence?: HatchOverrideEvidence[];
    },
    parentId?: string,
    surfaceReview?: WriterSurfaceReview,
  ): Promise<HatchWriterResult> {
    // Resolved before any work, so an unpinned call fails before the authority snapshot.
    const target = requireRoleModel(ctx, writer);
    const profile = createWriterCapabilityProfile(worktree, writer);
    const projectInstructions = await loadWorkerProjectInstructions(worktree);
    const instructions = projectInstructions.map((instruction) =>
      `### ${instruction.path} (blob ${instruction.blob}, sha256 ${instruction.sha256})\n\n${instruction.content}`,
    ).join("\n\n");
    const before = await snapshotWorkerAuthority(worktree);
    let response: { text: string; runtime: ChildRuntimeReport } | undefined;
    let invocationError: unknown;
    try {
      response = await this.#invoke({
        ctx,
        registry: this.#registry,
        profile,
        target,
        binder,
        parentId,
        surfaceReview,
        systemPrompt: writerSystemPrompt(profile, instructions),
        userPrompt: JSON.stringify({ binder, writer, ...input }),
      });
    } catch (error) {
      invocationError = error;
    }
    // Compared against `before` config first, so no status runs under a config the writer changed.
    const after = await snapshotWorkerAuthority(worktree, undefined, undefined, { before });
    const attestation = attestWriterAuthority(writer, before, after);
    if (!attestation.passed) {
      throw new HatchWriterAuthorityError(`Hatch writer violated host authority: ${attestation.issues.join("; ")}`);
    }
    if (invocationError) throw invocationError;
    if (!response) throw new Error("Hatch writer returned no response");
    return {
      ...parseWriterResult(response.text, binder, profile, response.runtime),
      attestation,
    } as HatchWriterResult;
  }
}
