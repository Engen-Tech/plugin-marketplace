# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch quick repair: build a successor binder from a predecessor and a short change list.

  make_successor.py --predecessor <slug> [--changes <file.json>] [--slug <new>] [--repo <dir>]
  make_successor.py --summary <binder path> [--repo <dir>]   # read-only; the review card runs it
  make_successor.py --self-test

The successor is the predecessor's committed plan (as its integration tip holds it) with
`slug` set, `supersedes: {slug, carried}` added, and the change list applied. It is
written to .hatch/binders/<new>.json and validated; it is never staged or committed.

Change list: {"items": {"<id>": {<whole replacement item>}}, "binder": {<field>: ...}}.
Items are keyed by id, so an id change shows (key != item id) and is refused. Binder
fields are limited to title, summary, motivation, scope, design_facts and token_manifest.
The file must not sit under .hatch/binders/, where every reader globs *.json.

Carried items are decided by deliver_preflight.check_supersedes itself, run on the draft:
the candidates are the predecessor's done items plus what it carried, and a successor
that preflight would refuse is never written. Every item not carried is copied (or
replaced), and its acceptance and safety tries restart, because the attempts ledger is
kept per slug and a slug that already has a ledger folder is refused.

Default slug: strip a trailing -r<N> from the predecessor (N = 1 when absent) and append
-r<N+1>. N comes from the predecessor's slug only; a taken slug is refused.

