---
name: hatch-plan
model: opus
effort: xhigh
description: >-
  Analyze a problem/feature description and/or a design mock or non-functional prototype, grill the user in rounds about every decision the repo cannot answer, and synthesize a validated binder of work items — or an ordered set when a named test says the work must land in stages — for ad-hoc orchestration; stack-agnostic (frontend, backend, CLI, data, library/SDK, IaC, mobile, ML, docs — UI is one stack among many); emits .hatch/binders/<slug>.json. The draft is reviewed as an editable in-chat card — or one plannotator browser annotation session when that separately-installed CLI is present — and commits only on the explicit "commit" verb. Trigger phrases: "plan this with hatch", "synthesize a binder", "break this work into a binder", "hatch-plan this feature".
---

hatch-plan ingests intent and — without fail — synthesizes a binder. Give it a problem or feature description; optionally attach a design mock or non-functional prototype. It looks up every fact the repo can answer, grills you in rounds about every decision it cannot — until nothing is left silently assumed, including whether the work is one binder or an ordered set — then runs a synthesis subagent to draft the binder, and commits on an explicit "commit" verb. The output lands at `.hatch/binders/<slug>.json` and is validated by `validate_binder.py` before any build run.

**Bundled scripts.** When Pi provides `hatch_script`, use the named action below. Otherwise replace `<skill-dir>` with the absolute directory containing this `SKILL.md` and run the fallback through `uv run --script`. Never resolve a bundled script from the consumer repo's working directory.

## Pi route

When Pi provides `hatch_dispatch`, the two rules in this skill that a host can enforce are host-owned rather than yours:

- **Survey facts.** Call `action: planSurvey` before the grilling rounds. It runs the package's stack detection and stack-pack provenance classification and returns both verbatim, so the repository's facts come from the package instead of improvised detection. Use its output for `plan:survey`.
- **Emit and commit.** Write the draft to `.hatch/binders/<slug>.json`, then call `action: commitBinder` with the slug. The host validates the binder (`validate_binder.py`), runs the cross-item shared-term check, presents the review card carrying the validator's recorded escapes, the shape line and each item's gate strictness, and commits only when the human at the prompt gives the `commit` verb. For a set, pass every other stage's slug in `set`: the binders commit together, in one commit, exactly as this skill requires. Do not validate by hand and then `git commit` the binder — that path skips the review point and the verb, which is the one place a bad plan reaches delivery unchecked.

`commitBinder` returns `hatch-plan-commit-v1` with `status` of `committed`, `blocked`, or `cancelled`. `blocked` means the binder validated but no human was at a prompt: report that and stop rather than committing it yourself. A tool error is a failure, never a reason to fall back to a by-hand commit.

Everything else stays yours — the intent ingest, the grilling rounds, the shape decision, synthesis judgment, the smart-surfaced walk, cost education, and the report. The host cannot take those, and this skill's own rule forbids delegating synthesis judgment.

## How this skill adapts to your project

hatch-plan is **stack-agnostic**. It plans frontend, backend, CLI, data pipelines, libraries/SDKs, IaC, mobile, ML, and docs work in the same way — UI is one stack among many, not the default.

**How it works:**

- Intent ingestion handles design exports too: when the input is a Claude Design or runtime-JSX export, the UI-analysis path applies (component inventory, token map, icon map). This is a **stack-specific aside**, not a precondition for the whole skill.
- A synthesis subagent drafts the binder from ingested intent.
- Facts come from the repo, never from you: the survey (`plan:survey`) looks them up. Decisions come from you, all of them: the grilling phase (`plan:grill`) works the design tree in rounds until its frontier is empty, and puts the binder's shape — one binder or an ordered set — to you as the tree's last decision (`plan:shape`).
- Commit-on-verb: the binder is presented as an editable card and committed when you say "commit."
- Review is smart-surfaced: the synthesis subagent flags items that warrant human attention (`surface.flagged` + `surface.signals`); unflagged items don't require a per-card walk.

**Scope limits (V1):**

- Repo detection is light and never blocks (see Project configuration below).
- When the work must land in ordered, separately-merged stages, it emits a *set* of self-sufficient binders (each independently valid and mergeable), each after the first carrying an `after` edge to its predecessor, and states the derived run order — `plan:shape` holds the two tests that decide it, `plan:emit` how a set is written. Default is one binder; a set needs a named reason, never a reflex.
- Synthesis runs as a single subagent, not a panel.

## Project configuration (resolve once, never blocking)

Resolve in order: **explicit user input → detect from the repo → ask the user**. Skip what you can detect; what the repo cannot answer is asked inside the grilling rounds (`plan:grill`) as a fact the survey could not settle — never as a questionnaire of its own. When detection conflicts with the project's stated stack, the stated stack wins — a repo can be mid-migration.

| Setting | What it is | How to resolve |
|-|-|-|
| **Stack** | The primary tech domain (frontend, backend, CLI, data, IaC, mobile, ML, docs, mixed) | Detect from repo layout, package manifests, and language files; ask when ambiguous |
| **Toolchain commands** | lint / test / build / typecheck invocations | Detect from package scripts, task runners (npm/pnpm/yarn, Makefile, Nx, Turborepo, Cargo, Poetry, etc.) |
| **CI-facing checks** | The subset of commands that gate CI (used as oracle `command` values) | Detect from CI workflow files; if absent, use the toolchain commands |
| **Env command** | The command that starts the dev/test environment (feeds `env_contract.command`) | Detect from package scripts or a `docker-compose.yml`; ask if not found |
| **Required runtime** | The language/toolchain runtime versions the commands need (feeds `runtime_contract`) | Detect from version-manager pin files (`.nvmrc`, `.tool-versions`, `.python-version`, `mise`/`asdf` config) and manifest fields (`package.json` `engines`/Volta, `pyproject.toml` `requires-python`); ask for the floor only when nothing pins it but a tool is known to gate on a minimum |
| **Repo direction docs** | Architecture docs, ADRs, or decision records | Detect: `ARCHITECTURE.md`, `docs/architecture/`, `docs/decisions/`, `adr/`; cite only filled docs (skip placeholder templates); ask when context is thin |
| **Project rules** | Conventions the repo documents (lint configs, contributor guides, rules files) | Detect; verify the doc has real content before citing |
| **Repo policy** | CI/branch/deployment policy (only when in planning scope) | Read root/area `AGENTS.md`, workflows, and CI docs; load [references/ci-policy.md](references/ci-policy.md) and [references/policy-yagni.md](references/policy-yagni.md) |
| **stack packs** | Advisory domain-expert do's/don'ts to apply (each with an enforceable Review checklist) | Match the built-in [references/sme/](references/sme/) plus the project overlay `.hatch/sme/*.md` against the dependencies/languages reported by `scripts/detect_stack.py`; record matched ids in the binder's `sme` |

