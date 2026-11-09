#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Codex Stop guard: a delivery may not quietly end dirty.

Codex twin of hooks/scripts/guard_delivery_stop.py (the Claude Code guard). The
detection logic is identical — it inspects repo state only, never the
transcript — for three dirty-delivery states across the live binders
(`.hatch/binders/*.json` in the working tree or in HEAD, never `archive/`):

- built-unmerged: some `refs/hatch/<slug>/item-<id>/built` ref (found by ref
  glob, so an orphaned ref still counts) has no matching `done` and no matching
  `failed` — the serial merge queue never finished.
- accepted-unmerged: an `accepted` ref has no valid `done` merge and no
  `failed` ref — an accept that never completed.
- complete-unarchived: the binder has at least one work item, every item has a
  valid `done` ref, and the archive file `.hatch/binders/archive/<slug>.json` is not
  committed anywhere it counts (HEAD, `refs/heads/hatch/<slug>/integration`, or
  the default branch). On disk or staged but uncommitted does not count.

A `done` ref counts only when it passes the provenance rules delivery applies
on resume — commit markers over `<done>^1..<done>`, the accepted-state rules,
and first-parent reachability on the integration branch — through the
hatch-status engine's done_verdicts (which loads the deliver skill's
check_item_provenance.py). A forged or stray done ref therefore never silences
built-unmerged, and a suspect done ref is a finding of its own even with
no built or accepted ref beside it. When the engine cannot be found beside this plugin, done refs
are trusted as present: the fail-open direction for a nudge.

A binder whose dispatch lock a live process holds is skipped whole: none of
the four findings (built-unmerged, accepted-unmerged, suspect-done,
complete-unarchived) is checked for it and it writes nothing to the sentinel,
because a running hatch_dispatch changes those refs on purpose. The lock is
`<git-common-dir>/hatch-locks/<slug>.lock/owner.json` (extensions/pi/dispatch-lock.ts).
Its edges: an owner on another host, or a pid whose state cannot be read, counts
as live (silence is the fail-open direction for a nudge); a dead pid, a missing,
unreadable, or malformed owner.json, a binder or schema mismatch, or a pid that
is not a positive int is not a lock, so a stale or corrupt lock never silences
the guard. A reused pid reads as live — a missed nudge, never a false block.
Once the lock is gone the identical state blocks once as before. On Windows the
probe uses OpenProcess/GetExitCodeProcess, never os.kill(pid, 0).

Two Codex adaptations, both in the harness contract only:

- A payload without a `hook_event_name` still counts as a Stop — this script is
  only ever wired on the Stop event, and requiring the field would silently kill
  the gate on a build that omits it. An explicit non-Stop event, or a payload
  carrying subagent identity fields, still passes untouched.
- On a finding it emits BOTH block channels: `{"decision": "block", "reason":
  ...}` on stdout (the documented Codex Stop decision) and the reason on stderr
  with exit 2 (the exit-code contract). Whichever the host honors, the result is
  the same block.

The block fires at most once per (session, state): a fingerprint of the findings
is recorded in `<git-common-dir>/hatch-stop-gate.json` (shared with the Claude
twin — sessions never collide) and an identical later stop passes — a nudge, not
a wall. A standing `failed` ref is a designed resting state, never a finding.
This guard is FAIL-OPEN and corrective: any genuinely unexpected internal error
exits 0, because a stray Stop trap is strictly worse than a missed nudge. Keep
the detection semantics in step with the Claude twin — the two files are
maintained by hand, not generated.

  guard_delivery_stop.py              # hook mode: JSON payload/output, exit 0/2
  guard_delivery_stop.py --self-test  # run embedded fixtures, exit 0/1
