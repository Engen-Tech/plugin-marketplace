# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch-status engine: derive 'what's next' from binders + git. Zero dependencies.

  uv run --script hatch_next.py                       # terminal map (auto-detect .hatch/binders)
  uv run --script hatch_next.py --json                # the state as JSON (Phase 2's server reads this)
  uv run --script hatch_next.py --footer --binder S   # one-line run footer for a binder slug
  uv run --script hatch_next.py --watch               # the one Hatch Watch line: keyed hub URL, nudge, or opt-in hint
  uv run --script hatch_next.py --self-test           # embedded fixtures, exit 0/1

Order is a topo sort over `after` edges, recomputed every call — never stored. A dangling `after`
is a warning; a cross-binder cycle is an error (and order is null). Delivered binders live in
`.hatch/binders/archive/` (hatch-deliver's end-of-life step): they are never listed, but an
`after` naming one resolves as satisfied — a delivered predecessor is not a dangling edge.

Every real invocation also fires a fail-open, fire-and-forget `serve_status.py --ensure`
(Hatch Watch hub revival), and the terminal map — never --footer, never --json — carries one
nudge line when this repo is opted in but the hub is unreachable."""
from __future__ import annotations
import argparse, fnmatch, hashlib, json, os, re, subprocess, sys, time
from pathlib import Path

BINDERS_DIR = Path(".hatch/binders")
ARCHIVE_DIR = BINDERS_DIR / "archive"


def _topo_order(after: dict[str, list[str]]) -> list[str] | None:
    """Kahn topo sort. `after[slug]` = the slugs that must come before `slug`. Deterministic
    (slug order among ready nodes). Returns the order, or None if a cycle leaves nodes unplaced."""
    indeg = {n: 0 for n in after}
    succ: dict[str, list[str]] = {n: [] for n in after}
    for n, preds in after.items():
        for p in preds:
            if p in indeg:
                succ[p].append(n)
                indeg[n] += 1
    ready = sorted(n for n in after if indeg[n] == 0)
    out: list[str] = []
    while ready:
        n = ready.pop(0)
        out.append(n)
        for m in sorted(succ[n]):
            indeg[m] -= 1
            if indeg[m] == 0:
                ready.append(m)
        ready.sort()
    return out if len(out) == len(after) else None


def _binder_status(item_ids: list[str], gb: dict, carried: frozenset[str] = frozenset()) -> str:
    """`carried` items are done by a predecessor binder: they count toward
    merged, but on their own they never make a successor in flight."""
    gitems = gb.get("items", {})
    if item_ids and all(gitems.get(i, {}).get("done_in_default") for i in item_ids):
        return "merged"
    if gb.get("integration_exists") or any(gitems.get(i, {}).get("done")
                                           for i in item_ids if i not in carried):
        return "in_flight"
    return "not_started"


def _supersedes(binder: dict) -> tuple[str, list[str]] | None:
    """(predecessor slug, carried item ids) for a successor binder, else None.
    The shape is validate_binder.py's; a malformed value reads as absent."""
    sup = binder.get("supersedes")
    if not isinstance(sup, dict) or not isinstance(sup.get("slug"), str):
        return None
    carried = sup.get("carried")
    if not isinstance(carried, list) or not all(isinstance(c, str) for c in carried):
        return None
    return sup["slug"], carried


def _item_status(deps: list[str], gi: dict, done_ids: set[str]) -> tuple[str, list[str]]:
    # accepted-done is done with a human waiver: merged, but the named assertion
    # was NOT met — never shown as a clean pass (skills/_shared/integration-branch.md)
    if gi.get("done"):   return ("accepted" if gi.get("accepted") else "done"), []
    if gi.get("failed"): return "failed", []
    if gi.get("built"):  return "built", []
    if gi.get("branch"): return "building", []
    unmet = [d for d in deps if d not in done_ids]
    return ("blocked", unmet) if unmet else ("ready", [])


# Item states an item can end a derive in. `accepted` is the done-with-waiver
# flavour; both count as complete for dependencies and progress.
ITEM_STATES = ("done", "accepted", "built", "failed", "building", "ready", "blocked")
COMPLETE_STATES = ("done", "accepted")


def derive_state(binders: list[dict], git_facts: dict,
                 archived: frozenset[str] = frozenset(),
                 surface_on_default: dict[str, bool | None] | None = None,
                 recovery: dict | None = None,
                 load_errors: list[str] | None = None) -> dict:
    """The derived state. `recovery` (gather_recovery_facts) carries the facts
    that are not plain ref presence: each done ref's provenance verdict and
    waiver reason, stray refs, deleted binders and post-landing leftovers.
    It also carries each item's halt record view, which no state depends on.
    Without it a done ref is trusted as present — the pure-derivation form the
    self-test and the benchmarks drive. `load_errors` (load_binders) are binder
    files that could not be read; they surface as errors, never vanish."""
    default_branch = git_facts.get("default_branch", "main")
    gfb = git_facts.get("binders", {})
    by_slug = {b["slug"]: b for b in binders}
    rec = recovery or {}
    rec_items = rec.get("items", {})

    # cross-binder graph: resolve `after`, collect warnings, topo-sort for the order.
    # A live binder wins over an archived namesake; an `after` naming an archived-only
    # slug is a delivered predecessor — satisfied, dropped from the graph, no warning.
    slugs = set(by_slug)
    warnings: list[str] = []
    for s in sorted(slugs & archived):
        warnings.append(f"binder '{s}' reuses the slug of an archived (delivered) binder — "
                        "the delivered history is shadowed; plan new work under a fresh slug")
    after: dict[str, list[str]] = {}
    for slug, b in by_slug.items():
        resolved = []
        for ref in b.get("after", []) or []:
            if ref in slugs:
                resolved.append(ref)
            elif ref not in archived:
                warnings.append(f"binder '{slug}' has a dangling after: '{ref}' (no such binder)")
        after[slug] = resolved
    order = _topo_order(after)
    errors = list(load_errors or [])
    if order is None:
        errors.append("cross-binder cycle in `after` — no run order exists")
    warnings.extend(rec.get("warnings", []))

    # A done ref that failed delivery's provenance rules is not trusted: the
    # item derives as if it had no done ref, and the reason is a warning.
    def trusted_items(slug: str, item_ids, warn: bool) -> dict:
        gitems = dict(gfb.get(slug, {}).get("items", {}))
        prov = rec_items.get(slug, {})
        for iid in item_ids:
            gi = gitems.get(iid, {})
            findings = (prov.get(iid) or {}).get("suspect")
            if gi.get("done") and findings:
                gitems[iid] = {**gi, "done": False, "done_in_default": False}
                if warn:
                    warnings.append(
                        f"binder '{slug}' item '{iid}': its done ref is suspect and is not "
                        f"trusted — {findings[0]}" + (f" (+{len(findings) - 1} more)"
                                                      if len(findings) > 1 else "")
                        + f"; hatch-deliver {slug} re-checks it on resume")
            elif warn and gi.get("accepted") and not gi.get("done"):
                warnings.append(
                    f"binder '{slug}' item '{iid}': an accepted ref with no done merge is "
                    f"suspect — the accept did not complete, so status ignores it")
        return gitems

    # A successor binder (supersedes: {slug, carried}) repairs a partially
    # delivered one. Its carried items were delivered by the predecessor, so
    # their evidence is the predecessor's done refs under the same provenance
    # rules; a live predecessor with a live successor is not open work.
    superseded_by: dict[str, str] = {}
    for slug, b in by_slug.items():
        sup = _supersedes(b)
        if sup and sup[0] in by_slug and sup[0] != slug:
            superseded_by.setdefault(sup[0], slug)

    out_binders = []
    status_by_slug: dict[str, str] = {}
    for slug, b in by_slug.items():
        gb = gfb.get(slug, {})
        items = b.get("work_items", [])
        item_ids = [it["id"] for it in items]
        gitems = trusted_items(slug, item_ids, warn=True)
        carried_from: dict[str, str] = {}
        sup = _supersedes(b)
        if sup and sup[0] != slug:
            pred, carried = sup
            pitems = trusted_items(pred, carried, warn=False)
            for iid in carried:
                pi = pitems.get(iid, {})
                if iid in item_ids and pi.get("done"):
                    gitems[iid] = {**gitems.get(iid, {}), "done": True,
                                   "done_in_default": pi.get("done_in_default"),
                                   "accepted": pi.get("accepted")}
                    carried_from[iid] = pred
                elif iid in item_ids:
                    warnings.append(
                        f"binder '{slug}' item '{iid}' is carried from '{pred}', but '{pred}' "
                        f"has no trusted done ref for it — hatch-deliver {slug} "
                        f"halts at preflight until it does")
        gb = {**gb, "items": gitems}
        status = _binder_status(item_ids, gb, frozenset(carried_from))
        status_by_slug[slug] = status

        done_ids = {i for i in item_ids if gitems.get(i, {}).get("done")}
        detail, counts = [], {k: 0 for k in ITEM_STATES}
        for it in items:
            st, blk = _item_status(it.get("depends_on", []), gitems.get(it["id"], {}), done_ids)
            counts[st] += 1
            entry = {"id": it["id"], "status": st}
            if blk:
                entry["blocked_by"] = blk
            owner = carried_from.get(it["id"])
            if owner:
                entry["carried_from"] = owner
            if st == "accepted":
                # the human's own words from the merge trailer; None when the
                # derive had no provenance pass to read them
                entry["waiver_reason"] = (rec_items.get(owner or slug, {}).get(it["id"])
                                          or {}).get("waiver_reason")
            # shown beside the state, and never read to choose it
            halt = rec.get("halts", {}).get(slug, {}).get(it["id"])
            if halt:
                entry["halt"] = halt
            detail.append(entry)
        row = {
            "slug": slug, "after": after[slug], "status": status,
            "items": {"total": len(items), **counts, "detail": detail},
        }
        if slug in superseded_by:
            row["superseded_by"] = superseded_by[slug]
        # Finding 21: a not_started binder whose declared surface already exists
        # on the default branch was likely delivered by another hand. Flag it
        # (advisory only — never a state change) so the next action can say so.
        if (status == "not_started" and surface_on_default
                and surface_on_default.get(slug) is True):
            row["surface_on_default"] = True
        out_binders.append(row)

    # is_next: a not-started binder whose every `after` predecessor is merged
    for ob in out_binders:
        ob["is_next"] = (ob["status"] == "not_started" and not ob.get("superseded_by")
                         and all(status_by_slug.get(p) == "merged" for p in ob["after"]))

    order_view = order if order is not None else sorted(by_slug)
    next_action = _next_action(out_binders, order_view, sorted(set(warnings)), errors,
                               archived, default_branch, recovery=rec)
    return {
        "repo": {"default_branch": default_branch},
        "order": order,                      # None on cycle — derived, never stored
        "binders": _in_order(out_binders, order_view),
        "next_action": next_action,
        "warnings": sorted(set(warnings)),
        "errors": errors,
    }


def _in_order(out_binders: list[dict], order_view: list[str]) -> list[dict]:
    pos = {s: i for i, s in enumerate(order_view)}
    return sorted(out_binders, key=lambda ob: pos.get(ob["slug"], len(pos)))


# The calm end-state copy. One constant, shared by the derive and the self-test —
# the hub landing renders next_action.human verbatim, so this string is contract.
DONE_HUMAN = "all binders merged — nothing left to run"
# A repo with no binder at all, live or archived, and nothing wrong: plan one.
EMPTY_HUMAN = "no binders planned yet — plan the first one with hatch-plan"
# The landing sentence is the deliver skill's own report wording
# (hatch-deliver Phase 7): the branch is the user's to merge. Status
# names that decision; it never runs it and never offers a command for it.
LANDING_HUMAN = ("{slug}: every item is merged on hatch/{slug}/integration. "
                 "That branch holds the one assembled result to review. No PR is open. "
                 "Review this branch and merge it yourself.")
BLOCKED_HUMAN = "no binder is ready to run — resolve the warnings/errors this status lists"


def _done_count(items: dict) -> int:
    """Complete items: clean-done plus accepted-done (a waiver is still merged)."""
    return sum(items.get(k, 0) or 0 for k in COMPLETE_STATES)


def _cleanup_command(cleanup: dict) -> str | None:
    """Remove leftover worktrees first (a branch checked out in one cannot be
    deleted), then the branches. Both commands refuse unmerged or dirty
    state on their own, so the suggestion cannot lose work."""
    import shlex
    parts = [f"git worktree remove {shlex.quote(p)}" for p in cleanup.get("worktrees", [])]
    branches = cleanup.get("branches", [])
    if branches:
        parts.append("git branch -d " + " ".join(shlex.quote(b) for b in branches))
    return " && ".join(parts) or None


def _next_action(out_binders: list[dict], order_view: list[str], warnings: list[str],
                 errors: list[str], archived: frozenset[str] = frozenset(),
                 default_branch: str = "main", recovery: dict | None = None) -> dict:
    by_slug = {ob["slug"]: ob for ob in out_binders}
    ordered = [by_slug[s] for s in order_view if s in by_slug]
    # a superseded predecessor's remaining work is delivered by its successor
    active = [ob for ob in ordered if not ob.get("superseded_by")]
    rec = recovery or {}

    # 0) a binder file status cannot read: it would otherwise simply vanish
    unreadable = [_load_error_path(e) for e in errors if e.startswith(LOAD_ERROR_PREFIX)]
    if unreadable:
        return {"level": "error", "command": None,
                "human": ("repair or restore the unreadable binder file(s) "
                          + ", ".join(unreadable)
                          + " — status leaves them out until they parse as a binder")}
    # 0b) a committed binder missing from the working tree
    for d in rec.get("deleted", []):
        slug = d["slug"]
        if d.get("archive_pending"):
            return {"level": "repair", "command": None,
                    "human": (f"binder '{slug}' was moved to .hatch/binders/archive/ "
                              f"but the move is not committed — commit it on "
                              f"hatch/{slug}/integration (hatch-deliver's "
                              f"end-of-life step)")}
        return {"level": "repair",
                "command": (f"git restore --source=HEAD --staged --worktree -- "
                            f".hatch/binders/{slug}.json"),
                "human": (f"binder '{slug}' is committed but missing from the working tree — "
                          f"restore it, or commit its removal if that was deliberate")}
    # 1) an in-flight binder with a failed item — fix/rerun or re-plan
    for ob in active:
        if ob["status"] == "in_flight" and ob["items"]["failed"]:
            return {"level": "item", "command": f"hatch-deliver {ob['slug']}",
                    "human": f"{ob['slug']} has a halted item — fix and re-run, or re-plan with hatch-plan"}
    # 2) an in-flight binder with work left (building/ready/blocked, or built
    #    items the merge queue never merged) — resume it
    for ob in active:
        it = ob["items"]
        if ob["status"] == "in_flight" and (it["building"] or it["ready"] or it["blocked"]
                                            or it.get("built")):
            done, total = _done_count(it), it["total"]
            if it.get("built") and not (it["building"] or it["ready"] or it["blocked"]):
                built = [d["id"] for d in it["detail"] if d["status"] == "built"]
                return {"level": "item", "command": f"hatch-deliver {ob['slug']}",
                        "human": (f"resume {ob['slug']}: item(s) {', '.join(built)} are built "
                                  f"but not merged — the merge queue did not finish "
                                  f"({done}/{total} done)")}
            return {"level": "item", "command": f"hatch-deliver {ob['slug']}",
                    "human": f"resume {ob['slug']} ({done}/{total} done)"}
    # 2b) every item merged on the integration branch, not yet on the default
    #     branch — the landing is the human's decision, so no command
    for ob in active:
        it = ob["items"]
        if ob["status"] == "in_flight" and it["total"] and _done_count(it) == it["total"]:
            return {"level": "landing", "command": None,
                    "human": LANDING_HUMAN.format(slug=ob["slug"])}
    # 3) no in-flight work — start the next not-started, unblocked binder.
    #    Exception (finding 21): if that binder's declared surface already sits
    #    on the default branch, re-delivering can only whiff on no-change — point
    #    at reviewing and archiving instead, never a re-delivery loop.
    for ob in ordered:
        if ob.get("is_next"):
            if ob.get("surface_on_default"):
                slug = ob["slug"]
                return {"level": "review",
                        "command": (f"mkdir -p .hatch/binders/archive && "
                                    f"git mv .hatch/binders/{slug}.json "
                                    f".hatch/binders/archive/"),
                        "human": (f"{slug}: its declared surface already exists on "
                                  f"{default_branch} — likely delivered outside hatch; "
                                  f"review, then archive (rather than re-deliver)")}
            return {"level": "binder", "command": f"hatch-deliver {ob['slug']}",
                    "human": f"start {ob['slug']} (its predecessors are merged)"}
    # 4) everything merged or archived (zero live binders included) on a clean
    #    derive — done, or cleanup when a landed binder left branches or
    #    worktrees behind. Warnings/errors keep the blocked message so a
    #    dangling edge or cycle is never papered over.
    if ((ordered or archived) and not warnings and not errors
            and all(ob["status"] == "merged" for ob in ordered)):
        cleanup = rec.get("cleanup") or {}
        command = _cleanup_command(cleanup)
        if command:
            slugs = ", ".join(cleanup.get("slugs", [])) or "a delivered binder"
            return {"level": "cleanup", "command": command,
                    "human": (f"everything is delivered — {slugs} left merged branches or "
                              f"worktrees behind; remove them (git refuses to delete "
                              f"anything unmerged or dirty)")}
        return {"level": "done", "command": None, "human": DONE_HUMAN}
    # 5) nothing planned at all, and nothing wrong — plan the first binder
    if not ordered and not archived and not warnings and not errors:
        return {"level": "empty", "command": "hatch-plan", "human": EMPTY_HUMAN}
    # 6) work remains but nothing is runnable (blocked / cycle bottleneck)
    if warnings or errors:
        return {"level": "blocked", "command": None, "human": BLOCKED_HUMAN}
    waiting = [f"{ob['slug']} waits on {', '.join(p for p in ob['after'] if by_slug.get(p, {}).get('status') != 'merged')}"
               for ob in ordered if ob["status"] == "not_started" and not ob.get("is_next")]
    return {"level": "blocked", "command": None,
            "human": ("no binder is ready to run"
                      + (" — " + "; ".join(waiting) + " (not yet merged)" if waiting else ""))}


_GLYPH = {"merged": "✓", "in_flight": "●", "not_started": "○"}
_ITEM_GLYPH = {"done": "✓", "accepted": "≈", "built": "▣", "failed": "✗", "building": "◐",
               "ready": "·", "blocked": "○"}


def render_terminal(state: dict) -> str:
    lines: list[str] = []
    for w in state["warnings"]:
        lines.append(f"  warning: {w}")
    for e in state["errors"]:
        lines.append(f"  error: {e}")
    route = "   ".join(f"{b['slug']} {_GLYPH[b['status']]}"
                       + (f" (superseded by {b['superseded_by']})" if b.get("superseded_by") else "")
                       for b in state["binders"])
    lines.append(route or "(no binders planned yet)")
    for b in state["binders"]:
        if b["status"] == "in_flight":
            it = b["items"]
            lines.append("")
            lines.append(f"{b['slug']}  (current binder)        {_done_count(it)}/{it['total']} done")
            for d in it["detail"]:
                tail = ("  needs " + ", ".join(d["blocked_by"])) if d.get("blocked_by") else ""
                if d["status"] == "accepted":
                    # a waiver is never a pass: say so, with the human's reason
                    tail = "  (waived — " + (d.get("waiver_reason") or "reason not recorded") + ")"
                if d.get("carried_from"):
                    tail += f"  (delivered by {d['carried_from']})"
                lines.append(f"   {_ITEM_GLYPH.get(d['status'], '?')} {d['id']}  {d['status']}{tail}")
    na = state["next_action"]
    lines.append("  " + "─" * 44)
    if na["command"]:
        lines.append(f"▶ next:  {na['command']}   ({na['human']})")
    else:
        lines.append(f"▶ {na['human']}")
    return "\n".join(lines)


# `built` shows as ▣ (committed, awaiting the orchestrator's merge); `building` as ◐;
# `accepted` as ≈ (merged under a human waiver — close to done, never the same).


def render_footer(state: dict, slug: str) -> str:
    na = state["next_action"]
    cur = next((b for b in state["binders"] if b["slug"] == slug), None)
    head = ""
    if cur:
        it = cur["items"]
        done = _done_count(it)
        left = it["total"] - done
        head = f"{slug} {done}/{it['total']}" + (f" · {left} left" if left else " · complete")
        if it.get("accepted"):
            head += f" · {it['accepted']} waived"
    tip = f"▶ {na['command']}" if na["command"] else f"▶ {na['human']}"
    return "  ".join(x for x in (head, tip) if x)


# ---------------------------------------------------------------------------
# Hatch Watch surface (revive-integration): every real engine touch fires a
# fail-open, fire-and-forget `serve_status.py --ensure`, and the terminal map
# (never --footer, which stays one line, never --json) may carry one nudge line when this repo is
# opted in but the hub is unreachable. Nothing here ever alters this script's
# own stdout shape on --json, its JSON schema, or its exit code.
# ---------------------------------------------------------------------------

_WATCH_SCRIPT = Path(__file__).resolve().parent / "serve_status.py"
# Shared terms (binder hatch-watch-hub): the 'Hatch Watch:' prefix and the
# 'turn off hatch watch' phrase are canonical — render them byte-exactly.
WATCH_BANNER = ('Hatch Watch: http://127.0.0.1:{port}/?key={token} — '
                'persistent; say "turn off hatch watch" to disable.')
WATCH_NUDGE = ('Hatch Watch: hub not running{reason} — revive it: '
               'uv run --script {script} --ensure')
# --watch's answers when there is no URL to give: one plain line each, so
# asking for the URL is never answered by silence. ASCII on purpose: they must
# survive any console encoding unchanged ({script}/{root}/{reason} may not).
# {script} and {root} arrive already quoted by _paste_path.
WATCH_NOT_OPTED = ('Hatch Watch: this repo is not opted into the persistent '
                   'Hatch Watch; opt in with hatch_script action statusControl '
                   'operation optIn (fallback: uv run --script {script} '
                   '--opt-in); for an ephemeral page instead, serve '
                   'uv run --script {script} --root {root} --port 8765')
WATCH_UNAVAILABLE = ('Hatch Watch: this repo is opted in but the hub URL is '
                     'unavailable ({reason}); revive it: '
                     'uv run --script {script} --ensure')
WATCH_NO_REPO = ('Hatch Watch: the current folder is not inside a git '
                 'checkout, so there is no repo to watch; run this from '
                 'inside a repo.')
# watch_report's re-probe window: the on-demand path has just fired --ensure
# on a possibly cold hub, which needs ~1 s to bind, so it waits ~2 s; the
# session-start hook keeps its own shorter window.
WATCH_REPORT_RETRIES = 8


def _paste_path(path) -> str:
    """A path as it pastes into a shell command: double-quoted when it holds
    whitespace. Double quotes are the one quoting POSIX shells, cmd and
    PowerShell all read the same way for an ordinary path."""
    text = os.fspath(path)
    return f'"{text}"' if any(c.isspace() for c in text) else text


def _fire_ensure(popen=None, os_name: str | None = None,
                 cwd: str | None = None) -> None:
    """Fire-and-forget hub revival: spawn `serve_status.py --ensure` with its
    stdio on DEVNULL plus close_fds (POSIX) or the detached-process creation
    flags (Windows), so a parent capturing this script's output can never
    block on, or receive bytes from, the ensure child. Every failure is
    swallowed — the embed is fail-open and never changes this script's own
    output or exit code. The popen/os_name seams exist for the self-test."""
    try:
        if not _WATCH_SCRIPT.is_file():
            return
        kwargs: dict = {"stdin": subprocess.DEVNULL,
                        "stdout": subprocess.DEVNULL,
                        "stderr": subprocess.DEVNULL,
                        "close_fds": True,
                        # A detached Windows child that inherits a short-lived
                        # repo cwd can keep that directory undeletable. The
                        # ensure path is state-file driven and never needs the
                        # caller's checkout as its working directory.
                        "cwd": str(Path(sys.executable).resolve().parent)}
        if (os_name or os.name) != "posix":
            kwargs["creationflags"] = (
                getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
                | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200))
        source_cwd = os.path.abspath(cwd or os.getcwd())
        (popen or subprocess.Popen)(
            [sys.executable, str(_WATCH_SCRIPT), "--ensure", "--root", source_cwd],
            **kwargs)
    except Exception:
        pass


