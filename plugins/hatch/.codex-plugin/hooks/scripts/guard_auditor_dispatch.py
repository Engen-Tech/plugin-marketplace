#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Codex PreToolUse guard: hatch-safety-auditor dispatches fail closed.

Hand-maintained Codex twin of hooks/scripts/guard_auditor_dispatch.py (the
Claude Code guard) — never generated from it, never byte-compared with it.
Zero dependencies (pure stdlib). The Codex harness invokes this on
`spawn_agent|Agent` (matchers are regex strings, and the Codex hooks docs
state "spawn_agent also matches Agent") with the hook payload JSON on stdin.
The Codex dispatch tool_input carries `message` and `task_name` with an
optional `agent_type` (a field set grounded in the Codex source, codex-rs
multi_agents_v2 spawn.rs), so this twin joins `message` and `task_name` into
the inspected text alongside the Claude original's `prompt`/`description`.

RECOGNITION never keys on the tool name, so a matcher change can never
silently disarm the guard. The agent identity is read from the payload's
tool_input identity fields — the original's key set (subagent_type,
agent_type, agent, agent_name, name) plus `task_name`, because a bare Codex
plugin install dispatches gates through a generic fallback agent whose only
hatch-bearing content is the task label, and Codex task names conventionally
use underscores: both spellings are accepted, `hatch-safety-auditor` and
`hatch_safety_auditor`, in any identity field. Recognition is a substring
test on those FIELDS only; a prose mention of the auditor inside message or
prompt text is NOT recognition. Stated limit: a fallback dispatch carrying a
generic agent_type and no hatch-bearing task_name is not recognized — the
enforced claim is scoped to dispatches that identify their gate in a payload
identity field.

For a recognized dispatch it requires, in the joined text: a binder path
(`.hatch/binders/<slug>.json`), and — when that binder pins a non-empty
`sme[]` — resolved checklist evidence (rule-id item lines, or rule ids inside
a checklist block). Missing binder path, unresolvable binder, or missing
checklists deny the dispatch — the auditor cannot re-derive built-in packs
(they live in the plugin, not the worktree), so a dispatch without them would
silently skip the stack-pack check.

DENY CHANNELS — both forms Codex documents, one reason byte for byte: on
stdout the JSON shape {"hookSpecificOutput": {"hookEventName": "PreToolUse",
"permissionDecision": "deny", "permissionDecisionReason": <reason>}}, and the
same reason on stderr with exit 2 — the both-channels precedent the Codex
Stop twin already sets. A pass emits nothing on stdout.

POSTURE — FAIL-CLOSED on the recognized shape ONLY, exactly like the Claude
original: an internal error while checking a RECOGNIZED dispatch denies with
a reason naming what to re-dispatch with; an unreadable payload, a payload
with no tool_input dict, a non-dispatch payload, and an unrecognized dispatch
shape all pass with exit 0. State the split plainly, because it is the subtle
part: the manifest LAUNCHER is fail-open and this GUARD is fail-closed, and
they are not in conflict — the launcher only decides whether the guard runs
at all when the plugin root does not resolve, while the fail-closed rule
governs once the guard is running. Neither posture may be traded for the
other.

  guard_auditor_dispatch.py              # hook mode: payload on stdin, exit 0/2
  guard_auditor_dispatch.py --self-test  # run embedded fixtures, exit 0/1
