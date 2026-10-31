# Binder Field Guide

The binder is hatch's spine — the single JSON artifact that drives planning, build, and integration from start to finish. Every hatch skill reads it; none of them write to it during a build run. The shape is hatch's own. `validate_binder.py` gates every binder before a run: it checks schema validity, detects dependency cycles, flags dangling `depends_on` references, and prints an opt-out summary.

A binder may stand alone, or be one of an **ordered set** that hatch-plan emits when work separates into stages that must land in order (expand → migrate → contract; see [example-sequence/](example-sequence/)). Each binder in a set is fully self-sufficient — independently valid and independently mergeable. Slugs are descriptive and unique, grouped by a shared prefix; no ordering is encoded in slugs.

When emitting a set, hatch-plan stores the cross-binder dependency as an `after` edge on each binder that has a predecessor. The run order is derived from those edges (a topo sort) and is never stored separately — no sequence manifest, no ordering in slugs. The spoken plan-time advice and `hatch-status`'s live ordering are always the same topo sort over the same `after` edges. The user runs the binders in the derived order manually.

**`after` — cross-binder predecessor slugs.** `after` is an optional top-level array of slug strings naming the binders that must be merged before this one starts. It is the only stored cross-binder dependency. A dangling reference (a slug that does not resolve to a sibling binder in the set) is a warning; a cycle is an error. The run order is always derived from `after` edges (topo sort) and never stored directly.

## Binder-level fields

| Field | Type | Required | Meaning |
|-|-|-|-|
| `slug` | string (kebab-case) | yes | Names the integration branch (`hatch/<slug>/integration`) and all wave tags |
| `title` | string | yes | Human-friendly binder name; the build's title on the Hatch Status page (the slug stays the technical id) |
| `summary` | string | yes | Plain-language goal, 1-2 sentences: what this binder delivers and why it matters; reader-facing, distinct from `motivation` (the terse internal why) |
| `after` | string[] | no | Predecessor binder slugs; the only stored cross-binder dependency; run order is derived from these edges (topo sort), never stored separately; dangling ref = warning, cycle = error |
| `motivation` | string | yes | One-sentence reason this binder exists |
| `scope.included` | string[] | yes | Areas of the codebase in scope |
| `scope.excluded` | string[] | no | Things explicitly left out (prevents scope creep) |
| `design_facts.source` | string \| null | no | Path to the source design or prototype, or null |
| `design_facts.stack` | string | no | Resolved tech stack, recorded once at plan time |
| `sme` | string[] | no | Ids of advisory SME packs matched at plan time; the implementer writes against them and `hatch-safety-auditor` enforces each pack's Review checklist (undeclared violations only). Absent or `[]` = none |
| `shared_terms` | object[] | no | Canonical strings several work items must render byte-identically; the whole-binder consistency gate `check_shared_terms.py` enforces at deliver time. Absent or `[]` = nothing to check (see Shared terms) |
| `supersedes` | object | no | Marks a successor binder that repairs a partially delivered, committed one: `{slug, carried[], dropped[]?}`. `slug` names the predecessor (successor slug convention `<slug>-r2`, then `-r3`); `carried` lists predecessor item ids copied into `work_items` unchanged; `dropped` lists predecessor items that are done but not carried — their merge is still on the branch the successor starts from, so a successor work item must revert or replace that code. `validate_binder.py` checks each carried id is one of this binder's items, that no id is both carried and dropped, and that the binder does not supersede itself; `deliver_preflight.py` halts unless each carried item has a done ref on the predecessor integration branch that passes provenance and equals the predecessor's committed item, every predecessor done item is carried or dropped, and every dropped id has a predecessor done ref. See docs/how-to/binder-repair.md |
| `token_manifest` | object \| null | no | Shared design-token map; present only when a token system exists |
| `env_contract.command` | string | yes | The project's own test/dev env command |
| `env_contract.supports_isolation` | boolean | yes | Whether the command accepts injectable isolation params |
| `env_contract.isolation_params` | string[] | no | Params that make runs isolated, e.g. `PORT`, `COMPOSE_PROJECT_NAME` |
| `env_contract.cwd` | string | no | Directory the env command runs in, relative to the worktree root; default is the worktree root (see Execution context) |
| `runtime_contract` | object \| null | no | Declares the runtimes the env needs; null or absent when no runtime floor is recorded (see The runtime contract) |
| `runtime_contract.runtimes` | object[] | no | Required language/toolchain runtimes the planner survey detected |
| `runtime_contract.runtimes[].name` | string | yes (in entry) | Runtime, e.g. `node`, `python`, `go` |
| `runtime_contract.runtimes[].version` | string | yes (in entry) | Required version or range, e.g. `24.15`, `3.13`, `>=24.15.0` |
| `runtime_contract.runtimes[].manager` | string | no | Version manager that pins it, e.g. `nvm`, `mise`, `asdf`, `volta`, `pyenv` |
| `runtime_contract.on_unavailable` | `halt` | no | Policy when the active runtime does not satisfy the declaration; the only value is `halt` |
| `work_items` | WorkItem[] | yes | Ordered list of work items (at least one) |

