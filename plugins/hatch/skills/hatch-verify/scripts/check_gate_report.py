# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch gate-report checker: mechanize the report grammar the gate agents already state.

The report rules in agents/hatch-acceptance-reviewer.md and
agents/hatch-safety-auditor.md are checked here, so the
orchestrator can check a returned report before acting on it instead of reading it:

  1. VERDICT AGREEMENT. A report carries exactly one `**Verdict:**` line, its value
     belongs to the dispatched agent's own normative verdict set, and it maps to the
     returned envelope by the table that agent file states:

       acceptance: CONFORMANT -> pass, DEVIATION -> concerns,
                   SPEC-SUSPECT -> blocked, BLOCKED -> blocked
       safety:     PASS -> pass, VIOLATION -> concerns, BLOCKED -> blocked

     A verdict outside the dispatched agent's normative set (CONFORMANT in a safety
     report, PASS in an acceptance report) is itself a finding, never a mapped row —
     it means the wrong agent's grammar came back. A divergence is a finding here,
     mirroring the agents' own "a divergence halts the pipeline" rule.

  2. STACK-PACK PROVENANCE (safety reports only). The mandatory line is present in
     its exact grammar and agrees with the binder:

       Stack-pack check: ran|skipped|blocked - pinned: [<ids>]; resolved: [<ids>]; items judged: <n>

     (with an em dash, not the hyphen shown above). The pinned id list must equal the
     binder's sme[] as a set; `skipped` is legitimate only when sme[] is empty or
     absent; pinned-but-unresolved must read `blocked`, never `skipped`.

  3. IDENTITY AND COVERAGE. The item, range, and SHA-256 of the live Git diff must
     match. Passing acceptance reports disposition every assertion; passing pinned
     safety reports disposition every dispatched rule. Blocked or empty pack
     judgments cannot be promoted into a passing report. These checks bind report
     claims to content; they do not prove the model performed the review.

  4. ROW FORM AND NOTES. The parser is line-based and deliberately not widened; both
     agent files state its rules instead. A safety disposition row is one line, and a
     passing one reads exactly `CONFORMS`. An acceptance row runs from its
     `- assertion <i> — ` start to the next `- assertion ` line or `**` heading, so a
     wrapped row fails its disposition. A safety report's `**Notes (non-blocking):**`
     section is free text here: no row, violation or coverage gap is read from it,
     and a note never changes the verdict. A note that borrows the row shape
     (`- rule <id> — ...`) is still read as a row wherever it sits, which is why the
     safety agent file forbids that shape in Notes.

Stdlib only. Invoked directly (not installed), matching the non-executable mode of
sibling scripts:

Usage:
  python3 skills/hatch-verify/scripts/check_gate_report.py \\
      --agent acceptance|safety --envelope pass|concerns|blocked \\
      --report FILE --binder FILE --item ID --repo DIR --range RANGE [--checklists FILE]
  python3 skills/hatch-verify/scripts/check_gate_report.py --self-test

Exit codes: 0 = no findings, 1 = findings (or self-test failure), 2 = usage error.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# The normative verdict -> envelope tables, transcribed from the agent files.
VERDICT_TABLES: dict[str, dict[str, str]] = {
    "acceptance": {
        "CONFORMANT": "pass",
        "DEVIATION": "concerns",
        "SPEC-SUSPECT": "blocked",
        "BLOCKED": "blocked",
    },
    "safety": {
        "PASS": "pass",
        "VIOLATION": "concerns",
        "BLOCKED": "blocked",
    },
}

ENVELOPES = ("pass", "concerns", "blocked")

VERDICT_LINE_RE = re.compile(r"\*\*Verdict:\*\*(?P<rest>.*)")
WORK_ITEM_LINE_RE = re.compile(r"\*\*Work item id:\*\*(?P<rest>.*)")

# The provenance line's exact grammar, em dash included.
PROVENANCE_PREFIX = "Stack-pack check:"
PROVENANCE_RE = re.compile(
    r"^Stack-pack check:\s+(?P<status>ran|skipped|blocked)\s+—\s+"
    r"pinned:\s+\[(?P<pinned>[^\]]*)\];\s+"
    r"resolved:\s+\[(?P<resolved>[^\]]*)\];\s+"
    r"items judged:\s+(?P<judged>\d+)\s*$"
)


