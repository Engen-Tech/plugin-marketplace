# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch mutation sweep: show which product check sites a test command actually catches.

A check that never fails against a broken input is not known to work. This sweep
takes one or more PRODUCT files that hold checks (a validator rule, a hook denial, a
regression guard, the production checks of a script that carries its own
self-test), neutralizes each check site in turn, runs the tests or the self-test
that should catch it, puts the file back byte for byte, and reports every site the
command still passed with. A caught site made the command fail once its check was
gone, so some test exercises it. An uncaught site has no failing case: write the
negative control the command is missing (a violating fixture, a mutation, or a
known-bad input that makes a test hit that check).

Sweep product files only. A test file's assertions, and the assertions inside a
self-test, are not sites: neutralizing one only makes its own test pass, so it
always reads UNCAUGHT, and that says nothing about the code under test. A test or
self-test assertion is proven by its negative control, a case that makes it fail,
which a reader finds in the diff. In a script that carries its own self-test, point
--site-re at the product's check calls so the self-test's own lines are not swept.

The report is plain text, one line per site, flushed as each run finishes:

  mutation sweep: command <command> in <cwd>
  file <path> sha256 <hex of the unmodified bytes> sites <n>
  [CAUGHT] <path>:<line> — <site> — exit <n> | timed out after <s>s
  [UNCAUGHT] <path>:<line> — <site> — the command still passed with this check neutralized
  [UNSWEPT] <path>:<line> — <site> — <why the site could not be neutralized safely>
  mutation sweep: <c> caught, <u> uncaught, <s> unswept of <n> sites

The sha256 lines let a reader who cannot run code (the safety auditor) tie the
report to the exact bytes at the reviewed tip: `git show <tip>:<path> | sha256sum`.

Exit codes: 0 = every site in scope is caught; 1 = at least one site is UNCAUGHT or
UNSWEPT (or a self-test failure); 2 = usage or setup error: no site matched, a file
could not be read or parsed, the command fails on the unmodified files (a failing
baseline would make every site look caught), or the sweep was interrupted.

What a site is, per file type:

  * Python (.py): an `assert` statement, or an expression, `return` or `raise`
    statement, whose source text matches --site-re. The default --mode for Python
    is noop: the statement is replaced at its exact syntax-tree span by `pass`.
    Commenting out one line of a multi-line call, or the only statement of a block,
    leaves a file that no longer parses, and the failing import would read as
    "caught". --mode comment comments out every line of the span instead. Either
    way the neutralized file is parsed first, and one that does not parse is
    UNSWEPT, never CAUGHT.
  * JavaScript and TypeScript (.js .mjs .cjs .jsx .ts .mts .cts .tsx): a line that
    matches --site-re and is not a comment, an import, a declaration
    (const/let/var) or a function or class header. The site runs on over the next
    lines while its brackets stay open. A site whose line closes a bracket opened
    before it (`} else fail(...)`) is UNSWEPT, because neutralizing it would cut
    the enclosing block. The default --mode is comment (`// ` before each line of
    the site); --mode noop puts `void 0;` in its place.

This script cannot parse JavaScript, so there a neutralized site that breaks the
file's syntax still reads as caught; the bracket rule removes the common case, not
every case. Point --site-re at the product's own check calls (for example
`errors\\.append\\(` in a validator). The default matches product check forms
only: a bare `assert`, a bare `assert*(` helper, and bare `fail(` and `check(`
calls. A callee reached through a dot is a test-side form and never matches:
`self.assert*`, `self.fail(`, `expect(`, node:assert's `assert.equal(` /
`assert.ok(` family, and a self-test's own `self.check(` or method `check(`.
Neutralizing a test-side form only makes its own test pass, so it is proven by
its negative control, never by the sweep. A self-test that calls a bare `check(`
helper still matches; point --site-re at the product's calls in that file.

A target that is a symbolic link is refused by name: the sweep would change the
file the link points to, which is not the file it was given.

With --changed-since REV only sites on lines the working tree adds or changes
against REV are swept, and a file git does not track counts as wholly new. Use the
item's integration tip, so the sweep covers the checks this diff adds.

The file is restored after every run and again on every exit path: an exception,
a per-run timeout, SIGINT, SIGTERM and (on POSIX) SIGHUP. A signal that arrives
while a file is being written waits until the write is done. Each restore is read
back and compared with the original bytes. SIGKILL and power loss cannot be
intercepted; at most one site of one file is neutralized at any moment, and the
report line printed last names the site before it.

