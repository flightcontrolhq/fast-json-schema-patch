import type { JsonValue, JsonObject, JsonArray, Operation } from "../types";
import {
  deepEqualMemo,
  deepEqual,
  deepEqualSchemaAware,
} from "../performance/deepEqual";
import { getEffectiveHashFields } from "../performance/getEffectiveHashFields";
import type { ArrayPlan } from "../core/buildPlan";

type ModificationCallback = (
  item1: JsonValue,
  item2: JsonValue,
  path: string,
  patches: Operation[]
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
  const map1 = new Map<string | number, { item: JsonValue; index: number }>();
  for (let i = 0; i < arr1.length; i++) {
    const item = arr1[i];
    if (typeof item === "object" && item !== null && primaryKey in item) {
      const key = item[primaryKey as keyof typeof item];
      if (typeof key === "string" || typeof key === "number") {
        map1.set(key, { item, index: i });
      }
    }
  }

  const seenKeys = new Set<string | number>();
  const modificationPatches: Operation[] = [];
  const additionPatches: Operation[] = [];

  for (let i = 0; i < arr2.length; i++) {
    const newItem = arr2[i];
    if (
      typeof newItem !== "object" ||
      newItem === null ||
      !(primaryKey in newItem)
    ) {
      continue;
    }
    const key = newItem[primaryKey as keyof typeof newItem];
    if (typeof key !== "string" && typeof key !== "number") {
      continue;
    }

    seenKeys.add(key);
    const oldEntry = map1.get(key);

    if (oldEntry) {
      const oldItem = oldEntry.item;
      let needsDiff = false;

      if (plan) {
        needsDiff = !deepEqualSchemaAware(
          oldItem,
          newItem,
          plan,
          effectiveHashFields
        );
      } else if (effectiveHashFields.length > 0) {
        let hashFieldsDiffer = false;
        for (let j = 0; j < effectiveHashFields.length; j++) {
          const field = effectiveHashFields[j];
          if (
            field &&
            (oldItem as JsonObject)[field] !== (newItem as JsonObject)[field]
          ) {
            hashFieldsDiffer = true;
            break;
          }
        }
        needsDiff =
          hashFieldsDiffer ||
          (oldItem !== newItem && !deepEqual(oldItem, newItem));
      } else {
        needsDiff = oldItem !== newItem && !deepEqual(oldItem, newItem);
      }

      if (needsDiff) {
        onModification(
          oldItem,
          newItem,
          `${path}/${oldEntry.index}`,
          modificationPatches
        );
      }
    } else {
      additionPatches.push({ op: "add", path: `${path}/-`, value: newItem });
    }
  }

  const removalIndices: { index: number; value: JsonValue }[] = [];
  for (const [key, oldEntry] of map1.entries()) {
    if (!seenKeys.has(key)) {
      removalIndices.push({ index: oldEntry.index, value: oldEntry.item });
    }
  }

  removalIndices.sort((a, b) => b.index - a.index);
  const removalPatches: Operation[] = removalIndices.map(
    ({ index, value }) => ({
      op: "remove",
      path: `${path}/${index}`,
      oldValue: value,
    })
  );

  patches.push(...modificationPatches, ...removalPatches, ...additionPatches);
}

