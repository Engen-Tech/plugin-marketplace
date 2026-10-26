#!/usr/bin/env python3
"""steward-delegation hook script.

Called as `delegation_hook.py <harness> <mode>`. Reads one JSON object
from stdin and prints at most one JSON object to stdout. Stdlib only,
python3.9+.

Harness `claude` has three modes: session-start injects the delegating
skill, gate counts direct edits on the main thread and denies (or warns
about) the second one in a row, and delegated resets that count when a
subagent runs.

Harness `copilot` has the same three modes. session-start also records
the main session, and gate and delegated act only for a recorded main
session, since Copilot sends no agent_id for a subagent's calls.

Harness `codex` has session-start only. Codex children share the
parent's session_id, so a per-session edit counter would charge a
worker's edits to the parent: Codex gets no gate and no delegated mode.

Harness `pi` has the same three hook modes, run by the pi extension.
session-start also appends the model plan block when the payload carries
valid model_facts. pi also has three CLI modes for /steward-models:
model-plan, model-plan-apply and delegation-stats. They read JSON on
stdin and print JSON on stdout, and they are the one exception to the
rule below: bad input exits 2, a refused apply exits 3, an internal
error exits 1.

This script must never raise to whoever called it. Any error, bad
input, missing file, unknown harness or unknown mode means: exit 0, no
output. Fail open, always.
"""

import fnmatch
import json
import os
import re
import sys
import tempfile
import time
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None

# ---------------------------------------------------------------------------
# Directories and paths
# ---------------------------------------------------------------------------


def get_config_dir(env, harness="claude"):
    """Where the harness keeps its config. Claude Code: $CLAUDE_CONFIG_DIR
    or ~/.claude. Copilot: $COPILOT_HOME or ~/.copilot. Codex: $CODEX_HOME
    or ~/.codex. pi: $PI_CODING_AGENT_DIR or ~/.pi/agent."""
    home = env.get("HOME") or os.path.expanduser("~")
    if harness == "pi":
        value = env.get("PI_CODING_AGENT_DIR")
        if value:
            return _expand_user(value, env)
        return os.path.join(home, ".pi", "agent")
    if harness == "copilot":
        value = env.get("COPILOT_HOME")
        if value:
            return _expand_user(value, env)
        return os.path.join(home, ".copilot")
    if harness == "codex":
        value = env.get("CODEX_HOME")
        if value:
            return _expand_user(value, env)
        return os.path.join(home, ".codex")
    value = env.get("CLAUDE_CONFIG_DIR")
    if value:
        return value
    return os.path.join(home, ".claude")


def get_state_dir(env):
    """Where the per-session edit counters live."""
    value = env.get("XDG_STATE_HOME")
    if value:
        return os.path.join(value, "steward-delegation")
    home = env.get("HOME") or os.path.expanduser("~")
    return os.path.join(home, ".local", "state", "steward-delegation")


def get_plugin_root(env):
    """Root of the steward-delegation plugin: STEWARD_DELEGATION_ROOT (tests
    only), else two directories up from this script (hooks/ is one level
    under the root)."""
    value = env.get("STEWARD_DELEGATION_ROOT")
    if value:
        return value
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
# session-start
# ---------------------------------------------------------------------------

def strip_frontmatter(text):
    """Drop a leading YAML frontmatter block (---...---) if present."""
    if not text.startswith("---"):
        return text
    lines = text.split("\n")
    if lines[0].strip() != "---":
        return text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[i + 1:]).lstrip("\n")
    return text


def _skill_path(env, *parts):
    return os.path.join(get_plugin_root(env), *parts, "skills", "delegating", "SKILL.md")


def _read_skill_body(path):
    with open(path, "r", encoding="utf-8") as f:
        return strip_frontmatter(f.read()).strip("\n")


_EDICT_HEADER = (
    "<STEWARD>\n"
    "You run under the steward delegation edict. The full text of the "
    "steward-delegation:delegating skill follows; read it as standing "
    "instructions.\n\n"
)


def cmd_session_start(payload, env):
    skill_body = _read_skill_body(_skill_path(env))
    return json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": _EDICT_HEADER + skill_body + "\n</STEWARD>",
        }
    })


