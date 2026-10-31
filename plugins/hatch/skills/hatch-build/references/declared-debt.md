# Declared Debt

## Marker syntax

hatch uses inline debt markers to declare deferrals during build. A marker takes the form:

```
HATCH-DEFER(<id>): <what is deferred> — <why> — follow-up: <what happens next>
```

Place the marker as a comment in the source at the exact site of the deferral.

## What a deferral records

Each marker states three things:

- **What is deferred** — the specific work skipped right now (a test, an edge case, a stubbed dependency, a TODO implementation).
- **Why** — the reason it is deferred now (out of scope for this item, blocks on another item, known unknowns at build time).
- **Follow-up** — who or what carries it forward *outside* hatch: a named owner, an entry in the team's own tracker/issue system, or the condition that unblocks it. **hatch has no backlog** — it does not schedule, queue, or revisit the deferral itself; this field records where the work lives once hatch hands off.

The marker is a snapshot: it states what *is* deferred and why, not a history of decisions.

## Two uses, two bars

A `HATCH-DEFER` marker arises in two very different situations, held to two different bars:

1. **Inline build-time deferral — the implementer's call.** While implementing, the worker may legitimately skip a test, stub a dependency, or defer an edge case, placing the marker at the site. This is a normal, surfaced engineering decision; the item can still complete, carrying the noted debt.
2. **A *capped acceptance-gate failure* is never cleared by a debt marker.** When the read-only acceptance gate caps out (two attempts, still failing), the item halts to a `failed` ref — letting the implementer place a marker to proceed would be grading its own escape. A `HATCH-DEFER` marker does **not** make the capped assertion pass. The two ways to accept an unmet acceptance assertion both live outside the worker: **re-plan it as an explicit oracle `opt_out` (with a reason) via hatch-plan** (a plan-time decision; the binder is read-only to build), or **a human accept-waiver** at the delivery halt (a build-time decision the orchestrator records in git). (See the verification-gate and integration-branch references.)

The distinction is the guardrail: a worker may *note* debt as it builds, but it may never *escape an acceptance cap* by declaring debt.

## Inline marker vs the human decisions at a halt

The inline `HATCH-DEFER` marker is a different thing from the two **human** choices the delivery orchestrator offers when an item halts at the acceptance gate. Keep them visibly separate — a worker must not be able to read its own marker as a self-accept path:

- **Inline `HATCH-DEFER`** — the implementer's note for an untestable-here assertion or a deferred edge case. It is build-time, worker-authored, and **never clears a gate**.
- **The human accept-waiver** — the orchestrator, from a live human decision (never from worker text), waives the named unmet assertion and merges the halted item as-is, recording the waiver in git (merge-commit trailers + the `accepted` ref). It is the only build-time path to merge an unmet assertion.
- **The human defer choice** — the human leaves the item unfinished (its `failed` ref stands, no `done`); the run continues and merges the independent rest, and hands off incomplete.

The backlog sink (an optional destination the user passes to hatch-deliver at run time — a file path or an append-command, **not** a binder field) is where the orchestrator appends an accept or defer record: the item id, the unmet assertion(s)/divergence, the decision, the human's reason, and — for accept — the merge commit. hatch appends to it and never reads, schedules, or revisits it; absent a sink, the decision is still surfaced once in the run report. An inline `HATCH-DEFER` marker is **not** routed to this sink — its follow-up field already records where that work lives.

## Surfacing

Deferrals do not silently disappear. hatch collects every `HATCH-DEFER` marker in the built result and surfaces them at the end of the wave — in the build summary and in the item's record. **An item carrying inline debt is never presented as complete without its deferral list shown alongside.** The run's review output includes a consolidated debt register across all items. That register is a **one-time report handed to the user, not a tracked backlog**: hatch does not persist, schedule, or revisit it. Carrying the debt forward is the user's job — hatch's contribution ends at surfacing it loudly.
