#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


STYLE_JS = r"""(() => {
  const cs = getComputedStyle(document.documentElement);
  const tokens = {};
  Array.from(cs).filter(p => p.startsWith('--')).forEach(p => tokens[p] = cs.getPropertyValue(p).trim());
  const compact = text => (text || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const identity = el => {
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${el.id}`;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const parent = el.parentElement;
    const nth = parent ? Array.prototype.indexOf.call(parent.children, el) + 1 : 1;
    return `${tag}${cls.length ? '.' + cls.join('.') : ''}:nth-child(${nth})`;
  };
  const siblingOrder = el => {
    const parent = el.parentElement;
    return parent ? Array.prototype.indexOf.call(parent.children, el) : 0;
  };
  const record = (el, category) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      identity: identity(el),
      category,
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      text: compact(el.textContent),
      parentIdentity: identity(el.parentElement),
      siblingOrder: siblingOrder(el),
      styles: {
        fontSize: s.fontSize,
        fontWeight: s.fontWeight,
        color: s.color,
        backgroundColor: s.backgroundColor,
        borderRadius: s.borderRadius,
        padding: s.padding,
        fontFamily: s.fontFamily.slice(0, 80)
      },
      box: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      }
    };
  };
  const collect = (selector, category, limit) =>
    Array.from(document.querySelectorAll(selector)).slice(0, limit).map(el => record(el, category));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    tokens,
    headings: collect('h1,h2,h3,h4,h5,h6', 'heading', 25),
    buttons: collect('button', 'button', 30),
    landmarks: collect('main,header,nav,aside,section,article', 'landmark', 30)
  });
})()"""


HEALTH_JS = r"""(() => {
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const isVisible = el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || num(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const body = document.body;
  const visibleText = ((body && body.innerText) || '').replace(/\s+/g, ' ').trim();
  const all = body ? Array.from(body.querySelectorAll('*')) : [];
  let visibleLeafElements = 0;
  let styledElementCount = 0;
  for (const el of all) {
    if (!isVisible(el)) continue;
    if (el.children.length === 0 && (el.textContent || '').trim().length > 0) visibleLeafElements++;
    const s = getComputedStyle(el);
    const bg = s.backgroundColor;
    const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const hasBorder = num(s.borderTopWidth) > 0 || num(s.borderRightWidth) > 0 ||
                      num(s.borderBottomWidth) > 0 || num(s.borderLeftWidth) > 0;
    const hasShadow = s.boxShadow && s.boxShadow !== 'none';
    if (hasBg || hasBorder || hasShadow) styledElementCount++;
  }
  return JSON.stringify({
    visibleTextChars: visibleText.length,
    visibleLeafElements,
    styledElementCount
  });
})()"""


AUTH_JS = r"""(() => {
  const text = (document.body && document.body.innerText || '').toLowerCase();
  const url = location.href.toLowerCase();
  const title = document.title.toLowerCase();
  const hasPassword = !!document.querySelector('input[type="password"], input[name*="password" i]');
  const authWords = ['sign in', 'signin', 'log in', 'login', 'authenticate', 'microsoft', 'entra'];
  const wordHit = authWords.some(w => text.includes(w) || url.includes(w) || title.includes(w));
  return JSON.stringify({
    url: location.href,
    title: document.title,
    hasPassword,
    wordHit,
    isLikelyAuth: hasPassword || wordHit,
    textSample: text.slice(0, 500)
  });
})()"""


PLAYWRIGHT_CLI_MISSING_HELP = (
    "playwright-cli is not available on PATH, so I can't capture the app/design "
    "for visual validation.\n"
    "\n"
    "To enable it (one-time):\n"
    "  1. npm install -g @playwright/cli@latest\n"
    "  2. playwright-cli install --skills   # adds its agent skill\n"
    "\n"
    "Docs: https://github.com/microsoft/playwright-cli\n"
    "Then re-run the validation and I'll pick up from here."
)


