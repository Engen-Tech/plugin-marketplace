# stackwell

A calm status pane for Claude Code. It sits beside the conversation and shows context use, quota, cost, git, subagents and tool calls at a glance. Text is grey by default. Muted colours mark the groups, and only warnings use strong colour.

```
Opus 5.5 (1M)                               main

context                          131k / 1M   13%
━━━━━━──────────────────────────────────────┊───
▪ msgs 79k  ▪ tools 7k  ▪ sys 3k  ▪ other 42k
trend       ▁▂▃▄▅▆▆█  +5k/turn · ~146 turns left

quota 7d    ━━━━━━━━━━━──│──────────  44%   3d4h
acct work   5h 58%  58m   7d 8%  5d12h

session     $47.04 est · $22/h · 2h11m
cost        ▂▃▃▆▄▂▃█▃▂     turn 14 · 2m10s · +9k

steward     primary · widget-release
            docs-sec         secondary   busy
            api-sec          secondary   idle
            log 12m ago

git         3 files  +120 −40  ↑2

agents      researcher  sonnet                1m

▸ tools     27 calls                         ✕ 2
```

## Install

```
/plugin marketplace add Engen-Tech/plugin-marketplace
/plugin install stackwell@engen-tech
```

The pane opens at the next session start. `/stackwell off` keeps it closed.

## What it shows

- **context**: how full the context window is, split into messages, tool definitions, system prompt and other. `┊` marks the auto-compact point. **trend** shows context growth per turn and about how many turns are left before auto-compact.
- **quota**: your rate-limit windows. `│` marks where even use over the window would be. **acct** rows show other accounts from the quota folder (see below).
- **session**: cost estimate, cost per hour and elapsed time. **cost** shows each turn's cost, the turn count, the last turn's duration and the context it added.
- **steward**: shown only when this session is a primary or secondary in a steward-orchestration registry (see below).
- **git**: changed files, lines added and removed, commits not yet pushed, and the worktree name.
- **agents**: subagents that are running or finished in the last 5 minutes.
- **tools**: the number of tool calls. Click the row, or run `/stackwell tools`, to open it. Open, it shows the most used tools and a log of recent calls.

When the pane is short, the least important rows drop first.

## Settings

Set these in `/config` or with `claude plugin configure stackwell`.

| Option | Default | What it does |
|-|-|-|
| `theme` | `auto` | `auto`, `vga`, `mocha`, `tokyo-night` or `latte`. `auto` uses the palette file if one is set, else follows Claude Code's light or dark theme. |
| `quotaDir` | `~/.claude/quota` | Folder of quota files for the `acct` rows. If the folder is missing, no rows show. |
| `paletteFile` | empty (off) | A file with a `# >>> PALETTE` … `# <<< PALETTE` block of `NAME=R,G,B` lines. The pane uses `TEXT_FG` (background), `CTX_OK` (text), `CTX_WARN` and `CTX_CRIT`. |

### Quota files

Each file in `quotaDir` is one account, as JSON. Any script can write them, for example a status line command:

```json
{
  "profile": "work",
  "five_hour": { "used_percentage": 58, "resets_at": 1767000000 },
  "seven_day": { "used_percentage": 8, "resets_at": 1767400000 },
  "updated_at_epoch": 1766990000
}
```

`resets_at` and `updated_at_epoch` are Unix seconds. A window with `null` usage is hidden. A file older than 10 minutes shows as `stale`. The current session's own quota comes from Claude Code, not from these files.

### Steward section

With the steward-orchestration plugin, the pane reads its registry at `~/.claude/orchestration/initiatives.md`, or in `$STEWARD_ORCHESTRATION_DIR` when set. If this session's id is listed as a primary or a secondary, the pane shows the role, the initiative, the other sessions with their state, and the age of the decision log.

## Commands

- `/stackwell`: open the pane.
- `/stackwell off` and `/stackwell on`: close it and keep it closed, or open it again.
- `/stackwell tools`: open or close the tools list.
- `/stackwell theme <name>`: pick a theme for this machine. This overrides the `theme` option.

The pane redraws only when something happens, plus once a minute while it is open.

## Licence

MIT. See [LICENSE](LICENSE).
