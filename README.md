# fast-json-schema-patch

🚀 Ultra-fast, Schema-Aware JSON Patch Generation with Human-Readable Diffing

fast-json-schema-patch is a high-performance JSON patching library designed to create efficient, schema-driven patches. It intelligently understands your data structure, enabling optimized, semantic diffs, and also provides fast, human-friendly diffing tools for frontend applications. It outperforms many popular alternatives in both speed and memory usage.

🧠 Schema-Driven Diffing
Unlike generic JSON diff libraries, fast-json-schema-patch leverages schema-based diff plans to:

- ⚡ Optimize array diffing using the best strategy for each case (LCS, primary key matching, etc.).

- 🧩 Generate semantic patches that align with your data’s meaning, not just its shape.

- 🎯 Compare objects intelligently by focusing only on relevant fields.

> 💡 Ideal for applications where the JSON structure is known and schema-driven diffs are important.

## 📦 Installation

```bash
bun add fast-json-schema-patch
```

## 🚀 Quick Start

The core of the library is the `JsonSchemaPatcher`, which uses a diff plan to optimize patch generation.

```typescript
import { JsonSchemaPatcher, buildPlan } from 'fast-json-schema-patch';

// 0. Describe your data with a JSON Schema. `id` is `required`, so the
//    `users` array auto-detects the `primaryKey` diffing strategy (CORE §3.5).
const schema = {
  type: 'object',
  properties: {
    users: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          status: { type: 'string' },
        },
      },
    },
  },
};

// 1. Build a plan from the schema — this needs to be done only once per schema.
const plan = buildPlan({ schema });

// 2. Instantiate the patcher with the plan
const patcher = new JsonSchemaPatcher({ plan });

// Original and modified documents
const original = {
  users: [
    { id: 'user1', name: 'John Doe', status: 'active' },
    { id: 'user2', name: 'Jane Smith', status: 'inactive' },
  ],
};

const modified = {
  users: [
    { id: 'user1', name: 'John Doe', status: 'online' }, // Changed
    { id: 'user3', name: 'Sam Ray', status: 'active' },  // Added
  ],
  // user2 was removed
};

// 3. Generate the optimized patch
const patch = patcher.execute({ original, modified });
console.log(patch);
// Output (modifications first, then removals, then `/-` appends — see
// GEN §4.1.4 for the primaryKey strategy's normative emission order):
// [
//   { op: "replace", path: "/users/0/status", value: "online", oldValue: "active" },
//   { op: "remove", path: "/users/1", oldValue: { id: "user2", name: "Jane Smith", status: "inactive" } },
//   { op: "add", path: "/users/-", value: { id: "user3", name: "Sam Ray", status: "active" } }
// ]
```

### A Note on RFC 6902 Compliance

This library extends the standard JSON Patch format by adding an `oldValue` field to `remove` and `replace` operations.
This addition makes UI rendering and state reconciliation easier but is not part of the strict RFC 6902 specification.

### A Note on Inputs: JSON Values Only

`original` and `modified` must be JSON values — the value space produced by `JSON.parse` (`null`, boolean, number, string, plain object, or array). Handling of non-JSON inputs is not fully defended against:

- `Date`, `RegExp`, `Map`, and other class instances are compared as opaque leaves (via `valueOf()`/`===`, so two different `Date`s will correctly diff instead of silently comparing equal), but they are otherwise echoed as-is into `value`/`oldValue` and will **not** round-trip through `JSON.stringify`/`JSON.parse` the way a plain object would.
- `undefined` values and `function`-valued fields are not valid JSON; diffing them can produce operations that omit `value` entirely.
- Circular references are **not** detected and will overflow the call stack.

If your data may contain any of the above, round-trip it through `JSON.parse(JSON.stringify(doc))` (or an equivalent JSON-safe transform) before diffing.

---

## 🔁 Applying and Inverting Patches

You can apply patches back to a document — no separate library needed. `applyPatch` supports all six RFC 6902 operations (`add`, `remove`, `replace`, `move`, `copy`, `test`), so it can also apply patches produced by other RFC 6902 tools.

```typescript
import { applyPatch, invertPatch } from 'fast-json-schema-patch';

// Reconstruct the modified document from the original + patch
const result = applyPatch(original, patch);

// Compute an undo patch (uses the original, pre-patch document)
const undo = invertPatch(original, patch);
applyPatch(result, undo); // deep-equals `original`
```

