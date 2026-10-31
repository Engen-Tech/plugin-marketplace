# Verification Gate

After a work item is built, hatch checks it before it counts as done. The check is a gate, not a suggestion. This file describes the gate's shape; the smart-surfaced-review reference describes the signals it re-runs, and the definition-of-done reference is the canonical source for the floor.

## Shape

The gate runs on the actual diff, in a fresh AI session, with a deliberately thin context: only the worktree, the binder, and the work item's acceptance check (its `oracle`, and `contract` if it has one). It does not inherit the build session's context, and it is independent of whoever implemented the item. The point is to judge the code that exists, not the story the implementer tells about it.

The gate is realized by dispatching two hatch-owned agents — `hatch-acceptance-reviewer` and `hatch-safety-auditor` — plus `hatch-validate` for visual oracles. Each runs read-only: it reports, it never edits.

## When the runtime cannot provide that fresh session

The fresh, independent session is not a nicety — it *is* the gate. So when the runtime cannot spawn a subagent or host worker at all (some hosts gate delegation behind an explicit user opt-in — a Codex session whose tool policy blocks sub-agents until the user asks for them is the common case), hatch has no isolated session to dispatch into, and an inline pass in the build session is the implementer grading its own work — exactly what the gate exists to prevent.

hatch does **not** silently substitute that inline pass. It **surfaces** the condition: name what is blocked (no isolated read-only session is available in this runtime), why it matters (the gate would become the implementer judging itself), and the one action that unblocks it (authorize sub-agents / delegation in the host, then re-run). The item is **blocked at the gate, not passed** — the same halt-and-surface posture as a floor failure. A person may then explicitly accept a clearly-marked *degraded inline review* — recorded like a human accept-waiver — but hatch never makes that substitution on its own and never reports a gate as cleared when only an inline self-review ran.

## Three checks, all on the actual diff

1. **Acceptance.** Does the diff satisfy the oracle's assertions? Visual oracles go to `hatch-validate`, which compares rendered output against the design. Unit, integration, e2e, and smoke oracles go to `hatch-acceptance-reviewer`, which dispositions each assertion against the code.

2. **Contract conformance.** If the item declares a `contract`, the gate checks the diff against an external artifact — a type-checker, a schema, or a contract test — not against the binder's own claim about the contract. A binder field saying "this conforms" is not evidence; the type-checker passing is. `hatch-acceptance-reviewer` owns this check.

3. **Boundary scan.** Does the diff cross a sensitive, destructive, or contract boundary the item never justified? `hatch-safety-auditor` re-runs the seven smart-surfaced-review signals on the real code and flags any crossing the work item did not declare. This is the build-time pass that the smart-surfaced-review reference calls the real gate: the plan-time triage informs, this decides.

## Boundary-only mode for visual oracles

A visual oracle gets its acceptance judgment from `hatch-validate`, but it never skips the boundary scan. hatch-verify has a **boundary-only** mode that runs only the safety-auditor boundary gate — no acceptance phase. hatch-build's Phase 6 dispatches it for visual-oracle items before hatch-validate runs, so a VIOLATION or BLOCKED halts the item before any dev-server work.

## The stack-pack checklist handoff

When the binder pins a non-empty `sme[]`, the dispatcher (hatch-verify) resolves each pinned pack — the project overlay `.hatch/sme/<id>.md` over the built-in copy, project-local wins — validates each overlay with `skills/hatch-kaizen/scripts/validate_packs.py` (a malformed overlay is BLOCKED, never skipped), and hands `hatch-safety-auditor` a normalized item list — rule id, rule text, source pack — never a raw section blob. A pinned id that resolves to no pack is BLOCKED with the missing id(s) named. The auditor fails closed on its end too: a pinned non-empty `sme[]` with no checklists in hand, or any pinned id without a resolved checklist, is BLOCKED — the stack-pack check is skipped only when the binder pins nothing, and every auditor report carries the provenance line `Stack-pack check: ran|skipped|blocked — pinned: [<ids>]; resolved: [<ids>]; items judged: <n>`.

## An empty diff is BLOCKED

hatch has no no-op work item, so a work item whose diff is readable but **empty** — zero changes versus its base — has produced nothing to judge. The acceptance reviewer returns **BLOCKED** for it, before dispositioning any assertion: an empty diff is never CONFORMANT, and it is not a DEVIATION to kick back. It means one of two things — the work was not delivered (a whiff), or the change is already present on the integration tip (a sibling or earlier work landed it). hatch-build's build-time guard catches the whiff before the gate runs: a worker whose branch did not change anything versus its base does not write `built` and halts. The gate is the catch for the already-present case, which shows up when the orchestrator re-validates an item against the moved tip. A BLOCKED-empty halt is surfaced for a person; it is **not** an accept/defer candidate — there is no diff to merge and no named assertion to waive. The ways forward are re-dispatch (a whiff) or drop/amend the item via hatch-plan (already present). A pre-dispatch guard now refuses a gate-agent dispatch whose diff range is empty before either gate agent spins up, so the common case never costs a reviewer context; this section still governs every empty diff that does reach the gate, and on a host with no hook surface — Codex today — it remains the only catch.

## The loop and its caps

On any finding, the gate kicks the work back to the implementer (hatch-build) for bounded self-correction, then re-runs on the corrected diff. The two agents have different caps, and they are deliberately different. Both are counted by hatch-verify's attempt ledger (`gate_attempts.py`, `verify:attempts`), never by memory, so a resumed session reads the real count instead of starting again from zero:

