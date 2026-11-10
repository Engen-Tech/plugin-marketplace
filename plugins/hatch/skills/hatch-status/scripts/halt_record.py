# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch halt record writer for the skill route. Stdlib only.

Writes the blob at refs/hatch/<slug>/item-<id>/halt that says why an item stopped,
the same bytes Pi's extensions/pi/halt-writer.ts writes for the same halt. The record
is validated by hatch_next.parse_halt_record, the parser every reader uses, and its
rules come from references/halt-record.json, so a writer writes only words it knows.

  halt_record.py write --repo DIR --binder FILE --item ID --kind K --phase P --next-step S
                       [--gate G] [--attempt N] [--findings-json FILE|-] [--required-check-id ID]
                       [--failed] [--recorded-at TS] [--dry-run]
  halt_record.py delete --repo DIR --slug SLUG --item ID [--with-failed TIP]
  halt_record.py --self-test

A record is prepared in four steps, and nothing reaches the object store before the
last: build the exact bytes, check them with the readers' parser, run the secret scan
over them, then hash. A model-written value the scan matches (a finding's code or path,
the required check id) is written as `withheld`; a record that still matches is not
written. The scan has its own time limit (30 s per scan, HATCH_HALT_SCAN_UV_TIMEOUT_MS
overrides it); a scan that times out or cannot run writes no record and says so, never
as a match or a validation failure.

`write` keeps the record in one `git update-ref --stdin` transaction: it verifies the
item branch at the tip it read; with --failed it creates .../failed at that tip in the
same transaction, and without it verifies .../failed as it found it. Nothing is written
beside built, done or accepted. With --failed, a record that cannot be kept still
writes `failed` alone and exits 0 with "written": false and the reason; without it,
the helper exits 3. --dry-run prints the record's bytes and writes nothing.

Stdout is one JSON object, {ref, written, failed_written, blob, withheld, why}, except
for --dry-run, which prints the bytes. Exit 0 written (or skipped beside an outcome, or
failed alone), 2 usage, 3 not written.
"""
import argparse
import datetime as _dt
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

sys.dont_write_bytecode = True
# Import the sibling engine regardless of CWD: its parser and rules are the readers'.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import hatch_next  # noqa: E402

HERE = Path(__file__).resolve().parent
SCANNER = HERE.parent.parent / "hatch-build" / "scripts" / "scan_secrets.py"
SCAN_SCRIPT = "scan_secrets.py"
SCAN_TIMEOUT_ENV = "HATCH_HALT_SCAN_UV_TIMEOUT_MS"
SCAN_TIMEOUT_DEFAULT_MS = 30_000
SCAN_TIMEOUT_MAX_MS = 2_147_483_647
MATCHED = "the halt record matched the secret scan; not written"
OUTCOMES = ("built", "done", "accepted")
HOST_GIT_CONFIG = ("-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null")
UNKNOWN_VERSION = "0.0.0+unknown"

# scan_secrets.py's two reports, read as extensions/pi/secret-scan.ts reads them.
CLEAN = "SECRET SCAN: CLEAN"
BLOCKED = "SECRET SCAN: BLOCKED"
BLOCKED_ADVICE = "Remove or rotate the secret, or add a reviewed allow-list entry, before retry."
FINDING = re.compile(r"^ {2}- (.+):(\d+): ([a-z0-9-]+)$")


class UsageError(Exception):
    """A caller error: exit 2, nothing written."""


class NotKept(Exception):
    """The record cannot be kept; the message is the reason."""


# ---- the bytes ----

def bounded(findings: list[dict], rules: dict) -> list[dict]:
    """item-halt.ts bounded(): at most max_findings; a path the path pattern rejects is
    null; a code the token pattern rejects is cut to 80 characters or, when the cut still
    fails, written as the `withheld` word."""
    token, path = rules["compiled"]["token"], rules["compiled"]["path"]

    def code(value: str) -> str:
        if token.fullmatch(value):
            return value
        cut = value[:80]
        return cut if token.fullmatch(cut) else rules["withheld"]

    return [{**f, "code": code(f["code"]),
             "path": f["path"] if f["path"] is not None and path.fullmatch(f["path"]) else None}
            for f in findings[:rules["max_findings"]]]


def record_of(halt: dict, rules: dict, findings: list[dict]) -> dict:
    """The record in the readers' field order, every field present (halt-writer.ts recordOf)."""
    check = halt["required_check_id"]
    return {
        "schema_version": rules["schema_version"],
        "binder": halt["binder"],
        "item": halt["item"],
        "item_spec_sha256": halt["item_spec_sha256"],
        "halt_kind": halt["halt_kind"],
        "gate": halt["gate"],
        "phase": halt["phase"],
        "attempt": halt["attempt"],
        "findings": [{"severity": f["severity"], "code": f["code"], "path": f["path"], "line": f["line"]}
                     for f in findings],
        "next_step": halt["next_step"],
        "required_check_id": (check if check is None or rules["compiled"]["token"].fullmatch(check)
                              else rules["withheld"]),
        "item_tip": halt["item_tip"],
        "integration_tip": halt["integration_tip"],
        "recorded_at": halt["recorded_at"],
        "hatch_version": halt["hatch_version"],
    }