function collapseReplace(
  ops: ("common" | "add" | "remove")[]
): ("common" | "add" | "remove" | "replace")[] {
  const out: ("common" | "add" | "remove" | "replace")[] = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === "remove" && ops[i + 1] === "add") {
      out.push("replace");
      i++; // skip next add
    } else {
      out.push(ops[i] as "common" | "add" | "remove" | "replace");
    }
  }
  return out;
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
  const max = n + m;
  const v: Record<number, number> = { 1: 0 };
  const trace: Record<number, number>[] = [];
  let endD = 0;

  for (let d = 0; d <= max; d++) {
    const vPrev = { ...v };
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d ||
        (k !== d && (vPrev[k - 1] ?? -Infinity) < (vPrev[k + 1] ?? -Infinity));
      let x = down ? (vPrev[k + 1] as number) : (vPrev[k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m) {
        let itemsEqual = false;
        if (plan) {
          itemsEqual = deepEqualSchemaAware(
            arr1[x],
            arr2[y],
            plan,
            effectiveHashFields
          );
        } else {
          itemsEqual = deepEqualMemo(arr1[x], arr2[y], effectiveHashFields);
        }
        if (!itemsEqual) break;
        x++;
        y++;
      }
      v[k] = x;
      if (x >= n && y >= m) {
        endD = d;
        trace.push({ ...v });
        d = max + 1;
        break;
      }
    }
    if (endD) break;
    trace.push({ ...v });
  }
  if (!endD) return;

  let x = n;
  let y = m;
  const rawOps: ("common" | "add" | "remove")[] = [];
  for (let d = endD; d > 0; d--) {
    const vPrev = trace[d - 1];
    const k = x - y;
    const down =
      k === -d ||
      (k !== d &&
        (vPrev?.[k - 1] ?? -Infinity) < (vPrev?.[k + 1] ?? -Infinity));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev?.[prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rawOps.unshift("common");
      x--;
      y--;
    }
    if (down) {
      rawOps.unshift("add");
      y--;
    } else {
      rawOps.unshift("remove");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    rawOps.unshift("common");
    x--;
    y--;
  }

  const ops2 = collapseReplace(rawOps);

  let ai = 0;
  let bi = 0;
  for (const op of ops2) {
    switch (op) {
      case "common":
        onModification(
          arr1[ai] as JsonValue,
          arr2[bi] as JsonValue,
          `${path}/${ai}`,
          patches
        );
        ai++;
        bi++;
        break;
      case "replace":
        patches.push({
          op: "replace",
          path: `${path}/${ai}`,
          value: arr2[bi] as JsonValue,
        });
        ai++;
        bi++;
        break;
      case "remove":
        patches.push({ op: "remove", path: `${path}/${ai}` });
        ai++;
        break;
      case "add":
        patches.push({
          op: "add",
          path: `${path}/${ai}`,
          value: arr2[bi] as JsonValue,
        });
        bi++;
        break;
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
  const set1 = new Set(arr1);
  const set2 = new Set(arr2);
  const minLength = Math.min(n, m);
  const replacedAtIndex = new Set<number>();
  const replacedValues2 = new Set<JsonValue>();

  for (let i = 0; i < minLength; i++) {
    const val1 = arr1[i];
    const val2 = arr2[i];
    if (val1 !== val2) {
      patches.push({ op: "replace", path: `${path}/${i}`, value: val2 });
      replacedAtIndex.add(i);
      if (val2 !== undefined) replacedValues2.add(val2);
    }
  }

  const removalIndices: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const item = arr1[i];
    if (item !== undefined && !set2.has(item) && !replacedAtIndex.has(i)) {
      removalIndices.push(i);
    }
  }
  for (const index of removalIndices) {
    patches.push({ op: "remove", path: `${path}/${index}` });
  }

  for (const item of set2) {
    if (item !== undefined && !set1.has(item) && !replacedValues2.has(item)) {
      patches.push({ op: "add", path: `${path}/-`, value: item });
    }
  }
}

// Helper: check if two items differ (same as your deepEqual/deepEqualSchemaAware logic)
function needsDiff(
  oldItem: JsonValue,
  newItem: JsonValue,
  plan: ArrayPlan | undefined,
  hashFields: string[] | undefined
): boolean {
  const effectiveHashFields = getEffectiveHashFields(
    plan,
    undefined,
    undefined,
    hashFields || []
  );

  if (plan) {
    return !deepEqualSchemaAware(
      oldItem,
      newItem,
      plan,
      effectiveHashFields
    );
  } else if (effectiveHashFields.length > 0) {
    let hashFieldsDiffer = false;
    for (let j = 0; j < effectiveHashFields.length; j++) {
      const field = effectiveHashFields[j];
      if (
        field &&
        (oldItem as JsonObject)[field] !== (newItem as JsonObject)[field]
      ) {
        hashFieldsDiffer = true;
        break;
      }
    }
    return (
      hashFieldsDiffer || (oldItem !== newItem && !deepEqual(oldItem, newItem))
    );
  } else {
    return oldItem !== newItem && !deepEqual(oldItem, newItem);
  }
}

// Standard O(n log n) LIS on an integer array, returns both the
// length and the list of indices in the original array that form one LIS
// Note: this implementation is O(n^2) due to the parent search loop.
// For performance-critical applications, a more optimized version can be used.
function longestIncreasingSubsequence(arr: number[]): {
  length: number;
  indices: number[];
} {
  const piles: number[] = [];
  const parent: number[] = Array(arr.length).fill(-1);
  const pileIndex: number[] = Array(arr.length);

  for (let i = 0; i < arr.length; i++) {
    const currentValue = arr[i];
    if (currentValue === undefined) continue;

    // binary search
    let lo = 0,
      hi = piles.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const midValue = piles[mid];
      if (midValue !== undefined && midValue < currentValue) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo === piles.length) piles.push(currentValue);
    else piles[lo] = currentValue;
    pileIndex[i] = lo;
    if (lo > 0) {
      // find last index j < i with pileIndex[j] = lo - 1
      for (let j = i - 1; j >= 0; j--) {
        if (pileIndex[j] === lo - 1) {
          parent[i] = j;
          break;
        }
      }
    }
  }

  // Reconstruct one LIS by walking backwards from the end of the last pile
  let lisLen = piles.length;
  const lisIndices: number[] = [];
  if (lisLen > 0) {
    let lisEnd = -1;
    for (let i = pileIndex.length - 1; i >= 0; i--) {
      if (pileIndex[i] === lisLen - 1) {
        lisEnd = i;
        break;
      }
    }

    while (lisEnd !== -1) {
      lisIndices.push(lisEnd);
      lisEnd = parent[lisEnd] ?? -1;
    }
    lisIndices.reverse();
  }

  return { length: lisLen, indices: lisIndices };
}

