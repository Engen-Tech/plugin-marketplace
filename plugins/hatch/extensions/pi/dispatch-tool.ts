import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { ActionUnion } from "./action-union.ts";
import {
  ChildRegistry,
  type GateProviderPreflightReport,
} from "./child-runtime.ts";
import { deriveItemGitState } from "./git-state.ts";
import { loadHatchRole, type HatchRoleDefinition } from "./role-catalog.ts";

const roleId = Type.Union([
  Type.Literal("acceptance-gate"),
  Type.Literal("safety-gate"),
  Type.Literal("visual-gate"),
  Type.Literal("build-worker"),
  Type.Literal("doc-gardner"),
  Type.Literal("kaizen"),
]);

const gateRoleId = Type.Union([
  Type.Literal("acceptance-gate"),
  Type.Literal("safety-gate"),
]);

const dispatchParameters = ActionUnion([
  Type.Object({
    action: Type.Literal("describeRole"),
    role: roleId,
  }),
  Type.Object({
    action: Type.Literal("preflightGate"),
    role: gateRoleId,
  }),
  Type.Object({
    action: Type.Literal("inspectItemState"),
    binder: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    item: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
  }),
  Type.Object({
    action: Type.Literal("deliverBinder"),
    binder: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
  }),
  Type.Object({
    action: Type.Literal("buildItem"),
    binder: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    item: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
  }),
  Type.Object({
    action: Type.Literal("runVerification"),
    binder: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    item: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    mode: Type.Union([Type.Literal("full"), Type.Literal("boundary-only")]),
  }),
  Type.Object({
    action: Type.Literal("planSurvey"),
  }),
  Type.Object({
    action: Type.Literal("commitBinder"),
    binder: Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }),
    set: Type.Optional(
      Type.Array(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" }), {
        description: "Additional binder slugs that are staged with this one and commit together in a single commit.",
      }),
    ),
  }),
]);

export type HatchDispatchParameters = Static<typeof dispatchParameters>;

interface GatePreflight {
  ensure(ctx: ExtensionContext, registry: ChildRegistry): Promise<GateProviderPreflightReport>;
}

interface DispatchDetails {
  action: HatchDispatchParameters["action"];
  role?: string;
  binder?: string;
  item?: string;
  evidenceHash?: string;
  status?: string;
  definitionHash?: string;
  provider?: string;
  model?: string;
  trustedProviderHook?: string;
  cached?: boolean;
  attempts?: number;
  worktree?: string;
  waves?: number;
  commit?: string;
}

function roleSummary(role: HatchRoleDefinition): Record<string, unknown> {
  return {
    role: role.id,
    authority: role.authority,
    capabilities: role.capabilities,
    outputSchema: role.outputSchema,
    sourceHash: role.sourceHash,
    promptHash: role.promptHash,
    definitionHash: role.definitionHash,
  };
}

interface DeliveryRunner {
  run(
    ctx: ExtensionContext,
    binder: string,
  ): Promise<{ status: string; waves: unknown[]; integrationWorktree: string }>;
}

interface BuildItemRunner {
  run(
    ctx: ExtensionContext,
    binder: string,
    item: string,
  ): Promise<{ status: string; attempts: number; worktree?: string }>;
}

interface VerificationRunner {
  run(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    mode: "full" | "boundary-only",
  ): Promise<{ evidenceHash: string; status: string }>;
}

interface PlanRunner {
  survey(ctx: ExtensionContext): Promise<{ schema: string; root: string; runs: unknown[] }>;
  commit(
    ctx: ExtensionContext,
    binder: string,
    set?: string[],
  ): Promise<{ status: string; paths: string[]; card: string; commit?: string; message: string }>;
}

