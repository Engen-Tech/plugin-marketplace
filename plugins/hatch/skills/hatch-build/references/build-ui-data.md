# Conditional UI/data annex

Loaded by `hatch-build` when the work item carries `component_map` / `icon_map` / `token_changes` or a `visual` oracle, or when it has a data-layer surface. A backend / CLI / data / IaC item with none of these skips this whole file. Cross-referenced from the core `skills/hatch-build/SKILL.md` at Project configuration (settings), Phase 4d (implementation rules), and Phase 5b (`build:datalayer`).

## Contents
- Conditional UI/data annex settings (resolve only when the item carries the surface)
- DTCG token systems
- Conditional UI/data implementation annex
- Phase 5b — Data-layer conformance loop (full procedure)

---

### Conditional UI/data annex settings (resolve only when the item carries the surface)

These apply **only** when the work item has `component_map` / `icon_map` / `token_changes` or a `visual` oracle. A non-UI item skips them entirely.

| Setting | What it is | How to resolve |
|-|-|-|
| **Component library** | UI-primitive library/libraries (0..n) and install path | Detect from `package.json` deps + existing imports; may be none — then the item's `component_map` "custom" entries are the build list |
| **Icon libraries** | Primary icon source + fallbacks | Detect from deps/imports; may be none |
| **Theme/token system** | Source of truth for colors / spacing / radius / typography | Detect: theme object, CSS custom properties, a design-tokens file (incl. W3C DTCG JSON — see [references/dtcg-tokens.md](references/dtcg-tokens.md)), a utility-class config, or plain CSS |
| **Data layer** | The API the UI reads from, if any | Detect: a GraphQL schema + codegen, OpenAPI/REST types, a tRPC router, generated TS client types; may be none. Note the detector `<data-layer-detector>` and the generated-code dir `<generated-code-dir>` to exclude |
| **Dev server URL/port** | Where the running app is served | Detect from dev-server config / framework defaults; record `<dev-server-port>` and any transitively-started backend port `<backend-port>`. Used only by the visual `hatch-validate` loop |
| **Design source** | The design file/prototype the item validates against | Read the binder's `design_facts.source` and the item's `design_reference` (view/route ID, or the literal `none`) |

Record the resolved values — every later phase references them.

### DTCG token systems

When the theme/token row detects a **W3C DTCG-format design-token file system** (JSON leaves carrying `$value`/`$type`, usually with a token build tool like Style Dictionary / Terrazzo in devDependencies), resolve the DTCG-only settings and build the **token manifest** as described in **[references/dtcg-tokens.md](references/dtcg-tokens.md)**. Everything DTCG-specific — the manifest, the autonomous token-add procedure, and the token-conformance check — is defined there and applies only when the item carries a UI surface and these settings were resolved. A DTCG *design* export mapped into a **non-DTCG** project uses the project's own token mechanism and skips all of it.

---

## Conditional UI/data implementation annex

Applies only when the item carries UI fields (`component_map` / `icon_map` / `token_changes`) — the settings above have been resolved.

**Conditional UI/data implementation annex (only when the item carries UI fields):**

- Use `<component-lib>` components per `COMPONENT_MAP` — do not rebuild primitives the library provides; build the "custom" entries the map lists when there is no library.
- Use the exact icon imports from `ICON_MAP`; for each "Missing Icons" entry, add the custom SVG the plan flagged rather than substituting a different library icon.
- All styling references the project's theme/token system — never hardcode hex/px values that duplicate what the token system provides.
- **DTCG token systems:** consume only the tier the project's convention allows (typically semantic, never primitives) — look variables up in the token manifest, never by grepping generated CSS. An *additive semantic-tier token* the item's `TOKEN_CHANGES` pre-authorizes (operation `add`, semantic tier, name, per-context value) may be added autonomously; the full procedure is in **[references/dtcg-tokens.md](references/dtcg-tokens.md)**. A `requires build-time confirmation` row, a needed token with no row, or no `TOKEN_CHANGES` at all routes to a question.
- Translate design mock data into the project's data layer (GraphQL with fragment colocation, REST calls, typed-client calls per the resolved layer) and the design's client-side navigation into the project's router.

---

## Phase 5b — Data-layer conformance loop (full procedure)

Corresponds to `build:datalayer` in the core SKILL.md — that phase header carries the label; this section is its full body.

**Conditional — UI/data items only.** This phase runs **only when the project has a data layer** (e.g. GraphQL with fragment colocation/codegen, or REST/OpenAPI/tRPC) **and** the item's changed files contain data operations. **Skip the entire phase** when there is no data layer at all, or when no changed file contains a data operation (computed in 5b-1). A backend/CLI/IaC item with no data-layer surface skips it outright. A missing conventions doc is **not** a skip trigger: when a data layer exists but no rules doc was resolved, still run the loop and fall back to the inline read-only pass in 5b-3 (against whatever conventions the repo documents; if truly none, check only that data operations are typed — no `any` — and not duplicated, and note the thin coverage in the report).

This is a UI/data-specific check, distinct from the generic acceptance gate (`build:acceptance`). It validates that created or modified components follow the project's data-layer conventions (for GraphQL: fragment colocation, fragment/operation naming, imports per the project's GraphQL rules, query/mutation tier boundaries; for other layers: schema conformance, typed-client usage) — citing the project's resolved data-layer rules doc where present — before the visual gate and the merge.

