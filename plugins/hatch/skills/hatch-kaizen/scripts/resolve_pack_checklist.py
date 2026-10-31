# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Resolve one project pack into the composed Review checklist the gate agents receive.

Given ONE already-resolved project-pack file, emit the composed Review checklist as the
identical normalized item list the gate agents already consume — one entry per active
rule, each carrying its rule id, rule text, and source pack.

Zero dependencies (pure stdlib), so every invocation form behaves identically:
  python3 resolve_pack_checklist.py <pack.md>   # print the composed Review checklist (JSON)
  python3 resolve_pack_checklist.py --self-test  # run embedded fixtures, exit 0/1
  uv run --script resolve_pack_checklist.py <pack.md>  # also fine — no deps to install

Composition:
  - A pack that does NOT declare `extends` passes through unchanged: its own active
    checklist items, source = the pack itself.
  - A pack that declares `extends: <built-in basename>` is composed as the extended
    built-in's active items (minus every id named in `exclude_rules`) first, then the
    pack's own active items appended. Ordering is deterministic: built-in checklist order
    for the base, then pack checklist order for the pack's own rules.

Asserting on the output (oracle authors): key any check on the emitted `id` values, never a
bare substring of the JSON. A `Narrows <id>:` replacement rule's own text contains the
excluded id, so a fixed-string grep for the id matches that prose and cannot tell an excluded
rule from a mentioned one. To prove a rule is excluded, assert its id is absent from the
emitted ids, e.g. `... | python3 -c 'import sys,json; assert "min.4" not in [e["id"] for e in json.load(sys.stdin)]'`.

Failures (consistent with validate_packs, never a silent drop):
  - `extends` naming no shipped built-in is a reported error and non-zero exit.
  - an `exclude_rules` id absent from the extended built-in's checklist is a reported
    error and non-zero exit.

Frontmatter parsing, the `## Review checklist` grammar (ITEM_RE), and the built-in packs
dir resolution are reused from the sibling validate_packs.py rather than re-derived.
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

# cwd-independent sibling import (no __init__.py in this scripts/ dir). validate_packs.py
# is import-safe, so importing it never runs the validator.
import os, sys  # noqa: E401 — keep the pinned one-liner intact
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); import validate_packs


class ResolveError(Exception):
    """A composition that cannot be resolved — a bad `extends` or a stale `exclude_rules`.
    Reported to stderr with a non-zero exit; never a silent drop."""


def _builtin_sme_dir() -> Path | None:
    """The shipped built-in packs dir, resolved exactly as validate_packs.load_builtin_registry
    does: CLAUDE_PLUGIN_ROOT first, then this resolver's own plugin root; built-ins live at
    skills/hatch-plan/references/sme/. Returns None when neither root has the dir."""
    roots: list[Path] = []
    env = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env:
        roots.append(Path(env))
    roots.append(Path(__file__).resolve().parents[3])  # <plugin root>/skills/hatch-kaizen/scripts/..
    for root in roots:
        cand = root / "skills" / "hatch-plan" / "references" / "sme"
        if cand.is_dir():
            return cand
    return None


def _disk_builtin_lookup(name: str) -> tuple[str, str] | None:
    """Resolve an `extends` value to (built-in text, real basename), or None if no such
    built-in ships. Matches by casefolded stem like validate_packs, and returns the file's
    actual basename so the emitted `source` is the built-in as shipped (e.g. 'minimalism.md')."""
    bdir = _builtin_sme_dir()
    if bdir is None:
        return None
    stem = name[:-3] if name.endswith(".md") else name
    for p in sorted(bdir.glob("*.md")):
        if p.stem.casefold() == stem.casefold():
            return p.read_text(encoding="utf-8", errors="replace"), p.name
    return None


def _active_checklist(text: str) -> list[tuple[str, str]]:
    """A pack's active checklist items as ordered (id, rule_text) tuples — mirrors
    validate_packs._check_checklist: active `- [ ] <id> — <text>` lines only, in
    checklist order. Tombstones and prose are not rules and are skipped."""
    lines = text.splitlines()
    fields, body_start, _ = validate_packs._parse_frontmatter(lines)
    if fields is None:
        body_start = 0
    start = next((i for i in range(body_start, len(lines))
                  if validate_packs.HEADING_RE.match(lines[i])), None)
    items: list[tuple[str, str]] = []
    if start is None:
        return items
    for ln in lines[start + 1:]:
        if ln.startswith("## "):
            break
        if m := validate_packs.ITEM_RE.match(ln):
            items.append((f"{m.group(1)}.{m.group(2)}", m.group(3)))
    return items