def _copilot_bound_profiles_note(config_dir):
    """One line naming the steward-delegation profiles the operator bound
    in Copilot's settings.json, or None. Any read or parse problem means
    no line."""
    try:
        with open(os.path.join(config_dir, "settings.json"), "r", encoding="utf-8") as f:
            settings = json.load(f)
        agents = settings["subagents"]["agents"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(agents, dict):
        return None
    entries = []
    for key, value in agents.items():
        if not (isinstance(key, str) and key.startswith("steward-delegation:")):
            continue
        if not isinstance(value, dict):
            value = {}
        entries.append("{k} (model {m}, effort {e})".format(
            k=key, m=value.get("model"), e=value.get("effortLevel")))
    if not entries:
        return None
    return (
        "Profiles bound in settings.json (omit model and reasoning_effort "
        "when you dispatch these): " + ", ".join(entries)
    )


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


_COPILOT_FALLBACK_EDICT = (
    "Every non-trivial task runs in a steward subagent. Dispatch it with "
    "the task tool, agent_type steward-delegation:<profile>, and pass model "
    "and reasoning_effort. Write for the operator in plain language.\n"
    "STEWARD WARNING: the steward delegating skill file was missing at "
    "{path}; this short fallback stands in for it."
)


def cmd_copilot_session_start(payload, env):
    # Best-effort and first: an unwritable state dir or a missing skill
    # file must not cost the marker or the injection.
    try:
        _record_copilot_main_session(env, payload.get("session_id"))
    except OSError:
        pass
    skill_path = _skill_path(env, "copilot")
    try:
        skill_body = _read_skill_body(skill_path)
    except OSError:
        skill_body = _COPILOT_FALLBACK_EDICT.format(path=skill_path)
    parts = [_EDICT_HEADER]
    note = _copilot_bound_profiles_note(get_config_dir(env, "copilot"))
    if note:
        parts.append(note + "\n")
    parts.append(skill_body)
    parts.append("\n</STEWARD>")
    # Copilot drops the wrapped hookSpecificOutput form at session start.
    return json.dumps({"additionalContext": "".join(parts)})


def cmd_codex_session_start(payload, env):
    # A missing skill file raises, and main() turns that into no output.
    skill_body = _read_skill_body(_skill_path(env, "codex")).strip()
    return json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": skill_body,
        }
    })


# ---------------------------------------------------------------------------
# pi session-start and the model plan
#
# Payload contract. The pi extension may add a `model_facts` key to the
# session-start payload ({"session_id", "model_facts"}). It holds exactly
# the registry facts documented in model_plan.py beside this script:
#
#   {"main": {"provider", "id", "thinkingLevel"} | null,
#    "models": [{"provider", "id", "available", "thinkingLevels"?,
#                "maxTokens"?, ...}],
#    "projectTrusted": bool, "cwd": str}
#
# With valid facts, pi session-start appends the Model plan block. Without
# the key, with malformed facts, or on any error the output is the edict
# alone. Other harnesses ignore the key.
# ---------------------------------------------------------------------------

def _hook_module(name):
    """Import a sibling module from this script's own hooks/ dir."""
    import importlib
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    return importlib.import_module(name)


def _pi_model_plan_block(payload, env):
    facts = payload.get("model_facts")
    if not isinstance(facts, dict):
        return None, None
    try:
        return _hook_module("model_plan_render").session_block_and_launches(facts, env)
    except Exception:  # session start must fail open
        return None, None


def block_launches_ok(launches):
    return isinstance(launches, dict) and bool(launches)


def cmd_pi_session_start(payload, env):
    # pi wraps the text in a <steward> system-prompt section itself, so no
    # tags here.
    skill_body = _read_skill_body(os.path.join(
        get_plugin_root(env), "pi", "skills", "steward-delegating", "SKILL.md"))
    text = (
        "You run under the steward delegation edict. The full text of "
        "the steward-delegating skill follows; read it as standing "
        "instructions.\n\n" + skill_body
    )
    block, launches = _pi_model_plan_block(payload, env)
    if block:
        text += "\n\n" + block
    output = {
        "hookEventName": "SessionStart",
        "additionalContext": text,
    }
    if block_launches_ok(launches):
        # Each profile's relaunch and escalation model strings, as data,
        # for the extension's outcome log.
        output["stewardLaunches"] = launches
    return json.dumps({"hookSpecificOutput": output})


# ---------------------------------------------------------------------------
# pi CLI modes (/steward-models). Each returns (stdout, stderr, exit code).
#
# model-plan (/steward-models check) reads {"model_facts", "cwd"}; `cwd`
# fills model_facts.cwd when that is missing. It prints {"report": "..."}
# and exits 0, findings or not. It writes no files.
#
# model-plan-apply (/steward-models apply) reads {"model_facts", "dryRun",
# "expect"?}. It writes only when "dryRun" is false and no --dry-run
# argument is given; otherwise it is a preview. stdout is the result
# object, exit 0. A refusal (nothing written) prints {"error",
# "refused": true} and exits 3.
#
# delegation-stats (/steward-models stats) reads {"days"?, "path"?, "now"?}
# and prints {"report": "..."}. It reads only the outcome log.
#
# Unusable input to any of them prints {"error": "..."}, writes the message
# to stderr and exits 2.
# ---------------------------------------------------------------------------