def _load_watch():
    """The sibling serve_status module (watch store + probe), or None when it
    is unavailable. Imported lazily so the engine costs nothing extra at load
    and there is no import cycle (serve_status imports this module)."""
    try:
        d = str(Path(__file__).resolve().parent)
        if d not in sys.path:
            sys.path.insert(0, d)
        import serve_status
        return serve_status
    except Exception:
        return None


def _watch_state_path() -> Path:
    """The per-user watch state file, resolved WITHOUT importing serve_status
    — the cold-path gate below must stay a bare stat/read. Mirrors
    serve_status.resolve_state_dir (HATCH_WATCH_STATE_DIR override first, then
    the platform dir); serve_status's self-test pins that resolution, this
    copy only ever reads."""
    override = os.environ.get("HATCH_WATCH_STATE_DIR")
    if override:
        return Path(override) / "state.json"
    home = Path(os.environ["HOME"]) if os.environ.get("HOME") else Path.home()
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        base = Path(local) if local else home / "AppData" / "Local"
    elif sys.platform == "darwin":
        base = home / "Library" / "Application Support"
    else:
        xdg = os.environ.get("XDG_STATE_HOME")
        base = Path(xdg) if xdg else home / ".local" / "state"
    return base / "hatch-watch" / "state.json"


def _nearest_git_root(cwd: str | None = None) -> str | None:
    """The nearest directory at or above `cwd` holding a .git, as
    serve_status.find_repo_root decides it — or None outside any checkout."""
    d = os.path.abspath(os.fspath(cwd) if cwd is not None else os.getcwd())
    while not os.path.exists(os.path.join(d, ".git")):
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent
    return d


def _opted_in_root(cwd: str | None = None) -> str | None:
    """The cold-path gate: the repo root above `cwd` when that root is opted
    in per the per-user store, else None — decided from a stat/read of the
    small state JSON alone. A repo with no store file or no opt-in pays
    nothing beyond that read: serve_status is never imported here, and
    nothing is created on disk. Fail-open: any error is 'not opted in'."""
    try:
        state_path = _watch_state_path()
        if not state_path.is_file():
            return None
        d = _nearest_git_root(cwd)
        if d is None:
            return None
        doc = json.loads(state_path.read_bytes())
        repos = doc.get("repos") if isinstance(doc, dict) else None
        rec = repos.get(d) if isinstance(repos, dict) else None
        return d if isinstance(rec, dict) and rec.get("opted_in") else None
    except Exception:
        return None


def watch_line(cwd: str | None = None, *, banner: bool = False, probe=None,
               retries: int = 0, retry_delay: float = 0.25,
               sleep=time.sleep) -> str | None:
    """Fail-open wrapper over _watch_line: any error returns None."""
    try:
        return _watch_line(cwd, banner=banner, probe=probe, retries=retries,
                           retry_delay=retry_delay, sleep=sleep)
    except Exception:
        return None


def _watch_line(cwd: str | None = None, *, banner: bool = False, probe=None,
                retries: int = 0, retry_delay: float = 0.25,
                sleep=time.sleep) -> str | None:
    """The one Hatch Watch line for the human surfaces, or None.

    None unless the repo at `cwd` is opted in per the per-user watch store —
    decided by the cheap _opted_in_root read BEFORE the watch module loads, so
    a non-opted repo never pays the serve_status import. Opted in with the hub
    answering our token: the persistent-watch URL banner — only when `banner`
    is set (the session-start hook's surface; this script's own renders stay
    quiet while the hub is healthy). Opted in with the hub unreachable: up to
    `retries` re-probes ~retry_delay s apart first (the hook passes 2 — its
    just-fired ensure needs ~1 s to bind, and nudging about a hub that is
    coming up reads as broken), then the one-line nudge naming the --ensure
    one-liner plus any failure reason the ensure path recorded in the state
    dir. Raises on error (watch_line is the fail-open wrapper). Never called
    on the --json path."""
    if _opted_in_root(cwd) is None:
        return None
    watch = _load_watch()
    if watch is None:
        raise RuntimeError("serve_status could not be loaded")
    sd = watch.ensure_state_dir()
    port = watch._hub_port(sd)
    token = watch.get_token()
    probe_fn = probe or (lambda p: watch._probe_hub(p, token))
    kind = probe_fn(port)[0]
    for _ in range(retries):
        if kind == "ours":
            break
        sleep(retry_delay)
        port = watch._hub_port(sd)  # a just-fired ensure may record a new port
        kind = probe_fn(port)[0]
    if kind == "ours":
        return WATCH_BANNER.format(port=port, token=token) if banner else None
    reason = ""
    try:
        doc = json.loads((sd / watch.ENSURE_FAILURE_FILENAME).read_bytes())
        if isinstance(doc, dict) and doc.get("reason"):
            reason = f" ({doc['reason']})"
    except Exception:
        reason = ""
    return WATCH_NUDGE.format(reason=reason, script=watch._SCRIPT_PATH)


def watch_report(cwd: str | None = None, *, probe=None,
                 retries: int = WATCH_REPORT_RETRIES,
                 sleep=time.sleep) -> str:
    """The --watch answer: the Hatch Watch line on demand, on any harness.

    The session-start banner is the only other surface that carries the
    keyed URL, and not every harness shows it. This is watch_line with the
    banner on and a ~2 s re-probe window (the caller has just fired --ensure
    at a possibly cold hub) — the keyed URL when the hub answers, the revive
    nudge when it does not — except that it is never silent: outside any git
    checkout it yields WATCH_NO_REPO; a repo that is not opted in yields
    WATCH_NOT_OPTED, naming the opt-in call and the ephemeral serve command;
    an opted-in repo whose line cannot be computed yields WATCH_UNAVAILABLE
    with the reason. The cold-path promise holds: a non-opted repo never
    imports serve_status."""
    root = _nearest_git_root(cwd)
    if root is None:
        return WATCH_NO_REPO
    script = _paste_path(_WATCH_SCRIPT)
    if _opted_in_root(cwd) is None:
        return WATCH_NOT_OPTED.format(script=script, root=_paste_path(root))
    try:
        line = _watch_line(cwd, banner=True, probe=probe, retries=retries,
                           sleep=sleep)
        reason = "no line was produced"
    except Exception as exc:
        line = None
        reason = (" ".join(str(exc).split()) or type(exc).__name__)[:120]
    if line is not None:
        return line
    return WATCH_UNAVAILABLE.format(reason=reason, script=script)


def _print_line(line: str) -> None:
    """Print one human line on any console. A Windows console may be cp1252
    or cp437 and a redirected one may be ascii; the banner and nudge carry an
    em dash, so a character the console cannot encode becomes '?' rather
    than a UnicodeEncodeError and a non-zero exit."""
    try:
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass
    print(line)


def _git(*args: str) -> str:
    try:
        return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8").stdout
    except OSError:
        return ""


def _default_branch() -> str:
    """Resolved in hatch-deliver's preflight order, so status reads
    the branch delivery used: git config hatch.defaultBranch (a
    local branch), the local origin/HEAD symref, the only local
    non-hatch/* branch, exactly one of main/master. Offline. Where
    preflight would halt, status still renders and reports "main", whose
    absence then reads as 'no surface information'."""
    def local(name: str) -> bool:
        return bool(_git("rev-parse", "--verify", "--quiet", f"refs/heads/{name}^{{commit}}").strip())

    configured = _git("config", "--get", "hatch.defaultBranch").strip()
    if configured:
        return configured if local(configured) else "main"
    head = _git("symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").strip()
    if head.startswith("refs/remotes/origin/"):
        return head[len("refs/remotes/origin/"):]
    branches = [b.strip() for b in _git("for-each-ref", "--format=%(refname:short)",
                                        "refs/heads/").splitlines()
                if b.strip() and not b.strip().startswith("hatch/")]
    if len(branches) == 1:
        return branches[0]
    conventional = [b for b in ("main", "master") if b in branches]
    return conventional[0] if len(conventional) == 1 else "main"


def default_branch_paths(default_branch: str, runner=None) -> frozenset[str] | None:
    """Every file path tracked on the default branch, from one read-only
    `git ls-tree -r --name-only <branch>`. None when the branch is missing or
    the call fails — so a caller can tell 'no surface information' apart from
    'the surface is empty'. Read-only by construction: it inspects a branch's
    tree, never the working copy and never a ref. `runner` is the injection
    seam the self-test drives."""
    run = runner or subprocess.run
    try:
        proc = run(["git", "ls-tree", "-r", "--name-only", default_branch],
                   capture_output=True, text=True)
    except OSError:
        return None
    if proc.returncode != 0:
        return None
    return frozenset(line for line in proc.stdout.splitlines() if line)


def _binder_surface_on_default(binder: dict, tree_paths: frozenset[str] | None) -> bool | None:
    """True when every file the binder's items declare in `touches` already
    exists on the default branch, False when at least one is absent, None when
    the question cannot be answered — the tree is unknown, or no item declares
    any touch (an empty surface can never be 'already delivered'). A glob touch
    is present when it matches at least one tracked path; a bare directory touch
    when any tracked path sits under it. Advisory only: the answer is a hint,
    never a state change — no ref is written and nothing is archived."""
    if tree_paths is None:
        return None
    touches: list[str] = []
    for it in binder.get("work_items", []) or []:
        for t in it.get("touches", []) or []:
            if isinstance(t, str) and t.strip():
                touches.append(t.strip())
    if not touches:
        return None
    for t in touches:
        norm = (t[2:] if t.startswith("./") else t).rstrip("/")
        if any(ch in norm for ch in "*?["):
            present = any(fnmatch.fnmatch(p, norm) for p in tree_paths)
        elif norm in tree_paths:
            present = True
        else:
            prefix = norm + "/"
            present = any(p.startswith(prefix) for p in tree_paths)
        if not present:
            return False
    return True


def _surface_hints(binders: list[dict], git_facts: dict, archived: frozenset[str],
                   default_branch: str) -> dict[str, bool | None] | None:
    """The read-only 'already delivered outside hatch?' hints for the human
    renders, or None. Computed only when at least one binder derives
    not_started — the only state the hint can fire in — so a repo with no idle
    binder never pays the tree read. None (rather than a partial map) whenever
    the default-branch tree is unknown. Advisory: the result only colours the
    next-action copy, never the derived state (finding 21)."""
    prelim = derive_state(binders, git_facts, archived)
    if not any(b["status"] == "not_started" for b in prelim["binders"]):
        return None
    tree = default_branch_paths(default_branch)
    if tree is None:
        return None
    return {b["slug"]: _binder_surface_on_default(b, tree) for b in binders}


LOAD_ERROR_PREFIX = "binder file "


def _load_error(path: Path, why: str) -> str:
    return (f"{LOAD_ERROR_PREFIX}{path.as_posix()} is unreadable: {why} — "
            "status leaves it out until it is repaired")


def _load_error_path(error: str) -> str:
    return error[len(LOAD_ERROR_PREFIX):].split(" is unreadable:", 1)[0]


def _binder_shape_error(doc) -> str | None:
    """The minimal shape derive_state indexes, or why this document is not it.
    Structural only — full validation belongs to validate_binder.py."""
    if not isinstance(doc, dict):
        return f"not a JSON object (got {type(doc).__name__})"
    if not isinstance(doc.get("slug"), str) or not doc["slug"].strip():
        return "no string `slug`"
    items = doc.get("work_items", [])
    if not isinstance(items, list):
        return "`work_items` is not a list"
    for n, it in enumerate(items):
        if not isinstance(it, dict) or not isinstance(it.get("id"), str):
            return f"work_items[{n}] has no string `id`"
        if not isinstance(it.get("depends_on", []) or [], list):
            return f"work_items[{n}].depends_on is not a list"
    after = doc.get("after", []) or []
    if not isinstance(after, list) or not all(isinstance(a, str) for a in after):
        return "`after` is not a list of slugs"
    return None


