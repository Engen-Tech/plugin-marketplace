#!/usr/bin/env python3
"""steward-prose-gate hook script.

Called as `prose_gate_hook.py <harness> <mode>`. Reads one JSON object
from stdin and prints at most one JSON object to stdout. Stdlib only,
python3.9+.

Harnesses: claude, copilot, codex and pi. Modes: pr-gate (PreToolUse on
Bash: deny a `gh pr create|edit` whose body has AI tells) and prose-gate
(Stop: block a reply that has AI tells). Copilot also has session-start,
which records the main session and prints nothing; Copilot sends no
agent_id, so its gates run only for a recorded main session. Codex
children share the parent's session_id, so its gates run for every
call, and its prose gate reads only last_assistant_message, never a
transcript. The pi extension registers nothing in a pi-subagents child
and sends last_assistant_message itself.

This script must never raise to whoever called it. Any error, bad
input, unknown harness or mode, or missing file means: exit 0, no
output. Fail open, always.
"""

import json
import os
import re
import sys
import time
from pathlib import Path

PLUGIN_DIR_NAME = "steward-prose-gate"

# ---------------------------------------------------------------------------
# Directories and paths
# ---------------------------------------------------------------------------


def get_config_dir(harness, env):
    """Where the harness keeps its config. Claude Code: $CLAUDE_CONFIG_DIR
    or ~/.claude. Copilot: $COPILOT_HOME or ~/.copilot. Codex:
    $CODEX_HOME or ~/.codex. pi: $PI_CODING_AGENT_DIR or ~/.pi/agent."""
    home = env.get("HOME") or os.path.expanduser("~")
    if harness == "pi":
        value = env.get("PI_CODING_AGENT_DIR")
        if value:
            return _expand_user(value, env)
        return os.path.join(home, ".pi", "agent")
    if harness in ("copilot", "codex"):
        value = env.get(harness.upper() + "_HOME")
        if value:
            return _expand_user(value, env)
        return os.path.join(home, "." + harness)
    value = env.get("CLAUDE_CONFIG_DIR")
    if value:
        return value
    return os.path.join(home, ".claude")


def get_state_dir(env):
    """Where this plugin keeps per-session state."""
    value = env.get("XDG_STATE_HOME")
    if value:
        return os.path.join(value, PLUGIN_DIR_NAME)
    home = env.get("HOME") or os.path.expanduser("~")
    return os.path.join(home, ".local", "state", PLUGIN_DIR_NAME)


def get_plugin_root():
    """Root of this plugin: two directories up from this script (hooks/ is
    one level under the root)."""
    return str(Path(__file__).resolve().parent.parent)


def _expand_user(path, env):
    """Expand a leading ~ using the env dict we were given, not os.environ."""
    if not path:
        return path
    if path == "~":
        return env.get("HOME") or os.path.expanduser("~")
    if path.startswith("~/") or path.startswith("~\\"):
        home = env.get("HOME") or os.path.expanduser("~")
        return os.path.join(home, path[2:])
    return path


def _non_empty_str(value):
    return isinstance(value, str) and value != ""


# ---------------------------------------------------------------------------
# Copilot main-session record
# ---------------------------------------------------------------------------

# A session id is used as a filename. Keep only safe characters so a
# crafted session id can never point outside the state directory.
_SESSION_ID_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_.-]")
_MAX_SESSION_ID_LEN = 200


def _sanitize_session_id(session_id):
    cleaned = _SESSION_ID_UNSAFE_RE.sub("_", session_id)
    return cleaned[:_MAX_SESSION_ID_LEN]


def _copilot_main_dir(env):
    return os.path.join(get_state_dir(env), "copilot-main")


def _record_copilot_main_session(env, session_id):
    if not _non_empty_str(session_id):
        return
    directory = _copilot_main_dir(env)
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, _sanitize_session_id(session_id))
    with open(path, "a", encoding="utf-8"):
        pass


def _is_copilot_main_session(env, session_id):
    if not _non_empty_str(session_id):
        return False
    path = os.path.join(_copilot_main_dir(env), _sanitize_session_id(session_id))
    return os.path.isfile(path)