"""
from __future__ import annotations
import argparse, json, os, re, sys
from pathlib import Path

def _read_stdin_text() -> str:
    """The hook payload is UTF-8 JSON, whatever the host's locale codec is.

    sys.stdin decodes with the locale codec — cp1252 on a stock Windows
    session — which mojibakes or raises on a payload it cannot spell. Read
    the byte stream and decode explicitly; the getattr falls back for test
    doubles that carry no .buffer."""
    data = getattr(sys.stdin, "buffer", sys.stdin).read()
    return data.decode("utf-8") if isinstance(data, bytes) else data

# The original's identity key set, plus task_name (the fallback-agent task label).
IDENTITY_KEYS = ("subagent_type", "agent_type", "agent", "agent_name", "name",
                 "task_name")
# The original's prompt/description, plus the Codex dispatch fields.
TEXT_KEYS = ("prompt", "description", "message", "task_name")
AUDITOR_NAMES = ("hatch-safety-auditor", "hatch_safety_auditor")
BINDER_PATH_RE = re.compile(r"[^\s'\"`]*\.hatch[\\/]binders[\\/][A-Za-z0-9][A-Za-z0-9._-]*\.json")
# same id grammar validate_packs.py enforces: <prefix>.<n> item lines / bare tokens
ITEM_LINE_RE = re.compile(r"^- \[ \] [a-z][a-z0-9-]*\.\d+ — ", re.M)
ID_TOKEN_RE = re.compile(r"\b[a-z][a-z0-9-]*\.\d+\b")

INTERNAL_ERROR_REASON = (
    "hatch: internal error while checking a hatch-safety-auditor dispatch — this guard "
    "fails closed. Re-dispatch with the binder path (.hatch/binders/<slug>.json) and, "
    "when the binder pins sme[] packs, each pack's resolved Review checklist embedded "
    "in the prompt.")


def _recognized(tool_input: dict) -> bool:
    return any(isinstance(tool_input.get(k), str)
               and any(n in tool_input[k] for n in AUDITOR_NAMES)
               for k in IDENTITY_KEYS)


def _has_checklist_evidence(text: str) -> bool:
    if ITEM_LINE_RE.search(text):
        return True
    idx = text.lower().find("checklist")
    return idx != -1 and bool(ID_TOKEN_RE.search(text[idx:]))


def _load_binder(path_str: str, cwd: str) -> dict | None:
    p = Path(path_str)
    if not p.is_absolute():
        p = Path(cwd) / p
    try:
        doc = json.loads(p.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def decide(payload: dict) -> tuple[int, str]:
    """Return (exit_code, stderr_reason)."""
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict) or not _recognized(tool_input):
        return 0, ""  # unrecognized dispatch shapes always pass
    text = "\n".join(str(tool_input.get(k) or "") for k in TEXT_KEYS)
    m = BINDER_PATH_RE.search(text)
    if not m:
        return 2, (
            "hatch: this is a hatch-safety-auditor dispatch and the auditor fails closed — the "
            "dispatch prompt must name the binder path (.hatch/binders/<slug>.json) so the "
            "auditor can compare the diff against the declared work item. Re-dispatch with the "
            "binder path (and, when the binder pins sme[] packs, each pack's resolved Review "
            "checklist) embedded in the prompt.")
    binder_path = m.group(0)
    binder = _load_binder(binder_path, payload.get("cwd") or os.getcwd())
    if binder is None:
        return 2, (
            f"hatch: this hatch-safety-auditor dispatch names binder '{binder_path}' but that "
            "file cannot be read as JSON, and the auditor fails closed on an unresolvable plan "
            "of record. Re-dispatch with a binder path that resolves from the session cwd.")
    sme = binder.get("sme")
    packs = [s for s in sme if isinstance(s, str)] if isinstance(sme, list) else []
    if not packs or _has_checklist_evidence(text):
        return 0, ""
    return 2, (
        f"hatch: binder '{binder_path}' pins stack packs [{', '.join(packs)}] but the dispatch "
        "prompt carries no resolved Review checklists (rule-id item lines like "
        "'- [ ] min.1 — …'). The auditor fails closed without them — built-in packs live in the "
        "plugin, not the worktree, so it cannot re-derive them. Re-dispatch with each pinned "
        "pack's checklist embedded as a normalized item list.")


def deny_json(reason: str) -> str:
    """The documented Codex PreToolUse deny decision, emitted on stdout beside
    the exit-2 + stderr contract."""
    return json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason}})


def decide_guarded(payload: dict) -> tuple[int, str]:
    """decide(), fail-closed on the recognized shape only: an internal error
    while checking a recognized dispatch denies; everything else passes."""
    try:
        return decide(payload)
    except Exception:  # noqa: BLE001
        tool_input = payload.get("tool_input")
        try:
            recognized = isinstance(tool_input, dict) and _recognized(tool_input)
        except Exception:  # noqa: BLE001
            recognized = False
        if not recognized:
            return 0, ""
        return 2, INTERNAL_ERROR_REASON


def _run_self_test() -> int:
    import subprocess, tempfile
    sys.dont_write_bytecode = True
    child_env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    results: list[bool] = []

    def check(name: str, payload: dict, want: int, needle: str | None) -> None:
        code, msg = decide_guarded(payload)
        ok = code == want and (needle is None or needle in msg)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
        results.append(ok)

    def flag(name: str, ok: bool) -> None:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        results.append(ok)

    with tempfile.TemporaryDirectory() as td:
        cwd = str(td)
        binders = Path(td) / ".hatch" / "binders"
        binders.mkdir(parents=True)
        (binders / "pinned.json").write_text(json.dumps(
            {"slug": "pinned", "sme": ["minimalism", "python"], "work_items": []}), encoding="utf-8")
        (binders / "bare.json").write_text(json.dumps(
            {"slug": "bare", "work_items": []}), encoding="utf-8")
        (binders / "mangled.json").write_text("{ not json", encoding="utf-8")

        def dispatch(prompt: str, subagent: str = AUDITOR_NAMES[0],
                     key: str = "subagent_type", text_key: str = "prompt") -> dict:
            return {"hook_event_name": "PreToolUse", "tool_name": "spawn_agent",
                    "cwd": cwd, "tool_input": {key: subagent, text_key: prompt}}

        checklists = ("stack-pack Review checklists (normalized):\n"
                      "- [ ] min.1 — No new third-party dependency where the stdlib ships it.\n"
                      "- [ ] py.2 — No bare except.\n")

        # The Claude original's fixture set, carried over.
        check("unrecognized subagent passes with no binder path",
              dispatch("build item a", subagent="hatch-build"), 0, None)
        check("mention of the auditor in prose alone is not recognition",
              dispatch("after the build, hatch-safety-auditor scans it",
                       subagent="hatch-build"), 0, None)
        check("recognized without a binder path denied",
              dispatch("scan the diff for item a"), 2, ".hatch/binders")
        check("recognized with unresolvable binder denied",
              dispatch("binder: .hatch/binders/ghost.json"), 2, "cannot be read")
        check("recognized with mangled binder JSON denied",
              dispatch("binder: .hatch/binders/mangled.json"), 2, "cannot be read")
        check("binder without sme passes without checklists",
              dispatch("binder: .hatch/binders/bare.json"), 0, None)
        check("pinned sme without checklist evidence denied, naming the packs",
              dispatch("binder: .hatch/binders/pinned.json"), 2, "minimalism, python")
        check("pinned sme with item-line evidence passes",
              dispatch(f"binder: .hatch/binders/pinned.json\n{checklists}"), 0, None)
        check("pinned sme with ids inside a checklist block passes",
              dispatch("binder: .hatch/binders/pinned.json\n"
                       "Resolved checklist: min.1 min.4 py.2 py.3"), 0, None)
        check("bare ids outside any checklist block are not evidence",
              dispatch("binder: .hatch/binders/pinned.json\nsee min.1 and py.2"),
              2, "minimalism")
        check("namespaced subagent type is recognized",
              dispatch("scan it", subagent="hatch:hatch-safety-auditor"),
              2, ".hatch/binders")
        check("absolute binder path resolves",
              dispatch(f"binder: {binders / 'bare.json'}"), 0, None)
        check("tool_input not a dict passes",
              {"hook_event_name": "PreToolUse", "tool_name": "spawn_agent",
               "cwd": cwd, "tool_input": "junk"}, 0, None)

        # Codex-native shapes: agent_type identity, message text, task_name both ways.
        check("Codex agent_type identity with message text is recognized and inspected",
              dispatch("scan the diff", key="agent_type", text_key="message"),
              2, ".hatch/binders")
        check("underscore spelling in agent_type is recognized",
              dispatch("scan the diff", subagent="hatch_safety_auditor",
                       key="agent_type", text_key="message"), 2, ".hatch/binders")
        check("underscore task label alone is recognition (fallback-agent dispatch)",
              dispatch("scan the diff", subagent="hatch_safety_auditor",
                       key="task_name", text_key="message"), 2, ".hatch/binders")
        check("agent_name key is recognized",
              dispatch("scan it", key="agent_name", text_key="message"),
              2, ".hatch/binders")
        check("bare name key is recognized",
              dispatch("scan it", key="name", text_key="message"),
              2, ".hatch/binders")
        check("agent key is recognized",
              dispatch("scan it", key="agent", text_key="message"),
              2, ".hatch/binders")
        check("binder path carried solely in task_name is joined into the inspected text",
              {"hook_event_name": "PreToolUse", "tool_name": "spawn_agent", "cwd": cwd,
               "tool_input": {"agent_type": AUDITOR_NAMES[0],
                              "task_name": "binder: .hatch/binders/bare.json"}}, 0, None)
        check("a gate identity that is not the auditor passes through this twin",
              dispatch("binder: .hatch/binders/pinned.json",
                       subagent="hatch-acceptance-reviewer", key="agent_type",
                       text_key="message"), 0, None)
        check("prose mention of the auditor inside message text is not recognition",
              dispatch("please consult the hatch-safety-auditor checklist for "
                       "binder: .hatch/binders/pinned.json",
                       subagent="general-purpose", key="agent_type",
                       text_key="message"), 0, None)

        # Fail-closed internal-error path, recognized vs not.
        global decide
        orig_decide = decide

        def _boom(_payload: dict) -> tuple[int, str]:
            raise RuntimeError("simulated internal error")

        decide = _boom
        try:
            check("internal error on a RECOGNIZED dispatch fails closed, naming the fix",
                  dispatch("binder: .hatch/binders/bare.json"), 2, "fails closed")
            check("internal error on an unrecognized dispatch still passes",
                  dispatch("build item a", subagent="hatch-build"), 0, None)
        finally:
            decide = orig_decide

        # Hook mode end to end: both deny channels, silent pass, fail-open stdin.
        denied = subprocess.run(
            [sys.executable, __file__],
            input=json.dumps(dispatch("scan the diff")),
            capture_output=True, text=True, env=child_env, encoding="utf-8")
        try:
            out = json.loads(denied.stdout)
        except json.JSONDecodeError:
            out = None
        hso = out.get("hookSpecificOutput", {}) if isinstance(out, dict) else {}
        flag("hook-mode deny emits the documented JSON decision on stdout and the "
             "identical reason on stderr, byte for byte",
             denied.returncode == 2
             and hso.get("hookEventName") == "PreToolUse"
             and hso.get("permissionDecision") == "deny"
             and bool(hso.get("permissionDecisionReason"))
             and denied.stderr == hso.get("permissionDecisionReason") + "\n")
        allowed = subprocess.run(
            [sys.executable, __file__],
            input=json.dumps(dispatch("build item a", subagent="hatch-build")),
            capture_output=True, text=True, env=child_env, encoding="utf-8")
        flag("hook-mode pass emits nothing on stdout",
             allowed.returncode == 0 and not allowed.stdout.strip())
        mangled = subprocess.run(
            [sys.executable, __file__], input="{ not json",
            capture_output=True, text=True, env=child_env, encoding="utf-8")
        flag("hook-mode unreadable payload passes silently (unrecognized shape)",
             mangled.returncode == 0 and not mangled.stdout.strip())

    total = len(results)
    failures = results.count(False)
    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _run_self_test()
    payload: dict = {}
    try:
        raw = json.loads(_read_stdin_text())
        if isinstance(raw, dict):
            payload = raw
    except Exception:  # noqa: BLE001
        return 0  # an unreadable payload is an unrecognized shape — pass
    code, reason = decide_guarded(payload)
    if code == 2:
        print(deny_json(reason))           # documented Codex deny decision channel
        print(reason, file=sys.stderr)     # exit-code channel, same reason
    return code


if __name__ == "__main__":
    sys.exit(main())
