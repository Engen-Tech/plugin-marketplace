# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch item-provenance checker: assert an item's commit and accept provenance from git.

Two doctrine rules from skills/_shared/integration-branch.md live today only as prose.
This script asserts both from git itself, so the merge queue can check an item before
merging it instead of trusting a report:

  1. MARKER. Every commit in the item's range carries that item's commit marker, in
     one of the two forms the doctrine sanctions: the bracket marker `[hatch:item-<id>]`
     in the subject, or a `Hatch-Item: item-<id>` git trailer when a Conventional-Commits
     type prefix owns the subject. A Pi-delivered merge made before the runtime adopted
     the documented `Merge item <id> into integration [hatch:item-<id>]` subject carries
     the legacy `[hatch:merge-item-<id>]` marker instead; that form counts for the same
     item, and a legacy marker naming a different item is reported as marked for another
     item like any other. An unmarked commit, or one marked for another item,
     is a finding naming the sha. Merge commits are held to the same rule — the worker
     writes their message too, so an unmarked merge in an item range is an untraceable
     commit like any other.

  2. ACCEPTED STATE (with --check-accepted --slug). Git refs carry no authorship and
     trailers are worker-forgeable; the one thing a worker cannot forge is a commit on
     `hatch/<slug>/integration`, which has exactly one writer. So an `accepted` ref is
     honored only if its companion `done` merge is FIRST-PARENT-REACHABLE on the
     integration branch AND carries the `Hatch-Accepted` and `Hatch-Accept-Reason`
     trailers. An accepted ref with no such done merge is a finding, and so is any
     trailer-bearing commit sitting off that first-parent chain — a side-branch accept
     is exactly the forgery the reachability rule exists to catch.

The script only READS git (rev-list, log, rev-parse, for-each-ref). It never writes a ref.

Stdlib only. Invoked directly (not installed), matching the non-executable mode of
sibling scripts:

Usage:
  python3 skills/hatch-deliver/scripts/check_item_provenance.py \\
      --repo DIR --item ID --range A..B [--slug SLUG] [--check-accepted]
  python3 skills/hatch-deliver/scripts/check_item_provenance.py --self-test

Exit codes: 0 = no findings, 1 = findings (or self-test failure), 2 = usage error.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ACCEPT_TRAILERS = ("Hatch-Accepted", "Hatch-Accept-Reason")


class GitError(RuntimeError):
    """A read-only git call failed — the caller reports it as a usage error, never a
    finding: a repo we cannot read is not a repo we can judge."""


def _git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", "-C", str(repo), *args],
                          capture_output=True, text=True, encoding="utf-8")
    if proc.returncode != 0:
        raise GitError(f"git {' '.join(args)}: {proc.stderr.strip() or proc.stdout.strip()}")
    return proc.stdout


def _commits_in_range(repo: Path, rng: str) -> list[str]:
    out = _git(repo, "rev-list", rng)
    return [line.strip() for line in out.splitlines() if line.strip()]


def _message(repo: Path, sha: str) -> str:
    return _git(repo, "log", "-1", "--format=%B", sha)


def _subject(repo: Path, sha: str) -> str:
    return _git(repo, "log", "-1", "--format=%s", sha).strip()


def _trailer_values(message: str, key: str) -> list[str]:
    """Every `Key: value` trailer-shaped line in a commit message."""
    prefix = key + ":"
    return [line.strip()[len(prefix):].strip()
            for line in message.splitlines()
            if line.strip().startswith(prefix)]


def commit_is_marked(repo: Path, sha: str, item_id: str) -> tuple[bool, str]:
    """Is this commit marked for `item_id`? Returns (marked, what-was-found)."""
    subject = _subject(repo, sha)
    message = _message(repo, sha)

    if f"[hatch:item-{item_id}]" in subject:
        return True, "subject marker"
    if f"[hatch:merge-item-{item_id}]" in subject:
        return True, "legacy pi merge marker"
    if f"item-{item_id}" in _trailer_values(message, "Hatch-Item"):
        return True, "Hatch-Item trailer"

    # Marked, but for some other item: name that, it is a different mistake.
    other_subject = [tok for tok in _bracket_ids(subject) if tok != item_id]
    other_legacy = [tok for tok in _legacy_merge_ids(subject) if tok != item_id]
    other_trailer = [v for v in _trailer_values(message, "Hatch-Item")
                     if v != f"item-{item_id}"]
    if other_subject or other_legacy or other_trailer:
        found = ", ".join(other_subject + other_legacy + other_trailer)
        return False, f"marked for another item ({found})"
    return False, "no marker"


