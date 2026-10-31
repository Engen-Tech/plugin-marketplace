import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadHatchRole, type HatchRoleDefinition } from "./role-catalog.ts";

const WRITER_PROFILE_VERSION = "hatch-writer-profile-v1";

type AnyToolDefinition = ToolDefinition<any, any, any>;
export type HatchWriterRole = "doc-gardner" | "kaizen";

export interface WriterCapabilityProfile {
  version: typeof WRITER_PROFILE_VERSION;
  role: HatchRoleDefinition;
  writer: HatchWriterRole;
  worktree: string;
  tools: AnyToolDefinition[];
  toolNames: string[];
  profileHash: string;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function physicalPath(path: string): string {
  let anchor = path;
  while (!existsSync(anchor)) {
    const parent = dirname(anchor);
    if (parent === anchor) break;
    anchor = parent;
  }
  return resolve(realpathSync(anchor), relative(anchor, path));
}

function normalizedRepoPath(root: string, requested: string): { lexical: string; physical: string } {
  if (!requested || requested.includes("\0")) throw new Error("Hatch writer path is empty or invalid");
  const lexical = resolve(root, requested);
  if (!inside(root, lexical)) throw new Error(`Hatch writer path escapes its worktree: ${requested}`);
  const physical = physicalPath(lexical);
  if (!inside(root, physical)) {
    throw new Error(`Hatch writer path resolves through a symlink outside its worktree: ${requested}`);
  }
  return {
    lexical: relative(root, lexical).split("\\").join("/"),
    physical: relative(root, physical).split("\\").join("/"),
  };
}

export function isWriterWritablePath(writer: HatchWriterRole, repoPath: string): boolean {
  const path = repoPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (writer === "kaizen") {
    return path === ".hatch/kaizen.json" || path.startsWith(".hatch/sme/");
  }
  if (path === ".gitignore") return true;
  if (path.startsWith("docs/")) return true;
  if (path.includes("/")) return false;
  return /^README(?:\..*)?$/i.test(path) || /^ARCHITECTURE(?:\..*)?$/i.test(path) || /\.md$/i.test(path);
}

const INVENTORY_LIMIT = 20_000;
const INVENTORY_OUTPUT_LIMIT = 512 * 1024;
const SEARCH_FILE_LIMIT = 2 * 1024 * 1024;
const SEARCH_TOTAL_LIMIT = 32 * 1024 * 1024;
const SEARCH_MATCH_LIMIT = 500;

async function repositoryFiles(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const paths: string[] = [];
  let truncated = false;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (paths.length >= INVENTORY_LIMIT) {
        truncated = true;
        return;
      }
      const path = join(directory, entry.name);
      const repoPath = relative(root, path).split("\\").join("/");
      if (repoPath === ".git" || repoPath.startsWith(".git/")) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        paths.push(`${repoPath}@`);
      } else if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile()) {
        paths.push(repoPath);
      }
      if (truncated) return;
    }
  };
  await visit(root);
  return { paths, truncated };
}

const inventoryParameters = Type.Object({ action: Type.Literal("list") });

function createWriterInventoryTool(root: string): AnyToolDefinition {
  return {
    name: "hatch_writer_inventory",
    label: "Hatch writer inventory",
    description: "List the disposable worktree's files without following symlinks or exposing Git administration.",
    parameters: inventoryParameters,
    async execute() {
      try {
        const inventory = await repositoryFiles(root);
        let text = inventory.paths.join("\n");
        let outputTruncated = inventory.truncated;
        if (Buffer.byteLength(text) > INVENTORY_OUTPUT_LIMIT) {
          text = Buffer.from(text).subarray(0, INVENTORY_OUTPUT_LIMIT).toString("utf8");
          outputTruncated = true;
        }
        return {
          content: [{ type: "text", text }],
          details: { count: inventory.paths.length, truncated: outputTruncated },
          isError: false,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { count: 0, truncated: false },
          isError: true,
        };
      }
    },
  } as AnyToolDefinition;
}

