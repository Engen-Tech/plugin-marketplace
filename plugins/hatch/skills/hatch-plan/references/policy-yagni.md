# Policy YAGNI Filter

Loaded by `hatch-plan` with `ci-policy.md` when planning frontend-adjacent CI, GitHub Actions, repository automation, branch policy, rulesets, required checks, deployment policy, generated contracts, or environment policy work.

Prefer controls that prevent observed or likely repo-specific failures. Avoid controls that only improve generic maturity.

Before recommending controls, answer:

- Does the repo accept fork PRs?
- Is PR volume high enough to justify merge queue?
- Does repo policy require topic branch names?
- Is there a maintainer/team model justifying CODEOWNERS?
- Is the risk real for this repo, or only generally good practice?

Do not add fork hardening, merge queue, strict up-to-date requirements, linear history, topic branch naming, CODEOWNERS expansion, or monorepo path-filter complexity unless repo policy or explicit user direction requires it.

## Branch Flow Simulation

For branch/ruleset tickets, simulate:

1. normal task branch to `dev`
2. `dev` to `test`
3. `test` to `main`
4. `hotfix/*` to `main`
5. hotfix port or equivalent fix to `dev`
6. next `test` to `main` after the hotfix

Reject any setting that requires forbidden back-merge. If hotfixes can land directly in `main` and back-merge is forbidden, do not recommend branch-up-to-date requirements on promotion branches, linear history, or fast-forward-only promotion.

Do not enforce task-branch naming unless repo policy explicitly defines it. Blocking protected branch backflow is a separate control from naming.