def _bracket_ids(subject: str) -> list[str]:
    """Ids inside any `[hatch:item-<id>]` marker in a subject line."""
    ids = []
    needle = "[hatch:item-"
    start = subject.find(needle)
    while start != -1:
        end = subject.find("]", start)
        if end == -1:
            break
        ids.append(subject[start + len(needle):end])
        start = subject.find(needle, end)
    return ids


def _legacy_merge_ids(subject: str) -> list[str]:
    """Ids inside any `[hatch:merge-item-<id>]` legacy Pi merge marker in a subject.

    The needle is distinct from `_bracket_ids`'s `[hatch:item-`: the `merge-` segment
    sits between `hatch:` and `item-`, so a legacy marker is never mis-parsed as an
    item marker (or the reverse)."""
    ids = []
    needle = "[hatch:merge-item-"
    start = subject.find(needle)
    while start != -1:
        end = subject.find("]", start)
        if end == -1:
            break
        ids.append(subject[start + len(needle):end])
        start = subject.find(needle, end)
    return ids


def check_markers(repo: Path, item_id: str, rng: str) -> list[str]:
    """Rule 1 — every commit in the range carries this item's marker."""
    findings: list[str] = []
    commits = _commits_in_range(repo, rng)
    if not commits:
        findings.append(f"marker: the range {rng} contains no commits — nothing to trace")
        return findings
    for sha in commits:
        marked, detail = commit_is_marked(repo, sha, item_id)
        if not marked:
            findings.append(
                f"marker: {sha[:12]} carries no marker for item '{item_id}' ({detail}) — "
                f"subject: {_subject(repo, sha)!r}"
            )
    return findings


def _ref_sha(repo: Path, ref: str) -> str | None:
    proc = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", ref + "^{commit}"],
                          capture_output=True, text=True, encoding="utf-8")
    out = proc.stdout.strip()
    return out or None


def _first_parent_chain(repo: Path, branch: str) -> list[str]:
    return [line.strip() for line in
            _git(repo, "rev-list", "--first-parent", branch).splitlines() if line.strip()]


def _slug_refs(repo: Path, slug: str) -> list[str]:
    """Every ref this binder owns: its integration branch, its item branches, and its
    refs/hatch/<slug>/ namespace. The forged-accept scan looks only here."""
    out = _git(repo, "for-each-ref", "--format=%(refname)",
               f"refs/heads/hatch/{slug}/", f"refs/hatch/{slug}/")
    return [line.strip() for line in out.splitlines() if line.strip()]


def check_accepted(repo: Path, slug: str, item_id: str) -> list[str]:
    """Rule 2 — an accepted ref is honored only against a first-parent-reachable,
    trailer-bearing done merge; and no trailer-bearing commit sits off that chain."""
    findings: list[str] = []
    integration = f"hatch/{slug}/integration"
    if _ref_sha(repo, integration) is None:
        findings.append(f"accepted: no integration branch '{integration}' to check reachability against")
        return findings

    chain = set(_first_parent_chain(repo, integration))

    accepted_ref = f"refs/hatch/{slug}/item-{item_id}/accepted"
    done_ref = f"refs/hatch/{slug}/item-{item_id}/done"
    accepted = _ref_sha(repo, accepted_ref)
    done = _ref_sha(repo, done_ref)

    if accepted is not None:
        if done is None:
            findings.append(
                f"accepted: {accepted_ref} exists but there is no {done_ref} — an accepted "
                f"ref with no companion done merge is not honored"
            )
        elif done not in chain:
            findings.append(
                f"accepted: the done merge {done[:12]} is not first-parent-reachable on "
                f"'{integration}' — only the single tip writer can produce an accept"
            )
        else:
            msg = _message(repo, done)
            missing = [t for t in ACCEPT_TRAILERS if not _trailer_values(msg, t)]
            if missing:
                findings.append(
                    f"accepted: the done merge {done[:12]} is missing the "
                    f"{', '.join(missing)} trailer(s) that record the waiver"
                )

    # Any trailer-bearing commit off the first-parent chain is a forged accept. The
    # scan is scoped twice over — to this slug's own refs, and then to commits that
    # name THIS item. Both narrowings are load-carrying: a slug's branches carry the
    # whole repo history, so scoping by ref alone reads every older binder's
    # legitimate accept (long since merged onward, and so no longer on this branch's
    # first-parent chain) as a forgery. The forgery this rule exists to catch is a
    # worker manufacturing an accept for its own item, and that commit names it.
    scan_refs = _slug_refs(repo, slug)
    stamped = [line.strip() for line in
               _git(repo, "log", "--format=%H", "--extended-regexp",
                    f"--grep=^{ACCEPT_TRAILERS[0]}:", *scan_refs).splitlines()
               if line.strip()] if scan_refs else []
    for sha in stamped:
        if f"item-{item_id}" not in _message(repo, sha):
            continue  # an accept belonging to some other item, not ours to judge
        if sha not in chain:
            findings.append(
                f"accepted: {sha[:12]} carries {ACCEPT_TRAILERS[0]} trailers but sits off the "
                f"first-parent chain of '{integration}' — suspect, never silently honored"
            )
    return findings


