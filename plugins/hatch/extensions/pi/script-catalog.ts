import { requirePackagePath } from "./package-paths.ts";

export const HATCH_SCRIPT_PATHS = {
  captureView: "skills/hatch-validate/scripts/capture_view.py",
  checkDesignPins: "skills/hatch-validate/scripts/check_design_pins.py",
  checkGateReport: "skills/hatch-verify/scripts/check_gate_report.py",
  checkItemProvenance: "skills/hatch-deliver/scripts/check_item_provenance.py",
  checkPackProvenance: "skills/hatch-plan/scripts/check_pack_provenance.py",
  checkSharedTerms: "skills/hatch-plan/scripts/check_shared_terms.py",
  deliverPreflight: "skills/hatch-deliver/scripts/deliver_preflight.py",
  detectStack: "skills/hatch-plan/scripts/detect_stack.py",
  diffCapture: "skills/hatch-validate/scripts/diff_capture.py",
  gateAttempts: "skills/hatch-verify/scripts/gate_attempts.py",
  itemContext: "skills/hatch-build/scripts/item_context.py",
  hatchNext: "skills/hatch-status/scripts/hatch_next.py",
  mergeItem: "skills/hatch-deliver/scripts/merge_item.py",
  mutationSweep: "skills/hatch-build/scripts/mutation_sweep.py",
  resolvePackChecklist: "skills/hatch-kaizen/scripts/resolve_pack_checklist.py",
  runOracle: "skills/hatch-build/scripts/run_oracle.py",
  scanSecrets: "skills/hatch-build/scripts/scan_secrets.py",
  serveDesign: "skills/hatch-validate/scripts/serve_design.py",
  serveStatus: "skills/hatch-status/scripts/serve_status.py",
  validateBinder: "skills/hatch-plan/scripts/validate_binder.py",
  validatePacks: "skills/hatch-kaizen/scripts/validate_packs.py",
} as const;

export type HatchScriptAction = keyof typeof HATCH_SCRIPT_PATHS;

export function resolveHatchScript(action: HatchScriptAction): string {
  return requirePackagePath(HATCH_SCRIPT_PATHS[action]);
}
