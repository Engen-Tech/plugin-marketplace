# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch gate-attempt ledger: persist reviewer attempts so a resumed session
cannot reset a retry cap.

The acceptance reviewer allows 2 attempts, then the item halts with a call to action;
the safety auditor allows 3, then the pipeline escalates to the human (both caps are
stated in agents/hatch-*.md). The reviewers are read-only and keep no loop
state, so the orchestrator records every checked verdict here and asks the ledger,
not its own memory, whether another attempt is allowed.

Where it lives: one JSON-lines file per (item, gate) under

    $(git rev-parse --git-common-dir)/hatch/attempts/<binder-slug>/<item-id>.<gate>.jsonl

Inside the Git common directory it is shared by every worktree of the repository and
is never part of a commit. Each line records: gate, attempt number, verdict, reviewed
range, the live diff digest (the same SHA-256 check_gate_report.py requires), the
item-spec digest (SHA-256 of the item's canonical binder JSON), the item, the binder
slug, and a UTC timestamp.

What counts. The cap counts `concerns` verdicts (DEVIATION / VIOLATION) per
(item, gate, item-spec digest). A `pass` or `blocked` verdict is recorded but spends
nothing — this matches the verify skill's rule that a verdict-currency refresh after
the agent's own passing verdict does not count. A changed diff does NOT start a new
count: fixing the diff is what the retries are for. A changed item spec — a successor
binder, a re-planned oracle — starts a new sequence, because the reviewers are judging
a different item. The attempt number of a record is 1 + the `concerns` verdicts before
it in its sequence.

Limits, stated plainly: the ledger is ordinary files the orchestrator writes; a
process with write access to the repository's Git directory can edit or delete it. It
makes a resumed or restarted session see the real count; it is not tamper-proof.

Usage:
  gate_attempts.py record --repo DIR --binder FILE --item ID --gate acceptance|safety \\
      --verdict pass|concerns|blocked --range RANGE
  gate_attempts.py check  --repo DIR --binder FILE --item ID --gate acceptance|safety
  gate_attempts.py --self-test

Both subcommands print the sequence state as JSON on stdout.
Exit codes: check — 0 attempts remain, 1 cap reached (halt or escalate);
record — 0 recorded, 1 recorded but the cap was already reached before this attempt
(a dispatch past the cap); 2 usage error for both.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

CAPS = {"acceptance": 2, "safety": 3}
CAP_ACTION = {
    "acceptance": ("halt the item with a call to action (a `failed` ref, not done) — no human "
                   "escalation from this gate; on Pi the halt prompt also offers Send back to the "
                   "worker once, which waives nothing and leaves the cap spent"),
    "safety": "escalate to the human — an unjustified boundary crossing needs a person's decision",
}
VERDICTS = ("pass", "concerns", "blocked")
SCHEMA = "hatch-gate-attempt-v1"
_SAFE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


class UsageError(Exception):
    pass


def _load_report_checker():
    """Reuse check_gate_report.diff_digest so both scripts bind to the same bytes."""
    path = Path(__file__).resolve().with_name("check_gate_report.py")
    spec = importlib.util.spec_from_file_location("hatch_check_gate_report", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _safe(kind: str, value: str) -> str:
    if not _SAFE_NAME.fullmatch(value) or ".." in value:
        raise UsageError(f"{kind} {value!r} is not a plain name (letters, digits, '.', '_', '-')")
    return value


def item_spec(binder_path: Path, item_id: str) -> tuple[dict, str]:
    try:
        binder = json.loads(binder_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        raise UsageError(f"cannot read --binder: {e}") from e
    items = binder.get("work_items") if isinstance(binder, dict) else None
    matches = [i for i in items or [] if isinstance(i, dict) and str(i.get("id")) == item_id]
    if len(matches) != 1:
        raise UsageError(f"item {item_id!r} is not exactly one work item in {binder_path}")
    canonical = json.dumps(matches[0], sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return matches[0], hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def ledger_path(repo: Path, binder_path: Path, item_id: str, gate: str) -> Path:
    try:
        out = subprocess.run(["git", "-C", str(repo), "rev-parse", "--path-format=absolute",
                              "--git-common-dir"], capture_output=True, text=True, encoding="utf-8",
                             check=True, timeout=30).stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        raise UsageError(f"--repo {repo} is not a Git working tree: {e}") from e
    slug = _safe("binder slug", binder_path.stem)
    return Path(out) / "hatch" / "attempts" / slug / f"{_safe('item', item_id)}.{gate}.jsonl"


def read_rows(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            raise UsageError(f"{path}:{n} is not JSON ({e}); the ledger was edited by hand — "
                             "repair or remove that line deliberately") from e
        if not isinstance(row, dict):
            raise UsageError(f"{path}:{n} is not a JSON object")
        rows.append(row)
    return rows


def state(rows: list[dict], gate: str, spec_digest: str, path: Path) -> dict:
    sequence = [r for r in rows if r.get("item_spec_sha256") == spec_digest]
    counted = sum(1 for r in sequence if r.get("verdict") == "concerns")
    cap = CAPS[gate]
    return {"gate": gate, "cap": cap, "counted": counted, "recorded": len(sequence),
            "exhausted": counted >= cap, "next_attempt": counted + 1,
            "item_spec_sha256": spec_digest, "ledger": str(path)}


def _common(args) -> tuple[Path, str]:
    _safe("item", args.item)
    _, spec_digest = item_spec(args.binder, args.item)
    return ledger_path(args.repo, args.binder, args.item, args.gate), spec_digest


def cmd_check(args) -> int:
    path, spec_digest = _common(args)
    st = state(read_rows(path), args.gate, spec_digest, path)
    print(json.dumps(st, sort_keys=True))
    if st["exhausted"]:
        print(f"gate_attempts: {args.gate} cap reached for {args.item} "
              f"({st['counted']}/{st['cap']} non-passing attempts on this item spec) — "
              f"do not re-dispatch; {CAP_ACTION[args.gate]}.", file=sys.stderr)
        return 1
    return 0


def cmd_record(args) -> int:
    path, spec_digest = _common(args)
    try:
        digest = _load_report_checker().diff_digest(args.repo, args.diff_range)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        raise UsageError(f"cannot identify the reviewed diff: {e}") from e
    rows = read_rows(path)
    before = state(rows, args.gate, spec_digest, path)
    row = {"schema": SCHEMA, "gate": args.gate, "attempt": before["next_attempt"],
           "verdict": args.verdict, "counted": args.verdict == "concerns",
           "range": args.diff_range, "diff_sha256": digest, "item_spec_sha256": spec_digest,
           "item": args.item, "binder_slug": args.binder.stem,
           "recorded_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        os.write(fd, (json.dumps(row, sort_keys=True) + "\n").encode("utf-8"))
    finally:
        os.close(fd)
    after = state(rows + [row], args.gate, spec_digest, path)
    print(json.dumps(after, sort_keys=True))
    if before["exhausted"]:
        print(f"gate_attempts: recorded, but the {args.gate} cap was already reached for "
              f"{args.item} before this attempt — this dispatch should not have happened; "
              f"{CAP_ACTION[args.gate]}.", file=sys.stderr)
        return 1
    return 0


def _run_self_test() -> int:
    failures = 0

    def expect(name: str, cond: bool) -> None:
        nonlocal failures
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        failures += 0 if cond else 1

    def run(*argv: str) -> int:
        try:
            return main(list(argv))
        except SystemExit as e:  # argparse usage errors
            return int(e.code or 0)

    with tempfile.TemporaryDirectory(prefix="gate-attempts-") as d:
        repo = Path(d) / "repo"
        repo.mkdir()
        git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True,  # noqa: E731
                                        capture_output=True, text=True,
                                        encoding="utf-8").stdout.strip()
        git("init", "-q")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "user.name", "fixture")
        binder = Path(d) / "demo.json"  # outside the tree: the spec edit below is not a change
        binder.write_text(json.dumps({"work_items": [{"id": "WI01", "title": "a"}]}), encoding="utf-8")
        (repo / "f.txt").write_text("one\n", encoding="utf-8")
        git("add", "-A")
        git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD")
        (repo / "f.txt").write_text("two\n", encoding="utf-8")
        git("add", "-A")
        git("commit", "-qm", "change")
        common = ["--repo", str(repo), "--binder", str(binder), "--item", "WI01"]
        rec = lambda gate, verdict: run("record", *common, "--gate", gate,  # noqa: E731
                                        "--verdict", verdict, "--range", f"{base}..HEAD")
        sink = open(os.devnull, "w", encoding="utf-8")
        real_out, real_err = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = sink
        try:
            results = {
                "fresh check passes": run("check", *common, "--gate", "acceptance"),
                "first concerns recorded": rec("acceptance", "concerns"),
                "one of two leaves room": run("check", *common, "--gate", "acceptance"),
                "second concerns recorded": rec("acceptance", "concerns"),
                "acceptance cap reached": run("check", *common, "--gate", "acceptance"),
                "record past cap flagged": rec("acceptance", "concerns"),
                "safety independent": run("check", *common, "--gate", "safety"),
                "pass does not count": (rec("safety", "pass"), rec("safety", "pass"),
                                        run("check", *common, "--gate", "safety"))[-1],
            }
            binder.write_text(json.dumps({"work_items": [{"id": "WI01", "title": "b"}]}),
                              encoding="utf-8")
            results["changed spec restarts"] = run("check", *common, "--gate", "acceptance")
            results["unknown item is usage error"] = run(
                "check", "--repo", str(repo), "--binder", str(binder), "--item", "WI09",
                "--gate", "acceptance")
            results["option-shaped range refused"] = run(
                "record", *common, "--gate", "safety", "--verdict", "pass", "--range", "--output=x")
        finally:
            sys.stdout, sys.stderr = real_out, real_err
            sink.close()
        want = {"fresh check passes": 0, "first concerns recorded": 0, "one of two leaves room": 0,
                "second concerns recorded": 0, "acceptance cap reached": 1,
                "record past cap flagged": 1, "safety independent": 0, "pass does not count": 0,
                "changed spec restarts": 0, "unknown item is usage error": 2,
                "option-shaped range refused": 2}
        for name, code in want.items():
            expect(f"{name} (exit {results[name]})", results[name] == code)
        expect("ledger stays out of the working tree", git("status", "--porcelain") == "")
    total = 12
    print(f"self-test: {total - failures}/{total} cases passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="gate_attempts.py", description=__doc__.split("\n\n")[0])
    ap.add_argument("--self-test", action="store_true", help="run embedded fixtures and exit 0/1")
    sub = ap.add_subparsers(dest="command")
    for name in ("record", "check"):
        p = sub.add_parser(name)
        p.add_argument("--repo", type=Path, default=Path.cwd(), help="the reviewed worktree")
        p.add_argument("--binder", type=Path, required=True, help="path to the binder JSON")
        p.add_argument("--item", required=True, help="work item id")
        p.add_argument("--gate", choices=sorted(CAPS), required=True)
        if name == "record":
            p.add_argument("--verdict", choices=VERDICTS, required=True,
                           help="the checked return envelope")
            p.add_argument("--range", dest="diff_range", required=True,
                           help="the dispatched Git diff range")
    args = ap.parse_args(argv)
    if args.self_test:
        return _run_self_test()
    if args.command is None:
        ap.error("a subcommand is required: record or check")
    try:
        return cmd_record(args) if args.command == "record" else cmd_check(args)
    except UsageError as e:
        print(f"gate_attempts: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
