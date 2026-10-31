---
name: hatch-validate
model: opus
effort: xhigh
description: Compare a running frontend implementation against design HTML files exported from Claude Design OR a runtime-JSX design source. Opens both the live app (at the caller-provided app URL) and the served design prototype through bundled uv-run capture scripts, captures screenshots and DOM snapshots, then reports structured discrepancies across layout, color, typography, spacing, component structure, and visual hierarchy. Validates one view per invocation — the calling pipeline loops for multiple views. Invoke when validating implementation fidelity — trigger phrases include "validate against the design", "compare implementation to design", "check design fidelity", "does this match the design", "visual QA against design HTML", or any request to diff what's running vs the design prototype files.
---

Compare a single frontend view against its design prototype exported from Claude Design OR a runtime-JSX design source. This skill is hatch's **visual acceptance gate** — the gate invoked for oracle `type: visual` items. It is read-only: it reports discrepancies as kickback input for `hatch-build` to self-correct and never fixes anything itself. The caller decides what to act on.

Write everything you show a person — the report, the stop messages, the summaries — in plain language. See [references/user-facing-prose.md](references/user-facing-prose.md).

See [references/verification-gate.md](references/verification-gate.md) for how the gate fits the broader build/verify loop, and [references/definition-of-done.md](references/definition-of-done.md) for the acceptance floor.

The skill uses bundled PEP 723 Python scripts to avoid Bash/WSL/POSIX assumptions:

- `scripts/serve_design.py` resolves and serves the design HTML on an OS-assigned localhost port. Before opening a socket it applies one containment rule to both explicit-file and directory-discovery modes: the chosen file's parent is the document root, and a repository/worktree root — or any directory at or above it — is refused so the whole tree can never be served as a subtree (a design directory strictly inside the repository, such as `docs/`, stays allowed).
- `scripts/capture_view.py` drives `playwright-cli`, captures both targets through two independently opened and closed named sessions (one suffixed `-design`, one `-app`, so request/console evidence can never cross-contaminate), computes an absolute per-target render-health verdict, and writes one JSON artifact.
- `scripts/diff_capture.py` is Pass 1 as code: it consumes that one capture artifact, validates each target's `hatch-render-health-v1` record, and emits a bounded, deterministic `hatch-structured-diff-v1` discrepancy document — geometry-first element pairing, exact token/computed-style comparison, missing/extra elements, and measured geometry and sibling-gap findings — so every runtime performs the same structured comparison instead of re-deriving it from prose.

When Pi provides `hatch_script`, use `serveDesignSelfTest` for the bounded self-test, `captureView` for capture, and `diffCapture` for the structured Pass-1 diff. The long-running design server still uses the runtime's managed-process facility with the fallback command. Otherwise replace `<skill-dir>` with the absolute directory containing this `SKILL.md` and run scripts through `uv run --script`. Never resolve a bundled script from the consumer repo's working directory, and do not invoke Python automation as `python script.py` in a uv-managed environment.

`playwright-cli` is an external dependency. This skill uses the installed `playwright-cli` command; it does not patch, wrap, bypass, or maintain Playwright CLI behavior. If a Playwright action cannot be performed, fail with the command, exit code, stdout, and stderr. When `playwright-cli` is not installed at all, `capture_view.py` fails with a one-time install CTA (`npm install -g @playwright/cli@latest`, then `playwright-cli install --skills` for its companion agent skill); relay that message to the user and stop — do not auto-install or hand-drive Playwright.

## Inputs

The caller's prompt must include:

- **Design HTML file path** — absolute or relative to the workspace root. Can be a directory; `serve_design.py` picks the best HTML file, preferring standalone non-print variants.
- **App base URL** (optional) — where the running app is served. Defaults to `http://localhost:3000` when omitted.
- **App route** — URL path in the running app; appended to the app base URL.
- **Design navigation instructions** — explicit steps to reach the target view in the design prototype.
- **App navigation instructions** (optional) — steps beyond loading the route, such as opening a modal or detail pane.
- **Auth / login setup** (optional) — steps, storage state, cookie, token, or test-login mechanism needed for the target app route to render.
- **Viewport** (optional) — width x height in pixels. Defaults to `1440x900`.
- **Focus areas** (optional) — comparison dimensions to emphasize.
- **Oracle assertions** (optional) — the acceptance assertions for this view as stated in the work item's oracle (e.g., "zero critical or major discrepancies at 1440x900"). When provided, the report adds an `ACCEPTANCE` verdict against these assertions. When omitted, the report describes drift only (fully back-compatible).

