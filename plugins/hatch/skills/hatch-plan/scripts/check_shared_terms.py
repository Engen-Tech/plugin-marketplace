# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Enforce a binder's declared `shared_terms` against the assembled tree.

A binder may declare canonical strings that several work items must render
byte-identically (see validate_binder.py for the plan-time schema check). This
script is the deliver-time enforcement point. An item counts as landed only when
its git done ref — refs/hatch/<slug>/item-<id>/done, probed under the scan root —
resolves (for an item a successor binder carries, the ref under the `supersedes` slug); an item with no done ref is not yet landed, so every entry listing it is
reported [PENDING] and skipped, never failed (a non-git scan root, or git being
unavailable, leaves every item pending). For landed items the script reads the
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


def _landed(slug: str, item_id: str, root: Path) -> bool:
    """True iff refs/hatch/<slug>/item-<item_id>/done resolves in the repo at `root`.

    Any failure — the ref absent, `root` not a git repository, git unavailable —
    means not landed. Callers turn that into PENDING, never a crash."""
    try:
        return subprocess.run(
            ["git", "show-ref", "--verify", "--quiet",
             f"refs/hatch/{slug}/item-{item_id}/done"],
            cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        ).returncode == 0
    except (OSError, subprocess.TimeoutExpired):  # git missing, root unusable, or hung
        return False


def evaluate_binder(binder: dict, root: Path) -> list[tuple[str, str, list[str], str]]:
    """Return one result per `shared_terms` entry: (id, status, items, canonical).

    status is one of:
      "OK"      — every listed item landed and has `canonical` in at least one
                  existing touched file.
      "PENDING" — at least one listed item is not yet landed — its git done ref
                  (refs/hatch/<slug>/item-<id>/done) does not resolve under `root` —
                  so the entry is skipped, never failed; `items` names the pending
                  items. A non-git root or missing git leaves every item pending.
      "FAIL"    — every listed item landed, but the `items` (offenders) lack the
                  term in every existing touched file (an offender with no touched
                  file left on the tree cannot render the term at all).

    An absent or empty `shared_terms` yields an empty list (a clean no-op pass)."""
    slug = binder.get("slug", "")
    # A successor binder's carried items landed under the predecessor's slug; their done
    # refs live there (deliver_preflight.py proves them before a successor run starts).
    sup = binder.get("supersedes") if isinstance(binder.get("supersedes"), dict) else {}
    carried = set(sup.get("carried") or [])
    ref_slug = {iid: sup.get("slug", slug) for iid in carried}
    items_by_id = {it["id"]: it for it in binder.get("work_items", []) if isinstance(it, dict)}
    results: list[tuple[str, str, list[str], str]] = []
    for entry in binder.get("shared_terms", []) or []:
        eid = entry.get("id", "<no-id>")
        canonical = entry.get("canonical", "")
        listed = entry.get("items", [])

        # An entry is only judged once every listed item has landed (done ref set).
        pending = [iid for iid in listed if not _landed(ref_slug.get(iid, slug), iid, root)]
        if pending:
            results.append((eid, "PENDING", pending, canonical))
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
        results.append((eid, "FAIL" if offenders else "OK", offenders, canonical))
    return results


def check(binder: dict, root: Path) -> tuple[int, list[str]]:
    """Evaluate `binder` under `root`; return (exit_code, human-readable lines).

    exit_code is 1 iff any entry is a violation. Pending and satisfied entries pass."""
    lines: list[str] = []
    violations = 0
    for eid, status, offenders, canonical in evaluate_binder(binder, root):
        if status == "FAIL":
            violations += 1
            who = ", ".join(offenders)
            lines.append(
                f"[FAIL] {eid}: item(s) {who} do not render the canonical term {canonical!r} "
                "byte-identically in any touched file")
        elif status == "PENDING":
            who = ", ".join(offenders)
            lines.append(
                f"[PENDING] {eid}: item(s) {who} not yet landed — no done ref; skipped")
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
        # Any object satisfies show-ref --verify; a blob avoids needing a commit.
        blob = git(root, "hash-object", "-w", "--stdin", stdin="")
        for iid in landed:
            git(root, "update-ref", f"refs/hatch/t/item-{iid}/done", blob)

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
