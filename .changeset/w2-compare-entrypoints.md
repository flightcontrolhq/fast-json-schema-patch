---
"fast-json-schema-patch": minor
---

Add one-call `Compare`/`CompareJSON` entry points to the Go engine, and complete the W2 wave's
user-facing surface (these entry points plus `ignorePaths`, released separately).

- **Go:** `schemapatch.CompareJSON(schema, original, modified []byte, opts ...PatcherOption) ([]Operation, error)` decodes all three documents through the ordered `Decode` (full §2.2 determinism guarantees apply), derives a `Plan` from `schema` (`nil` = schemaless), and runs `Patcher.Execute` in one call. `schemapatch.Compare(schema, source, target any, opts ...PatcherOption) ([]Operation, error)` does the same for arbitrary typed Go values (structs, maps, slices), marshaling each with `encoding/json` before delegating to `CompareJSON` — struct fields marshal in declaration order, maps marshal key-sorted. Both give Go callers the `wI2L/jsondiff`-style ergonomics of a single diff call, while the `Plan`+`Patcher` ordered-`Value` pipeline remains available for plan reuse and non-default `BuildPlanOptions`. Both forward their trailing `opts` to `NewPatcher`, so `IncludeOldValue`, `EmitMoves`, `WholesaleReplaceFallback`, and `IgnorePaths` all compose with them exactly as they do with the lower-level pipeline.
- **ignorePaths** (previously released): a set of object-member JSON Pointers whose subtrees are treated as equal in both directions, on both engines — see the `ignorePaths` changeset for the full capability description.

The root `README.md`'s "How it compares" section documents both engines' entry points (typed-value vs. raw-JSON) against `wI2L/jsondiff`, `fast-json-patch`, `jsondiffpatch`, and `rfc6902`.