Behavior guarantees:

- **Immutable**: the input document is never mutated. Untouched subtrees are shared by reference between input and output (copy-on-write), so applying a small patch to a large document is cheap. ⚠️ Because of that sharing, don't mutate the returned document in place — pass `{ cloneResult: true }` if you need a fully independent copy to mutate.
- **Atomic**: if any operation fails, a `JsonPatchError` is thrown (with a machine-readable `code`, the failing `operation`, and `operationIndex`) and your document is left untouched.
- **Validating**: pass `{ validateOldValues: true }` to check each operation's `oldValue` against the current document before applying — an implicit `test` for every `remove`/`replace`, useful when the document may have drifted.
- **Safe**: pointer segments that would mutate the prototype chain (`__proto__`, `constructor`→`prototype`) are rejected with an `UNSAFE_KEY` error.

Migrating from `fast-json-patch`: `applyPatch(doc, patch)` here returns the new document directly (not an `OperationResult[]` with `.newDocument`) and never mutates the input (no `mutateDocument` flag). Use `toRfc6902(patch)` to strip this library's `oldValue` fields before handing patches to strict third-party tools.

> ℹ️ Arrays diffed with the `primaryKey` strategy are compared *semantically*: patches capture item modifications, removals, and additions, but not pure reorderings of otherwise-identical items. Applying such a patch reconstructs the modified document's content exactly; surviving items keep their original relative order and additions are appended at the end. Enable `emitMoves` (see the `JsonSchemaPatcher` options below) to upgrade this to exact order fidelity: relocated items are expressed as `move` ops and the patched document matches `modified`'s order exactly, not just its content.

---

## 📋 Generating JSON Schema from Zod

If you're using [Zod](https://zod.dev/) for runtime validation, you can easily generate JSON schemas for use with `fast-json-schema-patch`. Zod 4 introduced native JSON Schema conversion:

```typescript
import * as z from "zod/v4";
import { JsonSchemaPatcher, buildPlan } from 'fast-json-schema-patch';

// Define your Zod schema
const userSchema = z.object({
  users: z.array(z.object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['active', 'inactive', 'online'])
  }))
});

// Convert Zod schema to JSON Schema
const jsonSchema = z.toJSONSchema(userSchema);

// Use the JSON schema to build a plan
const plan = buildPlan({ schema: jsonSchema });
const patcher = new JsonSchemaPatcher({ plan });
```

This integration makes it seamless to leverage your existing Zod schemas for optimized JSON patching. For more details on Zod's JSON Schema conversion, see the [official documentation](https://zod.dev/json-schema).

---

## 🎨 Human-Readable Diffs with `StructuredDiff`

When you need to present diffs to users, raw JSON patches can be hard to work with.
StructuredDiff helps you transform those patches into structured, human-readable diffs that are fast, memory-efficient, and frontend-friendly.

It organizes changes into:

Parent diffs: Changes outside of specific arrays.

Child diffs: Changes within a target array, keyed by unique identifiers.

This makes it easy to build side-by-side diff views or activity feeds.

```typescript
import { StructuredDiff } from 'fast-json-schema-patch';

// Assuming `original`, `modified`, `patch`, and `plan` from the previous example

// 1. Instantiate the aggregator with the plan
const structuredDiff = new StructuredDiff({plan});

// 2. Execute the aggregation
const aggregatedResult = structuredDiff.execute({
  original,
  modified,
  pathPrefix: '/users',
});

// 3. Use the result to render a UI
console.log(aggregatedResult.parentDiff); // Shows changes outside the /users array
console.log(aggregatedResult.childDiffs['user2']); // Shows user2 was removed
console.log(aggregatedResult.childDiffs['user3']); // Shows user3 was added
```

## 🛠️ API Reference

### `buildPlan`
Creates a plan for optimizing JSON patch generation based on a JSON schema.

