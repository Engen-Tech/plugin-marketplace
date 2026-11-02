---
name: hatch-verify
model: haiku
description: Verify one built work item against its behavioral acceptance check (oracle types unit/integration/e2e/smoke) in a read-only, fresh session on the actual diff; check acceptance + external-contract conformance + boundary crossings; kick findings back to build and escalate to the human only on retry-exhaustion.
triggers:
  - "verify this work item"
  - "run the behavioral gate"
  - "check acceptance for <id>"
---

**Model settings.** The frontmatter `model` and `effort` fields configure Claude Code only. On Codex and Copilot CLI, resolve the reviewers as described below; these fields neither select a GPT model nor require a switch to Claude. Do not warn, halt, or ask to switch models because this skill names Opus, Sonnet, or Haiku. On Pi, the package host runs each gate on the model resolved for its role (the steward profile by default, else the session model) and pins it for the run.

`hatch-verify` is the thin orchestrator for the behavioral acceptance gate. In its default **full** mode it dispatches two hatch-owned gate agents — `hatch-acceptance-reviewer` and `hatch-safety-auditor` — in parallel, aggregates their verdicts, and drives the kickback and escalation loop per `references/verification-gate.md`; in **boundary-only** mode it dispatches the safety-auditor alone (see *Modes* below). This skill is read-only throughout: the agents read the diff and the binder; this skill never edits code, tests, or the binder, and its only write is the attempt ledger outside the tree (`verify:attempts`).

**Bundled scripts.** When Pi provides `hatch_script`, it resolves these package-owned scripts; otherwise replace `<skill-dir>` with the absolute directory containing this `SKILL.md` and run the fallback through `uv run --script`. Never resolve a bundled script from the consumer repo's working directory.

## Pi route

When Pi provides `hatch_dispatch`, complete Phase 0, then call it with `action: runVerification`, the binder slug, work item id, and mode. In an interactive or RPC session on pi 1.4.0 or later it returns at once with a `hatch-dispatch-run-v1` receipt (`status: running`, a `runId`), and the run continues in the Pi host while the session stays free. The host shows progress in the footer and transcript. When the run ends, a `hatch-run-result` message starts a new turn; its content carries the `hatch-verification-v1` result, so use it exactly as described below. Do not poll, do not call `hatch_dispatch` again for this binder while the run is live, and never answer a Hatch prompt: only the human does. Call `action: runStatus` with the `runId` only when the operator asks how it is going, and `action: cancelRun` only when the operator asks to stop it. In print or JSON mode the call still blocks and returns `hatch-verification-v1` directly. The tool derives the binder, refs, tips, diff, composed pack rules, touched files, citations, and prompt from the installed package and Git. Do not pass or re-derive paths, prompts, tools, commands, models, providers, or diff ranges. Do not resolve the legacy agents below or run either review inline; `hatch_dispatch` creates both fresh read-only children and holds one dispatch lock across them.

A package-owned build or delivery binds verification to its fully staged candidate or proposed merge tree and supplies the ordered host-run check manifest. The manifest contains the final project-floor receipts plus the binder oracle receipt when required. A direct verification of a required command blocks when no manifest exists; the read-only gate never reruns commands to manufacture one.

Use the `hatch-verification-v1` result as Phase 3's aggregate. `pass`, `concerns`, `blocked`, and `skipped` map directly to the routing rules below. The host classifies a gate concern as retryable; this orchestrator still owns the existing caps—two acceptance attempts and three safety attempts—and the Git-native halt/escalation behavior. The attempt caps count results, so wait for each `hatch-run-result` before deciding a retry. A tool error is `blocked`, never a reason to fall back to an inline review. Use the legacy agent resolution only when `hatch_dispatch` is not available.

Visual oracles (`type: visual`) get their acceptance judgment from `hatch-validate`, never from this skill — but they do not skip the boundary gate: hatch-build (Phase 6) dispatches this skill in **boundary-only** mode for visual-oracle items *before* hatch-validate runs, so a VIOLATION or BLOCKED halts before any dev-server work. Opt-out oracles bypass this gate entirely; the build step skips hatch-verify for items where `oracle.opt_out` is true.

