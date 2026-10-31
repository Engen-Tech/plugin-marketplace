# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""hatch item context: one JSON packet answering everything hatch-build's Phase 1
(`build:gate`) currently discovers by hand for a single work item.

Zero dependencies (pure stdlib), so every invocation form behaves identically:
  python3 item_context.py --binder <path> --item <id> [--repo <dir>]  # print the packet
  python3 item_context.py --self-test                                  # embedded fixtures
  uv run --script item_context.py --binder <path> --item <id>          # also fine

Top-level keys:
  item             — the work-item JSON slice, verbatim.
  slug             — the binder's slug.
  oracle_cwd       — the item's resolved execution context: the oracle's own `cwd` when
                     set, else "." (the worktree root).
  oracle_expect    — the oracle's `expect`, or null.
  integration_tip  — the current tip of hatch/<slug>/integration, or null.
  dependencies     — {dep_id: {done_ref, target}} for every id in `depends_on`, so
                     hatch-build's Gate 3 is answered from the packet.
  sme              — [{id, source, checklist}] — every id in the binder's `sme` list,
                     with its COMPOSED Review checklist (resolve_pack_checklist.py),
                     project overlay `.hatch/sme/<id>.md` winning over the built-in
                     `references/sme/<id>.md`. A pinned id that cannot be resolved is a
                     LOUD ERROR (nonzero exit) — never a silently empty checklist.
  tools            — absolute resolved paths of run_oracle.py, scan_secrets.py,
                     check_item_provenance.py, and item_context.py, resolved from this
                     script's own location so a worktree, a plugin install, and a repo
                     checkout all work.

Stdlib only. Invoked directly (not installed), matching the non-executable mode of
sibling scripts.

Exit codes: 0 = packet printed, 1 = self-test failure or an unresolvable pinned sme
pack, 2 = usage error (bad binder / missing item).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
RUN_ORACLE = (SCRIPT_DIR / "run_oracle.py").resolve()
SCAN_SECRETS = (SCRIPT_DIR / "scan_secrets.py").resolve()
CHECK_PROVENANCE = (SCRIPT_DIR / ".." / ".." / "hatch-deliver" / "scripts" / "check_item_provenance.py").resolve()
ITEM_CONTEXT = Path(__file__).resolve()
BUILTIN_SME_DIR = (SCRIPT_DIR / ".." / "references" / "sme").resolve()

# cwd-independent sibling import (no __init__.py in hatch-kaizen/scripts). Import-safe —
# importing resolve_pack_checklist never runs it.
_RPC_DIR = str((SCRIPT_DIR / ".." / ".." / "hatch-kaizen" / "scripts").resolve())
if _RPC_DIR not in sys.path:
    sys.path.insert(0, _RPC_DIR)
import resolve_pack_checklist as rpc  # noqa: E402


class PackResolutionError(Exception):
    """A pinned sme id resolved to no file, or its checklist could not be composed.
    Reported to stderr with a non-zero exit — never a silently empty checklist."""


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8")


def ref_target(repo: Path, ref: str) -> str | None:
    proc = _git(repo, "rev-parse", "--verify", "--quiet", ref + "^{commit}")
    out = proc.stdout.strip()
    return out or None


def resolve_pack_path(repo: Path, pack_id: str) -> Path | None:
    """The project overlay `.hatch/sme/<id>.md` wins over the built-in
    `references/sme/<id>.md` resolved from this script's own location."""
    overlay = repo / ".hatch" / "sme" / f"{pack_id}.md"
    if overlay.is_file():
        return overlay
    builtin = BUILTIN_SME_DIR / f"{pack_id}.md"
    if builtin.is_file():
        return builtin
    return None


def resolve_sme(repo: Path, pack_ids: list[str]) -> list[dict]:
    """Resolve every pinned sme id to its composed Review checklist. Raises
    PackResolutionError (never returns a silently empty checklist) on the first id that
    cannot be resolved or composed."""
    result: list[dict] = []
    for pack_id in pack_ids:
        path = resolve_pack_path(repo, pack_id)
        if path is None:
            raise PackResolutionError(
                f"'{pack_id}' resolved to no pack file — tried "
                f"{repo / '.hatch' / 'sme' / (pack_id + '.md')} and "
                f"{BUILTIN_SME_DIR / (pack_id + '.md')}")
        text = path.read_text(encoding="utf-8")
        try:
            checklist = rpc.resolve_checklist(text, path.name, rpc._disk_builtin_lookup)
        except rpc.ResolveError as e:
            raise PackResolutionError(f"'{pack_id}' ({path}): {e}") from e
        result.append({"id": pack_id, "source": str(path), "checklist": checklist})
    return result


