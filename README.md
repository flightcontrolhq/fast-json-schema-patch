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
//    `users` array auto-detects the `primaryKey` diffing strategy (§4.5).
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
// SPEC.md §5.4.1.4 for the primaryKey strategy's normative emission order):
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

**`new JsonSchemaPatcher({ plan, includeOldValue?, emitMoves?, wholesaleReplaceFallback? })`**
- `plan`: A `Plan` object created by `buildPlan` that describes your data structure and desired diffing strategies.
- `includeOldValue` (optional, default `true`): When `false`, omits the non-standard `oldValue` field from every `remove`/`replace` op, producing smaller, strict RFC 6902-shaped patches. `invertPatch` still works without `oldValue` present, since it recovers prior values from the original document you pass it.
- `emitMoves` (optional, default `false`): When `true`, a relocated (unchanged) array element is expressed as a single RFC 6902 `move` instead of a remove+add pair, across all three array strategies (`lcs`, `unique`, `primaryKey`). Also upgrades the `unique` and `primaryKey` strategies to reconstruct the modified array's order exactly (see the note on the `primaryKey` strategy below).
- `wholesaleReplaceFallback` (optional, default `false`): When `true`, caps a heavily-rewritten array's patch size — if the estimated size of one array's granular ops would exceed the array's own serialized size, the differ emits a single whole-array `replace` instead. Applies independently to every array, including nested ones; small/typical diffs are unaffected.

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

## 🔗 Related Standards

- [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
- [JSON Schema Specification](https://json-schema.org/specification.html)