def _id_list(raw: str) -> list[str]:
    """Parse a `[a, b]` body into its ids. An empty body is the empty list."""
    return [part.strip() for part in raw.split(",") if part.strip()]


def check_verdict(report: str, agent: str, envelope: str) -> list[str]:
    """Rule 1 — exactly one verdict line, in this agent's normative set, mapping to
    the envelope."""
    findings: list[str] = []
    table = VERDICT_TABLES[agent]

    matches = [m for m in (VERDICT_LINE_RE.search(line) for line in report.splitlines()) if m]
    if len(matches) != 1:
        findings.append(
            f"verdict: expected exactly one '**Verdict:**' line, found {len(matches)}"
        )
        return findings

    verdict = matches[0].group("rest").strip()
    if verdict not in table:
        known = " | ".join(table)
        other = next(a for a in VERDICT_TABLES if a != agent)
        hint = (
            f" (that is the {other} agent's vocabulary — the wrong agent's grammar came back)"
            if verdict in VERDICT_TABLES[other]
            else ""
        )
        findings.append(
            f"verdict: '{verdict}' is not in the {agent} agent's normative set ({known}){hint}"
        )
        return findings

    expected = table[verdict]
    if expected != envelope:
        findings.append(
            f"verdict: report says {verdict}, which maps to envelope '{expected}', "
            f"but the envelope returned '{envelope}' — the agent file calls a divergence "
            f"a pipeline halt"
        )
    return findings


def check_provenance(report: str, pinned_in_binder: list[str], envelope: str) -> list[str]:
    """Rule 2 — the mandatory stack-pack provenance line, in grammar and in agreement
    with the binder's sme[]. Safety reports only."""
    findings: list[str] = []

    candidates = [line.strip() for line in report.splitlines() if PROVENANCE_PREFIX in line]
    if not candidates:
        findings.append(
            "stack-pack: the mandatory 'Stack-pack check:' provenance line is missing "
            "(the safety agent requires it in every report)"
        )
        return findings
    if len(candidates) > 1:
        findings.append(
            f"stack-pack: expected one 'Stack-pack check:' line, found {len(candidates)}"
        )
        return findings

    m = PROVENANCE_RE.match(candidates[0])
    if not m:
        findings.append(
            "stack-pack: the provenance line does not match its required grammar "
            "'Stack-pack check: ran|skipped|blocked — pinned: [<ids>]; resolved: [<ids>]; "
            f"items judged: <n>' — found: {candidates[0]!r}"
        )
        return findings

    status = m.group("status")
    pinned = _id_list(m.group("pinned"))
    resolved = _id_list(m.group("resolved"))
    binder_set = set(pinned_in_binder)

    if set(pinned) != binder_set:
        findings.append(
            f"stack-pack: the line pins {sorted(set(pinned))} but the binder's sme[] is "
            f"{sorted(binder_set)} — the report must name the packs the binder pins"
        )

    if status == "skipped" and binder_set:
        findings.append(
            f"stack-pack: status 'skipped' is legitimate only when the binder pins no "
            f"sme[]; this binder pins {sorted(binder_set)}"
        )

    unresolved = set(pinned) - set(resolved)
    if unresolved and status != "blocked":
        findings.append(
            f"stack-pack: pinned but unresolved {sorted(unresolved)} must read 'blocked', "
            f"not {status!r}"
        )

    if status == "ran" and not pinned:
        findings.append(
            "stack-pack: status 'ran' with no pinned packs — an empty sme[] reads 'skipped'"
        )

    if status == "blocked" and envelope != "blocked":
        findings.append("stack-pack: a blocked review requires the blocked envelope")
    if status == "ran" and pinned and int(m.group("judged")) == 0:
        findings.append("stack-pack: a completed review of pinned packs must judge their rules")
    if status == "skipped" and (resolved or int(m.group("judged")) != 0):
        findings.append("stack-pack: a skipped review cannot resolve packs or claim judgments")
    if set(resolved) - set(pinned):
        findings.append("stack-pack: resolved ids must belong to the pinned packs")

    return findings


def check_item(report: str, item_id: str, binder: dict) -> list[str]:
    """The report must name exactly the dispatched work item."""
    findings: list[str] = []
    known = [str(i.get("id")) for i in binder.get("work_items", [])]
    if item_id not in known:
        findings.append(f"item: '{item_id}' is not a work item in the binder (have: {known})")
        return findings

    matches = [m for line in report.splitlines() if (m := WORK_ITEM_LINE_RE.fullmatch(line))]
    if len(matches) != 1:
        findings.append("item: report must contain exactly one '**Work item id:**' line")
    elif matches[0].group("rest").strip() != item_id:
        findings.append(f"item: report id is not the dispatched item {item_id!r}")
    return findings