**`buildPlan(options)`**
- `options`: An object with the following properties:
  - `schema`: A JSON Schema object that describes your data structure.
  - `primaryKeyMap` (optional): A record mapping path prefixes to primary key field names.
  - `basePath` (optional): The base path for the schema traversal.
  - `primaryKeyCandidates` (optional): Override the ordered field-name candidate list used to auto-detect an array's primary key (default `["id", "name", "port"]`). The first candidate that is a `required` `string`/`number` property of the item schema is selected. Pass `[]` to disable auto-detection entirely for arrays without an explicit `primaryKeyMap` entry, keeping them on the `lcs`/`unique` strategy instead of (sometimes wrongly) matching on a mutable field like `name`.
  - `onWarning` (optional): `(message: string) => void`, called instead of writing to `console.warn` when traversal hits a `$ref` it cannot resolve. **Only local same-document references (`$ref` starting with `#/`) are ever resolved** — anything else (a relative/absolute URL, or any other non-`#/`-rooted string) always triggers this callback and is treated as unresolvable, so the branch is skipped and traversal continues elsewhere. Omit to stay silent (the default).
- **Returns**: A `Plan` object that can be used with `JsonSchemaPatcher` and `StructuredDiff`.

### `JsonSchemaPatcher`
The main class for generating patches.

**`new JsonSchemaPatcher({ plan, includeOldValue?, emitMoves?, wholesaleReplaceFallback?, ignorePaths? })`**
- `plan`: A `Plan` object created by `buildPlan` that describes your data structure and desired diffing strategies.
- `includeOldValue` (optional, default `true`): When `false`, omits the non-standard `oldValue` field from every `remove`/`replace` op, producing smaller, strict RFC 6902-shaped patches. `invertPatch` still works without `oldValue` present, since it recovers prior values from the original document you pass it.
- `emitMoves` (optional, default `false`): When `true`, a relocated (unchanged) array element is expressed as a single RFC 6902 `move` instead of a remove+add pair, across all three array strategies (`lcs`, `unique`, `primaryKey`). Also upgrades the `unique` and `primaryKey` strategies to reconstruct the modified array's order exactly (see the note on the `primaryKey` strategy below).
- `wholesaleReplaceFallback` (optional, default `false`): When `true`, caps a heavily-rewritten array's patch size — if the estimated size of one array's granular ops would exceed the array's own serialized size, the differ emits a single whole-array `replace` instead. Applies independently to every array, including nested ones; small/typical diffs are unaffected.
- `ignorePaths` (optional, default none): A list of object-member JSON Pointers whose subtrees are treated as **equal** — no ops are emitted at or beneath them, in any strategy. Use `*` for an array level, e.g. `["/users/*/updatedAt", "/meta/revision"]` ignores every user's `updatedAt` and the top-level `meta.revision`. Two items differing only in ignored fields collapse to nothing (or a single `move` under `emitMoves`) rather than a remove+add. An invalid pointer (an array-index or `-` segment, a rootless pointer, or one that would ignore a `primaryKey` field) throws a `TypeError` at construction.

**`patcher.execute({original, modified})`**
- `original`: The original document to compare from.
- `modified`: The modified document to compare to.
- **Returns**: A `DiffOperation[]` — an `add`/`remove`/`replace`/`move` subset of the wider `Operation` type that `applyPatch`/`invertPatch` accept (`move` only appears when `emitMoves` is enabled). `DiffOperation[]` is usable anywhere an `Operation[]` is expected.

### `applyPatch`
Applies an RFC 6902 patch to a document and returns the resulting document.

**`applyPatch(document, patches, options?)`**
- `document`: The document to apply the patch to (never mutated).
- `patches`: An array of JSON Patch operations (`add`, `remove`, `replace`, `move`, `copy`, `test`).
- `options.validateOldValues` (optional): When `true`, `remove`/`replace` operations carrying an `oldValue` are validated against the current document value before being applied.
- **Returns**: The patched document. Unchanged subtrees are shared by reference with the input.
- **Throws**: `JsonPatchError` if any operation cannot be applied; the input document is left untouched.

### `invertPatch`
Computes the inverse of a patch, for undo/rollback flows.

**`invertPatch(document, patches)`**
- `document`: The **original** (pre-patch) document the patch was generated from.
- `patches`: The patch to invert.
- **Returns**: An array of operations such that `applyPatch(applyPatch(document, patches), invertPatch(document, patches))` deep-equals `document`.

### `StructuredDiff`
The main class for creating human-readable diffs.

**`new StructuredDiff({plan})`**
- `plan`: A `Plan` object created by `buildPlan` that describes your data structure and desired diffing strategies.