# --- Render health (schema hatch-render-health-v1) ------------------------------
#
# An absolute, per-target verdict about whether a page really rendered, computed
# from bounded request/console/DOM/geometry evidence Playwright already exposes.
# `blocked` outranks `degraded` outranks `healthy`.
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
# A `readySelector` matched, but the page is an empty shell: below this many
# visible text characters AND with zero visible leaf elements AND zero styled
# elements. All three must hold — any one nonzero lifts it out of `blocked`.
SHELL_TEXT_THRESHOLD = 20
# Only these console levels count as errors; incidental warnings and
# informational logs are ordinary third-party noise and never degrade a render.
CONSOLE_ERROR_LEVELS = frozenset(
    {"error", "exception", "pageerror", "unhandledrejection", "unhandled rejection"}
)
# Only a failed request for one of these resource types degrades a render.
FAILED_RESOURCE_TYPES = frozenset({"document", "stylesheet", "script", "image"})
_MAX_EVIDENCE_ENTRIES = 20
_MAX_EVIDENCE_LEN = 200
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".avif")
_STATUS_RE = re.compile(r"\b([1-5][0-9]{2})\b")
_URL_RE = re.compile(r"https?://\S+|/\S+")


def bounded_list(items: Any, max_entries: int = _MAX_EVIDENCE_ENTRIES, max_len: int = _MAX_EVIDENCE_LEN) -> list[str]:
    """Normalize an iterable of evidence into bounded, de-noised text strings."""
    out: list[str] = []
    for item in items or []:
        text = str(item).strip()
        if not text:
            continue
        out.append(text[:max_len])
        if len(out) >= max_entries:
            break
    return out


def _entry_text(entry: Any) -> str:
    if isinstance(entry, dict):
        return str(entry.get("text") or entry.get("message") or "").strip()
    return str(entry).strip()


def _entry_level(entry: Any) -> str:
    if isinstance(entry, dict):
        return str(entry.get("level") or entry.get("type") or "").strip().lower()
    return ""


def _looks_like_error(text: str) -> bool:
    low = text.lower()
    return any(k in low for k in ("error", "uncaught", "unhandled rejection", "exception"))


def classify_console_errors(
    entries: Any, max_entries: int = _MAX_EVIDENCE_ENTRIES, max_len: int = _MAX_EVIDENCE_LEN
) -> list[str]:
    """Keep only error/exception/rejection console entries; drop warnings and logs.

    A known non-error level (warning, info, log, debug) is excluded even when its
    text happens to contain the word "error", so ordinary noise cannot degrade a
    render. Bare strings with no level are classified by their text."""
    out: list[str] = []
    for entry in entries or []:
        text = _entry_text(entry)
        if not text:
            continue
        level = _entry_level(entry)
        include = level in CONSOLE_ERROR_LEVELS if level else _looks_like_error(text)
        if include:
            out.append(text[:max_len])
            if len(out) >= max_entries:
                break
    return out


def classify_failed_requests(
    entries: Any, max_entries: int = _MAX_EVIDENCE_ENTRIES, max_len: int = _MAX_EVIDENCE_LEN
) -> list[str]:
    """Keep only failed document/stylesheet/script/image requests.

    A failed request for any other resource type (fetch, xhr, font, media, …)
    does not degrade a render per the render-health contract."""
    out: list[str] = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        rtype = str(entry.get("resourceType") or entry.get("type") or "").strip().lower()
        try:
            status = int(entry.get("status"))
        except (TypeError, ValueError):
            status = None
        failed = bool(entry.get("failed")) or (status is not None and status >= 400)
        if not (failed and rtype in FAILED_RESOURCE_TYPES):
            continue
        url = str(entry.get("url") or "").strip()
        label = f"{status if status is not None else 'failed'} {rtype} {url}".strip()
        out.append(label[:max_len])
        if len(out) >= max_entries:
            break
    return out


def parse_console_entries(raw: str) -> list[dict[str, str]]:
    """Best-effort normalize the raw `console error` CLI text into structured
    entries. The CLI stream is already error-filtered, so each non-empty line is
    tagged as an error; `classify_console_errors` remains the semantic gate."""
    return [{"level": "error", "text": line.strip()} for line in (raw or "").splitlines() if line.strip()]


def _infer_resource_type(url: str, text: str) -> str:
    low_text = (text or "").lower()
    for kw in ("stylesheet", "script", "image", "document"):
        if kw in low_text:
            return kw
    path = (url or "").split("?")[0].lower()
    if path.endswith(".css"):
        return "stylesheet"
    if path.endswith(".js") or path.endswith(".mjs"):
        return "script"
    if any(path.endswith(ext) for ext in _IMAGE_EXTS):
        return "image"
    if path.endswith(".html") or path.endswith(".htm") or path.endswith("/"):
        return "document"
    return "other"


