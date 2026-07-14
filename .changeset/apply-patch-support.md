---
"fast-json-schema-patch": minor
---

Add patch application and inversion (closes #1), plus three generator correctness fixes.

New APIs, exported from the package root:

- `applyPatch(document, patches, options?)` — applies all six RFC 6902 operations (`add`, `remove`, `replace`, `move`, `copy`, `test`) plus this library's extensions (`-` append paths; optional `oldValue` validation via `validateOldValues`). Immutable with copy-on-write structural sharing, atomic (throws `JsonPatchError` with a machine-readable `code`, the failing `operation`, and `operationIndex`, leaving the input untouched), and guards against prototype-pollution pointer segments. Options: `validateOldValues`, `cloneValues`, `cloneResult`.
- `invertPatch(document, patches)` — computes an undo patch from the original document, correctly inverting `-` appends, overwriting `add`/`move`/`copy` operations, and root replacements.
- `toRfc6902(patches)` — strips the non-standard `oldValue` fields for strict third-party consumers.

Generator fixes:

- Emptying a root-level array previously emitted unappliable `remove` ops with path `"/"` (index dropped) and no `oldValue`.
- Object keys containing `/` or `~` are now escaped per RFC 6901 in generated patch paths (previously they produced wrong or unresolvable pointers).
- The LCS equality cache key no longer collides for arrays with ≥65,536 elements (previously could silently drop or corrupt changes in very large arrays).
- `buildPlan` now validates its input `plan` (a helpful `TypeError` instead of a cryptic runtime crash when `plan` is missing or not a `Map`).
- `Date`, `RegExp`, `Map`, and other non-plain-object values are now compared as opaque leaves instead of silently comparing equal (two different `Date`s previously produced no patch at all).
- `StructuredDiff`'s remove-path-relativization fallback no longer fails to match numeric array indices (a regex built from an untagged template literal was cooking `\d` to a literal `d`).
- Module-level memoization caches (equality, stringify, path resolution) are now epoch-scoped per `execute()` call, so mutating a document in place between diffs no longer returns a stale cached verdict.
- Large single-array diffs (roughly ≥125k operations) no longer crash with `RangeError: Maximum call stack size exceeded`; op groups are now emitted with loops instead of spread arguments.
- The `primaryKey` array strategy now falls back to LCS for arrays containing non-object elements, elements missing the key field, or duplicate key values — previously such arrays silently lost items or produced a patch that mutated an already-identical array.
- `basePath` now matches on a path-segment boundary instead of a raw string prefix (a `basePath` of `/env` no longer wrongly captures a sibling `/envelope`).
- Nested arrays (arrays of arrays) now get distinct plan paths, so an inner array's schema no longer silently overrides an outer array's plan.
- Primary-key/hash-field detection now traverses schema nodes that omit an explicit `type: "object"` and merges `allOf` branches, so keys and required fields declared only inside `allOf` are no longer missed.
