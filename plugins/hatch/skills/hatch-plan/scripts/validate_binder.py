# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Validate a hatch binder: schema + dependency-graph + opt-out checks.

Zero dependencies (pure stdlib), so every invocation form behaves identically —
nothing has to be provisioned before it runs:
  uv run --script validate_binder.py --binder <path>   # validate one binder, exit 0/1
  uv run --script validate_binder.py --self-test        # run embedded fixtures, exit 0/1
  python3 validate_binder.py --binder <path>            # also fine — no deps to install
"""
from __future__ import annotations
import argparse, json, posixpath, re, shlex, sys
from fnmatch import fnmatch
from itertools import combinations
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "references" / "binder-schema.json"

# binder-schema.json is the one complete structural contract: every field this validator
# accepts is declared there, and the schema is loaded exactly as it sits on disk — never
# extended at check time — so an editor or third-party tool validating against the file
# gets the same structural answer as this script. Cross-references a JSON schema cannot
# express (duplicate/dangling ids, cycles, waiver coverage) are checked in Python below.


def _load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


# --- Minimal JSON-Schema checker (pure stdlib) --------------------------------
# hatch owns its binder schema, so rather than depend on `jsonschema` we check
# against exactly the draft-2020-12 keywords binder-schema.json actually uses:
#   type (incl. union lists), required, properties, additionalProperties:false,
#   items, enum, const, pattern, minLength, minItems, uniqueItems, oneOf, anyOf,
#   if/then/else, and local $ref.
# Keywords outside that subset are ignored — keep this in step with the schema.

def _type_ok(value, t: str) -> bool:
    if t == "object":  return isinstance(value, dict)
    if t == "array":   return isinstance(value, list)
    if t == "string":  return isinstance(value, str)
    if t == "boolean": return isinstance(value, bool)
    if t == "null":    return value is None
    if t == "integer": return isinstance(value, int) and not isinstance(value, bool)
    if t == "number":  return isinstance(value, (int, float)) and not isinstance(value, bool)
    return False


def _resolve_ref(ref: str, root: dict) -> dict:
    # local refs only, e.g. "#/$defs/workItem"
    node = root
    for part in ref.lstrip("#/").split("/"):
        node = node[part.replace("~1", "/").replace("~0", "~")]
    return node


def _check(value, schema: dict, root: dict, path: list, errors: list[str]) -> None:
    if "$ref" in schema:
        _check(value, _resolve_ref(schema["$ref"], root), root, path, errors)
        return

    loc = "/".join(str(p) for p in path) or "(root)"

    if "type" in schema:
        types = schema["type"]
        types = [types] if isinstance(types, str) else types
        if not any(_type_ok(value, t) for t in types):
            errors.append(f"schema: {loc}: is not of type {' or '.join(types)}")
            return  # a wrong-typed value makes the deeper keyword checks noise

    if "enum" in schema and value not in schema["enum"]:
        errors.append(f"schema: {loc}: {value!r} is not one of {schema['enum']}")
    if "const" in schema and value != schema["const"]:
        errors.append(f"schema: {loc}: {value!r} is not the allowed constant {schema['const']!r}")

    if isinstance(value, str):
        if "minLength" in schema and len(value) < schema["minLength"]:
            errors.append(f"schema: {loc}: string shorter than minLength {schema['minLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append(f"schema: {loc}: {value!r} does not match pattern {schema['pattern']!r}")

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append(f"schema: {loc}: array shorter than minItems {schema['minItems']}")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"schema: {loc}: array longer than maxItems {schema['maxItems']}")
        if schema.get("uniqueItems") is True:
            seen: list = []
            for item in value:
                if item in seen:
                    errors.append(f"schema: {loc}: has non-unique element {item!r}")
                    break
                seen.append(item)
        if "items" in schema:
            for i, item in enumerate(value):
                _check(item, schema["items"], root, path + [i], errors)

    if isinstance(value, dict):
        props = schema.get("properties", {})
        for req in schema.get("required", []):
            if req not in value:
                errors.append(f"schema: {loc}: missing required property '{req}'")
        if schema.get("additionalProperties") is False:
            for key in value:
                if key not in props:
                    errors.append(f"schema: {loc}: additional property '{key}' is not allowed")
        for key, subschema in props.items():
            if key in value:
                _check(value[key], subschema, root, path + [key], errors)

    if "anyOf" in schema:
        if not any(_passes(value, sub, root, path) for sub in schema["anyOf"]):
            errors.append(f"schema: {loc}: matched none of the anyOf branches")

    if "if" in schema:
        branch = "then" if _passes(value, schema["if"], root, path) else "else"
        if branch in schema:
            _check(value, schema[branch], root, path, errors)

    if "oneOf" in schema:
        matched = 0
        for sub in schema["oneOf"]:
            branch: list[str] = []
            _check(value, sub, root, path, branch)
            if not branch:
                matched += 1
        if matched != 1:
            errors.append(
                f"schema: {loc}: matched {matched} of the oneOf branches (exactly 1 required)")


def _passes(value, schema: dict, root: dict, path: list) -> bool:
    branch: list[str] = []
    _check(value, schema, root, path, branch)
    return not branch


def _schema_errors(binder: dict) -> list[str]:
    schema = _load_schema()
    errors: list[str] = []
    _check(binder, schema, schema, [], errors)
    return sorted(errors)


def validate_binder(binder: dict) -> list[str]:
    """Return a list of human-readable errors; empty list == valid."""
    errors = _schema_errors(binder)
    if errors:
        return errors  # graph checks assume a schema-valid shape

    items = binder.get("work_items", [])
    ids = [it["id"] for it in items]
    if len(ids) != len(set(ids)):
        errors.append("graph: duplicate work-item id(s)")
    id_set = set(ids)
    for it in items:
        for dep in it.get("depends_on", []):
            if dep not in id_set:
                errors.append(f"graph: item '{it['id']}' depends_on unknown id '{dep}'")

    # shared_terms cross-references: entry ids unique across entries, and every listed
    # item id resolves to a real work item (dangling id -> error, mirroring depends_on).
    # Shape (kebab id, non-empty canonical, >=2 items) is already enforced by the schema.
    seen_term_ids: set[str] = set()
    for term in binder.get("shared_terms", []):
        tid = term.get("id")
        if tid in seen_term_ids:
            errors.append(f"shared_terms: duplicate entry id '{tid}'")
        seen_term_ids.add(tid)
        for ref in term.get("items", []):
            if ref not in id_set:
                errors.append(f"shared_terms: entry '{tid}' lists unknown work-item id '{ref}'")

    # supersedes cross-references: a successor names another binder, and every carried id
    # is one of its own work items (copied unchanged from the predecessor). Whether the
    # predecessor really delivered them is a git question deliver_preflight.py answers.
    sup = binder.get("supersedes")
    if sup is not None:
        if sup.get("slug") == binder.get("slug"):
            errors.append("supersedes: a binder cannot supersede its own slug")
        for ref in sup.get("carried", []):
            if ref not in id_set:
                errors.append(f"supersedes: carried id '{ref}' is not a work item of this binder")
        for ref in set(sup.get("carried", [])) & set(sup.get("dropped", [])):
            errors.append(f"supersedes: id '{ref}' is both carried and dropped")

    # preconditions: ids unique, and every waits_on id names a declared one.
    pc_ids: set[str] = set()
    for pc in binder.get("preconditions", []):
        if pc["id"] in pc_ids:
            errors.append(f"preconditions: duplicate id '{pc['id']}'")
        pc_ids.add(pc["id"])
    for it in items:
        for ref in it.get("waits_on", []):
            if ref not in pc_ids:
                errors.append(f"waits_on: item '{it['id']}' waits on undeclared precondition '{ref}'")

    # cycle detection (DFS over depends_on)
    graph = {it["id"]: list(it.get("depends_on", [])) for it in items}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {i: WHITE for i in graph}

    def visit(node: str, stack: list[str]) -> None:
        color[node] = GRAY
        for nxt in graph.get(node, []):
            if nxt not in color:
                continue  # dangling already reported
            if color[nxt] == GRAY:
                cyc = " -> ".join(stack + [nxt])
                errors.append(f"graph: dependency cycle: {cyc}")
            elif color[nxt] == WHITE:
                visit(nxt, stack + [nxt])
        color[node] = BLACK

    for i in graph:
        if color[i] == WHITE:
            visit(i, [i])

    # design: a work item that names a real design view must either open it itself
    # (a visual oracle) or carry a recorded waiver naming the item that opens it for it.
    # Runs in the same pass as the cycle check above (not gated behind `if not errors`)
    # so a cyclic binder that also carries an unwaived design claim reports both —
    # the coverage walk below (`reachable`) has its own visited set and terminates
    # regardless of a cycle in `graph`.
    errors.extend(_design_reference_errors(items, graph))

    if not errors:
        errors.extend(_wave_collision(items))
    return errors


# The one sentinel that excuses a work item from claiming a design view: matched byte for
# byte, no stripping, no case folding. "None" and "NONE" are design claims, not the sentinel.
_NONE_SENTINEL = "none"


def _design_reference_errors(items: list[dict], graph: dict[str, list[str]]) -> list[str]:
    """The design: error family. An item whose `design_reference` names a real view (present,
    and not the exact string "none") is asserting that view is what it renders. That assertion
    must cost something: the item either carries a visual oracle itself, or a `visual_check_waiver`
    naming the item that checks it — never neither. A `visual_check_waiver` that isn't doing any
    work (the item makes no real design claim, or already carries a visual oracle) is itself
    rejected, and a waiver's `covered_by` target is checked against six conditions, each its own
    error: it must resolve to a real work item, that item's oracle must be `visual`, that item's
    own `design_reference` must name a real view (a covering gate hatch-build would skip cannot
    cover anything), that item must depend on the waived item directly or through the chain (it
    has to run after the work it covers), that item's oracle must carry a non-empty `assertions`
    list (a covering check has to state what it checks before it can cover anything), and that
    item must name the waived item in its own `covers` list — coverage is an agreement between
    both items, so a gate is never volunteered into covering work it never accepted, whatever
    view it happens to open.
    """
    by_id = {it["id"]: it for it in items}
    errors: list[str] = []
    for it in items:
        item_id = it["id"]
        design_ref = it.get("design_reference")
        names_real_view = design_ref is not None and design_ref != _NONE_SENTINEL
        oracle = it.get("oracle")
        oracle_type = oracle.get("type") if isinstance(oracle, dict) else None
        has_visual_oracle = oracle_type == "visual"
        waiver = it.get("visual_check_waiver")

        if waiver is not None:
            if not names_real_view or has_visual_oracle:
                why = ("design_reference is absent or the literal 'none'" if not names_real_view
                       else "the item already carries a visual oracle")
                errors.append(
                    f"design: item '{item_id}' visual_check_waiver is redundant — {why}, "
                    "so the waiver is doing no work")
                continue  # a redundant waiver's covered_by is not worth checking further

            covered_by = waiver.get("covered_by")
            cov_item = by_id.get(covered_by)
            if cov_item is None:
                errors.append(
                    f"design: item '{item_id}' visual_check_waiver.covered_by names unknown "
                    f"work item '{covered_by}'")
                continue  # nothing further to check against an item that doesn't exist

            cov_oracle = cov_item.get("oracle")
            cov_type = cov_oracle.get("type") if isinstance(cov_oracle, dict) else None
            if cov_type != "visual":
                errors.append(
                    f"design: item '{item_id}' visual_check_waiver.covered_by '{covered_by}' "
                    "does not carry a visual oracle")

            cov_design_ref = cov_item.get("design_reference")
            if cov_design_ref is None or cov_design_ref == _NONE_SENTINEL:
                errors.append(
                    f"design: item '{item_id}' visual_check_waiver.covered_by '{covered_by}' "
                    "has design_reference 'none' (or none at all) — hatch-build skips its "
                    "visual gate, so it cannot cover this waiver")

            if item_id not in reachable(covered_by, graph):
                errors.append(
                    f"design: item '{item_id}' visual_check_waiver.covered_by '{covered_by}' "
                    f"does not depend on '{item_id}' (directly or through the chain), so it "
                    "cannot cover work it does not run after")

            cov_assertions = cov_oracle.get("assertions") if isinstance(cov_oracle, dict) else None
            if not cov_assertions:
                errors.append(
                    f"design: item '{item_id}' visual_check_waiver.covered_by '{covered_by}' "
                    "oracle carries no assertions — a covering check must state what it checks")

            # The covering item's own `design_reference` is deliberately NOT compared with the
            # waived item's: one closing gate legitimately covers several differently-named
            # views, which is what `waiver_summary` reports. What a gate cannot be is
            # volunteered — it has to name the items it accepts, so coverage is agreed at
            # both ends rather than asserted by the item that benefits from it.
            cov_covers = cov_item.get("covers")
            if not isinstance(cov_covers, list) or item_id not in cov_covers:
                errors.append(
                    f"design: item '{item_id}' visual_check_waiver.covered_by '{covered_by}' "
                    f"does not list '{item_id}' in its covers — a covering gate must name the "
                    "items it covers")
            continue

        if names_real_view and not has_visual_oracle:
            errors.append(
                f"design: item '{item_id}' names a design view ('{design_ref}') but "
                "has no visual oracle and no visual_check_waiver")

    # A `covers` entry naming nothing is not a bypass — a waiver is always checked against
    # the real item it points at — but the schema calls these work-item ids, so a typo or a
    # stale id would sit there reading as coverage that was never agreed with anyone.
    for it in items:
        # Guarded the same way the waiver loop above guards this very field. The schema types
        # `covers` as an array of strings and validate_binder returns before reaching here on
        # a schema error, so this holds only for a caller invoking the helper directly — but
        # one function reading one field two different ways is a defect on its own.
        covers = it.get("covers")
        for cov_id in (covers if isinstance(covers, list) else []):
            if isinstance(cov_id, str) and cov_id not in by_id:
                errors.append(
                    f"design: item '{it['id']}' covers unknown work item '{cov_id}'")
    return errors


def waiver_summary(binder: dict) -> list[str]:
    """Mirrors opt_out_summary's surfacing so a recorded escape prints somewhere: one line
    per waiver stating its reason and its covered_by, plus one line per covering item stating
    how many waivers it absorbs — so a gate covering seven views reads as covering seven views,
    not as a binder with none."""
    lines: list[str] = []
    absorbed: dict[str, int] = {}
    for it in binder.get("work_items", []):
        w = it.get("visual_check_waiver")
        if isinstance(w, dict):
            covered_by = w.get("covered_by")
            lines.append(f"{it['id']}: {w.get('reason')} (covered by {covered_by})")
            absorbed[covered_by] = absorbed.get(covered_by, 0) + 1
    # Sorted by the printed form, not the key: a waiver with no `covered_by` keys this dict
    # on None, and mixing None with strings makes the plain sort raise. The schema rejects
    # that waiver long before validation reaches here, so this only holds for a caller
    # summarising a binder it has not validated — which must get a line, not a TypeError.
    for cov_id in sorted(absorbed, key=str):
        lines.append(f"{cov_id}: absorbs {absorbed[cov_id]} waiver(s)")
    return lines


def design_source_advisory(binder: dict) -> list[str]:
    """Advisory (non-fatal): a binder that names a design source in design_facts but carries no
    visual oracle on any item is exactly the shape of the failure this file's design: rule
    exists to catch — every design claim reaching the gate only through waivers pointing nowhere,
    or (before this rule existed) reaching it nowhere at all. A warning, not an error: a project
    may legitimately be all-backend work under a design-bearing repo. Prints on every run so the
    shape cannot pass unnoticed, the same way the previous failure did."""
    # `design_facts` is an object in the schema, so a non-dict here means the caller has not
    # validated the binder. Read it as "no source declared" rather than raising on .get.
    facts = binder.get("design_facts")
    source = facts.get("source") if isinstance(facts, dict) else None
    if not source:
        return []
    has_visual = any(
        isinstance(it.get("oracle"), dict) and it["oracle"].get("type") == "visual"
        for it in binder.get("work_items", []))
    if has_visual:
        return []
    return ["binder names a design source in design_facts but no work item carries a visual "
            "oracle — confirm this project is legitimately all-backend work, not a design claim "
            "with nothing behind it"]


def paths_overlap(a_paths: list[str], b_paths: list[str]) -> list[str]:
    """Do two `touches` lists name any common file? Beyond literal equality this
    normalizes `./` and redundant separators, expands a glob entry against concrete
    entries (fnmatch), and treats a directory-prefix of another path as an overlap.
    Glob-vs-glob is not expanded (rare; left to serialize/shared_resources)."""
    def is_glob(p: str) -> bool:
        return any(c in p for c in "*?[")

    hits: set[str] = set()
    for x in a_paths:
        nx, gx = posixpath.normpath(x.strip()), is_glob(x)
        for y in b_paths:
            ny, gy = posixpath.normpath(y.strip()), is_glob(y)
            if nx == ny:
                hits.add(nx)
            elif gx and not gy and fnmatch(ny, nx):
                hits.add(f"{x.strip()} ~ {y.strip()}")
            elif gy and not gx and fnmatch(nx, ny):
                hits.add(f"{x.strip()} ~ {y.strip()}")
            elif not gx and not gy and (ny.startswith(nx + "/") or nx.startswith(ny + "/")):
                hits.add(f"{x.strip()} ~ {y.strip()}")
    return sorted(hits)


def reachable(start: str, graph: dict[str, list[str]]) -> set[str]:
    """All ids reachable from `start` by following depends_on edges (the transitive
    closure of "depends on"). Iterative with its own visited set, so a cyclic graph still
    terminates. Module-level and shared by the same-wave collision check (`_wave_collision`)
    and the design-reference waiver's coverage check (`_design_reference_errors`) rather than
    walked twice — one shared walk, proven to terminate where it lives."""
    seen: set[str] = set()
    stack = list(graph.get(start, ()))
    while stack:
        n = stack.pop()
        if n in seen:
            continue
        seen.add(n)
        stack.extend(graph.get(n, ()))
    return seen


def _wave_collision(items: list[dict]) -> list[str]:
    """Flag item pairs that can land in the SAME wave and both `touches` a file,
    without declaring serialize or a shared resource to order them. Items with a
    dependency path between them land in different waves, so they never collide."""
    deps = {it["id"]: list(it.get("depends_on", [])) for it in items}
    trans = {i: reachable(i, deps) for i in deps}
    by_id = {it["id"]: it for it in items}
    out: list[str] = []
    for a, b in combinations(list(deps), 2):
        if a in trans[b] or b in trans[a]:
            continue  # a dependency path sequences them into different waves
        overlap = paths_overlap(by_id[a].get("touches", []), by_id[b].get("touches", []))
        if not overlap:
            continue
        if by_id[a].get("serialize") or by_id[b].get("serialize"):
            continue  # an explicit-serialize item never shares a build slot
        if set(by_id[a].get("shared_resources", [])) & set(by_id[b].get("shared_resources", [])):
            continue  # a co-declared shared resource serializes the whole pair, so no file is edited concurrently
        out.append(
            f"graph: items '{a}' and '{b}' can run in the same wave and both touch "
            f"{overlap}, but neither sets serialize nor shares a shared_resources entry"
        )
    return out


def opt_out_summary(binder: dict) -> list[str]:
    return [f"{it['id']}: {it['oracle']['reason']}"
            for it in binder.get("work_items", [])
            if isinstance(it.get("oracle"), dict) and it["oracle"].get("opt_out")]


def sme_warnings(binder: dict) -> list[str]:
    """Advisory (non-fatal) notes. An empty or absent `sme` means no stack packs were
    pinned — yet every binder should carry at least the always-on `minimalism` pack, so an
    empty `sme` almost always means the plan:sme matching step was skipped. Surfaced on every
    run so the omission can't pass unnoticed; never fails validation (a project may legitimately
    suppress the always-on pack), which is why it is a warning and not a schema error."""
    if binder.get("sme"):
        return []
    return ["no stack packs pinned (sme is empty) — every binder should carry at least the "
            "always-on 'minimalism' pack; confirm the plan:sme matching step ran"]


def shared_terms_warnings(binder: dict) -> list[str]:
    """Advisory (non-fatal): a shared_terms entry lists an item whose `touches` is empty, so
    the deliver-time check_shared_terms.py pass has no files to scan for that item — the
    declaration would be silently un-enforceable there. Not fatal (an item may declare its
    touched files later, or legitimately carry none), so it warns rather than errors."""
    by_id = {it["id"]: it for it in binder.get("work_items", [])}
    out: list[str] = []
    for term in binder.get("shared_terms", []):
        for ref in term.get("items", []):
            it = by_id.get(ref)
            if it is not None and not it.get("touches"):
                out.append(f"shared_terms entry '{term.get('id')}' lists item '{ref}' with empty "
                           "touches — the deliver-time check has no files to scan for it")
    return out


# A command is judged vacuous only when the whole string is one trivially-passing
# command. Anything joined by `;`, `&&`, `||`, `|`, or a newline is left alone: a
# compound command may open with `true` or `echo` and still do real work afterwards,
# and this lint must not cry wolf on it.
_COMPOUND = re.compile(r"[;|&\n]")
_LONE_ECHO = re.compile(r"^echo(\s|$)")
# `true` with or without arguments, `:`, `exit 0`, and the absolute forms. Anchored with a
# boundary so `truebeam --run` is not caught.
_ALWAYS_OK = re.compile(r"^(/usr)?(/bin)?/?(true|:)(\s|$)|^exit\s+0\s*$")
# `a || true`, `a ; true` and `a | true` all take their exit status from the tail, so a
# vacuous tail makes the whole command vacuous however real the head is. A pipeline is in
# that list on purpose: without `set -o pipefail` its status is the LAST stage's, so
# `false | true` exits 0 — verified, not assumed. `&&` is the one separator that does not
# hand over, since `a && true` still fails when a fails. Split on the three that do and
# judge the last segment.
_DEFANG_SPLIT = re.compile(r"\|\||\||;|\n")


def mask_quoted(command: str) -> str:
    """`command` with quoted and escaped spans blanked, same length, so a separator that is
    really an argument stops looking like one. `grep -E 'a|true b' f` must not split on the
    pipe inside those quotes — flagging that command vacuous would be a false positive, and
    a lint that cries wolf on real commands is worse than one that misses a case."""
    out = list(command)
    quote = None
    i = 0
    while i < len(command):
        ch = command[i]
        # A backslash escapes outside quotes and inside double quotes, but never inside
        # single quotes, where POSIX makes it a literal. Missing the double-quoted case
        # let an escaped quote close the span early and expose the separators after it.
        if ch == "\\" and quote != "'" and i + 1 < len(command):
            out[i] = out[i + 1] = "x"
            i += 2
            continue
        if quote is not None:
            if ch == quote:
                quote = None
            else:
                out[i] = "x"
        elif ch in "'\"":
            quote = ch
        i += 1
    return "".join(out)


def _is_atom_vacuous(atom: str) -> bool:
    """One command with no status-handing separator in it."""
    atom = atom.strip()
    if not atom:
        return True
    return bool(_ALWAYS_OK.match(atom)) or bool(_LONE_ECHO.match(atom))


def _is_vacuous_command(command: str) -> bool:
    stripped = command.strip()
    if not stripped:
        return True
    # The exit status of `a || b` and `a ; b` is b's, so a vacuous tail defangs whatever
    # ran before it — `pytest -q || true` is green no matter what pytest did. That is the
    # commonest way an oracle stops being able to fail, so it is judged on the last
    # status-bearing segment rather than waved through as "compound, therefore real".
    # Empty segments are dropped before the tail is taken: a command may legitimately end
    # in its separator, and `pytest -q || true;` split naively yields a trailing "" that
    # hides the `true` behind it.
    # Split positions are found on the masked copy and applied to the original, so a
    # separator inside quotes never splits while the segment text stays real.
    masked = mask_quoted(stripped)
    pieces, last = [], 0
    for sep in _DEFANG_SPLIT.finditer(masked):
        pieces.append((stripped[last:sep.start()], masked[last:sep.start()]))
        last = sep.end()
    pieces.append((stripped[last:], masked[last:]))
    segments = [(raw.strip(), msk.strip()) for raw, msk in pieces if raw.strip()]
    if len(segments) > 1:
        tail_raw, tail_masked = segments[-1]
        # Only a tail that is itself one plain command is judged: `a || b && c` hands its
        # status to `b && c`, which is not a no-op just because it starts with one.
        if not _COMPOUND.search(tail_masked) and _is_atom_vacuous(tail_raw):
            return True
    if _COMPOUND.search(masked):
        return False
    return _is_atom_vacuous(stripped)


def vacuous_oracle_warnings(binder: dict) -> list[str]:
    """Advisory (non-fatal): name the check oracles nothing can decide.

    Two shapes qualify. A command that is a bare `true`, a bare `:`, an empty string, or
    a lone `echo` passes no matter what the code does — it is runnable but unfalsifiable.
    And a check oracle carrying assertions with neither a command nor an opt-out has
    nothing runnable behind those assertions at all. Both are warnings, never errors: the
    binder may legitimately be mid-draft, and the exit code stays the schema's business —
    exactly like sme_warnings and shared_terms_warnings above."""
    out: list[str] = []
    for it in binder.get("work_items", []):
        oracle = it.get("oracle")
        if not isinstance(oracle, dict) or oracle.get("opt_out"):
            continue
        command = oracle.get("command")
        if isinstance(command, str) and _is_vacuous_command(command):
            out.append(f"{it.get('id')}: oracle command {command!r} is vacuous — it passes "
                       "whatever the code does; give it a real check, or an explicit opt_out "
                       "with a reason")
        elif command is None and oracle.get("assertions"):
            out.append(f"{it.get('id')}: oracle carries assertions but no command and no "
                       "opt_out — nothing runnable backs them, so the assertions are vacuous")
    return out


# Global options git accepts before a subcommand (`-C dir`, `-c k=v`, `--no-pager`, ...).
_GIT_GLOBALS = (r"(?:\s+(?:-C\s+(?:\"[^\"]*\"|'[^']*'|\S+)|-c\s+\S+|--no-pager|-P|"
                r"--no-optional-locks|--literal-pathspecs|--(?:git-dir|work-tree)=\S+))*")
_GIT_TREE_CMD = re.compile(r"\bgit(?P<globals>" + _GIT_GLOBALS + r")\s+(?P<sub>status|diff-index|diff)"
                           r"\b(?P<args>[^|;&)`\n<>]*)")
_GIT_C_DIR = re.compile(r"-C\s+(\"[^\"]*\"|'[^']*'|\S+)")
# A machine-readable status: `--porcelain[=[v]1|2]`, `--short`, `-z`, or a short-flag
# cluster holding `s` or `z` (`-s`, `-sb`, `-sz`).
_STATUS_SHORT_FLAG = re.compile(r"^(?:--porcelain(?:=v?[12])?|--short|-[A-Za-z]*[sz][A-Za-z]*)$")
_STDERR_REDIRECT = re.compile(r"\s2>>?\s*(?:&1|\S+)")
# A grep pattern that matches any line, so the grep only asks "is the output non-empty".
_ANY_LINE = {"", ".", "^", "$", ".*", "^.*", "^."}
_LONG_CLEAN = re.compile(r"nothing to commit|working tree clean")


def _pipe_stage(text: str) -> list[str] | None:
    """The words of the first pipeline stage in `text` (after a leading `|`), quote-aware."""
    quote, end = "", len(text)
    for i, ch in enumerate(text):
        if quote:
            quote = "" if ch == quote else quote
        elif ch in "'\"":
            quote = ch
        elif ch in "|;&)\n":
            end = i
            break
    try:
        return shlex.split(text[:end])
    except ValueError:
        return None


def _grep_pattern(words: list[str] | None) -> tuple[str | None, bool]:
    """(pattern, inverted) for a `grep` stage, else (None, False)."""
    if not words or posixpath.basename(words[0]) not in ("grep", "egrep", "fgrep"):
        return None, False
    inverted, pattern, rest = False, None, iter(words[1:])
    for w in rest:
        if w in ("-e", "--regexp"):
            pattern = next(rest, "")
        elif w.startswith("--regexp="):
            pattern = w.split("=", 1)[1]
        elif w == "--invert-match" or (w.startswith("-") and not w.startswith("--") and "v" in w):
            inverted = True
        elif w.startswith("-"):
            continue
        elif pattern is None:
            pattern = w
    return pattern, inverted


def _asserts_clean_tree(command: str) -> tuple[str, list[str] | None] | None:
    """The first check in `command` that asserts the tree matches HEAD or the index.

    Returns (the matched text, its pathspecs, or None for the whole tree), else None.
    Three shapes qualify:
    - a machine-readable `git status` the command consumes: inside `$(...)`, `<(...)` or
      backticks, redirected to a file, or piped into a command other than a grep for a
      specific pattern (a grep for named files, such as a secret-file guard, passes on a
      staged candidate unless the item stages such a file);
    - a long-format `git status` piped into a grep for "nothing to commit" or "working
      tree clean";
    - a `git diff` or `git diff-index` against `HEAD`, `--cached` or `--staged` that exits
      on a difference (`--exit-code`, `--quiet`) or whose output is consumed as above.
    A status printed on its own is a diagnostic and is not matched; nor is
    `git diff --exit-code [-- <paths>]`, which compares the worktree with the index."""
    command = _STDERR_REDIRECT.sub(" ", command)
    for m in _GIT_TREE_CMD.finditer(command):
        try:
            words = shlex.split(m.group("args"))
        except ValueError:
            words = m.group("args").split()
        flags, paths = (words[:words.index("--")], words[words.index("--") + 1:]) \
            if "--" in words else (words, [])
        before, after = command[:m.start()], command[m.end():].lstrip()
        opened = max(before.rfind("$("), before.rfind("<("))
        in_subst = opened >= 0 and ")" not in before[opened:]
        in_backticks = before.count("`") % 2 == 1
        redirected = after.startswith(">") and not after.lstrip(">").lstrip().startswith("/dev/null")
        piped = after.startswith("|") and not after.startswith("||")
        pattern, inverted = _grep_pattern(_pipe_stage(after[1:])) if piped else (None, False)
        targeted = pattern is not None and not inverted and pattern not in _ANY_LINE
        consumed = (in_subst or in_backticks or redirected or piped) and not targeted
        if m.group("sub") == "status":
            short = any(_STATUS_SHORT_FLAG.match(w) for w in flags)
            paths += [w for w in flags if not w.startswith("-")]
            hit = consumed if short else (
                piped and not inverted and bool(_LONG_CLEAN.search(pattern or "")))
        else:
            against = any(w in ("HEAD", "--cached", "--staged") for w in flags)
            hit = against and (consumed or any(w in ("--exit-code", "--quiet") for w in flags))
        if not hit:
            continue
        c_dirs = [d.strip("\"'") for d in _GIT_C_DIR.findall(m.group("globals"))]
        root = posixpath.join(*c_dirs) if c_dirs else ""
        specs = [posixpath.normpath(posixpath.join(root, p)) for p in paths]
        whole = not specs or any(sp in (".", "") for sp in specs)
        return m.group(0).strip(), None if whole else specs
    return None


def clean_status_oracle_warnings(binder: dict) -> list[str]:
    """Advisory (non-fatal): name the oracles that assert a clean tree over paths the item
    changes (F39).

    The build runs an item's oracle on the staged, uncommitted candidate in the item
    worktree: the Pi finalizer stages it (`git add -A`) before its final checks, and the
    Claude Code and Codex build skill stages before every floor run. Every path the item
    changed then differs from HEAD, so a check that the status is empty, or that the tree
    matches HEAD or the index, cannot pass if it covers one of those paths. Overlap is
    `paths_overlap` between the check's pathspecs and the item's `touches`: equal, a
    directory prefix either way, or a glob match. A check with no pathspec covers the whole
    tree and always warns; one with a pathspec warns when the item declares no `touches`,
    since nothing shows it disjoint. A warning, not an error, like the vacuous lint above:
    the text match is a heuristic."""
    out: list[str] = []
    for it in binder.get("work_items", []):
        oracle = it.get("oracle")
        if not isinstance(oracle, dict) or oracle.get("opt_out"):
            continue
        command = oracle.get("command")
        found = _asserts_clean_tree(command) if isinstance(command, str) else None
        if not found:
            continue
        text, specs = found
        touches = [t for t in it.get("touches") or [] if isinstance(t, str)]
        if specs is None:
            scope = "the whole tree (no pathspec)"
        elif not touches:
            scope = f"{', '.join(specs)}, and the item declares no touches to show it disjoint"
        else:
            overlap = paths_overlap(specs, touches)
            if not overlap:
                continue
            scope = f"{', '.join(overlap)}, which the item touches"
        out.append(f"{it.get('id')}: oracle asserts `{text}` is clean over {scope} — the "
                   "build runs the oracle on the staged, uncommitted candidate, so the check "
                   "cannot pass if the item changes any path it covers. To prove regenerated "
                   "files are unchanged, `git diff --exit-code -- <paths>` (worktree against "
                   "index) passes on a staged tree; it cannot see a staged new file, so do not "
                   "swap it in for a leak guard: scope the status away from the item's paths, "
                   "or grep its output for the specific file names")
    return out


def precondition_order_warnings(binder: dict) -> list[str]:
    """Advisory (non-fatal), B1: an item waits on a precondition and reaches, through
    `depends_on`, another item of this binder that is not carried. Preflight checks the
    precondition before that item builds, so if that item's change is what makes it true (a
    deploy, a served tree), it can never hold in this delivery. A warning, not an error: the
    graph cannot tell whether the dependency is what makes the precondition true."""
    items = binder.get("work_items", [])
    graph = {it.get("id"): list(it.get("depends_on", [])) for it in items}
    carried = set((binder.get("supersedes") or {}).get("carried", []))
    out: list[str] = []
    for it in items:
        upstream = sorted((reachable(it.get("id"), graph) & set(graph)) - carried - {it.get("id")})
        if not upstream or it.get("id") in carried:
            continue
        for ref in it.get("waits_on", []):
            out.append(f"{it.get('id')}: waits on precondition '{ref}' and depends on "
                       f"{', '.join(upstream)} in this binder — preflight checks '{ref}' before "
                       "those items build, so if their change makes it true it can never hold "
                       "in this delivery. Split the work into two binders joined by `after` "
                       "(plan:shape test 2, plan:prelanding)")
    return out


_PRECONDITION_WORD = re.compile(r"\bprecondition", re.IGNORECASE)


def _contract_text(contract) -> list[str]:
    """Every string in a contract: the string itself, or an object's keys and values,
    walked through nested objects and lists."""
    if isinstance(contract, str):
        return [contract]
    if isinstance(contract, dict):
        return [t for k, v in contract.items() for t in [str(k), *_contract_text(v)]]
    if isinstance(contract, list):
        return [t for v in contract for t in _contract_text(v)]
    return []


def undeclared_precondition_warnings(binder: dict) -> list[str]:
    """Advisory (non-fatal), B2: an item with no `waits_on` whose contract mentions a
    precondition in prose. Planners already write such waits in contract text, where
    nothing checks them before a worker runs. A word match, so a warning: it misses a wait
    written without the word and fires on a contract that only mentions one. A carried
    item is skipped: the planner cannot edit it."""
    carried = set((binder.get("supersedes") or {}).get("carried", []))
    return [f"{it.get('id')}: contract mentions a precondition but the item has no waits_on — "
            "declare it in `preconditions` so preflight checks it before any worker runs"
            for it in binder.get("work_items", [])
            if not it.get("waits_on") and it.get("id") not in carried
            and any(_PRECONDITION_WORD.search(t) for t in _contract_text(it.get("contract")))]


def cross_binder_errors(binders: list[dict],
                        archived: frozenset[str] = frozenset()) -> tuple[list[str], list[str]]:
    """Check the cross-binder `after` graph across a whole set of binders.

    Returns (errors, warnings). A dangling `after` ref (no binder with that slug) is a
    WARNING — the suggested order is recomputed over the binders that exist, so a stale edge
    surfaces but never fails the set. A cycle across `after` edges is an ERROR — a cycle has no
    valid order. A single binder, or binders with no `after`, produce nothing.

    `archived` is the slug set of delivered binders (`.hatch/binders/archive/`): an `after`
    naming one is satisfied, not dangling; a live binder REUSING an archived slug draws a
    warning — the delivered history would be shadowed, so new work takes a fresh slug."""
    slugs = {b.get("slug") for b in binders}
    warnings: list[str] = []
    for s in sorted(slugs & archived):
        warnings.append(f"binder '{s}' reuses the slug of an archived (delivered) binder — "
                        "the delivered history is shadowed; plan new work under a fresh slug")
    graph: dict[str, list[str]] = {}
    for b in binders:
        slug = b.get("slug")
        resolved: list[str] = []
        for ref in b.get("after", []) or []:
            if ref in slugs:
                resolved.append(ref)
            elif ref not in archived:
                warnings.append(f"binder '{slug}' has a dangling after: '{ref}' (no such binder)")
        graph[slug] = resolved

    errors: list[str] = []
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {s: WHITE for s in graph}

    def visit(node: str, stack: list[str]) -> None:
        color[node] = GRAY
        for nxt in graph.get(node, []):
            if color.get(nxt) == GRAY:
                errors.append("after cycle: " + " -> ".join(stack + [nxt]))
            elif color.get(nxt) == WHITE:
                visit(nxt, stack + [nxt])
        color[node] = BLACK

    for s in sorted(graph):
        if color[s] == WHITE:
            visit(s, [s])
    return errors, sorted(set(warnings))


def _run_self_test() -> int:
    valid = json.loads((SCHEMA_PATH.parent / "example-binder.json").read_text(encoding="utf-8"))
    cyclic = {
        "slug": "c", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "depends_on": ["b"], "oracle": {"type": "unit"}},
            {"id": "b", "title": "B", "summary": "s", "depends_on": ["a"], "oracle": {"type": "unit"}},
        ],
    }
    dangling = {
        "slug": "d", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s", "depends_on": ["ghost"], "oracle": {"type": "unit"}}],
    }
    no_oracle = {
        "slug": "n", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s"}],
    }
    optout_no_reason = {
        "slug": "o", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": {"opt_out": True}}],
    }
    _u = {"type": "unit"}
    collide = {
        "slug": "collide", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "touches": ["app/models.py"], "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "touches": ["app/models.py"], "oracle": _u},
        ],
    }
    collide_serialize = {
        "slug": "collide-ser", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "touches": ["app/models.py"], "serialize": True, "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "touches": ["app/models.py"], "oracle": _u},
        ],
    }
    collide_dep = {
        "slug": "collide-dep", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "touches": ["app/models.py"], "depends_on": ["b"], "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "touches": ["app/models.py"], "oracle": _u},
        ],
    }
    collide_shared = {
        "slug": "collide-shared", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "touches": ["db/x.sql"], "shared_resources": ["db/schema"], "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "touches": ["db/x.sql"], "shared_resources": ["db/schema"], "oracle": _u},
        ],
    }
    collide_glob = {
        "slug": "collide-glob", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "touches": ["app/*.py"], "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "touches": ["./app/models.py"], "oracle": _u},
        ],
    }
    no_collide = {
        "slug": "no-collide", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "touches": ["app/a.py"], "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "touches": ["app/b.py"], "oracle": _u},
        ],
    }
    collide_transitive = {
        "slug": "collide-trans", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "touches": ["app/x.py"], "depends_on": ["b"], "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "depends_on": ["c"], "oracle": _u},
            {"id": "c", "title": "C", "summary": "s", "touches": ["app/x.py"], "oracle": _u},
        ],
    }
    sme_valid = {
        "slug": "sme-ok", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "sme": ["angular", "python-fastapi"],
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}],
    }
    sme_not_array = {
        "slug": "sme-bad", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "sme": "angular",
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}],
    }
    sme_bad_id = {
        "slug": "sme-badid", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "sme": ["Angular_Expert"],
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}],
    }
    bad_estimate = {
        "slug": "bad-est", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s", "estimate": "XL", "oracle": _u}],
    }
    unknown_top_key = {
        "slug": "extra", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}],
        "surprise": True,
    }
    empty_work_items = {
        "slug": "empty", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [],
    }
    bad_slug = {
        "slug": "Bad_Slug", "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}],
    }
    missing_item_summary = {
        "slug": "no-item-summary", "title": "T", "summary": "S", "motivation": "x",
        "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "oracle": _u}],
    }
    missing_binder_summary = {
        "slug": "no-binder-summary", "title": "T", "motivation": "x",
        "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}],
    }
    missing_binder_title = {
        "slug": "no-binder-title", "summary": "S", "motivation": "x",
        "scope": {"included": ["x"]},
        "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}],
    }
    # shared_terms: two items touching distinct files (so no wave collision) plus a term.
    _st_items = [
        {"id": "a", "title": "A", "summary": "s", "touches": ["app/a.py"], "oracle": _u},
        {"id": "b", "title": "B", "summary": "s", "touches": ["app/b.py"], "oracle": _u},
    ]
    def _st_binder(slug, terms, items=None):
        return {
            "slug": slug, "title": "T", "summary": "S", "motivation": "x",
            "scope": {"included": ["x"]},
            "work_items": items if items is not None else [dict(i) for i in _st_items],
            "shared_terms": terms,
        }
    shared_terms_ok = _st_binder(
        "st-ok", [{"id": "shadow-warning", "canonical": "reuses an archived slug", "items": ["a", "b"]}])
    shared_terms_dangling = _st_binder(
        "st-dangling", [{"id": "t", "canonical": "c", "items": ["a", "ghost"]}])
    shared_terms_dup_id = _st_binder(
        "st-dup",
        [{"id": "t", "canonical": "c", "items": ["a", "b"]},
         {"id": "t", "canonical": "d", "items": ["a", "b"]}])
    shared_terms_empty_canonical = _st_binder(
        "st-empty-canon", [{"id": "t", "canonical": "", "items": ["a", "b"]}])
    shared_terms_single_item = _st_binder(
        "st-single", [{"id": "t", "canonical": "c", "items": ["a"]}])

    # oracle `expect`: the optional success-only marker on the check branch. It is a plain
    # string, so a non-string value must be rejected by the same schema pass that accepts it.
    def _expect_binder(slug, expect):
        return {
            "slug": slug, "title": "T", "summary": "S", "motivation": "x",
            "scope": {"included": ["x"]},
            "work_items": [{"id": "a", "title": "A", "summary": "s",
                            "oracle": {"type": "smoke", "command": "pytest -q",
                                       "expect": expect}}],
        }
    oracle_expect_ok = _expect_binder("oracle-expect-ok", "1 passed")
    oracle_expect_not_string = _expect_binder("oracle-expect-int", 3)

    # design: rule fixtures. _v is a visual oracle with a non-empty assertions list (the shape
    # a valid covering item needs); _u (defined above) is a plain unit oracle.
    _v = {"type": "visual", "assertions": ["matches the view"]}

    def _design_item(design_reference=None, oracle=None, waiver=None):
        it = {"id": "w", "title": "W", "summary": "s", "oracle": oracle if oracle is not None else _u}
        if design_reference is not None:
            it["design_reference"] = design_reference
        if waiver is not None:
            it["visual_check_waiver"] = waiver
        return it

    def _design_binder(slug, work_items, design_facts=None):
        b = {"slug": slug, "title": "T", "summary": "S", "motivation": "x",
             "scope": {"included": ["x"]}, "work_items": work_items}
        if design_facts is not None:
            b["design_facts"] = design_facts
        return b

    design_missing_waiver = _design_binder(
        "design-missing-waiver", [_design_item(design_reference="view-x")])
    design_visual_ok = _design_binder(
        "design-visual-ok", [_design_item(design_reference="view-x", oracle=_v)])
    design_none_ok = _design_binder(
        "design-none-ok", [_design_item(design_reference="none")])
    design_capital_none = _design_binder(
        "design-capital-none", [_design_item(design_reference="None")])
    design_upper_none = _design_binder(
        "design-upper-none", [_design_item(design_reference="NONE")])
    optout_design_no_waiver = _design_binder(
        "optout-design-no-waiver",
        [_design_item(design_reference="view-x", oracle={"opt_out": True, "reason": "r"})])
    optout_design_with_waiver = _design_binder("optout-design-with-waiver", [
        {"id": "w", "title": "W", "summary": "s", "design_reference": "view-x",
         "oracle": {"opt_out": True, "reason": "r"},
         "visual_check_waiver": {"reason": "checked by c", "covered_by": "c"}},
        {"id": "c", "title": "C", "summary": "s", "design_reference": "view-c",
         "depends_on": ["w"], "covers": ["w"], "oracle": _v},
    ])

    # redundant_waiver: one violating fixture covers both non-vacuous shapes (design_reference
    # absent + waiver; already-visual + waiver), plus one compliant twin with the waivers dropped.
    redundant_waiver_bad = _design_binder("redundant-waiver-bad", [
        {"id": "a", "title": "A", "summary": "s", "oracle": _u,
         "visual_check_waiver": {"reason": "r", "covered_by": "b"}},
        {"id": "b", "title": "B", "summary": "s", "design_reference": "view-b", "oracle": _v,
         "visual_check_waiver": {"reason": "r", "covered_by": "b"}},
    ])
    redundant_waiver_good = _design_binder("redundant-waiver-good", [
        {"id": "a", "title": "A", "summary": "s", "oracle": _u},
        {"id": "b", "title": "B", "summary": "s", "design_reference": "view-b", "oracle": _v},
    ])

    # coverage rule: a base fully-compliant pair (w waived, c covers it), then one broken twin
    # per condition — each flips exactly one property of the compliant pair.
    def _cov_binder(slug, w_extra=None, c_extra=None, drop_c_design_reference=False,
                    drop_c_covers=False):
        w = {"id": "w", "title": "W", "summary": "s", "design_reference": "view-w",
             "oracle": _u, "visual_check_waiver": {"reason": "checked by c", "covered_by": "c"}}
        c = {"id": "c", "title": "C", "summary": "s", "design_reference": "view-c",
             "depends_on": ["w"], "covers": ["w"],
             "oracle": {"type": "visual", "assertions": ["checks w and c"]}}
        if w_extra:
            w.update(w_extra)
        if c_extra:
            c.update(c_extra)
        if drop_c_design_reference:
            del c["design_reference"]
        if drop_c_covers:
            del c["covers"]
        return _design_binder(slug, [w, c])

    cov_base_good = _cov_binder("cov-base-good")
    cov_unknown_id = _cov_binder(
        "cov-unknown-id", w_extra={"visual_check_waiver": {"reason": "x", "covered_by": "ghost"}})
    cov_not_visual = _cov_binder(
        "cov-not-visual", c_extra={"oracle": {"type": "unit", "assertions": ["checks w and c"]}})
    cov_design_none = _cov_binder("cov-design-none", c_extra={"design_reference": "none"})
    cov_design_absent = _cov_binder("cov-design-absent", drop_c_design_reference=True)
    cov_no_dep_edge = _cov_binder("cov-no-dep-edge", c_extra={"depends_on": []})
    cov_no_assertions = _cov_binder("cov-no-assertions", c_extra={"oracle": {"type": "visual"}})
    cov_empty_assertions = _cov_binder(
        "cov-empty-assertions", c_extra={"oracle": {"type": "visual", "assertions": []}})
    # covers condition: the covering item has to accept the waived item. Two violating shapes
    # (no covers list at all; a covers list that names someone else), against cov_base_good —
    # the identical pair whose only difference is that 'w' appears in c's covers.
    cov_covers_absent = _cov_binder("cov-covers-absent", drop_c_covers=True)
    cov_covers_omits_waived = _cov_binder("cov-covers-omits-waived", c_extra={"covers": ["c"]})

    # The watch-fidelity shape, and the reason the covers condition is not design_reference
    # equality: one closing gate naming 'binder-panel' legitimately covers three items naming
    # three other views. Valid because the gate lists all three; the twin below drops one id
    # from that list and only that item is rejected.
    def _multi_view_binder(slug, covers):
        waived = [
            {"id": wid, "title": wid.upper(), "summary": "s", "design_reference": wid,
             "oracle": _u,
             "visual_check_waiver": {"reason": "compared once at the closing gate",
                                     "covered_by": "gate"}}
            for wid in ("typography", "item-card", "rail")]
        gate = {"id": "gate", "title": "Gate", "summary": "s",
                "design_reference": "binder-panel",
                "depends_on": ["typography", "item-card", "rail"], "covers": covers,
                "oracle": {"type": "visual",
                           "assertions": ["the assembled panel matches the design"]}}
        return _design_binder(slug, waived + [gate])

    multi_view_gate = _multi_view_binder(
        "multi-view-gate", ["typography", "item-card", "rail"])
    multi_view_gate_drops_one = _multi_view_binder(
        "multi-view-gate-drops-one", ["typography", "item-card"])

    # a cyclic depends_on graph still terminates when the coverage walk (reachable) runs over
    # it, and the cycle error and the design: error both surface in the same pass.
    cyclic_with_design = {
        "slug": "cyclic-design", "title": "T", "summary": "S", "motivation": "x",
        "scope": {"included": ["x"]},
        "work_items": [
            {"id": "a", "title": "A", "summary": "s", "depends_on": ["b"],
             "design_reference": "view-a", "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "depends_on": ["a"], "oracle": _u},
        ],
    }

    # pre-rule consumer shape, mirrored inline from benchmarks/fixtures/
    # gringotts-browse-refinements-binder-2026-07-17.json (same ids, same real prose
    # design_reference strings, no visual item anywhere) rather than read from disk, so the
    # shipped self-test stays zero-dependency wherever this script is installed — a bare
    # Codex plugin install carries no benchmarks/ directory.
    gringotts_shape = _design_binder(
        "gringotts-browse-refinements",
        [
            {"id": "detail-hero-derivative", "title": "T1", "summary": "s",
             "design_reference": "/photos/{id} — detail hero image (comps shared in-session 2026-07-17)",
             "oracle": {"type": "integration"}},
            {"id": "tag-chip-counts", "title": "T2", "summary": "s",
             "design_reference": "/ — tag chip rail with count badges (comps shared in-session 2026-07-17)",
             "oracle": {"type": "integration"}},
            {"id": "multi-tag-filter", "title": "T3", "summary": "s",
             "design_reference": "/?tag=a&tag=b — chip rail add/remove interaction, K-of-N header, "
                                  "intersection grid (comps shared in-session 2026-07-17)",
             "oracle": {"type": "integration"}},
            {"id": "wide-screen-layout", "title": "T4", "summary": "s",
             "design_reference": "/ and /photos/{id} at wide viewports — centered-column comps "
                                  "shared in-session 2026-07-17",
             "oracle": {"type": "integration"}},
        ],
        design_facts={"source": "https://claude.ai/design/p/48eada1e-cbaf-40d2-8b93-308d71b2f564 "
                                 "— delivered hybrid vocabulary extended; comps for this slice "
                                 "shared in-session 2026-07-17",
                      "stack": "Go 1.26 + templ/HTMX + modernc SQLite; one static CGO-free binary"})

    waiver_missing_reason = _design_binder("waiver-missing-reason", [
        {"id": "a", "title": "A", "summary": "s", "design_reference": "view-a", "oracle": _u,
         "visual_check_waiver": {"covered_by": "b"}},
        {"id": "b", "title": "B", "summary": "s", "design_reference": "view-b", "oracle": _v},
    ])
    waiver_missing_covered_by = _design_binder("waiver-missing-covered-by", [
        {"id": "a", "title": "A", "summary": "s", "design_reference": "view-a", "oracle": _u,
         "visual_check_waiver": {"reason": "r"}},
    ])
    waiver_empty_reason = _design_binder("waiver-empty-reason", [
        {"id": "a", "title": "A", "summary": "s", "design_reference": "view-a", "oracle": _u,
         "visual_check_waiver": {"reason": "", "covered_by": "b"}},
        {"id": "b", "title": "B", "summary": "s", "design_reference": "view-b", "oracle": _v},
    ])
    waiver_extra_prop = _design_binder("waiver-extra-prop", [
        {"id": "a", "title": "A", "summary": "s", "design_reference": "view-a", "oracle": _u,
         "visual_check_waiver": {"reason": "r", "covered_by": "b", "extra": True}},
        {"id": "b", "title": "B", "summary": "s", "design_reference": "view-b", "oracle": _v},
    ])
    design_reference_empty = _design_binder(
        "design-reference-empty",
        [{"id": "a", "title": "A", "summary": "s", "design_reference": "", "oracle": _u}])

    # UI-only fields on an item with no design_reference (a non-UI item) — a schema if/then.
    ui_fields_non_ui = _design_binder("ui-fields-non-ui", [
        {"id": "m", "title": "M", "summary": "s", "oracle": _u, "component_map": [{"n": "T"}]}])
    ui_fields_ui = _design_binder("ui-fields-ui", [
        {"id": "m", "title": "M", "summary": "s", "oracle": _u, "design_reference": "none",
         "component_map": [{"n": "T"}], "icon_map": [], "token_changes": []}])

    # supersedes: a successor binder carrying items the predecessor already delivered.
    def _succ_binder(slug, supersedes):
        return _design_binder(slug, [
            {"id": "a", "title": "A", "summary": "s", "oracle": _u},
            {"id": "b", "title": "B", "summary": "s", "oracle": _u, "depends_on": ["a"]}]) | {
            "supersedes": supersedes}
    succ_ok = _succ_binder("s-r2", {"slug": "s", "carried": ["a"]})
    succ_dangling = _succ_binder("s-r2", {"slug": "s", "carried": ["ghost"]})
    succ_self = _succ_binder("s-r2", {"slug": "s-r2", "carried": ["a"]})
    succ_dup = _succ_binder("s-r2", {"slug": "s", "carried": ["a", "a"]})

    # declared preconditions: a binder-level list of probes, and an item-level `waits_on`
    # that names one. Ids are unique and every waits_on id is declared; at most 8 probes.
    _pc = {"id": "live-evidence", "command": "test -f evidence.json", "reason": "needs live reads"}
    _pc_plain = [{"id": "a", "title": "A", "summary": "s", "oracle": _u}]

    def _pc_binder(preconditions, items=None):
        return {"slug": "pc", "title": "T", "summary": "S", "motivation": "x",
                "scope": {"included": ["x"]}, "preconditions": preconditions,
                "work_items": items if items is not None else [
                    {"id": "a", "title": "A", "summary": "s", "oracle": _u,
                     "waits_on": ["live-evidence"]}]}
    pc_ok = _pc_binder([_pc])
    pc_cwd_ok = _pc_binder([_pc | {"cwd": "backend"}])
    pc_binder_wide = _pc_binder([_pc], _pc_plain)
    pc_dup = _pc_binder([_pc, _pc])
    pc_unknown_wait = _pc_binder([_pc], [_pc_plain[0] | {"waits_on": ["ghost"]}])
    pc_wait_no_list = _pc_binder([], [_pc_plain[0] | {"waits_on": ["live-evidence"]}])
    pc_extra_key = _pc_binder([_pc | {"timeout": 5}])
    pc_no_reason = _pc_binder([{"id": "live-evidence", "command": "true"}])
    pc_empty_command = _pc_binder([_pc | {"command": ""}])
    pc_bad_id = _pc_binder([_pc | {"id": "Live Evidence"}], _pc_plain)
    pc_eight = _pc_binder([_pc | {"id": f"p{n}"} for n in range(8)], _pc_plain)
    pc_nine = _pc_binder([_pc | {"id": f"p{n}"} for n in range(9)], _pc_plain)
    pc_waits_string = _pc_binder([_pc], [_pc_plain[0] | {"waits_on": "live-evidence"}])

    cases = [
        ("valid example", valid, True),
        ("well-formed shared_terms", shared_terms_ok, True),
        ("shared_terms dangling item id", shared_terms_dangling, False),
        ("shared_terms duplicate entry id", shared_terms_dup_id, False),
        ("shared_terms empty canonical", shared_terms_empty_canonical, False),
        ("shared_terms single-item entry", shared_terms_single_item, False),
        ("binder with sme packs", sme_valid, True),
        ("sme not an array", sme_not_array, False),
        ("sme id bad pattern", sme_bad_id, False),
        ("bad estimate enum", bad_estimate, False),
        ("unknown top-level property", unknown_top_key, False),
        ("empty work_items", empty_work_items, False),
        ("bad slug pattern", bad_slug, False),
        ("work item missing summary", missing_item_summary, False),
        ("binder missing summary", missing_binder_summary, False),
        ("binder missing title", missing_binder_title, False),
        ("cyclic deps", cyclic, False),
        ("dangling dep", dangling, False),
        ("missing oracle", no_oracle, False),
        ("opt-out without reason", optout_no_reason, False),
        ("same-wave file collision", collide, False),
        ("file collision but serialized", collide_serialize, True),
        ("file overlap across a dependency edge", collide_dep, True),
        ("file overlap with shared resource", collide_shared, True),
        ("glob/normalized same-wave collision", collide_glob, False),
        ("same-wave different files", no_collide, True),
        ("file overlap across a transitive edge", collide_transitive, True),
        ("design_reference names a real view, no visual oracle, no waiver", design_missing_waiver, False),
        ("design_reference real view backed by a visual oracle needs no waiver", design_visual_ok, True),
        ("design_reference 'none' needs no visual oracle and no waiver", design_none_ok, True),
        ("design_reference 'None' is a design claim, not the none sentinel", design_capital_none, False),
        ("design_reference 'NONE' is a design claim, not the none sentinel", design_upper_none, False),
        ("opt-out oracle with a real design claim and no waiver", optout_design_no_waiver, False),
        ("opt-out oracle with a real design claim covered by a waiver", optout_design_with_waiver, True),
        ("redundant waiver on a none/absent claim and on an already-visual item", redundant_waiver_bad, False),
        ("same items with the redundant waivers dropped", redundant_waiver_good, True),
        ("waiver covered_by names an unknown work item", cov_unknown_id, False),
        ("waiver coverage: fully compliant pair", cov_base_good, True),
        ("waiver covered_by item does not carry a visual oracle", cov_not_visual, False),
        ("waiver covered_by item has design_reference 'none'", cov_design_none, False),
        ("waiver covered_by item has no design_reference at all", cov_design_absent, False),
        ("waiver covered_by item does not depend on the waived item", cov_no_dep_edge, False),
        ("waiver covered_by item oracle has no assertions field", cov_no_assertions, False),
        ("waiver covered_by item oracle has an empty assertions list", cov_empty_assertions, False),
        ("waiver covered_by item declares no covers at all", cov_covers_absent, False),
        ("waiver covered_by item's covers omits the waived item", cov_covers_omits_waived, False),
        ("one gate covering three items that name three different views", multi_view_gate, True),
        ("the same gate with one covered id dropped from its covers", multi_view_gate_drops_one, False),
        ("pre-rule consumer binder shape (gringotts-browse-refinements)", gringotts_shape, False),
        ("cyclic deps binder also carrying an unwaived design claim", cyclic_with_design, False),
        ("visual_check_waiver missing reason", waiver_missing_reason, False),
        ("visual_check_waiver missing covered_by", waiver_missing_covered_by, False),
        ("visual_check_waiver empty reason", waiver_empty_reason, False),
        ("visual_check_waiver additional property rejected", waiver_extra_prop, False),
        ("design_reference empty string rejected by minLength", design_reference_empty, False),
        ("oracle carrying an expect marker validates", oracle_expect_ok, True),
        ("oracle expect that is not a string is rejected", oracle_expect_not_string, False),
        ("UI-only field on an item without design_reference", ui_fields_non_ui, False),
        ("UI-only fields on an item with design_reference", ui_fields_ui, True),
        ("successor binder carrying a delivered item", succ_ok, True),
        ("successor carried id that is not a work item", succ_dangling, False),
        ("binder superseding its own slug", succ_self, False),
        ("successor carried ids not unique", succ_dup, False),
        ("precondition an item waits on", pc_ok, True),
        ("precondition with a cwd", pc_cwd_ok, True),
        ("binder-wide precondition no item names", pc_binder_wide, True),
        ("duplicate precondition id", pc_dup, False),
        ("waits_on names an undeclared precondition", pc_unknown_wait, False),
        ("waits_on with an empty preconditions list", pc_wait_no_list, False),
        ("precondition additional property rejected", pc_extra_key, False),
        ("precondition missing reason", pc_no_reason, False),
        ("precondition empty command", pc_empty_command, False),
        ("precondition id bad pattern", pc_bad_id, False),
        ("eight preconditions", pc_eight, True),
        ("nine preconditions exceed maxItems", pc_nine, False),
        ("waits_on that is not an array", pc_waits_string, False),
    ]
    failures = 0
    for name, binder, should_pass in cases:
        errs = validate_binder(binder)
        passed = not errs
        ok = passed == should_pass
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: "
              f"{'valid' if passed else 'invalid (' + '; '.join(errs) + ')'}")
        if not ok:
            failures += 1
    # opt-out summary must be detected on the valid example
    summ = opt_out_summary(valid)
    ok = len(summ) == 1
    print(f"[{'PASS' if ok else 'FAIL'}] opt-out summary on example: {summ}")
    failures += 0 if ok else 1
    # sme advisory: warns only when no stack packs are pinned
    ok = len(sme_warnings(cyclic)) == 1 and len(sme_warnings(sme_valid)) == 0
    print(f"[{'PASS' if ok else 'FAIL'}] sme warning fires only on empty sme")
    failures += 0 if ok else 1
    # shared_terms advisory: warns for a listed item with empty touches; silent otherwise.
    # The entry is otherwise well-formed, so the binder still validates (warning != error).
    st_empty_touches = _st_binder(
        "st-warn", [{"id": "t", "canonical": "c", "items": ["a", "b"]}],
        items=[{"id": "a", "title": "A", "summary": "s", "touches": ["app/a.py"], "oracle": _u},
               {"id": "b", "title": "B", "summary": "s", "oracle": _u}])
    ok = (not validate_binder(st_empty_touches)
          and len(shared_terms_warnings(st_empty_touches)) == 1
          and len(shared_terms_warnings(shared_terms_ok)) == 0)
    print(f"[{'PASS' if ok else 'FAIL'}] shared_terms warns on a listed item with empty touches")
    failures += 0 if ok else 1

    # vacuous-oracle lint, part 1 — a command nothing can fail. Each trivially-passing form
    # draws exactly one warning naming it vacuous, and the paired real commands draw none:
    # `pytest -q` is a plain check, and the compound command opens with `echo` yet goes on to
    # do real work, which is the false positive this lint must not produce.
    def _cmd_binder(command):
        return {
            "slug": "vac", "title": "T", "summary": "S", "motivation": "x",
            "scope": {"included": ["x"]},
            "work_items": [{"id": "a", "title": "A", "summary": "s",
                            "oracle": {"type": "smoke", "command": command}}],
        }
    # The defang cases are the point of the list, not an afterthought: `pytest -q || true`
    # is green whatever pytest did, and it was the shape this lint missed until a review
    # named it. `&&` and `|` stay off the list deliberately — `a && true` still fails when
    # a fails, so it is not a defang and `echo running && pytest -q` must stay quiet.
    vacuous_cmds = ["true", ":", "  true  ", "echo ok", "echo", "",
                    "pytest -q || true", "npm test ; true", "make lint || echo ok",
                    "/bin/true", "/usr/bin/true", "exit 0", "true --anything",
                    # A pipeline hands its status to the last stage without `pipefail`
                    # (`false | true` exits 0, verified), so a pipe defangs exactly like
                    # `||`. A command may also end in its own separator, which used to
                    # leave an empty tail segment that hid the no-op behind it.
                    "pytest -q | true", "make test | :", "pytest -q || true;",
                    'pytest -q "x\\" y" || true']
    real_cmds = ["pytest -q", "echo running && pytest -q", "true; pytest -q", "truebeam --run",
                 "pytest -q || exit 1", "pytest -q | grep -q PASS", "a || b && c",
                 # A separator inside quotes is an argument, not a separator. Splitting on
                 # it flagged this real grep as vacuous, which is the false positive a
                 # review caught after the pipe rule went in.
                 "grep -E 'failure|true condition' results.txt", "echo x | grep -q 'true'",
                 # An escaped quote inside double quotes does not close the span; missing
                 # that exposed the separators after it and flagged this real grep.
                 'grep -E "failure\\"|true condition" results.txt']
    fired = [c for c in vacuous_cmds
             if len(vacuous_oracle_warnings(_cmd_binder(c))) == 1
             and "vacuous" in vacuous_oracle_warnings(_cmd_binder(c))[0]]
    quiet = [c for c in real_cmds if vacuous_oracle_warnings(_cmd_binder(c)) == []]
    ok = (fired == vacuous_cmds and quiet == real_cmds
          and not validate_binder(_cmd_binder("true")))  # advisory: still a valid binder
    print(f"[{'PASS' if ok else 'FAIL'}] vacuous command warning fires on {fired} "
          f"and stays silent on {quiet}")
    failures += 0 if ok else 1

    # vacuous-oracle lint, part 2 — assertions with nothing runnable behind them. The negative
    # cases are the same assertions backed by a real command, and the same assertions under an
    # opt-out (an explicit, recorded escape is not a vacuous oracle).
    def _assert_binder(oracle):
        return {
            "slug": "vac2", "title": "T", "summary": "S", "motivation": "x",
            "scope": {"included": ["x"]},
            "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": oracle}],
        }
    bare_assertions = _assert_binder({"type": "unit", "assertions": ["the endpoint returns 200"]})
    backed_assertions = _assert_binder({"type": "unit", "command": "pytest -q",
                                        "assertions": ["the endpoint returns 200"]})
    opted_out = _assert_binder({"opt_out": True, "reason": "covered by the contract suite"})
    warns = vacuous_oracle_warnings(bare_assertions)
    ok = (len(warns) == 1 and "vacuous" in warns[0]
          and vacuous_oracle_warnings(backed_assertions) == []
          and vacuous_oracle_warnings(opted_out) == []
          and not validate_binder(bare_assertions))  # advisory: still a valid binder
    print(f"[{'PASS' if ok else 'FAIL'}] assertions with no command and no opt_out warn as "
          f"vacuous: {warns}")
    failures += 0 if ok else 1

    # clean-status lint (F39) — an oracle that asserts an empty `git status`, or an empty
    # diff against HEAD or the index, cannot pass for an item that changes a path the check
    # covers, because the oracle runs on the staged, uncommitted candidate. The cases come
    # from mc-server-admin's binders: `install-api` (packs-install-backend-r3) is the oracle
    # that halted; the authelia secret-file guard and the `frontend/src/api` status in
    # packs-upload-code and packs-install-screens-r2 are working checks a first version of
    # this lint flagged (review S1), so they are pinned quiet here.
    def _st_binder(command, touches=("frontend/src/api/generated/packs/", "backend/app.py")):
        b = _cmd_binder(command)
        if touches is not None:
            b["work_items"][0]["touches"] = list(touches)
        return b
    never_clean = [
        'npm --prefix frontend run generate:api && git diff --exit-code -- frontend/src/api'
        ' && test -z "$(git status --porcelain -- frontend/src/api)" && echo OK',
        '[ -z "$(git status --short)" ]',
        '[[ -z $(git status -s) ]]',
        'test -z "$(git -C frontend status --porcelain=v1)"',
        'git status --porcelain=v2 | wc -l | grep -qx 0',
        '! git status --porcelain | grep -q .',
        'test -z "`git status --porcelain`"',
        'test -z "$(cd frontend && git status --porcelain)"',
        'git status -sb | grep -q . && exit 1',
        # matcher variants (review M1)
        'test -z "$(git status --porcelain=1)"',
        'git status -z | wc -c | grep -qx 0',
        'test -z "$(git --no-pager status --porcelain)"',
        'test -z "$(git -c core.quotepath=off status -s)"',
        'test -z "$(git -C "a dir" status --porcelain)"',
        'git status | grep -q "nothing to commit"',
        "git status | grep -q 'working tree clean'",
        'git status --porcelain > s.txt && test ! -s s.txt',
        'diff <(git status --porcelain) /dev/null',
        "test $(git status --porcelain | grep -v '^??' | wc -l) -eq 0",
        'test -z "$(git -C backend status --porcelain -- app.py)"',
        # a diff against HEAD or the index fails on the item's own staged change (review S5)
        'git diff --exit-code HEAD',
        'git diff --quiet HEAD',
        'git diff --cached --exit-code',
        'git diff-index --quiet HEAD',
        'git diff --staged --quiet -- backend/app.py',
        'test -z "$(git diff --name-only HEAD)"',
    ]
    status_ok = ['git diff --exit-code -- frontend/src/api', 'pytest -q && git status --short',
                 "grep -q 'git status --porcelain' notes.md", 'test -z "$(git status)"',
                 'git status --porcelain-ish | wc -l',
                 # a pathspec outside the item's touches (packs-upload-code, packs-screens)
                 'git diff --exit-code -- frontend/src/api && test -z "$(git status --porcelain'
                 ' -- frontend/src/types)"',
                 'git diff --exit-code HEAD -- docs/other.md',
                 # a targeted grep over the status output: a secret-file guard (authelia)
                 "! git status --porcelain --untracked-files=all | grep -qE "
                 "'configuration\\.ya?ml|authelia-config|authelia-secrets'",
                 "test \"$(git status --porcelain | grep -c '^??')\" -eq 0",
                 'git status --porcelain >/dev/null', 'git diff --stat HEAD',
                 "git diff --cached --name-only | grep -qE '\\.env$' && exit 1"]
    st_fired = [c for c in never_clean
                if len(clean_status_oracle_warnings(_st_binder(c))) == 1
                and "staged" in clean_status_oracle_warnings(_st_binder(c))[0]
                and "leak guard" in clean_status_oracle_warnings(_st_binder(c))[0]]
    st_quiet = [c for c in status_ok if clean_status_oracle_warnings(_st_binder(c)) == []]
    # A pathspec on an item that declares no touches cannot be shown disjoint, so it warns.
    no_touches = clean_status_oracle_warnings(
        _st_binder('test -z "$(git status --porcelain -- frontend/src/types)"', touches=None))
    ok = (st_fired == never_clean and st_quiet == status_ok
          and len(no_touches) == 1 and "no touches" in no_touches[0]
          and not validate_binder(_st_binder(never_clean[0])))  # advisory: still valid
    print(f"[{'PASS' if ok else 'FAIL'}] clean git-status oracle warning fires on "
          f"{len(st_fired)}/{len(never_clean)} (missed "
          f"{[c for c in never_clean if c not in st_fired]}) and stays silent on "
          f"{len(st_quiet)}/{len(status_ok)} (fired on "
          f"{[c for c in status_ok if c not in st_quiet]}); no-touches: {no_touches}")
    failures += 0 if ok else 1

    # B1 — an item waits on a precondition and depends_on another item of the same binder,
    # so the probe runs at preflight before that item builds (packs-install-drill-r4: the
    # record item waits on live evidence and depends on the tools item that serves it).
    # Transitive edges count; a carried item was built in an earlier delivery and is quiet,
    # as is a binder-wide precondition no item names.
    def _b1_item(iid, **extra):
        return {"id": iid, "title": iid, "summary": "s", "oracle": _u} | extra
    b1 = _pc_binder([_pc], [_b1_item("tools"), _b1_item(
        "record", waits_on=["live-evidence"], depends_on=["tools"])])
    b1_deep = _pc_binder([_pc], [_b1_item("tools"), _b1_item("mid", depends_on=["tools"]),
                                 _b1_item("record", waits_on=["live-evidence"],
                                          depends_on=["mid"])])
    b1_carried = json.loads(json.dumps(b1)) | {"supersedes": {"slug": "pc-r1",
                                                              "carried": ["tools"]}}
    b1_wide = _pc_binder([_pc], [_b1_item("tools"), _b1_item("record", depends_on=["tools"])])
    w1, w1_deep = precondition_order_warnings(b1), precondition_order_warnings(b1_deep)
    ok = (len(w1) == 1 and all(s in w1[0] for s in ("record", "live-evidence", "tools", "after"))
          and len(w1_deep) == 1 and "mid" in w1_deep[0] and "tools" in w1_deep[0]
          and precondition_order_warnings(b1_carried) == []
          and precondition_order_warnings(b1_wide) == []
          and precondition_order_warnings(pc_ok) == []
          and not validate_binder(b1) and not validate_binder(b1_carried))  # advisory
    print(f"[{'PASS' if ok else 'FAIL'}] precondition-before-dependency warning (B1): "
          f"{w1} {w1_deep}")
    failures += 0 if ok else 1

    # B2 — a contract that names a precondition in prose, on an item with no `waits_on`. The
    # three shapes are the msa contracts the design cites: a string, an object key
    # (`install-job`) and a value inside a nested object.
    def _b2(contract, **extra):
        return _pc_binder([_pc], [_b1_item("a", contract=contract, **extra)])
    b2_fire = [_b2("Precondition: window-1 reads exist before the drill"),
               _b2({"precondition": "the C.4 owner answer is recorded"}),
               _b2({"windows": {"notes": ["No-push window (precondition, 23 h)"]}})]
    b2_quiet = [_b2("Precondition: window-1 reads exist", waits_on=["live-evidence"]),
                _b2("no prerequisites"), _b2("a nonprecondition word"), _b2(None),
                _pc_binder([_pc], [_b1_item("a", summary="precondition in the summary")]),
                {**_b2("Precondition: a carried item"), "supersedes": {"slug": "p", "carried": ["a"]}}]
    b2_warns = [undeclared_precondition_warnings(b) for b in b2_fire]
    ok = (all(len(w) == 1 and "declare it in `preconditions`" in w[0] for w in b2_warns)
          and all(undeclared_precondition_warnings(b) == [] for b in b2_quiet)
          and not any(validate_binder(b) for b in b2_fire))  # advisory
    print(f"[{'PASS' if ok else 'FAIL'}] undeclared-precondition warning (B2) fires on "
          f"{sum(len(w) for w in b2_warns)}/{len(b2_fire)}, quiet on "
          f"{sum(not undeclared_precondition_warnings(b) for b in b2_quiet)}/{len(b2_quiet)}")
    failures += 0 if ok else 1

    # waiver summary: one line per waiver stating reason + covered_by, one line per covering
    # item stating how many waivers it absorbs — the same surfacing opt_out_summary already gets.
    wsumm = waiver_summary(cov_base_good)
    ok = (any("checked by c" in l and "covered by c" in l for l in wsumm)
          and any("absorbs 1 waiver" in l for l in wsumm))
    print(f"[{'PASS' if ok else 'FAIL'}] waiver summary states reason, covered_by, and absorb count: {wsumm}")
    failures += 0 if ok else 1

    # design-source advisory: warns only when design_facts.source is set and no item anywhere
    # carries a visual oracle; silent once one does, and never changes the exit code.
    design_source_no_visual = _design_binder(
        "design-source-no-visual", [_design_item(design_reference="none")],
        design_facts={"source": "design.html", "stack": "x"})
    ok = (not validate_binder(design_source_no_visual)
          and len(design_source_advisory(design_source_no_visual)) == 1
          and len(design_source_advisory(valid)) == 0)  # 'valid' names a source AND has a visual item
    print(f"[{'PASS' if ok else 'FAIL'}] design-source advisory fires only with no visual oracle anywhere")
    failures += 0 if ok else 1

    # Both surfacing helpers are public and run after validation, so the two shapes below are
    # unreachable through this script's own CLI — the schema rejects a waiver with no
    # `covered_by` and a non-object `design_facts` first. They are here because a public
    # function another script can call must return where it used to raise, and each is paired
    # with the well-formed input it must keep handling identically.
    mixed_waivers = {"work_items": [
        {"id": "a", "visual_check_waiver": {"reason": "r", "covered_by": "c"}},
        {"id": "b", "visual_check_waiver": {"reason": "r"}},
    ]}
    ok = len(waiver_summary(mixed_waivers)) == 4 and len(waiver_summary(cov_base_good)) == 2
    print(f"[{'PASS' if ok else 'FAIL'}] waiver summary returns lines for a waiver with no covered_by")
    failures += 0 if ok else 1

    ok = (design_source_advisory({"design_facts": "docs/design.html", "work_items": []}) == []
          and len(design_source_advisory(design_source_no_visual)) == 1)
    print(f"[{'PASS' if ok else 'FAIL'}] design-source advisory returns for a non-object design_facts")
    failures += 0 if ok else 1

    # cyclic + design claim: the design: rule still reaches a cyclic binder in the same pass
    # (the coverage walk's own visited set terminates regardless of the cycle), so a graph:
    # cycle error and a design: error both come back together rather than one masking the other.
    cwd_errs = validate_binder(cyclic_with_design)
    ok = any("cycle" in e for e in cwd_errs) and any(e.startswith("design:") for e in cwd_errs)
    print(f"[{'PASS' if ok else 'FAIL'}] cyclic binder still surfaces the design: rule in the same pass: {cwd_errs}")
    failures += 0 if ok else 1

    # pre-rule consumer shape: every item draws the exact clause an operator is told to search
    # for — the same message the runbook's migration paragraph quotes.
    gr_errs = validate_binder(gringotts_shape)
    ok = (len(gr_errs) == 4
          and all("has no visual oracle and no visual_check_waiver" in e for e in gr_errs))
    print(f"[{'PASS' if ok else 'FAIL'}] pre-rule consumer fixture message matches the quoted clause: {gr_errs}")
    failures += 0 if ok else 1

    # cross-binder `after` graph (resolution + acyclicity)
    cb_new   = {"slug": "s-new",   "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
                "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}]}
    cb_edit  = {"slug": "s-edit",  "after": ["s-new"], "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
                "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}]}
    cb_del   = {"slug": "s-del",   "after": ["s-edit"], "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
                "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}]}
    cb_dangle = {"slug": "s-x",    "after": ["ghost"], "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
                 "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}]}
    cb_cyc_a = {"slug": "ca", "after": ["cb"], "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
                "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}]}
    cb_cyc_b = {"slug": "cb", "after": ["ca"], "title": "T", "summary": "S", "motivation": "x", "scope": {"included": ["x"]},
                "work_items": [{"id": "a", "title": "A", "summary": "s", "oracle": _u}]}

    cb_cases = [
        ("clean after-chain", [cb_new, cb_edit, cb_del], [], 0, frozenset()),   # no errors, no warnings
        ("dangling after-ref", [cb_dangle], [], 1, frozenset()),                # 1 warning, no error
        ("after cycle", [cb_cyc_a, cb_cyc_b], "cycle", 0, frozenset()),         # error present
        ("lone binder unchanged", [cb_new], [], 0, frozenset()),                # nothing flagged
        ("after -> archived slug is satisfied", [cb_dangle], [], 0,             # delivered predecessor
         frozenset({"ghost"})),
        ("live slug reusing an archived one warns", [cb_new], [], 1,            # shadowed history
         frozenset({"s-new"})),
    ]
    for name, binders, want_err, want_warn, archived in cb_cases:
        errs, warns = cross_binder_errors(binders, archived)
        if want_err == "cycle":
            ok = any("cycle" in e for e in errs)
        else:
            ok = (errs == []) and (len(warns) == want_warn)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: errors={errs} warnings={warns}")
        failures += 0 if ok else 1

    # covers naming nothing: not a bypass — a waiver is always resolved against the real item
    # it points at — but the schema calls these work-item ids, so a stale or mistyped one would
    # sit in the plan reading as coverage nobody agreed to. Paired with the same gate whose
    # covers resolves, which must stay valid.
    cov_ghost = _design_binder("cov-ghost", [
        _design_item(design_reference="panel", oracle=_v)])
    cov_ghost["work_items"][0]["covers"] = ["ghost"]
    cov_real = json.loads(json.dumps(cov_ghost))
    cov_real["slug"] = "cov-real"
    # the fixture item's own id, so the entry resolves
    cov_real["work_items"][0]["covers"] = [cov_real["work_items"][0]["id"]]
    errs_ghost = validate_binder(cov_ghost)
    ok = (any("covers unknown work item 'ghost'" in e for e in errs_ghost)
          and not validate_binder(cov_real))
    print(f"[{'PASS' if ok else 'FAIL'}] a covers entry naming no work item is reported, "
          f"and the same gate covering a real id is valid")
    failures += 0 if ok else 1

    print(f"\n{len(cases) + 14 + len(cb_cases) - failures}/{len(cases) + 14 + len(cb_cases)} checks passed")
    return 1 if failures else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--binder", type=Path)
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return _run_self_test()
    if not args.binder:
        ap.error("provide --binder <path> or --self-test")
    if not args.binder.is_file():
        archived_twin = args.binder.resolve().parent / "archive" / args.binder.name
        if archived_twin.is_file():
            print(f"INVALID: binder not found at {args.binder} — it was already delivered. "
                  f"hatch-deliver's end-of-life step archived it to {archived_twin}; "
                  "plan new work as a new binder with a fresh slug.")
        else:
            print(f"INVALID: binder file not found: {args.binder}")
        return 1
    binder = json.loads(args.binder.read_text(encoding="utf-8"))
    errs = validate_binder(binder)
    if errs:
        print("INVALID:")
        for e in errs:
            print(f"  - {e}")
        return 1
    summ = opt_out_summary(binder)
    waived = sum(1 for it in binder["work_items"]
                 if isinstance(it.get("visual_check_waiver"), dict))
    print(f"VALID. {len(binder['work_items'])} work items; {len(summ)} opted out of acceptance "
          f"checks; {waived} waived design checks.")
    for s in summ:
        print(f"  opt-out: {s}")
    for w in waiver_summary(binder):
        print(f"  waiver: {w}")
    for w in sme_warnings(binder):
        print(f"  warning: {w}")
    for w in shared_terms_warnings(binder):
        print(f"  warning: {w}")
    for w in vacuous_oracle_warnings(binder):
        print(f"  warning: {w}")
    for w in clean_status_oracle_warnings(binder):
        print(f"  warning: {w}")
    for w in precondition_order_warnings(binder):
        print(f"  warning: {w}")
    for w in undeclared_precondition_warnings(binder):
        print(f"  warning: {w}")
    for w in design_source_advisory(binder):
        print(f"  warning: {w}")
    # cross-binder `after` graph, when the binder is one of a set on disk — including
    # delivered (archived) slugs, so an `after` naming one reads satisfied and a slug
    # reuse draws its warning even for a lone live binder.
    if args.binder:
        siblings = []
        for p in sorted(args.binder.resolve().parent.glob("*.json")):
            try:
                doc = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(doc, dict) and "slug" in doc:
                    siblings.append(doc)
            except (OSError, json.JSONDecodeError):
                continue
        archived = set()
        archive_dir = args.binder.resolve().parent / "archive"
        if archive_dir.is_dir():
            for p in sorted(archive_dir.glob("*.json")):
                try:
                    doc = json.loads(p.read_text(encoding="utf-8"))
                    if isinstance(doc, dict) and isinstance(doc.get("slug"), str):
                        archived.add(doc["slug"])
                except (OSError, json.JSONDecodeError):
                    continue
        if len(siblings) > 1 or archived:
            cb_errs, cb_warns = cross_binder_errors(siblings, frozenset(archived))
            for w in cb_warns:
                print(f"  warning: {w}")
            if cb_errs:
                print("INVALID (cross-binder):")
                for e in cb_errs:
                    print(f"  - {e}")
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