The command runs like an oracle command (sh -c on POSIX, cmd.exe /d /s /c on
Windows) in its own process group, with PYTHONDONTWRITEBYTECODE=1 so a sweep over a
mirrored tree leaves no bytecode behind. Its output goes to a temporary file, never
a pipe, and only the end of a failing baseline's output is shown. On a timeout the
whole process tree is killed (killpg on POSIX, taskkill /T on Windows).

Stdlib only. Invoked directly (not installed), matching the non-executable mode of
sibling scripts:

Usage:
  python3 skills/hatch-build/scripts/mutation_sweep.py --command '<test command>' \\
      [--cwd DIR] [--site-re REGEX] [--mode auto|comment|noop] \\
      [--changed-since REV] [--timeout SECONDS] FILE [FILE ...]
  python3 skills/hatch-build/scripts/mutation_sweep.py --self-test
"""
from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import io
import os
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

sys.dont_write_bytecode = True

# Product check forms only: a bare assert (a Python statement, or a bare assert( call),
# a bare assertX*( helper, and a bare fail( or check( call. A callee reached through a
# dot is left out, so test-side forms never match: self.assert*, self.fail(, expect(,
# node:assert's assert.x( family (assert.equal(, assert.ok(, assert.fail(), and a
# self-test's own self.check( or obj.check(. A test or self-test assertion is never a
# sweep site, because neutralizing it only makes its own test pass; it is proven by its
# negative control instead.
DEFAULT_SITE_RE = (r"(?<![\w.])assert\b(?!\s*\.)|(?<![\w.])assert[A-Z_]\w*\s*\("
                   r"|(?<![\w.])(?:fail|check)\s*\(")
PYTHON_SUFFIXES = frozenset({".py"})
JS_SUFFIXES = frozenset({".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"})
PY_SITE_TYPES = (ast.Assert, ast.Expr, ast.Return, ast.Raise)
JS_SKIP_RE = re.compile(r"^(?://|/\*|\*)|^(?:import|export)\b|^(?:const|let|var)\b"
                        r"|^(?:async\s+)?function\b|^class\b")
MAX_SPAN = 200            # lines a JavaScript site may run over before it is UNSWEPT
OUTPUT_TAIL = 2000        # bytes of a failing baseline's output shown on stderr
BOM = b"\xef\xbb\xbf"


class SweepError(Exception):
    """A usage or setup problem: reported on stderr, exit 2."""


class Interrupted(BaseException):
    """A signal arrived; raised so every `finally` restores its file."""


@dataclass
class Site:
    line: int
    text: str
    mutated: bytes | None = None
    reason: str | None = None


@dataclass
class SweepFile:
    path: Path
    display: str
    data: bytes
    sha256: str
    mode: int
    sites: list[Site] = field(default_factory=list)


# ---------------------------------------------------------------- signals and writes

_critical = 0
_deferred: list[int] = []


def _on_signal(signum, _frame) -> None:
    if _critical:
        _deferred.append(signum)
        return
    raise Interrupted(signum)


@contextlib.contextmanager
def _uninterrupted():
    """Hold off a signal until the write in progress is complete."""
    global _critical
    _critical += 1
    try:
        yield
    finally:
        _critical -= 1
        if not _critical and _deferred:
            raise Interrupted(_deferred.pop(0))


def _write(path: Path, data: bytes) -> None:
    with _uninterrupted():
        path.write_bytes(data)


def _restore(f: SweepFile) -> None:
    """Put the original bytes back and prove they are back. A file the command
    deleted is recreated, with its original mode."""
    with _uninterrupted():
        try:
            current = f.path.read_bytes()
        except FileNotFoundError:
            current = None
        if current != f.data:
            f.path.parent.mkdir(parents=True, exist_ok=True)
            f.path.write_bytes(f.data)
            if current is None:
                os.chmod(f.path, f.mode)
        if f.path.read_bytes() != f.data:
            raise SweepError(f"{f.path}: the restored bytes differ from the original")


@contextlib.contextmanager
def _signals_restore_files():
    names = ["SIGINT", "SIGTERM"] + (["SIGHUP"] if os.name != "nt" else [])
    previous = {}
    for name in names:
        sig = getattr(signal, name, None)
        if sig is not None:
            with contextlib.suppress(ValueError, OSError):   # not the main thread
                previous[sig] = signal.signal(sig, _on_signal)
    try:
        yield
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


# ---------------------------------------------------------------- running the command

def run_command(command: str, cwd: Path, timeout: float) -> tuple[int | None, bool, str]:
    """(exit status or None on a timeout, timed out, end of the combined output)."""
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    with tempfile.TemporaryFile() as out:
        if os.name == "nt":
            shell = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "cmd.exe")
            # /s strips exactly the outer pair, so the command keeps its own quoting.
            proc = subprocess.Popen(f'"{shell}" /d /s /c "{command}"', cwd=str(cwd), env=env,
                                    stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
        else:
            proc = subprocess.Popen(["sh", "-c", command], cwd=str(cwd), env=env,
                                    stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                    start_new_session=True)
        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        finally:
            _stop_tree(proc)
        out.seek(0, os.SEEK_END)
        out.seek(max(0, out.tell() - OUTPUT_TAIL))
        tail = out.read().decode("utf-8", "replace")
    return (None if timed_out else proc.returncode), timed_out, tail


def _stop_tree(proc: subprocess.Popen) -> None:
    """Kill whatever is left of the command's process tree, then reap it."""
    if os.name == "nt":
        if proc.poll() is None:
            taskkill = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"
            with contextlib.suppress(OSError, subprocess.SubprocessError):
                subprocess.run([str(taskkill), "/F", "/T", "/PID", str(proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    else:
        # start_new_session made the shell's pid the group id; a descendant left
        # running could rewrite the file after it is restored.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(proc.pid, signal.SIGKILL)
    with contextlib.suppress(subprocess.TimeoutExpired):
        proc.wait(timeout=10)


# ---------------------------------------------------------------- finding sites

def _line_starts(data: bytes) -> list[int]:
    """Byte offset where each line starts; index 0 is line 1. Python's tokenizer and
    bytes.splitlines agree on the three line ends: \\n, \\r\\n and \\r."""
    starts = [0]
    for line in data.splitlines(keepends=True):
        starts.append(starts[-1] + len(line))
    return starts


def _ending(line: bytes) -> bytes:
    for end in (b"\r\n", b"\n", b"\r"):
        if line.endswith(end):
            return end
    return b""


def _indent(line: bytes) -> bytes:
    return line[:len(line) - len(line.lstrip(b" \t"))]


def _first_line(text: str) -> str:
    first = text.strip().splitlines()[0].strip() if text.strip() else ""
    return first if len(first) <= 96 else first[:93] + "..."


def python_sites(data: bytes, site_re: re.Pattern, mode: str,
                 scope: set[int] | None) -> list[Site]:
    try:
        tree = ast.parse(data)
    except SyntaxError as e:
        raise SweepError(f"does not parse as Python: {e}") from e
    starts = _line_starts(data)
    lines = data.splitlines(keepends=True)
    shift = len(BOM) if data.startswith(BOM) else 0   # col offsets on line 1 skip the BOM
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, PY_SITE_TYPES):
            continue
        if isinstance(node, ast.Expr) and not isinstance(node.value, (ast.Call, ast.Await)):
            continue                                   # a docstring or a bare name
        if isinstance(node, ast.Return) and node.value is None:
            continue
        first, last = node.lineno, node.end_lineno
        if scope is not None and not scope.intersection(range(first, last + 1)):
            continue
        start = starts[first - 1] + node.col_offset + (shift if first == 1 else 0)
        end = starts[last - 1] + node.end_col_offset + (shift if last == 1 else 0)
        source = data[start:end].decode("utf-8", "replace")
        if not site_re.search(source):
            continue
        if mode == "noop":
            mutated = data[:start] + b"pass" + data[end:]
        else:
            body = b"".join(_indent(l) + b"# " + l[len(_indent(l)):] for l in lines[first - 1:last])
            mutated = b"".join(lines[:first - 1]) + body + b"".join(lines[last:])
        site = Site(first, _first_line(source))
        try:
            ast.parse(mutated)
        except SyntaxError:
            site.reason = "the neutralized file does not parse, so a failing run would prove nothing"
        else:
            site.mutated = mutated
        found.append((first, node.col_offset, site))
    return [site for _, _, site in sorted(found, key=lambda t: (t[0], t[1]))]


def _js_span(lines: list[str], start: int) -> tuple[int, str | None]:
    """Index of the site's last line, or a reason it cannot be neutralized safely.
    Strings, template literals and comments are skipped; regex literals are not."""
    depth, quote, block = 0, None, False
    for i in range(start, min(len(lines), start + MAX_SPAN)):
        text, j = lines[i], 0
        while j < len(text):
            c = text[j]
            if block:
                if text.startswith("*/", j):
                    block, j = False, j + 2
                    continue
            elif quote:
                if c == "\\":
                    j += 2
                    continue
                if c == quote:
                    quote = None
            elif text.startswith("//", j):
                break
            elif text.startswith("/*", j):
                block, j = True, j + 2
                continue
            elif c in "'\"`":
                quote = c
            elif c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
                if depth < 0:
                    return i, "it closes a bracket opened before the site; neutralizing it would cut the enclosing block"
            j += 1
        if quote in ("'", '"'):
            quote = None                               # a plain string ends with its line
        if depth == 0 and quote is None and not block:
            return i, None
    return start, f"its brackets stay open for more than {MAX_SPAN} lines"


def js_sites(data: bytes, site_re: re.Pattern, mode: str, scope: set[int] | None) -> list[Site]:
    raw = data.splitlines(keepends=True)
    lines = [l.decode("utf-8", "replace") for l in raw]
    sites, i = [], 0
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped or JS_SKIP_RE.match(stripped) or not site_re.search(lines[i]):
            i += 1
            continue
        last, reason = _js_span(lines, i)
        if scope is not None and not scope.intersection(range(i + 1, last + 2)):
            i = last + 1
            continue
        site = Site(i + 1, _first_line(lines[i]), reason=reason)
        if reason is None:
            span = raw[i:last + 1]
            if mode == "comment":
                body = b"".join(_indent(l) + b"// " + l[len(_indent(l)):] for l in span)
            else:
                body = (_indent(span[0]) + b"void 0;" + _ending(span[-1])
                        + b"".join(_ending(l) for l in span[:-1]))
            site.mutated = b"".join(raw[:i]) + body + b"".join(raw[last + 1:])
        sites.append(site)
        i = last + 1
    return sites


def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, timeout=60)


def changed_lines(path: Path, rev: str) -> set[int] | None:
    """Line numbers the working tree adds or changes against `rev`; None when git
    does not track the file, so every line is new."""
    where, name = path.parent, path.name
    if _git(["rev-parse", "--verify", "--quiet", f"{rev}^{{commit}}"], where).returncode != 0:
        raise SweepError(f"--changed-since {rev!r} is not a commit in the repository holding {path}")
    if _git(["ls-files", "--error-unmatch", "--", name], where).returncode != 0:
        return None
    proc = _git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", rev, "--", name], where)
    if proc.returncode != 0:
        raise SweepError(f"git diff against {rev} failed for {path}: "
                         f"{proc.stderr.decode('utf-8', 'replace').strip()}")
    lines: set[int] = set()
    for m in re.finditer(rb"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", proc.stdout, re.M):
        start, count = int(m[1]), int(m[2] if m[2] is not None else 1)
        lines.update(range(start, start + count))
    return lines


def load_files(paths: list[str], site_re: re.Pattern, mode: str,
               changed_since: str | None) -> list[SweepFile]:
    files, seen = [], set()
    for arg in paths:
        path = Path(arg)
        if path.is_symlink():
            raise SweepError(f"{arg}: is a symbolic link; name the file it points to, so the "
                             f"file the sweep changes is the file it was given")
        key = path.resolve()
        if key in seen:
            continue
        seen.add(key)
        suffix = path.suffix.lower()
        if suffix not in PYTHON_SUFFIXES | JS_SUFFIXES:
            raise SweepError(f"{arg}: unsupported file type {suffix or '(none)'}; supported: "
                             + " ".join(sorted(PYTHON_SUFFIXES | JS_SUFFIXES)))
        try:
            data = path.read_bytes()
        except OSError as e:
            raise SweepError(f"{arg}: cannot read: {e}") from e
        try:
            data.decode("utf-8")
        except UnicodeDecodeError as e:
            raise SweepError(f"{arg}: not UTF-8 ({e})") from e
        scope = changed_lines(path, changed_since) if changed_since else None
        python = suffix in PYTHON_SUFFIXES
        file_mode = mode if mode != "auto" else ("noop" if python else "comment")
        try:
            sites = (python_sites if python else js_sites)(data, site_re, file_mode, scope)
        except SweepError as e:
            raise SweepError(f"{arg}: {e}") from e
        files.append(SweepFile(path, arg.replace("\\", "/"), data,
                               hashlib.sha256(data).hexdigest(), stat.S_IMODE(path.stat().st_mode),
                               sites))
    return files


# ---------------------------------------------------------------- the sweep

def sweep(files: list[SweepFile], command: str, cwd: Path, timeout: float,
          run=run_command, say=None) -> int:
    say = say or (lambda line: print(line, flush=True))
    say(f"mutation sweep: command {command} in {cwd}")
    for f in files:
        say(f"file {f.display} sha256 {f.sha256} sites {len(f.sites)}")
    total = sum(len(f.sites) for f in files)
    if total == 0:
        raise SweepError("no check site matched --site-re in scope; nothing was swept")
    try:
        code, timed_out, tail = run(command, cwd, timeout)
    finally:
        for f in files:
            _restore(f)                                # a baseline that changed or deleted a target
    if timed_out or code != 0:
        raise SweepError("the command fails on the unmodified files ("
                         + (f"timed out after {timeout:g}s" if timed_out else f"exit {code}")
                         + "); a failing baseline would make every site look caught\n" + tail)
    counts = {"CAUGHT": 0, "UNCAUGHT": 0, "UNSWEPT": 0}
    try:
        for f in files:
            for site in f.sites:
                if site.mutated is None:
                    status, why = "UNSWEPT", site.reason
                else:
                    _write(f.path, site.mutated)
                    try:
                        code, timed_out, _ = run(command, cwd, timeout)
                    finally:
                        _restore(f)
                    if timed_out:
                        status, why = "CAUGHT", f"timed out after {timeout:g}s"
                    elif code != 0:
                        status, why = "CAUGHT", f"exit {code}"
                    else:
                        status, why = "UNCAUGHT", "the command still passed with this check neutralized"
                counts[status] += 1
                say(f"[{status}] {f.display}:{site.line} — {site.text} — {why}")
    finally:
        for f in files:
            _restore(f)
    say(f"mutation sweep: {counts['CAUGHT']} caught, {counts['UNCAUGHT']} uncaught, "
        f"{counts['UNSWEPT']} unswept of {total} sites")
    return 0 if counts["UNCAUGHT"] == counts["UNSWEPT"] == 0 else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="mutation_sweep.py",
        description="Neutralize each check site of a product file in turn, run the tests or "
                    "self-test that should catch it, and report every site the command still "
                    "passes with. Never sweep a test's own assertions: neutralizing one only "
                    "makes that test pass, so it always reads uncaught and proves nothing.")
    ap.add_argument("files", nargs="*", metavar="FILE", help="files that hold the checks")
    ap.add_argument("--command", help="the test command, one shell string (like an oracle command)")
    ap.add_argument("--cwd", type=Path, default=Path.cwd(), help="where the command runs (default: here)")
    ap.add_argument("--site-re", default=DEFAULT_SITE_RE,
                    help="regex a product check site's source must match (default: a bare "
                         "assert, a bare assert*( helper, and bare fail( and check( calls; a "
                         "callee reached through a dot, such as self.fail(, assert.equal( or "
                         "self.check(, is a test-side form and never matches)")
    ap.add_argument("--mode", choices=("auto", "comment", "noop"), default="auto",
                    help="auto: noop for Python (pass), comment for JavaScript (//)")
    ap.add_argument("--changed-since", metavar="REV",
                    help="sweep only sites on lines the working tree adds or changes against REV")
    ap.add_argument("--timeout", type=float, default=600.0, help="seconds per run (default 600)")
    ap.add_argument("--self-test", action="store_true", help="run embedded fixtures and exit 0/1")
    args = ap.parse_args(argv)
    if args.self_test:
        return _run_self_test()
    if not args.files or not args.command:
        ap.error("give --command and at least one FILE")
    if args.changed_since and args.changed_since.startswith("-"):
        ap.error("--changed-since takes a revision, not an option")
    if args.timeout <= 0:
        ap.error("--timeout must be positive")
    try:
        site_re = re.compile(args.site_re)
    except re.error as e:
        ap.error(f"--site-re does not compile: {e}")
    try:
        with _signals_restore_files():
            files = load_files(args.files, site_re, args.mode, args.changed_since)
            return sweep(files, args.command, args.cwd, args.timeout)
    except SweepError as e:
        print(f"mutation_sweep: {e}", file=sys.stderr)
        return 2
    except Interrupted as e:
        print(f"mutation_sweep: interrupted by signal {e.args[0]}; every file was restored",
              file=sys.stderr)
        return 2
    except (OSError, subprocess.SubprocessError) as e:
        print(f"mutation_sweep: {e}", file=sys.stderr)
        return 2


