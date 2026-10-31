# Resume and worktree-clobber recovery

Loaded by `hatch-build`'s Phase 4 (`build:implement`) when `git worktree add` fails because the branch or worktree path already exists, and referenced wherever this file's doctrine calls out a resumable prior run. This is a small, standing reference — no numbered phase of its own — for the one recovery path hatch-build takes when it finds state left by an earlier attempt at the same item.

## The clobber guard

`git worktree add "$worktree" -b "$branch" "$integration"` fails when either the branch name or the worktree path already exists. **Don't clobber it.** hatch-build never force-deletes or overwrites an existing worktree or branch to make room for a fresh attempt — an existing `hatch/<slug>/item-<item-id>` branch or its worktree almost always means a prior run the user may want to resume, not stale debris to discard silently.

On this failure:

1. **Stop before making any change.** Do not run `git worktree remove`, `git branch -D`, or any destructive git command against the existing branch/worktree on your own judgment.
2. **Ask the user** how to proceed: resume the existing worktree (pick up implementation where it left off, honoring the same mutation guard and phase sequence from wherever the prior run stopped), or explicitly discard it (the user's call, not the worker's) and retry cleanly.
3. **If resuming**, re-run the mutation guard (`git rev-parse --show-toplevel`, `git branch --show-current`) against the *existing* worktree before any edit — the worktree may have been left mid-edit, mid-floor, or mid-gate by the interrupted run, and the guard is what confirms you are editing the right root on the right branch before continuing.

## Other resume touchpoints

Beyond the clobber guard above, resume shows up in a few narrower spots elsewhere in hatch-build's doctrine — restated here so the resume behavior is collected in one place:

- **The mutation guard itself.** Re-apply it "after creating a worktree, changing directories, resuming after context compaction, or any failed patch" (core SKILL.md, "Always-on mutation guard") — a context-compaction resume is a resume event just like a worktree-clobber resume, and gets the same re-check before the next edit.
- **The commit marker exists for this.** `[hatch:item-<item-id>]` (or the `Hatch-Item:` trailer) is what lets a resumed run — or the integration branch — re-derive which item a commit belongs to, without any other bookkeeping (core SKILL.md, Phase 9, `build:merge`).
- **9c-single's merge step accounts for a moved tip.** "Rebase/merge the item branch onto the **current** integration tip (which may have advanced if you are resuming a partial binder)" — a resumed single-item hatch re-targets the merge at wherever the integration branch actually sits now, not wherever it sat when the item branch was created (see [references/build-single-item-hatch.md](references/build-single-item-hatch.md)).
- **A halt always preserves the worktree.** "Preserve the failing worktree on halt and print its path" (core SKILL.md, Gotchas) — a halted item's worktree is exactly the state a resume picks back up from, so it is never torn down on the worker's own initiative.
