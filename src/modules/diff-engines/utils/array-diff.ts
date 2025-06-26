import type {
  JsonArray,
  JsonValue,
  DiffDelta,
  JsonObject,
} from "../../../types";
import { deepEqual, deepEqualMemo } from "../../../utils/deep-equal";
import type { PerformanceTracker } from "../../../utils/performance-tracker";

type ModificationCallback = (
  item1: JsonValue | undefined,
  item2: JsonValue | undefined,
  path: string
) => void;

export function diffArrayByPrimaryKey(
  arr1: JsonArray,
  arr2: JsonArray,
  primaryKey: string,
  path: string,
  patches: DiffDelta[],
  onModification: ModificationCallback,
  hashFields?: string[],
  performance?: PerformanceTracker | null
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

  const seenKeys = new Set<string | number>();

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
      if (!deepEqualMemo(oldEntry.item, newItem, hashFields)) {
        onModification(oldEntry.item, newItem, `${path}/${oldEntry.index}`);
      }
    } else {
      patches.push({ op: "add", path: `${path}/-`, value: newItem });
    }
  }

  const removalIndices: number[] = [];
  for (const [key, oldEntry] of map1.entries()) {
    if (!seenKeys.has(key)) {
      removalIndices.push(oldEntry.index);
    }
  }

  removalIndices.sort((a, b) => b - a);
  for (const index of removalIndices) {
    patches.push({
      op: "remove",
      path: `${path}/${index}`,
      value: undefined,
      oldValue: arr1[index],
    });
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
  patches: DiffDelta[],
  diffValues: (
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string
  ) => void,
  getIdentity?: (item: JsonValue) => JsonValue,
  hashFields?: string[],
  performance?: PerformanceTracker | null
) {
  performance?.start("lcs-overhead");
  const n = arr1.length;
  const m = arr2.length;
  const max = n + m;
  const v: Record<number, number> = { 1: 0 };
  const trace: Record<number, number>[] = [];
  let endD = 0;

  const areEqual = (a: JsonValue, b: JsonValue) =>
    getIdentity
      ? deepEqual(getIdentity(a), getIdentity(b))
      : deepEqualMemo(a, b, hashFields);

  for (let d = 0; d <= max; d++) {
    const vPrev = { ...v };
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d ||
        (k !== d &&
          (vPrev[k - 1] ?? Number.NEGATIVE_INFINITY) <
            (vPrev[k + 1] ?? Number.NEGATIVE_INFINITY));
      let x = down ? (vPrev[k + 1] as number) : (vPrev[k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && areEqual(arr1[x] as JsonValue, arr2[y] as JsonValue)) {
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
  performance?.end("lcs-overhead");
  if (!endD && !(n === 0 && m === 0)) {
    // Fallback to simpler diff if LCS fails
    for (let i = 0; i < Math.max(arr1.length, arr2.length); i++) {
      diffValues(arr1[i], arr2[i], `${path}/${i}`);
    }
    return;
  }

  let x = n;
  let y = m;
  const rawOps: ("common" | "add" | "remove")[] = [];
  for (let d = endD; d > 0; d--) {
    const vPrev = trace[d - 1];
    const k = x - y;
    const down =
      k === -d ||
      (k !== d &&
        (vPrev?.[k - 1] ?? Number.NEGATIVE_INFINITY) <
          (vPrev?.[k + 1] ?? Number.NEGATIVE_INFINITY));
    const prevK = down ? k + 1 : k - 1;
    const prevX = vPrev?.[prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rawOps.unshift("common");
      x--;
      y--;
    }
    if (d > 0 || x > 0 || y > 0) {
        if (down) {
          rawOps.unshift("add");
          y--;
        } else {
          rawOps.unshift("remove");
          x--;
        }
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
      case "common": {
        const item1 = arr1[ai];
        const item2 = arr2[bi];
        diffValues(item1, item2, `${path}/${ai}`);
        ai++;
        bi++;
        break;
      }
      case "replace": {
        diffValues(arr1[ai], arr2[bi], `${path}/${ai}`);
        ai++;
        bi++;
        break;
      }
      case "remove":
        patches.push({
          op: "remove",
          path: `${path}/${ai}`,
          value: undefined,
          oldValue: arr1[ai],
        });
        ai++;
        break;
      case "add":
        patches.push({
          op: "add",
          path: `${path}/${ai}`,
          value: arr2[bi],
        });
        ai++;
        bi++;
        break;
    }
  }
}

export function diffArrayUnique(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: DiffDelta[],
  performance?: PerformanceTracker | null
) {
  performance?.start("diffArrayUnique:buildSets");
  const set1 = new Set(arr1.map((item) => JSON.stringify(item)));
  const set2 = new Set(arr2.map((item) => JSON.stringify(item)));
  performance?.end("diffArrayUnique:buildSets");

  performance?.start("diffArrayUnique:findDiffs");
  const added = [...set2]
    .filter((item) => !set1.has(item))
    .map((item) => JSON.parse(item));

  const removed = [...set1]
    .filter((item) => !set2.has(item))
    .map((item) => JSON.parse(item));
  performance?.end("diffArrayUnique:findDiffs");

  performance?.start("diffArrayUnique:createPatches");
  if (added.length === removed.length && added.length > 0) {
    // This is likely a series of replacements
    // Simple heuristic: pair them up. A more advanced version could find best matches.
    for (let i = 0; i < added.length; i++) {
      // Finding original index is expensive. For "unique" strategy, we accept less optimal patches.
      // We can't know the original index of the removed item easily.
      // We will add `replace` operations, but finding the correct path is hard.
      // Defaulting to remove and add.
      patches.push({
        op: "remove",
        path: `${path}/-`,
        oldValue: removed[i],
      });
      patches.push({ op: "add", path: `${path}/-`, value: added[i] });
    }
  } else {
    for (const item of removed) {
      patches.push({ op: "remove", path: `${path}/-`, oldValue: item }); // Path is indicative
    }
    for (const item of added) {
      patches.push({ op: "add", path: `${path}/-`, value: item });
    }
  }
  performance?.end("diffArrayUnique:createPatches");
} 