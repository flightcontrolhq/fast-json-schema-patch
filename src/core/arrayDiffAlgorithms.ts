import type { ArrayPlan } from "../core/buildPlan";
import {
  deepEqual,
  deepEqualMemo,
  deepEqualSchemaAware,
} from "../performance/deepEqual";
import { getEffectiveHashFields } from "../performance/getEffectiveHashFields";
import type { JsonArray, JsonObject, JsonValue, Operation } from "../types";

export type ModificationCallback = (
  item1: JsonValue,
  item2: JsonValue,
  path: string,
  patches: Operation[],
  skipEqualityCheck?: boolean
) => void;

export function diffArrayByPrimaryKey(
  arr1: JsonArray,
  arr2: JsonArray,
  primaryKey: string,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  hashFields?: string[],
  plan?: ArrayPlan
) {
  const effectiveHashFields = getEffectiveHashFields(
    plan,
    undefined,
    undefined,
    hashFields || []
  );
  const hashFieldsLength = effectiveHashFields.length;
  const hasHashFields = hashFieldsLength > 0;

  const arr1Length = arr1.length;
  const arr2Length = arr2.length;

  // Pre-allocate with exact sizes to avoid hidden class transitions
  const keyToIndex = new Map<string | number, number>();
  const itemsByIndex = new Array(arr1Length);
  const pathPrefix = path + "/";

  // Phase 1: Build index mappings - O(n)
  for (let i = 0; i < arr1Length; i++) {
    const item = arr1[i];
    if (typeof item === "object" && item !== null) {
      const keyValue = item[primaryKey as keyof typeof item];
      if (keyValue !== undefined && keyValue !== null) {
        const keyType = typeof keyValue;
        if (keyType === "string" || keyType === "number") {
          keyToIndex.set(keyValue as string | number, i);
          itemsByIndex[i] = item;
        }
      }
    }
  }

  const modificationPatches: Operation[] = [];
  const additionPatches: Operation[] = [];

  // Phase 2: Process arr2 and mark operations - O(m)
  for (let i = 0; i < arr2Length; i++) {
    const newItem = arr2[i];

    if (typeof newItem !== "object" || newItem === null) {
      continue;
    }

    const keyValue = newItem[primaryKey as keyof typeof newItem];
    if (keyValue === undefined) {
      continue;
    }

    const keyType = typeof keyValue;
    if (keyType !== "string" && keyType !== "number") {
      continue;
    }

    const oldIndex = keyToIndex.get(keyValue as string | number);
    if (oldIndex !== undefined) {
      // Delete immediately to avoid later lookup
      keyToIndex.delete(keyValue as string | number);

      const oldItem = itemsByIndex[oldIndex];
      let needsDiff = false;

      if (hasHashFields) {
        const oldItemObj = oldItem as JsonObject;
        const newItemObj = newItem as JsonObject;

        for (let j = 0; j < hashFieldsLength; j++) {
          const field = effectiveHashFields[j];
          // Short-circuit evaluation optimized
          if (field && oldItemObj[field] !== newItemObj[field]) {
            needsDiff = true;
            break;
          }
        }

        // Only expensive deep equal if hash fields match
        if (!needsDiff && oldItem !== newItem) {
          needsDiff = !deepEqual(oldItem, newItem);
        }
      } else if (plan) {
        needsDiff = !deepEqualSchemaAware(
          oldItem,
          newItem,
          plan,
          effectiveHashFields
        );
      } else {
        // Reference equality first (fastest path)
        needsDiff = oldItem !== newItem && !deepEqual(oldItem, newItem);
      }

      if (needsDiff) {
        const itemPath = pathPrefix + oldIndex;
        onModification(oldItem, newItem, itemPath, modificationPatches, true);
      }
    } else {
      additionPatches.push({
        op: "add",
        path: pathPrefix + "-",
        value: newItem,
      });
    }
  }

  // Phase 3: Generate removal patches directly - O(remaining items)
  const removalIndices = Array.from(keyToIndex.values());

  // O(k log k)) where k << n and k and n are the number of removals and items in the array respectively
  removalIndices.sort((a, b) => b - a);

  const removalPatches: Operation[] = new Array(removalIndices.length);

  for (let i = 0; i < removalIndices.length; i++) {
    const index = removalIndices[i] as number;
    removalPatches[i] = {
      op: "remove",
      path: pathPrefix + index,
      oldValue: itemsByIndex[index],
    };
  }

  const totalPatches =
    modificationPatches.length + removalPatches.length + additionPatches.length;
  if (totalPatches > 0) {
    patches.push(...modificationPatches, ...removalPatches, ...additionPatches);
  }
}