def diff_digest(repo: Path, diff_range: str) -> str:
    """Content identity for the exact diff bytes the reviewer must inspect."""
    if not diff_range or diff_range.startswith("-"):
        raise ValueError("diff range must be a Git revision or range, not an option")
    result = subprocess.run(["git", "-C", str(repo), "diff", "--no-ext-diff",
                             "--no-textconv", "--binary", "--no-color", diff_range, "--"],
                            capture_output=True, check=True, timeout=30)
    return hashlib.sha256(result.stdout).hexdigest()


def check_identity(report: str, expected_range: str | None,
                   expected_digest: str | None) -> list[str]:
    findings = []
    for field, expected in (("Diff range", expected_range), ("Diff SHA256", expected_digest)):
        values = re.findall(r"^\*\*" + field + r":\*\*\s*(\S[^\n]*)$", report, re.M)
        if len(values) != 1:
            findings.append(f"identity: expected exactly one nonempty '{field}' line")
        elif expected is not None and values[0].strip() != expected:
            findings.append(f"identity: {field} does not match the dispatched diff")
        elif field == "Diff SHA256" and not re.fullmatch(r"[0-9a-f]{64}", values[0].strip()):
            findings.append("identity: Diff SHA256 must be a lowercase SHA-256 digest")
    return findings


def check_acceptance_coverage(report: str, binder: dict, item_id: str | None) -> list[str]:
    """Require a passing report to disposition each assertion from the binder."""
    item = next((i for i in binder.get("work_items", []) if i.get("id") == item_id), None)
    if item is None:
        return ["coverage: a passing acceptance report needs a known dispatched item"]
    assertions = item.get("oracle", {}).get("assertions", [])
    rows = re.findall(r"^- assertion (\d+) — (.*?)(?=^- assertion |^\*\*|\Z)", report, re.M | re.S)
    findings = []
    if sorted(int(i) for i, _ in rows) != list(range(len(assertions))):
        findings.append("coverage: disposition every oracle assertion exactly once using its zero-based index")
    for number, body in rows:
        body = body.strip()
        i = int(number)
        if i >= len(assertions):
            continue
        prefix = str(assertions[i]) + " — "
        if not body.startswith(prefix):
            findings.append(f"coverage: assertion {i} does not quote the binder assertion")
            continue
        disposition = body[len(prefix):]
        if disposition == "inspection-verifiable — CONFORMS":
            continue
        if (not re.search(r"\b(DEVIATION|UNDISPOSED)\b", disposition)
                and re.fullmatch(r"execution-required — (covered-by-command|covered-by-test|declared-debt)\s+\S.+", disposition)):
            continue
        findings.append(f"coverage: assertion {i} has no passing disposition with an evidence reference")
    contract = re.search(r"^\*\*Contract conformance:\*\*\s*\n([^*]+)", report, re.M)
    if not contract or not re.search(r"CONFORMS|n/a \(no contract\)", contract[1]) or "DEVIATION" in contract[1]:
        findings.append("coverage: a passing acceptance report needs contract conformance or explicit no-contract disposition")
    elif item.get("contract") and "CONFORMS" not in contract[1]:
        findings.append("coverage: the binder declares a contract; no-contract disposition is invalid")
    return findings


