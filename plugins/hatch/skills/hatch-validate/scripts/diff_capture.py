#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""Structured Pass-1 diff of one hatch-validate capture artifact.

This is the executable form of hatch-validate's Pass 1 doctrine. It consumes ONE
capture artifact (the JSON `capture_view.py` writes, schema
`hatch.validate.capture.v1`), after validating each target's `hatch-render-health-v1`
record, and emits a bounded, deterministic discrepancy document. It never reads app
or design source, and it never reads the playwright-cli YAML snapshot sidecar — only
the already-parsed JSON artifact — so the same result is produced on every runtime.

Pairing is geometry-first: elements are paired within each role/category by bounding
box, using normalized text only as a secondary tie-breaker, so mock-data values (dates,
names, counts) can never drive pairing. Tokens and computed styles are compared exactly;
missing and extra elements are reported; measured position/size and sibling-gap
discrepancies use the doctrine's current thresholds. Every candidate cites the exact
source evidence and the stable element identity used to derive it.

Fail closed: a malformed artifact, an auth-degraded app target, or a `blocked` render
(the page never really rendered) yields a `blocked` document and a non-zero exit — never
a silent clean diff. A `degraded` render still compares; its health finding is surfaced
ahead of the relative diff.

Usage:
  uv run --script diff_capture.py --capture <artifact.json> [--out <diff.json>]
  uv run --script diff_capture.py --self-test    # embedded + fixture drills, exit 0/1
"""
from __future__ import annotations

import argparse
import builtins
import json
import sys
from pathlib import Path
from typing import Any


STRUCTURED_DIFF_SCHEMA = "hatch-structured-diff-v1"
# The render-health schema this diff validates before comparing. Pinned identically to
# capture_view.py's producer (binder shared_terms: capture-health-schema).
RENDER_HEALTH_SCHEMA = "hatch-render-health-v1"
RENDER_HEALTH_KEYS = frozenset(
    {
        "schema",
        "result",
        "readySelector",
        "visibleTextChars",
        "visibleLeafElements",
        "styledElementCount",
        "consoleErrorCount",
        "failedRequestCount",
        "consoleErrors",
        "failedRequests",
    }
)
RENDER_HEALTH_RESULTS = frozenset({"healthy", "degraded", "blocked"})

# Doctrine thresholds — the same numbers hatch-validate's Pass 1 prose states. These are
# fixed package doctrine; the Pi action exposes no way for a caller to supply thresholds.
POSITION_THRESHOLD_PX = 20  # element position/size difference flagged over ~20px
SIBLING_GAP_THRESHOLD_PX = 8  # adjacent-sibling edge-to-edge gap difference over ~8px
# Beyond this pairing cost (center + size Manhattan distance) two elements are treated
# as different elements — reported as missing/extra rather than force-paired.
PAIR_MATCH_CEILING = 400

# Comparable categories, and the extracted_data key each is collected under.
CATEGORY_KEYS = (("heading", "headings"), ("button", "buttons"), ("landmark", "landmarks"))

STYLE_DIMENSION = {
    "fontSize": "typography",
    "fontWeight": "typography",
    "fontFamily": "typography",
    "color": "colors",
    "backgroundColor": "colors",
    "padding": "spacing",
    "borderRadius": "spacing",
}
STYLE_PROPS = tuple(STYLE_DIMENSION)
BOX_AXES = ("x", "y", "width", "height")


class CaptureError(Exception):
    """A fail-closed condition: the artifact cannot be trusted to produce a diff."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


def _norm_text(el: dict[str, Any]) -> str:
    return " ".join(str(el.get("text") or "").split()).lower()


def _box(el: dict[str, Any]) -> dict[str, float]:
    box = el.get("box")
    if not isinstance(box, dict):
        raise CaptureError("malformed-capture", f"element {el.get('identity')!r} has no box")
    out: dict[str, float] = {}
    for axis in BOX_AXES:
        try:
            out[axis] = float(box[axis])
        except (KeyError, TypeError, ValueError) as exc:
            raise CaptureError(
                "malformed-capture", f"element {el.get('identity')!r} box.{axis} is not numeric"
            ) from exc
    return out


def _center(box: dict[str, float]) -> tuple[float, float]:
    return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2


def _pair_cost(d_box: dict[str, float], a_box: dict[str, float]) -> float:
    """Geometry-first cost: center Manhattan distance plus size delta. Translation shows
    up as center distance; a genuinely different-sized element shows up as size delta."""
    dcx, dcy = _center(d_box)
    acx, acy = _center(a_box)
    return (
        abs(dcx - acx)
        + abs(dcy - acy)
        + abs(d_box["width"] - a_box["width"])
        + abs(d_box["height"] - a_box["height"])
    )


