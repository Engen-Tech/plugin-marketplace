# CI and Ruleset Policy

Loaded by `hatch-build` only when a ticket touches GitHub Actions, CI/CD, repository automation, branch policy, rulesets, required checks, deployment policy, generated contracts, or environment policy.

## Repo Policy Preflight

Before designing or mutating policy:

1. Read root `AGENTS.md`, area `AGENTS.md`, contributing docs, and existing CI docs if present.
2. Inspect existing workflows and scripts.
3. If remote policy is in scope, inspect current branch/ruleset settings, merge settings, required checks, and bypass actors.
4. Detect fork policy and branch-flow policy from docs. If unknown, ask once before adding fork-specific or branch-flow-specific controls.
5. Output a concise local policy summary before proposing enforcement.

## Automation Shape

Prefer repo-owned scripts over workflow-inline logic.

- In uv repos, write PEP 723 Python scripts and invoke them with `uv run` locally and in CI.
- Put non-trivial logic in `.github/scripts/*.py` or the repo's documented automation directory.
- Keep GitHub Actions as thin wrappers that install/setup tools and call the same script.
- Add `--self-test` where useful so local and CI verification do not diverge.
- Do not assume Bash, WSL, `/tmp`, `curl`, `grep`, `find`, `lsof`, `kill`, or other POSIX utilities on the developer machine.

## Runs vs Required

For every CI check, state both:

| Check | Runs where | Required where | Failure behavior |
| --- | --- | --- | --- |

Do not use "gate" ambiguously. A check can run and fail visibly without being required by a ruleset.

## GitHub Required-Check Rollout

1. Add workflows/scripts first.
2. Merge the workflow to the protected base branch.
3. Confirm exact emitted check contexts on GitHub.
4. Update rulesets to require those exact contexts.
5. Refresh older open PRs by merging the base branch into them, not rebasing.
6. Watch the new checks before calling the rollout complete.

## Break-Glass Reporting

Normal `hatch-build` flow should not use admin bypass. If the user explicitly authorizes break-glass, report:

- why normal merge was blocked
- who performed the bypass
- whether the user explicitly authorized it
- the merge commit
- the timestamp

When rulesets have bypass actors, describe controls as "blocked for normal users with documented break-glass bypass," not as absolute.