def record_text(halt: dict, rules: dict) -> str:
    """The exact bytes, as halt-writer.ts haltRecordText writes them. Over max_bytes,
    findings are dropped from the tail until it fits."""
    findings = halt["findings"]
    while True:
        text = json.dumps(record_of(halt, rules, findings), indent=1, ensure_ascii=False) + "\n"
        if not findings or len(text.encode("utf-8")) <= rules["max_bytes"]:
            return text
        findings = findings[:-1]


def checked(text: str, halt: dict, rules: dict) -> None:
    parsed = hatch_next.parse_halt_record(text.encode("utf-8"), halt["binder"], halt["item"], rules)
    if parsed["status"] == "valid":
        return
    why = parsed["why"] if parsed["status"] == "unreadable" else f"unsupported schema {parsed['schema']}"
    raise NotKept(f"the halt record is not valid: {why}")


def model_values(halt: dict) -> list[tuple[str, tuple]]:
    """The values a model wrote, in halt-writer.ts modelValues order, each with where it sits."""
    values: list[tuple[str, tuple]] = []
    for index, finding in enumerate(halt["findings"]):
        values.append((finding["code"], ("findings", index, "code")))
        if finding["path"] is not None:
            values.append((finding["path"], ("findings", index, "path")))
    if halt["required_check_id"] is not None:
        values.append((halt["required_check_id"], ("required_check_id",)))
    return values


def withhold(halt: dict, where: tuple, word: str) -> dict:
    if where[0] == "required_check_id":
        return {**halt, "required_check_id": word}
    _, index, field = where
    findings = [dict(f, **{field: word}) if at == index else f for at, f in enumerate(halt["findings"])]
    return {**halt, "findings": findings}


# ---- the scan ----

def scan_timeout_ms() -> int:
    """Read at call time. Unset or not an integer 1..2147483647 keeps the 30 s default,
    the rule halt-writer.ts applies to the same variable."""
    raw = os.environ.get(SCAN_TIMEOUT_ENV, "")
    if re.fullmatch(r"[0-9]+", raw.strip()):
        value = int(raw.strip())
        if 0 < value <= SCAN_TIMEOUT_MAX_MS:
            return value
    return SCAN_TIMEOUT_DEFAULT_MS


def _text(value) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else value


def read_scan_output(exit_code: int, stdout: str) -> list[dict] | None:
    """secret-scan.ts readSecretScanOutput: None for clean, the matches for a blocked
    report, NotKept for anything else."""
    lines = [line for line in re.split(r"\r?\n", stdout) if line.strip() != ""]
    text = stdout.strip()
    unreadable = NotKept(f"Hatch secret scan output could not be read (exit {exit_code}): {text}" if text
                         else f"Hatch secret scan failed (exit {exit_code}) with no report")
    if exit_code == 0:
        if lines == [CLEAN]:
            return None
        raise unreadable
    if exit_code != 1 or not lines or lines[0] != BLOCKED or lines[-1] != BLOCKED_ADVICE:
        raise unreadable
    found = lines[1:-1]
    if not found:
        raise unreadable
    matches = []
    for line in found:
        parsed = FINDING.match(line)
        if not parsed:
            raise unreadable
        matches.append({"pattern": parsed.group(3), "path": parsed.group(1), "line": int(parsed.group(2))})
    return matches


