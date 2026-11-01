#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Codex SubagentStop guard: a whiffed work item must not vanish silently.

Codex twin of hooks/scripts/guard_subagent_whiff.py (the Claude Code guard).
The detection logic is identical — it inspects repo state only, never the
transcript. It closes the deferral recorded in
docs/specs/2026-07-14-delivery-stop-gate-design.md ("SubagentStop whiff-worker
detection ... a separate design"): a wave worker that ends having produced
NOTHING — the BLOCKED-empty whiff, hatch-build's "produced no changes" halt —
leaves no completion ref at all, so nothing downstream ever names it unless the
orchestrator happens to re-derive the frontier. This guard makes the residue
audible: when a hatch-typed subagent stops while such residue stands, it is
told once (exit 2, corrective stderr) to name the stranded items in its final
report so the orchestrating session re-derives the frontier
(deliver:waveloop Step 3).

SCOPE — deterministic identity only, honestly narrower than the ideal:
generic wave build workers are dispatched through the host's parallel
primitive and report a non-hatch-typed identity at SubagentStop —
indistinguishable from any explorer/validator subagent, and the payload
carries no item id, so per-worker attribution is impossible. Nudging every
non-hatch stop would trap unrelated subagents; this guard therefore fires
ONLY when the stopping subagent's top-level `agent_type` is hatch-typed — a
bare `hatch-*` name or a plugin-scoped `*:hatch-*` form (prefix match,
deliberately wider than an exact-match table: over-inclusion here costs one
advisory nudge, never a denial). Codex's SubagentStop input documents optional
top-level `agent_type` and `agent_id` fields; this guard reads `agent_type`
ONLY — `agent_id` is an opaque identifier, not a type, and is NEVER used to
infer identity, since typing from an id would be circumstance, not content. A
whiff in a wave of only non-hatch-typed workers surfaces later — at the next
hatch-typed subagent stop (each item's verification gate dispatches the typed
acceptance reviewer), at the orchestrator's own frontier re-derivation, and at
the session Stop-gate for the merge-queue states.

SIGNAL — deterministic git facts, never prose. A finding is a live-binder work
item (binder read like guard_delivery_stop.py: working tree or HEAD, never
archive/) where ALL hold:

- no ref of any state stands under `refs/hatch/<slug>/item-<id>/`;
- the item branch `hatch/<slug>/item-<id>` exists (Phase 4b created it), and
  its tip is an ancestor of the integration tip — the branch contributes no
  commits, "the branch equals its base" (hatch-build SKILL.md, whiff halt);
- the branch is not checked out in a worktree with visible uncommitted work
  (a wave-mate mid-implementation is git-identical to a whiff at branch/ref
  level; a dirty worktree is the one deterministic tell that work is in
  flight, so it excludes — a whiffed worker halts with nothing to show).

Every exclusion errs toward silence: a standing ref of any state, a branch
with commits (worker died after committing), a missing integration branch, an
unreadable binder, a dirty worktree, and a superseded binder all drop the item.
A superseded binder's items are excluded because its live successor re-plans
them (a successor's `supersedes` names it). The residual
false-positive window — a wave-mate between worktree creation and its first
edit — is accepted and stated in the nudge, which asserts only the git facts
and tells the orchestrator's frontier re-derivation to disambiguate.

CHANNELS — on a finding this emits BOTH block channels, as
guard_delivery_stop.py already does for Stop: the documented Codex block
decision `{"decision": "block", "reason": ...}` on stdout, and the same reason
on stderr with exit 2. A pass emits nothing on stdout — the JSON decision
appears only on a finding, in the mold of the Claude original.

POSTURE — advisory, FAIL-OPEN, stateless: any internal error exits 0 (a stray
SubagentStop trap is strictly worse than a missed nudge); unreadable payload,
missing fields, non-git cwd, and git-absent all pass. Loop safety needs no
sentinel: exit 2 makes the subagent continue, and its next stop arrives with
`stop_hook_active` true, which passes — the harness's own flag is the
block-once. A later hatch-typed subagent stopping on the same residue is
nudged again by design (no state is kept). Non-hatch stops take a pure
payload-check fast path with zero subprocess calls.

  guard_subagent_whiff.py              # hook mode: JSON payload/output, exit 0/2
  guard_subagent_whiff.py --self-test  # run embedded fixtures, exit 0/1
"""
from __future__ import annotations
import argparse, json, os, subprocess, sys, tempfile
from pathlib import Path

def _read_stdin_text() -> str:
    """The hook payload is UTF-8 JSON, whatever the host's locale codec is.

    sys.stdin decodes with the locale codec — cp1252 on a stock Windows
    session — which mojibakes or raises on a payload it cannot spell. Read
    the byte stream and decode explicitly; the getattr falls back for test
    doubles that carry no .buffer."""
    data = getattr(sys.stdin, "buffer", sys.stdin).read()
    return data.decode("utf-8") if isinstance(data, bytes) else data

GIT = "git"  # module-level so the self-test can simulate a git-absent host

WHIFF_MSG = (
    "hatch: a hatch-typed subagent ({agent}) is stopping while undelivered "
    "work stands with the empty-whiff signature: {names} — each has an item "
    "branch contributing no commits over its binder's integration branch and "
    "no refs/hatch state ref, the residue a wave worker leaves when it whiffs "
    "('produced no changes') or dies before its first commit (a wave-mate "
    "visibly mid-build in its worktree is excluded, but one still setting up "
    "can look identical — the orchestrator's frontier re-derivation "
    "disambiguates). Do not let this vanish silently: name these items and "
    "this cause in your final report so the orchestrating session re-derives "
    "the frontier (deliver:waveloop Step 3) and rebuilds or re-plans them. "
    "This advisory fires once — your next stop passes.")


def _git(repo: str | Path, *args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run([GIT, "-C", str(repo), *args],
                              capture_output=True, text=True, encoding="utf-8")
    except OSError:  # git binary absent/broken — fail open upstream
        return subprocess.CompletedProcess(args=(GIT, *args), returncode=127,
                                           stdout="", stderr="git unavailable")


def _repo_root(cwd: str) -> str | None:
    if not os.path.isdir(cwd):
        return None
    r = _git(cwd, "rev-parse", "--show-toplevel")
    return r.stdout.strip() if r.returncode == 0 and r.stdout.strip() else None


def _hatch_typed(agent_type: object) -> bool:
    """Bare `hatch-<name>` or plugin-scoped `<ns>:hatch-<name>`. Prefix, not
    table: this guard is advisory, so a future registered hatch-* agent is
    covered for free."""
    if not isinstance(agent_type, str):
        return False
    bare = agent_type.rsplit(":", 1)[-1]
    return bare.startswith("hatch-") and len(bare) > len("hatch-")


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


def _binder_doc(root: str, slug: str) -> dict | None:
    """The binder object — working tree first, else the HEAD blob. None =
    unreadable/malformed (the caller fails open for this binder)."""
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
    return data if isinstance(data, dict) else None


def _binder_item_ids(root: str, slug: str) -> list[str] | None:
    """Work-item ids from _binder_doc. None = unreadable/malformed (fail open
    for this binder)."""
    data = _binder_doc(root, slug)
    if data is None:
        return None
    items = data.get("work_items")
    if not isinstance(items, list):
        return None
    ids = [it.get("id") for it in items if isinstance(it, dict)]
    if len(ids) != len(items) or not all(isinstance(i, str) for i in ids):
        return None
    return ids


def _supersedes(binder: dict) -> tuple[str, list[str]] | None:
    """(predecessor slug, carried item ids) for a successor binder, else None.
    The shape is validate_binder.py's; a malformed value reads as absent — the
    same parser as skills/hatch-status/scripts/hatch_next.py, copied because
    this guard is a standalone stdlib script."""
    sup = binder.get("supersedes")
    if not isinstance(sup, dict) or not isinstance(sup.get("slug"), str):
        return None
    carried = sup.get("carried")
    if not isinstance(carried, list) or not all(isinstance(c, str) for c in carried):
        return None
    return sup["slug"], carried


def _superseded_slugs(root: str, live: list[str]) -> set[str]:
    """Slugs a live successor binder supersedes. The successor re-plans every
    non-carried predecessor item, so an empty branch left on the predecessor is
    planned work elsewhere, not stranded work. A malformed `supersedes` and a
    predecessor that is not live both exclude nothing (`hatch_next.py`'s
    `sup[0] in by_slug and sup[0] != slug` rule)."""
    live_set = set(live)
    out: set[str] = set()
    for slug in live:
        doc = _binder_doc(root, slug)
        if doc is None:
            continue  # unreadable/malformed successor — reads as no supersedes
        sup = _supersedes(doc)
        if sup and sup[0] in live_set and sup[0] != slug:
            out.add(sup[0])
    return out


def _items_with_any_ref(root: str, slug: str) -> set[str]:
    """Item ids with ANY standing ref under refs/hatch/<slug>/item-<id>/ —
    built/done/failed and any future state alike all mean "not a whiff", the
    quieter direction. Read via plumbing, never .git/refs files."""
    prefix = f"refs/hatch/{slug}/item-"
    have: set[str] = set()
    r = _git(root, "for-each-ref", "--format=%(refname)", f"refs/hatch/{slug}/")
    if r.returncode != 0:
        return have
    for ref in r.stdout.splitlines():
        if ref.startswith(prefix):
            item, sep, state = ref[len(prefix):].rpartition("/")
            if sep and item and state:
                have.add(item)
    return have


def _branch_worktrees(root: str) -> dict[str, str]:
    """branch name -> worktree path, from `git worktree list --porcelain`."""
    out: dict[str, str] = {}
    r = _git(root, "worktree", "list", "--porcelain")
    if r.returncode != 0:
        return out
    path: str | None = None
    for line in r.stdout.splitlines():
        if line.startswith("worktree "):
            path = line[len("worktree "):]
        elif line.startswith("branch refs/heads/") and path:
            out[line[len("branch refs/heads/"):]] = path
    return out


def _whiff_items(root: str) -> list[tuple[str, str]]:
    """(slug, item-id) pairs carrying the deterministic empty-whiff signature."""
    findings: list[tuple[str, str]] = []
    worktrees: dict[str, str] | None = None  # lazy — most repos have no candidates
    live = _live_slugs(root)
    superseded = _superseded_slugs(root, live)
    for slug in live:
        if slug in superseded:
            continue  # a live successor re-plans its items — not stranded work
        ids = _binder_item_ids(root, slug)
        if ids is None:
            continue  # unreadable/malformed binder — fail open for this slug
        r = _git(root, "rev-parse", "--verify", "--quiet",
                 f"refs/heads/hatch/{slug}/integration")
        if r.returncode != 0 or not r.stdout.strip():
            continue  # no integration branch — the base is unknowable, stay silent
        integration_tip = r.stdout.strip()
        reffed = _items_with_any_ref(root, slug)
        for item in ids:
            if item in reffed:
                continue  # any standing state ref — not a whiff
            branch = f"hatch/{slug}/item-{item}"
            b = _git(root, "rev-parse", "--verify", "--quiet",
                     f"refs/heads/{branch}")
            if b.returncode != 0 or not b.stdout.strip():
                continue  # branch never created — nothing stands to surface
            if _git(root, "merge-base", "--is-ancestor",
                    b.stdout.strip(), integration_tip).returncode != 0:
                continue  # branch has commits (or indeterminate) — not the empty whiff
            if worktrees is None:
                worktrees = _branch_worktrees(root)
            wt = worktrees.get(branch)
            if wt is not None:
                s = _git(wt, "status", "--porcelain")
                if s.returncode == 0 and s.stdout.strip():
                    continue  # visible work in progress — a wave-mate mid-build
            findings.append((slug, item))
    return findings


def block_json(reason: str) -> str:
    """The documented Codex block decision, emitted on stdout beside the
    exit-2 + stderr contract."""
    return json.dumps({"decision": "block", "reason": reason})


def decide(payload: object) -> tuple[int, str]:
    """Return (exit_code, stderr_reason)."""
    if not isinstance(payload, dict):
        return 0, ""
    if payload.get("hook_event_name") != "SubagentStop":
        return 0, ""  # Stop and anything else is not this guard's event
    if payload.get("stop_hook_active"):
        return 0, ""  # harness loop flag — the stateless block-once
    agent_type = payload.get("agent_type")
    if not _hatch_typed(agent_type):
        return 0, ""  # non-hatch-typed / foreign / absent — out of scope
    cwd = payload.get("cwd")
    if not isinstance(cwd, str):
        return 0, ""  # missing field — fail open
    root = _repo_root(cwd)
    if root is None:
        return 0, ""  # not a git repo (or no git) — nothing to check
    findings = _whiff_items(root)
    if not findings:
        return 0, ""
    names = ", ".join(f"{slug}/item-{item}" for slug, item in findings)
    return 2, WHIFF_MSG.format(agent=agent_type, names=names)


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
                     malformed: bool = False,
                     supersedes: dict | None = None) -> None:
        d = repo / ".hatch" / "binders"
        d.mkdir(parents=True, exist_ok=True)
        binder: dict = {"slug": slug, "work_items": [{"id": i} for i in ids]}
        if supersedes is not None:
            binder["supersedes"] = supersedes
        body = "{not json" if malformed else json.dumps(binder)
        (d / f"{slug}.json").write_text(body, encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", f"binder {slug}")

    def set_ref(repo: Path, slug: str, item: str, state: str,
                rev: str = "HEAD") -> None:
        sha = git(repo, "rev-parse", rev).stdout.strip()
        git(repo, "update-ref", f"refs/hatch/{slug}/item-{item}/{state}", sha)

    def whiff_repo(td: str, name: str, items: list[str] | None = None) -> Path:
        """Binder wip, integration branch, item-a branch at the integration tip
        with no state ref — the canonical empty-whiff residue."""
        repo = init_repo(td, name)
        write_binder(repo, "wip", items or ["a"])
        git(repo, "branch", "hatch/wip/integration")
        git(repo, "branch", "hatch/wip/item-a", "hatch/wip/integration")
        return repo

    def substop(repo_or_dir: Path, agent: str = "hatch-acceptance-reviewer",
                **over: object) -> dict:
        payload: dict = {"hook_event_name": "SubagentStop",
                         "agent_type": agent, "agent_id": "x1",
                         "cwd": str(repo_or_dir), "stop_hook_active": False,
                         "turn_id": "t1"}
        payload.update(over)
        return payload

    with tempfile.TemporaryDirectory() as td:
        # 1. unreadable payload shapes -> allow
        check("non-dict payload (None) allows", None, 0)
        check("non-dict payload (list) allows", [], 0)

        repo = whiff_repo(td, "whiff1")
        # 2. wrong event -> allow, even hatch-typed in a whiff repo
        check("Stop event allows (guard_delivery_stop's turf)",
              substop(repo, hook_event_name="Stop"), 0)
        # 3. non-hatch agent types -> allow in the same whiff repo (pins the
        #    honest scoping: generic wave workers are unidentifiable)
        check("general-purpose subagent allows despite standing whiff",
              substop(repo, agent="general-purpose"), 0)
        check("foreign plugin agent allows", substop(repo, agent="other:reviewer"), 0)
        check("missing agent_type allows", substop(repo, agent=None), 0)
        check("non-hatch prefix allows", substop(repo, agent="myhatch-build"), 0)
        # 4. hatch-typed + whiff residue -> block, naming slug/item
        reason = check("hatch-typed stop over whiff residue blocks",
                       substop(repo), 2)
        flag("reason names the stranded item and the frontier fix",
             "wip/item-a" in reason and "frontier" in reason
             and "hatch-acceptance-reviewer" in reason)
        # 5. plugin-scoped agent_type recognized
        check("plugin-scoped hatch agent_type blocks",
              substop(repo, agent="hatch:hatch-safety-auditor"), 2)
        # 6. stateless: an identical later stop by another agent nudges again
        check("identical repeated stop nudges again (stateless by design)",
              substop(repo), 2)
        # 7. stop_hook_active is the block-once
        check("stop_hook_active true allows (harness loop flag)",
              substop(repo, stop_hook_active=True), 0)
        # 8. payload cwd in a subdirectory -> still detects
        sub = repo / "docs"
        sub.mkdir()
        check("payload cwd in a subdirectory still detects", substop(sub), 2)

        # 9. clean worker: committed item branch + built ref -> allow
        repo = init_repo(td, "clean")
        write_binder(repo, "wip", ["a"])
        git(repo, "branch", "hatch/wip/integration")
        git(repo, "checkout", "-q", "-b", "hatch/wip/item-a",
            "hatch/wip/integration")
        (repo / "feature.txt").write_text("delivered\n", encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "item a")
        git(repo, "checkout", "-q", "main")
        set_ref(repo, "wip", "a", "built", "hatch/wip/item-a")
        check("clean worker (commits + built ref) allows", substop(repo), 0)
        # 10. committed branch with NO ref -> allow (died after committing —
        #     out of this guard's scope; Stop-gate territory once built lands)
        git(repo, "update-ref", "-d", "refs/hatch/wip/item-a/built")
        check("committed item branch with no ref allows (not the empty whiff)",
              substop(repo), 0)

        # 11. any standing state ref silences the empty branch
        for state in ("failed", "done", "in-progress"):
            repo = whiff_repo(td, f"ref-{state}")
            set_ref(repo, "wip", "a", state, "hatch/wip/integration")
            check(f"empty branch with a standing {state} ref allows",
                  substop(repo), 0)

        # 12. refless item with no branch at all -> allow (nothing stands)
        repo = init_repo(td, "nobranch")
        write_binder(repo, "wip", ["a"])
        git(repo, "branch", "hatch/wip/integration")
        check("undispatched item (no branch) allows", substop(repo), 0)

        # 13. no integration branch -> allow (base unknowable, fail open)
        repo = init_repo(td, "nointeg")
        write_binder(repo, "wip", ["a"])
        git(repo, "branch", "hatch/wip/item-a")
        check("missing integration branch allows", substop(repo), 0)

        # 14. archived-only binder with leftover empty branch -> allow
        repo = init_repo(td, "archived")
        d = repo / ".hatch" / "binders" / "archive"
        d.mkdir(parents=True)
        (d / "old.json").write_text(json.dumps(
            {"slug": "old", "work_items": [{"id": "a"}]}), encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "archive old")
        git(repo, "branch", "hatch/old/integration")
        git(repo, "branch", "hatch/old/item-a", "hatch/old/integration")
        check("archived-only binder with leftover empty branch allows",
              substop(repo), 0)

        # 15. malformed binder / empty work_items -> allow
        repo = init_repo(td, "malformed")
        write_binder(repo, "broken", [], malformed=True)
        check("malformed binder JSON allows (fail-open)", substop(repo), 0)
        repo = init_repo(td, "hollow")
        write_binder(repo, "hollow", [])
        git(repo, "branch", "hatch/hollow/integration")
        check("empty work_items allows", substop(repo), 0)

        # 16. integration moved past the whiff branch -> still an ancestor, blocks
        repo = whiff_repo(td, "moved")
        git(repo, "checkout", "-q", "hatch/wip/integration")
        (repo / "other.txt").write_text("wave-mate merged\n", encoding="utf-8")
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", "integration advanced")
        git(repo, "checkout", "-q", "main")
        check("whiff branch behind a moved integration tip still blocks",
              substop(repo), 2)

        # 17. dirty worktree excludes (wave-mate mid-build), clean fires
        repo = whiff_repo(td, "worktree")
        wt = Path(td) / "worktree-item-a"
        git(repo, "worktree", "add", str(wt), "hatch/wip/item-a")
        (wt / "in-progress.txt").write_text("half-written\n", encoding="utf-8")
        check("branch checked out in a DIRTY worktree allows (mid-build)",
              substop(repo), 0)
        (wt / "in-progress.txt").unlink()
        check("branch checked out in a CLEAN worktree still blocks (whiff halt "
              "preserves its worktree)", substop(repo), 2)

        # 18. two whiffed items -> one nudge naming both
        repo = whiff_repo(td, "double", items=["a", "b"])
        git(repo, "branch", "hatch/wip/item-b", "hatch/wip/integration")
        reason = check("two whiffed items nudge once", substop(repo), 2)
        flag("one reason names both items",
             "wip/item-a" in reason and "wip/item-b" in reason)

        # 19. cwd guards -> allow
        check("missing cwd allows", substop(repo, cwd=None), 0)
        check("cwd not a directory allows",
              substop(repo, cwd=str(repo / "no-such-dir")), 0)
        plain = Path(td) / "plain"
        plain.mkdir()
        check("non-git cwd allows", substop(plain), 0)

        # 20. git binary absent -> allow, even over real whiff residue
        repo = whiff_repo(td, "gitless")
        global GIT
        GIT = "git-definitely-absent-for-self-test"
        try:
            check("git-absent host allows (fail-open)", substop(repo), 0)
        finally:
            GIT = "git"

        # 21. agent_id must never type an agent, even over real residue
        repo = whiff_repo(td, "idonly")
        check("agent_id-only payload allows (agent_id never types an agent)",
              substop(repo, agent=None, agent_id="hatch-opaque-id"), 0)

        # 22. the stdout block decision is well-formed JSON
        parsed = json.loads(block_json("fix the delivery"))
        flag("block_json emits decision=block with the reason",
             parsed == {"decision": "block", "reason": "fix the delivery"})

        # 23. Hook-mode allow output emits nothing on stdout — the JSON
        #     decision appears only on a finding.
        repo = whiff_repo(td, "hookmode-allow")
        allowed = subprocess.run(
            [sys.executable, __file__],
            input=json.dumps(substop(repo, agent="general-purpose")),
            capture_output=True, text=True, encoding="utf-8")
        flag("hook-mode allow emits no decision on stdout",
             allowed.returncode == 0 and not allowed.stdout.strip())

        malformed = subprocess.run(
            [sys.executable, __file__], input="{not json",
            capture_output=True, text=True, encoding="utf-8")
        flag("hook-mode fail-open emits no decision on stdout",
             malformed.returncode == 0 and not malformed.stdout.strip())

        # 24. Hook-mode block output emits both channels.
        repo = whiff_repo(td, "hookmode-block")
        blocked = subprocess.run(
            [sys.executable, __file__],
            input=json.dumps(substop(repo)),
            capture_output=True, text=True, encoding="utf-8")
        try:
            blocked_stdout = json.loads(blocked.stdout)
        except json.JSONDecodeError:
            blocked_stdout = None
        flag("hook-mode block emits the JSON decision on stdout and the "
             "identical reason on stderr",
             blocked.returncode == 2
             and isinstance(blocked_stdout, dict)
             and blocked_stdout.get("decision") == "block"
             and bool(blocked_stdout.get("reason"))
             and blocked.stderr == blocked_stdout.get("reason") + "\n")

        # 25. superseded predecessor's leftover empty branch -> allow: the
        #     successor re-plans every non-carried item, and the carried ones
        #     were delivered by the predecessor.
        repo = init_repo(td, "superseded")
        write_binder(repo, "pred", ["a", "b"])
        write_binder(repo, "succ", ["c"],
                     supersedes={"slug": "pred", "carried": ["b"]})
        git(repo, "branch", "hatch/pred/integration")
        git(repo, "branch", "hatch/pred/item-a", "hatch/pred/integration")
        check("superseded predecessor's leftover empty branch allows",
              substop(repo), 0)

        # 26. the successor's own empty-whiff item still fires
        git(repo, "branch", "hatch/succ/integration")
        git(repo, "branch", "hatch/succ/item-c", "hatch/succ/integration")
        reason = check("the successor's own empty branch still fires",
                       substop(repo), 2)
        flag("reason names the successor item, not the predecessor's",
             "succ/item-c" in reason and "pred/item-a" not in reason)

        # 27. malformed supersedes (carried not a list) reads as absent -> the
        #     predecessor is checked as before.
        repo = init_repo(td, "badsupersedes")
        write_binder(repo, "pred", ["a"])
        write_binder(repo, "succ", ["c"],
                     supersedes={"slug": "pred", "carried": "b"})
        git(repo, "branch", "hatch/pred/integration")
        git(repo, "branch", "hatch/pred/item-a", "hatch/pred/integration")
        reason = check("malformed supersedes (carried not a list) still fires",
                       substop(repo), 2)
        flag("malformed supersedes names the predecessor item",
             "pred/item-a" in reason)

        # 28. a binder naming itself in supersedes is not excluded
        repo = init_repo(td, "selfsupersede")
        write_binder(repo, "self", ["a"],
                     supersedes={"slug": "self", "carried": []})
        git(repo, "branch", "hatch/self/integration")
        git(repo, "branch", "hatch/self/item-a", "hatch/self/integration")
        reason = check("a binder naming itself in supersedes still fires",
                       substop(repo), 2)
        flag("self-supersedes names its own item", "self/item-a" in reason)

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
        return 0  # fail open: a stray SubagentStop trap is worse than a missed nudge
    if code == 2:
        print(block_json(reason))          # Codex block decision channel
        print(reason, file=sys.stderr)     # exit-code channel
    return code


if __name__ == "__main__":
    sys.exit(main())
