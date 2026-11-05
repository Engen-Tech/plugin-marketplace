# Binder Field Guide

The binder is hatch's spine — the single JSON artifact that drives planning, build, and integration from start to finish. Every hatch skill reads it; none of them write to it during a build run. The shape is hatch's own. `validate_binder.py` gates every binder before a run: it checks schema validity, detects dependency cycles, flags dangling `depends_on` references, and prints an opt-out summary.

## Binder-level fields

| Field | Type | Required | Meaning |
|-|-|-|-|
| `slug` | string (kebab-case) | yes | Names the integration branch (`hatch/<slug>/integration`) and all wave tags |
| `motivation` | string | yes | One-sentence reason this binder exists |
| `scope.included` | string[] | yes | Areas of the codebase in scope |
| `scope.excluded` | string[] | no | Things explicitly left out (prevents scope creep) |
| `design_facts.source` | string \| null | no | Path to the source design or prototype, or null |
| `design_facts.stack` | string | no | Resolved tech stack, recorded once at plan time |
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

## Per-work-item fields

| Field | Type | Required | Meaning |
|-|-|-|-|
| `id` | string (kebab-case) | yes | Unique identifier; referenced by `depends_on` in other items |
| `title` | string | yes | Short human label for the work item |
| `estimate` | `S` \| `M` \| `L` | no | Size estimate |
| `depends_on` | string[] | no | IDs of items that must land before this one starts |
| `design_reference` | string | no | View or route ID from the design source, or the literal `none`. Non-empty (`minLength: 1`). Naming a real view requires either a `visual` oracle or a `visual_check_waiver`; `none` is matched byte for byte, so `None` and `NONE` read as view names, not the sentinel |
| `covers` | string[] | no | IDs of the work items whose design claim this item's visual gate checks. A `visual_check_waiver` naming this item is only accepted when the waived item's ID appears here, so coverage is agreed at both ends rather than claimed by the item that benefits from it |
| `visual_check_waiver` | object | no | Records that this item names a design view another item opens for it. `reason` and `covered_by` are both required and non-empty. `validate_binder.py` holds the `covered_by` item to six conditions, each its own error: it resolves to a real work item; its oracle `type` is `visual`; its own `design_reference` names a real view (a gate hatch-build would skip covers nothing); it depends on the waived item directly or through the chain (a covering gate runs after the work it covers); its oracle carries a non-empty `assertions` list; and it lists this item in its own `covers`. The two `design_reference` values are never compared, so one gate covers several differently-named views as long as it names the items. A waiver on an item that names no view, or that already has a visual oracle, is rejected for doing no work |
| `component_map` | array | no | **UI-relevant, optional — present only when the stack has that surface** |
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

Every work item carries an oracle — the verification contract hatch uses before it considers the item complete. An oracle must be able to pass on the item's branch before the item lands: it must not need the item's own deploy, a production or shared live service, an operator login, or a post-merge event, though anything the build environment starts for itself is fine. A check that needs one belongs to a later drill stage (hatch-plan `plan:prelanding`).

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
