import type {
  JsonArray,
  JsonValue,
  DiffDelta,
} from "../../../types";
import { deepEqual, deepEqualMemo } from "../../../utils/deep-equal";
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
  ) => Iterable<DiffDelta>,
  getIdentity?: (item: JsonValue) => JsonValue
) {
  const n = arr1.length;
  const m = arr2.length;
  const max = n + m;
  const v: Record<number, number> = { 1: 0 };
  const trace: Record<number, number>[] = [];
  let endD = 0;

  const areEqual = (a: JsonValue, b: JsonValue) =>
    getIdentity ? getIdentity(a) === getIdentity(b) : deepEqualMemo(a, b);

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
      case "common": {
        const item1 = arr1[ai];
        const item2 = arr2[bi];
        if (
          item1 !== undefined &&
          item2 !== undefined &&
          !deepEqual(item1, item2)
        ) {
          for (const delta of diffValues(item1, item2, `${path}/${ai}`)) {
            patches.push(delta);
          }
        }
        ai++;
        bi++;
        break;
      }
      case "replace":
        patches.push({
          op: "replace",
          path: `${path}/${ai}`,
          value: arr2[bi] as JsonValue,
          oldValue: arr1[ai] as JsonValue,
        });
        ai++;
        bi++;
        break;
      case "remove":
        patches.push({
          op: "remove",
          path: `${path}/${ai}`,
          value: undefined,
          oldValue: arr1[ai] as JsonValue,
        });
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
