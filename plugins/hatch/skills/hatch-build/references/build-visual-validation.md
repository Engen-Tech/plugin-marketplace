# Visual-oracle acceptance path (full procedure)

Loaded by `hatch-build`'s acceptance loop (Phase 6, `build:acceptance`) when the work item's `oracle.type` is `visual`, and by its teardown (Phase 7, `build:teardown`) when this run started a dev server. A `hatch-verify` (non-visual) item skips this whole file.

## Contents
- The visual gate sequence (boundary-only pass, then `hatch-validate`)
- Dev-server lifecycle for the visual gate
- Phase 7 — Dev-server teardown (full procedure)

---

## The visual gate sequence

- **`oracle.type == visual`** → boundary gate first, then `hatch-validate`. First dispatch `hatch-verify` in **boundary-only mode** — it runs only the safety-auditor boundary gate on the diff (no acceptance phase) and must PASS before any dev-server work begins; a VIOLATION kicks back under the safety cap, a BLOCKED halts here. Only then does acceptance go to `hatch-validate`, which compares rendered output against the design (UI annex; resolve `<dev-server-port>`, the design source, and the item's `design_reference`). The per-round capture/compare mechanism `hatch-validate` uses is in **[references/design-validation-loop.md](references/design-validation-loop.md)**. Skip the `hatch-validate` gate when `design_reference` is `none` — the boundary-only pass still runs. **Before invoking `hatch-validate`, the app must be up** — bring it up per the dev-server lifecycle below.

## Dev-server lifecycle for the visual gate

**Dev-server lifecycle for the visual gate (conditional — `oracle.type == visual` only).** A `hatch-verify` (non-visual) item skips all of this. For a visual item, `hatch-validate` needs the app running before it can capture and compare, so bring it up here, before invoking the gate.

**First, honor a provided env.** The env may already be supplied by the binder's `env_contract` or by the orchestrator (a wave-bound env, started once and torn down once for the whole wave per [references/integration-branch.md](references/integration-branch.md)). When the wave env is present, use the env it exposes (`env_contract.command`, and `env_contract.isolation_params` such as `PORT` when `supports_isolation` is true) instead of starting your own — and **do not tear it down** (the orchestrator owns it). Only when the item is directly invoked with no provided env do you manage the dev server yourself, per the steps below.

Do not assume Bash, WSL, POSIX background syntax, `/tmp`, `curl`, `grep`, `lsof`, or `kill` exist on the developer machine. Use the host's native process and HTTP facilities, or a repo-owned helper script, and record the exact command/handle you used.

- **6-dev-a. Check port availability** with a host-native mechanism (a Python socket probe, a PowerShell TCP lookup, the project's dev-server status command, or the platform's equivalent). Check both `<dev-server-port>` and `<backend-port>` when the dev target starts a backend. **If something is already on either port, bail and ask the user to stop it first — never stop another process's dev server.** (This guards against *other* processes. When you must **restart** your own dev server — e.g. after a token rebuild or a degraded server mid-loop — first stop the recorded handle to free the port, then repeat these steps; otherwise this check sees your own still-running server and bails.)
- **6-dev-b. Start the dev server as a managed background process/session.** Record its process id or host process handle (call it `DEV_SERVER_PID` or the host equivalent), plus its log location. Do not use POSIX `&` unless the host shell is known to support it. If the dev target transitively starts a backend/API service (resolved in Project configuration), that service comes up on `<backend-port>` too — both are needed when the view depends on the backend for data. Note that port for the teardown (`build:teardown`).
- **6-dev-c. Health-poll the actual `design_reference` route** (not just `/`) with a host-native HTTP client until it returns an expected status such as `200`, `307`, or `308` — many dev servers compile/warm pages on demand, so `/` warming proves nothing about the target view. Use an explicit retry limit around **60 seconds** and capture failure output. If the route is not responding after ~60s, stop the recorded handle and bail with the error (common causes: port conflict, a build error the floor didn't catch, missing env vars). **A bare 2xx/3xx is not proof the view rendered when it's behind auth** — an unauthenticated request to a protected route can return `200` on a login page or `3xx` to `/login`, passing this poll while the target view is still unreachable. If the route requires authentication, detect the auth-redirect / login-page response here and treat establishing a logged-in session (and ensuring any backend service the view needs is up) as a `hatch-validate` prerequisite, not something this poll satisfies — see [references/design-validation-loop.md](references/design-validation-loop.md) (`dvl:invoke:auth`).
- **6-dev-d. Store the recorded handle** (`DEV_SERVER_PID` and `<backend-port>`, if any) for the teardown (`build:teardown`).

## Phase 7 — Dev-server teardown (full procedure)

Corresponds to `build:teardown` in the core SKILL.md — that phase header carries the label; this section is its full body.

**Conditional — visual items that started a dev server.** A non-visual item is a no-op here. **Always runs when this run started a server**, regardless of outcome — whether the skill succeeded, failed at a gate, or errored after bring-up, the ports it opened must be freed. Structure the teardown to run on every exit path after the acceptance loop's bring-up (`build:acceptance`).

Stop **only the process or process tree this run started**, using the host's native process handle (the `DEV_SERVER_PID` recorded in 6-dev-b/d). If the port is still held afterward, clean up an orphan only when you can prove it was spawned by this run's recorded dev command — **never stop an unrelated process** that happens to bind the same port (the mirror of 6-dev-a's "do not stop another process's dev server"). Apply the same guard to `<backend-port>` when the dev target started a backend/API service: stop only what this run started, then free the backend port too.

**Do not tear down a provided env.** When the acceptance loop (`build:acceptance`) used a wave-bound env from the binder's `env_contract` / the orchestrator instead of starting its own server, leave it running — the orchestrator owns its lifecycle and tears it down once for the whole wave (see [references/integration-branch.md](references/integration-branch.md)). This phase only stops servers *this run* started. If the skill exited before the acceptance loop (`build:acceptance`) brought up a server (e.g. at the input gate `build:gate`), this phase is a no-op. (Port-conflict and process-handling details also live in [references/design-validation-loop.md](references/design-validation-loop.md).)
