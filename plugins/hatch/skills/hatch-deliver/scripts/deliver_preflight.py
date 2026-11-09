# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch deliver preflight: one JSON packet answering everything Phase 0/1 and the
wave loop's Steps 1-2 currently discover by hand.

Zero dependencies (pure stdlib), so every invocation form behaves identically:
  python3 deliver_preflight.py --binder <path> [--repo <dir>]   # print the packet, exit 0/1
  python3 deliver_preflight.py --self-test                       # embedded fixtures, exit 0/1
  uv run --script deliver_preflight.py --binder <path>            # also fine — no deps to install

The packet is a SNAPSHOT of git + the binder at the moment it runs, not a cache — the
deliver doctrine re-runs this after a Clear, after a Resume decision, and after any
other change to the integration branch or the ref namespace before trusting the
result again.

Top-level keys:
  validator          — {exit_status, output} from running validate_binder.py with the
                        CURRENT interpreter (the validator is zero-dependency stdlib, so
                        python3 and `uv run --script` behave identically). A nonzero exit
                        ALSO sets `halt` — an invalid binder is a stop, never a frontier
                        to build from.
  slug                — the binder's slug.
  default_branch      — resolved locally, with no network call: `git config
                        hatch.defaultBranch`, else the local
                        refs/remotes/origin/HEAD symbolic ref, else the only local branch
                        (hatch/* branches aside), else exactly one of
                        main/master. null when none of those settles it.
  default_branch_error — null, or why the default branch could not be established and how
                        to set it. A non-null value sets `halt`: the default is never
                        guessed.
  integration_branch   — {name, exists, tip}.
  integration_base     — {ref, sha}: where a first run branches the integration branch
                        from — the default branch, or for a successor binder the
                        predecessor's integration branch.
  supersedes           — null for an ordinary binder. For a successor binder (top-level
                        `supersedes`): {predecessor, predecessor_integration {name, tip},
                        carried {id: done-provenance record}, dropped {id: predecessor
                        done sha}, findings, ok}. Each carried
                        item needs a done ref under the predecessor's slug passing the
                        same checks as done_provenance on the predecessor's integration
                        branch, and must equal the predecessor's committed work item; an
                        existing successor integration branch must contain the
                        predecessor's tip. Every predecessor done item must be carried or
                        listed in `supersedes.dropped` (its merge is on the successor's
                        base; a successor item must revert or replace it), and every
                        dropped id needs a predecessor done ref. Any failure sets `halt`.
                        Proven carried items count as done for the frontier.
  refs                — every refs/hatch/<slug>/item-*/{built,failed,done,accepted,evidence,halt}
                        that exists, mapped to its target sha. The canonical evidence
                        namespace is refs/hatch/<slug>/item-<id>/evidence.
  wave_tags            — every hatch/<slug>/wave-* tag, mapped to its target sha.
  done_provenance      — for every item carrying a done ref: the result of
                        `check_item_provenance.py --check-accepted --slug <slug>
                        --item <id> --range <done>^1..<done>` (the merge commit plus its
                        merged side — never <base>..<done>, which for an item merged
                        after a wave-mate would contain the wave-mate's commits too),
                        PLUS a --first-parent reachability check: the done target must
                        appear in `git rev-list --first-parent hatch/<slug>/integration`.
                        Either check failing is reported per item and sets `halt` — a
                        forged accepted/done pair cannot hide behind a clean frontier.
  halt                 — true when the binder failed validation, the default branch could
                        not be established, a successor's carried work is unproven, or any
                        done_provenance check failed. The deliver doctrine treats a packet with `halt`
                        set as a stop, never as a frontier to build from.
  frontier             — ready item ids: not done, and every depends_on id already
                        carries a done ref.
  parallelism          — {parallel, serialize, reasons, unresolved}, a partition of the
                        frontier from the four deterministic gates a script can decide
                        (a dependency edge, an explicit `serialize`, overlapping
                        `touches`, a co-declared `shared_resources`). The two gates a
                        script cannot decide are handled conservatively, never dropped:
                        an oracle needing a stateful, non-isolatable env goes to
                        serialize with reason undecidable:stateful-env; an item with no
                        touches goes to serialize with reason undecidable:missing-touches.
                        Both also land in `unresolved` for the orchestrator's judgment.
  tools                — absolute resolved paths of run_oracle.py, scan_secrets.py,
                        check_item_provenance.py, and item_context.py, resolved from this
                        script's own location so a worktree, a plugin install, and a repo
                        checkout all work.

Stdlib only. Invoked directly (not installed), matching the non-executable mode of
sibling scripts.

Exit codes: 0 = packet printed (regardless of `halt` — halt is a field, not an exit
status), 1 = self-test failure, 2 = usage error.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import shutil
from itertools import combinations
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
VALIDATE_BINDER = (SCRIPT_DIR / ".." / ".." / "hatch-plan" / "scripts" / "validate_binder.py").resolve()
RUN_ORACLE = (SCRIPT_DIR / ".." / ".." / "hatch-build" / "scripts" / "run_oracle.py").resolve()
SCAN_SECRETS = (SCRIPT_DIR / ".." / ".." / "hatch-build" / "scripts" / "scan_secrets.py").resolve()
CHECK_PROVENANCE = (SCRIPT_DIR / "check_item_provenance.py").resolve()
ITEM_CONTEXT = (SCRIPT_DIR / ".." / ".." / "hatch-build" / "scripts" / "item_context.py").resolve()

ENV_ORACLE_TYPES = {"integration", "e2e", "visual"}


GIT_TIMEOUT = 30       # seconds; every git call here is local and should be instant
SCRIPT_TIMEOUT = 300   # seconds; the validator and the provenance checker


def _run(args: list[str], timeout: float = SCRIPT_TIMEOUT) -> subprocess.CompletedProcess:
    """Every subprocess is bounded. A timeout reads as a failed call (exit 124), which
    every caller already treats as "not proven" — never as success."""
    try:
        return subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                              timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", f"timed out after {timeout}s")


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return _run(["git", "-C", str(repo), *args], timeout=GIT_TIMEOUT)


DEFAULT_BRANCH_KEY = "hatch.defaultBranch"
_SET_DEFAULT_HINT = (f"set it explicitly with `git config {DEFAULT_BRANCH_KEY} <branch>` "
                     "in this repository, then re-run preflight")


def _local_branch_exists(repo: Path, name: str) -> bool:
    return _git(repo, "rev-parse", "--verify", "--quiet",
                f"refs/heads/{name}^{{commit}}").returncode == 0


def resolve_default_branch(repo: Path) -> tuple[str | None, str | None]:
    """Return (branch, problem). Local and offline by construction — no call here
    contacts a remote. Order: explicit configuration, then the local
    refs/remotes/origin/HEAD symbolic ref, then an unambiguous local answer (the only
    local branch, or exactly one of main/master). Anything else is a problem naming
    how to set the branch; the default is never guessed."""
    configured = _git(repo, "config", "--get", DEFAULT_BRANCH_KEY)
    if configured.returncode == 0 and configured.stdout.strip():
        name = configured.stdout.strip()
        if _local_branch_exists(repo, name):
            return name, None
        return None, (f"git config {DEFAULT_BRANCH_KEY} names '{name}', which is not a "
                      f"local branch; create it or {_SET_DEFAULT_HINT}")

    origin_head = _git(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
    prefix = "refs/remotes/origin/"
    target = origin_head.stdout.strip()
    if origin_head.returncode == 0 and target.startswith(prefix):
        return target[len(prefix):], None

    heads = _git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    # hatch's own integration and item branches are never the default.
    branches = [b.strip() for b in heads.stdout.splitlines()
                if b.strip() and not b.strip().startswith("hatch/")]
    if len(branches) == 1:
        return branches[0], None
    conventional = [b for b in ("main", "master") if b in branches]
    if len(conventional) == 1:
        return conventional[0], None
    found = ", ".join(branches) if branches else "none"
    return None, (f"cannot establish the default branch offline (local branches: {found}; "
                  f"no refs/remotes/origin/HEAD); {_SET_DEFAULT_HINT}")


def detect_default_branch(repo: Path) -> str | None:
    return resolve_default_branch(repo)[0]


def ref_target(repo: Path, ref: str) -> str | None:
    proc = _git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
    out = proc.stdout.strip()
    return out or None


def list_prefixed_refs(repo: Path, prefix: str) -> dict[str, str]:
    proc = _git(repo, "for-each-ref", "--format=%(refname) %(objectname)", prefix)
    out: dict[str, str] = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        name, sha = line.rsplit(" ", 1)
        out[name] = sha
    return out


def list_wave_tags(repo: Path, slug: str) -> dict[str, str]:
    return {
        name[len("refs/tags/"):]: sha
        for name, sha in list_prefixed_refs(repo, f"refs/tags/hatch/{slug}/wave-*").items()
    }


def first_parent_chain(repo: Path, branch: str) -> set[str]:
    proc = _git(repo, "rev-list", "--first-parent", branch)
    return {line.strip() for line in proc.stdout.splitlines() if line.strip()}


def _done_record(repo: Path, slug: str, item_id: str, sha: str, chain: set[str]) -> dict:
    proc = _run([sys.executable, str(CHECK_PROVENANCE), "--repo", str(repo),
                 "--item", item_id, "--range", f"{sha}^1..{sha}",
                 "--slug", slug, "--check-accepted"])
    reachable = sha in chain
    return {
        "target": sha,
        "checker_exit": proc.returncode,
        "checker_output": (proc.stdout + proc.stderr).strip(),
        "first_parent_reachable": reachable,
        "ok": proc.returncode == 0 and reachable,
    }


def compute_done_provenance(repo: Path, slug: str, refs: dict[str, str],
                             integration_name: str) -> tuple[dict, bool]:
    """Rule: every done ref must pass check_item_provenance --check-accepted over its
    own merge range, AND be --first-parent reachable on the integration branch. Either
    failing is a per-item finding and sets halt True."""
    chain = first_parent_chain(repo, integration_name) if ref_target(repo, integration_name) else set()
    done_pat = re.compile(rf"^refs/hatch/{re.escape(slug)}/item-(.+)/done$")
    result: dict[str, dict] = {}
    halt = False
    for refname, sha in refs.items():
        m = done_pat.match(refname)
        if not m:
            continue
        result[m.group(1)] = record = _done_record(repo, slug, m.group(1), sha, chain)
        if not record["ok"]:
            halt = True
    return result, halt


def _predecessor_plan(repo: Path, pred: str, tip: str) -> dict | None:
    """The predecessor's committed binder as its own integration tip holds it — live, or
    already moved to the archive path by the sanctioned retirement."""
    for rel in (f".hatch/binders/{pred}.json",
                f".hatch/binders/archive/{pred}.json"):
        proc = _git(repo, "show", f"{tip}:{rel}")
        if proc.returncode == 0:
            try:
                doc = json.loads(proc.stdout)
            except json.JSONDecodeError:
                return None
            return doc if isinstance(doc, dict) else None
    return None


def check_supersedes(repo: Path, binder: dict, integration_name: str,
                     integration_tip: str | None) -> tuple[dict | None, bool]:
    """A successor binder (top-level `supersedes`) is refused unless every carried item
    is proven delivered by the predecessor: a done ref under the predecessor's slug that
    passes the same provenance and first-parent checks as a resumed done ref, on the
    predecessor's integration branch, for an item this binder copies unchanged from the
    predecessor's committed plan. When the successor's own integration branch exists it
    must already contain the predecessor's integration tip. Returns (report, halt)."""
    sup = binder.get("supersedes")
    if not isinstance(sup, dict):
        return None, False
    pred = sup.get("slug")
    carried_ids = [c for c in sup.get("carried") or [] if isinstance(c, str)]
    dropped_ids = [d for d in sup.get("dropped") or [] if isinstance(d, str)]
    dropped: dict[str, str] = {}
    pred_integration = f"hatch/{pred}/integration"
    pred_tip = ref_target(repo, pred_integration)
    findings: list[str] = []
    carried: dict[str, dict] = {}
    if pred_tip is None:
        findings.append(f"predecessor integration branch {pred_integration} does not exist; "
                        "the carried work cannot be proven or built on")
    else:
        chain = first_parent_chain(repo, pred_integration)
        plan = _predecessor_plan(repo, pred, pred_tip)
        pred_items = {it.get("id"): it for it in (plan or {}).get("work_items", [])
                      if isinstance(it, dict)}
        own_items = {it.get("id"): it for it in binder.get("work_items", []) if isinstance(it, dict)}
        if plan is None:
            findings.append(f"no committed binder for '{pred}' on {pred_integration}")
        for cid in carried_ids:
            sha = ref_target(repo, f"refs/hatch/{pred}/item-{cid}/done")
            if sha is None:
                carried[cid] = {"target": None, "ok": False,
                                "finding": f"no refs/hatch/{pred}/item-{cid}/done"}
                continue
            record = _done_record(repo, pred, cid, sha, chain)
            if plan is not None and pred_items.get(cid) != own_items.get(cid):
                record["ok"] = False
                record["finding"] = (f"work item '{cid}' differs from the predecessor's "
                                     "committed plan; a carried item is copied unchanged")
            carried[cid] = record
        # The successor starts from the predecessor's integration tip, so every done
        # predecessor item's code is on its base. Each must be named: carried (proven
        # above) or dropped (the successor plans the revert). Silence is refused.
        pred_done = {name.split("/")[-2][len("item-"):]: sha for name, sha in
                     list_prefixed_refs(repo, f"refs/hatch/{pred}/").items()
                     if name.endswith("/done") and name.split("/")[-2].startswith("item-")}
        for did in dropped_ids:
            if did in pred_done:
                dropped[did] = pred_done[did]
            else:
                findings.append(f"dropped id '{did}' has no refs/hatch/{pred}/"
                                f"item-{did}/done; there is no delivered work to drop")
        for did in sorted(set(pred_done) - set(carried_ids) - set(dropped_ids)):
            findings.append(f"predecessor item '{did}' is done and its merge "
                            f"({pred_done[did]}) is on {pred_integration}, which this binder "
                            "starts from; carry it, or list it in supersedes.dropped and "
                            "plan a work item that reverts or replaces it")
    if integration_tip is not None and pred_tip is not None:
        contained = _git(repo, "merge-base", "--is-ancestor", pred_tip,
                         integration_tip).returncode == 0
        if not contained:
            findings.append(f"{integration_name} does not contain the predecessor's "
                            f"integration tip {pred_tip}; start it from {pred_integration}")
    ok = not findings and bool(carried) and all(r["ok"] for r in carried.values())
    report = {"predecessor": pred,
              "predecessor_integration": {"name": pred_integration, "tip": pred_tip},
              "carried": carried, "dropped": dropped, "findings": findings, "ok": ok}
    return report, not ok


def compute_parallelism(items_by_id: dict, frontier: list[str], env_contract: dict | None) -> dict:
    """Partition the frontier per skills/_shared/parallelism-gates.md. Four gates a
    script can decide (dependency edge, explicit serialize, touches overlap,
    shared_resources overlap) never infer from prose. Two gates a script cannot decide
    are handled conservatively, never dropped, and also land in `unresolved`."""
    frontier_set = set(frontier)
    serialize: list[str] = []
    reasons: dict[str, list[str]] = {}
    unresolved: list[str] = []

    def mark(item_id: str, reason: str, *, is_undecidable: bool = False) -> None:
        reasons.setdefault(item_id, [])
        if reason not in reasons[item_id]:
            reasons[item_id].append(reason)
        if item_id not in serialize:
            serialize.append(item_id)
        if is_undecidable and item_id not in unresolved:
            unresolved.append(item_id)

    supports_isolation = bool((env_contract or {}).get("supports_isolation", False))

    for item_id in frontier:
        item = items_by_id[item_id]
        if item.get("serialize"):
            mark(item_id, "explicit-serialize")
        if set(item.get("depends_on") or []) & frontier_set:
            mark(item_id, "dependency-edge")
        if not item.get("touches"):
            mark(item_id, "undecidable:missing-touches", is_undecidable=True)
        oracle_type = (item.get("oracle") or {}).get("type")
        if oracle_type in ENV_ORACLE_TYPES and not supports_isolation:
            mark(item_id, "undecidable:stateful-env", is_undecidable=True)

    for a, b in combinations(frontier, 2):
        ia, ib = items_by_id[a], items_by_id[b]
        if set(ia.get("touches") or []) & set(ib.get("touches") or []):
            mark(a, "touches-overlap")
            mark(b, "touches-overlap")
        if set(ia.get("shared_resources") or []) & set(ib.get("shared_resources") or []):
            mark(a, "shared-resources")
            mark(b, "shared-resources")

    parallel = [i for i in frontier if i not in serialize]
    return {"parallel": parallel, "serialize": serialize, "reasons": reasons, "unresolved": unresolved}


def build_packet(binder_path: Path, repo: Path) -> dict:
    validator_proc = _run([sys.executable, str(VALIDATE_BINDER), "--binder", str(binder_path)])
    validator = {"exit_status": validator_proc.returncode,
                 "output": (validator_proc.stdout + validator_proc.stderr).strip()}
    halt = validator_proc.returncode != 0

    binder: dict | None = None
    try:
        binder = json.loads(binder_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        binder = None

    slug = binder.get("slug") if isinstance(binder, dict) else None
    default_branch, default_branch_error = resolve_default_branch(repo)
    halt = halt or default_branch_error is not None
    integration_name = f"hatch/{slug}/integration" if slug else None
    integration_tip = ref_target(repo, integration_name) if integration_name else None
    integration_branch = {"name": integration_name, "exists": integration_tip is not None,
                          "tip": integration_tip}
    integration_base = {"ref": default_branch,
                        "sha": ref_target(repo, default_branch) if default_branch else None}

    supersedes: dict | None = None
    if slug and isinstance(binder, dict) and validator_proc.returncode == 0:
        supersedes, sup_halt = check_supersedes(repo, binder, integration_name, integration_tip)
        halt = halt or sup_halt
        if supersedes is not None:
            pred = supersedes["predecessor_integration"]
            integration_base = {"ref": pred["name"], "sha": pred["tip"]}

    refs: dict[str, str] = {}
    wave_tags: dict[str, str] = {}
    done_provenance: dict = {}
    frontier: list[str] = []
    parallelism = {"parallel": [], "serialize": [], "reasons": {}, "unresolved": []}

    if slug:
        refs = list_prefixed_refs(repo, f"refs/hatch/{slug}/")
        wave_tags = list_wave_tags(repo, slug)
        done_provenance, dp_halt = compute_done_provenance(repo, slug, refs, integration_name)
        halt = halt or dp_halt

        if isinstance(binder, dict):
            items = binder.get("work_items", [])
            items_by_id = {it["id"]: it for it in items}
            done_ids = set(done_provenance)
            if supersedes is not None and supersedes["ok"]:
                done_ids |= set(supersedes["carried"])
            frontier = [it["id"] for it in items
                        if it["id"] not in done_ids
                        and all(d in done_ids for d in (it.get("depends_on") or []))]
            parallelism = compute_parallelism(items_by_id, frontier, binder.get("env_contract"))

    if validator_proc.returncode != 0 or (supersedes is not None and not supersedes["ok"]):
        frontier = []
        parallelism = {"parallel": [], "serialize": [], "reasons": {}, "unresolved": []}

    tools = {
        "run_oracle.py": str(RUN_ORACLE),
        "scan_secrets.py": str(SCAN_SECRETS),
        "check_item_provenance.py": str(CHECK_PROVENANCE),
        "item_context.py": str(ITEM_CONTEXT),
    }

    return {
        "validator": validator,
        "slug": slug,
        "default_branch": default_branch,
        "default_branch_error": default_branch_error,
        "integration_branch": integration_branch,
        "integration_base": integration_base,
        "supersedes": supersedes,
        "refs": refs,
        "wave_tags": wave_tags,
        "done_provenance": done_provenance,
        "halt": bool(halt),
        "frontier": frontier,
        "parallelism": parallelism,
        "tools": tools,
    }


# --- Self-test -------------------------------------------------------------------

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
        return ref_target(root, "HEAD") or ""

    def write_binder(path: Path, doc: dict) -> None:
        path.write_text(json.dumps(doc), encoding="utf-8")

    def minimal_item(item_id: str, **extra) -> dict:
        base = {"id": item_id, "title": item_id, "summary": "s",
                "oracle": {"opt_out": True, "reason": "fixture"}}
        base.update(extra)
        return base

    def minimal_binder(slug: str, items: list[dict], env_contract: dict | None = None) -> dict:
        doc = {"slug": slug, "title": "t", "summary": "s", "motivation": "m",
               "scope": {"included": ["x"]}, "work_items": items}
        if env_contract is not None:
            doc["env_contract"] = env_contract
        return doc

    tmp = Path(tempfile.mkdtemp(prefix="deliver_preflight_selftest_"))
    try:
        # --- invalid-binder: a dangling depends_on fails validate_binder.py ---------
        r = init(tmp / "invalid-binder")
        commit(r, "base")
        binder_path = tmp / "invalid-binder.json"
        write_binder(binder_path, minimal_binder(
            "fixture-invalid-binder",
            [minimal_item("a", depends_on=["ghost"])]))
        packet = build_packet(binder_path, r)
        check("[invalid-binder] a dangling depends_on fails the validator and sets halt "
              "with an empty frontier",
              packet["halt"] is True and packet["frontier"] == [] and packet["validator"]["exit_status"] != 0,
              json.dumps({"halt": packet["halt"], "frontier": packet["frontier"]}))

        # --- genuine clean done merge: passes, and does not appear in the frontier ---
        r = init(tmp / "clean-done")
        commit(r, "base")
        _git(r, "checkout", "-q", "-b", "hatch/s/integration")
        _git(r, "checkout", "-q", "-b", "hatch/s/item-a")
        commit(r, "the work [hatch:item-a]")
        _git(r, "checkout", "-q", "hatch/s/integration")
        _git(r, "merge", "-q", "--no-ff", "hatch/s/item-a", "-m", "hatch: merge item-a [hatch:item-a]")
        done_a = ref_target(r, "HEAD") or ""
        _git(r, "update-ref", "refs/hatch/s/item-a/done", done_a)
        binder_path = tmp / "clean-done.json"
        write_binder(binder_path, minimal_binder("s", [minimal_item("a"), minimal_item("b", depends_on=["a"])]))
        packet = build_packet(binder_path, r)
        check("a genuine done merge passes (no halt) and is absent from the frontier",
              packet["halt"] is False and "a" not in packet["frontier"] and "b" in packet["frontier"]
              and packet["done_provenance"]["a"]["ok"] is True,
              json.dumps(packet["done_provenance"]))

        # --- a valid second done merge, following the first, also passes and is absent
        _git(r, "checkout", "-q", "-b", "hatch/s/item-b")
        commit(r, "the work [hatch:item-b]")
        _git(r, "checkout", "-q", "hatch/s/integration")
        _git(r, "merge", "-q", "--no-ff", "hatch/s/item-b", "-m", "hatch: merge item-b [hatch:item-b]")
        done_b = ref_target(r, "HEAD") or ""
        _git(r, "update-ref", "refs/hatch/s/item-b/done", done_b)
        packet2 = build_packet(binder_path, r)
        check("a second, later done merge that follows the first also passes and both "
              "are absent from the frontier",
              packet2["halt"] is False and packet2["frontier"] == []
              and packet2["done_provenance"]["b"]["ok"] is True,
              json.dumps(packet2["done_provenance"]))

        # --- forged-done: an off-chain plain clean done ------------------------------
        r = init(tmp / "forged-done-plain")
        commit(r, "base")
        _git(r, "checkout", "-q", "-b", "hatch/s/integration")
        _git(r, "checkout", "-q", "-b", "hatch/s/item-a")
        commit(r, "the work [hatch:item-a]")
        # a merge commit exists, but done points at a commit OFF the first-parent chain
        _git(r, "checkout", "-q", "-b", "side")
        forged = commit(r, "hatch: forged merge for item-a [hatch:item-a]")
        _git(r, "checkout", "-q", "hatch/s/integration")
        _git(r, "update-ref", "refs/hatch/s/item-a/done", forged)
        binder_path = tmp / "forged-done-plain.json"
        write_binder(binder_path, minimal_binder("s", [minimal_item("a")]))
        packet = build_packet(binder_path, r)
        check("[forged-done] a plain clean done ref pointing off the integration "
              "branch's first-parent history sets halt",
              packet["halt"] is True and packet["done_provenance"]["a"]["ok"] is False
              and packet["done_provenance"]["a"]["first_parent_reachable"] is False,
              json.dumps(packet["done_provenance"]))

        # --- forged-done: an accepted ref alongside an off-chain done ----------------
        r = init(tmp / "forged-done-accepted")
        commit(r, "base")
        _git(r, "checkout", "-q", "-b", "hatch/s/integration")
        _git(r, "checkout", "-q", "-b", "hatch/s/item-a")
        tip = commit(r, "the work [hatch:item-a]")
        _git(r, "checkout", "-q", "-b", "side")
        forged = commit(r, "hatch: merge item-a\n\nHatch-Accepted: item-a\n"
                          "Hatch-Accept-Reason: forged off-chain")
        _git(r, "checkout", "-q", "hatch/s/integration")
        _git(r, "update-ref", "refs/hatch/s/item-a/done", forged)
        _git(r, "update-ref", "refs/hatch/s/item-a/accepted", tip)
        binder_path = tmp / "forged-done-accepted.json"
        write_binder(binder_path, minimal_binder("s", [minimal_item("a")]))
        packet = build_packet(binder_path, r)
        check("[forged-done] an accepted ref alongside an off-chain done also sets halt",
              packet["halt"] is True and packet["done_provenance"]["a"]["ok"] is False,
              json.dumps(packet["done_provenance"]))

        # --- parallelism: NEGATIVE CONTROLS ------------------------------------------
        items_by_id = {
            "iso": minimal_item("iso", touches=["x.py"], oracle={"type": "integration", "assertions": ["x"], "command": "true"}),
            "notouch": minimal_item("notouch", touches=["y.py"]),
        }
        items_by_id["notouch"] = minimal_item("notouch")  # no touches at all
        frontier = ["iso", "notouch"]
        par_isolated = compute_parallelism(items_by_id, frontier, {"supports_isolation": True})
        check("NEGATIVE CONTROL: supports_isolation true keeps a stateful-env oracle item parallel",
              "iso" in par_isolated["parallel"] and "iso" not in par_isolated["serialize"],
              json.dumps(par_isolated))

        items_by_id2 = {
            "hastouch": minimal_item("hastouch", touches=["z.py"]),
        }
        par_touches = compute_parallelism(items_by_id2, ["hastouch"], {"supports_isolation": False})
        check("NEGATIVE CONTROL: an item with touches present stays parallel "
              "(not undecidable:missing-touches)",
              "hastouch" in par_touches["parallel"] and "hastouch" not in par_touches["serialize"],
              json.dumps(par_touches))

        # --- parallelism: the two undecidable gates fire, conservatively -------------
        items_by_id3 = {
            "env": minimal_item("env", touches=["a.py"],
                                 oracle={"type": "e2e", "assertions": ["x"], "command": "true"}),
            "notouch2": minimal_item("notouch2"),
        }
        par_undecidable = compute_parallelism(items_by_id3, ["env", "notouch2"], {"supports_isolation": False})
        check("undecidable:stateful-env and undecidable:missing-touches both serialize "
              "and land in unresolved",
              "env" in par_undecidable["serialize"] and "notouch2" in par_undecidable["serialize"]
              and set(par_undecidable["unresolved"]) == {"env", "notouch2"}
              and "undecidable:stateful-env" in par_undecidable["reasons"]["env"]
              and "undecidable:missing-touches" in par_undecidable["reasons"]["notouch2"],
              json.dumps(par_undecidable))

        # --- parallelism: deterministic gates (touches overlap, shared_resources) ----
        items_by_id4 = {
            "p": minimal_item("p", touches=["shared.py"]),
            "q": minimal_item("q", touches=["shared.py"]),
            "r": minimal_item("r", touches=["r-only.py"], shared_resources=["db"]),
            "s": minimal_item("s", touches=["s-only.py"], shared_resources=["db"]),
            "t": minimal_item("t", touches=["t-only.py"], serialize=True),
        }
        par_det = compute_parallelism(items_by_id4, ["p", "q", "r", "s", "t"], {"supports_isolation": True})
        check("deterministic gates: touches-overlap, shared_resources, explicit serialize",
              {"p", "q"} <= set(par_det["serialize"]) and {"r", "s"} <= set(par_det["serialize"])
              and "t" in par_det["serialize"] and "explicit-serialize" in par_det["reasons"]["t"],
              json.dumps(par_det))

        # --- tools map: absolute, existing paths -------------------------------------
        binder_path = tmp / "tools.json"
        write_binder(binder_path, minimal_binder("tools-fixture", [minimal_item("a")]))
        r = init(tmp / "tools")
        commit(r, "base")
        packet = build_packet(binder_path, r)
        tools_ok = all(Path(p).is_absolute() and Path(p).name == name and Path(p).is_file()
                       for name, p in packet["tools"].items())
        check("tools map carries absolute, existing paths for all four scripts", tools_ok,
              json.dumps(packet["tools"]))

        # --- default branch: local-only discovery, never a guess ---------------------
        r = tmp / "trunk"
        r.mkdir()
        _git(r, "init", "-q", "-b", "trunk")
        _git(r, "config", "user.email", "t@example.invalid")
        _git(r, "config", "user.name", "hatch self-test")
        commit(r, "base")
        check("a local-only repository whose one branch is trunk resolves to trunk",
              detect_default_branch(r) == "trunk")
        _git(r, "branch", "feature")
        name, problem = resolve_default_branch(r)
        check("two unconventional branches and no configuration is an error, not a guess",
              name is None and DEFAULT_BRANCH_KEY in (problem or ""), str(problem))
        _git(r, "config", DEFAULT_BRANCH_KEY, "trunk")
        check("git config hatch.defaultBranch settles it",
              detect_default_branch(r) == "trunk")

        # --- required top-level keys always present ----------------------------------
        need = {"validator", "slug", "default_branch", "default_branch_error",
                "integration_branch", "integration_base", "supersedes", "refs",
                "wave_tags", "done_provenance", "halt", "frontier", "parallelism", "tools"}
        check("packet always carries every contracted top-level key", need <= set(packet))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"self-test: {passed}/{total} cases passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="deliver_preflight.py",
        description="Print one JSON packet answering deliver's Phase 0/1 and wave-loop Steps 1-2.",
    )
    ap.add_argument("--binder", type=Path, help="path to the binder JSON")
    ap.add_argument("--repo", type=Path, default=Path("."), help="repository to read (default: cwd)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)

    if args.self_test:
        return _run_self_test()
    if args.binder is None:
        ap.error("provide --binder <path> or --self-test")
    if not args.binder.is_file():
        print(f"deliver_preflight: binder file not found: {args.binder}", file=sys.stderr)
        return 2

    packet = build_packet(args.binder, args.repo.resolve())
    print(json.dumps(packet, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
