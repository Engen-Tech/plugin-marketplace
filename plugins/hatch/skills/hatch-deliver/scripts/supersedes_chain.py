# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch supersedes chain: which binder delivered an item a successor carries.

A successor binder (top-level `supersedes`) carries items its predecessor delivered, or
items the predecessor itself carried from an earlier binder. This module holds the one
git-backed walk back through those binders, so deliver_preflight.py, item_context.py,
hatch-plan's check_shared_terms.py and the delivery Stop guard (guard_delivery_stop.py and
its Codex twin) answer the same question the same way.

Zero dependencies (pure stdlib) and import-safe: importing it runs nothing.
  python3 supersedes_chain.py --self-test     # embedded fixtures, exit 0/1

Public API:
  resolve_delivery(git, predecessor, item_id, successor=None) -> Delivery
      `git` runs one git command in the repository: git(*args) -> CompletedProcess,
      never raising. Returns Delivery(slug, done, reason): the slug of the binder whose
      done ref delivered the item and that ref's sha, or (None, None, reason).
  committed_plan(git, slug, tip) -> dict | None
      A binder's committed plan as the commit `tip` holds it, at the live path or the
      archive path.

The walk starts at the predecessor. While no done ref stands under the current binder, it
reads that binder's committed `supersedes` from its integration tip and steps to the next
binder only if the current one carried the item. Each step is bounded: the next binder's
integration tip must be an ancestor of the current one's, its committed plan must hold the
same item, no binder is visited twice, and the walk ends after 16 binders. The walk does
not check the done ref's provenance: deliver_preflight.py does that, under the delivering
binder's slug on that binder's own first-parent history.

Exit codes: 0 = self-test passed, 1 = self-test failure, 2 = usage error.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable, NamedTuple

Git = Callable[..., subprocess.CompletedProcess]
MAX_BINDERS = 16


class Delivery(NamedTuple):
    slug: str | None
    done: str | None
    reason: str


def _ref(git: Git, ref: str) -> str | None:
    return git("rev-parse", "--verify", "--quiet", ref + "^{commit}").stdout.strip() or None


def committed_plan(git: Git, slug: str, tip: str) -> dict | None:
    """The binder's committed plan as `tip` holds it — live, or already moved to the
    archive path by the sanctioned retirement."""
    for rel in (f".hatch/binders/{slug}.json", f".hatch/binders/archive/{slug}.json"):
        proc = git("show", f"{tip}:{rel}")
        if proc.returncode == 0:
            try:
                doc = json.loads(proc.stdout)
            except json.JSONDecodeError:
                return None
            return doc if isinstance(doc, dict) else None
    return None


def _plan_item(plan: dict | None, item_id: str) -> dict | None:
    return {it.get("id"): it for it in (plan or {}).get("work_items", [])
            if isinstance(it, dict)}.get(item_id)


def resolve_delivery(git: Git, predecessor: str, item_id: str,
                     successor: str | None = None) -> Delivery:
    """The binder that delivered `item_id` on the predecessor's base, followed back through
    each binder's committed `supersedes`. It does not ask whether the successor carries
    the item: preflight also asks this for items it must name as dropped or silent."""
    tip = _ref(git, f"hatch/{predecessor}/integration")
    if tip is None:
        return Delivery(None, None, f"predecessor integration branch hatch/{predecessor}/integration "
                                    "does not exist")
    hop, plan, seen = predecessor, committed_plan(git, predecessor, tip), {successor, predecessor}
    prev = _plan_item(plan, item_id)
    while (sha := _ref(git, f"refs/hatch/{hop}/item-{item_id}/done")) is None:
        hsup = (plan or {}).get("supersedes")
        nxt = hsup.get("slug") if isinstance(hsup, dict) and item_id in (hsup.get("carried") or []) else None
        if not isinstance(nxt, str):
            return Delivery(None, None, f"no refs/hatch/{hop}/item-{item_id}/done"
                            + (f" (followed from '{predecessor}')" if hop != predecessor else ""))
        nxt_tip = _ref(git, f"hatch/{nxt}/integration")
        if nxt in seen or len(seen) > MAX_BINDERS or nxt_tip is None or git(
                "merge-base", "--is-ancestor", nxt_tip, tip).returncode != 0:
            return Delivery(None, None, f"'{hop}' carried '{item_id}' from '{nxt}', but "
                                        f"hatch/{nxt}/integration is missing, not on "
                                        f"hatch/{hop}/integration, or already followed")
        plan = committed_plan(git, nxt, nxt_tip)
        cur = _plan_item(plan, item_id)
        if cur != prev:
            return Delivery(None, None, f"work item '{item_id}' differs between the committed "
                                        f"plans of '{hop}' and '{nxt}'; a carried item is "
                                        "copied unchanged")
        hop, tip, prev = nxt, nxt_tip, cur
        seen.add(nxt)
    return Delivery(hop, sha, "")


