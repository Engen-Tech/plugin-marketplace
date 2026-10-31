#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pre/PostToolUse guard: stack packs land only validator-clean.

Zero dependencies (pure stdlib). The harness invokes this with the hook payload
JSON on stdin. Targets under `.hatch/sme/*.md` pass through one rule:

Validator-clean (`skills/hatch-kaizen/scripts/validate_packs.py`, resolved via
CLAUDE_PLUGIN_ROOT, falling back to this script's own plugin root):
  - PreToolUse `Write`: the proposed content is validated from a temp file; a
    failure denies the write (exit 2, findings on stderr).
  - PostToolUse `Edit`/`Write`: the file on disk is validated; a failure exits 2
    so the findings reach the model as feedback it must fix.

The Write-preventive / Edit-corrective asymmetry is deliberate: PreToolUse fires on
`Write` (deny before a malformed pack lands), PostToolUse on `Edit`|`Write` (diagnose
a malformed pack the model just wrote).

A string tool_input that starts with `*** Begin Patch` (Copilot hands PascalCase
hooks the raw apply_patch body under Edit or Write) is parsed into its file ops and
each is judged as the dict write it makes: Add File as a Write of its + lines,
Update File as an Edit (Move to retargets; Delete File leaves nothing to judge).

Any internal error fails open (exit 0): a missing/broken validator, a subprocess
crash, or unparseable output must never break an unrelated tool call.

  guard_pack_write.py              # hook mode: payload on stdin, exit 0/2
  guard_pack_write.py --self-test  # run embedded fixtures, exit 0/1
"""
from __future__ import annotations
import argparse, json, os, re, subprocess, sys, tempfile
from pathlib import Path

def _read_stdin_text() -> str:
    """The hook payload is UTF-8 JSON, whatever the host's locale codec is.

    sys.stdin decodes with the locale codec — cp1252 on a stock Windows
    session — which mojibakes or raises on a payload it cannot spell. Read
    the byte stream and decode explicitly; the getattr falls back for test
    doubles that carry no .buffer."""
    data = getattr(sys.stdin, "buffer", sys.stdin).read()
    return data.decode("utf-8") if isinstance(data, bytes) else data

PACK_RE = re.compile(r"(?:^|/)\.hatch/sme/.+\.md$")
VALIDATOR_REL = Path("skills") / "hatch-kaizen" / "scripts" / "validate_packs.py"


def _os_spelling(path: str, cwd: str) -> str:
    """The spelling the OS will actually open, in git's forward-slash form.

    A literal match on the typed path is the fact on POSIX, where open() opens
    exactly what was typed — only separators are normalised. On Windows it is
    not: a write resolves case-insensitively (`.Hatch`), strips trailing dots
    and spaces from the last component (`x.md.`), and accepts 8.3 short names
    (`HATCH~1`) — spellings that reach a real pack while sailing past the
    pattern, which here means a pack written with no validation at all.
    abspath() applies the dot/space cleanup the OS will apply, realpath()
    returns existing components in their true long-name casing, and the
    lowercase fold covers components that do not exist yet — matched against
    an all-lowercase pattern, that is NTFS's own equivalence."""
    if os.name != "nt":
        return path.replace("\\", "/")
    p = path if os.path.isabs(path) else os.path.join(cwd or ".", path)
    try:
        p = os.path.realpath(os.path.abspath(p))
    except (OSError, ValueError):
        pass
    return p.replace(os.sep, "/").lower()


def _resolve_rel(rel: Path) -> Path | None:
    """Resolve a plugin-relative path via CLAUDE_PLUGIN_ROOT, else this script's own
    plugin root — the idiom the validator lookup uses."""
    roots: list[Path] = []
    env = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env:
        roots.append(Path(env))
    roots.append(Path(__file__).resolve().parent.parent.parent)  # <plugin root>/hooks/scripts/..
    for root in roots:
        cand = root / rel
        if cand.is_file():
            return cand
    return None


def _validator_path() -> Path | None:
    return _resolve_rel(VALIDATOR_REL)


def _run_validator(validator: Path, pack_file: Path) -> tuple[int, str]:
    proc = subprocess.run([sys.executable, str(validator), str(pack_file)],
                          capture_output=True, text=True, timeout=30, encoding="utf-8")
    return proc.returncode, (proc.stdout + proc.stderr).strip()


DIRECTIVE_RE = re.compile(r"^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$")


def _as_patch_command(tool_input):
    """Copilot gives PascalCase hooks the raw patch string as tool_input, under
    tool_name Edit or Write. Wrap it so it takes the patch path."""
    if isinstance(tool_input, str) and tool_input.lstrip().startswith("*** Begin Patch"):
        return {"command": tool_input}
    return tool_input


def parse_patch_ops(text: str) -> list[dict]:
    """apply_patch body -> [{path, content}] for each file the patch leaves behind.
    Add File carries its full text (the + lines); Update File carries None, an
    Edit-like delta. Move to retargets the current op; Delete File leaves no file.
    Content lines are +/- prefixed, so text containing `*** Add File:` can never
    spoof a directive."""
    ops: list[dict] = []
    cur: dict | None = None
    for line in text.split("\n"):
        line = line.rstrip("\r")
        m = DIRECTIVE_RE.match(line)
        if m:
            # Windows models may spell patch paths with `\` separators.
            kind, path = m.group(1), m.group(2).strip().replace("\\", "/")
            if kind == "Move to":
                if cur is not None:
                    cur["path"] = path
            elif kind == "Delete File":
                cur = None
            else:
                cur = {"path": path, "content": "" if kind == "Add File" else None}
                ops.append(cur)
            continue
        if cur is not None and cur["content"] is not None and line.startswith("+"):
            cur["content"] += line[1:] + "\n"
    return ops


def decide(payload: dict) -> tuple[int, str]:
    """Return (exit_code, stderr_message)."""
    tool_input = _as_patch_command(payload.get("tool_input"))
    if isinstance(tool_input, dict) and isinstance(tool_input.get("command"), str) \
            and tool_input["command"].lstrip().startswith("*** Begin Patch"):
        # Judge each file the patch writes exactly as the dict write of that path.
        findings = []
        for op in parse_patch_ops(tool_input["command"]):
            sub = dict(payload, tool_name="Edit", tool_input={"file_path": op["path"]})
            if op["content"] is not None:
                sub["tool_name"] = "Write"
                sub["tool_input"]["content"] = op["content"]
            code, msg = decide(sub)
            if code:
                findings.append(msg)
        return (2, "\n\n".join(findings)) if findings else (0, "")
    target = tool_input.get("file_path") if isinstance(tool_input, dict) else None
    if not isinstance(target, str) and isinstance(tool_input, dict):
        # Copilot CLI spells the target `path` (Write {path, file_text}, Edit {path, ...}).
        target = tool_input.get("path")
    if not isinstance(target, str):
        return 0, ""
    cwd = payload.get("cwd") or os.getcwd()
    spelled = _os_spelling(target, cwd)
    if not PACK_RE.search(spelled):
        return 0, ""
    validator = _validator_path()
    if validator is None:
        return 0, ""  # fail open: no validator to consult

    # The canonical basename, so a `terraform.md.` write is validated as the
    # `terraform.md` the OS will create, not as a name no stack could match.
    basename = Path(spelled).name

    if payload.get("hook_event_name") == "PreToolUse":
        if payload.get("tool_name") != "Write":
            return 0, ""  # an Edit delta has no full content to validate; PostToolUse covers it
        content = tool_input.get("content")
        if content is None:
            content = tool_input.get("file_text")  # Copilot CLI's Write spelling
        if not isinstance(content, str):
            return 0, ""
        with tempfile.TemporaryDirectory() as td:
            # keep the target's basename: the validator checks `name` == file basename
            probe = Path(td) / basename
            probe.write_text(content, encoding="utf-8")
            rc, findings = _run_validator(validator, probe)
        if rc != 0:
            return 2, (
                f"hatch: '{target}' is a stack pack and the proposed content fails "
                "validate_packs.py, so the write is denied — packs land only in validator-clean "
                "form (the kaizen pre-land syntax check, enforced below the agent). Fix the "
                f"findings and write the pack again.\n\n{findings}")
        return 0, ""

    # PostToolUse (Edit|Write): the pack is already on disk — validate it and, on
    # failure, feed the findings back so the model must repair it before moving on.
    abs_target = Path(spelled) if os.path.isabs(spelled) else Path(cwd) / spelled
    if not abs_target.is_file():
        return 0, ""
    rc, findings = _run_validator(validator, abs_target)
    if rc != 0:
        return 2, (
            f"hatch: '{target}' is a stack pack and the content now on disk fails "
            "validate_packs.py. Repair the pack until the validator passes before doing anything "
            "else — a malformed pack silently drops out of plan-time matching and audit-time "
            f"checklists.\n\n{findings}")
    return 0, ""


# --- Self-test fixtures --------------------------------------------------------

_VALID_PACK = """\
---
name: terraform
description: Terraform pack fixture
match: ["terraform"]
---
## Review checklist
- [ ] tf.1 — Pin provider versions.
"""

_INVALID_PACK = """\
## Review checklist
- [ ] tf.1 — A pack with no frontmatter at all.
"""


def _run_self_test() -> int:
    if _validator_path() is None:
        print("[FAIL] validator not resolvable (skills/hatch-kaizen/scripts/validate_packs.py)")
        print("\n0/1 checks passed")
        return 1

    with tempfile.TemporaryDirectory() as td:
        cwd = str(td)
        sme = Path(td) / ".hatch" / "sme"
        sme.mkdir(parents=True)
        (sme / "terraform.md").write_text(_VALID_PACK, encoding="utf-8")
        (sme / "broken.md").write_text(_INVALID_PACK, encoding="utf-8")

        def pre_write(path: str, content: str | None) -> dict:
            ti: dict = {"file_path": path}
            if content is not None:
                ti["content"] = content
            return {"hook_event_name": "PreToolUse", "tool_name": "Write",
                    "cwd": cwd, "tool_input": ti}

        def post(tool: str, path: str) -> dict:
            return {"hook_event_name": "PostToolUse", "tool_name": tool, "cwd": cwd,
                    "tool_input": {"file_path": path}, "tool_response": {"success": True}}

        def copilot_write(path: str, file_text: str) -> dict:
            # Copilot CLI spells Write as {path, file_text}.
            return {"hook_event_name": "PreToolUse", "tool_name": "Write", "cwd": cwd,
                    "tool_input": {"path": path, "file_text": file_text}}

        def patch_str(event: str, tool: str, *lines: str) -> dict:
            return {"hook_event_name": event, "tool_name": tool, "cwd": cwd,
                    "tool_input": "\n".join(("*** Begin Patch", *lines, "*** End Patch"))}

        cases = [
            ("pre-write valid pack passes",
             pre_write(".hatch/sme/terraform.md", _VALID_PACK), 0, None),
            ("pre-write invalid pack denied",
             pre_write(".hatch/sme/terraform.md", _INVALID_PACK), 2, "frontmatter"),
            ("pre-write name/basename mismatch denied",
             pre_write(".hatch/sme/angular.md", _VALID_PACK), 2, "basename"),
            ("pre-write outside .hatch/sme passes",
             pre_write("docs/sme/terraform.md", _INVALID_PACK), 0, None),
            ("pre-write non-md under .hatch/sme passes",
             pre_write(".hatch/sme/notes.txt", "x"), 0, None),
            ("pre-write without content passes (nothing to validate)",
             pre_write(".hatch/sme/terraform.md", None), 0, None),
            ("PreToolUse Edit passes (PostToolUse covers it)",
             {"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": cwd,
              "tool_input": {"file_path": ".hatch/sme/broken.md",
                             "old_string": "a", "new_string": "b"}}, 0, None),
            ("post-write valid pack on disk passes",
             post("Write", ".hatch/sme/terraform.md"), 0, None),
            ("post-edit invalid pack on disk feeds back",
             post("Edit", ".hatch/sme/broken.md"), 2, "frontmatter"),
            ("post on missing file passes",
             post("Write", ".hatch/sme/ghost.md"), 0, None),
            ("Copilot pre-write {path, file_text} invalid pack denied",
             copilot_write(".hatch/sme/terraform.md", _INVALID_PACK), 2, "frontmatter"),
            ("Copilot pre-write {path, file_text} valid pack passes",
             copilot_write(".hatch/sme/terraform.md", _VALID_PACK), 0, None),
            ("Copilot post-edit {path} invalid pack on disk feeds back",
             {"hook_event_name": "PostToolUse", "tool_name": "Edit", "cwd": cwd,
              "tool_input": {"path": ".hatch/sme/broken.md", "old_str": "a", "new_str": "b"},
              "tool_response": {"success": True}}, 2, "frontmatter"),
            ("tool_input not a dict passes",
             {"hook_event_name": "PostToolUse", "tool_name": "Write", "cwd": cwd,
              "tool_input": "junk"}, 0, None),
            # Copilot hands PascalCase hooks the raw apply_patch body as a string
            # tool_input, under Edit or Write — judged like the dict write it makes.
            ("patch string adding an invalid pack is denied",
             patch_str("PreToolUse", "Write", "*** Add File: .hatch/sme/broken.md",
                       "+no frontmatter"), 2, "frontmatter"),
            ("patch string adding a valid pack passes",
             patch_str("PreToolUse", "Write", "*** Add File: .hatch/sme/terraform.md",
                       *("+" + line for line in _VALID_PACK.splitlines())), 0, None),
            ("patch string update of a committed invalid pack is reported",
             patch_str("PostToolUse", "Edit", "*** Update File: .hatch/sme/broken.md",
                       "@@", "+bad"), 2, "frontmatter"),
            ("patch string update outside the pack set passes",
             patch_str("PostToolUse", "Edit", "*** Update File: docs/broken.md",
                       "@@", "+bad"), 0, None),
            ("patch string with backslash pack path is denied",
             patch_str("PreToolUse", "Write", "*** Add File: .hatch\\sme\\broken.md",
                       "+bad"), 2, "frontmatter"),
            ("patch string content cannot spoof a directive",
             patch_str("PreToolUse", "Write", "*** Add File: notes.md",
                       "+*** Add File: .hatch/sme/broken.md", "+bad"), 0, None),
            ("patch string move checks the destination pack",
             patch_str("PostToolUse", "Edit", "*** Update File: notes.md",
                       "*** Move to: .hatch/sme/broken.md"), 2, "frontmatter"),
            ("patch string deletion leaves no pack to judge",
             patch_str("PostToolUse", "Edit", "*** Delete File: .hatch/sme/broken.md"),
             0, None),
            ("non-patch string tool_input passes",
             {"hook_event_name": "PreToolUse", "tool_name": "Write", "cwd": cwd,
              "tool_input": "just a string"}, 0, None),
        ]
        if os.name == "nt":
            # Spellings Windows resolves to a real pack while a literal match
            # would skip validation entirely — the unvalidated-write bypass.
            cases += [
                ("Windows: case-variant pack spelling is still validated",
                 pre_write(".Hatch/SME/terraform.md", _INVALID_PACK), 2, "frontmatter"),
                ("Windows: a trailing dot is stripped by the OS, not by the pattern",
                 pre_write(".hatch/sme/terraform.md.", _INVALID_PACK), 2, "frontmatter"),
                ("Windows: the canonical basename is what gets validated, so a "
                 "trailing-dot spelling of a valid pack still passes",
                 pre_write(".hatch/sme/terraform.md.", _VALID_PACK), 0, None),
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
    try:
        payload = json.loads(_read_stdin_text())
        code, reason = decide(payload if isinstance(payload, dict) else {})
    except Exception:  # noqa: BLE001
        return 0  # fail open: a guard-internal error must never break the tool call
    if code == 2:
        print(reason, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