Exit codes: 0 written and valid (or, with --summary, printed); 1 self-test failure;
2 usage error; 3 refused, nothing written.
"""
from __future__ import annotations

import argparse
import contextlib
import difflib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path

# preflight's carry rules and the supersedes-chain walk, imported by path (no __init__.py
# in hatch-deliver/scripts). The import writes no bytecode: an installed plugin is a git
# clone that a __pycache__ dirties. No ImportError fallback: without the carry rules this
# script must not write a plan.
_DELIVER_DIR = str((Path(__file__).resolve().parent / ".." / ".." / "hatch-deliver" / "scripts").resolve())
if _DELIVER_DIR not in sys.path:
    sys.path.insert(0, _DELIVER_DIR)
_dwb, sys.dont_write_bytecode = sys.dont_write_bytecode, True
try:
    import deliver_preflight  # noqa: E402
    import supersedes_chain  # noqa: E402
finally:
    sys.dont_write_bytecode = _dwb

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
BINDER_FIELDS = ("title", "summary", "motivation", "scope", "design_facts", "token_manifest")
GIT_TIMEOUT = 30


class Usage(Exception):
    """Exit 2."""


class Refused(Exception):
    """Exit 3; nothing is left on disk."""


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                              encoding="utf-8", timeout=GIT_TIMEOUT)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", "git timed out")


def default_slug(pred: str) -> str:
    m = re.fullmatch(r"(.+)-r([0-9]+)", pred)
    base, n = (m.group(1), int(m.group(2))) if m else (pred, 1)
    return f"{base}-r{n + 1}"


def _shown(value: object) -> str:
    """JSON text with every control and format character escaped, so it stays on one line
    and a tab never reads as a space."""
    return "".join(f"\\u{ord(c):04x}" if unicodedata.category(c) in ("Cc", "Cf") else c
                   for c in json.dumps(value, ensure_ascii=False))


def command_change(was: object, now: object, full: int = 2000, context: int = 40) -> list[str]:
    """Every difference between two commands: both in full when either is at most `full`
    characters, else each differing region with `context` characters around it."""
    def text(v: object) -> str:  # a missing command and an empty one are named, not left blank
        if v is None or v == "":
            return "(absent)" if v is None else "(empty)"
        return _shown(v)[1:-1] if isinstance(v, str) else _shown(v)
    a, b = text(was), text(now)
    if min(len(a), len(b)) <= full:
        return [f"    command was: {a}", f"    command now: {b}"]
    groups = list(difflib.SequenceMatcher(None, a, b, autojunk=False).get_grouped_opcodes(context))
    out = [f"    command: {len(groups)} differing region{'' if len(groups) == 1 else 's'} (both over {full:,} characters)"]
    for n, g in enumerate(groups, 1):
        (i1, j1), (i2, j2) = (g[0][1], g[0][3]), (g[-1][2], g[-1][4])
        for side, t, lo, hi in (("was", a, i1, i2), ("now", b, j1, j2)):
            out.append(f"    region {n} {side}: " + ("…" if lo else "") + t[lo:hi] + ("…" if hi < len(t) else ""))
    return out


def ledger_dir(repo: Path, slug: str) -> Path:
    """The path gate_attempts.py computes: <absolute git common dir>/hatch/attempts/<slug>."""
    common = _git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip()
    if not common:
        raise Usage(f"--repo {repo} is not a Git working tree")
    return Path(common) / "hatch" / "attempts" / slug


def _items(doc: dict | None) -> dict:
    return {it.get("id"): it for it in (doc or {}).get("work_items", []) if isinstance(it, dict)}


def _refs(repo: Path, slug: str, kind: str) -> list[str]:
    """Item ids holding refs/hatch/<slug>/item-<id>/<kind>."""
    return [name.split("/")[-2][len("item-"):] for name in
            deliver_preflight.list_prefixed_refs(repo, f"refs/hatch/{slug}/")
            if name.endswith(f"/{kind}") and name.split("/")[-2].startswith("item-")]


def predecessor_plan(repo: Path, pred: str) -> dict | None:
    tip = deliver_preflight.ref_target(repo, f"hatch/{pred}/integration")
    return supersedes_chain.committed_plan(lambda *a: _git(repo, *a), pred, tip) if tip else None


def load_changes(path: Path | None, repo: Path) -> tuple[dict, dict]:
    if path is None:
        return {}, {}
    binders = (repo / ".hatch" / "binders").resolve()
    if binders in path.resolve().parents:
        raise Usage(f"the change list {path} sits under .hatch/binders/, where every reader "
                    "globs *.json; keep it elsewhere in the project")
    try:
        doc = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as e:
        raise Usage(f"cannot read the change list {path}: {e}")
    if not isinstance(doc, dict) or set(doc) - {"items", "binder"}:
        raise Usage("a change list is a JSON object with the keys 'items' and 'binder' only")
    items, fields = doc.get("items") or {}, doc.get("binder") or {}
    if not isinstance(items, dict) or not isinstance(fields, dict) \
            or not all(isinstance(v, dict) for v in items.values()):
        raise Usage("'items' maps an id to a whole work item; 'binder' maps a field to its value")
    return items, fields


def check_slug_free(repo: Path, new: str) -> None:
    binders = repo / ".hatch" / "binders"
    used = [str(p) for p in (binders / f"{new}.json", binders / "archive" / f"{new}.json") if p.exists()]
    if deliver_preflight.ref_target(repo, f"hatch/{new}/integration"):
        used.append(f"hatch/{new}/integration")
    used += sorted(deliver_preflight.list_prefixed_refs(repo, f"refs/hatch/{new}/"))
    if ledger_dir(repo, new).exists():
        used.append(f"the attempts ledger folder {ledger_dir(repo, new)}")
    if used:
        raise Refused(f"the slug '{new}' is in use ({'; '.join(used)}); a reused ledger would keep "
                      "the old counts, so tries would not restart. Name another with --slug")


def build(repo: Path, pred: str, changes: Path | None, slug: str | None) -> str:
    new = slug or default_slug(pred)
    for s in (pred, new):
        if not SLUG.fullmatch(s):
            raise Usage(f"'{s}' is not a slug (lowercase letters, digits and hyphens)")
    items, fields = load_changes(changes, repo)
    binders = repo / ".hatch" / "binders"
    integration = f"hatch/{pred}/integration"
    tip = deliver_preflight.ref_target(repo, integration)
    if (binders / "archive" / f"{pred}.json").exists() or (tip and _git(
            repo, "cat-file", "-e", f"{tip}:.hatch/binders/archive/{pred}.json").returncode == 0):
        raise Refused(f"'{pred}' is in .hatch/binders/archive/: it was delivered")
    for live in sorted(binders.glob("*.json")):
        try:
            doc = json.loads(live.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise Refused(f"cannot read {live} to tell whether it supersedes '{pred}': {e}")
        sup = doc.get("supersedes") if isinstance(doc, dict) else None
        if isinstance(sup, dict) and sup.get("slug") == pred:
            draft = _git(repo, "ls-files", "--error-unmatch", str(live)).returncode != 0
            raise Refused(f"'{pred}' is already superseded by {live}" + (
                ", an uncommitted draft: delete it to build again, or commit it" if draft else
                "; a repair names the last binder in the line, so build from that one"))
    if tip is None:
        raise Refused(f"no {integration}: nothing ran, so there is nothing to carry or reset")
    check_slug_free(repo, new)
    plan = predecessor_plan(repo, pred)
    if plan is None:
        raise Refused(f"no committed binder for '{pred}' on {integration}")
    old = _items(plan)
    done, psup = set(_refs(repo, pred, "done")), plan.get("supersedes")
    pcarried = set(psup.get("carried") or []) if isinstance(psup, dict) else set()
    carried = [i for i in old if i in done or i in pcarried]
    if not carried:
        raise Refused(f"'{pred}' has no delivered item to carry, and a successor must carry one. "
                      "Use Clear and stop (on Pi it also deletes the ledger, which restarts the tries), "
                      "then withdraw the binder: docs/how-to/binder-repair.md")
    if extra := sorted(set(fields) - set(BINDER_FIELDS)):
        raise Refused(f"binder field(s) {', '.join(extra)} are outside quick repair "
                      f"({', '.join(BINDER_FIELDS)}); take the full hatch-plan route")
    for key, item in items.items():
        if key in carried:
            raise Refused(f"'{key}' is carried (delivered and copied unchanged); it cannot be changed")
        if item.get("id") != key:
            raise Refused(f"the change for '{key}' has id '{item.get('id')}'; renaming an item is a full plan")
        if key not in old:
            raise Refused(f"'{key}' is not an item of '{pred}'; adding an item is a full plan")
    draft = dict(plan, slug=new, **fields)
    draft["work_items"] = [items.get(i, it) for i, it in old.items()]
    draft["supersedes"] = {"slug": pred, "carried": carried}
    report, _ = deliver_preflight.check_supersedes(repo, draft, f"hatch/{new}/integration", None)
    if not report["ok"]:
        raise Refused("preflight would stop this successor:\n" + "\n".join(_findings(report)))
    path = binders / f"{new}.json"
    try:  # nothing outlives a refusal or a crash; a host kill runs no handler (the rerun names the draft)
        path.write_text(json.dumps(draft, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        try:
            proc = subprocess.run([sys.executable, str(deliver_preflight.VALIDATE_BINDER), "--binder", str(path)],
                                  capture_output=True, text=True, encoding="utf-8", errors="replace",
                                  timeout=deliver_preflight.SCRIPT_TIMEOUT)
        except subprocess.TimeoutExpired:
            raise Refused(f"validate_binder.py did not finish in {deliver_preflight.SCRIPT_TIMEOUT} s")
        output = (proc.stdout + proc.stderr).strip()
        if proc.returncode != 0:
            raise Refused(f"the successor failed validation and was deleted:\n{output}")
        return f"Wrote {path}\n{output}\n\n{summary(repo, draft, report)}"
    except BaseException:
        path.unlink(missing_ok=True)
        raise


def _findings(report: dict) -> list[str]:
    out = [f"  {f}" for f in report["findings"]]
    for iid, rec in report["carried"].items():
        if not rec["ok"]:
            hop = rec.get("delivered_by", report["predecessor"])
            why = rec.get("finding") or "; ".join(
                w for w, bad in ((f"check_item_provenance exit {rec.get('checker_exit')}",
                                  rec.get("checker_exit") != 0),
                                 (f"not first-parent reachable on hatch/{hop}/integration",
                                  not rec.get("first_parent_reachable"))) if bad)
            out.append(f"  carried '{iid}': refs/hatch/{hop}/item-{iid}/done: {why}")
            if rec.get("checker_output"):
                out.append("    checker: " + rec["checker_output"].replace("\n", "\n    "))
    return out


def _row(iid: str, was: dict, now: dict) -> list[str]:
    """One changed item's strictness rows: before and after, assertions verbatim."""
    wo, no = was.get("oracle") or {}, now.get("oracle") or {}
    if no.get("opt_out") or wo.get("opt_out"):
        if wo == no:
            head = [f"  {iid}: opted out, unchanged"]
        else:
            head = [f"  {iid}: " + (f"opted out ({_shown(no.get('reason'))})" if no.get("opt_out") else
                                    "opt-out removed"), f"    was: {_shown(wo)}"]
    else:
        wa, na = (Counter(map(_shown, o.get("assertions") or [])) for o in (wo, no))
        removed, added = list((wa - na).elements()), list((na - wa).elements())
        kept = na.total() - len(added)
        head = [f"  {iid}: {kept} assertion{'' if kept == 1 else 's'} kept, {len(removed)} removed or "
                f"reworded, {len(added)} added; command "
                f"{'changed' if wo.get('command') != no.get('command') else 'unchanged'}; marker "
                f"{'changed' if wo.get('expect') != no.get('expect') else 'unchanged'}"]
        head += [f"    removed or reworded: {a}" for a in removed] + [f"    added: {a}" for a in added]
        if wo.get("command") != no.get("command"):
            head += command_change(wo.get("command"), no.get("command"))
        for key, label in (("cwd", "cwd"), ("expect", "marker"), ("type", "oracle type")):
            if wo.get(key) != no.get(key):
                head.append(f"    {label} was: {_shown(wo.get(key))}; now: {_shown(no.get(key))}")
    for key in ("visual_check_waiver", "design_reference", "contract", "surface"):
        if was.get(key) != now.get(key):
            head.append(f"    {key} was: {_shown(was.get(key))}; now: {_shown(now.get(key))}")
    return head