- `hatch-safety-auditor` — **max 3 attempts, then escalate to the human.** A boundary the item never justified is a safety question; if three rounds of self-correction cannot clear it, a person needs to look, because the invariant or the crossing itself may need a decision.
- `hatch-acceptance-reviewer` — **max 2 attempts, then halt with a call to action.** No human escalation here, and **no self-clear**: on the second failed attempt the gate halts and the item takes the halt path — a `failed` ref, no `built`/`done`; it is **not done**. In a wave a worker that caps out here commits its item branch and writes `failed` at that tip (the same `failed` anchor a SPEC-SUSPECT halt leaves), then stops. Declaring debt does **not** make a capped acceptance failure pass — that would let the implementer grade its own escape. The ways forward are (a) **fix-and-rerun**, (b) **re-plan the unmet assertion as an explicit oracle `opt_out` (with a reason) via hatch-plan, then re-run** — the binder is read-only to build, so accepting an unmet assertion is a deliberate plan-time decision, recorded and validated like any opt-out and surfaced in the opt-out summary; or (c) **a human accept-waiver** — the orchestrator asks the human directly (never the worker) and, on a live accept, merges the halted item-branch tip and records the waiver in git (see the integration-branch reference, Accept). hatch has **no backlog**. (`HATCH-DEFER` markers are for inline build-time deferrals, never to clear this gate — see the declared-debt reference.)

A **SPEC-SUSPECT** verdict (the code looks intentional and correct, the binder looks stale) also halts the item; in a wave the worker commits its item branch and writes `failed` at that tip with the spec-suspect reason in its note — the `failed` ref means "halted at the gate, not cleanly done," not "the code is bad." A SPEC-SUSPECT may likewise be resolved by a human accept-waiver (the orchestrator records the waiver against the halted tip; within the run/resume an accepted SPEC-SUSPECT is not re-flagged) or amended via hatch-plan.

There is no automatic human review gate during delivery. The human is reached only on retry-exhaustion of the safety auditor, and — at the delivery orchestrator's Phase-4 halt — for an accept/defer decision. The gate itself never escalates for an accept; it surfaces the halt and the orchestrator asks the human.

## The floor

If the change does not even compile, type-check, or lint, the gate does not pass and hatch does not auto-merge. It surfaces the item for a person instead. This is the floor under every non-opted-out item, and the definition-of-done reference is its canonical statement. A change that cannot clear compile/type-check/lint has not earned an acceptance review — it has earned a surfacing.

The floor's commands do not run bare. hatch-build executes each one — and the item's oracle command — through the deterministic runner `skills/hatch-build/scripts/run_oracle.py`, which judges success mechanically (exit 0, plus an optional `--expect` match) and emits a small capped evidence record in place of a full log. **The record, not a re-read of raw output, is what travels between phases.** The implementer reads its `success`, `exit_status`, and `decisive_output` fields; on a failure the capped `decisive_output` head+tail is the debugging entry point, and the full log is re-examined only inside the worktree, never pasted into a dispatch brief or a report. On a clean floor the record is attached at the item's own namespace, `refs/hatch/<slug>/item-<id>/evidence`, where merge-time re-validation reads it.

### When the oracle command overlaps the floor

For a check oracle, the `oracle.command` is often a superset of the floor — the floor clears compile/type-check/lint, and the command is something wider like `npm run lint && npm test`. That looks like the floor and the gate run the same command twice. They do not. The command runs and the gate inspects, and they sit at different altitudes:

- **Floor — the command runs in the worktree.** hatch-build runs the project's floor commands (and the oracle command, when the project wires it in) inside the build worktree before any handoff, through the deterministic runner. This is execution: the code compiles, type-checks, lints, and the command exits clean, or the item never reaches the gate. What leaves this phase is the capped evidence record at `refs/hatch/<slug>/item-<id>/evidence` — a `decisive_output` excerpt and a mechanical verdict — not the log.
- **Acceptance — the gate reads the diff.** The acceptance gate is read-only. `hatch-acceptance-reviewer` dispositions each oracle assertion against the actual diff and, for a declared `contract`, checks the diff against the external artifact. It does not execute the oracle command. The command's runtime truth belongs to the run that already happened in the worktree, not to the gate.

So there is no double run at the gate. The floor proves the command passed in-worktree; acceptance judges whether the diff honors the oracle's assertions. They are different operations — execute, then inspect — not one check run twice.

The command does get re-executed, but later and at higher altitudes: merge re-validates the oracle against the merged tip — through the same runner, reading the same capped record rather than re-reading raw logs — so the check passes on what actually lands and not just on the item branch; and the project's CI is the final altitude, the authoritative run on the integrated result. A failure that the in-worktree floor cleared can still surface at merge or in CI when the tip has moved — that is the point of re-running there.

This overlap is only about the floor and the gate looking redundant. The genuine two-phase model stays intact for an assertion-bearing oracle — assertions the command does not itself check, a `visual` oracle, or a `contract` artifact: the floor clears compile/type-check/lint, then acceptance dispositions each assertion (or `hatch-validate` compares rendered output, or the gate checks the contract artifact) on its own.

## Advisory hooks

Any pre-tool hook a **project** wires in stays advisory: it exits 0 and never blocks. The gate blocks, not the project's hook. Such a hook can warn at edit time, but the authoritative judgment is the gate running on the actual diff in a fresh session — which self-corrects within its caps, then escalates or halts. A project hook that hard-failed would be a second, hidden gate; hatch keeps exactly one.

hatch's **own** plugin dispatch guards — the auditor-dispatch guard and the gate-dispatch guard — are the sanctioned exception, and they draw the line this rule already implies. They are fail-closed preflights on the *brief*: they refuse a malformed or empty gate dispatch before a gate context spins up. They never read a diff for findings and never render a verdict on the work, so they are not a second gate — the gate remains the one authority on the code itself. In full mode the two gate agents are dispatched in parallel; the verify skill carries the currency rules.
