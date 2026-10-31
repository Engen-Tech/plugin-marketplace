#!/usr/bin/env python3
"""Copilot CLI hook dispatcher: one process per hook event, every guard in-process.

Copilot starts this through the `exec` entries of .github/plugin/hooks.json, with
git as the launcher (one manifest for Windows and Linux; `exec` has no per-system
key, and an entry that mixes `exec` with a `bash` or `powershell` key makes Copilot
drop every hook of the plugin):

    git -c alias.kh=!<pick a verified Python 3.9+> kh <PLUGIN_ROOT>/.codex-plugin/hooks/dispatch.py EVENT GROUP

  EVENT   PreToolUse, PostToolUse, Stop, SubagentStop or SessionStart
  GROUP   edit (Write|Edit|NotebookEdit|apply_patch), task (Agent|Task) or any
  --probe exit 0 on Python 3.9 or later, 1 otherwise; the alias runs it with -I -S
          and stdin from /dev/null before it trusts an interpreter. 3.9 is the
          oldest on which every guard decides as it does on current Python: 3.8
          lets a bad-pack patch through, and before 3.7 this file's own
          sys.stdin.reconfigure fails, which would let every edit through.

What it does:
  - An edit PreToolUse or PostToolUse exits 0 before any guard is loaded only when
    every target it names is provably outside both edit guards' reach: `.hatch`
    appears in no spelling of it (as typed, with `\\` read as `/`, joined to the
    payload's cwd, or resolved through symlinks), it has no `..` segment and no
    Windows short-name, stream or trailing-dot spelling, and it is not a hard link.
    Patch directives are read with both line rules the guards use (str.splitlines
    and LF with a trailing CR dropped). Anything else goes to the guards.
  - Otherwise the guards the event used to list one entry each run here, in that
    order, each as __main__ with the argv, environment and stdin launch_hook.ps1
    gave it (argv the guard alone, PYTHONUTF8=1, the payload unread). The first
    deny (exit 2) stops the rest, as Copilot stops at the first denying entry. A
    guard's own exit code passes through as the launcher passed it.
  - Git's alias environment is undone first: the start folder is restored from
    GIT_PREFIX, and GIT_CONFIG_PARAMETERS, GIT_EXEC_PATH, GIT_PREFIX, GIT_DIR and
    GIT_WORK_TREE are cleared so they never reach a guard or the git it runs.
  - An internal error here exits 0 (INV-21), except for the task group: the
    dispatch inspectors fail closed, so a dispatcher fault there denies by name.
A guard file that is missing is an allow, as it was for launch_hook.ps1.
"""
import os
import sys

GUARDS = {
    ("PreToolUse", "edit"): ("guard_binder_immutability.py", "guard_pack_write.py"),
    ("PreToolUse", "task"): ("guard_auditor_dispatch.py", "guard_gate_dispatch.py"),
    ("PostToolUse", "edit"): ("guard_pack_write.py",),
    ("Stop", "any"): ("guard_delivery_stop.py",),
    ("SubagentStop", "any"): ("guard_subagent_whiff.py",),
    ("SessionStart", "any"): ("inject_hatch_status.py",),
}
FAIL_CLOSED = (("PreToolUse", "task"),)
# GIT_DIR: git exports it to an alias whenever the plugin root sits inside a repo, and a
# guard's own `git -C <repo>` would then answer for the plugin's repo instead.
GIT_LEAKS = ("GIT_CONFIG_PARAMETERS", "GIT_EXEC_PATH", "GIT_PREFIX", "GIT_DIR", "GIT_WORK_TREE")
PATH_KEYS = ("file_path", "notebook_path", "path", "filePath")
DIRECTIVE = r"^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$"
INTERNAL_ERROR_REASON = (
    "hatch: the hook dispatcher failed while checking this agent dispatch, and hatch's "
    "dispatch checks fail closed. Retry the dispatch; if it fails again, run "
    "`.codex-plugin/hooks/scripts/guard_auditor_dispatch.py --self-test` and "
    "`guard_gate_dispatch.py --self-test` in the plugin folder.")


def undo_git_alias_env():
    """Git runs an alias from the repo top and leaves its own variables behind."""
    prefix = os.environ.get("GIT_PREFIX")
    if prefix:
        start = os.path.join(os.getcwd(), prefix)
        if os.path.isdir(start):
            os.chdir(start)
    for name in GIT_LEAKS:
        os.environ.pop(name, None)


