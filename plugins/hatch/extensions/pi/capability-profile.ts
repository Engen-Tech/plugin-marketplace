import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createBoundaryInspectionTool } from "./boundary-inspector.ts";
import { createCheckEvidenceTool } from "./check-tool.ts";
import {
  canonicalJson,
  citationProblemLabels,
  citationReviewState,
  createEvidenceReadTool,
  verifyEvidenceIntegrity,
  type CitationReviewState,
  type HatchEvidenceManifest,
} from "./evidence.ts";
import { loadHatchRole, type HatchRoleDefinition, type HatchRoleId } from "./role-catalog.ts";

export const GATE_CAPABILITY_PROFILE_VERSION = 4;

export type HatchGateRoleId = Extract<HatchRoleId, "acceptance-gate" | "safety-gate" | "visual-gate">;

type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface GateRoleToolState {
  invoked: boolean;
  details?: unknown;
}

export interface GateEvidenceToolState {
  actions: Set<string>;
  packs: Set<string>;
  citations: Set<number>;
  requiredPacks: string[];
  requiredCitations: number[];
  // What the host can prove about repo-rule citations; the safety rules read this.
  citationReview: CitationReviewState;
  citationProblems: string[];
  diffReads: Array<[number, number]>;
  diffTotal: number;
}

export interface GateCapabilityProfile {
  version: typeof GATE_CAPABILITY_PROFILE_VERSION;
  role: HatchRoleDefinition;
  evidenceHash: string;
  tools: AnyToolDefinition[];
  toolNames: string[];
  profileHash: string;
  evidenceToolState: GateEvidenceToolState;
  roleToolState: GateRoleToolState;
}


function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toolIdentity(tool: AnyToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

export function createGateCapabilityProfile(
  roleId: HatchGateRoleId,
  manifest: HatchEvidenceManifest,
): GateCapabilityProfile {
  verifyEvidenceIntegrity(manifest);
  const role = loadHatchRole(roleId);
  if (role.authority !== "read-only") {
    throw new Error(`Hatch gate capability profile requires read-only authority: ${roleId}`);
  }
  const evidenceToolState: GateEvidenceToolState = {
    actions: new Set(),
    packs: new Set(),
    citations: new Set(),
    requiredPacks: manifest.payload.packs.map((pack) => pack.id),
    requiredCitations: manifest.payload.citations.map((citation) => citation.index),
    citationReview: citationReviewState(manifest),
    citationProblems: citationProblemLabels(manifest),
    diffReads: [],
    diffTotal: 0,
  };
  const evidence: AnyToolDefinition = createEvidenceReadTool(manifest);
  const executeEvidenceTool = evidence.execute.bind(evidence);
  const roleToolState: GateRoleToolState = { invoked: false };
  // The visual gate declares only evidence.read, so the evidence tool is itself its
  // role-owned read-only tool — it must never fall through to the boundary inspector.
  const evidenceIsRoleTool = roleId === "visual-gate";
  evidence.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
    const action = (params as { action?: unknown }).action;
    if (typeof action === "string") evidenceToolState.actions.add(action);
    if (action === "pack" && typeof (params as { id?: unknown }).id === "string") {
      evidenceToolState.packs.add((params as { id: string }).id);
    }
    if (action === "citation" && Number.isInteger((params as { index?: unknown }).index)) {
      evidenceToolState.citations.add((params as { index: number }).index);
    }
    const result = await executeEvidenceTool(toolCallId, params, signal, onUpdate, ctx);
    if (action === "diff") {
      // Record the byte range this read covered so grounding can require the whole
      // diff, not just one page. offset defaults to 0; a null nextOffset means the
      // read reached the end (totalLength).
      const details = result.details as { totalLength?: unknown; nextOffset?: unknown } | undefined;
      const total = Number.isInteger(details?.totalLength) ? Number(details?.totalLength) : 0;
      const offset = Number.isInteger((params as { offset?: unknown }).offset)
        ? Number((params as { offset?: unknown }).offset)
        : 0;
      const end = Number.isInteger(details?.nextOffset) ? Number(details?.nextOffset) : total;
      evidenceToolState.diffTotal = total;
      evidenceToolState.diffReads.push([offset, end]);
    }
    if (evidenceIsRoleTool) {
      roleToolState.invoked = true;
      roleToolState.details = result.details;
    }
    return result;
  };
  const roleTool: AnyToolDefinition | undefined =
    roleId === "acceptance-gate"
      ? createCheckEvidenceTool(manifest)
      : roleId === "safety-gate"
        ? createBoundaryInspectionTool(manifest)
        : undefined;
  if (roleTool) {
    const executeRoleTool = roleTool.execute.bind(roleTool);
    roleTool.execute = async (toolCallId, params, signal, onUpdate, ctx) => {
      roleToolState.invoked = true;
      const result = await executeRoleTool(toolCallId, params, signal, onUpdate, ctx);
      roleToolState.details = result.details;
      return result;
    };
  }
  const tools: AnyToolDefinition[] = roleTool ? [evidence, roleTool] : [evidence];
  const toolNames = tools.map((tool) => tool.name);
  if (new Set(toolNames).size !== toolNames.length) {
    throw new Error(`Hatch gate capability profile '${roleId}' contains duplicate tools`);
  }
  const profileHash = hash(
    canonicalJson({
      version: GATE_CAPABILITY_PROFILE_VERSION,
      role: role.id,
      roleDefinitionHash: role.definitionHash,
      evidenceHash: manifest.evidenceHash,
      capabilities: role.capabilities,
      tools: tools.map(toolIdentity),
    }),
  );
  return {
    version: GATE_CAPABILITY_PROFILE_VERSION,
    role,
    evidenceHash: manifest.evidenceHash,
    tools,
    toolNames,
    profileHash,
    evidenceToolState,
    roleToolState,
  };
}
