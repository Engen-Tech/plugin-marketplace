#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""PreToolUse guard: confined writers stay inside their declared surfaces, and the
read-only gate reviewers write nothing.

Zero dependencies (pure stdlib). The harness invokes this on Write|Edit|MultiEdit|
NotebookEdit and on Bash, with the hook payload JSON on stdin. It recognizes an actor
by the payload's top-level `agent_type` — exactly the bare name or an exact
`*:`-namespaced form, nothing wider (so `hatch-kaizen-v2` is not recognized). Two
writers are confined:

  kaizen       — a `.hatch/sme/` segment, and the exact file `.hatch/kaizen.json`.
  doc-gardner  — its prose-doc surface: `README*`, `AGENTS.md`, `CLAUDE.md`,
                 `ARCHITECTURE*` (basename-anchored), anything under a `docs/`
                 segment, other top-level `*.md` (top-level judged against the
                 payload `cwd`), plus exactly `.gitignore` — its one non-doc
                 exception (the superpowers-salvage ignore line). Never `.hatch/`.

On Write/Edit/MultiEdit/NotebookEdit every writer target (`tool_input.file_path`,
`tool_input.notebook_path`) must resolve inside both the payload's working directory
and the writer's surface. Existing symlinks and parent directories are resolved
before classification, including for new files. A missing working directory or
unverifiable target is denied.

On Bash the command string is statically parsed for high-confidence file-write and
delete operations — output redirections (`>`, `>>`, `>|`, `&>`), `tee`, `sed`/`perl`/
`python`/`ruby` in-place (`-i`) flags, `mv`/`cp`/`install` destinations (`mv` checks
both ends: it deletes the source too), `rm`/`rmdir`/`unlink`, `git mv`/`git rm`
(honoring `git -C`), and one level of `bash -c`/`eval` unwrapping. Commands are split
on `;`, `&`, `|`, parentheses and newlines, and shell syntax in front of a command —
`!`, `{`, `if`/`then`/`else`/`elif`, `while`/`until`/`do`, `time`, `coproc`, a
`function NAME` header — is not taken for its name, so `{ rm x; }` and
`if true; then rm x; fi` are judged as `rm x`. Extracted targets are resolved against
the payload `cwd` and checked against the same surface. Commands with no detected
write operation (grep, ls, git status, ...) pass.

Fail posture — FAIL-CLOSED on the recognized shape, same as the kaizen-only cut and
`guard_auditor_dispatch.py`: for a recognized confined writer, an internal error
denies, an unverifiable call denies, and an AMBIGUOUS OR UNPARSEABLE Bash command
denies — unbalanced quotes, command/process substitution (`$(...)`, backticks),
heredocs, variables in a write-target position, relative targets after `cd` or with
no `cwd` in the payload, and `xargs`/`find -delete`-style runtime-determined targets
are all denied with a corrective reason, not waved through. Unrecognized shapes —
unreadable payload, missing `agent_type`, unknown writer, main thread — always pass.

Three gate reviewers are read-only — `hatch-acceptance-reviewer`,
`hatch-safety-auditor`, `hatch-design-reviewer`. Their writable
surface is empty: every Write/Edit/MultiEdit/NotebookEdit is denied. Their Bash is
judged by a fail-closed ALLOWLIST, not by the writers' deny analysis: a command passes
only when every simple command in it is a listed read-only tool — `cat`, `head`,
`tail`, `wc`, `ls`, `stat`, `file`, `grep`/`egrep`/`fgrep`, `rg`, `diff`, `cmp`, `sort`,
`uniq`, `cut`, `tr`, `nl`, `basename`, `dirname`, `realpath`, `readlink`, `pwd`, `echo`,
`true`, `false`, `test`/`[`, `find`, `jq`, `sha256sum`/`sha1sum`/`shasum`/`md5sum`, and `git` with a read-only subcommand (`diff`, `log`, `show`, `status`,
`rev-parse`, `ls-files`, `ls-tree`, `cat-file`, `merge-base`, `blame`, `grep`,
`for-each-ref`, `rev-list`, `describe`, `name-rev`, reading forms of `symbolic-ref`,
`branch`, `worktree list` and `config`) — named by bare name, meeting its argument rule,
and joined only by `;`, `&&`, `||`, `|` or newlines. Argument rules refuse the options
that write or run a program: `find -exec`/`-execdir`/`-ok`/`-okdir`/`-delete`/`-fprint*`/
`-fls`; `sort -o`/`-T`/`--compress-program`; a second `uniq` operand; `file -C`;
`rg --pre`/`--hostname-bin`; git's `-c`, `--config-env`, `--exec-path`, `--git-dir`,
`--work-tree` and every global option but `-C`, `--no-pager`, `-P`,
`--no-optional-locks`, `--literal-pathspecs`, `--no-replace-objects`; a `git -C` that
does not resolve (each `-C` applied to the last, as git does) to the working directory
or the top level of one of its repository's worktrees — a directory below one may be a
nested repository with its own config; `--output`, `--ext-diff`, `--textconv`, `--filters`
and `git grep -O` (with every abbreviation git or GNU getopt would complete). Denied
outright: shell reserved words and compound syntax (`{ } ( ) ! [[ ]]`, `if`, `for`,
`while`, `until`, `case`, `function`, `select`, `coproc`, `time`, ...), `$` expansion
and backticks, `#` comments, `&` background jobs, `|&`, every wrapper that runs
another command (`eval`, `source`, `.`, `exec`, `trap`, `builtin`, `command`, `env`,
`nohup`, `setsid`, `xargs`, `timeout`, `nice`, `stdbuf`, the shells themselves, ...),
every builtin that assigns a variable or changes directory (`printf` — whose `-v`, in
any spelling, can set `HOME` or `PATH` for the next listed command — `read`, `mapfile`,
`getopts`, `let`, `declare`, `export`, `cd`, `pushd`, ...; `echo` covers output),
every unlisted program (`sed`, `awk`, `perl`, `python`, `node`, `less`, `more`, `man`,
`make`, `tee`, package managers and runners — so a project type-check is the
orchestrator's to run, not the reviewer's), a program named by path (`./x`, `/usr/bin/x`),
an unquoted glob or brace (`git rev^{tree}` and `ref@{n}` excepted), every assignment
prefix but `GIT_PAGER=cat`, `PAGER=cat`, `LC_ALL=C` and `LANG=C`, and every redirection
but one to `/dev/null` or an fd copy such as `2>&1`. Reviewer internal errors deny.

Honest limits (documented, deliberate): this is per-writer confinement and a
pre-operation hook, not a sandbox, and it runs only when the host starts it. For the
writers, an interpreter invocation (`python x.py`), a shell script (`bash x.sh`) or an
unlisted tool that writes is not detected; segment/basename anchoring admits nested
`docs/`/`README*` paths (the same accepted residual as kaizen's nested
`.hatch/sme/`); a Bash-written pack bypasses PostToolUse pack validation
(kaizen carries no Bash today — this mode is defense against tool-grant drift, like
the NotebookEdit matcher). For the reviewers, the allowlisted tools keep their own
behaviours, and git still runs any program the repository's own git config names
(`core.fsmonitor`, a `diff.<driver>.textconv` or `diff.external` driver, a pager) and
may refresh its own index file; a reviewer cannot set that config without a write,
but whoever wrote the repository's `.git/config` can. Aliases and functions the host
shell defines before it runs the command are outside the hook's view. A concurrent
symlink swap after this pre-operation check is outside the hook's protection.

  guard_writer_confinement.py              # hook mode: payload on stdin, exit 0/2
  guard_writer_confinement.py --self-test  # run embedded fixtures, exit 0/1
