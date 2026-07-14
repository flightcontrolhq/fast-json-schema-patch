---
"fast-json-schema-patch": minor
---

P2 performance work: cheaper object-key visitation, hoisted schema-aware equality overhead, and smaller plans.

- `diffObject` no longer allocates `new Set([...keys1, ...keys2])` per object node visited; a two-pass walk (original's own keys, then modified's own keys skipping ones already own-present on original) produces the identical SPEC §5.2.2 visitation order with zero temporary collections (~4-5x faster per node on a micro-benchmark).
- `deepEqualSchemaAware`'s per-call overhead (rebuilding a plan-fingerprint string and re-deriving effective hash fields, including an O(k^2) field-inference fallback) is now hoisted once per array diff and passed down, instead of being recomputed on every element pair. This is the dominant cost of `diffArrayLCS`'s common-prefix/suffix trim for arrays that carry a schema plan (measured ~10x on a worst-case benchmark: a 50k-item array whose plan has neither `hashFields` nor a `primaryKey`). Also removed an unreachable `deepEqualSchemaAware` branch in `diffArrayByPrimaryKey` that a missing argument at its only call site made permanently dead code.
- `ArrayPlan.itemSchema` (the resolved item schema, previously stored on every array's plan entry) is no longer populated by `buildPlan`. Nothing at diff time ever read it; retaining it pinned the parsed schema graph in memory for the plan's lifetime (measured ~2x plan memory on `schema/schema.json`). The field remains on the exported `ArrayPlan` type, marked `@deprecated`, for any 0.x consumer reading it directly — it will always be `undefined` going forward.

All three changes are output-neutral: no emitted patch changes as a result of this work (verified by the existing test suite, plus targeted benchmarks under `scratchpad/bench/` comparing before/after against the prior commit).