def parse_request_entries(raw: str) -> list[dict[str, Any]]:
    """Best-effort normalize the raw `requests` CLI text into structured entries."""
    entries: list[dict[str, Any]] = []
    for line in (raw or "").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        status_match = _STATUS_RE.search(stripped)
        status = int(status_match.group(1)) if status_match else None
        url_match = _URL_RE.search(stripped)
        url = url_match.group(0) if url_match else ""
        failed = "fail" in stripped.lower() or (status is not None and status >= 400)
        entries.append(
            {
                "status": status,
                "resourceType": _infer_resource_type(url, stripped),
                "url": url,
                "failed": failed,
            }
        )
    return entries


def compute_render_health(
    *,
    ready_selector: str | None,
    visible_text_chars: int,
    visible_leaf_elements: int,
    styled_element_count: int,
    console_errors: Any,
    failed_requests: Any,
) -> dict[str, Any]:
    """Pure render-health verdict from bounded evidence. Used by both runtime
    capture and --self-test so the boundary is exercised the same way it ships."""
    text_chars = max(0, int(visible_text_chars))
    leaf = max(0, int(visible_leaf_elements))
    styled = max(0, int(styled_element_count))
    console = bounded_list(console_errors)
    requests = bounded_list(failed_requests)
    is_blocked_shell = text_chars < SHELL_TEXT_THRESHOLD and leaf == 0 and styled == 0
    if is_blocked_shell:
        result = "blocked"
    elif console or requests:
        result = "degraded"
    else:
        result = "healthy"
    return {
        "schema": RENDER_HEALTH_SCHEMA,
        "result": result,
        "readySelector": ready_selector,
        "visibleTextChars": text_chars,
        "visibleLeafElements": leaf,
        "styledElementCount": styled,
        "consoleErrorCount": len(console),
        "failedRequestCount": len(requests),
        "consoleErrors": console,
        "failedRequests": requests,
    }


def resolve_playwright_command() -> list[str]:
    resolved = shutil.which("playwright-cli")
    if not resolved:
        raise SystemExit(PLAYWRIGHT_CLI_MISSING_HELP)
    return [resolved]


def run_cli(args: list[str], timeout: int = 30, check: bool = False) -> subprocess.CompletedProcess[str]:
    if args and args[0] == "playwright-cli":
        args = [*resolve_playwright_command(), *args[1:]]
    try:
        result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, encoding="utf-8")
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode(errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode(errors="replace")
        raise RuntimeError(
            f"Command timed out ({timeout}s): {' '.join(args)}\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"
        ) from exc
    if check and result.returncode != 0:
        raise RuntimeError(
            f"Command failed ({result.returncode}): {' '.join(args)}\nSTDOUT:\n{result.stdout}\nSTDERR:\n{result.stderr}"
        )
    return result


def cli(session: str, *args: str, timeout: int = 30, check: bool = False) -> subprocess.CompletedProcess[str]:
    return run_cli(["playwright-cli", f"-s={session}", *args], timeout=timeout, check=check)


def cli_stdout(session: str, *args: str, timeout: int = 30) -> str:
    return cli(session, *args, timeout=timeout, check=True).stdout


def eval_json(session: str, code: str, timeout: int = 30) -> tuple[dict[str, Any] | None, str]:
    result = run_cli(["playwright-cli", "--raw", f"-s={session}", "eval", code], timeout=timeout, check=True)
    raw = result.stdout.strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, str):
            parsed = json.loads(parsed)
        if isinstance(parsed, dict):
            return parsed, raw
        return None, raw
    except json.JSONDecodeError:
        return None, raw


def _extract_ready_selector(stdout: str, selectors: list[str]) -> str | None:
    """Recover the matched selector `wait_for_any` returned from the CLI stdout."""
    lines = [line.strip().strip('"').strip("'") for line in (stdout or "").splitlines() if line.strip()]
    for line in reversed(lines):
        if line in selectors:
            return line
    return lines[-1] if lines else None