def _run_self_test() -> int:
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

    def init(root: Path) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        _git(root, "init", "-q", "-b", "main")
        _git(root, "config", "user.email", "t@example.invalid")
        _git(root, "config", "user.name", "hatch self-test")
        return root

    def commit(root: Path, message: str) -> str:
        _git(root, "commit", "-q", "--allow-empty", "-m", message)
        return _ref_sha(root, "HEAD") or ""

    tmp = Path(tempfile.mkdtemp(prefix="check_item_provenance_selftest_"))
    try:
        # --- markers -------------------------------------------------------
        r = init(tmp / "markers")
        base = commit(r, "base")
        commit(r, "add the thing [hatch:item-a]")
        commit(r, "feat(x): add another thing\n\nBody.\n\nHatch-Item: item-a")
        check("subject marker and Hatch-Item trailer both count",
              check_markers(r, "a", f"{base}..HEAD") == [])

        unmarked = commit(r, "unmarked change")
        f = check_markers(r, "a", f"{base}..HEAD")
        check("NEGATIVE CONTROL: an unmarked commit is a finding naming its sha",
              len(f) == 1 and unmarked[:12] in f[0] and "no marker" in f[0], str(f))

        r2 = init(tmp / "wrongitem")
        b2 = commit(r2, "base")
        wrong = commit(r2, "do a thing [hatch:item-b]")
        f = check_markers(r2, "a", f"{b2}..HEAD")
        check("NEGATIVE CONTROL: a marker for another item is a finding, named as such",
              len(f) == 1 and wrong[:12] in f[0] and "marked for another item (b)" in f[0], str(f))

        wrong_trailer_repo = init(tmp / "wrongtrailer")
        b3 = commit(wrong_trailer_repo, "base")
        commit(wrong_trailer_repo, "feat: x\n\nHatch-Item: item-b")
        f = check_markers(wrong_trailer_repo, "a", f"{b3}..HEAD")
        check("NEGATIVE CONTROL: a trailer for another item is a finding",
              len(f) == 1 and "marked for another item (item-b)" in f[0], str(f))

        # The Pi runtime's legacy merge marker: same item counts, another item does not,
        # and the documented subject counts.
        legacy = init(tmp / "legacy-merge")
        b4 = commit(legacy, "base")
        commit(legacy, "[hatch:merge-item-a] integrate item-a")
        marked, detail = commit_is_marked(legacy, _ref_sha(legacy, "HEAD") or "", "a")
        check("a legacy Pi merge marker for the same item counts, named as legacy",
              marked and "legacy" in detail, detail)
        check("check_markers accepts a legacy Pi merge marker for the same item",
              check_markers(legacy, "a", f"{b4}..HEAD") == [])

        legacy_wrong = init(tmp / "legacy-merge-wrong")
        b5 = commit(legacy_wrong, "base")
        wrong_merge = commit(legacy_wrong, "[hatch:merge-item-b] integrate item-b")
        f = check_markers(legacy_wrong, "a", f"{b5}..HEAD")
        check("NEGATIVE CONTROL: a legacy Pi merge marker for another item is a finding, "
              "never a match",
              len(f) == 1 and wrong_merge[:12] in f[0]
              and "marked for another item (b)" in f[0], str(f))

        documented = init(tmp / "documented-merge")
        b6 = commit(documented, "base")
        commit(documented, "Merge item a into integration [hatch:item-a]")
        check("the documented integration merge subject counts",
              check_markers(documented, "a", f"{b6}..HEAD") == [])

        check("an empty range is a finding, never a silent pass",
              len(check_markers(r, "a", "HEAD..HEAD")) == 1)

        # --- accepted state ------------------------------------------------
        # A real accept: item branch merged into integration as a first-parent merge
        # commit on that branch, carrying both waiver trailers.
        a = init(tmp / "accept-good")
        commit(a, "base")
        _git(a, "checkout", "-q", "-b", "hatch/s/integration")
        _git(a, "checkout", "-q", "-b", "hatch/s/item-a")
        item_tip = commit(a, "the work [hatch:item-a]")
        _git(a, "checkout", "-q", "hatch/s/integration")
        _git(a, "merge", "-q", "--no-ff", "hatch/s/item-a", "-m",
             "hatch: merge item-a\n\nHatch-Accepted: item-a\nHatch-Accept-Reason: human said so")
        merge_sha = _ref_sha(a, "HEAD") or ""
        _git(a, "update-ref", f"refs/hatch/s/item-a/done", merge_sha)
        _git(a, "update-ref", f"refs/hatch/s/item-a/accepted", item_tip)
        check("a first-parent-reachable, trailered done merge honors the accepted ref",
              check_accepted(a, "s", "a") == [], str(check_accepted(a, "s", "a")))

        # NEGATIVE CONTROL: the same trailers on a side branch, never merged into
        # integration's first-parent chain — the forgery the rule exists to catch.
        _git(a, "checkout", "-q", "hatch/s/item-a")
        forged = commit(a, "hatch: merge item-a\n\nHatch-Accepted: item-a\n"
                           "Hatch-Accept-Reason: forged at a worker tip")
        _git(a, "checkout", "-q", "hatch/s/integration")
        f = check_accepted(a, "s", "a")
        check("NEGATIVE CONTROL: a trailered commit forged at the worker's own tip, off the "
              "first-parent chain, is a finding",
              len(f) == 1 and forged[:12] in f[0] and "off the first-parent chain" in f[0], str(f))

        # The scope of that rule, proved: the SAME off-chain shape belonging to another
        # item is not this item's finding. Without this, the check reads every older
        # binder's legitimate accept as a forgery (it did, on the hatch repo itself).
        _git(a, "checkout", "-q", "-b", "hatch/s/item-z", "hatch/s/item-a")
        commit(a, "hatch: merge item-z\n\nHatch-Accepted: item-z\n"
                  "Hatch-Accept-Reason: another item's accept, off this chain")
        _git(a, "checkout", "-q", "hatch/s/integration")
        f = check_accepted(a, "s", "a")
        check("another item's off-chain accept is not this item's finding",
              len(f) == 1 and forged[:12] in f[0], str(f))

        # NEGATIVE CONTROL: accepted ref with no done ref at all.
        b = init(tmp / "accept-nodone")
        commit(b, "base")
        _git(b, "checkout", "-q", "-b", "hatch/s/integration")
        _git(b, "checkout", "-q", "-b", "hatch/s/item-a")
        tip = commit(b, "the work [hatch:item-a]")
        _git(b, "checkout", "-q", "hatch/s/integration")
        _git(b, "update-ref", "refs/hatch/s/item-a/accepted", tip)
        f = check_accepted(b, "s", "a")
        check("NEGATIVE CONTROL: an accepted ref with no done merge is a finding",
              len(f) == 1 and "no refs/hatch/s/item-a/done" in f[0], str(f))

        # NEGATIVE CONTROL: done merge reachable but the waiver trailers are absent.
        c = init(tmp / "accept-notrailers")
        commit(c, "base")
        _git(c, "checkout", "-q", "-b", "hatch/s/integration")
        _git(c, "checkout", "-q", "-b", "hatch/s/item-a")
        tip = commit(c, "the work [hatch:item-a]")
        _git(c, "checkout", "-q", "hatch/s/integration")
        _git(c, "merge", "-q", "--no-ff", "hatch/s/item-a", "-m", "hatch: merge item-a")
        _git(c, "update-ref", "refs/hatch/s/item-a/done", _ref_sha(c, "HEAD") or "")
        _git(c, "update-ref", "refs/hatch/s/item-a/accepted", tip)
        f = check_accepted(c, "s", "a")
        check("NEGATIVE CONTROL: a reachable done merge without the waiver trailers is a finding",
              len(f) == 1 and "missing the Hatch-Accepted, Hatch-Accept-Reason trailer(s)" in f[0],
              str(f))

        # A clean-done item (no accepted ref, no trailers anywhere) has nothing to answer for.
        d = init(tmp / "clean-done")
        commit(d, "base")
        _git(d, "checkout", "-q", "-b", "hatch/s/integration")
        _git(d, "checkout", "-q", "-b", "hatch/s/item-a")
        commit(d, "the work [hatch:item-a]")
        _git(d, "checkout", "-q", "hatch/s/integration")
        _git(d, "merge", "-q", "--no-ff", "hatch/s/item-a", "-m", "hatch: merge item-a")
        _git(d, "update-ref", "refs/hatch/s/item-a/done", _ref_sha(d, "HEAD") or "")
        check("a clean-done item with no accepted ref is clean",
              check_accepted(d, "s", "a") == [], str(check_accepted(d, "s", "a")))

        # --- the script writes no refs --------------------------------------
        before = _git(a, "for-each-ref", "--format=%(refname) %(objectname)")
        check_markers(a, "a", "hatch/s/integration~1..hatch/s/item-a")
        check_accepted(a, "s", "a")
        check("the checker writes no ref",
              _git(a, "for-each-ref", "--format=%(refname) %(objectname)") == before)

        # --- end-to-end through main() ---------------------------------------
        quiet = io.StringIO()
        with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            clean = main(["--repo", str(r2), "--item", "b", "--range", f"{b2}..HEAD"])
            finding = main(["--repo", str(r2), "--item", "a", "--range", f"{b2}..HEAD"])
            usage = main(["--repo", str(r2), "--item", "a", "--range", "no-such-ref..HEAD"])
            needs_slug = main(["--repo", str(r2), "--item", "a", "--range", f"{b2}..HEAD",
                               "--check-accepted"])
        check("main() exit codes: 0 clean / 1 findings / 2 bad range / 2 --check-accepted "
              "without --slug",
              clean == 0 and finding == 1 and usage == 2 and needs_slug == 2,
              f"{clean} {finding} {usage} {needs_slug}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"self-test: {passed}/{total} cases passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="check_item_provenance.py",
        description="Assert an item's commit-marker and accept provenance from git itself.",
    )
    ap.add_argument("--repo", type=Path, help="repository to read (read-only)")
    ap.add_argument("--item", help="work item id")
    ap.add_argument("--range", dest="rng", help="commit range to check, e.g. A..B")
    ap.add_argument("--slug", default=None, help="binder slug (required with --check-accepted)")
    ap.add_argument("--check-accepted", action="store_true",
                    help="also assert the accepted-ref/trailer/reachability rules")
    ap.add_argument("--self-test", action="store_true", help="run embedded fixtures and exit 0/1")
    args = ap.parse_args(argv)

    if args.self_test:
        return _run_self_test()

    missing = [n for n in ("repo", "item", "rng") if getattr(args, n) is None]
    if missing:
        ap.error("missing required argument(s): "
                 + ", ".join("--" + ("range" if n == "rng" else n) for n in missing))
    if args.check_accepted and not args.slug:
        print("check_item_provenance: --check-accepted needs --slug", file=sys.stderr)
        return 2
    if not args.repo.is_dir():
        print(f"check_item_provenance: --repo is not a directory: {args.repo}", file=sys.stderr)
        return 2

    try:
        findings = check_markers(args.repo, args.item, args.rng)
        if args.check_accepted:
            findings += check_accepted(args.repo, args.slug, args.item)
    except GitError as e:
        print(f"check_item_provenance: {e}", file=sys.stderr)
        return 2

    for f in findings:
        print(f)
    if findings:
        print(f"check_item_provenance: {len(findings)} finding(s)")
        return 1
    print("check_item_provenance: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