def summary(repo: Path, doc: dict, report: dict | None = None) -> str:
    sup = doc.get("supersedes")
    if not isinstance(sup, dict) or not isinstance(sup.get("slug"), str):
        raise Refused("this binder has no supersedes; a change summary is for a successor")
    pred, new = sup["slug"], doc.get("slug")
    plan = predecessor_plan(repo, pred)
    if plan is None:
        raise Refused(f"no committed binder for '{pred}' on hatch/{pred}/integration")
    if report is None:
        report, _ = deliver_preflight.check_supersedes(
            repo, doc, f"hatch/{new}/integration",
            deliver_preflight.ref_target(repo, f"hatch/{new}/integration"))
    old, cur = _items(plan), _items(doc)
    claimed = [c for c in sup.get("carried") or [] if c in cur]
    carried = [c for c in claimed if report["carried"].get(c, {}).get("ok")]
    rest = [i for i in cur if i not in carried]
    changed = [i for i in rest if i in old and old[i] != cur[i]]
    named = lambda ids: ", ".join(ids) or "none"  # noqa: E731
    fields = sorted({k for k in set(plan) | set(doc) if k not in ("slug", "supersedes", "work_items")
                     and plan.get(k) != doc.get(k)})
    lines = [f"Change summary: {new} against {pred}",
             f"Carried, delivered and copied unchanged: {named(carried)}",
             "Changed: " + named([f"{i} ({', '.join(sorted(k for k in set(old[i]) | set(cur[i]) if old[i].get(k) != cur[i].get(k)))})"
                                  for i in changed])
             + f". Copied unchanged: {named([i for i in rest if old.get(i) == cur[i]])}"]
    if unproven := [c for c in claimed if c not in carried]:
        lines.insert(2, f"Claimed carried, not proven: {named(unproven)} (see 'Preflight would stop' below)")
    if added := [i for i in rest if i not in old]:
        lines.append(f"Added: {named(added)}")
    if dropped := [i for i in old if i not in cur]:
        lines.append(f"Not copied from {pred}: {named(dropped)}")
    lines.append(f"Binder fields changed: {named(fields)}")
    ledger = ledger_dir(repo, new)
    tries = (f"Tries: {new} already has a ledger at {ledger}, so its counts go on. " if ledger.exists() else
             f"Tries: every item not carried starts its acceptance and safety tries afresh under {new}; ")
    halted = [i for i in old if i in set(_refs(repo, pred, "halt"))]
    lines.append(tries + f"{pred} keeps its own ledger." + (f" Halted in {pred}: {named(halted)}." if halted else ""))
    lines += ["", f"Strictness changes against {pred}:"]
    lines += [r for i in changed for r in _row(i, old[i], cur[i])] or ["  No item changed."]
    if not report["ok"]:
        lines += ["", "Preflight would stop this successor:", *_findings(report)]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="make_successor.py", description=__doc__.split("\n\n")[0])
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--predecessor", help="slug of the binder to repair")
    mode.add_argument("--summary", type=Path, help="print the change summary of a successor binder")
    mode.add_argument("--self-test", action="store_true")
    ap.add_argument("--changes", type=Path, help="the change list (JSON)")
    ap.add_argument("--slug", help="the successor's slug (default: the next -r<N>)")
    ap.add_argument("--repo", type=Path, default=Path("."))
    args = ap.parse_args(argv)
    if args.self_test:
        return _run_self_test()
    with contextlib.suppress(AttributeError, ValueError):  # a Windows code page cannot crash the summary
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", newline="\n")
    os.environ["PYTHONIOENCODING"] = "utf-8"  # the validator and checkers print what is read as UTF-8
    repo = args.repo.resolve()
    try:
        if args.summary is not None:
            try:
                doc = json.loads(args.summary.read_text(encoding="utf-8"))
            except (OSError, ValueError) as e:
                raise Refused(f"cannot read {args.summary}: {e}")
            print(summary(repo, doc if isinstance(doc, dict) else {}))
        else:
            print(build(repo, args.predecessor, args.changes, args.slug))
        return 0
    except Usage as e:
        print(f"make_successor: {e}")
        return 2
    except Refused as e:
        print(f"make_successor: refused, nothing written: {e}")
        return 3