MODEL_PLAN_USAGE_EXIT = 2
MODEL_PLAN_REFUSED_EXIT = 3


def cmd_model_plan(stdin_text, env, argv=()):
    def fail(message):
        message = "model-plan: " + message
        return json.dumps({"error": message}), message, MODEL_PLAN_USAGE_EXIT

    try:
        payload = json.loads(stdin_text) if stdin_text and stdin_text.strip() else None
    except ValueError:
        return fail("stdin is not JSON")
    if not isinstance(payload, dict):
        return fail("stdin must be a JSON object {\"model_facts\": {...}, \"cwd\": \"...\"}")
    facts = payload.get("model_facts")
    if not isinstance(facts, dict):
        return fail("model_facts is missing or not an object")
    cwd = payload.get("cwd")
    if "cwd" not in facts and isinstance(cwd, str) and cwd:
        facts = dict(facts, cwd=cwd)
    if isinstance(facts.get("cwd"), str) and facts["cwd"] and not os.path.isabs(facts["cwd"]):
        return fail("cwd must be an absolute path, got a relative one")
    mp = _hook_module("model_plan")
    try:
        mp.validate_facts(facts)
    except ValueError as exc:
        return fail("model_facts is malformed: %s" % exc)
    render = _hook_module("model_plan_render")
    result = mp.evaluate(facts, env=env)
    return json.dumps({"report": render.render_report(result)}), "", 0


def cmd_model_plan_apply(stdin_text, env, argv=()):
    def fail(message, code=MODEL_PLAN_USAGE_EXIT, refused=False):
        message = "model-plan-apply: " + message
        body = {"error": message}
        if refused:
            body["refused"] = True
        return json.dumps(body), message, code

    try:
        payload = json.loads(stdin_text) if stdin_text and stdin_text.strip() else None
    except ValueError:
        return fail("stdin is not JSON")
    if not isinstance(payload, dict):
        return fail("stdin must be a JSON object {\"model_facts\": {...}, \"dryRun\": bool}")
    facts = payload.get("model_facts")
    if not isinstance(facts, dict):
        return fail("model_facts is missing or not an object")
    expect = payload.get("expect")
    if expect is not None and not (isinstance(expect, dict)
                                   and all(v is None or isinstance(v, str) for v in expect.values())):
        return fail("expect must be an object of file hashes")
    dry_run = "--dry-run" in argv or payload.get("dryRun") is not False
    mpa = _hook_module("model_plan_apply")
    try:
        result = mpa.apply(facts, env=env, dry_run=dry_run, expect=expect)
    except ValueError as exc:
        return fail("model_facts is malformed: %s" % exc)
    except mpa.Refused as exc:
        return fail(str(exc), MODEL_PLAN_REFUSED_EXIT, refused=True)
    result.pop("newSettings", None)
    return json.dumps(result), "", 0


def cmd_delegation_stats(stdin_text, env, argv=()):
    def fail(message):
        message = "delegation-stats: " + message
        return json.dumps({"error": message}), message, MODEL_PLAN_USAGE_EXIT

    try:
        payload = json.loads(stdin_text) if stdin_text and stdin_text.strip() else {}
    except ValueError:
        return fail("stdin is not JSON")
    if not isinstance(payload, dict):
        return fail("stdin must be a JSON object")
    stats = _hook_module("delegation_stats")
    days = payload.get("days", stats.DEFAULT_DAYS)
    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= 3650:
        return fail("days must be a whole number from 1 to 3650")
    path = payload.get("path")
    if not isinstance(path, str) or not path:
        path = stats.log_path(env)
    now = payload.get("now")
    if isinstance(now, bool) or not isinstance(now, (int, float)):
        now = time.time()
    return json.dumps({"report": stats.report(path, days, float(now))}), "", 0


# ---------------------------------------------------------------------------
# gate: bash command classification
#
# One table, one place. Add a new family by adding a (name, rule) pair.
# Each rule is a callable command -> bool ("this command writes").
# ---------------------------------------------------------------------------

def _regex_rule(pattern, flags=0):
    compiled = re.compile(pattern, flags)

    def rule(command):
        return compiled.search(command) is not None

    return rule


