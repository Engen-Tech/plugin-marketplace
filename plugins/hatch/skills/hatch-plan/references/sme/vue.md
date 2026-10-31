---
name: vue
description: Vue 3 do's and don'ts, scoped to the project's API style, build setup, and language
match: ["vue", "@vue/runtime-core", "@vitejs/plugin-vue"]
see_also: ["platform-native#html-elements", "platform-native#css-capabilities", "platform-native#javascript-browser-apis"]
---
## Applicability
Vue supports the Options and Composition APIs, with or without a build step. *SFC+build* rules apply only to `.vue` components compiled by a build step (Vite, vue-loader); *TypeScript* rules only to TypeScript. A no-build global-build app or an Options API codebase is a supported style, judged by the unmarked rules. On Vue 2 (detect_stack `versions`) read lifecycle hooks by their Vue 2 names; `<script setup>` needs 2.7+.

## Do
- *SFC+build*: use `<script setup>` for Composition API components; *TypeScript*: type props and emits with `defineProps<…>()` / `defineEmits<…>()`. Without a build step, use the Options API or `setup()` — macros need the SFC compiler.
- Use `ref` / `reactive` / `computed` for state and `watch` / `watchEffect` for side effects; clean up listeners/timers in `onUnmounted`. Watchers created synchronously in `<script setup>` auto-dispose on unmount; only watchers created outside setup scope (detached, `effectScope`, module level) need their stop handle called.
- Extract reusable stateful logic into composables (`useXxx`), one concern each.
- Give every `v-for` a stable `:key`.
- Scope component styles (`<style scoped>`) or use CSS modules.

## Don't
- Don't switch a new component away from the project's established API style; don't reach for `this` in `<script setup>`.
- Don't mutate props; emit an event or use `v-model` with a declared prop.
- *TypeScript*: don't use `any`; type props, emits, refs, and composable returns.
- Don't put heavy logic in templates; move it to a `computed` or a method.
- Don't manipulate the DOM by hand (`document.querySelector`, manual `innerHTML`) when a binding or directive will do — and never set unsanitized HTML.

## Patterns
- Smart/presentational split: container components own data and effects; presentational components take props and emit events (props down, events up).
- Composables for cross-component logic; co-locate a component with its test.
- Prefer the native platform before a dependency (see platform-native).

## Review checklist
- [ ] vue.1 — *SFC+build*: in a project whose `.vue` components are compiled by a build step and written in the Composition API, new components use `<script setup>`. Options API code passes — it is a supported style — and so does no-build code, where `<script setup>` is unavailable.
- [ ] vue.2 — *TypeScript*: `defineProps` / `defineEmits` are typed (no untyped props or emits). JavaScript projects pass; the rule never requires adopting TypeScript.
- [ ] vue.3 — *TypeScript*: no `any` in changed component/composable signatures. JavaScript projects pass.
- [ ] vue.4 — Every `v-for` has a stable `:key`.
- [ ] vue.5 — No prop mutation — state changes go through an emit or a local `ref`.
- [ ] vue.6 — Every added listener/timer has matching teardown (`onUnmounted`, or `beforeUnmount`/`unmounted` in the Options API), and every `watch`/`watchEffect` created outside component setup scope (detached, `effectScope`, module level) has its stop handle called — watchers created synchronously in `<script setup>`/`setup()` or through the `watch` option auto-dispose and are exempt.
- [ ] vue.7 — `v-html` is only fed sanitized content (a sanitizer such as DOMPurify in the same path) — never raw user input.
- [ ] vue.8 — No date/color/range/time-picker dependency where a native `<input type=…>` covers it (see platform-native).
