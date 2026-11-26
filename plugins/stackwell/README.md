# stackwell

A calm status pane for Claude Code. It sits beside the conversation and shows context use, quota, cost, the folders you work in and subagents at a glance. Text is grey by default. Muted colours mark the groups, and only warnings use strong colour.

```
Opus 5.5 (1M)                  ~/src/sample-repo

context  ~146 turns left         131k / 1M   13%
━━━━━━──────────────────────────────────────┊───
▪ msgs 79k  ▪ tools 7k  ▪ sys 3k  ▪ other 42k

quota 7d    ━━━━━━━━━━━──│──────────  44%   3d4h
acct work   5h 58%  58m   7d 8%  5d12h

steward     ★ widget-release
  ├─ docs-secondary                      busy 4m
  ├─ api-secondary                      idle 12m
  └─ log 12m ago

hatch       packs-install · wave 2/3
  ━━━━━━━━━━━━━━━━━━━━─────────────── 4/7 merged
  • install-api  • install-ui           building
  ✕ install-docs                          halted
  ready: docs-sweep 3 items

folders
  ● sample-repo    main        clean
    ../tools-lib   main        +2 −0          3m
    plugin-market  main        clean         12m
  ⎇ …/install-api  hatch/pac…  +5 −1   1h  hatch
    +2 more

agents      stw reviewer  Design…  opus 5.5 xh 1m
            Explore  survey this           3m

session     $47.04 est · 2h11m   turn 14 · 2m10s
```

## Install

```
/plugin marketplace add Engen-Tech/plugin-marketplace
/plugin install stackwell@engen-tech
```

The pane opens at the next session start. `/stackwell off` keeps it closed.

## What it shows

The sections, top to bottom: context, quota, steward, hatch, folders, agents, session.