**`structuredDiff.execute(config)`**
- `config`: A `StructuredDiffConfig` object with the following properties:
  - `pathPrefix`: The path prefix of the array to aggregate (e.g., `/users`).
  - `original`: The original document.
  - `modified`: The modified document.
  - `patches` (optional): Pre-computed patch array from `JsonSchemaPatcher`. If not provided, patches will be generated automatically.
- **Returns**: A `StructuredDiffResult` object containing `parentDiff` and a record of `childDiffs`.

### `setWarningHandler`
Registers (or clears) a callback for the one internal warning `StructuredDiff`/`DiffFormatter` can hit: a JSON parse failure while building a path map for diff-line formatting (not expected in normal operation, but defended against rather than left to throw).

**`setWarningHandler(handler)`**
- `handler`: `(message: string) => void`, or `undefined` to go back to silent (the default — no handler is registered until one is set).

## 🔬 Benchmarking Your Use Case

Run benchmarks on your own data:

```bash
# Run the benchmark suite
bun run compare
```

## 🐹 Go engine

A Go port lives in [`go/`](./go) as a separate module
(`github.com/flightcontrolhq/fast-json-schema-patch/go`, package `schemapatch`,
zero third-party dependencies). It implements the same **spec-v1**
([`SPEC.md`](./SPEC.md)) behavior and is held byte-identical to this TypeScript
reference by the shared conformance vectors ([`spec/vectors`](./spec/vectors))
plus a seeded differential-fuzz corpus ([`spec/fuzz`](./spec/fuzz)).

```sh
go get github.com/flightcontrolhq/fast-json-schema-patch/go
```

`Compare` diffs two typed Go values against a schema in one call (`nil` schema =
schemaless); `CompareJSON` is the same for raw JSON bytes:

```go
patch, err := schemapatch.Compare(schema, original, modified) // structs, maps, slices
patch, err := schemapatch.CompareJSON(schemaBytes, originalBytes, modifiedBytes)
```

See [`go/README.md`](./go/README.md) for the quick start, the determinism contract
(bytes preserve source order; `encoding/json` canonicalizes maps), capability
options, and the subdirectory-module tagging note (`go/vX.Y.Z`).

## 📊 How it compares