# ---------------------------------------------------------------- self-test

_PRODUCT = (
    "def fail(message):\n"
    "    raise SystemExit(message)\n"
    "\n"
    "\n"
    "def admit(n):\n"
    "    if n < 0:\n"
    "        fail(\"negative\")\n"
    "    if n > 9:\n"
    "        fail(\n"
    "            \"too big\")\n"
    "    assert n != 5, \"five\"\n"
    "    return n\n"
)

# A test of the product: exits 0 only when every probe in argv[2:] is refused.
_PRODUCT_TEST = (
    "import sys\n"
    "sys.dont_write_bytecode = True\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from product import admit\n"
    "def refused(n):\n"
    "    try:\n"
    "        admit(n)\n"
    "    except (SystemExit, AssertionError):\n"
    "        return True\n"
    "    return False\n"
    "probes = [int(a) for a in sys.argv[2:]]\n"
    "sys.exit(0 if all(refused(n) for n in probes) and admit(3) == 3 else 1)\n"
)

# Passes while admit(-1) is refused; hangs once that check is gone.
_HANG_TEST = (
    "import sys, time\n"
    "sys.dont_write_bytecode = True\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from product import admit\n"
    "try:\n"
    "    admit(-1)\n"
    "except SystemExit:\n"
    "    sys.exit(0)\n"
    "time.sleep(600)\n"
)

