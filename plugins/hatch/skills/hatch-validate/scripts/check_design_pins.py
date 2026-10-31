#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Check a committed design capture's bytes against its recorded fingerprint in
.hatch/design-pins.json — one more hard gate in hatch-validate's prerequisites
phase, run before the design is served.

What it proves: capture-against-pin, and capture-against-its-own recapture
date. It never reaches upstream — the living design lives behind agent-invoked
tools with no network access from here — so a pass never claims the pin still
resembles the design it was taken from; that is a human's job, and the run
prints the upstream address and the recapture triggers so the person about to
trust the comparison is reading the terms at the moment they matter.

Seven outcomes, in a deliberate ladder:
  1. bytes match the pin                                -> pass
  2. bytes disagree with the pin                         -> fail (drift)
  3. inside the repo, pin file present, no entry         -> fail
  4. recapture_after has passed                          -> fail
  5. no pin file at all                                  -> fail *
  6. design resolved from outside the repository         -> fail *
  7. malformed pin file (not an object, or an entry
     missing sha256)                                     -> fail

* Rungs 5 and 6 are the two the check could not verify, and they exit non-zero
so a caller gating on the exit status never reads "not verified" as
"verified". --allow-unpinned turns both back into a notice and a pass, for a
repository that has deliberately not pinned its captures.

The check reads. It never rewrites a capture, never rewrites the pin file, and
never deletes anything — restoring a drifted pin, or writing the first one, is
a copy-paste from this script's own printed hash.

Usage:
  uv run skills/hatch-validate/scripts/check_design_pins.py --design-path <path>
  uv run skills/hatch-validate/scripts/check_design_pins.py --design-path <path> --allow-unpinned
  uv run skills/hatch-validate/scripts/check_design_pins.py --self-test
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from datetime import date
from pathlib import Path

# check_design_pins.py sits in the same scripts directory as serve_design.py. The
# caller's design path is not resolved when this runs — it may legally be a
# directory — so this imports serve_design's own resolver rather than
# reimplementing its standalone/non-print preference. Kept here, in the
# prerequisites phase, rather than moved into the serve phase: this is the one
# phase that is already nothing but hard gates.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from serve_design import resolve_design_file  # noqa: E402

PIN_FILE_NAME = ".hatch/design-pins.json"
DRIFT_MESSAGE = "design capture does not match its pin in .hatch/design-pins.json"
UNPINNED_HINT = "Pass --allow-unpinned to accept a capture this check could not verify."
_ENTRY_KEYS = {"sha256", "source", "captured_on", "recapture_triggers", "recapture_after"}


