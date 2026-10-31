---
name: go-naming
description: Go naming do's and don'ts (identifiers, packages, files, receivers, interfaces)
match: ["go"]
---
## Do
- camelCase unexported, PascalCase exported; export only what another package needs (a main package exports nothing — reflection-read struct fields excepted).
- Keep initialisms one case throughout: userID, APIKey, HTTPClient, parseXML — never userId/ApiKey/HttpClient.
- Scale name length with distance from declaration: single letters in tight range/loop bodies; descriptive names for wider scope.
- Package names: short, all-lowercase ASCII, ideally one word that names the contents (orders, slug); concatenate if unavoidable (ordermanager).
- Receivers: 1–3 chars abbreviating the type (c, cus, hs), same name on every method of the type.
- One-method interfaces: method + -er (Reader, Authorizer); honor canonical names/signatures (String, Read, Close — same name only with same meaning).
- Getters drop Get (Owner()); setters keep Set (SetOwner()).
- Sentinel errors: ErrFoo vars; FooError types.

## Don't
- Don't shadow builtins (any, min, max, len, clear, …) or packages the file imports.
- Don't stutter the package name at the call site: customer.New, not customer.NewCustomer; customer.Address, not customer.CustomerAddress.
- Don't embed types in names (fullNameString, resultSlice) — except conversion pairs (userID / userIDStr).
- Don't name packages after Go-special directories (internal, vendor, testdata) or catch-alls (util, helpers, common, types) — split by focus instead.
- Don't use this/self/me as receivers.
- Don't prefix files or packages with _ or . (invisible to the go tool).

## Patterns
- Filenames: lowercase, ideally one word; multi-word names concatenate or underscore (routingindex.go, routing_index.go — stdlib does both); _ also marks special suffixes.
- Breaking a convention is deliberate: mirroring an external system's identifiers is acceptable when it makes intent clearer — note the reason at the site.

## Review checklist
- [ ] goname.1 — Changed identifiers use camelCase/PascalCase (no snake_case or SCREAMING_SNAKE) and keep initialisms one case (userID, HTTPClient, parseXML); Test/Benchmark/Fuzz names may carry underscores after the prefix (TestFoo_bar).
- [ ] goname.2 — New exports are justified in the diff — a consumer in it or its tests, or the declared contract/library surface; main packages export only reflection-read struct fields.
- [ ] goname.3 — No new identifier shadows a builtin of go.mod's `go` version (any, min, len, …) or a package the file imports.
- [ ] goname.4 — No type names embedded in new identifiers, except conversion pairs (userIDStr).
- [ ] goname.5 — New packages are short lowercase single words naming their contents — no catch-alls (util, helpers, common, types), no Go-special names (internal, vendor, testdata), no stdlib package name (strings, fmt, errors).
- [ ] goname.6 — New exported names don't repeat their package name (customer.New, not customer.NewCustomer).
- [ ] goname.7 — Receivers are short type-derived abbreviations (typically 1–3 chars), consistent with the type's existing receiver, never this/self/me.
- [ ] goname.8 — Getters carry no Get prefix; setters are Set-prefixed.
- [ ] goname.9 — New filenames are lowercase; underscores only as word separators or special suffixes (_test.go, GOOS/GOARCH); no _ or . prefix.
- [ ] goname.10 — New sentinel errors are named ErrFoo; new error types FooError.