def load_binders(binders_dir: Path = BINDERS_DIR) -> tuple[list[dict], list[str]]:
    """(binders, errors): every live binder that has the shape the derivation
    reads, plus one error per file that does not — unreadable, not JSON, or
    JSON that is not a binder object. A bad file is reported, never skipped
    silently and never handed on to crash derive_state."""
    out: list[dict] = []
    errors: list[str] = []
    if binders_dir.is_dir():
        for p in sorted(binders_dir.glob("*.json")):
            try:
                doc = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, UnicodeDecodeError) as e:
                errors.append(_load_error(p, f"{type(e).__name__}: {e}"[:160]))
                continue
            except json.JSONDecodeError as e:
                errors.append(_load_error(p, f"not valid JSON ({e.msg}, line {e.lineno})"))
                continue
            why = _binder_shape_error(doc)
            if why:
                errors.append(_load_error(p, why))
                continue
            out.append(doc)
    return out, errors


def load_archived_binders(archive_dir: Path = ARCHIVE_DIR) -> list[dict]:
    """Delivered binders, moved to `.hatch/binders/archive/` by hatch-deliver's
    end-of-life step. Same shape as `load_binders`; consumed for `after`
    satisfaction (the engine) and the Delivered timeline phase (the watch page)."""
    out = []
    if archive_dir.is_dir():
        for p in sorted(archive_dir.glob("*.json")):
            try:
                doc = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(doc, dict) and isinstance(doc.get("slug"), str):
                out.append(doc)
    return out


def _for_each_ref(args: list[str], runner=None) -> tuple[list[str], bool]:
    """One `git for-each-ref` subprocess, returning (lines, ok). `runner` is the
    injection seam gather_git_facts exposes: swap in a stand-in for
    subprocess.run to count calls or fail one of the three deliberately. `ok`
    is False on any failure (nonzero exit, or a spawn error) so the caller
    degrades the facts that call feeds to unknown instead of raising."""
    run = runner or subprocess.run
    try:
        proc = run(["git", "for-each-ref", *args], capture_output=True, text=True)
    except OSError:
        return [], False
    if proc.returncode != 0:
        return [], False
    return [line for line in proc.stdout.splitlines() if line], True


def gather_git_facts(binders: list[dict], default_branch: str, runner=None) -> dict:
    """Three whole-namespace ref queries answer every binder's and item's git
    facts at once, however many binders or items exist:
      1. every refs/hatch/ marker leaf (done/built/failed/accepted), one for-each-ref
      2. every refs/heads/hatch/ branch (integration + per-item), one for-each-ref
      3. the refs/hatch/ subset reachable from default_branch — replacing the
         old per-done-item `merge-base --is-ancestor` exit-code probe; git
         peels annotated tags here exactly as merge-base does
    `runner` is the injection seam: a stand-in for subprocess.run, used to
    count calls (the call-count check) or fail one of the three on purpose
    (the resilience check). Any one query failing degrades only the facts it
    feeds — marked None (unknown), never an exception; the rest of the state
    still renders. `default_branch` not existing (missing/renamed) fails only
    query 3, so done/built/failed/branch stay known even then.

    "Unknown, never false" is a claim about query FAILURE, and there is one
    non-failure case it does not cover: with `--merged` in play git's ref-filter
    silently skips a ref that does not peel to a commit. So a `.../done` marker
    pointing at a blob or a tree appears in query 1 and is absent from query 3 —
    done True, done_in_default False, no error anywhere. That is a false rather
    than an unknown. It is not a regression: the per-item `merge-base
    --is-ancestor` form this replaced returned the same false through a nonzero
    exit. hatch only ever points a marker at a commit, so no hatch-written ref
    reaches it."""
    markers, markers_ok = _for_each_ref(["--format=%(refname)", "refs/hatch/"], runner)
    branches, branches_ok = _for_each_ref(["--format=%(refname)", "refs/heads/hatch/"], runner)
    merged, merged_ok = _for_each_ref(
        ["--format=%(refname)", f"--merged={default_branch}", "refs/hatch/"], runner)
    marker_set = set(markers) if markers_ok else None
    branch_set = set(branches) if branches_ok else None
    merged_set = set(merged) if merged_ok else None

    facts = {"default_branch": default_branch, "binders": {}}
    # a successor's carried items are proven by its predecessor's refs; gather
    # them too when the predecessor is no longer a live binder
    live = {b.get("slug") for b in binders}
    extra: dict[str, set[str]] = {}
    for b in binders:
        sup = _supersedes(b)
        if sup and sup[0] not in live:
            extra.setdefault(sup[0], set()).update(sup[1])
    binders = list(binders) + [{"slug": p, "work_items": [{"id": i} for i in sorted(ids)]}
                               for p, ids in sorted(extra.items())]
    for b in binders:
        slug = b["slug"]
        item_ids = [it["id"] for it in b.get("work_items", [])]
        integration = (None if branch_set is None else
                       f"refs/heads/hatch/{slug}/integration" in branch_set)
        items = {}
        for i in item_ids:
            base = f"refs/hatch/{slug}/item-{i}"
            done = None if marker_set is None else f"{base}/done" in marker_set
            if done is None:
                done_in_default = None
            elif not done:
                done_in_default = False
            elif merged_set is None:
                done_in_default = None
            else:
                done_in_default = f"{base}/done" in merged_set
            items[i] = {
                "done": done,
                "done_in_default": done_in_default,
                "built": None if marker_set is None else f"{base}/built" in marker_set,
                "failed": None if marker_set is None else f"{base}/failed" in marker_set,
                "accepted": None if marker_set is None else f"{base}/accepted" in marker_set,
                "branch": (None if branch_set is None else
                          f"refs/heads/hatch/{slug}/item-{i}" in branch_set),
            }
        facts["binders"][slug] = {"integration_exists": integration, "items": items}
    return facts


# ---------------------------------------------------------------------------
# Recovery facts: what plain ref presence cannot say. A done ref is trusted
# only after the provenance rules delivery itself applies on resume
# (hatch-deliver's deliver_preflight done_provenance):
# check_item_provenance.py's commit markers over <done>^1..<done>, its
# --check-accepted rules, and first-parent reachability of the done merge on
# hatch/<slug>/integration. The checker is the deliver skill's own
# script, loaded from the sibling skill directory the way hatch-build's
# item_context.py loads it — one implementation of the rule, not a copy.
# ---------------------------------------------------------------------------

PROVENANCE_SCRIPT = (Path(__file__).resolve().parent.parent.parent
                     / "hatch-deliver" / "scripts" / "check_item_provenance.py")
_PROVENANCE_MODULE: object = None          # None = not tried; False = unavailable
_PROVENANCE_CACHE: dict[str, dict] = {}    # verdicts keyed by every sha they read
_CHAIN_CACHE: dict[str, frozenset[str]] = {}
_CACHE_MAX = 2048
_ACCEPT_REASON = "Hatch-Accept-Reason"


def _load_provenance():
    """The deliver skill's check_item_provenance module, or None when the
    sibling skill is not installed beside this one."""
    global _PROVENANCE_MODULE
    if _PROVENANCE_MODULE is None:
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "hatch_item_provenance", PROVENANCE_SCRIPT)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            _PROVENANCE_MODULE = mod
        except Exception:                                      # noqa: BLE001
            _PROVENANCE_MODULE = False
    return _PROVENANCE_MODULE or None


def _git_rc(*args: str, repo: Path | None = None) -> tuple[int, str]:
    cmd = ["git", *(["-C", str(repo)] if repo is not None else []), *args]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    except OSError:
        return 1, ""
    return p.returncode, p.stdout


def _first_parent(tip: str, repo: Path | None = None) -> frozenset[str]:
    chain = _CHAIN_CACHE.get(tip)
    if chain is None:
        rc, out = _git_rc("rev-list", "--first-parent", tip, repo=repo)
        chain = frozenset(out.split()) if rc == 0 else frozenset()
        if len(_CHAIN_CACHE) > 64:
            _CHAIN_CACHE.clear()
        _CHAIN_CACHE[tip] = chain
    return chain


def done_provenance(slug: str, item_id: str, refs: dict[str, str],
                    default_branch: str, prov=None, repo: Path | None = None) -> dict:
    """{"suspect": [findings], "waiver_reason": str | None} for one done ref,
    judged by delivery's resume rules. `refs` maps refname -> object id for the
    hatch namespaces. An empty `suspect` list means trusted.

    When the integration branch is gone (a landed delivery cleaned up), the
    reachability half cannot be asked; the done merge must then be merged into
    the default branch, and the marker check still runs. An accepted ref is
    never trusted without the integration branch to prove it against.

    Verdicts are cached by every object id they depend on, so a Watch poll
    re-pays nothing while git has not moved."""
    prov = prov or _load_provenance()
    base = f"refs/hatch/{slug}/item-{item_id}"
    done, accepted = refs.get(f"{base}/done"), refs.get(f"{base}/accepted")
    integ = refs.get(f"refs/heads/hatch/{slug}/integration")
    scope = tuple(sorted(kv for kv in refs.items()
                         if kv[0].startswith((f"refs/hatch/{slug}/",
                                              f"refs/heads/hatch/{slug}/"))))
    default_tip = (_git_rc("rev-parse", "--verify", "--quiet", default_branch,
                           repo=repo)[1].strip() if integ is None else None)
    key = hashlib.sha256(json.dumps([slug, item_id, done, accepted, integ, scope,
                                     default_tip]).encode("utf-8")).hexdigest()
    hit = _PROVENANCE_CACHE.get(key)
    if hit is not None:
        return hit
    findings: list[str] = []
    reason = None
    where = repo if repo is not None else Path(".")
    try:
        findings += prov.check_markers(where, item_id, f"{done}^1..{done}")
        if integ is not None:
            if done not in _first_parent(integ, repo):
                findings.append(f"the done merge {done[:12]} is not first-parent-reachable "
                                f"on hatch/{slug}/integration")
            findings += prov.check_accepted(where, slug, item_id)
        else:
            if _git_rc("merge-base", "--is-ancestor", done, default_branch, repo=repo)[0] != 0:
                findings.append(f"there is no hatch/{slug}/integration branch to "
                                f"check the done merge against, and it is not merged into "
                                f"{default_branch}")
            if accepted:
                findings.append("the accepted ref cannot be checked without the "
                                "integration branch")
        if accepted and not findings:
            msg = _git_rc("log", "-1", "--format=%B", done, repo=repo)[1]
            vals = [ln.strip()[len(_ACCEPT_REASON) + 1:].strip() for ln in msg.splitlines()
                    if ln.strip().startswith(_ACCEPT_REASON + ":")]
            reason = vals[0] if vals else None
    except prov.GitError as e:
        findings.append(f"git could not read it ({str(e)[:160]})")
    verdict = {"suspect": findings, "waiver_reason": reason}
    if len(_PROVENANCE_CACHE) > _CACHE_MAX:
        _PROVENANCE_CACHE.clear()
    _PROVENANCE_CACHE[key] = verdict
    return verdict


def load_provenance_cache(text: str) -> None:
    """Seed the verdict cache from provenance_cache_text() output. A verdict is
    keyed by every object id it read, so a cached one can never describe a
    different git state. Malformed input is ignored, entry by entry."""
    try:
        doc = json.loads(text)
    except ValueError:
        return
    if not isinstance(doc, dict):
        return
    for k, v in list(doc.items())[-_CACHE_MAX:]:
        if (isinstance(v, dict) and isinstance(v.get("suspect"), list)
                and all(isinstance(f, str) for f in v["suspect"])
                and (v.get("waiver_reason") is None or isinstance(v["waiver_reason"], str))):
            _PROVENANCE_CACHE[k] = {"suspect": v["suspect"],
                                    "waiver_reason": v.get("waiver_reason")}


def provenance_cache_text() -> str:
    """The verdict cache as JSON, for a caller that keeps it between processes
    (the Watch hub's per-repo child derivations)."""
    return json.dumps(dict(list(_PROVENANCE_CACHE.items())[-_CACHE_MAX:]))


def done_verdicts(repo: Path, slug: str, item_ids: list[str],
                  default_branch: str) -> dict[str, dict] | None:
    """done_provenance for each named item of one binder that carries a done
    ref, read from the repository at `repo`. None when the provenance checker
    is unavailable, so a caller can say it trusted refs alone. This is the one
    entry point the delivery Stop guard shares with status."""
    prov = _load_provenance()
    if prov is None:
        return None
    rc, out = _git_rc("for-each-ref", "--format=%(refname) %(objectname)",
                      f"refs/hatch/{slug}/", f"refs/heads/hatch/{slug}/",
                      repo=repo)
    refs = dict(line.rsplit(" ", 1) for line in out.splitlines() if " " in line) if rc == 0 else {}
    return {i: done_provenance(slug, i, refs, default_branch, prov, repo=repo)
            for i in item_ids if f"refs/hatch/{slug}/item-{i}/done" in refs}


