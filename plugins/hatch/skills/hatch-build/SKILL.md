---
name: hatch-build
model: sonnet
effort: high
description: >-
  Use when implementing one work item from a hatch binder in an isolated git worktree — stack-agnostic (frontend, backend, CLI, data, IaC, …) — running the project's lint/test/build plus the item's acceptance check, tagging commits, and completing the item on its branch (in a wave the orchestrator merges; invoked directly the worker merges into the per-binder integration branch). No PR. Trigger phrases: "build this binder item", "implement work item `<id>`", "hatch-build `<binder> <id>`".
---

hatch-build takes **one work item from a validated binder** and carries it from pickup to a tagged set of commits that complete the item on its own branch — all inside an isolated git worktree. How the item finishes depends on how the skill was invoked: invoked directly on one item, the worker merges its commits into the binder's **integration branch**; dispatched inside a wave, the worker stops at its committed branch and the orchestrator merges. It is stack-agnostic: the same flow implements a frontend view, a backend endpoint, a CLI command, a data migration, or an IaC change. It does **not** open a PR. The user reviews and merges the integration branch.

**Bundled scripts.** When Pi provides `hatch_script`, it resolves these package-owned scripts; otherwise replace `<skill-dir>` with the absolute directory containing this `SKILL.md` and run the fallback through `uv run --script`. Never resolve a bundled script from the consumer repo's working directory.

## Pi route

When Pi provides `hatch_dispatch`, call it with `action: buildItem`, the binder slug, and the work item id. In an interactive or RPC session on pi 1.4.0 or later it returns at once with a `hatch-dispatch-run-v1` receipt (`status: running`, a `runId`), and the run continues in the Pi host while the session stays free. The host shows progress in the footer and transcript. When the run ends, a `hatch-run-result` message starts a new turn; its content carries the `hatch-build-item-v1` result, so use it exactly as described below. Do not poll, do not call `hatch_dispatch` again for this binder while the run is live, and never answer a Hatch prompt: only the human does. Call `action: runStatus` with the `runId` only when the operator asks how it is going, and `action: cancelRun` only when the operator asks to stop it. In print or JSON mode the call still blocks and returns `hatch-build-item-v1` directly. The package host owns the worktree, isolated worker, checks, gates, commits, refs, retries, and Git-only recovery. Use the `hatch-build-item-v1` result; do not run the legacy phases below yourself or fall back after a tool error. `built` means the item is ready for the binder's serial integration queue. Use `hatch_dispatch` with `action: deliverBinder` when the request is to assemble or finish the binder.

The binder (`.hatch/binders/<slug>.json`) is the cross-skill contract. Each work item carries an `oracle` (its acceptance check) and an optional `contract` (the interface it exposes or consumes). hatch-build reads the binder — it never writes to it during a run (see [references/binder-reference.md](references/binder-reference.md)). The planning counterpart is `hatch-plan`; the read-only acceptance and visual gates are `hatch-verify` / `hatch-validate`.

## How this skill adapts to your project

hatch-build is **stack-agnostic**. It does not assume a frontend framework, component library, data layer, branch convention, or repo layout. It resolves a small set of project settings up front (detect → ask), then implements the item against whatever it finds. Where this document shows a concrete tool, command, or library, treat it as an **example**, not a requirement.

The UI-specific machinery — component maps, icon imports, token rules, the data-layer conformance loop, and the dev-server/visual-validation lifecycle — is a **conditional annex** — see [references/build-ui-data.md](references/build-ui-data.md) and [references/build-visual-validation.md](references/build-visual-validation.md) — that applies only when the item carries `component_map` / `icon_map` / `token_changes`, a data-layer surface, or a `visual` oracle. A backend / CLI / data / IaC item skips both annexes.

## Project configuration (resolve once, up front)

Resolve each setting in this order: **explicit user input → detect from the repo → ask the user** (batch all unknowns into a single question). Do not prompt for things you can detect. **When detection conflicts with explicit user input or the project's documented/blessed stack, the stated stack wins** — confirm it rather than asserting what's merely present (a repo can be mid-migration).

| Setting | What it is | How to resolve |
|-|-|-|
| **App dir / target** | Where the item's code lives, and its task-target name | Detect from the binder's `scope.included` and the repo layout; in a monorepo or polyglot repo, root all paths/commands at the area the item targets; else ask |
| **Command cwd** | The working directory each floor/oracle/env command runs in | Read the oracle's `cwd` and `env_contract.cwd` — both **relative to the item's worktree root** (default = the worktree root itself). When the binder omits it, the command runs from the worktree root; run a toolchain from its own root either by a cwd or by the runner's own directory flag, never both. A floor command you report for the host to rerun carries the cwd you actually ran it from: a command that sets its own directory (`--directory`, `--prefix`, `-C`, `cd`) uses `.`, never the subdirectory it already targets. In a multi-root repo each root keeps its own cwd; when one command must span roots, target each through the runner's own flag (`npm --prefix`, `pnpm -C`, `make -C`, `nx run`) per [references/binder-reference.md](references/binder-reference.md) "Execution context" — never a synthetic root or shim. Project-local tools resolve from this dir — see [references/integration-branch.md](references/integration-branch.md) for env injection |
| **Toolchain commands** | install / lint / test / build / typecheck invocations | Detect from package scripts + task runner (npm/pnpm/yarn, Make, Nx, Turbo, Cargo, Poetry, …); record `<install command>`, `<lint command>`, `<test command>`, `<build command>`, `<typecheck command>`. When both package scripts and a task runner exist, prefer the project's documented entrypoint — a bare script pick can skip orchestrated lint/coverage the runner bundles |
| **Env command** | The dev/test env command and its isolation params | Read the binder's `env_contract` (`command`, `supports_isolation`, `isolation_params`); see [references/integration-branch.md](references/integration-branch.md) for env injection |
| **Required runtime** | The runtime versions the floor/env commands need | Read the binder's optional `runtime_contract` (`runtimes[]` with `name`/`version`, `on_unavailable: halt`). When absent, fall back to detecting the repo's pin files (`.nvmrc`, `.tool-versions`, `.python-version`) and manifest fields (`engines`, `requires-python`). A preflight in `build:sanity`/`build:floor` **checks** the active runtime against the declaration and **halts** on mismatch — hatch never installs or selects a runtime itself |
| **Default branch** | The repo's mainline (only the fallback base, not the build base) | Use the delivery packet's `default_branch`. Standalone, resolve it offline in the same order: `git config hatch.defaultBranch`, then the local `refs/remotes/origin/HEAD`, then the only local non-`hatch/*` branch or exactly one of `main`/`master`; if none settles it, ask rather than guess. Never `git remote show origin` — it contacts the remote and can hang |
| **Integration branch** | The binder's integration branch and its worktree | `hatch/<slug>/integration`, where `<slug>` is the binder's `slug` field. This — not the default branch — is the base for the item's worktree (see `build:implement`) |
| **Worktree root** | Parent dir for per-item worktrees | Ask/default to a sibling dir (e.g. `../<repo>-worktrees/`) |
| **Git identity** | Author identity for commits | `git config user.name` / `user.email`. If unset, ask once or record an explicit "unattributed" note — do not silently invent one. This is **commit authorship only**, not a ticketing identity |
| **Project rules** | Component-structure, data-layer, and convention docs | Detect: contributor docs, lint configs, rules files; cite them during implementation/fixes if present, else fall back to inline generic conventions |
| **Repo policy** | Branch/CI/ruleset/deployment policy, only when the item touches those areas | Read root/area `AGENTS.md`, existing workflows, CI docs when remote policy is in scope. For details load [references/ci-policy.md](references/ci-policy.md) and [references/policy-yagni.md](references/policy-yagni.md) |
| **stack packs** | Advisory expert do's/don'ts to write against, with an enforceable Review checklist | Read the binder's `sme`; resolve each id against the project overlay `.hatch/sme/*.md` laid over the built-in [references/sme/](references/sme/) |

