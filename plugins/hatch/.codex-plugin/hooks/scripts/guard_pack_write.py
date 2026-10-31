#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Pre/PostToolUse guard: stack packs land only validator-clean.

Zero dependencies (pure stdlib). The harness invokes this with the hook payload
JSON on stdin. Targets under `.hatch/sme/*.md` pass through one rule:

Validator-clean (`skills/hatch-kaizen/scripts/validate_packs.py`, resolved via
PLUGIN_ROOT or CLAUDE_PLUGIN_ROOT, falling back to this script's own plugin root):
  - PreToolUse `Write`: the proposed content is validated from a temp file; a
    failure denies the write (exit 2, findings on stderr).
  - PostToolUse `Edit`/`Write`: the file on disk is validated; a failure exits 2
    with the findings on stderr AND as exactly one stdout JSON line,
    `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext":
    <findings>}}`, so Copilot injects them into the model's context as feedback
    it must fix. PreToolUse denies and clean passes print nothing to stdout.

The Write-preventive / Edit-corrective asymmetry is deliberate: PreToolUse fires on
`Write` (deny before a malformed pack lands), PostToolUse on `Edit`|`Write` (diagnose
a malformed pack the model just wrote).
Codex `apply_patch` additions carry complete content and are checked before the
write. Updates and moves are checked on disk after the patch, including every
destination in a multi-file patch. Deletions leave no pack to validate.

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
DIRECTIVE_RE = re.compile(r"^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$")


def _resolve_rel(rel: Path) -> Path | None:
    """Resolve from host roots, then the nearest enclosing plugin manifest."""
    roots: list[Path] = []
    for key in ("PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"):
        env = os.environ.get(key)
        if env:
            roots.append(Path(env))
    for parent in Path(__file__).resolve().parents:
        if (parent / ".codex-plugin" / "plugin.json").is_file():
            roots.append(parent)
            break
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


def _patch_writes(raw: str) -> list[dict]:
    """Extract final destinations and complete Add File content, never edit deltas."""
    writes: list[dict] = []
    current: dict | None = None
    # Codex splits LF/CRLF lines, not Python's additional Unicode/control separators.
    for line in raw.split("\n"):
        line = line.removesuffix("\r")
        match = DIRECTIVE_RE.match(line)
        if match:
            kind, path = match.groups()
            if kind == "Move to":
                if current is not None:
                    current["file_path"] = path.strip()
            elif kind == "Delete File":
                current = None
            else:
                current = {"file_path": path.strip()}
                if kind == "Add File":
                    current["content"] = ""
                writes.append(current)
        elif current is not None and "content" in current and line.startswith("+"):
            current["content"] += line[1:] + "\n"
    return writes


def decide(payload: dict) -> tuple[int, str]:
    """Return (exit_code, stderr_message)."""
    tool_input = payload.get("tool_input")
    if isinstance(tool_input, str) and tool_input.lstrip().startswith("*** Begin Patch"):
        # Copilot gives PascalCase hooks the raw patch string, under Edit or Write.
        tool_input = {"command": tool_input}
        payload = {**payload, "tool_name": "apply_patch", "tool_input": tool_input}
    if payload.get("tool_name") == "apply_patch" and isinstance(tool_input, dict):
        raw = tool_input.get("command")
        if not isinstance(raw, str):
            return 0, ""
        findings: list[str] = []
        for write in _patch_writes(raw):
            code, reason = decide({**payload, "tool_input": write,
                                   "tool_name": "Write" if "content" in write else "Edit"})
            if code == 2:
                findings.append(reason)
        return (2, "\n\n".join(findings)) if findings else (0, "")
    target = tool_input.get("file_path") if isinstance(tool_input, dict) else None
    if not isinstance(target, str) and isinstance(tool_input, dict):
        # Copilot CLI spells the target `path` (Write {path, file_text}, Edit {path, ...}).
        target = tool_input.get("path")
    if not isinstance(target, str):
        return 0, ""
    cwd = payload.get("cwd") or os.getcwd()
    target_path = Path(target.replace("\\", "/"))
    abs_target = target_path if target_path.is_absolute() else Path(cwd) / target_path
    # On Windows both forms are matched in the OS's own equivalence: abspath()
    # already strips the trailing dots and spaces a write would strip, resolve()
    # returns existing components in their true long-name casing (and expands
    # 8.3 short names like HATCH~1), and the lowercase fold covers what does
    # not exist yet. Without this, `.Hatch/sme/x.md` or `x.md.` reaches a real
    # pack with no validation at all. POSIX matches the typed spelling — there
    # it IS what open() opens.
    fold = (lambda s: s.lower()) if os.name == "nt" else (lambda s: s)
    logical_target = Path(os.path.abspath(abs_target))
    if not PACK_RE.search(fold(logical_target.as_posix())):
        # An alias into packs is a pack write too. Preserve logical pack paths
        # otherwise: .hatch/sme may itself be a symlink to shared pack storage.
        abs_target = abs_target.resolve()
        if not PACK_RE.search(fold(abs_target.as_posix())):
            return 0, ""
    validator = _validator_path()
    if validator is None:
        return 0, ""  # fail open: no validator to consult
    # The canonical basename (dot/space cleanup via abspath, NTFS case fold), so
    # a `terraform.md.` write is validated as the `terraform.md` the OS creates.
    basename = fold(logical_target.name)

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
    # The logical (dot/space-cleaned) path names the file the write actually made;
    # handing the validator a dotted spelling would fail its basename check.
    disk_target = logical_target if logical_target.is_file() else abs_target
    if not disk_target.is_file():
        return 0, ""
    rc, findings = _run_validator(validator, disk_target)
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
    # Do not let an installed plugin's environment mask a broken checkout fallback.
    from unittest.mock import patch
    with patch.dict(os.environ, {}, clear=True):
        if _validator_path() is None:
            print("[FAIL] validator not resolvable without plugin environment")
            return 1
    if _validator_path() is None:
        print("[FAIL] validator not resolvable (skills/hatch-kaizen/scripts/validate_packs.py)")
        print("\n0/1 checks passed")
        return 1

    with tempfile.TemporaryDirectory() as td:
        cwd = str(td)
        # A damaged install must not discover a validator outside its own package.
        plugin = Path(td) / "plugin"
        (plugin / ".codex-plugin").mkdir(parents=True)
        (plugin / ".codex-plugin/plugin.json").write_text('{}\n', encoding="utf-8")
        decoy = Path(td) / VALIDATOR_REL
        decoy.parent.mkdir(parents=True)
        decoy.write_text("# unrelated ancestor validator\n", encoding="utf-8")
        with patch.dict(os.environ, {}, clear=True), patch.dict(
                globals(), {"__file__": str(plugin / ".codex-plugin/hooks/scripts/guard_pack_write.py")}):
            if _validator_path() is not None:
                print("[FAIL] missing packaged validator escaped its plugin root")
                return 1
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

        def codex(event: str, *lines: str) -> dict:
            return {"hook_event_name": event, "tool_name": "apply_patch", "cwd": cwd,
                    "tool_input": {"command": "\n".join(
                        ("*** Begin Patch", *lines, "*** End Patch"))}}

        cases = [
            ("Codex control separators stay in added content and are validated",
             codex("PreToolUse", "*** Add File: .hatch/sme/terraform.md",
                   *("+" + line for line in _VALID_PACK.splitlines()), "+\x0bgarbage"),
             2, "checklist"),
            ("Codex normalized destination outside packs passes",
             codex("PreToolUse", "*** Add File: .hatch/sme/../../notes.md", "+ordinary note"),
             0, None),
            ("Codex normalized destination inside packs is checked",
             codex("PreToolUse", "*** Add File: .hatch/elsewhere/../sme/broken.md", "+bad"),
             2, "frontmatter"),
            ("Codex post-add checks actual disk content",
             codex("PostToolUse", "*** Add File: .hatch/sme/broken.md",
                   *("+" + line for line in _VALID_PACK.splitlines())), 2, "frontmatter"),
            ("Codex invalid addition denied before writing",
             codex("PreToolUse", "*** Add File: .hatch/sme/broken.md", "+no frontmatter"),
             2, "frontmatter"),
            ("Codex valid addition passes",
             codex("PreToolUse", "*** Add File: .hatch/sme/terraform.md",
                   *("+" + line for line in _VALID_PACK.splitlines())), 0, None),
            ("Codex update deferred to post hook",
             codex("PreToolUse", "*** Update File: .hatch/sme/broken.md", "@@", "+bad"),
             0, None),
            ("Codex invalid update reported from disk",
             codex("PostToolUse", "*** Update File: .hatch/sme/broken.md", "@@", "+bad"),
             2, "frontmatter"),
            ("Codex multi-file patch checks later pack",
             codex("PostToolUse", "*** Update File: README.md", "@@", "+ok",
                   "*** Update File: .hatch/sme/broken.md", "@@", "+bad"), 2, "frontmatter"),
            ("Codex move checks destination",
             codex("PostToolUse", "*** Update File: notes.md",
                   "*** Move to: .hatch/sme/broken.md"), 2, "frontmatter"),
            ("Codex deletion has no resulting pack",
             codex("PostToolUse", "*** Delete File: .hatch/sme/broken.md"), 0, None),
            ("Codex content cannot spoof a directive",
             codex("PreToolUse", "*** Add File: notes.md",
                   "+*** Add File: .hatch/sme/broken.md", "+bad"), 0, None),
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
            # Copilot hands PascalCase hooks the raw patch string itself as tool_input.
            ("Copilot raw patch string adding invalid pack denied",
             {**codex("PreToolUse", "*** Add File: .hatch/sme/broken.md", "+bad"),
              "tool_name": "Edit",
              "tool_input": "*** Begin Patch\n*** Add File: .hatch/sme/broken.md"
                            "\n+bad\n*** End Patch"}, 2, "frontmatter"),
            ("Copilot raw patch string update reported from disk",
             {**codex("PostToolUse"), "tool_name": "Edit",
              "tool_input": "*** Begin Patch\n*** Update File: .hatch/sme/broken.md"
                            "\n@@\n+bad\n*** End Patch"}, 2, "frontmatter"),
            ("patch path with backslash separators is checked",
             codex("PreToolUse", "*** Add File: .hatch\\sme\\broken.md", "+bad"),
             2, "frontmatter"),
        ]
        crlf = codex("PreToolUse", "*** Add File: .hatch/sme/terraform.md",
                     *("+" + line for line in _VALID_PACK.splitlines()))
        crlf["tool_input"]["command"] = crlf["tool_input"]["command"].replace("\n", "\r\n")
        cases.append(("Codex CRLF patch keeps valid added content", crlf, 0, None))

        linked = Path(td) / "linked"
        (linked / ".hatch").mkdir(parents=True)
        shared = Path(td) / "shared-packs"
        shared.mkdir()
        (shared / "broken.md").write_text(_INVALID_PACK, encoding="utf-8")
        (shared / "terraform.md").write_text(_VALID_PACK, encoding="utf-8")
        try:
            (linked / ".hatch/sme").symlink_to(shared, target_is_directory=True)
            (Path(td) / "alias").symlink_to(sme, target_is_directory=True)
            (sme / "alias.md").symlink_to(shared / "terraform.md")
        except OSError:
            if sys.platform != "win32":
                raise
            print("[SKIP] symlink fixtures require Windows symlink privileges")
        else:
            cases.extend([
                ("Codex pre-add into symlinked pack directory denied",
                 {**codex("PreToolUse", "*** Add File: .hatch/sme/broken.md", "+bad"),
                  "cwd": str(linked)}, 2, "frontmatter"),
                ("Codex post-add into symlinked pack directory reported",
                 {**codex("PostToolUse", "*** Add File: .hatch/sme/broken.md", "+bad"),
                  "cwd": str(linked)}, 2, "frontmatter"),
                ("legacy Write into symlinked pack directory denied",
                 {**pre_write(".hatch/sme/broken.md", _INVALID_PACK),
                  "cwd": str(linked)}, 2, "frontmatter"),
                ("valid pack in symlinked directory passes",
                 {**post("Write", ".hatch/sme/terraform.md"), "cwd": str(linked)}, 0, None),
                ("alias into pack directory is validated",
                 pre_write("alias/broken.md", _INVALID_PACK), 2, "frontmatter"),
                ("pack file symlink retains logical basename check",
                 post("Write", ".hatch/sme/alias.md"), 2, "basename"),
            ])
        if os.name == "nt":
            # Spellings Windows resolves to a real pack while a literal match
            # would skip validation entirely — the unvalidated-write bypass.
            cases.extend([
                ("Windows: case-variant pack spelling is still validated",
                 pre_write(".Hatch/SME/terraform.md", _INVALID_PACK), 2, "frontmatter"),
                ("Windows: a trailing dot is stripped by the OS, not by the pattern",
                 pre_write(".hatch/sme/terraform.md.", _INVALID_PACK), 2, "frontmatter"),
                ("Windows: the canonical basename is what gets validated, so a "
                 "trailing-dot spelling of a valid pack still passes",
                 pre_write(".hatch/sme/terraform.md.", _VALID_PACK), 0, None),
            ])
        failures = 0
        for name, payload, want, needle in cases:
            code, msg = decide(payload)
            ok = code == want and (needle is None or needle in msg)
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
            failures += 0 if ok else 1

        # Hook-mode stdout is parsed by Copilot: exactly one JSON line on a
        # PostToolUse finding, nothing on a PreToolUse deny or a clean pass.
        import io

        def run_hook(payload: dict) -> tuple[int, str, str]:
            stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode("utf-8")))
            out, err = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", ["guard_pack_write.py"]), \
                    patch.object(sys, "stdin", stdin), \
                    patch.object(sys, "stdout", out), patch.object(sys, "stderr", err):
                code = main()
            return code, out.getvalue(), err.getvalue()

        def post_context_ok(code: int, out: str, err: str) -> bool:
            lines = out.splitlines()
            if code != 2 or len(lines) != 1 or not out.endswith("\n"):
                return False
            obj = json.loads(lines[0])
            hso = obj.get("hookSpecificOutput", {}) if isinstance(obj, dict) else {}
            return (list(obj) == ["hookSpecificOutput"]
                    and hso.get("hookEventName") == "PostToolUse"
                    and hso.get("additionalContext") == err.rstrip("\n")
                    and "frontmatter" in err)

        stdout_cases = [
            ("PostToolUse finding emits one additionalContext JSON line",
             post("Edit", ".hatch/sme/broken.md"), post_context_ok),
            ("PreToolUse deny keeps stdout empty",
             pre_write(".hatch/sme/terraform.md", _INVALID_PACK),
             lambda c, o, e: c == 2 and o == "" and "frontmatter" in e),
            ("clean pass keeps stdout and stderr empty",
             post("Write", ".hatch/sme/terraform.md"),
             lambda c, o, e: c == 0 and o == "" and e == ""),
        ]
        for name, payload, check in stdout_cases:
            code, out, err = run_hook(payload)
            try:
                ok = check(code, out, err)
            except ValueError:
                ok = False
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
            failures += 0 if ok else 1
        cases.extend(stdout_cases)

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
        if payload.get("hook_event_name") == "PostToolUse":
            # One ASCII-escaped JSON line: Copilot injects additionalContext
            # into the model's context. PreToolUse relies on exit 2 alone.
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PostToolUse", "additionalContext": reason}}))
    return code


if __name__ == "__main__":
    sys.exit(main())