# --- Self-test -------------------------------------------------------------------

def _run_self_test() -> int:
    results: list[bool] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f"\n{detail}" if detail and not ok else ""))

    tmp = Path(tempfile.mkdtemp(prefix="make_successor_selftest_"))

    def git(repo: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(repo), *args], capture_output=True,
                              text=True, encoding="utf-8")

    def item(iid: str, **extra) -> dict:
        doc = {"id": iid, "title": iid, "summary": f"{iid} work",
               "oracle": {"type": "unit", "assertions": [f"{iid} one", f"{iid} two"],
                          "command": f"pytest tests/test_{iid}.py", "expect": "passed"}}
        doc.update(extra)
        return doc

    def fixture(name: str, done: tuple[str, ...] = ("alpha",), integration: bool = True,
                **beta: object) -> Path:
        """Binder `s` (alpha, then beta) committed on main; alpha merged with its marker and
        given a done ref on hatch/s/integration; beta halted there."""
        r = tmp / name
        r.mkdir()
        git(r, "init", "-q", "-b", "main")
        git(r, "config", "user.email", "t@example.invalid")
        git(r, "config", "user.name", "hatch self-test")
        git(r, "config", "commit.gpgsign", "false")
        doc = {"slug": "s", "title": "t", "summary": "s", "motivation": "m",
               "scope": {"included": ["x"]},
               "work_items": [item("alpha"), item("beta", depends_on=["alpha"], **beta)]}
        (r / ".hatch" / "binders").mkdir(parents=True)
        (r / ".hatch" / "binders" / "s.json").write_text(json.dumps(doc, indent=2) + "\n",
                                                         encoding="utf-8")
        git(r, "add", "-A")
        git(r, "commit", "-q", "-m", "plan s")
        if integration:
            git(r, "checkout", "-q", "-b", "hatch/s/integration")
            for iid in done:
                git(r, "checkout", "-q", "-b", f"hatch/s/item-{iid}")
                git(r, "commit", "-q", "--allow-empty", "-m", f"the work [hatch:item-{iid}]")
                git(r, "checkout", "-q", "hatch/s/integration")
                git(r, "merge", "-q", "--no-ff", f"hatch/s/item-{iid}",
                    "-m", f"hatch: merge item-{iid} [hatch:item-{iid}]")
                git(r, "update-ref", f"refs/hatch/s/item-{iid}/done", "HEAD")
            git(r, "update-ref", "refs/hatch/s/item-beta/halt", "HEAD")
            git(r, "checkout", "-q", "main")
        return r

    def run(*argv: str) -> tuple[int, str]:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            try:
                code = main(list(argv))
            except SystemExit as e:  # argparse usage errors
                code = e.code if isinstance(e.code, int) else 2
            except Exception as e:  # a crash is a failed case, not a dead self-test
                code = -1
                print(f"crashed: {e!r}")
        return code, buf.getvalue()

    def files(r: Path) -> list[str]:
        return sorted(str(p.relative_to(r)) for p in (r / ".hatch").rglob("*.json"))

    def load(path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}

    def refused(name: str, r: Path, argv: tuple[str, ...], *needles: str) -> None:
        before = files(r)
        code, out = run(*argv, "--repo", str(r))
        check(f"refused, nothing written: {name}",
              code == 3 and files(r) == before and all(n in out for n in needles),
              f"exit {code}\n{out}")

    try:
        check("default slug: x gives x-r2, x-r3 gives x-r4",
              default_slug("x") == "x-r2" and default_slug("x-r3") == "x-r4"
              and default_slug("console-log-stream") == "console-log-stream-r2")

        # --- carry by provenance; no change list is reset tries -----------------------
        r = fixture("carry")
        pred = load(r / ".hatch/binders/s.json")
        code, out = run("--predecessor", "s", "--repo", str(r))
        path = r / ".hatch/binders/s-r2.json"
        doc = load(path)
        check("carry by provenance: done alpha is carried, halted beta is copied unchanged",
              code == 0 and doc.get("supersedes") == {"slug": "s", "carried": ["alpha"]}
              and doc.get("work_items") == pred["work_items"]
              and "Carried, delivered and copied unchanged: alpha" in out, f"exit {code}\n{out}")
        check("reset tries: every other field copied, 'No item changed', tries afresh, halted named",
              doc.get("slug") == "s-r2"
              and {k: v for k, v in doc.items() if k not in ("slug", "supersedes")}
              == {k: v for k, v in pred.items() if k != "slug"}
              and "No item changed." in out and "afresh under s-r2" in out
              and "Halted in s: beta." in out and "VALID" in out, out)
        raw = path.read_bytes() if path.is_file() else b""
        check("the successor is written UTF-8 with LF line ends and indent 2",
              raw.endswith(b"}\n") and b"\r" not in raw and b'\n  "slug": "s-r2"' in raw)
        code2, summary = run("--summary", str(path), "--repo", str(r))
        check("--summary on the written file prints the same summary the build printed",
              code2 == 0 and summary.strip() != "" and summary.strip() in out, summary)

        # --- carried again through a chain: r3 carries what r2 carried from r1 --------
        git(r, "add", "-A")
        git(r, "commit", "-q", "-m", "plan s-r2")
        git(r, "checkout", "-q", "-b", "hatch/s-r2/integration", "hatch/s/integration")
        git(r, "merge", "-q", "--no-ff", "main", "-m", "s-r2 starts from s")
        git(r, "checkout", "-q", "main")
        code, out = run("--predecessor", "s-r2", "--repo", str(r))
        doc = load(r / ".hatch/binders/s-r3.json")
        check("carried through a chain: s-r3 carries alpha, which s-r2 carried from s",
              code == 0 and doc.get("supersedes") == {"slug": "s-r2", "carried": ["alpha"]},
              f"exit {code}\n{out}")
        refused("predecessor already superseded by a live binder", r,
                ("--predecessor", "s"), "s-r2")

        # --- forged done ref: not carried, refused, named ------------------------------
        r = fixture("forged", done=())
        git(r, "checkout", "-q", "-b", "hatch/s/item-alpha", "hatch/s/integration")
        git(r, "commit", "-q", "--allow-empty", "-m", "the work [hatch:item-alpha]")
        git(r, "checkout", "-q", "-b", "side")
        git(r, "commit", "-q", "--allow-empty", "-m", "hatch: forged merge [hatch:item-alpha]")
        git(r, "update-ref", "refs/hatch/s/item-alpha/done", "HEAD")
        git(r, "checkout", "-q", "main")
        refused("a forged done ref off the first-parent chain is not carried", r,
                ("--predecessor", "s"), "refs/hatch/s/item-alpha/done")

        # --- change list applied ----------------------------------------------------
        r = fixture("change")
        beta = item("beta", depends_on=["alpha"], contract="the fixed contract")
        beta["oracle"] = {"type": "unit", "assertions": ["beta one", "beta three"],
                          "command": "pytest tests/test_beta.py -k fixed", "expect": "passed"}
        changes = r / "changes.json"
        changes.write_text(json.dumps({"items": {"beta": beta},
                                       "binder": {"design_facts": {"source": None}}}),
                           encoding="utf-8")
        code, out = run("--predecessor", "s", "--changes", str(changes), "--repo", str(r))
        doc = load(r / ".hatch/binders/s-r2.json")
        got_beta = [i for i in doc.get("work_items", []) if i.get("id") == "beta"]
        check("change list applied: beta replaced whole, design_facts set",
              code == 0 and got_beta == [beta] and doc.get("design_facts") == {"source": None},
              f"exit {code}\n{out}")
        check("change summary names the changed fields and the strictness changes word for word",
              "Changed: beta (contract, oracle). Copied unchanged: none" in out
              and "Binder fields changed: design_facts" in out
              and "beta: 1 assertion kept, 1 removed or reworded, 1 added; command changed; "
                  "marker unchanged" in out
              and '    removed or reworded: "beta two"' in out
              and '    added: "beta three"' in out
              and '    contract was: null; now: "the fixed contract"' in out
              and "    command was: pytest tests/test_beta.py\n" in out
              and "    command now: pytest tests/test_beta.py -k fixed" in out, out)

        # --- the strictness rows show what differs, never two equal lines ------------------
        tail = " && ".join(f"node check{i}.mjs --flag-{i}" for i in range(12))
        oracle = {"type": "unit", "assertions": ["x", "x"], "command": tail, "expect": "ok"}
        rows = _row("b", {"oracle": dict(oracle, command="npm run lint && " + tail)},
                    {"oracle": oracle})
        was = [x for x in rows if x.startswith("    command was: ")]
        now = [x for x in rows if x.startswith("    command now: ")]
        check("a command changed outside its last 140 characters shows the differing part",
              len(was) == len(now) == 1 and was[0][16:] != now[0][16:] and "npm run lint" in was[0],
              "\n".join(rows))
        rows = _row("b", {"oracle": dict(oracle, command="a\tb")}, {"oracle": dict(oracle, command="a b")})
        check("a tab replaced by a space still shows two different lines",
              len({x[16:] for x in rows if x.startswith("    command ")}) == 2, "\n".join(rows))
        rows = _row("b", {"oracle": oracle}, {"oracle": dict(oracle, assertions=["x"], cwd="sub")})
        check("removing one of two equal assertions shows it; cwd before and after as JSON",
              '    removed or reworded: "x"' in rows and '    cwd was: null; now: "sub"' in rows,
              "\n".join(rows))
        rows = _row("b", {"oracle": oracle}, {"oracle": {"opt_out": True, "reason": "r\n  fake: line"}})
        check("an opt-out reason with a newline stays on one line",
              rows[0] == '  b: opted out ("r\\n  fake: line")' and all(x.startswith("  ") for x in rows),
              "\n".join(rows))
        long = " && ".join(f"node check{i}.mjs --flag-{i}" for i in range(120))
        rows = _row("b", {"oracle": dict(oracle, command=long)},
                    {"oracle": dict(oracle, command="npm run lint && " + long + " && echo final")})
        text = "\n".join(rows)
        check("a long command edited at its start and its end shows both edits and counts them",
              "npm run lint" in text and "echo final" in text and "2 differing regions" in text, text)
        mid = " && ".join(f"node check{i}.mjs" for i in range(40))
        rows = _row("b", {"oracle": dict(oracle, command="A " + mid + " Z")},
                    {"oracle": dict(oracle, command="B " + mid + " Y")})
        check("a command under 2,000 characters is shown in full on both sides",
              f"    command was: A {mid} Z" in rows and f"    command now: B {mid} Y" in rows,
              "\n".join(rows))
        rows = _row("b", {"oracle": dict(oracle, assertions=["safe ‮ reversed"])},
                    {"oracle": {"opt_out": True, "reason": "r"}})
        text = "\n".join(rows)
        check("a format character in the old oracle is escaped, not passed to the card",
              "‮" not in text and "\\u202e" in text, text)
        no_command = {k: v for k, v in oracle.items() if k != "command"}
        rows = _row("b", {"oracle": no_command}, {"oracle": dict(oracle, command="")})
        check("a missing command against an empty one says absent and empty",
              "    command was: (absent)" in rows and "    command now: (empty)" in rows,
              "\n".join(rows))

        # --- Windows code page: the summary is UTF-8, and no draft outlives a failure --------
        r = fixture("cp1252")
        changes = r / "changes.json"
        beta = item("beta", depends_on=["alpha"])
        beta["oracle"]["command"] = "pytest -k 'rows ≥ 3'"
        changes.write_text(json.dumps({"items": {"beta": beta}}), encoding="utf-8")
        env = {k: v for k, v in os.environ.items() if k != "PYTHONUTF8"}
        env.update(PYTHONIOENCODING="cp1252", PYTHONDONTWRITEBYTECODE="1")
        proc = subprocess.run([sys.executable, __file__, "--predecessor", "s", "--changes", str(changes),
                               "--repo", str(r)], capture_output=True, env=env, timeout=120)
        check("a cp1252 stdout gets the summary as UTF-8, with no crash",
              proc.returncode == 0 and "rows ≥ 3".encode("utf-8") in proc.stdout,
              proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace"))
        fake = tmp / "fake_validator.py"
        real_validator, real_timeout = deliver_preflight.VALIDATE_BINDER, deliver_preflight.SCRIPT_TIMEOUT
        try:
            deliver_preflight.VALIDATE_BINDER = fake
            fake.write_text("import sys; sys.stdout.buffer.write(b'VALID \\x97\\n')\n", encoding="utf-8")
            code, out = run("--predecessor", "s", "--repo", str(fixture("bad-bytes")))
            check("validator output that is not UTF-8 is shown, not a crash", code == 0, f"exit {code}\n{out}")
            fake.write_text("print('VALID \\u2265')\n", encoding="utf-8")
            saved = os.environ.get("PYTHONIOENCODING")
            os.environ["PYTHONIOENCODING"] = "cp1252"  # a parent on a Windows code page
            try:
                code, out = run("--predecessor", "s", "--repo", str(fixture("child-cp1252")))
            finally:
                os.environ.pop("PYTHONIOENCODING", None)
                if saved is not None:
                    os.environ["PYTHONIOENCODING"] = saved
            check("a child script under a cp1252 parent prints a non-cp1252 character as UTF-8",
                  code == 0 and "VALID \u2265" in out, f"exit {code}\n{out}")
            fake.write_text("import time; time.sleep(5)\n", encoding="utf-8")
            deliver_preflight.SCRIPT_TIMEOUT = 1
            refused("a validator that does not finish leaves no file", fixture("slow"),
                    ("--predecessor", "s"), "did not finish")
        finally:
            deliver_preflight.VALIDATE_BINDER, deliver_preflight.SCRIPT_TIMEOUT = real_validator, real_timeout
        r, real_summary = fixture("crash"), globals()["summary"]
        try:
            globals()["summary"] = lambda *a: 1 / 0
            before = files(r)
            code, out = run("--predecessor", "s", "--repo", str(r))
        finally:
            globals()["summary"] = real_summary
        check("a crash after the write leaves no file", code == -1 and files(r) == before, f"exit {code}\n{out}")
        run("--predecessor", "s", "--repo", str(r))  # a first build leaves the draft s-r2
        refused("a rerun names our own uncommitted draft, not a superseding binder", r,
                ("--predecessor", "s"), "uncommitted draft", "s-r2.json")

        # --- refusals, one case each ----------------------------------------------------
        r = fixture("refuse")

        def change_list(doc: dict) -> str:
            p = r / "c.json"
            p.write_text(json.dumps(doc), encoding="utf-8")
            return str(p)

        refused("change list names a carried item", r,
                ("--predecessor", "s", "--changes", change_list({"items": {"alpha": item("alpha")}})),
                "alpha", "carried")
        refused("an id change", r, ("--predecessor", "s", "--changes",
                                    change_list({"items": {"beta": item("gamma")}})), "gamma")
        refused("an unknown id", r, ("--predecessor", "s", "--changes",
                                     change_list({"items": {"ghost": item("ghost")}})), "ghost")
        refused("a binder field outside the six (sme)", r, ("--predecessor", "s", "--changes",
                change_list({"binder": {"sme": ["minimalism"]}})), "sme")
        refused("a validator failure leaves no file", r, ("--predecessor", "s", "--changes",
                change_list({"items": {"beta": item("beta", depends_on=["ghost"])}})), "INVALID")
        (r / ".hatch/binders/s-r2.json").write_text("{}\n", encoding="utf-8")
        refused("the new slug already has a draft (rerun after a first build)", r,
                ("--predecessor", "s"), "s-r2", "in use")
        (r / ".hatch/binders/s-r2.json").unlink()
        ledger = r / ".git" / "hatch" / "attempts" / "s-r2"
        ledger.mkdir(parents=True)
        refused("the new slug already has a ledger folder", r, ("--predecessor", "s"),
                "s-r2", "attempts")
        shutil.rmtree(ledger)
        (r / ".hatch/binders/archive").mkdir()
        (r / ".hatch/binders/archive/s-r2.json").write_text("{}\n", encoding="utf-8")
        refused("the new slug has an archived binder", r, ("--predecessor", "s"), "archive", "in use")
        shutil.rmtree(r / ".hatch/binders/archive")
        git(r, "branch", "hatch/s-r2/integration", "main")
        refused("the new slug has an integration branch", r, ("--predecessor", "s"),
                "hatch/s-r2/integration", "in use")
        git(r, "branch", "-D", "hatch/s-r2/integration")
        git(r, "update-ref", "refs/hatch/s-r2/item-beta/halt", "main")
        refused("the new slug has a refs/hatch ref", r, ("--predecessor", "s"),
                "refs/hatch/s-r2/item-beta/halt", "in use")
        git(r, "update-ref", "-d", "refs/hatch/s-r2/item-beta/halt")
        (r / ".hatch/binders/broken.json").write_text("{", encoding="utf-8")
        refused("an unreadable live binder", r, ("--predecessor", "s"), "broken.json")
        (r / ".hatch/binders/broken.json").unlink()
        code, out = run("--predecessor", "s", "--slug", "x\n", "--repo", str(r))
        check("a --slug with a trailing newline is a usage error", code == 2, f"exit {code}\n{out}")
        bom = r / "bom.json"
        bom.write_bytes(b"\xef\xbb\xbf" + json.dumps({"items": {}}).encode("utf-8"))
        code, out = run("--predecessor", "s", "--changes", str(bom), "--slug", "s-bom", "--repo", str(r))
        check("a change list with a byte-order mark is read", code == 0, f"exit {code}\n{out}")
        (r / ".hatch/binders/s-bom.json").unlink(missing_ok=True)
        archived = r / ".hatch/binders/archive/s.json"
        archived.parent.mkdir()
        shutil.copy(r / ".hatch/binders/s.json", archived)
        refused("predecessor archived in the working tree", r, ("--predecessor", "s"), "archive")
        shutil.rmtree(archived.parent)
        code, out = run("--predecessor", "s", "--changes",
                        change_list({"items": {}, "extra": 1}), "--repo", str(r))
        check("an unknown change-list key is a usage error", code == 2, f"exit {code}\n{out}")
        code, out = run("--predecessor", "s", "--slug", "Bad_Slug", "--repo", str(r))
        check("a malformed --slug is a usage error", code == 2, f"exit {code}\n{out}")
        under = r / ".hatch/binders/changes.json"
        under.write_text(json.dumps({"items": {}}), encoding="utf-8")
        code, out = run("--predecessor", "s", "--changes", str(under), "--repo", str(r))
        under.unlink()
        check("a change list under .hatch/binders/ is a usage error", code == 2,
              f"exit {code}\n{out}")

        r = fixture("archived-tip")
        git(r, "checkout", "-q", "hatch/s/integration")
        (r / ".hatch/binders/archive").mkdir()
        git(r, "mv", ".hatch/binders/s.json", ".hatch/binders/archive/s.json")
        git(r, "commit", "-q", "-m", "retire s")
        git(r, "checkout", "-q", "main")
        refused("predecessor archived at its integration tip", r, ("--predecessor", "s"), "archive")
        refused("no integration branch", fixture("no-integration", integration=False),
                ("--predecessor", "s"), "hatch/s/integration")
        refused("nothing delivered to carry", fixture("nothing", done=()),
                ("--predecessor", "s"), "Clear and stop", "on Pi")
        r = fixture("no-plan-at-tip")
        git(r, "checkout", "-q", "hatch/s/integration")
        git(r, "rm", "-q", ".hatch/binders/s.json")
        git(r, "commit", "-q", "-m", "drop the plan")
        git(r, "checkout", "-q", "main")
        refused("no committed binder at the predecessor's integration tip", r,
                ("--predecessor", "s"), "no committed binder")
        r = fixture("forged-in-place", done=())
        git(r, "checkout", "-q", "-b", "hatch/s/item-alpha", "hatch/s/integration")
        git(r, "commit", "-q", "--allow-empty", "-m", "the work, no marker")
        git(r, "checkout", "-q", "hatch/s/integration")
        git(r, "merge", "-q", "--no-ff", "hatch/s/item-alpha", "-m", "merge alpha, no marker")
        git(r, "update-ref", "refs/hatch/s/item-alpha/done", "HEAD")
        git(r, "checkout", "-q", "main")
        refused("a done ref on the first-parent chain whose merge has no marker is not carried", r,
                ("--predecessor", "s"), "refs/hatch/s/item-alpha/done", "check_item_provenance exit")

        # --- --summary on a hand-written successor ------------------------------------
        r = fixture("hand")
        hand = dict(load(r / ".hatch/binders/s.json"), slug="s-r5",
                    supersedes={"slug": "s", "carried": ["alpha"]})
        hand["work_items"] = [item("alpha"), item("gamma")]
        hand_path = tmp / "s-r5.json"
        hand_path.write_text(json.dumps(hand, indent=2), encoding="utf-8")
        (r / ".git" / "hatch" / "attempts" / "s-r5").mkdir(parents=True)
        code, out = run("--summary", str(hand_path), "--repo", str(r))
        check("--summary on a hand-written successor names added and dropped items and the "
              "existing ledger", code == 0 and "Added: gamma" in out
              and "Not copied from s: beta" in out and "already has a ledger" in out,
              f"exit {code}\n{out}")
        weak = item("alpha")
        weak["oracle"] = {"type": "unit", "assertions": ["alpha one"], "command": "true", "expect": "passed"}
        hand = dict(hand, slug="s-r6", supersedes={"slug": "s", "carried": ["alpha", "beta"]},
                    work_items=[weak, item("beta", depends_on=["alpha"])])
        hand_path.write_text(json.dumps(hand, indent=2), encoding="utf-8")
        code, out = run("--summary", str(hand_path), "--repo", str(r))
        check("--summary calls only proven items carried, and a weakened claimed one changed",
              code == 0 and "Carried, delivered and copied unchanged: none" in out
              and "Claimed carried, not proven: alpha, beta" in out
              and "Changed: alpha (oracle)" in out and '    removed or reworded: "alpha two"' in out,
              f"exit {code}\n{out}")
        code, out = run("--summary", str(r / ".hatch/binders/s.json"), "--repo", str(r))
        check("--summary on a binder without supersedes is refused", code == 3, f"exit {code}\n{out}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"self-test: {sum(results)}/{len(results)} cases passed")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
