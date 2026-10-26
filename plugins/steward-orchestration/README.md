# steward-orchestration

steward-orchestration sets up primary and secondary roles for initiatives that span several Claude Code sessions. For each initiative, the operator names one session as the **primary**. The primary directs one or more **secondary** sessions, and each secondary owns one repo. The primary briefs a secondary one step at a time, checks its report, and then reports to the operator.

The plugin works on Claude Code only. GitHub Copilot reads the same catalog, so it lists the plugin, but nothing in it runs there.

The plugin ships:

- The `steward-orchestration:orchestrating` skill: the rules for the primary and for secondaries, and an onboarding message the primary sends to each new secondary.
- A SessionStart hook. It creates the registry file if it is missing and adds a short role check to each session's context.

## Install

The plugin relies on steward-delegation: the orchestrating skill applies the "Everyone" rules of the `steward-delegation:delegating` skill. The manifest has no dependency field, so install steward-delegation yourself. If its skill is missing, the session tells you once. Both plugins install from the Engen-Tech marketplace, [Engen-Tech/plugin-marketplace](https://github.com/Engen-Tech/plugin-marketplace).

```
claude plugin marketplace add https://github.com/Engen-Tech/plugin-marketplace.git
claude plugin install steward-orchestration@engen-tech --scope user
```

If you use several `CLAUDE_CONFIG_DIR` profiles, install once per profile.

For local development from a steward checkout, run Claude Code against this folder. This is not a way to install the plugin.

```
claude --plugin-dir /path/to/steward/plugins/steward-orchestration
```

## The registry

Roles come from the registry file `~/.claude/orchestration/initiatives.md`, one row per initiative: the primary, its secondaries and the decision log. To use another directory, set `STEWARD_ORCHESTRATION_DIR`; the registry is then `$STEWARD_ORCHESTRATION_DIR/initiatives.md`.

The registry sits under `~/.claude`, not under `$CLAUDE_CONFIG_DIR`, so sessions in different config profiles share it. The hook creates the file from a blank table the first time, and never overwrites it.

## The operator's edict (optional)

You can give secondaries a standing instruction of your own. Write it to `edict.md` in the registry directory (`~/.claude/orchestration/edict.md`, or under `$STEWARD_ORCHESTRATION_DIR`). When the file exists, the primary pastes its text verbatim into the onboarding message, and each secondary follows it. When the file is absent, the onboarding message has no edict.

You own this file; the plugin never writes it, and no code reads it. Only the primary session reads it, when it onboards a secondary.

## If you already have these rules in CLAUDE.md

If your `CLAUDE.md` already spells out the orchestration rules, installing this plugin loads them twice. Shrink your `CLAUDE.md` section to a pointer instead, and move any standing instruction for secondaries into `edict.md`:

```
# Orchestration: the steward-orchestration plugin
Primary and secondary roles come from the `steward-orchestration` plugin (`steward-orchestration:orchestrating`).
```
