---
name: hatch-kaizen
model: haiku
description: >-
  Improve the project's stack packs from what its builds keep repeating. Opt-in via .hatch/kaizen.json, and the switch is absolute: absent or disabled means kaizen never runs, even when invoked directly. When on, it seeds every pack the project uses into .hatch/sme/ on the first enabled run, then writes pack edits as labeled kaizen: commits a human reviews — it never weakens a rule and never promotes a pack to enforcing. Sharpening rules from repeated overrides, erosion notes, and the first-draft discipline are live; new-pack suggestions and the advisory/enforcing pack flag come in a later phase. Trigger phrases: "run kaizen", "kaizen the packs", "improve the stack packs".
triggers:
  - "run kaizen"
  - "kaizen the packs"
  - "improve the stack packs"
---

`hatch-kaizen` turns what a project's builds keep repeating into better stack packs. It dispatches one hatch-owned agent — `hatch-kaizen` — a writer confined to `.hatch/sme/` and its own config area, whose every change lands as a commit a human reviews. This skill is the only place that agent is dispatched; it is the pack analog of `hatch-doc-gardner`: a thin orchestrator around a single writer.

**This is phase two: sharpen and educate.** What runs today is the seed-all step, the write-commit-review loop, and the sharpening pass: repeated `HATCH-SME-OVERRIDE` markers become narrow, evidence-cited rule improvements, and a signal that points toward loosening becomes an erosion note for the human. Phase three — new-pack suggestions and the advisory/enforcing pack flag with its gate mechanics — is a later phase and is not built yet. This skill does not pretend to it.

**Bundled scripts.** When Pi provides `hatch_script`, use the named action below. Otherwise replace `<skill-dir>` with the absolute directory containing this `SKILL.md` and run the fallback through `uv run --script`. Never resolve a bundled script from the consumer repo's working directory.

## Opt-in — `.hatch/kaizen.json` (the switch is absolute)

Read `.hatch/kaizen.json`:

- `{"enabled": true}` (optionally `"focus": "<freeform note>"`) → opted in. `hatch-deliver` runs this skill after each delivery, and a direct invocation works too.
- Absent, or `{"enabled": false}` → kaizen **never runs — including when this skill is invoked directly.** This is stricter than doc-gardner on purpose: doc-gardner's switch governs only its automatic delivery path and a standalone run works regardless; kaizen has no standalone carve-out. Off means off. When the switch is off and someone invokes this skill, report that kaizen is off — and that `.hatch/kaizen.json` with `"enabled": true` turns it on — then stop. Do not dispatch the agent.

`focus` is a plain nudge about what to watch (for example "watch the billing items and the auth rules"). It is not a task list. The file shape is gated by [references/kaizen-schema.json](references/kaizen-schema.json); see [references/kaizen.example.json](references/kaizen.example.json). The plugin validator schema-checks the file when a repo commits one.

## Inputs

