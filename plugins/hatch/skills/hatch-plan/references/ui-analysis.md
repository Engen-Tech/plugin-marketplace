# UI analysis methodology (conditional path)

Loaded by `hatch-plan` **only when the resolved stack has a UI surface** — a design mock or non-functional prototype as input, or a component-library / token system in the repo. Non-UI stacks (backend, CLI, data, library/SDK, IaC, ML, docs) skip this file entirely.

This is hatch's frontend analysis at full depth. It is the conditional UI path layered on top of the lean binder workflow — it does **not** replace the stack-agnostic synthesis. Its job is to feed the binder, not to write tickets:

- The **design analysis** and **codebase/library inventory** populate the facts every later step reads.
- The **component / icon / token mappings** populate each UI work item's `component_map`, `icon_map`, and `token_changes` fields.
- The **vertical-slice heuristics** drive the slice→work-item breakdown.
- The **S/M/L sizing** sets each UI work item's `estimate`.
- The view/route a slice renders sets its `design_reference`.

The output target is **binder fields**, not ticket sections. The table formats below — Component-to-Library Map, Icon Mapping, Design Token Map, Token Changes — feed cleanly into each UI work item's `component_map` / `icon_map` / `token_changes`; hatch emits binder JSON, not tickets. For DTCG token mechanics (tiers, name resolution, `<token-source-dir>`, `<token-build-command>`), see `dtcg-tokens.md`.

When this path runs, drive it from three read-only Explore passes (design analysis, codebase + library inventory, data-layer mapping) — run them in parallel where the host allows — then do the mapping and slicing yourself in the main thread.

---

## 1. Design analysis (Explore pass)  `ui:design`

Read the design export (and its sibling sources). Prefer individual `.jsx` files when present, then `combined.jsx`, then the inline `<script type="text/babel">` block in the HTML. Read the extracted tokens stylesheet if it exists. Report with exact `file:line` citations.

1. **Component inventory.** Every named component (PascalCase function or const):
    - Name.
    - Props (names + inferred types from usage).
    - Approximate complexity: trivial (<30 lines), moderate (30–100), complex (>100).
    - Dependencies on other design components (which it renders).
    - Local state (`useState` calls — what state, what drives it).

2. **Component hierarchy tree.** Containment from the root component down, e.g.:

    ```
    App > Sidebar > [NavItem, UserMenu, Avatar]
    App > Feed > [SignalCard > [Badge, Avatar, Icon], FilterChip]
    ```

3. **Page/view inventory.** Every distinct rendered "view" worth a slice. These come from `page === '<id>'` conditionals or a client-side router, but a single-screen export often drives views with `useState` **modes / panes / modals** instead (read pane vs edit pane, a settings pane, a confirm modal, a mobile-nav drawer). Treat each distinct rendered state as a view, whichever mechanism switches it:
    - Page/view ID (e.g. 'home', 'feed', 'projects').
    - Entry component name (e.g. `HomePage`, `Feed`).
    - Sub-views (e.g. projects has both pipeline and detail).
    - Components used exclusively by this view vs shared across views.

4. **Design-token inventory (with values).** Every CSS custom property from `:root` and the tokens stylesheet — report each token **with its value**, not just counts or naming conventions (the token-mapping step must classify each value as Direct/Close/No-match within ~2px / ~1 shade, impossible without the actual values). A hand-built design often tokenizes **only some categories** (commonly colors + fonts, maybe one radius) and uses **raw px/hex literals** for the rest; report both — defined tokens *and* recurring raw literals (with values and where they appear):
    - Colors: every custom property with hex/rgb value (note naming convention, e.g. `--gray-25` … `--gray-950`).
    - Spacing: scale values.
    - Typography: font families, size scale, weight scale.
    - Radius: scale values.
    - Shadows: elevation levels.
    - Semantic tokens (e.g. `--bg-primary`, `--fg-primary`, `--border-primary`).
    - **Theme contexts:** if the design defines alternate contexts (a `[data-theme="dark"]` / `.dark` block, or a separate dark stylesheet), report each token's value *per context*, not just `:root`. Also report whether the prototype can be *switched* into an alternate context at runtime (a theme toggle or `useState('theme'|'darkMode'|'colorScheme')`) — this decides whether a UI work item's oracle can request a full second design-validation loop (needs a switchable prototype) or only a smoke check.