# Quoted spans (single or double) are masked to a single placeholder char
# before any redirect/tee/etc. rule runs, so a ">" or "|" or "tee" that is
# just part of a quoted string (an argument to awk, psql, grep, git log
# --format, and so on) is never mistaken for real shell syntax. "Q" is not
# a space, so "cat > \"my file.txt\"" still reads as a real redirect.
_QUOTED_SPAN_RE = re.compile(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"")


def _mask_quotes(command):
    return _QUOTED_SPAN_RE.sub("Q", command)


# A heredoc body (the lines between the opener and its terminator line)
# is excised before the generic rules run, so code inside it (like
# "if a > b:") is never mistaken for a real redirect. The opener's own
# line is kept, so a redirect written on that same line (as in
# "cat <<EOF > out.txt") still reads as a real redirect. The
# python-heredoc-write rule below looks at the raw, un-excised body.
_HEREDOC_BLOCK_RE = re.compile(
    r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n[ \t]*\2[ \t]*(?=\n|$)",
    re.DOTALL,
)


def _strip_one_heredoc_body(match):
    text = match.group(0)
    newline_at = text.find("\n")
    if newline_at == -1:
        return text
    return text[:newline_at] + "\nQ"


def _strip_heredoc_bodies(command):
    return _HEREDOC_BLOCK_RE.sub(_strip_one_heredoc_body, command)


def _clean_for_classification(command):
    """Quote-masked, heredoc-body-stripped text for the generic rules.
    The python-heredoc-write rule below uses the raw command instead,
    since it needs to read the real heredoc body."""
    return _mask_quotes(_strip_heredoc_bodies(command))


# Redirects that never count as a write: /dev/null targets and fd
# duplication (2>&1, 1>&2, &>/dev/null and friends). Stripped from a
# scratch copy before the generic write-redirect check runs, so the
# generic check never has to special-case them itself.
_SAFE_REDIRECT_RE = re.compile(
    r"&>\s*/dev/null"
    r"|\d*>>?\s*/dev/null"
    r"|\d+>&\d+"
)

# A real redirect to a file: single ">" not part of ">>", followed by a
# real-looking target (not another & | ; or whitespace); or a literal
# ">>" append, once the safe cases above are stripped out.
_WRITE_REDIRECT_RE = re.compile(r"(^|[^>])>(?!>)\s*[^&|;\s]")
_APPEND_RE = re.compile(r">>")


def _write_redirect_rule(command):
    cleaned = _SAFE_REDIRECT_RE.sub(" ", command)
    if _APPEND_RE.search(cleaned):
        return True
    return _WRITE_REDIRECT_RE.search(cleaned) is not None


# tee: anchored to a real command position (start of string, or right
# after a pipe/&&/;), and excludes device targets like /dev/stderr or
# /dev/null (writing there is not really a file write) as well as a
# bare input redirect with no output target at all (tee </dev/null).
_TEE_RE = re.compile(r"(^|\||&&|;)\s*tee\b(?!\s+(-\w+\s+)*(/dev/|<))")


def _tee_rule(command):
    return _TEE_RE.search(command) is not None


# git subcommands that mutate history or state, except the read-only or
# abort/undo flags that just cancel an in-progress operation.
_GIT_MUTATE_RE = re.compile(
    r"\bgit\s+(commit|push|merge|rebase|cherry-pick|am|apply)\b"
    r"(?!\s+--(abort|continue|quit|skip|check|dry-run)\b)"
)


def _git_mutate_rule(command):
    return _GIT_MUTATE_RE.search(command) is not None


# Indicators that a "python3 - <<HEREDOC" body actually writes to disk.
# A heredoc that only reads (json.load, print, and so on) is not a write.
#
# open(...) needs its own check: the mode string must be a short token
# made only of mode letters (r/w/a/x/b/t/+), otherwise a filename that
# happens to contain the letter "x" (like "f.txt") would false-match.
_OPEN_CALL_RE = re.compile(r"open\([^,)]*,\s*['\"]([rwaxbt+]{1,3})['\"]")

_PY_OTHER_WRITE_INDICATOR_RE = re.compile(
    r"\.write_text\("
    r"|\.write_bytes\("
    r"|\.write\("
    r"|\bshutil\."
    r"|\bos\.remove\("
    r"|\bos\.rename\("
    r"|\bos\.makedirs\("
    r"|\bos\.unlink\("
    r"|\.mkdir\("
)


def _has_write_mode_open(text):
    for m in _OPEN_CALL_RE.finditer(text):
        mode = m.group(1)
        if "w" in mode or "a" in mode or "x" in mode:
            return True
    return False


