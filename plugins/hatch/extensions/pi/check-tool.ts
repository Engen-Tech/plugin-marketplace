import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  verifyEvidenceIntegrity,
  type HatchCheckManifestEvidence,
  type HatchEvidenceManifest,
} from "./evidence.ts";

export interface CheckToolDetails extends HatchCheckManifestEvidence {
  evidenceHash: string;
}

const checkParameters = Type.Object({ action: Type.Literal("summary") });

export function createCheckEvidenceTool(
  manifest: HatchEvidenceManifest,
): ToolDefinition<typeof checkParameters, CheckToolDetails> {
  verifyEvidenceIntegrity(manifest);
  return {
    name: "hatch_checks",
    label: "Hatch check evidence",
    description:
      "Read the ordered host-generated check manifest bound to this evidence tree. It cannot execute or select commands, paths, environments, refs, or timeouts.",
    parameters: checkParameters,
    async execute() {
      try {
        verifyEvidenceIntegrity(manifest);
        const details: CheckToolDetails = {
          evidenceHash: manifest.evidenceHash,
          ...manifest.payload.checks.manifest,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details,
          isError: false,
        };
      } catch (error) {
        const details: CheckToolDetails = {
          evidenceHash: manifest.evidenceHash,
          status: "missing",
          targetTree: manifest.payload.git.targetTree,
        };
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details,
          isError: true,
        };
      }
    },
  };
}