"""
from __future__ import annotations
import argparse, json, os, re, shlex, subprocess, sys

def _read_stdin_text() -> str:
    """The hook payload is UTF-8 JSON, whatever the host's locale codec is.

    sys.stdin decodes with the locale codec — cp1252 on a stock Windows
    session — which mojibakes or raises on a payload it cannot spell. Read
    the byte stream and decode explicitly; the getattr falls back for test
    doubles that carry no .buffer."""
    data = getattr(sys.stdin, "buffer", sys.stdin).read()
    return data.decode("utf-8") if isinstance(data, bytes) else data

WRITERS: dict[str, dict] = {
    "hatch-kaizen": {
        "label": "kaizen",
        "regexes": (re.compile(r"(?:^|/)\.hatch/sme/"),
                    re.compile(r"(?:^|/)\.hatch/kaizen\.json$")),
        "toplevel_md": False,
        "doctrine": ("kaizen's writable surface is exactly two things — `.hatch/sme/` (the "
                     "project's stack packs) and `.hatch/kaizen.json` (its opt-in switch)"),
    },
    "hatch-doc-gardner": {
        "label": "doc-gardner",
        "regexes": (re.compile(r"(?:^|/)docs/"),
                    re.compile(r"(?:^|/)README[^/]*$"),
                    re.compile(r"(?:^|/)AGENTS\.md$"),
                    re.compile(r"(?:^|/)CLAUDE\.md$"),
                    re.compile(r"(?:^|/)ARCHITECTURE[^/]*$"),
                    re.compile(r"(?:^|/)\.gitignore$")),
        "toplevel_md": True,
        "doctrine": ("doc-gardner's writable surface is the prose-doc surface — `README*`, "
                     "anything under a `docs/` segment, `AGENTS.md`, `CLAUDE.md`, "
                     "`ARCHITECTURE*`, other top-level `*.md` — plus exactly `.gitignore` "
                     "(its one non-doc exception); code, tests, skills, and every "
                     "`.hatch/` path are not its to write"),
    },
}

# Read-only gate reviewers: an empty writable surface. Recognized like the writers.
REVIEWERS = ("hatch-acceptance-reviewer", "hatch-safety-auditor",
             "hatch-design-reviewer")
_EDIT_TOOLS = {"Write", "Edit", "MultiEdit", "NotebookEdit"}
_REVIEWER_DOCTRINE = ("the gate reviewers are read-only: they read the diff, the binder and "
                      "the evidence, and report; any edit goes back to hatch-build")

# Bash static analysis: commands that mutate files directly, shells/wrappers that
# can smuggle a mutation past a surface check, and substitution markers that hide
# commands from any static tokenization.
_DELETERS = {"rm", "rmdir", "unlink"}
_INPLACE_EDITORS = {"sed", "perl", "python", "python3", "ruby"}
_SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
_RISKY = (_DELETERS | _SHELLS | _INPLACE_EDITORS
          | {"tee", "mv", "cp", "install", "git", "eval", "xargs"})
_TRANSPARENT_PREFIXES = {"sudo", "env", "command", "nohup", "nice", "time", "stdbuf"}
# Discard devices: redirecting output here is the quiet idiom (cmd >/dev/null 2>&1),
# never a file write worth confining.
_SINK_DEVICES = {"/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"}
_ASSIGNMENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
_SCRIPT_FLAG_RE = re.compile(r"-[A-Za-z]*[eEcCmM]$")  # option cluster consuming a script arg
_SUBSTITUTION_MARKERS = ("$(", "`", "<(", ">(")

# Writers only: shell syntax that can stand in front of a command without being its
# name. `{ rm x; }`, `if true; then rm x; fi` and `! rm x` must be judged as `rm x`.
_RESERVED_LEAD = {"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while",
                  "until", "esac", "[[", "]]"}
# A `for`/`select`/`case` segment is a loop or case header, not a command; its body
# arrives as segments of its own after the `do`/`)` that the tokenizer splits on.
_HEADER_WORDS = {"for", "select", "case"}

# Gate reviewers: a fail-closed allowlist. A reviewer's Bash command passes only when
# every simple command in it is one of these read-only tools, meets its argument rule,
# and the commands are joined by nothing but `;`, `&&`, `||`, `|` and newlines. Any
# other command, and any other shell syntax, is denied.
_REVIEWER_COMMANDS = (
    "cat", "head", "tail", "wc", "ls", "stat", "file", "grep", "egrep", "fgrep", "rg",
    "diff", "cmp", "sort", "uniq", "cut", "tr", "nl", "basename", "dirname", "realpath",
    "readlink", "pwd", "echo", "true", "false", "test", "[", "find", "jq",
    "sha256sum", "sha1sum", "shasum", "md5sum", "git")
# The only assignment prefixes a reviewer may put in front of a listed command.
_REVIEWER_ASSIGNMENTS = {"GIT_PAGER=cat", "PAGER=cat", "LC_ALL=C", "LANG=C"}
# Compound syntax and reserved words (bash and zsh): each opens a construct whose body
# the allowlist would have to understand, so none is a command a reviewer runs.
_SHELL_SYNTAX = {"{", "}", "(", ")", "!", "[[", "]]", "if", "then", "else", "elif", "fi",
                 "for", "while", "until", "do", "done", "case", "esac", "in", "function",
                 "select", "coproc", "time", "repeat", "foreach", "end", "nocorrect",
                 "noglob"}
# Programs and builtins that run another command, a script, or change the shell.
_RUNNERS = {"eval", "source", ".", "exec", "trap", "builtin", "command", "env", "nohup",
            "setsid", "xargs", "timeout", "nice", "ionice", "chrt", "taskset", "stdbuf",
            "flock", "watch", "parallel", "script", "sudo", "doas", "busybox", "export",
            "declare", "typeset", "local", "readonly", "alias", "unalias", "set", "shopt",
            "enable", "hash", "cd", "pushd", "popd", "sh", "bash", "zsh", "dash", "ksh",
            "fish", "csh", "tcsh", "coproc",
            # Builtins that assign a variable: `printf -vHOME .` makes the next listed
            # command read a committed config or run a committed program.
            "printf", "print", "read", "mapfile", "readarray", "getopts", "let", "unset",
            "vared"}
_FIND_DENIED = {"-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0",
                "-fprintf", "-fls"}
_GIT_GLOBAL_FLAGS = {"--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs",
                     "--no-replace-objects"}
_GIT_READ = {"diff", "log", "show", "status", "rev-parse", "ls-files", "ls-tree", "cat-file",
             "merge-base", "blame", "grep", "for-each-ref", "rev-list", "describe",
             "name-rev", "symbolic-ref", "branch", "worktree", "config"}
# Options that write a file or run a program. git and GNU getopt accept a unique
# prefix of a long option, so every prefix of these is refused too (`--out=x`).
_GIT_DENIED_LONG = ("--output", "--ext-diff", "--textconv", "--filters",
                    "--open-files-in-pager")
_GIT_BRANCH_LIST_MODE = {"-l", "--list", "-a", "--all", "-r", "--remotes", "-v", "-vv",
                         "--verbose", "--contains", "--no-contains", "--merged",
                         "--no-merged", "--points-at"}
_GIT_BRANCH_FLAGS = _GIT_BRANCH_LIST_MODE | {"--show-current", "--format", "--sort",
                                             "--color", "--no-color", "--abbrev",
                                             "--no-abbrev", "--column", "--no-column",
                                             "-i", "--ignore-case", "--omit-empty"}
_GIT_CONFIG_READ_ACTIONS = {"--get", "--get-all", "--get-regexp", "--get-urlmatch",
                            "--list", "-l"}
_GIT_CONFIG_FLAGS = _GIT_CONFIG_READ_ACTIONS | {
    "--local", "--global", "--system", "--worktree", "--file", "-f", "--blob", "--type",
    "--bool", "--int", "--bool-or-int", "--path", "--null", "-z", "--name-only",
    "--show-origin", "--show-scope", "--includes", "--no-includes", "--default",
    "--fixed-value", "--all", "--regexp", "--value", "--url"}
_REDIRECT_SINK = "/dev/null"



def _recognized(agent_type: object) -> str | None:
    """Return the writer-table key for an exactly recognized confined writer."""
    if not isinstance(agent_type, str):
        return None
    for name in WRITERS:
        if agent_type == name or agent_type.endswith(":" + name):
            return name
    return None


def _recognized_reviewer(agent_type: object) -> str | None:
    """Return the reviewer-table key for an exactly recognized read-only gate reviewer."""
    if not isinstance(agent_type, str):
        return None
    for name in REVIEWERS:
        if agent_type == name or agent_type.endswith(":" + name):
            return name
    return None


def _isabs(path: str) -> bool:
    """Absolute or rooted. Python 3.13 stopped calling `/repo` absolute on Windows
    (it is drive-relative there), but it is still not relative to cwd — joining
    cwd to it discards cwd — so for confinement it is anchored all the same."""
    return os.path.isabs(path) or path.startswith(("/", "\\"))


def _allowed(conf: dict, path: str, cwd: object) -> bool:
    # Judge the object the OS will open, including symlinked parent directories.
    # realpath resolves existing ancestors of a not-yet-created destination too.
    # This is a pre-operation check, not protection against a concurrent link swap.
    if not isinstance(cwd, str) or not cwd or not path:
        return False
    try:
        root = os.path.realpath(cwd)
        target = os.path.realpath(path if _isabs(path) else os.path.join(root, path))
        if os.path.commonpath((root, target)) != root:
            return False
        p = os.path.relpath(target, root).replace(os.sep, "/")
    except (OSError, ValueError):
        return False
    if any(rx.search(p) for rx in conf["regexes"]):
        return True
    if conf["toplevel_md"] and p.endswith(".md"):
        if "/" not in p:
            return True  # bare relative filename — top level of the working dir
    return False


def _tokenize(command: str) -> list[str]:
    # A newline ends a command just as `;` does, so it is a separator token here, not
    # whitespace: `echo x\nrm y` is two commands, and so is a multi-line `for` loop.
    lex = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    return list(lex)


def _operands(args: list[str]) -> list[str]:
    """Non-flag arguments, honoring `--` end-of-flags; `-` (stdin/stdout) skipped."""
    out: list[str] = []
    no_more_flags = False
    for a in args:
        if no_more_flags:
            if a != "-":
                out.append(a)
        elif a == "--":
            no_more_flags = True
        elif not a.startswith("-") or a == "-":
            if a != "-":
                out.append(a)
    return out


def _analyze(command: str, cwd: object, depth: int = 0) -> tuple[list[str], list[str]]:
    """Statically extract file-write/delete targets from one shell command string.

    Returns (resolved_targets, ambiguities). Any ambiguity means the command could
    not be pinned down with confidence — the caller denies for a recognized writer
    (fail-closed), never guesses. This is the writers' analysis; the gate reviewers
    are judged by the allowlist in `_reviewer_verdict` instead.
    """
    targets: list[str] = []
    ambiguities: list[str] = []
    if depth > 3:
        return [], ["shell nesting deeper than 3 levels"]
    for marker in _SUBSTITUTION_MARKERS:
        if marker in command:
            return [], [f"command/process substitution ('{marker}') hides commands "
                        "from a static check"]
    try:
        tokens = _tokenize(command)
    except ValueError as e:
        return [], [f"unparseable shell syntax ({e})"]

    shifted = False  # a `cd`/`pushd` ran earlier — later relative paths are unknowable

    def resolve(raw: str, base: object = None) -> None:
        if raw in _SINK_DEVICES:
            return
        t = os.path.expanduser(raw)
        if "$" in t or "`" in t:
            ambiguities.append(f"write target '{raw}' contains a shell variable")
            return
        if not _isabs(t):
            if shifted:
                ambiguities.append(f"relative write target '{raw}' after `cd` cannot "
                                   "be resolved statically")
                return
            root = base if isinstance(base, str) and base else cwd
            if not isinstance(root, str) or not root:
                ambiguities.append(f"relative write target '{raw}' with no cwd in "
                                   "the payload")
                return
            t = os.path.join(root, t)
        targets.append(os.path.normpath(t).replace(os.sep, "/"))

    def finalize(words: list[str]) -> None:
        nonlocal shifted
        while words:
            # Reserved words, `!` and `{` are syntax in front of a command, never its
            # name: `{ rm x; }` and `if true; then rm x; fi` are judged as `rm x`.
            if words[0] in _HEADER_WORDS:
                return  # `for x in ...` / `case x in` — a header, not a command
            if words[0] == "function":
                del words[:2]  # `function NAME {` — the body follows the name
                continue
            if words[0] == "coproc":
                del words[:2 if len(words) > 2 and words[2] == "{" else 1]
                continue
            if words[0] in _RESERVED_LEAD:
                words.pop(0)
                continue
            if not (_ASSIGNMENT_RE.match(words[0]) or words[0] in _TRANSPARENT_PREFIXES):
                break
            if words[0] == "command" and len(words) > 1 and words[1].startswith("-"):
                if words[1] in ("-v", "-V"):
                    return  # `command -v X` — the POSIX tool-presence probe, read-only
                ambiguities.append("cannot statically resolve `command` with flags")
                return
            words.pop(0)
        if not words:
            return
        if words[0].startswith("-"):
            ambiguities.append(f"cannot statically identify the command behind "
                               f"'{words[0]}'")
            return
        cmd = os.path.basename(words[0])
        args = words[1:]
        if cmd in ("cd", "pushd", "popd"):
            shifted = True
            return
        if cmd in _SHELLS:
            script = None
            for j, a in enumerate(args):
                if a == "-c" or (re.fullmatch(r"-[A-Za-z]+", a) and "c" in a[1:]):
                    if j + 1 < len(args):
                        script = args[j + 1]
                    break
            if script is None:
                return  # `bash script.sh` — execution, not a direct write op
            if shifted:
                ambiguities.append("nested shell after `cd` cannot be resolved "
                                   "statically")
                return
            sub_t, sub_a = _analyze(script, cwd, depth + 1)
            targets.extend(sub_t)
            ambiguities.extend(sub_a)
            return
        if cmd == "eval":
            joined = " ".join(args)
            if "$" in joined or "`" in joined:
                ambiguities.append("eval over shell variables hides the real command")
                return
            sub_t, sub_a = _analyze(joined, cwd, depth + 1)
            targets.extend(sub_t)
            ambiguities.extend(sub_a)
            return
        if cmd == "xargs":
            if any(os.path.basename(a) in _RISKY for a in args if not a.startswith("-")):
                ambiguities.append("xargs feeds runtime-determined arguments to a "
                                   "command that can write or delete")
            return
        if cmd == "find":
            if "-delete" in args:
                ambiguities.append("find -delete removes runtime-determined paths")
            elif (any(a in ("-exec", "-execdir", "-ok", "-okdir") for a in args)
                  and any(os.path.basename(a) in _RISKY for a in args)):
                ambiguities.append("find -exec over a command that can write or "
                                   "delete has runtime-determined targets")
            return
        if cmd == "tee":
            for a in _operands(args):
                resolve(a)
            return
        if cmd in _DELETERS or cmd == "mv":
            # mv mutates both ends — the source is deleted, the destination written —
            # so every operand (including a `-t` directory) is checked.
            for a in _operands(args):
                resolve(a)
            return
        if cmd in ("cp", "install"):
            dest_from_t = None
            ops: list[str] = []
            j = 0
            while j < len(args):
                a = args[j]
                if a == "--":
                    ops.extend(x for x in args[j + 1:] if x != "-")
                    break
                if a in ("-t", "--target-directory"):
                    j += 1
                    if j < len(args):
                        dest_from_t = args[j]
                elif a.startswith("--target-directory="):
                    dest_from_t = a.split("=", 1)[1]
                elif a.startswith("-") and a != "-":
                    if cmd == "install" and a in ("-m", "-o", "-g", "-S", "--mode",
                                                  "--owner", "--group", "--suffix"):
                        j += 1  # this flag consumes a value
                else:
                    ops.append(a)
                j += 1
            if dest_from_t is not None:
                resolve(dest_from_t)
            elif len(ops) >= 2:
                resolve(ops[-1])  # only the destination is mutated; sources are reads
            return
        if cmd in _INPLACE_EDITORS:
            inplace = any(a == "--in-place" or a.startswith("--in-place=")
                          or (a.startswith("-") and not a.startswith("--")
                              and "i" in a[1:])
                          for a in args if a.startswith("-"))
            if not inplace:
                return  # plain interpreter/stream run — not a detected write op
            has_script_flag = False
            ops = []
            j = 0
            while j < len(args):
                a = args[j]
                if a == "--":
                    ops.extend(x for x in args[j + 1:] if x != "-")
                    break
                if a.startswith("-") and a != "-":
                    if cmd == "sed" and a in ("-e", "-f", "--expression", "--file"):
                        has_script_flag = True
                        j += 1  # the script / script-file argument (a read)
                    elif cmd == "sed" and (a.startswith("--expression=")
                                           or a.startswith("--file=")):
                        has_script_flag = True
                    elif cmd != "sed" and _SCRIPT_FLAG_RE.fullmatch(a):
                        j += 1  # interpreter script/module argument
                elif a != "-":
                    ops.append(a)
                j += 1
            if cmd == "sed" and not has_script_flag and ops:
                ops = ops[1:]  # the first bare operand is the sed script
            for a in ops:
                resolve(a)
            return
        if cmd == "git":
            base: object = None
            sub = None
            j = 0
            while j < len(args):
                a = args[j]
                if a == "-C":
                    j += 1
                    if j < len(args):
                        d = os.path.expanduser(args[j])
                        if "$" in d or "`" in d:
                            ambiguities.append("git -C over a shell variable cannot "
                                               "be resolved statically")
                            return
                        if not _isabs(d):
                            if shifted or not isinstance(cwd, str) or not cwd:
                                ambiguities.append(f"git -C with unresolvable "
                                                   f"relative directory '{args[j]}'")
                                return
                            d = os.path.join(cwd, d)
                        base = d
                elif a in ("-c", "--git-dir", "--work-tree", "--namespace",
                           "--exec-path"):
                    j += 1
                elif a.startswith("-"):
                    pass
                else:
                    sub = a
                    break
                j += 1
            if sub in ("mv", "rm"):
                for a in _operands(args[j + 1:]):
                    resolve(a, base)
            return
        # anything else: not a recognized write/delete operation — passes

    cur: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if all(c in "();|&\n" for c in tok) and (">" not in tok and "<" not in tok):
            finalize(cur)
            cur = []
        elif all(c in "<>|&" for c in tok) and (">" in tok or "<" in tok):
            if cur and cur[-1].isdigit():
                cur.pop()  # fd number the tokenizer split off (2>file) — not an operand
            if tok == "<<":
                ambiguities.append("a heredoc defeats static tokenization")
                break
            i += 1
            nxt = tokens[i] if i < len(tokens) else None
            if ">" in tok:
                if nxt is None or all(c in "();<>|&\n" for c in nxt):
                    ambiguities.append("output redirection with no target")
                elif tok.endswith("&") and (nxt.isdigit() or nxt == "-"):
                    pass  # fd duplication/close (2>&1, >&-) — not a file target
                else:
                    resolve(nxt)
            # pure reads (<, <<<): operand consumed and ignored
        else:
            cur.append(tok)
        i += 1
    finalize(cur)
    return targets, ambiguities


def _reviewer_lex(command: str,
                  literal_backslash: bool | None = None) -> tuple[list[dict], str | None]:
    """Split a reviewer's command into simple commands, or name what stops that.

    A deliberately small shell reader for the allowlist: plain words with single
    quotes, double quotes and backslashes; `;`, `&&`, `||`, `|` and newlines between
    commands; and redirections, which are returned for judging. Every
    other construct — expansion (`$`, backticks), subshells and grouping (`(`, `)`),
    background jobs, `|&`, case separators — returns a reason instead, because the
    reader does not model it; so does a `#` comment, since whether one starts depends on
    the shell's options. Each word keeps a per-character quoted flag so glob and
    brace characters are judged only where the shell would expand them.

    On Windows (`literal_backslash` defaults to `os.name == "nt"`) the harness runs
    the command through PowerShell or cmd, where a backslash is an ordinary character,
    so `C:\\Users\\x` stays one path. Backticks and `$` are still refused."""
    if literal_backslash is None:
        literal_backslash = os.name == "nt"
    commands: list[dict] = [{"words": [], "redirs": []}]
    n = len(command)
    i = 0
    breaks = " \t;&|<>()\n"

    def read_word(i: int) -> tuple[list[tuple[str, bool]], int, str | None]:
        chars: list[tuple[str, bool]] = []
        while i < n:
            c = command[i]
            if c in breaks:
                break
            if c == "'":
                j = command.find("'", i + 1)
                if j < 0:
                    return chars, i, "an unterminated single quote"
                chars.extend((ch, True) for ch in command[i + 1:j])
                i = j + 1
            elif c == '"':
                i += 1
                while True:
                    if i >= n:
                        return chars, i, "an unterminated double quote"
                    ch = command[i]
                    if ch == '"':
                        i += 1
                        break
                    if ch in "$`":
                        return chars, i, (f"`{ch}` inside double quotes expands to text "
                                          "this check cannot see")
                    if (ch == "\\" and not literal_backslash and i + 1 < n
                            and command[i + 1] in '$`"\\\n'):
                        if command[i + 1] != "\n":
                            chars.append((command[i + 1], True))
                        i += 2
                        continue
                    chars.append((ch, True))
                    i += 1
            elif c == "\\" and not literal_backslash:
                if i + 1 >= n:
                    return chars, i, "a trailing backslash"
                if command[i + 1] != "\n":
                    chars.append((command[i + 1], True))
                i += 2
            elif c in "$`":
                return chars, i, (f"`{c}` expands a variable, a command or arithmetic into "
                                  "text this check cannot see")
            else:
                chars.append((c, False))
                i += 1
        return chars, i, None

    last_word_end = -1
    while i < n:
        c = command[i]
        if c in " \t":
            i += 1
            continue
        if (c == "\\" and not literal_backslash and i + 1 < n
                and command[i + 1] == "\n"):
            i += 2  # line continuation
            continue
        if c == "#":
            return [], ("a `#` comment; bash and zsh do not agree on when one starts, so "
                        "leave it out")
        if c == "\n" or c == ";":
            if c == ";" and i + 1 < n and command[i + 1] in ";&":
                return [], "`;;`/`;&` belong to `case`, which is compound syntax"
            commands.append({"words": [], "redirs": []})
            i += 1
            continue
        if c in "()":
            return [], f"`{c}` opens a subshell, a function or a group"
        if c == "&" and command.startswith("&&", i):
            commands.append({"words": [], "redirs": []})
            i += 2
            continue
        if c == "|":
            if command.startswith("||", i):
                i += 2
            elif command.startswith("|&", i):
                return [], "`|&` pipes a second stream into a command"
            else:
                i += 1
            commands.append({"words": [], "redirs": []})
            continue
        if c in "<>" or (c == "&" and command.startswith("&>", i)):
            cur = commands[-1]
            fd = None
            if (cur["words"] and last_word_end == i and cur["words"][-1]
                    and all(ch.isdigit() and not q for ch, q in cur["words"][-1])):
                fd = "".join(ch for ch, _ in cur["words"].pop())
            op = next(o for o in ("<<<", "<<-", "&>>", "<<", "<>", "<&", ">>", ">|", ">&", "&>",
                                  "<", ">") if command.startswith(o, i))
            i += len(op)
            while i < n and command[i] in " \t":
                i += 1
            target, i, err = read_word(i)
            if err:
                return [], err
            if not target:
                return [], f"the redirection `{op}` has no plain target"
            cur["redirs"].append((fd, op, target))
            continue
        if c == "&":
            return [], "`&` runs a command in the background"
        word, i, err = read_word(i)
        if err:
            return [], err
        commands[-1]["words"].append(word)
        last_word_end = i
    return [c for c in commands if c["words"] or c["redirs"]], None


def _plain(word: list[tuple[str, bool]]) -> str:
    return "".join(ch for ch, _ in word)


def _word_problem(word: list[tuple[str, bool]]) -> str | None:
    """Glob and brace characters the shell would expand, judged by quoting."""
    value = _plain(word)
    if value in ("[", "]") and not word[0][1]:
        return None  # the `[` test command and its closing bracket
    unquoted = "".join("_" if q else ch for ch, q in word)
    if any(ch in unquoted for ch in "*?["):
        return (f"`{value}` has an unquoted glob character; quote it, or use Glob — a "
                "pattern can expand to names that read as options")
    # `rev^{tree}` and `ref@{1}` are git revision syntax, not brace expansion.
    kept = re.sub(r"(?<=[\^@])\{[^{},]*\}", lambda m: m.group() if ".." in m.group() else "",
                  unquoted)
    if "{" in kept or "}" in kept:
        return f"`{value}` has an unquoted brace, which the shell can expand into words"
    return None


def _long_hits(arg: str, names: tuple[str, ...], exact_ok: tuple[str, ...] = ()) -> bool:
    """True when `arg` is one of `names`, or a prefix a GNU/git parser completes to one."""
    name = arg.split("=", 1)[0]
    if not name.startswith("--") or name == "--" or name in exact_ok:
        return False
    return any(full.startswith(name) for full in names)


def _flag_words(args: list[str]) -> list[str]:
    """Arguments before `--` that look like options."""
    out = []
    for a in args:
        if a == "--":
            break
        if a.startswith("-") and a != "-":
            out.append(a)
    return out


def _path_key(path: str, pathmod=os.path) -> str:
    """A comparison key for a resolved directory: on Windows, drive-letter case, letter
    case and `/` versus `\\` do not name a different directory (`git worktree list`
    prints `C:/...`). On POSIX this is the path itself."""
    return pathmod.normcase(pathmod.normpath(path))


def _reviewer_roots(cwd: object) -> list[str]:
    """Where a reviewer's `git -C` may point: the working directory itself and the top
    level of every worktree of its repository — never a directory below one, which may
    be a different repository nested inside with its own config."""
    if not isinstance(cwd, str) or not cwd:
        return []
    roots = [os.path.realpath(cwd)]
    try:
        out = subprocess.run(["git", "-C", cwd, "worktree", "list", "--porcelain"],
                             capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return roots
    if out.returncode == 0:
        for line in out.stdout.decode("utf-8", errors="surrogateescape").splitlines():
            if line.startswith("worktree "):
                roots.append(os.path.realpath(line[len("worktree "):]))
    return roots


def _reviewer_git(args: list[str], cwd: object) -> str | None:
    sub = None
    j = 0
    base = None
    while j < len(args):
        a = args[j]
        if a == "-C":
            if j + 1 >= len(args):
                return "`git -C` names no directory"
            d = args[j + 1]
            roots = _reviewer_roots(cwd)
            if d.startswith("~") or not roots:
                return f"`git -C {d}` cannot be resolved against the working directory"
            # git applies each `-C` relative to the one before it.
            base = os.path.realpath(d if _isabs(d) else os.path.join(base or roots[0], d))
            if _path_key(base) not in {_path_key(r) for r in roots}:
                return (f"`git -C {d}` is outside the working directory and the top "
                        "levels of this repository's worktrees (a directory below one may "
                        "be another repository with its own config)")
            j += 2
            continue
        if a in _GIT_GLOBAL_FLAGS:
            j += 1
            continue
        if a.startswith("-"):
            if a in ("--version", "--help") and j == len(args) - 1:
                return None
            return (f"`git {a}` is not a global option reviewers may use (`-c`, "
                    "`--config-env`, `--exec-path`, `--git-dir` and kin can point git at "
                    "another program or repository)")
        sub = a
        break
    if sub is None:
        return "`git` with no subcommand"
    if sub not in _GIT_READ:
        return (f"`git {sub}` is not on the reviewers' read-only git list "
                f"({', '.join(sorted(_GIT_READ))})")
    rest = args[j + 1:]
    flags = _flag_words(rest)
    for a in flags:
        if _long_hits(a, _GIT_DENIED_LONG, exact_ok=("--text",)):
            return f"`git {sub} {a}` writes a file or runs a configured program"
    if sub == "grep" and any(not a.startswith("--") and "O" in a for a in flags):
        return "`git grep -O` opens the matches in a pager program"
    positional = [a for a in rest if not a.startswith("-")]
    if sub == "branch":
        names = {a.split("=", 1)[0] for a in flags}
        if names - _GIT_BRANCH_FLAGS or (positional and not names & _GIT_BRANCH_LIST_MODE):
            return f"`git branch {' '.join(rest)}` creates, moves or deletes a branch"
    elif sub == "worktree":
        if positional[:1] != ["list"] or len(positional) > 1 or set(flags) - {
                "--porcelain", "-v", "--verbose", "-z"}:
            return "only `git worktree list` is read-only"
    elif sub == "symbolic-ref":
        if set(flags) - {"-q", "--quiet", "--short", "--no-recurse"} or len(positional) != 1:
            return "`git symbolic-ref` with these arguments changes a ref"
    elif sub == "config":
        names = {a.split("=", 1)[0] for a in flags}
        verb = positional[0] if positional else None
        reading = names & _GIT_CONFIG_READ_ACTIONS or verb in ("get", "list")
        if names - _GIT_CONFIG_FLAGS or not reading:
            return "only the reading forms of `git config` (`--get`, `--list`, ...) are read-only"
    return None


def _reviewer_simple(words: list[str], cwd: object) -> str | None:
    """Judge one simple command (assignments already split off) against the allowlist."""
    cmd, args = words[0], words[1:]
    if cmd in _SHELL_SYNTAX:
        return f"`{cmd}` is shell compound syntax; reviewers run plain simple commands"
    if "/" in cmd or "\\" in cmd:
        return (f"`{cmd}` names a program by path; reviewers read code and do not run it, "
                "and run listed tools by name only")
    if cmd in _RUNNERS:
        return (f"`{cmd}` runs another command or a script, or changes the shell; reviewers "
                "read code and do not run it")
    if cmd not in _REVIEWER_COMMANDS:
        return (f"`{cmd}` is not on the reviewers' read-only command list "
                f"({', '.join(_REVIEWER_COMMANDS)})")
    flags = _flag_words(args)
    if cmd == "git":
        return _reviewer_git(args, cwd)
    if cmd == "find":
        hit = next((a for a in args if a in _FIND_DENIED), None)
        return f"`find {hit}` runs a command, deletes, or writes a file" if hit else None
    if cmd == "sort":
        if (any(not a.startswith("--") and ("o" in a or "T" in a) for a in flags)
                or any(_long_hits(a, ("--output", "--compress-program",
                                      "--temporary-directory")) for a in flags)):
            return "`sort -o`/`-T`/`--compress-program` writes a file or runs a program"
    if cmd == "uniq":
        operands, skip, done = [], False, False
        for a in args:
            if skip:
                skip = False
            elif done or not a.startswith("-") or a == "-":
                operands.append(a)
            elif a == "--":
                done = True
            elif a in ("-f", "-s", "-w"):
                skip = True
        if len(operands) > 1:
            return "`uniq IN OUT` writes its second operand"
    if cmd == "file" and (any(not a.startswith("--") and "C" in a for a in flags)
                          or any(_long_hits(a, ("--compile",)) for a in flags)):
        return "`file -C` compiles a magic file and writes the result"
    if cmd == "rg" and any(a.split("=", 1)[0] in ("--pre", "--hostname-bin") for a in flags):
        return "`rg --pre`/`--hostname-bin` runs a program"
    return None


def _reviewer_verdict(command: str, cwd: object) -> str | None:
    """None when the whole command is on the allowlist, else the first reason it is not."""
    commands, err = _reviewer_lex(command)
    if err:
        return err
    for c in commands:
        for fd, op, target in c["redirs"]:
            value = _plain(target)
            if op in (">", ">>", "&>", "&>>", "<") and value == _REDIRECT_SINK:
                continue
            if op in (">&", "<&") and (value.isdigit() or value == "-"):
                continue
            return (f"the redirection `{fd or ''}{op} {value}` is not `/dev/null` or a file "
                    "descriptor copy such as `2>&1`")
        words = [_plain(w) for w in c["words"]]
        k = 0
        while k < len(words) and re.match(r"[A-Za-z_][A-Za-z0-9_]*=", words[k]) and all(
                not q for _, q in c["words"][k][:words[k].index("=") + 1]):
            if words[k] not in _REVIEWER_ASSIGNMENTS:
                return (f"the `{words[k].split('=', 1)[0]}=` assignment can change what a "
                        "command runs; only " + ", ".join(sorted(_REVIEWER_ASSIGNMENTS))
                        + " may prefix a reviewer's command")
            k += 1
        if k == len(words):
            return "a command with no program name (a bare assignment or redirection)"
        if words[k] in _SHELL_SYNTAX:
            return _reviewer_simple(words[k:], cwd)
        for word in c["words"]:
            problem = _word_problem(word)
            if problem:
                return problem
        reason = _reviewer_simple(words[k:], cwd)
        if reason:
            return reason
    return None


def _decide_bash(writer: str, conf: dict, tool_input: object,
                 cwd: object) -> tuple[int, str]:
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str):
        return 2, (
            f"hatch: '{writer}' is the {conf['label']} writer and this Bash call "
            "carries no verifiable command string (tool_input.command missing or not "
            "a string) — an unverifiable call from a confined writer is denied, not "
            f"waved through. {conf['doctrine']}.")
    targets, ambiguities = _analyze(command, cwd)
    if ambiguities:
        return 2, (
            f"hatch: '{writer}' is the {conf['label']} writer and this Bash command "
            f"is ambiguous to the confinement check ({ambiguities[0]}) — this guard "
            "fails closed for its recognized writers, so an ambiguous or unparseable "
            f"shell command is denied, not waved through. {conf['doctrine']}; use a "
            "plainly parseable command, or the Write/Edit tools, against that surface.")
    for target in targets:
        if not _allowed(conf, target, cwd):
            return 2, (
                f"hatch: '{writer}' is the {conf['label']} writer and this Bash "
                f"command writes or deletes '{target}', outside its writable surface. "
                f"{conf['doctrine']}; nothing else is this writer's to touch via the "
                "shell either. Redirect the operation into that surface or drop it.")
    return 0, ""


def _decide_reviewer(payload: dict) -> tuple[int, str]:
    who = payload["agent_type"]
    tool = payload.get("tool_name")
    if tool in _EDIT_TOOLS:
        return 2, (
            f"hatch: '{who}' is a read-only gate reviewer and `{tool}` edits a "
            f"file. {_REVIEWER_DOCTRINE}. Report the finding instead of making the change.")
    if tool != "Bash":
        return 0, ""  # Read, Grep, Glob, ... — nothing to confine
    tool_input = payload.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str):
        return 2, (
            f"hatch: '{who}' is a read-only gate reviewer and this Bash call "
            "carries no verifiable command string (tool_input.command missing or not a "
            "string) — an unverifiable call is denied, not waved through. "
            f"{_REVIEWER_DOCTRINE}.")
    reason = _reviewer_verdict(command, payload.get("cwd"))
    if reason:
        return 2, (
            f"hatch: '{who}' is a read-only gate reviewer and this Bash command is "
            f"outside the reviewers' read-only allowlist: {reason}. {_REVIEWER_DOCTRINE}; "
            "run listed read-only tools by name (git diff/log/show/status/rev-parse, grep, "
            "rg, cat, ls, find, jq, sha256sum, ...) joined only by `;`, `&&`, `||`, `|` or "
            "newlines, or use Read/Grep/Glob. The guard fails closed: anything it does not "
            "list is denied.")
    return 0, ""


def decide(payload: object) -> tuple[int, str]:
    """Return (exit_code, stderr_reason)."""
    if not isinstance(payload, dict):
        return 0, ""  # unrecognized shape — pass
    key = _recognized(payload.get("agent_type"))
    if key is None:
        if _recognized_reviewer(payload.get("agent_type")) is not None:
            return _decide_reviewer(payload)
        return 0, ""  # main thread or unknown agent — pass
    conf = WRITERS[key]
    writer = payload["agent_type"]
    tool_input = payload.get("tool_input")
    if payload.get("tool_name") == "Bash":
        return _decide_bash(writer, conf, tool_input, payload.get("cwd"))
    # `path` is the Copilot CLI spelling (Write {path, file_text}, Edit {path, ...}).
    targets = ([tool_input[k] for k in ("file_path", "notebook_path", "path")
                if k in tool_input]
               if isinstance(tool_input, dict) else [])
    if not targets or not all(isinstance(t, str) for t in targets):
        return 2, (
            f"hatch: '{writer}' is the {conf['label']} writer and this call carries "
            "no verifiable write target (tool_input.file_path / "
            "tool_input.notebook_path / tool_input.path missing or not a string) — an unverifiable "
            f"write from a confined writer is denied, not waved through. "
            f"{conf['doctrine']}; every {conf['label']} write must name a path inside "
            "that surface.")
    for target in targets:
        if not _allowed(conf, target, payload.get("cwd")):
            return 2, (
                f"hatch: '{writer}' is the {conf['label']} writer and '{target}' is "
                f"outside its writable surface. {conf['doctrine']}; this path is not, "
                "and nothing else is this writer's to write. Redirect the edit into "
                "that surface or drop it.")
    return 0, ""


def _run_self_test() -> int:
    def pre(agent_type: object = None, tool: str = "Write",
            tool_input: object = "__kwargs__", cwd: object = "/tmp",
            **ti: object) -> dict:
        payload: dict = {"hook_event_name": "PreToolUse", "tool_name": tool, "cwd": cwd}
        if agent_type is not None:
            payload["agent_type"] = agent_type
        payload["tool_input"] = ti if tool_input == "__kwargs__" else tool_input
        return payload

    def sh(agent_type: object, command: object = None, cwd: object = "/repo",
           tool_input: object = "__auto__") -> dict:
        payload: dict = {"hook_event_name": "PreToolUse", "tool_name": "Bash",
                         "cwd": cwd}
        if agent_type is not None:
            payload["agent_type"] = agent_type
        payload["tool_input"] = ({"command": command} if tool_input == "__auto__"
                                 else tool_input)
        return payload

    cases = [
        # --- kaizen on Write/Edit/NotebookEdit (original cut, unchanged) ---
        ("bare hatch-kaizen writing a .hatch/sme/ pack passes",
         pre("hatch-kaizen", file_path=".hatch/sme/python.md", content="x"), 0, None),
        ("namespaced hatch:hatch-kaizen writing a .hatch/sme/ pack passes",
         pre("hatch:hatch-kaizen", file_path=".hatch/sme/python.md", content="x"), 0, None),
        ("absolute worktree .hatch/sme/ path passes (segment anchor)",
         pre("hatch-kaizen",
             cwd="/abs/worktree", file_path="/abs/worktree/.hatch/sme/minimalism.md", content="x"), 0, None),
        ("nested src/x/.hatch/sme/y.md passes (accepted residual)",
         pre("hatch-kaizen", file_path="src/x/.hatch/sme/y.md", content="x"), 0, None),
        ("exact .hatch/kaizen.json passes",
         pre("hatch-kaizen", file_path=".hatch/kaizen.json", content="{}"), 0, None),
        (".hatch/kaizen.json.bak denied (end-anchored match)",
         pre("hatch-kaizen", file_path=".hatch/kaizen.json.bak", content="{}"),
         2, ".hatch/kaizen.json.bak"),
        (".hatch/sme-extras/x.md denied (segment boundary)",
         pre("hatch-kaizen", file_path=".hatch/sme-extras/x.md", content="x"),
         2, ".hatch/sme-extras/x.md"),
        ("bare .hatch/sme denied (no trailing segment)",
         pre("hatch-kaizen", file_path=".hatch/sme", content="x"), 2, None),
        ("out-of-surface skill file denied, reason names path and surface",
         pre("hatch-kaizen", file_path="skills/hatch-plan/SKILL.md", content="x"),
         2, ("skills/hatch-plan/SKILL.md", "`.hatch/sme/`", "`.hatch/kaizen.json`")),
        (".hatch/binders/x.json denied (confinement, independent of immutability)",
         pre("hatch-kaizen", file_path=".hatch/binders/x.json", content="{}"), 2, None),
        (".hatch/sme/../../src/app.py traversal normalized then denied",
         pre("hatch-kaizen", file_path=".hatch/sme/../../src/app.py", content="x"), 2, None),
        ("NotebookEdit with notebook_path outside the surface denied",
         pre("hatch-kaizen", tool="NotebookEdit",
             notebook_path="notebooks/scratch.ipynb"), 2, "notebooks/scratch.ipynb"),
        ("tool_input not a dict denied (unverifiable — fail-closed)",
         pre("hatch-kaizen", tool_input="junk"), 2, "no verifiable"),
        ("Copilot Write {path, file_text} inside the surface allowed",
         pre("hatch-kaizen", path=".hatch/sme/python.md", file_text="x"), 0, None),
        ("Copilot Write {path, file_text} outside the surface denied",
         pre("hatch-kaizen", path="skills/x/SKILL.md", file_text="x"), 2, "skills/x/SKILL.md"),
        ("non-string file_path denied (unverifiable)",
         pre("hatch-kaizen", file_path=42, content="x"), 2, "no verifiable"),
        ("hatch-kaizen-v2 writing anywhere passes (not an exact match)",
         pre("hatch-kaizen-v2", file_path="src/app.py", content="x"), 0, None),
        ("main-thread write (no agent_type) passes",
         pre(file_path="skills/hatch-plan/SKILL.md", content="x"), 0, None),
        ("unknown agent (Explore) writing anywhere passes",
         pre("Explore", file_path="src/app.py", content="x"), 0, None),
        ("doc-gardner (hatch:hatch-doc-gardner) writing docs/x.md passes (in surface)",
         pre("hatch:hatch-doc-gardner", file_path="docs/x.md", content="x"), 0, None),
        ("payload not a dict passes (unrecognized shape)", "not a dict", 0, None),
        ("prose mentioning kaizen without agent_type passes (identity from the field)",
         pre(file_path="docs/notes.md",
             content="hatch-kaizen edits the packs; hatch:hatch-kaizen when namespaced"),
         0, None),
        # --- doc-gardner confinement row (A1) ---
        ("bare hatch-doc-gardner writing README.md passes",
         pre("hatch-doc-gardner", file_path="README.md", content="x"), 0, None),
        ("doc-gardner writing an absolute docs/ path passes (segment anchor)",
         pre("hatch:hatch-doc-gardner",
             cwd="/abs/worktree", file_path="/abs/worktree/docs/how-to/hooks.md", content="x"), 0, None),
        ("doc-gardner writing AGENTS.md passes",
         pre("hatch-doc-gardner", file_path="AGENTS.md", content="x"), 0, None),
        ("doc-gardner writing CLAUDE.md passes",
         pre("hatch-doc-gardner", file_path="CLAUDE.md", content="x"), 0, None),
        ("doc-gardner writing ARCHITECTURE.md passes (prefix pattern)",
         pre("hatch-doc-gardner", file_path="ARCHITECTURE.md", content="x"), 0, None),
        ("doc-gardner writing .gitignore passes (the one non-doc exception)",
         pre("hatch-doc-gardner", file_path=".gitignore", content="superpowers/"),
         0, None),
        ("doc-gardner writing other top-level markdown passes (cwd-relative)",
         pre("hatch:hatch-doc-gardner", file_path="/repo/CHANGELOG.md", content="x",
             cwd="/repo"), 0, None),
        ("doc-gardner absolute README outside the active worktree is denied",
         pre("hatch-doc-gardner", file_path="/abs/worktree/README.md", content="x"),
         2, None),
        ("doc-gardner writing nested non-doc markdown denied (not top-level)",
         pre("hatch-doc-gardner", file_path="/repo/src/notes.md", content="x",
             cwd="/repo"), 2, "src/notes.md"),
        ("doc-gardner writing a skill file denied, reason names the doc surface",
         pre("hatch:hatch-doc-gardner", file_path="skills/hatch-plan/SKILL.md",
             content="x"), 2, ("skills/hatch-plan/SKILL.md", "`docs/`")),
        ("doc-gardner writing .hatch/sme/python.md denied (zero .hatch surface)",
         pre("hatch-doc-gardner", file_path=".hatch/sme/python.md", content="x"),
         2, ".hatch/sme/python.md"),
        ("doc-gardner writing .hatch/doc-gardner.json denied (config is user-authored)",
         pre("hatch-doc-gardner", file_path=".hatch/doc-gardner.json", content="{}"),
         2, None),
        ("doc-gardner writing src/app.py denied",
         pre("hatch-doc-gardner", file_path="src/app.py", content="x"), 2, None),
        ("doc-gardner writing mydocs/x.md denied (docs/ segment boundary)",
         pre("hatch-doc-gardner", file_path="mydocs/x.md", content="x"), 2, None),
        ("kaizen writing README.md denied (surfaces are per-writer)",
         pre("hatch-kaizen", file_path="README.md", content="x"), 2, "README.md"),
        ("hatch-doc-gardner-v2 writing anywhere passes (not an exact match)",
         pre("hatch-doc-gardner-v2", file_path="src/app.py", content="x"), 0, None),
        # --- Bash coverage (A2): main thread / unrecognized always pass ---
        ("main-thread Bash rm -rf passes (no agent_type)",
         sh(None, "rm -rf /anything"), 0, None),
        ("unknown agent Bash redirect passes",
         sh("Explore", "echo x > /etc/motd"), 0, None),
        # --- Bash coverage: benign non-write commands pass ---
        ("kaizen `git status` passes (non-write command)",
         sh("hatch-kaizen", "git status"), 0, None),
        ("kaizen `grep -r TODO src/` passes (non-write command)",
         sh("hatch-kaizen", "grep -r TODO src/"), 0, None),
        ("kaizen `ls src 2>&1` passes (fd duplication is not a file target)",
         sh("hatch-kaizen", "ls src 2>&1"), 0, None),
        ("kaizen quiet probe passes (sink devices are not write targets)",
         sh("hatch-kaizen", "command -v plannotator >/dev/null 2>&1"), 0, None),
        ("doc-gardner stderr-to-/dev/null passes (quiet idiom)",
         sh("hatch-doc-gardner", "grep -q pattern README.md 2>/dev/null"), 0, None),
        ("kaizen stdout-to-/dev/null passes (sink device)",
         sh("hatch-kaizen", "git ls-files docs > /dev/null"), 0, None),
        ("doc-gardner fd-number redirect resolves the target, not the fd",
         sh("hatch-doc-gardner", "rm docs/old.md 2>docs/err.log"), 0, None),
        ("kaizen fd-redirect delete outside the surface still blocked",
         sh("hatch-kaizen", "rm README.md 2>/dev/null"), 2, "README.md"),
        ("kaizen `command` with a non-query flag stays ambiguous (blocked)",
         sh("hatch-kaizen", "command -p rm .hatch/sme/x.md"), 2, None),
        ("kaizen empty Bash command passes (nothing to write)",
         sh("hatch-kaizen", ""), 0, None),
        # --- Bash coverage: in-surface writes pass, bypasses are blocked ---
        ("kaizen redirect into .hatch/sme/ passes",
         sh("hatch-kaizen", "echo note > .hatch/sme/note.md"), 0, None),
        ("kaizen redirect outside the surface blocked",
         sh("hatch-kaizen", "echo x > /etc/evil"), 2, "/etc/evil"),
        ("kaizen append redirect outside the surface blocked",
         sh("hatch:hatch-kaizen", "echo x >> src/app.py"), 2, "src/app.py"),
        ("kaizen tee bypass blocked (pipeline split)",
         sh("hatch-kaizen", "cat .hatch/sme/x.md | tee /tmp/leak"), 2, "/tmp/leak"),
        ("kaizen tee into the surface passes (multiple files)",
         sh("hatch-kaizen", "echo x | tee .hatch/sme/a.md .hatch/sme/b.md"), 0, None),
        ("kaizen sed -i outside the surface blocked",
         sh("hatch-kaizen", "sed -i s/a/b/ src/app.py"), 2, "src/app.py"),
        ("kaizen sed -i on a pack passes (script operand skipped)",
         sh("hatch-kaizen", "sed -i s/a/b/ .hatch/sme/python.md"), 0, None),
        ("kaizen rm of a pack passes (in-surface delete)",
         sh("hatch-kaizen", "rm .hatch/sme/stale.md"), 0, None),
        ("kaizen rm -rf outside the surface blocked (resolved against cwd)",
         sh("hatch-kaizen", "rm -rf docs"), 2, "/repo/docs"),
        ("kaizen mv checks both ends — pack moved out of the surface blocked",
         sh("hatch-kaizen", "mv .hatch/sme/a.md /tmp/a.md"), 2, "/tmp/a.md"),
        ("kaizen git rm outside the surface blocked",
         sh("hatch-kaizen", "git rm docs/x.md"), 2, "/repo/docs/x.md"),
        ("kaizen git -C resolves against the -C directory, blocked",
         sh("hatch-kaizen", "git -C /elsewhere rm notes.txt"), 2,
         "/elsewhere/notes.txt"),
        ("env-assignment prefix does not hide the command — blocked",
         sh("hatch-kaizen", "FOO=1 rm -rf src"), 2, "/repo/src"),
        ("bash -c wrapper is unwrapped — escape blocked",
         sh("hatch-kaizen", "bash -c 'echo x > /etc/evil'"), 2, "/etc/evil"),
        ("bash -c wrapper with an in-surface write passes",
         sh("hatch-kaizen", "bash -c 'echo x > .hatch/sme/x.md'"), 0, None),
        # --- Bash coverage: doc-gardner surface ---
        ("doc-gardner redirect into docs/ passes",
         sh("hatch-doc-gardner", "echo x >> docs/notes.md"), 0, None),
        ("doc-gardner redirect into top-level markdown passes (cwd resolution)",
         sh("hatch-doc-gardner", "echo x >> CHANGELOG.md"), 0, None),
        ("doc-gardner git mv within docs/ passes",
         sh("hatch:hatch-doc-gardner", "git mv docs/a.md docs/b.md"), 0, None),
        ("doc-gardner rm within docs/ passes (relative resolution against cwd)",
         sh("hatch-doc-gardner", "rm docs/old.md"), 0, None),
        ("doc-gardner cp checks the destination only (superpowers salvage shape)",
         sh("hatch-doc-gardner",
            "cp superpowers/design.md docs/design-docs/design.md"), 0, None),
        ("doc-gardner redirect into src blocked",
         sh("hatch-doc-gardner", "echo x > src/main.py"), 2, "/repo/src/main.py"),
        ("doc-gardner rm of code blocked",
         sh("hatch-doc-gardner", "rm src/app.py"), 2, "/repo/src/app.py"),
        # --- Bash coverage: ambiguous/unparseable posture — fail-closed, denied ---
        ("variable write target is ambiguous — blocked (fail-closed posture)",
         sh("hatch-kaizen", "echo x > $OUT"), 2, ("ambiguous", "fails closed")),
        ("command substitution is ambiguous — blocked even aimed at the surface",
         sh("hatch-kaizen", "echo $(date) > .hatch/sme/x.md"), 2, "ambiguous"),
        ("unparseable command (unbalanced quote) blocked",
         sh("hatch-kaizen", 'echo "unterminated > .hatch/sme/x.md'), 2, "ambiguous"),
        ("heredoc blocked as ambiguous even into the surface",
         sh("hatch-kaizen", "cat << EOF > .hatch/sme/x.md"), 2, "heredoc"),
        ("cd then relative write is ambiguous — blocked",
         sh("hatch-doc-gardner", "cd /tmp && echo x > escape.md"), 2, "cd"),
        ("xargs into rm is ambiguous — blocked",
         sh("hatch-kaizen", "find . -name '*.md' | xargs rm"), 2, "xargs"),
        ("relative target with no cwd in the payload is ambiguous — blocked",
         sh("hatch-kaizen", "echo x > .hatch/sme/x.md", cwd=None), 2, "no cwd"),
        ("recognized writer Bash with no command string blocked (unverifiable)",
         sh("hatch-kaizen", tool_input={}), 2, "no verifiable"),
        # --- read-only gate reviewers: empty writable surface ---
        ("safety auditor Write denied",
         pre("hatch-safety-auditor", file_path="docs/x.md", content="x"), 2, "read-only"),
        ("namespaced acceptance reviewer MultiEdit denied",
         pre("hatch:hatch-acceptance-reviewer", tool="MultiEdit",
             file_path="src/app.py", edits=[]), 2, "`MultiEdit`"),
        ("design reviewer Read passes",
         pre("hatch-design-reviewer", tool="Read", file_path="src/app.py"), 0, None),
        ("reviewer redirect denied", sh("hatch-safety-auditor", "echo x > out.txt"),
         2, ("allowlist", "out.txt")),
        ("reviewer touch denied (not listed)", sh("hatch-safety-auditor", "touch x"),
         2, "`touch` is not on the reviewers' read-only command list"),
        ("reviewer git add denied", sh("hatch-acceptance-reviewer", "git add -A"),
         2, "`git add`"),
        ("reviewer git -c denied", sh("hatch-acceptance-reviewer",
                                      "git -c core.pager=cat log"), 2, "`git -c`"),
        ("reviewer package install denied", sh("hatch-safety-auditor",
                                                "npm install x"), 2, "`npm`"),
        ("reviewer python one-liner denied (interpreters are not listed)",
         sh("hatch-safety-auditor", "python3 -c \"print(1)\""), 2, "`python3`"),
        ("reviewer project type-check denied (runs project code)",
         sh("hatch-acceptance-reviewer", "npx tsc --noEmit"), 2, "`npx`"),
        ("reviewer timeout wrapper denied", sh("hatch-safety-auditor",
                                               "timeout 5 cat x"), 2, "`timeout` runs another"),
        ("reviewer git diff range passes",
         sh("hatch-safety-auditor", "git diff --stat a..b"), 0, None),
        ("reviewer git branch listing passes",
         sh("hatch-acceptance-reviewer", "git branch -a --contains HEAD"), 0, None),
        ("reviewer git branch create denied",
         sh("hatch-acceptance-reviewer", "git branch new"), 2, "branch"),
        ("reviewer grep pipeline passes",
         sh("hatch-design-reviewer", "git diff a..b | grep -n x | head"), 0, None),
        ("reviewer digest pipeline passes",
         sh("hatch-safety-auditor",
            "git diff --no-ext-diff --no-textconv --binary --no-color a..b -- | sha256sum"),
         0, None),
        ("reviewer reviewed-tree lookup passes (git revision braces)",
         sh("hatch-acceptance-reviewer", "git rev-parse b^{tree}"), 0, None),
        ("reviewer quiet redirect and fd copy pass",
         sh("hatch-safety-auditor", "git diff a..b > /dev/null 2>&1"), 0, None),
        ("reviewer newline-separated reads pass",
         sh("hatch-safety-auditor", "git status --short\ngit log -1"), 0, None),
        ("reviewer GIT_PAGER=cat passes",
         sh("hatch-safety-auditor", "GIT_PAGER=cat git log -1"), 0, None),
        ("reviewer other assignment prefix denied",
         sh("hatch-safety-auditor", "BASH_ENV=x.sh cat a"), 2, "`BASH_ENV=`"),
        ("reviewer `bash script.sh` denied",
         sh("hatch-safety-auditor", "bash tool.sh"), 2, "`bash` runs another"),
        ("reviewer stdin script denied",
         sh("hatch-safety-auditor", "cat tool.sh | sh"), 2, "`sh` runs another"),
        ("reviewer ./script denied (run by path)",
         sh("hatch-design-reviewer", "./tool.sh"), 2, "by path"),
        ("reviewer system program by absolute path denied too",
         sh("hatch-safety-auditor", "/usr/bin/git diff HEAD"), 2, "by path"),
        ("reviewer `source` denied",
         sh("hatch-acceptance-reviewer", ". tool.sh"), 2, "`.` runs another"),
        ("reviewer `exec` denied",
         sh("hatch-safety-auditor", "exec ./tool.sh"), 2, "`exec` runs another"),
        ("reviewer brace group denied (reserved word first)",
         sh("hatch-safety-auditor", "{ rm src/app.py; }"), 2, "`{` is shell"),
        ("reviewer if/then denied",
         sh("hatch-safety-auditor", "if true; then bash x.sh; fi"), 2, "`if` is shell"),
        ("reviewer `!` denied", sh("hatch-safety-auditor", "! ./x.sh"), 2,
         "`!` is shell"),
        ("reviewer subshell denied", sh("hatch-safety-auditor", "( cat a )"), 2,
         "subshell"),
        ("reviewer $SHELL denied", sh("hatch-safety-auditor", "$SHELL x.sh"), 2,
         "`$` expands"),
        ("reviewer env wrapper denied",
         sh("hatch-safety-auditor", "/usr/bin/env bash x.sh"), 2, "by path"),
        ("reviewer xargs denied",
         sh("hatch-safety-auditor", "echo a | xargs -n 1 ./x.sh"), 2, "`xargs`"),
        ("reviewer find -exec denied",
         sh("hatch-safety-auditor", "find . -name x.sh -exec {} \\;"), 2,
         "unquoted brace"),
        ("reviewer find -exec with quoted braces denied",
         sh("hatch-safety-auditor", "find . -exec env '{}' ';'"), 2, "`find -exec`"),
        ("reviewer trap denied", sh("hatch-safety-auditor", "trap ./x.sh EXIT"), 2,
         "`trap`"),
        ("reviewer sed denied (`e` runs a command)",
         sh("hatch-safety-auditor", "sed '1e ./x.sh' a"), 2, "`sed`"),
        ("reviewer awk denied (`system()`)",
         sh("hatch-safety-auditor", "awk 'BEGIN{system(\"x\")}'"), 2, "`awk`"),
        ("reviewer make denied", sh("hatch-safety-auditor", "make"), 2, "`make`"),
        ("reviewer sort -o denied",
         sh("hatch-safety-auditor", "sort -o out a"), 2, "`sort -o`"),
        ("reviewer sort abbreviated --out= denied",
         sh("hatch-safety-auditor", "sort --out=x a"), 2, "`sort -o`"),
        ("reviewer uniq output operand denied",
         sh("hatch-safety-auditor", "uniq a b"), 2, "second operand"),
        ("reviewer rg --pre denied",
         sh("hatch-safety-auditor", "rg --pre ./x.sh y"), 2, "`rg --pre`"),
        ("reviewer git log --output denied",
         sh("hatch-safety-auditor", "git log --output=x"), 2, "writes a file"),
        ("reviewer git diff --ext-diff denied",
         sh("hatch-safety-auditor", "git diff --ext-diff"), 2, "configured program"),
        ("reviewer git -C outside the working directory denied",
         sh("hatch-safety-auditor", "git -C /elsewhere status"), 2, "outside"),
        ("reviewer git -C into a subdirectory (maybe a nested repository) denied",
         sh("hatch-safety-auditor", "git -C sub diff"), 2, "top levels"),
        ("reviewer chained git -C into a subdirectory denied",
         sh("hatch-safety-auditor", "git -C . -C sub diff"), 2, "`git -C sub`"),
        ("reviewer git -C to the working directory passes",
         sh("hatch-safety-auditor", "git -C /repo diff"), 0, None),
        ("reviewer git --work-tree denied",
         sh("hatch-safety-auditor", "git --work-tree=sub diff"), 2,
         "global option"),
        ("reviewer printf -vHOME denied",
         sh("hatch-safety-auditor", "printf -vHOME .; git diff"), 2, "`printf`"),
        ("reviewer printf -v HOME denied",
         sh("hatch-acceptance-reviewer", "printf -v HOME ."), 2, "`printf`"),
        ("reviewer printf -- denied (printf is off the list)",
         sh("hatch:hatch-design-reviewer", "printf -- -vHOME"), 2,
         "`printf`"),
        ("reviewer printf -vPATH combined denied",
         sh("hatch-safety-auditor", "printf -vPATH %s .:/bin; cat a"), 2,
         "`printf`"),
        ("reviewer read denied (assigns a variable)",
         sh("hatch-safety-auditor", "read HOME < /dev/null"), 2, "`read`"),
        ("reviewer unquoted glob denied",
         sh("hatch-safety-auditor", "ls src/*.py"), 2, "glob"),
        ("reviewer quoted glob passes",
         sh("hatch-safety-auditor", "find . -name '*.py'"), 0, None),
        ("reviewer background job denied",
         sh("hatch-safety-auditor", "cat a &"), 2, "background"),
        ("reviewer heredoc denied",
         sh("hatch-safety-auditor", "cat <<EOF\nx\nEOF"), 2, "`<< EOF`"),
        ("reviewer input redirect from a file denied",
         sh("hatch-safety-auditor", "wc -l < a"), 2, "redirection"),
        ("reviewer unterminated quote denied",
         sh("hatch-safety-auditor", "cat 'a"), 2, "unterminated"),
        ("reviewer comment denied (shells differ on where one starts)",
         sh("hatch-safety-auditor", "cat a # ; touch x"), 2, "comment"),
        ("reviewer empty command passes (nothing runs)",
         sh("hatch-safety-auditor", ""), 0, None),
        ("writer brace group judged as its command (kaizen, outside surface)",
         sh("hatch-kaizen", "{ rm src/app.py; }"), 2, "/repo/src/app.py"),
        ("writer if/then judged as its command (doc-gardner, outside surface)",
         sh("hatch-doc-gardner", "if true; then rm src/app.py; fi"), 2,
         "/repo/src/app.py"),
        ("writer `!` and while/do judged as the command",
         sh("hatch-doc-gardner", "while true; do ! rm src/app.py; done"), 2,
         "/repo/src/app.py"),
        ("writer multi-line loop body judged (newline separates commands)",
         sh("hatch-kaizen", "for f in a\ndo rm src/app.py\ndone"), 2,
         "/repo/src/app.py"),
        ("writer brace group inside the surface passes",
         sh("hatch-doc-gardner", "{ rm docs/old.md; }"), 0, None),
        ("writer `bash script.sh` unchanged (not a detected write)",
         sh("hatch-kaizen", "bash tool.sh"), 0, None),
        ("reviewer-v2 lookalike passes (not recognized)",
         sh("hatch-safety-auditor-v2", "touch x"), 0, None),
    ]
    failures = 0
    for name, payload, want, needle in cases:
        code, reason = decide(payload)
        needles = (needle,) if isinstance(needle, str) else (needle or ())
        ok = (code == want and (want == 0) == (reason == "")
              and (want == 0 or reason.startswith("hatch: "))
              and all(n in reason for n in needles))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: exit {code}")
        failures += 0 if ok else 1

    # Windows harness shells (PowerShell, cmd) treat a backslash as a plain character.
    import ntpath
    win = r"C:\Users\x\wt"
    lexed, err = _reviewer_lex(f"git -C {win} diff", literal_backslash=True)
    pure = [
        ("reviewer lexer keeps a Windows path whole on nt",
         err is None and [_plain(w) for w in lexed[0]["words"]] == ["git", "-C", win, "diff"]),
        ("reviewer lexer on nt still refuses `$` and backticks",
         all(_reviewer_lex(c, literal_backslash=True)[1]
             for c in ("git -C $env:TEMP diff", "git -C `x` diff"))),
        ("reviewer lexer on POSIX still treats a backslash as an escape",
         _reviewer_lex("git log \\", literal_backslash=False)[1] == "a trailing backslash"),
        ("worktree containment folds case and separators on Windows",
         _path_key("C:/Users/X/wt", ntpath) == _path_key(r"c:\users\x\wt", ntpath)),
    ]
    for name, ok in pure:
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        failures += 0 if ok else 1

    total = len(cases) + len(pure)
    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _run_self_test()
    payload: dict = {}
    try:
        raw = json.loads(_read_stdin_text())
        if isinstance(raw, dict):
            payload = raw
    except Exception:  # noqa: BLE001
        return 0  # an unreadable payload is an unrecognized shape — pass
    try:
        code, reason = decide(payload)
    except Exception:  # noqa: BLE001
        # fail closed only on the writers this guard exists to confine; all else passes
        try:
            key = _recognized(payload.get("agent_type"))
            reviewer = _recognized_reviewer(payload.get("agent_type"))
        except Exception:  # noqa: BLE001
            key = reviewer = None
        if reviewer is not None:
            print("hatch: internal error while checking a read-only gate "
                  f"reviewer's call — this guard fails closed for them. {_REVIEWER_DOCTRINE}.",
                  file=sys.stderr)
            return 2
        if key is None:
            return 0
        code, reason = 2, (
            "hatch: internal error while checking a confined writer's call — this "
            f"guard fails closed for the writers it recognizes. "
            f"{WRITERS[key]['doctrine']}; retry with a target inside that surface.")
    if code == 2:
        print(reason, file=sys.stderr)
    return code


if __name__ == "__main__":
    sys.exit(main())