### Conditional UI/data annex settings and DTCG tokens

When the item carries `component_map` / `icon_map` / `token_changes` or a `visual` oracle, resolve these settings (and any DTCG token settings) from [references/build-ui-data.md](references/build-ui-data.md) before proceeding. Non-UI items skip it. Record resolved values for later phases.

---

## Workflow

### Always-on mutation guard

Before any file mutation, apply [references/worktree-safety.md](references/worktree-safety.md): assert the intended root with `git rev-parse --show-toplevel`, check the current branch with `git branch --show-current`, and refuse implementation edits when the root or branch is wrong. Repeat this after creating a worktree, changing directories, resuming after context compaction, or any failed patch. After the worktree is created (`build:implement`), the intended root is the implementation worktree, not the original checkout. The binder is **read-only** to build — never edit it.

### Phase 0 — Classify intent before choosing a workflow  `build:classify`

Classify the request before framing the work:

- **implementation of a binder work item** — normal `hatch-build` execution (from `build:gate` onward)
- **inspection aid** — behavior works, but the user needs to see or hold a state such as a login screen
- **bug fix** — behavior is broken or regressed
- **product feature** — new behavior not already in the binder
- **CI/policy change** — workflow, ruleset, branch, deployment, generated-contract, or environment behavior

If the user corrects the category, drop the old framing immediately. For inspection aids and CI/policy changes, keep scope explicit and contained unless the user asks for a permanent product change.

**Ticketless inspection-aid mode.** If the request is a narrow inspection aid and no binder work item drives it, do not force the binder gates. Use this limited flow:

1. Resolve the app dir/target, toolchain, default branch, worktree root, and relevant project rules from Project configuration.
2. State the high-impact mutation preview from `build:implement` and wait for confirmation before editing.
3. Create an isolated worktree from the default branch with a branch like `inspect_<short-slug>`.
4. Run the mutation guard before every edit.
5. Implement only the confirmed inspection aid.
6. Run the relevant lint/test/build checks.
7. Report the worktree path and changed files. Do not merge into integration unless the user explicitly asks.

This mode is for observability/inspection only. If the change becomes product behavior, convert it to a binder work item or an explicit product-feature request.

### Phase 1 — Input, validate, and gate the work item  `build:gate`

The input is `(binder path, work-item id)` — **not** a ticket file. Resolve both from the user (default binder location `.hatch/binders/<slug>.json`; see [references/binder-reference.md](references/binder-reference.md)).

