# steward-delegation

steward-delegation makes the main agent hand work to subagents instead of doing it all itself. It has three parts:

- **The delegation edict**: rules added to every main session at start. They say which kind of task goes to which subagent, and how to brief it.
- **Seven pinned profiles**: subagents with a fixed model and effort, chosen by how hard the task is. The routing table in `skills/delegating/routing.md` maps tasks to profiles.
- **The delegation gate**: the main agent may make one direct edit. A second direct edit in a row is denied until a subagent call happens in between.

It works on Claude Code, GitHub Copilot, Codex and pi.

## What it ships on each harness

| Harness | What you get |
|-|-|
| Claude Code | SessionStart edict; 7 agents; `delegating` skill with `routing.md`; delegation gate; a subagent call resets the gate's counter |
| GitHub Copilot | SessionStart edict and a note on the profiles you bound; 7 agents; Copilot edict skill; delegation gate; a subagent call resets the counter |
| Codex | SessionStart edict; Codex edict skill with `profiles.json`; `install_agents.py`. No delegation gate |
| pi | extension: edict, model plan block, `/steward-models` (`check`, `apply`, `stats`), launch log, delegation gate; 7 agents; `steward-delegating` skill |

Codex has no delegation gate because Codex subagents share the parent's session id, so a per-session edit count would count a subagent's edits against the main session.

## What else to install

The plugin declares no dependencies on any harness. Install these yourself:

- **plainlanguage** (recommended): the writing skill the edict tells the agent to use for prose it writes to you and for PR bodies. It is a separate plugin, `plainlanguage@engen-tech`; install it alongside. If it is missing, the agent applies the edict's short writing rules directly; on Claude Code, Copilot and pi it also tells you once.
- **pi-subagents** (pi only, required): pi has no subagents of its own, and the steward profiles run through this extension. Without it, the gate reminds instead of blocking, because the agent has no way to delegate.
- **steward-prose-gate** (optional): enforces the prose half of the edict by sending back replies and PR bodies that read like AI-generated text.
- **An `update-pr-summary` command** (optional): if you have one, for example `<config>/commands/update-pr-summary.md` on Claude Code, the edict uses it to draft PR bodies. If not, PR bodies are drafted from the branch's diff against its base.

## Install

