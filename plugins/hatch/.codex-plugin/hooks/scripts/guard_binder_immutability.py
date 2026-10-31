#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Codex PreToolUse guard: committed binders are read-only — live and archived.

Codex twin of hooks/scripts/guard_binder_immutability.py (the Claude Code guard).
Same rule, different payload shape: Codex file edits arrive as `apply_patch` calls
whose `tool_input.command` is the RAW PATCH BODY (`*** Add File:` / `*** Update
File:` / `*** Delete File:` / `*** Move to:` directives), never a `file_path`.
This guard parses the patch body, resolves each touched path against the payload
`cwd`, and denies (exit 2, reason on stderr) any operation that would rewrite a
binder (`.hatch/binders/*.json`, or a delivered one under
`.hatch/binders/archive/`) that already exists in HEAD:

- Update File on a committed binder — denied, with one sanctioned exception: a
  hunk-free move (`*** Move to:`) of a live binder to its own archive path
  (`.hatch/binders/archive/<same name>.json`), which is the end-of-life step.
- Add File over a path tracked in HEAD — denied (a re-add is an overwrite).
- Delete File of a committed binder — denied; archive it with `git mv` or a
  hunk-free patch move instead.
- A path that is a hard link to a committed binder (same device and inode) gets
  the same rule as the binder, since realpath does not collapse hard links.
- Untracked binder writes (plan drafting) pass, as on Claude Code.

A Claude-shaped payload (`tool_input.file_path`/`notebook_path`) is also handled,
in case a Codex build maps Write/Edit natively. Any internal error or unknown
payload shape fails open (exit 0): this guard must never break an unrelated tool
call. Keep the rule semantics in step with the Claude twin — the two files are
maintained by hand, not generated.

  guard_binder_immutability.py              # hook mode: payload on stdin, exit 0/2
  guard_binder_immutability.py --self-test  # run embedded fixtures, exit 0/1
"""
from __future__ import annotations
import argparse, json, os, re, stat, subprocess, sys
from pathlib import Path

def _read_stdin_text() -> str:
    """The hook payload is UTF-8 JSON, whatever the host's locale codec is.

    sys.stdin decodes with the locale codec — cp1252 on a stock Windows
    session — which mojibakes or raises on a payload it cannot spell. Read
    the byte stream and decode explicitly; the getattr falls back for test
    doubles that carry no .buffer."""
    data = getattr(sys.stdin, "buffer", sys.stdin).read()
    return data.decode("utf-8") if isinstance(data, bytes) else data

BINDER_RE = re.compile(r"(?:^|/)\.hatch/binders/(?:archive/)?[^/]+\.json$")
DIRECTIVE_RE = re.compile(r"^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$")


def _os_spelling(path: str, cwd: str) -> str:
    """Resolve dot segments and existing symlinks before classifying a target."""
    target = os.path.realpath(os.path.join(cwd or os.getcwd(), path))
    return os.path.normcase(target).replace(os.sep, "/")


def _binder_targets(path: str, cwd: str) -> set[str]:
    # Keep the lexical name too: overwriting a committed binder that is itself
    # a symlink must not become legal merely because its target is elsewhere.
    lexical = os.path.normcase(os.path.abspath(os.path.join(cwd or os.getcwd(), path)))
    return {p for p in (lexical.replace(os.sep, "/"), _os_spelling(path, cwd))
            if BINDER_RE.search(p)}


def _repo_top(start: str) -> str | None:
    top = subprocess.run(["git", "-C", start, "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, encoding="utf-8")
    return top.stdout.strip() if top.returncode == 0 and top.stdout.strip() else None


def _worktrees(top: str) -> list[str]:
    """`top` plus every worktree of its repository (`git worktree list --porcelain`)."""
    try:
        out = subprocess.run(["git", "-C", top, "worktree", "list", "--porcelain"],
                             capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return [top]
    if out.returncode != 0:
        return [top]
    lines = out.stdout.decode("utf-8", errors="surrogateescape").splitlines()
    return [top, *(line[len("worktree "):] for line in lines if line.startswith("worktree "))]


def _hardlinked_binder(path: str, cwd: str) -> bool:
    """Is `path` a hard link to a binder committed in HEAD?

    realpath collapses symlinks, never hard links: a second name for the binder's
    inode classifies as an ordinary file. So when the resolved target is a regular
    file with more than one link, compare its (st_dev, st_ino) with every binder
    HEAD tracks — live and archived — in every worktree of the repository of the
    working directory and of the target, and apply the binder rule on a match. A
    linked worktree holds its own copy of each tracked file, so a hard link made in
    one worktree to another worktree's binder matches only in that other worktree."""
    target = os.path.realpath(os.path.join(cwd or os.getcwd(), path))
    try:
        st = os.stat(target)
    except OSError:
        return False
    if not stat.S_ISREG(st.st_mode) or st.st_nlink < 2:
        return False
    tops = {t for t in (_repo_top(os.path.dirname(target)), _repo_top(cwd or os.getcwd())) if t}
    tops = {os.path.realpath(w) for t in tops for w in _worktrees(t)}
    for top in sorted(tops):
        listing = subprocess.run(["git", "-C", top, "ls-tree", "-r", "-z", "--name-only", "HEAD"],
                                 capture_output=True, timeout=10)
        if listing.returncode != 0:
            continue
        for rel in listing.stdout.decode("utf-8", errors="surrogateescape").split("\0"):
            if not rel or not BINDER_RE.search(rel):
                continue
            try:
                other = os.stat(os.path.join(top, rel))
            except OSError:
                continue
            if (other.st_dev, other.st_ino) == (st.st_dev, st.st_ino):
                return True
    return False