def _exclude_rules(fields: dict[str, str]) -> list[str]:
    """The pack's `exclude_rules` as an ordered list of rule ids (empty when absent or `[]`).
    Absence and an explicit empty list are identical — both drop nothing."""
    raw = fields.get("exclude_rules")
    if raw is None:
        return []
    try:
        val = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ResolveError("'exclude_rules' must be a JSON list of rule-id strings") from e
    if not isinstance(val, list):
        raise ResolveError("'exclude_rules' must be a JSON list of rule-id strings")
    return val


def resolve_checklist(pack_text: str, pack_basename: str, builtin_lookup) -> list[dict[str, str]]:
    """Compose the Review checklist for one resolved project pack.

    `builtin_lookup(extends_value)` returns (built-in text, built-in basename) or None when
    no such built-in ships. Returns the composed Review checklist: a list of {id, text,
    source} dicts — for a non-extends pack, only its own items (source = the pack); for an
    extends pack, the extended built-in's active items minus `exclude_rules` (source = the
    built-in) followed by the pack's own items (source = the pack). Raises ResolveError on
    a bad `extends` or a stale `exclude_rules` entry."""
    fields, _, _ = validate_packs._parse_frontmatter(pack_text.splitlines())
    fields = fields or {}
    own = _active_checklist(pack_text)

    extends = fields.get("extends")
    if extends is None:
        return [{"id": rid, "text": txt, "source": pack_basename} for rid, txt in own]

    found = builtin_lookup(extends)
    if found is None:
        raise ResolveError(f"'extends' names '{extends}', which is not a shipped built-in pack")
    base_text, base_basename = found
    base = _active_checklist(base_text)
    base_ids = {rid for rid, _ in base}

    excludes = _exclude_rules(fields)
    for rid in excludes:
        if rid not in base_ids:
            raise ResolveError(
                f"'exclude_rules' names '{rid}', which is not a rule in the extended built-in "
                f"'{extends}' — a stale exclusion, never a silent no-op")
    dropped = set(excludes)

    result = [{"id": rid, "text": txt, "source": base_basename}
              for rid, txt in base if rid not in dropped]
    result += [{"id": rid, "text": txt, "source": pack_basename} for rid, txt in own]
    return result


# --- Self-test fixtures --------------------------------------------------------

# A built-in with a tombstone (min.3) between active rules — the resolver must skip it.
_FIX_MINIMALISM = """\
---
name: minimalism
description: Write the least code that works
always: true
---
## Review checklist
- [ ] min.1 — first base rule
- [ ] min.2 — second base rule
- ~~min.3~~ retired: folded into min.2.
- [ ] min.4 — fourth base rule
"""

# A plain project pack with no `extends`.
_FIX_PLAIN = """\
---
name: python
description: Python do's and don'ts
match: ["python"]
---
## Review checklist
- [ ] py.1 — first plain rule
- [ ] py.2 — second plain rule
"""

# A project pack that extends the built-in and appends its own prefixed rules.
_FIX_EXTENDS = """\
---
name: hatch-house-minimalism
description: House minimalism on top of the built-in
match: ["house"]
extends: minimalism
id_prefix: khm
---
## Review checklist
- [ ] khm.1 — first own rule
- [ ] khm.2 — second own rule
"""