def scan_file(repo: Path, file: Path) -> list[dict] | None:
    """scan_secrets.py --file over one scratch file, from the repository root so its
    allow-list applies. A timeout names the limit; any other failure is the scanner's own."""
    timeout = scan_timeout_ms()
    try:
        proc = subprocess.run([sys.executable, str(SCANNER), "--file", str(file)], cwd=repo,
                              capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=timeout / 1000)
    except subprocess.TimeoutExpired as expired:
        limit = f"{timeout // 1000} s" if timeout % 1000 == 0 else f"{timeout} ms"
        output = (_text(expired.stdout) + _text(expired.stderr)).strip()
        timed_out = f"{SCAN_SCRIPT} did not finish in {limit}"
        raise NotKept(f"{timed_out}:\n{output}" if output else timed_out) from None
    except OSError as error:
        raise NotKept(f"{SCAN_SCRIPT} could not start: {error}") from None
    if proc.returncode == 0:
        return read_scan_output(0, proc.stdout)
    try:
        return read_scan_output(proc.returncode, proc.stdout)
    except NotKept as unread:
        stderr = proc.stderr.strip()
        raise NotKept(f"{unread}\n{stderr}" if stderr else str(unread)) from None


# ---- git ----

def git(repo: Path, *args: str, stdin: str | None = None) -> str:
    proc = subprocess.run(["git", "-C", str(repo), *HOST_GIT_CONFIG, *args], input=stdin,
                          capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode != 0:
        raise NotKept(proc.stderr.strip() or proc.stdout.strip()
                      or f"git {args[0]} failed while writing a halt record")
    return proc.stdout.strip()


def ref_oid(repo: Path, ref: str) -> str | None:
    proc = subprocess.run(["git", "-C", str(repo), *HOST_GIT_CONFIG, "rev-parse", "--verify", "--quiet", ref],
                          capture_output=True, text=True, encoding="utf-8")
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else None


def transaction(repo: Path, commands: list[str]) -> None:
    """One `git update-ref --stdin` transaction: every line lands, or none does."""
    git(repo, "update-ref", "--stdin", stdin="start\n" + "\n".join(commands) + "\nprepare\ncommit\n")


def prepare(repo: Path, halt: dict, rules: dict, dry_run: bool) -> tuple[str, str | None, bool]:
    """(text, blob, withheld) for a record that passed the readers' parser and the scan.
    Every scan and the hash read the same scratch file, so the bytes scanned are the
    bytes stored. Raises NotKept."""
    text = record_text(halt, rules)
    checked(text, halt, rules)
    scratch = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")) / "hatch"
    scratch.mkdir(parents=True, exist_ok=True)
    record = scratch / f"halt-{uuid.uuid4()}.json.tmp"
    values = scratch / f"halt-{uuid.uuid4()}.values.tmp"
    withheld = False
    try:
        record.write_bytes(text.encode("utf-8"))
        if scan_file(repo, record) is not None:
            candidates = model_values(halt)
            values.write_bytes("".join(f"{value}\n" for value, _ in candidates).encode("utf-8"))
            lines = {m["line"] for m in scan_file(repo, values) or []}
            kept = halt
            for index, (_, where) in enumerate(candidates):
                if index + 1 in lines:
                    kept = withhold(kept, where, rules["withheld"])
                    withheld = True
            text = record_text(kept, rules)
            checked(text, halt, rules)
            record.write_bytes(text.encode("utf-8"))
            if scan_file(repo, record) is not None:
                raise NotKept(MATCHED)
        blob = None if dry_run else git(repo, "hash-object", "-w", "--no-filters", "--", str(record))
        return text, blob, withheld
    finally:
        for scratch_file in (record, values):
            try:
                scratch_file.unlink()
            except OSError:
                pass


# ---- inputs ----

def hatch_version() -> str:
    """The nearest hatch manifest above this script: package.json named @engen-tech/hatch,
    .claude-plugin/plugin.json or .codex-plugin/plugin.json; else 0.0.0+unknown."""
    pattern = hatch_next.load_halt_rules().get("compiled", {}).get("version")
    for folder in (HERE, *HERE.parents):
        for manifest, named in ((folder / "package.json", "@engen-tech/hatch"),
                                (folder / ".claude-plugin" / "plugin.json", None),
                                (folder / ".codex-plugin" / "plugin.json", None)):
            try:
                doc = json.loads(manifest.read_text(encoding="utf-8"))
            except OSError:
                continue
            except ValueError as error:
                raise NotKept(f"the hatch manifest {manifest} is not valid UTF-8 JSON: {error}") from None
            if not isinstance(doc, dict) or (named is not None and doc.get("name") != named):
                continue
            version = doc.get("version")
            if isinstance(version, str) and (pattern is None or pattern.fullmatch(version)):
                return version
    return UNKNOWN_VERSION


def binder_item(binder: Path, item_id: str) -> dict:
    """The one work item `item_id` in the binder, as gate_attempts.py item_spec finds it."""
    try:
        doc = json.loads(binder.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise UsageError(f"cannot read --binder: {error}") from None
    items = doc.get("work_items") if isinstance(doc, dict) else None
    matches = [i for i in items or [] if isinstance(i, dict) and str(i.get("id")) == item_id]
    if len(matches) != 1:
        raise UsageError(f"item {item_id!r} is not exactly one work item in {binder}")
    return matches[0]


def _whole(value, name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise UsageError(f"findings: {name} must be a whole number or null")
    if isinstance(value, float):
        if not value.is_integer():
            raise UsageError(f"findings: {name} must be a whole number or null")
        value = int(value)
    return value


def read_findings(source: str | None, rules: dict) -> list[dict]:
    if source is None:
        return []
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        found = json.loads(raw)
    except (OSError, ValueError) as error:
        raise UsageError(f"cannot read --findings-json: {error}") from None
    if not isinstance(found, list):
        raise UsageError("findings: expected a JSON list")
    findings = []
    for one in found:
        if not isinstance(one, dict):
            raise UsageError("findings: each finding must be an object")
        severity, code, path = one.get("severity"), one.get("code"), one.get("path")
        if severity not in rules["severities"]:
            raise UsageError(f"findings: severity must be one of {', '.join(rules['severities'])}")
        if not isinstance(code, str) or not code:
            raise UsageError("findings: code must be a non-empty string")
        if path is not None and not isinstance(path, str):
            raise UsageError("findings: path must be a string or null")
        findings.append({"severity": severity, "code": code, "path": path, "line": _whole(one.get("line"), "line")})
    return findings


def known(rules: dict, table: str, flag: str, value: str | None) -> None:
    if value is not None and value not in rules[table]:
        raise UsageError(f"{flag} {value!r} is not one of {', '.join(rules[table])}")


# ---- commands ----

def emit(out: dict) -> None:
    sys.stdout.write(json.dumps(out) + "\n")


def cmd_write(args) -> int:
    repo = Path(args.repo)
    binder = Path(args.binder)
    slug = binder.stem
    rules = hatch_next.load_halt_rules()
    if "broken" in rules:
        raise UsageError(f"the halt rules file could not be read: {rules['broken']}")
    for name, value in (("binder slug", slug), ("item", args.item)):
        if not rules["compiled"]["slug"].fullmatch(value):
            raise UsageError(f"the {name} {value!r} is not a slug")
    known(rules, "kinds", "--kind", args.kind)
    known(rules, "phases", "--phase", args.phase)
    known(rules, "next_steps", "--next-step", args.next_step)
    known(rules, "gates", "--gate", args.gate)
    if args.attempt is not None and args.attempt < 1:
        raise UsageError("--attempt must be 1 or more")
    recorded_at = args.recorded_at or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not rules["compiled"]["timestamp"].fullmatch(recorded_at):
        raise UsageError("--recorded-at must look like 2026-01-31T12:00:00Z")
    item = binder_item(binder, args.item)
    findings = read_findings(args.findings_json, rules)

    root = f"refs/hatch/{slug}/item-{args.item}"
    branch = f"refs/heads/hatch/{slug}/item-{args.item}"
    tip = ref_oid(repo, branch)
    if tip is None:
        raise UsageError(f"{branch} does not exist in {repo}")
    out = {"ref": f"{root}/halt", "written": False, "failed_written": False, "blob": None,
           "withheld": False, "why": None}
    # An unreadable manifest is a record that cannot be kept: with --failed, failed alone.
    unkept = None
    try:
        version = hatch_version()
    except NotKept as refused:
        version, unkept = None, refused
    halt = {
        "binder": slug, "item": args.item, "item_spec_sha256": hatch_next.item_spec_digest(item),
        "halt_kind": args.kind, "gate": args.gate, "phase": args.phase, "attempt": args.attempt,
        "findings": bounded(findings, rules), "next_step": args.next_step,
        "required_check_id": args.required_check_id, "item_tip": tip,
        "integration_tip": ref_oid(repo, f"refs/heads/hatch/{slug}/integration"),
        "recorded_at": recorded_at, "hatch_version": version,
    }

    if args.dry_run:
        try:
            if unkept is not None:
                raise unkept
            text, _, _ = prepare(repo, halt, rules, dry_run=True)
        except NotKept as refused:
            emit({**out, "why": str(refused)})
            return 3
        sys.stdout.flush()
        sys.stdout.buffer.write(text.encode("utf-8"))
        return 0

    listed = git(repo, "for-each-ref", "--format=%(refname) %(objectname)", f"{root}/")
    refs = dict(line.split(" ", 1) for line in listed.splitlines() if " " in line)
    standing = [name for name in OUTCOMES if f"{root}/{name}" in refs]
    if standing:
        emit({**out, "why": f"the item has a {standing[0]} ref; no record is written beside built, done or accepted"})
        return 0
    try:
        if unkept is not None:
            raise unkept
        _, blob, withheld = prepare(repo, halt, rules, dry_run=False)
    except NotKept as refused:
        out["why"] = str(refused)
        if not args.failed:
            emit(out)
            return 3
        try:
            transaction(repo, [f"verify {branch} {tip}", f"create {root}/failed {tip}"])
        except NotKept as git_error:
            emit({**out, "why": f"{refused}; {root}/failed was not written either: {git_error}"})
            return 3
        emit({**out, "failed_written": True})
        return 0
    zero = "0" * len(blob)
    failed_line = (f"create {root}/failed {tip}" if args.failed
                   else f"verify {root}/failed {refs.get(f'{root}/failed', zero)}")
    try:
        transaction(repo, [f"verify {branch} {tip}", failed_line,
                           *(f"verify {root}/{name} {zero}" for name in OUTCOMES),
                           f"update {root}/halt {blob}"])
    except NotKept as git_error:
        emit({**out, "why": str(git_error), "withheld": withheld})
        return 3
    emit({**out, "written": True, "failed_written": bool(args.failed), "blob": blob, "withheld": withheld})
    return 0


def cmd_delete(args) -> int:
    rules = hatch_next.load_halt_rules()
    slug_pattern = re.compile(r"[a-z0-9][a-z0-9-]*") if "broken" in rules else rules["compiled"]["slug"]
    for name, value in (("slug", args.slug), ("item", args.item)):
        if not slug_pattern.fullmatch(value):
            raise UsageError(f"the {name} {value!r} is not a slug")
    root = f"refs/hatch/{args.slug}/item-{args.item}"
    commands = [f"delete {root}/halt"]
    if args.with_failed is not None:
        commands.append(f"delete {root}/failed {args.with_failed}")
    try:
        transaction(Path(args.repo), commands)
    except NotKept as git_error:
        emit({"ref": f"{root}/halt", "deleted": False, "why": str(git_error)})
        return 3
    emit({"ref": f"{root}/halt", "deleted": True, "why": None})
    return 0


# ---- self-test ----

def _run_self_test() -> int:
    failures = total = 0

    def expect(name: str, cond: bool) -> None:
        nonlocal failures, total
        print(f"[{'PASS' if cond else 'FAIL'}] {name}")
        total += 1
        failures += 0 if cond else 1

    rules = hatch_next.load_halt_rules()
    expect("the halt rules load", "broken" not in rules)
    if "broken" in rules:
        print(f"\n0/{total} checks passed")
        return 1
    halt = {
        "binder": "s", "item": "a", "item_spec_sha256": "e" * 64, "halt_kind": "gate-cap",
        "gate": "acceptance-gate", "phase": "build", "attempt": 2,
        "findings": [{"severity": "major", "code": "missing-test", "path": "src/a.ts", "line": 3}],
        "next_step": "human-decision", "required_check_id": None, "item_tip": "1" * 40,
        "integration_tip": None, "recorded_at": "2026-11-09T12:34:56Z", "hatch_version": "1.2.3",
    }
    text = record_text(halt, rules)
    parsed = hatch_next.parse_halt_record(text.encode("utf-8"), "s", "a", rules)
    expect("a built record is valid to the readers' parser", parsed["status"] == "valid")
    expect("the bytes are one-space JSON with a trailing newline",
           text.startswith('{\n "schema_version": 1,\n "binder": "s",') and text.endswith("}\n"))
    expect("required_check_id that is not a token is withheld",
           json.loads(record_text({**halt, "required_check_id": "a b"}, rules))["required_check_id"] == "withheld")
    cut = bounded([{"severity": "minor", "code": "c" * 90, "path": "a\nb", "line": None},
                   {"severity": "minor", "code": "a b", "path": "ok", "line": None}], rules)
    expect("bounded cuts a long code, withholds a bad one, nulls a bad path",
           [(f["code"], f["path"]) for f in cut] == [("c" * 80, None), ("withheld", "ok")])
    expect("bounded keeps at most max_findings",
           len(bounded([halt["findings"][0]] * 60, rules)) == rules["max_findings"])
    big = {**halt, "findings": [{"severity": "minor", "code": f"c{n}", "path": "p/" + "x" * 290, "line": 1}
                                for n in range(50)]}
    trimmed = record_text(big, rules)
    expect("an oversized record drops findings until it fits",
           len(trimmed.encode("utf-8")) <= rules["max_bytes"] and 0 < len(json.loads(trimmed)["findings"]) < 50)
    expect("a clean report reads as clean", read_scan_output(0, CLEAN + "\n") is None)
    blocked = f"{BLOCKED}\n  - <file>:2: aws-key\n{BLOCKED_ADVICE}\n"
    expect("a blocked report reads its matches",
           read_scan_output(1, blocked) == [{"pattern": "aws-key", "path": "<file>", "line": 2}])
    for name, code, out in (("an unknown clean report", 0, "SECRET SCAN: MAYBE"),
                            ("an empty failure", 2, ""), ("a blocked report with no finding", 1,
                                                          f"{BLOCKED}\n{BLOCKED_ADVICE}\n")):
        try:
            read_scan_output(code, out)
            expect(f"{name} is a scanner error", False)
        except NotKept:
            expect(f"{name} is a scanner error", True)
    saved = os.environ.get(SCAN_TIMEOUT_ENV)
    try:
        results = []
        for value, want in (("200", 200), ("abc", 30_000), ("0", 30_000), ("2147483648", 30_000)):
            os.environ[SCAN_TIMEOUT_ENV] = value
            results.append(scan_timeout_ms() == want)
        expect("the scan limit override is an integer 1..2147483647, else 30 s", all(results))
    finally:
        if saved is None:
            os.environ.pop(SCAN_TIMEOUT_ENV, None)
        else:
            os.environ[SCAN_TIMEOUT_ENV] = saved
    expect("the hatch version matches the record's version pattern",
           rules["compiled"]["version"].fullmatch(hatch_version()) is not None)
    with tempfile.TemporaryDirectory(prefix="hatch-halt-record-selftest-") as tmp:
        clean = Path(tmp) / "clean.txt"
        clean.write_text("nothing here\n", encoding="utf-8")
        try:
            expect("the scanner beside this skill runs and reads clean", scan_file(Path(tmp), clean) is None)
        except NotKept as error:
            expect(f"the scanner beside this skill runs and reads clean ({error})", False)
    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Write or delete a hatch halt record (the skill route).")
    ap.add_argument("--self-test", action="store_true", help="run the embedded checks and exit")
    sub = ap.add_subparsers(dest="command")
    w = sub.add_parser("write", help="write the halt record")
    w.add_argument("--repo", required=True)
    w.add_argument("--binder", required=True)
    w.add_argument("--item", required=True)
    w.add_argument("--kind", required=True)
    w.add_argument("--phase", required=True)
    w.add_argument("--next-step", required=True)
    w.add_argument("--gate")
    w.add_argument("--attempt", type=int)
    w.add_argument("--findings-json")
    w.add_argument("--required-check-id")
    w.add_argument("--failed", action="store_true")
    w.add_argument("--recorded-at")
    w.add_argument("--dry-run", action="store_true")
    d = sub.add_parser("delete", help="delete the halt record, and failed with --with-failed")
    d.add_argument("--repo", required=True)
    d.add_argument("--slug", required=True)
    d.add_argument("--item", required=True)
    d.add_argument("--with-failed", metavar="TIP")
    args = ap.parse_args(argv)
    if args.self_test:
        return _run_self_test()
    if args.command is None:
        ap.error("a command is required: write or delete")
    try:
        return cmd_write(args) if args.command == "write" else cmd_delete(args)
    except UsageError as error:
        print(f"halt_record: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.exit(main())