def _skip_session(harness, payload, env):
    """True when this call is not the main session's. Claude Code marks a
    subagent with agent_id. Copilot sends no agent_id; a subagent's calls
    carry its own session_id, which session-start never recorded. Codex
    children share the parent's session_id, so no Codex call is skipped.
    pi never sends agent_id: its extension does not run in a child."""
    if harness == "codex":
        return False
    if _non_empty_str(payload.get("agent_id")):
        return True
    if harness == "copilot":
        return not _is_copilot_main_session(env, payload.get("session_id"))
    return False


def cmd_session_start(harness, payload, env):
    """Copilot SessionStart: record the main session. Prints nothing."""
    try:
        _record_copilot_main_session(env, payload.get("session_id"))
    except OSError:
        pass
    return None


# ---------------------------------------------------------------------------
# The on/off switch (file first, then env, then default on)
# ---------------------------------------------------------------------------

_SWITCH_VALUES = ("on", "off")


def _read_switch_file(config_dir):
    path = os.path.join(config_dir, PLUGIN_DIR_NAME, "gate")
    try:
        with open(path, "r", encoding="utf-8") as f:
            value = f.read().strip().lower()
    except OSError:
        return None
    if value in _SWITCH_VALUES:
        return value
    return None


def gate_is_on(harness, env):
    """One switch covers both gates. Read on every call."""
    file_value = _read_switch_file(get_config_dir(harness, env))
    if file_value:
        return file_value == "on"
    env_value = (env.get("STEWARD_PROSE_GATE") or "").strip().lower()
    if env_value in _SWITCH_VALUES:
        return env_value == "on"
    return True


# ---------------------------------------------------------------------------
# AI-tell markers, shared by the PR gate and the prose gate
# ---------------------------------------------------------------------------