For alternate theme contexts, the caller provides navigation/context-switch steps for both design and app. This skill has no separate theme input.

## Workflow

### Phase 0 — Prerequisites  `validate:prereq`

All checks are hard gates. Fail with a clear report rather than prompting.

1. **`uv` is available.** The bundled scripts are run with `uv run`.
2. **Design files resolve.** Run:

   Use `hatch_script` action `serveDesignSelfTest`; fallback: `uv run --script <skill-dir>/scripts/serve_design.py --self-test`.

   Then use the same script in the serve step (`validate:serve`) with the caller's design path. If it cannot resolve an HTML file, stop with: "No design HTML files found at `<path>`. Provide a Claude Design OR runtime-JSX design HTML export."

3. **App dev server is already running.** The caller owns the app server lifecycle. Use a host-native HTTP check or let `capture_view.py` fail on navigation. Do not start the app server here.
4. **`playwright-cli` is available.** `capture_view.py` checks this before capture. If it is missing, the script exits non-zero with an actionable install CTA — the two-step `npm install -g @playwright/cli@latest` then `playwright-cli install --skills`, plus the docs link. Surface that message and stop; this stays a hard gate (no prompting, no auto-install, no degraded capture).
5. **The design capture still matches its pin, if one is recorded.** Run:

   ```powershell
   uv run <skill-dir>/scripts/check_design_pins.py --design-path <design-path> --allow-unpinned
   ```

   `check_design_pins.py` hashes the caller's design path (resolving a directory through the same `resolve_design_file` used in `validate:serve`, so it pins the file that will actually be served) and compares it against the fingerprint recorded for it in `.hatch/design-pins.json`. A capture that has drifted, expired past its own `recapture_after`, or has no entry of its own fails, and a non-zero exit here is a hard stop, the same as the checks above. The two outcomes where the check verified nothing — no pin file at all, or a design resolved from outside the repository — exit non-zero on their own, because a zero exit is read as "this capture was checked" and for those two that is false. This step passes `--allow-unpinned`, which turns exactly those two back into a printed notice and a pass, because pinning is opt-in and a repository that never pinned anything should not be stopped by a check it never asked for. Nothing else moves: with the flag set, a drifted capture, an expired pin, a missing entry and a malformed pin file all still hard-stop. Drop the flag in a repository that has pinned its captures and wants the unverifiable cases to stop it too. On a pass, the run also prints the capture's date, its upstream address, and its recapture triggers — read them before trusting the comparison that follows, since this check never looks upstream itself.

Do not assume Bash, WSL, `/tmp`, `curl`, `grep`, `find`, `lsof`, `kill`, or POSIX background syntax.

### Phase 1 — Serve the design HTML  `validate:serve`

Start the design server as a managed background process/session with the bundled script:

```powershell
uv run --script <skill-dir>/scripts/serve_design.py --design-path <design-path> --metadata-out <metadata-json>
```

The script:

- resolves the HTML path
- resolves each requested file and directory index and rejects symlinks outside the design directory (a concurrent filesystem mutation after the check remains outside this local preview server's protection)
- refuses to serve a repository/worktree root (or a directory containing it) as the document root before opening a socket; a design directory strictly inside the repository stays allowed, and outside Git only a filesystem root is refused
- serves from the design file's parent directory so relative `fonts/`, `assets/`, and `uploads/` paths work
- binds to `127.0.0.1` on an OS-assigned port
- writes JSON metadata containing `design_file`, `design_url`, `port`, and `metadata`
- verifies the design URL returns HTTP 200 before reporting readiness

Keep the process handle so cleanup (`validate:cleanup`) can stop it. Read `design_url` from the metadata file or the script's first JSON stdout line.

### Phase 2 — Capture worker  `validate:capture`

Use a capture subagent OR host worker for mechanical capture only. It does not compare and does not suggest fixes.

For simple route-only or text-click navigation, use `hatch_script` action `captureView` with `designUrl`, `appUrl`, `viewport`, and `out`; fallback:

```powershell
uv run --script <skill-dir>/scripts/capture_view.py `
  --design-url <design-url> `
  --app-url <app-base-url><app-route> `
  --viewport <WxH> `
  --out <capture-json>
```

Optional repeated flags:

- `--design-click-text "<label>"` for simple design navigation
- `--app-click-text "<label>"` for simple app navigation

If the required navigation cannot be represented by the supported capture script inputs, stop and report the unsupported navigation requirement to the caller. Do not hand-drive Playwright outside the script and do not hand-produce a replacement artifact.

The capture artifact contains, per target (`design`, `app`):

- design/app screenshot paths
- design/app DOM snapshot paths with bounding boxes
- extracted token data, plus comparable heading/button/landmark records that each carry stable `identity`, `category`/`role`, normalized `text`, `parentIdentity`, `siblingOrder`, computed `styles`, and a `box` with `x`/`y`/`width`/`height`
- `console_errors` and `requests` — the raw CLI text, preserved
- `render_health` — an absolute per-target verdict (schema `hatch-render-health-v1`)
- `APP_HEALTH`
- `compare_ready`

**Render health (`render_health`, schema `hatch-render-health-v1`).** An absolute answer to whether the page really rendered, distinct from the relative design diff and from the auth gate. `result` is `healthy | degraded | blocked`, alongside bounded evidence: `readySelector` (the matched selector `wait_for_any` returned), `visibleTextChars`, `visibleLeafElements`, `styledElementCount`, `consoleErrorCount`, `failedRequestCount`, and the bounded `consoleErrors` / `failedRequests` lists.

- **`blocked`** — a `readySelector` matched but the page is an empty shell: fewer than 20 visible text characters **and** zero visible leaf elements **and** zero styled elements. Any one of the three being nonzero lifts it out of `blocked`. (A fully blank page never reaches here — it hard-fails earlier through `wait_for_any`.)
- **`degraded`** — an otherwise-rendered page carrying an uncaught page exception, an unhandled promise rejection, or a failed document/stylesheet/script/image request. Incidental console warnings and informational logs do not degrade a render, so ordinary third-party noise cannot flip a good render to `degraded`.
- **`healthy`** — rendered with none of the above.

DEGRADED_AUTH remains the first gate for the app target; render health is computed only once auth permits comparison (it is `null` on a `DEGRADED_AUTH` return).

**Auth-aware gate.** If the app route renders a login/auth screen instead of the target view, the artifact must set:

```text
APP_HEALTH: DEGRADED_AUTH
compare_ready: false
```

Do not compare a login screen against the target design. Return the blocked-auth report in the comparison worker (`validate:compare`) and ask the caller/build skill for authenticated session setup.

### Phase 3 — Comparison worker  `validate:compare`

Use a separate comparison subagent OR fresh host-worker pass with only the capture JSON and any caller focus areas. It has not seen the app code, design files, or pipeline state.

If `compare_ready` is `false` because `APP_HEALTH` is `DEGRADED_AUTH`, return:

```text
STATUS: blocked_auth

SUMMARY: The app route showed an authentication screen, not the target view, so design fidelity was not checked. Set up an authenticated session and re-run.

APP_HEALTH: DEGRADED_AUTH

DISCREPANCIES:
Not evaluated.

TOKEN_DRIFT:
Not evaluated.

MISSING_ELEMENTS:
Not evaluated.

EXTRA_ELEMENTS:
Not evaluated.
```

Otherwise run the comparison in two passes and **ground every finding in evidence** — the shared script produces the exact structured data, and you treat the screenshots as an equal, mandatory source, not an afterthought. The extracted data covers only some elements (headings, buttons, landmarks) and a few properties, so it finds much but not everything.

**Pass 1 — the shared structured diff (`scripts/diff_capture.py`).** The exact, mechanical comparison is not prose you perform — it is one package-owned script every runtime runs. On Pi use `hatch_script` action `diffCapture` with the capture-artifact path (and an optional `out` path); otherwise `uv run --script <skill-dir>/scripts/diff_capture.py --capture <capture-json>`. The script reads only the capture JSON (never the app or design source, never the playwright-cli YAML snapshot sidecar), validates each target's `hatch-render-health-v1` record, and emits a bounded, deterministic `hatch-structured-diff-v1` document:

- It **consumes render health before any relative diff.** It surfaces `design` and `app` render health in the document's `renderHealth`, and **fails closed** — a malformed artifact, an auth-degraded app target, or a `blocked` render (the page never really rendered) yields `status: blocked` with a `blockedReason` and a non-zero exit, never a silent clean diff. A `degraded` render (an uncaught error or a failed asset) still compares, with its health surfaced first — a page that did not render is not a fidelity question.
- It **pairs elements within each role/category by bounding-box geometry first**, using normalized text only as a secondary tie-breaker, so mock-data text (dates, names, counts, seeded values) can never drive pairing and array order never implies a 1:1 match. What is genuinely present on one side only becomes `missingElements` / `extraElements`.
- It compares the `--*` token map (`tokenDrift`) and the captured computed styles — `color`, `backgroundColor`, `fontSize`, `fontWeight`, `fontFamily`, `padding`, `borderRadius` — **exactly**, per matched element.
- It flags element position/size differences over about 20px and edge-to-edge gap differences between adjacent matched siblings over about 8px, each citing the measured boxes.

Every candidate cites its evidence (a token, a computed-style value, a bounding-box delta, or a sibling gap) and the stable element identity it came from. Read that document as the exact, grounded starting point for Pass 2 — do not re-derive these numbers by hand, and confirm spacing candidates against the screenshots. A model-unavailable runtime may report this structured result but cannot on its own claim full visual acceptance; Pi stays blocked on a full visual oracle until its later screenshot-judgement binder lands.

**Pass 2 — inspect the screenshots (mandatory, even if Pass 1 is clean).** Many real regressions never reach the extracted data: wrong or missing icons, missing shadows/borders, gradients, opacity, clipped or overlapping content, broken visual hierarchy, component fidelity, interactive-element presence, the styling (color, font, size) of elements the extracted data omits — body copy, links, and form inputs — and content/copy (ignoring mock-data value differences). Inspect the design and app screenshots directly for these across the whole view. **A difference you can see and point to is a valid finding even with zero data delta** — do not discount it for lacking a numeric anchor. But do not flag plausible capture or rendering artifacts (anti-aliasing, sub-pixel shifts, font rasterization, image compression); those are not product differences.

**Ground every discrepancy — a pointed-to visual difference counts as evidence.** Every finding must cite one of: a token/computed-style value, a bounding-box delta, or a specific region you can point to in a screenshot. Where a computed value exists, put the two values in `DESIGN`/`APP`; for a visual-only finding, name the element or area in `ELEMENT` (the schema allows an area, not just a selector) and put a short "what the design shows" vs "what the app shows" description in `DESIGN`/`APP`. Drop only candidates you cannot point to at all — a vague "feels off" with no region is noise. The rule exists to stop invention at high effort, **not** to suppress visible differences.

**Judge on evidence, not polish or order.** The design is the fidelity target and the app is the candidate, but neither screenshot's overall "finished" look decides a finding — only a measured or pointed-to difference does. Don't let which capture you read first, or which simply looks more polished, introduce or inflate a discrepancy. Assign each discrepancy a severity by its user-facing impact: `critical` (blocks use or breaks the layout or a primary action), `major` (clearly wrong and visible but still usable), `minor` (noticeable only on close inspection), `cosmetic` (barely perceptible — a few-px shift or a tiny color delta). The oracle, when provided, still sets the pass/fail bar (see below).

Expected report format:

```text
STATUS: <match | partial | mismatch | blocked_auth>

SUMMARY: <2-3 sentence overall assessment>

APP_HEALTH: <OK | DEGRADED | DEGRADED_AUTH>

DISCREPANCIES:
For each issue found:
- DIMENSION: <layout | colors | typography | spacing | components | hierarchy | interactive | content>
- SEVERITY: <critical | major | minor | cosmetic>
- ELEMENT: <specific element or area>
- DESIGN: <what the design shows, citing values where possible>
- APP: <what the app shows, citing values where possible>
- NOTES: <context>

TOKEN_DRIFT:
For each significant CSS custom-property difference:
- TOKEN: <name> | DESIGN: <value> | APP: <value or "not defined">

MISSING_ELEMENTS:
Bulleted list, or "None".

EXTRA_ELEMENTS:
Bulleted list, or "None".

ACCEPTANCE: <pass | fail>   ← include ONLY when oracle assertions were provided; omit entirely otherwise
```

`ACCEPTANCE: pass` means every provided oracle assertion holds (e.g., zero critical and zero major discrepancies). `ACCEPTANCE: fail` means at least one assertion does not hold. When no assertions are provided, omit the line entirely — the schema is unchanged for callers that do not pass assertions.

Do not add `RECOMMENDATIONS`, `FIXES`, code suggestions, or implementation instructions to the schema. If a worker suggests fixes, strip them before returning the report.

### Phase 4 — Cleanup  `validate:cleanup`

Always stop only the design server process started in the serve step (`validate:serve`). Close the `playwright-cli` named session defensively if the capture worker failed before cleanup. Remove temporary capture artifacts only with host-native filesystem operations and only for paths created by this run.

The final output is the structured report from the comparison worker (`validate:compare`). Do not modify app files, design files, or ticket files.

## Gotchas

- **Design render delay.** Runtime-JSX prototypes can be blank until React/Babel finishes. `capture_view.py` waits for `#root > *` or `body > *` before screenshotting.
- **Design navigation is client-side.** The prototype usually uses `useState`; reach views by interactions, not by changing the design URL.
- **HTTP server directory matters.** Serve from the design file's parent directory so relative assets resolve.
- **Standalone HTML is preferred.** The server script chooses standalone non-print HTML before other HTML files.
- **Auth redirects are not visual mismatches.** `DEGRADED_AUTH` blocks comparison and routes the problem back to the caller for session setup.
- **Render health is absolute, not relative.** `render_health` answers whether each target really rendered (`healthy | degraded | blocked`) from request/console/DOM/geometry evidence, independent of the design diff. The comparison consumes it first: a `blocked` shell or a `degraded` render is reported ahead of any fidelity finding.
- **Pass 1 is one shared script, not model arithmetic.** `scripts/diff_capture.py` performs the exact structured comparison for every runtime — geometry-first pairing, exact token/computed-style diffs, missing/extra elements, and measured geometry/sibling-gap findings — deterministically, from the capture JSON alone. It never reads the app/design source or the playwright-cli YAML snapshot sidecar, and it fails closed (`status: blocked`, non-zero exit) on a malformed, auth-degraded, or `blocked`-render capture. Do not hand-derive these numbers or reimplement the pairing in prose; read the script's document and build Pass 2 on it.
- **Design and app never cross-contaminate.** The two targets are captured in independently opened and closed named sessions, so one target's console errors or failed requests can never leak into the other's evidence.
- **Serving the repository root is refused.** `serve_design.py` will not expose a repository/worktree root (or a directory containing it) as the design document root; point `--design-path` at a design subdirectory such as `docs/`.
- **Validation is read-only.** This skill reports only. It never fixes, re-runs after fixes, or changes files.
- **Playwright is external.** Do not repair or bypass `playwright-cli` internals. Fail clearly when a Playwright action fails.
- **This is the visual acceptance gate.** hatch routes `oracle.type: visual` items here. Other oracle types (unit, integration, e2e, smoke) go to `hatch-acceptance-reviewer`, not here.
- **The report is kickback input, not a fix.** A `STATUS: mismatch` or `ACCEPTANCE: fail` result feeds back to `hatch-build` for self-correction within the gate's retry cap. This skill never applies those corrections.
- **The oracle sets the bar.** When oracle assertions are provided, `ACCEPTANCE` is determined by them — not by the skill's own judgment of severity. A single critical discrepancy can produce `ACCEPTANCE: fail` even if the visual diff looks minor. When no assertions are given, no verdict is emitted; the report is descriptive only.