def patch_paths(text):
    """Directive paths under either line rule a guard uses."""
    import re
    lines = set(text.splitlines())
    lines.update(line[:-1] if line.endswith("\r") else line for line in text.split("\n"))
    out = []
    for line in lines:
        m = re.match(DIRECTIVE, line)
        if m:
            out.append(m.group(2))
    return out


def edit_targets(payload):
    """Every path an edit payload names, in any place either edit guard reads one."""
    ti = payload.get("tool_input")
    if isinstance(ti, str):
        return patch_paths(ti)
    if not isinstance(ti, dict):
        return []
    out = [ti[k] for k in PATH_KEYS if isinstance(ti.get(k), str)]
    command = ti.get("command")
    if isinstance(command, list):
        command = "\n".join(x for x in command if isinstance(x, str))
    if isinstance(command, str):
        out += patch_paths(command)
    return out


def has_hatch(path):
    return ".hatch" in path.replace("\\", "/").lower()


def outside_guard_reach(target, cwd):
    import stat
    for spelled in {target, target.strip(), target.replace("\\", "/"),
                    target.strip().replace("\\", "/")}:
        if has_hatch(spelled):
            return False
        for i, seg in enumerate(spelled.replace("\\", "/").split("/")):
            if seg == ".." or "~" in seg:
                return False
            if ":" in seg and not (i == 0 and len(seg) == 2):
                return False
            if seg not in ("", ".") and seg[-1] in ". ":
                return False
        joined = os.path.join(cwd, spelled)
        real = os.path.realpath(joined)
        if has_hatch(os.path.abspath(joined)) or has_hatch(real):
            return False
        try:
            st = os.stat(real)
        except OSError:
            continue  # a new file; realpath already followed every existing parent
        if stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
            return False
    return True


def early_exit(data):
    """True only when no edit guard could act on this payload."""
    import json
    text = data.decode("utf-8", "replace")
    try:
        payload = json.loads(text)
    except ValueError:
        return False  # not a payload this can read; the guards answer it
    if not isinstance(payload, dict):
        return False
    cwd = payload.get("cwd") or os.getcwd()
    if not isinstance(cwd, str):
        return False
    targets = edit_targets(payload)
    if not targets:
        return not has_hatch(text) and not has_hatch(cwd)
    return all(outside_guard_reach(t, cwd) for t in targets)


def run_guard(path, data):
    """One guard as __main__ in this process; its exit code, as its own process would give."""
    import io
    import runpy
    saved = sys.argv, sys.stdin, list(sys.path)
    sys.argv = [path]
    sys.stdin = io.TextIOWrapper(io.BytesIO(data))
    sys.stdin.reconfigure(encoding="utf-8")  # the payload is UTF-8 whatever the locale
    sys.path.insert(0, os.path.dirname(path))
    try:
        runpy.run_path(path, run_name="__main__")
        code = 0
    except SystemExit as e:
        if e.code is None:
            code = 0
        elif isinstance(e.code, int):
            code = e.code
        else:
            sys.stderr.write("%s\n" % (e.code,))
            code = 1
    except BaseException:  # noqa: BLE001 - an uncaught exception ends a guard process: traceback, exit 1
        import traceback
        traceback.print_exc()
        code = 1
    finally:
        sys.argv, sys.stdin, sys.path[:] = saved
        sys.stdout.flush()
        sys.stderr.flush()
    return code


def run_guards(root, names, data):
    """The guards in order; the first exit 2 is the answer, else the first other non-zero."""
    os.environ["PYTHONUTF8"] = "1"
    scripts = os.path.join(root, ".codex-plugin", "hooks", "scripts")
    first = 0
    for name in names:
        path = os.path.join(scripts, name)
        if not os.path.isfile(path):
            continue
        code = run_guard(path, data)
        if code == 2:
            return 2
        if code and not first:
            first = code
    return first


def dispatch(event, group, data):
    undo_git_alias_env()
    if group == "edit" and event in ("PreToolUse", "PostToolUse") and early_exit(data):
        return 0
    root = os.environ.get("PLUGIN_ROOT") or os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return run_guards(root, GUARDS.get((event, group), ()), data)


def main(argv, stdin=None):
    if argv[1:2] == ["--probe"]:
        return 0 if sys.version_info >= (3, 9) else 1
    event = argv[1] if len(argv) > 1 else ""
    group = argv[2] if len(argv) > 2 else "any"
    try:
        data = (stdin if stdin is not None else sys.stdin.buffer).read()
        return dispatch(event, group, data)
    except Exception:  # noqa: BLE001 - INV-21: a broken hook never wedges the session
        if (event, group) in FAIL_CLOSED:
            sys.stderr.write(INTERNAL_ERROR_REASON + "\n")
            return 2
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