def wait_for_any(session: str, selectors: list[str], timeout_ms: int) -> str | None:
    selector_array = json.dumps(selectors)
    code = (
        "async page => { "
        f"for (const sel of {selector_array}) {{ "
        f"try {{ await page.waitForSelector(sel, {{ timeout: {timeout_ms} }}); return sel; }} catch {{}} "
        "} "
        "throw new Error('No ready selector matched'); "
        "}"
    )
    result = cli(
        session,
        "run-code",
        code,
        timeout=max(10, len(selectors) * (timeout_ms // 1000 + 2)),
        check=True,
    )
    return _extract_ready_selector(result.stdout, selectors)


def click_text(session: str, text: str) -> None:
    code = f"async page => await page.getByText({json.dumps(text)}, {{ exact: false }}).first().click()"
    cli(session, "run-code", code, timeout=15, check=True)


def capture_target(
    session: str,
    name: str,
    url: str,
    out_dir: Path,
    ready_selectors: list[str],
    click_texts: list[str],
    detect_auth: bool,
) -> dict[str, Any]:
    cli(session, "goto", url, timeout=60, check=True)
    ready_selector = wait_for_any(session, ready_selectors, 5000)

    for text in click_texts:
        click_text(session, text)

    raw_console = cli_stdout(session, "console", "error", timeout=10)
    raw_requests = cli_stdout(session, "requests", timeout=10)

    auth_info: dict[str, Any] | None = None
    if detect_auth:
        # DEGRADED_AUTH is the first gate for the app target: render health is only
        # computed once auth permits comparison.
        auth_info, _ = eval_json(session, AUTH_JS)
        if auth_info and auth_info.get("isLikelyAuth"):
            screenshot = out_dir / f"{name}.png"
            cli(session, "screenshot", f"--filename={screenshot}", timeout=30, check=True)
            return {
                "url": url,
                "health": "DEGRADED_AUTH",
                "auth": auth_info,
                "screenshot": str(screenshot),
                "dom_snapshot": None,
                "extracted_data": None,
                "ready_selector": ready_selector,
                "render_health": None,
                "console_errors": raw_console,
                "requests": raw_requests,
            }

    screenshot = out_dir / f"{name}.png"
    snapshot = out_dir / f"{name}-snapshot.yaml"
    cli(session, "screenshot", f"--filename={screenshot}", timeout=30, check=True)
    cli(session, "snapshot", "--boxes", f"--filename={snapshot}", timeout=30, check=True)
    extracted, raw = eval_json(session, STYLE_JS)
    health_evidence, _ = eval_json(session, HEALTH_JS)
    evidence = health_evidence or {}
    render_health = compute_render_health(
        ready_selector=ready_selector,
        visible_text_chars=evidence.get("visibleTextChars", 0),
        visible_leaf_elements=evidence.get("visibleLeafElements", 0),
        styled_element_count=evidence.get("styledElementCount", 0),
        console_errors=classify_console_errors(parse_console_entries(raw_console)),
        failed_requests=classify_failed_requests(parse_request_entries(raw_requests)),
    )
    return {
        "url": url,
        "health": "OK",
        "auth": auth_info,
        "screenshot": str(screenshot),
        "dom_snapshot": str(snapshot),
        "extracted_data": extracted if extracted is not None else raw,
        "ready_selector": ready_selector,
        "render_health": render_health,
        "console_errors": raw_console,
        "requests": raw_requests,
    }


def parse_viewport(value: str) -> tuple[int, int]:
    normalized = value.lower().replace(",", "x")
    parts = [p for p in normalized.split("x") if p]
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("viewport must be WIDTHxHEIGHT, e.g. 1440x900")
    return int(parts[0]), int(parts[1])


def _find_fixtures_dir() -> Path | None:
    """Walk up from this script to the repo's visual-capture fixtures, if present.

    Reachable identically from the canonical script and both generated mirrors
    (all live inside the repo). Absent in an installed consumer skill, where the
    inline scenarios below still make the self-test authoritative."""
    here = Path(__file__).resolve()
    for parent in (here.parent, *here.parents):
        candidate = parent / "tests" / "pi" / "fixtures" / "visual-captures"
        if candidate.is_dir():
            return candidate
    return None


def self_test() -> None:
    width, height = parse_viewport("1440x900")
    assert (width, height) == (1440, 900)
    sample = {"compare_ready": False, "app": {"health": "DEGRADED_AUTH"}}
    assert sample["app"]["health"] == "DEGRADED_AUTH"

    # --- render health: the shell boundary, locked at each of three conditions ---
    def health(chars: int, leaf: int, styled: int, console=None, requests=None) -> dict[str, Any]:
        return compute_render_health(
            ready_selector="body > *",
            visible_text_chars=chars,
            visible_leaf_elements=leaf,
            styled_element_count=styled,
            console_errors=console or [],
            failed_requests=requests or [],
        )

    # 19/20/21 visible-text characters with zero meaningful elements.
    assert health(19, 0, 0)["result"] == "blocked"
    assert health(20, 0, 0)["result"] == "healthy"
    assert health(21, 0, 0)["result"] == "healthy"
    # Each shell condition lifts `blocked` independently, even with 0 text and 0 of the other.
    assert health(0, 1, 0)["result"] == "healthy"
    assert health(0, 0, 1)["result"] == "healthy"
    assert health(0, 0, 0)["result"] == "blocked"

    # Degraded evidence flips an otherwise healthy render; blocked outranks degraded.
    assert health(400, 40, 30, console=["Uncaught TypeError: x is undefined"])["result"] == "degraded"
    assert health(400, 40, 30, requests=["404 stylesheet /theme.css"])["result"] == "degraded"
    assert health(400, 40, 30)["result"] == "healthy"
    assert health(5, 0, 0, console=["Uncaught TypeError"])["result"] == "blocked"

    # Closed evidence-key set and the literal hatch-render-health-v1 schema.
    healthy = health(400, 40, 30, console=["boom"], requests=["500 script /a.js"])
    assert set(healthy.keys()) == set(RENDER_HEALTH_KEYS)
    assert healthy["schema"] == "hatch-render-health-v1"
    assert healthy["result"] == "degraded"
    assert healthy["consoleErrorCount"] == 1 and healthy["failedRequestCount"] == 1

    # Console classification: only errors/exceptions/rejections; warnings and logs drop.
    console_entries = [
        {"level": "error", "text": "Uncaught TypeError: x is undefined"},
        {"level": "warning", "text": "deprecation warning"},
        {"level": "info", "text": "app started"},
        {"level": "pageerror", "text": "Uncaught ReferenceError: y is not defined"},
        {"level": "unhandledrejection", "text": "Unhandled promise rejection: boom"},
        {"level": "log", "text": "this log mentions the word error but is not one"},
    ]
    assert classify_console_errors(console_entries) == [
        "Uncaught TypeError: x is undefined",
        "Uncaught ReferenceError: y is not defined",
        "Unhandled promise rejection: boom",
    ]

    # Request classification: only failed document/stylesheet/script/image requests.
    request_entries = [
        {"status": 404, "resourceType": "stylesheet", "url": "/theme.css"},
        {"status": 500, "resourceType": "script", "url": "/app.js"},
        {"status": 200, "resourceType": "image", "url": "/ok.png"},
        {"failed": True, "resourceType": "image", "url": "/broken.png"},
        {"status": 404, "resourceType": "fetch", "url": "/api/data"},
        {"status": 503, "resourceType": "document", "url": "/"},
    ]
    assert classify_failed_requests(request_entries) == [
        "404 stylesheet /theme.css",
        "500 script /app.js",
        "failed image /broken.png",
        "503 document /",
    ]

    # Runtime text parsers feed the classifiers end-to-end.
    assert classify_console_errors(parse_console_entries("console.error handler failed\nsecond error")) == [
        "console.error handler failed",
        "second error",
    ]
    assert classify_failed_requests(
        parse_request_entries("GET https://x/style.css 404 stylesheet\nGET https://x/app.js 200 script")
    ) == ["404 stylesheet https://x/style.css"]

    # Bounding of noisy evidence.
    bounded = compute_render_health(
        ready_selector=None,
        visible_text_chars=10,
        visible_leaf_elements=5,
        styled_element_count=5,
        console_errors=[f"error {i}" for i in range(50)],
        failed_requests=[],
    )
    assert bounded["consoleErrorCount"] == _MAX_EVIDENCE_ENTRIES
    assert len(bounded["consoleErrors"]) == _MAX_EVIDENCE_ENTRIES

    # Matched-selector recovery from run-code stdout.
    assert _extract_ready_selector('"body > *"\n', ["main", "body > *"]) == "body > *"
    assert _extract_ready_selector("main\n", ["main", "#root > *"]) == "main"
    assert _extract_ready_selector("", ["main"]) is None

    # CTA message content and the missing-binary hard gate.
    assert PLAYWRIGHT_CLI_MISSING_HELP.startswith("playwright-cli is not available on PATH")
    assert "npm install -g @playwright/cli@latest" in PLAYWRIGHT_CLI_MISSING_HELP
    assert "playwright-cli install --skills" in PLAYWRIGHT_CLI_MISSING_HELP
    assert "https://github.com/microsoft/playwright-cli" in PLAYWRIGHT_CLI_MISSING_HELP
    original_which = shutil.which
    shutil.which = lambda _cmd: None
    try:
        raised = None
        try:
            resolve_playwright_command()
        except SystemExit as exc:
            raised = str(exc)
        assert raised == PLAYWRIGHT_CLI_MISSING_HELP
    finally:
        shutil.which = original_which

    # Bind the shipped fixtures to the real helper: every recorded render_health
    # must be exactly what compute_render_health produces from its own evidence.
    fixtures_dir = _find_fixtures_dir()
    if fixtures_dir is None:
        print("capture_view self-test: no visual-captures fixtures found (skipped fixture binding)")
    else:
        verified = 0
        for fixture in sorted(fixtures_dir.glob("*.json")):
            data = json.loads(fixture.read_text(encoding="utf-8"))
            for key in ("design", "app"):
                target = data.get(key)
                if not isinstance(target, dict):
                    continue
                rh = target.get("render_health")
                if rh is None:
                    continue
                assert set(rh.keys()) == set(RENDER_HEALTH_KEYS), f"{fixture.name}:{key} key set"
                recomputed = compute_render_health(
                    ready_selector=rh["readySelector"],
                    visible_text_chars=rh["visibleTextChars"],
                    visible_leaf_elements=rh["visibleLeafElements"],
                    styled_element_count=rh["styledElementCount"],
                    console_errors=rh["consoleErrors"],
                    failed_requests=rh["failedRequests"],
                )
                assert recomputed == rh, f"{fixture.name}:{key} render_health drifted from compute_render_health"
                verified += 1
        assert verified > 0, "expected at least one fixture render_health record to verify"
        print(f"capture_view self-test: verified {verified} fixture render_health records")

    print("capture_view self-test passed")


def main() -> None:
    parser = argparse.ArgumentParser(description="Capture design and app views with playwright-cli.")
    parser.add_argument("--design-url")
    parser.add_argument("--app-url")
    parser.add_argument("--out", default="hatch-validate-capture.json")
    parser.add_argument("--artifacts-dir", default=".hatch-validate")
    parser.add_argument("--viewport", default="1440x900", type=parse_viewport)
    parser.add_argument("--session", default="hatch-validate")
    parser.add_argument("--design-click-text", action="append", default=[])
    parser.add_argument("--app-click-text", action="append", default=[])
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.design_url or not args.app_url:
        parser.error("--design-url and --app-url are required unless --self-test is used")

    width, height = args.viewport
    out_path = Path(args.out).expanduser().resolve()
    artifacts_dir = Path(args.artifacts_dir).expanduser().resolve()
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {
        "schema": "hatch.validate.capture.v1",
        "viewport": {"width": width, "height": height},
        "design": None,
        "app": None,
        "APP_HEALTH": None,
        "STATUS": "capture_pending",
        "error": None,
        "compare_ready": False,
    }

    # Hard gate — missing binary prints the install CTA and exits without an artifact.
    resolve_playwright_command()

    # Design and app run in two independently opened and closed named sessions so
    # request/console evidence can never cross-contaminate. Each session owns its
    # cleanup: a failure to open, capture, or close one never skips the other's.
    targets = [
        (
            "design",
            f"{args.session}-design",
            args.design_url,
            ["#root > *", "body > *"],
            args.design_click_text,
            False,
        ),
        (
            "app",
            f"{args.session}-app",
            args.app_url,
            ["main", "#__next > *", "#root > *", "#app > *", "body > *"],
            args.app_click_text,
            True,
        ),
    ]

    error_message: str | None = None
    for key, session, url, ready_selectors, click_texts, detect_auth in targets:
        try:
            cli(session, "open", timeout=30, check=True)
            cli(session, "resize", str(width), str(height), timeout=15, check=True)
            result[key] = capture_target(
                session, key, url, artifacts_dir, ready_selectors, click_texts, detect_auth
            )
        except Exception as exc:
            if error_message is None:
                error_message = str(exc)
        finally:
            try:
                cli(session, "close", timeout=15, check=True)
            except Exception as close_exc:
                if error_message is None:
                    error_message = str(close_exc)
                else:
                    result.setdefault("close_errors", []).append(f"{session}: {close_exc}")

    if error_message is None:
        app = result["app"]
        result["APP_HEALTH"] = app["health"] if isinstance(app, dict) else None
        result["compare_ready"] = result["APP_HEALTH"] not in (None, "DEGRADED_AUTH")
        result["STATUS"] = "captured" if result["compare_ready"] else "blocked_auth"
    else:
        result["STATUS"] = "error"
        result["error"] = error_message

    out_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    if error_message:
        print(error_message, file=sys.stderr)
        print(json.dumps({"capture": str(out_path), "status": result["STATUS"], "error": error_message}))
        raise SystemExit(1)
    print(json.dumps({"capture": str(out_path), "compare_ready": result["compare_ready"]}))


if __name__ == "__main__":
    main()