function textResult(text: string, details: DispatchDetails, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

export function createHatchDispatchTool(
  preflight: GatePreflight,
  children: ChildRegistry,
  verification?: VerificationRunner,
  buildItems?: BuildItemRunner,
  deliveries?: DeliveryRunner,
  plans?: PlanRunner,
): ToolDefinition<typeof dispatchParameters, DispatchDetails> {
  return {
    name: "hatch_dispatch",
    label: "Hatch dispatch",
    description:
      "Package-owned Hatch role entrypoint. Surveys a repository for planning, commits a validated binder on the human's own `commit` verb, describes a fixed role, preflights a read-only gate, runs hash-bound verification, or builds one binder-bound item. Callers cannot supply prompts, paths, tools, commands, models, or provider hooks.",
    parameters: dispatchParameters,
    async execute(_toolCallId, params: HatchDispatchParameters, _signal, _onUpdate, ctx) {
      if (!ctx?.isProjectTrusted()) {
        return textResult(
          "Hatch dispatch is disabled in untrusted projects.",
          {
            action: params.action,
            role: "role" in params ? params.role : undefined,
            binder: "binder" in params ? params.binder : undefined,
            item: "item" in params ? params.item : undefined,
          },
          true,
        );
      }
      try {
        if (params.action === "inspectItemState") {
          const state = await deriveItemGitState(ctx.cwd, params.binder, params.item);
          return textResult(JSON.stringify(state, null, 2), {
            action: params.action,
            binder: params.binder,
            item: params.item,
            status: state.state,
          });
        }
        if (params.action === "planSurvey") {
          if (!plans) throw new Error("Hatch plan runner is unavailable");
          const result = await plans.survey(ctx);
          return textResult(JSON.stringify(result, null, 2), {
            action: params.action,
            status: result.schema,
          });
        }
        if (params.action === "commitBinder") {
          if (!plans) throw new Error("Hatch plan runner is unavailable");
          const result = await plans.commit(ctx, params.binder, params.set ?? []);
          return textResult(JSON.stringify(result, null, 2), {
            action: params.action,
            binder: params.binder,
            status: result.status,
            commit: result.commit,
          });
        }
        if (params.action === "deliverBinder") {
          if (!deliveries) throw new Error("Hatch delivery runner is unavailable");
          const result = await deliveries.run(ctx, params.binder);
          return textResult(JSON.stringify(result, null, 2), {
            action: params.action,
            binder: params.binder,
            status: result.status,
            waves: result.waves.length,
            worktree: result.integrationWorktree,
          });
        }
        if (params.action === "buildItem") {
          if (!buildItems) throw new Error("Hatch build-item runner is unavailable");
          const result = await buildItems.run(ctx, params.binder, params.item);
          return textResult(JSON.stringify(result, null, 2), {
            action: params.action,
            binder: params.binder,
            item: params.item,
            status: result.status,
            attempts: result.attempts,
            worktree: result.worktree,
          });
        }
        if (params.action === "runVerification") {
          if (!verification) throw new Error("Hatch verification runner is unavailable");
          const result = await verification.run(ctx, params.binder, params.item, params.mode);
          return textResult(JSON.stringify(result, null, 2), {
            action: params.action,
            binder: params.binder,
            item: params.item,
            evidenceHash: result.evidenceHash,
            status: result.status,
          });
        }
        const role = loadHatchRole(params.role);
        if (params.action === "describeRole") {
          return textResult(
            JSON.stringify(roleSummary(role), null, 2),
            { action: params.action, role: role.id, definitionHash: role.definitionHash },
          );
        }
        if (role.authority !== "read-only") {
          throw new Error(`Hatch gate preflight requires a read-only role, not '${role.id}'`);
        }
        const report = await preflight.ensure(ctx, children);
        return textResult(
          JSON.stringify({ ...roleSummary(role), preflight: report }, null, 2),
          {
            action: params.action,
            role: role.id,
            definitionHash: role.definitionHash,
            provider: report.provider,
            model: report.model,
            cached: report.cached,
            ...(report.trustedProviderHook
              ? { trustedProviderHook: report.trustedProviderHook }
              : {}),
          },
        );
      } catch (error) {
        return textResult(
          error instanceof Error ? error.message : String(error),
          {
            action: params.action,
            role: "role" in params ? params.role : undefined,
            binder: "binder" in params ? params.binder : undefined,
            item: "item" in params ? params.item : undefined,
          },
          true,
        );
      }
    },
  };
}
