# RFC6902 `move` Operation Implementation Plan

This document outlines the necessary changes to implement the `move` operation for array items when using the `primaryKey` strategy, ensuring better compliance with RFC6902.

---

### 1. `src/types.ts`

- [ ] Update the `Operation` type definition to officially include the `move` operation. The `from` path is required for `move`.

```typescript
export type Operation =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "remove"; path: string; oldValue?: JsonValue }
  | { op: "replace"; path: string; value: JsonValue; oldValue?: JsonValue }
  | { op: "move"; from: string; path: string };
```

---

### 2. `src/core/arrayDiffAlgorithms.ts`

- [ ] **Overhaul `diffArrayByPrimaryKey`:**
    - The current implementation is a set-based diff; it must be converted to a sequence-aware diff to detect reordering.
    - **Step 1: Indexing**: Create maps for both `arr1` and `arr2` that store each item and its index against its primary key.
    - **Step 2: Categorization**: Iterate through the new array (`arr2`) to identify items as either common (present in both arrays) or new (additions).
    - **Step 3: Detect Changes for Common Items**:
        - **Moves**: If a common item's index in `arr1` differs from its index in `arr2`, record it as a `move`.
        - **Modifications**: Perform a deep, schema-aware comparison on common items. If their content differs, generate modification patches against their **original** index using the `onModification` callback.
    - **Step 4: Identify Removals**: Items present in `arr1` but not `arr2` are marked for removal.
    - **Step 5: Generate Patches in Order**: To ensure path integrity, generate patches in a strict sequence:
        1.  All content modification patches.
        2.  All `remove` patches (sorted from highest index to lowest).
        3.  All `move` patches.
        4.  All `add` patches.

---

### 3. `src/formatting/PatchAggregator.ts`

- [ ] **Update Patch Bucketing Logic:**
    - In the `aggregate` method, the loop that categorizes patches must be taught to handle `{ op: 'move', ... }`.
    - When a `move` patch is found, use its `patch.from` path to identify the `childId` of the item that was moved.
    - Assign the `move` patch to the correct child in the `childPatchesById` map.

- [ ] **Prevent Discarding Moved Children:**
    - Locate the optimization that skips diff generation for unchanged children: `if (this.compareObjects(...) { continue; })`.
    - Modify this condition to *prevent* skipping if the child has a `move` patch associated with it. An `AggregatedChildDiff` must be created to signal the move.

- [ ] **Preserve Global Paths for `move` Patches:**
    - The logic that transforms patch paths into child-relative paths should not apply to `move` operations.
    - Ensure that `move` patches are passed into the `AggregatedChildDiff.patches` array with their original, global `from` and `path` values intact.

---

### 4. `src/formatting/DiffFormatter.ts`

- [ ] **No Changes Required.**
    - The current implementation correctly ignores `move` operations when generating line-by-line content diffs. This is the desired behavior for a child diff, which should only reflect content changes.
    - The responsibility for visualizing the "Moved" state will fall to the UI that consumes the `AggregatedDiffResult`, which can inspect the `patches` array of each `AggregatedChildDiff`.

---

### 5. `src/core/buildPlan.ts` (Performance Optimization)

- [ ] **Add a Pre-compiled Equality Function to `ArrayPlan`**:
    - **Goal**: To accelerate content comparison within `diffArrayByPrimaryKey`. Instead of re-interpreting the schema/plan for every pair of items, we can use a pre-compiled function.
    - **Action**:
        1.  Modify the `ArrayPlan` interface to include an optional `isEqual` function: `isEqual?: (obj1: JsonObject, obj2: JsonObject) => boolean;`.
        2.  In `_traverseSchema`, when an `ArrayPlan` with `strategy: 'primaryKey'` is created, also generate and attach an `isEqual` function to it.
        3.  This function should encapsulate the logic of `deepEqualSchemaAware`, using the pre-calculated `hashFields` and `itemSchema` for that specific array path.
    - **Usage**:
        - `diffArrayByPrimaryKey` will be updated to use `plan.isEqual(item1, item2)` if it exists, falling back to the generic `deepEqualSchemaAware` otherwise. This makes the diffing process faster by executing a specialized function instead of a generic one.

---

### 6. Performance Optimizations for `diffArrayByPrimaryKey`

The current move generation logic has a complexity of O(N*M) due to `findIndex` and `splice` operations inside a loop, which is the primary cause of the performance regression. The following optimizations should be implemented:

- [ ] **Adopt an LCS-based Approach for Move Generation**:
    - **Goal**: Replace the inefficient greedy algorithm with a more performant one based on the Longest Common Subsequence (LCS).
    - **Action**:
        1.  After identifying additions, removals, and common items, create two lists of primary keys for the common items: one in their original order (`arr1`) and one in their new order (`arr2`).
        2.  Compute the LCS of these two key sequences. The keys *not* in the LCS are the ones that must be moved.
        3.  Generate `move` patches only for the items corresponding to the keys not in the LCS. This avoids generating moves for items that have shifted but maintained their relative order.

- [ ] **Eliminate In-place Array Manipulation (`splice`)**:
    - **Goal**: Calculate `move` patch paths without simulating the operations on a temporary array.
    - **Action**:
        1.  Generate `remove` patches first, from highest index to lowest. This is the current, correct behavior.
        2.  For `move` operations, calculate the `from` path by considering the shifts caused by *all* removals that occurred at an index lower than the item's original index.
        3.  Calculate the `to` path by considering the shifts from items that are added or moved *before* the current item's target position.
        4.  A helper map (`key -> originalIndex`) can be used to track the index shifts for each item being moved. This avoids repeated `findIndex` calls.

- [ ] **Pre-calculate Indices in `buildPlan`**:
    - **Goal**: Leverage the `buildPlan` step to pre-process arrays and reduce runtime work.
    - **Action**:
        1.  If feasible, enhance the `ArrayPlan` to include a pre-computed map of `primaryKey -> index` for known static arrays if they are part of the base schema.
        2.  While this is less likely to apply to dynamic document inputs, it could optimize benchmarks or scenarios with a known base document. 