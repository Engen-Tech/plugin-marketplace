import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  defineTool,
  truncateTail,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ActionUnion } from "./action-union.ts";
import { PACKAGE_ROOT } from "./package-paths.ts";
import { resolveHatchScript } from "./script-catalog.ts";

const PathValue = Type.String({ minLength: 1, maxLength: 4096 });
export const ScriptParameters = ActionUnion([
  Type.Object({ action: Type.Literal("detectStack"), root: Type.Optional(PathValue) }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("checkPackProvenance"),
      root: Type.Optional(PathValue),
      file: Type.Optional(PathValue),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("validateBinder"), binder: PathValue }, { additionalProperties: false }),
  Type.Object(
    { action: Type.Literal("checkSharedTerms"), binder: PathValue, root: Type.Optional(PathValue) },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("validatePacks"), packs: Type.Array(PathValue, { minItems: 1, maxItems: 64 }) },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("resolvePackChecklist"), pack: PathValue }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("scanSecrets"), allowlist: Type.Optional(PathValue) }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("hatchNext"),
      format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json"), Type.Literal("footer")])),
      binder: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("statusControl"),
      operation: Type.Union([
        Type.Literal("ensure"),
        Type.Literal("optIn"),
        Type.Literal("optOut"),
        Type.Literal("printState"),
      ]),
      root: Type.Optional(PathValue),
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("diffCapture"),
      capture: PathValue,
      out: Type.Optional(PathValue),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("serveDesignSelfTest") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("captureView"),
      designUrl: Type.String({ minLength: 1, maxLength: 4096 }),
      appUrl: Type.String({ minLength: 1, maxLength: 4096 }),
      out: Type.Optional(PathValue),
      artifactsDir: Type.Optional(PathValue),
      viewport: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$" })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      designClickText: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
      appClickText: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
    },
    { additionalProperties: false },
  ),
]);

export type HatchScriptParameters = Static<typeof ScriptParameters>;

export interface ScriptInvocation {
  action: HatchScriptParameters["action"];
  script: string;
  args: string[];
  cwd: string;
  timeout: number;
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function nearestExistingParent(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) throw new Error(`No existing parent for path: ${path}`);
    current = parent;
  }
  return current;
}

function projectPath(
  cwd: string,
  input: string,
  options: { allowPackage?: boolean; mustExist?: boolean; directory?: boolean } = {},
): string {
  if (input.includes("\0")) throw new Error("Path contains a NUL byte");
  const logicalProjectRoot = resolve(cwd);
  const logicalPackageRoot = resolve(PACKAGE_ROOT);
  const projectRoot = realpathSync(cwd);
  const packageRoot = realpathSync(PACKAGE_ROOT);
  const target = resolve(cwd, input);
  const logicalRoots = options.allowPackage
    ? [logicalProjectRoot, logicalPackageRoot]
    : [logicalProjectRoot];
  const physicalRoots = options.allowPackage ? [projectRoot, packageRoot] : [projectRoot];
  if (!logicalRoots.some((root) => isInside(root, target))) {
    throw new Error(`Path is outside the project${options.allowPackage ? " and Hatch package" : ""}: ${input}`);
  }
  if (options.mustExist && !existsSync(target)) throw new Error(`Path does not exist: ${input}`);
  const existing = nearestExistingParent(target);
  const physical = realpathSync(existing);
  if (!physicalRoots.some((root) => isInside(root, physical))) {
    throw new Error(`Path resolves outside its allowed root: ${input}`);
  }
  if (options.directory && existsSync(target) && !statSync(target).isDirectory()) {
    throw new Error(`Path is not a directory: ${input}`);
  }
  return target;
}

function checkedUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  return value;
}

