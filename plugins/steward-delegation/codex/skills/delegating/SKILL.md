---
name: delegating
description: Use Steward to delegate non-trivial work to seven OpenAI role profiles, select model and effort, review the results, and write clear prose. Applies when the user requests Steward or a trusted Steward startup hook loads this edict.
---

# Steward for Codex CLI and the ChatGPT desktop app

When this skill is loaded, delegate every non-trivial task to a Steward role. This skill requests subagent work. Follow higher-priority instructions, the user's task scope, and applicable repository rules. Do not delegate again inside a worker unless its brief asks for it.

The main agent gathers requirements, chooses the role, gives a self-contained brief, checks the result, and reports to the user. It may perform a single targeted lookup or a one-line mechanical edit itself. Implementation, investigation across several files, substantial prose, and substantive review belong in a worker. Separate independent tasks when concurrency helps; serialize writes to the same files. Do not create sidebar chats for workers.

## Choose a role

|Role|Model|Effort|Fallback|Use for|
|-|-|-|-|-|
|coder|`gpt-6.1-sol`|high|none|Implementation with a clear spec and a verifiable check|
|deep-reasoner|`gpt-6-astra`|xhigh|`gpt-6.1-sol` xhigh|Architecture, ambiguous design, security, subtle correctness|
|reviewer|`gpt-6.1-sol`|medium|none|Everyday diff and PR review|
|researcher|`gpt-6.1-sol`|medium|none|Read-only codebase or web investigation|
|writer|`gpt-6.1-sol`|medium|none|Docs, substantial PR bodies, prose rewrites|
|mechanic|`gpt-6-luna`|high|none|A known command, single lookup, or rote edit|
|top-reviewer|`gpt-6-astra`|max|`gpt-6.1-sol` xhigh|Highest-stakes gap review, only on explicit user request|

These are provisional task assignments based on published evidence, not measured Steward success rates. Read [profiles.json](profiles.json) for each role's brief and escalation settings. API list prices and AA cost per benchmark task do not describe ChatGPT subscription usage.

## Dispatch and collect

Use the available subagent tool, such as `spawn_agent` or `collaboration.spawn_agent`. Tool schemas vary by client. Pass the chosen `model` and `reasoning_effort` explicitly when the tool supports them. In clients with `fork_turns`, use `"none"` for a self-contained brief; a full-history fork inherits the parent's model and effort. If the tool supports a named `agent_type` and the operator installed the optional TOML profiles, use `steward-<role>`. Those files also pin both settings.

Read the chosen role's `instructions` in profiles.json and include them in the brief. Include the goal, absolute repo path, allowed files, branch/worktree rules, known facts, required checks, output format, and actions already authorized by the user. Workers inherit permissions; the brief must not expand them. Researchers and reviewers should modify nothing unless the user requested a written artifact. Preserve applicable search and attribution rules in every brief.

Wait for results through the client's subagent wait tool. Inspect the actual diff or cited evidence, run the required checks, and fix or return concrete failures to the worker. A coder that misses its check can retry on Sol at xhigh. If a mechanic needs judgment or fails its check, move the task to Sol at low effort or the appropriate stronger role. Never silently lower a model or effort because it is unavailable. Explain the limitation and choose an available configuration within the user's instructions.

Astra fallback (Operator decision, 2026-10-09): when `gpt-6-astra` is unavailable, the deep-reasoner and top-reviewer roles fall back to `gpt-6.1-sol` at xhigh, as recorded in each role's `fallback` field in profiles.json. Astra counts as unavailable when it is missing from the client's model list or a dispatch with it is rejected as unavailable. A worker that ran and produced weak results is not a reason to fall back. When you fall back, tell the user in one line, naming the role, the unavailable model, and the fallback, for example: "deep-reasoner: gpt-6-astra is unavailable, so this runs on gpt-6.1-sol at xhigh." This is the only pre-approved substitution; explain any other unavailable configuration as above. The named agents `steward-deep-reasoner` and `steward-top-reviewer` pin Astra and cannot fall back on their own. If one fails because Astra is unavailable, dispatch the same brief without that `agent_type` (or with the generic agent) and pass `model: gpt-6.1-sol` and `reasoning_effort: xhigh` explicitly. If the client does not support explicit model selection, report the limitation instead.

This port targets the local Codex runtime in the CLI and the ChatGPT desktop app (formerly the Codex app). If subagents or model overrides are unavailable in a client, disclose the limitation. Do not claim pinned execution when the tool cannot provide it. Carry out authorized work directly if delegation is unavailable.

## Write clear prose

Use the installed plainlanguage skill when available. Otherwise apply these rules directly: lead with the conclusion or requested action, use familiar words and active voice, keep each paragraph on one topic, cut filler, preserve facts and caveats, and use lists or tables where they aid comparison. Avoid canned AI phrases. Match the repository's conventions for docs and code comments.

Draft PR bodies from the final diff against the base, preserve required trailers, and use a body file or a structured argument for multiline text. Follow the user's existing authorization for publishing or messaging; this skill adds no approval step.

## Local hooks

After installation and hook trust review, local Codex loads this edict at SessionStart, checks final replies at Stop, and checks `gh pr create` / `gh pr edit` bodies in Bash calls. The hooks fail open on errors. The Stop check requests one revision and respects `stop_hook_active`.

Delegation is an instruction, not a hard edit gate on Codex. The documented PreToolUse payload shares the parent session id with workers and lacks a reliable worker identity. A parent edit counter would risk blocking workers. PR checks cover the shell commands named above, not connector PR tools.
