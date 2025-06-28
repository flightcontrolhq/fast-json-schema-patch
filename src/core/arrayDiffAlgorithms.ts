import type { JsonValue, JsonObject, JsonArray, Operation } from "../types";
import {
  deepEqual,
  deepEqualMemo,
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

  const map2 = new Map<string | number, { item: JsonValue; index: number }>();
  for (let i = 0; i < arr2.length; i++) {
    const item = arr2[i];
    if (typeof item === "object" && item !== null && primaryKey in item) {
      const key = item[primaryKey as keyof typeof item];
      if (typeof key === "string" || typeof key === "number") {
        map2.set(key, { item, index: i });
      }
    }
  }

  const modificationPatches: Operation[] = [];
  const additions: { item: JsonValue; index: number }[] = [];
  const moves: { from: number; to: number; item: JsonValue }[] = [];
  const removals: { index: number; value: JsonValue }[] = [];
  const commonItems = new Map<
    string | number,
    { oldIndex: number; newIndex: number; item: JsonValue }
  >();

  const seenInArr2 = new Set<string | number>();

  for (const [key, { item: newItem, index: newIndex }] of map2.entries()) {
    seenInArr2.add(key);
    const oldEntry = map1.get(key);

    if (oldEntry) {
      // Common item
      const { item: oldItem, index: oldIndex } = oldEntry;

      // Check for content change
      const isEqual = plan?.isEqual
        ? plan.isEqual(oldItem as JsonObject, newItem as JsonObject)
        : deepEqual(oldItem, newItem);

      if (!isEqual) {
        onModification(
          oldItem,
          newItem,
          `${path}/${oldIndex}`,
          modificationPatches
        );
      }

      commonItems.set(key, { oldIndex, newIndex, item: newItem });
    } else {
      // New item
      additions.push({ item: newItem, index: newIndex });
    }
  }

  for (const [key, oldEntry] of map1.entries()) {
    if (!seenInArr2.has(key)) {
      removals.push({ index: oldEntry.index, value: oldEntry.item });
    }
  }

  // --- Generate patches in a safe order ---

  // 1. Handle modifications first
  patches.push(...modificationPatches);

  // 2. Handle removals from high index to low to avoid index shifting issues.
  removals.sort((a, b) => b.index - a.index);
  for (const removal of removals) {
    patches.push({
      op: "remove",
      path: `${path}/${removal.index}`,
      oldValue: removal.value,
    });
  }

  // 3. Determine moves vs. add/remove for positional changes.
  // Create a map of old indices that are targets of moves.
  const targetOldIndices = new Set(
    Array.from(commonItems.values())
      .filter((c) => c.oldIndex !== c.newIndex)
      .map((c) => c.oldIndex)
  );

  const finalAdditions = [...additions];
  const movePatches: Operation[] = [];

  // An item can only be "moved" if its original spot isn't taken by another moved item.
  // Otherwise, it's a "remove" (already handled) and an "add".
  const oldIndicesOccupiedByMoves = new Set<number>();
  const moveCandidates = Array.from(commonItems.values()).filter(
    (c) => c.oldIndex !== c.newIndex
  );

  // A map to track where items at old indices are moving to.
  // This helps resolve "move chains" or "swaps".
  const oldIndexToNewIndexMap = new Map<number, number>();
  for (const { oldIndex, newIndex } of moveCandidates) {
    oldIndexToNewIndexMap.set(oldIndex, newIndex);
  }

  for (const common of moveCandidates) {
    // If the item's destination is another item's original position,
    // and that other item is also moving, it's a swap/chain.
    // We treat the current item as an "add" and let the other item "move".
    const isDestinationTakenByAnotherMover = oldIndexToNewIndexMap.has(
      common.newIndex
    );

    if (isDestinationTakenByAnotherMover) {
      // This spot is part of a swap or move chain.
      // The original item at this position was already removed.
      // We just need to add this item at its new position.
      finalAdditions.push({ item: common.item, index: common.newIndex });
    } else {
      // It's a clean move.
      movePatches.push({
        op: "move",
        from: `${path}/${common.oldIndex}`,
        path: `${path}/${common.newIndex}`,
      });
    }
  }

  // 4. Handle moves.
  // This needs careful ordering, but RFC6902 move 'from' paths are based on original doc,
  // so we don't need to simulate the moves.
  patches.push(...movePatches);

  // 5. Handle additions, sorted by index.
  finalAdditions.sort((a, b) => a.index - b.index);
  for (const add of finalAdditions) {
    patches.push({ op: "add", path: `${path}/${add.index}`, value: add.item });
  }
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
      patches.push({
        op: "replace",
        path: `${path}/${i}`,
        value: val2 as JsonValue,
      });
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
