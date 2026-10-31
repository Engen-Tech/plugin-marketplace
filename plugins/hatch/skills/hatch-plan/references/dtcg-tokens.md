# DTCG token systems — planning settings

Loaded by `hatch-plan` only when the **Token/theme system** is a W3C DTCG design-token file. Resolve these extra settings so Phases 2, 4a.2, 4c, and the ticket's **Token Changes** section author tier-correct, build-actionable guidance.

### DTCG token systems (extra settings, resolved only when the token system is DTCG)

When the **Token/theme system** is a design-token file in W3C DTCG format (JSON leaves carrying `$value`/`$type`, usually alongside a token build tool such as Style Dictionary / Terrazzo and a build script), resolve these additional settings so Phases 2, 4a.2, 4c, and the ticket's **Token Changes** section can author tier-correct, build-actionable token guidance. (These mirror the implementation skill `hatch-build`'s DTCG settings — keeping the two in sync is what lets a plan-authored token addition be applied without re-asking the user at build time.)

| Setting | What it is | How to resolve |
|-|-|-|
| `<token-source-dir>` | The DTCG JSON files — the only editable token surface | Detect from the build script's `source` config, or glob for `$value`-bearing JSON |
| `<token-build-command>` | Regenerates artifacts from the JSON | Detect from package scripts (e.g. `build:tokens`) |
| `<generated-token-artifacts>` | Build outputs (e.g. a generated `tokens.css`) — read-only; tickets must never hand-edit them | Detect from the build script's output path or a "GENERATED" header |
| Tier convention | Which tiers exist (primitive/semantic/component) and which one new code may consume | Read the token dir's README/conventions doc; a common rule is "consume semantic, never primitives", including documented transitional-debt carve-outs |
| Name-resolution rule | How a token path maps to the emitted variable name — often a vendor `$extensions` key (e.g. `com.<project>.cssName`), else path-derived | Scan `$extensions` keys on a few tokens; the key is project-specific — never assume one |
| Theme-context selector | How alternate contexts are activated (e.g. `[data-theme="dark"]`, a `.dark` class, `prefers-color-scheme`) | Detect from the build config's per-context selectors and the source files (e.g. a `semantic.dark.json`) |

### Design token system vs project token system (asymmetry)

This file's settings apply **only when the PROJECT's token system is DTCG**. The *design* export's token format is independent of that and must not be conflated with it:

- **The design's tokens are the spec of intended values; the project's token system is the authority for how to express them.** This holds whether the design ships loose CSS custom properties, raw literals, or its own full DTCG token system.
- **Project DTCG, design anything:** the rules above apply — map design values onto the project's consumable tier, route gaps through Token Changes, edit `<token-source-dir>` and run `<token-build-command>`.
- **Project NON-DTCG (a component-library theme object — e.g. a Vuetify / PrimeVue / MUI / Chakra theme — CSS variables, a Tailwind/UnoCSS config, or plain CSS), design ships DTCG:** the design's DTCG JSON is read as a value spec only. Map each design value into the project's mechanism (theme keys / variables / classes). Do **NOT** import the design's DTCG JSON, do **NOT** load this file's DTCG settings, and do **NOT** emit a Token Changes section — its tier/manifest/autonomous-add/`<token-build-command>` machinery is keyed to a *project* DTCG system that doesn't exist here. Gaps are handled as plain theme-key additions per the project's convention.
- **Adopting the design's DTCG system into a non-DTCG project is a separate foundation decision** — surface it to the user in Phase 4c as an explicit scope question ("the design ships a DTCG token system; the app uses a theme object / CSS variables — keep mapping values into the existing mechanism, or adopt a DTCG pipeline?"). Never assume the adoption; the default is to map values into the existing mechanism.
