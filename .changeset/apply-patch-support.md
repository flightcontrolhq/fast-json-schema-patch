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