export function buildScriptInvocation(params: HatchScriptParameters, cwd: string): ScriptInvocation {
  const base = { action: params.action, cwd, timeout: 120_000 };
  switch (params.action) {
    case "detectStack":
      return {
        ...base,
        script: resolveHatchScript("detectStack"),
        args: [projectPath(cwd, params.root ?? ".", { mustExist: true, directory: true })],
      };
    case "checkPackProvenance": {
      if (params.root && params.file) throw new Error("checkPackProvenance accepts root or file, not both");
      const args = params.file
        ? ["--file", projectPath(cwd, params.file, { allowPackage: true, mustExist: true })]
        : [projectPath(cwd, params.root ?? ".", { mustExist: true, directory: true })];
      return { ...base, script: resolveHatchScript("checkPackProvenance"), args };
    }
    case "validateBinder":
      return {
        ...base,
        script: resolveHatchScript("validateBinder"),
        args: ["--binder", projectPath(cwd, params.binder, { mustExist: true })],
      };
    case "checkSharedTerms":
      return {
        ...base,
        script: resolveHatchScript("checkSharedTerms"),
        args: [
          "--binder",
          projectPath(cwd, params.binder, { mustExist: true }),
          projectPath(cwd, params.root ?? ".", { mustExist: true, directory: true }),
        ],
      };
    case "validatePacks":
      return {
        ...base,
        script: resolveHatchScript("validatePacks"),
        args: params.packs.map((pack) =>
          projectPath(cwd, pack, { allowPackage: true, mustExist: true }),
        ),
      };
    case "resolvePackChecklist":
      return {
        ...base,
        script: resolveHatchScript("resolvePackChecklist"),
        args: [projectPath(cwd, params.pack, { allowPackage: true, mustExist: true })],
      };
    case "scanSecrets":
      return {
        ...base,
        script: resolveHatchScript("scanSecrets"),
        args: params.allowlist ? ["--allowlist", projectPath(cwd, params.allowlist)] : [],
      };
    case "hatchNext": {
      const args: string[] = [];
      if (params.format === "json") args.push("--json");
      if (params.format === "footer") args.push("--footer");
      if (params.binder) args.push("--binder", params.binder);
      return { ...base, script: resolveHatchScript("hatchNext"), args };
    }
    case "statusControl": {
      const args = [
        params.operation === "ensure"
          ? "--ensure"
          : params.operation === "optIn"
            ? "--opt-in"
            : params.operation === "optOut"
              ? "--opt-out"
              : "--print-state",
      ];
      if (params.root) {
        const root = projectPath(cwd, params.root, { mustExist: true, directory: true });
        if (params.operation === "optIn" || params.operation === "optOut") args.push(root);
        else args.push("--root", root);
      }
      if (params.port) args.push("--port", String(params.port));
      return { ...base, script: resolveHatchScript("serveStatus"), args };
    }
    case "diffCapture": {
      const args = ["--capture", projectPath(cwd, params.capture, { mustExist: true })];
      if (params.out) args.push("--out", projectPath(cwd, params.out));
      return { ...base, script: resolveHatchScript("diffCapture"), args };
    }
    case "serveDesignSelfTest":
      return { ...base, script: resolveHatchScript("serveDesign"), args: ["--self-test"] };
    case "captureView": {
      const args = [
        "--design-url",
        checkedUrl(params.designUrl, "designUrl"),
        "--app-url",
        checkedUrl(params.appUrl, "appUrl"),
      ];
      if (params.out) args.push("--out", projectPath(cwd, params.out));
      if (params.artifactsDir) args.push("--artifacts-dir", projectPath(cwd, params.artifactsDir));
      if (params.viewport) args.push("--viewport", params.viewport);
      if (params.session) args.push("--session", params.session);
      for (const text of params.designClickText ?? []) args.push("--design-click-text", text);
      for (const text of params.appClickText ?? []) args.push("--app-click-text", text);
      return { ...base, script: resolveHatchScript("captureView"), args, timeout: 300_000 };
    }
  }
}

export function createHatchScriptTool(extension: ExtensionAPI) {
  return defineTool({
    name: "hatch_script",
    label: "Hatch script",
    description:
      "Run one fixed Hatch script action from the installed package. Prefer this over checkout-relative Hatch script commands.",
    parameters: ScriptParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.isProjectTrusted()) {
        return {
          content: [{ type: "text", text: "Hatch scripts are disabled in an untrusted project." }],
          details: { action: params.action, code: null, killed: false },
          isError: true,
        };
      }
      let invocation: ScriptInvocation;
      try {
        invocation = buildScriptInvocation(params, ctx.cwd);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { action: params.action, code: null, killed: false },
          isError: true,
        };
      }
      try {
        const result = await extension.exec(
          "uv",
          ["run", "--script", invocation.script, ...invocation.args],
          { cwd: invocation.cwd, signal, timeout: invocation.timeout },
        );
        const stdout = truncateTail(result.stdout);
        const stderr = truncateTail(result.stderr);
        const text = [
          stdout.content || "(no stdout)",
          stderr.content ? `stderr:\n${stderr.content}` : "",
          stdout.truncated || stderr.truncated ? "[output truncated]" : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: {
            action: invocation.action,
            code: result.code,
            killed: result.killed,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          },
          isError: result.code !== 0 || result.killed,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          details: { action: invocation.action, code: null, killed: false },
          isError: true,
        };
      }
    },
  });
}
