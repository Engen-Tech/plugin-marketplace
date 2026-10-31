import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
import { HatchPlanRunner } from "./plan-runner.ts";
import { HatchProcessManager } from "./process-manager.ts";
import { createHatchScriptTool } from "./script-tool.ts";
import { HatchShutdownCoordinator } from "./shutdown-coordinator.ts";
import { HatchVerificationRunner } from "./verification-runner.ts";
import { HatchWaveRunner } from "./wave-runner.ts";
import { HatchBuildWorkerRunner } from "./worker-runner.ts";
import { HatchWriterRunner } from "./writer-runner.ts";

export default function hatchPi(extension: ExtensionAPI): void {
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
  const guards = registerGuardAdapters(extension);
  const shutdown = new HatchShutdownCoordinator({
    children,
    locks: dispatchLocks,
    guards,
    preflight: gatePreflight,
    releaseInstance,
  });
  extension.registerTool(createHatchScriptTool(extension));
  extension.registerTool(
    createHatchDispatchTool(gatePreflight, children, verification, buildItems, deliveries, plans),
  );

  extension.on("resources_discover", (_event, ctx) => {
    if (!ctx.isProjectTrusted()) return {};
    return { skillPaths: [requirePackagePath("skills")] };
  });

  extension.registerCommand("hatch-phase0", {
    description:
      "Run Hatch's Pi feasibility probes: status, auth, gate-auth, gate-child, multi-cancel, child, or cancel",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (action === "status") {
        ctx.ui.notify(
          JSON.stringify(
            {
              trusted: ctx.isProjectTrusted(),
              packageRoot: PACKAGE_ROOT,
              model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
              activeChildren: children.size,
              activeProcesses: processes.size,
              lifecycles: children.lifecycles.snapshot(),
              gatePreflights: gatePreflight.size,
              dispatchLocks: dispatchLocks.size,
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
      try {
        let result: unknown;
        switch (action) {
          case "auth":
            result = await runAuthProbe(ctx);
            break;
          case "gate-auth":
            result = await runGateAuthProbe(ctx);
            break;
          case "gate-child":
            result = await gatePreflight.ensure(ctx, children);
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
            ctx.ui.notify(
              "Usage: /hatch-phase0 [status|auth|gate-auth|gate-child|multi-cancel|child|cancel]",
              "warning",
            );
            return;
        }
        ctx.ui.notify(JSON.stringify(result, null, 2), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  extension.on("session_shutdown", async () => {
    await shutdown.shutdown();
  });
}
