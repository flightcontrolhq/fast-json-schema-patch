---
"fast-json-schema-patch": minor
---

Packaging, types, and diagnostics improvements:

- The `fast-json-schema-patch/aggregators` subpath now actually resolves (it previously pointed at files the build never produced, failing under every module system). `StructuredDiff` remains re-exported from the root; importing only the patcher no longer pulls in `json-source-map` (`"sideEffects": false` added, formatting stack split into its own chunk).
- `execute()` is now typed as returning `DiffOperation[]` — a discriminated union of exactly what the differ emits (`add`/`remove`/`replace`, plus `move` under `emitMoves`), so exhaustive switches no longer need impossible branches. The wide RFC 6902 `Operation` type remains for `applyPatch` inputs.
- Library diagnostics no longer write to the console: `buildPlan` accepts an `onWarning` option and the root exports `setWarningHandler` for the formatting-layer warnings (default: silent).
- `typescript` is no longer a peerDependency (it was force-installed into consumers by npm 7+); it is a devDependency.
