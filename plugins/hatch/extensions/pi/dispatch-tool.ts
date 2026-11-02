import { stat } from "node:fs/promises";
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
import { inspectDispatchLock, resolveDispatchLockPath } from "./dispatch-lock.ts";
import { deriveItemGitState } from "./git-state.ts";
import { loadHatchRole, type HatchRoleDefinition } from "./role-catalog.ts";
import {
  resolveRoleModelPlan,
  summarizeRoleModels,
  withPinnedRoleModels,
  type HatchModelRole,
  type RoleModelPlan,
  type RoleModelSource,
  type RoleModelSummaryEntry,
  type RoleModelTarget,
} from "./role-models.ts";
import type { HatchRunProgress } from "./run-events.ts";
import { runResultSchema } from "./run-feedback.ts";
import type { HatchLaunchOutcome, HatchRunHost } from "./run-host.ts";
import type { HatchRunAction, HatchRunSnapshot } from "./run-registry.ts";

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
  Type.Object({
    action: Type.Literal("runStatus"),
    runId: Type.Optional(Type.String({ pattern: "^hatch-run-[0-9a-f]{8}$" })),
    binder: Type.Optional(Type.String({ pattern: "^[a-z0-9][a-z0-9-]*$" })),
  }),
  Type.Object({
    action: Type.Literal("cancelRun"),
    runId: Type.String({ pattern: "^hatch-run-[0-9a-f]{8}$" }),
  }),
]);

export type HatchDispatchParameters = Static<typeof dispatchParameters>;

interface GatePreflight {
  ensure(
    ctx: ExtensionContext,
    registry: ChildRegistry,
    target?: RoleModelTarget,
  ): Promise<GateProviderPreflightReport>;
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
  runId?: string;
  background?: boolean;
  attached?: boolean;
  roleModels?: Record<HatchModelRole, RoleModelSummaryEntry>;
  notes?: string[];
  thinkingLevel?: string;
  modelSource?: RoleModelSource;
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
    progress?: HatchRunProgress,
  ): Promise<{ status: string; waves: unknown[]; integrationWorktree: string }>;
}

interface BuildItemRunner {
  run(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    progress?: HatchRunProgress,
  ): Promise<{ status: string; attempts: number; worktree?: string }>;
}

