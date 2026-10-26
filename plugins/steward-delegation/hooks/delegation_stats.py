"""Summarizer for the pi per-launch outcome log (docs/roadmap/pi-model-plan.md, Phase 4).

The pi extension appends one JSON line per finished steward.* child launch to
``$XDG_STATE_HOME/steward-delegation/pi-delegations.jsonl`` (default
``~/.local/state/steward-delegation/pi-delegations.jsonl``)::

    {"v": 2, "ts": ISO-8601, "sessionId", "cwd", "sessionCwd", "agent", "runId",
     "modelParam": str|None, "model": str|None, "thinking": str|None,
     "status": "ok"|"error", "isError": bool, "errorClass": "provider"|"other"|None,
     "durationMs": int|None, "mode": "sync"|"async"|"workflow-child",
     "kind": "plain"|"relaunch"|"escalation"|"operator"}

``cwd`` is the directory the child ran in and ``sessionCwd`` the session's. v1
lines (before steward 0.14.2) have no ``sessionCwd`` and their ``cwd`` is the
session's directory. Both versions are summarized the same way.

``summarize`` groups the lines inside the window by (agent, model) and
``render`` turns that into the /steward-models stats text. A line that is not
a JSON object, has no parseable ``ts`` or no ``agent`` is corrupt: skipped and
counted. The log holds no task text, outputs or file contents, so neither does
the report.

Only the live file is read; rotated files (``pi-delegations.jsonl.<stamp>-<pid>``)
are not.
"""

import json
import math
import os
from datetime import datetime

LOG_NAME = "pi-delegations.jsonl"
DEFAULT_DAYS = 7


def log_path(env):
    state = env.get("XDG_STATE_HOME") or os.path.join(env.get("HOME") or os.path.expanduser("~"), ".local", "state")
    return os.path.join(state, "steward-delegation", LOG_NAME)


def percentile(values, p):
    """Nearest-rank percentile of `values` (0 < p <= 100), or None when empty."""
    if not values:
        return None
    ordered = sorted(values)
    rank = max(1, int(math.ceil(p / 100.0 * len(ordered))))
    return ordered[rank - 1]


def _timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def summarize(lines, now, days):
    cutoff = now - days * 86400.0
    groups = {}
    corrupt = 0
    for raw in lines:
        if not raw or not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except ValueError:
            corrupt += 1
            continue
        if not isinstance(row, dict):
            corrupt += 1
            continue
        ts = _timestamp(row.get("ts"))
        agent = row.get("agent")
        if ts is None or not isinstance(agent, str) or not agent:
            corrupt += 1
            continue
        if ts < cutoff:
            continue
        model = row.get("model") if isinstance(row.get("model"), str) and row.get("model") else "unknown"
        g = groups.setdefault((agent, model), {"agent": agent, "model": model, "launches": 0, "ok": 0,
                                                "providerErrors": 0, "otherErrors": 0, "durations": [],
                                                "relaunches": 0, "escalations": 0})
        g["launches"] += 1
        if row.get("status") == "ok":
            g["ok"] += 1
        elif row.get("errorClass") == "provider":
            g["providerErrors"] += 1
        else:
            g["otherErrors"] += 1
        duration = row.get("durationMs")
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration >= 0:
            g["durations"].append(duration)
        if row.get("kind") == "relaunch":
            g["relaunches"] += 1
        elif row.get("kind") == "escalation":
            g["escalations"] += 1
    rows = []
    for key in sorted(groups):
        g = groups.pop(key)
        durations = g.pop("durations")
        g["errors"] = g["providerErrors"] + g["otherErrors"]
        g["successRate"] = g["ok"] / g["launches"]
        g["medianMs"] = percentile(durations, 50)
        g["p90Ms"] = percentile(durations, 90)
        rows.append(g)
    return {"days": days, "rows": rows, "corrupt": corrupt}


def _seconds(ms):
    return "-" if ms is None else "%.1fs" % (ms / 1000.0)


def _errors(row):
    if not row["errors"]:
        return "0"
    parts = []
    if row["providerErrors"]:
        parts.append("%d provider" % row["providerErrors"])
    if row["otherErrors"]:
        parts.append("%d other" % row["otherErrors"])
    return ", ".join(parts)


def render(summary):
    days = summary["days"]
    head = "steward launches, last %d day%s" % (days, "" if days == 1 else "s")
    lines = []
    if not summary["rows"]:
        lines.append("No steward launches logged in the last %d day%s." % (days, "" if days == 1 else "s"))
    else:
        lines.append(head + " (per profile and resolved model):")
        lines.append("")
        lines.append("| Profile | Model | Launches | OK | Errors | Success | Median | p90 | Relaunches | Escalations |")
        lines.append("|-|-|-|-|-|-|-|-|-|-|")
        for r in summary["rows"]:
            lines.append("| %s | %s | %d | %d | %s | %d%% | %s | %s | %d | %d |" % (
                r["agent"], r["model"], r["launches"], r["ok"], _errors(r),
                int(round(r["successRate"] * 100)), _seconds(r["medianMs"]), _seconds(r["p90Ms"]),
                r["relaunches"], r["escalations"]))
    if summary["corrupt"]:
        lines.append("")
        lines.append("Skipped %d corrupt line%s." % (summary["corrupt"], "" if summary["corrupt"] == 1 else "s"))
    return "\n".join(lines)


def report(path, days, now):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except FileNotFoundError:
        lines = []
    return render(summarize(lines, now=now, days=days))