def check_report(report: str, agent: str, envelope: str, binder: dict,
                  item_id: str | None = None, expected_range: str | None = None,
                  expected_digest: str | None = None, expected_rules: list[dict] | None = None) -> list[str]:
    """Run every applicable rule and return the findings, one string each."""
    findings = check_verdict(report, agent, envelope)
    findings += check_identity(report, expected_range, expected_digest)
    if agent == "safety":
        findings += check_provenance(report, list(binder.get("sme") or []), envelope)
        if envelope == "pass" and expected_rules is not None:
            expected_ids = sorted({rule["id"] for rule in expected_rules})
            rows = re.findall(r"^- rule ([\w.-]+) — (.+)$", report, re.M)
            if sorted(i for i, _ in rows) != expected_ids:
                findings.append("coverage: disposition every resolved checklist rule exactly once")
            for rule_id, disposition in rows:
                if not re.fullmatch(r"CONFORMS|OVERRIDE\s+\S.+|NOT-APPLICABLE\s+\S.+", disposition):
                    findings.append(f"coverage: rule {rule_id} needs a passing disposition, override reference, or non-applicability reason")
            provenance = next((PROVENANCE_RE.fullmatch(line.strip()) for line in report.splitlines()
                               if line.strip().startswith(PROVENANCE_PREFIX)), None)
            if provenance and int(provenance.group("judged")) != len(expected_ids):
                findings.append("coverage: items judged must equal the number of distinct resolved rules")
    if item_id is not None:
        findings += check_item(report, item_id, binder)
    if agent == "acceptance" and envelope == "pass" and not findings:
        findings += check_acceptance_coverage(report, binder, item_id)
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

    def report(verdict: str, provenance: str | None = None, extra: str = "") -> str:
        lines = ["## Hatch Boundary Scan: t", "", f"**Verdict:** {verdict}", "",
                 "**Diff range:** base..tip", "**Diff SHA256:** " + "a" * 64,
                 "**Contract conformance:**", "- n/a (no contract)"]
        if "**Work item id:**" not in extra:
            lines.append("**Work item id:** a")
        if provenance is not None:
            lines.append(provenance)
        if extra:
            lines.append(extra)
        return "\n".join(lines) + "\n"

    def prov(status: str, pinned: list[str], resolved: list[str], judged: int) -> str:
        return (f"Stack-pack check: {status} — pinned: [{', '.join(pinned)}]; "
                f"resolved: [{', '.join(resolved)}]; items judged: {judged}")

    empty_binder: dict = {"work_items": [{"id": "a"}]}
    pinned_binder: dict = {"sme": ["p1", "p2"], "work_items": [{"id": "a"}]}

    # (a) a well-formed safety report with a matching envelope passes
    ok = check_report(report("PASS", prov("skipped", [], [], 0)), "safety", "pass", empty_binder)
    check("safety PASS + matching envelope -> clean", ok == [], str(ok))

    # (b) NEGATIVE CONTROL for (a): the same report against a mismatched envelope is a
    #     finding, and the finding is about the verdict mapping (not something else)
    bad = check_report(report("PASS", prov("skipped", [], [], 0)), "safety", "blocked", empty_binder)
    check("safety PASS + 'blocked' envelope -> verdict finding",
          len(bad) == 1 and bad[0].startswith("verdict:") and "maps to envelope 'pass'" in bad[0],
          str(bad))

    # (c) every normative row of both tables maps clean
    rows_ok = all(
        check_report(
            report(v, prov("skipped", [], [], 0) if agent == "safety" else None),
            agent, env, empty_binder, "a",
        ) == []
        for agent, table in VERDICT_TABLES.items()
        for v, env in table.items()
    )
    check("every normative verdict->envelope row maps clean", rows_ok)

    # (d) NEGATIVE CONTROL: a verdict from the other agent's set is a finding about the
    #     normative set, never a mapped row
    alien = check_report(report("CONFORMANT", prov("skipped", [], [], 0)), "safety", "pass",
                         empty_binder)
    check("acceptance verdict in a safety report -> normative-set finding",
          len(alien) == 1 and "not in the safety agent's normative set" in alien[0]
          and "wrong agent's grammar" in alien[0], str(alien))
    alien2 = check_report(report("PASS"), "acceptance", "pass", empty_binder)
    check("safety verdict in an acceptance report -> normative-set finding",
          len(alien2) == 1 and "not in the acceptance agent's normative set" in alien2[0],
          str(alien2))

    # (e) zero and two verdict lines are both findings
    none_f = check_report("no verdict here\n", "acceptance", "pass", empty_binder)
    two_f = check_report("**Verdict:** DEVIATION\n**Verdict:** CONFORMANT\n", "acceptance",
                         "concerns", empty_binder)
    check("missing / duplicated verdict line -> finding",
          "found 0" in none_f[0]
          and "found 2" in two_f[0], f"{none_f} {two_f}")

    # (f) an acceptance report needs no provenance line; a safety report does
    acc = check_report(report("DEVIATION"), "acceptance", "concerns", empty_binder)
    saf = check_report(report("PASS"), "safety", "pass", empty_binder)
    check("provenance line required of safety reports only",
          acc == [] and len(saf) == 1 and saf[0].startswith("stack-pack:")
          and "missing" in saf[0], f"{acc} {saf}")

    # (g) the provenance grammar is exact: an ASCII hyphen for the em dash is a finding
    hyphen = ("Stack-pack check: skipped - pinned: []; resolved: []; items judged: 0")
    g = check_report(report("PASS", hyphen), "safety", "pass", empty_binder)
    check("provenance line with the wrong dash -> grammar finding",
          len(g) == 1 and "does not match its required grammar" in g[0], str(g))

    # (h) pinned ids must equal the binder's sme[] as a set (order-insensitive)
    reordered = check_report(report("PASS", prov("ran", ["p2", "p1"], ["p2", "p1"], 7)),
                             "safety", "pass", pinned_binder)
    wrong = check_report(report("PASS", prov("ran", ["p1"], ["p1"], 4)),
                         "safety", "pass", pinned_binder)
    check("pinned set must equal the binder's sme[]",
          reordered == [] and len(wrong) == 1 and "the binder's sme[] is" in wrong[0],
          f"{reordered} {wrong}")

    # (i) 'skipped' with a pinning binder, and pinned-but-unresolved not reading 'blocked'
    skipped = check_report(report("PASS", prov("skipped", ["p1", "p2"], [], 0)),
                           "safety", "pass", pinned_binder)
    unresolved_ran = check_report(report("PASS", prov("ran", ["p1", "p2"], ["p1"], 3)),
                                  "safety", "pass", pinned_binder)
    unresolved_blocked = check_report(report("BLOCKED", prov("blocked", ["p1", "p2"], ["p1"], 0)),
                                      "safety", "blocked", pinned_binder)
    check("skipped-with-pins and unresolved-not-blocked are findings; blocked is legitimate",
          any("legitimate only when" in f for f in skipped)
          and any("must read 'blocked'" in f for f in unresolved_ran)
          and unresolved_blocked == [],
          f"{skipped} {unresolved_ran} {unresolved_blocked}")

    # (j) 'ran' with no pinned packs is a finding
    ran_empty = check_report(report("PASS", prov("ran", [], [], 0)), "safety", "pass",
                             empty_binder)
    check("'ran' with an empty sme[] -> finding",
          len(ran_empty) == 1 and "reads 'skipped'" in ran_empty[0], str(ran_empty))

    # (k) --item: an unknown id, and a report naming a different item
    unknown = check_report(report("DEVIATION"), "acceptance", "concerns", empty_binder,
                           item_id="nope")
    mismatch = check_report(report("DEVIATION", None, "**Work item id:** b"), "acceptance",
                            "concerns", empty_binder, item_id="a")
    agree = check_report(report("DEVIATION", None, "**Work item id:** a"), "acceptance",
                         "concerns", empty_binder, item_id="a")
    check("--item catches an unknown id and a report naming another item",
          len(unknown) == 1 and "is not a work item" in unknown[0]
          and len(mismatch) == 1 and "is not the dispatched item" in mismatch[0]
          and agree == [], f"{unknown} {mismatch} {agree}")

    # (l) end-to-end through main(): exit 0 clean, 1 on a finding, 2 on a missing file
    tmp = Path(tempfile.mkdtemp(prefix="check_gate_report_selftest_"))
    rpt = tmp / "report.md"
    rpt.write_text(report("PASS", prov("skipped", [], [], 0)), encoding="utf-8")
    bnd = tmp / "binder.json"
    bnd.write_text(json.dumps(empty_binder), encoding="utf-8")
    quiet = io.StringIO()
    from unittest.mock import patch
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet), patch.dict(
            globals(), diff_digest=lambda repo, diff_range: "a" * 64):
        clean = main(["--agent", "safety", "--envelope", "pass", "--report", str(rpt),
                      "--binder", str(bnd), "--item", "a", "--range", "base..tip"])
        finding = main(["--agent", "safety", "--envelope", "concerns", "--report", str(rpt),
                        "--binder", str(bnd), "--item", "a", "--range", "base..tip"])
        usage = main(["--agent", "safety", "--envelope", "pass", "--report", str(tmp / "nope.md"),
                      "--binder", str(bnd), "--item", "a", "--range", "base..tip"])
    check("main() exit codes: 0 clean / 1 findings / 2 unreadable input",
          clean == 0 and finding == 1 and usage == 2, f"{clean} {finding} {usage}")

    # (m) a safety report's Notes section is free text: a passing pinned report with a
    #     note is clean. NEGATIVE CONTROL: the same note written in the disposition-row
    #     shape is read as a second row for the rule, so coverage fails by name.
    one_rule = [{"id": "p1.1", "text": "rule text", "source": "p1"}]
    one_pack: dict = {"sme": ["p1"], "work_items": [{"id": "a"}]}
    rows = "**Checklist dispositions:**\n- rule p1.1 — CONFORMS\n\n**Violations (if any):**\n\n"
    note = ("**Notes (non-blocking):**\n"
            "- [note] [tests/t.py:9] — assertNotEqual(a, b) is redundant: line 8 pins both\n")
    with_note = check_report(report("PASS", prov("ran", ["p1"], ["p1"], 1), rows + note),
                             "safety", "pass", one_pack, expected_rules=one_rule)
    check("a Notes section is free text: no row, violation or coverage gap is read from it",
          with_note == [], str(with_note))
    borrowed = check_report(
        report("PASS", prov("ran", ["p1"], ["p1"], 1),
               rows + note + "- rule p1.1 — redundant assertion at tests/t.py:9\n"),
        "safety", "pass", one_pack, expected_rules=one_rule)
    check("a note shaped like a rule row is read as a row and fails coverage",
          "coverage: disposition every resolved checklist rule exactly once" in borrowed,
          str(borrowed))

    shutil.rmtree(tmp, ignore_errors=True)

    print(f"self-test: {passed}/{total} cases passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="check_gate_report.py",
        description="Check a returned gate report against the grammar its agent file states.",
    )
    ap.add_argument("--agent", choices=sorted(VERDICT_TABLES), help="which gate agent produced the report")
    ap.add_argument("--envelope", choices=ENVELOPES, help="the verdict the return envelope carried")
    ap.add_argument("--report", type=Path, help="path to the returned report")
    ap.add_argument("--binder", type=Path, help="path to the binder JSON")
    ap.add_argument("--item", default=None, help="work item id the gate was dispatched on")
    ap.add_argument("--range", dest="diff_range", help="the dispatched Git diff range")
    ap.add_argument("--repo", type=Path, default=Path.cwd(), help="reviewed worktree")
    ap.add_argument("--checklists", type=Path, help="JSON array of the normalized rules dispatched to safety")
    ap.add_argument("--self-test", action="store_true", help="run embedded fixtures and exit 0/1")
    args = ap.parse_args(argv)

    if args.self_test:
        return _run_self_test()

    missing = [n for n in ("agent", "envelope", "report", "binder", "item", "diff_range") if getattr(args, n) is None]
    if missing:
        ap.error("missing required argument(s): " + ", ".join("--" + n for n in missing))

    try:
        report = args.report.read_text(encoding="utf-8")
    except OSError as e:
        print(f"check_gate_report: cannot read --report: {e}", file=sys.stderr)
        return 2
    try:
        binder = json.loads(args.binder.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"check_gate_report: cannot read --binder: {e}", file=sys.stderr)
        return 2

    try:
        digest = diff_digest(args.repo, args.diff_range)
    except (OSError, ValueError, subprocess.SubprocessError) as e:
        print(f"check_gate_report: cannot identify the dispatched diff: {e}", file=sys.stderr)
        return 2
    rules = None
    if args.agent == "safety" and args.envelope == "pass" and binder.get("sme"):
        try:
            if args.checklists is None:
                raise ValueError("a passing pinned safety review requires --checklists")
            rules = json.loads(args.checklists.read_text(encoding="utf-8"))
            if not isinstance(rules, list) or not rules or any(
                    not isinstance(r, dict) or not isinstance(r.get("id"), str) or not r["id"]
                    or not isinstance(r.get("text"), str) or not isinstance(r.get("source"), str)
                    for r in rules):
                raise ValueError("--checklists must contain the dispatched normalized rule objects")
            by_id = {}
            for rule in rules:
                if rule["id"] in by_id and rule["text"] != by_id[rule["id"]]:
                    raise ValueError("conflicting checklist texts for rule " + rule["id"])
                by_id[rule["id"]] = rule["text"]
        except (OSError, ValueError) as e:
            print(f"check_gate_report: {e}", file=sys.stderr)
            return 2
    findings = check_report(report, args.agent, args.envelope, binder, args.item,
                            args.diff_range, digest, rules)
    for f in findings:
        print(f)
    if findings:
        print(f"check_gate_report: {len(findings)} finding(s)")
        return 1
    print("check_gate_report: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