The plugin installs from the Engen-Tech marketplace, [Engen-Tech/plugin-marketplace](https://github.com/Engen-Tech/plugin-marketplace). Add `plainlanguage@engen-tech` the same way if you want the writing skill.

Claude Code:

```
claude plugin marketplace add https://github.com/Engen-Tech/plugin-marketplace.git
claude plugin install steward-delegation@engen-tech --scope user
```

If you use several `CLAUDE_CONFIG_DIR` profiles, install once per profile.

GitHub Copilot:

```
copilot plugin marketplace add Engen-Tech/plugin-marketplace
copilot plugin install steward-delegation@engen-tech
```

Close running Copilot sessions before you install, remove or replace the plugin. A running session keeps the hooks of a deleted plugin folder, and Copilot then denies every edit and shell command in it.

Codex:

```
codex plugin marketplace add Engen-Tech/plugin-marketplace
codex plugin add steward-delegation@engen-tech
```

In an interactive session, review and trust the session-start hook once with `/hooks`. In `codex exec`, hooks of an untrusted plugin are skipped silently: no edict, no warning. For automation, run `codex exec --dangerously-bypass-hook-trust`. The Codex docs name that flag for vetted automation. To add the seven profiles as standalone Codex agents (`steward-<role>`), run `python3 codex/install_agents.py` from this plugin's folder; it refuses to overwrite an agent file that differs.

pi:

```
pi install npm:pi-subagents
pi install git:github.com/Engen-Tech/plugin-marketplace
```

The marketplace's root package holds the pi parts of every plugin in it. The [steward README](https://github.com/TejGandham/steward#pi) shows how to load only some of them.

For local development from a steward checkout, run Claude Code against this folder. This is not a way to install the plugin.

```
claude --plugin-dir /path/to/steward/plugins/steward-delegation
```

## Names

Claude Code and Copilot put the plugin name in front of each skill and agent:

- the skill is `steward-delegation:delegating`;
- the Claude Code profiles are `steward-delegation:coder-opus-medium`, `steward-delegation:deep-reasoner-opus-xhigh`, `steward-delegation:reviewer-sonnet-high`, `steward-delegation:researcher-sonnet-low`, `steward-delegation:writer-sonnet-medium`, `steward-delegation:mechanic-haiku-medium` and `steward-delegation:reviewer-opus-max`;
- the Copilot profiles carry role-only names, such as `steward-delegation:coder` and `steward-delegation:top-reviewer`.

If you bound Copilot profiles in `~/.copilot/settings.json` under `subagents.agents`, the keys use these names too; rename keys saved under the 0.14.2 plugin's prefix.

The plugin id is `steward-delegation@engen-tech` on Claude Code, Copilot and Codex. Names on pi (`steward.<role>`, `steward-delegating`, `/steward-models`) and Codex agent names (`steward-<role>`) did not change.

## The subagent profiles

| Profile | Model | Effort | Use for |
|-|-|-|-|
| `steward-delegation:coder-opus-medium` | Opus | medium | Implementation with a spec and tests (TDD) |
| `steward-delegation:deep-reasoner-opus-xhigh` | Opus | xhigh | Architecture, ambiguous design, security review |
| `steward-delegation:reviewer-sonnet-high` | Sonnet | high | Everyday PR and diff review |
| `steward-delegation:researcher-sonnet-low` | Sonnet | low | Read-only investigation and search |
| `steward-delegation:writer-sonnet-medium` | Sonnet | medium | Docs, PR bodies, plain-language rewrites |
| `steward-delegation:mechanic-haiku-medium` | Haiku | medium | Single lookups, rote edits, running known commands |
| `steward-delegation:reviewer-opus-max` | Opus | xhigh | Highest-stakes gap review, on request or when a deep-reasoner pass is not enough |

The profiles run on three models: Haiku 5.5, Sonnet 5.5 and Opus 5.5. The top reviewer runs Opus 5.5 at xhigh. Claude Opus never runs at max, and the profile keeps the name `reviewer-opus-max` so saved briefs still work. Fable 5.1 runs only when you ask for it by name: the edict then calls the top reviewer with a one-off model override to Fable, at the effort you name (xhigh if you name none). On Claude Code the profiles use the `haiku`, `sonnet` and `opus` aliases, and the Fable override uses the `fable` alias.

Each profile sets its own effort. Claude Code 2.1.292 and later also let a single Agent call pass an `effort` that overrides the profile's. The edict passes one only when it, a skill, or you name a level.

The full routing table and the reasoning behind it are in `skills/delegating/routing.md`. The evidence tables are in the repository at `docs/evaluations/2026-10-09-model-assignment-evidence.md`.

## The delegation gate

The gate watches direct edits on the main thread: Edit, Write, MultiEdit, NotebookEdit, and write-shaped shell commands such as a file redirect, `tee`, `sed -i`, `git commit` or `git push`, `gh pr create` or `gh pr edit`, `mv`, `cp`, `rm`, `mkdir`, `touch`, a package install, or a Python heredoc that writes a file. Read-only commands pass. Work done inside a subagent is not gated. On Claude Code a session started with `--agent` is still gated.

The gate fails open: if the hook errors or `python3` is missing, the edit goes through. The hooks call `python3`; on Windows you need a `python3` launcher on PATH.

Set the mode by writing `off`, `soft` or `hard` to the file `<config>/steward-delegation/gate`:

```
mkdir -p ~/.claude/steward-delegation && echo soft > ~/.claude/steward-delegation/gate
```

- `hard`: denies a second direct edit in a row.
- `soft`: allows it, with a reminder.
- `off`: turns the gate off.

The file is read on every call, so a change applies right away. If the file does not exist, the environment variable `STEWARD_DELEGATION_GATE` is used; it applies only at the next session start. If that is also unset, the mode is `hard`.

`<config>` depends on the harness:

| Harness | Config directory |
|-|-|
| Claude Code | `$CLAUDE_CONFIG_DIR`, else `~/.claude` |
| GitHub Copilot | `$COPILOT_HOME`, else `~/.copilot` |
| Codex | `$CODEX_HOME`, else `~/.codex` |
| pi | `$PI_CODING_AGENT_DIR`, else `~/.pi/agent` |

### Files the gate never counts

Some edits are exempt, such as `CLAUDE.md`, `AGENTS.md`, memory folders, `/tmp`, and the harness's own config directory. On Copilot only parts of `~/.copilot` are exempt (settings, agents, skills, hooks, session state and the `steward-*` folders), because Copilot app chats run inside it. To add your own, list one glob per line in `<config>/steward-delegation/allowlist`:

```
/home/me/notes/**
**/scratch/*.md
```

A shell command is exempt only when every path it writes is on the list.

## Pi

On [pi](https://pi.dev) you get the same edict, the same seven profiles and the same delegation gate. Pi has no subagents of its own. The profiles run through the community [pi-subagents](https://github.com/nicobailon/pi-subagents) extension, so you install both.

### What you need

- pi 1.0 or newer (`pi --version`).
- `python3` on your PATH. The extension runs the same hook script as the other harnesses, `hooks/delegation_hook.py`. To use another interpreter, set `STEWARD_DELEGATION_PYTHON`. If the interpreter cannot be found, the extension shows a warning, and the edict and the gate are off for that session.
- pi-subagents. Install it with `pi install npm:pi-subagents` before steward, and `pi update` keeps it current. Steward was tested live on 2026-10-25 with pi 1.4.0 and pi-subagents 0.82.1. Steward's pi-subagents mirror tests still pin 0.78.0, so two version tests fail against 0.82.1 (follow-up). pi-subagents ships new versions every few days, so if an update breaks delegation, hold it at a known version with `pi install npm:pi-subagents@0.78.0`.
- The `plainlanguage` skill, in `~/.agents/skills/plainlanguage/` or `~/.pi/agent/skills/plainlanguage/` (recommended).
- Optional: an `update-pr-summary` prompt template at `~/.pi/agent/prompts/update-pr-summary.md`. If it is there, the edict uses it to draft PR bodies.

After you install, restart pi or run `/reload` in a running session. To check the install, ask pi to "list the available subagents". You should see seven agents whose names start with `steward.`.

### How it works on pi

The pi side of this plugin has three parts:
- `pi/skills/steward-delegating/`: the edict, written for pi. The extension adds it to the system prompt of every main session.
- `pi/agents/`: the seven profiles. pi-subagents loads them as `steward.<name>`, for example `steward.coder`.
- `pi/extensions/steward-delegation/`: the extension that adds the edict and runs the gate. It passes each pi event to `hooks/delegation_hook.py`, so every harness shares one set of rules and tests.

The model delegates with pi-subagents' `subagent` tool, for example `subagent({ agent: "steward.mechanic", task: "...", async: false })`.

### Profiles on pi

Each profile ships with a default model ID and thinking level. Settings override them (recipes below), and the [model plan](#model-plan-on-pi) shows what each profile really runs on:

| Profile | Model | Thinking |
|-|-|-|
| `steward.coder` | `anthropic/claude-opus-5-5` | medium |
| `steward.deep-reasoner` | `anthropic/claude-opus-5-5` | xhigh |
| `steward.reviewer` | `anthropic/claude-sonnet-5-5` | high |
| `steward.researcher` | `anthropic/claude-sonnet-5-5` | low |
| `steward.writer` | `anthropic/claude-sonnet-5-5` | medium |
| `steward.mechanic` | `anthropic/claude-haiku-5-5` | medium |
| `steward.top-reviewer` | `anthropic/claude-opus-5-5` | xhigh |

Older names, such as `steward.coder-opus-medium`, still launch the same profile through pi-subagents aliases, and `steward.reviewer-fable-xhigh` launches `steward.top-reviewer`. Settings are different: pi-subagents reads config such as `subagents.agentOverrides` under the new name only, so rename any override keys you saved under an old name, or let `/steward-models apply` move them.

A bare `agent: "coder"`, without the `steward.` prefix, launches `steward.coder` instead of pi-subagents' builtin `worker` agent. pi-subagents lists `coder` as an alias of `worker`, but it matches an agent's own short name before it looks at aliases. To run `worker`, call it by its own name.

If you ask for Fable by name, the edict runs `steward.top-reviewer` with `model: "anthropic/claude-fable-5-1:xhigh"`. The `:xhigh` suffix sets the thinking level; it becomes the level you name, if you name one.

pi needs version 1.1.0 or later for `anthropic/claude-haiku-5-5`, and a custom provider needs its own `claude-haiku-5-5` model entry.

If you reach Claude through another provider, override the model in `~/.pi/agent/settings.json`. The thinking level stays as the profile sets it unless you override that too:

```json
{
  "subagents": {
    "agentOverrides": {
      "steward.coder": { "model": "openrouter/anthropic/claude-opus-5.5" }
    }
  }
}
```

To run some profiles on other providers, add overrides to `~/.pi/agent/settings.json`. `agentOverrides` sets a model and thinking level per profile. `agentOverridesByProvider` changes a profile only while the main thread runs on the provider you name. The providers and models below are an example; use any you have credentials for:

```json
{
  "subagents": {
    "agentOverrides": {
      "steward.coder": { "model": "ollama-cloud/deepseek-v4.1-flash", "thinking": "high" },
      "steward.researcher": { "model": "ollama-cloud/deepseek-v4.1-flash", "thinking": "high" },
      "steward.writer": { "model": "ollama-cloud/deepseek-v4.1-flash", "thinking": "high" },
      "steward.mechanic": { "model": "ollama-cloud/deepseek-v4.1-flash", "thinking": "low" },
      "steward.reviewer": { "model": "amorphic/claude-sonnet-5-5", "thinking": "high" },
      "steward.deep-reasoner": { "model": "inherit", "thinking": "xhigh" },
      "steward.top-reviewer": { "model": "amorphic/claude-opus-5-5", "thinking": "xhigh" }
    },
    "agentOverridesByProvider": {
      "amorphic": {
        "steward.reviewer": { "model": "openai-codex/gpt-6.1-sol", "thinking": "medium" }
      }
    }
  }
}
```

Here `inherit` makes the deep-reasoner run on whatever model the main thread uses, and the last block swaps the reviewer to a different model family when the main thread is on `amorphic`. Then run `/reload`, and `/subagents-models` to confirm what each profile now runs on. Use the role-only keys: overrides saved under an old name, such as `steward.coder-opus-medium`, do not apply.

A repository's committed `.pi/settings.json` overrides your user settings field by field. The steward repository's own file pins every profile to `amorphic/claude-*`, so inside it the `model` values above lose, and `/subagents-models` shows what actually applies. If you decline project trust, pi-subagents 0.77.0 and later ignores that file.

Subagents see your `AGENTS.md` files and your skills catalog. A foreground subagent does not load your pi extensions; a background one does. The delegation gate never applies inside a subagent.

### Model plan on pi

The model plan says which model and thinking level each profile should use. **The plan is not applied on its own.** Profiles launch on what pi-subagents settings (`subagents.agentOverrides`) and the profile defaults say, and the block warns where those differ from your plan. Run `/steward-models apply` to write your user plan into those settings. Run it again after you edit the plan, or after `/subagents-load-profile` replaced the mapping.

**What `apply` does**
- It reads your user plan only (`~/.pi/agent/steward-delegation/model-plan.json`). A repo's plan file, its `.pi/settings.json` and its provider lists play no part, because user settings apply in every repo. To keep a repo off a provider, pin its profiles in that repo's `.pi/settings.json`.
- It first shows every change, old value to new, and the files it will write, then asks. Without a UI (print mode) it only shows the changes; `/steward-models apply --yes` writes them.
- It writes only the `model` and `thinking` of the `steward.*` entries in `subagents.agentOverrides` and `subagents.agentOverridesByProvider` in `~/.pi/agent/settings.json`. Everything else stays, including other agents' entries and fields such as `machine`. Entries under old profile names, such as `steward.coder-opus-medium`, move to the new names.
- Each profile gets the first model in its list that pi has credentials for. `main` becomes `inherit`. A profile with no usable model is left as it is, and the report says so. Profiles and fields your plan does not name are left as they are, with one exception: for a profile your plan names, apply removes `model` and `thinking` from its `agentOverridesByProvider` entry for any provider the plan no longer lists under `byMainProvider`. Otherwise those old values would still win when the main thread is on that provider. Other fields in that entry, such as `fast`, `disabled` or `machine`, stay. An entry left empty is removed, and the provider's object stays, as `{}` if nothing else is in it. A profile with no usable model keeps its provider entries too. A provider entry apply writes always carries `thinking`, so an old level there cannot win either.
- Before writing it saves a copy, `settings.json.bak-<date>-<time>`. It refuses, and writes nothing, when the plan has an error, the settings file is not valid JSON (a number too large to store, such as `1e400`, counts as invalid), or the plan, the settings file or the profile changed after the preview. A run with nothing to change writes nothing.
- It also writes the pi-subagents profile `~/.pi/agent/profiles/pi-subagents/steward.json` with the whole mapping, other agents' entries included. `/subagents-load-profile steward` restores it. Loading it resets every agent override, steward or not, to what it was at the last apply, so a change you made to another agent since then is lost. An entry the profile format does not allow, such as `"model": false` (settings accept it, profiles do not), is left out of the profile, and the report says so.
- `/subagents-check-profile steward` tests each model with a short live call. A profile set to `inherit` (the deep-reasoner in the example plan) shows as a failure there, because `inherit` is not a model name. That failure is expected. It does not test the models under `agentOverridesByProvider`; `/steward-models check` reports those. Run it interactively or in print mode (`pi -p "/subagents-check-profile steward"`). In RPC mode it does not hang, but it returns its result only as a custom message, with no prompt response and no `agent_end`, so an RPC client that waits for either times out (checked 2026-10-12).
- If the settings file is written but the profile is not (a full disk, say), the report says so and lists the backups it made (one for each file that existed before), and pi still reloads. Run `/steward-models apply` again before you load the steward profile.
- Then it reloads pi and shows a fresh check.
- `/steward-models` prints its report to stdout in print mode (`pi -p "/steward-models check"`). In JSON and RPC mode the report arrives as an `entry_appended` event; in RPC mode it is also sent as a notification. In the terminal UI it is shown in the transcript and never sent to the model.

You write which model and thinking level each profile should use, plus fallbacks and escalations. At session start, and again after you switch model or thinking level, the extension adds a "Model plan" block to the main thread's instructions. The block shows:
- what each profile really runs on;
- what to relaunch with after a provider error;
- what to escalate to after a failed check;
- which profiles are blocked.

Without a plan file the block still lists what each profile runs on.

**Where the plan lives**
- `~/.pi/agent/steward-delegation/model-plan.json`, or `$PI_CODING_AGENT_DIR/steward-delegation/model-plan.json`.
- Per repo: `.pi/steward-model-plan.json`. In a trusted repo it wins over your user plan.
- A repo's `allowProviders` and `denyProviders` are read even when you decline project trust. If a list cannot be read, every profile is marked blocked.

**The provider lists do not stop a launch.** `allowProviders` and `denyProviders` change only what the block tells the main thread about the `steward.*` profiles and what `/steward-models check` reports. pi-subagents still launches whatever its settings say, and other agents, such as its builtin `worker` and `scout`, are not checked at all. To actually stop a launch on a provider, set an enforced, strict `subagents.modelScope` in pi-subagents settings; in an untrusted project pi-subagents ignores the project's copy of that setting.

A small plan:

```json
{
  "version": 1,
  "roles": {
    "*": {
      "model": "anthropic/claude-sonnet-5-5",
      "thinking": "medium",
      "fallback": ["openrouter/anthropic/claude-sonnet-5.5"],
      "escalate": "main:high"
    },
    "reviewer": {
      "thinking": "high",
      "escalate": "role:deep-reasoner"
    },
    "deep-reasoner": {
      "model": "anthropic/claude-opus-5-5",
      "thinking": "xhigh",
      "fallback": null,
      "escalate": null
    },
    "top-reviewer": {
      "model": "anthropic/claude-opus-5-5",
      "thinking": "xhigh",
      "fallback": null,
      "escalate": null
    }
  }
}
```

Every role inherits the `"*"` entry. The reviewer escalates to the `steward.deep-reasoner` profile, which keeps its own model and thinking. Deep-reasoner and top-reviewer clear both the fallback and the escalation: a judgment role should never drop to the Sonnet fallback in `"*"`, and a failed check there stays on the main thread. The repository's `docs/roadmap/pi-model-plan.md` describes every field.

**How the main thread uses the block**
- It passes `model` only to relaunch after a provider error, to escalate after a failed check, or when you ask. Fable by name still works.
- A row that says "pass model X" gets `model: "X"` on every launch.
- If there is no relaunch model, it never picks one itself. After an overload, rate-limit or timeout error it retries the same profile once without `model`; otherwise it does small or read-only work itself or tells you.
- A relaunch, escalation or "pass model" string that an enforced `subagents.modelScope` or `subagents.maxThinking` would refuse is shown as `none`; the full report says why.
- It never launches a blocked profile.
- When every profile is marked below the judgment floor, judgment work stays on the main thread. `not checked` sets no floor.

**The seven guardrails** the edict states:
1. Judgment floor: architecture, plans, security review and final synthesis go only to a profile marked judgment-grade `yes`, or stay on the main thread when every profile is `no`. With `not checked` or no block, the routing table decides.
2. Cheap models get bounded tasks with a done-condition that a test, type check, lint or command can prove.
3. One failed check gets one relaunch on the escalation model. With no escalation model, or after a second failure, the work goes to the main thread or `steward.deep-reasoner`.
4. Fallback is not escalation: a provider error gets one relaunch, on the block's relaunch model when there is one, and never on a model the block does not name.
5. Cross-family review: a child's output is reviewed by a profile from another model family when the block shows one; otherwise by the routing table's reviewer.
6. Respect provider caps: never more children at once on a provider than its stated cap.
7. Thinking where it pays: the main thread never raises a cheap role's thinking per call; high thinking belongs to the main thread and the judgment roles.

**How the main thread delegates.** For independent children it uses the built-in `parallel` workflow. For dependent steps it makes separate `subagent` calls, one after another. It uses a workflow script only as a file path. A script written in the reply never reaches pi-subagents on pi 1.1.0 with pi-subagents 0.77.0, so the edict does not use that form.

**Checking and debugging.** `/steward-models check` prints the full report on screen. It does not go into the model's context. To debug the hook, start pi with `STEWARD_DELEGATION_HOOK_LOG=<file>`. Each session-start, `model-plan` and `model-plan-apply` hook call then appends one JSON line to that file, holding the full payload and the hook's reply. The session-start payload includes pi's whole model catalog (a few hundred KB with many providers) and your working directory, once per session start and per model or thinking switch. Gate calls are never logged, because they carry your commands, file contents and replies. Delete the file when you are done.

### Launch log and stats on pi

The extension writes one JSON line for each finished `steward.*` launch to `$XDG_STATE_HOME/steward-delegation/pi-delegations.jsonl` (by default `~/.local/state/steward-delegation/pi-delegations.jsonl`). Only the main session writes it; subagent sessions do not. A failed write is ignored and never affects the session. The file is mode 0600 in a 0700 directory, because it holds working directories and session ids; a looser file or directory is tightened on the next write. Above 5 MB the file is renamed to `pi-delegations.jsonl.<UTC time>-<pid>` and a new file starts. Each rotation gets its own name, so two sessions rotating at the same moment never overwrite each other's file (the second one moves a small, fresh file aside). Only the two newest rotated files are kept.

**What each line holds:** time, session id, the directory the child ran in (`cwd`) and the session's directory (`sessionCwd`), profile, run id, the `model` the launch passed (if any), the model and thinking level it ran on, `ok` or `error`, whether the error looks like a provider error or something else (judged from pi-subagents' own error field only: an HTTP 408, 429 or 5xx status at the start of an error line, or a phrase such as rate limit, overloaded, timed out or ECONNRESET; never from the child's output), duration, and how it ran (`sync`, `async` or `workflow-child`). `kind` says why it ran on that model: `relaunch` and `escalation` when the passed model is exactly the block's relaunch or escalation model for that profile, `operator` for any other passed model, `plain` when none was passed.

Lines are `v: 2`. The directory decides which repo pins apply, so `cwd` is where the child ran, not where the session ran: the directory pi-subagents reports for an async run or workflow, else the launch's `cwd` (a per-item `cwd` in `tasks` or `chain` resolved against the top-level one, a relative one against the session's directory), else the session's directory. For an async `tasks` or `chain` run, an item with its own `cwd` logs that directory resolved against the reported one, since pi-subagents reports only the top-level directory; a parallel group inside a chain counts one row per task. A launch with `machine` runs on that machine, and its `cwd` is a directory there, so the line logs the session's directory as `cwd` and the machine name in `remote` (null for local runs). Both directory fields are capped at 4096 characters with control characters removed. Older `v: 1` lines have no `sessionCwd`, and their `cwd` is always the session's directory; `/steward-models stats` reads both.

**What is never logged:** the task text, the child's output, error messages, and file contents.

A sync launch is logged when its result comes back, an async launch when it finishes, a launch with top-level `tasks` or `chain` once per child, and each child of a workflow (the built-in `parallel` or a script) when the workflow finishes. Workflow children always log `plain`: the workflow's completion does not say which model a script passed to a child. A run that is detached, paused after an interrupt, or stopped without an error is not logged when its tool result comes back; it is logged once when it really finishes. `kind` for an async or detached run is decided at launch, from the relaunch and escalation models current then. That launch record lives in memory only: if you `/reload` before the run finishes, its line is still written but logs `kind: plain` with no passed model.

**Reading it.** `/steward-models stats` reads the live file only, not the rotated ones, and summarizes the last 7 days; `/steward-models stats --days 30` a longer window. For each profile and model it shows launches, successes, errors (provider and other), success rate, median and 90th-percentile duration, relaunches and escalations. Lines it cannot read are skipped and counted at the end. The output goes where `check` output goes. A low success rate on a cheap model is the signal to move that profile up; many provider errors point at the provider, not the model.

**Deleting it.** `rm ~/.local/state/steward-delegation/pi-delegations.jsonl*` (or the same name under your `XDG_STATE_HOME`). The next launch starts a new file.

### Gates on pi

The delegation gate behaves as described in [The delegation gate](#the-delegation-gate), with these differences:
- It watches pi's `edit` and `write` tools and write-shaped `bash` commands. A `subagent` call resets it once pi-subagents accepts the launch. A call that fails, or one such as `subagent({ action: "list" })` that starts no work, does not.
- If pi-subagents is not loaded, or it is loaded but neither `subagent` nor `subagents_enable` is active in the current session, the model has no way to delegate, so the gate reminds instead of blocking. The note it adds says which case applies.
- Edits to `AGENTS.md` and to anything under a `.pi/` directory are exempt, as `CLAUDE.md` and `.claude/` are on Claude Code.
- The gate mode file is `~/.pi/agent/steward-delegation/gate` (or `$PI_CODING_AGENT_DIR/steward-delegation/gate`):

```
mkdir -p ~/.pi/agent/steward-delegation && echo soft > ~/.pi/agent/steward-delegation/gate
```

Some turns start without a prompt from you, for example when a background subagent finishes. Pi builds those turns without the usual system prompt additions, so the extension adds the edict to that turn's messages instead. Nothing extra is saved in the session.

### Optional: show the subagent tool from the start

On some models pi-subagents first offers a small `subagents_enable` tool and adds `subagent` only after the model calls it. The edict tells the model to do that. To skip the step, create `~/.pi/agent/extensions/subagent/config.json` with:

```json
{ "toolActivation": "eager" }
```

Eager mode plus `/reload` is also how a conversation that started before pi-subagents was installed gets the tool. Pi restores a conversation's recorded tools when it resumes, so restarting pi and resuming that conversation does not add it; starting a new session does.

### Developing for pi

Load your checkout instead of the published package:

```
pi install /path/to/steward
```

A local path install reads the files in place, so edits apply on the next pi start or `/reload`.

## GitHub Copilot

On GitHub Copilot you get the same edict, the same seven profiles and the same delegation gate. The Copilot cloud agent is not covered. You need `python3` on your PATH, and the `plainlanguage` skill in `~/.agents/skills/plainlanguage/` or `~/.copilot/skills/plainlanguage/` (recommended).

### How the edict gets in

A SessionStart hook adds the Copilot edict as session context at the start of every main session. Copilot reads `.github/plugin/plugin.json` in this folder, so it gets the Copilot files: `copilot/agents/`, `copilot/skills/delegating/`, and `copilot/hooks.json`.

### Profiles and models on Copilot

The Copilot profiles carry role-only names. Each profile sets a reasoning effort and `include-custom-instructions: true`, so subagents read `AGENTS.md` and other instruction files:

| Profile | Model | Effort |
|-|-|-|
| `steward-delegation:coder` | Claude Opus 5.5 | medium |
| `steward-delegation:deep-reasoner` | Claude Opus 5.5 | xhigh |
| `steward-delegation:reviewer` | Claude Sonnet 5.5 | high |
| `steward-delegation:researcher` | Claude Sonnet 5.5 | low |
| `steward-delegation:writer` | Claude Sonnet 5.5 | medium |
| `steward-delegation:mechanic` | Claude Haiku 5.5 | medium |
| `steward-delegation:top-reviewer` | Claude Opus 5.5 | xhigh |

Copilot does not resolve the `opus`, `sonnet`, `haiku`, and `fable` aliases, and model IDs differ by account and provider (for example a provider-prefixed `<provider>/claude-opus-5-5`). So the Copilot profiles set only `reasoning-effort`.

Instead, the edict tells the main agent to pass two fields on every `task` call: `model`, the role's Claude model from the table above, copied from the task tool's own model list, and `reasoning_effort`, the role's level. `steward-delegation:top-reviewer` runs when you ask for the top reviewer or when a deep-reasoner pass is not enough. If you ask for Fable by name, the main agent runs the top reviewer on the Claude Fable 5.1 model from the task tool's list, at the effort you name (xhigh if you name none). If Claude Haiku 5.5 is not listed, the mechanic runs on Claude Sonnet 5.5 at `low`.

### Optional: bind a profile on your machine

To fix a profile's model and effort on one machine, add it to `~/.copilot/settings.json`. The `/subagents` picker writes the same keys.

```json
{
  "subagents": {
    "agents": {
      "steward-delegation:coder": { "model": "<id>", "effortLevel": "medium" }
    }
  }
}
```

The session-start note then lists the bound profiles, and the main agent omits `model` and `reasoning_effort` for them.

### Gates on Copilot

The delegation gate behaves as described in [The delegation gate](#the-delegation-gate), with these differences:
- The gate mode file is `~/.copilot/steward-delegation/gate` and the extra allowlist is `~/.copilot/steward-delegation/allowlist` (or the same names under `$COPILOT_HOME`).
- Subagents are not gated. Copilot does not tell a hook whether a call comes from a subagent, so the plugin records each main session when it starts and skips any other session. A session that was already running when the plugin was installed is not gated.
- These files are exempt: `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/`, `.github/agents/`, `.github/skills/`, and `.github/copilot/`. Inside `~/.copilot`, only the `steward-*` folders, `settings.json`, `settings.local.json`, `copilot-instructions.md`, `agents/`, `skills/`, `hooks/`, and `session-state/` are exempt. Copilot app chat sessions run under `~/.copilot/chats/`, and edits there are still gated.

Set the gate mode with:

```
mkdir -p ~/.copilot/steward-delegation && echo soft > ~/.copilot/steward-delegation/gate
```

## If you already have these rules in CLAUDE.md

If your `CLAUDE.md` already spells out the delegation rules, installing this plugin loads them twice: once from your `CLAUDE.md`, once from the plugin's skill. Shrink your `CLAUDE.md` section to a pointer instead:

```
# Delegation: the steward-delegation plugin
Rules and routing table come from the `steward-delegation` plugin (`steward-delegation:delegating`).
```