def build_packet(binder_path: Path, item_id: str, repo: Path) -> dict:
    binder = json.loads(binder_path.read_text(encoding="utf-8"))
    slug = binder.get("slug")
    items = binder.get("work_items", [])
    item = next((it for it in items if it.get("id") == item_id), None)
    if item is None:
        available = ", ".join(sorted(it.get("id", "?") for it in items))
        raise ValueError(f"no work item '{item_id}' in {binder_path} — available: {available}")

    oracle = item.get("oracle") or {}
    oracle_cwd = oracle.get("cwd") or "."
    oracle_expect = oracle.get("expect")

    integration_name = f"hatch/{slug}/integration" if slug else None
    integration_tip = ref_target(repo, integration_name) if integration_name else None

    dependencies: dict[str, dict] = {}
    for dep_id in item.get("depends_on") or []:
        done_ref = f"refs/hatch/{slug}/item-{dep_id}/done"
        dependencies[dep_id] = {"done_ref": done_ref, "target": ref_target(repo, done_ref)}

    sme = resolve_sme(repo, binder.get("sme") or [])

    tools = {
        "run_oracle.py": str(RUN_ORACLE),
        "scan_secrets.py": str(SCAN_SECRETS),
        "check_item_provenance.py": str(CHECK_PROVENANCE),
        "item_context.py": str(ITEM_CONTEXT),
    }

    return {
        "item": item,
        "slug": slug,
        "oracle_cwd": oracle_cwd,
        "oracle_expect": oracle_expect,
        "integration_tip": integration_tip,
        "dependencies": dependencies,
        "sme": sme,
        "tools": tools,
    }