Resolved values feed the binder's `design_facts.stack`, `env_contract`, `runtime_contract`, and each oracle's `command`. Record them — every later phase references them.

### UI / design-token annex (conditional)

When the resolved stack has a design or token surface, also resolve:

- **Component library:** detect from package deps and import statements; may be none.
- **Icon libraries:** detect from deps/imports; may be none.
- **Token/theme system:** detect a theme object, CSS custom properties, a design-tokens file (incl. W3C DTCG JSON — see [references/dtcg-tokens.md](references/dtcg-tokens.md)), a utility-class config, or plain CSS.

When the **token system** is a W3C DTCG file (JSON leaves carrying `$value`/`$type`), resolve the additional DTCG-only settings in [references/dtcg-tokens.md](references/dtcg-tokens.md) so the binder's `token_manifest` and each work item's `token_changes` can carry tier-correct, build-actionable guidance.

Resolved UI values feed the binder's `design_facts` and each work item's `component_map`, `icon_map`, and `token_changes` (see [references/binder-reference.md](references/binder-reference.md) — these fields are UI-optional and omitted when the stack has no design surface).

## Workflow

### Phase 0 — Ingest intent (light gate)  `plan:ingest`

Accept a problem or feature description as the only hard requirement. Optionally accept a path to a design mock or non-functional prototype. Some statement of intent is required — if the user provides nothing, ask once.

**Open the design tree.** The stated intent is the tree's root. Note, without asking yet, the decisions that visibly hang off it — where the scope's edges are, what the intent leaves unsaid, which project-configuration settings only the user can supply, and the shape question (`plan:shape`). The tree is worked in Phase 2; Phase 1 is dispatched first so its findings settle as many of those branches as the repo can.

**Repo detect (light, never blocking).** Check for a recognizable repo layout to resolve the binder's landing path and later feed the repo survey (`plan:survey`). Never fail on an unfamiliar structure.

**UI-format gate (conditional).** When the input includes a design file path, check whether it is a Claude Design or runtime-JSX export: verify that `.jsx` siblings exist or the HTML contains a `<script type="text/babel">` block. If the check fails, tell the user what was found and ask them to re-export or point at the `.jsx` sources. Only run this check when a design file is provided; a plain text description has no format to gate.

**Resolve the binder location.** In order: explicit user input → detect an existing `.hatch/binders/` directory in the repo → default to `.hatch/binders/<slug>.json`. Ask the user only when you cannot determine `<slug>` from the intent.

---

### Phase 1 — Best-effort repo + stack understanding (Explore subagent)  `plan:survey`

Use an **Explore subagent** OR an inline read-only pass to survey the repo. Both are sanctioned; when the host cannot spawn the subagent, run inline — but note in what you show the user that the survey ran inline, rather than letting the degraded path pass unremarked.

**Subagent brief:**

Survey the repo at `<root>`. Identify the primary tech domain (frontend, backend, CLI, data pipeline, library/SDK, IaC, mobile, ML, docs, or mixed). Identify the toolchain: how the project lints, tests, builds, and type-checks (look at package scripts, task runners — npm/pnpm/yarn, Makefile, Nx, Turborepo, Cargo, Poetry, Gradle, etc. — and any CI workflow files). Determine the env command: what starts the dev or test environment. Determine the required runtime: read version-manager pin files (`.nvmrc`, `.tool-versions`, `.python-version`, `mise`/`asdf` config) and manifest fields (`package.json` `engines`/Volta, `pyproject.toml` `requires-python`, a `go` directive in `go.mod`, `rust-version` in `Cargo.toml`) for the language/toolchain versions the commands need. Read any architecture, ADR, or decision docs you find (`ARCHITECTURE.md`, `docs/architecture/`, `docs/decisions/`, `adr/`, `AGENTS.md`) — cite only docs with real content; skip placeholders. Read project rule and contributor convention files when present.

Report:
1. Resolved stack (one phrase, e.g. "Python/FastAPI backend + Postgres").
2. Toolchain commands for lint, test, build, and typecheck — with the exact invocations.
3. CI-facing checks: the subset of toolchain commands that gate CI (from workflow files, or fall back to the toolchain commands).
4. Env command.
5. Conventions and rules the repo documents.
6. Architecture or decision-record notes relevant to the stated intent (if any docs exist).
7. Required runtime: per runtime, the version or range and the pin file or manifest field it came from (`.nvmrc`, `.tool-versions`, `.python-version`, `engines`, `requires-python`, …). This feeds the binder's `runtime_contract`. Say so plainly when nothing pins a runtime — an absent floor is a clean result, not a gap to guess at.

When context is thin on a point, say so — the main thread will put the missing piece to the user in the grilling rounds (`plan:grill`).

Report with `file:line` citations.

**UI annex — full design analysis (conditional).** When the resolved stack has a UI surface — a design mock or non-functional prototype as input, **or** a component-library / token system in the repo — run hatch's full frontend analysis per **[references/ui-analysis.md](references/ui-analysis.md)** instead of the one-line inventory. Keep the Explore-subagent pattern: that reference drives three read-only passes (run them in parallel where the host allows), each citing `file:line`:

- **Design analysis** — component inventory (with props, complexity, state), the component-hierarchy tree, the page/view inventory, the design-token inventory *with values* (per theme context), mock-data shapes, and navigation structure (ui-analysis `ui:design`).
- **Codebase + component-library inventory** — existing components/routes/styles/data-layer/client-state/tests, the component-library catalog, icon libraries, and the theme/token inventory (incl. DTCG tier/path/name from the JSON source, resolved values from the generated output) (ui-analysis `ui:inventory`).
- **Data-layer mapping** — the type-coverage buckets (matched / gap / unused / exists-but-differs / field-level gap), operation mapping, schema gaps, and fetch-boundary planning (ui-analysis `ui:datalayer`).

When the token system is W3C DTCG (JSON leaves carrying `$value`/`$type`), also resolve the DTCG-only settings in [references/dtcg-tokens.md](references/dtcg-tokens.md) so the binder's `token_manifest` and each work item's `token_changes` carry tier-correct, build-actionable guidance.

Non-UI stacks skip this annex entirely — the base survey above is all they need.

<!-- hatch:matching-rule:start — benchmarks/sme-static/match_pins.py pins the sha256 of the text between these markers so its replay implementation is re-verified whenever the rule changes. You may edit the rule, but keep both markers; adding a **-lead paragraph inside them changes the hash (re-run the gate to re-pin), while paragraphs outside them do not. -->
**stack pack matching (after the survey)  `plan:sme`.** hatch ships curated stack packs — advisory do's/don'ts per stack, each with an enforceable Review checklist — and a project may add its own. Once the survey completes, select the packs that apply:

