# Policy YAGNI Filter

Loaded by `hatch-build` with `ci-policy.md` when a ticket touches branch policy, rulesets, CI enforcement, repository controls, or deployment policy.

Prefer controls that prevent observed or likely repo-specific failures. Avoid controls that only improve generic maturity.

Before adding a control, answer:

- Does the repo accept fork PRs?
- Is PR volume high enough to justify merge queue?
- Does repo policy require topic branch naming?
- Is there an actual maintainer/team model justifying CODEOWNERS expansion?
- Is the risk real for this repo, or only generally good practice?

Do not add these unless repo policy or explicit user direction requires them:

- fork/SHA hardening for repos that do not accept forks
- merge queue
- strict branch-up-to-date requirements
- linear-history or fast-forward-only promotion
- topic branch naming enforcement
- CODEOWNERS/team-gated review
- monorepo path-filter complexity

## Branch Flow Simulation

For branch/ruleset policy, simulate:

1. normal task branch to `dev`
2. `dev` to `test`
3. `test` to `main`
4. `hotfix/*` to `main`
5. hotfix port or equivalent fix to `dev`
6. next `test` to `main` after the hotfix

If hotfixes can land directly in `main` and back-merge is forbidden, do not require branch-up-to-date on promotion branches, linear history, or fast-forward-only promotion. Use merge commits unless repo policy explicitly says otherwise.

Do not enforce task-branch naming into `dev` unless the repo policy explicitly defines a naming rule. Blocking protected-branch backflow is a separate policy from topic branch naming.