- **Repo root** — the working tree whose packs kaizen improves (the integration branch's tree in a delivery).
- **Mode** — `delivery` (commit the pack edits) or `direct` (leave the working-tree edits for the caller). An explicit signal from the caller; default `direct`.
- **Binder slug** — in delivery mode, for the commit label.
- **Focus** — the optional `focus` string from `.hatch/kaizen.json`, passed through to the agent.

## Resolving the kaizen agent (any runtime)

The agent is a **writer** (it edits packs), so it needs a write-capable sandbox. Resolve it the way the runtime supports:

1. **A registered `hatch-kaizen` subagent exists** — dispatch it by name. This is the path on Claude Code (the plugin bundles it) and on Codex when the project carries `.codex/agents/hatch-kaizen.toml` (there `sandbox_mode = "workspace-write"` is set).
2. **No registered agent by that name** (a Codex plugin install, which cannot register subagents) — spawn a fresh write-capable subagent (a normal worker, not the read-only explorer) and give it, as its complete instructions, the bundled agent file: [references/hatch-kaizen.agent.md](references/hatch-kaizen.agent.md). That file is the agent's own instructions and is self-contained.

## Phase 1 — Check the switch  `kaizen:switch`

Read `.hatch/kaizen.json`. If it is absent, unparseable, or `enabled` is not `true`, report that kaizen is off and stop — even on a direct invocation. Otherwise read `focus` (may be absent) and continue.

## Phase 2 — Resolve the pack set  `kaizen:packs`

Resolve the pack set for this run — deterministically, by mode. "Every pack the project uses" means:

- **`Mode: delivery`** (including hatch-build's single-item hatch): exactly the binder's pinned `sme[]` — the packs this delivery built and gated against. Read the list from the binder; never re-derive it by matching. A delivery seeds what it used, nothing more: a pack the stack would match but the binder never pinned is left for the run that actually pins it.
- **`Mode: direct`** (no binder in play): derive the set the way `plan:sme` does — the always-on built-ins plus every built-in whose `match` token equals (case-insensitively) a dependency name or language emitted by `hatch_script` action `detectStack` with `root: <repo-root>`; fallback: `uv run --script <skill-dir>/../hatch-plan/scripts/detect_stack.py <repo-root>`.

Either way, resolve ids from hatch's bundled pack set (the same built-ins the hatch-plan, hatch-build, and hatch-verify skills carry), laid under the project's own `.hatch/sme/*.md` — on a name clash the project's copy wins. Hand the agent the resolved list, each id with the path to its source file. The skill resolves this because the built-in packs live in the installed plugin, not necessarily in the repo.

## Phase 3 — Dispatch the writer  `kaizen:write`

Dispatch `hatch-kaizen` (resolved as above) with the repo root, the resolved pack list, and the focus note. On the first enabled run the agent seeds `.hatch/sme/` — every used pack copied in as a full file with a provenance stamp and a lowercase basename (lowercase enforced at seed time), existing project copies left untouched. Beyond seeding, an edit comes from one of two signals: a concrete instruction carried in the dispatch (the same dispatch-instruction mechanism phase one already defined, unchanged), or the sharpening pass below — and the agent never weakens a rule or promotes a pack to enforcing. It returns a terse envelope (`seeded`, `packs_changed`, `candidates`, `erosion_notes`, `upstream_candidates`, `proposed_scaffolds`, `residual`, `summary`).

### The provenance stamp and the eager migrate pass  `kaizen:migrate`

Every file the agent seeds carries a **provenance stamp** in its frontmatter — `seeded_from` (the built-in it was copied from) and `base_sha256` (the canonical hash of that built-in) — so a later run can tell an untouched copy from an edited one. The stamp is diagnostic only: `validate_packs.py` checks its shape (paired keys; `base_sha256` is 64 lowercase hex) but never gates a pack's cleanliness on it.

The **first enabled run after this change performs an eager migrate pass** over `.hatch/sme/`, so copies that were seeded before stamps existed get classified and brought current in one visible sweep. It classifies every existing `.hatch/sme/` file with `hatch_script` action `checkPackProvenance` and `root: <repo-root>`; fallback: `uv run --script <skill-dir>/../hatch-plan/scripts/check_pack_provenance.py <repo-root>`; then acts on the classifier's state — one visible logged line per action:

- **seeded cache** — stamp-stripped bytes match the current built-in: write the provenance stamp onto it (it was a faithful copy that simply predates stamping).
- **stale cache** — byte-identical to a genuine *past* built-in the shipped hash ledger records: **auto-reseed** it — replace its bytes with the current built-in plus a fresh stamp. "stale cache" is the classifier's **ledger-verified** state; the migrate pass auto-reseeds only a ledger-verified stale cache, never a copy it merely guesses is old.
- **local fork** (a user-edited copy of the shipped built-in, including an unverifiable `base_sha256`) — **left in place and reported, never overwritten.** Kaizen never destroys a user's edit; a fork simply no longer receives upstream pack updates.
- **project pack / suppression / orphaned cache** — left as-is.

The migrate pass is **naturally idempotent**: a stamped seeded cache classifies clean on the next run, so re-runs are no-ops — there is no marker file to write or read.

### The sharpening pass  `kaizen:sharpen`

In delivery mode, after the seed/migrate work, the agent runs the sharpening pass over the repo's override signal:

- It reads the delivery's blast radius for new `HATCH-SME-OVERRIDE` markers and tallies standing markers repo-wide per rule id. Markers follow the grammar hatch-build's 6-sme step defines — `HATCH-SME-OVERRIDE(<rule-id>): <rationale>` — referenced here, never redefined.
- **Threshold.** Two or more occurrences sharing a reason across two or more distinct deliveries sharpen the rule — the narrow, evidence-cited exception. A single occurrence is recorded as a candidate in the run envelope and commit body only. An explicit concrete instruction carried in the dispatch may still sharpen from a single occurrence.
- **Direction rule.** A sharper or clarifying change the agent writes; anything that would loosen becomes an erosion note — rule id, override count, the builds (delivery slugs), the reasons given, and what loosening would let through — recorded in the run envelope and the kaizen commit body only, never in a pack.
- **Stale-exclusion re-check.** Each pass compares every standing replacement rule whose text begins `Narrows <built-in-id>:` against the current built-in text; when upstream has absorbed the narrowing, the agent proposes retiring the exclusion as an envelope note, never as an autonomous edit.

**First-draft discipline** for new and repaired rules: the enforced checklist wording must itself name the observable condition under which the rule applies — a condition stated only in Do/Don't/Patterns prose does not count. A checklist mandate is reserved for rules whose violation is deterministically observable in a diff; a lesson without such a signature lands as advisory guidance with a decision procedure (a stated when-to-apply condition the builder can evaluate), and single-incident lessons default to advisory. Before landing a new rule the agent scans the repo for sites the drafted wording would flag and attaches the site list to the commit body as evidence for the reviewer — never an auto-gate. New and sharpened rules cite provenance inline in the form `(seen <date>, <delivery> delivery)`.

**Surface resolution** — where a sharpening lands: a built-in rule with a repo-specific lesson lands in the repo's **existing** project pack, via `exclude_rules` on the built-in id plus a replacement rule under the project prefix whose text begins `Narrows <built-in-id>:`. A built-in rule with an environment-generic lesson becomes an upstream candidate note in the envelope and commit body — promotion into the built-in stays a human act in the hatch repo. A rule in the repo's own project pack gets a **new rule added beside it**, not an edit: an existing checklist rule's text is immutable and the host enforces that by byte comparison, refusing any reword, appended clause, or typo fix. The host cannot tell a tightening from a loosening, so it permits neither — changing the wording of a standing rule is a human act. The direction rule still governs what may be added: a would-loosen change becomes an erosion note, never an edit. A seeded cache, never: kaizen never edits a seeded cache in place. Kaizen never creates a project pack — when sharpening needs one that does not exist, it emits the proposed scaffold (frontmatter plus the replacement rule) in its envelope for a human to create.

## Phase 4 — Land or hand back  `kaizen:land`

**Pre-land syntax check — a hard rule in both modes.** Before staging or committing anything (delivery) and before reporting (direct), run the bundled pack validator over every changed file under `.hatch/sme/`, seeded files included: use `hatch_script` action `validatePacks` with `packs: [<pack.md>...]`; fallback: `uv run --script <skill-dir>/scripts/validate_packs.py <pack.md>...` (exit 0 clean, 1 findings). On findings, return the invalid file(s) and the validator output to the agent once to fix, then run the check again. If it still fails, do **not** land — no commit, no clean hand-back: report the validator output and return the failure as this phase's result.

- **`Mode: delivery`** — the agent's edits are in the integration branch's working tree. If `packs_changed` is non-empty, stage the changed files under `.hatch/sme/` and commit them as a labeled kaizen commit on the integration branch: `kaizen: <short summary>` (for a seed run, `kaizen: seed <n> packs into .hatch/sme/`), carrying the agent's `summary` in the body and any `residual` as a trailer. The subject prefix is exactly `kaizen: ` — the form the bench auditor measures; the `kaizen(<pack>):` variants are non-conforming. The commit body also carries the envelope's sharpening slots — `candidates`, `erosion_notes`, `upstream_candidates`, `proposed_scaffolds` — plus the evidence for any new rule (the provenance citation and the counterexample site list); that body is where erosion notes and upstream candidates become durable in git. The human reviewing the branch reviews these commits like any other. If nothing changed, make no commit. Never push.
- **`Mode: direct`** — leave the edits in the working tree and report the envelope to the caller; the user reviews and commits. Make no commit yourself.

Fold the envelope into the caller's report — the sharpening slots (`candidates`, `erosion_notes`, `upstream_candidates`, `proposed_scaffolds`) included. Write everything you show a person in plain language — the agent routes its human-facing output through the hatch-plainlanguage skill, and so does this skill.

## Rules

- **One agent, packs only.** The kaizen agent writes inside `.hatch/sme/` and `.hatch/kaizen.json` — never code, tests, the binder, git refs, prose docs, or hatch's built-in packs. This skill never edits anything itself — it dispatches and (in delivery mode) commits the agent's pack edits.
- **The switch is absolute.** Absent or disabled means kaizen never runs, direct invocation included. There is no standalone carve-out.
- **Never weaker.** No rule loosened or removed, no pack promoted to enforcing — changing what gates a build is the human's decision, made in review of kaizen's commits.
- **Direction rule.** A sharper or clarifying change kaizen writes; anything that would loosen becomes an erosion note in the run envelope and the kaizen commit body only — never in a pack.
- **Syntax-checked before landing.** Every changed file under `.hatch/sme/` must pass `validatePacks` (fallback: `<skill-dir>/scripts/validate_packs.py`) before Phase 4 commits (delivery) or hands back (direct); a failure lands nothing, and the validator output is the phase result. The design's promise that pack edits are syntax-checked before they land — so a bad edit can't silently break the checker that reads the pack — is now a running check, not prose.
- **Seed once, full files, stamped.** The first enabled run copies every used pack into `.hatch/sme/` whole, each with its provenance stamp and a lowercase basename; a project's existing copy always wins. That same first run migrates copies seeded before stamps existed (`kaizen:migrate`): it stamps a seeded cache and auto-reseeds a ledger-verified stale cache, but leaves a local fork in place, reported, never overwritten. From then on the repo owns its packs, and the built-ins cover only names the repo does not carry.
- **The migrate pass lands through the existing flow.** The stamps it writes and the stale caches it auto-reseeds are ordinary changes under `.hatch/sme/` — labeled `kaizen:` commits in delivery mode, working-tree edits in direct mode — gated by the same pre-land `validate_packs` check (Phase 4). It needs no separate path and no marker file; being naturally idempotent, a second run is a no-op.
- **Labeled, revertible commits.** In delivery mode every change is a commit whose subject prefix is exactly `kaizen: ` on the integration branch — the form the bench auditor measures; the `kaizen(<pack>):` variants are non-conforming — never pushed, never on a protected branch, reviewed and revertible like any commit.
- **Plain language to people, precision in packs.** Human-facing output goes through the hatch-plainlanguage skill; pack content stays technical.
- **Phase-two honesty.** Sharpening, erosion notes, and the first-draft discipline are live; new-pack suggestions and the advisory/enforcing pack flag are not built yet — never pretend to them: when a run has nothing it can do within phase two, say so in the envelope and stop.