1. Detect dependencies deterministically: use `hatch_script` action `detectStack` with `root: <repo-root>`; fallback: `uv run --script <skill-dir>/scripts/detect_stack.py <repo-root>` (stdlib-only). It scans the repo's manifests (package.json, pyproject.toml, requirements*.txt, go.mod, Cargo.toml, Gemfile, composer.json) and prints `{"dependencies": [...], "languages": [...], "versions": {name: [declared specifiers]}}`. `dependencies` and `languages` are the **only** matching input; `versions` never affects matching — version-aware pack rules read it. The survey's one-phrase stack summary stays — for human reporting — but it is not a matching input.
2. Enumerate available packs. A pack's identity is its **file basename** (sans `.md`); the frontmatter `name` must equal it (`validate_packs.py` enforces this), so pinning here and resolution at verify time use one identity. Enumerate the project overlay `.hatch/sme/*.md` in the repo, laid over the built-ins in [references/sme/](references/sme/). On a basename clash the project-local file wins. A file whose frontmatter carries `disabled: true` is a **suppression pack** — the sanctioned no-op override: enumerate it as suppressed, never pin it. (`platform-native.md` is shared reference data, not a pack — skip it; the packs link to it via `see_also`.)
3. Select the packs that apply, by frontmatter kind:
   - An **always-on stack pack** (`always: true`, e.g. `minimalism`) applies to **every** binder — unless the project suppresses it with a `disabled: true` overlay of the same basename.
   - A **matched stack pack** (`match: [tokens]`) applies when a match token equals — case-insensitively — a name in detect_stack.py's `dependencies` list or a `languages` entry. No substring matching, no matching against the stack phrase.
4. Collect the applied pack basenames — always-on and matched together — into the binder's `sme`. Every binder gets at least the unsuppressed always-on stack packs (e.g. `["minimalism"]`); a polyglot repo adds several stack packs (e.g. `["minimalism", "python", "python-fastapi", "angular"]`). A suppressed always-on pack is **not** pinned into `sme`; when every always-on pack is suppressed and nothing matches, `sme` is legitimately empty and `validate_binder.py`'s empty-`sme` warning is the expected, legitimate outcome — not a failure.

Because `sme` is matched from one repo survey, it is identical across every binder in a planning run unless a binder's scope genuinely excludes a stack.

Load the applied packs now — their guidance feeds synthesis (`plan:synthesize`) and their ids are pinned into the binder (`plan:emit`). These packs are **advisory for decomposition**: they shape how items are split, what each `contract` says, and which `oracle` assertions you choose; they never add a gate at plan time.
<!-- hatch:matching-rule:end -->

**Provenance classification (read-only reporting).** As you enumerate the overlay packs (step 2), classify where each local copy came from, so the plan reports its origin next to the match result. Use `hatch_script` action `checkPackProvenance` with `root: <repo-root>`; fallback: `uv run --script <skill-dir>/scripts/check_pack_provenance.py <repo-root>`; report each pack's state. A pack lands in exactly one of six states: `seeded cache` (a clean copy of the current built-in), `stale cache` (a clean copy of an older built-in), `suppression` (a `disabled: true` override), `project pack` (the project's own pack, with no built-in of that name), `local fork` (a copy that carries a genuine user edit over the shipped built-in), or `orphaned cache` (its `seeded_from` names a built-in that no longer exists). The comparison is byte-level on canonicalized content; the provenance stamp is diagnostic only, never the cleanliness signal.

**Plan time is read-only.** This step classifies and reports — it never writes under `.hatch/sme/`. Refreshing an out-of-date copy is auto-reseed, and auto-reseed is owned exclusively by the kaizen item; plan time only names it. Report a `stale cache` in one line that names the coming resolution — auto-reseed at the next kaizen pass — and carry on. Report a `local fork` in one line quoting `local fork: a user-edited copy of the shipped built-in` and naming the built-in it forked, with the one consequence: the copy no longer receives upstream pack updates; user edits always win. This is information, never a warning, and nothing halts.

**Project pack composition (`extends`).** A project pack no longer has to fork a whole built-in or suppress it wholesale to change one rule. A pack whose frontmatter carries `extends: <built-in basename>` **builds on** that built-in instead of replacing it:

- **Checklist appends.** The project pack's own `## Review checklist` items are **appended** to the extended built-in's checklist — the built-in's rules still apply, plus the project's. The project pack declares `id_prefix: <prefix>` and its own checklist ids use exactly that prefix (`validate_packs.py` enforces this); the appended rules are namespaced apart from the built-in's.
- **Match tokens are additive (union).** The combined pack fires when **either** the built-in's match tokens **or** the project pack's match tokens hit — the union, not a replacement. An `always: true` built-in stays always-on.
- **`exclude_rules` subtracts, visibly.** The project pack's `exclude_rules` — a JSON list of built-in rule ids, legal only alongside `extends` — **removes** those named rules from the combined checklist. Report the excluded ids at plan time the same way retired ledger entries are surfaced: an exclusion is **visible**, never silent. `validate_packs.py` rejects an `exclude_rules` entry that names a rule the extended built-in never had — a stale exclusion is a loud error, not a quiet no-op.
- **`id_prefix` uniqueness is enforced per repo at plan time.** Two project packs in the same repo claiming the same `id_prefix` is a **reported error** — fix the collision before pinning. (`validate_packs.py` already rejects an `id_prefix` that squats a prefix a shipped built-in registers; the per-repo cross-pack check is the plan-time addition.)
- **A dangling `extends` pointer resolves through the rename-alias table.** When a built-in was renamed upstream, an `extends` pointer at the old basename resolves through the rename-alias table shipped in `check_pack_provenance.py` (exposed in its JSON `aliases`, the single truth plan:sme and the docs both cite) — kept for **one minor release** after a rename and retired on its own schedule.
- **plan:sme pins the extends pack alone — never its base a second time.** Because a project pack that `extends` a built-in already carries that built-in's rules into the enforced checklist through composition (resolved at verify and build — see the extends-resolver), plan:sme pins the extends pack alone into `sme` and never the extended built-in as a second independent pin. This holds for **every** applied extends pack — whether it is `always: true` or a `match:`-token pack — because in both cases the pack stands in for its base, so the base is never independently pinned alongside it. The in-span always-on rule (pin the built-in unless a same-basename `disabled` overlay suppresses it) is **satisfied** by the extends pack, which stands in for its base; pinning both would double-apply the base and re-fire any rule the pack's `exclude_rules` drops. A fresh-basename `extends` pack does **not** suppress its base the way a same-basename `disabled: true` overlay does — the base is not disabled — so this dedup is the mechanism that keeps the base from being pinned as a second independent basename alongside the extends pack that already carries it.