**With an `item_context.py` packet in the dispatch brief (a wave dispatch — see hatch-deliver's Step 2), Gates 1-3 below and the Extract-and-cache step are satisfied FROM IT.** The orchestrator's own preflight (`deliver_preflight.py`) already validated the binder, so Gate 1 is met; the packet's `item` field, present and non-null, is Gate 2; its `dependencies` map — `{dep_id: {done_ref, target}}` — answers Gate 3 directly (a null `target` is an unmet dependency). Read `oracle_cwd`, `oracle_expect`, `dependencies`, and `sme` (with its already-composed checklists) straight off the packet instead of re-deriving them: do not re-run `validate_binder.py`, and do not search the filesystem for its path or any other script's. **Without a packet — a directly-invoked worker — run the three gates below as written; nothing about that path changes.**

Three gates, **all must pass**. Any failing is an immediate hard stop — report and exit, no "continue anyway?".

**Gate 1 — The binder validates.** Run `uv run --script <skill-dir>/../hatch-plan/scripts/validate_binder.py --binder <binder path>` (schema validity, dependency cycles, dangling `depends_on`). If the orchestrator already validated the binder for this run, take that as satisfied rather than re-running — but never skip validation when invoked directly. On failure, bail with the validator's output.

**Gate 2 — The item id exists.** Find the work item whose `id` equals the requested id in the binder's `work_items`. If none matches, bail with the requested id and the list of available ids.

**Gate 3 — Dependencies are merged.** Every id in `depends_on` must already be merged into the integration branch — i.e. its done ref exists (`refs/hatch/<slug>/item-<dep-id>/done`; see [references/integration-branch.md](references/integration-branch.md)). Unmet deps **halt with a call to action** naming them; `depends_on` is a scheduling constraint, not something to build past.

**Resolve git identity** (Project configuration) for commit authorship only — no ticketing system, assignee, or status field. If `git config` has no `user.email`/`user.name`, ask once or record an explicit "unattributed" note.

**Extract and cache** from the item (or the packet's `item`/`dependencies`/`sme` fields, when present) for later phases: `ITEM_ID` (the `id`, driving the branch name and `[hatch:item-<id>]` marker); `ITEM_ORACLE` (`type`/`assertions`/`command`, or `opt_out`+`reason`); `ITEM_CONTRACT`, if present; `ITEM_DEPS` (the resolved, all-merged `depends_on` ids); `SERIALIZE`/`SHARED_RESOURCES`, if present (the orchestrator's concern, noted here); `RUN_MODE` — **single-item hatch** vs **orchestrated wave**, an **explicit signal** (`hatch-deliver` tells a wave worker so at dispatch; a worker invoked directly with no such signal defaults to single-item) that decides who owns the terminal merge in `build:merge` (see [references/integration-branch.md](references/integration-branch.md)) — never infer it from the integration branch's existence or wave-mates; UI annex fields **only if present** (`COMPONENT_MAP`, `ICON_MAP`, `TOKEN_CHANGES`, `DESIGN_REFERENCE`, `VISUAL_CHECK_WAIVER`, and the binder's `design_facts.source` — a `visual_check_waiver` names the item whose visual gate covers this one via `covered_by`, and routes nothing: `build:acceptance`'s gate choice still keys on this item's own `oracle.type`); and `SME_PACKS` (the binder's `sme` list), resolved and loaded in `build:implement`, self-checked before the gate in `build:acceptance` (6-sme).

### Phase 2 — Sanity-check the item against the codebase  `build:sanity`

**With an `item_context.py` packet, `oracle_cwd`/`oracle_expect`/`dependencies` are already resolved — this phase does not re-derive them.** Read the work item and the binder's `scope`, `design_facts`, and `env_contract`. Then verify the item against the current code:

- **Do referenced/reused files still exist?** Read the paths the item's plan cites as existing. (Do not existence-check files the item is meant to create.)
- **Do new files conflict with existing ones?** Flag any path the item creates that already exists with different content — a conflict to resolve, not the greenfield case.
- **Is a shared file co-owned by an earlier item?** An item may legitimately modify a file an earlier **depended-on** item created — e.g. a view item adding its route to the app shell's `app.ts`, or an endpoint item registering itself in `main.py` — as long as that file is inside the binder's `scope.included`. (There is no per-item scope field; the binder's `scope.included` is the boundary.) This is allowed when the edit is **additive and scoped to the item's own surface** (registering a route, mounting a component, adding a handler). Make the smallest change that wires in this item; do not refactor or restyle the co-owned file beyond what this item needs. If the edit would rewrite shared structure rather than extend it, that is blast-radius the item did not authorize — flag it and ask. Two wave-mates that both edit a co-owned file is a serialization concern the orchestrator's parallelism gates handle, not a build-time decision; honor a declared `serialize` / `shared_resources` rather than racing the edit.
- **Do citations still resolve?** Search for any "reuse `<path>`" target with the host's fastest code-search tool.
- **Has the surrounding code drifted?** Confirm the function signatures and data shapes the item depends on still match — including anything a merged dependency introduced on the integration tip.
- **Contract sanity.** If the item declares an `ITEM_CONTRACT`, confirm the external artifact it names (a type, a schema, a contract test) still exists and is the shape the item expects.
- **Runtime sanity.** Read the binder's optional `runtime_contract`. For each declared runtime, compare the active version on the host (`node --version`, `python --version`, the host equivalent) against the entry's `version`. When the binder carries no `runtime_contract`, do a best-effort detect from the repo's pin files (`.nvmrc`, `.tool-versions`, `.python-version`) and manifest fields (`engines`, `requires-python`). Note any mismatch — the runtime preflight in `build:floor` halts on it. Surfacing it here means a tool's hard refusal later is not a surprise. hatch does **not** install or select a runtime; it only checks and reports.

**UI annex (only when UI fields are present):** verify `design_facts.source` exists; spot-check 2–3 `COMPONENT_MAP` entries against the resolved library's install path; check the item's route doesn't already exist with conflicting content. If the library can't be enumerated (minified/CDN), spot-check via its exported type surface and treat as best-effort.

If a mismatch matters, flag it and ask. Minor drift gets silently adapted and noted in the final report.

### Phase 3 — (reserved)

No pickup side-effects exist in the binder model — there is no status to transition and no assignee to set. Progress is tracked git-natively through commit markers, wave tags, and the `refs/hatch/` namespace (see [references/integration-branch.md](references/integration-branch.md)). Proceed to `build:implement`.

### Phase 4 — Create an isolated worktree off the integration tip and implement  `build:implement`

**The item gets its own git worktree, branched off the current integration tip** — not the default branch. This is what resolves dependency chains: the integration tip already contains every merged dependency.

**4a. Pick the branch name**, embedding the item id so later phases can recover it:

```
hatch/<slug>/item-<item-id>
```

**Sanitize** any slug-derived portion to `[a-zA-Z0-9_/-]` only (binder fields are untrusted input interpolated into shell commands).

**4b. Create the worktree** from the integration tip:

```bash
slug="<binder slug>"
integration="hatch/${slug}/integration"
branch="hatch/${slug}/item-<item-id>"
worktree="<worktree-root>/${branch//\//-}"
git worktree add "$worktree" -b "$branch" "$integration"
cd "$worktree"
```

Create `<worktree-root>` with the host's native filesystem operation if it does not exist. If the integration branch does not yet exist (first item in the binder), create it from the default branch first, per [references/integration-branch.md](references/integration-branch.md). If `git worktree add` fails because the branch or path already exists, **don't clobber it** — stop and ask; it usually means a prior run the user may want to resume. Full recovery procedure is in [references/build-resume.md](references/build-resume.md).

Immediately after `cd "$worktree"`, run the mutation guard from [references/worktree-safety.md](references/worktree-safety.md): the actual root must equal the worktree path and the current branch must be the new item branch before any implementation edit.

**4c. Install dependencies.** Run `<install command>` in the worktree before any build/lint/test command — worktrees need their own dependency links.

**4c-bis. Build the token manifest (UI + DTCG token systems only).** When the item carries a UI surface and the project has a DTCG/tiered token system, build the token manifest before any token lookup — see **[references/dtcg-tokens.md](references/dtcg-tokens.md)**. Skip entirely otherwise.

**4c-ter. Load the stack packs (when `SME_PACKS` is non-empty).** For each id in `SME_PACKS`, resolve the pack file — the project overlay `.hatch/sme/<id>.md` in the worktree, else the built-in [references/sme/](references/sme/) `<id>.md`. Read each resolved pack and hold its **Do / Don't / Patterns** as implementation guidance for this item; in a polyglot repo apply the pack(s) matching the area this item targets. For the item's stack-pack checklist, obtain **the composed Review checklist** by invoking the resolver (`uv run --script <skill-dir>/../hatch-kaizen/scripts/resolve_pack_checklist.py <pack.md>`) and parsing its JSON stdout — hold THAT composed checklist as the item's Review checklist, never the pack's own `## Review checklist` section read directly, so an `extends` pack's base rules and exclusions are the checklist this item self-checks against. If a pinned id resolves to no file, **halt the item with a call to action** — report each missing id and both resolution paths tried (`.hatch/sme/<id>.md`, `references/sme/<id>.md`). A pinned pack the build cannot load is a binder error to fix via hatch-plan, never a note to skim past; `hatch-verify` treats the same gap as BLOCKED. Follow this guidance while implementing (4d) and while fixing any gate kickback.

**Precedence:** a documented convention in the target repo's own CLAUDE.md/AGENTS.md wins over a built-in pack rule. When the two conflict, follow the repo rule and declare the deviation with a `HATCH-SME-OVERRIDE` marker (see 6-sme) whose rationale cites the repo rule as `repo-rule: <path>:<line-or-section>`.

**4d. Implement the item** against the resolved conventions, stack-agnostically. Key rules:

**High-impact mutation preview.** Before editing auth, routing, guards, security, CI/CD, rulesets, branch policy, deployment, generated contracts, or environment files, state: the exact behavior change; likely files/workflows touched; what stays unchanged; and rollback/containment notes when relevant. Wait for confirmation when the user asked to approve first, or when the change introduces route/security/policy behavior the item did not already authorize.

**CI/policy items.** If the item touches CI, repository automation, branch policy, rulesets, required checks, deployment, generated contracts, or environment policy, load [references/ci-policy.md](references/ci-policy.md) and [references/policy-yagni.md](references/policy-yagni.md) before editing. Summarize the current repo policy first, keep workflows thin, distinguish "runs" from "required", and do not add fork hardening, merge queues, CODEOWNERS, or similar controls unless repo policy or explicit direction requires them.

**Greenfield / scaffold mode (foundation or first item only).** Triggers when the integration branch doesn't yet exist and the item's contract is to stand up the project/framework, not edit existing conventions. When it triggers, read [references/build-greenfield.md](references/build-greenfield.md) first for the full scaffold rules. Otherwise skip it and implement against the resolved conventions below.

**General implementation rules (every stack):**

- Follow the project's structure and convention docs — cite a resolved rules doc if one exists, else apply sensible inline conventions.
- Implement against the resolved `ITEM_CONTRACT` when present — produce the interface the contract names; do not diverge from it silently.
- **Declare deferrals inline.** When you skip a test, stub a dependency, or defer an edge case, place a `HATCH-DEFER(<id>)` marker at the exact site per [references/declared-debt.md](references/declared-debt.md). A deferral is recorded, never silent — it surfaces in the final report. This inline use is the implementer's call; it is **not** a way to clear the acceptance gate — a capped acceptance failure is never escaped by self-declaring debt (see the acceptance cap in `build:acceptance` and [references/declared-debt.md](references/declared-debt.md)).
- **Never weaken the oracle.** Do not edit or soften the item's `oracle`/acceptance assertions (or its `contract`) to make a check pass. On a genuine oracle-or-contract conflict — the item cannot be implemented as specified without violating one — **halt with a call to action** rather than silently diverging. Code, specs, and tests win; the implementer does not get to move the goalposts. When a *fresh scaffold* lacks a check the oracle names, that is the absent-check case, not a conflict — provision the named tooling through the framework's own add/plugin command (see Greenfield / scaffold mode above). A check that **exists but fails** is always a real failure, never the absent-check carve-out.

**Conditional UI/data implementation annex (only when the item carries UI fields).** Rules are in [references/build-ui-data.md](references/build-ui-data.md). A non-UI item skips it.

All subsequent phases run from inside the worktree. Stay `cd`'d there until the skill finishes.

### Phase 5 — Deterministic gate (the floor)  `build:floor`

**Runtime preflight — check, then halt (never auto-provision).** A floor command can hard-refuse on a runtime mismatch: a CLI that demands a minimum Node exits non-zero before any of your code runs. So before any floor command, check the active runtime against the declaration:

1. For each runtime in the binder's `runtime_contract` (or, when absent, each version pinned by the repo's `.nvmrc` / `.tool-versions` / `.python-version` / `engines` / `requires-python` detected in `build:sanity`), compare the active host version against the entry's `version`.
2. **On a mismatch, halt with a call to action** — report the required version, the active version, and the pin file/source. hatch does **not** install or select a runtime; provisioning a runtime is a hermeticity and supply-chain concern that stays the operator's. `on_unavailable` carries the single value `halt`; this is the same hard-gate idiom hatch uses for the playwright/uv preflights — surface the gap, do not auto-fix.
3. When the repo declares its own version manager (a `mise`/`asdf`/Volta config), the floor and oracle commands **may** route through it (e.g. `mise exec -- <command>`) so they run under the declared version. This is using the repo's own pinned runtime, not hatch selecting one.

**Tool-imposed runtime floors — a floor that is in no pin file.** The preflight above checks *declared* floors (the `runtime_contract`, or pins in `.nvmrc` / `.tool-versions` / `.python-version` / `engines` / `requires-python`). A second class exists: a floor **imposed by a tool itself** that no pin file records — `@angular/cli@22` hard-refuses Node < 24.15.0, a bundler rejects an old Node, a formatter needs a newer Python. It surfaces only as a tool's hard-refusal at install/run, after the declared preflight has already passed clean. The adapt-vs-halt choice is **explicit and decided by mode**, never improvised in the moment:

- **Greenfield / scaffold.** Pinning a compatible tool version (not a runtime) is allowed here — see [references/build-greenfield.md](references/build-greenfield.md).
- **Non-greenfield (edit mode).** An existing project already pins its tools; a tool hard-refusing on the host runtime is an **environment mismatch**, not something to silently paper over by downgrading a dependency the project relies on. **Halt with a call to action** — name the tool, its required runtime, and the active runtime — the same surface-don't-fix idiom as the declared preflight. Surface the durable fix in that CTA: the floor should be recorded in the binder's `runtime_contract` (a re-plan via hatch-plan — the binder is read-only to build) so the *declared* preflight catches it next run, rather than leaving it to a runtime hard-refusal.

The line that must not blur: pinning a *tool* version to fit the host's runtime is a tool choice (allowed in greenfield); selecting or installing a *runtime* is never hatch's to make.

Only once the active runtime satisfies the declaration do the floor commands run.

Run from the worktree before the acceptance loop. This is the floor under every non-opted-out item — compile / type-check / lint clean (see [references/definition-of-done.md](references/definition-of-done.md)):

```bash
<lint command>
<typecheck command>
<test command>
<build command>
```

Run whichever of these the project defines. If any fails, fix it in this thread — you own the code — and do not proceed to the acceptance loop until the floor is clean. A change that cannot clear the floor has not earned an acceptance review; if fixes take more than ~2 attempts, surface to the user.

**Every floor and oracle command runs through the deterministic runner — you read its record, not a log.** Execute each one as:

```bash
uv run --script <skill-dir>/scripts/run_oracle.py --cwd <resolved cwd> [--expect <oracle.expect>] '<command>'
```

`--cwd` is the item's resolved execution context per [references/binder-reference.md](references/binder-reference.md), "Execution context": the oracle's own `cwd` when set, else the worktree root. Pass `--expect` when a check oracle declares an `expect` string. It judges success mechanically — exit 0, plus the expect match when given — and emits a capped JSON evidence record. Output is decoded as UTF-8 with replacement (`decisive_output.lossy` flags invalid bytes and `decode_error` names the first one), and only a bounded head and tail are kept in memory (`decisive_output.stream_truncated`); `--expect` is matched on the full stream, `--expect-re` only on the retained head and tail. Read its `success`, `exit_status`, and `decisive_output` fields instead of scrolling raw output. **On a failure, the record's `decisive_output` head+tail is the debugging entry point.** Re-examine the full log only inside the worktree, and only when the capped output is genuinely insufficient — never paste raw log text into a dispatch brief or a report.

**On a clean floor, attach the record.** Re-run the oracle command with `--attach-ref refs/hatch/<slug>/item-<id>/evidence --repo <worktree>` so the record lands at the item's evidence ref, where merge-time re-validation reads it (see [references/integration-branch.md](references/integration-branch.md)).

The oracle runner also compares `tree_before_sha` with `tree_sha`. If source changes during the command, it emits `tree_changed: true`, reports `success: false`, and exits nonzero even when the command exited zero. Prepare generated inputs first, inspect the changes, then rerun the oracle on the stable tree. Do not attach the mutating run as passing evidence. Ignored build outputs do not change the Git source tree.

**The resolved cwd is the mechanism — never a shim.** Project-local binaries resolve through that dir as each runner provides them: `npm`/`pnpm`/`yarn run` put the package's `node_modules/.bin` on `PATH`, `uv run` executes inside the project's `.venv`, `make -C <dir>` runs the recipe in that dir. **Do not invent a root `package.json`, a `bin/` shim, or a hand-assembled `PATH`.** When one oracle command must span more than one toolchain root, drive each root through the runner's own root-targeting flag (`npm --prefix`, `pnpm -C`, `make -C`, `nx run`) rather than synthesizing a root — the full table is in binder-reference.md, "Execution context".

**A command-shaped oracle check runs here, at the floor.** When `ITEM_ORACLE.command` duplicates a floor check (the oracle command is `npm run lint`, which `<lint command>` already runs), it simply runs here — there is no second phase that re-executes it. The acceptance gate (`build:acceptance`) is read-only: it inspects and dispositions the oracle's assertions against the diff. Assertion-bearing, `visual`, and `contract` oracles are dispositioned there instead.

**UI annex — token-conformance check (DTCG only, single pass folded into this phase, never a loop).** When the DTCG token settings were resolved, run the deterministic three-check scan (generated-artifact reproducibility; no primitive-tier consumption in new code; no hardcoded duplicates of existing tokens), scoped to files changed vs the integration tip. Stage new files first (`git add -A`). Full definitions in **[references/dtcg-tokens.md](references/dtcg-tokens.md)**.

### Phase 5b — Data-layer conformance loop (conditional UI/data, up to 3 rounds)  `build:datalayer`

**Conditional — UI/data items only.** Full procedure in [references/build-ui-data.md](references/build-ui-data.md) — read before running. Skip when there's no data layer, or no changed file contains a data-layer operation.

### Phase 6 — Acceptance loop  `build:acceptance`

Once the floor is clean, run the item's acceptance check through the verification gate. The gate is **read-only** — it reports, it never edits — and it runs in a fresh, thin context (only the worktree, the binder, and the item's `oracle`/`contract`). See [references/verification-gate.md](references/verification-gate.md).

