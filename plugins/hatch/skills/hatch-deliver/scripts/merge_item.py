# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch serial merge queue, one command per item: merge / close-wave / tag-wave.

This script performs the orchestrator's Step-3 merge mechanics for ONE item in a
single call, stops at the first failure, and ALWAYS prints one fixed-shape JSON
object on stdout — {item, skipped_done, provenance, drift, merge_commit,
revalidation, done_ref, halted_at} — the same keys on every path, with
`halted_at` naming the step that stopped it or null.

`merge` order of operations:

  (a)  DONE-REF IDEMPOTENCY, VERIFIED. An existing done ref is trusted only after
       check_item_provenance.py --check-accepted over `<done>^1..<done>` (the
       merge commit and its merged side — a wider range would contain wave-mates'
       commits and fail spuriously) AND first-parent reachability of the done
       target from hatch/<slug>/integration. Both pass -> skipped_done true,
       exit 0; either fails -> halted_at "done-provenance", exit 1, nothing
       written. This is resume-idempotency, not a race fix — the queue is serial.
  (a2) PRECONDITIONS, before anything is touched: clean integration worktree,
       HEAD on hatch/<slug>/integration, refs/hatch/<slug>/item-<id>/built
       present and equal to the item-branch tip, no /failed ref. The pre-merge
       tip is recorded here.
  (b)  PROVENANCE. check_item_provenance.py WITHOUT --check-accepted over
       <integration-tip>..<item-tip>; nonzero halts before any merge.
  (c)  DRIFT. Read refs/hatch/<slug>/item-<id>/evidence (a shared term) with
       `git cat-file` and compare its `command_sha256` with the sha256 of the
       binder oracle's current command — hashed over the exact command string
       bytes as stored in the binder JSON, UTF-8 encoded, no trimming, the same
       form run_oracle.py records. A mismatch is reported as drift: true and
       halts unless --allow-drift. A missing or unreadable ref is noted in the
       result (a string note in `drift`) and is never fatal.
  (d)  MERGE. `git merge --no-ff` with the message
       `Merge item <id> into integration [hatch:item-<id>]`. On a conflict the
       merge is aborted (git merge --abort), the tree verified clean and HEAD
       back at the recorded pre-merge tip, and the halt reported.
  (e)  RE-VALIDATION. Merge re-validation always re-executes: run_oracle.py runs
       the binder oracle against the MERGED tip with the oracle's resolved cwd
       and expect; there is no skip-on-match — a matching command hash says
       nothing about the composed tree.
  (e2) CLEAN AND UNMOVED. After the oracle, porcelain must be empty
       ("dirty-after-oracle" otherwise) and HEAD/branch/ref must still be the
       just-made merge commit on the integration branch ("tip-moved" otherwise).
  (f)  On success, write refs/hatch/<slug>/item-<id>/done at the merge commit.

Every halt after the merge started goes through ONE SHARED UNWIND ROUTINE — a
fixed, forced sequence that works from any state the oracle can leave:
  (1) git update-ref refs/heads/hatch/<slug>/integration <pre-merge tip>
      (recreates the branch if the oracle deleted it; the only ref a rollback
      ever writes — a foreign branch's ref is never written)
  (2) git checkout -f hatch/<slug>/integration (forced, so a tracked
      modification made on a divergent foreign branch cannot refuse it)
  (3) git reset --hard <pre-merge tip>
  (4) git clean -fd  (never the ignored-files flag: ignored files such as
      caches predate the run and are not this script's to delete)
  (5) verify HEAD, the integration ref and an empty porcelain — loud on failure.
Because (a2) proved the tree clean before anything ran, any untracked file
present at rollback was created by the merge or the oracle.

`close-wave` runs the post-wave checks on the current tip — each passed
explicitly with --check (required, repeatable; env_contract.command is the
command that STARTS the environment and is never used here), each run through
run_oracle.py with its capped record in the result — then
check_shared_terms.py, whose result appears in the printed JSON under a
`shared_terms` key. It requires a clean tree on entry, verifies the branch and
tip it started on are unchanged after every check (a check that moved them
routes through the same shared unwind: "tip-moved"), and on "dirty-after-check"
restores index and tracked tree with git reset --hard HEAD — which moves no ref
and also clears a STAGED mutation — then git clean -fd. It writes NO tag and
does NOT revert: reverting a wave rewinds refs and restores failed markers and
stays a doctrine decision made with the human.

`tag-wave` writes hatch/<slug>/wave-<N> at the explicitly resolved
refs/heads/hatch/<slug>/integration tip it read at entry, and nothing else.

Stdlib only. Invoked directly (not installed), matching sibling scripts:

Usage:
  python3 skills/hatch-deliver/scripts/merge_item.py merge \\
      --repo DIR --binder PATH --slug S --item ID [--allow-drift]
  python3 skills/hatch-deliver/scripts/merge_item.py close-wave \\
      --repo DIR --binder PATH --slug S --check CMD [--check CMD ...]
  python3 skills/hatch-deliver/scripts/merge_item.py tag-wave \\
      --repo DIR --slug S --wave N
  python3 skills/hatch-deliver/scripts/merge_item.py --self-test

Exit codes: 0 = success, 1 = halt/failure (or self-test failure), 2 = usage error,
128 + the signal number = stopped by SIGTERM, SIGINT or SIGHUP during an oracle run, the
oracle stopped with it.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RUN_ORACLE = (SCRIPT_DIR / ".." / ".." / "hatch-build" / "scripts" / "run_oracle.py").resolve()
PROVENANCE = SCRIPT_DIR / "check_item_provenance.py"
SHARED_TERMS = (SCRIPT_DIR / ".." / ".." / "hatch-plan" / "scripts" / "check_shared_terms.py").resolve()

CAP_BYTES = 1024
# Seconds a stopped run_oracle.py gets to end its command. Its own stop path waits up
# to 20 s on a child that does not die.
ORACLE_STOP_GRACE = 30
STOP_SIGNALS = tuple(getattr(signal, name) for name in ("SIGTERM", "SIGINT", "SIGHUP")
                     if hasattr(signal, name))


def _cap(s: str) -> str:
    b = s.encode("utf-8", "replace")
    if len(b) <= CAP_BYTES:
        return s
    return b[:CAP_BYTES].decode("utf-8", "replace")


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")


def _rev(repo: Path, ref: str) -> str | None:
    p = _git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
    out = p.stdout.strip()
    return out if p.returncode == 0 and out else None


def _porcelain(repo: Path) -> str:
    # Bytes and -z preserve literal names, including newlines and rename sources.
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain=v1", "-z"],
        capture_output=True,
    )
    if status.returncode:
        raise RuntimeError(f"git status failed: {os.fsdecode(status.stderr)}")
    if not status.stdout:
        return ""
    parts = status.stdout.split(b"\0")
    if parts.pop() != b"":
        raise RuntimeError("git status returned an unterminated record")
    dirty: list[bytes] = []
    i = 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4 or entry[2:3] != b" ":
            raise RuntimeError("git status returned an invalid record")
        xy = entry[:2]
        records = [entry]
        if b"R" in xy or b"C" in xy:
            if i == len(parts) or not parts[i]:
                raise RuntimeError("git status omitted a rename/copy source")
            records.append(parts[i])
            i += 1
        if xy == b" M":
            # autocrlf can report a size-only change after a generator writes LF.
            # Refresh stat data, not staged content. Only exit 0 proves no diff.
            diff = _git(
                repo, "--literal-pathspecs", "-c", "diff.autoRefreshIndex=true",
                "diff", "--quiet", "--no-ext-diff", "--no-textconv",
                "--ignore-submodules=none", "--", os.fsdecode(entry[3:]),
            )
            if diff.returncode == 0:
                continue
            if diff.returncode != 1:
                raise RuntimeError(f"git diff failed ({diff.returncode}): {diff.stderr}")
        dirty.extend(records)
    return os.fsdecode(b"".join(record + b"\0" for record in dirty))


def _shell_quote_path(path: str) -> str:
    # These operands are file paths, not arbitrary shell code. Windows paths
    # cannot contain a double quote; quote even when only '&' requires it.
    return f'"{path}"' if os.name == "nt" else shlex.quote(path)


def _utf8_python_env() -> dict[str, str]:
    """Keep child Python output aligned with our explicit UTF-8 decoder."""
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    return env


def _symref(repo: Path) -> str | None:
    p = _git(repo, "symbolic-ref", "-q", "HEAD")
    out = p.stdout.strip()
    return out if p.returncode == 0 and out else None


def _first_parent_chain(repo: Path, branch: str) -> set[str]:
    p = _git(repo, "rev-list", "--first-parent", branch)
    if p.returncode != 0:
        return set()
    return {line.strip() for line in p.stdout.splitlines() if line.strip()}


def _run_provenance(repo: Path, item: str, rng: str, slug: str | None = None,
                    check_accepted: bool = False) -> dict:
    argv = [sys.executable, str(PROVENANCE), "--repo", str(repo), "--item", item, "--range", rng]
    if check_accepted:
        argv += ["--slug", slug or "", "--check-accepted"]
    p = subprocess.run(
        argv, capture_output=True, text=True, encoding="utf-8", env=_utf8_python_env())
    return {
        "range": rng,
        "check_accepted": check_accepted,
        "exit_status": p.returncode,
        "output": _cap((p.stdout + p.stderr).strip()),
    }


def _run_oracle_record(command: str, cwd: Path, expect: str | None) -> dict:
    """Run one command through run_oracle.py (the deterministic runner) and return
    its capped evidence record. A record that cannot be parsed is itself a failure."""
    argv = [sys.executable, str(RUN_ORACLE), "--cwd", str(cwd)]
    if expect:
        argv += ["--expect", expect]
    argv.append(command)
    # Not subprocess.run: on any exception it SIGKILLs the child, and a SIGKILLed
    # run_oracle.py cannot kill its command. The group lets a terminal's Ctrl-C reach
    # the runner by one path only, _stop_oracle, so the runner sees one signal.
    group = ({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt"
             else {"start_new_session": True})
    with _signals_stop_the_oracle(), subprocess.Popen(
            argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            encoding="utf-8", env=_utf8_python_env(), **group) as p:
        try:
            stdout, stderr = p.communicate()
        finally:
            if p.poll() is None:
                _stop_oracle(p)
    try:
        record = json.loads(stdout)
    except json.JSONDecodeError:
        record = {
            "success": False,
            "exit_status": p.returncode,
            "parse_error": "run_oracle.py produced no parseable record",
            "decisive_output": {"head": _cap(stdout + stderr), "tail": ""},
        }
    return record


def _exit_on_signal(signum: int, _frame) -> None:
    """The first stop decides. Later ones are ignored, so none can leave _stop_oracle
    before the command is gone."""
    for sig in STOP_SIGNALS:
        signal.signal(sig, signal.SIG_IGN)
    raise SystemExit(128 + signum)


@contextlib.contextmanager
def _signals_stop_the_oracle():
    """The oracle runs in a session of its own, so a signal to this process never reaches
    it. For the length of the call these signals become an exit that passes through
    _stop_oracle. Outside it they keep their earlier handlers, so a stop cannot raise
    into a git call: subprocess.run would SIGKILL git and could leave an index.lock. A
    signal ignored at the start (`nohup`, a shell's `&`) stays ignored. Main thread only,
    as signal.signal requires: this script starts no thread."""
    earlier = {}
    try:
        for sig in STOP_SIGNALS:
            handler = signal.getsignal(sig)
            if handler not in (signal.SIG_IGN, None):
                earlier[sig] = handler
                signal.signal(sig, _exit_on_signal)
        yield
    finally:
        for sig, handler in earlier.items():
            signal.signal(sig, handler)


def _stop_oracle(proc: subprocess.Popen) -> None:
    """Stop a running run_oracle.py and wait until its command is gone. SIGTERM, not
    SIGKILL: the command sits in a session of its own that only the runner's signal
    handler reaches. On Windows ending the runner closes the job holding the command,
    and KILL_ON_JOB_CLOSE ends it."""
    if os.name == "nt":
        proc.terminate()
    else:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=ORACLE_STOP_GRACE)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            proc.kill()
        else:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)