---

### Phase 2 — Grill the intent (rounds, until nothing is assumed)  `plan:grill`

Run the interview exactly as [references/grilling.md](references/grilling.md) prescribes. That file is a verbatim copy of the `grilling` skill from mattpocock/skills — `skills/productivity/grilling/SKILL.md` at commit `85f83d3` (2026-08-20) — and it is the whole method: a design tree of decisions, a frontier of the ones that can be asked now, numbered rounds with your recommended answer under every question, facts found by you and decisions made by the user, done only when the frontier is empty and the user confirms. Do not paraphrase it, trim it, or ask one question at a time when a round is due; to change the method, change it upstream and re-copy the file byte for byte.

What hatch-plan binds into that method:

- **The tree's root is the stated intent (Phase 0).** Its first branches are the decisions the repo cannot settle: where the scope's edges are — what is in, what is out, what is deliberately left for later; what happens at the edges the intent does not mention; what "done" looks like to the user, in terms an oracle can check; and any project-configuration setting the survey came back without. Recommend an answer under every question, and put the cheap ones to the user too — a decision confirmed in a word costs less than one assumed and rebuilt.
- **Facts are yours; the survey is the sub-agent.** A question the repo can answer is never asked. The Phase 1 survey is the running exploration the method names: dispatch it before the first round, ask the questions that do not depend on it now, and hold the ones that do for the round after it reports. When a fact lives in neither the repo nor the intent — an env command nothing pins, a runtime floor no file records — it is asked in a round, as a fact the survey could not settle, not batched into a questionnaire of its own. When the host cannot spawn a fact-finding subagent, look the fact up inline and say so; never turn a fact into a question because the lookup was inconvenient.
- **The shape question is the tree's last decision (`plan:shape`, below).** It depends on the scope boundary, so it is asked in a round after the boundary settles — never in the first round beside it — and the frontier is not empty until it is answered.
- **Confirmation is the user's words.** The phase ends when the frontier is empty *and* the user says the understanding is shared. A round that produced no new questions is not confirmation; neither is silence. Synthesis (Phase 3) does not start before it.

Nothing enforces this phase — no gate can see a chat. What a reader can check is its residue: every decision the rounds settled appears in the binder as a scope line or a contract term, or as an oracle assertion where a named command turns it red (Phase 3 lists that as a review check), and the review card and the report both carry the shape line with its reason.

**One binder or an ordered set  `plan:shape`.** Every plan answers this once, in the round after the scope boundary settles (and again only when `plan:prelanding` moves a check to a later stage), with your recommendation attached; the answer is carried onto the review card (`plan:emit`) and into the report (`plan:report`) with its reason. The default is one binder. Recommend a set only when one of two tests holds, and name which:

1. **The user asked for separate binders.** Their words, recorded as their decision — *"new first, then edit, then delete — separate binders"* is the canonical case. Say why one binder would do if you think so; do not overrule them.
2. **An event outside the branch must happen between two stages.** Some of the work cannot be built, verified, or safely kept until earlier work has merged to the default branch *and something has happened since*: a migration has run against real data, a deprecation or soak window has elapsed, another repo or service has shipped against the new contract, a flag has flipped in production, a consumer has cut over, the item's own code has deployed (a check that needs that code running in a deployed environment; see `plan:prelanding`). Name the event. If the only thing between the stages is "the earlier code exists", that is a `depends_on` edge inside one binder, not a set — deliver's waves already honour it.

The canonical set is expand → migrate → contract ([references/example-sequence/](references/example-sequence/)): each stage leaves the tree green on its own because the event between stages is what makes the next stage safe.

What does **not** make a set — recommend one binder, and say which of these the intent leaned on:

- **Size.** A large binder is still one binder; waves run its items in parallel, and Phase 5 offers a smaller first slice. Trimming is not splitting: a smaller binder now and a later plan for the rest is one binder with no `after` edge to anything.
- **Order inside the work.** "B needs A first" is `depends_on`. A set is for work that needs a *merge* between A and B, not a build order.
- **Different stacks, areas, or teams.** A polyglot repo's frontend and backend items share one binder; `touches`, `serialize`, and `shared_resources` carry the collisions.
- **A stage that *could* merge on its own.** Every wave could. Could is not must; only test 2's named event makes it must.
- **Smaller reviews.** If that is what the user wants, it is test 1 — ask, and let them say it. Do not split on their behalf.

Record the outcome as one line the card and the report both carry — *Shape: one binder — <reason>* or *Shape: a set of N — test <1|2>: <the user's words, or the event>*. For a set, each binder's `summary` names its stage and its `after` edge names its predecessor (`plan:emit`); for one binder nothing extra is stored. `validate_binder.py` never reads the reason: across a set it checks only that each binder is valid on its own, that every `after` slug resolves (a dangling one is a warning), and that the `after` graph has no cycle (an error).

---

### Phase 3 — Synthesize the binder (synthesis subagent; main thread owns judgment)  `plan:synthesize`

Decompose the stated intent into work items. Do not delegate this judgment — the synthesis subagent drafts; you review and own the output.

When the runtime cannot spawn the synthesis subagent (a host that gates delegation behind an explicit opt-in), **say so and synthesize inline in the main thread** — the binder is still yours to review and own, but the fresh-context draft/review separation was unavailable this run, so flag that plainly in what you show the user. Running inline is **not** licence to skip phases: still run the stack-pack match (`plan:sme`) and pin `sme[]` (every binder carries at least the unsuppressed always-on packs, e.g. `["minimalism"]`), and still apply every survey output. Degrade visibly; never drop steps silently.

**Subagent brief:**

Given the intent `<intent>`, the decisions settled in the grilling rounds (`plan:grill`) — including the shape decision (`plan:shape`) — and the repo survey (`plan:survey`), draft a binder JSON that conforms to [references/binder-reference.md](references/binder-reference.md). When the shape is a set, draft one binder per stage, each self-sufficient and each after the first carrying its `after` edge (see `plan:emit`).

**Domain guidance (when stack packs matched in `plan:sme`).** When one or more stack packs matched, their do's/don'ts are domain guidance for this synthesis. Decompose items, write `contract`s, and choose `oracle` assertions so they respect each matched stack's patterns and avoid its anti-patterns (e.g. an Angular slice's `contract` speaks in standalone-component / signals terms; a FastAPI item's `oracle` expects Pydantic-validated request/response shapes). This guidance shapes the plan; it never adds a plan-time gate.

