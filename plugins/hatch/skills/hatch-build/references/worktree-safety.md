# Worktree Safety

Loaded by `hatch-build` before any file mutation, after creating a worktree, after context resumes, after directory changes, and after failed patches.

## Mutation Guard

Before every file edit or generated-file write:

1. Record `INTENDED_ROOT` for the current phase.
   - Ticket-lifecycle metadata writes may target the resolved ticket file location or ticketing-system client state.
   - After the implementation worktree exists, all implementation paths target `<worktree-root>/<branch>`.
   - Persist the implementation `INTENDED_ROOT` and branch in the PR notes, a run-state note, or a small `.hatch-build-state.json` in the worktree so a resumed/compacted session can re-establish the guard before editing.
2. Run `git rev-parse --show-toplevel`.
3. Compare the result to `INTENDED_ROOT`.
4. Run `git branch --show-current`.
5. Refuse implementation mutations on protected branches such as `main`, `master`, `dev`, `test`, or any project-defined protected branch.
6. If the root or branch is wrong, stop and report. Do not patch from the wrong checkout.

If a resumed session cannot recover `INTENDED_ROOT`, recompute it from the known worktree path and branch before editing. If it cannot be recomputed confidently, stop and ask rather than mutating.

## After Unexpected Workspace Behavior

If a patch lands in the wrong checkout, a command runs from the wrong directory, or the workspace state is surprising:

1. Run `git status --short --branch` in the intended worktree.
2. Run `git status --short --branch` in the original checkout if known.
3. Identify only files touched by this run.
4. Restore only those accidental edits. Do not revert user changes.
5. Re-run the mutation guard before continuing.

Never rebase, back-merge, delete worktrees, reset hard, or revert unrelated changes unless the user explicitly asks.