# --- Self-test -------------------------------------------------------------------

def _run_self_test() -> int:
    results: list[bool] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail and not ok else ""))

    tmp = Path(tempfile.mkdtemp(prefix="supersedes_chain_selftest_"))
    try:
        def git(*args: str) -> subprocess.CompletedProcess:
            return subprocess.run(["git", "-C", str(tmp), *args], capture_output=True,
                                  text=True, encoding="utf-8")

        def plan(slug: str, carried_from: str | None = None) -> None:
            doc = {"slug": slug, "work_items": [{"id": "a", "title": "A"}]}
            if carried_from:
                doc["supersedes"] = {"slug": carried_from, "carried": ["a"]}
            path = tmp / ".hatch" / "binders" / f"{slug}.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(doc), encoding="utf-8")
            git("add", "-A")
            git("commit", "-q", "-m", f"plan {slug}")

        git("init", "-q", "-b", "main")
        git("config", "user.email", "t@example.invalid")
        git("config", "user.name", "hatch self-test")
        git("config", "commit.gpgsign", "false")
        plan("s")
        git("checkout", "-q", "-b", "hatch/s/integration")
        git("commit", "-q", "--allow-empty", "-m", "deliver a [hatch:item-a]")
        done = _ref(git, "HEAD") or ""
        git("update-ref", "refs/hatch/s/item-a/done", done)
        git("checkout", "-q", "-b", "hatch/s-r2/integration")
        plan("s-r2", "s")
        git("checkout", "-q", "-b", "hatch/s-r3/integration")
        plan("s-r3", "s-r2")

        got = resolve_delivery(git, "s-r3", "a", "s-r4")
        check("a three-binder chain resolves to the binder that delivered",
              got == Delivery("s", done, ""), repr(got))
        got = resolve_delivery(git, "s", "a", "s-r2")
        check("one hop resolves to the predecessor's own done ref",
              got == Delivery("s", done, ""), repr(got))
        got = resolve_delivery(git, "ghost", "a")
        check("a missing predecessor integration branch does not resolve",
              got.done is None and "hatch/ghost/integration" in got.reason, repr(got))
        git("checkout", "-q", "hatch/s/integration")
        git("commit", "-q", "--allow-empty", "-m", "later work on s")
        got = resolve_delivery(git, "s-r3", "a", "s-r4")
        check("an origin moved off the chain does not resolve",
              got.done is None and "not on hatch/s-r2/integration" in got.reason, repr(got))
        git("update-ref", "-d", "refs/hatch/s/item-a/done")
        git("checkout", "-q", "-B", "hatch/s/integration", done)
        got = resolve_delivery(git, "s-r3", "a", "s-r4")
        check("a gone origin done ref does not resolve and names it",
              got == Delivery(None, None, "no refs/hatch/s/item-a/done (followed from 's-r3')"),
              repr(got))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"self-test: {sum(results)}/{len(results)} cases passed")
    return 0 if all(results) else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="supersedes_chain.py",
        description="The supersedes-chain walk shared by deliver_preflight.py and "
                    "item_context.py. Import it; run it only for --self-test.",
    )
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    if args.self_test:
        return _run_self_test()
    ap.error("this module has no command; use --self-test")
    return 2


if __name__ == "__main__":
    sys.exit(main())