def _sibling_gap(b1: dict[str, float], b2: dict[str, float]) -> float:
    """Edge-to-edge gap between two boxes along their dominant separation axis."""
    c1x, c1y = _center(b1)
    c2x, c2y = _center(b2)
    if abs(c2x - c1x) >= abs(c2y - c1y):
        left, right = (b1, b2) if b1["x"] <= b2["x"] else (b2, b1)
        return round(right["x"] - (left["x"] + left["width"]), 3)
    top, bottom = (b1, b2) if b1["y"] <= b2["y"] else (b2, b1)
    return round(bottom["y"] - (top["y"] + top["height"]), 3)


def _reading_order(items: list[dict[str, Any]]) -> list[int]:
    """Stable reading-order indices (top-to-bottom, left-to-right, identity tie-break)."""
    order = list(range(len(items)))
    order.sort(
        key=lambda i: (
            _box(items[i])["y"],
            _box(items[i])["x"],
            _norm_text(items[i]),
            str(items[i].get("identity")),
        )
    )
    return order


def pair_category(
    design_items: list[dict[str, Any]], app_items: list[dict[str, Any]]
) -> tuple[list[tuple[int, int]], list[int], list[int]]:
    """Geometry-first greedy pairing within one category.

    All candidate (design, app) pairs within the match ceiling are sorted by cost, then
    by a text-match tie-breaker, then by stable identity, and assigned greedily. Text is
    never primary, so mock-data values cannot drive pairing; sorting is fully determined,
    so repeated runs pair identically. Unpaired design elements are 'missing', unpaired
    app elements are 'extra'."""
    candidates: list[tuple[float, int, str, str, int, int]] = []
    for di, d in enumerate(design_items):
        d_box = _box(d)
        d_text = _norm_text(d)
        for ai, a in enumerate(app_items):
            cost = _pair_cost(d_box, _box(a))
            if cost > PAIR_MATCH_CEILING:
                continue
            text_mismatch = 0 if d_text == _norm_text(a) else 1
            candidates.append(
                (cost, text_mismatch, str(d.get("identity")), str(a.get("identity")), di, ai)
            )
    candidates.sort()
    used_d: set[int] = set()
    used_a: set[int] = set()
    pairs: list[tuple[int, int]] = []
    for _cost, _tm, _did, _aid, di, ai in candidates:
        if di in used_d or ai in used_a:
            continue
        used_d.add(di)
        used_a.add(ai)
        pairs.append((di, ai))
    pairs.sort()
    missing = [di for di in range(len(design_items)) if di not in used_d]
    extra = [ai for ai in range(len(app_items)) if ai not in used_a]
    return pairs, missing, extra


def _validate_render_health(target: dict[str, Any], name: str) -> dict[str, Any]:
    rh = target.get("render_health")
    if not isinstance(rh, dict):
        raise CaptureError("malformed-capture", f"{name}.render_health is missing")
    if set(rh.keys()) != set(RENDER_HEALTH_KEYS):
        raise CaptureError("malformed-capture", f"{name}.render_health key set is not {RENDER_HEALTH_SCHEMA}")
    if rh.get("schema") != RENDER_HEALTH_SCHEMA:
        raise CaptureError("malformed-capture", f"{name}.render_health schema is not {RENDER_HEALTH_SCHEMA}")
    if rh.get("result") not in RENDER_HEALTH_RESULTS:
        raise CaptureError("malformed-capture", f"{name}.render_health result is not a health verdict")
    return rh


def _health_summary(rh: dict[str, Any]) -> dict[str, Any]:
    return {
        "result": rh["result"],
        "readySelector": rh["readySelector"],
        "consoleErrorCount": rh["consoleErrorCount"],
        "failedRequestCount": rh["failedRequestCount"],
    }


def _elements(target: dict[str, Any], key: str, name: str) -> list[dict[str, Any]]:
    data = target.get("extracted_data")
    if not isinstance(data, dict):
        raise CaptureError("malformed-capture", f"{name}.extracted_data is not a structured record")
    items = data.get(key, [])
    if not isinstance(items, list):
        raise CaptureError("malformed-capture", f"{name}.extracted_data.{key} is not a list")
    for el in items:
        if not isinstance(el, dict) or "identity" not in el:
            raise CaptureError("malformed-capture", f"{name}.extracted_data.{key} has an element without identity")
    return items


