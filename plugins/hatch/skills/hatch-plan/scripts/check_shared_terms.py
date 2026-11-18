# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Enforce a binder's declared `shared_terms` against the assembled tree.

A binder may declare canonical strings that several work items must render
byte-identically (see validate_binder.py for the plan-time schema check). This
script is the deliver-time enforcement point. An item counts as landed only when
its git done ref — refs/hatch/<slug>/item-<id>/done, probed under the scan root —
resolves and is an ancestor of the scan root's HEAD (for an item a successor binder carries, the ref under the slug of the binder
that delivered it, found by walking the `supersedes` chain back through
hatch-deliver's supersedes_chain.py); an item with no done ref on that history is not
yet landed (the default branch at plan time has not merged the delivery), so
every entry listing it is reported [PENDING] and skipped, never failed (a non-git scan
root, git being unavailable, or a chain that does not resolve leaves the item pending). The
[PENDING] line names why: no done ref, a done ref not on the scanned tree's history, or a
supersedes chain that does not resolve. For landed items the script reads the
touched files each actually produced and fails if a declared term drifted.

Zero dependencies (pure stdlib; the done-ref probe shells out to git, which is
already a hard hatch requirement), so every invocation form behaves identically —
nothing has to be provisioned before it runs:
  uv run --script check_shared_terms.py --binder <path> [root]   # check, exit 0/1
  uv run --script check_shared_terms.py --self-test              # embedded fixtures
  python3 check_shared_terms.py --binder <path> [root]           # also fine — no deps

`root` defaults to the current working directory (the assembled integration
worktree). Matching is exact substring over file bytes: no similarity threshold,
no language assumptions, no parsing — presence of the declared substring is the
whole reference check.
"""
from __future__ import annotations
import argparse, json, subprocess, sys
from pathlib import Path

# The supersedes-chain walk hatch-deliver's preflight uses, imported by path (no
# __init__.py in hatch-deliver/scripts). Without it (a partial install) a carried item is
# probed one hop back only, as before, and a twice-carried item stays PENDING. The import
# writes no bytecode: an installed plugin is a git clone that a __pycache__ dirties.
_CHAIN_DIR = str((Path(__file__).resolve().parent / ".." / ".." / "hatch-deliver" / "scripts").resolve())
if _CHAIN_DIR not in sys.path:
    sys.path.insert(0, _CHAIN_DIR)
_dwb, sys.dont_write_bytecode = sys.dont_write_bytecode, True
try:
    import supersedes_chain  # noqa: E402
except ImportError:
    supersedes_chain = None
finally:
    sys.dont_write_bytecode = _dwb


def _on_head(rev: str, root: Path) -> bool:
    """True iff `rev` resolves and is an ancestor of HEAD in the repo at `root`.

    Any failure — the rev absent, `root` not a git repository, git unavailable —
    means not landed. Callers turn that into PENDING, never a crash."""
    try:
        return subprocess.run(
            ["git", "merge-base", "--is-ancestor", rev, "HEAD"],
            cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):  # git missing, root unusable, or hung
        return False


NO_REF = "no done ref"
OFF_HISTORY = "done ref not on this tree's history"


def _git(root: Path, *args: str) -> subprocess.CompletedProcess:
    """One git call in `root` that never raises. Git missing, a hang, or output that is
    not UTF-8 (a committed plan, say) reads as a failed call whose stderr names the error:
    the item stays pending."""
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True,
                              encoding="utf-8", timeout=30)
    except (OSError, ValueError, subprocess.TimeoutExpired) as e:
        return subprocess.CompletedProcess(args, 1, "", str(e))


def _ref_why(rev: str, root: Path) -> str | None:
    """None iff `rev` is on the history of `root`'s HEAD; else why the item is pending."""
    if _on_head(rev, root):
        return None
    return OFF_HISTORY if _git(root, "rev-parse", "--verify", "--quiet", rev).returncode == 0 \
        else NO_REF


def _landed(slug: str, item_id: str, root: Path) -> bool:
    """True iff refs/hatch/<slug>/item-<item_id>/done is on the history of `root`'s HEAD.

    A done ref off that history (a delivery not merged into the scanned tree, such as the
    default branch at plan time) is not landed there: its files are not on the tree."""
    return _on_head(f"refs/hatch/{slug}/item-{item_id}/done", root)