interface VerificationRunner {
  run(
    ctx: ExtensionContext,
    binder: string,
    item: string,
    mode: "full" | "boundary-only",
    progress?: HatchRunProgress,
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

// The plan's notes for a sync result's details, only when there are any.
function planNotes(plan: RoleModelPlan): { notes?: string[] } {
  return plan.notes.length > 0 ? { notes: [...plan.notes] } : {};
}

function textResult(text: string, details: DispatchDetails, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    isError,
  };
}

type DispatchResult = ReturnType<typeof textResult>;

function receiptNext(action: HatchRunAction): string {
  return `The run continues in the Pi host and this session is free. Do not poll and do not call hatch_dispatch for this binder again. A hatch-run-result message starts a new turn when the run ends; it carries the ${runResultSchema(action)} result. Use runStatus only if the operator asks, and cancelRun only if the operator asks to stop.`;
}

function runReceipt(snapshot: HatchRunSnapshot, attached: boolean): DispatchResult {
  const receipt = {
    schema: "hatch-dispatch-run-v1",
    runId: snapshot.runId,
    action: snapshot.action,
    binder: snapshot.binder,
    ...(snapshot.item !== undefined ? { item: snapshot.item } : {}),
    ...(snapshot.mode !== undefined ? { mode: snapshot.mode } : {}),
    status: snapshot.status,
    attached,
    startedAt: snapshot.startedAt,
    elapsedMs: snapshot.elapsedMs,
    ...(snapshot.model !== undefined ? { model: snapshot.model } : {}),
    ...(snapshot.roleModels !== undefined ? { roleModels: snapshot.roleModels } : {}),
    ...(snapshot.roleModelNotes !== undefined && snapshot.roleModelNotes.length > 0
      ? { notes: snapshot.roleModelNotes }
      : {}),
    progress: snapshot.progress,
    next: receiptNext(snapshot.action),
  };
  return textResult(JSON.stringify(receipt, null, 2), {
    action: snapshot.action,
    binder: snapshot.binder,
    ...(snapshot.item !== undefined ? { item: snapshot.item } : {}),
    status: snapshot.status,
    runId: snapshot.runId,
    background: true,
    attached,
    ...(snapshot.roleModels !== undefined ? { roleModels: snapshot.roleModels } : {}),
  });
}

// A receipt when the run continues in the host; otherwise the same result or error the
// synchronous path gives, so a lock held by another process stays a plain tool error.
function launchResult<R>(outcome: HatchLaunchOutcome<R>, sync: (result: R) => DispatchResult): DispatchResult {
  if (outcome.kind === "started" || outcome.kind === "attached") {
    return runReceipt(outcome.snapshot, outcome.kind === "attached");
  }
  if (outcome.kind === "returned") return sync(outcome.result);
  if (outcome.kind === "threw") throw outcome.error;
  throw new Error("Unknown Hatch launch outcome");
}

export function createHatchDispatchTool(
  preflight: GatePreflight,
  children: ChildRegistry,
  verification?: VerificationRunner,
  buildItems?: BuildItemRunner,
  deliveries?: DeliveryRunner,
  plans?: PlanRunner,
  options: { runs?: HatchRunHost; resolveRoleModels?: (ctx: ExtensionContext) => RoleModelPlan } = {},
): ToolDefinition<typeof dispatchParameters, DispatchDetails> {
  const runs = options.runs;
  // Resolved once per call, before any runner takes the dispatch lock; every fail-closed
  // case is a tool error here. Callers never supply a model.
  const resolveRoleModels = options.resolveRoleModels ?? ((ctx: ExtensionContext) => resolveRoleModelPlan(ctx));
  return {
    name: "hatch_dispatch",
    label: "Hatch dispatch",
    description:
      "Package-owned Hatch role entrypoint. Surveys a repository for planning, commits a validated binder on the human's own `commit` verb, describes a fixed role, preflights a read-only gate, runs hash-bound verification, or builds one binder-bound item. Callers cannot supply prompts, paths, tools, commands, models, or provider hooks. Long actions return a hatch-dispatch-run-v1 receipt at once in interactive and RPC sessions; the result arrives as a hatch-run-result message. Do not poll.",
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
          const binder = params.binder;
          const plan = resolveRoleModels(ctx);
          const roleModels = summarizeRoleModels(plan);
          const sync = (result: Awaited<ReturnType<DeliveryRunner["run"]>>) =>
            textResult(JSON.stringify(result, null, 2), {
              action: "deliverBinder",
              binder,
              status: result.status,
              waves: result.waves.length,
              worktree: result.integrationWorktree,
              roleModels,
              ...planNotes(plan),
            });
          if (runs?.supportsBackground(ctx)) {
            return launchResult(
              await runs.launch(
                ctx,
                { action: "deliverBinder", binder },
                _signal,
                (runCtx, progress) => deliveries.run(runCtx, binder, progress),
                { roleModels: plan },
              ),
              sync,
            );
          }
          return sync(await deliveries.run(withPinnedRoleModels(ctx, plan), binder));
        }
        if (params.action === "buildItem") {
          if (!buildItems) throw new Error("Hatch build-item runner is unavailable");
          const { binder, item } = params;
          const plan = resolveRoleModels(ctx);
          const roleModels = summarizeRoleModels(plan);
          const sync = (result: Awaited<ReturnType<BuildItemRunner["run"]>>) =>
            textResult(JSON.stringify(result, null, 2), {
              action: "buildItem",
              binder,
              item,
              status: result.status,
              attempts: result.attempts,
              worktree: result.worktree,
              roleModels,
              ...planNotes(plan),
            });
          if (runs?.supportsBackground(ctx)) {
            return launchResult(
              await runs.launch(
                ctx,
                { action: "buildItem", binder, item },
                _signal,
                (runCtx, progress) => buildItems.run(runCtx, binder, item, progress),
                { roleModels: plan },
              ),
              sync,
            );
          }
          return sync(await buildItems.run(withPinnedRoleModels(ctx, plan), binder, item));
        }
        if (params.action === "runVerification") {
          if (!verification) throw new Error("Hatch verification runner is unavailable");
          const { binder, item, mode } = params;
          const plan = resolveRoleModels(ctx);
          const roleModels = summarizeRoleModels(plan);
          const sync = (result: Awaited<ReturnType<VerificationRunner["run"]>>) =>
            textResult(JSON.stringify(result, null, 2), {
              action: "runVerification",
              binder,
              item,
              evidenceHash: result.evidenceHash,
              status: result.status,
              roleModels,
              ...planNotes(plan),
            });
          if (runs?.supportsBackground(ctx)) {
            return launchResult(
              await runs.launch(
                ctx,
                { action: "runVerification", binder, item, mode },
                _signal,
                (runCtx, progress) => verification.run(runCtx, binder, item, mode, progress),
                { roleModels: plan },
              ),
              sync,
            );
          }
          return sync(await verification.run(withPinnedRoleModels(ctx, plan), binder, item, mode));
        }
        if (params.action === "runStatus") {
          const snapshots = runs?.status({ runId: params.runId, binder: params.binder }) ?? [];
          const status: Record<string, unknown> = { schema: "hatch-dispatch-status-v1", runs: snapshots };
          if (params.binder) {
            const lockPath = await resolveDispatchLockPath(ctx.cwd, params.binder);
            const inspection = await inspectDispatchLock(lockPath);
            // The directory is the lock: a crash before owner.json is written still blocks acquire.
            const held = await stat(lockPath).then((entry) => entry.isDirectory(), () => false);
            status.lock = {
              binder: params.binder,
              held,
              readable: inspection.readable,
              ...(inspection.owner
                ? {
                    owner: {
                      pid: inspection.owner.pid,
                      hostname: inspection.owner.hostname,
                      acquiredAt: inspection.owner.acquiredAt,
                      packageVersion: inspection.owner.packageVersion,
                    },
                  }
                : {}),
              ...(inspection.ownerAppearsActive !== undefined
                ? { ownerAppearsActive: inspection.ownerAppearsActive }
                : {}),
            };
          }
          return textResult(JSON.stringify(status, null, 2), {
            action: params.action,
            binder: params.binder,
            runId: params.runId,
            status: "hatch-dispatch-status-v1",
          });
        }
        if (params.action === "cancelRun") {
          if (!runs || !ctx.hasUI) {
            throw new Error("There is no background Hatch run to cancel in this mode");
          }
          const current = runs.status({ runId: params.runId })[0];
          if (!current) throw new Error(`No Hatch run '${params.runId}' in this Pi process`);
          let snapshot = current;
          let declined = false;
          if (current.status === "running") {
            const confirmed = await ctx.ui.confirm(
              `Stop hatch run ${current.runId}?`,
              `${current.action} ${current.binder} is aborted where it stands; rerunning the same action resumes from Git.`,
            );
            if (confirmed) snapshot = (await runs.cancel(current.runId)) ?? current;
            else declined = true;
          }
          const body = {
            schema: "hatch-dispatch-run-v1",
            ...snapshot,
            ...(declined ? { next: "The operator declined; the run continues." } : {}),
          };
          return textResult(JSON.stringify(body, null, 2), {
            action: params.action,
            binder: snapshot.binder,
            runId: snapshot.runId,
            status: snapshot.status,
            background: true,
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
        // The whole table resolves, so a config error anywhere fails here as it would at launch.
        const plan = resolveRoleModels(ctx);
        const target = plan.roles[role.id];
        const report = await preflight.ensure(ctx, children, target);
        // The child report carries the effective level once the runtime records it; until
        // then the requested level from the plan stands in.
        const reported = report as GateProviderPreflightReport & {
          thinkingLevel?: string;
          modelSource?: RoleModelSource;
        };
        const thinkingLevel = reported.thinkingLevel ?? target.thinkingLevel ?? plan.session.thinkingLevel;
        const modelSource = reported.modelSource ?? target.source;
        return textResult(
          JSON.stringify({ ...roleSummary(role), preflight: report }, null, 2),
          {
            action: params.action,
            role: role.id,
            definitionHash: role.definitionHash,
            provider: report.provider,
            model: report.model,
            cached: report.cached,
            ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
            modelSource,
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