function isObject(x: any): x is object {
  return typeof x === "object" && x !== null;
}
function isStringOrNumber(x: any): x is string | number {
  return typeof x === "string" || typeof x === "number";
}

export function diffArrayByPrimaryKeyWithMoves(
  oldArr: JsonArray,
  newArr: JsonArray,
  primaryKey: string,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  hashFields?: string[],
  plan?: ArrayPlan
) {
  // 1. Build maps from key → (item, oldIndex)
  const oldMap = new Map<string | number, { item: JsonValue; index: number }>();
  oldArr.forEach((it, i) => {
    if (isObject(it) && primaryKey in it) {
      const k = (it as any)[primaryKey];
      if (isStringOrNumber(k)) oldMap.set(k, { item: it, index: i });
    }
  });

  // 2. Gather three classes of keys:
  //    A = keys only in old  → removals
  //    B = keys only in new  → additions
  //    C = keys in both      → candidates for modify or move
  const seen = new Set<string | number>();
  const common: { key: string | number; oldIndex: number; newIndex: number }[] =
    [];
  const additions: { newIndex: number; item: JsonValue }[] = [];

  const newKeyToIndexMap = new Map<string | number, number>();
  newArr.forEach((it, newI) => {
    if (!isObject(it) || !(primaryKey in it)) return;
    const k = (it as any)[primaryKey];
    if (!isStringOrNumber(k)) return;
    newKeyToIndexMap.set(k, newI);
    const old = oldMap.get(k);
    if (old) {
      seen.add(k);
      common.push({ key: k, oldIndex: old.index, newIndex: newI });
      // check for modifications too:
      if (needsDiff(old.item, it, plan, hashFields)) {
        onModification(old.item, it, `${path}/${old.index}`, patches);
      }
    } else {
      additions.push({ newIndex: newI, item: it });
    }
  });

  // 3. Removals = old keys not seen in new
  const removals = Array.from(oldMap.entries())
    .filter(([k, _]) => !seen.has(k))
    .map(([_, { index, item }]) => ({ index, item }))
    .sort((a, b) => b.index - a.index)
    .map(
      ({ index, item }) =>
        ({
          op: "remove",
          path: `${path}/${index}`,
          oldValue: item,
        } as Operation)
    );

  // 4. Find moves among the "common" keys:
  //    We have a list of (oldIndex → newIndex).  We want to leave
  //    in place as many as possible, so compute the Longest Increasing
  //    Subsequence (LIS) of newIndex when sorted by oldIndex.
  //    Elements *not* in that LIS must be "moved."
  common.sort((a, b) => a.oldIndex - b.oldIndex);
  const seq = common.map(x => x.newIndex);
  const lisResult = longestIncreasingSubsequence(seq);
  //    lisResult.indices is the set of positions in `seq` that form an LIS.

  // 5. Emit move ops for any common[i] where i ∉ lisResult.indices
  const moves: Operation[] = [];
  const inLIS = new Set(lisResult.indices);

  const commonNotInLis = common.filter((_, i) => !inLIS.has(i));

  // Sort moves by their destination index.
  commonNotInLis.sort((a, b) => a.newIndex - b.newIndex);

  // The LIS items are the "stable" ones that don't move. We can create
  // a map from their old index to their new index.
  const lisMap = new Map<number, number>();
  for (let i = 0; i < lisResult.indices.length; i++) {
    const commonIndex = lisResult.indices[i];
    if (commonIndex !== undefined) {
      const commonEntry = common[commonIndex];
      if (commonEntry) {
        lisMap.set(commonEntry.oldIndex, commonEntry.newIndex);
      }
    }
  }

  // Generate move operations.
  // The key insight here is that the 'from' path in a move op refers to the
  // state of the document *before this operation*.
  // We can track the offset caused by previous moves to adjust the 'from' index.
  const liveToOldIndex = oldArr.map((_, i) => i);

  for (const entry of commonNotInLis) {
    const fromIndex = liveToOldIndex.indexOf(entry.oldIndex);
    if (fromIndex !== -1) {
      moves.push({
        op: "move",
        from: `${path}/${fromIndex}`,
        path: `${path}/${entry.newIndex}`,
      });
      // a move is a remove then an add, so the array shrinks then grows.
      const [movedItem] = liveToOldIndex.splice(fromIndex, 1);
      liveToOldIndex.splice(entry.newIndex, 0, movedItem as number);
    }
  }

  // 6. Finally, additions: just add the new items
  const adds = additions
    .sort((a, b) => a.newIndex - b.newIndex)
    .map(
      ({ newIndex, item }) =>
        ({
          op: "add",
          path: `${path}/${newIndex}`,
          value: item,
        } as Operation)
    );

  // 7. Stitch together: modifications already pushed, then
  //    removals (descending oldIndex), then moves, then adds.
  //    The moves are split into removals and additions to handle index changes.
  patches.push(...removals, ...moves, ...adds);
}
