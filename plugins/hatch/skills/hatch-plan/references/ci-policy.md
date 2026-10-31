# CI and Ruleset Planning

Loaded by `hatch-plan` only when a frontend planning run explicitly includes CI, GitHub Actions, repository automation, branch policy, rulesets, required checks, deployment policy, generated contracts, or environment policy work. Do not broaden a normal design-slicing run into policy work on your own.

## Preflight

Before emitting CI or ruleset tickets:

1. Read root `AGENTS.md`, area `AGENTS.md`, contributing docs, and CI docs if present.
2. Inspect existing workflows and scripts.
3. If remote policy changes are requested, inspect current rulesets, merge settings, required checks, and bypass actors.
4. Detect fork policy and branch-flow policy from docs. If unknown, ask once before adding fork-specific or branch-flow-specific controls.
5. Summarize the current policy before proposing enforcement.

## Automation Shape

- Prefer repo-owned PEP 723 Python scripts for non-trivial automation.
- In uv repos, invoke scripts with `uv run` locally and in CI.
- Keep workflows thin; do not duplicate policy logic in YAML and a local script.
- Add `--self-test` where useful.
- Do not assume Bash, WSL, `/tmp`, `curl`, `grep`, `find`, `lsof`, or `kill` on developer machines.

## Runs vs Required

Every CI/ruleset ticket must include:

| Check | Runs where | Required where | Failure behavior |
| --- | --- | --- | --- |

A check can run and fail visibly without being required. Avoid "gate" unless the ticket also states the enforcement surface.

## Required-Check Rollout

1. Add workflow/script.
2. Merge workflow to the protected base.
3. Confirm exact emitted check context on GitHub.
4. Require that exact context in the ruleset.
5. Refresh older PRs by merging the base branch into them, not rebasing.
6. Watch the new check.

Policy tickets that change remote rulesets must also include local doc updates: root `AGENTS.md`, area `AGENTS.md` if present, and CI/README docs if present.
