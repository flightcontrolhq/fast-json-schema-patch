---
"fast-json-schema-patch": minor
---

P3 compactness work: granular LCS descent by default, plus four new opt-in capabilities for smaller/leaner patches (`includeOldValue`, `emitMoves`, `wholesaleReplaceFallback`) and configurable primary-key detection (`primaryKeyCandidates`).

**Default-behavior change (not opt-in):** when an LCS-diffed array element is replaced by another value of the *same kind* (both plain objects, or both arrays), the differ now recurses into it and emits granular nested operations instead of one whole-item `replace` carrying the complete old and new value. A single-field change on a large array element now costs roughly the size of that field instead of ~2x the whole element (measured up to ~23x smaller in the audit's repro shapes). This is the one output-shape change in this release that isn't behind a flag — every other default-mode patch is byte-for-byte unchanged from the pre-release generator.

New `JsonSchemaPatcher` constructor options (all default to the pre-release behavior — omitting them changes nothing):

- `includeOldValue?: boolean` (default `true`) — set to `false` to omit the non-standard `oldValue` field from every `remove`/`replace` op, for smaller, stricter RFC 6902-shaped patches. Measured 26–51% smaller on typical remove/replace-heavy diffs, up to ~86x smaller when a large subtree is removed. `invertPatch` still works without `oldValue` present, since it recovers prior values from the original document you pass it.
- `emitMoves?: boolean` (default `false`) — set to `true` to express a relocated (unchanged) array element as a single RFC 6902 `move` instead of a remove+add pair, across all three array strategies. Also upgrades the `unique` and `primaryKey` strategies to reconstruct the modified array's order exactly (previously `primaryKey` was order-insensitive: survivors kept their original relative position and new items were appended at the tail). Measured: a relocated ~600B item drops from ~1.3KB (remove+add) to ~40B (move); a 50-element array rotation drops from 50 replace ops to a single move.
- `wholesaleReplaceFallback?: boolean` (default `false`) — set to `true` to cap a heavily-rewritten array's patch size: if the estimated size of the granular ops for one array would exceed the array's own serialized size, the differ emits a single whole-array `replace` instead. Applies independently to every array, including nested ones. Small/typical diffs are unaffected — only near-complete rewrites trigger it.

New `buildPlan` option:

- `primaryKeyCandidates?: string[]` (default `["id", "name", "port"]`, unchanged) — override the ordered field-name candidate list used to auto-detect an array's primary key. Pass `[]` to disable auto-detection entirely for arrays without an explicit `primaryKeyMap` entry, keeping them on the `lcs`/`unique` strategy instead of (sometimes wrongly) matching on a mutable field like `name`.

All new options are additive and default to identical output; only the granular-descent change above affects default-mode patches.
