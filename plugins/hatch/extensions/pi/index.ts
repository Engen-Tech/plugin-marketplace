import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HatchBuildFinalizer } from "./build-finalizer.ts";
import { HatchBuildItemRunner } from "./build-runner.ts";
import { HatchCompanionRunner } from "./companion-runner.ts";
import {
  ChildRegistry,
  GateProviderPreflight,
  runAuthProbe,
  runCancellationProbe,
  runGateAuthProbe,
  runMultiChildShutdownProbe,
  runResponseProbe,
} from "./child-runtime.ts";
import { HatchDeliveryRunner } from "./delivery-runner.ts";
import { DispatchLockManager } from "./dispatch-lock.ts";
import { createHatchDispatchTool } from "./dispatch-tool.ts";
import { claimExtensionInstance } from "./extension-instance.ts";
import { registerGuardAdapters } from "./guard-adapter.ts";
import { HatchIntegrationRunner } from "./integration-runner.ts";
import { PACKAGE_ROOT, requirePackagePath } from "./package-paths.ts";
import {
  resolveRoleModelPlan,
  STEWARD_ROLE_DEFAULTS,
  summarizeRoleModels,
  type HatchModelRole,
} from "./role-models.ts";
import { registerHatchRunRenderers } from "./run-feedback.ts";
import { HatchRunHost } from "./run-host.ts";
import { HatchRunRegistry } from "./run-registry.ts";
import { HatchPlanRunner } from "./plan-runner.ts";
import { HatchProcessManager } from "./process-manager.ts";
import { createHatchScriptTool } from "./script-tool.ts";
import { HatchShutdownCoordinator } from "./shutdown-coordinator.ts";
import { HatchVerificationRunner } from "./verification-runner.ts";
import { HatchWaveRunner } from "./wave-runner.ts";
import { HatchBuildWorkerRunner } from "./worker-runner.ts";
import { HatchWriterRunner } from "./writer-runner.ts";

// The role models the next run would resolve to, or why resolution fails. Status
// reports either; it never throws, so a broken config still shows everything else.
function roleModelsStatus(ctx: ExtensionContext): unknown {
  try {
    return summarizeRoleModels(resolveRoleModelPlan(ctx));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const USAGE =
  "Usage: /hatch-phase0 [status|auth|gate-auth [role]|gate-child [role]|multi-cancel|child|cancel]";

function isModelRole(value: string): value is HatchModelRole {
  return Object.hasOwn(STEWARD_ROLE_DEFAULTS, value);
}

export default async function hatchPi(extension: ExtensionAPI): Promise<void> {
  const releaseInstance = claimExtensionInstance(PACKAGE_ROOT);
  const children = new ChildRegistry();
  const dispatchLocks = new DispatchLockManager();
  const processes = new HatchProcessManager(children.lifecycles);
  const gatePreflight = new GateProviderPreflight();
  const verification = new HatchVerificationRunner(gatePreflight, children, dispatchLocks);
  const workers = new HatchBuildWorkerRunner(children);
  const finalizer = new HatchBuildFinalizer(dispatchLocks, verification);
  const buildItems = new HatchBuildItemRunner(dispatchLocks, workers, finalizer, processes);
  const integrations = new HatchIntegrationRunner(dispatchLocks, verification);
  const waves = new HatchWaveRunner(dispatchLocks);
  const writers = new HatchWriterRunner(children);
  const plans = new HatchPlanRunner();
  const companions = new HatchCompanionRunner(dispatchLocks, writers);
  const deliveries = new HatchDeliveryRunner(
    dispatchLocks,
    processes,
    buildItems,
    integrations,
    workers,
    waves,
    companions,
  );
  const runs = new HatchRunRegistry();
  const runHost = new HatchRunHost({ extension, registry: runs });
  const guards = registerGuardAdapters(extension, runs);
  const shutdown = new HatchShutdownCoordinator({
    children,
    locks: dispatchLocks,
    guards,
    preflight: gatePreflight,
    runs: runHost,
    releaseInstance,
  });
  extension.registerTool(createHatchScriptTool(extension));
  extension.registerTool(
    createHatchDispatchTool(gatePreflight, children, verification, buildItems, deliveries, plans, {
      runs: runHost,
    }),
  );

  extension.on("resources_discover", (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return {};
    return { skillPaths: [requirePackagePath("skills")] };
  });

  extension.registerCommand("hatch-phase0", {
    description:
      "Run Hatch's Pi feasibility probes: status, auth, gate-auth [role], gate-child [role], multi-cancel, child, or cancel",
    handler: async (args, ctx) => {
      const [action = "status", roleArg, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "status") {
        ctx.ui.notify(
          JSON.stringify(
            {
              trusted: ctx.isProjectTrusted(),
              packageRoot: PACKAGE_ROOT,
              model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
              roleModels: roleModelsStatus(ctx),
              activeChildren: children.size,
              activeProcesses: processes.size,
              lifecycles: children.lifecycles.snapshot(),
              gatePreflights: gatePreflight.size,
              dispatchLocks: dispatchLocks.size,
              hatchRuns: runs.snapshots().length,
            },
            null,
            2,
          ),
          "info",
        );
        return;
      }
      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Hatch Phase 0 probes are disabled in an untrusted project.", "error");
        return;
      }
      const takesRole = action === "gate-auth" || action === "gate-child";
      if ((roleArg !== undefined && !takesRole) || extra.length > 0) {
        ctx.ui.notify(USAGE, "warning");
        return;
      }
      const role = roleArg ?? "acceptance-gate";
      if (takesRole && !isModelRole(role)) {
        ctx.ui.notify(
          `Unknown Hatch role '${role}'. Roles: ${Object.keys(STEWARD_ROLE_DEFAULTS).join(", ")}`,
          "warning",
        );
        return;
      }
      try {
        let result: unknown;
        // Resolved on the spot, so a probe runs on exactly the model a run would.
        const roleTarget = () => resolveRoleModelPlan(ctx).roles[role as HatchModelRole];
        switch (action) {
          case "auth":
            result = await runAuthProbe(ctx);
            break;
          case "gate-auth":
            result = await runGateAuthProbe(ctx, roleTarget());
            break;
          case "gate-child":
            result = await gatePreflight.ensure(ctx, children, roleTarget());
            break;
          case "multi-cancel":
            result = await runMultiChildShutdownProbe(ctx);
            break;
          case "child":
            result = await runResponseProbe(ctx, children);
            break;
          case "cancel":
            result = await runCancellationProbe(ctx, children);
            break;
          default:
            ctx.ui.notify(USAGE, "warning");
            return;
        }
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  // Replacing the session stops a live run, so a switch the operator can still veto asks first.
  const confirmReplace = async (ctx: ExtensionContext) => {
    if (!runHost.hasLiveRuns() || !ctx.hasUI) return {};
    const proceed = await ctx.ui.confirm(
      "A hatch run is live",
      `${runHost.liveSummaries().join("; ")}. Switching sessions stops it; rerunning resumes from Git. Switch anyway?`,
    );
    return proceed ? {} : { cancel: true };
  };
  extension.on("session_before_switch", (_event, ctx) => confirmReplace(ctx));
  extension.on("session_before_fork", (_event, ctx) => confirmReplace(ctx));

  extension.on("session_shutdown", async () => {
    await shutdown.shutdown();
  });
  await registerHatchRunRenderers(extension);
}