**Precondition — did this item change anything?** Before you run the gate, confirm the item branch actually changed something versus the integration tip it branched from:

```
git diff --quiet "$integration"...HEAD   # exit 0 = no change; exit 1 = change present
```

If there is no change, this item is **not delivered** — hatch has no no-op work item. Do **not** run the gate and do **not** write any completion ref. Halt and report the cause "produced no changes." This is the build-time catch for a whiff. It leaves **no** ref at all — the branch equals its base, so there is no distinct tip to anchor a `failed`/`built`/`done` ref to, and there is nothing to merge or mark. In an orchestrated wave this is just another halted worker the orchestrator skips when it re-derives the frontier (`deliver:waveloop` Step 3); invoked directly (single-item mode) you stop here, before Phase 9 ever merges. The precondition applies **even to an opt-out item**: opt-out skips *verification*, not *delivery*. If the item genuinely needs no change, that is a planning error — surface it for a re-plan via hatch-plan, never a silent pass. (The gate enforces this again on its side: an empty diff handed to the acceptance reviewer returns BLOCKED, the catch for a change that is already present on the moved tip at merge-time re-validation — see [references/verification-gate.md](references/verification-gate.md).)

On Pi, the package host makes this check itself and tells the two empty cases apart before it halts. When the staged tree equals `HEAD`, it diffs the item's branch against its merge base and runs the item's oracle on `HEAD`. An empty diff with a passing oracle is reported as `already-present`, carrying the oracle receipt in its `checks` manifest; the halt says the change is already on the base and that the way forward is a plan change per `docs/how-to/binder-repair.md` — a successor binder that drops or amends the item when other items are done, or withdrawing the binder when none is — with the receipt as the evidence for that decision. The receipt is only as strong as the oracle, which is why a person decides. If the environment preflight fails, the item is `blocked` with the project's remediation, because the oracle could not run. Anything else — a diff of its own, no runnable oracle, or an oracle that fails or writes files (the host restores the worktree after the probe) — stays `no-change`, a whiff, and its halt says to re-dispatch the worker. None of these writes a completion ref.