def item_spec_digest(item: dict) -> str:
    """The digest gate_attempts.py and Pi's itemSpecDigest give one work item."""
    canonical = json.dumps(item, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# The halt record: a JSON blob at refs/hatch/<slug>/item-<id>/halt saying why an
# item stopped. references/halt-record.json holds its rules as data, for this
# engine and extensions/pi/halt-record.ts alike, and the two parsers are held
# equal by the rows of item-states.json. The bytes are untrusted: a worker can
# write them on the skill route, and they reach a page and a model. So reading
# never raises, a reason never echoes the record, and an item's state is worked
# out before and without it. A view is "current" only while the item's spec
# digest and tip still match and no later outcome ref stands beside it.
# ---------------------------------------------------------------------------

HALT_RULES_PATH = (Path(__file__).resolve().parent.parent
                   / "references" / "halt-record.json")
_HALT_RULES: dict | None = None                 # the one cached load
_MAX_SAFE_INTEGER = 2 ** 53 - 1


def load_halt_rules(path: Path = HALT_RULES_PATH) -> dict:
    """The rules with their patterns compiled, or {"broken": the error's name} when the
    file is missing or broken, which makes every record unreadable and fails nothing else."""
    try:
        rules = json.loads(path.read_text(encoding="utf-8"))
        compiled = {name: re.compile(src) for name, src in rules["patterns"].items()}
        for key in ("schema_version", "max_bytes", "max_findings", "max_depth", "severities", "gates",
                    "phases", "kinds", "next_steps", "history", "reasons"):
            rules[key]
        return {**rules, "compiled": compiled}
    except (OSError, ValueError, KeyError, TypeError, AttributeError, re.error) as error:
        return {"broken": type(error).__name__}


def _halt_rules() -> dict:
    global _HALT_RULES
    if _HALT_RULES is None:
        _HALT_RULES = load_halt_rules()
    return _HALT_RULES


class _HaltDefect(ValueError):
    """One field failed: its name, from the rules, never its value."""


def _whole(value) -> int | None:
    """A JSON number as a whole int, or None. Numbers parse to floats, so this reads
    them as JavaScript does: 2.0 is whole, and past 2^53 nothing is."""
    if isinstance(value, float) and value.is_integer() and abs(value) <= _MAX_SAFE_INTEGER:
        return int(value)
    return None


def _halt_fields(doc: dict, rules: dict) -> dict:
    """The validated fields, and only those. Raises _HaltDefect on the first bad one."""
    compiled = rules["compiled"]

    def text(name: str, pattern: str, nullable: bool = False):
        value = doc.get(name)
        if value is None and nullable:
            return None
        if not (isinstance(value, str) and compiled[pattern].fullmatch(value)):
            raise _HaltDefect(name)
        return value

    gate = doc.get("gate")
    if gate is not None and (not isinstance(gate, str) or gate not in rules["gates"]):
        raise _HaltDefect("gate")
    phase = doc.get("phase")
    if not isinstance(phase, str) or phase not in rules["phases"]:
        raise _HaltDefect("phase")
    attempt = doc.get("attempt")
    if attempt is not None:
        attempt = _whole(attempt)
        if attempt is None or attempt < 1:
            raise _HaltDefect("attempt")
    found = doc.get("findings")
    if not isinstance(found, list) or len(found) > rules["max_findings"]:
        raise _HaltDefect("findings")
    findings = []
    for one in found:
        if not (isinstance(one, dict) and isinstance(one.get("severity"), str)
                and one["severity"] in rules["severities"]
                and isinstance(one.get("code"), str)
                and compiled["token"].fullmatch(one["code"])):
            raise _HaltDefect("findings")
        path, line = one.get("path"), one.get("line")
        if path is not None and not (isinstance(path, str) and compiled["path"].fullmatch(path)):
            raise _HaltDefect("findings")
        if line is not None:
            line = _whole(line)
            if line is None or line < 1:
                raise _HaltDefect("findings")
        findings.append({"severity": one["severity"], "code": one["code"],
                         "path": path, "line": line})
    return {
        "item_spec_sha256": text("item_spec_sha256", "sha256"),
        "halt_kind": text("halt_kind", "token"),
        "gate": gate,
        "phase": phase,
        "attempt": attempt,
        "findings": findings,
        "next_step": text("next_step", "token"),
        "required_check_id": text("required_check_id", "token", nullable=True),
        "item_tip": text("item_tip", "oid", nullable=True),
        "integration_tip": text("integration_tip", "oid", nullable=True),
        "recorded_at": text("recorded_at", "timestamp"),
        "hatch_version": text("hatch_version", "version"),
    }


def _nesting(text: str) -> int:
    """How deep the brackets outside JSON strings go. JSON.parse has no such limit and
    Python's parser raises at a depth that varies by version, so both languages cap it
    first, and malformed text gets the same answer from each."""
    depth = deepest = 0
    in_string = escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
            deepest = max(deepest, depth)
        elif ch in "]}":
            depth -= 1
    return deepest


def parse_halt_record(raw: bytes, slug: str, item: str, rules: dict) -> dict:
    """One record's bytes as {"status": "valid", "fields": ...}, {"status": "unsupported",
    "schema": n} or {"status": "unreadable", "why": a fixed reason}, with "error" naming
    the exception's type where one was caught, and never its text, which can quote the
    bytes. Never raises. parse_int=float gives every number JSON.parse's one number type."""
    def unreadable(why: str) -> dict:
        return {"status": "unreadable", "why": why}

    def no_constants(name: str):
        raise ValueError(name)

    if "broken" in rules:
        return {**unreadable("no-rules"), "error": rules["broken"]}
    if len(raw) > rules["max_bytes"]:
        return unreadable("too-large")
    try:
        text = raw.decode("utf-8")
        if _nesting(text) > rules["max_depth"]:
            return unreadable("too-deep")
        doc = json.loads(text, parse_int=float, parse_constant=no_constants)
    except ValueError as error:
        return {**unreadable("not-json"), "error": type(error).__name__}
    if not isinstance(doc, dict):
        return unreadable("not-an-object")
    schema = doc.get("schema_version")
    version = _whole(schema)
    if version is None:
        return unreadable("bad-field:schema_version")
    if version != rules["schema_version"]:
        return {"status": "unsupported", "schema": version}
    if doc.get("binder") != slug or doc.get("item") != item:
        return unreadable("wrong-item")
    try:
        return {"status": "valid", "fields": _halt_fields(doc, rules)}
    except _HaltDefect as defect:
        return unreadable(f"bad-field:{defect}")


def _halt_headline(fields: dict, rules: dict) -> str:
    kind = fields["halt_kind"]
    label = rules["kinds"].get(kind) or f'Kind "{kind}" (not known to this hatch version)'
    where = [rules["gates"][fields["gate"]]] if fields["gate"] else []
    where.append(rules["phases"][fields["phase"]])
    if fields["attempt"]:
        where.append(f"attempt {fields['attempt']}")
    return f"{label}: {', '.join(where)}. Recorded {fields['recorded_at']}."


def _halt_finding_line(finding: dict) -> str:
    where = finding["path"] or ""
    if where and finding["line"]:
        where += f":{finding['line']}"
    return " ".join(p for p in (finding["severity"], finding["code"], where) if p)


def _halt_reason_text(why: str, rules: dict) -> str:
    if why == "no-rules":
        return "hatch's halt rules file could not be read"
    name, _, field = why.partition(":")
    return rules["reasons"][name].replace("{field}", field)


def halt_view(parsed: dict, rules: dict, ref: str, spec: str | None,
              item_tip: str | None, outcome: bool) -> dict:
    """What a reader is shown: status, why, label_key, lines, the caught error's name when
    there was one, and for a valid record its fields under "record". A pure function of the parsed record and what git holds now."""
    tail = "The item's state does not depend on it."
    if parsed["status"] == "unreadable":
        reason = _halt_reason_text(parsed["why"], rules)
        named = {"error": parsed["error"]} if "error" in parsed else {}
        return {"status": "unreadable", "why": parsed["why"], "label_key": "halt_unread", **named,
                "lines": [f"A halt record exists at {ref} but hatch could not read it: "
                          f"{reason}. {tail}"]}
    if parsed["status"] == "unsupported":
        return {"status": "unsupported", "why": None, "label_key": "halt_unread",
                "lines": [f"A halt record exists from another hatch version (schema "
                          f"{parsed['schema']}). This version does not read it. {tail}"]}
    fields = parsed["fields"]
    why = ("spec-unknown" if spec is None
           else "spec-changed" if fields["item_spec_sha256"] != spec
           else "tip-moved" if fields["item_tip"] != item_tip
           else "outcome-written" if outcome else None)
    headline = _halt_headline(fields, rules)
    if why:
        old, new = fields["item_tip"], item_tip
        sentence = (rules["history"][why].replace("{old}", old[:7] if old else "no branch")
                    .replace("{new}", new[:7] if new else "no branch"))
        return {"status": "history", "why": why, "label_key": "halt_history", "record": fields,
                "lines": [f"History, not the present reason: {sentence}.", headline]}
    step = fields["next_step"]
    known = rules["next_steps"].get(step)
    next_line = (f"Next: {known}." if known
                 else f'Next: "{step}" (not known to this hatch version).')
    return {"status": "current", "why": None, "label_key": "halt", "record": fields,
            "lines": [headline, *(_halt_finding_line(f) for f in fields["findings"]), next_line]}


def _cat_blobs(oids: list[str]) -> dict[str, bytes]:
    """{oid: bytes} from one `git cat-file --batch`. An oid it does not return is absent."""
    try:
        proc = subprocess.run(["git", "cat-file", "--batch"], capture_output=True,
                              input="".join(f"{oid}\n" for oid in oids).encode("ascii"))
    except OSError:
        return {}
    out, at, blobs = proc.stdout, 0, {}
    while at < len(out):
        end = out.find(b"\n", at)
        if end < 0:
            break
        head = out[at:end].split()
        at = end + 1
        if len(head) == 3:
            size = int(head[2])
            blobs[head[0].decode("ascii")] = out[at:at + size]
            at += size + 1
    return blobs


def _halt_views(binders: list[dict], refs: dict[str, str]) -> dict:
    """{slug: {item: view}} for every declared item with a halt ref. Makes no git call
    without one, and two with any number: object type and size first, so a blob over
    the cap or a ref that is not a blob is never read."""
    found = {f"refs/hatch/{b['slug']}/item-{it['id']}/halt": (b["slug"], it)
             for b in binders for it in b.get("work_items", [])
             if f"refs/hatch/{b['slug']}/item-{it['id']}/halt" in refs}
    if not found:
        return {}
    rules = _halt_rules()
    objects: dict[str, tuple[str, int]] = {}
    if "broken" not in rules:
        lines, _ = _for_each_ref(["--format=%(refname) %(objecttype) %(objectsize)",
                                  "refs/hatch/*/*/halt"])
        for line in lines:
            name, kind, size = line.rsplit(" ", 2)
            objects[name] = (kind, int(size))

    def readable(ref: str) -> bool:
        return objects.get(ref, ("", 0))[0] == "blob" and objects[ref][1] <= rules["max_bytes"]

    wanted = [refs[ref] for ref in found if readable(ref)]
    blobs = _cat_blobs(wanted) if wanted else {}
    out: dict = {}
    for ref, (slug, it) in found.items():
        iid = it["id"]
        base = f"refs/hatch/{slug}/item-{iid}"
        kind, size = objects.get(ref, ("", 0))
        if "broken" in rules or refs[ref] in blobs:
            parsed = parse_halt_record(blobs.get(refs[ref], b""), slug, iid, rules)
        else:
            parsed = {"status": "unreadable",
                      "why": ("not-read" if kind == "" or readable(ref)
                              else "not-a-blob" if kind != "blob" else "too-large")}
        outcome = any(f"{base}/{name}" in refs for name in ("built", "done", "accepted"))
        out.setdefault(slug, {})[iid] = halt_view(
            parsed, rules, ref, item_spec_digest(it), refs.get(f"refs/heads/hatch/{slug}/item-{iid}"),
            outcome)
    return out


def gather_recovery_facts(binders: list[dict], git_facts: dict, default_branch: str,
                          archived: frozenset[str] = frozenset(),
                          binders_dir: Path = BINDERS_DIR) -> dict:
    """Facts for the states plain ref presence cannot tell apart. Read-only.

      items     {slug: {item: done_provenance verdict}} for every done ref
      halts     {slug: {item: halt_view}} for every declared item with a halt ref
      warnings  stray item refs, and a missing provenance checker
      deleted   live binders committed in HEAD but gone from the working tree
      cleanup   merged branches / mounted worktrees a landed binder left behind

    Fail-soft: a git call that fails contributes nothing, never an exception."""
    import re
    rec: dict = {"items": {}, "warnings": [], "deleted": [],
                 "cleanup": {"slugs": [], "worktrees": [], "branches": []}}
    lines, ok = _for_each_ref(["--format=%(refname) %(objectname)",
                               "refs/hatch/", "refs/heads/hatch/"])
    refs = dict(line.rsplit(" ", 1) for line in lines if " " in line) if ok else {}
    live = {b["slug"]: {it["id"] for it in b.get("work_items", [])} for b in binders}

    # stray refs: an item namespace under a live binder the binder never declared
    item_ref = re.compile(r"^refs/hatch/([^/]+)/item-(.+)/([^/]+)$")
    for ref in sorted(refs):
        m = item_ref.match(ref)
        if m and m.group(1) in live and m.group(2) not in live[m.group(1)]:
            rec["warnings"].append(
                f"binder '{m.group(1)}' has a {m.group(3)} ref for item '{m.group(2)}', which "
                f"is not in the binder — suspect, and status ignores it ({ref})")

    # provenance of every done ref the facts report
    gfb = git_facts.get("binders", {})
    checked = {slug: set(ids) for slug, ids in live.items()}
    for b in binders:
        sup = _supersedes(b)
        if sup and sup[0] != b["slug"]:
            checked.setdefault(sup[0], set()).update(sup[1])
    done_items = [(slug, iid) for slug, ids in checked.items() for iid in sorted(ids)
                  if gfb.get(slug, {}).get("items", {}).get(iid, {}).get("done")
                  and f"refs/hatch/{slug}/item-{iid}/done" in refs]
    prov = _load_provenance() if done_items else None
    if done_items and prov is None:
        rec["warnings"].append(
            "done refs were not provenance-checked — the deliver skill's "
            f"{PROVENANCE_SCRIPT.name} is not installed beside this one, so "
            "completion is read from refs alone")
    for slug, iid in (done_items if prov is not None else []):
        rec["items"].setdefault(slug, {})[iid] = done_provenance(
            slug, iid, refs, default_branch, prov)

    try:
        rec["halts"] = _halt_views(binders, refs)
    except Exception as error:                                 # noqa: BLE001
        rec["halts"] = {}
        rec["warnings"].append(f"halt records were not read ({type(error).__name__}); "
                               "no item's state depends on them")

    # a committed live binder deleted from the working tree (or a crash between
    # the end-of-life `git mv` and its commit)
    rc, out = _git_rc("ls-tree", "--name-only", "HEAD", binders_dir.as_posix() + "/")
    if rc == 0:
        for name in out.splitlines():
            fname = name.rsplit("/", 1)[-1]
            if not fname.endswith(".json") or (binders_dir / fname).exists():
                continue
            slug = fname[:-len(".json")]
            pending = (binders_dir / "archive" / fname).exists()
            rec["deleted"].append({"slug": slug, "archive_pending": pending})
            rec["warnings"].append(
                f"binder '{slug}' is committed in HEAD but deleted from the working tree"
                + (" (moved to archive/, move not committed)" if pending else "")
                + " — status cannot see its items")

    # leftovers of landed binders: branches merged into the default branch, and
    # worktrees still mounted on them. Refs under refs/hatch/ stay —
    # the deliver skill keeps a delivered run's refs on purpose.
    gone = sorted(s for s in archived if s not in live)
    if gone:
        merged, _ = _for_each_ref(["--format=%(refname)", f"--merged={default_branch}",
                                   "refs/heads/hatch/"])
        leftover = [r[len("refs/heads/"):] for r in merged if r.split("/")[3] in gone]
        rc, out = _git_rc("worktree", "list", "--porcelain")
        entries: list[dict] = []
        for block in (out.split("\n\n") if rc == 0 else []):
            entry = dict(line.split(" ", 1) for line in block.splitlines() if " " in line)
            if entry.get("worktree"):
                entries.append(entry)
        main_branch = entries[0].get("branch", "") if entries else ""
        wts = [e["worktree"] for e in entries[1:]
               if e.get("branch", "")[len("refs/heads/"):] in leftover]
        leftover = [b for b in leftover if "refs/heads/" + b != main_branch]
        if leftover or wts:
            rec["cleanup"] = {"slugs": sorted({b.split("/")[1] for b in leftover}) or gone,
                              "worktrees": wts, "branches": leftover}
    return rec


# ---------------------------------------------------------------------------
# The shared item-state table. references/item-states.json maps a ref
# configuration to what each reader of hatch's git state derives from it, and
# names where the readers disagree. This engine's self-test, both Stop guards'
# (through the engine they already load) and tests/pi/git-state.test.ts read it.
# scripts/validate_plugin.py fails when a Python self-test's output lacks a pass
# line with the table's value for any row, or its real derivation is no longer
# the one passed; for the Pi test it checks source text only and does not prove
# the test runs. A self-test that cannot find the table fails and says where it
# looked. The file ships beside this
# script in every install shape, so a missing table is a broken install.
# ---------------------------------------------------------------------------

ITEM_STATES_FIXTURE = (Path(__file__).resolve().parent.parent
                       / "references" / "item-states.json")


def plant_halt_record(doc: dict, row: dict, repo: Path) -> None:
    """Write a row's halt record to its real ref, then fail if the ref is absent: a
    runner that ignored the key would pass while proving nothing. A test plants the
    record because nothing else writes one yet."""
    plant, slug, item = row["halt"], doc["binder"]["slug"], doc["item"]
    root = f"{slug}/item-{item}"

    def tip(name: str) -> str | None:
        rc, out = _git_rc("rev-parse", "--verify", "--quiet", f"{name}^{{commit}}", repo=repo)
        return out.strip() if rc == 0 else None

    tips = {"@item_tip": tip(f"hatch/{root}"), "@integration_tip": tip(f"hatch/{slug}/integration"),
            "@failed_tip": tip(f"refs/hatch/{root}/failed")}
    declared = row.get("work_items", doc["binder"]["work_items"])
    digest = item_spec_digest(next(it for it in declared if it["id"] == item))
    if digest != doc["halt_spec_digest"]:
        raise RuntimeError(f"item-states row {row['id']}: the digest {digest} is not the "
                           f"table's {doc['halt_spec_digest']}")
    if plant.get("commit"):
        value = tips["@item_tip"]
    else:
        if "raw" in plant:
            body = plant["raw"] * plant.get("repeat", 1)
        else:
            record = {**doc["halt_record"], **plant.get("fields", {})}
            if "findings" in plant:
                record["findings"] = record["findings"][:1] * plant["findings"]
            body = json.dumps({k: digest if v == "@spec"
                               else tips.get(v, v) if isinstance(v, str) else v
                               for k, v in record.items()})
        value = subprocess.run(["git", "-C", str(repo), "hash-object", "-w", "--stdin"],
                               input=body.encode("utf-8"), capture_output=True,
                               check=True).stdout.decode("ascii").strip()
    subprocess.run(["git", "-C", str(repo), "update-ref", f"refs/hatch/{root}/halt", value],
                   capture_output=True, check=True)
    assert_halt_ref(repo, slug, item)


def assert_halt_ref(repo: Path, slug: str, item: str) -> None:
    """The ref plant_halt_record exists to write. The negative control calls this alone."""
    ref = f"refs/hatch/{slug}/item-{item}/halt"
    if _git_rc("show-ref", "--verify", "--quiet", ref, repo=repo)[0] != 0:
        raise RuntimeError(f"the planted halt record is not at {ref}")


def _item_state_repo(doc: dict, row: dict, repo: Path) -> None:
    """Build a row's ref configuration in a fresh repo: git steps and nothing else,
    then the row's halt record when it carries one."""
    repo.mkdir()
    for step in [*doc["seed"], *(s for name in row["setup"] for s in doc["steps"][name])]:
        proc = subprocess.run(["git", "-C", str(repo), *step], capture_output=True,
                              text=True, encoding="utf-8")
        if proc.returncode != 0:
            raise RuntimeError(f"item-states step {step} failed: {proc.stderr.strip()}")
    if "halt" in row:
        plant_halt_record(doc, row, repo)


def item_state_mismatch(reader: str, row: dict, got) -> str | None:
    """The failure line for a reader that derived something other than its cell."""
    want = row["expect"].get(reader)
    if got == want:
        return None
    return f"item-states row {row['id']}: {reader} reads {got!r}, the table says {want!r}"


def _read_item_states(path: Path) -> tuple[dict | None, str]:
    """(table, "") or (None, a failure line naming the path)."""
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, f"item-states fixture missing at {path}"
    except (OSError, ValueError) as e:
        return None, f"item-states fixture unreadable at {path}: {e}"
    if not isinstance(doc, dict) or not isinstance(doc.get("rows"), list):
        return None, f"item-states fixture unreadable at {path}: it has no rows list"
    return doc, ""


def item_state_checks(reader: str, derive, path: Path | None = None) -> list[tuple[str, bool]]:
    """(check name, ok) for one reader over every row. `derive(repo, binder, item)` is
    the reader's real derivation over a real scratch repo. A row whose cell for
    this reader is {"skip": why} prints that reason; it never passes silently. A
    row that raises is that row's failure, and the other rows still run. A pass
    line carries the derived value: scripts/validate_plugin.py requires one per row."""
    import tempfile
    path = path or ITEM_STATES_FIXTURE
    doc, problem = _read_item_states(path)
    if doc is None:
        return [(problem, False)]
    rows = doc["rows"]
    checks = [(f"item-states table has rows ({len(rows)})", bool(rows))]

    def binder_for(row: dict) -> dict:
        return {"slug": doc["binder"]["slug"],
                "work_items": row.get("work_items", doc["binder"]["work_items"])}

    with tempfile.TemporaryDirectory() as td:
        for n, row in enumerate(rows):
            try:
                cell = row["expect"].get(reader)
                if isinstance(cell, dict):
                    print(f"[SKIP] item-states row {row['id']}: {reader}: {cell['skip']}")
                    continue
                repo = Path(td) / f"row{n}"
                _item_state_repo(doc, row, repo)
                got = derive(repo, binder_for(row), doc["item"])
                miss = item_state_mismatch(reader, row, got)
                checks.append((miss or f"item-states row {row['id']}: {reader} reads {got!r}",
                               miss is None))
            except Exception as e:                             # noqa: BLE001
                checks.append((f"item-states row {row.get('id')}: {reader} raised {e!r}", False))
        # Selected by id, so a reordered table cannot move the control onto
        # another row: the built row's cell over the failed row's refs must fail.
        by_id = {row.get("id"): row for row in rows}
        built, failed = by_id.get("built"), by_id.get("failed")
        if built is None or failed is None:
            checks.append(("item-states negative control needs the built and failed rows", False))
        else:
            try:
                repo = Path(td) / "control"
                _item_state_repo(doc, failed, repo)
                got = derive(repo, binder_for(failed), doc["item"])
                miss = item_state_mismatch(reader, built, got) or ""
                checks.append((f"NEGATIVE CONTROL: built's cell over failed's refs fails {reader}",
                               miss.startswith(f"item-states row built: {reader} reads ")))
            except Exception as e:                             # noqa: BLE001
                checks.append((f"item-states negative control: {reader} raised {e!r}", False))
    return checks


def _status_state(repo: Path, binder: dict) -> dict:
    """The whole state a real derive gives over `repo`."""
    old = Path.cwd()
    os.chdir(repo)
    try:
        facts = gather_git_facts([binder], "main")
        return derive_state([binder], facts,
                            recovery=gather_recovery_facts([binder], facts, "main"))
    finally:
        os.chdir(old)


def _status_item_state(repo: Path, binder: dict, item: str) -> str:
    """The status a real derive gives the table's item, or not-in-binder when the
    binder does not declare it and status lists no entry for it."""
    detail = _status_state(repo, binder)["binders"][0]["items"]["detail"]
    return next((e["status"] for e in detail if e["id"] == item), "not-in-binder")


def _item_state_seam_checks() -> list[tuple[str, bool]]:
    """What the real table cannot show: its absence fails and says where it looked,
    a skipped row prints its reason and is not counted, and a derivation that
    raises fails its own row while the rest still run."""
    import contextlib, io, tempfile
    doc, problem = _read_item_states(ITEM_STATES_FIXTURE)
    if doc is None:
        return [(problem, False)]
    missing = item_state_checks("status", _status_item_state, Path("no-such") / "item-states.json")
    by_id = {row.get("id"): row for row in doc["rows"]}
    if not {"not-started", "built", "failed"} <= set(by_id):
        return [("item-states seam checks need the not-started, built and failed rows", False)]
    skipped = by_id["not-started"]
    skipped["expect"]["status"] = {"skip": "a reason"}
    skipped["setup"] = ["no-such-step"]

    def raises(_repo: Path, _binder: dict, _item: str) -> str:
        raise RuntimeError("derivation broke")

    with tempfile.TemporaryDirectory() as td:
        table = Path(td) / "table.json"
        table.write_text(json.dumps({**doc, "rows": [skipped, by_id["built"], by_id["failed"]]}),
                         encoding="utf-8")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            checks = item_state_checks("status", _status_item_state, table)
        broken = item_state_checks("status", raises, table)
        unreadable = Path(td) / "unreadable.json"
        unreadable.write_text("{not json", encoding="utf-8")
        garbled = item_state_checks("status", _status_item_state, unreadable)
    return [
        ("NEGATIVE CONTROL: a missing item-states table fails and names the path",
         len(missing) == 1 and missing[0][1] is False
         and "item-states fixture missing at no-such" in missing[0][0]),
        ("NEGATIVE CONTROL: an unreadable item-states table fails and names the path",
         len(garbled) == 1 and garbled[0][1] is False
         and f"item-states fixture unreadable at {unreadable}" in garbled[0][0]),
        ("an item-states skip prints its reason and is not reported as a pass",
         "[SKIP] item-states row not-started: status: a reason" in out.getvalue()
         and not any("row not-started:" in name for name, _ in checks)),
        ("NEGATIVE CONTROL: a derivation that raises fails each row and the run goes on",
         sum("status raised RuntimeError" in name and not ok for name, ok in broken) == 3),
    ]


def _without_halts(state: dict) -> dict:
    """A derived state with every record's view removed."""
    copy = json.loads(json.dumps(state))
    for binder in copy["binders"]:
        for entry in binder["items"]["detail"]:
            entry.pop("halt", None)
    return copy


def _halt_view_of(state: dict) -> dict:
    """The one record view a table row's derived state carries, or {}."""
    views = [e.get("halt") for b in state["binders"] for e in b["items"]["detail"]]
    return next((v for v in views if v), {})


def halt_row_problem(row: dict, base: dict, base_state: dict, state: dict) -> str | None:
    """Why a row with a record does not hold: its cells differ from its base row's, a
    derived state differs from the base's in anything but the view, or the view is not
    the row's. A view_skip for status leaves only the view's half unasked."""
    if row["expect"] != base["expect"]:
        return f"row {row['id']}: its cells differ from {base['id']}'s"
    if _without_halts(state) != _without_halts(base_state):
        return f"row {row['id']}: the record changed the derived state"
    if "status" in row.get("view_skip", {}):
        return None
    view = _halt_view_of(state)
    got = {"status": view.get("status"), "why": view.get("why")}
    want = {"status": row["view"]["status"], "why": row["view"].get("why")}
    if "lines" in row["view"]:
        got["lines"], want["lines"] = view.get("lines"), row["view"]["lines"]
    return None if got == want else f"row {row['id']}: view {got!r}, the table says {want!r}"


def _halt_row_checks() -> list[tuple[str, bool]]:
    """Every row with a record against its base row in real repos, over the engine's
    whole derived state, plus the controls that make that comparison able to fail."""
    import tempfile
    doc, problem = _read_item_states(ITEM_STATES_FIXTURE)
    if doc is None:
        return [(problem, False)]
    by_id = {row["id"]: row for row in doc["rows"]}
    records = [row for row in doc["rows"] if "halt" in row]
    checks = [(f"item-states has rows with a record ({len(records)})", bool(records))]

    def binder_for(row: dict) -> dict:
        return {"slug": doc["binder"]["slug"],
                "work_items": row.get("work_items", doc["binder"]["work_items"])}

    def state_of(row: dict, td: str, name: str) -> dict:
        repo = Path(td) / name
        _item_state_repo(doc, row, repo)
        return _status_state(repo, binder_for(row))

    with tempfile.TemporaryDirectory() as td:
        bases: dict[str, dict] = {}
        states: dict[str, dict] = {}
        for n, row in enumerate(records):
            base = by_id[row["base"]]
            try:
                if base["id"] not in bases:
                    bases[base["id"]] = state_of(base, td, f"base{n}")
                states[row["id"]] = state_of(row, td, f"record{n}")
                if "status" in row.get("view_skip", {}):
                    print(f"[SKIP] halt row {row['id']}: view: {row['view_skip']['status']}")
                miss = halt_row_problem(row, base, bases[base["id"]], states[row["id"]])
                seen = ("skipped" if "status" in row.get("view_skip", {})
                        else _halt_view_of(states[row["id"]]).get("status"))
                checks.append((miss or f"halt row {row['id']}: state equals {base['id']}, "
                               f"view {seen}", miss is None))
            except Exception as e:                             # noqa: BLE001
                checks.append((f"halt row {row['id']} raised {e!r}", False))
        unplanted = Path(td) / "unplanted"
        _item_state_repo(doc, by_id["failed"], unplanted)
        try:
            assert_halt_ref(unplanted, doc["binder"]["slug"], doc["item"])
            checks.append(("NEGATIVE CONTROL: a plant that wrote no ref fails", False))
        except RuntimeError as e:
            checks.append(("NEGATIVE CONTROL: a plant that wrote no ref fails",
                           "the planted halt record is not at refs/hatch/demo/item-a/halt" in str(e)))
    row, base = by_id["failed+halt-current"], by_id["failed"]
    state = states.get(row["id"], {"binders": []})
    moved = json.loads(json.dumps(state))
    for entry in (e for b in moved["binders"] for e in b["items"]["detail"]):
        entry["status"] = "building"
    checks += [
        ("NEGATIVE CONTROL: a state that reads the record fails its row",
         halt_row_problem(row, base, bases.get("failed", {"binders": []}), moved)
         == "row failed+halt-current: the record changed the derived state"),
        ("NEGATIVE CONTROL: a view belonging to another row fails",
         halt_row_problem({**row, "view": by_id["built+halt"]["view"]}, base,
                          bases.get("failed", {"binders": []}), state)
         == "row failed+halt-current: view {'status': 'current', 'why': None}, the table says "
            "{'status': 'history', 'why': 'outcome-written'}"),
        ("NEGATIVE CONTROL: words other than the table's fail",
         (halt_row_problem({**row, "view": {**row["view"], "lines": ["other words"]}}, base,
                           bases.get("failed", {"binders": []}), state) or "").endswith(
             "'why': None, 'lines': ['other words']}")),
        ("NEGATIVE CONTROL: a row whose cells are not its base's fails",
         halt_row_problem(row, by_id["built"], {"binders": []}, {"binders": []})
         == "row failed+halt-current: its cells differ from built's"),
    ]
    return checks


def _halt_call_checks() -> list[tuple[str, bool]]:
    """Reading records costs nothing without one and two git calls with any number, and
    a record over the cap or not a blob never reaches cat-file."""
    import tempfile
    doc, problem = _read_item_states(ITEM_STATES_FIXTURE)
    if doc is None:
        return [(problem, False)]
    by_id = {row["id"]: row for row in doc["rows"]}
    binder = {"slug": doc["binder"]["slug"], "work_items": doc["binder"]["work_items"]}

    def calls_for(repo: Path) -> list[list[str]]:
        seen: list[list[str]] = []
        real = subprocess.run

        def counting(cmd, *a, **k):
            seen.append([str(c) for c in cmd])
            return real(cmd, *a, **k)

        old = Path.cwd()
        os.chdir(repo)
        subprocess.run = counting
        try:
            gather_recovery_facts([binder], gather_git_facts([binder], "main"), "main")
        finally:
            subprocess.run = real
            os.chdir(old)
        return seen

    def repo_for(row: dict, td: str, name: str) -> Path:
        repo = Path(td) / name
        _item_state_repo(doc, row, repo)
        return repo

    with tempfile.TemporaryDirectory() as td:
        plain = len(calls_for(repo_for(by_id["failed"], td, "plain")))
        one = repo_for(by_id["failed+halt-current"], td, "one")
        with_one = calls_for(one)
        both = repo_for(by_id["failed+halt-current"], td, "both")
        subprocess.run(["git", "-C", str(both), "update-ref", "refs/hatch/demo/item-other/halt",
                        "refs/hatch/demo/item-a/halt"], check=True)
        with_two = len(calls_for(both))
        large = calls_for(repo_for(by_id["failed+halt-toolarge"], td, "large"))
        commit = calls_for(repo_for(by_id["failed+halt-commit"], td, "commit"))
        beside = {}
        for name in ("built", "done", "accepted"):
            repo = repo_for(by_id["failed+halt-current"], td, f"beside-{name}")
            subprocess.run(["git", "-C", str(repo), "update-ref", f"refs/hatch/demo/item-a/{name}",
                            "hatch/demo/item-a"], check=True)
            state = _status_state(repo, binder)
            beside[name] = next(e for e in state["binders"][0]["items"]["detail"]
                                if e["id"] == "a")["halt"]["why"]
        real_views, old = globals()["_halt_views"], Path.cwd()
        globals()["_halt_views"] = lambda *_: 1 / 0
        os.chdir(one)
        try:
            broken = gather_recovery_facts([binder], gather_git_facts([binder], "main"), "main")
        finally:
            os.chdir(old)
            globals()["_halt_views"] = real_views
    return [
        ("one halt record adds two git calls", len(with_one) == plain + 2),
        ("two halt records add the same two git calls", with_two == plain + 2),
        ("NEGATIVE CONTROL: a record over the cap never reaches cat-file",
         len(large) == plain + 1 and not any("cat-file" in c for c in large)),
        ("NEGATIVE CONTROL: a ref that is not a blob never reaches cat-file",
         len(commit) == plain + 1 and not any("cat-file" in c for c in commit)),
        *[(f"a matching record beside only a {name} ref is history",
           beside[name] == "outcome-written") for name in beside],
        ("NEGATIVE CONTROL: a reader that raises leaves a warning naming the error",
         "halt records were not read (ZeroDivisionError); no item's state depends on them"
         in broken["warnings"] and broken["halts"] == {}),
    ]


def _halt_parser_checks() -> list[tuple[str, bool]]:
    """What the rows cannot reach: the parser's edges, a view with no spec to compare,
    a missing rules file, and the exact words a reader is shown."""
    rules = load_halt_rules()
    if "broken" in rules:
        return [(f"the halt rules file loads, not {rules['broken']}", False)]
    tip, spec, oid = "a" * 40, "b" * 64, "c" * 40
    good = {"schema_version": 1, "binder": "s", "item": "a", "item_spec_sha256": spec,
            "halt_kind": "gate-cap", "gate": "acceptance-gate", "phase": "build", "attempt": 2,
            "findings": [{"severity": "major", "code": "ver-1", "path": "a/b.py", "line": 88},
                         {"severity": "minor", "code": "min-2"}],
            "next_step": "fix-and-rerun", "required_check_id": None, "item_tip": tip,
            "integration_tip": None, "recorded_at": "2026-11-06T21:39:00Z",
            "hatch_version": "2.46.7"}

    def parsed(**over) -> dict:
        return parse_halt_record(json.dumps({**good, **over}).encode("utf-8"), "s", "a", rules)

    def view(p: dict, *, now_spec=spec, now_tip=tip, outcome=False) -> dict:
        return halt_view(p, rules, "refs/hatch/s/item-a/halt", now_spec, now_tip, outcome)

    def why(p: dict) -> tuple:
        return (p["status"], p.get("why"))

    def nested(depth: int) -> dict:
        body = json.dumps(good)[1:].replace('"schema_version": 1, ', "")
        text = '{"schema_version": 1, "extra": ' + "[" * depth + "]" * depth + ", " + body
        return parse_halt_record(text.encode("utf-8"), "s", "a", rules)

    current = view(parsed())
    unknown = view(parsed(), now_spec=None)
    moved = view(parsed(), now_tip=oid)
    gone = view(parsed(item_tip=None), now_tip=oid)
    kind = view(parsed(halt_kind="quota-spent", next_step="ask-someone", gate=None))
    bad = view(parse_halt_record(b"{not json", "s", "a", rules))
    newer = view(parsed(schema_version=2))
    missing = load_halt_rules(Path("no-such"))
    norules = parse_halt_record(json.dumps(good).encode("utf-8"), "s", "a", missing)
    capped = json.dumps({**good, "hatch_version": "2.46.7"}).encode("utf-8")
    fit = capped + b" " * (rules["max_bytes"] - len(capped))
    head = "Gate attempts used up: acceptance gate, build phase, attempt 2. Recorded 2026-11-06T21:39:00Z."
    return [
        ("a current record reads as the page words it",
         current["label_key"] == "halt" and current["lines"] == [
             head, "major ver-1 a/b.py:88", "minor min-2", "Next: fix the item and rerun."]),
        ("a history record says so first, and shows no findings or next step",
         moved["label_key"] == "halt_history" and moved["lines"] == [
             f"History, not the present reason: the item branch moved from {tip[:7]} to "
             f"{oid[:7]} after this was recorded.", head]),
        ("a record of no branch names that",
         gone["lines"][0] == f"History, not the present reason: the item branch moved from "
                             f"no branch to {oid[:7]} after this was recorded."),
        ("a view with no spec to compare is history",
         why(unknown) == ("history", "spec-unknown") and unknown["lines"][0]
         == "History, not the present reason: hatch could not read this item's plan to compare."),
        ("an outcome beside a matching record is history",
         why(view(parsed(), outcome=True)) == ("history", "outcome-written")),
        ("no branch then and none now still binds", why(view(parsed(item_tip=None), now_tip=None))
         == ("current", None)),
        ("an unknown kind and next step render as literals, still bound",
         kind["status"] == "current" and kind["lines"][0]
         == 'Kind "quota-spent" (not known to this hatch version): build phase, attempt 2. '
            "Recorded 2026-11-06T21:39:00Z."
         and kind["lines"][-1] == 'Next: "ask-someone" (not known to this hatch version).'),
        ("an unreadable record says where and that the state does not depend on it",
         bad["label_key"] == "halt_unread" and bad["lines"] == [
             "A halt record exists at refs/hatch/s/item-a/halt but hatch could not read it: "
             "not valid JSON. The item's state does not depend on it."]),
        ("an unsupported record names its schema and is never interpreted",
         newer["status"] == "unsupported" and "record" not in newer and newer["lines"] == [
             "A halt record exists from another hatch version (schema 2). This version does "
             "not read it. The item's state does not depend on it."]),
        ("unknown keys are not carried", "extra" not in parsed(extra="x")["fields"]),
        ("a whole number spelled as a float reads as JavaScript reads it",
         parsed(attempt=2.0)["fields"]["attempt"] == 2),
        ("a record exactly at the cap is read", why(parse_halt_record(fit, "s", "a", rules))[0] == "valid"),
        ("NEGATIVE CONTROL: one byte over the cap is too large",
         why(parse_halt_record(fit + b" ", "s", "a", rules)) == ("unreadable", "too-large")),
        ("NEGATIVE CONTROL: a trailing newline fails a pattern",
         why(parsed(recorded_at="2026-11-06T21:39:00Z\n")) == ("unreadable", "bad-field:recorded_at")),
        ("NEGATIVE CONTROL: invalid UTF-8 is not JSON",
         why(parse_halt_record(b'{"a": "\xff"}', "s", "a", rules)) == ("unreadable", "not-json")),
        ("NEGATIVE CONTROL: NaN is not JSON",
         why(parse_halt_record(b'{"schema_version": NaN}', "s", "a", rules)) == ("unreadable", "not-json")),
        ("NEGATIVE CONTROL: a list is not an object",
         why(parse_halt_record(b"[]", "s", "a", rules)) == ("unreadable", "not-an-object")),
        ("NEGATIVE CONTROL: a record for another binder is the wrong item",
         why(parsed(binder="t")) == ("unreadable", "wrong-item")),
        ("NEGATIVE CONTROL: a fractional attempt fails",
         why(parsed(attempt=1.5)) == ("unreadable", "bad-field:attempt")),
        ("NEGATIVE CONTROL: a boolean attempt fails",
         why(parsed(attempt=True)) == ("unreadable", "bad-field:attempt")),
        ("NEGATIVE CONTROL: a line of zero fails its findings",
         why(parsed(findings=[{"severity": "major", "code": "c", "line": 0}]))
         == ("unreadable", "bad-field:findings")),
        ("NEGATIVE CONTROL: a schema version that is text is not read",
         why(parsed(schema_version="2")) == ("unreadable", "bad-field:schema_version")),
        ("NEGATIVE CONTROL: a gate outside the set fails",
         why(parsed(gate="other")) == ("unreadable", "bad-field:gate")),
        *[(f"NEGATIVE CONTROL: {name} fails", why(parsed(**over)) == ("unreadable", want))
          for name, over, want in (
              ("a gate that is not text", {"gate": 1}, "bad-field:gate"),
              ("a gate that is a list", {"gate": ["acceptance-gate"]}, "bad-field:gate"),
              ("a phase that is absent", {"phase": None}, "bad-field:phase"),
              ("a phase that is a list", {"phase": ["build"]}, "bad-field:phase"),
              ("an attempt of zero", {"attempt": 0}, "bad-field:attempt"),
              ("a finding that is null", {"findings": [None]}, "bad-field:findings"),
              ("a finding with a control byte in its code",
               {"findings": [{"severity": "major", "code": "c\x1b[2J"}]}, "bad-field:findings"),
              ("more findings than the cap",
               {"findings": [{"severity": "major", "code": "c"}] * 51}, "bad-field:findings"),
              ("findings that are not a list", {"findings": "x"}, "bad-field:findings"),
              ("a finding that is not an object", {"findings": [1]}, "bad-field:findings"),
              ("a severity that is not text",
               {"findings": [{"severity": 1, "code": "c"}]}, "bad-field:findings"),
              ("a code that is not text",
               {"findings": [{"severity": "major", "code": 1}]}, "bad-field:findings"),
              ("a path that is not text",
               {"findings": [{"severity": "major", "code": "c", "path": 1}]}, "bad-field:findings"),
              ("a line that is not a number",
               {"findings": [{"severity": "major", "code": "c", "line": "1"}]}, "bad-field:findings"),
              ("a code with a trailing newline",
               {"findings": [{"severity": "major", "code": "c\n"}]}, "bad-field:findings"),
              ("an attempt past the safe integers", {"attempt": 2 ** 53}, "bad-field:attempt"),
              ("a line past the safe integers",
               {"findings": [{"severity": "major", "code": "c", "line": 2 ** 53}]},
               "bad-field:findings"))],
        ("the largest safe integer is whole",
         parsed(attempt=2 ** 53 - 1)["fields"]["attempt"] == 2 ** 53 - 1),
        ("exactly the cap of findings is read",
         why(parsed(findings=[{"severity": "major", "code": "c"}] * rules["max_findings"]))[0]
         == "valid"),
        ("nesting at the cap is read", why(nested(rules["max_depth"] - 1))[0] == "valid"),
        ("NEGATIVE CONTROL: nesting one past the cap is too deep",
         why(nested(rules["max_depth"])) == ("unreadable", "too-deep")),
        ("NEGATIVE CONTROL: nesting past Python's recursion limit is too deep, not a crash",
         why(nested(4000)) == ("unreadable", "too-deep")),
        ("brackets inside text do not count as nesting",
         parsed(extra='"[{\\' + "[" * 500)["status"] == "valid"),
        ("the digest pin covers keys out of order, nesting and non-ASCII text",
         item_spec_digest({"id": "é", "z": {"b": [1, "ü"], "a": None}})
         == "8af560c7845a1e511a80abd393f5ef1ca453a6b2f726f0020fe3529b8712e310"),
        ("a reason never echoes record content",
         "SECRET" not in json.dumps(view(parsed(gate="SECRET")))),
        ("a missing rules file reads every record as unreadable and raises nothing",
         why(norules) == ("unreadable", "no-rules")
         and halt_view(norules, missing, "r", spec, tip, False) == {
             "status": "unreadable", "why": "no-rules", "label_key": "halt_unread",
             "error": "FileNotFoundError", "lines": [
                 "A halt record exists at r but hatch could not read it: hatch's halt rules "
                 "file could not be read. The item's state does not depend on it."]}),
        ("a record that is not JSON names the error's type",
         bad["error"] == "JSONDecodeError" and "not json" not in bad["error"]),
        ("a record that is not UTF-8 names the error's type",
         parse_halt_record(b'"\xff"', "s", "a", rules)["error"] == "UnicodeDecodeError"),
    ]


# ---------------------------------------------------------------------------
# gather_git_facts self-test support (batch-git-facts). `_reference_git_facts`
# is the ORIGINAL per-binder + per-item walker gather_git_facts replaced —
# kept here, production-dead, purely as the equivalence oracle: one
# for-each-ref per binder, one merge-base --is-ancestor exit-code probe per
# done item. The fixture builders below create real git repos so the oracle
# and the batched form answer the same actual git state.
# ---------------------------------------------------------------------------

def _reference_git_facts(binders: list[dict], default_branch: str) -> dict:
    facts = {"default_branch": default_branch, "binders": {}}
    for b in binders:
        slug = b["slug"]
        item_ids = [it["id"] for it in b.get("work_items", [])]
        refs = set(_git("for-each-ref", "--format=%(refname)",
                        f"refs/hatch/{slug}/").splitlines())
        integration = bool(_git("rev-parse", "--verify", "--quiet",
                                f"hatch/{slug}/integration").strip())
        items = {}
        for i in item_ids:
            base = f"refs/hatch/{slug}/item-{i}"
            done = f"{base}/done" in refs
            done_in_default = done and subprocess.run(
                ["git", "merge-base", "--is-ancestor", f"{base}/done", default_branch]
            ).returncode == 0
            branch = bool(_git("rev-parse", "--verify", "--quiet",
                               f"hatch/{slug}/item-{i}").strip())
            items[i] = {
                "done": done,
                "done_in_default": done_in_default,
                "built": f"{base}/built" in refs,
                "failed": f"{base}/failed" in refs,
                "accepted": f"{base}/accepted" in refs,
                "branch": branch,
            }
        facts["binders"][slug] = {"integration_exists": integration, "items": items}
    return facts


def _calls_stay_constant(counts: list[int]) -> bool:
    """The derivation's cost invariant: git calls stay constant as binder count
    grows. `counts` is the git-call count observed at each of several binder
    counts, in increasing order; true only when every one is the same. This is
    strictly stronger than pinning one number on one fixture — it survives the
    batched implementation being replaced by a different call-count-flat one.
    The self-test drives it both ways: the batched derivation must satisfy it,
    and a deliberately per-binder derivation must fail it, which is what makes
    the check itself known to work rather than merely never-seen-to-fail."""
    return len(counts) > 1 and len(set(counts)) == 1


def _git_facts_self_test_checks() -> list[tuple[str, bool]]:
    """batch-git-facts: equivalence across ref topologies, a constant git-call
    count (default-branch resolution included), and graceful degradation on a
    failing/erroring git call. Every check runs against a real git repo built
    with plain git — no mocked ref data — so both the oracle and the batched
    form answer the same actual state."""
    import contextlib, tempfile

    checks: list[tuple[str, bool]] = []

    @contextlib.contextmanager
    def _in_dir(path: Path):
        old = os.getcwd()
        os.chdir(path)
        try:
            yield
        finally:
            os.chdir(old)

    def _setup(args: list[str], cwd: Path, **kw) -> subprocess.CompletedProcess:
        kw.setdefault("text", True)
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True,
                              check=True, **kw)

    def _mk_repo(path: Path) -> str:
        path.mkdir(parents=True, exist_ok=True)
        _setup(["init", "-q", "-b", "main", "."], path)
        _setup(["config", "user.email", "t@example.com"], path)
        _setup(["config", "user.name", "t"], path)
        (path / "f").write_text("c1", encoding="utf-8")
        _setup(["add", "f"], path)
        _setup(["commit", "-q", "-m", "c1"], path)
        return _setup(["rev-parse", "HEAD"], path).stdout.strip()

    def _wi(iid: str) -> dict:
        return {"id": iid, "title": iid, "oracle": {"type": "unit"}}

    def _binder(slug: str, item_ids: list[str]) -> dict:
        return {"slug": slug, "motivation": "x", "scope": {"included": ["x"]},
                "work_items": [_wi(i) for i in item_ids]}

    def _topology(path: Path, sha: str, n_binders: int, n_items: int,
                 with_integration) -> list[dict]:
        """with_integration: True/False forces it for every binder; None
        alternates per binder index. Items cycle through every presence
        combination (done / built / failed / branch-only / nothing)."""
        binders, updates = [], []
        for bi in range(n_binders):
            slug = f"b{bi}"
            item_ids = [f"i{ii}" for ii in range(n_items)]
            for ii, iid in enumerate(item_ids):
                base = f"refs/hatch/{slug}/item-{iid}"
                pat = (bi + ii) % 5
                if pat == 0:
                    updates.append(f"update {base}/done {sha}")
                elif pat == 1:
                    updates.append(f"update {base}/built {sha}")
                elif pat == 2:
                    updates.append(f"update {base}/failed {sha}")
                elif pat == 3:
                    updates.append(f"update refs/heads/hatch/{slug}/item-{iid} {sha}")
            wi = with_integration if with_integration is not None else (bi % 2 == 0)
            if wi:
                updates.append(f"update refs/heads/hatch/{slug}/integration {sha}")
            binders.append(_binder(slug, item_ids))
        if updates:
            # Bytes, not text: text mode turns each "\n" into "\r\n" on Windows and
            # `update-ref --stdin` rejects the CR ("expected SP") — git wants LF exactly.
            _setup(["update-ref", "--stdin"], path, text=False,
                   input=("\n".join(updates) + "\n").encode("utf-8"))
        return binders

    def _equivalence(name: str, path: Path, binders: list[dict],
                     default_branch: str = "main") -> None:
        with _in_dir(path):
            ref = _reference_git_facts(binders, default_branch)
            new = gather_git_facts(binders, default_branch)
        checks.append((f"equivalence ({name}): batched == per-item reference walker",
                       ref == new))

    # -- six ref topologies: empty, single, typical (5x10), wide (20x10),
    # no integration branch, with integration branch --
    with tempfile.TemporaryDirectory() as sd:
        root = Path(sd)
        empty = root / "empty"; _mk_repo(empty)
        _equivalence("empty", empty, [])

        single = root / "single"; sha = _mk_repo(single)
        b = _topology(single, sha, 1, 1, True)
        _equivalence("single", single, b)

        typical = root / "typical"; sha = _mk_repo(typical)
        b = _topology(typical, sha, 5, 10, None)
        _equivalence("typical (5x10)", typical, b)

        wide = root / "wide"; sha = _mk_repo(wide)
        b = _topology(wide, sha, 20, 10, None)
        _equivalence("wide (20x10)", wide, b)

        no_int = root / "no-integration"; sha = _mk_repo(no_int)
        b = _topology(no_int, sha, 1, 3, False)
        _equivalence("no integration branch", no_int, b)

        with_int = root / "with-integration"; sha = _mk_repo(with_int)
        b = _topology(with_int, sha, 1, 3, True)
        _equivalence("with integration branch", with_int, b)

        # -- real, multi-commit history with a done ref NOT merged into default --
        hist = root / "history"; sha1 = _mk_repo(hist)
        (hist / "f2").write_text("c2", encoding="utf-8")
        _setup(["add", "f2"], hist); _setup(["commit", "-q", "-m", "c2"], hist)
        sha2 = _setup(["rev-parse", "HEAD"], hist).stdout.strip()
        _setup(["checkout", "-q", "-b", "side", sha1], hist)
        (hist / "f3").write_text("c3", encoding="utf-8")
        _setup(["add", "f3"], hist); _setup(["commit", "-q", "-m", "c3"], hist)
        sha3 = _setup(["rev-parse", "HEAD"], hist).stdout.strip()
        _setup(["checkout", "-q", "main"], hist)
        _setup(["update-ref", "refs/hatch/hb/item-merged/done", sha2], hist)
        _setup(["update-ref", "refs/hatch/hb/item-unmerged/done", sha3], hist)
        hb = [_binder("hb", ["merged", "unmerged"])]
        with _in_dir(hist):
            ref = _reference_git_facts(hb, "main")
            new = gather_git_facts(hb, "main")
        checks.append(("equivalence (real history, an unmerged done ref): "
                       "both forms agree on done_in_default for every item",
                       ref["binders"]["hb"]["items"]["merged"]["done_in_default"] is True
                       and ref == new
                       and new["binders"]["hb"]["items"]["merged"]["done_in_default"] is True
                       and new["binders"]["hb"]["items"]["unmerged"]["done_in_default"] is False))

        # -- annotated tags: one whose target is merged, one whose target is not.
        # Pins git's tag-peeling behaviour, verified directly on git 2.47.3:
        # for-each-ref --merged peels exactly as merge-base --is-ancestor does. --
        tags = root / "tags"; sha1 = _mk_repo(tags)
        (tags / "f2").write_text("c2", encoding="utf-8")
        _setup(["add", "f2"], tags); _setup(["commit", "-q", "-m", "c2"], tags)
        _setup(["tag", "-a", "-m", "merged", "tm", sha1], tags)
        _setup(["checkout", "-q", "-b", "side", sha1], tags)
        (tags / "f3").write_text("c3", encoding="utf-8")
        _setup(["add", "f3"], tags); _setup(["commit", "-q", "-m", "c3"], tags)
        sha3 = _setup(["rev-parse", "HEAD"], tags).stdout.strip()
        _setup(["tag", "-a", "-m", "not merged", "tnm", sha3], tags)
        _setup(["checkout", "-q", "main"], tags)
        _setup(["update-ref", "refs/hatch/tb/item-merged/done", "refs/tags/tm"], tags)
        _setup(["update-ref", "refs/hatch/tb/item-notmerged/done", "refs/tags/tnm"], tags)
        tb = [_binder("tb", ["merged", "notmerged"])]
        with _in_dir(tags):
            ref = _reference_git_facts(tb, "main")
            new = gather_git_facts(tb, "main")
        checks.append(("equivalence (annotated tags, one merged target one not): "
                       "both forms agree, peeling the tag exactly as merge-base does",
                       ref == new
                       and new["binders"]["tb"]["items"]["merged"]["done_in_default"] is True
                       and new["binders"]["tb"]["items"]["notmerged"]["done_in_default"] is False))

        # -- call count: a whole state derivation (default-branch resolution
        # included, counted at the subprocess boundary — the real
        # subprocess.run — rather than inside one helper) issues the same
        # fixed number of git subprocesses at 1, 5, 10 and 20 binders --
        cc = root / "callcount"; _mk_repo(cc)
        orig_run = subprocess.run
        binder_counts = (1, 5, 10, 20)
        totals = []
        with _in_dir(cc):
            for n in binder_counts:
                b = [_binder(f"cc{i}", ["a"]) for i in range(n)]
                seen = [0]

                def counting(*a, __seen=seen, **kw):
                    __seen[0] += 1
                    return orig_run(*a, **kw)

                subprocess.run = counting
                try:
                    db = _default_branch()
                    gather_git_facts(b, db)
                finally:
                    subprocess.run = orig_run
                totals.append(seen[0])
        checks.append(("git calls stay constant as binder count grows — whole "
                       "derivation at 1/5/10/20 binders, default-branch "
                       "resolution included, counted at the subprocess boundary",
                       _calls_stay_constant(totals)))

        # -- the same invariant one level down, through gather_git_facts's own
        # runner seam — plus the negative control that proves the check can
        # actually fail. _per_binder_facts is the pre-batch shape (one
        # for-each-ref per binder); the identical harness must report growth
        # for it, or the invariant check above would be untested machinery. --
        def _per_binder_facts(binders: list[dict], default_branch: str,
                              runner=None) -> dict:
            """Deliberately per-binder: one for-each-ref per binder, so its call
            count grows with binder count. The negative control only."""
            for b in binders:
                _for_each_ref(["--format=%(refname)",
                               f"refs/hatch/{b['slug']}/"], runner)
            return {}

        def _counts_for(derivation) -> list[int]:
            """Git calls `derivation` issues at each of binder_counts, observed
            through the injectable counting runner both derivations accept."""
            observed = []
            for n in binder_counts:
                b = [_binder(f"cc{i}", ["a"]) for i in range(n)]
                calls = []
                derivation(b, "main", runner=lambda *a, __c=calls, **kw: (
                    __c.append(1), orig_run(*a, **kw))[1])
                observed.append(len(calls))
            return observed

        inv = root / "invariant"; _mk_repo(inv)
        with _in_dir(inv):
            batched_counts = _counts_for(gather_git_facts)
            per_binder_counts = _counts_for(_per_binder_facts)
        checks.append(("git calls stay constant as binder count grows — "
                       "gather_git_facts at 1/5/10/20 binders through its own "
                       "runner seam",
                       _calls_stay_constant(batched_counts)))
        checks.append(("gather_git_facts issues exactly 3 git calls, at every "
                       "binder count",
                       batched_counts == [3, 3, 3, 3]))
        checks.append(("negative control: the same invariant check FAILS on a "
                       "deliberately per-binder derivation, so it is known to "
                       "detect the regression it guards",
                       per_binder_counts == [1, 5, 10, 20]
                       and not _calls_stay_constant(per_binder_counts)))

        # -- failure injection: one batched call failing degrades only the
        # facts it feeds, marked None — the rest of the page still renders --
        fi = root / "failinj"; sha = _mk_repo(fi)
        _setup(["update-ref", "refs/hatch/fi/item-a/done", sha], fi)
        fib = [_binder("fi", ["a"])]
        with _in_dir(fi):
            n = [0]

            def fail_third(*a, __n=n, **kw):
                __n[0] += 1
                if __n[0] == 3:
                    return subprocess.CompletedProcess(a[0], returncode=128,
                                                        stdout="", stderr="injected")
                return orig_run(*a, **kw)

            facts = gather_git_facts(fib, "main", runner=fail_third)
            item = facts["binders"]["fi"]["items"]["a"]
            checks.append(("failure injection: unaffected facts (done/built/failed/"
                           "branch) still populate when only the merged-set call fails",
                           item["done"] is True and item["built"] is False
                           and item["failed"] is False and item["branch"] is False))
            checks.append(("failure injection: the affected fact (done_in_default) "
                           "degrades to None, never raises",
                           item["done_in_default"] is None))

            def fail_all(*a, **kw):
                return subprocess.CompletedProcess(a[0], returncode=1,
                                                    stdout="", stderr="injected")

            facts_all = gather_git_facts(fib, "main", runner=fail_all)
            item_all = facts_all["binders"]["fi"]["items"]["a"]
            checks.append(("failure injection: every batched call failing yields "
                           "all-unknown facts for the item, never raises",
                           item_all["done"] is None and item_all["built"] is None
                           and item_all["failed"] is None and item_all["branch"] is None
                           and item_all["done_in_default"] is None
                           and facts_all["binders"]["fi"]["integration_exists"] is None))

            state = derive_state(fib, facts_all)
            try:
                term = render_terminal(state)
                foot = render_footer(state, "fi")
                rendered_ok = bool(term) and bool(foot)
            except Exception:                                     # noqa: BLE001
                rendered_ok = False
            checks.append(("failure injection: a state carrying unknown facts still "
                           "renders a page (terminal + footer), not blank or raising",
                           rendered_ok))

            def boom(*a, **kw):
                raise OSError("git not found")

            facts_boom = gather_git_facts(fib, "main", runner=boom)
            item_boom = facts_boom["binders"]["fi"]["items"]["a"]
            checks.append(("failure injection: a spawn OSError degrades to unknown "
                           "facts too, never raises",
                           item_boom["done"] is None and item_boom["done_in_default"] is None))

        # -- a refs/hatch/ entry pointing at a non-commit object (a blob) does
        # not break the derivation --
        blob = root / "blob"; sha = _mk_repo(blob)
        blob_oid = _setup(["hash-object", "-w", "--stdin"], blob,
                          input="not a commit").stdout.strip()
        _setup(["update-ref", "refs/hatch/bl/item-a/done", blob_oid], blob)
        blb = [_binder("bl", ["a"])]
        with _in_dir(blob):
            try:
                facts = gather_git_facts(blb, "main")
                ok = True
            except Exception:                                     # noqa: BLE001
                ok = False
        checks.append(("a refs/hatch/ entry on a non-commit object (a blob) does "
                       "not break the derivation",
                       ok and facts["binders"]["bl"]["items"]["a"]["done"] is True))

        # -- empty repository / unborn HEAD: no commits, no refs, no raise --
        emptyrepo = root / "emptyrepo"
        emptyrepo.mkdir(parents=True, exist_ok=True)
        _setup(["init", "-q", "-b", "main", "."], emptyrepo)
        eb = [_binder("e", ["a"])]
        with _in_dir(emptyrepo):
            try:
                db = _default_branch()
                facts = gather_git_facts(eb, db)
                ok = True
            except Exception:                                     # noqa: BLE001
                ok = False
        checks.append(("empty repository / unborn HEAD: default-branch resolution "
                       "and gather_git_facts both survive, no raise",
                       ok and facts["binders"]["e"]["items"]["a"]["done"] is False
                       and facts["binders"]["e"]["items"]["a"]["done_in_default"] is False))

        # -- detached HEAD does not break the derivation --
        detached = root / "detached"; sha = _mk_repo(detached)
        _setup(["checkout", "-q", "--detach", sha], detached)
        db_ = [_binder("d", ["a"])]
        with _in_dir(detached):
            try:
                facts = gather_git_facts(db_, "main")
                ok = True
            except Exception:                                     # noqa: BLE001
                ok = False
        checks.append(("detached HEAD does not break the derivation",
                       ok and facts["binders"]["d"]["items"]["a"]["done"] is False))

        # -- a missing or renamed default branch: query 3 fails, but query 1/2
        # data (done/built/failed/branch) stays known; only done_in_default
        # for a done item degrades to unknown --
        missing = root / "missingdefault"; sha = _mk_repo(missing)
        _setup(["update-ref", "refs/hatch/md/item-a/done", sha], missing)
        mdb = [_binder("md", ["a"])]
        with _in_dir(missing):
            try:
                facts = gather_git_facts(mdb, "trunk-does-not-exist")
                ok = True
            except Exception:                                     # noqa: BLE001
                ok = False
            item = facts["binders"]["md"]["items"]["a"] if ok else {}
        checks.append(("missing/renamed default branch: no raise, done stays known, "
                       "only done_in_default degrades to unknown",
                       ok and item.get("done") is True
                       and item.get("done_in_default") is None))

    return checks