## The runtime contract

`env_contract` says how to start the env; the optional `runtime_contract` says which language and toolchain runtimes that env needs. It records a runtime floor up front instead of leaving it to be discovered when a CLI hard-refuses — npm `engines` with engine-strict, a framework CLI that demands a minimum Node, an interpreter that rejects an old version. Omit it (or set it to `null`) when the project has no runtime floor worth recording.

hatch does not install or select runtimes for you. Doing so would reach outside the worktree and pull an unpinned toolchain onto the host — a hermeticity and supply-chain hazard. The contract only **declares and detects**; it never auto-provisions.

Each `runtimes` entry pins one runtime: `name` (`node`, `python`, `go`, …), the `version` it requires (a version or range, e.g. `node` `>=24.15.0`, `python` `3.13.x`), and an optional `manager` — the version manager that pins it (`nvm`, `mise`, `asdf`, `volta`, `pyenv`). The planner reads the repo's pin files (`.nvmrc`, `.tool-versions`, `.python-version`, a `package.json` `engines` entry, `pyproject`) to detect the floor, then records the resulting `version` (and the `manager` when one is in use) — not the pin-file path. `on_unavailable` has exactly one value, `halt`: when the active runtime does not satisfy the declaration, hatch stops and reports rather than guessing or installing.

The two roles split cleanly:

- **hatch-plan** runs the survey once during project configuration. It reads the pin files (`.nvmrc`, `.tool-versions`, `.python-version`, `package.json` `engines`, `pyproject`) and writes the detected floor into `runtime_contract`.
- **hatch-build** runs a preflight before the deterministic floor. It checks the active runtime against the declaration. On a match it proceeds; on a mismatch it **halts** with an actionable call to action — the same hard-gate idiom hatch uses for `playwright-cli` and `uv`: surface the gap, name the fix, do not auto-fix it.

When the repo declares a version manager, the `env_contract.command` or an oracle `command` may route through it (e.g. `mise exec -- <command>`) so the declared runtime is the one that runs. That is the repo's own manager doing the selection inside the worktree — hatch still installs nothing.

## Shared terms

hatch builds a binder's items in parallel and gates each item's diff in isolation, so no
per-item gate can see two items wording the same user-facing string differently. `shared_terms`
is the whole-binder answer: a binder declares the strings several items must render identically,
and the deliver-time check `check_shared_terms.py` halts a delivery whose assembled tree lets one
drift. The field is optional and backward-compatible — a binder with no shared wording omits it,
and an absent or empty `shared_terms` is a clean no-op everywhere downstream.

Each entry has exactly three keys:

| Key | Type | Meaning |
|-|-|-|
| `id` | string (kebab-case) | Unique identifier for the shared term; must be unique across all entries |
| `canonical` | string | The exact substring every listed item must contain, byte-identical (non-empty) |
| `items` | string[] | Two or more work-item ids that must each render `canonical`; every id must resolve to a real work item in this binder |

```json
"shared_terms": [{
  "id": "shadow-warning",
  "canonical": "reuses an archived (delivered) slug — the delivered history is shadowed; pick a fresh slug",
  "items": ["archive-aware-validator", "archive-aware-status-engine", "plan-slug-freshness-doctrine"]
}]
```

`canonical` is a byte-identical **substring**, not a whole line. Drifting strings usually live
inside interpolations (`f"binder '{slug}' reuses an archived …"`), so declaring the stable
substring — the part with no interpolated prefix or suffix — keeps the check free of interpolation
syntax and language assumptions: it is plain substring presence in a file's bytes, not parsing.
Pick the longest run of literal text that every listed item shares, and leave any per-item prefix
(a variable, a slug, a leading label) outside it.

`validate_binder.py` checks the shape at plan time: `id` kebab-case and unique across entries,
`canonical` present and non-empty, `items` with at least two ids that each resolve to a real work
item (a dangling id is an error, mirroring the `depends_on` dangling check). It also **warns** when
a listed item has an empty `touches` — the deliver-time check would then have no files to scan for
that item. These are structural checks only; the byte-identity enforcement over real file contents
is `check_shared_terms.py`'s job on the assembled tree, not the validator's.

## Per-work-item fields

