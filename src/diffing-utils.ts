import type {
  JsonValue,
  JsonObject,
  JsonArray,
  Operation,
} from "./types";
import {
  deepEqualMemo,
  deepEqual,
  deepEqualSchemaAware,
  getEffectiveHashFields,
} from "./index";
import type { ArrayPlan } from "./index";

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
  const effectiveHashFields = getEffectiveHashFields(plan, undefined, undefined, hashFields || []);
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
        needsDiff = !deepEqualSchemaAware(oldItem, newItem, plan, effectiveHashFields);
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
        needsDiff = hashFieldsDiffer || (oldItem !== newItem && !deepEqual(oldItem, newItem));
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
  const removalPatches: Operation[] = removalIndices.map(({ index, value }) => ({
    op: "remove",
    path: `${path}/${index}`,
    oldValue: value,
  }));

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
  const effectiveHashFields = getEffectiveHashFields(plan, undefined, undefined, hashFields || []);
  
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
          itemsEqual = deepEqualSchemaAware(arr1[x], arr2[y], plan, effectiveHashFields);
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