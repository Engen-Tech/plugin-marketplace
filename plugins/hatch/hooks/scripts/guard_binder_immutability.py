#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""PreToolUse guard: committed binders are read-only — live and archived.

Zero dependencies (pure stdlib). The harness invokes this on Write|Edit|NotebookEdit
with the hook payload JSON on stdin. If the target path is a binder
(`.hatch/binders/*.json`, or a delivered one under `.hatch/binders/archive/`) that
already exists in HEAD, the write is denied — exit 2 with the reason on stderr. The
target is judged by its lexical name, its symlink-resolved name, and — for a regular
file with more than one link — its inode, so a hard link to a committed binder is
denied like the binder itself. A
committed live binder is the plan of record hatch-deliver derives run state from, so
mutating it mid-flight desynchronizes the run; an archived binder is delivered
history and is never edited. Untracked binder writes (plan drafting) pass. Any
internal error fails open (exit 0): this guard must never break an unrelated tool
call.

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
    tool_name Edit or Write (Codex sends it as apply_patch). Wrap it so it takes
    the patch path; any other string passes through unchanged."""
    if isinstance(tool_input, str) and tool_input.lstrip().startswith("*** Begin Patch"):
        return {"command": tool_input}
    return tool_input


def parse_patch_ops(text: str) -> list[dict]:
    """apply_patch body -> [{op, path, move_to, changed}]. `changed` is True when
    the op carries content hunks (+/- lines); a pure rename has none. Content
    lines are +/- prefixed, so a file whose text contains `*** Update File:` can
    never spoof a directive. Kept in step with the Codex twin by hand."""
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


def _target_path(tool_input: dict) -> str | None:
    # `path` is the Copilot CLI spelling (Write {path, file_text}, Edit {path,
    # old_str, new_str}); without it every Copilot edit reads as targetless.
    for key in ("file_path", "notebook_path", "path"):
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip():
            return val
    return None


def _tracked_in_head(path: str, cwd: str) -> bool:
    """Is `path` (as the tool call names it) a blob in HEAD of its repo?"""
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
    # an untracked one must not free the blob the tool call names. The final
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


def decide(payload: dict, tracked=_tracked_in_head) -> tuple[int, str]:
    """Return (exit_code, stderr_reason). `tracked` is injectable for the self-test."""
    tool_input = _as_patch_command(payload.get("tool_input"))
    if not isinstance(tool_input, dict):
        return 0, ""
    cwd = payload.get("cwd") or os.getcwd()
    target = _target_path(tool_input)
    if target:
        targets = [target]
    else:
        # A patch body: judge every path an op touches, move targets included,
        # by the same committed-binder rule as a direct file_path edit.
        raw = tool_input.get("command")
        ops = parse_patch_ops(raw) if isinstance(raw, str) else []
        targets = [p for op in ops for p in (op["path"], op["move_to"]) if p]
    target = next((t for t in targets if _committed_binder(t, cwd, tracked)), None)
    if not target:
        return 0, ""  # untracked draft — plan-time binder writing is allowed
    return 2, (
        f"hatch: committed binders are read-only. '{target}' already exists in HEAD, and a "
        "committed binder is the plan of record — hatch-deliver derives the whole run's state "
        "from it plus its git refs, so mutating it mid-flight desynchronizes the run and its "
        "resume story; an archived binder (.hatch/binders/archive/) is delivered history and "
        "is never edited. To change the plan, re-plan with hatch-plan (which writes a fresh "
        "binder file) or draft a new, not-yet-committed binder; writes to untracked binder "
        "drafts are not blocked. If nothing has been delivered from this binder and the plan "
        "is simply wrong — a retroactive review rejected it, say — withdraw it: commit the "
        "deletion of this file, then commit the corrected plan (the same slug is fine) with "
        "its review record. Never rewrite history to edit a binder in place.")


def _run_self_test() -> int:
    tracked = lambda path, cwd: True     # noqa: E731
    untracked = lambda path, cwd: False  # noqa: E731

    def pre(tool: str, **ti) -> dict:
        return {"hook_event_name": "PreToolUse", "tool_name": tool,
                "cwd": "/tmp", "tool_input": ti}

    cases = [
        ("non-binder write passes",
         pre("Write", file_path="src/app.py", content="x"), tracked, 0),
        ("tracked binder write denied",
         pre("Write", file_path=".hatch/binders/checkout.json", content="{}"), tracked, 2),
        ("tracked binder edit denied (absolute path)",
         pre("Edit", file_path="/repo/.hatch/binders/checkout.json",
             old_string="a", new_string="b"), tracked, 2),
        ("tracked binder notebook edit denied",
         pre("NotebookEdit", notebook_path=".hatch/binders/checkout.json"), tracked, 2),
        ("untracked binder draft passes",
         pre("Write", file_path=".hatch/binders/new-plan.json", content="{}"), untracked, 0),
        ("non-json under binders passes",
         pre("Write", file_path=".hatch/binders/notes.md", content="x"), tracked, 0),
        ("binder-like path elsewhere passes",
         pre("Write", file_path="docs/hatch/binders-history.json", content="x"), tracked, 0),
        ("nested binder dir path still matches",
         pre("Write", file_path="sub/.hatch/binders/x.json", content="{}"), tracked, 2),
        ("tracked archived binder write denied",
         pre("Write", file_path=".hatch/binders/archive/done.json", content="{}"), tracked, 2),
        ("untracked archive draft passes",
         pre("Write", file_path=".hatch/binders/archive/new.json", content="{}"), untracked, 0),
        ("deeper subdir under binders passes (only archive/ is a binder home)",
         pre("Write", file_path=".hatch/binders/archive/nested/x.json", content="{}"), tracked, 0),
        ("Copilot Write {path, file_text} on tracked binder denied",
         pre("Write", path=".hatch/binders/checkout.json", file_text="{}"), tracked, 2),
        ("Copilot Edit {path, old_str, new_str} on tracked binder denied",
         pre("Edit", path=".hatch/binders/checkout.json", old_str="a", new_str="b"),
         tracked, 2),
        ("Copilot Write {path, file_text} on untracked draft passes",
         pre("Write", path=".hatch/binders/draft.json", file_text="{}"), untracked, 0),
        ("Copilot Edit {path, old_str, new_str} on untracked draft passes",
         pre("Edit", path=".hatch/binders/draft.json", old_str="a", new_str="b"),
         untracked, 0),
        ("no target path passes", pre("Write", content="x"), tracked, 0),
        ("non-patch string tool_input passes",
         {"hook_event_name": "PreToolUse", "tool_name": "Write", "tool_input": "junk"},
         tracked, 0),
        ("patch-string Delete File of tracked binder denied",
         {"hook_event_name": "PreToolUse", "tool_name": "apply_patch", "cwd": "/tmp",
          "tool_input": "*** Begin Patch\n*** Delete File: .hatch/binders/x.json\n*** End Patch"},
         tracked, 2),
        ("patch-string directive inside file content cannot spoof an op",
         {"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": "/tmp",
          "tool_input": "*** Begin Patch\n*** Update File: src/app.py\n@@\n"
                        "+*** Update File: .hatch/binders/x.json\n*** End Patch"},
         tracked, 0),
        ("patch-string Move to over a tracked binder denied",
         {"hook_event_name": "PreToolUse", "tool_name": "Edit", "cwd": "/tmp",
          "tool_input": "*** Begin Patch\n*** Update File: notes.json\n"
                        "*** Move to: .hatch/binders/x.json\n*** End Patch"},
         tracked, 2),
    ]
    if os.name == "nt":
        # The spellings Windows resolves to the protected file while a literal
        # match waves them through. 8.3 short names (HATCH~1) are covered by the
        # same realpath call but need the component to exist, so they have no
        # portable fixture here — the probe above is the evidence.
        cases += [
            ("Windows: case-variant spelling reaches the same binder — denied",
             pre("Write", file_path=".Hatch/Binders/checkout.json", content="{}"),
             tracked, 2),
            ("Windows: a trailing dot is stripped by the OS, not by the pattern — denied",
             pre("Write", file_path=".hatch/binders/checkout.json.", content="{}"),
             tracked, 2),
            ("Windows: a trailing space likewise — denied",
             pre("Write", file_path=".hatch/binders/checkout.json ", content="{}"),
             tracked, 2),
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
            ("git: committed binder denied across path aliases",
             ".hatch/binders/committed.json", 2),
            ("git: untracked draft passes", ".hatch/binders/draft.json", 0),
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
            payload = {"hook_event_name": "PreToolUse", "tool_name": "Write",
                       "cwd": str(where), "tool_input": {"file_path": rel, "content": "{}"}}
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

        # A string tool_input carrying an apply_patch body (Copilot sends it under
        # Edit or Write) runs end to end through main() in a child process.
        def hook(tool_input, tool: str = "Edit") -> subprocess.CompletedProcess:
            payload = {"hook_event_name": "PreToolUse", "tool_name": tool,
                       "cwd": str(repo), "tool_input": tool_input}
            return subprocess.run([sys.executable, os.path.abspath(__file__)],
                                  input=json.dumps(payload), capture_output=True,
                                  text=True, encoding="utf-8")

        def update(rel: str) -> str:
            return f"*** Begin Patch\n*** Update File: {rel}\n@@\n-{{}}\n+{{\"x\":1}}\n*** End Patch\n"

        committed = ".hatch/binders/committed.json"
        main_cases = [
            ("main: patch-string Add File over committed binder denied",
             hook(f"*** Begin Patch\n*** Add File: {committed}\n+{{}}\n*** End Patch", "Write"), 2),
            ("main: patch-string Update File of committed binder denied",
             hook(update(committed)), 2),
            ("main: patch-string Update File of untracked draft passes",
             hook(update(".hatch/binders/draft.json")), 0),
            ("main: backslash-spelled patch path on committed binder denied",
             hook(update(".hatch\\binders\\committed.json")), 2),
            ("main: non-patch string tool_input passes", hook("just a string"), 0),
        ]
        for name, proc, want in main_cases:
            ok = (proc.returncode == want and not proc.stdout.strip()
                  and (want == 0) == (proc.stderr == "")
                  and (want == 0 or "committed.json" in proc.stderr))
            print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {proc.returncode}")
            failures += 0 if ok else 1

    # The denial has to name the withdrawal path, or a rejected plan tempts the
    # reader into a history rewrite instead.
    _, reason = decide(pre("Write", file_path=".hatch/binders/checkout.json", content="{}"),
                       tracked=tracked)
    msg_ok = "withdraw it" in reason and "commit the deletion" in reason
    print(f"[{'PASS' if msg_ok else 'FAIL'}] denial names the withdrawal path")
    failures += 0 if msg_ok else 1

    total = len(cases) + len(git_cases) + len(direct_cases) + len(main_cases) + 1
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