| Field | Type | Required | Meaning |
|-|-|-|-|
| `id` | string (kebab-case) | yes | Unique identifier; referenced by `depends_on` in other items |
| `title` | string | yes | Short human label for the work item; its card's title on the Hatch Status page (the id stays the technical anchor) |
| `summary` | string | yes | Plain-language goal, one sentence: what this item does |
| `estimate` | `S` \| `M` \| `L` | no | Size estimate |
| `depends_on` | string[] | no | IDs of items that must land before this one starts |
| `design_reference` | string | no | View or route ID from the design source, or the literal `none`. Non-empty (`minLength: 1`). Naming a real view requires either a `visual` oracle or a `visual_check_waiver`; `none` is matched byte for byte, so `None` and `NONE` read as view names, not the sentinel |
| `covers` | string[] | no | IDs of the work items whose design claim this item's visual gate checks. A `visual_check_waiver` naming this item is only accepted when the waived item's ID appears here, so coverage is agreed at both ends rather than claimed by the item that benefits from it |
| `visual_check_waiver` | object | no | Records that this item names a design view another item opens for it. `reason` and `covered_by` are both required and non-empty. `validate_binder.py` holds the `covered_by` item to six conditions, each its own error: it resolves to a real work item; its oracle `type` is `visual`; its own `design_reference` names a real view (a gate hatch-build would skip covers nothing); it depends on the waived item directly or through the chain (a covering gate runs after the work it covers); its oracle carries a non-empty `assertions` list; and it lists this item in its own `covers`. The two `design_reference` values are never compared, so one gate covers several differently-named views as long as it names the items. A waiver on an item that names no view, or that already has a visual oracle, is rejected for doing no work |
| `component_map` | array | no | **UI-relevant, optional — present only when the stack has that surface.** Like `icon_map`, `token_changes`, `covers`, and `visual_check_waiver`, it requires `design_reference` on the same item: the schema defines a UI item structurally as one carrying `design_reference` |
| `icon_map` | array | no | **UI-relevant, optional — present only when the stack has that surface** |
| `token_changes` | array | no | **UI-relevant, optional — present only when the stack has that surface** |
| `contract` | object \| string \| null | no | The open-shape interface this item exposes or consumes |
| `serialize` | boolean | no | When true, this item runs alone — no parallel build mates (default: false) |
| `shared_resources` | string[] | no | Resources that cannot be accessed concurrently, e.g. `db/migrations` |
| `touches` | string[] | no | Concrete files/paths this item creates or modifies; feeds the file-collision + shared-resource parallelism gates and `validate_binder.py`'s same-wave overlap check |
| `surface.flagged` | boolean | no | Whether hatch has flagged this item for human review |
| `surface.signals` | string[] | no | Human-readable reasons for the flag |
| `oracle` | Oracle | yes | How hatch verifies the item is done |

## The oracle

Every work item carries an oracle — the verification contract hatch uses before it considers the item complete.

The schema allows two shapes:

**A check oracle** names a test type and the command hatch runs:

```json
{
  "type": "smoke",
  "assertions": ["route renders without error"],
  "command": "npm run lint && npm test"
}
```

`type` is one of `unit`, `integration`, `e2e`, `smoke`, or `visual`. `assertions` and `command` are optional but recommended. The floor for a non-opted-out item is compile / type-check / lint — a change that cannot clear that bar is surfaced for human review rather than auto-merged.

**An opt-out oracle** records a deliberate decision to skip hatch's verification:

```json
{
  "opt_out": true,
  "reason": "migration verified by the team's existing migration test suite in CI"
}
```

Opt-outs are explicit and recorded, never silent. The `reason` field is required. After a run, hatch reports every opted-out item and its reason so nothing slips through unnoticed. For the full rules on the floor and opt-out policy, see `definition-of-done.md`.

**A recorded visual-check waiver** is the other escape hatch writes down. It sits beside the oracle rather than inside it, and records that this item names a design view but is checked against it by another item's visual gate:

```json
{
  "id": "dashboard-data",
  "design_reference": "dashboard",
  "visual_check_waiver": {
    "reason": "this item wires the dashboard's data layer; the view is opened once, by the slice that renders it",
    "covered_by": "dashboard-view"
  }
}
```

Here `dashboard-view` carries the `visual` oracle, names `dashboard` in its own `design_reference`, lists `dashboard-data` in both its `depends_on` and its `covers`, and states what it checks in a non-empty `assertions` list — the six conditions in the field table above. Waivers are explicit and recorded, never silent, the same way opt-outs are: `validate_binder.py` prints every waiver with its reason and its covering item, and prints how many waivers each covering item absorbs, so a gate covering seven views reads as covering seven views.

## Execution context — where the command runs and how tools resolve

An oracle `command` (and the `env_contract.command`) is one shell string, so the binder must also say **where** it runs and **how** its tools are found. Otherwise a multi-root repo — say a Python service at the repo root with a `.venv`, plus an Angular app under `frontend/` — is ambiguous: neither toolchain is on `PATH`, and the same string cannot sit at two roots.