export function diffArrayLCS(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  hashFields?: string[],
  plan?: ArrayPlan
) {
  const effectiveHashFields = getEffectiveHashFields(
    plan,
    undefined,
    undefined,
    hashFields || []
  );

  const n = arr1.length;
  const m = arr2.length;

  // Early exit for empty arrays
  if (n === 0) {
    const prefixPath = path === "" ? "/" : path + "/";
    for (let i = 0; i < m; i++) {
      patches.push({
        op: "add",
        path: prefixPath + i,
        value: arr2[i] as JsonValue,
      });
    }
    return;
  }
  if (m === 0) {
    for (let i = n - 1; i >= 0; i--) {
      patches.push({
        op: "remove",
        path: path === "" ? "/" : path + "/" + i,
      });
    }
    return;
  }

  const max = n + m;
  const offset = max;
  const bufSize = 2 * max + 1;

  // Pre-allocate buffers to avoid repeated allocations
  const buffer1 = new Int32Array(bufSize);
  const buffer2 = new Int32Array(bufSize);
  buffer1.fill(-1);
  buffer2.fill(-1);

  let vPrev = buffer1;
  let vCurr = buffer2;
  vPrev[offset + 1] = 0;

  // Pre-allocate trace array with estimated size
  const trace = new Array(max + 1);
  let traceLen = 0;
  let endD = -1;

  // Cache equality checks to avoid redundant comparisons
  const equalCache = new Map<number, boolean>();
  const cacheKey = (x: number, y: number): number => (x << 16) | y; // Assumes arrays < 65536 length

  const equalAt = (x: number, y: number): boolean => {
    const key = cacheKey(x, y);
    let result = equalCache.get(key);
    if (result !== undefined) return result;

    result = plan
      ? deepEqualSchemaAware(arr1[x], arr2[y], plan, effectiveHashFields)
      : deepEqualMemo(arr1[x], arr2[y], effectiveHashFields);

    equalCache.set(key, result);
    return result;
  };

  const prefixPath = path === "" ? "/" : path + "/";

  // Forward pass with optimizations
  outer: for (let d = 0; d <= max; d++) {
    // Clone only the used portion of the array
    const traceCopy = new Int32Array(bufSize);
    traceCopy.set(vPrev);
    trace[traceLen++] = traceCopy;

    const dMin = -d;
    const dMax = d;

    for (let k = dMin; k <= dMax; k += 2) {
      const kOffset = k + offset;

      // Inline get() for performance
      const vLeft = kOffset > 0 ? (vPrev[kOffset - 1] as number) : -1;
      const vRight =
        kOffset < bufSize - 1 ? (vPrev[kOffset + 1] as number) : -1;

      const down = k === dMin || (k !== dMax && vLeft < vRight);
      let x = down ? vRight : vLeft + 1;
      let y = x - k;

      // Snake with bounds checking
      while (x < n && y < m && equalAt(x, y)) {
        x++;
        y++;
      }

      vCurr[kOffset] = x;

      if (x >= n && y >= m) {
        const finalCopy = new Int32Array(bufSize);
        finalCopy.set(vCurr);
        trace[traceLen++] = finalCopy;
        endD = d;
        break outer;
      }
    }

    // Swap buffers efficiently
    const tmp = vPrev;
    vPrev = vCurr;
    vCurr = tmp;
    vCurr.fill(-1);
  }

  if (endD === -1) return;

  // Backtracking to build edit script
  const editScript: Array<{
    op: "common" | "remove" | "add";
    ai?: number;
    bi?: number;
  }> = [];

  let x = n;
  let y = m;

  for (let d = endD; d > 0; d--) {
    const vRow = trace[d];
    const k = x - y;
    const kOffset = k + offset;

    const vLeft = kOffset > 0 ? vRow[kOffset - 1] : -1;
    const vRight = kOffset < bufSize - 1 ? vRow[kOffset + 1] : -1;

    const down = k === -d || (k !== d && vLeft < vRight);
    const prevK = down ? k + 1 : k - 1;
    const prevX = vRow[prevK + offset];
    const prevY = prevX - prevK;

    // Add common elements (snake)
    while (x > prevX && y > prevY) {
      x--;
      y--;
      editScript.push({ op: "common", ai: x, bi: y });
    }

    // Add the edit operation
    if (down) {
      y--;
      editScript.push({ op: "add", bi: y });
    } else {
      x--;
      editScript.push({ op: "remove", ai: x });
    }
  }

  // Add remaining common elements
  while (x > 0 && y > 0) {
    x--;
    y--;
    editScript.push({ op: "common", ai: x, bi: y });
  }

  // Reverse to get forward order
  editScript.reverse();

  // Optimize: collapse adjacent remove+add into replace operations
  const optimizedScript: Array<{
    op: "common" | "remove" | "add" | "replace";
    ai?: number;
    bi?: number;
  }> = [];

  for (let i = 0; i < editScript.length; i++) {
    const current = editScript[i];
    const next = editScript[i + 1];

    // Check if we can combine remove + add into replace
    if (
      current &&
      current.op === "remove" &&
      next &&
      next.op === "add" &&
      current.ai !== undefined &&
      next.bi !== undefined
    ) {
      optimizedScript.push({ op: "replace", ai: current.ai, bi: next.bi });
      i++; // Skip the next operation
    } else if (current) {
      optimizedScript.push(current);
    }
  }

  // Apply operations and generate patches
  let currentIndex = 0;

  for (const operation of optimizedScript) {
    switch (operation.op) {
      case "common": {
        const v1 = arr1[operation.ai as number];
        const v2 = arr2[operation.bi as number];
        // Only call onModification for objects that might have nested differences
        if (
          typeof v1 === "object" &&
          v1 !== null &&
          typeof v2 === "object" &&
          v2 !== null
        ) {
          onModification(v1, v2, prefixPath + currentIndex, patches, false);
        }
        currentIndex++;
        break;
      }
      case "replace": {
        patches.push({
          op: "replace",
          path: prefixPath + currentIndex,
          value: arr2[operation.bi as number] as JsonValue,
          oldValue: arr1[operation.ai as number],
        });
        currentIndex++;
        break;
      }
      case "remove": {
        patches.push({
          op: "remove",
          path: prefixPath + currentIndex,
          oldValue: arr1[operation.ai as number],
        });
        // Don't increment currentIndex for removes
        break;
      }
      case "add": {
        patches.push({
          op: "add",
          path: prefixPath + currentIndex,
          value: arr2[operation.bi as number] as JsonValue,
        });
        currentIndex++;
        break;
      }
    }
  }
}