**6-sme. stack-pack self-check before the gate (when `SME_PACKS` is non-empty).** Runs here, **before any gate dispatch and before the opt-out check** (an opt-out item still gets self-checked), so the markers exist when the safety-auditor judges the diff. For each loaded pack (4c-ter), run its **Review checklist** — the composed Review checklist loaded in 4c-ter (the resolver's output: base minus `exclude_rules`, plus the pack's own rules), so this pre-gate self-check and the boundary gate enforce the identical rule set — against the item's diff (`git diff "$integration"...HEAD`). For every checklist item, decide pass or miss. Two outcomes for a miss:

- **Fix it** — adjust the code so the checklist item passes. Preferred.
- **Declare the override** — when the deviation is deliberate and justified, leave the code and record a declared override at the deviation site, modelled on the `HATCH-DEFER` family (see [references/declared-debt.md](references/declared-debt.md)): an inline comment `HATCH-SME-OVERRIDE(<rule-id>): <rationale>`, optionally followed by `[ceiling: <bound>; upgrade: <trigger>]` — the ceiling names where the shortcut breaks, the upgrade what forces a revisit. `<rule-id>` is the checklist item's id from the pack (e.g. `min.1`, `ng.3`). The legacy form `HATCH-SME-OVERRIDE(<pack>: <rule paraphrase>): <rationale>` is tolerated where it already exists, but every **new** marker uses the rule id. The `ceiling`/`upgrade` trigger is **optional** — name it when the shortcut is knowingly temporary; a permanent justified exception needs only the rationale. A declared override is a justified crossing; the safety-auditor passes it.