def _has_python_write_indicators(text):
    if _has_write_mode_open(text):
        return True
    return _PY_OTHER_WRITE_INDICATOR_RE.search(text) is not None


_PY_HEREDOC_OPENER_RE = re.compile(r"python3?\s+-\s*<<-?\s*(['\"]?)(\w+)\1")


def _python_heredoc_write_rule(command):
    m = _PY_HEREDOC_OPENER_RE.search(command)
    if not m:
        return False
    terminator = m.group(2)
    rest = command[m.end():]
    term_re = re.compile(r"^[ \t]*" + re.escape(terminator) + r"[ \t]*$", re.MULTILINE)
    tm = term_re.search(rest)
    body = rest[:tm.start()] if tm else rest
    return _has_python_write_indicators(body)


_HEREDOC_OPENER_RE = re.compile(r"<<-?\s*['\"]?\w+['\"]?")


def _heredoc_redirect_rule(command):
    if not _HEREDOC_OPENER_RE.search(command):
        return False
    return _write_redirect_rule(command)


# Each entry is (name, rule, uses_raw_text). Every rule except the
# python-heredoc one runs against the quote-masked, heredoc-stripped
# text; the python-heredoc rule needs the raw command so it can read the
# real heredoc body. Add a new family by adding one more tuple here.
BASH_WRITE_RULES = [
    ("redirect", _write_redirect_rule, False),
    ("tee", _tee_rule, False),
    ("sed-inplace", _regex_rule(r"\bsed\s+(-[a-zA-Z]*i|--in-place)"), False),
    ("perl-inplace", _regex_rule(r"\bperl\s+-[a-zA-Z]*i"), False),
    ("heredoc-redirect", _heredoc_redirect_rule, False),
    ("git-mutate", _git_mutate_rule, False),
    ("gh-pr-mutate", _regex_rule(r"\bgh\s+pr\s+(create|edit|merge)\b"), False),
    ("fs-verbs", _regex_rule(
        r"(^|&&|;|\|)\s*(mv|cp|rm|mkdir|touch|ln|chmod|chown|install)\b"
        r"|\bxargs\s+rm\b",
        re.MULTILINE,
    ), False),
    ("python-heredoc-write", _python_heredoc_write_rule, True),
    ("package-install", _regex_rule(
        r"\bnpm\s+(install|i|uninstall|update)\b"
        r"|\bpip3?\s+install\b"
        r"|\buv\s+(pip|add|remove)\b"
        r"|\bbrew\s+install\b",
        re.MULTILINE,
    ), False),
]


def classify_bash_command(command):
    """True if this Bash command is a direct write, by the rules above."""
    if not command:
        return False
    cleaned = _clean_for_classification(command)
    for _name, rule, uses_raw in BASH_WRITE_RULES:
        target = command if uses_raw else cleaned
        if rule(target):
            return True
    return False


# ---------------------------------------------------------------------------
# gate: allowlist
# ---------------------------------------------------------------------------

def default_allowlist_globs(env, harness="claude"):
    config_dir = get_config_dir(env, harness)
    home = env.get("HOME") or os.path.expanduser("~")
    harness_globs = []
    config_globs = [os.path.join(config_dir, "**")]
    if harness == "pi":
        # pi's counterparts of CLAUDE.md and a project's .claude directory.
        harness_globs = ["**/AGENTS.md", "**/.pi/**"]
    elif harness == "copilot":
        harness_globs = [
            "**/AGENTS.md",
            "**/.github/copilot-instructions.md",
            "**/.github/instructions/**",
            "**/.github/agents/**",
            "**/.github/skills/**",
            "**/.github/copilot/**",
        ]
        # Copilot chat sessions run with cwd under <config_dir>/chats/, so
        # the whole config dir would exempt every edit made in a chat.
        config_globs = [
            os.path.join(config_dir, rel) for rel in (
                "steward-*/**",
                "settings.json",
                "settings.local.json",
                "copilot-instructions.md",
                "agents/**",
                "skills/**",
                "hooks/**",
                "session-state/**",
            )
        ]
    return harness_globs + config_globs + [
        os.path.join(home, ".claude", "**"),
        os.path.join(home, ".claude-profiles", "**"),
        "**/memory/**",
        "**/CLAUDE.md",
        "**/*decisions*.md",
        "/tmp/**",
        "/private/tmp/**",
        "**/.claude/**",
    ]


def extra_allowlist_globs(config_dir):
    path = os.path.join(config_dir, "steward-delegation", "allowlist")
    try:
        with open(path, "r", encoding="utf-8") as f:
            return [line.strip() for line in f if line.strip()]
    except OSError:
        return []


