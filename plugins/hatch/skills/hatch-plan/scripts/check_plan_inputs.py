# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Check a binder's inputs before any worker runs; report only, never edit the binder.

Plan mode (--binder <draft>) runs nothing the binder wrote: tool names reach a fixed
`command -v` script as arguments, and preconditions are only listed. Preflight mode
(--slug S --base REF) reads the committed binder at REF and runs each precondition a
not-done item waits on, or that no item names, in a throwaway worktree of REF (for a
successor's first run, its predecessor's tip with the default branch merged in; 30 s each,
CI=1, stdin closed, GIT_* removed, in the --shell form); --environment-config adds the
committed .hatch/environment.json `preflight` (60 s). Only those runs and a successor merge
that conflicts, or that git before 2.38 cannot make, can set `halt`: the static probe of
commands cannot be complete, so it warns.
Exit 0: report printed, `halt` is a field; 1: self-test failure; 2: usage error,
unreadable or malformed binder, or a git failure. Pure stdlib.
"""
from __future__ import annotations
import argparse, contextlib, io, json, os, posixpath, re, shlex, shutil, signal, subprocess, sys, tempfile, time
from pathlib import Path

# Sibling scripts, imported by path with no bytecode (an installed plugin is a git clone,
# and Pi sets PYTHONSAFEPATH=1, so the script's own directory is not on sys.path).
_HERE = Path(__file__).resolve().parent
for _d in (_HERE, _HERE / ".." / ".." / "hatch-build" / "scripts", _HERE / ".." / ".." / "hatch-deliver" / "scripts"):
    if str(_d.resolve()) not in sys.path:
        sys.path.insert(0, str(_d.resolve()))
_dwb, sys.dont_write_bytecode = sys.dont_write_bytecode, True
try:
    import validate_binder as vb  # noqa: E402
    import run_oracle  # noqa: E402
    import deliver_preflight  # noqa: E402
finally:
    sys.dont_write_bytecode = _dwb

SCHEMA = "hatch-plan-inputs-v1"
PRECONDITION_TIMEOUT = 30
ENV_PREFLIGHT_TIMEOUT = 60
PROBE_TIMEOUT = 60
OUTPUT_LIMIT = 2048
WINDOWS = os.name == "nt"


_SEP = re.compile(r"\|\||&&|;|\||\n")
_SEP_WIN = re.compile(r"\|\||&&|;|\||\n|(?<![>&])&(?![&>])")
# A heredoc, a subshell or function body, or a comment: the rest of the command is not read.
_STOP_AT = re.compile(r"<<|[()]|(?:^|(?<=[\s;&|]))#")
# After one of these, control flow or PATH is unknown, so the rest of the command is unread.
_STOP = {"if", "case", "for", "while", "until", "select", "function", "source", ".", "eval", "exec",
         "export", "alias", "pushd"}
_WRAPPERS = {"env", "command", "time", "!", "{"}
_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_REDIRECT = re.compile(r"^\d*[<>]")
# Only a plain name, or a path of plain characters, is probed; anything else is skipped.
_WORD = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._+-]*$|^[A-Za-z0-9._+-]*/[A-Za-z0-9._/+-]*$")
_CMD_BUILTINS = set("assoc break call cd chdir cls copy date del dir echo endlocal erase exit goto md mkdir "
                    "mklink move path pause popd pushd rd rem ren rename rmdir set setlocal shift start "
                    "time title type ver vol".split())
_MARK = "--hatch-probe--"
_PROBE = f'printf "%s\\n" {_MARK}; for t; do command -v -- "$t" >/dev/null 2>&1 || printf "%s\\n" "$t"; done'
_LOGIN_PATH = ('command export PATH="${HATCH_HOST_PATH:+${HATCH_HOST_PATH}${PATH:+:}}${PATH}"; '
               "unset HATCH_HOST_PATH; ")
# A precondition under --shell login: the committed command travels in the environment.
_LOGIN_RUN = "exec /bin/sh -lc '" + _LOGIN_PATH + "eval \"$HATCH_INPUT_CMD\"'"
HALTING = {"precondition-unmet", "precondition-cannot-run", "environment-preflight-failed"}


def _mask_subst(command: str) -> str:
    """`$(...)` and backtick spans filled with `$`, same length: their quotes and separators
    belong to an inner shell, and a `$` word is never probed. An unclosed span fills to the end."""
    out, i = list(command), 0
    while i < len(command):
        if command.startswith("$(", i) or command[i] == "`":
            j, depth = i + 1, 0
            while j < len(command) and command[i] == "`" and command[j] != "`":
                j += 1
            while j < len(command) and command[i] == "$":
                depth += {"(": 1, ")": -1}.get(command[j], 0)
                if depth == 0:
                    break
                j += 1
            out[i:j + 1] = "$" * (min(j, len(command) - 1) - i + 1)
            i = j
        i += 1
    return "".join(out)


def command_words(command: str, windows: bool = WINDOWS) -> tuple[list[tuple[str, str]], bool]:
    """The first word of each simple command that will run, with the directory (relative to
    the command's cwd) a `cd` moved to before it. Second value: True when reading stopped at
    a construct it does not parse. It stops or skips rather than guess."""
    command = _mask_subst(command)
    masked, sep = vb.mask_quoted(command), (_SEP_WIN if windows else _SEP)
    stop, k = _STOP_AT.search(masked), len(masked)
    if stop:  # cut before the whole word that holds it: `true)`, `f(){`
        k = stop.start()
        while k and masked[k - 1] not in " \t\n;&|":
            k -= 1
    command, masked = command[:k], masked[:k]
    pieces, before, start = [], None, 0
    for m in sep.finditer(masked):
        pieces.append([before, command[start:m.start()], m.group()])
        before, start = m.group(), m.end()
    pieces.append([before, command[start:], None])
    out: list[tuple[str, str]] = []
    here, wrappers = ".", _WRAPPERS - ({"time"} if windows else set())
    for before, seg, after in pieces:
        if "||" in (before, after):  # either side of a fallback may not run; a `cd` there moves unknowably
            if seg.split()[:1] == ["cd"]:
                return out, True
            continue
        try:
            toks = shlex.split(seg.replace("\\", "/") if windows else seg)
        except ValueError:
            return out, True
        i, word, wrapped = 0, "", False
        while i < len(toks):
            word = toks[i].lstrip("@") if windows else toks[i]
            word = "echo" if windows and word.lower() in ("echo.", "echo:") else word
            if word.startswith("PATH=") or word in _STOP or (word == "command" and toks[i + 1:i + 2] in (["-v"], ["-V"])):
                return out, True
            if wrapped and word.startswith("-"):  # a wrapper's option, and env's option argument
                i, word = i + (2 if word in ("-u", "-C", "-S", "--unset", "--chdir") else 1), ""
                continue
            if word and word not in wrappers and not _ASSIGN.match(word) and not _REDIRECT.match(word):
                break
            wrapped = wrapped or word in wrappers
            i, word = i + 1, ""
        if not _WORD.match(word):
            continue
        if word == "cd":
            arg = toks[i + 1] if i + 1 < len(toks) else ""
            if not _WORD.match(arg) or arg.startswith(("-", "/")):
                return out, True
            here = posixpath.normpath(posixpath.join(here, arg))
            continue
        out.append((word, here))
    return out, bool(stop)


def _clean_env(env: dict[str, str] | None = None) -> dict[str, str]:
    return {k: v for k, v in (os.environ if env is None else env).items() if not k.startswith("GIT_")}


def _git(repo: Path, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", env={**_clean_env(), **(env or {})}, stdin=subprocess.DEVNULL, timeout=60)


def _object_type(repo: Path, sha: str, path: str) -> str | None:
    p = _git(repo, "cat-file", "-t", f"{sha}:{'' if path == '.' else path}")
    return p.stdout.strip() if p.returncode == 0 else None


def _generated(repo: Path, sha: str, rel: str) -> bool:
    """A path a build or an install makes: ignored in the checkout, or under a top
    directory the base does not have (`.venv/`, `node_modules/`, `bin/`)."""
    return ("/" in rel and _object_type(repo, sha, rel.split("/")[0]) is None) \
        or _git(repo, "check-ignore", "-q", "--no-index", rel).returncode == 0


def _commit(repo: Path, ref: str) -> str | None:
    return _git(repo, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").stdout.strip() or None


def _successor_base(repo: Path, pred_ref: str, base_ref: str) -> tuple[str, str, str | None]:
    """(label, sha, problem) for a successor's first run: the predecessor's tip with the
    default branch merged in, the tree Pi and hatch-deliver build from. No ref moves: the
    merge is a dangling commit with a fixed identity and date, so repeated runs on the same
    refs make the same commit. When the merge conflicts, or git is older than 2.38, the label
    and sha are the predecessor's tip and the third value says why."""
    name = deliver_preflight.resolve_default_branch(repo)[0]
    other = name if name and _commit(repo, f"refs/heads/{name}") else base_ref
    tip, head = _commit(repo, pred_ref), _commit(repo, f"refs/heads/{other}" if other == name else other)
    if head is None or _git(repo, "merge-base", "--is-ancestor", head, tip).returncode == 0:
        return pred_ref, tip, None
    p = _git(repo, "merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", tip, head)
    if p.returncode == 129:  # a usage error: git before 2.38 has no --write-tree
        return pred_ref, tip, "git 2.38 or newer is needed for a successor's first-run check (`git merge-tree --write-tree`)"
    if p.returncode > 1:
        raise RuntimeError(f"git merge-tree failed: {p.stderr.strip()}")
    tree, *files = [f for f in p.stdout.split("\0") if f] or [""]
    if p.returncode:
        return pred_ref, tip, (f"merging {other} into {pred_ref} conflicts in {', '.join(files)}; "
                               "resolve it before delivering")
    pin = {"GIT_AUTHOR_DATE": "@0 +0000", "GIT_COMMITTER_DATE": "@0 +0000"}
    c = _git(repo, "-c", "commit.gpgsign=false", "-c", "user.name=hatch", "-c", "user.email=hatch@invalid",
             "commit-tree", tree, "-p", tip, "-p", head, "-m", "hatch input check", env=pin)
    if c.returncode != 0:
        raise RuntimeError(f"git commit-tree failed: {c.stderr.strip()}")
    return f"{pred_ref} merged with {other}", c.stdout.strip(), None


def load_committed(repo: Path, slug: str, ref: str) -> dict | None:
    """The binder's committed bytes at `ref`, live or archived; None when neither exists."""
    sha = _commit(repo, ref)
    for path in (f".hatch/binders/{slug}.json", f".hatch/binders/archive/{slug}.json"):
        p = _git(repo, "show", f"{sha}:{path}") if sha else None
        if p and p.returncode == 0:
            return json.loads(p.stdout)
    return None


def _missing_tools(repo: Path, tools: set[str], shell: str) -> set[str]:
    """Tools the route's shell cannot find, by one fixed `command -v` script that gets the
    names as arguments. On Windows both routes use cmd.exe, so PATH lookup plus its built-ins.
    A probe that exits nonzero reports nothing; one that cannot run or times out raises."""
    if not tools:
        return set()
    if os.name == "nt":
        return {t for t in tools if t.lower() not in _CMD_BUILTINS and shutil.which(t) is None}
    else:
        env = _clean_env()
        if shell == "login":
            env["HATCH_HOST_PATH"] = env.get("PATH", "")
            argv = ["/bin/sh", "-lc", _LOGIN_PATH + _PROBE, "sh", *sorted(tools)]
        else:
            argv = ["sh", "-c", _PROBE, "sh", *sorted(tools)]
        p = subprocess.run(argv, cwd=repo, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", stdin=subprocess.DEVNULL, timeout=PROBE_TIMEOUT)
    lines = p.stdout.splitlines()
    return set(lines[lines.index(_MARK) + 1:]) & tools if p.returncode == 0 and _MARK in lines else set()


@contextlib.contextmanager
def _child_context(extra: dict[str, str]):
    """CI=1 unless set, GIT_* removed and stdin closed for a command run_oracle spawns, as
    Pi's check runner does; restored afterwards."""
    saved, saved_fd = dict(os.environ), None
    os.environ.clear()
    os.environ.update({"CI": "1", **_clean_env(saved), **extra})
    try:
        with contextlib.suppress(OSError):
            saved_fd = os.dup(0)
        null = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null, 0)
        os.close(null)
        yield
    finally:
        if saved_fd is not None:
            os.dup2(saved_fd, 0)
            os.close(saved_fd)
        os.environ.clear()
        os.environ.update(saved)


def _run(worktree: Path, command: str, cwd: str | None, timeout: int, shell: str) -> dict:
    """Run one committed command in the throwaway worktree, in the probe's shell form."""
    target = (worktree / (cwd or ".")).resolve()
    if not target.is_dir() or not target.is_relative_to(worktree.resolve()):
        return {"exit": None, "timed_out": False, "output": "", "why": f"cwd `{cwd}` is not a directory at base"}
    extra = {}
    if shell == "login" and not WINDOWS:
        extra = {"HATCH_INPUT_CMD": command, "HATCH_HOST_PATH": os.environ.get("PATH", "")}
    with _child_context(extra):
        rec = run_oracle.run_oracle(_LOGIN_RUN if extra else command, target, None, None, timeout)
    d, code = rec["decisive_output"], rec["exit_status"]
    text = d["head"] + (("\n...\n" + d["tail"]) if d["tail"] else "")
    out = text.encode("utf-8")[-OUTPUT_LIMIT:].decode("utf-8", "ignore")
    why = (f"timed out after {timeout} s" if rec["timed_out"] else
           "the shell could not start" if code == 2 and "failed to start command" in text else
           f"exited {code} (not found or not executable)" if code in (126, 127, 9009) else "")
    return {"exit": None if rec["timed_out"] else code, "timed_out": rec["timed_out"], "output": out, "why": why}


def _finding(kind: str, items: list, subject: str, detail: str, command=None, run=None) -> dict:
    run = run or {}
    return {"kind": kind, "halts": kind in HALTING, "items": sorted(items), "subject": subject, "command": command,
            "exit": run.get("exit"), "timed_out": run.get("timed_out", False),
            "output": run.get("output", ""), "detail": detail}


def check_inputs(repo: Path, binder: dict, mode: str, base_ref: str = "HEAD", shell: str = "plain",
                 environment_config: bool = False) -> dict:
    slug = binder.get("slug", "")
    pred, problem = (binder.get("supersedes") or {}).get("slug"), None
    # A successor's first run builds on its predecessor's tip merged with the default branch.
    if pred and not _commit(repo, f"refs/heads/hatch/{slug}/integration") \
            and _commit(repo, f"refs/heads/hatch/{pred}/integration"):
        base_ref, sha, problem = _successor_base(repo, f"hatch/{pred}/integration", base_ref)
    else:
        sha = _commit(repo, base_ref)
    if sha is None:
        raise RuntimeError(f"base ref {base_ref!r} does not resolve to a commit")
    env_cfg: dict = {}
    if environment_config:
        p = _git(repo, "show", f"{sha}:.hatch/environment.json")
        env_cfg = json.loads(p.stdout) if p.returncode == 0 else {}
    done_pat = re.compile(rf"^refs/hatch/{re.escape(slug)}/item-(.+)/done$")
    done = {m.group(1) for name in deliver_preflight.list_prefixed_refs(repo, f"refs/hatch/{slug}/")
            if (m := done_pat.match(name))}
    carried = set((binder.get("supersedes") or {}).get("carried", []))
    items = binder.get("work_items", [])
    graph = {it.get("id"): list(it.get("depends_on", [])) for it in items}
    touches = {it.get("id"): list(it.get("touches", [])) for it in items}
    findings: list[dict] = []
    skipped: list[dict] = []
    live = []
    for it in items:
        iid, oracle = it.get("id"), it.get("oracle") or {}
        why = ("done" if iid in done else "carried" if iid in carried else
               "opt-out" if oracle.get("opt_out") else "no command" if not oracle.get("command") else None)
        (skipped.append({"item": iid, "why": why}) if why else live.append(it))
    probes = [(it["id"], [it["id"]], it["oracle"]["command"], it["oracle"].get("cwd"),
               [p for j in {it["id"], *vb.reachable(it["id"], graph)} for p in touches.get(j, [])]) for it in live]
    env_items = [it["id"] for it in live if it["oracle"].get("type") in deliver_preflight.ENV_ORACLE_TYPES]
    env_contract = binder.get("env_contract") or {}
    if env_items and env_contract.get("command"):
        probes.append(("env_contract", env_items, env_contract["command"], env_contract.get("cwd"),
                       [p for t in touches.values() for p in t]))
    shell_label = "cmd.exe" if WINDOWS else "/bin/sh -lc" if shell == "login" else "sh -c"
    wanted: dict[str, dict[str, list[str]]] = {}
    for subject, its, command, cwd, scope in probes:
        note = (" and nothing this item depends on touches it" if scope else
                "; no `touches` is declared, so this check cannot tell whether the item makes it")
        ncwd = posixpath.normpath(cwd or ".")
        if ncwd != "." and _object_type(repo, sha, ncwd) not in ("tree", "commit") \
                and not vb.paths_overlap([ncwd], scope) and not _generated(repo, sha, ncwd):
            findings.append(_finding("cwd-missing", its, subject, f"cwd `{cwd}` is not a directory at {base_ref}{note}",
                                     command))
            continue
        words, unread = command_words(command)
        if unread:
            skipped.append({"item": subject, "why": "unread construct"})
        for word, here in words:
            if "/" not in word:
                wanted.setdefault(word, {})[subject] = its
                continue
            rel = word if word.startswith("/") else posixpath.normpath(posixpath.join(ncwd, here, word))
            if word.startswith("//") or (word.startswith("/") and os.path.exists(word)) or rel.startswith("..") \
                    or (WINDOWS and not posixpath.splitext(rel)[1]) or (not word.startswith("/") and (
                        _object_type(repo, sha, rel) is not None or vb.paths_overlap([rel], scope)
                        or _generated(repo, sha, rel))):
                continue
            findings.append(_finding("path-missing", its, subject, f"`{rel}` is not at {base_ref}{note}", command))
    setup = "; the base declares a setup that may install it" if env_cfg.get("setup") else ""
    try:
        missing = _missing_tools(repo, set(wanted), shell)
    except (OSError, subprocess.SubprocessError) as e:  # a static finding never stops a delivery
        missing = set()
        findings.append(_finding("probe-failed", [], "static probe", f"probe could not run: {e}"))
    for tool in sorted(missing):
        for subject, its in wanted[tool].items():
            findings.append(_finding("tool-missing", its, subject, f"`{tool}` is not found by {shell_label}{setup}"))
    pres = binder.get("preconditions") or []
    named = {ref for it in items for ref in it.get("waits_on", [])}
    waiters = {p["id"]: [it["id"] for it in items if p["id"] in it.get("waits_on", [])
                         and it["id"] not in done and it["id"] not in carried] for p in pres}
    remaining = {it.get("id") for it in items} - done - carried
    applies = [p for p in pres if remaining and (p["id"] not in named or waiters[p["id"]])]
    if mode == "plan":
        for p in applies:
            findings.append(_finding("precondition-declared", waiters[p["id"]], p["id"],
                                     f"runs at delivery preflight: {p['reason']}", p["command"]))
    if problem:
        findings.append(_finding("precondition-cannot-run", sorted(remaining), "supersedes", problem))
    leftover = None
    if mode == "preflight" and (applies or env_cfg.get("preflight")) and not problem:
        tmp = Path(tempfile.mkdtemp(prefix="hatch-inputs-"))
        wt = tmp / "wt"
        try:  # main() turns SIGTERM into SystemExit, so this cleanup runs on a cancel too
            add = _git(repo, "worktree", "add", "--detach", str(wt), sha)
            if add.returncode != 0:
                raise RuntimeError(f"git worktree add failed: {add.stderr.strip()}")
            for p in applies:
                run = _run(wt, p["command"], p.get("cwd"), PRECONDITION_TIMEOUT, shell)
                if run["exit"] == 0:
                    continue
                kind = "precondition-cannot-run" if run["why"] else "precondition-unmet"
                findings.append(_finding(kind, waiters[p["id"]], p["id"],
                                         f"{run['why'] or 'exited ' + str(run['exit'])}: {p['reason']}",
                                         p["command"], run))
            if env_cfg.get("preflight"):
                run = _run(wt, env_cfg["preflight"], None, ENV_PREFLIGHT_TIMEOUT, shell)
                if run["exit"] != 0:
                    findings.append(_finding("environment-preflight-failed", [], ".hatch/environment.json",
                                             run["why"] or f"`preflight` exited {run['exit']}"
                                             + (f": {env_cfg['on_unavailable']}" if env_cfg.get("on_unavailable") else ""),
                                             env_cfg["preflight"], run))
        finally:
            rm = _git(repo, "worktree", "remove", "--force", str(wt))
            shutil.rmtree(tmp, ignore_errors=True)
            if rm.returncode != 0:  # prune after the delete, so no admin entry is left behind
                _git(repo, "worktree", "prune")
                findings.append(_finding("cleanup-failed", [], "throwaway worktree", f"git worktree remove failed for "
                                         f"{wt}: {rm.stderr.strip()}" + ("; it is still there" if wt.exists() else "")))
            leftover = str(wt) if wt.exists() else None
    report = {"schema": SCHEMA, "mode": mode, "binder": slug, "base": {"ref": base_ref, "sha": sha},
              "shell": shell_label, "halt": mode == "preflight" and any(f["halts"] for f in findings),
              "findings": findings, "skipped": skipped}
    if leftover:
        report["leftover_worktree"] = leftover
    return report


def render_text(report: dict) -> str:
    """One block in the review card's shape: a two-space line per finding, four-space detail."""
    head = (f"Input check ({report['mode']}): {report['binder']} at {report['base']['ref']} "
            f"({report['base']['sha'][:12]})" + (" — HALT" if report["halt"] else ""))
    lines = [head]
    for f in report["findings"]:
        tag = (" (stops delivery)" if f["halts"] else " (stops delivery if unmet)"
               if f["kind"] == "precondition-declared" else " (warning)")
        items = f" — items: {', '.join(f['items'])}" if f["items"] and f["items"] != [f["subject"]] else ""
        lines.append(f"  {f['subject']}: {f['kind']}{tag}{items}")
        lines.append(f"    {f['detail']}")
        if f["command"] and f["kind"].startswith(("precondition", "environment")):
            lines.append(f"    command: {f['command']}")
        if f["output"].strip():
            lines.append(f"    output: {f['output'].strip().splitlines()[-1]}")
    if not report["findings"]:
        lines.append("  no findings")
    partial = [s["item"] for s in report["skipped"] if s["why"] == "unread construct"]
    if partial:
        lines.append(f"  {len(partial)} command(s) read only in part: {', '.join(partial)}")
    return "\n".join(lines)


def _run_self_test() -> int:
    failures = 0

    def check(name: str, ok: bool, detail: object = "") -> None:
        nonlocal failures
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + ("" if ok else f" — got {detail!r}"))
        failures += 0 if ok else 1

    def words(cmd: str, win: bool = False) -> list[str]:
        return [w for w, _ in command_words(cmd, win)[0]]

    check("probe: first word", words("npm test -- -x") == ["npm"], words("npm test -- -x"))
    check("probe: cd moves the base of a relative path",
          command_words("cd backend && ./run.sh")[0] == [("./run.sh", "backend")],
          command_words("cd backend && ./run.sh")[0])
    for cmd, want in [("grep -E 'a|zz' f.txt", ["grep"]), ("grep -E '(a|b)' f", ["grep"]),
                      ('echo "a # b" && true', ["echo", "true"]), ("a || b; c", ["c"]),
                      ("x && a || b; c", ["x", "c"]), ("FOO=1 env time pytest -q", ["pytest"]),
                      ("$PY -m x; y", ["y"]), ("env -u TOKEN -i bash x.sh; test 1 -ne 0", ["bash", "test"]),
                      ('x="$(python3 -c \'d("k; a")\')" && n=$((n+1)) && go `x; y` z', ["go"]),
                      ("true # x && hatch-q", ["true"]), ("cat <<'EOF'\nprint(1)\nEOF", ["cat"])]:
        check(f"probe: reads {cmd!r}", words(cmd) == want, words(cmd))
    for cmd in ["x; if true; then y; fi", "PATH=/x:$PATH tool", "( env bash x.sh )", "# c\ntrue",
                "command -v q >/dev/null && q --x || echo s", "command -V q && q", "f(){ true; }; f",
                "(cd sub && true) && ./scripts/ok.sh", "case x in x) q;; esac", "cd sub || exit 1; ./x.sh",
                "pushd sub; ./x.sh"]:
        got = command_words(cmd)
        check(f"probe: stops at {cmd!r} and reads nothing after", got[1] and all(w in ("x",) for w, _ in got[0]), got)
    check("probe: & splits on Windows only", words("a & b", True) == ["a", "b"] and words("a 2>&1") == ["a"])
    for cmd, want in [("%PY% -m pytest", []), ("@echo off & git status", ["echo", "git"]),
                      ("time /t", ["time"]), ("echo. && git x", ["echo", "git"])]:
        check(f"probe: Windows reads {cmd!r}", words(cmd, True) == want, words(cmd, True))

    def git(root: Path, *args: str) -> str:
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        return subprocess.run(["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-C", str(root), *args],
                              check=True, capture_output=True, text=True, encoding="utf-8", env=env).stdout.strip()

    def kinds(report: dict) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for f in report["findings"]:
            out.setdefault(f["kind"], []).append(f["subject"])
        return {k: sorted(v) for k, v in out.items()}

    def item(iid: str, command: str | None, **extra) -> dict:
        oracle = {"type": "unit", "command": command} if command else {"opt_out": True, "reason": "r"}
        return {"id": iid, "title": iid, "summary": "s", "oracle": oracle, **extra}

    def commit_binders(repo: Path, msg: str, **binders: dict) -> None:
        (repo / ".hatch" / "binders").mkdir(parents=True, exist_ok=True)
        for slug, b in binders.items():
            (repo / ".hatch" / "binders" / f"{slug}.json").write_text(json.dumps(b), encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", msg)

    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp) / "repo"
        (repo / "scripts").mkdir(parents=True)
        (repo / "scripts" / "ok.sh").write_text("exit 0\n", encoding="utf-8")
        (repo / "scripts" / "noexec.sh").write_text("exit 0\n", encoding="utf-8")
        (repo / ".gitignore").write_text(".venv/\n", encoding="utf-8")
        git(repo.parent, "init", "-q", "-b", "main", str(repo))
        git(repo, "config", "user.email", "t@example.invalid")
        git(repo, "config", "user.name", "t")
        git(repo, "add", "-A")
        git(repo, "update-index", "--chmod=-x", "scripts/noexec.sh")
        git(repo, "commit", "-q", "-m", "base")
        (repo / ".venv" / "bin").mkdir(parents=True)
        head = git(repo, "rev-parse", "HEAD")
        git(repo, "update-ref", "refs/hatch/demo/item-i-done/done", head)
        silent = {"x-comment": "# run the checks\ntrue", "x-comment2": "git status  # lint && hatch-no-such-qq",
                  "x-heredoc": "git status <<'EOF'\nhatch-no-such-qq\nEOF",
                  "x-guard": "command -v hatch-no-such-qq >/dev/null && hatch-no-such-qq --x || echo skipped",
                  "x-sub": "(cd sub && true) && ./scripts/ok.sh", "x-fn": "f(){ true; }; f",
                  "h-venv": ".venv/bin/pytest -q", "h-nm": "./node_modules/.bin/tsc", "h-bin": "git status && ./bin/app",
                  "h-unc": "//hatch-no-such-host/share/x"}
        binder = {
            "slug": "demo", "title": "t", "summary": "s",
            "env_contract": {"command": "hatch-no-such-env-qq up", "supports_isolation": False},
            "preconditions": [{"id": "answer", "command": "exit 1", "reason": "the owner answer"}],
            "work_items": [
                item("i-tool", "hatch-no-such-tool-qq --x"),
                item("i-ok", "git status && ./scripts/ok.sh", waits_on=["answer"]),
                item("i-path", "./scripts/missing.sh", touches=["other/x.txt"]),
                item("i-new", "./scripts/new-check.sh", touches=[]),
                item("i-touch", "./gen/new.sh", touches=["gen/new.sh"]),
                item("i-dep", "./gen/new.sh", depends_on=["i-touch"]),
                {**item("i-cwd", "git status"), "oracle": {"type": "integration", "command": "git status", "cwd": "nope"}},
                item("i-opt", None),
                item("i-done", "hatch-no-such-tool-qq"),
                *[item(k, v) for k, v in silent.items()]]}
        rep = check_inputs(repo, binder, "plan")
        got = kinds(rep)
        check("plan: findings by kind; comments, heredocs, guards, subshells, functions, generated "
              "and ignored paths give none", got == {
                  "tool-missing": ["env_contract", "i-tool"], "path-missing": ["i-new", "i-path"],
                  "cwd-missing": ["i-cwd"], "precondition-declared": ["answer"]}, got)
        check("plan: never halts, and no finding halts", rep["halt"] is False and rep["schema"] == SCHEMA
              and rep["base"]["sha"] == head and not any(f["halts"] for f in rep["findings"]), rep)
        new = [f["detail"] for f in rep["findings"] if f["subject"] == "i-new"]
        check("plan: a path with no `touches` says it cannot tell", new and "cannot tell" in new[0], new)
        decl = [f for f in rep["findings"] if f["kind"] == "precondition-declared"]
        check("plan: precondition printed verbatim with its waiting items",
              decl and decl[0]["command"] == "exit 1" and decl[0]["items"] == ["i-ok"] and not decl[0]["halts"], decl)
        skipped = {s["item"]: s["why"] for s in rep["skipped"]}
        check("plan: done and opt-out items are skipped",
              skipped.get("i-done") == "done" and skipped.get("i-opt") == "opt-out", skipped)
        text = render_text(rep)
        check("plan: the card marks what stops delivery and what only warns",
              "answer: precondition-declared (stops delivery if unmet)" in text
              and "i-tool: tool-missing (warning)" in text and "read only in part" in text, text)

        canary = Path(tmp) / "canary"
        canary.mkdir()
        c = canary.as_posix()
        bait = {"slug": "bait", "env_contract": {"command": f"touch {c}/e"},
                "preconditions": [{"id": "p", "command": f"touch {c}/p", "reason": "r"}],
                "work_items": [item("o", f"touch {c}/o"), item("b", f"echo `touch {c}/b`"),
                               item("d", f"echo $(touch {c}/d)"), item("q", f'echo "$(touch {c}/q)"'),
                               {**item("e", "true"), "oracle": {"type": "integration", "command": "true"}}]}
        for shell in ("plain", "login"):
            check_inputs(repo, bait, "plan", shell=shell)
        check("plan: runs nothing the binder wrote (canary, plain and login shell)",
              not list(canary.iterdir()), list(canary.iterdir()))

        git(repo, "checkout", "-q", "-b", "hatch/pred/integration")
        (repo / "made.sh").write_text("exit 0\n", encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "pred")
        git(repo, "checkout", "-q", "main")
        (repo / "docs").mkdir()
        (repo / "docs" / "c4.md").write_text("answer\n", encoding="utf-8")
        (repo / "main-only.sh").write_text("exit 0\n", encoding="utf-8")
        py = f'"{sys.executable}" -c'
        succ = {"slug": "demo-r2", "title": "t", "summary": "s", "supersedes": {"slug": "pred", "carried": ["s0"]},
                "preconditions": [{"id": "owner", "reason": "on main only", "command":
                                   f"{py} \"import os,sys; sys.exit(0 if os.path.getsize('docs/c4.md') else 1)\""},
                                  {"id": "predp", "reason": "on the predecessor only", "command":
                                   f"{py} \"import os,sys; sys.exit(0 if os.path.isfile('made.sh') else 1)\""},
                                  {"id": "carriedp", "command": "exit 1", "reason": "only a carried item waits"}],
                "work_items": [item("s0", "hatch-no-such-carried-qq", waits_on=["carriedp"]),
                               item("s1", "./made.sh && ./main-only.sh", waits_on=["owner", "predp"])]}
        commit_binders(repo, "successor", **{"demo-r2": succ})

        def state() -> tuple[str, ...]:
            return tuple(git(repo, *a) for a in (["for-each-ref"], ["worktree", "list"], ["status", "--porcelain"]))

        before_succ = state()
        plan = check_inputs(repo, succ, "plan")
        pre = check_inputs(repo, load_committed(repo, "demo-r2", "HEAD"), "preflight", "HEAD")
        merged = pre["base"]["sha"]
        check("successor: plan and preflight both check the predecessor's tip merged with the default branch",
              plan["base"] == pre["base"] and pre["base"]["ref"] == "hatch/pred/integration merged with main"
              and git(repo, "rev-parse", f"{merged}^1", f"{merged}^2").split() == [
                  git(repo, "rev-parse", "hatch/pred/integration"), git(repo, "rev-parse", "main")],
              (plan["base"], pre["base"]))
        check("successor: a file on main and a file on the predecessor are both there; no halt",
              kinds(plan) == {"precondition-declared": ["owner", "predp"]} and not pre["findings"] and not pre["halt"],
              (plan["findings"], pre["findings"]))
        check("successor: a carried item is skipped, and a precondition only it waits on does not run",
              {"item": "s0", "why": "carried"} in plan["skipped"], plan["skipped"])
        check("successor: no ref, worktree or file moved", state() == before_succ, state())
        real_git = _git
        globals()["_git"] = lambda r, *a, **k: (subprocess.CompletedProcess(a, 129, "", "usage: git merge-tree")
                                                 if a[:2] == ("merge-tree", "--write-tree") else real_git(r, *a, **k))
        try:
            old = check_inputs(repo, load_committed(repo, "demo-r2", "HEAD"), "preflight", "HEAD")
        finally:
            globals()["_git"] = real_git
        check("successor: git without merge-tree --write-tree halts and says 2.38 is needed, running nothing",
              old["halt"] and [(f["subject"], "git 2.38 or newer" in f["detail"]) for f in old["findings"] if f["halts"]]
              == [("supersedes", True)] and old["base"]["ref"] == "hatch/pred/integration"
              and state() == before_succ, (old, state()))

        clash_name = "clash é.txt"
        git(repo, "checkout", "-q", "-b", "hatch/predc/integration")
        (repo / clash_name).write_text("pred\n", encoding="utf-8")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", "predc")
        git(repo, "checkout", "-q", "main")
        (repo / clash_name).write_text("main\n", encoding="utf-8")
        (repo / "late.sh").write_text("exit 0\n", encoding="utf-8")
        clash = {"slug": "clash-r2", "supersedes": {"slug": "predc", "carried": []},
                 "preconditions": [{"id": "cp", "command": f"touch {canary.as_posix()}/clash", "reason": "r"}],
                 "work_items": [item("c1", "./late.sh")]}
        commit_binders(repo, "clash", **{"clash-r2": clash})
        before_clash = state()
        rep = check_inputs(repo, load_committed(repo, "clash-r2", "HEAD"), "preflight", "HEAD")
        cf = [f for f in rep["findings"] if f["kind"] == "precondition-cannot-run"]
        check("successor: a conflicting merge halts, says the merge conflicts and names the file whole, running nothing",
              rep["halt"] and len(cf) == 1 and f"merging main into hatch/predc/integration conflicts in {clash_name}"
              in cf[0]["detail"] and not list(canary.iterdir()) and state() == before_clash, (rep, state()))
        check("successor: on a conflict, static findings name the predecessor's tip they were read at",
              rep["base"]["ref"] == "hatch/predc/integration" and kinds(rep).get("path-missing") == ["c1"]
              and not any("merged with" in f["detail"] for f in rep["findings"]), rep)

        pres = {**binder, "env_contract": None, "preconditions": [
            {"id": "pass", "command": f"{py} \"import os,sys; sys.exit(0 if os.environ.get('CI') else 5)\"", "reason": "r"},
            {"id": "unmet", "command": "echo nope-marker && exit 3", "reason": "r"},
            {"id": "cannot", "command": "exit 127", "reason": "r"},
            *([] if WINDOWS else [{"id": "noexec", "command": "./scripts/noexec.sh", "reason": "r"}]),
            {"id": "cwdp", "command": "exit 0", "reason": "r", "cwd": "nope"},
            {"id": "skippedp", "command": "exit 1", "reason": "r"}],
            "work_items": [item("i-a", "git status", waits_on=["unmet"]), item("i-tool", "hatch-no-such-tool-qq"),
                           item("i-done", "git status", waits_on=["skippedp"])]}
        del pres["env_contract"]
        (repo / ".hatch" / "environment.json").write_text(json.dumps({"preflight": "exit 4", "setup": "x"}), encoding="utf-8")
        sig_cmd = f"echo $$ > '{Path(tmp).as_posix()}/pid'; exec sleep 60"
        commit_binders(repo, "binder", demo=pres, sig={"slug": "sig", "preconditions": [
            {"id": "w", "command": sig_cmd, "reason": "r"}], "work_items": [item("w1", "true")]})
        (repo / ".hatch" / "binders" / "demo.json").write_text(json.dumps({**pres, "preconditions": []}), encoding="utf-8")
        before = git(repo, "worktree", "list")
        rep = check_inputs(repo, load_committed(repo, "demo", "HEAD"), "preflight", "HEAD", environment_config=True)
        got = kinds(rep)
        check("preflight: committed preconditions run; done items' are skipped", got == {
            "precondition-unmet": ["unmet"], "precondition-cannot-run": ["cannot", "cwdp", *([] if WINDOWS else ["noexec"])],
            "environment-preflight-failed": [".hatch/environment.json"], "tool-missing": ["i-tool"]}, got)
        unmet = [f for f in rep["findings"] if f["subject"] == "unmet"]
        check("preflight: output tail and exit are kept",
              unmet and "nope-marker" in unmet[0]["output"] and unmet[0]["exit"] == 3, unmet)
        check("preflight: halts on preconditions and the environment, never on the static probe",
              rep["halt"] is True and [f["halts"] for f in rep["findings"] if f["kind"] == "tool-missing"] == [False], rep)
        check("preflight: the throwaway worktree is removed", git(repo, "worktree", "list") == before)
        rep = check_inputs(repo, {**binder, "preconditions": []}, "preflight", "HEAD")
        check("preflight: static findings alone do not halt",
              rep["findings"] and rep["halt"] is False and "HALT" not in render_text(rep), rep)
        global PRECONDITION_TIMEOUT
        saved, PRECONDITION_TIMEOUT = PRECONDITION_TIMEOUT, 1
        try:
            rep = check_inputs(repo, {"slug": "demo", "preconditions": [
                {"id": "slow", "command": f"{py} \"import time; time.sleep(60)\"", "reason": "r"}],
                "work_items": [item("w", "git status")]}, "preflight", "HEAD")
        finally:
            PRECONDITION_TIMEOUT = saved
        check("preflight: a timeout is cannot-run", kinds(rep) == {"precondition-cannot-run": ["slow"]}
              and rep["findings"][0]["timed_out"], rep["findings"])
        wide = {"slug": "demo", "preconditions": [{"id": "wide", "command": "exit 1", "reason": "r"}]}
        rep = check_inputs(repo, {**wide, "work_items": [item("i-done", "git status")]}, "preflight", "HEAD")
        check("preflight: no item left, so no binder-wide precondition runs", not rep["findings"], rep["findings"])
        rep = check_inputs(repo, {**wide, "work_items": [item("i-done", "git status"), item("i-opt", None)]}, "preflight", "HEAD")
        check("preflight: an opt-out item still to build keeps it", kinds(rep) == {"precondition-unmet": ["wide"]}, rep)
        (repo / ".hatch" / "binders" / "archive").mkdir()
        (repo / ".hatch" / "binders" / "archive" / "arch.json").write_text('{"slug": "arch"}', encoding="utf-8")
        git(repo, "add", ".hatch/binders/archive/arch.json")
        git(repo, "commit", "-q", "-m", "archive")
        before = git(repo, "worktree", "list")
        check("load: an archived binder is read when no live one exists",
              (load_committed(repo, "arch", "HEAD") or {}).get("slug") == "arch" and load_committed(repo, "nope", "HEAD") is None)
        real_git, real_rmtree = _git, shutil.rmtree
        globals()["_git"] = lambda r, *a, **k: (subprocess.CompletedProcess(a, 1, "", "") if a[:2] in (
            ("worktree", "remove"), ("worktree", "prune")) else real_git(r, *a, **k))
        shutil.rmtree = lambda *a, **k: None
        try:
            rep = check_inputs(repo, {**wide, "work_items": [item("w", "git status")]}, "preflight", "HEAD")
        finally:
            globals()["_git"], shutil.rmtree = real_git, real_rmtree
        left = rep.get("leftover_worktree")
        cleanup = [f for f in rep["findings"] if f["kind"] == "cleanup-failed"]
        check("preflight: a worktree that cannot be removed is reported, and warned of",
              left and Path(left).is_dir() and len(cleanup) == 1 and not cleanup[0]["halts"]
              and left in cleanup[0]["detail"], rep)
        if left:
            git(repo, "worktree", "remove", "--force", left)
            shutil.rmtree(Path(left).parent, ignore_errors=True)
        real = run_oracle.run_oracle
        for code, out in ((2, "failed to start command: no sh"), (9009, "")):
            run_oracle.run_oracle = lambda *a, code=code, out=out: {
                "exit_status": code, "timed_out": False, "decisive_output": {"head": out, "tail": ""}}
            try:
                rep = check_inputs(repo, {**wide, "work_items": [item("w", "git status")]}, "preflight", "HEAD")
            finally:
                run_oracle.run_oracle = real
            check(f"preflight: exit {code} {out!r} is cannot-run", kinds(rep) == {"precondition-cannot-run": ["wide"]}, rep)

        if not WINDOWS:
            home = Path(tmp) / "home"
            home.mkdir()
            (home / ".profile").write_text("export HATCH_QQ_MARKER=1\n", encoding="utf-8")
            prof = {**wide, "preconditions": [{"id": "prof", "command": 'test "$HATCH_QQ_MARKER" = 1', "reason": "r"}],
                    "work_items": [item("w", "git status")]}
            saved_home, os.environ["HOME"] = os.environ.get("HOME"), str(home)
            try:
                plain = kinds(check_inputs(repo, prof, "preflight", "HEAD"))
                login = kinds(check_inputs(repo, prof, "preflight", "HEAD", shell="login"))
            finally:
                os.environ.pop("HOME") if saved_home is None else os.environ.__setitem__("HOME", saved_home)
            check("preflight: --shell login runs preconditions in the login shell, as the probe does",
                  plain == {"precondition-unmet": ["prof"]} and login == {}, (plain, login))

            def gone(pid: int) -> bool:  # a zombie counts: where PID 1 does not reap, a killed child stays one
                try:
                    os.kill(pid, 0)
                    stat = Path(f"/proc/{pid}/stat")
                    return stat.exists() and stat.read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0] == "Z"
                except (ProcessLookupError, OSError, IndexError):
                    return True

            zombie = subprocess.Popen(["true"])
            time.sleep(0.5)
            check("signal: an exited child not yet reaped counts as gone", not Path("/proc").is_dir() or gone(zombie.pid))
            zombie.wait()
            env = {**_clean_env(), "PYTHONDONTWRITEBYTECODE": "1"}
            proc = subprocess.Popen([sys.executable, __file__, "--slug", "sig", "--base", "HEAD", "--repo", str(repo)],
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            pidf, wt_path = Path(tmp) / "pid", None
            for _ in range(600):
                if pidf.exists() and pidf.read_text(encoding="utf-8").strip():
                    break
                time.sleep(0.1)
            for line in git(repo, "worktree", "list", "--porcelain").splitlines():
                if "hatch-inputs-" in line:
                    wt_path = Path(line.split(" ", 1)[1])
            proc.send_signal(signal.SIGTERM)
            code = proc.wait(timeout=60)
            pid = int(pidf.read_text(encoding="utf-8").strip() or 0)
            for _ in range(100):
                if gone(pid):
                    pid = 0
                    break
                time.sleep(0.1)
            check("signal: SIGTERM removes the worktree, its temp directory and the precondition's processes",
                  code != 0 and wt_path is not None and not wt_path.parent.exists() and pid == 0
                  and git(repo, "worktree", "list") == before, (code, wt_path, pid))

            slow = Path(tmp) / "slow.json"
            slow.write_text(json.dumps({"slug": "slow", "work_items": [item("w", "npm test")]}), encoding="utf-8")
            (home / ".profile").write_text("exec sleep 5\n", encoding="utf-8")
            saved_home, os.environ["HOME"] = os.environ.get("HOME"), str(home)
            global PROBE_TIMEOUT
            saved, PROBE_TIMEOUT, out = PROBE_TIMEOUT, 1, io.StringIO()
            try:
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
                    code = main(["--binder", str(slow), "--repo", str(repo), "--shell", "login"])
            finally:
                PROBE_TIMEOUT = saved
                os.environ.pop("HOME") if saved_home is None else os.environ.__setitem__("HOME", saved_home)
            try:
                rep = json.loads(out.getvalue())
            except ValueError:
                rep = {}
            check("probe: a login shell that hangs past the limit is a warning, exit 0",
                  code == 0 and rep.get("halt") is False and [f["kind"] for f in rep["findings"]] == ["probe-failed"]
                  and "probe could not run" in rep["findings"][0]["detail"], (code, out.getvalue()))

        ascii_env = {**_clean_env(), "PYTHONIOENCODING": "ascii", "PYTHONDONTWRITEBYTECODE": "1"}
        p = subprocess.run([sys.executable, __file__, "--binder", str(Path(tmp) / "absent-\u00e9.json")], env=ascii_env,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        check("cli: stderr is UTF-8 whatever the locale, so an error keeps a non-ASCII path",
              p.returncode == 2 and "absent-\u00e9.json" in p.stderr, p.stderr)

        out = io.StringIO()
        bad = Path(tmp) / "bad.json"
        bad.write_text(json.dumps({"slug": "x", "preconditions": [{"id": "a"}], "work_items": [item("w", "git status")]}),
                       encoding="utf-8")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            missing = main(["--binder", str(Path(tmp) / "absent.json")])
            try:
                malformed = main(["--binder", str(bad), "--repo", str(repo)])
            except Exception as e:  # noqa: BLE001
                malformed = repr(e)
            try:
                dash = main(["--slug", "demo", "--base=-x", "--repo", str(repo)])
            except SystemExit as e:
                dash = e.code
            text = main(["--slug", "demo", "--base", "HEAD", "--repo", str(repo), "--format", "text"])
        check("cli: unreadable binder exits 2", missing == 2, missing)
        check("cli: a malformed binder exits 2", malformed == 2, malformed)
        check("cli: a --base that starts with - exits 2", dash == 2, dash)
        check("cli: text report prints one indented line per finding",
              text == 0 and "\n  unmet: precondition-unmet (stops delivery)" in out.getvalue()
              and "\n    " in out.getvalue(), out.getvalue())

    print(f"\n{'all passed' if not failures else f'{failures} failed'}")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--binder", help="plan mode: a working-tree draft; nothing in it is run")
    ap.add_argument("--slug", help="preflight mode: read .hatch/binders/<slug>.json at --base")
    ap.add_argument("--base", help="preflight mode: the committed ref to read and check out "
                                   "(merged for a successor's first run)")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--shell", choices=["plain", "login"], default="plain")
    ap.add_argument("--environment-config", action="store_true",
                    help="also run the base's .hatch/environment.json preflight (Pi)")
    ap.add_argument("--format", choices=["json", "text"], default="json")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(encoding="utf-8")
    if args.self_test:
        return _run_self_test()
    if bool(args.binder) == bool(args.slug) or (args.slug and not args.base) or (args.base or "").startswith("-"):
        ap.error("give --binder, or --slug with a --base that does not start with -")
    for sig in (signal.SIGTERM, signal.SIGINT):  # a cancel still removes the worktree and kills the group
        signal.signal(sig, lambda n, _f: sys.exit(128 + n))
    repo = Path(args.repo).resolve()
    try:
        if args.binder:
            mode, base = "plan", "HEAD"
            binder = json.loads(Path(args.binder).read_text(encoding="utf-8"))
        else:
            mode, base = "preflight", args.base
            binder = load_committed(repo, args.slug, base)
            if binder is None:
                raise OSError(f"no committed binder {args.slug!r} at {base}")
        report = check_inputs(repo, binder, mode, base, args.shell, args.environment_config)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError, subprocess.SubprocessError) as e:
        print(f"check_plan_inputs: {e}", file=sys.stderr)
        return 2
    print(render_text(report) if args.format == "text" else json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