def load_markers(path):
    """The AI-tell word list: one literal marker per line, # comments and
    blank lines skipped, whitespace trimmed. A missing or unreadable file
    means no markers."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        return []
    markers = []
    for line in lines:
        marker = line.strip()
        if marker and not marker.startswith("#"):
            markers.append(marker)
    return markers


def _compile_marker(marker):
    pattern = r"\b" + re.escape(marker)
    last = marker[-1]
    if last.isalnum() or last == "_":
        pattern += r"\b"
    return re.compile(pattern, re.IGNORECASE)


_MARKER_PATTERNS = [
    (m, _compile_marker(m))
    for m in load_markers(os.path.join(get_plugin_root(), "data", "ai-tells.txt"))
]


def load_operator_patterns(config_dir):
    """The operator's own banned phrases, from
    <config>/steward-prose-gate/prose-patterns: one case-insensitive
    regular expression per line, # starts a comment, blank lines are
    skipped, and a line that does not compile is ignored. ^ and $ match at
    line boundaries. A missing file means no patterns."""
    path = os.path.join(config_dir, PLUGIN_DIR_NAME, "prose-patterns")
    try:
        with open(path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    patterns = []
    for line in lines:
        source = line.strip()
        if not source or source.startswith("#"):
            continue
        try:
            patterns.append(re.compile(source, re.IGNORECASE | re.MULTILINE))
        except re.error:
            continue
    return patterns


def find_operator_hits(text, patterns):
    """The matched text of every operator pattern that hits, in file order.
    Unlike the built-in markers, a single hit is enough to block."""
    hits = []
    for pattern in patterns:
        m = pattern.search(text)
        if m:
            found = " ".join(m.group(0).split()) or pattern.pattern
            if found not in hits:
                hits.append(found)
    return hits


def find_markers(text):
    """Returns (total hit count, list of distinct markers that hit)."""
    hits = 0
    names = []
    for name, pattern in _MARKER_PATTERNS:
        count = len(pattern.findall(text))
        if count:
            hits += count
            names.append(name)
    return hits, names


# ---------------------------------------------------------------------------
# Text cleaning: code, URLs and paths are not prose
# ---------------------------------------------------------------------------

_FENCED_CODE_RE = re.compile(r"```.*?```", re.DOTALL)
# A fence with no closing ``` strips from the fence to the end of the
# text, rather than leaving everything after it unstripped.
_UNTERMINATED_FENCE_RE = re.compile(r"```.*\Z", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`]*`")
_URL_RE = re.compile(r"https?://\S+")

# A whole token that is a file path or a bare domain/filename: contains a
# "/", or is dot-separated segments with no slash (like "x.py" or
# "example.com"). Dropped before marker matching so a marker word that
# is only part of a path (like "landscape" in "/src/landscape/x.py")
# does not count as prose.
_PATH_LIKE_TOKEN_RE = re.compile(
    r"(?<!\S)(?:[\w.-]*/[\w./-]*|[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)(?!\S)"
)


def _clean_text(text):
    text = _FENCED_CODE_RE.sub(" ", text)
    text = _UNTERMINATED_FENCE_RE.sub(" ", text)
    text = _INLINE_CODE_RE.sub(" ", text)
    text = _URL_RE.sub(" ", text)
    text = _PATH_LIKE_TOKEN_RE.sub(" ", text)
    return text


# ---------------------------------------------------------------------------
# pr-gate: the "gh pr create|edit" PR-body check
# ---------------------------------------------------------------------------

_BASH_TOOLS = ("Bash", "bash")
_GH_PR_CREATE_EDIT_RE = re.compile(r"\bgh\s+pr\s+(create|edit)\b")
_BODY_FILE_RE = re.compile(r"(?:--body-file|-F)\s+(\S+)")

PR_OPERATOR_MSG_TEMPLATE = (
    "steward PR gate: the PR body contains phrases the operator bans: "
    "{phrases}. Redraft it from the branch's diff with the plainlanguage "
    "skill, show the operator, then retry."
)

PR_MARKER_MSG_TEMPLATE = (
    "steward PR gate: the PR body contains these AI tells: {markers}. "
    "Redraft it from the branch's diff with the plainlanguage skill, show "
    "the operator, then retry."
)


def _resolve_against_cwd(path, cwd):
    if os.path.isabs(path):
        return path
    base = cwd or os.getcwd()
    return os.path.join(base, path)


def _read_text_file(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read()
    except OSError:
        return ""


def pr_gate_violation(command, cwd=None, operator_patterns=()):
    """None if fine, else the deny reason string. When the command passes
    the PR body as a file (--body-file or -F), that file's text is
    checked too, not just the command line itself."""
    if not _GH_PR_CREATE_EDIT_RE.search(command):
        return None
    combined = command
    m = _BODY_FILE_RE.search(command)
    if m:
        body_path = _resolve_against_cwd(m.group(1).strip("'\""), cwd)
        combined = combined + "\n" + _read_text_file(body_path)
    cleaned = _clean_text(combined)
    _hits, names = find_markers(cleaned)
    if len(names) >= 2:
        return PR_MARKER_MSG_TEMPLATE.format(markers=", ".join(names))
    phrases = find_operator_hits(cleaned, operator_patterns)
    if phrases:
        return PR_OPERATOR_MSG_TEMPLATE.format(phrases=", ".join(phrases))
    return None


def cmd_pr_gate(harness, payload, env):
    if _skip_session(harness, payload, env):
        return None
    if not gate_is_on(harness, env):
        return None

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        tool_input = {}
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = None

    if tool_name in _BASH_TOOLS:
        command = tool_input.get("command")
        if not isinstance(command, str):
            command = ""
        violation = pr_gate_violation(
            command, cwd, load_operator_patterns(get_config_dir(harness, env)))
        if violation:
            return json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": violation,
                }
            })
    return None


# ---------------------------------------------------------------------------
# prose-gate: the Stop-hook reply check
# ---------------------------------------------------------------------------

_MAX_TAIL_BYTES = 2 * 1024 * 1024


def _read_transcript_tail(path):
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        start = max(0, size - _MAX_TAIL_BYTES)
        f.seek(start)
        data = f.read()
    text = data.decode("utf-8", errors="replace")
    if start > 0:
        idx = text.find("\n")
        if idx != -1:
            text = text[idx + 1:]
    return text


def _extract_last_assistant_text(transcript_path):
    if not transcript_path:
        return None
    path = os.path.expanduser(transcript_path)
    try:
        raw = _read_transcript_tail(path)
    except OSError:
        return None

    parsed = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            parsed.append(obj)

    last_idx = None
    for i in range(len(parsed) - 1, -1, -1):
        if parsed[i].get("type") == "assistant":
            last_idx = i
            break
    if last_idx is None:
        return None

    target_id = None
    last_msg = parsed[last_idx].get("message")
    if isinstance(last_msg, dict):
        target_id = last_msg.get("id")

    run = []
    i = last_idx
    while i >= 0 and parsed[i].get("type") == "assistant":
        run.append(parsed[i])
        i -= 1
    run.reverse()

    if target_id:
        run = [
            p for p in run
            if isinstance(p.get("message"), dict) and p["message"].get("id") == target_id
        ]

    texts = []
    for obj in run:
        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    t = item.get("text")
                    if isinstance(t, str):
                        texts.append(t)
        elif isinstance(content, str):
            texts.append(content)

    if not texts:
        return None
    return "".join(texts)


# Copilot runs the Stop hook before it has flushed the final
# assistant.message to events.jsonl. It writes a hook.start event for the
# agentStop invocation after that message, so the gate polls for it.
_COPILOT_FLUSH_POLL_SECONDS = 0.1
_COPILOT_FLUSH_LIMIT_SECONDS = 3.0
_COPILOT_STOP_MATCH_MS = 1000


def _parse_iso_ms(value):
    """Milliseconds since the epoch for an ISO 8601 string, or None."""
    if not isinstance(value, str) or not value.strip():
        return None
    from datetime import datetime, timezone
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    try:
        moment = datetime.fromisoformat(text)
    except ValueError:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return int(round(moment.timestamp() * 1000))


def _find_copilot_stop_marker(lines, session_id, stop_ms):
    """Index of the agentStop hook.start line for this stop, or None.
    Without stop_ms, only a marker after the last main user.message
    counts."""
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i].strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "user.message" and "agentId" not in event and stop_ms is None:
            return None
        if kind != "hook.start":
            continue
        data = event.get("data")
        if not isinstance(data, dict) or data.get("hookType") != "agentStop":
            continue
        hook_input = data.get("input")
        if not isinstance(hook_input, dict) or hook_input.get("sessionId") != session_id:
            continue
        if stop_ms is None:
            return i
        ms = hook_input.get("timestamp")
        if isinstance(ms, bool) or not isinstance(ms, (int, float)):
            continue
        if abs(ms - stop_ms) <= _COPILOT_STOP_MATCH_MS:
            return i
    return None


def _read_copilot_until_stop(path, session_id, stop_ms):
    """The transcript tail up to (not including) this stop's hook.start
    line, polling until it appears. Past the limit, the whole tail."""
    deadline = time.monotonic() + _COPILOT_FLUSH_LIMIT_SECONDS
    while True:
        raw = _read_transcript_tail(path)
        lines = raw.splitlines()
        idx = _find_copilot_stop_marker(lines, session_id, stop_ms)
        if idx is not None:
            return "\n".join(lines[:idx])
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return raw
        time.sleep(min(_COPILOT_FLUSH_POLL_SECONDS, remaining))


def _extract_last_copilot_text(transcript_path, session_id=None, stop_timestamp=None):
    """What the operator sees as the final answer of the last turn of a
    Copilot events.jsonl: the last non-empty main assistant.message
    content plus any task_complete summaries after the last main-agent
    user.message. Subagent events carry agentId and are skipped. None if
    no user.message boundary is in the tail that was read. With a
    session_id, first waits for the runtime to flush this stop."""
    if not transcript_path:
        return None
    path = os.path.expanduser(transcript_path)
    try:
        if _non_empty_str(session_id):
            raw = _read_copilot_until_stop(path, session_id, _parse_iso_ms(stop_timestamp))
        else:
            raw = _read_transcript_tail(path)
    except OSError:
        return None

    final_message = None
    summaries = []
    found_boundary = False
    for line in reversed(raw.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or "agentId" in event:
            continue
        kind = event.get("type")
        data = event.get("data")
        if not isinstance(data, dict):
            data = {}
        if kind == "user.message":
            found_boundary = True
            break
        if kind == "assistant.message":
            value = data.get("content")
            if final_message is None and isinstance(value, str) and value.strip():
                final_message = value
        elif kind == "session.task_complete":
            value = data.get("summary")
            if isinstance(value, str) and value.strip():
                summaries.append(value)

    if not found_boundary:
        return None
    texts = ([final_message] if final_message is not None else []) + summaries[::-1]
    if not texts:
        return None
    return "\n\n".join(texts)


PROSE_OPERATOR_MSG_TEMPLATE = (
    "steward prose gate: your last reply has {found}. The operator's rule "
    "is plain language. Revise the reply with the plainlanguage skill and "
    "send it again."
)


def cmd_prose_gate(harness, payload, env):
    # One revision per reply: a Stop that follows a block is let through.
    if payload.get("stop_hook_active") is True:
        return None
    if _skip_session(harness, payload, env):
        return None
    if not gate_is_on(harness, env):
        return None

    text = payload.get("last_assistant_message")
    # Codex transcripts are not a stable hook interface: on Codex the
    # gate reads only last_assistant_message and fails open without it.
    if harness != "codex" and not (isinstance(text, str) and text.strip()):
        transcript_path = payload.get("transcript_path")
        text = None
        if isinstance(transcript_path, str) and transcript_path:
            if harness == "copilot":
                text = _extract_last_copilot_text(
                    transcript_path,
                    session_id=payload.get("session_id"),
                    stop_timestamp=payload.get("timestamp"),
                )
            else:
                text = _extract_last_assistant_text(transcript_path)

    if not (isinstance(text, str) and text.strip()):
        return None

    cleaned = _clean_text(text)
    _hits, names = find_markers(cleaned)
    phrases = find_operator_hits(cleaned, load_operator_patterns(get_config_dir(harness, env)))

    # The threshold counts distinct markers, not raw occurrences: the
    # same marker twice is still only one kind of tell. An operator
    # phrase blocks on its own.
    if len(names) < 2 and not phrases:
        return None

    # Name only what was found, so the message never lists an empty kind.
    found = []
    if phrases:
        found.append("phrases the operator bans: " + ", ".join(phrases))
    if names:
        found.append("these AI tells: " + ", ".join(names))
    reason = PROSE_OPERATOR_MSG_TEMPLATE.format(found="; ".join(found))
    return json.dumps({"decision": "block", "reason": reason})


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

_MODES = {
    "claude": {
        "pr-gate": cmd_pr_gate,
        "prose-gate": cmd_prose_gate,
    },
    "copilot": {
        "session-start": cmd_session_start,
        "pr-gate": cmd_pr_gate,
        "prose-gate": cmd_prose_gate,
    },
    "codex": {
        "pr-gate": cmd_pr_gate,
        "prose-gate": cmd_prose_gate,
    },
    "pi": {
        "pr-gate": cmd_pr_gate,
        "prose-gate": cmd_prose_gate,
    },
}


def _dispatch(argv, stdin_text, env):
    if len(argv) < 3:
        return None
    harness, mode = argv[1], argv[2]
    handler = _MODES.get(harness, {}).get(mode)
    if handler is None:
        return None
    try:
        payload = json.loads(stdin_text) if stdin_text and stdin_text.strip() else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return handler(harness, payload, env)


def main():
    try:
        stdin_text = sys.stdin.read()
        output = _dispatch(sys.argv, stdin_text, os.environ)
        if output:
            sys.stdout.write(output)
            if not output.endswith("\n"):
                sys.stdout.write("\n")
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
