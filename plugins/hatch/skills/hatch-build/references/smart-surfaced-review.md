# Smart-Surfaced Review

Hatch front-loads review at plan time and keeps it optional. Surfacing is by objective boundary signals computed from the declared change — not by self-assessed confidence. This is hatch's principle 6: resolve early, autopilot after.

The same signals are re-checked at build time on the actual diff. That pass is authoritative (see `verification-gate.md`).

## When to Surface

Surface a work item if any of the following holds:

1. **Contract mutation** — a public API or SDK signature, data or wire or DB schema, CLI flags, args, or defaults, or config keys. Distinguish a *new* surface (additive) from a change to an *existing* one (breaking risk).
2. **Destructive op** — drop, delete, truncate, overwrite, migrate, force, or revert.
3. **Sensitive zone** — matched by path convention plus an optional per-repo setting. No hardcoded wordlist.
4. **Capability or resource escalation** — a new dependency, new IO, new infrastructure, or new integration.
5. **Blast radius** — exceeds file or context thresholds, or a file is edited by more than one work item in this binder. At plan time this flags every shared file; at build time the overlap passes only when a `depends_on` path joins the two items.
6. **Genuine architectural novelty** — a new pattern entering the codebase. Not merely new-to-this-repo usage of an existing project pattern.
7. **Explicit open question, conflict, or ambiguous scope** — anything the plan itself marks as unresolved.

## Weak Signal Handling

When a signal cannot be computed — schema detection unavailable, no diff yet, no path conventions configured — hatch asks rather than guessing. It records which signals it could not evaluate in the work item's `surface.signals` field, e.g. `not-computed:contract`. This keeps the triage honest: a missing signal is not a clean pass.

## Two-Pass Model

**Plan-time pass (advisory triage).** Hatch writes `surface { flagged, signals }` into each work item as the plan is built. Items above any threshold get flagged. At the end of planning, the user sees three options: review all items, review flagged items only, or accept the plan as-is. Routine items stay quiet.

**Build-time pass (the real gate).** After implementation, `hatch-safety-auditor` re-runs the same seven signals on the actual diff. An implementer can pivot into a boundary the plan never predicted — a dependency added mid-build, a schema touched incidentally. The build-time pass catches those. See `verification-gate.md` for the full gate protocol.

The plan-time pass informs; the build-time pass decides.

## Presenting at Plan Time

Surface a short list — only the items worth a human's eyes. Stay quiet on routine ones. Make refinement a short list, not a chore.

Do not surface oracles or acceptance criteria for routine items. Reserve that for flagged ones.