def _watch_self_test_checks() -> list[tuple[str, bool]]:
    """Hatch Watch surface (revive-integration): the fire-and-forget ensure
    spawn, the one nudge/banner line, and — end to end — that neither ensure
    nor the watch surface ever alters --json output or the exit code. Every
    check points HATCH_WATCH_STATE_DIR at a scratch dir: the real per-user
    store is never touched, and no real hub daemon is ever spawned (the e2e
    occupies every candidate port so the ensure child fails open)."""
    import contextlib, socket, tempfile, time
    checks: list[tuple[str, bool]] = []

    @contextlib.contextmanager
    def temp_store():
        saved = os.environ.get("HATCH_WATCH_STATE_DIR")
        with tempfile.TemporaryDirectory() as sd:
            os.environ["HATCH_WATCH_STATE_DIR"] = sd
            try:
                yield Path(sd)
            finally:
                if saved is None:
                    os.environ.pop("HATCH_WATCH_STATE_DIR", None)
                else:
                    os.environ["HATCH_WATCH_STATE_DIR"] = saved

    # -- spawn args: DEVNULL stdio + close_fds / detached creation flags --
    calls: list[tuple[list[str], dict]] = []
    _fire_ensure(popen=lambda argv, **kw: calls.append((argv, kw)),
                 os_name="posix")
    ok = bool(calls)
    if ok:
        argv, kw = calls[0]
        ok = (argv == [sys.executable, str(_WATCH_SCRIPT), "--ensure", "--root",
                       os.path.abspath(os.getcwd())]
              and kw.get("stdin") is subprocess.DEVNULL
              and kw.get("stdout") is subprocess.DEVNULL
              and kw.get("stderr") is subprocess.DEVNULL
              and kw.get("close_fds") is True
              and kw.get("cwd") == str(Path(sys.executable).resolve().parent)
              and "creationflags" not in kw)
    checks.append(("ensure spawn (POSIX): --ensure argv, DEVNULL stdio, close_fds", ok))
    calls.clear()
    _fire_ensure(popen=lambda argv, **kw: calls.append((argv, kw)), os_name="nt")
    flags = calls[0][1].get("creationflags", 0) if calls else 0
    checks.append(("ensure spawn (Windows): detached creation flags + DEVNULL stdio",
                   bool(flags & 0x00000008) and bool(flags & 0x00000200)
                   and calls and calls[0][1].get("stdout") is subprocess.DEVNULL))
    checks.append(("ensure spawn never inherits the caller's disposable cwd",
                   bool(calls)
                   and calls[0][1].get("cwd")
                   == str(Path(sys.executable).resolve().parent)))

    def _boom(argv, **kw):
        raise OSError("spawn denied")
    try:
        _fire_ensure(popen=_boom)
        swallowed = True
    except Exception:                                          # noqa: BLE001
        swallowed = False
    checks.append(("ensure spawn failure is swallowed", swallowed))

    # -- watch_line: opt-in gate, exact banner, nudge, fail-open --
    with temp_store() as sd:
        watch = _load_watch()
        checks.append(("watch store module loads", watch is not None))
        repo = sd / "repo"
        (repo / ".git").mkdir(parents=True)
        checks.append(("not opted in -> no watch line", watch_line(str(repo)) is None))
        watch.upsert_repo(str(repo), opted_in=True)
        port = watch._hub_port(watch.ensure_state_dir())
        token = watch.get_token()
        expect = (f'Hatch Watch: http://127.0.0.1:{port}/?key={token} — '
                  f'persistent; say "turn off hatch watch" to disable.')
        checks.append(("opted in + reachable hub -> the exact URL banner",
                       watch_line(str(repo), banner=True,
                                  probe=lambda p: ("ours", {})) == expect))
        checks.append(("healthy hub -> the engine renders stay quiet",
                       watch_line(str(repo), probe=lambda p: ("ours", {})) is None))
        nudge = watch_line(str(repo), probe=lambda p: ("dead", None))
        checks.append(("opted in + unreachable -> nudge names the --ensure one-liner",
                       nudge is not None
                       and nudge.startswith("Hatch Watch: hub not running")
                       and f"{watch._SCRIPT_PATH} --ensure" in nudge
                       and "?key=" not in nudge))
        watch._record_ensure_failure("no bindable port")
        nudge2 = watch_line(str(repo), banner=True,
                            probe=lambda p: ("foreign", None))
        checks.append(("nudge carries the recorded failure reason",
                       nudge2 is not None and "(no bindable port)" in nudge2))
        checks.append(("outside any git checkout -> no watch line",
                       watch_line(str(sd / "nowhere")) is None))

        # -- the hook's bounded retry window (a just-fired ensure needs ~1 s
        # to bind): re-probe up to `retries` times ~250 ms apart, banner on a
        # late success, nudge only after the window exhausts --
        rp_probes: list[int] = []
        rp_naps: list[float] = []
        late = iter([("dead", None), ("dead", None), ("ours", {})])
        got_late = watch_line(str(repo), banner=True,
                              probe=lambda p: rp_probes.append(p) or next(late),
                              retries=2, sleep=rp_naps.append)
        checks.append(("retry: a hub that binds during the re-probe window"
                       " still yields the banner",
                       got_late == expect and len(rp_probes) == 3
                       and rp_naps == [0.25, 0.25]))
        rp_probes.clear(); rp_naps.clear()
        got_down = watch_line(str(repo), banner=True,
                              probe=lambda p: rp_probes.append(p)
                              or ("dead", None),
                              retries=2, sleep=rp_naps.append)
        checks.append(("retry: the window is bounded — 2 re-probes, then the"
                       " nudge",
                       got_down is not None
                       and got_down.startswith("Hatch Watch: hub not running")
                       and len(rp_probes) == 3 and len(rp_naps) == 2))
        rp_probes.clear(); rp_naps.clear()
        got_up = watch_line(str(repo), banner=True,
                            probe=lambda p: rp_probes.append(p) or ("ours", {}),
                            retries=2, sleep=rp_naps.append)
        checks.append(("retry: a first-probe success never sleeps",
                       got_up == expect and len(rp_probes) == 1
                       and rp_naps == []))

    # -- cold path: a repo not opted in decides from the bare state JSON and
    # never imports the watch module --
    with temp_store() as sd:
        cold_repo = sd / "cold"
        (cold_repo / ".git").mkdir(parents=True)
        code = ("import json, sys\n"
                "sys.path.insert(0, sys.argv[1])\n"
                "import hatch_next\n"
                "line = hatch_next.watch_line(sys.argv[2])\n"
                "print(json.dumps({'line': line,"
                " 'imported': 'serve_status' in sys.modules}))\n")
        proc = subprocess.run(
            [sys.executable, "-c", code,
             str(Path(__file__).resolve().parent), str(cold_repo)],
            capture_output=True, text=True, timeout=60, encoding="utf-8")
        try:
            cold = json.loads(proc.stdout)
        except ValueError:
            cold = {}
        checks.append(("cold path: a non-opted repo never imports serve_status",
                       proc.returncode == 0 and cold.get("line") is None
                       and cold.get("imported") is False))

    # -- --watch (watch_report): the on-demand URL line for any harness. It is
    # never silent: banner with the key, the nudge, or the opt-in line --
    with temp_store() as sd:
        repo = sd / "wrepo"
        (repo / ".git").mkdir(parents=True)
        repo = Path(os.path.realpath(repo))
        no_naps: list[float] = []
        cold_line = watch_report(str(repo), probe=lambda p: ("ours", {}),
                                 sleep=no_naps.append)
        checks.append(("--watch: not opted in -> the one opt-in line",
                       cold_line == WATCH_NOT_OPTED.format(
                           script=_WATCH_SCRIPT, root=str(repo))
                       and "\n" not in cold_line
                       and "statusControl" in cold_line and "optIn" in cold_line
                       and "--opt-in" in cold_line
                       and f"--root {repo} --port 8765" in cold_line
                       and no_naps == []))
        watch = _load_watch()
        watch.upsert_repo(str(repo), opted_in=True)
        port = watch._hub_port(watch.ensure_state_dir())
        token = watch.get_token()
        up = watch_report(str(repo), probe=lambda p: ("ours", {}),
                          sleep=no_naps.append)
        checks.append(("--watch: opted in + hub answering -> the keyed URL banner",
                       up == WATCH_BANNER.format(port=port, token=token)
                       and f"?key={token}" in up))
        down_naps: list[float] = []
        down = watch_report(str(repo), probe=lambda p: ("dead", None),
                            sleep=down_naps.append)
        checks.append(("--watch: opted in + hub down -> the revive nudge after"
                       " 8 re-probes (~2 s)",
                       down is not None
                       and down.startswith("Hatch Watch: hub not running")
                       and f"{watch._SCRIPT_PATH} --ensure" in down
                       and "?key=" not in down and len(down_naps) == 8))
        # a cold hub needs ~1 s to bind after the just-fired ensure: a hub
        # that first answers on the 4th probe still yields the banner
        calls = {"n": 0}

        def late(p):
            calls["n"] += 1
            return ("ours", {}) if calls["n"] >= 4 else ("dead", None)
        late_line = watch_report(str(repo), probe=late, sleep=lambda s: None)
        checks.append(("--watch: hub answering on the 4th probe -> the banner",
                       late_line == WATCH_BANNER.format(port=port, token=token)))
        # the just-fired ensure may bind a different port than the store held
        # (the derived default was taken): each re-probe re-reads the port
        moved = port + 3
        seen_ports: list[int] = []

        def moving(p):
            seen_ports.append(p)
            if len(seen_ports) == 1:
                watch.record_port(moved)
                return ("foreign", None)
            return ("ours", {}) if p == moved else ("dead", None)
        moved_line = watch_report(str(repo), probe=moving, sleep=lambda s: None)
        checks.append(("--watch: ensure moving the hub to a new port -> the"
                       " banner on the new port",
                       moved_line == WATCH_BANNER.format(port=moved, token=token)))
        watch.record_port(port)
        # opted in, but the watch module cannot answer: never claim the repo
        # is not opted in
        saved_load = globals()["_load_watch"]

        class _Broken:
            def ensure_state_dir(self):
                raise OSError("disk full")
        try:
            globals()["_load_watch"] = lambda: None
            no_mod = watch_report(str(repo), probe=lambda p: ("ours", {}),
                                  sleep=lambda s: None)
            globals()["_load_watch"] = lambda: _Broken()
            no_dir = watch_report(str(repo), probe=lambda p: ("ours", {}),
                                  sleep=lambda s: None)
        finally:
            globals()["_load_watch"] = saved_load
        unavailable = "this repo is opted in but the hub URL is unavailable"
        checks.append(("--watch: opted in + watch module missing -> the"
                       " unavailable line, not the opt-in hint",
                       unavailable in no_mod and "not opted" not in no_mod
                       and "--ensure" in no_mod and "\n" not in no_mod))
        checks.append(("--watch: opted in + state dir error -> the unavailable"
                       " line naming the reason",
                       unavailable in no_dir and "disk full" in no_dir
                       and "--ensure" in no_dir and "\n" not in no_dir))

    # -- --watch quoting and the no-repo case: a path holding a space is
    # double-quoted (pastes in POSIX shells, cmd and PowerShell); a folder
    # outside any checkout is never offered --opt-in --
    with temp_store() as sd:
        repo = sd / "w repo"
        (repo / ".git").mkdir(parents=True)
        repo = Path(os.path.realpath(repo))
        spaced = watch_report(str(repo), sleep=lambda s: None)
        saved_script = globals()["_WATCH_SCRIPT"]
        odd = sd / "my tools" / "serve_status.py"
        try:
            globals()["_WATCH_SCRIPT"] = odd
            odd_line = watch_report(str(repo), sleep=lambda s: None)
        finally:
            globals()["_WATCH_SCRIPT"] = saved_script
        checks.append(("--watch: a repo path with a space is double-quoted",
                       f'--root "{repo}" --port 8765' in spaced))
        checks.append(("--watch: a script path with a space is double-quoted",
                       f'uv run --script "{odd}" --opt-in' in odd_line
                       and f'uv run --script "{odd}" --root' in odd_line))
        nowhere = sd / "plain"
        nowhere.mkdir()
        bare = watch_report(str(nowhere), sleep=lambda s: None)
        checks.append(("--watch: outside any git checkout -> the no-repo line,"
                       " no --opt-in or --root",
                       "not inside a git checkout" in bare
                       and "--opt-in" not in bare and "--root" not in bare
                       and "\n" not in bare and bare.isascii()))

    with temp_store() as sd:
        repo = sd / "wcli"
        (repo / ".git").mkdir(parents=True)
        repo = Path(os.path.realpath(repo))
        # utf-8 pinned so a non-ASCII temp path round-trips on any OS; the
        # narrow-console case is the ascii check below
        proc = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                               "--watch"], capture_output=True, text=True,
                              cwd=repo, timeout=60, encoding="utf-8",
                              env=dict(os.environ, PYTHONIOENCODING="utf-8"))
        wl = proc.stdout.splitlines()
        checks.append(("--watch CLI: not opted in -> exit 0, exactly the opt-in line",
                       proc.returncode == 0 and len(wl) == 1
                       and wl[0] == WATCH_NOT_OPTED.format(script=_WATCH_SCRIPT,
                                                           root=str(repo))))

    # -- the cold-path gate reads the SAME store file serve_status writes, on
    # every platform branch, with no HATCH_WATCH_STATE_DIR override --
    watch = _load_watch()
    saved_env = {k: os.environ.get(k) for k in
                 ("HATCH_WATCH_STATE_DIR", "HOME", "XDG_STATE_HOME", "LOCALAPPDATA")}
    saved_plat = sys.platform
    parity = []
    try:
        os.environ.pop("HATCH_WATCH_STATE_DIR", None)
        os.environ["HOME"] = os.path.join(tempfile.gettempdir(), "hn-home")
        for plat in ("linux", "darwin", "win32"):
            for k in ("XDG_STATE_HOME", "LOCALAPPDATA"):
                os.environ.pop(k, None)
            sys.platform = plat
            parity.append(_watch_state_path()
                          == watch.resolve_state_dir(platform=plat) / "state.json")
    finally:
        sys.platform = saved_plat
        for k, v in saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    checks.append(("watch store path matches serve_status on linux, darwin,"
                   " win32", parity == [True, True, True]))

    # -- --watch on a narrow console (Windows cp1252/cp437, or ascii): the
    # banner and nudge carry an em dash; printing must never raise --
    checks.append(("--watch: the opt-in line is plain ASCII",
                   WATCH_NOT_OPTED.isascii()))
    code = ("import sys\n"
            "sys.path.insert(0, sys.argv[1])\n"
            "import hatch_next\n"
            "hatch_next._print_line(hatch_next.WATCH_BANNER.format("
            "port=8765, token='t'))\n")
    enc_env = dict(os.environ, PYTHONIOENCODING="ascii")
    proc = subprocess.run([sys.executable, "-c", code,
                           str(Path(__file__).resolve().parent)],
                          capture_output=True, env=enc_env, timeout=60)
    checks.append(("--watch: an ascii console prints the banner (em dash"
                   " replaced), exit 0",
                   proc.returncode == 0 and proc.stderr == b""
                   and proc.stdout.strip()
                   == b'Hatch Watch: http://127.0.0.1:8765/?key=t ? persistent;'
                      b' say "turn off hatch watch" to disable.'))

    # -- e2e: opted-in repo, every candidate port foreign — the detached child
    # fails open (never spawns), the footer stays one line, --json is
    # untouched, both exit 0 --
    with temp_store() as sd:
        repo = sd / "repo"
        (repo / ".hatch" / "binders").mkdir(parents=True)
        (repo / ".git").mkdir()
        (repo / ".hatch" / "binders" / "s.json").write_text(json.dumps(
            {"slug": "s", "motivation": "x", "scope": {"included": ["x"]},
             "work_items": [{"id": "a", "title": "A",
                             "oracle": {"type": "unit"}}]}), encoding="utf-8")
        # realpath: the child processes key the store by their resolved cwd
        repo = Path(os.path.realpath(repo))
        watch = _load_watch()
        watch.upsert_repo(str(repo), opted_in=True)
        listeners: list = []
        base = None
        for start in range(watch.PORT_BASE, watch.PORT_BASE + watch.PORT_SPAN - 5):
            socks = []
            try:
                for off in range(5):
                    s = socket.socket()
                    s.bind(("127.0.0.1", start + off))
                    s.listen(16)
                    socks.append(s)
                listeners, base = socks, start
                break
            except OSError:
                for s in socks:
                    s.close()
        checks.append(("e2e scaffold: five consecutive loopback ports held",
                       base is not None))
        if base is not None:
            watch.record_port(base)
            me = str(Path(__file__).resolve())
            crumb = watch.ensure_state_dir() / watch.ENSURE_FAILURE_FILENAME

            def wait_crumb() -> bool:
                """Each detached ensure child ends its candidate walk by
                failing open — writing the breadcrumb. Gating on it before
                the next step keeps every candidate port held for the whole
                walk, so a child can never see a freed port and spawn a real
                daemon out of the test."""
                deadline = time.time() + 30
                while time.time() < deadline:
                    if crumb.is_file():
                        return True
                    time.sleep(0.2)
                return False

            foot = subprocess.run([sys.executable, me, "--footer", "--binder", "s"],
                                  capture_output=True, text=True, cwd=repo,
                                  timeout=120, encoding="utf-8")
            ran_footer = wait_crumb()
            crumb.unlink(missing_ok=True)
            jso = subprocess.run([sys.executable, me, "--json"],
                                 capture_output=True, text=True, cwd=repo,
                                 timeout=120, encoding="utf-8")
            ran_json = wait_crumb()
            flines = foot.stdout.splitlines()
            checks.append(("e2e: --footer stays one line (no nudge) and exits 0",
                           foot.returncode == 0 and len(flines) == 1
                           and "Hatch Watch" not in foot.stdout))
            checks.append(("e2e: --json output and exit code are never altered",
                           jso.returncode == 0 and "Hatch Watch" not in jso.stdout
                           and isinstance(json.loads(jso.stdout), dict)))
            checks.append(("e2e: both fire-and-forget ensure children ran and failed open",
                           ran_footer and ran_json))
        for s in listeners:
            s.close()
    return checks