def _carried_why(predecessor: str, item_id: str, slug: str, root: Path) -> str | None:
    """None iff the binder in the supersedes chain that delivered `item_id` has its done ref
    on the history of `root`'s HEAD; else why the item is pending.

    The predecessor's own ref is probed first (one hop, as before); past it the walk in
    supersedes_chain.py follows each binder's committed `supersedes` back. A chain that
    does not resolve, or a missing module, means not landed."""
    why = _ref_why(f"refs/hatch/{predecessor}/item-{item_id}/done", root)
    if why is None or supersedes_chain is None:
        return why
    got = supersedes_chain.resolve_delivery(lambda *a: _git(root, *a), predecessor, item_id, slug)
    if got.done is None:
        return f"supersedes chain unresolved ({got.reason})"
    return None if _on_head(got.done, root) else OFF_HISTORY


def evaluate_binder(binder: dict, root: Path) -> list[tuple[str, str, list[str], str]]:
    return [r[:4] for r in _evaluate(binder, root)]


def _evaluate(binder: dict, root: Path) -> list[tuple[str, str, list[str], str, dict]]:
    """Return one result per `shared_terms` entry: (id, status, items, canonical).

    status is one of:
      "OK"      — every listed item landed and has `canonical` in at least one
                  existing touched file.
      "PENDING" — at least one listed item is not yet landed — its git done ref
                  (refs/hatch/<slug>/item-<id>/done) does not resolve under `root` —
                  so the entry is skipped, never failed; `items` names the pending
                  items. A done ref off the history of `root`'s HEAD is not landed
                  there. A non-git root or missing git leaves every item pending.
      "FAIL"    — every listed item landed, but the `items` (offenders) lack the
                  term in every existing touched file (an offender with no touched
                  file left on the tree cannot render the term at all).

    An absent or empty `shared_terms` yields an empty list (a clean no-op pass).
    `_evaluate` adds a fifth element: for PENDING, each pending item's reason."""
    slug = binder.get("slug", "")
    # A successor binder's carried items landed under an earlier binder in the supersedes
    # chain; their done refs live there (deliver_preflight.py proves them before a
    # successor run starts).
    sup = binder.get("supersedes") if isinstance(binder.get("supersedes"), dict) else {}
    carried = set(sup.get("carried") or [])
    pred = sup.get("slug") if isinstance(sup.get("slug"), str) else slug

    def why(iid: str) -> str | None:
        if iid in carried:
            return _carried_why(pred, iid, slug, root)
        return _ref_why(f"refs/hatch/{slug}/item-{iid}/done", root)
    items_by_id = {it["id"]: it for it in binder.get("work_items", []) if isinstance(it, dict)}
    results: list[tuple[str, str, list[str], str, dict]] = []
    for entry in binder.get("shared_terms", []) or []:
        eid = entry.get("id", "<no-id>")
        canonical = entry.get("canonical", "")
        listed = entry.get("items", [])

        # An entry is only judged once every listed item has landed (done ref set).
        reasons = {iid: r for iid in listed if (r := why(iid)) is not None}
        if reasons:
            results.append((eid, "PENDING", list(reasons), canonical, reasons))
            continue

        # Gather, per listed item, the touched files that actually exist under root.
        per_item_existing: dict[str, list[Path]] = {}
        for iid in listed:
            item = items_by_id.get(iid)
            touches = item.get("touches", []) if isinstance(item, dict) else []
            per_item_existing[iid] = [root / t for t in touches if (root / t).is_file()]

        needle = canonical.encode("utf-8")
        offenders = [iid for iid, files in per_item_existing.items()
                     if not any(needle in f.read_bytes() for f in files)]
        results.append((eid, "FAIL" if offenders else "OK", offenders, canonical, {}))
    return results