#### 5b-1. Identify target files

Only validate files created or modified **in this item** that contain data-layer operations. Use the resolved `<data-layer-detector>` from Project configuration — the literal `graphql(` is just the GraphQL example; for REST/tRPC the detector is "files importing the client or calling the typed endpoints." Anchor on the resolved detector, not the example token. Exclude generated code (the `<generated-code-dir>`, if any) and test files.

Compute the changed-file set **relative to the current integration tip** — the item branched off integration (`build:implement`), so the integration branch is the base, **not** the default branch. Stage new files first (`git add -A`) so untracked, just-created files are included, then enumerate changed files relative to the integration tip:

```bash
integration="hatch/<slug>/integration"
git diff --name-only --diff-filter=ACMR "$integration"...HEAD -- <app-dir/target>
```

Filter the result in memory or with the host's native tools, keeping only files that:

- match the resolved framework's source extensions
- are not under `<generated-code-dir>` when one exists
- are not test/spec files
- contain the resolved `<data-layer-detector>` pattern or import

Use a repo-owned helper script when this logic becomes non-trivial; do not assume Bash pipelines, `grep`, `find`, or WSL exist locally. This produces a list of modified source files (excluding generated code and tests) that contain data-layer operations. If the list is empty, log "No data-layer files modified — skipping data-layer validation" and proceed to the acceptance loop (`build:acceptance`).

#### 5b-2. Per-round structure

```
round = 1
while round <= 3:
  # Re-run the floor if we made fixes (skip for round 1 — the floor `build:floor` already passed)
  # Floor commands go through the runner, exactly as in build:floor:
  #   python3 skills/hatch-build/scripts/run_oracle.py --cwd <resolved cwd> '<lint command>'
  if round > 1:
    run <lint command> && <test command>
    if fail: fix, re-run lint/test

  invoke the data-layer conformance validator (see 5b-3)
  parse the structured report

  issues_count = count of Issues (not Warnings) across all files

  if issues_count == 0:
    break — validation passed

  if round == 3:
    surface residual issues to the user (AskUserQuestion OR host user-input prompt)
    break

  implement fixes based on the report   # 5b-5
  round += 1
```

#### 5b-3. Invoke the data-layer conformance validator

Run a **read-only conformance check** scoped to the target file list from 5b-1. **Strongly prefer a separate read-only subagent OR host worker so the check runs in an isolated context** — the implementer must not grade its own work. If the project provides a dedicated data-layer conformance validator (a subagent, host worker, or skill — e.g. a GraphQL-conventions checker for a GraphQL/Apollo stack, or the project's REST/OpenAPI/tRPC schema-conformance equivalent), use it. Pass it the file list and ask it to check each file against the project's data-layer rules.

Only when the environment provides no subagent, host worker, OR skill mechanism, fall back to an inline read-only pass against the project's data-layer-rules doc, noting that this loses context isolation (the implementer is reviewing its own output). Either way the validator must be **read-only** — it reports, it never edits — and **MUST** return a per-file `STATUS: PASS | ISSUES_FOUND` line plus a summary containing an explicit issue count (e.g. `Issues found: N across M files`), so the loop parses the exit condition deterministically.

#### 5b-4. Parse the report and decide

The report MUST include a per-file `STATUS: PASS | ISSUES_FOUND` line and a summary line with an explicit issue count (e.g. `Issues found: N across M files`); the loop parses that count as its exit condition. Since 5b-1 already excludes generated code and tests, only Issues in non-generated files count.

| Condition | Action |
|-|-|
| `Issues found: 0` (all files PASS) | Exit loop — validation passed |
| Issues found, round < 3 | Fix issues in the main thread, re-run lint/test, re-validate |
| Round 3 reached with residual issues | Stop and **surface to the user** (`AskUserQuestion` OR host user-input prompt) — the worker does not silently self-defer. If the user accepts the residual, it becomes an inline `HATCH-DEFER` marker naming it + an external follow-up (hatch has no backlog), per [references/declared-debt.md](references/declared-debt.md) |

**Warnings are acceptable** — only Issues (clear rule violations) trigger fixes. Do not attempt to fix Warnings.

#### 5b-5. Implement fixes (main thread)

When fixing issues between rounds:

- Use the report's category and line hints to locate each violation.
- Cross-reference the project's data-layer-rules doc for the correct pattern when the category isn't self-explanatory.
- After fixes, re-run `<lint command> && <test command>` before the next validation round — fixes must not break the floor. Run them through `skills/hatch-build/scripts/run_oracle.py` the way `build:floor` does, and read the emitted record's `success`, `exit_status`, and `decisive_output` rather than the raw output, so a UI/data item leaves the same evidence trail as every other item.

#### 5b-6. Edge cases

- **The validator crashes or returns no output:** treat as a failed round. Retry once. If it fails again, skip data-layer validation and note the failure in the final report — don't block on a tooling failure.
- **All issues are in generated code:** shouldn't happen (generated code is excluded in 5b-1), but if it does, treat as a pass.
- **A file was deleted between rounds:** re-compute the target file list before each round to avoid passing stale paths.