**Working directory.** The optional `cwd` field names the directory the command runs in, **relative to the worktree root**. Omit it and the command runs at the worktree root. In a multi-root or polyglot repo, set `cwd` to the toolchain's own root — e.g. `cwd: "frontend"` for the Angular command, no `cwd` (or `cwd: "."`) for the root Python command.

**Multi-root commands use the runner's own targeting — never a synthetic root.** When two roots must be driven from one place, express it with the task runner's built-in root-targeting flag rather than inventing structure:

| Runner | Run rooted at a sub-path |
|-|-|
| npm | `npm --prefix <dir> run <script>`, or workspaces `npm -w <workspace> run <script>` |
| pnpm | `pnpm -C <dir> <script>`, or `pnpm --filter <pkg> <script>` |
| yarn (berry) | `yarn workspace <name> <script>` |
| make | `make -C <dir> <target>` |
| just | `just --justfile <dir>/justfile <recipe>` (or `-d <dir>`) |
| Nx / Turbo | run from the repo root, target by project name (`nx run <proj>:<target>`, `turbo run <task> --filter=<proj>`) |

Do **not** add a root `package.json`, a `bin/` wrapper, or a hand-assembled `PATH` to make a bare command work — that is invented machinery the runner already provides.

**Project-local toolchains resolve through their own entrypoint, not a global install.**

- **Node:** invoke the binary through its package script or the runner — `npm`/`pnpm`/`yarn run` prepend that package's `node_modules/.bin` to `PATH` for the script, so `ng`, `tsc`, `eslint`, `vite` resolve with no global install and no shim. `npx`/`pnpm exec` do the same for a one-off.
- **Python:** run through `uv run <command>` (executes inside the project's `.venv` with no manual activation) or the project's documented venv entrypoint — not by hand-editing `PATH` or sourcing an activate script inside the command string.
- **Task runners** (`make`, `just`, Nx, Turbo) already run their recipes with the project environment set up; prefer the documented entrypoint over re-deriving it.

When the project declares a runtime floor (see The runtime contract), a command may also route through the repo's own version manager — e.g. `mise exec -- <command>` — so the declared runtime is the one that resolves.

## Optional and nullable fields

State a field's optionality and nullability explicitly so an oracle can verify it. The two are different:

- **Optional** — the key may be absent. Anything in the schema's `properties` but not in `required` is optional. Use this for a field that simply may not apply ("not asked").
- **Nullable** — the key is present but its value may be `null` (`"type": ["<type>", "null"]`). Use this for a field that always appears but whose value can be genuinely empty ("asked, and the answer is none").

A logically-absent value is `null`; a present-but-empty collection is `[]` or `{}`; only a deliberately empty text value is `""`. Modelling a possibly-absent field as a required non-null string forces a seeded placeholder and defeats verification — prefer nullable, and seed genuine absence as `null`.

The `contract` field shows both forms, because the schema allows `object | string | null`:

- **Null whole field.** When an item has no interface at all — no upstream dependency to consume, nothing to expose — set `contract` to `null`, **never to an empty string `""`**. An empty string is a value, not an absence: it reads as "the upstream is the empty interface" rather than "there is no upstream," which an oracle cannot tell apart from a real-but-blank contract.
- **Absent inner field of an object contract.** When `contract` is an object but one part of the interface does not apply — say the item exposes an output but consumes no input — leave that inner key absent (or `null`) rather than seeding it with `""` or `{}`. The same rule recurses: an absent inner field means "this part is not part of the interface," which an oracle can check, while a blank placeholder cannot be told apart from a real empty value.

## On disk and resume

The default location is `.hatch/binders/<slug>.json`. When hatch-plan runs, it checks for an existing binder there first, then asks, then falls back to that default.

The binder is committed only at run boundaries — never mid-step. During a build run it is read-only: work items cannot modify the plan that governs them. This prevents a build step from corrupting its own governance.

Resume is git-native. hatch tracks progress through commit markers, wave tags, and a `refs/hatch/` ref namespace. The tag and ref scheme is documented in `integration-branch.md`.

## Example walk

The `example-binder.json` file has three work items from a notifications redesign:

- **`shell`** — sets up the routing and mount point. No dependencies, smoke oracle with an explicit lint + test command. Builds first.
- **`list-view`** — the visible notifications list. Depends on `shell` (won't start until shell lands). Uses a visual oracle that checks pixel fidelity against the design at 1440×900.
- **`schema-migration`** — adds a `read_at` column. No UI surface. Marked `serialize: true` so it runs alone, not in parallel with other items. Lists `db/migrations` as a shared resource. Uses an opt-out oracle with a recorded reason — the team's CI migration suite already covers this; hatch reports the opt-out rather than re-running it.
