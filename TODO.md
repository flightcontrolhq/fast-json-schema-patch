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