# Definition of Done

"Done" means the oracle passes on the merged result. The definition of done is the minimum check you'd want CI to run — the project's real CI-facing checks (its tests, build, and type-check) plus item-specific assertions. It is not a check the model grades itself on.

## Floor

The change must at least compile, type-check, and lint clean. Below that threshold hatch does **not** auto-merge — it surfaces the failure and halts.

Floor and oracle commands run at the work item's resolved execution context — the working directory the binder names and the project's own toolchain, never a hand-built `PATH` or shim.

Shipped output must also carry no framework-default placeholder branding — a stock `<title>` like `Frontend` or `Create React App`, generator boilerplate, lorem-ipsum copy, or a `TODO`-named export — left in place of the real values the item's plan specifies. Leftover stock scaffolding in delivered output is a floor failure, not a cosmetic note: an item is not done while it still ships another tool's defaults.

When an item's check oracle runs a command that is a superset of the floor — say the floor is compile/type-check/lint and the oracle is `npm run lint && npm test` — the floor and acceptance are the same check at two altitudes, not two separate bars. The floor runs first as the implementer's own pre-gate. Acceptance re-runs that command in a fresh context and governs. Merge re-validates the merged result, and CI is the bar underneath all of it. The two-phase split stays a real split only for assertion-bearing oracles — assertions the command does not itself check, a `visual` oracle, or a `contract` artifact.

## Lockfiles

A generated dependency lockfile (`uv.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `poetry.lock`, `go.sum`) is part of an application's deliverable, not transient scratch. For an application the lockfile is **tracked** — committed so every later item, every worktree, and CI install the same dependency graph; an untracked lockfile that each item regenerates is non-reproducible and reads as drift. (A published library may instead leave its lockfile untracked and pin only ranges in its manifest — the inverse convention.)

The decision is made **once**, by the foundation/scaffold item that stands the project up (greenfield mode in hatch-build), and the rest of the binder follows it — a later item does not independently decide to track or ignore a lockfile. When a scaffold generator emits a lockfile, the foundation item commits it (application) or records a deliberate ignore with its reason; either way the choice is explicit, never left to each worker to improvise.

## Opt-out

Opting out of a check is explicit and **recorded**: the binder's `oracle.opt_out` field plus a `reason`. There is no silent opt-out. hatch reports what it leaves unchecked whenever an opt-out is in effect.

## How to explain review to users

You don't have to review everything. hatch shows you what's worth a look.

Every work item carries a check that proves it's done — a real one, the kind you'd want CI to run, not a box to tick. hatch writes it and runs it for you.

When planning is done, hatch hands you a short list: the items worth your eyes — anything risky, unusual, or touching something sensitive — and stays quiet about the routine ones. Review is a short list, not a slog.

You keep the controls:
- Want to see everything? You can.
- A check doesn't fit an item? Turn it off — hatch tells you what that leaves unchecked.

The idea is simple: hatch puts the decisions that matter in front of you early, then gets out of your way.