const searchParameters = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 256 }),
});

function createWriterSearchTool(root: string): AnyToolDefinition {
  return {
    name: "hatch_writer_search",
    label: "Hatch writer search",
    description: "Search repository text for one literal string. Results are bounded and symlinks are not followed.",
    parameters: searchParameters,
    async execute(_toolCallId: string, params: { query: string }) {
      try {
        if (!params.query || params.query.length > 256) throw new Error("Hatch writer search query is invalid");
        const inventory = await repositoryFiles(root);
        const needle = params.query.toLocaleLowerCase();
        const matches: string[] = [];
        let bytes = 0;
        let truncated = inventory.truncated;
        for (const repoPath of inventory.paths) {
          if (repoPath.endsWith("@")) continue;
          const path = join(root, repoPath);
          const stat = await lstat(path);
          if (stat.size > SEARCH_FILE_LIMIT) continue;
          bytes += stat.size;
          if (bytes > SEARCH_TOTAL_LIMIT) {
            truncated = true;
            break;
          }
          const content = await readFile(path);
          if (content.includes(0)) continue;
          const lines = content.toString("utf8").split("\n");
          for (const [index, line] of lines.entries()) {
            if (!line.toLocaleLowerCase().includes(needle)) continue;
            matches.push(`${repoPath}:${index + 1}:${line.slice(0, 1_000)}`);
            if (matches.length >= SEARCH_MATCH_LIMIT) {
              truncated = true;
              break;
            }
          }
          if (matches.length >= SEARCH_MATCH_LIMIT) break;
        }
        return {
          content: [{ type: "text", text: matches.join("\n") }],
          details: { count: matches.length, truncated },
          isError: false,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { count: 0, truncated: false },
          isError: true,
        };
      }
    },
  } as AnyToolDefinition;
}

function confineWriterTool(
  tool: AnyToolDefinition,
  root: string,
  writer: HatchWriterRole,
): AnyToolDefinition {
  const execute = tool.execute.bind(tool);
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requested = (params as { path?: unknown }).path;
      if (typeof requested !== "string") throw new Error(`Hatch writer tool '${tool.name}' requires a path`);
      const paths = normalizedRepoPath(root, requested);
      if (
        paths.lexical === ".git" || paths.lexical.startsWith(".git/") ||
        paths.physical === ".git" || paths.physical.startsWith(".git/")
      ) {
        throw new Error(`Hatch writer tools cannot access Git administration paths: ${requested}`);
      }
      if (["write", "edit"].includes(tool.name)) {
        if (!isWriterWritablePath(writer, paths.lexical) || !isWriterWritablePath(writer, paths.physical)) {
          throw new Error(`Hatch ${writer} cannot write outside its declared surface: ${requested}`);
        }
      }
      return execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

export function createWriterCapabilityProfile(
  worktree: string,
  writer: HatchWriterRole,
): WriterCapabilityProfile {
  const root = realpathSync(worktree);
  const role = loadHatchRole(writer);
  const tools: AnyToolDefinition[] = [
    confineWriterTool(createReadToolDefinition(root), root, writer),
    createWriterInventoryTool(root),
    createWriterSearchTool(root),
    confineWriterTool(createWriteToolDefinition(root), root, writer),
    confineWriterTool(createEditToolDefinition(root), root, writer),
  ];
  const toolNames = tools.map((tool) => tool.name);
  const profileHash = createHash("sha256")
    .update(JSON.stringify({
      version: WRITER_PROFILE_VERSION,
      roleDefinitionHash: role.definitionHash,
      writer,
      worktree: root,
      tools: toolNames,
    }))
    .digest("hex");
  return {
    version: WRITER_PROFILE_VERSION,
    role,
    writer,
    worktree: root,
    tools,
    toolNames,
    profileHash,
  };
}