def is_allowlisted(path, env, cwd=None, harness="claude"):
    """A relative path is resolved against cwd (falling back to this
    process's own cwd) before matching, so "CLAUDE.md" or "memory/x.md"
    match the same globs an absolute path would."""
    if not path:
        return False
    config_dir = get_config_dir(env, harness)
    globs = default_allowlist_globs(env, harness) + extra_allowlist_globs(config_dir)
    candidate = _expand_user(path, env)
    if not os.path.isabs(candidate):
        base = cwd or os.getcwd()
        candidate = os.path.abspath(os.path.join(base, candidate))
    for pattern in globs:
        expanded_pattern = _expand_user(pattern, env)
        if fnmatch.fnmatch(candidate, expanded_pattern):
            return True
    return False


_TOKEN_RE = re.compile(r"\S+")

# A bare filename with an extension, like "CLAUDE.md", has no "/" and no
# leading "~" or ".", but is still a path worth checking against the
# allowlist.
_BARE_FILENAME_RE = re.compile(r"^[\w.-]+\.[\w-]+$")


def _path_like_tokens(command):
    tokens = []
    for raw in _TOKEN_RE.findall(command):
        token = raw.strip("'\"")
        if not token:
            continue
        if ("/" in token or token.startswith("~") or token.startswith(".")
                or _BARE_FILENAME_RE.match(token)):
            tokens.append(token)
    return tokens


def bash_command_allowlisted(command, env, cwd=None, harness="claude"):
    """A Bash command is exempt only if every path-looking token in it is
    allowlisted, and there is at least one such token. A command that
    touches one allowlisted path and one real path still counts."""
    tokens = _path_like_tokens(command)
    if not tokens:
        return False
    return all(is_allowlisted(t, env, cwd, harness) for t in tokens)


# ---------------------------------------------------------------------------
# gate: tool classification and state
# ---------------------------------------------------------------------------

# pi's built-in edit and write tools take the target in "path".
_PI_EDIT_TOOLS = ("edit", "write")

# Claude Code names first, then pi's.
_DIRECT_EDIT_TOOLS = ("Edit", "Write", "NotebookEdit", "MultiEdit") + _PI_EDIT_TOOLS

# Claude Code calls its shell tool Bash; pi calls it bash.
_BASH_TOOLS = ("Bash", "bash")


def direct_edit_file_path(tool_name, tool_input):
    # Read only the field the tool actually writes to, so an extra argument
    # naming an allowlisted path cannot exempt a real write.
    if tool_name in _PI_EDIT_TOOLS:
        return tool_input.get("path")
    path = tool_input.get("file_path")
    if path:
        return path
    if tool_name == "NotebookEdit":
        return tool_input.get("notebook_path")
    if tool_name == "MultiEdit":
        edits = tool_input.get("edits")
        if isinstance(edits, list) and edits:
            first = edits[0]
            if isinstance(first, dict):
                return first.get("file_path")
    return None


_PATCH_PATH_RE = re.compile(
    r"^\*\*\* (?:Add File|Update File|Delete File|Move to):[ \t]*(.+?)[ \t]*$",
    re.MULTILINE,
)


def apply_patch_paths(patch):
    """Every target path named in a Copilot apply_patch string."""
    return [p for p in _PATCH_PATH_RE.findall(patch) if p]


def _classify_copilot_edit(tool_input, env, cwd):
    """Copilot's Edit and Write: an apply_patch call passes the patch as a
    bare string; the create and edit tools pass a dict with the target in
    "path"."""
    if isinstance(tool_input, str):
        paths = apply_patch_paths(tool_input)
        if not paths:
            return True, False
        return True, all(is_allowlisted(p, env, cwd, "copilot") for p in paths)
    if not isinstance(tool_input, dict):
        return True, False
    path = tool_input.get("path") or tool_input.get("file_path")
    if not path:
        return True, False
    return True, is_allowlisted(path, env, cwd, "copilot")


def classify_tool_call(tool_name, tool_input, env, cwd=None, harness="claude"):
    """Returns (is_direct_edit, is_allowlisted)."""
    if harness == "copilot" and tool_name in ("Edit", "Write"):
        return _classify_copilot_edit(tool_input, env, cwd)
    if not isinstance(tool_input, dict):
        tool_input = {}
    if tool_name in _DIRECT_EDIT_TOOLS:
        path = direct_edit_file_path(tool_name, tool_input)
        if not path:
            return True, False
        return True, is_allowlisted(path, env, cwd, harness)
    if tool_name in _BASH_TOOLS:
        command = tool_input.get("command")
        if not isinstance(command, str):
            command = ""
        if not classify_bash_command(command):
            return False, False
        return True, bash_command_allowlisted(command, env, cwd, harness)
    return False, False