def _committed_binder(path: str, cwd: str, tracked) -> bool:
    return (any(tracked(p, cwd) for p in _binder_targets(path, cwd))
            or _hardlinked_binder(path, cwd))


def _as_patch_command(tool_input):
    """Copilot gives PascalCase hooks the raw patch string as tool_input, under
    tool_name Edit or Write. Wrap it so it takes the apply_patch path."""
    if isinstance(tool_input, str) and tool_input.lstrip().startswith("*** Begin Patch"):
        return {"command": tool_input}
    return tool_input


def parse_patch_ops(text: str) -> list[dict]:
    """apply_patch body -> [{op, path, move_to, changed}]. `changed` is True when
    the op carries content hunks (+/- lines); a pure rename has none. Content
    lines are +/- prefixed, so a file whose text contains `*** Update File:` can
    never spoof a directive."""
    ops: list[dict] = []
    cur: dict | None = None
    for line in text.splitlines():
        m = DIRECTIVE_RE.match(line)
        if m:
            # Windows models may spell patch paths with `\` separators.
            kind, path = m.group(1), m.group(2).strip().replace("\\", "/")
            if kind == "Move to":
                if cur is not None:
                    cur["move_to"] = path
            else:
                cur = {"op": kind, "path": path, "move_to": None, "changed": False}
                ops.append(cur)
            continue
        if line.startswith("*** "):
            continue  # Begin Patch / End Patch / End of File markers
        if cur is not None and line.startswith(("+", "-")):
            cur["changed"] = True
    return ops