_JS_PRODUCT = (
    "const assert = require(\"node:assert\");\n"
    "function admit(n) {\n"
    "  if (n < 0) fail(\"negative\");\n"
    "  if (n > 9) {\n"
    "    fail(\n"
    "      \"too big\");\n"
    "  }\n"
    "  if (n === 5) {\n"
    "    assert(n !== 5);\n"
    "  } else check(n);\n"
    "  return n;\n"
    "}\n"
)

# Stands in for a JavaScript test without needing node: passes while each check's
# text is on a line that is not commented out.
_JS_TEST = (
    "import sys\n"
    "lines = open(sys.argv[1], encoding='utf-8').read().splitlines()\n"
    "active = '\\n'.join(l for l in lines if not l.lstrip().startswith('//'))\n"
    "need = ['fail(\"negative\")', '\"too big\")', 'assert(n !== 5)']\n"
    "sys.exit(0 if all(n in active for n in need) else 1)\n"
)

# A test file whose checks are its own assertions. Swept against itself, each one
# reads UNCAUGHT: neutralizing a test's assertion only makes that test pass.
_OWN_ASSERT_TEST = (
    "import sys\n"
    "sys.dont_write_bytecode = True\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "from product import admit\n"
    "assert admit(3) == 3\n"
    "assert admit(0) == 0\n"
)