def _run_self_test() -> int:
    def sub(text: str, old: str, new: str) -> str:
        assert old in text, f"self-test fixture bug: {old!r} not found"
        return text.replace(old, new)

    # Hermetic built-in source — never touches disk.
    fixtures = {"minimalism.md": _FIX_MINIMALISM}

    def lookup(name: str):
        key = name if name.endswith(".md") else name + ".md"
        return (fixtures[key], key) if key in fixtures else None

    failures = 0

    def check(name: str, ok: bool) -> None:
        nonlocal failures
        print(f"[{'PASS' if ok else 'FAIL'}] {name}")
        if not ok:
            failures += 1

    # (a) plain pack, no `extends`: own checklist unchanged, source = the pack itself.
    a = resolve_checklist(_FIX_PLAIN, "python.md", lookup)
    check("(a) plain pack (no extends) returns its own checklist unchanged",
          a == [{"id": "py.1", "text": "first plain rule", "source": "python.md"},
                {"id": "py.2", "text": "second plain rule", "source": "python.md"}])

    # (b) extends pack, no `exclude_rules` field: base (tombstone skipped) then own.
    expected_b = [
        {"id": "min.1", "text": "first base rule", "source": "minimalism.md"},
        {"id": "min.2", "text": "second base rule", "source": "minimalism.md"},
        {"id": "min.4", "text": "fourth base rule", "source": "minimalism.md"},
        {"id": "khm.1", "text": "first own rule", "source": "hatch-house-minimalism.md"},
        {"id": "khm.2", "text": "second own rule", "source": "hatch-house-minimalism.md"},
    ]
    b = resolve_checklist(_FIX_EXTENDS, "hatch-house-minimalism.md", lookup)
    check("(b) extends pack (no exclude_rules) returns base + own", b == expected_b)

    # (b2) `exclude_rules: []` behaves IDENTICALLY to (b).
    b2_text = sub(_FIX_EXTENDS, "id_prefix: khm\n", "id_prefix: khm\nexclude_rules: []\n")
    b2 = resolve_checklist(b2_text, "hatch-house-minimalism.md", lookup)
    check("(b2) empty exclude_rules list behaves identically to no exclude_rules", b2 == expected_b)

    # (c) `exclude_rules` drops precisely the named base ids, keeps the rest and own rules.
    c_text = sub(_FIX_EXTENDS, "id_prefix: khm\n", 'id_prefix: khm\nexclude_rules: ["min.2"]\n')
    expected_c = [
        {"id": "min.1", "text": "first base rule", "source": "minimalism.md"},
        {"id": "min.4", "text": "fourth base rule", "source": "minimalism.md"},
        {"id": "khm.1", "text": "first own rule", "source": "hatch-house-minimalism.md"},
        {"id": "khm.2", "text": "second own rule", "source": "hatch-house-minimalism.md"},
    ]
    c = resolve_checklist(c_text, "hatch-house-minimalism.md", lookup)
    check("(c) exclude_rules drops exactly the named base ids, keeps the rest + own", c == expected_c)

    # (d) `exclude_rules` naming an id absent from base is flagged as an error.
    d_text = sub(_FIX_EXTENDS, "id_prefix: khm\n", 'id_prefix: khm\nexclude_rules: ["min.9"]\n')
    try:
        resolve_checklist(d_text, "hatch-house-minimalism.md", lookup)
        raised = False
    except ResolveError:
        raised = True
    check("(d) exclude_rules naming an id absent from base is an error", raised)

    # (e) emitted objects carry exactly keys id/text/source, base-then-own order, basename sources.
    keys_ok = all(set(o) == {"id", "text", "source"} for o in b)
    order_ok = [o["id"] for o in b] == ["min.1", "min.2", "min.4", "khm.1", "khm.2"]
    source_ok = [o["source"] for o in b] == [
        "minimalism.md", "minimalism.md", "minimalism.md",
        "hatch-house-minimalism.md", "hatch-house-minimalism.md"]
    check("(e) exact keys id/text/source, base-then-own order, basename source values",
          keys_ok and order_ok and source_ok)

    # (f) `extends` naming a built-in that does not ship is flagged as an error, never a
    # silent pass-through — the resolver fails closed exactly as validate_packs rejects it.
    f_text = sub(_FIX_EXTENDS, "extends: minimalism\n", "extends: nonesuch\n")
    try:
        resolve_checklist(f_text, "hatch-house-minimalism.md", lookup)
        raised_f = False
    except ResolveError:
        raised_f = True
    check("(f) extends naming a non-shipped built-in is an error", raised_f)

    total = 7
    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Resolve one project pack into the composed Review checklist (JSON array of "
                    "{id, text, source}) the gate agents receive.")
    ap.add_argument("pack", nargs="?", type=Path, metavar="pack.md",
                    help="one already-resolved project-pack file")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _run_self_test()
    if args.pack is None:
        ap.error("provide a pack file or --self-test")
    try:
        text = args.pack.read_text(encoding="utf-8")
    except OSError as e:
        print(f"{args.pack}: unreadable ({e})", file=sys.stderr)
        return 1
    try:
        items = resolve_checklist(text, args.pack.name, _disk_builtin_lookup)
    except ResolveError as e:
        print(f"{args.pack}: {e}", file=sys.stderr)
        return 1
    print(json.dumps(items, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
