---
name: angular
description: Angular architecture do's and don'ts
match: ["@angular/core", "@angular/cli", "angular"]
see_also: ["platform-native#html-elements", "platform-native#css-capabilities"]
---
## Versions
Rules naming a version apply by the project's `@angular/core` major, read from detect_stack's `versions` (the lockfile when a range spans majors). Where the framework default already gives the required behavior, the inherited default satisfies the rule. An older project is judged by the rules for its version, not flagged for being on it.

## Do
- Use standalone components, directives, and pipes (v14+); avoid declaring them in NgModules. From v19 standalone is the default, so omit `standalone: true`.
- Use signals (`signal`, `computed`, `effect`; v16+) for local component state; prefer the `inject()` function over constructor injection.
- Use OnPush change detection: the default from v22; before v22 set `changeDetection: ChangeDetectionStrategy.OnPush`.
- Use typed reactive forms (`FormGroup`/`FormControl` with explicit types) for non-trivial input.
- Clean up subscriptions with `takeUntilDestroyed()` or the `async` pipe; prefer the `async` pipe over manual subscription.
- Lazy-load feature routes with `loadComponent` / `loadChildren`.

## Don't
- Don't put logic in templates beyond simple expressions; move it to the component or a pipe.
- Don't use `any`; type inputs, outputs, and service results.
- Don't subscribe to a long-lived observable without a teardown path; a single-shot finite observable (e.g. an `HttpClient` request) completes on its own.
- Don't mutate `@Input()` values; treat inputs as read-only.
- Don't reach into the DOM with `ElementRef.nativeElement` when a binding or directive will do.

## Patterns
- Smart/presentational split: container components own data and effects; presentational components take inputs and emit outputs.
- One responsibility per service; provide app-wide singletons with `providedIn: 'root'`.
- Co-locate a component's template, styles, and spec with the component.

## Review checklist
- [ ] ng.1 — No `any` in changed component/service signatures.
- [ ] ng.2 — Every new component uses OnPush change detection. On v22+ the inherited default satisfies this — an explicit OnPush declaration is allowed but not required, and opting into `Eager`/`Default` misses. Before v22 (or when the version is unknown) the component declares `changeDetection: ChangeDetectionStrategy.OnPush`.
- [ ] ng.3 — No `.subscribe()` on a long-lived or multi-emission observable without `takeUntilDestroyed()` (v16+), an `async` pipe, or an explicit unsubscribe — a single-shot finite observable (e.g. an `HttpClient` request) that completes on first emission is exempt.
- [ ] ng.4 — New components/directives/pipes are standalone, not added to an NgModule's `declarations`. On v19+ the default makes them standalone (`standalone: true` not required; `standalone: false` misses); on v14–v18 they declare `standalone: true`; before v14 this rule does not apply.
- [ ] ng.5 — No business logic embedded in a template expression.
- [ ] ng.6 — No date/color/range/time-picker dependency where a native `<input type=…>` covers it (see platform-native).
