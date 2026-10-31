---
name: hatch-debt
model: haiku
description: >-
  Harvest every HATCH-DEFER and HATCH-SME-OVERRIDE marker in the repo into a one-shot, read-only ledger so deliberate shortcuts and overrides don't rot into "later means never". Groups by file, flags deferrals with no follow-up trigger and legacy-format overrides due for migration. Writes nothing, tracks nothing. Trigger phrases: "hatch debt", "list the shortcuts", "what did we defer", "harvest the overrides".
---

hatch-debt collects hatch's inline deferral and override markers into one ledger so a deferral can't quietly become permanent. It is **read-only**: it reads and reports, and changes nothing — consistent with hatch's no-backlog rule (the ledger is a report handed to you once, not a list hatch persists, schedules, or revisits).

## Two marker families

- `HATCH-DEFER(<id>): <what> — <why> — follow-up: <trigger>` — an inline build-time deferral (see hatch-build's references/declared-debt.md).
- `HATCH-SME-OVERRIDE(<rule-id>): <rationale> [ceiling: <bound>; upgrade: <trigger>]` — a deliberate deviation from a stack pack's Review checklist, named by rule id (e.g. `min.2`; see hatch-build, `build:acceptance` step 6-sme). The legacy form `HATCH-SME-OVERRIDE(<pack>: <rule paraphrase>): <rationale>` is still recognized — harvest it, but classify it `legacy-format (migrate to rule id)`.

## Scan

Grep the repo for both markers, skipping VCS / build / vendor output:

`grep -rnE 'HATCH-DEFER|HATCH-SME-OVERRIDE' . --exclude-dir={.git,node_modules,dist,build,.venv}`

Each hit is one ledger row. The marker prefix keeps prose that merely mentions the convention out of the ledger.

## Output

One row per marker, grouped by file:

`<file>:<line>  <family>  <what>.  trigger: <upgrade / follow-up, or "none">.`

Pull the trigger straight from the marker — `follow-up:` for a `HATCH-DEFER`, `upgrade:` for an override. Flag a `HATCH-DEFER` with no `follow-up:` trigger as `no-trigger` — the deferral that silently rots. For a `HATCH-SME-OVERRIDE` the trigger is optional by definition (hatch-build, `build:acceptance` step 6-sme): with an `upgrade:` trigger it is knowingly temporary — report the trigger; without one it is a permanent justified exception — tag it `permanent`, not `no-trigger`. Tag any legacy pack-name override `legacy-format (migrate to rule id)` alongside its other tag.

End with `<N> markers, <M> no-trigger, <L> legacy-format`. Nothing found: `No hatch debt markers. Clean ledger.`

## Boundaries

Reads and reports only — changes nothing, persists nothing, schedules nothing. One-shot. If you want it saved, that is your copy to keep; hatch does not write or track a ledger file. This skill never edits code, tests, or the binder. Write the report in plain language (the hatch-plainlanguage standard).
