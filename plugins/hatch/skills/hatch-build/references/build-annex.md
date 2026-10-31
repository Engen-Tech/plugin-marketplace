# Build annex — conditional-feature gotchas

Rules that left `SKILL.md`'s core Gotchas list to keep the always-loaded file under its
byte cap (see the `deliver-preflight` binder item). Every rule below still applies in
full — nothing here is advisory or superseded — it is simply not part of the core text
every build reads regardless of which features an item touches. A non-UI, non-greenfield,
single-toolchain-root item will not need any of these; an item that does should open this
file the way it would open `references/build-ui-data.md` or `references/build-greenfield.md`.

- **UI rules are conditional.** Component/icon/token rules and the visual `hatch-validate` loop apply only when the item carries a UI surface — full rules in [build-ui-data.md](build-ui-data.md) and [build-visual-validation.md](build-visual-validation.md). A backend / CLI / data / IaC item skips both.
- **The visual gate is expensive and capped.** Each `hatch-validate` round can spawn a browser session; don't exceed the cap — see [build-visual-validation.md](build-visual-validation.md).
- **Data-layer conformance is read-only, isolated, and conditional.** Full procedure (validator contract, per-round structure, skip conditions) is in [build-ui-data.md](build-ui-data.md).
- **The visual gate needs the app up on the actual route, not `/`.** Bring-up, health-poll, and auth-detection details are in [build-visual-validation.md](build-visual-validation.md).
- **Never stop another process's dev server.** Bring-up bails on a taken port; teardown stops only its own recorded handle and leaves a wave-bound env alone — full guard in [build-visual-validation.md](build-visual-validation.md).
- **Tool-imposed runtime floors are mode-gated.** Greenfield may pin a compatible tool version; edit mode halts with a CTA. See [build-greenfield.md](build-greenfield.md). Pinning a tool ≠ selecting a runtime — hatch never does the latter.
- **Multi-root oracles use the runner's own root-targeting, never a shim.** A polyglot/multi-root repo drives each toolchain from its own root via `npm --prefix <dir>` / `pnpm -C <dir>` / `make -C <dir>` / `nx run <proj>:<target>` (full table in [binder-reference.md](binder-reference.md), "Execution context"), or sets the oracle `cwd` per segment. Inventing a root `package.json` or a `bin/` shim to make a bare command resolve is the anti-pattern the cwd + runner-targeting design exists to prevent.
- **Greenfield items scaffold, then provision the named check.** Full rules (generator allowance, bounding, re-resolving the toolchain, provisioning a named check) are in [build-greenfield.md](build-greenfield.md). A check that exists but fails is always a real failure, never the absent-check carve-out.