For the binder level, populate:
- `slug` (kebab-case, derived from the feature name). A slug must be **fresh**: it is taken if `.hatch/binders/<slug>.json` exists, if `.hatch/binders/archive/<slug>.json` exists (a delivered binder — its slug is retired), or if the `refs/hatch/<slug>/` namespace or `hatch/<slug>/*` tags survive in git (a delivered run's refs would read as the new binder's own state and silently skip its work). Pick another slug rather than reuse one; `validate_binder.py` and the status engine warn when a live binder shadows an archived slug.
- `title` (a friendly binder name a person reads first — not the slug, e.g. "Tag editing for notes")
- `summary` (the plain-language goal in 1-2 sentences: what this binder delivers and why it matters)
- `motivation` (one sentence)
- `scope.included` and `scope.excluded`
- `design_facts.source` (path to the design, or null) and `design_facts.stack` (from `plan:survey`)
- `env_contract.command`, `env_contract.supports_isolation`, and `env_contract.isolation_params` (from `plan:survey`)
- `runtime_contract` when the project pins a runtime floor: one `runtimes` entry per runtime (`name`, the required `version`/range, and an optional `manager` — the version manager that pins it, e.g. `nvm`/`mise`), plus `on_unavailable` (always `halt` — hatch never auto-provisions or selects a runtime). Detect the floor from version-manager pin files and manifest fields (`engines`, `requires-python`), then record the resolved `version`; omit the whole object when no runtime floor exists
- `token_manifest` only when the stack has a token system
- `sme` — the stack pack ids pinned in `plan:sme`. An always-on pack applies to every binder, so an empty `sme` is legitimate only when every always-on pack is suppressed by a `disabled: true` overlay and nothing else matched — never because the match step was skipped

**Every settled decision has a home in the binder.** Each answer the grilling rounds settled lands as a `scope.included`/`scope.excluded` line or a `contract` term by default; the plan of record carries it, not the conversation. It becomes an `oracle` assertion only when you can name the command line or test that turns it red, and the item's `contract` records that sentence. A settled decision with no home is a gap to raise in the draft, never a fact to drop. This is a review rule: no validator checks it.

For each work item, set:
- `id` (kebab-case, unique)
- `title` (short human label)
- `summary` (the plain-language goal in one sentence: what this item does)
- `estimate` (`S`, `M`, or `L`)
- `depends_on` (IDs of items that must land first)
- `contract` (the open-shape interface this item exposes or consumes — be specific; vague contracts produce unverifiable oracles)
- `oracle` per [references/definition-of-done.md](references/definition-of-done.md): a real CI-facing check oracle (`type`, `command`, and any `assertions` a named command or test can turn red) OR an explicit opt-out (`opt_out: true`, `reason: "…"`). The floor is compile + type-check + lint. Use opt-out only when a genuinely better check already exists and recording it here would be redundant — always provide a reason.
- `serialize: true` and `shared_resources` for items that must not run in parallel (e.g. DB migrations, lock-file changes).
- `touches`: the concrete files/paths each item creates or modifies. This gives the parallelism file-collision and shared-resource gates structured data instead of prose to infer from, and `validate_binder.py` uses it to flag two same-wave items (no dependency edge between them) whose `touches` overlap unless one declares `serialize` or they share a `shared_resources` entry. Populate it for every item; without it the collision gate falls back to unenforced inference.
- UI-only fields (`design_reference`, `visual_check_waiver`, `covers`, `component_map`, `icon_map`, `token_changes`) only when the stack has a design surface. Omit them entirely for backend, CLI, data, and other non-UI stacks.

**Write the human prose in plain language.** The binder `title`/`summary` and each work item's `title`/`summary` are what a person reads on the Hatch Status page. Write them with the bundled **hatch-plainlanguage** standard: lead with the reader, plain words over jargon, active voice, and no kebab-case identifiers in the prose. The `slug` and `id` stay the technical anchors; the `title` and `summary` are for humans — a `title` that just restates the slug, or a `summary` that restates the title, fails this bar.

**Multi-root / polyglot oracle commands.** When the repo has more than one toolchain root (e.g. a Python service at the root plus an Angular app under `frontend/`), do not emit a bare oracle `command` that assumes a single root — `ruff && pytest && npm run lint && ng build` resolves `ng` from nowhere at the root and forces build to improvise a shim. Express each segment through the runner's own root-targeting flag so every tool resolves from its own root with no synthetic structure: `uv run pytest` at the root, `npm --prefix frontend run lint`, `pnpm -C frontend build`, `make -C api test` (see [references/binder-reference.md](references/binder-reference.md), "Execution context"). Set the oracle's `cwd` to the segment's root when the whole command lives in one sub-tree; use the runner's root-targeting when one command must drive several roots. This tool-resolution rule holds for **every** oracle command, single-root included: author a Python tool through the project's venv entrypoint (`uv run ruff`, `uv run pytest`, `uv run mypy`) — never a bare `ruff`/`pytest` that assumes a global install — and a Node tool through its package script/runner (`npm … run`, `npx`). Write the command the way it actually resolves in the project so the build worker never has to rewrite it.

**For UI items — populate the UI fields from the analysis (conditional).** When the stack has a UI surface, decompose the UI work and fill its fields using **[references/ui-analysis.md](references/ui-analysis.md)** and the survey (`plan:survey`) analysis it produced:

