# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Validate hatch stack packs: frontmatter + review-checklist discipline.

Zero dependencies (pure stdlib), so every invocation form behaves identically —
nothing has to be provisioned before it runs:
  python3 validate_packs.py <pack.md>...        # validate packs, exit 0 clean / 1 findings
  python3 validate_packs.py --self-test          # run embedded fixtures, exit 0/1
  uv run --script validate_packs.py <pack.md>... # also fine — no deps to install

Checks (fail-closed):
  - frontmatter is strict line-based `key: value` pairs between two `---` lines;
    keys limited to name/description/match/always/see_also/disabled
  - name equals the file basename (sans .md)
  - exactly one of match/always, unless the pack is a suppression pack (disabled: true)
  - a "## Review checklist" section exists (unless disabled) and every line in it is
    either an active item "- [ ] <prefix>.<n> — <rule text>" or a tombstone
    "- ~~<prefix>.<n>~~ retired: <reason>"
  - ids use the pack's registered prefix, are unique, and a retired id never
    reappears as an active item
Packs above 3500 bytes warn (never fail) — packs are prompt text; keep them terse.
"""
from __future__ import annotations
import argparse, json, os, re, sys
from pathlib import Path

# Registered per-pack rule-id prefixes. Ids in a registered pack must use exactly
# its prefix. An unregistered pack must use one consistent prefix of its own that
# does not collide with another pack's registered prefix.
PREFIXES = {
    "minimalism": "min",
    "angular": "ng",
    "vue": "vue",
    "python-fastapi": "fapi",
    "python": "py",
    "go-htmx": "htmx",
    "go-naming": "goname",
}
ALLOWED_KEYS = ("name", "description", "match", "always", "see_also", "disabled",
                "seeded_from", "base_sha256", "extends", "exclude_rules", "id_prefix")
# The provenance stamp (frontmatter `seeded_from` + `base_sha256`, written by kaizen's
# seed/migrate pass). Both are optional but paired — one without the other is an error.
# The stamp is diagnostic shape only: a syntactically valid but forged stamp still
# validates; the validator never gates a pack's cleanliness on it. `base_sha256` names
# the canonical hash of the built-in the copy was seeded from (see
# skills/hatch-plan/scripts/check_pack_provenance.py, which produces the same 64-hex form).
STAMP_KEYS = ("seeded_from", "base_sha256")
BASE_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# Composition keys (project packs that extend a built-in). `id_prefix` names the prefix
# the pack's own appended checklist ids must use; it must be a valid rule prefix and must
# not collide with a prefix any shipped built-in already registers.
ID_PREFIX_RE = re.compile(r"^[a-z][a-z0-9-]*$")
SIZE_WARN_BYTES = 3500

KV_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_-]*):\s*(\S.*?)\s*$")
ITEM_RE = re.compile(r"^- \[ \] ([a-z][a-z0-9-]*)\.(\d+) — (\S.*)$")
TOMBSTONE_RE = re.compile(r"^- ~~([a-z][a-z0-9-]*)\.(\d+)~~ retired: (\S.*)$")
HEADING_RE = re.compile(r"^## Review checklist\b")


def load_builtin_registry() -> dict[str, set[str]]:
    """Casefolded built-in stem -> the set of its checklist rule ids (active + retired).

    This is scanned from the shipped built-ins under hatch-plan's `references/sme/`, the
    single source for both the registered rule prefixes (used to reject an `id_prefix`
    that squats a built-in's prefix) and each built-in's rule set (used to reject an
    `exclude_rules` entry naming a rule the extended built-in never had). There is no
    separate prefix manifest — the built-ins' own ids are the registry. Resolves via
    CLAUDE_PLUGIN_ROOT, falling back to this validator's own plugin root; on a miss it
    returns {} and the built-in-dependent checks fail open (structural checks still run)."""
    roots: list[Path] = []
    env = os.environ.get("CLAUDE_PLUGIN_ROOT")
    if env:
        roots.append(Path(env))
    roots.append(Path(__file__).resolve().parents[3])  # <plugin root>/skills/hatch-kaizen/scripts/..
    bdir: Path | None = None
    for root in roots:
        cand = root / "skills" / "hatch-plan" / "references" / "sme"
        if cand.is_dir():
            bdir = cand
            break
    if bdir is None:
        return {}
    registry: dict[str, set[str]] = {}
    for p in sorted(bdir.glob("*.md")):
        ids: set[str] = set()
        for ln in p.read_text(encoding="utf-8", errors="replace").splitlines():
            if m := ITEM_RE.match(ln):
                ids.add(f"{m.group(1)}.{m.group(2)}")
            elif m := TOMBSTONE_RE.match(ln):
                ids.add(f"{m.group(1)}.{m.group(2)}")
        registry[p.stem.casefold()] = ids
    return registry


def _registered_prefixes(registry: dict[str, set[str]]) -> set[str]:
    """Every rule prefix any shipped built-in uses — derived, never a manifest."""
    return {rid.rsplit(".", 1)[0] for ids in registry.values() for rid in ids}


def _parse_frontmatter(lines: list[str]) -> tuple[dict[str, str] | None, int, list[str]]:
    """Strict line-based frontmatter parse. Returns (fields, body_start, errors);
    fields is None when there is no frontmatter block to parse at all."""
    errors: list[str] = []
    if not lines or lines[0] != "---":
        return None, 0, ["frontmatter: file must start with a '---' line"]
    close = next((i for i in range(1, len(lines)) if lines[i] == "---"), None)
    if close is None:
        return None, 0, ["frontmatter: no closing '---' line"]
    fields: dict[str, str] = {}
    for ln in lines[1:close]:
        m = KV_RE.match(ln)
        if not m:
            errors.append(f"frontmatter: not a 'key: value' pair: {ln!r}")
            continue
        key, value = m.group(1), m.group(2)
        if key not in ALLOWED_KEYS:
            errors.append(f"frontmatter: unknown key '{key}' (allowed: {', '.join(ALLOWED_KEYS)})")
            continue
        if key in fields:
            errors.append(f"frontmatter: duplicate key '{key}'")
            continue
        fields[key] = value
    return fields, close + 1, errors


def _string_list(fields: dict[str, str], key: str, errors: list[str]) -> None:
    """A key whose value must be a JSON array of non-empty strings, e.g. ["fastapi"]."""
    if key not in fields:
        return
    try:
        val = json.loads(fields[key])
    except json.JSONDecodeError:
        errors.append(f"frontmatter: '{key}' must be a JSON list of strings, e.g. [\"fastapi\"]")
        return
    if (not isinstance(val, list) or not val
            or not all(isinstance(t, str) and t.strip() for t in val)):
        errors.append(f"frontmatter: '{key}' must be a non-empty JSON list of non-empty strings")


def _check_checklist(lines: list[str], body_start: int, stem: str, errors: list[str],
                     id_prefix: str | None = None) -> None:
    start = next((i for i in range(body_start, len(lines)) if HEADING_RE.match(lines[i])), None)
    if start is None:
        errors.append("missing '## Review checklist' section")
        return
    active: list[str] = []
    retired: list[str] = []
    for ln in lines[start + 1:]:
        if ln.startswith("## "):
            break
        if not ln.strip():
            continue
        if m := ITEM_RE.match(ln):
            active.append(f"{m.group(1)}.{m.group(2)}")
        elif m := TOMBSTONE_RE.match(ln):
            retired.append(f"{m.group(1)}.{m.group(2)}")
        else:
            errors.append(
                "checklist: line matches neither '- [ ] <id> — <rule text>' nor "
                f"'- ~~<id>~~ retired: <reason>': {ln!r}")
    if not active:
        errors.append("checklist: no active items — a pack with nothing to enforce "
                      "should be a suppression pack (disabled: true)")

    # prefix discipline. A pack declaring `id_prefix` must use exactly that prefix for its
    # own appended checklist ids; otherwise a registered pack must use its registered prefix.
    prefixes = {pid.rsplit(".", 1)[0] for pid in active + retired}
    declared = id_prefix if (id_prefix and ID_PREFIX_RE.match(id_prefix)) else None
    if declared:
        for pfx in sorted(prefixes - {declared}):
            errors.append(f"checklist: prefix '{pfx}' is not this pack's declared id_prefix '{declared}'")
    elif expected := PREFIXES.get(stem):
        for pfx in sorted(prefixes - {expected}):
            errors.append(f"checklist: prefix '{pfx}' is not this pack's registered prefix '{expected}'")
    elif prefixes:
        if len(prefixes) > 1:
            errors.append(f"checklist: mixed id prefixes {sorted(prefixes)} — one pack, one prefix")
        else:
            owner = {v: k for k, v in PREFIXES.items()}
            pfx = next(iter(prefixes))
            if pfx in owner:
                errors.append(f"checklist: prefix '{pfx}' is registered to pack '{owner[pfx]}'")

    # id uniqueness + tombstone respect
    for ids, kind in ((active, "active"), (retired, "tombstone")):
        seen: set[str] = set()
        for pid in ids:
            if pid in seen:
                errors.append(f"checklist: duplicate {kind} id '{pid}'")
            seen.add(pid)
    for pid in sorted(set(active) & set(retired)):
        errors.append(f"checklist: retired id '{pid}' reappears as an active item")


def _check_stamp(fields: dict[str, str], errors: list[str]) -> None:
    """Validate the provenance stamp: paired, and shape-correct. Legal on any pack
    (suppression packs included), never required — an unstamped pack is valid. Shape
    only: a forged stamp whose bytes don't match its named built-in still validates,
    because cleanliness is the classifier's job, never the validator's."""
    present = [k for k in STAMP_KEYS if k in fields]
    if not present:
        return  # unstamped — the stamp is diagnostic, never required
    if len(present) != 2:
        missing = next(k for k in STAMP_KEYS if k not in fields)
        errors.append(f"frontmatter: provenance stamp is paired — '{present[0]}' is set but "
                      f"'{missing}' is missing (set both stamp keys or neither)")
    # `seeded_from` is captured non-empty by KV_RE; `base_sha256` must be 64 lowercase hex.
    if "base_sha256" in fields and not BASE_SHA256_RE.match(fields["base_sha256"]):
        errors.append("frontmatter: 'base_sha256' must be exactly 64 lowercase hex characters")


def _check_composition(fields: dict[str, str], registry: dict[str, set[str]],
                       errors: list[str]) -> None:
    """Validate the project-pack composition keys: `extends`, `exclude_rules`, `id_prefix`.

    - `extends` is a plain built-in basename; a pack that declares it must also declare
      `id_prefix` (extends without id_prefix is an error).
    - `exclude_rules` is a JSON list of rule-id strings, legal only alongside `extends`;
      each entry must name a rule that exists in the extended built-in's checklist — a
      stale exclusion is a loud error, never a silent no-op.
    - `id_prefix` is a valid rule prefix that must not collide with any prefix a shipped
      built-in already registers (registry scanned from the built-ins — no manifest).

    Built-in existence and exclude/collision checks fail open when the registry is empty
    (built-ins unresolved); the structural pairing/shape checks always run."""
    extends = fields.get("extends")
    id_prefix = fields.get("id_prefix")
    exclude_raw = fields.get("exclude_rules")

    if exclude_raw is not None and extends is None:
        errors.append("frontmatter: 'exclude_rules' is legal only alongside 'extends'")
    if extends is not None and id_prefix is None:
        errors.append("frontmatter: a pack declaring 'extends' must also declare 'id_prefix'")

    if id_prefix is not None:
        if not ID_PREFIX_RE.match(id_prefix):
            errors.append(f"frontmatter: 'id_prefix' '{id_prefix}' is not a valid rule prefix "
                          "(lowercase, starts with a letter, then [a-z0-9-])")
        elif id_prefix in _registered_prefixes(registry):
            errors.append(f"frontmatter: 'id_prefix' '{id_prefix}' collides with a rule prefix a "
                          "shipped built-in already registers — pick a prefix no built-in uses")

    excludes: list[str] | None = None
    if exclude_raw is not None:
        try:
            parsed = json.loads(exclude_raw)
        except json.JSONDecodeError:
            errors.append("frontmatter: 'exclude_rules' must be a JSON list of rule-id strings, "
                          'e.g. ["min.2"]')
        else:
            if not isinstance(parsed, list) or not parsed or not all(
                    isinstance(x, str) and x.strip() for x in parsed):
                errors.append("frontmatter: 'exclude_rules' must be a non-empty JSON list of "
                              "non-empty rule-id strings")
            else:
                excludes = parsed

    # Built-in-dependent checks: resolve `extends` against the scanned registry.
    if extends is not None and registry:
        key = extends.casefold()
        key = key[:-3] if key.endswith(".md") else key
        if key not in registry:
            errors.append(f"frontmatter: 'extends' names '{extends}', which is not a shipped "
                          "built-in pack")
        elif excludes is not None:
            known = registry[key]
            for rid in excludes:
                if rid not in known:
                    errors.append(f"frontmatter: 'exclude_rules' names '{rid}', which is not a rule "
                                  f"in the extended built-in '{extends}' — a stale exclusion, never "
                                  "a silent no-op")


def validate_pack(text: str, filename: str,
                  registry: dict[str, set[str]] | None = None) -> tuple[list[str], list[str], bool]:
    """Return (errors, warnings, disabled); empty errors == valid.

    `registry` maps casefolded built-in stem -> its checklist rule ids, used for the
    composition checks (id_prefix collision, exclude_rules existence). It defaults to
    empty — those built-in-dependent checks then fail open; main() loads the real one."""
    registry = registry or {}
    errors: list[str] = []
    warnings: list[str] = []
    size = len(text.encode("utf-8"))
    if size > SIZE_WARN_BYTES:
        warnings.append(f"pack is {size} bytes (> {SIZE_WARN_BYTES}) — packs are prompt text; trim it")
    if not filename.endswith(".md"):
        errors.append(f"pack file must be a .md file, got '{filename}'")
        return errors, warnings, False
    stem = filename[:-3]

    lines = text.splitlines()
    fields, body_start, fm_errors = _parse_frontmatter(lines)
    errors.extend(fm_errors)
    if fields is None:
        return errors, warnings, False

    for key in ("name", "description"):
        if key not in fields:
            errors.append(f"frontmatter: missing '{key}'")
    if "name" in fields and fields["name"] != stem:
        errors.append(f"frontmatter: name '{fields['name']}' != file basename '{stem}'")
    for key in ("always", "disabled"):
        if key in fields and fields[key] != "true":
            errors.append(f"frontmatter: '{key}' must be exactly 'true' (omit the key otherwise)")
    _string_list(fields, "match", errors)
    _string_list(fields, "see_also", errors)
    _check_stamp(fields, errors)  # legal on any pack, suppression included — before the early return
    _check_composition(fields, registry, errors)  # structural checks legal on any pack

    disabled = fields.get("disabled") == "true"
    if disabled:
        return errors, warnings, True  # suppression pack: enumerated, never pinned — no body checks

    present = [k for k in ("match", "always") if k in fields]
    if len(present) != 1:
        errors.append("frontmatter: exactly one of 'match' or 'always' required "
                      f"(found: {present or 'neither'})")
    _check_checklist(lines, body_start, stem, errors, id_prefix=fields.get("id_prefix"))
    return errors, warnings, False


# --- Self-test fixtures --------------------------------------------------------

_GOOD_ALWAYS = """\
---
name: minimalism
description: Write the least code that works
always: true
see_also: ["platform-native"]
---
## The ladder (advisory)
Prose the validator must ignore.

## Review checklist (enforced — diff-checkable only)
- [ ] min.1 — No new third-party dependency where the stdlib already ships it.
- [ ] min.2 — No abstraction with a single implementation added speculatively.
- ~~min.3~~ retired: folded into min.2.
- [ ] min.4 — Non-trivial new logic leaves one runnable check.
"""

_GOOD_MATCH = """\
---
name: python-fastapi
description: FastAPI/Pydantic do's and don'ts
match: ["fastapi", "pydantic"]
---
## Review checklist
- [ ] fapi.1 — Every changed route declares request/response types.
- [ ] fapi.2 — No blocking I/O inside an `async def` route.
"""

_SUPPRESSED = """\
---
name: vue
description: Suppressed in this project
disabled: true
---
This project opts out of the vue pack.
"""

# A project pack that extends a built-in: appends its own prefixed rules and drops one
# built-in rule that does not fit. Validated against _FIXTURE_REGISTRY below.
_EXTENDS = """\
---
name: acme-min
description: Acme's extra minimalism rules on top of the built-in
match: ["acme"]
extends: minimalism
id_prefix: acme
exclude_rules: ["min.2"]
---
## Review checklist
- [ ] acme.1 — Every module ships an Acme copyright header.
- [ ] acme.2 — No direct process.env reads outside config/.
"""

# Casefolded built-in stem -> its checklist rule ids. Mirrors what load_builtin_registry()
# scans off the shipped built-ins, but hermetic so the self-test never touches disk.
_FIXTURE_REGISTRY = {
    "minimalism": {"min.1", "min.2", "min.4"},
    "python": {"py.1", "py.2"},
    "go-htmx": {"htmx.1"},
}


def _run_self_test() -> int:
    def sub(text: str, old: str, new: str) -> str:
        assert old in text, f"self-test fixture bug: {old!r} not found"
        return text.replace(old, new)

    hex64 = "a1" * 32              # a shape-valid 64-lowercase-hex base_sha256
    forged = "0" * 64             # equally shape-valid; the bytes needn't match anything

    def stamp(seed: str, base: str) -> str:
        return f"seeded_from: {seed}\nbase_sha256: {base}"

    cases = [
        ("valid always pack (with tombstone)", _GOOD_ALWAYS, "minimalism.md", True),
        ("valid match pack", _GOOD_MATCH, "python-fastapi.md", True),
        ("valid suppression pack", _SUPPRESSED, "vue.md", True),
        ("no frontmatter at all", "# just prose\n", "minimalism.md", False),
        ("unclosed frontmatter", "---\nname: minimalism\n", "minimalism.md", False),
        ("unknown frontmatter key",
         sub(_GOOD_ALWAYS, "always: true", "always: true\nseverity: high"), "minimalism.md", False),
        ("non key-value frontmatter line",
         sub(_GOOD_ALWAYS, "always: true", "always: true\njust some prose"), "minimalism.md", False),
        ("duplicate frontmatter key",
         sub(_GOOD_ALWAYS, "always: true", "always: true\nalways: true"), "minimalism.md", False),
        ("name != basename", _GOOD_ALWAYS, "angular.md", False),
        ("both match and always",
         sub(_GOOD_ALWAYS, "always: true", 'always: true\nmatch: ["x"]'), "minimalism.md", False),
        ("neither match nor always",
         sub(_GOOD_ALWAYS, "always: true\n", ""), "minimalism.md", False),
        ("always must be literally true",
         sub(_GOOD_ALWAYS, "always: true", "always: yes"), "minimalism.md", False),
        ("match not a JSON list",
         sub(_GOOD_MATCH, '["fastapi", "pydantic"]', "fastapi"), "python-fastapi.md", False),
        ("missing review checklist",
         _GOOD_ALWAYS.split("## Review checklist")[0], "minimalism.md", False),
        ("hyphen instead of em-dash separator",
         sub(_GOOD_ALWAYS, "min.4 — Non-trivial", "min.4 - Non-trivial"), "minimalism.md", False),
        ("free-prose checklist line",
         sub(_GOOD_ALWAYS, "- [ ] min.4 —", "Also check the vibes.\n- [ ] min.4 —"), "minimalism.md", False),
        ("id missing (legacy un-numbered item)",
         sub(_GOOD_ALWAYS, "min.4 — ", ""), "minimalism.md", False),
        ("wrong prefix for registered pack",
         sub(_GOOD_ALWAYS, "min.4", "ng.4"), "minimalism.md", False),
        ("duplicate active id",
         sub(_GOOD_ALWAYS, "min.4", "min.2"), "minimalism.md", False),
        ("retired id reappears as active",
         sub(_GOOD_ALWAYS, "min.4", "min.3"), "minimalism.md", False),
        ("tombstone without reason",
         sub(_GOOD_ALWAYS, "retired: folded into min.2.", "retired:"), "minimalism.md", False),
        ("all items retired (no active left)",
         sub(_GOOD_MATCH, "- [ ] fapi.1 — Every changed route declares request/response types.\n"
                          "- [ ] fapi.2 — No blocking I/O inside an `async def` route.",
             "- ~~fapi.1~~ retired: superseded.\n- ~~fapi.2~~ retired: superseded."),
         "python-fastapi.md", False),
        ("unregistered pack, own consistent prefix",
         sub(sub(sub(_GOOD_MATCH, "python-fastapi", "terraform"), "fapi.", "tf."),
             '["fastapi", "pydantic"]', '["terraform"]'), "terraform.md", True),
        ("unregistered pack, mixed prefixes",
         sub(sub(sub(_GOOD_MATCH, "python-fastapi", "terraform"), "fapi.1", "tf.1"),
             '["fastapi", "pydantic"]', '["terraform"]'), "terraform.md", False),
        ("unregistered pack squatting a registered prefix",
         sub(sub(sub(_GOOD_MATCH, "python-fastapi", "terraform"), "fapi.", "min."),
             '["fastapi", "pydantic"]', '["terraform"]'), "terraform.md", False),
        ("disabled pack needs no match/always/checklist", _SUPPRESSED, "vue.md", True),
        ("disabled must be literally true",
         sub(_SUPPRESSED, "disabled: true", "disabled: yes"), "vue.md", False),
        # --- provenance stamp (seeded_from + base_sha256) ---
        ("stamped pack validates",
         sub(_GOOD_ALWAYS, "always: true", f"always: true\n{stamp('minimalism', hex64)}"),
         "minimalism.md", True),
        ("forged stamp (shape-valid, bytes need not match) still validates — shape only",
         sub(_GOOD_MATCH, "match:", f"{stamp('python-fastapi', forged)}\nmatch:"),
         "python-fastapi.md", True),
        ("lone seeded_from is an error",
         sub(_GOOD_ALWAYS, "always: true", "always: true\nseeded_from: minimalism"),
         "minimalism.md", False),
        ("lone base_sha256 is an error",
         sub(_GOOD_ALWAYS, "always: true", f"always: true\nbase_sha256: {hex64}"),
         "minimalism.md", False),
        ("base_sha256 wrong length is an error",
         sub(_GOOD_ALWAYS, "always: true", f"always: true\n{stamp('minimalism', 'deadbeef')}"),
         "minimalism.md", False),
        ("base_sha256 uppercase hex is an error (must be lowercase)",
         sub(_GOOD_ALWAYS, "always: true", f"always: true\n{stamp('minimalism', 'A' * 64)}"),
         "minimalism.md", False),
        ("stamp is legal on a suppression pack",
         sub(_SUPPRESSED, "disabled: true", f"disabled: true\n{stamp('vue', hex64)}"),
         "vue.md", True),
        ("lone stamp key on a suppression pack is an error",
         sub(_SUPPRESSED, "disabled: true", "disabled: true\nseeded_from: vue"),
         "vue.md", False),
    ]
    failures = 0
    for name, text, filename, should_pass in cases:
        errs, _, _ = validate_pack(text, filename)
        ok = (not errs) == should_pass
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: "
              f"{'valid' if not errs else 'invalid (' + '; '.join(errs) + ')'}")
        if not ok:
            failures += 1

    # size warning: fires above 3500 bytes, never fails validation
    padded = _GOOD_ALWAYS + "\n## Notes\n" + ("x" * SIZE_WARN_BYTES)
    errs, warns, _ = validate_pack(padded, "minimalism.md")
    ok = not errs and len(warns) == 1
    print(f"[{'PASS' if ok else 'FAIL'}] oversize pack warns but stays valid: warnings={warns}")
    failures += 0 if ok else 1

    # suppression packs are surfaced as suppressed
    _, _, disabled = validate_pack(_SUPPRESSED, "vue.md")
    ok = disabled and not validate_pack(_GOOD_ALWAYS, "minimalism.md")[2]
    print(f"[{'PASS' if ok else 'FAIL'}] disabled flag reported only for suppression packs")
    failures += 0 if ok else 1

    # --- project-pack composition (extends / exclude_rules / id_prefix) ---
    # These run against _FIXTURE_REGISTRY so prefix registration and exclude existence are
    # derived by scanning built-in rule ids — no separate prefix manifest.
    comp_cases = [
        ("extends pack with id_prefix and own-prefix checklist validates",
         _EXTENDS, "acme-min.md", True),
        ("extends without id_prefix is an error",
         sub(_EXTENDS, "id_prefix: acme\n", ""), "acme-min.md", False),
        ("exclude_rules without extends is an error",
         sub(_EXTENDS, "extends: minimalism\n", ""), "acme-min.md", False),
        ("exclude_rules that is not a JSON list of strings is an error",
         sub(_EXTENDS, 'exclude_rules: ["min.2"]', "exclude_rules: min.2"), "acme-min.md", False),
        ("exclude_rules as a JSON list of non-strings is an error",
         sub(_EXTENDS, 'exclude_rules: ["min.2"]', "exclude_rules: [2]"), "acme-min.md", False),
        ("id_prefix squatting a registered built-in prefix is an error (scanned, no manifest)",
         sub(sub(_EXTENDS, "id_prefix: acme", "id_prefix: min"), "acme.", "min."),
         "acme-min.md", False),
        ("exclude_rules naming a nonexistent rule in the extended built-in is an error",
         sub(_EXTENDS, 'exclude_rules: ["min.2"]', 'exclude_rules: ["min.9"]'), "acme-min.md", False),
        ("extends naming an unknown built-in is an error",
         sub(_EXTENDS, "extends: minimalism", "extends: nosuchpack"), "acme-min.md", False),
        ("id_prefix that is not a valid rule prefix is an error",
         sub(_EXTENDS, "id_prefix: acme", "id_prefix: Acme_1"), "acme-min.md", False),
        ("checklist ids not using the declared id_prefix is an error",
         sub(_EXTENDS, "- [ ] acme.1", "- [ ] other.1"), "acme-min.md", False),
    ]
    for name, text, filename, should_pass in comp_cases:
        errs, _, _ = validate_pack(text, filename, _FIXTURE_REGISTRY)
        ok = (not errs) == should_pass
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: "
              f"{'valid' if not errs else 'invalid (' + '; '.join(errs) + ')'}")
        if not ok:
            failures += 1

    # An empty registry fails the built-in-dependent checks open: a well-formed extends pack
    # still validates structurally, so a validator run that cannot resolve the built-ins never
    # false-fails a legitimate project pack.
    errs_open, _, _ = validate_pack(_EXTENDS, "acme-min.md", {})
    ok = not errs_open
    print(f"[{'PASS' if ok else 'FAIL'}] extends pack validates structurally under an empty registry")
    failures += 0 if ok else 1

    total = len(cases) + len(comp_cases) + 3
    print(f"\n{total - failures}/{total} checks passed")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("packs", nargs="*", type=Path, metavar="pack.md")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _run_self_test()
    if not args.packs:
        ap.error("provide one or more pack files or --self-test")
    registry = load_builtin_registry()
    failed = False
    for path in args.packs:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as e:
            print(f"{path}: unreadable ({e})")
            failed = True
            continue
        errors, warnings, disabled = validate_pack(text, path.name, registry)
        for w in warnings:
            print(f"{path}: warning: {w}")
        if errors:
            failed = True
            print(f"{path}: INVALID")
            for e in errors:
                print(f"  - {e}")
        else:
            print(f"{path}: OK{' (suppressed: disabled pack, never pinned)' if disabled else ''}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