"""
from __future__ import annotations
import argparse, hashlib, json, os, socket, subprocess, sys, tempfile
from pathlib import Path

def _read_stdin_text() -> str:
    """The hook payload is UTF-8 JSON, whatever the host's locale codec is.

    sys.stdin decodes with the locale codec — cp1252 on a stock Windows
    session — which mojibakes or raises on a payload it cannot spell. Read
    the byte stream and decode explicitly; the getattr falls back for test
    doubles that carry no .buffer."""
    data = getattr(sys.stdin, "buffer", sys.stdin).read()
    return data.decode("utf-8") if isinstance(data, bytes) else data

SENTINEL_NAME = "hatch-stop-gate.json"
SENTINEL_MAX_SESSIONS = 20
# The ref vocabulary the engine writes (skills/_shared/integration-branch.md),
# kept equal to it so the gate and status read the same states. `evidence` and
# `in-progress` change no decision; `accepted` is checked below.
REF_STATES = ("built", "done", "accepted", "failed", "evidence", "in-progress")

BUILT_UNMERGED_MSG = (
    "binder {slug}: items {ids} carry built but no done — the serial merge queue "
    "did not finish. Re-enter hatch-deliver's merge step: for each, re-validate "
    "its oracle against the current integration tip, merge FIFO, write the done "
    "ref; or tell the user plainly that the delivery is stopping mid-wave and "
    "how to resume.")
ACCEPTED_UNMERGED_MSG = (
    "binder {slug}: items {ids} carry an accepted ref but no valid done merge — "
    "the accept did not complete. Re-enter hatch-deliver's accept step "
    "for each (it re-prompts the human), or tell the user plainly that the "
    "accept is unfinished.")
SUSPECT_DONE_MSG = (
    "binder {slug}: the done ref of items {ids} fails delivery's provenance "
    "check ({why}), so it is not counted as done.")
COMPLETE_UNARCHIVED_MSG = (
    "binder {slug}: all items are done but the binder was never archived. Run "
    "the end-of-life step (deliver:archive / hatch-build 9c-single): git mv it "
    "to .hatch/binders/archive/{slug}.json and commit on the integration branch.")


def _git(repo: str | Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, encoding="utf-8")


def _repo_root(cwd: str) -> str | None:
    if not os.path.isdir(cwd):
        return None
    r = _git(cwd, "rev-parse", "--show-toplevel")
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


STATUS_ENGINE_REL = Path("skills") / "hatch-status" / "scripts" / "hatch_next.py"


def _status_engine():
    """The hatch-status engine, whose done_verdicts applies the same
    provenance rules delivery uses on resume. Found beside this plugin's own
    skills tree (walking up from this file, never a fixed depth), else under
    CLAUDE_PLUGIN_ROOT. None when neither holds it — the guard then trusts done
    refs as present, which is the fail-open direction for a Stop nudge."""
    roots = [d for d in Path(__file__).resolve().parents]
    env = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env:
        roots.append(Path(env))
    for root in roots:
        script = root / STATUS_ENGINE_REL
        if script.is_file():
            try:
                import importlib.util
                spec = importlib.util.spec_from_file_location(
                    "hatch_next_for_stop", script)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                return mod
            except Exception:  # noqa: BLE001
                return None
    return None


def _done_verdicts(root: str, slug: str, item_ids: list[str]) -> dict[str, dict]:
    """item -> {"suspect": [findings], ...} for the named items' done refs; empty
    when the engine is unavailable (refs are then trusted as present)."""
    if not item_ids:
        return {}
    engine = _status_engine()
    if engine is None:
        return {}
    revs = _default_branch_revs(root)
    default = revs[0][len("refs/heads/"):] if revs else "main"
    try:
        return engine.done_verdicts(Path(root), slug, item_ids, default) or {}
    except Exception:  # noqa: BLE001 — fail open
        return {}


def _live_slugs(root: str) -> list[str]:
    """Live binder slugs: union of working tree and HEAD, never archive/."""
    slugs: set[str] = set()
    binders = Path(root) / ".hatch" / "binders"
    if binders.is_dir():
        slugs.update(f.stem for f in binders.glob("*.json"))
    r = _git(root, "ls-tree", "--name-only", "HEAD", ".hatch/binders/")
    if r.returncode == 0:
        for line in r.stdout.splitlines():
            name = line.strip().rsplit("/", 1)[-1]
            if name.endswith(".json"):
                slugs.add(name[: -len(".json")])
    return sorted(slugs)


def _binder_item_ids(root: str, slug: str) -> list[str] | None:
    """Work-item ids from the live binder — working tree first, else the HEAD
    blob (a crash between the archive `git mv` and its commit removes the file
    from disk while the archival is not yet real). None = unreadable/malformed
    (fail open for this binder)."""
    live = Path(root) / ".hatch" / "binders" / f"{slug}.json"
    if live.is_file():
        try:
            raw = live.read_text(encoding="utf-8")
        except OSError:
            return None
    else:
        r = _git(root, "cat-file", "blob", f"HEAD:.hatch/binders/{slug}.json")
        if r.returncode != 0:
            return None
        raw = r.stdout
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    items = data.get("work_items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return None
    ids = [it.get("id") for it in items if isinstance(it, dict)]
    if len(ids) != len(items) or not all(isinstance(i, str) for i in ids):
        return None
    return ids


def _slug_ref_states(root: str, slug: str) -> dict[str, set[str]]:
    """item-id -> set of standing states, read via plumbing (never .git/refs/
    files, which go silent once refs are packed)."""
    prefix = f"refs/hatch/{slug}/item-"
    states: dict[str, set[str]] = {}
    r = _git(root, "for-each-ref", "--format=%(refname)", f"refs/hatch/{slug}/")
    if r.returncode != 0:
        return states
    for ref in r.stdout.splitlines():
        if not ref.startswith(prefix):
            continue
        item, sep, state = ref[len(prefix):].rpartition("/")
        if sep and item and state in REF_STATES:
            states.setdefault(item, set()).add(state)
    return states


def _default_branch_revs(root: str) -> list[str]:
    """The default branch, resolved in hatch-deliver's preflight
    order so the Stop guard judges against the branch delivery used: git config
    hatch.defaultBranch (a local branch), the local origin/HEAD
    symref, the only local non-hatch/* branch, exactly one of
    main/master. Offline; [] when nothing is unambiguous."""
    def local(name: str) -> bool:
        return _git(root, "rev-parse", "--verify", "--quiet",
                    f"refs/heads/{name}^{{commit}}").returncode == 0

    r = _git(root, "config", "--get", "hatch.defaultBranch")
    if r.returncode == 0 and r.stdout.strip():
        name = r.stdout.strip()
        return [f"refs/heads/{name}"] if local(name) else []
    r = _git(root, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    prefix = "refs/remotes/origin/"
    if r.returncode == 0 and r.stdout.strip().startswith(prefix):
        name = r.stdout.strip()[len(prefix):]
        return [f"refs/heads/{name}", f"refs/remotes/origin/{name}"]
    r = _git(root, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    branches = [b.strip() for b in r.stdout.splitlines()
                if b.strip() and not b.strip().startswith("hatch/")]
    if len(branches) == 1:
        return [f"refs/heads/{branches[0]}"]
    conventional = [b for b in ("main", "master") if b in branches]
    return [f"refs/heads/{conventional[0]}"] if len(conventional) == 1 else []


def _archive_committed(root: str, slug: str) -> bool:
    """Is the archive file committed anywhere it counts? A failing cat-file /
    missing branch is an expected negative feeding the finding, not an error."""
    path = f".hatch/binders/archive/{slug}.json"
    revs = ["HEAD", f"refs/heads/hatch/{slug}/integration", *_default_branch_revs(root)]
    return any(_git(root, "cat-file", "-e", f"{rev}:{path}").returncode == 0
               for rev in revs)


def _common_dir(root: str) -> Path | None:
    r = _git(root, "rev-parse", "--git-common-dir")
    if r.returncode != 0 or not r.stdout.strip():
        return None
    common = Path(r.stdout.strip())
    if not common.is_absolute():
        common = Path(root) / common
    return common


def _sentinel_path(root: str) -> Path | None:
    common = _common_dir(root)
    return None if common is None else common / SENTINEL_NAME


def _pid_alive(pid: int) -> bool | None:
    """True alive, False gone, None unknown. Never os.kill(pid, 0) on Windows:
    signal 0 there is CTRL_C_EVENT, which could reach the console we share."""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes
            k = ctypes.WinDLL("kernel32", use_last_error=True)
            k.OpenProcess.restype = wintypes.HANDLE
            k.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            k.GetExitCodeProcess.restype = wintypes.BOOL
            k.GetExitCodeProcess.argtypes = (wintypes.HANDLE,
                                             ctypes.POINTER(wintypes.DWORD))
            k.CloseHandle.restype = wintypes.BOOL
            k.CloseHandle.argtypes = (wintypes.HANDLE,)
            handle = k.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
            if not handle:
                err = ctypes.get_last_error()
                if err == 87:   # ERROR_INVALID_PARAMETER: no such process
                    return False
                if err == 5:    # ERROR_ACCESS_DENIED: exists, not ours
                    return True
                return None
            try:
                code = wintypes.DWORD()
                if not k.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return None
                return code.value == 259  # STILL_ACTIVE
            finally:
                k.CloseHandle(handle)
        except Exception:  # noqa: BLE001
            return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def _read_lock_owner(path: Path, slug: str) -> dict | None:
    """The lock's owner record, or None when it is missing, unreadable,
    malformed, or names another binder — none of which is a lock. Undecodable
    bytes are replaced, so they fail the JSON or shape checks below."""
    try:
        owner = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(owner, dict) or owner.get("schema") != 1 \
            or owner.get("binder") != slug:
        return None
    pid, host = owner.get("pid"), owner.get("hostname")
    # 2**31 bounds every real pid and keeps os.kill clear of OverflowError.
    if not isinstance(pid, int) or isinstance(pid, bool) or not 0 < pid < 2 ** 31 \
            or not isinstance(host, str):
        return None
    return owner


def _lock_live(common: Path, slug: str) -> bool:
    """Is this binder's dispatch lock held by a live process? Unknown is live
    (silence is the fail-open direction for a nudge); a missing, unreadable,
    malformed, or mismatched owner.json is not a lock at all."""
    try:
        owner = _read_lock_owner(
            common / "hatch-locks" / f"{slug}.lock" / "owner.json", slug)
        if owner is None:
            return False
        if owner["hostname"] != socket.gethostname():
            return True  # another host's process cannot be probed
        return _pid_alive(owner["pid"]) is not False
    except Exception:  # noqa: BLE001
        return True  # one odd lock must not disable the guard for other binders


def _load_sentinel(path: Path) -> dict[str, str]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items()
            if isinstance(k, str) and isinstance(v, str)}


def _record_nudge(path: Path, sessions: dict[str, str],
                  session_id: str, fingerprint: str) -> None:
    """Record session -> fingerprint, pruned to the newest SENTINEL_MAX_SESSIONS,
    written atomically via a temp file + os.replace."""
    sessions.pop(session_id, None)
    sessions[session_id] = fingerprint
    while len(sessions) > SENTINEL_MAX_SESSIONS:
        del sessions[next(iter(sessions))]
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=SENTINEL_NAME + ".")
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(sessions, fh)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def block_json(reason: str) -> str:
    """The documented Codex Stop block decision, emitted on stdout beside the
    exit-2 + stderr contract."""
    return json.dumps({"decision": "block", "reason": reason})


def decide(payload: object) -> tuple[int, str]:
    """Return (exit_code, stderr_reason)."""
    if not isinstance(payload, dict):
        return 0, ""
    event = payload.get("hook_event_name")
    if event is not None and event != "Stop":
        return 0, ""  # SubagentStop or anything else is not this guard's event
    if "agent_type" in payload or "agent_id" in payload:
        return 0, ""  # subagent-shaped payload — not a main-session stop
    if payload.get("stop_hook_active"):
        return 0, ""  # harness-documented loop guard
    session_id = payload.get("session_id")
    cwd = payload.get("cwd")
    if not isinstance(session_id, str) or not session_id or not isinstance(cwd, str):
        return 0, ""  # missing fields — fail open
    root = _repo_root(cwd)
    if root is None:
        return 0, ""  # not a git repo — nothing to check
    findings: list[tuple[str, str, tuple[str, ...]]] = []
    messages: list[str] = []
    common = _common_dir(root)
    for slug in _live_slugs(root):
        if common is not None and _lock_live(common, slug):
            continue  # a live dispatch owns this binder; its state is mid-flight
        ids = _binder_item_ids(root, slug)
        if ids is None:
            continue  # unreadable/malformed binder — fail open for this slug
        states = _slug_ref_states(root, slug)
        # A done ref counts only once it passes the provenance rules delivery
        # applies on resume: a forged or stray done must never silence the
        # built-without-done check. Every done ref is checked, including a bare
        # one with no built or accepted ref beside it, and any suspect done is
        # its own finding: a forged done is a dirty delivery whatever else the
        # binder carries.
        with_done = {i for i, st in states.items() if "done" in st}
        needed = sorted(with_done)
        verdicts = _done_verdicts(root, slug, needed)
        suspect = sorted(i for i in needed if (verdicts.get(i) or {}).get("suspect"))

        def done_ok(item: str) -> bool:
            return item in with_done and item not in suspect

        stranded = sorted(item for item, st in states.items()
                          if "built" in st and "failed" not in st and not done_ok(item))
        if stranded:
            findings.append((slug, "built-unmerged", tuple(stranded)))
            messages.append(BUILT_UNMERGED_MSG.format(
                slug=slug, ids=", ".join(stranded)))
        unaccepted = sorted(item for item, st in states.items()
                            if "accepted" in st and "failed" not in st
                            and not done_ok(item))
        if unaccepted:
            findings.append((slug, "accepted-unmerged", tuple(unaccepted)))
            messages.append(ACCEPTED_UNMERGED_MSG.format(
                slug=slug, ids=", ".join(unaccepted)))
        if suspect:
            findings.append((slug, "suspect-done", tuple(suspect)))
            messages.append(SUSPECT_DONE_MSG.format(
                slug=slug, ids=", ".join(suspect),
                why=verdicts[suspect[0]]["suspect"][0]))
        if ids and all(done_ok(i) for i in ids) \
                and not _archive_committed(root, slug):
            findings.append((slug, "complete-unarchived", tuple(sorted(ids))))
            messages.append(COMPLETE_UNARCHIVED_MSG.format(slug=slug))
    if not findings:
        return 0, ""
    fingerprint = hashlib.sha256(
        json.dumps(sorted(findings)).encode("utf-8")).hexdigest()
    sentinel = _sentinel_path(root)
    if sentinel is None:
        return 0, ""  # cannot do block-once safely — fail open
    sessions = _load_sentinel(sentinel)
    if sessions.get(session_id) == fingerprint:
        return 0, ""  # already nudged for exactly this state
    _record_nudge(sentinel, sessions, session_id, fingerprint)
    return 2, (
        "hatch: this session is stopping with a dirty delivery. "
        + " ".join(messages)
        + " This stop is blocked once per state — an identical stop will pass, "
          "so fix it now or stop again to defer to the resume flow.")


def _run_self_test() -> int:
    results: list[bool] = []

    def check(name: str, payload: object, want: int) -> str:
        code, reason = decide(payload)
        ok = (code == want and (want == 0) == (reason == "")
              and (want == 0 or reason.startswith("hatch: ")))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
        results.append(ok)
        return reason

    def flag(name: str, ok: bool) -> None:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        results.append(ok)

    def git(repo: Path, *a: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "-C", str(repo), "-c", "user.email=hatch@test",
             "-c", "user.name=hatch", "-c", "commit.gpgsign=false", *a],
            capture_output=True, text=True, encoding="utf-8")

    def init_repo(td: str, name: str) -> Path:
        repo = Path(td) / name
        repo.mkdir()
        git(repo, "init", "-q", "-b", "main")
        (repo / "README.md").write_text("seed\n", encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "seed")
        return repo

    def write_binder(repo: Path, slug: str, ids: list[str],
                     malformed: bool = False, commit: bool = True) -> None:
        d = repo / ".hatch" / "binders"
        d.mkdir(parents=True, exist_ok=True)
        body = "{not json" if malformed else json.dumps(
            {"slug": slug, "work_items": [{"id": i} for i in ids]})
        (d / f"{slug}.json").write_text(body, encoding="utf-8")
        if commit:
            git(repo, "add", ".")
            git(repo, "commit", "-q", "-m", f"binder {slug}")

    def set_ref(repo: Path, slug: str, item: str, state: str) -> None:
        head = git(repo, "rev-parse", "HEAD").stdout.strip()
        git(repo, "update-ref", f"refs/hatch/{slug}/item-{item}/{state}", head)

    def deliver(repo: Path, slug: str, item: str) -> None:
        """Merge an item the way the merge queue does: a marked item commit on
        its own branch off the integration tip, a --no-ff marked merge on the
        integration branch, then built -> the item tip and done -> the merge.
        A done ref that did not come from this shape fails provenance."""
        here = git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        integ = f"hatch/{slug}/integration"
        if git(repo, "rev-parse", "--verify", "--quiet", integ).returncode != 0:
            git(repo, "branch", integ)
        git(repo, "checkout", "-q", "-b", f"hatch/{slug}/item-{item}", integ)
        (repo / f"{slug}-{item}.txt").write_text(item + "\n", encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", f"[hatch:item-{item}] work")
        set_ref(repo, slug, item, "built")
        git(repo, "checkout", "-q", integ)
        git(repo, "merge", "-q", "--no-ff", "-m",
            f"Merge item {item} into integration [hatch:item-{item}]",
            f"hatch/{slug}/item-{item}")
        set_ref(repo, slug, item, "done")
        git(repo, "checkout", "-q", here)

    def stop(repo_or_dir: Path, session: str = "s1", **over: object) -> dict:
        payload: dict = {"hook_event_name": "Stop", "session_id": session,
                         "cwd": str(repo_or_dir), "stop_hook_active": False}
        payload.update(over)
        return payload

    def dirty_repo(td: str, name: str) -> Path:
        """built-unmerged: item a merged, item b built with no done/failed."""
        repo = init_repo(td, name)
        write_binder(repo, "wip", ["a", "b"])
        deliver(repo, "wip", "a")
        set_ref(repo, "wip", "b", "built")
        return repo

    def complete_repo(td: str, name: str, slug: str = "comp") -> Path:
        """all items done, nothing archived yet."""
        repo = init_repo(td, name)
        write_binder(repo, slug, ["a"])
        deliver(repo, slug, "a")
        return repo

    with tempfile.TemporaryDirectory() as td:
        # 1. no live binder -> allow
        repo = init_repo(td, "clean")
        check("no live binder allows", stop(repo), 0)

        # 2. archived-only slug with surviving refs -> allow
        repo = init_repo(td, "archived")
        d = repo / ".hatch" / "binders" / "archive"
        d.mkdir(parents=True)
        (d / "old.json").write_text(json.dumps(
            {"slug": "old", "work_items": [{"id": "a"}]}), encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "archive old")
        set_ref(repo, "old", "a", "built")
        check("archived-only slug with surviving refs allows", stop(repo), 0)

        # 3. in-flight binder, no built standing -> allow
        repo = init_repo(td, "inflight")
        write_binder(repo, "wip", ["a", "b"])
        deliver(repo, "wip", "a")
        check("in-flight binder with no built standing allows", stop(repo), 0)

        # 4. built-unmerged -> block naming slug + stranded items
        repo = dirty_repo(td, "built1")
        reason = check("built-unmerged blocks", stop(repo), 2)
        flag("block reason names the slug and the stranded item",
             "binder wip" in reason and "items b carry built" in reason)

        # 5. built + failed, no done -> allow (parked four-way choice)
        repo = init_repo(td, "parked")
        write_binder(repo, "wip", ["a"])
        set_ref(repo, "wip", "a", "built")
        set_ref(repo, "wip", "a", "failed")
        check("item with built and failed but no done allows (parked)",
              stop(repo), 0)

        # 6. empty work_items -> allow (vacuously complete, never a finding)
        repo = init_repo(td, "empty")
        write_binder(repo, "hollow", [])
        check("empty work_items allows", stop(repo), 0)

        # 7. complete-unarchived, integration branch exists, no archive -> block
        repo = complete_repo(td, "comp7")
        reason = check("complete-unarchived blocks (no archive anywhere)",
                       stop(repo), 2)
        flag("block reason names the slug and the archive fix",
             "binder comp" in reason and "never archived" in reason)

        # 8. complete-unarchived with no integration branch at all -> block
        #    (landed and cleaned up: the done merge is on the default branch)
        repo = complete_repo(td, "comp8")
        git(repo, "merge", "-q", "--no-ff", "-m", "land comp",
            "hatch/comp/integration")
        git(repo, "branch", "-D", "hatch/comp/integration")
        check("complete-unarchived blocks with no integration branch "
              "(missing branch is a negative, not an error)", stop(repo), 2)

        # 9. archive git mv'd but uncommitted -> block (live binder in HEAD)
        repo = complete_repo(td, "comp9")
        (repo / ".hatch" / "binders" / "archive").mkdir()
        git(repo, "mv", ".hatch/binders/comp.json",
            ".hatch/binders/archive/comp.json")
        check("archive mv'd but uncommitted still blocks", stop(repo), 2)

        # 10. archive committed on the integration branch only -> allow
        repo = complete_repo(td, "comp10")
        git(repo, "checkout", "-q", "hatch/comp/integration")
        (repo / ".hatch" / "binders" / "archive").mkdir()
        git(repo, "mv", ".hatch/binders/comp.json",
            ".hatch/binders/archive/comp.json")
        git(repo, "commit", "-q", "-m", "archive comp")
        git(repo, "checkout", "-q", "main")
        check("archive committed on integration branch only allows",
              stop(repo), 0)

        # 11. complete with archive in HEAD (live copy also present) -> allow
        repo = complete_repo(td, "comp11")
        d = repo / ".hatch" / "binders" / "archive"
        d.mkdir()
        (d / "comp.json").write_text(
            (repo / ".hatch" / "binders" / "comp.json").read_text(encoding="utf-8"), encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "archive comp (copy in HEAD)")
        check("archive present in HEAD allows", stop(repo), 0)

        # 12. archive merged to default branch, stale feature checkout -> allow
        repo = complete_repo(td, "comp12")
        git(repo, "branch", "feature")
        (repo / ".hatch" / "binders" / "archive").mkdir()
        git(repo, "mv", ".hatch/binders/comp.json",
            ".hatch/binders/archive/comp.json")
        git(repo, "commit", "-q", "-m", "archive comp on main")
        git(repo, "checkout", "-q", "feature")
        check("archive merged to default branch allows under a stale "
              "feature-branch checkout", stop(repo), 0)

        # 13. two live binders with mixed findings -> one block covering both
        repo = dirty_repo(td, "mixed")
        write_binder(repo, "comp", ["a"])
        deliver(repo, "comp", "a")
        reason = check("two live binders with mixed findings block once",
                       stop(repo), 2)
        flag("one reason covers both findings",
             "binder wip" in reason and "binder comp" in reason)
        check("second stop, same session and fingerprint covering both, allows",
              stop(repo), 0)

        # 14. payload cwd in a subdirectory -> still detects
        repo = dirty_repo(td, "subdir")
        sub = repo / "docs"
        sub.mkdir()
        check("payload cwd in a subdirectory still detects", stop(sub), 2)

        # 15. subagent-shaped payloads -> allow, even in a dirty repo
        repo = dirty_repo(td, "subagent")
        check("SubagentStop-shaped payload allows",
              stop(repo, hook_event_name="SubagentStop",
                   agent_type="hatch:hatch-build"), 0)
        check("Stop payload carrying subagent fields allows",
              stop(repo, agent_id="abc123"), 0)

        # 16. stop_hook_active true -> allow, even in a dirty repo
        check("stop_hook_active true allows", stop(repo, stop_hook_active=True), 0)

        # 17. Codex adaptation: no hook_event_name still counts as a Stop
        repo = dirty_repo(td, "noevent")
        payload = stop(repo, session="ne1")
        del payload["hook_event_name"]
        del payload["stop_hook_active"]
        check("payload without hook_event_name still blocks on a dirty repo",
              payload, 2)

        # 18./19./20. block-once per (session, state)
        repo = dirty_repo(td, "sessions")
        check("first stop on a dirty state blocks", stop(repo, session="s1"), 2)
        check("same session + same fingerprint allows on the second call",
              stop(repo, session="s1"), 0)
        set_ref(repo, "wip", "c", "built")  # orphaned ref still counts
        check("same session + changed fingerprint blocks again",
              stop(repo, session="s1"), 2)
        check("new session + same state blocks once", stop(repo, session="s2"), 2)
        check("new session + same state allows on its second call",
              stop(repo, session="s2"), 0)

        # provenance: a done ref only counts once delivery's own rules pass it
        repo = init_repo(td, "forged")
        write_binder(repo, "wip", ["a", "b"])
        git(repo, "branch", "hatch/wip/integration")
        set_ref(repo, "wip", "a", "built")
        set_ref(repo, "wip", "a", "done")   # forged: no merge, no marker
        reason = check("a forged done ref beside built does not silence "
                       "built-unmerged", stop(repo), 2)
        flag("block reason names the suspect done ref",
             "items a carry built" in reason and "fails delivery's provenance" in reason)
        repo = init_repo(td, "acc")
        write_binder(repo, "wip", ["a", "b"])
        set_ref(repo, "wip", "a", "accepted")
        reason = check("an accepted ref with no done merge blocks", stop(repo), 2)
        flag("block reason names the unfinished accept",
             "items a carry an accepted ref" in reason)
        repo = init_repo(td, "bare")
        write_binder(repo, "wip", ["a", "b", "c"])
        deliver(repo, "wip", "a")
        set_ref(repo, "wip", "b", "done")   # forged, with no built/accepted
        reason = check("a bare forged done ref with no built beside it blocks",
                       stop(repo), 2)
        flag("block reason names the bare suspect done ref",
             "done ref of items b fails delivery's provenance" in reason)

        # 21. malformed binder JSON -> allow (fail-open)
        repo = init_repo(td, "malformed")
        write_binder(repo, "broken", [], malformed=True)
        check("malformed binder JSON allows (fail-open)", stop(repo), 0)

        # 22. non-git cwd -> allow
        plain = Path(td) / "plain"
        plain.mkdir()
        check("non-git cwd allows", stop(plain), 0)

        # 23. sentinel pruning at SENTINEL_MAX_SESSIONS sessions
        repo = dirty_repo(td, "prune")
        for n in range(1, 26):
            decide(stop(repo, session=f"p{n}"))
        sentinel = _sentinel_path(str(repo))
        sessions = _load_sentinel(sentinel) if sentinel else {}
        flag("sentinel is pruned to 20 sessions, oldest first",
             len(sessions) == SENTINEL_MAX_SESSIONS
             and "p1" not in sessions and "p5" not in sessions
             and "p6" in sessions and "p25" in sessions)

        # 24. the stdout block decision is well-formed JSON
        parsed = json.loads(block_json("fix the delivery"))
        flag("block_json emits decision=block with the reason",
             parsed == {"decision": "block", "reason": "fix the delivery"})

        # 25. Hook-mode allow output must satisfy Codex's Stop JSON schema.
        allowed = subprocess.run(
            [sys.executable, __file__],
            input=json.dumps({"hook_event_name": "Stop"}),
            capture_output=True, text=True, encoding="utf-8")
        try:
            allowed_output = json.loads(allowed.stdout)
        except json.JSONDecodeError:
            allowed_output = None
        flag("hook-mode allow emits an empty JSON object",
             allowed.returncode == 0 and allowed_output == {})

        malformed = subprocess.run(
            [sys.executable, __file__], input="{not json",
            capture_output=True, text=True, encoding="utf-8")
        try:
            malformed_output = json.loads(malformed.stdout)
        except json.JSONDecodeError:
            malformed_output = None
        flag("hook-mode fail-open emits an empty JSON object",
             malformed.returncode == 0 and malformed_output == {})

        # Live dispatch lock (L1-L7): a binder whose lock a live process holds
        # is skipped whole; a dead, malformed, or absent lock is not a lock.
        def lock_dir(repo: Path, slug: str) -> Path:
            common = Path(git(repo, "rev-parse", "--path-format=absolute",
                              "--git-common-dir").stdout.strip())
            return common / "hatch-locks" / f"{slug}.lock"

        def lock(repo: Path, slug: str, raw: str | None = None,
                 **over: object) -> Path:
            owner: dict = {"schema": 1, "binder": slug, "pid": os.getpid(),
                           "hostname": socket.gethostname(),
                           "processStartedAt": "2026-11-01T00:00:00.000Z",
                           "nonce": "selftest", "packageVersion": "0.0.0",
                           "acquiredAt": "2026-11-01T00:00:00.000Z"}
            owner.update(over)
            d = lock_dir(repo, slug)
            d.mkdir(parents=True, exist_ok=True)
            (d / "owner.json").write_text(
                json.dumps(owner) if raw is None else raw, encoding="utf-8")
            return d

        reaped = subprocess.run([sys.executable, "-c",
                                 "import os; print(os.getpid())"],
                                capture_output=True, text=True,
                                encoding="utf-8").stdout.strip()
        reaped_pid = int(reaped) if reaped.isdigit() else 0
        flag("pid probe: this process is alive", _pid_alive(os.getpid()) is True)
        flag("pid probe: a reaped child is dead",
             reaped_pid > 0 and _pid_alive(reaped_pid) is False)

        # L1. live lock on the only dirty binder -> allow, sentinel untouched
        repo = dirty_repo(td, "lock1")
        held = lock(repo, "wip")
        sentinel = _sentinel_path(str(repo))
        before = sentinel.read_bytes() if sentinel and sentinel.exists() else None
        check("a live dispatch lock skips its binder", stop(repo), 0)
        after = sentinel.read_bytes() if sentinel and sentinel.exists() else None
        flag("a skipped binder writes no sentinel", before == after)

        # L2. lock released -> the identical state blocks
        (held / "owner.json").unlink()
        held.rmdir()
        check("the same state blocks once the lock dir is removed",
              stop(repo), 2)

        # L3. lock owned by a dead pid -> not live
        repo = dirty_repo(td, "lock3")
        lock(repo, "wip", pid=reaped_pid)
        check("a lock whose owner pid is dead does not silence the guard",
              stop(repo), 2)

        # L4. lock owned on another host -> unknown, treated as live
        repo = dirty_repo(td, "lock4")
        lock(repo, "wip", hostname="elsewhere.invalid")
        check("a lock held on another host skips its binder", stop(repo), 0)

        # L5. malformed owner.json -> not a lock
        repo = dirty_repo(td, "lock5")
        lock(repo, "wip", raw="{")
        check("an unparseable owner.json does not silence the guard",
              stop(repo, session="m1"), 2)
        lock(repo, "wip", binder="other")
        check("an owner.json naming another binder does not silence the guard",
              stop(repo, session="m2"), 2)
        lock(repo, "wip", pid=0)
        check("an owner.json with pid 0 does not silence the guard",
              stop(repo, session="m3"), 2)
        lock(repo, "wip", pid=True)
        check("an owner.json with a boolean pid does not silence the guard",
              stop(repo, session="m4"), 2)

        # L6. two binders: live lock on wip, other built-unmerged -> names other only
        repo = dirty_repo(td, "lock6")
        write_binder(repo, "other", ["x"])
        set_ref(repo, "other", "x", "built")
        lock(repo, "wip")
        reason = check("a live lock on one binder still blocks on another",
                       stop(repo), 2)
        flag("block reason names the unlocked binder and not the locked one",
             "binder other" in reason and "binder wip" not in reason)

        # L7. complete-unarchived binder under a live lock -> allow
        repo = complete_repo(td, "lock7")
        lock(repo, "comp")
        check("a live lock skips complete-unarchived too", stop(repo), 0)

        # L8. an owner.json that breaks the reader -> that binder counts as
        #     live, and every other binder is still checked
        repo = dirty_repo(td, "lock8")
        write_binder(repo, "other", ["x"])
        set_ref(repo, "other", "x", "built")
        lock(repo, "wip", raw="[" * 100000 + "]" * 100000)
        reason = check("a lock that breaks the reader skips only its binder",
                       stop(repo), 2)
        flag("block reason names the other binder and not the unreadable one",
             "binder other" in reason and "binder wip" not in reason)

        # L9. a pid beyond the platform range is malformed, not live
        repo = dirty_repo(td, "lock9")
        lock(repo, "wip", pid=2 ** 40)
        check("an owner.json with an out-of-range pid does not silence the guard",
              stop(repo), 2)


        # The shared item-state table: every row's ref configuration in a real
        # repo, read by this guard's real decide(). Each finding's text is the
        # block reason's, so the table pins what the session is told.
        def guard_item_state(repo: Path, binder: dict, _item: str) -> list[str]:
            d = repo / ".hatch" / "binders"
            d.mkdir(parents=True)
            (d / f"{binder['slug']}.json").write_text(json.dumps(binder), encoding="utf-8")
            code, reason = decide(stop(repo, session="item-states"))
            found = sorted(name for name, text in (
                ("built-unmerged", "carry built but no done"),
                ("accepted-unmerged", "carry an accepted ref"),
                ("suspect-done", "fails delivery's provenance check"),
                ("complete-unarchived", "the binder was never archived"),
            ) if text in reason)
            # An empty list means the guard allows, never "no finding this reads".
            return found or ([] if code == 0 else [f"exit {code} with no known finding"])

        engine = _status_engine()
        if engine is None:
            flag("item-states table unreadable: the hatch-status engine is not "
                 "beside this guard", False)
        else:
            for name, ok in engine.item_state_checks("guard", guard_item_state):
                flag(name, ok)

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
    try:
        payload = json.loads(_read_stdin_text())
        code, reason = decide(payload)
    except Exception:  # noqa: BLE001
        print("{}")
        return 0  # fail open: a stray Stop trap is worse than a missed nudge
    if code == 2:
        print(block_json(reason))          # Codex Stop decision channel
        print(reason, file=sys.stderr)     # exit-code channel
    else:
        print("{}")                        # Codex requires JSON on every pass
    return code


if __name__ == "__main__":
    sys.exit(main())
