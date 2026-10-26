#!/usr/bin/env python3
"""steward-orchestration hook script.

Called as `orchestration_hook.py <harness> <mode>`. Reads one JSON object
from stdin and prints at most one JSON object to stdout. Stdlib only,
python3.9+.

Only `claude session-start` does anything: it creates the orchestration
registry when it is missing (never overwriting it) and prints a context
block that tells the model to check its role.

This script must never raise to whoever called it. Any error, unknown
harness or mode means: exit 0, no output. Fail open, always.
"""

import json
import os
import sys


def get_orchestration_dir(env):
    """Where the orchestration registry lives. Deliberately under HOME, not
    $CLAUDE_CONFIG_DIR, so sessions in different config profiles share one
    registry."""
    value = env.get("STEWARD_ORCHESTRATION_DIR")
    if value:
        return value
    home = env.get("HOME") or os.path.expanduser("~")
    return os.path.join(home, ".claude", "orchestration")


REGISTRY_SKELETON = (
    "# Orchestration registry\n"
    "\n"
    "One primary per initiative, designated by the operator. The primary keeps "
    "its own entry current: it adds a secondary when it onboards one and "
    "removes it when the initiative ends. Every session reads this file to "
    "work out its role before applying the `steward-orchestration:orchestrating` "
    "skill. Names are `ListAgents` names; the session id is the tie-breaker if "
    "a name is reused.\n"
    "\n"
    "| Initiative | Primary (ListAgents name, session id) | Secondaries "
    "(ListAgents name, repo) | Decision log | Since |\n"
    "|-|-|-|-|-|\n"
)

CONTEXT_BLOCK = (
    "<STEWARD-ORCHESTRATION>\n"
    "## Role check\n"
    "If `~/.claude/orchestration/initiatives.md` (or "
    "`$STEWARD_ORCHESTRATION_DIR/initiatives.md`) names this session as a "
    "primary or secondary, also follow the `steward-orchestration:orchestrating` "
    "skill.\n"
    "\n"
    "This plugin relies on steward-delegation. If the "
    "`steward-delegation:delegating` skill is not in your skill list, tell the "
    "operator once.\n"
    "</STEWARD-ORCHESTRATION>"
)


def _ensure_registry(env):
    orch_dir = get_orchestration_dir(env)
    path = os.path.join(orch_dir, "initiatives.md")
    if os.path.exists(path):
        return
    os.makedirs(orch_dir, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(REGISTRY_SKELETON)


def session_start(env):
    # The registry write is best-effort. An unwritable orchestration dir
    # must never cost us the context block.
    try:
        _ensure_registry(env)
    except OSError:
        pass
    return json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": CONTEXT_BLOCK,
        }
    })


def _dispatch(argv, env):
    if argv[1:3] != ["claude", "session-start"]:
        return None
    return session_start(env)


def main():
    try:
        # Drain stdin so the caller never sees a broken pipe; the payload
        # carries nothing this hook needs.
        sys.stdin.read()
        output = _dispatch(sys.argv, os.environ)
        if output:
            sys.stdout.write(output + "\n")
    except Exception:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