# --- Self-test -------------------------------------------------------------------

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

    def init(root: Path) -> Path:
        root.mkdir(parents=True, exist_ok=True)
        _git(root, "init", "-q", "-b", "main")
        _git(root, "config", "user.email", "t@example.invalid")
        _git(root, "config", "user.name", "hatch self-test")
        return root

    def commit(root: Path, message: str) -> str:
        _git(root, "commit", "-q", "--allow-empty", "-m", message)
        return ref_target(root, "HEAD") or ""

    tmp = Path(tempfile.mkdtemp(prefix="item_context_selftest_"))
    try:
        # --- basic packet: item slice, oracle_cwd default, dependencies, tools -------
        repo = init(tmp / "basic")
        commit(repo, "base")
        _git(repo, "branch", "-m", "hatch/s/integration")  # rename main -> integration
        tip = ref_target(repo, "HEAD") or ""
        binder = {
            "slug": "s", "title": "t", "summary": "s", "motivation": "m",
            "scope": {"included": ["x"]},
            "work_items": [
                {"id": "a", "title": "A", "summary": "s",
                 "oracle": {"type": "smoke", "assertions": ["x"], "command": "true"}},
                {"id": "b", "title": "B", "summary": "s", "depends_on": ["a"],
                 "oracle": {"type": "smoke", "cwd": "sub", "expect": "OK",
                            "assertions": ["y"], "command": "true"}},
            ],
        }
        binder_path = tmp / "basic.json"
        binder_path.write_text(json.dumps(binder), encoding="utf-8")

        packet_a = build_packet(binder_path, "a", repo)
        check("item slice is verbatim and oracle_cwd defaults to the worktree root",
              packet_a["item"]["id"] == "a" and packet_a["oracle_cwd"] == "."
              and packet_a["oracle_expect"] is None and packet_a["integration_tip"] == tip,
              json.dumps(packet_a["item"]))

        packet_b = build_packet(binder_path, "b", repo)
        check("an explicit oracle.cwd/expect resolve, and an unmet dependency reports "
              "no target",
              packet_b["oracle_cwd"] == "sub" and packet_b["oracle_expect"] == "OK"
              and packet_b["dependencies"]["a"]["target"] is None
              and packet_b["dependencies"]["a"]["done_ref"] == "refs/hatch/s/item-a/done",
              json.dumps(packet_b["dependencies"]))

        # now merge item-a's done ref in, and re-check gate-3 answers from the packet
        _git(repo, "update-ref", "refs/hatch/s/item-a/done", tip)
        packet_b2 = build_packet(binder_path, "b", repo)
        check("a merged dependency's done ref target is answered from the packet "
              "(hatch-build Gate 3)",
              packet_b2["dependencies"]["a"]["target"] == tip)

        # --- unknown item id is a usage error -----------------------------------------
        raised = False
        try:
            build_packet(binder_path, "ghost", repo)
        except ValueError as e:
            raised = "available" in str(e)
        check("an unknown item id raises naming the available ids", raised)

        # --- sme resolution: overlay wins over built-in -------------------------------
        overlay_dir = repo / ".hatch" / "sme"
        overlay_dir.mkdir(parents=True, exist_ok=True)
        (overlay_dir / "fixture-pack.md").write_text(
            "---\nname: fixture-pack\ndescription: fixture\nalways: true\n---\n"
            "## Review checklist\n- [ ] fp.1 — overlay wins\n", encoding="utf-8")
        binder["sme"] = ["fixture-pack"]
        binder_path.write_text(json.dumps(binder), encoding="utf-8")
        packet_sme = build_packet(binder_path, "a", repo)
        check("a project-overlay pack resolves and carries a non-empty composed checklist",
              len(packet_sme["sme"]) == 1
              and packet_sme["sme"][0]["id"] == "fixture-pack"
              and packet_sme["sme"][0]["source"] == str(overlay_dir / "fixture-pack.md")
              and packet_sme["sme"][0]["checklist"] == [
                  {"id": "fp.1", "text": "overlay wins", "source": "fixture-pack.md"}],
              json.dumps(packet_sme["sme"]))

        # --- NEGATIVE CONTROL: an unresolvable pinned pack is a loud error ------------
        binder["sme"] = ["fixture-pack", "no-such-pack-anywhere"]
        binder_path.write_text(json.dumps(binder), encoding="utf-8")
        raised_pack = False
        try:
            build_packet(binder_path, "a", repo)
        except PackResolutionError as e:
            raised_pack = "no-such-pack-anywhere" in str(e)
        check("NEGATIVE CONTROL: a pinned sme id that resolves to no file is a loud "
              "error, never a silently empty checklist", raised_pack)

        # a genuinely built-in pack (minimalism, extended by hatch's own house pack)
        # resolves through the built-in dir when no overlay shadows it
        binder["sme"] = ["minimalism"]
        binder_path.write_text(json.dumps(binder), encoding="utf-8")
        if (BUILTIN_SME_DIR / "minimalism.md").is_file():
            packet_builtin = build_packet(binder_path, "a", repo)
            check("a built-in pack with no overlay resolves from references/sme/ and "
                  "carries a non-empty checklist",
                  len(packet_builtin["sme"]) == 1 and len(packet_builtin["sme"][0]["checklist"]) > 0,
                  json.dumps(packet_builtin["sme"]))
        else:
            check("a built-in pack with no overlay resolves from references/sme/ "
                  "(skipped — no built-in dir shipped alongside this checkout)", True)

        # --- tools map: absolute, existing paths --------------------------------------
        binder["sme"] = []
        binder_path.write_text(json.dumps(binder), encoding="utf-8")
        packet_tools = build_packet(binder_path, "a", repo)
        tools_ok = all(Path(p).is_absolute() and Path(p).name == name and Path(p).is_file()
                       for name, p in packet_tools["tools"].items())
        check("tools map carries absolute, existing paths for all four scripts", tools_ok,
              json.dumps(packet_tools["tools"]))

        # --- required top-level keys always present -----------------------------------
        need = {"item", "slug", "oracle_cwd", "oracle_expect", "integration_tip",
                "dependencies", "sme", "tools"}
        check("packet always carries every contracted top-level key", need <= set(packet_tools))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"self-test: {passed}/{total} cases passed")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="item_context.py",
        description="Print one JSON packet answering hatch-build's Phase 1 (build:gate) "
                    "for a single work item.",
    )
    ap.add_argument("--binder", type=Path, help="path to the binder JSON")
    ap.add_argument("--item", help="work item id")
    ap.add_argument("--repo", type=Path, default=Path("."), help="repository to read (default: cwd)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args(argv)

    if args.self_test:
        return _run_self_test()
    missing = [n for n in ("binder", "item") if getattr(args, n) is None]
    if missing:
        ap.error("missing required argument(s): " + ", ".join("--" + n for n in missing))
    if not args.binder.is_file():
        print(f"item_context: binder file not found: {args.binder}", file=sys.stderr)
        return 2

    try:
        packet = build_packet(args.binder, args.item, args.repo.resolve())
    except ValueError as e:
        print(f"item_context: {e}", file=sys.stderr)
        return 2
    except PackResolutionError as e:
        print(f"item_context: unresolvable sme pack — {e}", file=sys.stderr)
        return 1

    print(json.dumps(packet, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
