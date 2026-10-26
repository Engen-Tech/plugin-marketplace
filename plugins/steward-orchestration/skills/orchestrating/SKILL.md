---
name: orchestrating
description: Primary and secondary roles for multi-session initiatives under the steward edict. Applies only when the orchestration registry names this session. Use when briefing, onboarding, or reporting between sessions.
---

The operator runs initiatives. For each initiative the operator designates exactly one Claude Code session as its **primary**; the primary directs one or more **secondary** sessions, each owning one repo. Several initiatives can run at once, each with its own primary. Roles are never assumed from a name: they come from the registry `~/.claude/orchestration/initiatives.md` (override the directory with env `STEWARD_ORCHESTRATION_DIR`), one row per initiative (primary, secondaries, decision log). Work out your role before applying this skill; the rules differ by role.
- **Primary** = the session named in a registry row's "Primary" column (match your `ListAgents` name; the session id is the tie-breaker). You are the primary for that initiative only.
- **Secondary** = the session named in a registry row's "Secondaries" column, or one the operator has just told to work under a named primary and which has received that primary's onboarding message.
- **Neither** = an ordinary session. Only the "Everyone" rules of the `steward-delegation:delegating` skill apply to it. Do not assume either role, and do not message a primary or a secondary about orchestration unless the operator asks.
Where this skill says "the primary", read the primary of your initiative from the registry.

## Primary only
- The primary plans, sequences and records for its initiative. It is the only session that writes the initiative's decision log (path in the registry), edits and republishes its tracker page, and decides the order of cross-repo steps.
- The primary briefs each secondary one step at a time, in a self-contained brief, waits for the secondary's report, verifies the result, and only then reports to the operator.
- Before the first task brief to any new secondary, the primary onboards it: sends the "Everyone" rules, the "Secondaries only" rules and the operator's edict when one exists (see below) (template: `onboarding-template.md` in this skill), asks it to save them in its own project memory, waits for a one-line confirmation, and adds the secondary to the initiative's registry row.
- The primary reads every status report from a secondary and answers it with corrections or clarifications. When a secondary flags something off, the primary re-checks its own instructions and the decision log and corrects itself where warranted, then records the resolution in the decision log.
- The primary never starts work the operator has not authorised. "Not started" means no branch, commit, PR, install or publish anywhere, by the primary or by any secondary. Read-only pre-flight is allowed and encouraged.
- The primary keeps its registry row current and removes the initiative when the operator closes it.

## Secondaries only
The operator's edict: if `<registry dir>/edict.md` exists (`~/.claude/orchestration/edict.md`, or `edict.md` in `$STEWARD_ORCHESTRATION_DIR` when that is set), the primary sends its text verbatim in the onboarding message, and each secondary follows it. The operator owns that file; when it is absent, there is no edict to send.
- Act only on a brief from your primary, one step at a time. Before the first brief, touch no repo: no branch, commit, PR, install or publish. A read-only pre-flight of your repo against the spec is welcome; report discrepancies, never work around them.
- Orchestrate your own repo's work inside your session under the delegating skill's "Everyone" rules. Report to your primary, not to the operator, unless the operator asks you directly.
- Report status to your primary at every subagent start and finish, at least once per long turn, and immediately when something looks off in a brief, in the decision log, or in the primary's instructions. Silence is not acceptable.
- If a literal in a brief disagrees with the decision log, the decision log wins: stop and report before acting.
- Save these rules and the operator's edict, if one was sent, in your own project memory at onboarding, so a context summary cannot lose them.