def _tracked_in_head(path: str, cwd: str) -> bool:
    """Is `path` (as the patch names it) a blob in HEAD of its repo?"""
    abs_path = Path(os.path.abspath(os.path.join(cwd, path)))
    base = str(abs_path.parent) if abs_path.parent.is_dir() else cwd
    top = subprocess.run(["git", "-C", base, "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, encoding="utf-8")
    if top.returncode != 0:
        return False  # not a repo (or no git): nothing is committed here
    toplevel = Path(top.stdout.strip()).resolve()
    # Git prints the physical top level, so a path spelled through an alias
    # (a linked or 8.3 parent, or macOS /var -> /private/var) only matches it
    # with its folder resolved. The spelling as given still counts: a tracked folder swapped for a link to
    # an untracked one must not free the blob the patch names. The final
    # name is never resolved, so a committed link is judged as itself. When
    # the root itself is spelled through an alias, the given spelling is read
    # from the nearest parent that resolves to the top level.
    rels = []
    for candidate in (abs_path, abs_path.parent.resolve() / abs_path.name):
        try:
            rels.append(os.path.relpath(candidate, toplevel))
        except ValueError:
            pass  # another drive on Windows: not in this repo
    for parent in abs_path.parents:
        if parent.resolve() == toplevel:
            rels.append(os.path.relpath(abs_path, parent))
            break
    for rel in dict.fromkeys(rels):
        if rel.startswith(".."):
            continue  # outside the repo the tool call runs in
        out = subprocess.run(["git", "-C", str(toplevel), "ls-tree", "HEAD", "--", rel],
                             capture_output=True, text=True, encoding="utf-8")
        if out.returncode == 0 and out.stdout.strip():
            return True
    return False


def _archive_dst(src_norm: str) -> str | None:
    """The one sanctioned move target for a live binder: its own archive path."""
    m = re.match(r"^(?P<prefix>.*\.hatch/binders/)(?P<name>[^/]+\.json)$", src_norm)
    if not m:
        return None
    return m.group("prefix") + "archive/" + m.group("name")


def _deny(path: str, what: str) -> tuple[int, str]:
    return 2, (
        f"hatch: committed binders are read-only. This patch would {what} '{path}', which "
        "already exists in HEAD — a committed binder is the plan of record hatch-deliver "
        "derives the whole run's state from, so mutating it mid-flight desynchronizes the "
        "run and its resume story; an archived binder (.hatch/binders/archive/) is delivered "
        "history and is never edited. To change the plan, re-plan with hatch-plan (which "
        "writes a fresh binder file) or draft a new, not-yet-committed binder. The one "
        "sanctioned mutation is the end-of-life archive move: `git mv` the live binder to "
        ".hatch/binders/archive/<same name>.json, or use a hunk-free patch move to exactly "
        "that path.")


def decide(payload: dict, tracked=_tracked_in_head) -> tuple[int, str]:
    """Return (exit_code, stderr_reason). `tracked` is injectable for the self-test."""
    tool_input = _as_patch_command(payload.get("tool_input"))
    if not isinstance(tool_input, dict):
        return 0, ""
    cwd = payload.get("cwd") or os.getcwd()

    # Claude-shaped fallback: a direct file_path write, should a Codex build send one.
    # `path` is the Copilot CLI spelling (Write {path, file_text}, Edit {path,
    # old_str, new_str}): this script also serves Copilot's plugin hooks.
    for key in ("file_path", "notebook_path", "path"):
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip():
            if _committed_binder(val, cwd, tracked):
                return _deny(val, "overwrite")
            return 0, ""

    raw = tool_input.get("command")
    if isinstance(raw, list):
        raw = "\n".join(x for x in raw if isinstance(x, str))
    if not isinstance(raw, str) or "*** " not in raw:
        return 0, ""
    for op in parse_patch_ops(raw):
        # The canonical spellings do all the matching and comparing below; the
        # deny reasons keep op["path"] so the message names what was typed.
        src = _os_spelling(op["path"], cwd)
        dst = (_os_spelling(op["move_to"], cwd)
               if isinstance(op["move_to"], str) else None)
        # _committed_binder covers a binder spelling and a hard link to a binder alike.
        if op["op"] == "Add File":
            if _committed_binder(op["path"], cwd, tracked):
                return _deny(op["path"], "re-add (overwrite)")
        elif op["op"] == "Delete File":
            if _committed_binder(op["path"], cwd, tracked):
                return _deny(op["path"], "delete")
        elif op["op"] == "Update File":
            if _committed_binder(op["path"], cwd, tracked):
                if dst and dst == _archive_dst(src) and not op["changed"]:
                    continue  # the sanctioned end-of-life archive move
                return _deny(op["path"], "rewrite")
            if dst and _committed_binder(op["move_to"], cwd, tracked):
                return _deny(dst, "move another file over")
    return 0, ""


def _run_self_test() -> int:
    tracked = lambda path, cwd: True     # noqa: E731
    untracked = lambda path, cwd: False  # noqa: E731

    def patch(*lines: str) -> dict:
        body = "\n".join(("*** Begin Patch", *lines, "*** End Patch"))
        return {"hook_event_name": "PreToolUse", "tool_name": "apply_patch",
                "cwd": "/tmp", "tool_input": {"command": body}}

    cases = [
        ("non-binder patch passes",
         patch("*** Update File: src/app.py", "@@", "-a", "+b"), tracked, 0),
        ("update of tracked binder denied",
         patch("*** Update File: .hatch/binders/checkout.json", "@@", "-a", "+b"),
         tracked, 2),
        ("update of untracked binder draft passes",
         patch("*** Update File: .hatch/binders/draft.json", "@@", "+x"), untracked, 0),
        ("add of new binder draft passes",
         patch("*** Add File: .hatch/binders/new-plan.json", "+{}"), untracked, 0),
        ("re-add over tracked binder denied",
         patch("*** Add File: .hatch/binders/checkout.json", "+{}"), tracked, 2),
        ("delete of tracked binder denied",
         patch("*** Delete File: .hatch/binders/checkout.json"), tracked, 2),
        ("hunk-free archive move passes",
         patch("*** Update File: .hatch/binders/checkout.json",
               "*** Move to: .hatch/binders/archive/checkout.json"), tracked, 0),
        ("archive move with content hunks denied",
         patch("*** Update File: .hatch/binders/checkout.json",
               "*** Move to: .hatch/binders/archive/checkout.json", "@@", "+x"),
         tracked, 2),
        ("move of tracked binder to a non-archive path denied",
         patch("*** Update File: .hatch/binders/checkout.json",
               "*** Move to: docs/checkout.json"), tracked, 2),
        ("move of tracked binder to a renamed archive path denied",
         patch("*** Update File: .hatch/binders/checkout.json",
               "*** Move to: .hatch/binders/archive/renamed.json"), tracked, 2),
        ("move of tracked archived binder denied (archive is history)",
         patch("*** Update File: .hatch/binders/archive/done.json",
               "*** Move to: .hatch/binders/done.json"), tracked, 2),
        ("move of another file over a tracked binder denied",
         patch("*** Update File: notes.json",
               "*** Move to: .hatch/binders/checkout.json"), tracked, 2),
        ("update of tracked archived binder denied",
         patch("*** Update File: .hatch/binders/archive/done.json", "@@", "+x"),
         tracked, 2),
        ("binder-like path elsewhere passes",
         patch("*** Update File: docs/hatch/binders-history.json", "+x"), tracked, 0),
        ("non-json under binders passes",
         patch("*** Update File: .hatch/binders/notes.md", "+x"), tracked, 0),
        ("deeper subdir under archive passes (only archive/ is a binder home)",
         patch("*** Update File: .hatch/binders/archive/nested/x.json", "+x"),
         tracked, 0),
        ("nested binder dir path still matches",
         patch("*** Update File: sub/.hatch/binders/x.json", "+x"), tracked, 2),
        ("content line spelling a directive cannot spoof one",
         patch("*** Update File: src/app.py",
               "+*** Update File: .hatch/binders/checkout.json"), tracked, 0),
        ("multi-op patch: clean op then binder op denied",
         patch("*** Update File: src/app.py", "+x",
               "*** Update File: .hatch/binders/checkout.json", "+y"), tracked, 2),
        ("command as list is normalized",
         {"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "cwd": "/tmp",
          "tool_input": {"command": ["apply_patch",
                                     "*** Begin Patch\n*** Update File: "
                                     ".hatch/binders/checkout.json\n+x\n*** End Patch"]}},
         tracked, 2),
        ("Claude-shaped file_path payload on tracked binder denied",
         {"hook_event_name": "PreToolUse", "tool_name": "Write", "cwd": "/tmp",
          "tool_input": {"file_path": ".hatch/binders/checkout.json", "content": "{}"}},
         tracked, 2),
        ("Claude-shaped file_path payload on untracked draft passes",
         {"hook_event_name": "PreToolUse", "tool_name": "Write", "cwd": "/tmp",
          "tool_input": {"file_path": ".hatch/binders/new.json", "content": "{}"}},
         untracked, 0),
        ("Copilot Edit {path, old_str, new_str} on tracked binder denied",
         {"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": "/tmp",
          "tool_input": {"path": ".hatch/binders/checkout.json",
                         "old_str": "a", "new_str": "b"}},
         tracked, 2),
        ("Copilot Write {path, file_text} on tracked binder denied",
         {"hook_event_name": "PreToolUse", "tool_name": "Write", "cwd": "/tmp",
          "tool_input": {"path": ".hatch/binders/checkout.json", "file_text": "{}"}},
         tracked, 2),
        ("Copilot Write {path, file_text} on untracked draft passes",
         {"hook_event_name": "PreToolUse", "tool_name": "Write", "cwd": "/tmp",
          "tool_input": {"path": ".hatch/binders/draft.json", "file_text": "{}"}},
         untracked, 0),
        ("Copilot Edit {path, old_str, new_str} on untracked draft passes",
         {"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": "/tmp",
          "tool_input": {"path": ".hatch/binders/draft.json",
                         "old_str": "a", "new_str": "b"}},
         untracked, 0),
        # Copilot hands PascalCase hooks the raw patch string itself as tool_input,
        # under tool_name Edit or Write (seen on the Windows PC, 2026-10-03).
        ("Copilot raw patch string updating tracked binder denied",
         {**patch("*** Update File: .hatch/binders/checkout.json", "@@", "-a", "+b"),
          "tool_name": "Edit",
          "tool_input": "*** Begin Patch\n*** Update File: .hatch/binders/checkout.json"
                        "\n@@\n-a\n+b\n*** End Patch"}, tracked, 2),
        ("Copilot raw patch string re-adding tracked binder denied",
         {**patch(), "tool_name": "Write",
          "tool_input": "*** Begin Patch\n*** Add File: .hatch/binders/checkout.json"
                        "\n+{}\n*** End Patch\n"}, tracked, 2),
        ("Copilot raw patch string on untracked draft passes",
         {**patch(), "tool_name": "Edit",
          "tool_input": "*** Begin Patch\n*** Update File: .hatch/binders/draft.json"
                        "\n@@\n+x\n*** End Patch"}, untracked, 0),
        ("patch path with backslash separators denied on tracked binder",
         patch("*** Update File: .hatch\\binders\\checkout.json", "@@", "-a", "+b"),
         tracked, 2),
        ("no command and no file_path passes",
         {"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "cwd": "/tmp",
          "tool_input": {}}, tracked, 0),
        ("tool_input not a dict passes",
         {"hook_event_name": "PreToolUse", "tool_name": "apply_patch",
          "tool_input": "junk"}, tracked, 0),
    ]
    if os.name == "nt":
        # The spellings Windows resolves to the protected file while a literal
        # match waves them through. 8.3 short names (HATCH~1) are covered by the
        # same realpath call but need the component to exist, so they have no
        # portable fixture here.
        cases += [
            ("Windows: case-variant patch spelling reaches the same binder — denied",
             patch("*** Update File: .Hatch/Binders/checkout.json", "@@", "-a", "+b"),
             tracked, 2),
            ("Windows: a trailing dot is stripped by the OS, not by the pattern — denied",
             patch("*** Update File: .hatch/binders/checkout.json.", "@@", "-a", "+b"),
             tracked, 2),
            ("Windows: case-variant file_path spelling — denied",
             {"hook_event_name": "PreToolUse", "tool_name": "Write", "cwd": "/tmp",
              "tool_input": {"file_path": ".Hatch/binders/checkout.json ",
                             "content": "{}"}}, tracked, 2),
        ]
    failures = 0
    for name, payload, probe, want in cases:
        code, reason = decide(payload, tracked=probe)
        ok = code == want and (want == 0) == (reason == "")
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
        failures += 0 if ok else 1

    # real git roundtrip: a committed binder denies, a fresh draft next to it passes
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        repo = Path(td)

        def git(*a: str) -> None:
            subprocess.run(["git", "-C", str(repo), *a], capture_output=True, text=True, encoding="utf-8")

        git("init", "-q")
        (repo / ".hatch" / "binders").mkdir(parents=True)
        (repo / ".hatch" / "binders" / "committed.json").write_text("{}\n", encoding="utf-8")
        # A committed binder that is itself a symlink, pointing at a file HEAD does
        # not hold: only a probe that keeps the leaf unresolved reports it tracked.
        symlinked = True
        try:
            os.symlink("draft.json", repo / ".hatch" / "binders" / "linked.json")
        except (OSError, NotImplementedError):
            symlinked = False  # no symlinks on this filesystem or account
        git("add", ".")
        git("-c", "user.email=hatch@test", "-c", "user.name=hatch", "commit", "-q", "-m", "seed")
        (repo / ".hatch" / "binders" / "draft.json").write_text("{}\n", encoding="utf-8")
        # A linked worktree holds its own copies: a hard link made there to the main
        # checkout's binder must still meet the binder rule; one to a non-binder not.
        (repo / "notes.txt").write_text("x\n", encoding="utf-8")
        git("add", "notes.txt")
        git("-c", "user.email=hatch@test", "-c", "user.name=hatch", "commit", "-q", "-m", "notes")
        wt = Path(td) / "wt"
        git("worktree", "add", "-q", str(wt), "HEAD")
        linked = True
        try:
            os.link(repo / ".hatch" / "binders" / "committed.json", wt / "alias.json")
            os.link(repo / "notes.txt", wt / "notes-alias.txt")
        except OSError:
            linked = False  # no hard links on this filesystem: nothing to alias

        git_cases = [
            ("git: committed binder update denied",
             ".hatch/binders/committed.json", 2),
            ("git: untracked draft update passes", ".hatch/binders/draft.json", 0),
        ]
        git_cases = [(n, rel, want, repo) for n, rel, want in git_cases]
        if linked:
            git_cases += [
                ("git: hard link in a linked worktree to the main checkout's binder denied",
                 "alias.json", 2, wt),
                ("git: hard link in a linked worktree to a non-binder passes",
                 "notes-alias.txt", 0, wt),
            ]
        for name, rel, want, where in git_cases:
            body = f"*** Begin Patch\n*** Update File: {rel}\n@@\n+x\n*** End Patch"
            payload = {"hook_event_name": "PreToolUse", "tool_name": "apply_patch",
                       "cwd": str(where), "tool_input": {"command": body}}
            code, _ = decide(payload)
            ok = code == want
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
            failures += 0 if ok else 1

        # _tracked_in_head directly: decide() also tries the realpath spelling, so
        # it would hide a probe that compares a lexical alias path with git's
        # symlink-resolved toplevel. These pin the probe itself.
        direct_cases = [
            ("direct: a path whose parent directory does not exist is untracked",
             "no/such/dir/x.json", repo, False),
        ]
        if symlinked:
            alias = Path(td) / "alias"
            os.symlink(repo, alias, target_is_directory=True)
            direct_cases += [
                ("direct: committed binder reached through a symlinked alias dir is tracked",
                 ".hatch/binders/committed.json", alias, True),
                ("direct: committed binder that is itself a symlink leaf is tracked",
                 ".hatch/binders/linked.json", alias, True),
            ]
        for name, rel, where, want in direct_cases:
            got = _tracked_in_head(rel, str(where))
            ok = got is want
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: {got}")
            failures += 0 if ok else 1

    total = len(cases) + len(git_cases) + len(direct_cases)
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