def _forced_unwind(repo: Path, slug: str, tip: str) -> list[str]:
    """The one shared unwind routine for every halt after the merge started — a
    failing oracle, dirty-after-oracle, tip-moved, a failed verification. There is
    no second, older reset path. Fixed, forced sequence (works from any state the
    oracle can leave):
      (1) git update-ref the integration branch back to <tip> — the only ref a
          rollback ever writes (a foreign branch keeps its tip);
      (2) git checkout -f the integration branch — forced;
      (3) git reset --hard <tip>;
      (4) git clean -fd — never the ignored-files variant;
      (5) verify HEAD, the integration ref and an empty porcelain."""
    branch = f"hatch/{slug}/integration"
    _git(repo, "update-ref", f"refs/heads/{branch}", tip)
    _git(repo, "checkout", "-f", branch)
    _git(repo, "reset", "--hard", tip)
    _git(repo, "clean", "-fd")
    problems: list[str] = []
    if _rev(repo, "HEAD") != tip:
        problems.append(f"unwind verification failed: HEAD is not {tip}")
    if _rev(repo, f"refs/heads/{branch}") != tip:
        problems.append(f"unwind verification failed: refs/heads/{branch} is not {tip}")
    if _porcelain(repo):
        problems.append("unwind verification failed: porcelain is not empty")
    for msg in problems:
        print(f"merge_item: {msg}", file=sys.stderr)
    return problems


def _load_oracle(binder: Path, item: str) -> dict | None:
    try:
        data = json.loads(binder.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"merge_item: cannot read binder {binder}: {e}", file=sys.stderr)
        return None
    for wi in data.get("work_items", []):
        if wi.get("id") == item:
            return wi.get("oracle") or {}
    print(f"merge_item: no work item '{item}' in {binder}", file=sys.stderr)
    return None


def _state_after(repo: Path, branch: str, expected: str) -> tuple[bool, bool]:
    """(moved, dirty) relative to `expected` being the checked-out tip of `branch`.
    A reset, a checkout, an empty commit, a ref update or deletion, or a detached
    HEAD all count as moved."""
    ref = _rev(repo, f"refs/heads/{branch}")
    sym = _symref(repo)
    head = _rev(repo, "HEAD")
    moved = ref != expected or sym != f"refs/heads/{branch}" or head != expected
    dirty = bool(_porcelain(repo))
    return moved, dirty


# --- merge ----------------------------------------------------------------