def _tokens(target: dict[str, Any], name: str) -> dict[str, Any]:
    data = target.get("extracted_data")
    tokens = data.get("tokens", {}) if isinstance(data, dict) else {}
    if not isinstance(tokens, dict):
        raise CaptureError("malformed-capture", f"{name}.extracted_data.tokens is not a map")
    return tokens


def _style_discrepancies(d: dict[str, Any], a: dict[str, Any], category: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    d_styles = d.get("styles") or {}
    a_styles = a.get("styles") or {}
    for prop in STYLE_PROPS:
        d_val = d_styles.get(prop)
        a_val = a_styles.get(prop)
        if d_val == a_val:
            continue
        out.append(
            {
                "dimension": STYLE_DIMENSION[prop],
                "category": category,
                "property": prop,
                "evidence": "computed-style",
                "designIdentity": str(d.get("identity")),
                "appIdentity": str(a.get("identity")),
                "design": d_val,
                "app": a_val,
            }
        )
    return out


def _geometry_discrepancies(d: dict[str, Any], a: dict[str, Any], category: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    d_box = _box(d)
    a_box = _box(a)
    for axis in BOX_AXES:
        delta = round(a_box[axis] - d_box[axis], 3)
        if abs(delta) <= POSITION_THRESHOLD_PX:
            continue
        out.append(
            {
                "dimension": "layout",
                "category": category,
                "property": f"box.{axis}",
                "evidence": "bounding-box",
                "designIdentity": str(d.get("identity")),
                "appIdentity": str(a.get("identity")),
                "design": d_box[axis],
                "app": a_box[axis],
                "delta": delta,
            }
        )
    return out


def _sibling_gap_discrepancies(
    design_items: list[dict[str, Any]],
    app_items: list[dict[str, Any]],
    pairs: list[tuple[int, int]],
    category: str,
) -> list[dict[str, Any]]:
    """Compare edge-to-edge gaps between adjacent design siblings against the gap between
    the app elements they paired to. Only matched adjacent pairs are compared, so a
    missing element never masquerades as a spacing change."""
    d_to_a = dict(pairs)
    ordered = [di for di in _reading_order(design_items) if di in d_to_a]
    out: list[dict[str, Any]] = []
    for prev_di, next_di in zip(ordered, ordered[1:]):
        d_gap = _sibling_gap(_box(design_items[prev_di]), _box(design_items[next_di]))
        a_prev = app_items[d_to_a[prev_di]]
        a_next = app_items[d_to_a[next_di]]
        a_gap = _sibling_gap(_box(a_prev), _box(a_next))
        delta = round(a_gap - d_gap, 3)
        if abs(delta) <= SIBLING_GAP_THRESHOLD_PX:
            continue
        out.append(
            {
                "dimension": "spacing",
                "category": category,
                "property": "sibling-gap",
                "evidence": "sibling-gap",
                "designIdentity": f"{design_items[prev_di].get('identity')} -> {design_items[next_di].get('identity')}",
                "appIdentity": f"{a_prev.get('identity')} -> {a_next.get('identity')}",
                "design": d_gap,
                "app": a_gap,
                "delta": delta,
            }
        )
    return out


def _element_stub(el: dict[str, Any], category: str, evidence: str) -> dict[str, Any]:
    return {
        "identity": str(el.get("identity")),
        "category": category,
        "role": el.get("role"),
        "text": el.get("text"),
        "box": _box(el),
        "evidence": evidence,
    }


def _token_drift(design_tokens: dict[str, Any], app_tokens: dict[str, Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for token in sorted(set(design_tokens) | set(app_tokens)):
        d_val = design_tokens.get(token)
        a_val = app_tokens.get(token)
        if token in design_tokens and token in app_tokens and d_val == a_val:
            continue
        out.append(
            {
                "token": token,
                "evidence": "token",
                "design": d_val if token in design_tokens else None,
                "app": a_val if token in app_tokens else None,
            }
        )
    return out


def _discrepancy_sort_key(item: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(item.get("category")),
        str(item.get("property")),
        str(item.get("designIdentity")),
        str(item.get("appIdentity")),
    )


def build_diff(artifact: Any) -> dict[str, Any]:
    """Pure structured diff. Does no file I/O — it only reads the already-parsed
    artifact, which is how the diff is guaranteed to never touch the YAML sidecar."""
    if not isinstance(artifact, dict):
        raise CaptureError("malformed-capture", "capture artifact is not a JSON object")
    design = artifact.get("design")
    app = artifact.get("app")
    if not isinstance(design, dict) or not isinstance(app, dict):
        raise CaptureError("malformed-capture", "capture artifact is missing a design or app target")

    # Auth gate first — a login screen is not the target view, so render_health is null.
    if artifact.get("APP_HEALTH") == "DEGRADED_AUTH" or artifact.get("compare_ready") is False:
        raise CaptureError(
            "auth-degraded",
            "app target did not reach the requested view (authentication screen); nothing to compare",
        )

    design_rh = _validate_render_health(design, "design")
    app_rh = _validate_render_health(app, "app")
    for rh, name in ((design_rh, "design"), (app_rh, "app")):
        if rh["result"] == "blocked":
            raise CaptureError("render-blocked", f"{name} render health is blocked — the page never rendered")

    discrepancies: list[dict[str, Any]] = []
    missing_elements: list[dict[str, Any]] = []
    extra_elements: list[dict[str, Any]] = []
    for category, key in CATEGORY_KEYS:
        design_items = _elements(design, key, "design")
        app_items = _elements(app, key, "app")
        pairs, missing, extra = pair_category(design_items, app_items)
        for di, ai in pairs:
            discrepancies.extend(_style_discrepancies(design_items[di], app_items[ai], category))
            discrepancies.extend(_geometry_discrepancies(design_items[di], app_items[ai], category))
        discrepancies.extend(_sibling_gap_discrepancies(design_items, app_items, pairs, category))
        missing_elements.extend(_element_stub(design_items[di], category, "design-only") for di in missing)
        extra_elements.extend(_element_stub(app_items[ai], category, "app-only") for ai in extra)

    token_drift = _token_drift(_tokens(design, "design"), _tokens(app, "app"))
    discrepancies.sort(key=_discrepancy_sort_key)
    missing_elements.sort(key=lambda e: (e["category"], e["identity"]))
    extra_elements.sort(key=lambda e: (e["category"], e["identity"]))

    by_dimension: dict[str, int] = {}
    for item in discrepancies:
        by_dimension[item["dimension"]] = by_dimension.get(item["dimension"], 0) + 1

    return {
        "schema": STRUCTURED_DIFF_SCHEMA,
        "status": "ok",
        "blockedReason": None,
        "renderHealth": {"design": _health_summary(design_rh), "app": _health_summary(app_rh)},
        "summary": {
            "discrepancyCount": len(discrepancies),
            "tokenDriftCount": len(token_drift),
            "missingCount": len(missing_elements),
            "extraCount": len(extra_elements),
            "byDimension": dict(sorted(by_dimension.items())),
        },
        "discrepancies": discrepancies,
        "tokenDrift": token_drift,
        "missingElements": missing_elements,
        "extraElements": extra_elements,
    }


def blocked_document(reason: str, detail: str) -> dict[str, Any]:
    return {
        "schema": STRUCTURED_DIFF_SCHEMA,
        "status": "blocked",
        "blockedReason": reason,
        "detail": detail,
        "renderHealth": None,
        "summary": {
            "discrepancyCount": 0,
            "tokenDriftCount": 0,
            "missingCount": 0,
            "extraCount": 0,
            "byDimension": {},
        },
        "discrepancies": [],
        "tokenDrift": [],
        "missingElements": [],
        "extraElements": [],
    }


def diff_capture_file(capture_path: Path) -> tuple[dict[str, Any], int]:
    """Read one capture artifact and produce (document, exit_code). Exit code is 0 for a
    produced diff and 1 for any fail-closed condition."""
    try:
        raw = capture_path.read_text(encoding="utf-8")
    except OSError as exc:
        return blocked_document("malformed-capture", f"cannot read capture artifact: {exc}"), 1
    try:
        artifact = json.loads(raw)
    except json.JSONDecodeError as exc:
        return blocked_document("malformed-capture", f"capture artifact is not valid JSON: {exc}"), 1
    try:
        return build_diff(artifact), 0
    except CaptureError as exc:
        return blocked_document(exc.reason, exc.detail), 1


# --------------------------------------------------------------------------- self-test

def _mk_el(identity: str, category: str, box: dict[str, float], text: str = "", **styles: str) -> dict[str, Any]:
    base_styles = {
        "fontSize": "16px",
        "fontWeight": "400",
        "color": "rgb(17, 24, 39)",
        "backgroundColor": "rgba(0, 0, 0, 0)",
        "borderRadius": "0px",
        "padding": "0px",
        "fontFamily": "Inter, system-ui, sans-serif",
    }
    base_styles.update(styles)
    return {
        "identity": identity,
        "category": category,
        "role": category,
        "text": text,
        "parentIdentity": "div#root:nth-child(1)",
        "siblingOrder": 0,
        "styles": base_styles,
        "box": dict(box),
    }


def _rh(result: str = "healthy", *, console: int = 0, requests: int = 0) -> dict[str, Any]:
    return {
        "schema": RENDER_HEALTH_SCHEMA,
        "result": result,
        "readySelector": "main",
        "visibleTextChars": 400,
        "visibleLeafElements": 40,
        "styledElementCount": 30,
        "consoleErrorCount": console,
        "failedRequestCount": requests,
        "consoleErrors": ["boom"] * console,
        "failedRequests": ["404 stylesheet /x.css"] * requests,
    }


def _artifact(design_data: dict[str, Any], app_data: dict[str, Any], **overrides: Any) -> dict[str, Any]:
    art = {
        "schema": "hatch.validate.capture.v1",
        "design": {
            "extracted_data": design_data,
            "dom_snapshot": ".hatch-validate/design-snapshot.yaml",
            "render_health": _rh(),
            "console_errors": "",
            "requests": "",
        },
        "app": {
            "extracted_data": app_data,
            "dom_snapshot": ".hatch-validate/app-snapshot.yaml",
            "render_health": _rh(),
            "console_errors": "",
            "requests": "",
        },
        "APP_HEALTH": "OK",
        "compare_ready": True,
    }
    for key, value in overrides.items():
        art[key] = value
    return art


def _empty_data(**tokens: str) -> dict[str, Any]:
    return {"tokens": dict(tokens), "headings": [], "buttons": [], "landmarks": []}


def _check(results: list[tuple[bool, str]], ok: bool, label: str) -> None:
    results.append((ok, label))


def self_test() -> int:
    results: list[tuple[bool, str]] = []

    # --- identical captures produce no discrepancies -----------------------------------
    h = _mk_el("h1#title", "heading", {"x": 24, "y": 24, "width": 320, "height": 36}, "Team dashboard")
    b = _mk_el("button.btn:nth-child(2)", "button", {"x": 880, "y": 24, "width": 132, "height": 40}, "New project")
    data = {"tokens": {"--color-primary": "#2563eb"}, "headings": [h], "buttons": [b], "landmarks": []}
    identical = build_diff(_artifact(json.loads(json.dumps(data)), json.loads(json.dumps(data))))
    _check(results, identical["status"] == "ok", "identical: status ok")
    _check(
        results,
        identical["summary"]["discrepancyCount"] == 0
        and identical["summary"]["tokenDriftCount"] == 0
        and identical["summary"]["missingCount"] == 0
        and identical["summary"]["extraCount"] == 0,
        "identical: no discrepancies",
    )

    # --- fail closed: malformed, blocked render, auth-degraded -------------------------
    def blocked(artifact: Any) -> dict[str, Any]:
        try:
            build_diff(artifact)
        except CaptureError as exc:
            return {"reason": exc.reason}
        return {"reason": None}

    _check(results, blocked("not-a-dict")["reason"] == "malformed-capture", "fail closed: non-dict artifact")
    _check(results, blocked({"design": {}, "app": {}})["reason"] == "malformed-capture", "fail closed: no render_health")
    bad_rh = _artifact(_empty_data(), _empty_data())
    bad_rh["app"]["render_health"] = {"schema": "wrong", "result": "healthy"}
    _check(results, blocked(bad_rh)["reason"] == "malformed-capture", "fail closed: wrong health schema")
    blocked_render = _artifact(_empty_data(), _empty_data())
    blocked_render["app"]["render_health"] = _rh("blocked")
    _check(results, blocked(blocked_render)["reason"] == "render-blocked", "fail closed: blocked render")
    auth = _artifact(_empty_data(), _empty_data(), APP_HEALTH="DEGRADED_AUTH", compare_ready=False)
    auth["app"]["render_health"] = None
    _check(results, blocked(auth)["reason"] == "auth-degraded", "fail closed: auth-degraded")

    # --- the diff never touches the filesystem (never reads the YAML sidecar) ----------
    real_open = builtins.open
    opened: list[str] = []

    def guard_open(file: Any, *a: Any, **k: Any):  # pragma: no cover - exercised below
        opened.append(str(file))
        raise AssertionError(f"build_diff opened a file: {file}")

    builtins.open = guard_open  # type: ignore[assignment]
    try:
        build_diff(_artifact(json.loads(json.dumps(data)), json.loads(json.dumps(data))))
    finally:
        builtins.open = real_open
    _check(results, not opened, "no-sidecar: build_diff does zero file I/O")

    # --- token drift -------------------------------------------------------------------
    tok = build_diff(
        _artifact(_empty_data(**{"--color-primary": "#2563eb", "--radius": "8px"}), _empty_data(**{"--color-primary": "#1d4ed8"}))
    )
    _check(results, tok["summary"]["tokenDriftCount"] == 2, "token: two drifts (changed + missing)")
    drift = {d["token"]: d for d in tok["tokenDrift"]}
    _check(
        results,
        drift["--color-primary"]["design"] == "#2563eb"
        and drift["--color-primary"]["app"] == "#1d4ed8"
        and drift["--radius"]["app"] is None
        and all(d["evidence"] == "token" for d in tok["tokenDrift"]),
        "token: evidence-cited values",
    )

    # --- computed-style discrepancy ----------------------------------------------------
    d_style = _mk_el("h1#title", "heading", {"x": 24, "y": 24, "width": 320, "height": 36}, "Title", color="rgb(17, 24, 39)")
    a_style = _mk_el("h1#title", "heading", {"x": 24, "y": 24, "width": 320, "height": 36}, "Title", color="rgb(220, 38, 38)")
    style_diff = build_diff(
        _artifact({"tokens": {}, "headings": [d_style], "buttons": [], "landmarks": []},
                  {"tokens": {}, "headings": [a_style], "buttons": [], "landmarks": []})
    )
    color_finds = [x for x in style_diff["discrepancies"] if x["property"] == "color"]
    _check(
        results,
        len(color_finds) == 1
        and color_finds[0]["evidence"] == "computed-style"
        and color_finds[0]["designIdentity"] == "h1#title"
        and color_finds[0]["design"] == "rgb(17, 24, 39)"
        and color_finds[0]["app"] == "rgb(220, 38, 38)",
        "computed-style: evidence-cited color drift on the right identity",
    )

    # --- missing / extra elements ------------------------------------------------------
    d_me = {"tokens": {}, "headings": [h], "buttons": [b], "landmarks": []}
    extra_btn = _mk_el("button.ghost:nth-child(3)", "button", {"x": 1040, "y": 24, "width": 90, "height": 40}, "Export")
    a_me = {"tokens": {}, "headings": [], "buttons": [b, extra_btn], "landmarks": []}
    me = build_diff(_artifact(d_me, a_me))
    _check(
        results,
        me["summary"]["missingCount"] == 1
        and me["missingElements"][0]["identity"] == "h1#title"
        and me["missingElements"][0]["evidence"] == "design-only",
        "missing: design-only heading reported with identity",
    )
    _check(
        results,
        me["summary"]["extraCount"] == 1
        and me["extraElements"][0]["identity"] == "button.ghost:nth-child(3)"
        and me["extraElements"][0]["evidence"] == "app-only",
        "extra: app-only button reported with identity",
    )

    # --- geometry discrepancy over 20px, but 20px exactly is within tolerance ----------
    d_geo = _mk_el("main#content", "landmark", {"x": 0, "y": 64, "width": 1440, "height": 800}, "Body")
    a_geo = _mk_el("main#content", "landmark", {"x": 0, "y": 96, "width": 1440, "height": 800}, "Body")
    geo = build_diff(_artifact({"tokens": {}, "headings": [], "buttons": [], "landmarks": [d_geo]},
                               {"tokens": {}, "headings": [], "buttons": [], "landmarks": [a_geo]}))
    y_finds = [x for x in geo["discrepancies"] if x["property"] == "box.y"]
    _check(
        results,
        len(y_finds) == 1 and y_finds[0]["evidence"] == "bounding-box" and y_finds[0]["delta"] == 32,
        "geometry: 32px y shift flagged with delta",
    )
    a_edge = _mk_el("main#content", "landmark", {"x": 0, "y": 84, "width": 1440, "height": 800}, "Body")
    edge = build_diff(_artifact({"tokens": {}, "headings": [], "buttons": [], "landmarks": [d_geo]},
                                {"tokens": {}, "headings": [], "buttons": [], "landmarks": [a_edge]}))
    _check(results, not [x for x in edge["discrepancies"] if x["property"].startswith("box.")], "geometry: exactly 20px is within tolerance")

    # --- sibling-gap discrepancy over 8px ----------------------------------------------
    d1 = _mk_el("button.a:nth-child(1)", "button", {"x": 24, "y": 24, "width": 100, "height": 40}, "One")
    d2 = _mk_el("button.b:nth-child(2)", "button", {"x": 144, "y": 24, "width": 100, "height": 40}, "Two")
    a1 = _mk_el("button.a:nth-child(1)", "button", {"x": 24, "y": 24, "width": 100, "height": 40}, "One")
    a2 = _mk_el("button.b:nth-child(2)", "button", {"x": 164, "y": 24, "width": 100, "height": 40}, "Two")
    gap = build_diff(_artifact({"tokens": {}, "headings": [], "buttons": [d1, d2], "landmarks": []},
                               {"tokens": {}, "headings": [], "buttons": [a1, a2], "landmarks": []}))
    gap_finds = [x for x in gap["discrepancies"] if x["property"] == "sibling-gap"]
    _check(
        results,
        len(gap_finds) == 1
        and gap_finds[0]["design"] == 20
        and gap_finds[0]["app"] == 40
        and gap_finds[0]["delta"] == 20
        and "->" in gap_finds[0]["designIdentity"],
        "sibling-gap: 20px gap widening flagged, citing both siblings",
    )

    # --- geometry-first pairing: duplicate role, mock value, reordering, uniform offset -
    # Two same-role headings; app arrays reversed and mock text swapped. Geometry must
    # pair each to its positional counterpart, so the color drift lands on the top one.
    top = _mk_el("h2.card:nth-child(1)", "heading", {"x": 24, "y": 24, "width": 200, "height": 28}, "Jan 3", color="rgb(1, 1, 1)")
    bottom = _mk_el("h2.card:nth-child(2)", "heading", {"x": 24, "y": 120, "width": 200, "height": 28}, "Feb 9", color="rgb(2, 2, 2)")
    app_top = _mk_el("h2.card:nth-child(1)", "heading", {"x": 24, "y": 24, "width": 200, "height": 28}, "Sep 8", color="rgb(9, 9, 9)")
    app_bottom = _mk_el("h2.card:nth-child(2)", "heading", {"x": 24, "y": 120, "width": 200, "height": 28}, "Aug 1", color="rgb(2, 2, 2)")
    dup = build_diff(
        _artifact({"tokens": {}, "headings": [top, bottom], "buttons": [], "landmarks": []},
                  {"tokens": {}, "headings": [app_bottom, app_top], "buttons": [], "landmarks": []})  # reordered
    )
    dup_colors = [x for x in dup["discrepancies"] if x["property"] == "color"]
    _check(
        results,
        dup["summary"]["missingCount"] == 0 and dup["summary"]["extraCount"] == 0,
        "duplicate-role: geometry pairs both despite reordering (no missing/extra)",
    )
    _check(
        results,
        len(dup_colors) == 1
        and dup_colors[0]["design"] == "rgb(1, 1, 1)"
        and dup_colors[0]["app"] == "rgb(9, 9, 9)",
        "duplicate-role: style-to-box linkage holds (top element's color, not the sibling's)",
    )

    # Mock-value-only difference: identical geometry and styles, different text → clean.
    mock_d = _mk_el("span#count", "landmark", {"x": 10, "y": 10, "width": 80, "height": 20}, "1,204 users")
    mock_a = _mk_el("span#count", "landmark", {"x": 10, "y": 10, "width": 80, "height": 20}, "37 users")
    mock = build_diff(_artifact({"tokens": {}, "headings": [], "buttons": [], "landmarks": [mock_d]},
                                {"tokens": {}, "headings": [], "buttons": [], "landmarks": [mock_a]}))
    _check(results, mock["summary"]["discrepancyCount"] == 0, "mock-value: text-only difference is never a discrepancy")

    # Uniform layout offset: every app element shifted +40/+40. Pairing stays stable, and
    # the offset is reported (not hidden), never collapsing into missing/extra.
    o1 = _mk_el("button.a:nth-child(1)", "button", {"x": 24, "y": 24, "width": 100, "height": 40}, "One")
    o2 = _mk_el("button.b:nth-child(2)", "button", {"x": 24, "y": 200, "width": 100, "height": 40}, "Two")
    off = build_diff(
        _artifact({"tokens": {}, "headings": [], "buttons": [o1, o2], "landmarks": []},
                  {"tokens": {}, "headings": [],
                   "buttons": [_shift(o1, 40, 40), _shift(o2, 40, 40)], "landmarks": []})
    )
    _check(results, off["summary"]["missingCount"] == 0 and off["summary"]["extraCount"] == 0, "uniform-offset: pairing stays stable")
    off_axes = {x["property"] for x in off["discrepancies"]}
    _check(results, {"box.x", "box.y"} <= off_axes, "uniform-offset: the offset is reported, not hidden")
    _check(
        results,
        not [x for x in off["discrepancies"] if x["property"] == "sibling-gap"],
        "uniform-offset: relative sibling gaps unchanged",
    )

    # --- determinism: repeated runs over one artifact are byte-identical ---------------
    once = build_diff(_artifact(json.loads(json.dumps(d_me)), json.loads(json.dumps(a_me))))
    twice = build_diff(_artifact(json.loads(json.dumps(d_me)), json.loads(json.dumps(a_me))))
    _check(results, json.dumps(once, sort_keys=True) == json.dumps(twice, sort_keys=True), "determinism: repeated runs are identical")

    # --- bind against the shipped diff fixtures on disk, if present --------------------
    fixtures_dir = _find_fixtures_dir()
    if fixtures_dir is None:
        _check(results, True, "fixtures: none on disk (installed skill) — inline drills are authoritative")
    else:
        verified = 0
        for fixture in sorted(fixtures_dir.glob("diff-*.json")):
            spec = json.loads(fixture.read_text(encoding="utf-8"))
            artifact = spec["capture"]
            try:
                produced = build_diff(artifact)
                actual = {"status": produced["status"], "blockedReason": produced.get("blockedReason")}
            except CaptureError as exc:
                produced = None
                actual = {"status": "blocked", "blockedReason": exc.reason}
            expect = spec["expect"]
            ok = actual["status"] == expect["status"] and actual.get("blockedReason") == expect.get("blockedReason")
            if produced is not None:
                for field in ("discrepancyCount", "tokenDriftCount", "missingCount", "extraCount"):
                    if field in expect:
                        ok = ok and produced["summary"][field] == expect[field]
                # Determinism per fixture: element identities are stable across runs.
                again = build_diff(json.loads(json.dumps(artifact)))
                ids_once = [d.get("designIdentity") for d in produced["discrepancies"]]
                ids_again = [d.get("designIdentity") for d in again["discrepancies"]]
                ok = ok and ids_once == ids_again
            _check(results, ok, f"fixture {fixture.name}: {expect}")
            verified += 1
        _check(results, verified > 0, "fixtures: at least one diff-*.json exercised")

    failed = [label for ok, label in results if not ok]
    for ok, label in results:
        print(f"[{'PASS' if ok else 'FAIL'}] {label}")
    if failed:
        print(f"diff_capture self-test: {len(failed)} FAILED of {len(results)}")
        return 1
    print(f"diff_capture self-test passed ({len(results)} checks)")
    return 0


def _shift(el: dict[str, Any], dx: float, dy: float) -> dict[str, Any]:
    moved = json.loads(json.dumps(el))
    moved["box"]["x"] += dx
    moved["box"]["y"] += dy
    return moved


def _find_fixtures_dir() -> Path | None:
    """Walk up to the repo's visual-capture fixtures. Present in-repo (canonical and both
    mirrors live inside it); absent in an installed consumer skill, where the inline
    drills above are the authoritative self-test."""
    here = Path(__file__).resolve()
    for parent in (here.parent, *here.parents):
        candidate = parent / "tests" / "pi" / "fixtures" / "visual-captures"
        if candidate.is_dir():
            return candidate
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description="Structured Pass-1 diff of one capture artifact.")
    parser.add_argument("--capture", help="path to a hatch-validate capture artifact (JSON)")
    parser.add_argument("--out", help="write the diff document here instead of stdout")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        raise SystemExit(self_test())
    if not args.capture:
        parser.error("--capture <artifact.json> is required unless --self-test is used")

    document, code = diff_capture_file(Path(args.capture).expanduser())
    payload = json.dumps(document, indent=2)
    if args.out:
        out_path = Path(args.out).expanduser()
        out_path.write_text(payload, encoding="utf-8")
        print(json.dumps({
            "diff": str(out_path),
            "status": document["status"],
            "blockedReason": document["blockedReason"],
            "discrepancyCount": document["summary"]["discrepancyCount"],
        }))
    else:
        print(payload)
    raise SystemExit(code)


if __name__ == "__main__":
    main()
