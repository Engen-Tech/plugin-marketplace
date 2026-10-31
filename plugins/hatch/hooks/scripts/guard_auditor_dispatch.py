#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""PreToolUse guard: hatch-safety-auditor dispatches fail closed.

Zero dependencies (pure stdlib). The harness invokes this on Task|Agent with the
hook payload JSON on stdin. It recognizes a hatch-safety-auditor dispatch by the
agent identity fields of the tool input (subagent type / agent name). For a
recognized dispatch it requires, in the prompt: a binder path
(`.hatch/binders/<slug>.json`), and — when that binder pins a non-empty `sme[]` —
resolved checklist evidence (rule-id item lines, or rule ids inside a checklist
block). Missing binder path, unresolvable binder, or missing checklists deny the
dispatch (exit 2, reason on stderr) — the auditor cannot re-derive built-in packs,
so a dispatch without them would silently skip the stack-pack check. Unlike the
other guards this one is FAIL-CLOSED on its recognized shape: an internal error
while checking a recognized dispatch denies. Unrecognized dispatch shapes always
pass.

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

AGENT_KEYS = ("subagent_type", "agent_type", "agent", "agent_name", "name")
AUDITOR = "hatch-safety-auditor"
BINDER_PATH_RE = re.compile(r"[^\s'\"`]*\.hatch[\\/]binders[\\/][A-Za-z0-9][A-Za-z0-9._-]*\.json")
# same id grammar validate_packs.py enforces: <prefix>.<n> item lines / bare tokens
ITEM_LINE_RE = re.compile(r"^- \[ \] [a-z][a-z0-9-]*\.\d+ — ", re.M)
ID_TOKEN_RE = re.compile(r"\b[a-z][a-z0-9-]*\.\d+\b")


def _recognized(tool_input: dict) -> bool:
    return any(isinstance(tool_input.get(k), str) and AUDITOR in tool_input[k]
               for k in AGENT_KEYS)


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
    text = "\n".join(str(tool_input.get(k) or "") for k in ("prompt", "description"))
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


def _run_self_test() -> int:
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        cwd = str(td)
        binders = Path(td) / ".hatch" / "binders"
        binders.mkdir(parents=True)
        (binders / "pinned.json").write_text(json.dumps(
            {"slug": "pinned", "sme": ["minimalism", "python"], "work_items": []}), encoding="utf-8")
        (binders / "bare.json").write_text(json.dumps(
            {"slug": "bare", "work_items": []}), encoding="utf-8")
        (binders / "mangled.json").write_text("{ not json", encoding="utf-8")

        def dispatch(prompt: str, subagent: str = AUDITOR) -> dict:
            return {"hook_event_name": "PreToolUse", "tool_name": "Task", "cwd": cwd,
                    "tool_input": {"subagent_type": subagent,
                                   "description": "boundary scan", "prompt": prompt}}

        checklists = ("stack-pack Review checklists (normalized):\n"
                      "- [ ] min.1 — No new third-party dependency where the stdlib ships it.\n"
                      "- [ ] py.2 — No bare except.\n")
        cases = [
            ("unrecognized subagent passes with no binder path",
             dispatch("build item a", subagent="hatch-build"), 0, None),
            ("mention of the auditor in prose alone is not recognition",
             dispatch("after the build, hatch-safety-auditor scans it",
                      subagent="hatch-build"), 0, None),
            ("recognized without a binder path denied",
             dispatch("scan the diff for item a"), 2, ".hatch/binders"),
            ("recognized with unresolvable binder denied",
             dispatch("binder: .hatch/binders/ghost.json"), 2, "cannot be read"),
            ("recognized with mangled binder JSON denied",
             dispatch("binder: .hatch/binders/mangled.json"), 2, "cannot be read"),
            ("binder without sme passes without checklists",
             dispatch("binder: .hatch/binders/bare.json"), 0, None),
            ("pinned sme without checklist evidence denied, naming the packs",
             dispatch("binder: .hatch/binders/pinned.json"), 2, "minimalism, python"),
            ("pinned sme with item-line evidence passes",
             dispatch(f"binder: .hatch/binders/pinned.json\n{checklists}"), 0, None),
            ("pinned sme with ids inside a checklist block passes",
             dispatch("binder: .hatch/binders/pinned.json\n"
                      "Resolved checklist: min.1 min.4 py.2 py.3"), 0, None),
            ("bare ids outside any checklist block are not evidence",
             dispatch("binder: .hatch/binders/pinned.json\nsee min.1 and py.2"), 2, "minimalism"),
            ("namespaced subagent type is recognized",
             dispatch("scan it", subagent="hatch:hatch-safety-auditor"), 2, ".hatch/binders"),
            ("absolute binder path resolves",
             dispatch(f"binder: {binders / 'bare.json'}"), 0, None),
            ("tool_input not a dict passes",
             {"hook_event_name": "PreToolUse", "tool_name": "Task", "cwd": cwd,
              "tool_input": "junk"}, 0, None),
        ]
        failures = 0
        for name, payload, want, needle in cases:
            code, msg = decide(payload)
            ok = code == want and (needle is None or needle in msg)
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
            failures += 0 if ok else 1

    total = len(cases)
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
    try:
        code, reason = decide(payload)
    except Exception:  # noqa: BLE001
        # fail closed only on the shape this guard exists for; everything else passes
        tool_input = payload.get("tool_input")
        try:
            recognized = isinstance(tool_input, dict) and _recognized(tool_input)
        except Exception:  # noqa: BLE001
            recognized = False
        if not recognized:
            return 0
        code, reason = 2, (
            "hatch: internal error while checking a hatch-safety-auditor dispatch — this guard "
            "fails closed. Re-dispatch with the binder path (.hatch/binders/<slug>.json) and, "
            "when the binder pins sme[] packs, each pack's resolved Review checklist embedded "
            "in the prompt.")
    if code == 2:
        print(reason, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