Record the per-pack tally for the report (`build:report`), e.g. `stack-pack self-check (angular): 4/4 ok` or `3/4 — 1 declared override`. This self-check **never halts the build** — it produces the markers and the report line. The judgment of declared-vs-undeclared belongs to `hatch-safety-auditor` at the gate: an **undeclared** checklist violation is a VIOLATION there (kickback), so leaving a miss neither fixed nor declared will fail the boundary scan. Only Review-checklist items have teeth; Do / Don't / Patterns are advisory.

**6-sweep. Prove each new check can fail, before staging (when the diff adds one).** A check that guards an invariant must be shown to fail on a broken input before the gate asks. How you show it depends on where the check lives:

- **A product check site** (a validator rule, a hook denial, a regression guard, or a production check in a script that carries its own self-test) is proven by the bundled [scripts/mutation_sweep.py](scripts/mutation_sweep.py), run over the product file with the tests or self-test that should catch it as the command.
- **A test assertion or a self-test assertion** whose pass means an invariant holds or something is absent (no leak, no write, no file created) is proven by its negative control in the diff: a case that makes that assertion fail. Never sweep it. Neutralizing a test's own assertion only makes that test pass, so it always reads `[UNCAUGHT]` and proves nothing. An exact-value test assertion needs neither: it fails on its own when the value is wrong.

Run the sweep from the worktree root over the product files only, naming each by its repository-relative path:

```
uv run --script <skill-dir>/scripts/mutation_sweep.py --command '<tests or self-test>' --changed-since "$integration" [--site-re '<regex for the product check calls>'] <product file> ...
```

It neutralizes each product check site the diff adds, one at a time, runs the command, restores the file byte for byte, and lists every site the command still passed with; exit 0 means every site is caught. The default `--site-re` matches product check forms only: a bare `assert`, a bare `assert*(` helper, and bare `fail(` and `check(` calls. A callee reached through a dot (`self.fail(`, `assert.equal(`, `self.check(`) is a test-side form and never matches. Point it at the product's own check calls when they look different (for example `errors\.append\(` in a validator). In a script that carries its own self-test, narrow it to the product's check calls so the self-test's own `check(` and `assert` lines are not swept. For each `[UNCAUGHT]` site, write the negative control the command was missing (a violating fixture, a mutation, or a known-bad input that makes a test or the self-test hit that check), or declare the override; an `[UNSWEPT]` site, one the script could not neutralize safely, needs the same proof by hand. Re-run until it exits 0, then paste the whole report, its `file … sha256 …` lines included, into the item commit's message body, above any `Hatch-Item:` trailer so the trailer stays last. The safety auditor cannot run code: it reads the report with `git log` and checks each sha256 against the reviewed tip, so every product site the report lists reaches the gate in one attempt instead of one per attempt. The sweep is your evidence, not a gate: it never halts the build, and the auditor still judges the diff itself.

**Opt-out items skip the loop.** When `ITEM_ORACLE.opt_out` is true, record the `reason` and skip acceptance (the floor still applies). Report the opt-out in the final summary — opt-outs are explicit and surfaced, never silent (see [references/definition-of-done.md](references/definition-of-done.md)).

**Choose the gate by oracle type:**

- **`oracle.type == visual`** → the visual acceptance path (boundary-only pass, then `hatch-validate`); skip `hatch-validate` when `design_reference` is `none`. Full mechanics in [references/build-visual-validation.md](references/build-visual-validation.md).
- **any other type** (`unit` / `integration` / `e2e` / `smoke`) → `hatch-verify`. It dispositions each of the oracle's `assertions` against the actual diff, and — when the item declares an `ITEM_CONTRACT` — checks the diff against the external contract artifact (a type-checker, schema, or contract test), not against the binder's claim. Pass it the `<typecheck command>` resolved above, or say the project has none: hatch-verify runs the type-check itself and hands the acceptance reviewer the record, because the reviewer's shell may not run project code.

**One command, distinct altitudes.** A command-shaped oracle check has one execution site — the floor, through the runner — and one read-only disposition site, here. The serial merge re-validates against the merged tip, and CI is the final word.

**Every gate-agent dispatch brief you compose carries the diff stat line.** Any dispatch of `hatch-acceptance-reviewer` or `hatch-safety-auditor` — including the behavioral-floor path — states the diff range and a `Diff-size: <files> files, <bytes> bytes` line whose numbers match what git recomputes for that range. hatch's own pre-dispatch guard refuses a brief missing either, or naming an empty range, before a reviewer context spins up.

**Dev-server lifecycle for the visual gate (conditional — `oracle.type == visual` only).** Non-visual items skip this. Full bring-up procedure in [references/build-visual-validation.md](references/build-visual-validation.md) — read before invoking `hatch-validate`.

**Kickback and caps.** On any finding, the gate kicks the work back to this skill for **bounded self-correction**, then re-runs on the corrected diff. Per [references/verification-gate.md](references/verification-gate.md) the caps differ by gate:

- **Safety / boundary scan** (the seven smart-surfaced-review signals re-run on the real diff; see [references/smart-surfaced-review.md](references/smart-surfaced-review.md)) — **max 3 attempts, then escalate to the human.** A boundary the item never justified is a safety question. The count is kept by hatch-verify's attempt ledger (`verify:attempts`), never by memory.
- **Acceptance / contract gate** — **max 2 attempts, then halt with a call to action**, counted by hatch-verify's attempt ledger (`verify:attempts`), never by memory. On the second failed attempt the gate halts and the item takes the halt path — in a wave you commit the item branch and write a `failed` ref at that tip, no `built`/`done`, not done. You do **not** clear a capped acceptance failure by declaring debt — that would let the implementer grade its own escape. The ways forward are fix-and-rerun; **re-plan the unmet assertion as an explicit oracle `opt_out` (with a reason) via hatch-plan** and re-run (the binder is read-only to build, so accepting it is a plan-time decision; hatch has no backlog); or — in a wave only — a **human accept-waiver** the orchestrator obtains at its Phase-4 halt and records in git. You never obtain or write that waiver yourself. In single-item mode there is no accept (see `build:merge`, 9c-single). See [references/declared-debt.md](references/declared-debt.md).

Only on cap exhaustion does the gate halt or escalate — otherwise it self-corrects within the caps and moves on.

### Phase 7 — Dev-server teardown (cleanup for the visual gate)  `build:teardown`

**Conditional — visual items that started a dev server.** Non-visual items are a no-op here. Full teardown procedure in [references/build-visual-validation.md](references/build-visual-validation.md).

### Phase 8 — (reserved)

### Phase 9 — Commit, secret-scan, and finish the item — NO PR  `build:merge`

Run from inside the worktree. There is **no PR**. The terminal state depends on `RUN_MODE` (Phase 1): a single-item hatch ends at a tagged item *merged* into the integration branch; an orchestrated wave ends at a *committed, secret-scanned item branch* carrying a durable `built` marker, which the orchestrator merges. Either way the user ultimately reviews and merges the integration branch.