export function diffArrayUnique(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[]
) {
  const n = arr1.length;
  const m = arr2.length;
  const pathPrefix = path + "/";

  const patches_temp: Operation[] = [];

  if (n === 0 && m === 0) return;
  if (n === 0) {
    // All additions
    for (let i = 0; i < m; i++) {
      patches_temp.push({ op: "add", path: pathPrefix + "-", value: arr2[i] });
    }
    patches.push(...patches_temp);
    return;
  }
  if (m === 0) {
    // All removals (descending order)
    for (let i = n - 1; i >= 0; i--) {
      patches_temp.push({
        op: "remove",
        path: pathPrefix + i,
        oldValue: arr1[i],
      });
    }
    patches.push(...patches_temp);
    return;
  }

  // Use Map for O(1) lookups instead of Set for complex logic
  const arr1Map = new Map<JsonValue, number>();
  const arr2Map = new Map<JsonValue, number>();

  // Single pass to build both maps
  for (let i = 0; i < n; i++) {
    arr1Map.set(arr1[i] as JsonValue, i);
  }
  for (let i = 0; i < m; i++) {
    arr2Map.set(arr2[i] as JsonValue, i);
  }

  const minLength = Math.min(n, m);
  const replacedItems = new Set<JsonValue>();

  // Phase 1: Handle replacements in common indices - O(min(n,m))
  for (let i = 0; i < minLength; i++) {
    const val1 = arr1[i];
    const val2 = arr2[i];

    if (val1 !== val2) {
      patches_temp.push({
        op: "replace",
        path: pathPrefix + i,
        value: val2,
        oldValue: val1,
      });
      replacedItems.add(val2 as JsonValue);
    }
  }

  // Phase 2: Handle removals - O(n)
  // Collect removal indices first, then sort
  const removalIndices: number[] = [];

  for (let i = n - 1; i >= 0; i--) {
    const item = arr1[i];

    // Skip if this position was replaced or item exists in arr2
    if (i < minLength && arr1[i] !== arr2[i]) {
      continue;
    }

    if (!arr2Map.has(item as JsonValue)) {
      removalIndices.push(i);
    }
  }

  // Add removal patches (already in descending order)
  for (const index of removalIndices) {
    patches_temp.push({
      op: "remove",
      path: pathPrefix + index,
      oldValue: arr1[index],
    });
  }

  // Phase 3: Handle additions - O(m)
  for (let i = 0; i < m; i++) {
    const item = arr2[i];

    // Skip if this was a replacement
    if (i < minLength && arr1[i] !== arr2[i]) {
      continue;
    }

    if (!arr1Map.has(item as JsonValue)) {
      patches_temp.push({ op: "add", path: pathPrefix + "-", value: item });
    }
  }

  patches.push(...patches_temp);
}

export function checkArraysUnique(arr1: JsonArray, arr2: JsonArray): boolean {
  const len1 = arr1.length;
  const len2 = arr2.length;

  if (len1 !== len2) return false;

  const seen1 = new Set<JsonValue>();
  const seen2 = new Set<JsonValue>();

  for (let i = 0; i < len1; i++) {
    const val1 = arr1[i];
    const val2 = arr2[i];

    if (seen1.has(val1 as JsonValue) || seen2.has(val2 as JsonValue)) {
      return false;
    }

    seen1.add(val1 as JsonValue);
    seen2.add(val2 as JsonValue);
  }

  return true;
}
