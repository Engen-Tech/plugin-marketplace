import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_INSTRUCTION_FILES = 32;
const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;
const MAX_INSTRUCTION_BYTES = 1024 * 1024;

export interface WorkerProjectInstruction {
  path: string;
  blob: string;
  sha256: string;
  content: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || `git ${args[0] ?? "command"} failed while loading worker instructions`);
  }
}

export async function loadWorkerProjectInstructions(
  worktree: string,
): Promise<WorkerProjectInstruction[]> {
  const names = (await git(worktree, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]))
    .split("\0")
    .filter((path) => {
      const basename = path.split("/").at(-1);
      return basename === "AGENTS.md" || basename === "CLAUDE.md";
    })
    .sort();
  if (names.length > MAX_INSTRUCTION_FILES) {
    throw new Error(
      `Hatch worker found ${names.length} project instruction files; limit is ${MAX_INSTRUCTION_FILES}`,
    );
  }
  const instructions: WorkerProjectInstruction[] = [];
  let totalBytes = 0;
  for (const path of names) {
    const [blob, content] = await Promise.all([
      git(worktree, ["rev-parse", `HEAD:${path}`]).then((value) => value.trim()),
      git(worktree, ["show", `HEAD:${path}`]),
    ]);
    const bytes = Buffer.byteLength(content);
    if (bytes > MAX_INSTRUCTION_FILE_BYTES) {
      throw new Error(
        `Hatch worker instruction '${path}' is ${bytes} bytes; limit is ${MAX_INSTRUCTION_FILE_BYTES}`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > MAX_INSTRUCTION_BYTES) {
      throw new Error(`Hatch worker project instructions exceed ${MAX_INSTRUCTION_BYTES} bytes`);
    }
    instructions.push({
      path,
      blob,
      sha256: createHash("sha256").update(content).digest("hex"),
      content,
    });
  }
  return instructions;
}