def _run_self_test() -> int:
    passed = total = 0

    def check(name: str, ok: bool, detail: str = "") -> None:
        nonlocal passed, total
        total += 1
        passed += bool(ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail and not ok else ""))

    def cli(*argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def py(script: Path, *args: str) -> str:
        parts = [sys.executable, str(script), *args]
        if os.name == "nt":
            return " ".join(f'"{p}"' for p in parts)
        return " ".join(shlex.quote(p) for p in parts)

    tmp = Path(tempfile.mkdtemp(prefix="mutation_sweep_selftest_"))
    # A fixture repository must never reach an enclosing one, and a git hook's GIT_DIR
    # or GIT_INDEX_FILE in the environment would point the fixture's git at it.
    saved = {k: v for k, v in os.environ.items() if k.startswith("GIT_")}
    for k in saved:
        del os.environ[k]
    os.environ["GIT_CEILING_DIRECTORIES"] = str(tmp.resolve().parent)
    try:
        work = tmp / "py"
        work.mkdir()
        product = work / "product.py"
        product.write_bytes(_PRODUCT.encode("utf-8"))
        original = product.read_bytes()
        test = work / "test_product.py"
        test.write_bytes(_PRODUCT_TEST.encode("utf-8"))
        rel = str(product)

        # (a) a test missing the n > 9 probe: that site is reported UNCAUGHT and the
        #     sweep exits 1, while the two sites the test does probe are CAUGHT
        code, out, err = cli("--command", py(test, str(work), "-1", "5"), "--cwd", str(work), rel)
        check("an uncaught site is reported and exits 1",
              code == 1 and f"[UNCAUGHT] {rel.replace(os.sep, '/')}:9 — fail(" in out
              and out.count("[CAUGHT]") == 2 and "1 uncaught" in out, out + err)

        # (b) the same sweep with every probe: all three sites CAUGHT, exit 0. The
        #     multi-line call on lines 9-10 is replaced at its whole span by `pass`.
        code, out, err = cli("--command", py(test, str(work), "-1", "10", "5"), "--cwd", str(work), rel)
        check("an all-caught fixture exits 0",
              code == 0 and out.count("[CAUGHT]") == 3 and "[UNCAUGHT]" not in out
              and "3 caught, 0 uncaught, 0 unswept of 3 sites" in out, out + err)
        check("the file is byte-identical after the sweeps", product.read_bytes() == original)
        digest = hashlib.sha256(original).hexdigest()
        check("the report names each file's sha256 and site count",
              f"file {rel.replace(os.sep, '/')} sha256 {digest} sites 3" in out, out)

        # (c) a run that raises mid-sweep, while the first site is neutralized: the
        #     exception propagates and the file is restored byte for byte
        seen: list[bytes] = []

        def raising_run(command, cwd, timeout):
            seen.append(product.read_bytes())
            if len(seen) == 2:
                raise RuntimeError("injected failure mid-sweep")
            return 0, False, ""

        files = load_files([rel], re.compile(DEFAULT_SITE_RE), "auto", None)
        try:
            sweep(files, "unused", work, 30, run=raising_run, say=lambda _line: None)
            raised = False
        except RuntimeError:
            raised = True
        check("a file is byte-identical after a run that raised",
              raised and len(seen) == 2 and seen[1] != original and product.read_bytes() == original,
              f"raised={raised} runs={len(seen)}")

        # (d) a neutralized check that makes the test hang: the run times out, the
        #     process tree is killed, the site counts as caught, and the file is restored
        hang = work / "test_hang.py"
        hang.write_bytes(_HANG_TEST.encode("utf-8"))
        code, out, err = cli("--command", py(hang, str(work)), "--cwd", str(work), "--timeout", "5",
                             "--site-re", r'fail\("negative"\)', rel)
        check("a run that times out is caught and the file is restored",
              code == 0 and "timed out after 5s" in out and product.read_bytes() == original, out + err)

        # (e) --mode comment on a Python block whose only statement is the site: the
        #     neutralized file does not parse, so the site is UNSWEPT, never CAUGHT
        code, out, err = cli("--command", py(test, str(work), "-1", "10", "5"), "--cwd", str(work),
                             "--mode", "comment", rel)
        check("a neutralization that does not parse is UNSWEPT, not caught",
              code == 1 and f"[UNSWEPT] {rel.replace(os.sep, '/')}:7" in out
              and "does not parse" in out and f"[CAUGHT] {rel.replace(os.sep, '/')}:11" in out, out + err)

        # (f) a command that fails on the unmodified file: exit 2, nothing swept
        failing = work / "always_fails.py"
        failing.write_bytes(b"import sys\nsys.exit(3)\n")
        code, out, err = cli("--command", py(failing), "--cwd", str(work), rel)
        check("a failing baseline exits 2 and sweeps nothing",
              code == 2 and "fails on the unmodified files (exit 3)" in err and "[CAUGHT]" not in out
              and product.read_bytes() == original, out + err)

        # (g) a site regex that matches nothing: exit 2, never a vacuous pass
        code, out, err = cli("--command", py(test, str(work)), "--cwd", str(work),
                             "--site-re", "no_such_check_anywhere", rel)
        check("no matching site exits 2, never a vacuous pass",
              code == 2 and "nothing was swept" in err, out + err)

        # (h) JavaScript, line mode: the import is not a site, a multi-line call is
        #     commented over its whole span, and `} else check(n)` is UNSWEPT
        js = tmp / "js"
        js.mkdir()
        jsfile = js / "admit.js"
        jsfile.write_bytes(_JS_PRODUCT.encode("utf-8"))
        js_original = jsfile.read_bytes()
        jstest = js / "check_js.py"
        jstest.write_bytes(_JS_TEST.encode("utf-8"))
        jrel = str(jsfile).replace(os.sep, "/")
        code, out, err = cli("--command", py(jstest, str(jsfile)), "--cwd", str(js), str(jsfile))
        check("JavaScript sites: whole-span comment, an enclosing-bracket site is UNSWEPT",
              code == 1 and f"[CAUGHT] {jrel}:3" in out and f"[CAUGHT] {jrel}:5" in out
              and f"[CAUGHT] {jrel}:9" in out and f"[UNSWEPT] {jrel}:10" in out
              and "closes a bracket" in out and ":1 —" not in out
              and jsfile.read_bytes() == js_original, out + err)

        # (i) --changed-since: only the line the working tree adds is a site, and a
        #     file git does not track is wholly new
        repo = tmp / "repo"
        repo.mkdir()
        base = _PRODUCT.replace("    assert n != 5, \"five\"\n", "")
        (repo / "product.py").write_bytes(base.encode("utf-8"))
        ident = ["-c", "user.name=hatch", "-c", "user.email=hatch@example.invalid"]
        steps = [["init", "-q"], ["add", "product.py"], ["write-tree"]]
        outs = [_git(s, repo) for s in steps]
        tree = outs[-1].stdout.decode("utf-8", "replace").strip()
        made = subprocess.run(["git", "-C", str(repo), *ident, "commit-tree", "--no-gpg-sign",
                               "-m", "base", tree], capture_output=True, timeout=60)
        rev = made.stdout.decode("utf-8", "replace").strip()
        (repo / "product.py").write_bytes(_PRODUCT.encode("utf-8"))
        (repo / "fresh.py").write_bytes(_PRODUCT.encode("utf-8"))
        try:
            scoped = load_files([str(repo / "product.py"), str(repo / "fresh.py")],
                                re.compile(DEFAULT_SITE_RE), "auto", rev)
            lines = [[s.line for s in f.sites] for f in scoped]
        except SweepError as e:
            lines = [str(e)]
        check("--changed-since sweeps only added lines; an untracked file is wholly new",
              all(o.returncode == 0 for o in outs) and made.returncode == 0
              and lines == [[11], [7, 9, 11]], f"{lines} {made.stderr!r}")

        # (j) the default pattern names product check calls and leaves test-side
        #     forms out: self.assert*, self.fail(, expect(, node:assert's assert.x(
        #     family, and a self-test's check( reached as self.check( or a method
        default = re.compile(DEFAULT_SITE_RE)
        product_like = ["assert n != 5", "assert(ok);", "assertDeep(a, b);",
                        "assertRaisesLike(err, f)", 'fail("x")', "  fail(", 'check(ok, "x")',
                        "  } else check(n);", 'if (n < 0) fail("negative");']
        test_like = ["self.assertEqual(a, b)", "self.assertTrue(ok)", "expect(x).toBe(1);",
                     'self.fail("x")', "assert.equal(a, b);", "assert.ok(ok);",
                     "assert.deepStrictEqual(a, b);", "assert.fail('x');",
                     'self.check("name", ok)', 'suite.check("name", ok)']
        missed = [s for s in product_like if not default.search(s)]
        caught = [s for s in test_like if default.search(s)]
        check("the default site pattern matches product checks, not test assertions",
              not missed and not caught, f"missed {missed}, matched {caught}")

        # (k) the documented limit: a test file swept against itself reports its own
        #     assertions UNCAUGHT, because neutralizing an assertion only makes its own
        #     test pass. That is why test assertions are never swept.
        own = work / "test_own_asserts.py"
        own.write_bytes(_OWN_ASSERT_TEST.encode("utf-8"))
        own_original = own.read_bytes()
        code, out, err = cli("--command", py(own, str(work)), "--cwd", str(work), str(own))
        check("a test file swept against itself reads uncaught, which is not evidence",
              code == 1 and out.count("[UNCAUGHT]") == 2 and "[CAUGHT]" not in out
              and own.read_bytes() == own_original, out + err)

        # (l) a command that deletes the target: the file is recreated from the
        #     original bytes, with its mode, after the baseline and after every run
        mode = stat.S_IMODE(product.stat().st_mode)
        deleter = work / "deletes_target.py"
        deleter.write_bytes(b"import os, sys\nos.remove(sys.argv[1])\n")
        code, out, err = cli("--command", py(deleter, rel), "--cwd", str(work), rel)
        restored = product.exists() and product.read_bytes() == original
        check("a command that deletes the target leaves it restored byte for byte",
              code == 1 and restored and out.count("[UNCAUGHT]") == 3
              and stat.S_IMODE(product.stat().st_mode) == mode, out + err)
        if not product.exists():
            product.write_bytes(original)

        # (m) a symlinked target is refused by name: the sweep would change the file
        #     the link points to, which is not the file it was given
        link = work / "linked_product.py"
        try:
            os.symlink(product, link)
        except (OSError, NotImplementedError) as e:
            print(f"[SKIP] a symlinked target is refused by name: this host cannot create a symlink ({e})")
        else:
            code, out, err = cli("--command", py(test, str(work), "-1", "10", "5"), "--cwd", str(work),
                                 str(link))
            check("a symlinked target is refused by name",
                  code == 2 and f"{link}: is a symbolic link" in err and "[CAUGHT]" not in out
                  and product.read_bytes() == original, out + err)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        os.environ.pop("GIT_CEILING_DIRECTORIES", None)
        os.environ.update(saved)

    print(f"self-test: {passed}/{total} cases passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