The integration tip has exactly one writer per [references/integration-branch.md](references/integration-branch.md). Steps 9a (secret scan) and 9b (commit) run in **both** modes; step 9c branches on `RUN_MODE`.

**9-recheck. Post-gate mutation re-check (hard rule).** The stack-pack self-check runs pre-gate (6-sme); it is not repeated here. But a gate verdict binds only the diff it judged. If **any** step after the acceptance gate mutated the diff — a kickback fix, a late correction, any edit in a later phase — re-run the definition-of-done floor (`build:floor` commands) and the boundary scan on the mutated diff before committing. This is mandatory, not advice: no commit lands on a post-gate mutation without the re-run.

**9a. Secret scan before every commit.** Before each commit, run the bundled scanner [scripts/scan_secrets.py](scripts/scan_secrets.py) — `uv run <skill-dir>/scripts/scan_secrets.py` — against the **staged diff** only. One scanner for every build keeps the gate reproducible. The pattern set, the allow-list format, and the on-hit behavior are defined in [references/secret-scan.md](references/secret-scan.md). On a hit, **block the commit and surface the finding** (file, line, matched pattern); mark the item failed with the scan output, preserve the worktree, and halt. Resolution requires removing or rotating the secret (or an in-repo allow-list entry, reviewed alongside the code) before retry.

**9b. Commit** with the item marker in the subject line. The canonical commit **subject** marker is:

```
[hatch:item-<item-id>] <summary>
```

The `[hatch:item-<item-id>]` marker is mandatory and appears verbatim — resume and integration parse it to trace the commit. `<summary>` is a short imperative description of the change.

**Coexisting with Conventional Commits.** When the project's convention puts a single type prefix on the subject (`feat:`/`fix:`/`chore:`), do **not** stack the hatch marker into that prefix and do **not** add a second type — a Conventional-Commits subject carries exactly one type. Keep the single CC prefix on the subject and carry the marker as a git trailer instead, one blank line after the body:

```
feat(profile): <summary>

<optional body>

Hatch-Item: item-<item-id>
```

Either form satisfies the requirement: the bracket marker in the subject (canonical default), or the `Hatch-Item: item-<item-id>` trailer when a CC prefix owns the subject. Use the trailer only when the project's convention requires a single typed subject; otherwise prefer the subject marker. Apply one form consistently across the item's commits so resume can recover the id.

**9c. Finish — who merges depends on `RUN_MODE`.** The integration tip has exactly one writer; pick the branch that matches how this run was invoked, per the two modes in [references/integration-branch.md](references/integration-branch.md).

**9c-single — single-item hatch (the worker owns the merge).** When `RUN_MODE` is single-item, the worker completes the merge itself. Full terminal sequence in [references/build-single-item-hatch.md](references/build-single-item-hatch.md) — read before finishing. A wave worker skips this — see 9c-wave below.

**9c-wave — orchestrated wave (the worker commits and stops; the orchestrator merges).** When `RUN_MODE` is orchestrated, **stop at the committed item branch** — do **not** touch `hatch/<slug>/integration` and do **not** write the `done` ref. The pass signal is durable git state, not an ephemeral report:

