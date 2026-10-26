# steward-prose-gate

steward-prose-gate stops replies and pull request text that read like AI-generated writing. It has two gates:

- **Prose gate**: when the agent finishes a reply, the gate checks the reply. If it finds two or more different AI-writing tells, or any of your own banned phrases, it sends the reply back once and asks for a revision.
- **PR-body gate**: on `gh pr create` or `gh pr edit`, the gate checks the command text, which holds the PR title and body, and the file that `--body-file` or `-F` names. If it finds two or more different tells, or any banned phrase, it denies the command.

The block messages say to revise with the plainlanguage skill, which is a separate plugin, `plainlanguage@engen-tech`. The plugin does not need that skill: if it is not installed, the agent revises the text without it.

Text in code blocks and inline code is never checked, so a banned word in backticks passes.

The gates work on Claude Code, GitHub Copilot, Codex and pi. Each one fails open: if the hook errors or `python3` is missing, the reply or command goes through. The hooks call `python3`; on Windows you need a `python3` launcher on PATH.

## Install

The plugin installs from the Engen-Tech marketplace, [Engen-Tech/plugin-marketplace](https://github.com/Engen-Tech/plugin-marketplace). It needs nothing else. It pairs well with the plainlanguage skill, and with steward-delegation if you use the delegation edict.

Claude Code:

```
claude plugin marketplace add https://github.com/Engen-Tech/plugin-marketplace.git
claude plugin install steward-prose-gate@engen-tech --scope user
```

If you use several `CLAUDE_CONFIG_DIR` profiles, install once per profile.

GitHub Copilot:

```
copilot plugin marketplace add Engen-Tech/plugin-marketplace
copilot plugin install steward-prose-gate@engen-tech
```

Close running Copilot sessions before you install, remove or replace the plugin. A running session keeps the hooks of a deleted plugin folder, and Copilot then denies every shell command in it.

Codex:

```
codex plugin marketplace add Engen-Tech/plugin-marketplace
codex plugin add steward-prose-gate@engen-tech
```

In an interactive session, review and trust the two hooks once with `/hooks`. In `codex exec`, hooks of an untrusted plugin are skipped silently: no gate, no warning. For automation, run `codex exec --dangerously-bypass-hook-trust`. The Codex docs name that flag for vetted automation.

pi: the marketplace's root package holds the pi extension, so `pi install git:github.com/Engen-Tech/plugin-marketplace` installs it. The [steward README](https://github.com/TejGandham/steward#pi) shows how to load only the prose gate.

For local development from a steward checkout, run Claude Code against this folder. This is not a way to install the plugin.

```
claude --plugin-dir /path/to/steward/plugins/steward-prose-gate
```

## Turn the gates on or off

One switch covers both gates. Write `on` or `off` to the file `<config>/steward-prose-gate/gate`:

```
mkdir -p ~/.claude/steward-prose-gate && echo off > ~/.claude/steward-prose-gate/gate
```

The file is read on every check, so a change applies right away. If the file does not exist, the environment variable `STEWARD_PROSE_GATE` (`on` or `off`) is used. If that is also unset, the gates are on.

`<config>` depends on the harness:

| Harness | Config directory |
|-|-|
| Claude Code | `$CLAUDE_CONFIG_DIR`, else `~/.claude` |
| GitHub Copilot | `$COPILOT_HOME`, else `~/.copilot` |
| Codex | `$CODEX_HOME`, else `~/.codex` |
| pi | `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` |

## Your own banned phrases

List your own rules in `<config>/steward-prose-gate/prose-patterns`, for example `~/.claude/steward-prose-gate/prose-patterns` on Claude Code or `~/.pi/agent/steward-prose-gate/prose-patterns` on pi. Each line is a case-insensitive regular expression, and a single match blocks. `^` and `$` match at the start and end of a line. Lines starting with `#` are comments, and a line that is not a valid expression is skipped.

```
# words I never want in a reply
load[- ]?bearing
\bfootguns?\b
# narrating a tool call at the start of a line
^\s*(let me|now i'?ll)\b
```

The file is read on every check, so edits apply right away. Without it, the gates use only the word list.

To share one file across harnesses, symlink it:

```
mkdir -p ~/.copilot/steward-prose-gate
ln -s ~/.claude/steward-prose-gate/prose-patterns ~/.copilot/steward-prose-gate/prose-patterns
```

## The word list

The AI-writing tells live in `data/ai-tells.txt` inside the plugin. Each line is one literal word or phrase, matched case-insensitively at word boundaries. Lines starting with `#` and blank lines are skipped. Changes to the list ship as a new release of this plugin; for your own additions, use the prose-patterns file.

## How each harness differs

- **Claude Code**: subagents are not gated. The prose gate checks the last reply Claude Code hands to the hook, or reads it from the session transcript.
- **GitHub Copilot**: Copilot does not tell a hook whether a call comes from a subagent. The plugin records each main session when it starts and gates only those, so a session that was already running when you installed the plugin is not gated. The prose gate reads Copilot's own transcript and waits up to 3 seconds for the final reply to be written.
- **Codex**: Codex cannot tell a subagent from the main session, so the PR-body gate runs for every call. The prose gate reads only the last reply Codex hands to the hook, never a transcript.
- **pi**: the extension does not load in a pi-subagents child. It runs the hook with `python3`; set `STEWARD_PROSE_GATE_PYTHON` to use another interpreter.

On every harness a revised reply is not sent back a second time.
