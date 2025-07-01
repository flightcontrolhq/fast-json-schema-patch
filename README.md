# schema-json-patch

🚀 **Ultra-fast, schema-aware JSON patch generation and human-readable diffing**

A high-performance JSON patch library that leverages schema knowledge to generate efficient, semantic patches. It also includes powerful tools to create human-readable diffs suitable for frontend applications, outperforming similar libraries in speed and memory efficiency.

## 🧠 Schema-Driven Intelligence

Unlike generic JSON diff libraries, `schema-json-patch` uses a **diff plan** derived from your JSON Schema to:

- **Apply optimal array diffing strategies** (LCS, Primary Key, etc.).
- **Generate semantic patches** that understand your data's structure.
- **Perform intelligent object comparisons** by focusing on relevant fields.

> 💡 **Best suited for applications where JSON structure is known and performance is critical.**

## 📦 Installation

```bash
bun add schema-json-patch
```

## 🚀 Quick Start

The core of the library is the `SchemaJsonPatcher`, which is configured with a `plan` to optimize patch generation.

```typescript
import { SchemaJsonPatcher, buildPlan } from 'schema-json-patch';

// 1. Define a plan for your data structure
const plan = buildPlan(schema);

// 2. Instantiate the patcher with the plan
const patcher = new SchemaJsonPatcher({ plan });

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
const patch = patcher.createPatch(original, modified);
console.log(patch);
// Output: [
//   { op: "remove", path: "/users/1", oldValue: { id: 'user2', ... } },
//   { op: "replace", path: "/users/0/status", value: "online", oldValue: "active" },
//   { op: "add", path: "/users/-", value: { id: 'user3', ... } }
// ]
```

### A Note on RFC 6902 Compliance

To facilitate richer diffing and state reconstruction, this library adds an `oldValue` property to `remove` and `replace` operations. While incredibly useful, this is a deviation from the strict RFC 6902 standard.

---

## 📋 Generating JSON Schema from Zod

If you're using [Zod](https://zod.dev/) for runtime validation, you can easily generate JSON schemas for use with `schema-json-patch`. Zod 4 introduced native JSON Schema conversion:

```typescript
import * as z from "zod/v4";
import { SchemaJsonPatcher, buildPlan } from 'schema-json-patch';

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
const patcher = new SchemaJsonPatcher({ plan });
```

This integration makes it seamless to leverage your existing Zod schemas for optimized JSON patching. For more details on Zod's JSON Schema conversion, see the [official documentation](https://zod.dev/json-schema).
---

## 🎨 Human-Readable Diffs with `PatchAggregator`

Tired of trying to render raw JSON patches in your UI? The `PatchAggregator` transforms a patch into a structured, human-readable format, similar to `json-diff-kit`, but significantly faster and more memory-efficient.

It separates changes into **parent diffs** (changes to the root object) and **child diffs** (changes within a nested array), making it trivial to build side-by-side diff viewers in a frontend application.

```typescript
import { PatchAggregator } from 'schema-json-patch/aggregators';

// Assuming `original`, `modified`, `patch`, and `plan` from the previous example

// 1. Instantiate the aggregator with the original and new documents
const aggregator = new PatchAggregator(original, modified);

// 2. Aggregate the patch
const aggregatedResult = aggregator.aggregate(patch, {
  pathPrefix: '/users', // The path to the array we want to analyze
  plan: plan,
});

// 3. Use the result to render a UI
console.log(aggregatedResult.parentDiff); // Shows changes outside the /users array
console.log(aggregatedResult.childDiffs.get('user2')); // Shows user2 was removed
console.log(aggregatedResult.childDiffs.get('user3')); // Shows user3 was added
```

🏆 **Summary**: `PatchAggregator` is **2.2x faster** and uses **93% less memory**, making it ideal for performance-sensitive applications.

## 🛠️ API Reference

### `SchemaJsonPatcher`
The main class for generating patches.

**`new SchemaJsonPatcher({ plan })`**
- `plan`: A `Plan` object created by `buildPlan` that describes your data structure and desired diffing strategies.

**`patcher.createPatch(source, target)`**
- Generates an array of JSON Patch operations.

### `PatchAggregator`
The main class for creating human-readable diffs.

**`new PatchAggregator(originalDoc, newDoc)`**
- `originalDoc`, `newDoc`: The two documents to compare.

**`aggregator.aggregate(patches, config)`**
- `patches`: The patch array from `SchemaJsonPatcher`.
- `config`: An object specifying the `pathPrefix` of the array to aggregate and an optional `plan`.
- **Returns**: An `AggregatedDiffResult` object containing `parentDiff` and a map of `childDiffs`.

## 🔬 Benchmarking Your Use Case

Run benchmarks on your own data:

```bash
# Run the benchmark suite
bun run compare
```

## 🔗 Related Standards

- [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
- [JSON Schema Specification](https://json-schema.org/specification.html)