def check(binder: dict, root: Path) -> tuple[int, list[str]]:
    """Evaluate `binder` under `root`; return (exit_code, human-readable lines).

    exit_code is 1 iff any entry is a violation. Pending and satisfied entries pass."""
    lines: list[str] = []
    violations = 0
    for eid, status, offenders, canonical, reasons in _evaluate(binder, root):
        if status == "FAIL":
            violations += 1
            who = ", ".join(offenders)
            lines.append(
                f"[FAIL] {eid}: item(s) {who} do not render the canonical term {canonical!r} "
                "byte-identically in any touched file")
        elif status == "PENDING":
            by_why: dict[str, list[str]] = {}
            for iid, r in reasons.items():
                by_why.setdefault(r, []).append(iid)
            said = "; ".join(f"item(s) {', '.join(ids)} not yet landed — {r}"
                             for r, ids in by_why.items())
            lines.append(f"[PENDING] {eid}: {said}; skipped")
        else:
            lines.append(f"[PASS] {eid}: every listed item renders the canonical term")
    return (1 if violations else 0, lines)


def _run_self_test() -> int:
    import os, tempfile

    # A realistic canonical substring, including a non-ASCII em dash, so the byte-identity
    # path is exercised (not just ASCII). Mirrors the dogfood string the design cites.
    CANON = "reuses an archived (delivered) slug — the delivered history is shadowed; pick a fresh slug"
    DRIFT = "reuses an archived slug - the history is shadowed; pick a fresh slug"

    def binder(items: list[dict], shared_terms=None) -> dict:
        b = {"slug": "t", "title": "T", "summary": "S", "motivation": "x",
             "scope": {"included": ["x"]}, "work_items": items}
        if shared_terms is not None:
            b["shared_terms"] = shared_terms
        return b

    def item(iid: str, touches: list[str]) -> dict:
        return {"id": iid, "title": iid, "summary": "s", "touches": touches,
                "oracle": {"type": "unit"}}

    def git(root: Path, *args: str, stdin: str | None = None) -> str:
        """Run git headless in a fixture repo: no global/system config, fixed identity."""
        env = dict(os.environ,
                   GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull,
                   GIT_AUTHOR_NAME="hatch-self-test", GIT_AUTHOR_EMAIL="self-test@hatch",
                   GIT_COMMITTER_NAME="hatch-self-test", GIT_COMMITTER_EMAIL="self-test@hatch")
        res = subprocess.run(["git", *args], cwd=root, env=env,
                             capture_output=True, text=True, input=stdin, encoding="utf-8")
        if res.returncode != 0:
            raise RuntimeError(f"git {' '.join(args)} failed: {res.stderr.strip()}")
        return res.stdout.strip()

    def init_repo(root: Path, landed: list[str]) -> None:
        """git init the fixture root and write a done ref for each landed item id."""
        git(root, "init", "-q")
        # A done ref counts only on HEAD's history: one empty-tree commit is both.
        tree = git(root, "hash-object", "-w", "-t", "tree", "--stdin", stdin="")
        head = git(root, "commit-tree", tree, "-m", "fixture")
        git(root, "update-ref", "HEAD", head)
        off = git(root, "commit-tree", tree, "-m", "a delivery HEAD has not merged")
        for iid in landed:  # "~id": the done ref stands on a commit off HEAD's history
            git(root, "update-ref", f"refs/hatch/t/item-{iid.lstrip('~')}/done",
                off if iid.startswith("~") else head)

    # Each case: (name, binder, tree, landed, want_exit, must_mention).
    # landed is a list of item ids whose done refs are written into a fixture git
    # repo at the scan root; None means no repo at all (the non-git root path).
    cases: list[tuple] = []

    # 1. every listed item landed and renders the term identically -> pass
    cases.append((
        "all landed items render the term identically",
        binder(
            [item("validator", ["validator.py"]), item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["validator", "engine"]}],
        ),
        {"validator.py": f"msg = '{CANON}'", "engine.py": f"warn('{CANON}')"},
        ["validator", "engine"],
        0, ("[PASS]",),
    ))

    # 2. a landed item drifts -> fail, naming the offending item + canonical
    cases.append((
        "landed item drifts",
        binder(
            [item("validator", ["validator.py"]), item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["validator", "engine"]}],
        ),
        {"validator.py": f"msg = '{CANON}'", "engine.py": f"warn('{DRIFT}')"},
        ["validator", "engine"],
        1, ("[FAIL]", "engine", CANON),
    ))

    # 3. an item with no done ref -> pending, skipped (not failed)
    cases.append((
        "item without a done ref is pending",
        binder(
            [item("validator", ["validator.py"]), item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["validator", "engine"]}],
        ),
        {"validator.py": f"msg = '{CANON}'"},  # engine not landed, nothing on the tree
        ["validator"],
        0, ("[PENDING]", "engine", "not yet landed — no done ref"),
    ))

    # 4. a binder with no shared_terms -> clean no-op pass (no lines, exit 0)
    cases.append((
        "binder with no shared_terms is a no-op pass",
        binder([item("validator", ["validator.py"])]),
        {"validator.py": "anything"},
        None,
        0, (),
    ))

    # 5. canonical present in one of several touched files -> pass
    cases.append((
        "canonical in one of several touched files",
        binder(
            [item("validator", ["a1.py", "a2.py"]), item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["validator", "engine"]}],
        ),
        {"a1.py": "unrelated", "a2.py": f"msg = '{CANON}'", "engine.py": f"'{CANON}'"},
        ["validator", "engine"],
        0, ("[PASS]",),
    ))

    # 6. an explicitly empty shared_terms list -> clean no-op pass
    cases.append((
        "empty shared_terms list is a no-op pass",
        binder([item("validator", ["validator.py"])], []),
        {"validator.py": "anything"},
        None,
        0, (),
    ))

    # 7. REGRESSION: touched file exists with the term absent, but the item has NO
    #    done ref -> pending, not fail (the old disk-existence proxy false-failed here)
    cases.append((
        "existing touched file without done ref is pending, not fail",
        binder(
            [item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["engine"]}],
        ),
        {"engine.py": f"warn('{DRIFT}')"},  # file on disk, term absent, item not landed
        [],
        0, ("[PENDING]", "engine", "not yet landed — no done ref"),
    ))

    # 8. a scan root that is not a git repository -> every item pending, no crash
    cases.append((
        "non-git root makes every item pending",
        binder(
            [item("validator", ["validator.py"]), item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["validator", "engine"]}],
        ),
        {"validator.py": f"msg = '{CANON}'", "engine.py": f"warn('{CANON}')"},
        None,
        0, ("[PENDING]", "validator", "engine", "not yet landed — no done ref"),
    ))

    # 9. a landed item whose touched files are all absent -> fail naming the item
    cases.append((
        "landed item with no touched file on the tree fails",
        binder(
            [item("validator", ["validator.py"]), item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["validator", "engine"]}],
        ),
        {"validator.py": f"msg = '{CANON}'"},  # engine landed but left nothing behind
        ["validator", "engine"],
        1, ("[FAIL]", "engine"),
    ))

    # 10. a done ref that is not on HEAD's history -> pending, and the line says so
    cases.append((
        "done ref off HEAD's history is pending and names why",
        binder(
            [item("validator", ["validator.py"]), item("engine", ["engine.py"])],
            [{"id": "shadow", "canonical": CANON, "items": ["validator", "engine"]}],
        ),
        {"validator.py": f"msg = '{CANON}'"},
        ["validator", "~engine"],
        0, ("[PENDING] shadow: item(s) engine not yet landed — done ref not on this "
            "tree's history; skipped",),
    ))

    failures = 0
    for name, b, tree, landed, want_exit, must_mention in cases:
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            if landed is not None:
                init_repo(root, landed)
            for rel, content in tree.items():
                p = root / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content, encoding="utf-8")
            code, lines = check(b, root)
        out = "\n".join(lines)
        ok = code == want_exit and all(m in out for m in must_mention)
        # A no-op case must additionally emit no per-entry lines at all.
        if not must_mention and lines:
            ok = False
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit={code} lines={lines}")
        if not ok:
            failures += 1

    print(f"\n{len(cases) - failures}/{len(cases)} checks passed")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Enforce a binder's declared shared_terms.")
    ap.add_argument("--binder", type=Path)
    ap.add_argument("root", nargs="?", type=Path, default=Path.cwd(),
                    help="repo root to scan (default: cwd)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return _run_self_test()
    if not args.binder:
        ap.error("provide --binder <path> [root] or --self-test")
    if not args.binder.is_file():
        print(f"INVALID: binder file not found: {args.binder}")
        return 1

    binder = json.loads(args.binder.read_text(encoding="utf-8"))
    code, lines = check(binder, args.root)
    for ln in lines:
        print(ln)
    if not lines:
        print("no shared_terms declared — nothing to check")
    print("SHARED TERMS: DRIFT" if code else "SHARED TERMS: OK")
    return code


if __name__ == "__main__":
    sys.exit(main())