def _run_self_test() -> int:
    new   = {"slug": "s-new",  "motivation": "x", "scope": {"included": ["x"]},
             "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}
    edit  = {"slug": "s-edit", "after": ["s-new"], "motivation": "x", "scope": {"included": ["x"]},
             "work_items": [
                 {"id": "api", "title": "api", "oracle": {"type": "unit"}},
                 {"id": "doc", "title": "doc", "depends_on": ["api"], "oracle": {"type": "unit"}}]}
    deln  = {"slug": "s-del",  "after": ["s-edit"], "motivation": "x", "scope": {"included": ["x"]},
             "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}
    binders = [new, edit, deln]

    facts = {"default_branch": "main", "binders": {
        "s-new":  {"integration_exists": False,
                   "items": {"a": {"done": True, "done_in_default": True}}},
        "s-edit": {"integration_exists": True, "items": {
            "api": {"done": True, "done_in_default": False},
            "doc": {"branch": False}}},
        "s-del":  {"integration_exists": False, "items": {"a": {}}},
    }}
    st = derive_state(binders, facts)

    checks = [
        ("order is topo-sorted", st["order"] == ["s-new", "s-edit", "s-del"]),
        ("new is merged",  st["binders"][0]["status"] == "merged"),
        ("edit is in-flight", st["binders"][1]["status"] == "in_flight"),
        ("del is not-started", st["binders"][2]["status"] == "not_started"),
        ("doc is ready (api done)", any(d["id"] == "doc" and d["status"] == "ready"
                                        for d in st["binders"][1]["items"]["detail"])),
        ("next action resumes edit", st["next_action"]["command"] == "hatch-deliver s-edit"),
        ("no warnings/errors", st["warnings"] == [] and st["errors"] == []),
        ("del not yet is_next (edit unmerged)", st["binders"][2]["is_next"] is False),
    ]

    dangle = derive_state([{"slug": "z", "after": ["ghost"], "motivation": "x",
                            "scope": {"included": ["x"]},
                            "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}],
                          {"default_branch": "main", "binders": {"z": {"items": {"a": {}}}}})
    checks.append(("dangling after warns", len(dangle["warnings"]) == 1 and dangle["errors"] == []))

    cyc = derive_state(
        [{"slug": "ca", "after": ["cb"], "motivation": "x", "scope": {"included": ["x"]},
          "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]},
         {"slug": "cb", "after": ["ca"], "motivation": "x", "scope": {"included": ["x"]},
          "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}],
        {"default_branch": "main", "binders": {"ca": {"items": {"a": {}}},
                                               "cb": {"items": {"a": {}}}}})
    checks.append(("cycle -> order None + error", cyc["order"] is None and len(cyc["errors"]) == 1))

    # archived predecessors: an `after` naming a delivered (archived) binder is satisfied —
    # no warning, and the successor is next. A live binder wins over an archived namesake.
    arch = derive_state(
        [{"slug": "w", "after": ["shipped"], "motivation": "x", "scope": {"included": ["x"]},
          "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}],
        {"default_branch": "main", "binders": {"w": {"items": {"a": {}}}}},
        archived=frozenset({"shipped"}))
    checks.append(("after -> archived binder is satisfied (no warning, is_next)",
                   arch["warnings"] == [] and arch["binders"][0]["is_next"] is True))
    dup = derive_state(
        [{"slug": "dup", "motivation": "x", "scope": {"included": ["x"]},
          "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]},
         {"slug": "x", "after": ["dup"], "motivation": "x", "scope": {"included": ["x"]},
          "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}],
        {"default_branch": "main", "binders": {"dup": {"items": {"a": {}}},
                                               "x": {"items": {"a": {}}}}},
        archived=frozenset({"dup"}))
    x_row = next(ob for ob in dup["binders"] if ob["slug"] == "x")
    checks.append(("live slug wins over an archived namesake (edge kept, x waits)",
                   x_row["after"] == ["dup"] and x_row["is_next"] is False))
    checks.append(("the shadowed archived namesake draws a warning",
                   len(dup["warnings"]) == 1 and "reuses the slug" in dup["warnings"][0]))

    # the calm end state (watch-shell): all merged or archived + clean derive -> done,
    # while every genuinely blocked derive keeps the blocked copy
    done_action = {"level": "done", "command": None, "human": DONE_HUMAN}
    all_merged = derive_state(
        [{"slug": "m1", "motivation": "x", "scope": {"included": ["x"]},
          "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}],
        {"default_branch": "main", "binders": {
            "m1": {"items": {"a": {"done": True, "done_in_default": True}}}}})
    checks.append(("all binders merged -> done, no command, the calm copy",
                   all_merged["next_action"] == done_action))
    all_archived = derive_state([], {"default_branch": "main", "binders": {}},
                                archived=frozenset({"shipped"}))
    checks.append(("zero live binders (all archived) -> the same calm done",
                   all_archived["next_action"] == done_action))
    checks.append(("genuinely blocked (cycle) derive is unchanged",
                   cyc["next_action"] == {"level": "blocked", "command": None,
                                          "human": BLOCKED_HUMAN}))
    warn_merged = derive_state(
        [{"slug": "wm", "after": ["ghost"], "motivation": "x", "scope": {"included": ["x"]},
          "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}}]}],
        {"default_branch": "main", "binders": {
            "wm": {"items": {"a": {"done": True, "done_in_default": True}}}}})
    checks.append(("all merged but a dangling-after warning -> still blocked, never done",
                   warn_merged["warnings"] != []
                   and warn_merged["next_action"]["level"] == "blocked"))
    empty = derive_state([], {"default_branch": "main", "binders": {}})["next_action"]
    checks.append(("no binders and no archive -> the empty state points at planning, "
                   "never at warnings that are not there",
                   empty == {"level": "empty", "command": "hatch-plan",
                             "human": EMPTY_HUMAN}
                   and "warnings" not in empty["human"]))

    # accepted-done is its own state (never a clean pass) and counts as complete
    one = {"slug": "w", "motivation": "x", "scope": {"included": ["x"]},
           "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"}},
                          {"id": "b", "title": "B", "depends_on": ["a"],
                           "oracle": {"type": "unit"}}]}
    acc = derive_state([one], {"default_branch": "main", "binders": {"w": {
        "integration_exists": True, "items": {
            "a": {"done": True, "accepted": True, "done_in_default": False},
            "b": {}}}}},
        recovery={"items": {"w": {"a": {"suspect": [], "waiver_reason": "why"}}}})
    a_row = acc["binders"][0]["items"]["detail"][0]
    b_row = acc["binders"][0]["items"]["detail"][1]
    checks.append(("accepted-done derives 'accepted' with the waiver reason, and "
                   "unblocks its dependents like done",
                   a_row == {"id": "a", "status": "accepted", "waiver_reason": "why"}
                   and acc["binders"][0]["items"]["accepted"] == 1
                   and acc["binders"][0]["items"]["done"] == 0
                   and b_row["status"] == "ready"
                   and "waived — why" in render_terminal(acc)))
    # a suspect done ref is not trusted: the item derives without it + a warning
    sus = derive_state([one], {"default_branch": "main", "binders": {"w": {
        "integration_exists": True, "items": {
            "a": {"done": True, "built": True, "done_in_default": False}, "b": {}}}}},
        recovery={"items": {"w": {"a": {"suspect": ["forged"], "waiver_reason": None}}}})
    checks.append(("a suspect done ref is ignored with a warning, and the built item "
                   "it hid resumes the merge queue",
                   sus["binders"][0]["items"]["detail"][0]["status"] == "built"
                   and any("suspect" in w and "forged" in w for w in sus["warnings"])
                   and sus["next_action"]["command"] == "hatch-deliver w"))
    land = derive_state([one], {"default_branch": "main", "binders": {"w": {
        "integration_exists": True, "items": {
            "a": {"done": True, "done_in_default": False},
            "b": {"done": True, "done_in_default": False}}}}})
    checks.append(("every item merged on integration, not on main -> the human "
                   "landing decision, with no command",
                   land["next_action"] == {"level": "landing", "command": None,
                                           "human": LANDING_HUMAN.format(slug="w")}))
    bad = derive_state([], {"default_branch": "main", "binders": {}},
                       load_errors=[_load_error(Path("x/b.json"), "not a JSON object")])
    checks.append(("a binder load error is an error and names the file in the next action",
                   bad["errors"] and bad["next_action"]["level"] == "error"
                   and "x/b.json" in bad["next_action"]["human"]))
    checks.append(("shape check: a non-object and an id-less item are errors, a "
                   "minimal binder is not",
                   _binder_shape_error(["x"]) is not None
                   and _binder_shape_error({"slug": "s", "work_items": [{}]}) is not None
                   and _binder_shape_error({"slug": "s", "work_items": []}) is None))

    # surface-on-default hint (finding 21): a not_started binder whose declared
    # touches all already exist on the default branch is flagged, and the next
    # action points at archiving rather than a re-delivery that can only whiff.
    surf_binder = {"slug": "landed-elsewhere", "motivation": "x",
                   "scope": {"included": ["x"]},
                   "work_items": [{"id": "a", "title": "A", "oracle": {"type": "unit"},
                                   "touches": ["app/models.py", "app/views/*.py"]}]}
    present = frozenset({"app/models.py", "app/views/list.py"})
    absent = frozenset({"app/models.py"})
    checks.append(("surface present: every touch on default -> True",
                   _binder_surface_on_default(surf_binder, present) is True))
    checks.append(("surface absent: a glob with no match -> False",
                   _binder_surface_on_default(surf_binder, absent) is False))
    checks.append(("surface unknown when the tree is None",
                   _binder_surface_on_default(surf_binder, None) is None))
    checks.append(("no declared touches -> unknown (never claim delivered)",
                   _binder_surface_on_default(
                       {"slug": "z", "work_items": [{"id": "a"}]}, present) is None))
    checks.append(("bare directory touch present when a file sits under it",
                   _binder_surface_on_default(
                       {"work_items": [{"touches": ["app/views"]}]}, present) is True))
    surf_facts = {"default_branch": "main",
                  "binders": {"landed-elsewhere": {"items": {"a": {}}}}}
    surf_state = derive_state([surf_binder], surf_facts,
                              surface_on_default={"landed-elsewhere": True})
    surf_row = surf_state["binders"][0]
    checks.append(("not_started binder is flagged surface_on_default and stays is_next",
                   surf_row["status"] == "not_started"
                   and surf_row.get("surface_on_default") is True
                   and surf_row["is_next"] is True))
    surf_na = surf_state["next_action"]
    checks.append(("next action redirects to archive, never re-deliver",
                   "hatch-deliver" not in (surf_na["command"] or "")
                   and "archive" in surf_na["command"]
                   and "already exists on main" in surf_na["human"]
                   and surf_na["level"] == "review"))
    plain_state = derive_state([surf_binder], surf_facts)
    checks.append(("no surface signal -> unchanged 'start' recommendation",
                   plain_state["next_action"]["command"] == "hatch-deliver landed-elsewhere"
                   and plain_state["binders"][0].get("surface_on_default") is None))
    # default_branch_paths against a real repo: lists tracked files, None on a
    # missing branch — the read-only tree query the hint is built on.
    import tempfile as _tf
    with _tf.TemporaryDirectory() as _td:
        _r = Path(_td)
        _mk = lambda *a: subprocess.run(["git", *a], cwd=str(_r),
                                        capture_output=True, text=True, check=True, encoding="utf-8")
        _mk("init", "-q", "-b", "main", ".")
        _mk("config", "user.email", "t@example.com")
        _mk("config", "user.name", "t")
        (_r / "app").mkdir()
        (_r / "app" / "models.py").write_text("x", encoding="utf-8")
        (_r / "app" / "list.py").write_text("y", encoding="utf-8")
        _mk("add", "-A"); _mk("commit", "-q", "-m", "c")
        _old = os.getcwd(); os.chdir(_r)
        try:
            tracked = default_branch_paths("main")
            missing = default_branch_paths("no-such-branch")
        finally:
            os.chdir(_old)
    checks.append(("default_branch_paths lists the branch's tracked files",
                   tracked is not None and "app/models.py" in tracked
                   and "app/list.py" in tracked))
    checks.append(("default_branch_paths returns None for a missing branch",
                   missing is None))

    done_foot = render_footer(all_merged, "m1")
    done_term = render_terminal(all_archived)
    checks.append(("footer and terminal render the done state calmly",
                   done_foot == f"m1 1/1 · complete  ▶ {DONE_HUMAN}"
                   and done_term.splitlines()[-1] == f"▶ {DONE_HUMAN}"
                   and "warning:" not in done_term and "error:" not in done_term
                   and "hatch-deliver" not in done_term))

    # the renderers must not raise on a real state
    try:
        render_terminal(st); render_footer(st, "s-edit"); rendered = True
    except Exception as exc:                                   # noqa: BLE001
        rendered = False; print(f"render raised: {exc}")
    checks.append(("renderers run", rendered))

    checks.extend(item_state_checks("status", _status_item_state))
    checks.extend(_item_state_seam_checks())
    checks.extend(_halt_row_checks())
    checks.extend(_halt_call_checks())
    checks.extend(_halt_parser_checks())
    checks.extend(_git_facts_self_test_checks())
    checks.extend(_watch_self_test_checks())

    failures = 0
    for name, ok in checks:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        failures += 0 if ok else 1
    print(f"\n{len(checks) - failures}/{len(checks)} checks passed")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--footer", action="store_true")
    ap.add_argument("--binder", type=str)
    ap.add_argument("--watch", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _run_self_test()
    if args.watch:
        if _opted_in_root() is not None:
            _fire_ensure()  # revive first; watch_report's re-probes cover the bind
        _print_line(watch_report())
        return 0
    _fire_ensure()  # every real engine touch revives the watch hub — fail-open
    binders, load_errors = load_binders()
    archived = frozenset(b["slug"] for b in load_archived_binders())
    default_branch = _default_branch()
    git_facts = gather_git_facts(binders, default_branch)
    surface = _surface_hints(binders, git_facts, archived, default_branch)
    recovery = gather_recovery_facts(binders, git_facts, default_branch, archived)
    state = derive_state(binders, git_facts, archived, surface_on_default=surface,
                         recovery=recovery, load_errors=load_errors)
    if args.json:
        print(json.dumps(state, indent=2))  # never altered by the watch surface
    else:
        if args.footer:
            print(render_footer(state, args.binder or ""))  # one line, always
        else:
            nudge = watch_line()
            out = render_terminal(state)
            print(out if nudge is None else f"{out}\n{nudge}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