def cmd_merge(args: argparse.Namespace) -> int:
    repo = args.repo.resolve()
    slug, item = args.slug, args.item
    branch = f"hatch/{slug}/integration"
    item_branch = f"hatch/{slug}/item-{item}"
    done_ref = f"refs/hatch/{slug}/item-{item}/done"
    built_ref = f"refs/hatch/{slug}/item-{item}/built"
    failed_ref = f"refs/hatch/{slug}/item-{item}/failed"
    evidence_ref = f"refs/hatch/{slug}/item-{item}/evidence"

    res: dict = {
        "item": item,
        "skipped_done": False,
        "provenance": None,
        "drift": None,
        "merge_commit": None,
        "revalidation": None,
        "done_ref": None,
        "halted_at": None,
    }

    def emit(code: int) -> int:
        print(json.dumps(res, indent=2))
        return code

    def halt(step: str) -> int:
        res["halted_at"] = step
        return emit(1)

    # (a) done-ref idempotency, verified — a worker sharing the ref namespace can
    # write a done ref after preflight ran, and a skip must never take its word.
    done = _rev(repo, done_ref)
    if done is not None:
        prov = _run_provenance(repo, item, f"{done}^1..{done}", slug=slug, check_accepted=True)
        reachable = done in _first_parent_chain(repo, branch)
        prov["first_parent_reachable"] = reachable
        res["provenance"] = prov
        if prov["exit_status"] == 0 and reachable:
            res["skipped_done"] = True
            res["done_ref"] = {"ref": done_ref, "target": done}
            return emit(0)
        return halt("done-provenance")

    # (a2) preconditions — checked before anything is touched.
    if _porcelain(repo):
        return halt("dirty-worktree")
    if _symref(repo) != f"refs/heads/{branch}":
        return halt("head-not-integration")
    item_tip = _rev(repo, f"refs/heads/{item_branch}")
    if item_tip is None:
        return halt("item-branch-missing")
    built = _rev(repo, built_ref)
    if built is None or built != item_tip:
        # A branch the gate halted (failed present, built absent or stale) reaches
        # the tip only through a human accept at the Phase-4 halt, never here.
        return halt("built-ref")
    if _rev(repo, failed_ref) is not None:
        return halt("failed-ref")
    pre_tip = _rev(repo, "HEAD")
    if pre_tip is None:
        return halt("no-pre-merge-tip")

    # (b) provenance — WITHOUT --check-accepted: the accepted-state form belongs
    # to resume and to the moment just after an accepted ref is written.
    prov = _run_provenance(repo, item, f"{pre_tip}..{item_tip}")
    res["provenance"] = prov
    if prov["exit_status"] != 0:
        return halt("provenance")

    # (c) drift — evidence command_sha256 vs the binder oracle's current command.
    oracle = _load_oracle(args.binder, item)
    if oracle is None:
        return halt("binder")
    command = oracle.get("command")
    expect = oracle.get("expect")
    if command:
        cat = _git(repo, "cat-file", "-p", evidence_ref)
        if cat.returncode != 0:
            res["drift"] = "evidence-missing: no readable evidence ref (noted, never fatal)"
        else:
            try:
                record = json.loads(cat.stdout)
                recorded = record.get("command_sha256")
            except json.JSONDecodeError:
                recorded = None
            if recorded is None:
                res["drift"] = "evidence-unreadable: no command_sha256 in record (noted, never fatal)"
            else:
                res["drift"] = recorded != _sha256_hex(command.encode("utf-8"))
                if res["drift"] and not args.allow_drift:
                    # The binder's command changed since the item built — a human's call.
                    return halt("drift")
    else:
        res["drift"] = "no-oracle-command: nothing to compare (noted, never fatal)"

    # (d) merge — the marker grammar the provenance checker already knows survives.
    merge = _git(repo, "merge", "--no-ff", item_branch, "-m",
                 f"Merge item {item} into integration [hatch:item-{item}]")
    if merge.returncode != 0:
        conflicts = [line.strip() for line in
                     _git(repo, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
                     if line.strip()]
        # A conflicted MERGE_HEAD must never be left for the next item: git merge --abort,
        # then verify the tree is clean and HEAD is back at the recorded pre-merge tip.
        _git(repo, "merge", "--abort")
        if _porcelain(repo) or _rev(repo, "HEAD") != pre_tip:
            _forced_unwind(repo, slug, pre_tip)
        print(f"merge_item: merge conflict on: {', '.join(conflicts) or '(unreported paths)'}",
              file=sys.stderr)
        return halt("merge")
    merge_commit = _rev(repo, "HEAD")
    res["merge_commit"] = merge_commit

    # (e) re-validation always re-executes — there is no skip-on-match: a matching
    # command hash says nothing about the composed tree, which is what merge-time
    # re-validation exists to test.
    if command:
        cwd = (repo / oracle["cwd"]).resolve() if oracle.get("cwd") else repo
        record = _run_oracle_record(command, cwd, expect)
        res["revalidation"] = record
    else:
        record = {"success": True}
        res["revalidation"] = {"skipped": "oracle has no command"}

    # (e2) clean and unmoved after the oracle.
    moved, dirty = _state_after(repo, branch, merge_commit or "")
    if not record.get("success"):
        step = "tip-moved" if moved else "revalidation"
        if (not moved and dirty and record.get("tree_changed")
                and record.get("exit_status") == 0 and not record.get("timed_out")
                and (record.get("expect") or {}).get("matched", True)):
            # The runner now rejects source mutation itself. Preserve the merge
            # protocol's existing diagnostic and unwind behavior for that case.
            step = "dirty-after-oracle"
        _forced_unwind(repo, slug, pre_tip)
        return halt(step)
    if moved:
        # A full unwind to the recorded PRE-MERGE tip, so a resumed run re-merges
        # from a known state instead of finding the item half-landed.
        _forced_unwind(repo, slug, pre_tip)
        return halt("tip-moved")
    if dirty:
        # The oracle validated a tree that is not the merge commit — halts exactly
        # like a failed oracle.
        _forced_unwind(repo, slug, pre_tip)
        return halt("dirty-after-oracle")

    # (f) done ref.
    upd = _git(repo, "update-ref", done_ref, merge_commit or "")
    if upd.returncode != 0:
        print(f"merge_item: update-ref failed: {upd.stderr.strip()}", file=sys.stderr)
        return halt("done-ref-write")
    res["done_ref"] = {"ref": done_ref, "target": merge_commit}
    return emit(0)


# --- close-wave -----------------------------------------------------------


def cmd_close_wave(args: argparse.Namespace) -> int:
    repo = args.repo.resolve()
    slug = args.slug
    branch = f"hatch/{slug}/integration"

    res: dict = {
        "subcommand": "close-wave",
        "tip": None,
        "checks": [],
        "shared_terms": None,
        "halted_at": None,
    }

    def emit(code: int) -> int:
        print(json.dumps(res, indent=2))
        return code

    def halt(step: str) -> int:
        res["halted_at"] = step
        return emit(1)

    if _symref(repo) != f"refs/heads/{branch}":
        return halt("head-not-integration")
    if _porcelain(repo):
        return halt("dirty-on-entry")
    entry_tip = _rev(repo, "HEAD")
    if entry_tip is None:
        return halt("no-entry-tip")
    res["tip"] = entry_tip

    def settle(record: dict, kind: str) -> str | None:
        """After every check: the branch and tip close-wave started on must be
        unchanged, and the tree clean. Returns the halt step name, or None."""
        moved, dirty = _state_after(repo, branch, entry_tip)
        if moved:
            # Same shared five-step unwind back to the recorded entry tip.
            _forced_unwind(repo, slug, entry_tip)
            return "tip-moved"
        if dirty:
            # git reset --hard HEAD moves no ref and, unlike a pathspec checkout,
            # also clears a STAGED mutation (a check that ran `git add` would
            # otherwise leave the index dirty); then git clean -fd, so a mutating
            # check never strands the worktree for the next merge.
            _git(repo, "reset", "--hard", "HEAD")
            _git(repo, "clean", "-fd")
            if _porcelain(repo):
                print("merge_item: dirty-after-check cleanup left a dirty tree", file=sys.stderr)
            return "dirty-after-check"
        if not record.get("success"):
            return kind
        return None

    for command in args.check:
        record = _run_oracle_record(command, repo, None)
        res["checks"].append({"command": command, "record": record})
        step = settle(record, "check")
        if step is not None:
            return halt(step)

    st_cmd = (f"{_shell_quote_path(sys.executable)} {_shell_quote_path(str(SHARED_TERMS))} "
              f"--binder {_shell_quote_path(str(args.binder.resolve()))}")
    st_record = _run_oracle_record(st_cmd, repo, None)
    res["shared_terms"] = st_record
    step = settle(st_record, "shared-terms")
    if step is not None:
        return halt(step)

    # No tag on any path — the wave tag is tag-wave's alone, after Phase 4 resolves.
    return emit(0)


# --- tag-wave -------------------------------------------------------------


def cmd_tag_wave(args: argparse.Namespace) -> int:
    repo = args.repo.resolve()
    slug = args.slug
    # Tag the explicitly resolved integration tip read at entry, and nothing else.
    tip = _rev(repo, f"refs/heads/hatch/{slug}/integration")
    if tip is None:
        print(f"merge_item: no integration branch hatch/{slug}/integration", file=sys.stderr)
        return 2
    tag = f"hatch/{slug}/wave-{args.wave}"
    p = _git(repo, "tag", tag, tip)
    if p.returncode != 0:
        print(f"merge_item: git tag failed: {p.stderr.strip()}", file=sys.stderr)
        return 1
    print(json.dumps({"subcommand": "tag-wave", "tag": tag, "target": tip}, indent=2))
    return 0


# --- self-test ------------------------------------------------------------


def _run_guard_self_test() -> int:
    """Focused real-Git controls; never run merge/unwind against a user repo."""
    os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
    os.environ["GIT_CONFIG_SYSTEM"] = os.devnull
    os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
    os.environ.pop("GIT_CONFIG_COUNT", None)
    os.environ.pop("GIT_CONFIG_PARAMETERS", None)
    passed = total = 0

    def check(name: str, ok: bool) -> None:
        nonlocal passed, total
        total += 1
        passed += int(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")

    def g(repo: Path, *args: str) -> str:
        p = _git(repo, *args)
        if p.returncode:
            raise RuntimeError(p.stderr)
        return p.stdout

    with tempfile.TemporaryDirectory(prefix="merge_guards_") as directory:
        root = Path(directory)
        serial = 0

        def fixture(path: str = "f.txt") -> tuple[Path, Path]:
            nonlocal serial
            serial += 1
            repo = root / str(serial)
            repo.mkdir()
            g(repo, "init", "-q", "-b", "hatch/s/integration")
            g(repo, "config", "user.name", "Test")
            g(repo, "config", "user.email", "test@example.invalid")
            g(repo, "config", "core.autocrlf", "true")
            g(repo, "config", "diff.autoRefreshIndex", "false")
            file = repo / path
            file.write_bytes(b"one\ntwo\n")
            g(repo, "--literal-pathspecs", "add", "--", path)
            g(repo, "commit", "-qm", "base")
            file.unlink()
            g(repo, "--literal-pathspecs", "checkout", "--", path)
            assert file.read_bytes() == b"one\r\ntwo\r\n"
            return repo, file

        names = ["f.txt", "space & name.txt", "-option.txt", "[literal].txt",
                 " leading.txt", "quote'name.txt", "semi;colon.txt"]
        if os.name != "nt":
            names += ["line\nbreak.txt", "carriage\rreturn.txt", ":(glob)*"]
        for name in names:
            repo, file = fixture(name)
            file.write_bytes(b"one\ntwo\n")
            raw = g(repo, "status", "--porcelain=v1", "-z")
            check(f"reproduces EOL-only status {name!r}", raw.startswith(" M "))
            index = g(repo, "ls-files", "--stage", "-z")
            check(f"normalized EOL-only clean {name!r}", not _porcelain(repo))
            check(f"guard preserves staged entries {name!r}",
                  g(repo, "ls-files", "--stage", "-z") == index)

        repo, file = fixture()
        check("clean checkout stays clean", not _porcelain(repo))
        for kind in ("content", "whitespace", "staged", "cancel", "add",
                     "delete", "staged-delete", "rename", "untracked", "intent", "mode"):
            repo, file = fixture()
            if kind in ("content", "whitespace", "staged", "cancel"):
                file.write_bytes(b"one \ntwo\n" if kind == "whitespace" else b"changed\n")
                if kind in ("staged", "cancel"):
                    g(repo, "add", "f.txt")
                if kind == "cancel":
                    file.write_bytes(b"one\ntwo\n")
            elif kind in ("add", "untracked", "intent"):
                (repo / "new.txt").write_bytes(b"new\n")
                if kind == "add":
                    g(repo, "add", "new.txt")
                if kind == "intent":
                    g(repo, "add", "-N", "new.txt")
            elif kind == "delete":
                file.unlink()
            elif kind == "staged-delete":
                g(repo, "rm", "-q", "f.txt")
            elif kind == "rename":
                g(repo, "mv", "f.txt", "renamed & file.txt")
            elif kind == "mode":
                g(repo, "update-index", "--chmod=+x", "f.txt")
            index = g(repo, "ls-files", "--stage", "-z")
            dirty = _porcelain(repo)
            check(f"{kind} stays dirty without staging",
                  bool(dirty) and g(repo, "ls-files", "--stage", "-z") == index)
            if kind == "rename":
                check("rename source retained", "f.txt\0" in dirty
                      and "renamed & file.txt\0" in dirty)

        # A glob must not select a second, truly dirty path.
        repo, file = fixture("[ab].txt")
        (repo / "a.txt").write_bytes(b"base\n")
        g(repo, "add", "a.txt")
        g(repo, "commit", "-qm", "literal control")
        file.write_bytes(b"one\ntwo\n")
        (repo / "a.txt").write_bytes(b"changed\n")
        dirty = _porcelain(repo)
        check("literal path comparison ignores glob meaning",
              "[ab].txt" not in dirty and "a.txt" in dirty)

        repo, file = fixture()
        g(repo, "checkout", "-qb", "other")
        file.write_bytes(b"other\n")
        g(repo, "add", "f.txt")
        g(repo, "commit", "-qm", "other")
        g(repo, "checkout", "-q", "hatch/s/integration")
        file.write_bytes(b"integration\n")
        g(repo, "add", "f.txt")
        g(repo, "commit", "-qm", "integration")
        conflict = _git(repo, "merge", "--no-edit", "other")
        check("unmerged conflict stays dirty",
              conflict.returncode == 1 and "UU f.txt\0" in _porcelain(repo))

        for kind in ("content", "untracked", "tip"):
            repo, _ = fixture()
            source, _ = fixture()
            g(repo, "-c", "protocol.file.allow=always",
              "submodule", "add", "-q", str(source), "sub")
            g(repo, "commit", "-qam", "submodule")
            sub = repo / "sub"
            if kind == "untracked":
                (sub / "new.txt").write_bytes(b"new\n")
            else:
                (sub / "f.txt").write_bytes(b"submodule change\n")
                if kind == "tip":
                    g(sub, "add", "f.txt")
                    g(sub, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                      "commit", "-qm", "next")
            check(f"submodule {kind} stays dirty", bool(_porcelain(repo)))

        if os.name != "nt":
            repo, file = fixture()
            g(repo, "config", "core.filemode", "true")
            file.chmod(0o755)
            check("unstaged executable mode stays dirty", bool(_porcelain(repo)))
        else:
            print("[SKIP] unstaged POSIX executable-bit control on Windows")

        # Real Git failures must raise, never silently return clean.
        try:
            _porcelain(root)
        except RuntimeError:
            check("status failure halts loudly", True)
        else:
            check("status failure halts loudly", False)
        repo, file = fixture()
        file.write_bytes(b"changed\n")
        sha = g(repo, "rev-parse", "HEAD:f.txt").strip()
        blob = repo / ".git" / "objects" / sha[:2] / sha[2:]
        blob.chmod(0o600)
        blob.unlink()  # Corrupt only this disposable fixture, not a user repo.
        check("diff-error fixture has valid status",
              _git(repo, "status", "--porcelain=v1", "-z").returncode == 0)
        try:
            _porcelain(repo)
        except RuntimeError:
            check("diff failure halts loudly", True)
        else:
            check("diff failure halts loudly", False)

        # Exercise the actual close-wave command builder and runner.
        for path in (r"C:\Program Files\Python\python.exe", r"C:\a&b\script name.py"):
            check(f"shell quotes path {path!r}",
                  _shell_quote_path(path) == (f'"{path}"' if os.name == "nt" else shlex.quote(path)))
        repo, _ = fixture()
        binder = root / "binder space & name.json"
        binder.write_text('{"slug":"s","work_items":[],"shared_terms":[]}', encoding="utf-8")
        for exists in (True, False):
            if not exists:
                binder.unlink()
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                code = cmd_close_wave(argparse.Namespace(
                    repo=repo, slug="s", binder=binder, check=["echo CHECK-OK"]))
            result = json.loads(buf.getvalue())
            record = result.get("shared_terms") or {}
            check(f"shared terms {'success' if exists else 'missing binder fails'} through runner",
                  (code == 0 if exists else code == 1)
                  and record.get("success") is exists
                  and (record.get("exit_status") == 0 if exists else
                       record.get("exit_status", 0) != 0))
    print(f"\n{passed}/{total} checks passed")
    return int(passed != total)


def _run_self_test() -> int:  # noqa: C901 — one hermetic harness, many named cases
    # Hermetic: never inherit the developer's global/system git config — a signing key,
    # hooksPath, or credential helper would hang or taint the harness's temp repos.
    os.environ["GIT_CONFIG_GLOBAL"] = os.devnull
    os.environ["GIT_CONFIG_SYSTEM"] = os.devnull
    os.environ["GIT_CONFIG_NOSYSTEM"] = "1"
    os.environ.pop("GIT_CONFIG_COUNT", None)      # command-scope config env leaks in too
    os.environ.pop("GIT_CONFIG_PARAMETERS", None)
    passed = 0
    total = 0
    failures = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal passed, total, failures
        total += 1
        if ok:
            passed += 1
        else:
            failures += 1
        suffix = f": {detail}" if detail else ""
        print(f"[{'PASS' if ok else 'FAIL'}] {name}{suffix}")

    def g(repo: Path, *a: str) -> subprocess.CompletedProcess:
        p = _git(repo, *a)
        if p.returncode != 0:
            raise RuntimeError(f"fixture git {' '.join(a)}: {p.stderr.strip()}")
        return p

    def run_cli(argv: list[str]) -> tuple[int, dict | None]:
        buf = io.StringIO()
        err = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
            code = main(argv)
        try:
            obj = json.loads(buf.getvalue())
        except json.JSONDecodeError:
            obj = None
        return code, obj

    tmp = Path(tempfile.mkdtemp(prefix="merge_item_selftest_"))
    prior_cwd = Path.cwd()
    prior_git_ceiling = os.environ.get("GIT_CEILING_DIRECTORIES")
    # A fixture command that loses its requested cwd must fail inside the
    # disposable tree, never discover and mutate the checkout running the test.
    os.environ["GIT_CEILING_DIRECTORIES"] = str(tmp.parent.resolve())
    os.chdir(tmp)

    class Fx:
        pass

    def fixture(name: str, oracle_cmd: str, expect: str | None = None,
                conflict: bool = False, foreign: bool = False) -> Fx:
        f = Fx()
        repo = tmp / name
        repo.mkdir()
        g(repo, "init", "-q", "-b", "main")
        g(repo, "config", "user.email", "t@example.invalid")
        g(repo, "config", "user.name", "hatch self-test")
        (repo / "f.txt").write_text("line1\nline2\n", encoding="utf-8")
        g(repo, "add", "f.txt")
        g(repo, "commit", "-q", "-m", "base")
        if foreign:
            g(repo, "checkout", "-q", "-b", "foreign")
            (repo / "foreign.txt").write_text("foreign\n", encoding="utf-8")
            g(repo, "add", "foreign.txt")
            g(repo, "commit", "-q", "-m", "foreign work")
            g(repo, "checkout", "-q", "main")
        g(repo, "checkout", "-q", "-b", "hatch/s/integration")
        g(repo, "checkout", "-q", "-b", "hatch/s/item-a")
        (repo / "item.txt").write_text("item\n", encoding="utf-8")
        g(repo, "add", "item.txt")
        if conflict:
            (repo / "f.txt").write_text("item version\n", encoding="utf-8")
            g(repo, "add", "f.txt")
        g(repo, "commit", "-q", "-m", "the work [hatch:item-a]")
        g(repo, "checkout", "-q", "hatch/s/integration")
        if conflict:
            (repo / "f.txt").write_text("integration version\n", encoding="utf-8")
            g(repo, "add", "f.txt")
            g(repo, "commit", "-q", "-m", "integration drift")
        f.repo = repo
        f.binder = tmp / f"{name}-binder.json"
        oracle: dict = {"type": "smoke", "command": oracle_cmd}
        if expect:
            oracle["expect"] = expect
        f.binder.write_text(json.dumps(
            {"slug": "s", "work_items": [{"id": "a", "oracle": oracle}]}, indent=1), encoding="utf-8")
        # Evidence written by run_oracle.py --attach-ref, exactly as a build does.
        # The command runs in a scratch dir (never the fixture repo) — only its
        # command_sha256 matters here, not its outcome.
        scratch = tmp / f"{name}-scratch"
        scratch.mkdir()
        subprocess.run(
            [sys.executable, str(RUN_ORACLE), "--cwd", str(scratch),
             "--attach-ref", "refs/hatch/s/item-a/evidence", "--repo", str(repo), oracle_cmd],
            capture_output=True, text=True, encoding="utf-8", env=_utf8_python_env())
        f.item_tip = _rev(repo, "refs/heads/hatch/s/item-a")
        g(repo, "update-ref", "refs/hatch/s/item-a/built", f.item_tip)
        f.pre_tip = _rev(repo, "HEAD")
        return f

    def merge_args(f: Fx, *extra: str) -> list[str]:
        return ["merge", "--repo", str(f.repo), "--binder", str(f.binder),
                "--slug", "s", "--item", "a", *extra]

    def clean_at(f: Fx, tip: str) -> bool:
        return (_rev(f.repo, "refs/heads/hatch/s/integration") == tip
                and _rev(f.repo, "HEAD") == tip
                and _symref(f.repo) == "refs/heads/hatch/s/integration"
                and not _porcelain(f.repo))

    def no_done(f: Fx) -> bool:
        return _rev(f.repo, "refs/hatch/s/item-a/done") is None

    try:
        # 1. clean merge
        f = fixture("clean", "echo OK", expect="OK")
        code, res = run_cli(merge_args(f))
        merge_sha = _rev(f.repo, "refs/hatch/s/item-a/done")
        subject = _git(f.repo, "log", "-1", "--format=%s", merge_sha or "HEAD").stdout.strip()
        check("a clean merge writes the done ref and the merge commit carries the "
              "[hatch:item-a] marker",
              code == 0 and res is not None and res["halted_at"] is None
              and res["done_ref"] is not None and merge_sha is not None
              and "[hatch:item-a]" in subject and res["merge_commit"] == merge_sha
              and res["drift"] is False,
              f"code={code} subject={subject!r}")
        check("the merge result carries the fixed shape on the success path",
              res is not None and set(res) == {"item", "skipped_done", "provenance", "drift",
                                              "merge_commit", "revalidation", "done_ref",
                                              "halted_at"},
              str(sorted(res or {})))

        # 2-4. built/failed preconditions
        f = fixture("nobuilt", "echo OK")
        g(f.repo, "update-ref", "-d", "refs/hatch/s/item-a/built")
        code, res = run_cli(merge_args(f))
        check("a missing built ref halts before any merge with nothing written",
              code == 1 and res["halted_at"] == "built-ref"
              and clean_at(f, f.pre_tip) and no_done(f))

        f = fixture("stalebuilt", "echo OK")
        g(f.repo, "update-ref", "refs/hatch/s/item-a/built", f.pre_tip)
        code, res = run_cli(merge_args(f))
        check("a built ref not at the item tip halts with nothing written",
              code == 1 and res["halted_at"] == "built-ref" and no_done(f))

        f = fixture("failedref", "echo OK")
        g(f.repo, "update-ref", "refs/hatch/s/item-a/failed", f.item_tip)
        code, res = run_cli(merge_args(f))
        check("a present failed ref halts with nothing written",
              code == 1 and res["halted_at"] == "failed-ref" and no_done(f))

        # 5-6. worktree preconditions
        f = fixture("dirtywt", "echo OK")
        (f.repo / "f.txt").write_text("dirtied\n", encoding="utf-8")
        code, res = run_cli(merge_args(f))
        check("a dirty integration worktree halts before any merge",
              code == 1 and res["halted_at"] == "dirty-worktree" and no_done(f))

        f = fixture("wronghead", "echo OK")
        g(f.repo, "checkout", "-q", "main")
        code, res = run_cli(merge_args(f))
        check("a HEAD not on the integration branch halts before any merge",
              code == 1 and res["halted_at"] == "head-not-integration" and no_done(f))

        # 7. conflict
        f = fixture("conflict", "echo OK", conflict=True)
        code, res = run_cli(merge_args(f))
        check("a conflicting item branch is aborted, leaving a clean tree at the "
              "pre-merge tip and no done ref",
              code == 1 and res["halted_at"] == "merge"
              and clean_at(f, f.pre_tip) and no_done(f))

        # 8. dirty-after-oracle, passing oracle
        f = fixture("dirtyoracle", "echo dirty>junk.txt")
        code, res = run_cli(merge_args(f))
        check("an oracle that exits 0 but creates an untracked file halts as "
              "dirty-after-oracle with the file removed and no done ref",
              code == 1 and res["halted_at"] == "dirty-after-oracle"
              and clean_at(f, f.pre_tip) and no_done(f)
              and not (f.repo / "junk.txt").exists())

        # 9. failing oracle that dirties the tree
        f = fixture(
            "dirtyfail", "echo dirty>junk.txt && git show definitely-missing-ref")
        code, res = run_cli(merge_args(f))
        check("an oracle that fails after creating an untracked file leaves a clean "
              "tree at the pre-merge tip",
              code == 1 and res["halted_at"] == "revalidation"
              and clean_at(f, f.pre_tip) and no_done(f)
              and not (f.repo / "junk.txt").exists())

        # 10. reset oracle
        # HEAD~1, not HEAD^: cmd.exe eats a bare caret, which would silently
        # turn this reset into a no-op and stop the fixture moving the tip.
        f = fixture("resetoracle", "git reset --hard HEAD~1 -q")
        code, res = run_cli(merge_args(f))
        check("an oracle that exits 0 after a hard reset halts as tip-moved with the "
              "pre-merge tip restored and no done ref",
              code == 1 and res["halted_at"] == "tip-moved"
              and clean_at(f, f.pre_tip) and no_done(f))

        # 11. detached HEAD oracle
        f = fixture("detach", "git checkout -q --detach")
        code, res = run_cli(merge_args(f))
        check("an oracle that detaches HEAD while the branch still points at the merge "
              "halts as tip-moved with both the integration ref and HEAD restored",
              code == 1 and res["halted_at"] == "tip-moved"
              and clean_at(f, f.pre_tip) and no_done(f))

        # 12. switch-to-other-branch oracle
        f = fixture("switch", "git checkout -q main")
        code, res = run_cli(merge_args(f))
        check("an oracle that switches to another branch halts as tip-moved with HEAD "
              "back on integration at the pre-merge tip",
              code == 1 and res["halted_at"] == "tip-moved"
              and clean_at(f, f.pre_tip) and no_done(f))

        # 13. foreign divergent branch + tracked modification, both oracle outcomes
        for tag, cmd in (("exit-0-then-rejected", "git checkout -q foreign && echo mod >> f.txt"),
                         ("exit-nonzero", "git checkout -q foreign && echo mod >> f.txt && exit 1")):
            f = fixture(f"foreign-{tag}", cmd, foreign=True)
            foreign_before = _rev(f.repo, "refs/heads/foreign")
            code, res = run_cli(merge_args(f))
            check(f"foreign divergent branch checked out and a tracked path modified "
                  f"({tag}): full unwind, foreign ref unchanged, no done ref",
                  code == 1 and res["halted_at"] in ("tip-moved", "revalidation")
                  and clean_at(f, f.pre_tip) and no_done(f)
                  and _rev(f.repo, "refs/heads/foreign") == foreign_before)

        # 14. oracle deletes the integration ref, both oracle outcomes
        for tag, cmd in (("exit-0-then-rejected",
                          "git update-ref -d refs/heads/hatch/s/integration"),
                         ("exit-nonzero",
                          "git update-ref -d refs/heads/hatch/s/integration && exit 1")):
            f = fixture(f"delref-{tag}", cmd)
            code, res = run_cli(merge_args(f))
            check(f"the integration ref deleted by the oracle ({tag}) is recreated at "
                  f"the pre-merge tip by the tip-moved unwind, no done ref",
                  code == 1 and res["halted_at"] == "tip-moved"
                  and clean_at(f, f.pre_tip) and no_done(f))

        # 15. plain failing oracle on the merged tip
        f = fixture("oraclefail", "false")
        code, res = run_cli(merge_args(f))
        check("an oracle that fails on the merged tip resets the branch to the "
              "recorded pre-merge tip and writes no done ref and exits 1",
              code == 1 and res["halted_at"] == "revalidation"
              and clean_at(f, f.pre_tip) and no_done(f))

        # 16. drift
        f = fixture("drift", "echo OK", expect="OK")
        drifted = dict(json.loads(f.binder.read_text(encoding="utf-8")))
        drifted["work_items"][0]["oracle"]["command"] = "echo OK # drifted"
        f.binder.write_text(json.dumps(drifted, indent=1), encoding="utf-8")
        code, res = run_cli(merge_args(f))
        check("a drifted command_sha256 halts without --allow-drift, before any merge",
              code == 1 and res["halted_at"] == "drift" and res["drift"] is True
              and clean_at(f, f.pre_tip) and no_done(f))
        code, res = run_cli(merge_args(f, "--allow-drift"))
        check("the same drift proceeds with --allow-drift and reports drift true",
              code == 0 and res["halted_at"] is None and res["drift"] is True
              and not no_done(f))

        # 16b. missing evidence ref is noted, never fatal
        f = fixture("noevidence", "echo OK", expect="OK")
        g(f.repo, "update-ref", "-d", "refs/hatch/s/item-a/evidence")
        code, res = run_cli(merge_args(f))
        check("a missing evidence ref is noted in the result and never blocks the merge",
              code == 0 and isinstance(res["drift"], str)
              and res["drift"].startswith("evidence-missing") and not no_done(f))

        # 17. done-ref idempotency
        f = fixture("doneskip", "echo OK", expect="OK")
        # wave-mate lands first, then item-a — the narrow <done>^1..<done> range
        # must not see the wave-mate's commits.
        g(f.repo, "checkout", "-q", "-b", "hatch/s/item-b")
        (f.repo / "b.txt").write_text("b\n", encoding="utf-8")
        g(f.repo, "add", "b.txt")
        g(f.repo, "commit", "-q", "-m", "wave mate [hatch:item-b]")
        g(f.repo, "checkout", "-q", "hatch/s/integration")
        g(f.repo, "merge", "-q", "--no-ff", "hatch/s/item-b", "-m",
          "Merge item b into integration [hatch:item-b]")
        g(f.repo, "merge", "-q", "--no-ff", "hatch/s/item-a", "-m",
          "Merge item a into integration [hatch:item-a]")
        done_sha = _rev(f.repo, "HEAD")
        g(f.repo, "update-ref", "refs/hatch/s/item-a/done", done_sha)
        code, res = run_cli(merge_args(f))
        check("a genuine done merge that follows another item's merge is skipped "
              "cleanly (done-provenance over the narrow range) with skipped_done true",
              code == 0 and res["skipped_done"] is True
              and res["done_ref"]["target"] == done_sha)

        f = fixture("doneoffchain", "echo OK", expect="OK")
        g(f.repo, "update-ref", "refs/hatch/s/item-a/done", f.item_tip)
        code, res = run_cli(merge_args(f))
        check("a done ref pointing off-chain halts as done-provenance instead of "
              "being skipped",
              code == 1 and res["halted_at"] == "done-provenance")

        # 17b. accepted done, with and without the item marker
        def accept_fixture(name: str, subject: str) -> Fx:
            f = fixture(name, "echo OK", expect="OK")
            g(f.repo, "checkout", "-q", "-b", "hatch/s/item-b")
            (f.repo / "b.txt").write_text("b\n", encoding="utf-8")
            g(f.repo, "add", "b.txt")
            g(f.repo, "commit", "-q", "-m", "wave mate [hatch:item-b]")
            g(f.repo, "checkout", "-q", "hatch/s/integration")
            g(f.repo, "merge", "-q", "--no-ff", "hatch/s/item-b", "-m",
              "Merge item b into integration [hatch:item-b]")
            g(f.repo, "merge", "-q", "--no-ff", "hatch/s/item-a", "-m",
              f"{subject}\n\nHatch-Accepted: item-a\nHatch-Accept-Reason: waived at the prompt")
            done_sha = _rev(f.repo, "HEAD")
            g(f.repo, "update-ref", "refs/hatch/s/item-a/done", done_sha)
            g(f.repo, "update-ref", "refs/hatch/s/item-a/accepted", f.item_tip)
            g(f.repo, "update-ref", "-d", "refs/hatch/s/item-a/built")
            return f

        f = accept_fixture("acceptmarked", "Accept item a into integration [hatch:item-a]")
        code, res = run_cli(merge_args(f))
        check("an accepted done — the doctrine's accept subject with the marker and "
              "both trailers, merged after a wave-mate — is skipped cleanly "
              "(done-provenance honors it)",
              code == 0 and res["skipped_done"] is True)

        f = accept_fixture("acceptunmarked", "Accept item a into integration")
        code, res = run_cli(merge_args(f))
        check("the same accept merge without the [hatch:item-a] marker halts as "
              "done-provenance ('no marker' over the narrow range)",
              code == 1 and res["halted_at"] == "done-provenance"
              and "no marker" in (res["provenance"] or {}).get("output", ""))

        # 18. close-wave
        f = fixture("closewave", "echo OK", expect="OK")

        def close_args(*checks: str) -> list[str]:
            argv = ["close-wave", "--repo", str(f.repo), "--binder", str(f.binder),
                    "--slug", "s"]
            for c in checks:
                argv += ["--check", c]
            return argv

        def no_tags() -> bool:
            return not _git(f.repo, "tag", "-l").stdout.strip()

        code, res = run_cli(close_args("echo A", "echo B"))
        check("close-wave exits 0 when every --check passes, carries the shared_terms "
              "key in its result, and writes no tag",
              code == 0 and res["halted_at"] is None and len(res["checks"]) == 2
              and "shared_terms" in res and res["shared_terms"]["success"] is True
              and no_tags())
        code, res = run_cli(close_args("echo A", "false"))
        check("close-wave exits nonzero when a --check fails, and writes no tag on "
              "that path either",
              code == 1 and res["halted_at"] == "check" and no_tags())

        entry = _rev(f.repo, "HEAD")
        code, res = run_cli(close_args("echo x >> f.txt"))
        check("a close-wave check that exits 0 after modifying a tracked file halts as "
              "dirty-after-check with the tree restored",
              code == 1 and res["halted_at"] == "dirty-after-check"
              and clean_at(f, entry) and no_tags())
        code, res = run_cli(close_args("echo x >> f.txt && exit 1"))
        check("a close-wave check that fails after modifying a tracked file is "
              "restored too (dirty-after-check on the failing path)",
              code == 1 and res["halted_at"] == "dirty-after-check"
              and clean_at(f, entry))
        code, res = run_cli(close_args("echo x >> f.txt && git add f.txt"))
        check("a close-wave check that staged its modification is cleared as well — "
              "dirty-after-check clears a staged mutation",
              code == 1 and res["halted_at"] == "dirty-after-check"
              and clean_at(f, entry))

        for tag, cmd in (("exit-0-then-rejected", "git commit -q --allow-empty -m boom"),
                         ("exit-nonzero", "git commit -q --allow-empty -m boom && exit 1")):
            code, res = run_cli(close_args(cmd))
            check(f"a close-wave check that commits ({tag}) routes through the shared "
                  f"unwind back to the entry tip: tip-moved",
                  code == 1 and res["halted_at"] == "tip-moved" and clean_at(f, entry))
        for tag, cmd in (("exit-0-then-rejected",
                          "git update-ref -d refs/heads/hatch/s/integration"),
                         ("exit-nonzero",
                          "git update-ref -d refs/heads/hatch/s/integration && exit 1")):
            code, res = run_cli(close_args(cmd))
            check(f"a close-wave check that deletes the integration ref ({tag}) is "
                  f"unwound back to the entry tip: tip-moved",
                  code == 1 and res["halted_at"] == "tip-moved" and clean_at(f, entry))

        # 19. tag-wave
        code, res = run_cli(["tag-wave", "--repo", str(f.repo), "--slug", "s", "--wave", "1"])
        tag_target = _rev(f.repo, "hatch/s/wave-1")
        check("tag-wave writes hatch/<slug>/wave-<N> at the integration tip and "
              "nothing else",
              code == 0 and res["tag"] == "hatch/s/wave-1" and tag_target == entry
              and clean_at(f, entry))

        # 20. A stopped merge_item stops the oracle it started. Real CLI, real
        # signals, real process groups. The marker's writer is a backgrounded
        # descendant, so stopping only the shell, or only the top process, leaves it
        # running.
        if os.name != "nt":
            stop_dir = tmp / "stop"
            stop_dir.mkdir()
            cases = iter(range(1000))
            # The real runner's command sits in a session of its own. This stand-in
            # leaves the command in the runner's group, and handles no signal, so
            # only a signal to that whole group ends the command.
            stand_in = stop_dir / "stand_in_runner.py"
            stand_in.write_text(
                "import subprocess, sys, time\n"
                "subprocess.Popen(['sh', '-c', sys.argv[-1]])\n"
                "time.sleep(60)\n", encoding="utf-8")
            # Holds merge_item inside its stop until the group's SIGKILL.
            stubborn = stop_dir / "stubborn_runner.py"
            stubborn.write_text(
                "import signal, subprocess, sys, time\n"
                "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
                "subprocess.Popen(['sh', '-c', sys.argv[-1]])\n"
                "time.sleep(60)\n", encoding="utf-8")
            driver = ("import pathlib, sys\n"
                      "sys.dont_write_bytecode = True\n"
                      "sys.path.insert(0, sys.argv[1])\n"
                      "import merge_item\n"
                      "merge_item.RUN_ORACLE = pathlib.Path(sys.argv[2])\n"
                      "merge_item.ORACLE_STOP_GRACE = 0.6\n"
                      "sys.exit(merge_item.main(sys.argv[3:]))\n")

            def stop_cli(sig: signal.Signals, disposition=None, runner: Path | None = None,
                         again: signal.Signals | None = None,
                         gap: float = 0.0) -> tuple[int | None, bool, bool]:
                """Start close-wave on a check that would write a marker in 2 s, signal
                merge_item alone once the check runs, then `again` after `gap` seconds,
                and report (exit, whether the command's group is gone, whether the marker
                appeared)."""
                case = next(cases)
                pid_file = stop_dir / f"{case}.pid"
                marker = stop_dir / f"{case}.marker"
                command = (f"echo $$ > {_shell_quote_path(str(pid_file))}; "
                           f"(sleep 2; touch {_shell_quote_path(str(marker))}) & wait")
                cli = [sys.executable, str(Path(__file__).resolve())]
                if runner is not None:
                    cli = [sys.executable, "-c", driver, str(SCRIPT_DIR), str(runner)]

                def set_disposition() -> None:
                    if disposition is not None:
                        signal.signal(sig, disposition)

                group = 0
                with subprocess.Popen(
                        [*cli, *close_args(command)], stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL, env=_utf8_python_env(),
                        preexec_fn=set_disposition) as cli_proc:
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline and not group:
                        text = pid_file.read_text(encoding="utf-8").strip() if pid_file.exists() else ""
                        group = int(text) if text else 0
                        time.sleep(0.02)
                    time.sleep(0.3)  # past the start of the runner's own stop path
                    cli_proc.send_signal(sig)
                    if again is not None:
                        time.sleep(gap)
                        cli_proc.send_signal(again)
                    try:
                        code = cli_proc.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        cli_proc.kill()
                        code = None
                time.sleep(2.5)
                try:
                    os.killpg(group, 0)
                    gone = False
                except ProcessLookupError:
                    gone = True
                written = marker.exists()
                with contextlib.suppress(ProcessLookupError, PermissionError):
                    os.killpg(group, signal.SIGKILL)
                return code, gone, written

            for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                code, gone, written = stop_cli(sig, signal.SIG_DFL)
                check(f"{sig.name} to merge_item stops the oracle's command, "
                      f"backgrounded descendant included",
                      code == 128 + sig and gone and not written,
                      f"exit={code} gone={gone} marker={written}")
            code, _gone, written = stop_cli(signal.SIGTERM, signal.SIG_DFL, stand_in)
            check("the stop signal reaches the whole group of the process merge_item "
                  "started, not only that process",
                  code == 128 + signal.SIGTERM and not written,
                  f"exit={code} marker={written}")
            code, gone, written = stop_cli(signal.SIGTERM, signal.SIG_DFL, again=signal.SIGTERM)
            check("two signals in quick succession stop the oracle's command once",
                  code == 128 + signal.SIGTERM and gone and not written,
                  f"exit={code} gone={gone} marker={written}")
            code, _gone, written = stop_cli(signal.SIGTERM, signal.SIG_DFL, stubborn,
                                            again=signal.SIGINT, gap=0.2)
            check("a second signal during the stop does not skip the group's SIGKILL, and "
                  "the exit names the first signal",
                  code == 128 + signal.SIGTERM and not written,
                  f"exit={code} marker={written}")
            code, _gone, written = stop_cli(signal.SIGHUP, signal.SIG_IGN)
            check("SIGHUP ignored at the start stays ignored: the check finishes",
                  code == 0 and written, f"exit={code} marker={written}")

            # The handlers belong to the oracle call alone: outside it a signal must
            # find what it found before this branch, so a git call can finish.
            stop_signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
            caller_handler = lambda *_: None  # noqa: E731
            prior = {sig: signal.signal(sig, caller_handler) for sig in stop_signals}
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
            before = {sig: signal.getsignal(sig) for sig in stop_signals}
            try:
                _run_oracle_record("echo OK", tmp, None)
                check("the signal handlers after an oracle call equal those before it",
                      {sig: signal.getsignal(sig) for sig in stop_signals} == before,
                      str({sig.name: signal.getsignal(sig) for sig in stop_signals}))
                run_cli(close_args("echo A"))
                check("the signal handlers after main() equal those before it",
                      {sig: signal.getsignal(sig) for sig in stop_signals} == before,
                      str({sig.name: signal.getsignal(sig) for sig in stop_signals}))
                stopper = threading.Timer(0.5, os.kill, (os.getpid(), signal.SIGTERM))
                stopper.start()
                try:
                    _run_oracle_record("sleep 5", tmp, None)
                    stopped = None
                except SystemExit as e:
                    stopped = e.code
                stopper.join()
                check("the signal handlers after a stopped oracle call equal those before it",
                      stopped == 128 + signal.SIGTERM
                      and {sig: signal.getsignal(sig) for sig in stop_signals} == before,
                      f"exit={stopped}")
            finally:
                for sig, handler in prior.items():
                    signal.signal(sig, handler)

            # Negative control: nothing can catch SIGKILL, so the command outlives
            # merge_item, which shows the probes above can see a survivor.
            code, gone, written = stop_cli(signal.SIGKILL)
            check("control: a command outliving a SIGKILLed merge_item is visible to "
                  "the probes", code == -signal.SIGKILL and written,
                  f"exit={code} gone={gone} marker={written}")

    finally:
        os.chdir(prior_cwd)
        if prior_git_ceiling is None:
            os.environ.pop("GIT_CEILING_DIRECTORIES", None)
        else:
            os.environ["GIT_CEILING_DIRECTORIES"] = prior_git_ceiling
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{passed}/{total} checks passed")
    return 1 if failures else 0


# --- CLI ------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="merge_item.py",
        description="hatch serial merge queue, one command per item: "
                    "merge / close-wave / tag-wave.",
    )
    ap.add_argument("--self-test", action="store_true",
                    help="run embedded hermetic fixtures and exit 0/1")
    ap.add_argument("--self-test-guards", action="store_true",
                    help="run focused status and quoting fixtures")
    sub = ap.add_subparsers(dest="subcommand")

    p_merge = sub.add_parser("merge", help="merge one built item into the integration branch")
    p_merge.add_argument("--repo", type=Path, required=True, help="the integration worktree")
    p_merge.add_argument("--binder", type=Path, required=True, help="the binder JSON path")
    p_merge.add_argument("--slug", required=True, help="the binder slug")
    p_merge.add_argument("--item", required=True, help="the work item id")
    p_merge.add_argument("--allow-drift", action="store_true",
                         help="proceed although the binder oracle's command changed "
                              "since the item built (a human's call)")

    p_close = sub.add_parser("close-wave", help="run the post-wave checks; never tags")
    p_close.add_argument("--repo", type=Path, required=True, help="the integration worktree")
    p_close.add_argument("--binder", type=Path, required=True, help="the binder JSON path")
    p_close.add_argument("--slug", required=True, help="the binder slug")
    p_close.add_argument("--check", action="append", required=True,
                         help="a post-wave check command (repeatable); the project's "
                              "resolved build/type-check, never env_contract.command")

    p_tag = sub.add_parser("tag-wave", help="write the wave success tag at the integration tip")
    p_tag.add_argument("--repo", type=Path, required=True, help="the integration worktree")
    p_tag.add_argument("--slug", required=True, help="the binder slug")
    p_tag.add_argument("--wave", required=True, help="the wave number")

    args = ap.parse_args(argv)

    if args.self_test_guards:
        return _run_guard_self_test()
    if args.self_test:
        return _run_self_test()
    if args.subcommand == "merge":
        return cmd_merge(args)
    if args.subcommand == "close-wave":
        return cmd_close_wave(args)
    if args.subcommand == "tag-wave":
        return cmd_tag_wave(args)
    ap.error("a subcommand (merge, close-wave, tag-wave) or --self-test is required")
    return 2


if __name__ == "__main__":
    sys.exit(main())
