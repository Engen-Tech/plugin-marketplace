import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  citationReviewState,
  resolveItemRelations,
  verifyEvidenceIntegrity,
  type CitationReviewState,
  type EvidenceCitationDefect,
  type HatchEvidenceManifest,
} from "./evidence.ts";

const MAX_CUES = 50;
const SENSITIVE_PATH = /(^|\/)(auth|credential|crypto|permission|secret|security|token)(\/|\.|$)/i;
const DEPENDENCY_PATH = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|pyproject\.toml|go\.mod|go\.sum|Cargo\.(toml|lock)|Gemfile(\.lock)?|requirements[^/]*\.txt)$/;
const DESTRUCTIVE_LINE = /\b(drop|delete|truncate|overwrite|force|revert|destroy|remove)\b/i;

export interface BoundaryInspection {
  evidenceHash: string;
  touchedPaths: string[];
  declaredTouches: string[];
  undeclaredTouchedPaths: string[];
  // dependencyPath: a `depends_on` path joins the item to this one, so the overlap is
  // planned sequencing; false is an overlap the plan did not order.
  overlappingWorkItems: Array<{ item: string; paths: string[]; dependencyPath: boolean }>;
  sensitivePathCues: string[];
  dependencyChangeCues: string[];
  destructiveLineCues: string[];
  overrideMarkers: Array<{ rule: string; line: string }>;
  declaredBoundary: {
    contract: unknown;
    sharedResources: unknown;
    surface: unknown;
  };
  citations: Array<{
    index: number;
    path: string;
    locator: string;
    state: "present" | "deleted" | "missing";
    omitted?: "too-large" | "non-blob";
  }>;
  citationDefects: EvidenceCitationDefect[];
  packs: Array<{
    id: string;
    source: "project" | "package";
    sha256: string;
    checklistItems: number;
  }>;
  truncated: boolean;
}

function globExpression(pattern: string): RegExp {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        expression += ".*";
        index += 1;
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function declarationMatches(path: string, declaration: string): boolean {
  const normalized = declaration.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized) return false;
  if (normalized.includes("*") || normalized.includes("?")) {
    return globExpression(normalized).test(path);
  }
  const prefix = normalized.replace(/\/+$/, "");
  return path === prefix || path.startsWith(`${prefix}/`);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

export function inspectBoundaries(manifest: HatchEvidenceManifest): BoundaryInspection {
  verifyEvidenceIntegrity(manifest);
  const item = manifest.payload.workItem;
  const touchedPaths = manifest.payload.diff.touchedPaths;
  const declaredTouches = stringArray(item.touches);
  const undeclaredTouchedPaths = touchedPaths.filter(
    (path) => !declaredTouches.some((declaration) => declarationMatches(path, declaration)),
  );
  const overlaps: BoundaryInspection["overlappingWorkItems"] = [];
  const workItems = manifest.payload.binder.document.work_items;
  const { prerequisites, dependents } = resolveItemRelations(workItems, item.id, manifest.payload.binder.document.supersedes);
  const joined = new Set([...prerequisites, ...dependents].map((relation) => relation.id));
  for (const candidate of workItems) {
    if (candidate.id === item.id) continue;
    const declarations = stringArray(candidate.touches);
    const paths = touchedPaths.filter((path) =>
      declarations.some((declaration) => declarationMatches(path, declaration)),
    );
    if (paths.length > 0) overlaps.push({ item: candidate.id, paths, dependencyPath: joined.has(candidate.id) });
  }
  const lines = addedLines(manifest.payload.diff.content);
  const destructiveLineCues = lines.filter((line) => DESTRUCTIVE_LINE.test(line));
  const overrideMarkers = lines.flatMap((line) => {
    const match = line.match(/HATCH-SME-OVERRIDE\(([^)]+)\):/);
    return match ? [{ rule: match[1].trim(), line: line.trim() }] : [];
  });
  const allCueCount =
    destructiveLineCues.length +
    overrideMarkers.length +
    touchedPaths.filter((path) => SENSITIVE_PATH.test(path) || DEPENDENCY_PATH.test(path)).length;
  return {
    evidenceHash: manifest.evidenceHash,
    touchedPaths,
    declaredTouches,
    undeclaredTouchedPaths,
    overlappingWorkItems: overlaps,
    sensitivePathCues: touchedPaths.filter((path) => SENSITIVE_PATH.test(path)).slice(0, MAX_CUES),
    dependencyChangeCues: touchedPaths.filter((path) => DEPENDENCY_PATH.test(path)).slice(0, MAX_CUES),
    destructiveLineCues: destructiveLineCues.slice(0, MAX_CUES),
    overrideMarkers: overrideMarkers.slice(0, MAX_CUES),
    declaredBoundary: {
      contract: item.contract ?? null,
      sharedResources: item.shared_resources ?? [],
      surface: item.surface ?? null,
    },
    citations: manifest.payload.citations.map(({ index, path, locator, state, omitted }) => ({
      index,
      path,
      locator,
      state,
      omitted,
    })),
    citationDefects: manifest.payload.citationDefects ?? [],
    packs: manifest.payload.packs.map(({ id, source, sha256, checklist }) => ({
      id,
      source,
      sha256,
      checklistItems: checklist.length,
    })),
    truncated: allCueCount > MAX_CUES,
  };
}

const boundaryParameters = Type.Object({ action: Type.Literal("inspect") });

export function createBoundaryInspectionTool(
  manifest: HatchEvidenceManifest,
): ToolDefinition<
  typeof boundaryParameters,
  { evidenceHash: string; citationReview: CitationReviewState }
> {
  verifyEvidenceIntegrity(manifest);
  return {
    name: "hatch_boundary",
    label: "Hatch boundary evidence",
    description:
      "Inspect fixed boundary cues derived from this evidence manifest. It cannot select paths, refs, commands, or files.",
    parameters: boundaryParameters,
    async execute() {
      try {
        const inspection = inspectBoundaries(manifest);
        return {
          content: [{ type: "text", text: JSON.stringify(inspection, null, 2) }],
          details: {
            evidenceHash: manifest.evidenceHash,
            citationReview: citationReviewState(manifest),
          },
          isError: false,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { evidenceHash: manifest.evidenceHash, citationReview: citationReviewState(manifest) },
          isError: true,
        };
      }
    },
  };
}