5. **Mock-data shapes.** For each top-level data constant (e.g. SIGNALS, PROJECTS, TEAM, CONTACTS), report the TypeScript-like shape of one item with all fields and inferred types.

6. **Navigation structure.** How views relate: sidebar items, breadcrumbs, drill-down (list → detail), modal/dialog/slideout patterns.

---

## 2. Codebase + component-library inventory (Explore pass)  `ui:inventory`

Survey the frontend app and the project's component library/libraries. Report with `file:line` citations.

**Part A — frontend app:**

1. **Existing components.** Every component file under the app's components/routes directories — exports and purpose.
2. **Existing routes.** Map the router structure (file-based like Next.js App Router, or config-based like React Router / TanStack Router): how routes are declared, where layouts / loading / error boundaries live.
3. **Styles.** Stylesheet files, global tokens, font stack, styling approach (CSS Modules, CSS-in-JS, utility classes).
4. **Data layer.** GraphQL fragments/queries/mutations + codegen, REST clients, or generated types. Where operations are defined; any codegen config (e.g. openapi).
5. **Client state.** Stores (Redux, Zustand, Jotai, signals, context) and what they manage.
6. **Tests.** Test files, runner config, network-mocking setup.
7. **Library integration.** Is the component library imported anywhere? Is its provider/theme bootstrapped (theme provider in the root layout or a providers file)? If there is no library, note the project's local primitives instead.

**Part B — component-library catalog** (skip if no component library; instead catalog local design-system primitives):

Read the library from its installed location (e.g. `node_modules/<component-lib>/`) — the main export/type entry and any components directory. **If the install can't be enumerated** (minified, types-only, a remote/CDN system, or a nested pnpm store), fall back to the `.d.ts` type surface, published docs/README, or the doc site, and mark the catalog best-effort.