## Modes

The caller names the mode at dispatch; unnamed means **full**.

- **full** (default) — the pipeline as written below: Phase 0, then Phase 1 (acceptance) and Phase 2 (boundary scan) dispatched **in parallel**, then Phase 3 (aggregate).
- **boundary-only** — runs only the safety-auditor boundary gate (no acceptance phase, so nothing to parallelize): Phase 0, then Phase 2 directly, then report the safety verdict alone (Phase 3's aggregate table does not apply — PASS → `pass`, VIOLATION → the kickback loop under the same cap of 3, BLOCKED → `blocked`). hatch-build's Phase 6 dispatches this mode for visual-oracle items BEFORE hatch-validate runs; a VIOLATION or BLOCKED halts the item before any dev-server work. Acceptance for a visual oracle stays with hatch-validate and is never judged here.

## Inputs

The caller must supply:

- **Worktree path** — the checked-out tree holding the item's branch.
- **Binder path + work item id** — locates the `oracle`, `assertions`, and optional `contract` for the item. The binder is a JSON file at `.hatch/binders/<slug>.json` by default; see `references/binder-reference.md`.
- **Diff range** — the item's branch versus the integration tip (e.g. `hatch/<slug>/WI01..hatch/<slug>/integration`).
- **Type-check command** — the project's `<typecheck command>` as hatch-build resolved it, or word that the project defines none. Needed only when the item declares a `contract`; see `verify:typecheck`.

## Phase 0 — Prerequisites  `verify:prereq`

Before dispatching either agent:

1. Confirm a fresh, thin context: only the worktree path, the binder path, the work item id, and the diff range travel to each agent — plus, for the safety-auditor when the binder pins `sme[]`, the resolved stack-pack Review checklists (see `verify:boundary`). No build-session state.
2. Resolve the **pre-verify env command** bound to this wave: read `env_contract.command` from the binder (see `references/verification-gate.md` and `references/binder-reference.md`). If the oracle's assertions need an environment to run and no env command is present, halt with a clear message naming the missing contract — this is a hard gate.
3. Check the floor: if the diff cannot clear compile / type-check / lint, do not dispatch the agents. Surface the item for human review and halt. The floor is defined in `references/definition-of-done.md`.
4. Run the type-check for the acceptance reviewer when the item declares a `contract` (`verify:typecheck`, below).

## Type-check evidence for the acceptance reviewer  `verify:typecheck`

The acceptance reviewer judges a declared `contract` against an external artifact, and a passing type-check is one. The reviewer cannot produce it: on Claude Code its shell is held to a read-only allowlist, and every type-check (`npx tsc`, `uv run mypy`, `npm run typecheck`, `go vet`, `./node_modules/.bin/tsc`) runs project code. So this orchestrator runs it, before dispatching the acceptance reviewer, every time the item declares a non-null `contract` — first dispatch and every re-dispatch, because a kickback changes the tree:

```
uv run --script <skill-dir>/../hatch-build/scripts/run_oracle.py --cwd <worktree> --out <file> '<typecheck command>'
```

Run it in the item's worktree with the range's tip checked out and nothing else changed, so the record's `tree_sha` is the reviewed tree. Carry the record's JSON verbatim in the acceptance brief's `Type-check-record:` block (`verify:brief`); a failing type-check is evidence too — hand it over rather than halting on it. When the project defines no type-check command, write `Type-check-record: none — the project defines no type-check command`. When the item declares no contract, write `Type-check-record: none — no contract`. If the runner errors (exit 2), write `Type-check-record: none` plus the error: the reviewer then returns BLOCKED for missing evidence if the contract needs the type-check, which costs no attempt. Never ask the reviewer to run the type-check itself.

## Resolving the gate agents (any runtime)  `verify:resolve`

Each gate runs as a **fresh, read-only subagent** that receives only the dispatch brief's inputs — the four identifiers (worktree path, binder path, work item id, diff range) and the three evidence blocks (`Evidence-record:`, `Work-item:`, `Changed-files:`) — plus, for the acceptance reviewer, the `Type-check-record:` block (`verify:typecheck`), plus, for the safety-auditor when the binder pins `sme[]`, the resolved stack-pack Review checklists (see `verify:boundary`) — and reads the diff itself (and the binder, when a brief block is absent). hatch ships each agent so the gate runs automatically wherever it is installed — resolve the agent the way the current runtime supports:

1. **A registered subagent by that name exists** — dispatch it by name (`hatch-acceptance-reviewer` / `hatch-safety-auditor`). This is the path on Claude Code (the plugin bundles the agents) and on Codex when the project carries `.codex/agents/*.toml` (a repo checkout, or a project that installed them); there the agent file asks for `sandbox_mode = "read-only"`.
2. **No registered agent by that name** (for example a Codex plugin install, which cannot register subagents) — spawn a fresh subagent (an explorer-style worker told to stay read-only) and give it, as its complete instructions, the agent file bundled with this skill: [references/hatch-acceptance-reviewer.agent.md](references/hatch-acceptance-reviewer.agent.md) for acceptance, [references/hatch-safety-auditor.agent.md](references/hatch-safety-auditor.agent.md) for the boundary scan. Those files are the agents' own instructions and are self-contained.
3. **No subagent or host-worker mechanism is available at all** — the runtime forbids spawning entirely (e.g. a Codex session whose tool policy blocks sub-agents unless the user explicitly authorizes delegation). **Do not run the gate inline in this session as if it cleared** — the fresh read-only session is the gate's enforcement, and an inline pass is the implementer grading its own work. **Surface and halt** per [references/verification-gate.md](references/verification-gate.md) ("When the runtime cannot provide that fresh session"): report `blocked`, name what is blocked, and give the one action that unblocks it (authorize sub-agents / delegation in the host, then re-run). hatch never silently substitutes an inline self-review for the gate.

In both dispatching paths (1 and 2) the agent is instructed to stay read-only and receives only the brief's inputs — the four identifiers and the three evidence blocks (plus the acceptance reviewer's `Type-check-record:` and the safety-auditor's resolved stack-pack checklists when `sme[]` is non-empty); no build-session state travels with it. The dispatch steps below say "dispatch the `<agent>` gate" — resolve it by this rule each time.

**How firmly "read-only" is held, per host.** The reviewers' prompts forbid writes everywhere; what stops a reviewer that ignores them differs, so never report a stronger level than the row says.

| Host and install | Edit tools | Shell writes | Level |
|-|-|-|-|
| Claude Code plugin | not granted (`tools: Read, Glob, Grep, Bash`), and denied by `guard_writer_confinement.py` | the same hook allows only a fail-closed list of read-only commands (`git diff`/`log`/`show`/`status`/`rev-parse`/`cat-file`/`ls-files`/..., `grep`, `rg`, `cat`, `head`, `ls`, `find` without `-exec`/`-delete`, `jq`, `sha256sum`, ...) named without a path and joined by `;`, `&&`, `||`, `|` or newlines; compound syntax, expansion, wrappers, unlisted programs (so no type-check — see `verify:typecheck`) and redirects other than to `/dev/null` are denied | hook-enforced by allowlist. Not a sandbox: git still runs a program the repository's own git config names, and a hook holds only when the host starts it. Plugin agents ignore `permissionMode`. |
| Codex, registered `.codex/agents/*.toml` | sandbox | sandbox (`sandbox_mode = "read-only"`) | host-enforced, unless the parent session's live overrides (`/permissions`, `--yolo`) replace it — Codex reapplies those to spawned agents |
| Codex plugin fallback (path 2) | inherits the parent's sandbox | inherits the parent's sandbox | instruction-level, unless the whole session runs read-only. Codex tool hooks do not name the subagent, so no hook can single the reviewer out. |
| Copilot CLI profiles | no editing tool in the profile | `execute` is governed by Copilot's host permissions; no hatch hook loads there | instruction-level for shell writes; untested |
| Pi package host | explicit read-only tool set in fresh child sessions | no ambient shell or project tools | host-enforced by the package adapter; no ambient skills, extensions, project context, or parent conversation travel with the child |

**Codex model selection — acceptance and safety.** Read [references/codex-gate-models.json](references/codex-gate-models.json) before dispatch. It is generated from the same `codex_model` and `effort` fields as the registered Codex agents. The Claude `model: opus` setting does not apply on Codex, and this dispatcher's `model: haiku` does not select either reviewer's model.

- **Registered reviewer:** dispatch by its registered name; its Codex configuration supplies model and effort. An explicit user override takes precedence where the host supports it.
- **Plugin fallback:** select the entry for the reviewer being dispatched and pass its `model` and `reasoning_effort` through the host's spawn parameters, unless the user explicitly chose an override. Use a fresh context with only the bundled agent instructions and dispatch brief. On hosts exposing `fork_turns`, set it to `"none"`; a full-history fork can force parent-model inheritance and also leaks build context into the gate.
- **Host limitation:** if the host cannot apply those settings, use a registered or otherwise configured fresh read-only reviewer with the required settings. If no such route exists, report `blocked` with the reviewer name, required GPT model/effort, and the host limitation. Do not silently inherit a different model, claim the requested model ran without host evidence, or ask for Opus on Codex.

**GitHub Copilot CLI — acceptance and safety.** Use the native `hatch-acceptance-reviewer` and `hatch-safety-auditor` profiles loaded from the deliverable's `.github/agents/` through `.github/plugin/plugin.json`. Dispatch each through Copilot's custom-agent/task facility with only the fresh review brief. The profiles deliberately omit `model`, `models`, and `modelPolicy`: use Copilot's configured per-reviewer model, or inherit the resolved session model when no override exists. Both Claude and GPT are valid. Do not pass a model override merely to translate the canonical Claude `model: opus`, this dispatcher's `model: haiku`, or the Codex model manifest; those are not Copilot requirements. Honor an explicit user model choice through the host's supported settings. Each profile requests the canonical `effort` through Copilot's `reasoningEffort` field.

Before relying on a profile, inspect the loaded agent settings: a project or user profile with the same name can shadow the plugin, including an older GPT-only profile. If the native profile is missing or stale, reinstall the plugin from the repository root and start a new session. An Auto session's resolved model is valid; the label Auto is not itself a failure. If the host cannot launch a fresh reviewer or honor an explicit user setting, report the actual limitation. Do not claim a model or effort was applied from prompt text alone. Copilot's shell access remains governed by host permissions; the reviewer prompt forbids writes, but the profile is not an OS read-only sandbox and no hatch hook runs there — read-only is instruction-level on Copilot.

## Parallel dispatch and verdict currency  `verify:parallel`

In **full** mode the two gates go out **in parallel** — one message carrying two independent read-only dispatches, `verify:acceptance` and `verify:boundary` together. Nothing forces an order: both read the same diff, neither writes, and neither agent's answer changes what the other reads. Running them one after the other cost the measured delivery about thirteen minutes. Everything else is unchanged — the aggregate table, both caps (2 acceptance, 3 safety, still independent), and every verdict rule. Aggregation simply waits for both envelopes before it fills a row. The dispatcher waits for both gates' completion notifications rather than polling — no sleep loop between dispatch and aggregation.

The safety-auditor's stack-pack checklist resolution (`verify:boundary`, unchanged mechanics — including the composed-checklist resolver) happens **before** the parallel dispatch, because its output rides in that agent's dispatch brief.

**The verdict-currency invariant.** A verdict is bound to the diff-range hash it reviewed, and the aggregate table may only ever combine two verdicts bound to the same, final diff-range hash. When a kickback changes the range, every verdict bound to the old hash is stale: re-dispatch each stale agent on the new range — in parallel again when both are stale — and never carry a stale verdict into a row.

**Cap counting.** An agent's cap counts only the dispatches that follow its OWN non-passing verdict. A re-dispatch caused purely by a verdict-currency refresh — the agent's own prior verdict was passing, and a peer's kickback changed the range — does NOT count toward that agent's cap. So a safety-driven kickback chain can never exhaust the acceptance cap of an item acceptance never faulted, and the reverse holds the same way. The count lives in the attempt ledger (`verify:attempts`), never in this conversation's memory: the ledger counts each agent's `concerns` verdicts, which is the same number.

**The acknowledged cost, stated plainly.** A range-changing kickback re-dispatches EVERY stale agent — up to two dispatches per kickback where the serial flow re-dispatched one. The parallel saving therefore lives on clean items, which the measured delivery shows are the common case; a kickback-heavy item trades some of it back.

## Dispatch briefs and returned reports  `verify:brief`

**Every** gate dispatch brief — first dispatch or re-dispatch, either agent, either mode — carries the deterministic diff-size stat line in the pre-dispatch guard's grammar:

```
Diff-size: <files> files, <bytes> bytes
```

Compute both numbers over the item's diff range: `git diff --name-only <range>` piped to a line count for `<files>`, `git diff <range>` piped to a byte count for `<bytes>`. The guard recomputes them and denies a brief that omits the line or claims numbers git disagrees with, so the doctrine here and the guard agree byte-for-byte on the shared prefix.

**After the Diff-size line, every brief — first dispatch as well as kickback, either agent, either mode — carries three more blocks, in this order, so each gate reads the evidence instead of re-deriving it (the acceptance brief carries a fourth, last):**

- **`Evidence-record:`** — the item's `run_oracle` evidence record, read with `git cat-file -p refs/hatch/<slug>/item-<id>/evidence`, followed by that JSON verbatim. Its `tree_sha` is what binds the record to the exact tree under review. When the ref is absent, write the literal `Evidence-record: none` plus one clause saying why (no floor run has attached one for this item yet) — an absent record is stated, never omitted.
- **`Work-item:`** — the item's JSON slice as it reads from the binder: `id`, `title`, `contract`, `oracle`, `touches`, `shared_resources`, `surface`.
- **`Changed-files:`** — `git diff --stat <range>` followed by `git diff --name-status <range>`, over the same range as the Diff-size line.
- **`Type-check-record:`** (acceptance brief only) — the `run_oracle` record of the project's type-check on the range's tip, or `Type-check-record: none` plus the reason (`verify:typecheck`).

These blocks come strictly AFTER the worktree-path mention and the Range/Diff-size lines, never before. The pre-dispatch guard takes the FIRST `<rev>..<rev>` token in the brief as the diff range and resolves the FIRST `worktree` mention that names an existing path and stops there — so ordering the new blocks last is what makes a contract or evidence record that itself later mentions a worktree, or contains a `..`-shaped token, harmless to the guard's own read.

**Fresh-eyes kickback.** A re-dispatch brief after a kickback carries **deterministic facts only** — the `run_oracle` evidence record for the corrected build (its JSON, already capped), a fresh `Type-check-record:` for the corrected tip when the item declares a contract, the failing assertion ids, and the diff-range hash (`git rev-parse` of both endpoints). It carries **never the prior attempt**'s verdict prose: no quoted findings, no earlier narrative, no argument with what the last report said. The re-review is a fresh reading of the corrected diff, not a debate with the report that preceded it.

**Check every returned report before acting on it.** On EVERY returned report, run the checker first:

```
uv run --script <skill-dir>/scripts/check_gate_report.py --agent <acceptance|safety> --envelope <verdict> --report <file> --binder <path> --item <id> --repo <worktree> --range <range>
```

For a passing safety report with pinned packs, also pass `--checklists <file>` containing the exact normalized rule objects dispatched to that agent as a JSON array. Keep this temporary input beside the report; it is not delivery state. Both report formats require `**Diff SHA256:**`, computed over `git diff --no-ext-diff --no-textconv --binary --no-color <range> --` stdout bytes.

A nonzero result means the report is **malformed or stale**: verdict/provenance contradiction, missing item/range/digest, changed diff, or missing assertion/checklist dispositions. Do not act on the verdict. Re-dispatch that agent once for a well-formed report against the current range. If the re-dispatched report ALSO fails the checker, halt the item with a call to action naming the field — never loop. Matching hashes establish which content a report names, not proof that a model actually reviewed it.

## The attempt ledger  `verify:attempts`

Retry caps must survive a crash, a context reset, or a resumed session, so the count is persisted, not remembered. Run the bundled ledger helper:

```
uv run --script <skill-dir>/scripts/gate_attempts.py check  --repo <worktree> --binder <path> --item <id> --gate <acceptance|safety>
uv run --script <skill-dir>/scripts/gate_attempts.py record --repo <worktree> --binder <path> --item <id> --gate <acceptance|safety> --verdict <pass|concerns|blocked> --range <range>
```

1. **Before every dispatch** of a gate — first dispatch, kickback re-dispatch, or currency refresh — run `check` for that gate. Exit 1 means the cap is already spent for this item: do not dispatch; take the cap path (acceptance: halt with a call to action; safety: escalate to the human). This is how a resumed session learns about attempts made before it started.
2. **After every report that passes `check_gate_report.py`**, run `record` with the envelope verdict and the dispatched range. A malformed report is not an attempt — its single re-dispatch is governed by `verify:brief` — so record only checked reports.
3. Read the cap from `check`, not from a count you kept. `record` exits 1 when it recorded an attempt the ledger says should never have been dispatched; treat that like an exhausted cap and report it.

What counts: `concerns` verdicts (DEVIATION, VIOLATION) per item, gate, and item spec; `pass` and `blocked` are recorded and spend nothing. A changed diff keeps the count — fixing the diff is what the retries are for. A changed item spec (a successor binder, a re-planned oracle; the ledger hashes the item's canonical binder JSON) starts a new sequence. Each line carries the gate, attempt number, verdict, range, live diff digest, and item-spec digest. The ledger lives under the repository's Git common directory (`hatch/attempts/<binder-slug>/<item-id>.<gate>.jsonl`), shared by every worktree and never committed. The reviewers never touch it; this orchestrator does. It is ordinary files, so it makes a resumed session honest, not a tamper-proof record.

## Phase 1 — Acceptance + contract conformance  `verify:acceptance`

Dispatch the **`hatch-acceptance-reviewer`** gate (resolved per *Resolving the gate agents* above) with the worktree path, binder path, work item id, and diff range — in the same message as the boundary dispatch (`verify:parallel`), and with the brief content `verify:brief` requires.

The agent reads the binder on disk, dispositions each `oracle.assertions[i]` as inspection-verifiable or execution-required, and checks contract conformance against an external artifact (the `Type-check-record:` this orchestrator ran per `verify:typecheck`, a schema, or a contract test — the reviewer never runs the type-check). It returns one of:

- `CONFORMANT` — all assertions disposed, contract confirmed or absent.
- `DEVIATION` — one or more unresolved assertions or a missing contract artifact.
- `BLOCKED` — a required input is unreadable or missing — including a type-check record a declared contract needs (run `verify:typecheck` and re-dispatch; no attempt is spent) — **or the diff is readable but empty** (the item produced zero changes — nothing to disposition).
- `SPEC-SUSPECT` — the code diverges intentionally and the binder looks stale; halts for human adjudication.

**On DEVIATION:** record it in the attempt ledger (`verify:attempts`), kick the findings back to hatch-build for bounded self-correction, and re-dispatch the agent on the corrected diff once `check` allows it. Cap: **max 2 attempts total**, counted by the ledger. On the second attempt still returning DEVIATION, halt with a call to action — no human escalation at this gate, and **no self-clear**: the implementer may **not** make the capped failure pass by declaring debt. The capped item takes the halt path — in a wave the worker commits its item branch and writes a `failed` ref at that tip ("halted at the gate, not cleanly done"), not done. Three ways forward:

- **Fix and rerun.**
- **Re-plan the unmet assertion as an explicit oracle `opt_out` via hatch-plan, then rerun.** The binder is read-only to build, and hatch has no backlog.
- **Get a human accept-waiver or defer at the delivery orchestrator's Phase-4 halt.** The orchestrator asks the human directly; this gate never records the accept.

See `references/verification-gate.md`.

**On SPEC-SUSPECT:** halt for human adjudication immediately. Do not loop; do not kick back. The boundary verdict dispatched alongside is recorded in the report but triggers no kickback — a halted item has no corrected diff to re-scan. In a wave the worker leaves the same `failed` anchor — a committed item branch + a `failed` ref carrying the spec-suspect reason (it means "halted at the gate," not "the code is bad"). The binder is amended through hatch-plan; alternatively the human may accept the divergence at the Phase-4 halt (the orchestrator records the waiver against the halted tip), never by this gate.

**On BLOCKED:** halt with the blocking reason. The boundary scan (`verify:boundary`) was dispatched alongside rather than after, so record whatever verdict it returns and kick nothing back — the item is halted. For an empty diff, the reason names which it looks like — a whiff (re-dispatch the worker) or a change already present on the tip (drop or amend the item via hatch-plan). An empty-diff BLOCKED is not an accept/defer candidate: there is no diff to merge and no named assertion to waive.

## Phase 2 — Boundary scan  `verify:boundary`

Dispatch the **`hatch-safety-auditor`** gate (resolved per *Resolving the gate agents* above) with the same inputs: worktree path, binder path, work item id, and diff range — in full mode, in the same message as the acceptance dispatch (`verify:parallel`), and with the brief content `verify:brief` requires.

**Resolve stack-pack checklists first (only when the binder pins `sme[]`).** Read the binder's `sme` list. For each id, resolve the pack — the worktree's project overlay `.hatch/sme/<id>.md` laid over this skill's built-in [references/sme/](references/sme/) `<id>.md` (project-local wins). Before extracting anything from a project overlay, validate it with the pack validator (`uv run --script <skill-dir>/../hatch-kaizen/scripts/validate_packs.py <pack.md>`): a malformed overlay is **BLOCKED** — report the validator's findings and halt; never skip a pack that fails validation, because a silently dropped pack silently drops its rules out of the gate. A pinned id that resolves to no pack at all (no overlay, no built-in) is likewise **BLOCKED**, with the missing id(s) named in the report. After validation, obtain the checklist by invoking the resolver (`uv run --script <skill-dir>/../hatch-kaizen/scripts/resolve_pack_checklist.py <pack.md>`) and **parsing its JSON stdout as the composed Review checklist** — the normalized item list, one object per rule with keys `id`, `text`, `source` — and hand THAT parsed list to the auditor in its dispatch brief, never a raw section blob. The dispatcher no longer reads the pack's own `## Review checklist` section directly: the resolver's output IS the checklist, so an `extends` pack's base rules and exclusions actually reach the gate. A resolver error — an unresolvable `extends` base, or an `exclude_rules` id the extended built-in never had — is **BLOCKED** and halts with the resolver's findings, exactly like a validator failure. This is the one input beyond the four that travels to a gate agent, and only when `sme[]` is non-empty: a project-extensible checklist cannot be embedded in the self-contained agent, and built-in packs live in the plugin rather than the worktree, so the dispatcher resolves them. When `sme[]` is empty or absent, hand nothing and the auditor's stack-pack check no-ops.

The agent re-runs the seven smart-surfaced-review signals (see `references/smart-surfaced-review.md`) on the actual diff — plus, when handed stack-pack checklists, the conditional stack-pack check (an undeclared `HATCH-SME-OVERRIDE` is a VIOLATION) — and returns:

- `PASS` — no undeclared crossings.
- `VIOLATION` — one or more undeclared boundary crossings.
- `BLOCKED` — a required input is unreadable, or the binder pins a non-empty `sme[]` and the auditor received no checklists, or a pinned id has no resolved checklist (the auditor reads the binder itself, so it detects the mismatch and fails closed).

**On VIOLATION:** record it in the attempt ledger (`verify:attempts`), kick findings back to hatch-build, and re-dispatch the agent on the corrected diff once `check` allows it. Cap: **max 3 attempts total**, counted by the ledger. After the third attempt still returning VIOLATION, escalate to the human — an unjustified boundary crossing is a safety question that requires a person's decision.

**On BLOCKED:** halt with the blocking reason.

In full mode this scan is dispatched **in parallel** with acceptance (`verify:acceptance`), not after it — see `verify:parallel`. Its verdict is always collected: when acceptance halts the item, the boundary result arriving alongside is recorded in the report and kicks nothing back. When acceptance kicks back and the diff range changes, this verdict goes stale and the auditor is re-dispatched on the new range under the currency invariant — which does not spend its cap when it had already returned PASS. In boundary-only mode this phase runs directly after Phase 0 — there is no acceptance phase beside it.

## Phase 3 — Aggregate verdict  `verify:aggregate`

In boundary-only mode there is nothing to aggregate: report the safety-auditor's verdict alone — PASS → `pass`, VIOLATION with the cap exhausted → escalate per the cap rules, BLOCKED → `blocked`. In full mode, combine both agents' return envelopes — checked per `verify:brief`, and both bound to the same, final diff-range hash per `verify:parallel` — into a single verdict:

| Acceptance result | Safety result | Aggregate |
|-|-|-|
| CONFORMANT | PASS | `pass` |
| CONFORMANT | VIOLATION (cap not exhausted) | loop `verify:boundary` |
| DEVIATION (cap not exhausted) | — | loop `verify:acceptance` |
| Either cap exhausted | — | `blocked` (halt-with-CTA or escalate per cap rules) |
| SPEC-SUSPECT or BLOCKED | — | `blocked` (halt for human) |

Report the aggregate verdict to the caller (hatch-build or hatch-deliver). Write everything you show a person in plain language — see [references/user-facing-prose.md](references/user-facing-prose.md).

- `pass` — both agents cleared. Report PASS with a one-paragraph summary.
- `concerns` — findings went back to build. This is an intermediate state, not a terminal one.
- `blocked` — a cap is exhausted, or the verdict is SPEC-SUSPECT or BLOCKED input. Include the exact agent output and the one action the human needs to take next.

This skill is read-only throughout all phases, apart from the attempt ledger outside the tree.

## Gotchas

- **Floor first.** A change that cannot clear compile / type-check / lint never reaches the agents. See `references/definition-of-done.md`.
- **Read-only.** This skill never edits code, tests, the binder, or any other file — its one write is the attempt ledger under the Git common directory, which is not part of the tree. Neither do the agents; how firmly each host holds them to it is in the table under `verify:resolve`. If an edit is needed, it goes back to hatch-build.
- **Fresh session per dispatch.** Each agent dispatch is a new session with no build-session context. Pass only the brief's inputs — the four identifiers, the three evidence blocks, the acceptance reviewer's `Type-check-record:`, and, the one conditional addition, the safety-auditor's stack-pack Review checklists, resolved here and passed only when the binder pins `sme[]`. No build-session state travels.
- **The agents do the reading.** On Pi, package code builds hash-bound Git evidence and exposes it through fixed read-only tools; on other hosts `hatch-acceptance-reviewer` and `hatch-safety-auditor` read the diff and the binder directly. This skill does not pre-read those files for them.
- **Escalate only on exhaustion; this gate never records an accept.** No human review gate fires during delivery except safety-auditor cap exhaustion (3 attempts). The acceptance gate (2 attempts) and a SPEC-SUSPECT halt with a call to action, not a human escalation. A human may accept or defer the halted item, but only at the delivery orchestrator's Phase-4 halt through the host's user-input facility — this read-only gate surfaces the halt and never writes the `accepted` ref.
- **Caps are per-agent, not shared, and persisted.** The acceptance cap (2) and the safety cap (3) are independent. Exhausting one does not reset the other, and a re-dispatch that only refreshes a stale-but-passing verdict does NOT count toward that agent's cap (`verify:parallel`). The counts live in the attempt ledger, so a resumed session reads them with `gate_attempts.py check` instead of starting again from zero (`verify:attempts`).
- **Both gates go out at once, and a stale verdict never lands in the table.** In full mode the two dispatches share one message; a kickback that changes the diff range invalidates every verdict bound to the old hash, and each stale agent is re-dispatched before aggregation (`verify:parallel`).
- **Never act on an unchecked report.** `check_gate_report.py` runs on every returned report first; a nonzero result is a malformed report, worth exactly one re-dispatch and then a halt — never a loop (`verify:brief`).
- **Opt-out items skip this gate.** Items with `oracle.opt_out: true` are not dispatched here. The build step reports the opt-out; hatch-verify is not invoked.
- **Visual oracles run boundary-only here; acceptance belongs to hatch-validate.** If a work item arrives here with `oracle.type: visual`, run boundary-only mode — never Phase 1, and never a plain refusal. Its acceptance judgment happens in `hatch-validate`, after this gate clears.