# A session id is used as a filename. Keep only safe characters so a
# crafted session id can never point outside the state directory.
_SESSION_ID_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_.-]")
_MAX_SESSION_ID_LEN = 200


def _sanitize_session_id(session_id):
    cleaned = _SESSION_ID_UNSAFE_RE.sub("_", session_id)
    return cleaned[:_MAX_SESSION_ID_LEN]


def _state_path(state_dir, session_id):
    return os.path.join(state_dir, _sanitize_session_id(session_id) + ".json")


def _atomic_write_json(path, data):
    """Write via a temp file plus os.replace, so a reader never sees a
    half-written file."""
    directory = os.path.dirname(path) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".steward-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _acquire_state_lock(path):
    """An advisory lock on a sidecar file, POSIX only. Returns None (no
    lock) on any platform or error where locking is not available; the
    caller then just falls back to unlocked read-modify-write."""
    if fcntl is None:
        return None
    lock_path = path + ".lock"
    try:
        lock_file = open(lock_path, "a+")
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        return lock_file
    except OSError:
        return None


def _release_state_lock(lock_file):
    if lock_file is None:
        return
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass
    try:
        lock_file.close()
    except OSError:
        pass


def _bump_counter(state_dir, session_id):
    os.makedirs(state_dir, exist_ok=True)
    path = _state_path(state_dir, session_id)
    lock_file = _acquire_state_lock(path)
    try:
        now = time.time()
        count = 0
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            count = int(data.get("count", 0))
            last = float(data.get("last", 0))
            if now - last > 600:
                count = 0
        except (OSError, ValueError, TypeError):
            count = 0
        count += 1
        _atomic_write_json(path, {"count": count, "last": now})
        return count
    finally:
        _release_state_lock(lock_file)


def _reset_counter(state_dir, session_id):
    os.makedirs(state_dir, exist_ok=True)
    path = _state_path(state_dir, session_id)
    lock_file = _acquire_state_lock(path)
    try:
        _atomic_write_json(path, {"count": 0, "last": time.time()})
    finally:
        _release_state_lock(lock_file)


# ---------------------------------------------------------------------------
# gate: runtime mode (file first, then env, then default hard)
# ---------------------------------------------------------------------------

_VALID_MODES = ("off", "soft", "hard")


def _gate_mode_path(config_dir):
    return os.path.join(config_dir, "steward-delegation", "gate")


def _read_gate_mode_file(config_dir):
    try:
        with open(_gate_mode_path(config_dir), "r", encoding="utf-8") as f:
            value = f.read().strip().lower()
    except OSError:
        return None
    if value in _VALID_MODES:
        return value
    return None


def get_gate_mode(env, harness="claude"):
    config_dir = get_config_dir(env, harness)
    file_mode = _read_gate_mode_file(config_dir)
    if file_mode:
        return file_mode
    env_mode = (env.get("STEWARD_DELEGATION_GATE") or "").strip().lower()
    if env_mode in _VALID_MODES:
        return env_mode
    return "hard"


def gate_message(count, config_dir, harness="claude"):
    # The pi extension matches the "steward delegation gate" prefix.
    if harness == "copilot":
        return (
            "steward delegation gate: this is direct edit #{n} on the main "
            "thread with no subagent call in between. The edict says every "
            "non-trivial task runs in a subagent. Delegate it with the task "
            "tool (agent_type steward-delegation:coder for code, "
            "steward-delegation:mechanic for rote edits), or ask the "
            "operator to set the gate to soft or off by writing that word "
            "to {gate_path} (takes effect immediately; "
            "STEWARD_DELEGATION_GATE only applies at next start)."
        ).format(n=count, gate_path=_gate_mode_path(config_dir))
    if harness == "pi":
        return (
            "steward delegation gate: this is direct edit #{n} on the main "
            "thread with no subagent call in between. The edict says every "
            "non-trivial task runs in a subagent. Delegate it with the "
            "subagent tool (agent steward.coder for code, "
            "steward.mechanic for rote edits), or ask the operator "
            "to set the gate to soft or off by writing that word to "
            "{gate_path} (takes effect immediately; "
            "STEWARD_DELEGATION_GATE only applies at next start)."
        ).format(n=count, gate_path=_gate_mode_path(config_dir))
    return (
        "steward delegation gate: this is direct edit #{n} on the main "
        "thread with no subagent call in between. The edict says every "
        "non-trivial task runs in a subagent "
        "(steward-delegation:coder-opus-medium for code, "
        "steward-delegation:mechanic-haiku-medium for rote edits). Delegate "
        "it, or ask the operator to set the gate to soft or off by writing "
        "that word to {gate_path} (takes effect immediately; "
        "STEWARD_DELEGATION_GATE only applies at next start)."
    ).format(n=count, gate_path=_gate_mode_path(config_dir))