**Large-catalog handling.** Real icon sets (1,000+ exports) and component libraries are too large to carry in main-thread context. Write the full catalogs (component props, the complete icon export list, the token inventory) to scratch files and return a **summary plus the file paths**; the mapping steps read targeted sections on demand (e.g. grep the icon file for the design's icon names) rather than holding everything in context.

For each exported component, report: name; category (the library's own grouping: atoms/molecules/organisms/primitives, etc.); key props and types (especially `variant`, `size`, `color`, `type` enums); what it renders (button, card, input, badge, avatar, tooltip, table, menu, etc.).

Also catalog:

- **Icon libraries.** For each configured source (primary first, then fallbacks), list ALL available icon exports and the import pattern, so the icon-mapping step can resolve design icons to concrete imports. Note each library's props convention (size, color, standard SVG props).
- **Theme/token inventory (critical).** Read however the project exposes tokens — a theme object + its types, a CSS-variable map, a design-tokens file, or a utility-class config — and report the complete inventory:
    - **Colors:** every named color (and shade scale, e.g. 0–11) with hex values where readable.
    - **Spacing:** the full scale (named keys + px).
    - **Radius:** the full scale.
    - **Font sizes & line heights:** all named sizes.
    - **Shadows:** named elevation levels.
    - **Font family:** body and heading families.
    - **Custom/semantic tokens** the system exposes (and how they resolve to CSS variables or classes).

    **DTCG token systems — read tier/path/name from the JSON source, resolved values from the generated output.** When the project's token system is DTCG (see `dtcg-tokens.md`), take **token path**, **tier** (primitive/semantic/component), **emitted CSS variable name** (via the name-resolution `$extensions` key or path-derivation), and **alias target** from the JSON source; take the **resolved value per theme context** from the generated output (run `<token-build-command>` and parse it, or read a build-derived manifest) — do not hand-resolve aliases/overrides from the JSON. Also read the token dir's README/conventions doc and report the consumption rule (e.g. "consume semantic, never primitives") and any documented transitional-debt carve-outs. The token-mapping step depends on the tier and name fields to map to the *consumable* tier.

---

## 3. Data-layer mapping (Explore pass)  `ui:datalayer`

Read the project's data layer — a GraphQL schema, OpenAPI/REST spec, or generated TS types — and the design's mock-data shapes. **When there is no single contract artifact** (a REST/FastAPI/tRPC app may ship none), reconstruct the contract by triangulating both sides: the **client** (endpoint table + fetch signatures + request/response usage) and the **server** (route handlers + their types). Treat a loader/action data router (React Router loaders/actions, TanStack Router, Remix) as a **first-class fetch boundary**, not just component-level fetching. **If the project has no data layer at all**, document the data each design entity needs (entity name, fields, inferred types) — do not generate a mock layer here; the main thread decides handling during mapping. Report with `file:line` citations.

1. **Type coverage.** For each design data entity, map to the data layer's types using these buckets:
    - **Matched** — fields in both the design mock and the schema.
    - **Gap** — fields in the design mock with no schema equivalent.
    - **Unused** — schema fields not used by any design component (for awareness).
    - **Exists-but-differs** — present but semantically/format-mismatched (single-file vs zip; list vs paginated cursor; epoch vs ISO timestamp; a client-derived value vs a server-stored one).
    - **Field-level gap on an existing entity** — a missing field on an otherwise-present entity (note if it spans multiple in-scope views).

2. **Operation mapping.** For each view's data needs, which queries/endpoints serve them (e.g. a `searchSignals` query or `GET /signals` for the feed; `me`/`/me` for the current user).

3. **Schema gaps.** Entities in the design with NO corresponding type. List each with: entity name; which views depend on it; approximate field count.

4. **Fetch-boundary planning.** Derive the containment relationships from the design files, then report which components own data fetching / fragments (those directly consuming entity data) vs purely presentational. If the stack uses GraphQL fragment colocation, note which components would own fragments. Reconcile against the design analysis's full hierarchy.

---

## 4. Component-to-library mapping → `component_map`  `ui:components`

Do this yourself; don't delegate. For every design component, determine if it maps to a library component. Classify each:

| Classification | Meaning | Build impact |
|-|-|-|
| **Library match** | Maps directly to a library component | Use library component with props/variants — no custom code |
| **Library + wrapper** | Library covers 80%+ but needs a thin domain wrapper | Wrapper component that composes the library component |
| **Custom** | No library equivalent (or no library at all) | Full custom component plan |
| **Composite** | Assembled from multiple library components | Document the composition |

This mapping is the core UI output. Each UI work item's `component_map` carries the rows for the components in its slice.

Common UI-primitive correspondences (names vary by library — match by role, not name):

- Buttons → `Button` (check variant: primary/secondary/tertiary, color).
- Badges/tags → `Badge` / `Tag` / `Chip`.
- Avatars → `Avatar` / `AvatarGroup`.
- Tooltips → `Tooltip`.
- Inputs → `TextInput` / `Textarea` / `InputField`.
- Checkboxes/toggles → `Checkbox` / `Switch` / `Toggle`.
- Tabs → `Tabs`.
- Tables/lists → `Table` / `DataTable`.
- Dropdowns/selects → `Select` / `Combobox` / `MultiSelect`.
- Menus → `Menu`.
- Breadcrumbs → `Breadcrumbs`.
- Pagination → `Pagination`.
- Accordions → `Accordion`.
- Alerts/banners → `Alert` / `Banner` / `Notification`.
- Empty states → `EmptyState`.
- Slide-outs/drawers → `Drawer` / `SlideOut`.
- Command bar/search → `Spotlight` / `CommandBar` / `SearchBar`.
- Progress indicators → `Progress` / `ProgressRing` / `Stepper`.
- Date pickers → `DatePicker`.
- Section headers → `SectionHeader` / `Title`.
- Loading states → `Loader` / `Skeleton`.
- Icons → the project's icon libraries (see icon mapping below).

If the project has **no** component library, every primitive is **Custom** — the map becomes a build list.

Components that are typically **custom** (no library equivalent), regardless of library:

- Page-level layouts and view controllers.
- Domain-specific cards (SignalCard, ProjectCard, ContactCard).
- Domain-specific panels (detail views, slideout content).
- App chrome (Sidebar, TopBar) — though they may compose library primitives.
- Charts, timelines, kanban boards.
- Domain-specific filters and search.

Row format carried into `component_map`:

| Design Component | Library Mapping | Notes |
|-|-|-|
| Button | `Button` (variant="primary", color="brand") | Direct match |
| SignalCard | **Custom** — composes `Badge`, `Avatar`, `Tag` | Domain-specific |
| FilterBar | **Composite** — `Tabs` + `Badge` buttons | Tab nav + filter chips |

---

## 5. Icon mapping → `icon_map`  `ui:icons`

Every icon in the design maps to a concrete icon import. Designs reference icons by string name (e.g. `'radar'`, `'bell'`) via an `Icon` component — resolve each to a concrete icon (a React/Vue/Svelte icon component or an SVG sprite reference).

**Priority order:**

1. **Primary icon library** — check first.
2. **Fallback icon library** (if configured) — when the primary has no suitable match.
3. **Custom SVG** — only when no configured library has a match.

**Process:**

1. Inventory every unique icon name used in the design (`<Icon name="...">` calls and inline SVGs).
2. For each, check the primary library first; if no suitable match, check each fallback in order.
3. Carry an **Icon Mapping** table — with a **Source** column — in the `icon_map` of every UI work item that uses icons:

| Design Icon | Source | Import | Notes |
|-|-|-|-|
| `radar` | primary | `Signal01` from `<icon-lib>/…/Signal01` | Closest match to radar/signal |
| `bell` | primary | `Bell01` from `<icon-lib>/…/Bell01` | Direct match |
| `sparkle` | fallback | `{ Sparkles }` from `<fallback-icon-lib>` | No primary match |
| `drag-handle` | **Custom SVG** | — | No configured library has it |

4. **When no library has a match:** flag it prominently — a "Missing Icons" note in that item's `icon_map`, with the design usage context. The implementer needs a custom SVG. Do NOT silently plan custom SVGs without calling them out.

**Report to user:** after icon mapping, surface gaps. Example: "10 of 12 design icons mapped (8 primary, 2 fallback); 2 require custom SVGs: `kanban`, `drag-handle`." This lands in the Phase 6 report and the smart-surfaced review when it flags the item.

---

## 6. Design-token mapping → `token_changes` (and the shared `token_manifest`)  `ui:tokens`

**The project's token/theme system is the source of truth for all design tokens in the implementation.** The design's extracted tokens — whatever form (CSS custom properties, or a full DTCG system the *design* ships) — are the **spec of intended values**, not the implementation mechanism; never copy them verbatim into the app. Every design token maps back to a project token (theme key, CSS variable, or utility class). Don't conflate the design's token system with the project's: the project side always decides the mechanism, and the two can differ in kind. The DTCG-specific guidance below (tiers, `<token-build-command>`) is keyed to the *project's* token system; it does **not** apply when the project is non-DTCG, even if the design ships DTCG. See `dtcg-tokens.md` for the full asymmetry rules.

**Process:**

1. Read the project's token inventory (colors with shades, spacing, radius, font sizes, line heights, shadows, semantic tokens). Map **what the design tokenized**; for categories the design left as **raw literals** (common in hand-built designs), map each recurring literal onto the project's scale (`16px` → the `md` spacing token) or, if it has no scale fit and isn't reused, flag it as a one-off to confirm with the user.

2. For each design token category, map design values to project equivalents (the form depends on the system — a theme prop, a CSS variable, or a utility class):

    | Category | Design Token Example | Project Token Equivalent (form varies) | How to Use |
    |-|-|-|-|
    | Color | `var(--blue-700)` | brand/primary shade 7 — theme prop, CSS var, or class | Library color prop; the token in CSS |
    | Spacing | `var(--space-16)` / `16px` | the `md` spacing token | Spacing prop or token, not raw px |
    | Radius | `8px` / `var(--radius-md)` | the `md` radius token | Radius prop or token |
    | Font size | `14px` | the `sm` font-size token | Typography prop or token |
    | Shadow | `var(--shadow-sm)` | the `sm` shadow token | The shadow token |

    **Tiered (DTCG) token systems — map to the *consumable* tier.** When the project's token system has tiers, the project-token side of every mapping must be a token new code may consume — typically **semantic**, never primitives (design `--blue-700` → `semantic.color.accent`, *not* a raw ramp shade like `--p600`). Shade-ramp names are primitive-tier; `hatch-build` runs a deterministic check that flags primitive consumption in new code, so a map that resolves a design value to a primitive shade sends the implementer straight into a guaranteed conformance failure. If a design value matches *only* a primitive with no semantic equivalent, that is a **"no semantic match"** (classified "No match", then handled as a candidate new semantic token), not a direct mapping. Capture the tier of each project token mapped.

3. Classify each design token:

    | Classification | Meaning | Action |
    |-|-|-|
    | **Direct match** | Maps exactly to a project token | Use the project token/prop — document the mapping |
    | **Close match** | Within ~2px / ~1 shade of a token | Use the closest token — note the minor difference |
    | **No match** | No equivalent in the consumable tier | **Flag to user.** For a tiered system, offer the options below so the decision is build-actionable |

4. **Where it lands in the binder.** The full design→project mapping is the shared `token_manifest` at binder level (present only when a token system exists). Tokens a given UI work item must **add** — those with no consumable-tier match — go in that item's `token_changes`. Carry the rows on every item that consumes the token; do not make one item depend on reading another's. The `token_changes` row shape is: `Token (path → var) | Op | Value — base / <context> | Source file(s) | Covers | Auth`.

5. **When tokens don't map:** surface mismatches to the user before drafting items, and **record the decision in the item's `token_changes`** so the build skill can act without re-asking. For a tiered (DTCG) system, frame the options in the build skill's vocabulary:
    - **(a) Use the nearest existing token in the consumable tier** (note the delta).
    - **(b) Add an additive semantic-tier token** — alias to a named existing primitive when one matches, else a literal value; record per theme context. Do **not** alias a primitive in a documented transitional-debt block (it's re-pointed per context and the alias resolves wrong); use a literal with explicit per-context values. This is the one option the build skill can apply autonomously — record it as pre-authorization (token name, tier, alias-or-literal, per-context values, target source file).
    - **(c) Adjust the design** to use an existing token.
    - **(d) A new primitive, or mutating an existing token's value** — only when (a)/(b) won't do. These can **never** be applied autonomously by the build skill; mark them "requires build-time confirmation" or land them under explicit user approval.

    Example: "The design uses `--gray-25` (#FAFAFA); the project's `gray` ramp starts at `--n50` (#F8F9FA) and there is no semantic token for this surface. Options: (a) use `semantic.color.surface` (Δ ~2 in lightness), (b) add `semantic.color.surface-subtle` = `#FAFAFA` (literal; dark context: `<value>`), (c) nudge the design to `semantic.color.surface`?" Avoid "one-off override" — a hardcoded literal in component CSS collides with the Key rule and the build skill's conformance check.

**Key rule:** custom components must reference project theme tokens (theme variables / utility classes) — never hardcoded hex or px that duplicate what the token system already provides, so theme changes propagate everywhere. For a tiered (DTCG) system, "project theme tokens" means the **consumable tier only**; primitives are deny-listed for new code.

---

## 7. Slice → work-item breakdown and S/M/L estimate  `ui:slice`

Read all three Explore reports, then break UI work into work items using these vertical-slice heuristics:

1. **Foundation slice** (only if the component library + theme system aren't integrated yet): library/theme provider bootstrap + design-token setup + app shell. Such a setup item has no design view to validate — set its `design_reference` to `none`. Its scope is the foundation checklist:
    - Bootstrap the component-library provider with the project theme/token resolver.
    - Import the library's base stylesheet (if required).
    - Set up icon-library imports.
    - Configure fonts.
    - Verify project tokens cover the design's color/spacing/radius/shadow needs.
    - Add supplemental tokens **only** for design values with no project equivalent (document why). For a DTCG system, edit the JSON in `<token-source-dir>` (the right tier file, plus the per-context file for any context override) and run `<token-build-command>`; the generated artifacts are read-only.
2. **One slice per page/view** when the view has unique components. For a **one-page app** (no routes — views are `useState` modes/panes/modals), slice by **mode/pane/component boundary** (a read-pane slice, an edit-pane slice, a settings-pane slice; bundle a confirm modal per heuristic 6).
3. **Split list + detail** when both exist for an entity (Projects list vs Project detail).
4. **Complex reusable components** get their own slice when >100 lines in design and used across views.
5. **Cross-cutting features** (AI Assistant, global search) are separate slices.
6. **Dialogs/modals** that serve a single view bundle with that view.

Each slice becomes a work item that is independently implementable and verifiable — it should render something meaningful on its own. The view/route it renders sets its `design_reference`, and naming a view commits the slice to being checked against it: its `oracle` is a `visual` check that opens the view, or the item carries a `visual_check_waiver` naming the slice whose visual gate covers this view for it. A recorded waiver is the only way a view-naming slice is checked by something other than a rendered comparison. A slice with no view — a pure setup or foundation item — sets `design_reference` to `none` and takes the compile/type-check/lint floor. `validate_binder.py` rejects a slice that names a view and carries neither.

**Estimate each slice (S/M/L)** from its component count and the per-component complexity from the design analysis (trivial <30 lines / moderate 30–100 / complex >100):

- **S** — mostly library matches, ≤2 custom components, none complex.
- **M** — a few custom components or one complex one.
- **L** — many custom components or multiple complex ones, or list+detail in one slice.

This value sets the work item's `estimate`, feeds the Phase 4 cost-education check, and shows in the Phase 6 report.

---

## Reconciliation notes  `ui:reconcile`

- **Architectural-reversal check.** While slicing, watch for design elements that **conflict with or reverse a deliberate existing architectural decision** (the codebase survey plus any architecture/decision docs are the signal). Re-adding such a pattern is not a neutral detail — surface it as an explicit scope decision (implement as designed / keep the current architecture and adapt / descope) rather than silently planning the reversal. This is also a natural smart-surfaced-review flag.
- **Data-layer gaps.** For every design entity with no equivalent in the data layer, decide with the user: **stub** (mock data, mark the item blocked until backend lands), **exclude** (skip views depending on it), **include backend work** (add schema/resolver/endpoint work to the item — makes it larger and may add a serialized migration item), or **plan a canonical mock layer** (when the project has *no* data layer — a separate work item the UI items build against). Group related entities into one question.
- **Prototype-vs-target reconciliation.** Prototypes are often single-user, localStorage/in-memory mocks; the build target may be multi-user with real auth and server persistence. Reconcile the *semantics*, not just field shapes: ownership/visibility, concurrency, identity/auth, and persistence boundaries are gaps even when the shape matches. Handle **interactive-but-dataless** features (a validation-only form, a calculator, a filter UI with no backing entity) by noting them as such — no schema work, not a data gap.