- **context**: how full the context window is, split into messages, tool definitions, system prompt and other. `┊` marks the auto-compact point. The context row also shows about how many turns are left before auto-compact and, when there is room, the context growth per turn.
- **quota**: your rate-limit windows. `│` marks where even use over the window would be. **acct** rows show other accounts from the quota folder (see below).
- **steward**: shown only when this session is a primary or secondary in a steward-orchestration registry (see below).
- **hatch**: shown while a repo in the folders list has hatch binders in `.hatch/binders/`. A running binder (its integration branch exists) shows its wave, a bar of merged items, and the items building or halted. Binders not started yet share one line.
- **folders**: the folders this session's tool uses named, newest first after the session's own (`●`). A folder inside the session folder shows its path from there. A folder outside it shows where it is: `../name` (at most two `../`) when near, else the path from `~` or `/`, whichever is shorter. A long path loses its middle first (`~/…/src/utils`). Each row shows the branch, lines added and removed (`?N` untracked files) and when it was last touched (not on the session's own row, which is always now). `⎇` marks a worktree; `hatch` marks a hatch item worktree. System and device folders (`/dev`, `/proc`, `/sys`, `/usr`, `/bin`, `/sbin`, `/etc`, and `/tmp` unless the session folder is there) are left out. Four rows show; click `+N more` to show them all, and `show less` to go back. The choice is kept across reloads.
- **agents**: subagents that are running or finished in the last 5 minutes.
- **session**: cost estimate, cost per hour, elapsed time, the turn count, the last turn's duration and the context it added. When the row is short, the context added goes first, then cost per hour, then the duration, then the turn count.

When the pane is short, the least important rows drop first.

### Where the data comes from

Stackwell observes only: it reads the agent list and the session history after each turn, and never hooks tool calls. No hook of it sits in a call's path, so a call runs the same with the pane on or off. It hooks only `session.start`, `session.measure`, `turn.start` and `turn.complete`, plus its own `/stackwell` command and its pane's drawing. Each hook passes its event on first and returns what came back unchanged; the reads run after the hook returns, one run at a time.

| Section | Source |
|-|-|
| context, quota, session | `session.measure`, and `$.session.usage()` at session start and at each main turn end |
| folders | the tool uses in `$.session.messages()` since the last read, at each main turn end; an agent's own at its end, against its own folder; then git for the rows shown |
| agents | `$.agent.list()` at each turn start (the main loop's and each agent's), at each main turn end, on the minute tick and on the 15 s tick while it runs; an agent's own `turn.complete` ends it |
| hatch | the `.hatch/binders/` files of the folders' repos and one ref listing per repo |
| steward | the steward-orchestration registry and the peers' session files |
| accounts | the quota files |

Folders take the paths the tool uses named: Read, Edit, Write and NotebookEdit file paths; Grep and Glob paths; `cd` and `git -C` folders and absolute paths in a Bash command. A file stands for its folder; where a path does not say, a stat decides.

### Section icons

On a terminal that shows images, a small picture replaces each section's word: 2 columns wide, 1 row high, followed by a 1-column gap. The column the word used goes to the content. Later rows of a section keep a 3-column indent. The pictures are in `assets/sections/dark/` and `assets/sections/light/`, one PNG per section (`context`, `quota`, `session`, `agents`, `folders`, `steward`, `hatch`). The dark set is used on a dark background and the light set on a light one, decided by the palette's background, so a custom palette file picks the right set too. The pane reads the 14 files once at session start, never while drawing.

Each picture carries a glyph as its alt text, 2 cells with its trailing space: `◔` context, `◷` quota, `⚷` steward, `◒` hatch, `▭` folders, `◉` agents and `≣` session. Every glyph is East Asian Width N, so it takes one cell in any terminal. The steward badge on an agent row takes the steward glyph. Where a terminal cannot show images, Claude Code draws the alt text in the picture's place. With `showIcon` off, or on a surface without images, the pane shows the words as before.

The header icon is `assets/header-icon.png`, a 64 x 64 copy of the mod's icon, 4 columns wide and 2 rows high; its alt text is `◫` (U+25EB, East Asian Width N). The pane reads it once at session start. The full-size `.claude-plugin/icon.png` is only for the plugin listing.

### Agent rows

Each agent row reads `[badge] kind  description  model effort  age`, for example `coder  Fix the parser  opus 5.5 xh  2m`. The kind comes from the agent's type as `$.agent.list()` reports it: the part after the last `:`, without a trailing `-<model>-<effort>` (`steward-delegation:reviewer-opus-max` shows as `reviewer`). A kind that repeats its plugin's name loses it (`hatch:hatch-safety-auditor` shows as `safety-auditor`). An agent from a steward plugin carries the steward icon as a badge, or `stw` without images. When the row is short, the description shortens first (and goes below 6 cells), then the effort goes, then the model; the kind and the age stay.

The model shows short (`claude-opus-5-5` as `opus 5.5`) and the effort as a code: `l`, `m`, `h`, `xh` or `max` for low, medium, high, xhigh and max. Each comes from the best source that has it: the engine first (the model and effort of the agent's last request, else the ones set for it, both from `$.agent.list()`), then the profile name's suffix (`coder-opus-medium`). The profile name is only a fallback, read for the model: Claude Opus never runs at max, so `reviewer-opus-max` shows `xh`; `max` shows only where the engine reports it. A running agent picks up the engine's values at each list read and when it ends.

Hovering an agent row always opens its card: kind, plugin, model (the full id), effort (spelled out), task, start time and status. The status says `background` once the main conversation shows the Agent call ran in the background.

## Settings

Set these in `/config` or with `claude plugin configure stackwell`.

| Option | Default | What it does |
|-|-|-|
| `theme` | `auto` | `auto`, `vga`, `mocha`, `tokyo-night` or `latte`. `auto` uses the palette file if one is set, else follows Claude Code's light or dark theme. |
| `quotaDir` | `~/.claude/quota` | Folder of quota files for the `acct` rows. If the folder is missing, no rows show. |
| `sessionDirs` | this session's own `<config dir>/sessions` | Folders of Claude Code session files, for the steward peer status. For example `~/.claude/sessions`. A relative path is taken from the config folder. A `*` in a part of the path matches any folder name there. `~user/` paths are not supported. |
| `showIcon` | `true` | Draw the mod's icon in the header and the section icons, on terminals that show images. Off: the section words everywhere. |
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

With the steward-orchestration plugin, the pane reads its registry at `~/.claude/orchestration/initiatives.md`, or in `$STEWARD_ORCHESTRATION_DIR` when set. If this session's id is listed as a primary or a secondary, the pane shows the initiative (`★` when you are the primary), the other sessions, and the age of the decision log. Each peer's state (`busy 4m`, `idle 12m`, `offline`) comes from the session files in `sessionDirs`, matched by session id; when several files carry that id (after a resume), the newest wins. A peer listed without a session id is matched by name. A session file whose `pid` is no longer running reads `offline`; that check runs when the file changes and once a minute for each matched peer. They are checked every 15 seconds while the section shows.

## Commands

- `/stackwell`: open the pane.
- `/stackwell off` and `/stackwell on`: close it and keep it closed, or open it again.
- `/stackwell theme <name>`: pick a theme for this machine. This overrides the `theme` option.

The pane redraws only when something happens, plus once a minute while it is open. Git, hatch refs and quota files are read at session start, at the end of each turn and on that minute tick, never while drawing.

## Licence

MIT. See [LICENSE](LICENSE).