1. Leave the item branch `hatch/<slug>/item-<item-id>` committed (9b) and secret-scanned (9a) at its tip — this is your terminal artifact.
2. On a clean floor + acceptance + secret scan, write the durable marker ref `refs/hatch/<slug>/item-<item-id>/built` → the item-branch tip. This is the worker's pass signal; the orchestrator merges only items carrying a `built` marker (or an item the human accept-waives — never your call). Do **not** write `done`, and **never** write the `accepted` namespace under any mode — that ref is the orchestrator's, recorded from a live human decision (see [references/integration-branch.md](references/integration-branch.md)).
3. On a halt at the acceptance gate (a capped DEVIATION **or** a SPEC-SUSPECT), write **no** `built` marker — commit the item branch and write `refs/hatch/<slug>/item-<item-id>/failed` → that tip instead, then surface the cause. The `failed` ref means "halted at the gate, not cleanly done" (for a SPEC-SUSPECT its note carries the spec-suspect reason; it does not claim the code is bad). A halted item produces no pass signal; its committed branch + `failed` ref is the uniform anchor the orchestrator's human accept-waiver merges from if the human chooses to accept it.
4. **Stop here.** Report the committed item branch and its tip (Phase 10). The orchestrator (`hatch-deliver`, `deliver:waveloop` Step 3) is the single writer of the integration tip: it runs the serial FIFO merge queue, re-validates the oracle against the moving tip before each merge (so it re-checks rather than trusting the `built` marker's word), merges, tags the wave, and writes `done`. Because the queue is serial there is no concurrency at the tip; the orchestrator's done-ref guard is resume-idempotency, not a race fix.

**Do not open a PR** in either mode. No `gh`/`glab`/`tea`, no push-to-review, no review-status transition.

### Phase 10 — Report back  `build:report`

Write everything you show a person in plain language — see [references/user-facing-prose.md](references/user-facing-prose.md). Give the user a short summary (~8 lines):

- **Item id** and the binder slug
- **Worktree path** — so the user knows where the checkout lives
- **Terminal artifact** — single-item hatch: the integration tip the item merged to (merge commit / `done` ref); orchestrated wave: the committed item branch and its tip (`built` marker ref) that the orchestrator will merge; on a halt, the `failed` ref
- **Binder end-of-life** — single-item hatch only: archived to `.hatch/binders/archive/<slug>.json` on a clean merge, or left live with the reason (a halt). A wave worker omits this line — end-of-life is the orchestrator's
- **Doc-gardner** — single-item hatch only: off, or on with the `docs: gardner <slug>` commit's sha, the number of doc files corrected (0 on a no-drift run), and any residual the gardner could not auto-correct. A wave worker omits this line — the orchestrator runs doc-gardner once for the whole delivery
- **Kaizen** — single-item hatch only: off, or on with the `kaizen:` commits (if any) and what changed (packs seeded into `.hatch/sme/`, pack files edited). A wave worker omits this line — the orchestrator runs kaizen once for the whole delivery
- **Runtime** — the active runtime version(s) the floor ran under, against the `runtime_contract` (or detected pin files); note a clean match or the mismatch that halted
- **Generated-but-unused files** (greenfield/scaffold items only) — anything the framework generator emitted that fell outside the item's `scope`/`contract`, noted here rather than written to the read-only binder
- **Acceptance result** — which gate ran (`hatch-verify` / `hatch-validate` / opted out), final disposition, rounds used, any residual finding
- **stack-pack self-check** — per applied pack, the Review-checklist tally and any `HATCH-SME-OVERRIDE` declared (what, which rule id, why); on a 4c-ter resolution halt, name each pinned `sme` id that resolved to no pack file and the paths tried. Omit the whole line when `SME_PACKS` is empty
- **Declared-debt summary** — every `HATCH-DEFER` marker you placed (what, why, external follow-up), per [references/declared-debt.md](references/declared-debt.md). **Flag any `HATCH-DEFER` marker whose `follow-up:` trigger is missing or empty as `no-trigger`** — the deferral that silently rots — and end the register with `<N> markers, <M> no-trigger`. This reads what you already scanned; it adds no state. Markers are inline deferrals only. An item carrying inline debt is never reported as done without its deferral list shown. A capped acceptance failure is never turned into a marker: it halts to a `failed` ref. Accepting the unmet assertion is a re-plan opt-out via hatch-plan or a human accept-waiver the orchestrator records, never a worker-placed marker. hatch surfaces the debt register once and never tracks it (no backlog)
- **Mutation sweep** — the last sweep's summary line (`<c> caught, <u> uncaught, <s> unswept of <n> sites`) for each run, or omit the line when the diff adds no product check site (6-sweep)
- **Secret-scan status** — clean, or blocked-with-finding
- A self-assessment from the automated gates. Flag anything no gate checked (e.g. accessibility) as needing manual review — do not imply it passed

**On a halt, preserve the failing item's worktree and print its path.** Leave the worktree in place on success too — re-runs and review iterations frequently need it back.

---

## Gotchas

- **No PR — ever.** The user reviews and merges the integration branch. No `gh`/`glab`/`tea`, no review transition.
- **One writer to the integration tip — the explicit mode decides who.** Single-item hatch: the worker merges its item into `hatch/<slug>/integration` and writes the `done` ref. Orchestrated wave: the worker **stops at the committed item branch** and writes the durable `built` marker (not `done`); the orchestrator/`hatch-deliver` runs the serial merge queue and writes `done`. The mode is told to the worker explicitly — never inferred from repo state. See [references/integration-branch.md](references/integration-branch.md).
- **The worker never writes `accepted`, in any mode.** The `accepted` ref records a human accept-waiver and is the orchestrator's alone, written from a live human decision at its Phase-4 halt. A wave acceptance halt (capped DEVIATION or SPEC-SUSPECT) commits the item branch and writes `failed` at that tip — the anchor an accept merges from. Accept is unavailable in single-item mode: a directly-invoked worker that caps out writes only `failed` and halts.
- **Branch off the integration tip, not the default branch.** That tip already contains every merged dependency; building off the default branch would lose them.
- **Dependencies must be merged before pickup.** Gate 3 checks `refs/hatch/<slug>/item-<dep>/done` for every `depends_on`; an unmet dependency halts.
- **The binder is read-only to build.** A build step never edits the plan that governs it — that would corrupt its own governance.
- **Never weaken the oracle.** Don't edit or soften the acceptance assertions or contract to make a check pass. On a genuine conflict, halt — code/specs/tests win.
- **Commit marker is mandatory.** Every commit carries `[hatch:item-<id>]` so resume and integration can trace it — in the subject by default, or as a `Hatch-Item: item-<id>` git trailer when a Conventional-Commits type prefix owns the subject (never stack the marker into the CC prefix or add a second type).
- **Secret scan before every commit.** It inspects the staged diff and blocks on a hit. Block, surface, mark failed, preserve the worktree — don't write the commit.
- **Acceptance caps differ on purpose.** Safety/boundary gate: 3 attempts then escalate to the human. Acceptance/contract gate: 2 attempts then halt-with-CTA. Both counts are kept by hatch-verify's attempt ledger (`verify:attempts`), never by memory. The gate kicks findings back to build for bounded self-correction; only exhaustion halts.
- **Re-validate the oracle against the merged tip.** A text-clean merge can still break semantics (a wave-mate renamed a helper). The acceptance check must pass on what lands, not on the pre-merge branch.
- **Always work in the worktree.** After the worktree is created (`build:implement`), every implementation path resolves under the worktree root. The mutation guard in [references/worktree-safety.md](references/worktree-safety.md) is mandatory before every edit.
- **Don't clobber an existing worktree.** If `git worktree add` fails, stop and ask — recovery procedure is in [references/build-resume.md](references/build-resume.md).
- **Conditional-feature gotchas — UI/visual, data-layer, greenfield tool-pinning, and multi-root oracle mechanics — are in [references/build-annex.md](references/build-annex.md).** Open it the way you'd open `build-ui-data.md` or `build-greenfield.md`: only when the item actually carries that surface.
- **Declare deferrals inline — never to clear a gate.** A skipped test or stubbed dependency gets a `HATCH-DEFER` marker at the site (with an external follow-up; hatch has no backlog); the report surfaces every one, and an item carrying inline debt is never reported as done without its list. A marker never clears a capped acceptance failure — that halts to a `failed` ref. The marker is the worker's inline note; it is a different thing from the **human accept-waiver** and the **human defer choice**, which are the orchestrator's decisions at the Phase-4 halt (a worker can never read its own marker as a self-accept path). Accepting the unmet assertion is a re-plan opt-out via hatch-plan or a human accept-waiver the orchestrator records.
- **Opt-outs are explicit and surfaced.** When `oracle.opt_out` is set, skip acceptance (not the floor), record the reason, and report it. There is no silent opt-out.
- **The floor is non-negotiable.** A change that won't compile / type-check / lint does not earn an acceptance review — it earns a surfacing.
- **Check the runtime before the floor — never auto-provision.** A floor command can hard-refuse on a runtime mismatch. The preflight compares the active runtime against the binder's `runtime_contract` (or detected pin files) and **halts with a CTA** on a mismatch; `on_unavailable` carries the single value `halt`. hatch does not install or select a runtime — provisioning is the operator's, a hermeticity/supply-chain concern. The floor/oracle commands may route through the repo's own declared version manager (`mise exec -- …`).
- **Floor RUNS, acceptance INSPECTS — one check, two altitudes.** Floor commands execute in-worktree; the acceptance gate is read-only and dispositions assertions against the diff (it does not re-run the command). When the oracle `command` overlaps a floor check it simply runs at the floor — not a second phase. The merge re-validates on the merged tip (single-item mode); CI is final.
- **Co-owned files are additive only.** An item may extend a file an earlier depended-on item created (registering a route, mounting a component) when it is inside the binder's `scope.included` — smallest wiring change, no broader refactor. A rewrite of shared structure is unauthorized blast-radius: flag and ask. Two wave-mates on one file is the orchestrator's serialization concern (`serialize` / `shared_resources`).
- **Preserve the failing worktree on halt and print its path.** Don't tear it down — the user needs it to resume.
- **Don't re-plan.** The plan lives in the binder. Your job is execution of one item, not re-planning. The planning counterpart is `hatch-plan`.