# ---------------------------------------------------------------------------
# gate mode
# ---------------------------------------------------------------------------

def cmd_gate(payload, env, harness="claude"):
    if _non_empty_str(payload.get("agent_id")):
        return None

    mode = get_gate_mode(env, harness)
    if mode == "off":
        return None

    tool_name = payload.get("tool_name")
    tool_input = payload.get("tool_input")
    # A Copilot apply_patch call passes the patch as a bare string.
    if not isinstance(tool_input, dict) and not (
            harness == "copilot" and isinstance(tool_input, str)):
        tool_input = {}
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = None

    is_edit, allowlisted = classify_tool_call(tool_name, tool_input, env, cwd, harness)
    if not is_edit or allowlisted:
        return None

    session_id = payload.get("session_id")
    if not _non_empty_str(session_id):
        session_id = "unknown"
    count = _bump_counter(get_state_dir(env), session_id)
    if count <= 1:
        return None

    msg = gate_message(count, get_config_dir(env, harness), harness)
    if mode == "hard":
        return json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": msg,
            }
        })
    # Soft mode. No permissionDecision here: "allow" would skip the
    # permission prompt outright. Soft mode is only a reminder, so it
    # carries nothing but additionalContext.
    return json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": msg,
        }
    })


# ---------------------------------------------------------------------------
# delegated mode
# ---------------------------------------------------------------------------

def cmd_delegated(payload, env):
    if _non_empty_str(payload.get("agent_id")):
        return None
    session_id = payload.get("session_id")
    if not _non_empty_str(session_id):
        session_id = "unknown"
    _reset_counter(get_state_dir(env), session_id)
    return None


# ---------------------------------------------------------------------------
# Copilot gate and delegated
#
# Copilot sends no agent_id; a subagent's calls carry its own session_id,
# which session-start never recorded. Act only for a recorded main session.
# ---------------------------------------------------------------------------

def cmd_copilot_gate(payload, env):
    if not _is_copilot_main_session(env, payload.get("session_id")):
        return None
    return cmd_gate(payload, env, "copilot")


def cmd_copilot_delegated(payload, env):
    if not _is_copilot_main_session(env, payload.get("session_id")):
        return None
    return cmd_delegated(payload, env)


def cmd_pi_gate(payload, env):
    return cmd_gate(payload, env, "pi")


# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

# Codex has session-start only: no gate and no delegated mode (see the
# module docstring), so `codex gate` falls through to "no output".
_MODES = {
    "claude": {
        "session-start": cmd_session_start,
        "gate": cmd_gate,
        "delegated": cmd_delegated,
    },
    "copilot": {
        "session-start": cmd_copilot_session_start,
        "gate": cmd_copilot_gate,
        "delegated": cmd_copilot_delegated,
    },
    "codex": {
        "session-start": cmd_codex_session_start,
    },
    "pi": {
        "session-start": cmd_pi_session_start,
        "gate": cmd_pi_gate,
        "delegated": cmd_delegated,
    },
}

# pi's /steward-models modes. Unlike the hook modes above they read stdin
# raw, take extra arguments and set the exit code.
_CLI_MODES = {
    "pi": {
        "model-plan": cmd_model_plan,
        "model-plan-apply": cmd_model_plan_apply,
        "delegation-stats": cmd_delegation_stats,
    },
}


def _dispatch(argv, stdin_text, env):
    if len(argv) < 3:
        return None
    handler = _MODES.get(argv[1], {}).get(argv[2])
    if handler is None:
        return None
    try:
        payload = json.loads(stdin_text) if stdin_text and stdin_text.strip() else {}
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return handler(payload, env)


def _run_cli(name, handler):
    try:
        out, err, code = handler(sys.stdin.read(), os.environ, sys.argv[3:])
    except Exception as exc:
        err = "%s: internal error (%s)" % (name, type(exc).__name__)
        out, code = json.dumps({"error": err}), 1
    sys.stdout.write(out + "\n")
    if err:
        sys.stderr.write(err + "\n")
    return code


def main():
    if len(sys.argv) >= 3:
        handler = _CLI_MODES.get(sys.argv[1], {}).get(sys.argv[2])
        if handler is not None:
            return _run_cli(sys.argv[2], handler)
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