- Break UI work into items with the **vertical-slice heuristics** (foundation slice if the library/theme isn't integrated; one slice per page/view; split list + detail; complex reusable components; cross-cutting features; modals bundled with their view) — ui-analysis `ui:slice`.
- Set `estimate` to the **S/M/L** size from the slice's component count and per-component complexity — ui-analysis `ui:slice`.
- Set `design_reference` to the view/route the slice renders (or `none` for a pure setup/foundation item). **Naming a real view commits the item to being checked against it**: give it a `visual` oracle, or record a `visual_check_waiver` naming the item that opens the view for it. With neither, `validate_binder.py` rejects the binder — "…has no visual oracle and no visual_check_waiver". A waiver is `reason` plus `covered_by`, and the `covered_by` item must be a real work item that carries a `visual` oracle with a non-empty `assertions` list, names a real view in its own `design_reference`, and depends on the waived item directly or through the chain — a covering gate has to run after the work it covers. A waiver on an item that names no view, or that already carries a visual oracle, is rejected for doing no work. The field table and a worked snippet are in [references/binder-reference.md](references/binder-reference.md).
- Populate `component_map` from the **component-to-library mapping** (Library match / Library + wrapper / Custom / Composite), `icon_map` from the **icon mapping** (primary → fallback → custom SVG, with the Source column and any missing-icon flags), and `token_changes` from the **design-token mapping** (no-consumable-tier-match tokens recorded as semantic-additive entries with per-context values and Auth) — ui-analysis `ui:components`, `ui:icons`, `ui:tokens`. Put the shared design→project token map in the binder-level `token_manifest`.

Non-UI items keep the stack-agnostic synthesis above and carry none of these fields.

**Foundation / greenfield items (any stack).** A foundation item creates a project from nothing — the first item in a binder that has no integration branch yet and whose contract is to stand up the project, not edit against existing conventions. Trigger greenfield mode off that existing first-item/foundation signal, not a separate judgment call: the project does not exist yet, so there is nothing to detect and no convention to match. When you plan such an item:

- State in the item's `scope.included` and `contract` that it runs the framework's own official generator (e.g. `ng new`, `create-next-app`, `cargo new`, `npm create vite@latest`, `django-admin startproject`). These generators are deterministic and blessed — the framework's own way to lay down a working baseline. Bound the scaffold to the item's contract: set `scope.excluded` to keep generated sample features, demo pages, and unrequested add-ons out, since the generator's footprint is wider than the item. Build trims it and notes generated-but-unused files in its report (it does not edit the read-only binder).
- Keep the oracle as the real CI-facing check. When the oracle names a check a bare scaffold won't ship (a fresh `ng new` has no `ng lint` / `npm run lint` target), note in the contract that the item must satisfy it through the framework's own official add/plugin command — e.g. `ng add @angular-eslint`, which installs the linter and wires the `lint` target. Provisioning the named tooling is part of the foundation item's work. Do not opt the check out, downgrade it to what the empty scaffold passes, or hand-invent config. A named check that exists but fails is a real failure, never the absent-check carve-out. If no official mechanism exists to satisfy a named check, the item must halt with a call to action rather than improvise.
- Note that the project's toolchain and oracle commands are re-resolved after the generator runs — before the scaffold there is nothing to detect. The pre-scaffold survey is best-effort; the real commands land once the project exists.
- Decide the project's lockfile policy at this foundation item, not per later item: an application commits its generated lockfile (`uv.lock`, `package-lock.json`, `Cargo.lock`, …) so every worktree and CI resolve the same dependency graph (see [references/definition-of-done.md](references/definition-of-done.md), Lockfiles). State it in the item's `scope.included`/`contract` so build tracks it rather than leaving it untracked.
- Expect the scaffold's footprint to trip the smart-surfaced-review boundary signals at the safety gate (a foundation item touches many new files at once). Pre-justify it in the item's surfacing note so it reads as expected, not as a red flag.

**Oracle traceability rule.** Each oracle assertion you write must be traceable to the item's `contract`. If an assertion references a field, shape, or behavior the `contract` does not declare, flag the gap now — emit the work item with a note that the contract needs expanding rather than writing an assertion that cannot be verified.

**Authoring honest oracles.** A check that runs is not yet a check that can fail. Write each oracle so you can say plainly what would turn it red, and record that in the item's `contract`.

- **Prefer a success-only marker.** Where the command can emit one, have it print a string that appears only on genuine success — `N/N checks passed`, `PROBE OK` — and check for that string. Record it in the oracle's optional `expect` field so the marker travels with the plan and the oracle runner (`run_oracle.py --expect`) can assert it. Judging by the absence of error text mistakes silence for health: a command that dies before printing anything, and a grep that matches nothing because the file moved, both read exactly like a clean run.
- **Prove an absence assertion against a positive control.** An oracle that asserts something is gone — a `grep -v`, a "no longer contains", a count of zero — passes trivially when the pattern is simply wrong. State in the `contract` how the same check fails on a tree that still carries the retired thing: that is the positive control. Without one, a typo in the pattern passes forever and the oracle reports green about a condition it never tested.
- **Prefer an assertion the command settles.** An assertion the oracle command settles by its own exit status or `expect` marker can be dispositioned `covered-by-command`, with no test body to read. On the skill route `run_oracle.py --expect` asserts the marker; the Pi host reads the exit status only, so on Pi make the command fail when the marker condition fails.
- **Measure the expectation; never copy a supplied figure.** A number that arrives in the request — a file count, a byte budget, a duration — is a claim, not a measurement. Run the command at plan time, record the value you actually measured, and name the source it came from (the command and where it ran). An expectation copied from a supplied figure pins the oracle to someone's recollection, so the check then guards the recollection instead of the code.

**An oracle passes before its item lands  `plan:prelanding`.** Every item's oracle must be able to pass on the item's own branch, before the item lands, in the build environment. It must not need the item's own deploy, a read from a production or shared live service, an operator login, or a post-merge event. Anything the build environment starts for itself is fine: the binder's `env_contract` environment, a local dev server, a docker-compose stack, a test database, a headless browser against a local server. hatch gates an item on its oracle before it merges, so a check that needs one of the excluded things cannot pass when it runs: the build halts, and landing the work by hand to get past it bypasses every gate. Make such a check a later-stage drill instead: a later binder in a set, with an `after` edge and test 2's event "the earlier stage deployed", whose drill item's oracle verifies the evidence recorded after that deploy. The drill's own oracle meets this rule, because the deploy it needs is the earlier stage's, not its own. Moving a check to a later stage turns one binder into a set, so take the shape question back to the user (`plan:shape`, test 2) and record the new shape line; never split on your own. When the evidence can be recorded before landing by some other means, keep the check in the item. No validator can tell from a command whether it needs a deploy, so plan review alone holds this rule.

- Fails: one item builds the upload route, and its oracle ends in a live-evidence verifier that reads the item's own deployed service.
- Holds: stage 1 builds the route under a CI oracle; stage 2, `after` stage 1 deployed, carries a drill item whose oracle verifies the recorded evidence.

**Propose shared-term candidates  `plan:terms`.** After drafting the items, read every `contract` at once and propose a `shared_terms` entry for each string two or more items must render identically (see [references/binder-reference.md](references/binder-reference.md) — `id`, the `canonical` substring, and the `items` that must render it). Two signals raise a candidate:

- **Explicit** — a `contract` that says an item must quote or match another item's string verbatim. Turn that declared edge into a `shared_terms` entry so the invariant is machine-checkable, not just prose.
- **Overlap** — two or more items whose contracts describe emitting the same user-facing string or message. Propose the stable substring they share as `canonical` and list those items.

Each candidate is a proposal, not a commitment: it surfaces in the plan review card (`plan:surface`) for the human to confirm into the binder — surfacing is **advisory, not a gate**. This is the **only** point in hatch with cross-item visibility — the planner reads every contract at once, where the per-item build and deliver gates each see one item in isolation — so it is the one place the overlap can be caught. It is **best-effort, not a guarantee**: a shared term nobody surfaces here is never declared, so it is never enforced downstream.

Return the draft binder JSON.

---

After the subagent returns, review the draft. Check:
- The binder has a human `title` and a plain-language `summary`, and every work item has a one-sentence `summary` — none of them just restate the slug/id.
- Every work item has an `id`, a `contract`, and an `oracle`.
- Every decision the grilling rounds settled has a home in the binder — a scope line or a contract term by default, an oracle assertion only where the contract names the command or test that turns it red — and none lives only in the conversation. This is a review rule: no validator checks it.
- The shape matches the recorded `plan:shape` decision: one binder, or exactly the stages decided, each after the first carrying its `after` edge.
- `depends_on` references resolve to real IDs in this binder (no dangling refs).
- Oracle assertions trace to the item's contract.
- No oracle, by its own words or command, needs the item's own deploy, a production or shared live service, an operator login, or a post-merge event to pass (`plan:prelanding`); what the build environment starts for itself is fine. Flag one that does. Moving it to a later drill stage makes a set, so it goes back to the user as a `plan:shape` decision. This is a review rule: no validator checks it.
- `serialize`/`shared_resources` are set for any items that write shared state (migrations, lock files, config that multiple items touch).
- UI fields are present only on items with a UI surface.
- `sme` lists exactly the packs pinned in `plan:sme`. An empty `sme` is legitimate only when every always-on pack is suppressed by a `disabled: true` overlay — empty without that suppression means `plan:sme` was skipped; go back and run it.

Fix gaps in the main thread before proceeding.

---

### Phase 4 — Smart-surfaced review (the review point)  `plan:surface`

Per [references/smart-surfaced-review.md](references/smart-surfaced-review.md): compute the seven boundary signals for each work item and write `surface { flagged, signals }` into the binder. When a signal cannot be computed yet (no diff, no path conventions), record `not-computed:<signal-name>` in `surface.signals` rather than giving a clean pass.

Write everything you show a person in plain language — see [references/user-facing-prose.md](references/user-facing-prose.md).

Show the user which items are flagged and why. Then give them three ways to go:

- **Review all** — walk every work item.
- **Review flagged only** — walk only the flagged items.
- **Accept as-is** — skip the walk and move on.

Keep the list short: don't show oracle details for routine, unflagged items. The grilling rounds settled the intent; this point settles what the flags raise, so the deliver and build steps can run hands-off.

---

### Phase 5 — Cost education  `plan:cost`

When the binder has many work items or several large (`L`) estimates, tell the user plainly: this scope will cost time and real money before anything lands. Suggest a smaller first slice — the items with no `depends_on` that form the first wave — as a lower-risk start. A smaller slice is a smaller binder, not a set: it changes nothing in the `plan:shape` decision.

Educate; don't forbid. If the user wants the full scope, move on.

---

### Phase 6 — Emit, validate, and commit  `plan:emit`

**Write the binder(s)** to the resolved location (`.hatch/binders/<slug>.json`).

**When the shape decision is a set, emit a set.** The split was decided once, in the grilling rounds (`plan:shape`), by one of its two tests — the user asked for separate binders, or a named event outside the branch must happen between two stages. Do not re-decide it here, and never split at emit time for size or tidiness. The expand → migrate → contract shape is the canonical set (see [references/example-sequence/](references/example-sequence/)). Each binder in the set is a normal, self-sufficient binder: it must pass `validate_binder.py` on its own and leave the tree green on its own (e.g. *new* adds standalone code, *edit* rewires call sites, *delete* removes the now-dead code). Slugs are **descriptive and unique, grouped by a shared prefix, and carry no sequence number** (`note-tags-new`, `note-tags-edit`, `note-tags-delete`) — a number would be a stored order that rots when the set changes.

**Emit `after` edges when emitting a set.** For each binder in the set except the first, set its top-level `after` to the slug(s) of its immediate predecessor(s) in the suggested order — `note-tags-edit` carries `"after": ["note-tags-new"]`, `note-tags-delete` carries `"after": ["note-tags-edit"]`, and `note-tags-new` carries no `after` at all (it has no predecessor). The `after` field is the **only** persisted cross-binder dependency. (An `after` may also name an already-delivered binder — one hatch-deliver archived to `.hatch/binders/archive/` — which the status engine resolves as satisfied, not dangling.) The run order the user sees in the report (`plan:report`) is the topo sort the engine derives from these edges — which means `hatch-status`'s live order and this plan-time advice are always the same sort over the same stored edges. Only the edge is stored; the order is derived, never stored. Do **not** write a sequence manifest or encode order in slugs.

**Validate it.** Use `hatch_script` action `validateBinder` with `binder: <path>`; fallback: `uv run --script <skill-dir>/scripts/validate_binder.py --binder <path>`. On Pi, `hatch_dispatch` action `commitBinder` runs this validation itself as part of the review-and-commit step — do not validate by hand and then commit with `git`.

The validator is pure stdlib (no dependencies), so `uv run --script`, `uv run`, or `python3` all run it. Do not proceed on a validation failure. Fix the binder and re-validate until it passes. **For a set, validate every binder** — each must pass on its own before you present the set.

A clean run still prints two recorded escapes: the opted-out items, and the waived visual checks — every item naming a design view it does not open, with its reason and the item covering it. **Carry both onto the review card, with the shape line from `plan:shape`**, so the person saying `commit` sees each escape, its cover, and why the work is one binder or a set before the binder is committed rather than in the report afterwards.

**Carry each item's gate strictness onto the review card.** One row per item: its assertion count, how many assertions you expect the acceptance reviewer to class as execution-required (behavior only running reveals, such as timing or races, persistence, network or IO, UI viewport or rendering, and concurrency), whether it declares `expect`, and how its oracle command ends, in this shape:

```
upload-check-route: 12 assertions, 7 execution-required (planner's count; the gate classifies each one itself), marker yes
  ends: …the last 140 characters of the command
```

An opted-out item reads `opted out`, and a visual one `N assertions (visual gate)`. The execution-required number is your reading, not the gate's: nothing checks it, and the gate classifies each assertion itself. On Pi, pass it as `executionRequired` on `commitBinder`, keyed by item id (in a set, by `<slug>/<id>`), and the host writes the rows. `ends:` serves `plan:prelanding` review: read what the chain ends on.

**Single-work-item hatch.** A binder with exactly one work item can skip the deliver phase and go straight to build. Tell the user this option exists; let them make the call.

**Review surface — in-chat card, or a plannotator annotation session.** The editable card has an optional second surface: a browser annotation session over the same card(s), through the separately-installed plannotator CLI. The surface changes how the user reviews; it changes no gate and no verb — committing still takes the explicit `commit`.

- **Probe** for the CLI first (cross-shell; exit 0 = installed):

  ```
  uv run python -c "import shutil,sys; sys.exit(0 if shutil.which('plannotator') else 1)"
  ```

  On a failed probe, skip this block silently — never mention plannotator, offer nothing; the flow is the in-chat card exactly as below. Do not retry.
- **Offer** (probe succeeded), recommendation-first, through the host's user-input facility:

  > **Recommended: plannotator** — one browser session over the whole binder reads faster than a card-by-card chat walk, and every gate still runs.
  >
  > Verbs: `card` — review in chat · `plannotator` — annotate in a browser session
- **The annotation session** (chosen): render the card(s) to a session-scratch markdown file (the host's scratch area or a temp path — never committed, never under `.hatch/binders/`): the binder frame first, then every work item in dependency order carrying the same fields the chat card shows — title, summary, contract, `touches`, oracle, `depends_on`, and any smart-surfaced flags, plus the gate-strictness rows, unchanged. Hand the file to a blocking plannotator session (the `plannotator-annotate` skill where the host lists it, else the CLI directly) and wait for the returned feedback. Ingest by mapping each annotation onto binder-field edits; an annotation that maps to no binder field unambiguously is asked back in chat against that item — never guessed. Re-run the validator after applying the edits; it must pass before the card is presented for commit.

**Commit on the `commit` verb.** Show the binder — or, for a set, every binder — as an editable card (annotated-session runs: the updated card summary). Commit only when the user says "commit"; a set commits together, in one commit. Once committed, a binder is read-only to every later build step.

---

### Phase 7 — Report back  `plan:report`

Lead with the binder path and the total work-item count, then give the user:

- **Shape** — the `plan:shape` line: one binder and why, or a set of N and the test that decided it.
- **Work order** — the item IDs in dependency order (topological sort), and the dependency chain.
- **Flagged for review** — the IDs and the signals that flagged each one.
- **Opted-out items** — the IDs and their recorded reasons (from the validator's opt-out summary).
- **Waived visual checks** — the IDs that name a design view but do not open it, each with its reason and the item that checks it for them, plus how many waivers each covering item absorbs (from the validator's waiver summary).
- **First wave** — the items with no `depends_on`. These can start right away.
- **Experts applied** — the `sme` packs in effect for this binder (or *none*).

**For a set, also state the run order — as the topo sort derived from the `after` edges.** Name the binders in the order the engine derives: *first* `<slug>`, *next* `<slug>`, *then* `<slug>`, and remind the user to review and merge each before starting the next. The order is derived here from the `after` edges stored in each binder — which means this spoken advice and `hatch-status`'s live ordering are always the same topo sort over the same edges. Only the edges are stored; the order is derived, never written separately. The user moves between binders manually.

---

## Gotchas

- **The binder is always synthesized.** hatch-plan never exits early with a plan outline or a list of tickets. The output is a validated `.json` binder or nothing.
- **UI fields are conditional, not universal.** `design_reference`, `component_map`, `icon_map`, `token_changes`, `covers`, and `visual_check_waiver` belong only on items with a UI surface. The schema recognises a UI item by its `design_reference` (a view id, or `none` for UI foundation work): `binder-schema.json` rejects `component_map`, `icon_map`, `token_changes`, `covers`, or `visual_check_waiver` on an item without one, and `validate_binder.py` applies the same schema. What no check can catch is a `design_reference` placed on a migration, a CLI command, or a data pipeline item — the schema cannot tell that work from a UI slice by its shape, so don't write it in the first place.
- **The oracle is a real CI-facing check.** It is not a self-grading statement ("implementation looks correct") or a description of what the item does. It is the command you'd want CI to run, plus any assertion that command or a named test can turn red.
- **Opt-out is explicit and recorded.** There is no silent opt-out. Every `opt_out: true` requires a `reason`. hatch reports opted-out items after every run so nothing slips through unnoticed.
- **A design claim is checked or waived — never neither.** An item whose `design_reference` names a real view carries a `visual` oracle or a `visual_check_waiver` (`reason` plus `covered_by`). `validate_binder.py` rejects the binder otherwise, and rejects a waiver that does no work. `none` is matched byte for byte, so `None` and `NONE` are view names, not the sentinel.
- **Don't delegate synthesis judgment.** The synthesis subagent drafts; the main thread reviews, corrects, and owns the binder. Cross-referencing contracts, oracle traceability, and dependency order requires judgment — do not hand that off.
- **Facts are never asked; decisions are never assumed.** The survey answers what the repo can answer, and the grilling rounds put every remaining decision to the user, one frontier at a time, with a recommendation attached. The interview ends on the user's confirmation — not on a round with no new questions, and not on silence.
- **Validate before commit.** A binder that fails `validate_binder.py` is not a valid binder. Fix it before presenting it to the user for commit.
- **A sequence is a set of self-sufficient binders; order is derived, never stored.** The split is decided once, in `plan:shape`, by a named test — the user's own words, or an event outside the branch that must happen between two stages — never at emit time, and never for size, build order, stack, or reviewability. When it is a set, each binder is independently valid and mergeable, sliced expand → migrate → contract so each leaves the tree green. Slugs are descriptive and unique (no sequence number). Each binder except the first carries an `after` field naming its immediate predecessor(s); `after` is the only persisted cross-binder dependency. No sequence manifest, no ordering in slugs. The run order is derived (topo sort) from the edges — it is never stored directly. Movement between binders is the user's, done manually. Default is one binder.
- **The binder is read-only once committed.** Build steps read the binder; they do not modify it. A build step that tries to rewrite its own work item's oracle or estimate is corrupting its own governance.
- **A partially delivered binder is repaired by a successor, never an edit.** When a wave proves a committed plan wrong, plan a new binder with slug `<slug>-r2` (then `-r3`) and a top-level `supersedes: {"slug": "<predecessor>", "carried": [<ids already done>]}`. Copy every carried item into `work_items` unchanged from the predecessor — `hatch-deliver`'s preflight compares them with the predecessor's committed plan and refuses the successor otherwise — and plan the corrected remaining work beside them; a new item may `depends_on` a carried one. The successor starts from the predecessor's integration tip, so a done predecessor item you do not carry still has its code there: list it in `supersedes.dropped` and plan a work item that reverts or replaces it — preflight halts on a done item that is neither carried nor dropped. `validate_binder.py` checks that each carried id is a work item and that the binder does not supersede itself; the preflight proves each carried item's done ref in the predecessor. Commit it with its review like any binder. The predecessor is retired by the archive move at delivery, never edited or deleted.
