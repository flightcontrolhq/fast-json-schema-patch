# TODO: Refactor to Aggregator-Based Architecture

This document outlines the steps to refactor the `SchemaPatcher` to use an aggregator-based architecture for generating rich diffs. This decouples diff generation from formatting.

## 1. Define Core Types (`src/types.ts`)

- [x] Create a central `src/types.ts` file for all shared types.
- [x] Define `JsonValue`, `Operation` (with `oldValue`).
- [x] Define diff-related types: `DiffLine`, `SideBySideDiff`, `UnifiedDiffLine`, `PathMap`.
- [x] Remove the `PatcherPlugin` type.

## 2. Simplify `SchemaPatcher` (`src/index.ts`)

- [x] Remove the plugin system from the `SchemaPatcher`.
- [x] The constructor no longer accepts plugins.
- [x] The `addPatches` method is removed.
- [x] `SchemaPatcher` is now only responsible for creating an array of `Operation` objects.

## 3. Implement Diff Formatter (`src/diff-formatters.ts`)

- [x] Create `src/diff-formatters.ts` to house the formatting logic.
- [x] Implement the `DiffFormatter` class.
  - The constructor takes the original and new JSON documents.
  - A `format(patches: Operation[])` method takes the output from `SchemaPatcher` and returns a `SideBySideDiff` object.
- [x] Keep the `generateUnifiedDiff` function to convert the side-by-side view into a unified diff.
- [x] Include necessary helper functions (`buildPathMap`, `resolvePatchPath`, `getPathLineRange`).

## 4. Implement a Caching Mechanism (Future)

- [ ] **Goal:** Create a global cache to store `Operation[]` results for pairs of documents.
- [ ] This caching layer would wrap the `SchemaPatcher`, checking the cache before calling `createPatch`. The resulting patch array can then be passed to the `DiffFormatter` as needed.

## 5. Performance Optimizations & Caching

### 5.1 Eliminate Redundant Path Resolution Logic
- [x] **Extract Common Path Utilities**: Create a shared `src/path-utils.ts` module to consolidate path resolution logic from:
  - `getValueByPath` in `patch-aggregator.ts`
  - `resolvePatchPath` in `diff-formatters.ts` 
  - Path traversal in schema plan lookups (`index.ts`)
- [x] **Unified Path Resolution**: Implement a single, optimized path resolution function with consistent JSON Pointer handling (including `~0` and `~1` escaping)

### 5.2 JSON Serialization & Path Map Caching
- [x] **JSON String Cache**: Implement a WeakMap cache for `JSON.stringify(obj, null, 2)` results to avoid repeated serialization of the same objects
- [x] **Path Map Cache**: Cache `buildPathMap()` results using object identity as keys, since path maps are expensive to compute
- [x] **Memoized Formatting**: Cache `DiffFormatter` instances for identical (original, new) JSON pairs

### 5.3 Schema Plan Integration in PatchAggregator
- [x] **Plan-Aware Aggregation**: Modify `PatchAggregator` constructor to accept a `Plan` parameter
- [x] **Schema-Driven Array Detection**: Use plan information to identify arrays and their primary keys instead of hardcoded `idKey` parameter
- [ ] **Strategy-Aware Processing**: Leverage the plan's diffing strategies (primaryKey, lcs, unique) for optimized aggregation
- [ ] **Remove Hardcoded Array Logic**: Replace manual array detection with schema-based path resolution

### 5.4 Path Lookup Optimizations  
- [ ] **Plan Lookup Cache**: Implement caching for `getPlanForPath()` results with normalized path keys
- [ ] **Path Normalization Cache**: Cache normalized paths (with array indices removed) to avoid repeated regex operations
- [ ] **Wildcard Path Cache**: Cache parent wildcard path lookups to reduce string manipulation

### 5.5 Object Cloning Optimizations
- [ ] **Structured Clone Alternative**: Replace `JSON.parse(JSON.stringify())` in `stripChildArray()` with more efficient cloning (structuredClone or custom implementation)
- [ ] **Selective Cloning**: Only clone the specific parts of objects that need modification rather than entire documents
- [ ] **Clone Result Cache**: Cache clone results for identical objects to avoid repeated deep copying

### 5.6 Deep Equality Enhancements
- [ ] **Extend Memoization**: Expand the existing `deepEqualMemo` cache to cover more use cases across all three files
- [ ] **Hash-Based Pre-filtering**: Use the existing `fastHash` function more broadly to eliminate unnecessary deep comparisons
- [ ] **Schema-Aware Equality**: Use plan information to optimize equality checks by focusing on significant fields first 