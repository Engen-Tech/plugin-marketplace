---
name: hatch-status
model: haiku
description: >-
  Show what's next in a hatch run — where you are and the single next action, at binder and work-item level, derived from git and never stored. Read-only. When someone wants to SEE or watch status, it opens the live Hatch Status browser page by default — ephemeral for this session unless the repo is opted into the persistent multi-repo hub; a one-shot terminal map is the headless fallback. Trigger phrases: "what's next", "hatch status", "where am I in this binder", "show me the hatch status", "hatch watch", "turn off hatch watch", "hatch-status".
---

hatch-status answers one question: **what do I do next?** It reads every binder in
`.hatch/binders/` and the hatch git refs, recomputes the state, and surfaces a "you are here" view
with one copy-pasteable next action — **by default the live Hatch Status browser page**, or a
one-shot terminal map when there's no browser. It writes nothing and changes nothing.

## How it derives state

All state is git-native and recomputed on every call — there is no stored cursor:

- **Binder order** is a topo sort over the optional cross-binder `after` edge (see
  [hatch-plan's binder reference](../hatch-plan/references/binder-reference.md)). The order is
  *derived*, never written anywhere. A dangling `after` is surfaced as a warning; a cycle is an
  error. An `after` naming a **delivered** binder — one hatch-deliver archived to
  `.hatch/binders/archive/` — resolves as satisfied, not dangling.
- **Archived binders** (`.hatch/binders/archive/`) are delivered history: the terminal map and
  the session-start summary never list them; the Hatch Status page shows them as Delivered
  builds, sorted last.
- **Binder status** — `merged` (every item's `done` ref is an ancestor of the default branch),
  `in_flight` (integration branch exists, or some items merged), or `not_started`.
- **Work-item frontier** (for the in-flight binder) — `done` / `accepted` / `built` / `failed` /
  `building` / `ready` / `blocked`, from `depends_on` and the `refs/hatch/<slug>/item-<id>/*` refs.
  `accepted` is done under a human waiver: merged, but the named assertion was not met. It counts
  as complete, and every surface shows it apart from a clean pass, with the reason from the merge
  commit's `Hatch-Accept-Reason` trailer.
- **A done ref is trusted only after provenance.** Status applies the rules hatch-deliver
  uses on resume — the deliver skill's `check_item_provenance.py` over `<done>^1..<done>` with its
  accepted-state rules, plus first-parent reachability on `hatch/<slug>/integration`. A done ref
  that fails is ignored and named in a warning, and so is a ref for an item the binder does not
  declare. The delivery Stop guard reads the same verdicts, so a forged done never silences it.
- **Successor binders.** A binder with `supersedes: {slug, carried}` repairs a partially delivered
  one. Each carried item is `done` (or `accepted`) when its predecessor's done ref under
  `refs/hatch/<predecessor>/` passes the same provenance rules, and it is shown as
  delivered by the predecessor; a carried item without that proof is not done and draws a
  warning. A live predecessor with a live successor is labelled superseded and is never offered
  as the next action — its remaining work is the successor's.
- **Unreadable binders are errors, never skipped.** A binder file that is not JSON, or is JSON but
  not a binder object, is listed in `errors` by path, and the next action says to repair it.
- **Next action** — one of: repair an unreadable or deleted binder; resume a delivery (including
  built items the merge queue never merged); land an integration branch whose every item is
  merged (the human's decision — status names it and never runs it); start the next binder;
  clean up branches or worktrees a landed binder left behind; plan the first binder in an empty
  repo; or the calm all-delivered end state.

## Two modes, two gates

Hatch Status runs in one of two modes, and two explicit gates decide which:

1. **You ask for status at all.** Nothing serves until someone asks to see it.
2. **You opt a repo into persistence.** Without that second, per-repo opt-in, the page is
   ephemeral — it lives and dies with the session that started it, exactly today's behavior.

Ephemeral is the default and is unchanged. The persistent hub is a deliberate, per-repo choice.

**Bundled scripts.** When Pi provides `hatch_script`, use `statusControl` and `hatchNext` for the bounded actions below. Otherwise replace `<skill-dir>` with the absolute directory containing this `SKILL.md` and run the fallback through `uv run --script`. The foreground ephemeral server still uses the fallback because it needs the runtime's managed-process facility. Never resolve a bundled script from the consumer repo's working directory.

## Ephemeral mode (the default) — open the live page

When someone asks for hatch status, "what's next", or to **see / watch / show / look at** where
they are, **start Hatch Status, the live browser page.** That is the point of this skill, so it is
the default — not an extra someone has to ask for:

  `uv run --script <skill-dir>/scripts/serve_status.py --root <repo> --port 8765`

Check first with `hatch_script` action `hatchNext` `format: watch` (fallback:
`uv run --script <skill-dir>/scripts/hatch_next.py --watch`): in an opted-in repo it returns the
persistent hub's working URL, so hand that over instead of starting a second server.

It is a **long-running** server (a browser polls it for as long as the page is open), so start it as a
**persistent/managed process** — a bare `&` or `nohup` is often reaped by the agent runtime before
it binds, so use the runtime's managed background-session mechanism — then **confirm it is serving
and hand the user the working URL**, not just the launch command: the full
`http://127.0.0.1:8765/?key=<token>` URL it prints at startup (on a remote host, forward the port to
the same port number locally — the page only answers a Host of `127.0.0.1:<port>` or
`localhost:<port>`). The page opens on four squares (my builds, waves in each build, running
now, needs you) under a headline that counts healthy builds and what needs a person. Each build
opens to its next step with a copy button, its waves, and one card per work item; it polls
`/state.json` to stay live. `?theme=light|dark` forces a theme. Every route except the static
assets needs `?key=`: a fresh token is generated on each start (`--key <token>` supplies your own),
and a request naming any other Host is refused, assets included. It is **self-contained** (vendored Vue and fonts, no CDN, no build step) and
**zero-dependency** stdlib Python; `serve_status.py --self-test` checks its invariants.

## Persistent mode — the Hatch Status hub (per-repo opt-in)

When someone asks to keep the status page around — "opt this repo into hatch watch", "make hatch
watch persistent" — flip the second gate:

  use `hatch_script` action `statusControl` with `operation: optIn`; fallback: `uv run --script <skill-dir>/scripts/serve_status.py --opt-in`

From then on, one per-user **hub** serves every opted-in repo at a stable local URL, and ordinary
hatch activity revives it automatically. The lifecycle flags, all on the same script:

- `--opt-in [PATH_OR_SLUG]` — opt a repo into the persistent watch (default: the current repo).
- `--opt-out [PATH_OR_SLUG]` — turn it off; accepts a path or slug so a moved or deleted repo's
  entry can be cleared from anywhere. When the user says **"turn off hatch watch"**, run this.
- `--ensure` — idempotently revive the hub: no-op when healthy, detached respawn when dead or
  outdated, and it **fails open** (one plain line, exit 0) so it never blocks hatch work. Hatch
  fires this automatically on every plan, build, deliver, and status touch; the flag exists for
  running it by hand, e.g. after a reboot.
- `--hub` — serve the hub in the foreground (mainly for testing; `--ensure` is the normal path).

Two rules hold on every hub route — home page, per-repo pages, state feeds, `/identity`, and
assets alike: the **token is required everywhere** (`?key=<token>`, generated per user, stored
0600 in the per-user state dir), and the **bind is hardcoded to loopback** (`127.0.0.1`, IPv4
only) with no interface option — the page is never reachable off the machine. In an opted-in
repo, Claude Code's session-start banner carries the full working URL with port and key. Pi shows
the user no such banner (it only folds the hook's text into the system prompt), so on Pi, or any
time the URL is needed, get it on demand and hand it to the user:

  use `hatch_script` action `hatchNext` with `format: watch`; fallback: `uv run --script <skill-dir>/scripts/hatch_next.py --watch`

It prints one line: the keyed hub URL when the hub answers (it waits about 2 s for a hub it just
revived), the revive one-liner when it does not, or, in a repo that is not opted in, how to opt in
and the ephemeral serve command instead. In an opted-in repo whose URL cannot be read it says so,
with the reason and the revive one-liner; outside any git checkout it says there is no repo to
watch. Paths that contain spaces are printed in double quotes, ready to paste.
`statusControl` `ensure` prints nothing on success, so it never answers "what is the URL".

Operator guide — opt-in, the stable URL, the off switch, the reboot gap, and the security model:
`docs/how-to/hatch-watch.md` in the hatch repo.

## One-shot text — when there's no browser

When the caller wants a quick textual answer, or there is no browser (CI, headless, a script), run
the engine directly instead of the page:

- Use `hatch_script` action `hatchNext` with `format: text`; fallback: `uv run --script <skill-dir>/scripts/hatch_next.py` — the route + frontier + `▶ next`.
- Use `hatch_script` action `hatchNext` with `format: json`; fallback: `uv run --script <skill-dir>/scripts/hatch_next.py --json` — the full state (the page consumes this).
- Use `hatch_script` action `hatchNext` with `format: footer` and `binder: <slug>`; fallback: `uv run --script <skill-dir>/scripts/hatch_next.py --footer --binder <slug>` — the one-line run-end nudge (always exactly one line; the hub-down nudge appears only on the terminal map).
- Use `hatch_script` action `hatchNext` with `format: watch`; fallback: `uv run --script <skill-dir>/scripts/hatch_next.py --watch` — the one Hatch Watch line: the hub URL with its key, the revive nudge, the opt-in hint, the "opted in but unavailable" line, or the "not inside a git checkout" line.

This skill is read-only and stack-agnostic. It never starts a build, never merges, never writes a
binder. It only tells you where you are and what is next. The one exception to "starts nothing" is
deliberate: asking for status also fires the fail-open `--ensure` above, so a hub you opted into
revives on the touches you already make.