def _sha256(path: Path) -> str:
    """Hash the capture's bytes. An unreadable file raises OSError here; `evaluate` catches it
    and returns, so the caller never sees a traceback out of a check that promises a return."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _unverified(reason: str, allow_unpinned: bool) -> tuple[int, list[str]]:
    """Rungs 5 and 6 — the two outcomes where the check could not verify the capture at all.
    They fail by default: a caller that gates on the exit status reads 0 as "this capture was
    checked", and for these two that is false. --allow-unpinned is the deliberate opt-out for
    a repository that has not pinned its captures, and restores the notice and the pass."""
    if allow_unpinned:
        return 0, [f"NOTICE: {reason}"]
    return 1, [f"{reason} {UNPINNED_HINT}"]


def evaluate(design_path: Path, pin_file: Path, repo_root: Path,
             allow_unpinned: bool = False) -> tuple[int, list[str]]:
    """Run the enforcement ladder for one design path against one pin file,
    rooted at repo_root. Returns (exit_code, lines-to-print). Every outcome is
    a return, never an exception — the caller only prints and exits.

    `allow_unpinned` loosens the two rungs the check cannot verify (no pin file
    at all, a design outside the repository) back to a notice and a pass."""
    # Normalising the root is itself fallible — expanduser raises RuntimeError for a ~user
    # with no home, and resolve can fail on an unreadable component. This runs before any
    # other guard, so without this the contract breaks on the function's first statement.
    try:
        repo_root = repo_root.expanduser().resolve()
    except (OSError, RuntimeError) as e:
        return 1, [f"repository root could not be resolved ({e})"]
    # main resolves this before calling, so this is for a direct caller passing "~/pins.json":
    # unexpanded, .exists() would read it as a literal ./~ directory and report no pin file.
    try:
        pin_file = pin_file.expanduser().resolve()
    except (OSError, RuntimeError) as e:
        return 1, [f"pin file path could not be resolved ({e})"]
    try:
        resolved = resolve_design_file(Path(design_path))
    except SystemExit as e:
        return 1, [str(e)]
    except (OSError, RuntimeError) as e:
        # resolve_design_file raises SystemExit for its own outcomes, but it expanduser()s and
        # stats the path to get there: a stat can fail on an unreadable component (OSError) and
        # a ~user with no home raises RuntimeError. Both reach here, so both become returns —
        # the same two the repo root is guarded against, on the third path argument.
        return 1, [f"design path could not be resolved ({e})"]

    try:
        inside = resolved.is_relative_to(repo_root)
    except ValueError:
        inside = False

    if not inside:
        return _unverified(f"{resolved} is outside the repository ({repo_root}); "
                           f"it cannot be pinned and was not verified.", allow_unpinned)

    rel = resolved.relative_to(repo_root).as_posix()

    # Hashed once here rather than at each rung that wants it. An unreadable capture is not a
    # ladder outcome — it is the ladder having nothing to run on — so it becomes an ordinary
    # error return at the one place the bytes are read.
    try:
        digest = _sha256(resolved)
    except OSError as e:
        return 1, [f"{rel}: design capture could not be read ({e})"]

    if not pin_file.exists():
        return _unverified(f"no {PIN_FILE_NAME} found; {rel} was not verified "
                           f"(sha256={digest}).", allow_unpinned)

    try:
        raw = json.loads(pin_file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return 1, [f"malformed pin file {PIN_FILE_NAME}: invalid JSON ({e})"]

    if not isinstance(raw, dict):
        return 1, [f"malformed pin file {PIN_FILE_NAME}: top level must be an object "
                   f"(design path -> pin record)"]

    for key, val in raw.items():
        if not isinstance(val, dict) or not isinstance(val.get("sha256"), str) or not val.get("sha256"):
            return 1, [f"malformed pin file {PIN_FILE_NAME}: entry for '{key}' is missing 'sha256'"]

    entry = raw.get(rel)
    if entry is None:
        return 1, [f"{rel} has no pin in {PIN_FILE_NAME} (sha256={digest}) — this "
                   f"repository pins its design captures, and this one has no entry."]

    # Keyed on the value being non-null, not on it being truthy. `null` is how JSON writes
    # "absent", so a generator that always emits the key still means no deadline. 0, "" and
    # false are not ways of writing that — they are a deadline someone got wrong, and reading
    # them as "no deadline" would let a pin outlive the life its author tried to give it,
    # which is the one thing this rung exists to stop.
    if entry.get("recapture_after") is not None:
        recapture_after = entry["recapture_after"]
        if not isinstance(recapture_after, str) or not recapture_after:
            return 1, [f"malformed pin file {PIN_FILE_NAME}: entry for '{rel}' has an "
                       f"invalid recapture_after date '{recapture_after}'"]
        try:
            deadline = date.fromisoformat(recapture_after)
        except ValueError:
            return 1, [f"malformed pin file {PIN_FILE_NAME}: entry for '{rel}' has an "
                       f"invalid recapture_after date '{recapture_after}'"]
        if date.today() > deadline:
            return 1, [f"{rel} pin has expired: recapture_after {recapture_after} has "
                       f"passed — recapture the design before trusting this comparison."]

    pinned = entry["sha256"]
    if digest != pinned:
        return 1, [f"{rel}: {DRIFT_MESSAGE}",
                   f"  pinned sha256={pinned}",
                   f"  actual sha256={digest}"]

    lines = [f"PASS: {rel} matches its pin (sha256={digest})",
             f"  captured:   {entry.get('captured_on', '(not recorded)')}",
             f"  source:     {entry.get('source', '(not recorded)')}"]
    # Deliberately laxer than recapture_after above, which hard-fails on "". A deadline is
    # safety-critical — getting it wrong lets a pin outlive its stated life — while triggers
    # are a note to a human, so a malformed one is shown rather than made a failure.
    # Only a list is iterated. A scalar here would raise straight out of the PASS branch,
    # and a bare string would iterate per character into nonsense — both on a capture whose
    # digest matched, which is the one outcome that must not end in a traceback.
    triggers = entry.get("recapture_triggers")
    if isinstance(triggers, list) and triggers:
        shown = ", ".join(str(t) for t in triggers)
    elif isinstance(triggers, str) and triggers:
        shown = triggers
    elif triggers is None or triggers == [] or triggers == "":
        shown = "(none recorded)"
    else:
        shown = f"(malformed: {triggers!r})"
    lines.append(f"  recapture_triggers: {shown}")
    return 0, lines


def _self_test() -> int:
    """Each of the seven ladder outcomes, plus the two directory-path cases and the
    unreadable capture, gets its own fixture built in a temporary directory at run
    time and committed nowhere — the passing and failing fixtures differ only in the
    byte, the date, or the flag that should decide the outcome."""
    total = 0
    failures = 0

    def record(name: str, ok: bool, detail: str = "") -> None:
        nonlocal total, failures
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + ("" if ok else f" — {detail}"))
        total += 1
        failures += 0 if ok else 1

    import contextlib, os

    @contextlib.contextmanager
    def homeless_user():
        """Make `~nosuchuser0987` raise on expanduser, as it does on POSIX. Windows never
        raises there — it guesses a sibling of the current home — so without this cases
        14 and 15 would test a path that resolves, not one that cannot."""
        if os.name != "nt":
            yield
            return
        real = Path.expanduser

        def expanduser(self: Path) -> Path:
            if str(self).startswith("~nosuchuser0987"):
                raise RuntimeError("Could not determine home directory.")
            return real(self)

        Path.expanduser = expanduser  # type: ignore[method-assign]
        try:
            yield
        finally:
            Path.expanduser = real  # type: ignore[method-assign]

    with tempfile.TemporaryDirectory() as td:
        root = Path(td).resolve()
        good_bytes = b"<!doctype html><title>ok</title>"
        good_hash = hashlib.sha256(good_bytes).hexdigest()
        pin_file = root / ".hatch" / "design-pins.json"
        pin_file.parent.mkdir(parents=True)

        # 1. bytes match the pin -> pass, printing capture date, source, triggers.
        design = root / "design.html"
        design.write_bytes(good_bytes)
        pin_file.write_text(json.dumps({"design.html": {
            "sha256": good_hash, "source": "claude-design://x", "captured_on": "2026-01-01",
            "recapture_triggers": ["the export changes"]}}), encoding="utf-8")
        code, lines = evaluate(design, pin_file, root)
        blob = "\n".join(lines)
        ok = (code == 0 and "PASS" in blob and "2026-01-01" in blob
              and "claude-design://x" in blob and "the export changes" in blob)
        record("a capture whose bytes match its pin passes, printing its capture date, "
               "upstream address, and recapture triggers", ok, f"{code=} {lines=}")

        # 2. bytes disagree with the pin -> fail with the exact drift clause + both hashes.
        drifted = root / "drifted.html"
        drifted.write_text("<!doctype html><title>different</title>", encoding="utf-8")
        pin_file.write_text(json.dumps({"drifted.html": {"sha256": good_hash}}), encoding="utf-8")
        code, lines = evaluate(drifted, pin_file, root)
        blob = "\n".join(lines)
        ok = code == 1 and DRIFT_MESSAGE in blob and "pinned sha256=" in blob and "actual sha256=" in blob
        record("a capture whose bytes differ from its pin fails with the runbook's exact "
               "clause and prints both hashes", ok, f"{code=} {lines=}")

        # 3. inside the repo, pin file present, no entry of its own -> fail, naming the
        #    path and printing its hash (one of the three hash-printing outcomes).
        unpinned = root / "unpinned.html"
        unpinned.write_bytes(good_bytes)
        pin_file.write_text(json.dumps({"design.html": {"sha256": good_hash}}), encoding="utf-8")
        code, lines = evaluate(unpinned, pin_file, root)
        blob = "\n".join(lines)
        ok = code == 1 and "unpinned.html" in blob and "no pin" in blob and "sha256=" in blob
        record("a design inside the repo with a pin file present but no entry of its own "
               "fails, naming the path and printing its hash", ok, f"{code=} {lines=}")

        # 4. recapture_after passed -> fail naming the date; the same entry with no
        #    recapture_after key passes, so the rung is opt-in.
        expired = root / "expired.html"
        expired.write_bytes(good_bytes)
        pin_file.write_text(json.dumps({"expired.html": {"sha256": good_hash,
                                                          "recapture_after": "2000-01-01"}}), encoding="utf-8")
        code_a, lines_a = evaluate(expired, pin_file, root)
        ok_a = code_a == 1 and "recapture_after" in "\n".join(lines_a) and "2000-01-01" in "\n".join(lines_a)
        pin_file.write_text(json.dumps({"expired.html": {"sha256": good_hash}}), encoding="utf-8")
        code_b, lines_b = evaluate(expired, pin_file, root)
        ok_b = code_b == 0
        record("a pin whose recapture_after date has passed fails naming that date, and "
               "the same entry with no recapture_after key passes", ok_a and ok_b,
               f"{code_a=} {lines_a=} {code_b=} {lines_b=}")

        # 5. no pin file at all -> fail, naming the design and printing its hash (the
        #    third hash-printing outcome), because nothing here was verified. The twin is
        #    the same call under --allow-unpinned, which is the notice and the pass.
        no_pinfile_design = root / "no-pinfile.html"
        no_pinfile_design.write_bytes(good_bytes)
        missing_pin_file = root / "does-not-exist.json"
        code_a, lines_a = evaluate(no_pinfile_design, missing_pin_file, root)
        blob_a = "\n".join(lines_a)
        ok_a = (code_a == 1 and "no-pinfile.html" in blob_a and "sha256=" in blob_a
                and "--allow-unpinned" in blob_a)
        code_b, lines_b = evaluate(no_pinfile_design, missing_pin_file, root, allow_unpinned=True)
        blob_b = "\n".join(lines_b)
        ok_b = code_b == 0 and "NOTICE" in blob_b and "no-pinfile.html" in blob_b and "sha256=" in blob_b
        record("a repository with no pin file at all fails, naming the design it did not "
               "verify and its hash, and passes with a notice under --allow-unpinned",
               ok_a and ok_b, f"{code_a=} {lines_a=} {code_b=} {lines_b=}")

        # 6. design resolved from outside the repository -> fail, for the same reason: no
        #    fingerprint it could ever have had. Its twin is the same --allow-unpinned pass.
        with tempfile.TemporaryDirectory() as outside_td:
            outside_design = Path(outside_td) / "outside.html"
            outside_design.write_bytes(good_bytes)
            code_a, lines_a = evaluate(outside_design, pin_file, root)
            blob_a = "\n".join(lines_a)
            ok_a = (code_a == 1 and "outside the repository" in blob_a
                    and "cannot be pinned" in blob_a and "--allow-unpinned" in blob_a)
            code_b, lines_b = evaluate(outside_design, pin_file, root, allow_unpinned=True)
            blob_b = "\n".join(lines_b)
            ok_b = code_b == 0 and "NOTICE" in blob_b and "outside the repository" in blob_b
            record("a design resolved from outside the repository fails saying it cannot be "
                   "pinned, and passes with a notice under --allow-unpinned",
                   ok_a and ok_b, f"{code_a=} {lines_a=} {code_b=} {lines_b=}")

        # 7. malformed pin file — not an object, or an entry missing sha256 — is
        #    reported as malformed and NEVER as a matching capture.
        mal_ok = True
        mal_detail = ""
        for text in ("[1, 2, 3]", json.dumps({"design.html": {"source": "x"}})):
            pin_file.write_text(text, encoding="utf-8")
            code, lines = evaluate(design, pin_file, root)
            blob = "\n".join(lines)
            if not (code == 1 and "malformed pin file" in blob and "PASS" not in blob):
                mal_ok = False
                mal_detail = f"{text=} {code=} {lines=}"
        record("a malformed pin file — not an object, or an entry missing sha256 — is "
               "reported as malformed and never as a matching capture", mal_ok, mal_detail)

        # 8/9. a directory-valued design path is resolved through serve_design's own
        # resolve_design_file before anything is hashed, so the check pins the file
        # the serve step will actually serve — one case where the chosen file is
        # pinned, one where it has drifted.
        subdir = root / "sub"
        subdir.mkdir()
        chosen = subdir / "demo.standalone.html"
        chosen.write_bytes(good_bytes)
        rel_chosen = chosen.relative_to(root).as_posix()
        pin_file.write_text(json.dumps({rel_chosen: {"sha256": good_hash}}), encoding="utf-8")
        code, lines = evaluate(subdir, pin_file, root)
        ok = code == 0 and "PASS" in "\n".join(lines)
        record("a directory-valued design path resolves through resolve_design_file "
               "before hashing, and a pinned chosen file passes", ok, f"{code=} {lines=}")

        pin_file.write_text(json.dumps({rel_chosen: {"sha256": "0" * 64}}), encoding="utf-8")
        code, lines = evaluate(subdir, pin_file, root)
        ok = code == 1 and DRIFT_MESSAGE in "\n".join(lines)
        record("the same directory-valued path fails when the file resolve_design_file "
               "chooses has drifted from its pin", ok, f"{code=} {lines=}")

        # 10. a capture whose bytes cannot be read comes back as an ordinary error return,
        #     never a traceback out of read_bytes() — evaluate's contract is that every
        #     outcome is a return. Two shapes of the same OSError: a dangling symlink the
        #     directory resolver still picks (which binds under any uid), and a mode-000
        #     file (the permission case, dropped where the running uid ignores file modes).
        #     The compliant twin is the identical capture readable, which passes its pin.
        broken_dir = root / "broken-capture"
        broken_dir.mkdir()
        (broken_dir / "gone.html").symlink_to(root / "never-written.html")
        unreadable_targets = [broken_dir]
        mode000 = root / "mode000.html"
        mode000.write_bytes(good_bytes)
        mode000.chmod(0o000)
        try:
            mode000.read_bytes()
        except OSError:
            unreadable_targets.append(mode000)
        else:
            mode000.chmod(0o644)
        unread_ok, unread_detail = True, ""
        for target in unreadable_targets:
            try:
                code, lines = evaluate(target, pin_file, root)
            except Exception as e:  # the traceback this guard exists to stop
                code, lines = -1, [f"raised {e!r}"]
            if not (code == 1 and "could not be read" in "\n".join(lines)):
                unread_ok, unread_detail = False, f"{target=} {code=} {lines=}"
        mode000.chmod(0o644)
        readable_twin = root / "readable-twin.html"
        readable_twin.write_bytes(good_bytes)
        pin_file.write_text(json.dumps({"readable-twin.html": {"sha256": good_hash}}), encoding="utf-8")
        code, lines = evaluate(readable_twin, pin_file, root)
        twin_ok = code == 0 and "PASS" in "\n".join(lines)
        record("a capture whose bytes cannot be read returns a clean error rather than a "
               "traceback, and the same bytes readable pass their pin",
               unread_ok and twin_ok, unread_detail or f"{code=} {lines=}")

        # 11. A scalar `recapture_triggers` on a capture whose digest MATCHES must not
        #     escape as a TypeError out of the PASS branch — a matching capture is the one
        #     outcome that must never end in a traceback. The compliant twin is a real list,
        #     which still prints its triggers.
        trig = root / "trig.html"
        trig.write_bytes(good_bytes)
        scalar_ok, scalar_detail = True, ""
        for bad in (5, True, "one-string"):
            pin_file.write_text(json.dumps(
                {"trig.html": {"sha256": good_hash, "recapture_triggers": bad}}), encoding="utf-8")
            try:
                code, lines = evaluate(trig, pin_file, root)
            except Exception as e:  # the traceback this guard exists to stop
                code, lines = -1, [f"raised {e!r}"]
            if code != 0:
                scalar_ok, scalar_detail = False, f"{bad=} {code=} {lines=}"
        pin_file.write_text(json.dumps(
            {"trig.html": {"sha256": good_hash, "recapture_triggers": ["export changed"]}}), encoding="utf-8")
        code, lines = evaluate(trig, pin_file, root)
        list_ok = code == 0 and "export changed" in "\n".join(lines)
        record("a scalar recapture_triggers on a matching capture returns instead of raising, "
               "and a real list still prints its triggers",
               scalar_ok and list_ok, scalar_detail or f"{code=} {lines=}")

        # 12. `recapture_after` is keyed on presence, not truthiness: a falsy-but-present
        #     value is a deadline written down wrong and must fail as malformed, not pass as
        #     "no deadline". The compliant twin is the same entry with the key absent.
        exp = root / "exp.html"
        exp.write_bytes(good_bytes)
        falsy_ok, falsy_detail = True, ""
        for bad in (0, "", False):
            pin_file.write_text(json.dumps(
                {"exp.html": {"sha256": good_hash, "recapture_after": bad}}), encoding="utf-8")
            code, lines = evaluate(exp, pin_file, root)
            if not (code == 1 and "invalid recapture_after" in "\n".join(lines)):
                falsy_ok, falsy_detail = False, f"{bad=} {code=} {lines=}"
        pin_file.write_text(json.dumps({"exp.html": {"sha256": good_hash}}), encoding="utf-8")
        code, lines = evaluate(exp, pin_file, root)
        absent_ok = code == 0
        record("a falsy-but-present recapture_after fails as malformed, and the same entry "
               "with the key absent passes",
               falsy_ok and absent_ok, falsy_detail or f"{code=} {lines=}")

        # 13. `recapture_after: null` is how JSON writes "absent", so a generator that always
        #     emits the key still means no deadline — it must pass, unlike the falsy values
        #     above. The violating twin is the same entry with a real expired date.
        pin_file.write_text(json.dumps({"exp.html": {"sha256": good_hash,
                                                     "recapture_after": None}}), encoding="utf-8")
        code, lines = evaluate(exp, pin_file, root)
        null_ok = code == 0
        pin_file.write_text(json.dumps({"exp.html": {"sha256": good_hash,
                                                     "recapture_after": "2000-01-01"}}), encoding="utf-8")
        code_x, lines_x = evaluate(exp, pin_file, root)
        expired_ok = code_x == 1 and "expired" in "\n".join(lines_x)
        record("a null recapture_after reads as no deadline and passes, while a real expired "
               "date on the same entry still fails",
               null_ok and expired_ok, f"{code=} {lines=} {code_x=} {lines_x=}")

        # 14. Resolving the caller's own paths is fallible before any rung runs — expanduser
        #     raises RuntimeError for a ~user with no home. The check promises a return, so
        #     that is an ordinary error; the compliant twin is the same call on a real root.
        try:
            with homeless_user():
                code, lines = evaluate(exp, pin_file, Path("~nosuchuser0987/x"))
        except Exception as e:  # the traceback this guard exists to stop
            code, lines = -1, [f"raised {e!r}"]
        bad_root_ok = code == 1 and "could not be resolved" in "\n".join(lines)
        pin_file.write_text(json.dumps({"exp.html": {"sha256": good_hash}}), encoding="utf-8")
        code_g, lines_g = evaluate(exp, pin_file, root)
        good_root_ok = code_g == 0
        record("an unresolvable repo root returns a clean error rather than a traceback, and "
               "a real root on the same capture passes",
               bad_root_ok and good_root_ok, f"{code=} {lines=} {code_g=} {lines_g=}")

        # 15. The design path is the third fallible argument, and the one the round-4 panel
        #     found unguarded because rounds 2-3 fixtured the other two and not this. It is
        #     the same failure — resolve_design_file expanduser()s, so a ~user with no home
        #     raises RuntimeError — so it gets the same paired fixture.
        try:
            with homeless_user():
                code, lines = evaluate(Path("~nosuchuser0987/x.html"), pin_file, root)
        except Exception as e:  # the traceback this guard exists to stop
            code, lines = -1, [f"raised {e!r}"]
        bad_design_ok = code == 1 and "could not be resolved" in "\n".join(lines)
        pin_file.write_text(json.dumps({"exp.html": {"sha256": good_hash}}), encoding="utf-8")
        code_d, lines_d = evaluate(exp, pin_file, root)
        good_design_ok = code_d == 0
        record("an unresolvable design path returns a clean error rather than a traceback, and "
               "a real path on the same root passes",
               bad_design_ok and good_design_ok, f"{code=} {lines=} {code_d=} {lines_d=}")

    print(f"self-test: {total - failures}/{total} cases passed")
    if total != 15:
        print(f"FAIL: expected exactly 15 self-test cases, ran {total} "
              f"(the seven ladder outcomes, of which the malformed pin file is the "
              f"seventh, plus the two directory-path cases, the unreadable capture, the "
              f"two malformed-metadata cases, the null-deadline case and the "
              f"unresolvable-root case and the unresolvable-design-path case)")
        return 1
    return 1 if failures else 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=f"Check a design capture's bytes against its recorded pin in {PIN_FILE_NAME}.")
    parser.add_argument("--design-path", help="Design HTML file or directory containing one.")
    parser.add_argument("--pin-file", help=f"Path to the pin file. Defaults to {PIN_FILE_NAME} "
                        "resolved from the repo root.")
    parser.add_argument("--repo-root", help="Repository root the pin file and the resolved "
                        "design path are checked against. Defaults to the current working "
                        "directory.")
    parser.add_argument("--allow-unpinned", action="store_true",
                        help="Accept a capture this check could not verify — no pin file at "
                             "all, or a design resolved from outside the repository — as a "
                             "pass with a notice instead of a failure.")
    parser.add_argument("--self-test", action="store_true", help="Run the embedded fixtures and exit.")
    args = parser.parse_args()

    if args.self_test:
        raise SystemExit(_self_test())
    if not args.design_path:
        parser.error("--design-path is required unless --self-test is used")

    # main resolves the two path arguments before evaluate sees them, so evaluate's own guard
    # cannot cover this: expanduser raises RuntimeError for a ~user with no home, and resolve
    # can fail on an unreadable component. A bad argument is an exit-1 message, not a traceback.
    try:
        repo_root = (Path(args.repo_root).expanduser().resolve() if args.repo_root
                     else Path.cwd().resolve())
        pin_file = (Path(args.pin_file).expanduser().resolve() if args.pin_file
                    else repo_root / ".hatch" / "design-pins.json")
    except (OSError, RuntimeError) as e:
        print(f"path argument could not be resolved ({e})")
        raise SystemExit(1)

    code, lines = evaluate(Path(args.design_path), pin_file, repo_root,
                           allow_unpinned=args.allow_unpinned)
    for line in lines:
        print(line)
    raise SystemExit(code)


if __name__ == "__main__":
    main()
