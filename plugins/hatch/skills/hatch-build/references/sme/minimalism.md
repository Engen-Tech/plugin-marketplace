---
name: minimalism
description: Write the least code that works; don't over-build
always: true
see_also: ["platform-native"]
---
## The ladder (advisory — shapes how you write, never gates)
Stop at the first rung that holds:
1. Does this need to exist at all? Speculative need = skip it, say so in one line (YAGNI).
2. Stdlib does it? Use it.
3. Native platform feature covers it? Use it (see platform-native).
4. Already-installed dependency solves it? Use it. Never add a new dependency for what a few lines do.
5. Can it be one line? One line.
6. Only then: the minimum code that works.

## Never simplify away (safety floor)
Validation at trust boundaries, error handling that prevents data loss, security, accessibility basics, anything explicitly requested, and hardware calibration knobs are never on the chopping block. Lazy means less code, not a flimsier algorithm.

## Patterns (advisory)
- No unrequested abstractions: no interface with one implementation, no factory for one product.
- Deletion over addition; boring over clever; fewest files; shortest working diff.

## Review checklist (enforced — diff-checkable only)
- [ ] min.1 — No new third-party dependency where the stdlib or platform already ships it — name the dep and the native equivalent (see platform-native).
- [ ] min.2 — No abstraction with a single implementation/caller added speculatively (interface, factory, wrapper that only delegates).
- [ ] min.3 — No new config key, flag, or option that nothing reads.
- [ ] min.4 — Non-trivial new logic (a branch, loop, parser, money/security path) leaves one runnable check (an `assert`-based self-check or one small test).
