# schema-json-patch

🚀 **Ultra-fast, schema-aware JSON patch generation and human-readable diffing**

A high-performance JSON patch library that leverages schema knowledge to generate efficient, semantic patches. It also includes powerful tools to create human-readable diffs suitable for frontend applications, outperforming similar libraries in speed and memory efficiency.

## 🏆 Performance Benchmarks

Based on a comprehensive benchmark of **5,000** stratified samples against popular libraries using simulated real-world JSON documents generated with Faker.js.

### 📊 Detailed Performance Summary

| Library | Avg Time (ms) | Throughput (ops/s) | Avg Patches | Patch Reduction |
|---|---|---|---|---|
| **schema-json-patch** | **0.32ms** ⚡️ | **3,129** 🚀 | **396** 📏 | - |
| fast-json-patch | 0.36ms | 2,793 | 905 | **56.2%** |
| jsondiffpatch | 1.22ms | 823 | 430 | **7.9%** |

### 🎯 Key Performance Advantages

- **12% higher throughput** than `fast-json-patch`.
- **74% faster** execution time than `jsondiffpatch`.
- Generates **56% fewer patches** than `fast-json-patch`, resulting in smaller payloads and more semantic operations.
- Consistently fast performance, especially with highly complex and nested documents.

*Benchmarks run on simulated real-world JSON documents (1KB-200KB) with varying complexity levels, generated via Faker.js. Full benchmark data and analysis scripts are available in the `/comparison` directory.*

## 🧠 Schema-Driven Intelligence

Unlike generic JSON diff libraries, `schema-json-patch` uses a **diff plan** derived from your JSON Schema to:

- **Apply optimal array diffing strategies** (LCS, Primary Key, etc.).
- **Generate semantic patches** that understand your data's structure.
- **Perform intelligent object comparisons** by focusing on relevant fields.

> 💡 **Best suited for applications where JSON structure is known and performance is critical.**

## 📦 Installation

```bash
npm install schema-json-patch
```

## 🚀 Quick Start

The core of the library is the `SchemaPatcher`, which is configured with a `plan` to optimize patch generation.

```typescript
import { SchemaPatcher, buildPlan } from 'schema-json-patch';

// 1. Define a plan for your data structure
const plan = buildPlan({
  '/users': {
    strategy: 'primaryKey',
    primaryKey: 'id',
  },
});

// 2. Instantiate the patcher with the plan
const patcher = new SchemaPatcher({ plan });

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

## 🎨 Human-Readable Diffs with `PatchAggregator`

Tired of trying to render raw JSON patches in your UI? The `PatchAggregator` transforms a patch into a structured, human-readable format, similar to `json-diff-kit`, but significantly faster and more memory-efficient.

It separates changes into **parent diffs** (changes to the root object) and **child diffs** (changes within a nested array), making it trivial to build side-by-side diff viewers in a frontend application.

```typescript
import { PatchAggregator } from 'schema-json-patch';

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

### `PatchAggregator` Performance

It not only provides a structured diff but does so with exceptional performance compared to alternatives.

| Library | Avg Time (ms) | Throughput (ops/s) | Memory Usage (KB) |
|---|---|---|---|
| **SchemaPatch + Aggregator** | **7.59ms** | **132** | **426 KB** |
| json-diff-kit | 16.79ms | 60 | 6,307 KB |

🏆 **Summary**: `PatchAggregator` is **2.2x faster** and uses **93% less memory**, making it ideal for performance-sensitive applications.

## 🛠️ API Reference

### `SchemaPatcher`
The main class for generating patches.

**`new SchemaPatcher({ plan })`**
- `plan`: A `Plan` object created by `buildPlan` that describes your data structure and desired diffing strategies.

**`patcher.createPatch(source, target)`**
- Generates an array of JSON Patch operations.

### `PatchAggregator`
The main class for creating human-readable diffs.

**`new PatchAggregator(originalDoc, newDoc)`**
- `originalDoc`, `newDoc`: The two documents to compare.

**`aggregator.aggregate(patches, config)`**
- `patches`: The patch array from `SchemaPatcher`.
- `config`: An object specifying the `pathPrefix` of the array to aggregate and an optional `plan`.
- **Returns**: An `AggregatedDiffResult` object containing `parentDiff` and a map of `childDiffs`.

## 🔬 Benchmarking Your Use Case

Run benchmarks on your own data:

```bash
# Clone the repository
git clone https://github.com/your-org/schema-json-patch
cd schema-json-patch

# Install dependencies
npm install

# Run the benchmark suite
npm run compare
```

## 🤝 Contributing

We welcome contributions! See our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup

```bash
git clone https://github.com/your-org/schema-json-patch
cd schema-json-patch
npm install
npm test
```

## 📈 Roadmap

- [ ] **WebAssembly optimization** for core diffing algorithms
- [ ] **Streaming patch generation** for large documents
- [ ] **Schema evolution support** for backward compatibility
- [ ] **TypeScript schema inference** from types

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🔗 Related Standards

- [RFC 6902 - JSON Patch](https://tools.ietf.org/html/rfc6902)
- [JSON Schema Specification](https://json-schema.org/specification.html)

