---
"fast-json-schema-patch": minor
---

Add the `ignorePaths` generator capability (wI2L/jsondiff parity) to both the TypeScript and Go engines.

`ignorePaths` is a set of object-member JSON Pointers whose subtrees are treated as **equal in both directions** — no operations are emitted at or beneath a matched location, in any array strategy. It is opt-in and, when absent, output is byte-for-byte identical to before.

- **TS:** `new JsonSchemaPatcher({ plan, ignorePaths })`. An invalid pointer throws a `TypeError` at construction.
- **Go:** `schemapatch.NewPatcher(plan, schemapatch.IgnorePaths(...))`. `NewPatcher` now returns `(*Patcher, error)`; the error is non-nil only for an invalid `IgnorePaths` pointer (or one that would ignore a plan `primaryKey` field), and always nil otherwise.

Semantics (SPEC §5.10): pointers are matched by a trie threaded in parallel with the plan trie; an array level is matched by a `*` wildcard (so `"/users/*/updatedAt"` ignores every user's `updatedAt`), object members match exact-then-wildcard. Two items differing only in ignored fields compare equal, so they collapse to nothing (or, under `emitMoves`, a single `move`) instead of a spurious remove+add. `wholesaleReplaceFallback` is disabled for any array with an ignore path beneath it so ignored content can never leak through an ancestor replace. A plan's `primaryKey` field may not be ignored. Round-trip contracts hold modulo the ignored subtrees.
