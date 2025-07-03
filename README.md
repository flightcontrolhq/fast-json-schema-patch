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

// 1. Define a plan for your data structure, this needs to be done only once for a given schema
const plan = buildPlan({schema});

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
const patch = patcher.execute({original, modified});
console.log(patch);
// Output: [
//   { op: "remove", path: "/users/1", oldValue: { id: 'user2', ... } },
//   { op: "replace", path: "/users/0/status", value: "online", oldValue: "active" },
//   { op: "add", path: "/users/-", value: { id: 'user3', ... } }
// ]
```

### A Note on RFC 6902 Compliance

This library extends the standard JSON Patch format by adding an `oldValue` field to `remove` and `replace` operations.
This addition makes UI rendering and state reconciliation easier but is not part of the strict RFC 6902 specification.

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
const plan = buildPlan(jsonSchema);
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

// 1. Instantiate the aggregator with the original and new documents
const aggregatedResult = new StructuredDiff({plan}).execute({
  original,
  modified,
  pathPrefix: '/users',
})

// 3. Use the result to render a UI
console.log(aggregatedResult.parentDiff); // Shows changes outside the /users array
console.log(aggregatedResult.childDiffs['user2']); // Shows user2 was removed
console.log(aggregatedResult.childDiffs['user3']); // Shows user3 was added
```

## 🛠️ API Reference

### `JsonSchemaPatcher`
The main class for generating patches.

**`new JsonSchemaPatcher({ plan })`**
- `plan`: A `Plan` object created by `buildPlan` that describes your data structure and desired diffing strategies.

**`patcher.createPatch(source, target)`**
- Generates an array of JSON Patch operations.

### `StructuredDiff`
The main class for creating human-readable diffs.

**`new StructuredDiff(original, modified)`**
- `original`, `modified`: The two documents to compare.

**`aggregator.aggregate(patches, config)`**
- `patches`: The patch array from `JsonSchemaPatcher`.
- `config`: An object specifying the `pathPrefix` of the array to aggregate and an optional `plan`.
- **Returns**: An `AggregatedDiffResult` object containing `parentDiff` and a record of `childDiffs`.

## 🔬 Benchmarking Your Use Case

Run benchmarks on your own data:

```bash
# Run the benchmark suite
bun run compare
```

## 🔗 Related Standards

- [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
- [JSON Schema Specification](https://json-schema.org/specification.html)

