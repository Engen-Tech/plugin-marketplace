import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { requirePackagePath } from "./package-paths.ts";

export type HatchRoleId =
  | "acceptance-gate"
  | "safety-gate"
  | "visual-gate"
  | "build-worker"
  | "doc-gardner"
  | "kaizen";

export type HatchRoleAuthority = "read-only" | "worktree-write" | "surface-write";

export type HatchCapability =
  | "evidence.read"
  | "checks.read"
  | "boundary.inspect"
  | "worktree.read"
  | "worktree.write"
  | "command.run"
  | "docs.write"
  | "packs.write";

interface RoleCatalogEntry {
  source: string;
  expectedName: string;
  authority: HatchRoleAuthority;
  capabilities: readonly HatchCapability[];
  outputSchema: "gate-verdict-v1" | "worker-result-v2" | "writer-result-v1";
}

const ROLE_CATALOG: Record<HatchRoleId, RoleCatalogEntry> = {
  "acceptance-gate": {
    source: "agents/hatch-acceptance-reviewer.md",
    expectedName: "hatch-acceptance-reviewer",
    authority: "read-only",
    capabilities: ["evidence.read", "checks.read"],
    outputSchema: "gate-verdict-v1",
  },
  "safety-gate": {
    source: "agents/hatch-safety-auditor.md",
    expectedName: "hatch-safety-auditor",
    authority: "read-only",
    capabilities: ["evidence.read", "boundary.inspect"],
    outputSchema: "gate-verdict-v1",
  },
  "visual-gate": {
    source: "agents/hatch-design-reviewer.md",
    expectedName: "hatch-design-reviewer",
    authority: "read-only",
    capabilities: ["evidence.read"],
    outputSchema: "gate-verdict-v1",
  },
  "build-worker": {
    source: "skills/hatch-build/SKILL.md",
    expectedName: "hatch-build",
    authority: "worktree-write",
    capabilities: ["worktree.read", "worktree.write", "command.run"],
    outputSchema: "worker-result-v2",
  },
  "doc-gardner": {
    source: "agents/hatch-doc-gardner.md",
    expectedName: "hatch-doc-gardner",
    authority: "surface-write",
    capabilities: ["worktree.read", "docs.write"],
    outputSchema: "writer-result-v1",
  },
  kaizen: {
    source: "agents/hatch-kaizen.md",
    expectedName: "hatch-kaizen",
    authority: "surface-write",
    capabilities: ["worktree.read", "packs.write"],
    outputSchema: "writer-result-v1",
  },
};

export interface HatchRoleDefinition extends RoleCatalogEntry {
  id: HatchRoleId;
  sourcePath: string;
  sourceHash: string;
  prompt: string;
  promptHash: string;
  definitionHash: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parsePromptSource(source: string, path: string): { name: string; prompt: string } {
  if (!source.startsWith("---\n")) throw new Error(`Hatch role source has no frontmatter: ${path}`);
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`Hatch role source has unterminated frontmatter: ${path}`);
  const frontmatter = source.slice(4, end);
  const nameLine = frontmatter
    .split("\n")
    .find((line) => line.startsWith("name:"));
  const name = nameLine?.slice("name:".length).trim();
  if (!name) throw new Error(`Hatch role source has no name: ${path}`);
  const prompt = source.slice(end + "\n---\n".length).trim();
  if (!prompt) throw new Error(`Hatch role source has an empty prompt: ${path}`);
  return { name, prompt };
}

export function loadHatchRole(role: string): HatchRoleDefinition {
  if (!Object.hasOwn(ROLE_CATALOG, role)) throw new Error(`Unknown Hatch role: ${role}`);
  const id = role as HatchRoleId;
  const entry = ROLE_CATALOG[id];
  const sourcePath = requirePackagePath(entry.source);
  const source = readFileSync(sourcePath, "utf8");
  const parsed = parsePromptSource(source, sourcePath);
  if (parsed.name !== entry.expectedName) {
    throw new Error(
      `Hatch role '${id}' expected source name '${entry.expectedName}', found '${parsed.name}'`,
    );
  }
  const sourceHash = hash(source);
  const promptHash = hash(parsed.prompt);
  const definitionHash = hash(
    JSON.stringify({
      id,
      sourceHash,
      promptHash,
      authority: entry.authority,
      capabilities: entry.capabilities,
      outputSchema: entry.outputSchema,
    }),
  );
  return {
    id,
    ...entry,
    sourcePath,
    sourceHash,
    prompt: parsed.prompt,
    promptHash,
    definitionHash,
  };
}

export function listHatchRoles(): HatchRoleDefinition[] {
  return Object.keys(ROLE_CATALOG).map(loadHatchRole);
}