A capability comparison against the closest alternative in each ecosystem: [`wI2L/jsondiff`](https://github.com/wI2L/jsondiff) v0.7.1 (Go), [`fast-json-patch`](https://github.com/Starcounter-Jack/JSON-Patch) v3.1.1 (JS), [`jsondiffpatch`](https://github.com/benjamine/jsondiffpatch) v0.7.3 (JS), and [`rfc6902`](https://github.com/chbrown/rfc6902) v5.1.2 (JS). Versions are the ones pinned in this repo's `package.json`/`go-bench/go.mod` `devDependencies`, so every competitor claim below was checked against the exact source in `node_modules`/the Go module cache, not against upstream docs of an unknown version. No claim here is a benchmark result — see [Benchmarking Your Use Case](#-benchmarking-your-use-case) and the [notebook](./analysis/benchmark_visualization.ipynb) for performance.

Capabilities only, no marketing language. "Yes" means the capability is a documented, exported part of the library's public API; "Partial" means it exists but with a caveat spelled out in the cell; "No" means it doesn't exist. Every claim about us cites a runnable proof (a test file or vector name) in an inline HTML comment; every competitor claim cites the exact source location checked.

| Capability | Ours (TS + Go) | wI2L/jsondiff v0.7.1 (Go) | fast-json-patch v3.1.1 (JS) | jsondiffpatch v0.7.3 (JS) | rfc6902 v5.1.2 (JS) |
|---|---|---|---|---|---|
| RFC 6902 output | Yes — diff emits a pure add/remove/replace(/move) subset of RFC 6902; the non-standard `oldValue` extension is stripped by `toRfc6902()` for strict consumers.<!-- proof: spec/vectors/diff/*.json (every op is add/remove/replace/move); test/apply.test.ts "toRfc6902" --> | Yes — that's the package's stated purpose (README.md intro). | Yes — `compare()`/`generate()` emit add/remove/replace ops (README.md:207-289). | Partial — native output is its own "delta" format; RFC 6902 is available only via the separate `jsonpatch` formatter (README.md:34; lib/formatters/jsonpatch.js). | Yes, but `createPatch` generation is "limited to `remove`, `add`, and `replace` operations" — no `move`/`copy` (README.md:85). |
| Schema-aware array strategies | Yes — `buildPlan` derives a per-array strategy (`lcs` / `unique` / `primaryKey`) from a JSON Schema.<!-- proof: spec/vectors/diff/plan-selection.json; src/core/buildPlan.ts --> | No — one generic recursive/LCS comparison; `Compare`/`CompareJSON` take no schema argument (compare.go). | No — arrays are diffed positionally, treated like objects with numeric keys (module/duplex.mjs `_generate`). | No — array diffing is `objectHash`-based LCS matching, not schema-driven (README.md "smart array diffing"). | No — no schema concept anywhere in the public API (index.d.ts). |
| Typed-value entry API | Yes — TS `JsonSchemaPatcher.execute({original, modified})` takes parsed `JsonValue`s directly; Go `Compare(schema, source, target any, ...)` diffs typed structs/maps/slices.<!-- proof: test/comprehensive.test.ts; go/compare_any_test.go --> | Yes — `Compare(source, target interface{}, ...)` (compare.go:11). | Yes — `compare(document1, document2)` (README.md:261-264). | Yes — `diff(left, right)` (README.md usage example). | Yes — `createPatch(input, output)` (README.md). |
| Raw-JSON entry | Partial — Go `CompareJSON(schema, original, modified []byte, ...)` decodes raw bytes in one call; the TS engine has no equivalent (caller `JSON.parse`s first).<!-- proof: go/compare_test.go --> | Yes — `CompareJSON(source, target []byte, ...)` (compare.go:21). | No — no byte-input entry point distinct from `compare()` (README.md API list). | No — no byte-input entry point distinct from `diff()` (README.md API list). | No — no byte-input entry point distinct from `createPatch()` (README.md API list). |
| Diff | Yes.<!-- proof: spec/vectors/diff/ (171 vectors); test/conformance.test.ts; go/diff_conformance_test.go --> | Yes (core purpose). | Yes (core purpose). | Yes (core purpose). | Yes (core purpose). |
| Apply | Yes — `applyPatch` implements all six RFC 6902 ops, immutable and atomic.<!-- proof: test/apply.test.ts; spec/vectors/apply/ (93 vectors); go/apply.go + go/apply_conformance_test.go --> | No — an `apply` method exists but its own doc comment says it "will **NEVER** be exported... is feature-wise out of scope of the project" (apply.go:19-22, citing wI2L/jsondiff#28). | Yes — `applyPatch`/`applyOperation`, all six ops (README.md:89-155). | Partial — `applyJsonPatchRFC6902` exists, but its doc comment says it "is used for testing to ensure the JSON-Patch formatter output is correct" and supports "only add, remove, replace and move" (jsonpatch-apply.d.ts). | Yes — `applyPatch(object, patch)` (README.md). |
| Invert (incl. WITHOUT `oldValue`) | Yes — `invertPatch(originalDocument, patch)` recovers prior values by walking the original document, so it inverts correctly even when the patch carries no `oldValue` field.<!-- proof: test/apply.test.ts "recovers removed values even without oldValue"; spec/vectors/invert/ (28 vectors); go/invert.go + go/invert_conformance_test.go --> | Partial — `Patch.Invert()` exists, but requires the patch to have been generated with `Invertible()` (a `test` op preceding every `remove`/`replace`); a `remove`/`replace` without a preceding `test` returns `ErrNonReversible` (patch.go:34-58). | No — no standalone invert function; `compare(a, b, invertible=true)` can only generate a patch with test ops baked in up front (README.md:207-289). | No, for RFC 6902 — `reverse()`/`unpatch()` operate on jsondiffpatch's own delta format, which stores both values by construction; there is no RFC-6902-patch inversion function (README.md:83-85). | No — no invert/reverse export (index.d.ts exports only `applyPatch`, `createPatch`, `createTests`). |
| Move factorization | Yes, scoped to one array — `emitMoves` expresses a relocated element as a single `move` within its own array; it does not factor arbitrary add/remove pairs elsewhere in the document into moves.<!-- proof: test/emit-moves.test.ts; spec/vectors/diff/capabilities-emit-moves.json; GEN §8 --> | Yes, document-wide — `Factorize()` turns any matching remove+add pair anywhere in the tree into `move`/`copy` (README.md "Operations factorization"). | No — source comment: "if ever \"move\" operation is implemented here..." confirms it's never generated (module/duplex.mjs:124). | Partial — the `jsonpatch` formatter emits `move` for LCS-matched array reorders (requires an `objectHash` function), not general cross-path factorization (lib/formatters/jsonpatch.js:129). | No — generation "limited to remove, add, and replace" (README.md:85). |
| Size rationalization (wholesale) | Yes — `wholesaleReplaceFallback` caps one array's patch at roughly its own serialized size by substituting a single whole-array `replace` when the granular op stream would be larger.<!-- proof: test/wholesale-replace-fallback.test.ts; spec/vectors/diff/capabilities-wholesale.json; GEN §9 --> | Yes — `Rationalize()` replaces a set of child operations with a single parent `replace` when it marshals smaller (README.md "Operations rationalization"). | No — no such option (README.md API list). | No — no such option (README.md API list). | No — no such option (README.md API list). |
| Ignores | Yes — `ignorePaths` (JSON Pointer + `*` wildcard syntax), threaded through every array strategy so ignored subtrees compare equal.<!-- proof: test/ignore-paths.test.ts; spec/vectors/diff/capabilities-ignore-paths.json; GEN §10 --> | Yes — `Ignores()` (variadic JSON Pointer list), marked experimental (README.md "Ignores"). | No — no ignore/filter option (README.md API list). | Partial — `propertyFilter` is a `(name, context) => boolean` callback, not JSON-Pointer/wildcard syntax (README.md:229-231). | No — no ignore option (README.md API list). |
| Deterministic cross-language output | Yes — the TS and Go engines are checked against the same 300+ conformance vectors plus a 576-record seeded differential-fuzz corpus, zero mismatches.<!-- proof: go/differential_test.go ("differential fuzz records executed: 576 across 9 files"); test/conformance.test.ts (319 tests); spec/vectors/ --> | N/A — single-language implementation, no second engine to be deterministic against. | N/A — single-language implementation. | N/A — single-language implementation. | N/A — single-language implementation. |
| Conformance test suite | Yes — 300+ spec-linked, language-neutral vectors under `spec/vectors/{diff,apply,plan,invert}`, documented in `spec/vectors/README.md`, executed by both engines.<!-- proof: spec/vectors/README.md; test/conformance.test.ts; go/*_conformance_test.go --> | Partial — has internal `testdata/tests/jsonpatch/*.json` fixtures used by its own `_test.go` files; not documented or published as a spec-linked suite for external implementers (no README under `testdata/tests`). | No published cross-implementation vector suite — ordinary unit tests only. | No published cross-implementation vector suite — ordinary unit tests only. | No published cross-implementation vector suite — ordinary unit tests only. |
| Second-language engine | Yes — a full Go port (`go/`, package `schemapatch`), zero third-party dependencies, implementing the same spec-v1 contract.<!-- proof: go/ (module github.com/flightcontrolhq/fast-json-schema-patch/go) --> | No — Go only. | No — JS only. | No — JS only. | No — JS only. |
| Structured/human-readable diff layer | Yes — `StructuredDiff` aggregates a patch into parent/child diffs keyed by primary key, for building diff UIs (TS only, no Go equivalent yet).<!-- proof: src/aggregators/StructuredDiff.ts; test/structured-diff-aggregator.test.ts --> | No — public output is only the `Patch`/`Operation` type. | No. | Partial — ships `html`/`annotated`/`console` formatters that render its delta for human viewing, but no queryable structured object for building a custom UI (lib/formatters/{html,annotated,console}.js). | No. |

### Verification notes

- Competitor versions are pinned exactly as declared in this repo: `fast-json-patch@3.1.1`, `jsondiffpatch@0.7.3`, `rfc6902@5.1.2` in [`package.json`](./package.json) `devDependencies`; `github.com/wI2L/jsondiff@v0.7.1` in [`go-bench/go.mod`](./go-bench/go.mod). Every claim above was checked against that exact version's source (`node_modules/<pkg>` / the Go module cache), not against upstream `main`/latest docs.
- Every "Ours" cell's HTML comment names a real test file or vector directory in this repository at the time of writing; run `bun test` / `cd go && go test ./...` to reproduce.
- "N/A" (not "No") is used only for the two cross-language rows, where the capability requires a second implementation to exist at all — a single-language library cannot meaningfully have or lack it.

## 🔗 Related Standards

- [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
- [JSON Schema Specification](https://json-schema.org/specification.html)

