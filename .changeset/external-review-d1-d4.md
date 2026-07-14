---
"fast-json-schema-patch": patch
---

Correctness fixes from an external review of the reference engines (defects D1–D4):

- **Empty array vs empty object are no longer treated as equal (D1).** The memoized equality fast path treated `[]` and `{}` as equal (both have zero members), so a diff like `{x: [[], {}]}` → `{x: [{}, []]}` silently emitted **zero** operations. An array is now never equal to an object regardless of contents, so such changes are diffed correctly.
- **Malformed JSON Pointers are now rejected (D2).** A non-empty pointer without a leading `/` (e.g. `path: "foo"` instead of `/foo`) previously aliased to the document **root** — `applyPatch({foo: 1}, [{op: "replace", path: "foo", value: 2}])` overwrote the whole document with `2`. Such pointers now throw `JsonPatchError` with code `INVALID_POINTER` (per RFC 6901), on both `path` and `from`, for all six operations.
- **`getValueByPath` no longer returns stale values after in-place mutation (D3).** Its path-resolution cache was keyed on object identity and never invalidated, so mutating a document in place and re-resolving returned the pre-mutation value. The cache (which measurably did not pay for itself once made correct) was removed; resolution is always fresh. This affects the `StructuredDiff` aggregator.
- **`test` operations now require a `value` (D4).** Per RFC 6902 §4.6 a `test` op must carry `value`; a `test` with no `value` is now rejected with `INVALID_OPERATION` (previously it threw the wrong code, or — treating an absent value as `null` — wrongly passed against a `null` target). A `value` explicitly present as `null` is still valid and tests against `null`. Missing-required-field checks are also correctly ordered ahead of pointer and existence checks.
