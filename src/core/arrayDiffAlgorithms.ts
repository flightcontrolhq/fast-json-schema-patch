import type { ArrayPlan } from "../core/buildPlan";
import {
  deepEqual,
  deepEqualMemo,
  deepEqualSchemaAware,
  getPlanFingerprint,
  isOpaqueObject,
} from "../performance/deepEqual";
import { getEffectiveHashFields } from "../performance/getEffectiveHashFields";
import type { JsonArray, JsonObject, JsonValue, Operation } from "../types";

/**
 * Canonical, key-sorted fingerprint of a JSON value (F21). Two values produce
 * the SAME string iff they are deep-equal per SPEC §2.4.1: primitives via
 * `JSON.stringify`, arrays order-sensitively, objects with their keys sorted
 * (so §2.4.2 object-key-order-insensitivity holds). This is exact for JSON
 * inputs, so interning by this fingerprint needs no deepEqual confirmation.
 *
 * Non-JSON inputs are out of scope (§2.1.2). Opaque objects (Date, RegExp, Map,
 * class instances — §F16) have no reliable structural form, so each distinct
 * *reference* is assigned a unique tag via `opaqueId`. This is SOUND (never a
 * false positive that would drop a real change): distinct references compare
 * unequal (matching deepEqual's treatment of two different Dates), and the same
 * reference compares equal. It may over-emit for two equal-valued-but-distinct
 * opaque instances, which is acceptable for out-of-scope inputs.
 */
export function canonicalFingerprint(
  value: JsonValue,
  opaqueId: (o: object) => number
): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) as string;
  }
  if (isOpaqueObject(value)) {
    return ` O${opaqueId(value as object)}`;
  }
  if (Array.isArray(value)) {
    let s = "[";
    for (let i = 0; i < value.length; i++) {
      if (i > 0) s += ",";
      s += canonicalFingerprint(value[i] as JsonValue, opaqueId);
    }
    return `${s}]`;
  }
  const obj = value as JsonObject;
  const keys = Object.keys(obj).sort();
  let s = "{";
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as string;
    if (i > 0) s += ",";
    s += `${JSON.stringify(k)}:${canonicalFingerprint(obj[k] as JsonValue, opaqueId)}`;
  }
  return `${s}}`;
}

export type ModificationCallback = (
  item1: JsonValue,
  item2: JsonValue,
  path: string,
  patches: Operation[],
  skipEqualityCheck?: boolean
) => void;

/**
 * primaryKey applicability gate (SPEC §5.4.3).
 *
 * Before committing to the primaryKey strategy, verify in one O(n+m) pass over
 * both arrays that:
 *   (a) every element of both arrays is a plain object whose value at
 *       `primaryKey` is a string or number (present, non-null); and
 *   (b) there are no duplicate key values within `arr1` and none within `arr2`.
 *
 * If either check fails, the caller MUST fall back to diffArrayLCS for this
 * diff. Without the gate, non-conforming elements are silently skipped
 * (added/removed items vanish from the patch, F05) and duplicate keys corrupt
 * the last-write-wins index so even identical arrays emit a growing patch (F06).
 * Key equality is by JSON type AND value (no coercion, §5.4.1.5): a Set
 * distinguishes numeric `1` from string `"1"` natively.
 */
export function checkPrimaryKeyApplicable(
  arr1: JsonArray,
  arr2: JsonArray,
  primaryKey: string
): boolean {
  const seen1 = new Set<string | number>();
  for (let i = 0; i < arr1.length; i++) {
    const item = arr1[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    const keyValue = (item as JsonObject)[primaryKey];
    const keyType = typeof keyValue;
    if (keyType !== "string" && keyType !== "number") {
      return false;
    }
    const key = keyValue as string | number;
    if (seen1.has(key)) return false;
    seen1.add(key);
  }

  const seen2 = new Set<string | number>();
  for (let i = 0; i < arr2.length; i++) {
    const item = arr2[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return false;
    }
    const keyValue = (item as JsonObject)[primaryKey];
    const keyType = typeof keyValue;
    if (keyType !== "string" && keyType !== "number") {
      return false;
    }
    const key = keyValue as string | number;
    if (seen2.has(key)) return false;
    seen2.add(key);
  }

  return true;
}

export function diffArrayByPrimaryKey(
  arr1: JsonArray,
  arr2: JsonArray,
  primaryKey: string,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  hashFields?: string[]
) {
  // F37: this used to also accept a `plan` 8th argument, but the only real
  // caller (index.ts's diffArray) never passed one, making the
  // deepEqualSchemaAware branch below permanently unreachable — and even if
  // wired, it would buy nothing here: buildPlan's auto-detected primaryKey is
  // always itself a required string/number field, so it is always included
  // in `hashFields` (metadata.hashFields is built by scanning `required` for
  // primitive fields BEFORE the candidate-key loop selects one of them,
  // buildPlan.ts), and a `primaryKeyMap` override sets neither `hashFields`
  // nor `requiredFields`. So the only way to reach this function with empty
  // `hashFields` is the override path, where deepEqualSchemaAware's
  // requiredFields/primaryKey early-exits are no-ops (both fields are
  // undefined) and it falls straight through to the same `deepEqual(a, b)`
  // the plain branch below already performs — just via a heavier
  // WeakMap-cache-and-fingerprint path for zero benefit, since matched items
  // are already known-equal on `primaryKey` from the Phase 2 lookup itself.
  // Deleted rather than wired; deepEqualSchemaAware's real hot-path caller is
  // diffArrayLCS's prefix/suffix trim (see below).
  const effectiveHashFields = hashFields && hashFields.length > 0 ? hashFields : [];
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

  // Plain loops rather than spread pushes: a single array can contribute
  // >125k ops (e.g. clearing a 150k-item keyed array), and
  // `patches.push(...ops)` passes every element as a call argument, which
  // throws RangeError: Maximum call stack size exceeded past the engine's
  // argument limit (F13).
  for (let i = 0; i < modificationPatches.length; i++) {
    patches.push(modificationPatches[i] as Operation);
  }
  for (let i = 0; i < removalPatches.length; i++) {
    patches.push(removalPatches[i] as Operation);
  }
  for (let i = 0; i < additionPatches.length; i++) {
    patches.push(additionPatches[i] as Operation);
  }
}

export function diffArrayLCS(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  // Reserved for granular descent of collapsed `replace` pairs (§5.5.4.2 / F10,
  // compactness phase); intentionally unused until then. `common` entries are
  // proven equal by interning and never routed through it (F20).
  // biome-ignore lint/correctness/noUnusedFunctionParameters: wired for P3 F10 granular descent
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

  const prefixPath = path === "" ? "/" : path + "/";

  // Empty-array fast paths (SPEC §5.5.1).
  if (n === 0) {
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
        path: prefixPath + i,
        oldValue: arr1[i] as JsonValue,
      });
    }
    return;
  }

  // F37: hoist the plan fingerprint ONCE for this whole array diff (it is a
  // pure function of `plan`, invariant across every position the trim below
  // queries) instead of letting deepEqualSchemaAware rebuild the fingerprint
  // string on every call. Paired with `effectiveHashFields` (already hoisted
  // above), this removes deepEqualSchemaAware's per-call
  // getEffectiveHashFields/getPlanFingerprint recomputation from the one
  // real hot per-pair loop that reaches it (the prefix/suffix trim scans up
  // to O(n) positions sequentially for a long common run — the library's
  // primary "mostly-unchanged array" use case, F20).
  const schemaAwarePrecomputed = plan
    ? { effectiveHashFields, planFingerprint: getPlanFingerprint(plan) }
    : undefined;

  // Deep-equal predicate (SPEC §2.4.1) used by the prefix/suffix trim (§5.5.0).
  // Trimming queries each position at most once (lo and hi advance
  // monotonically), so no per-pair cache is needed here; the Myers snake uses
  // interned ids instead (below). The old n*m-capacity equalCache Map is gone
  // (F34) along with its collision-prone key (F21).
  const deepEqualAt = (x: number, y: number): boolean =>
    plan
      ? deepEqualSchemaAware(
          arr1[x],
          arr2[y],
          plan,
          effectiveHashFields,
          schemaAwarePrecomputed
        )
      : deepEqualMemo(arr1[x], arr2[y], effectiveHashFields);

  // §5.5.0 Trim step 0: maximal common prefix first, then the maximal common
  // suffix of the remainder. Myers then runs only on the trimmed window
  // [lo, n-hi) × [lo, m-hi); emitted indices are offset by lo. This bounds cost
  // by the edit region rather than the array length (F09) and keeps the Myers
  // coordinates small.
  let lo = 0;
  while (lo < n && lo < m && deepEqualAt(lo, lo)) lo++;
  let hi = 0;
  while (hi < n - lo && hi < m - lo && deepEqualAt(n - 1 - hi, m - 1 - hi)) hi++;

  const wn = n - lo - hi; // original window length
  const wm = m - lo - hi; // modified window length

  // Windowed fast paths (generalise §5.5.1 to the trimmed remainder).
  if (wn === 0 && wm === 0) return; // arrays are deep-equal
  if (wn === 0) {
    // Pure insertion window (append / prepend / interior insert): ascending
    // adds at the evolving index, which starts at the prefix length lo.
    for (let j = 0; j < wm; j++) {
      patches.push({
        op: "add",
        path: prefixPath + (lo + j),
        value: arr2[lo + j] as JsonValue,
      });
    }
    return;
  }
  if (wm === 0) {
    // Pure deletion window (truncate / prefix / suffix / interior removal):
    // descending removes so lower indices stay valid during application.
    for (let j = wn - 1; j >= 0; j--) {
      patches.push({
        op: "remove",
        path: prefixPath + (lo + j),
        oldValue: arr1[lo + j] as JsonValue,
      });
    }
    return;
  }

  // F21/F34: intern the window elements to integer ids via a canonical,
  // key-sorted fingerprint shared across BOTH arrays, so the Myers snake
  // compares ids in O(1) (`idsA[x] === idsB[y]`) instead of deep-comparing each
  // pair and memoizing the verdict in a Map that could grow to O(wn·wm). Each
  // element is fingerprinted exactly once — O(window content) — regardless of
  // how many times Myers revisits it. All state here is call-local, so there is
  // no cross-call cache and no epoch concern (F02). Fingerprint equality is
  // exact deep-equal for JSON inputs (§2.4), so no deepEqual confirmation is
  // needed.
  const fpToId = new Map<string, number>();
  let nextId = 0;
  const opaqueIdMap = new Map<object, number>();
  let opaqueSeq = 0;
  const opaqueId = (o: object): number => {
    let id = opaqueIdMap.get(o);
    if (id === undefined) {
      id = opaqueSeq++;
      opaqueIdMap.set(o, id);
    }
    return id;
  };
  const intern = (value: JsonValue): number => {
    const fp = canonicalFingerprint(value, opaqueId);
    let id = fpToId.get(fp);
    if (id === undefined) {
      id = nextId++;
      fpToId.set(fp, id);
    }
    return id;
  };
  const idsA = new Int32Array(wn);
  const idsB = new Int32Array(wm);
  for (let i = 0; i < wn; i++) idsA[i] = intern(arr1[lo + i] as JsonValue);
  for (let i = 0; i < wm; i++) idsB[i] = intern(arr2[lo + i] as JsonValue);

  // Myers O(ND) forward pass over the trimmed window. Window coordinates
  // x∈[0,wn], y∈[0,wm] map to array indices (lo + x, lo + y); the pinned
  // tie-breaks (§5.5.2) therefore apply to the window.
  const max = wn + wm;
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

      // Snake: interned-id equality is exact deep-equal for the window (F21).
      while (x < wn && y < wm && idsA[x] === idsB[y]) {
        x++;
        y++;
      }

      vCurr[kOffset] = x;

      if (x >= wn && y >= wm) {
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

  // Backtracking to build edit script (window coordinates).
  const editScript: Array<{
    op: "common" | "remove" | "add";
    ai?: number;
    bi?: number;
  }> = [];

  let x = wn;
  let y = wm;

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

  // Apply operations and generate patches. currentIndex starts at lo: the
  // trimmed common prefix occupies output indices 0..lo-1 unchanged. Window
  // coordinates ai/bi are offset by lo when fetching values (§5.5.5).
  let currentIndex = lo;

  for (const operation of optimizedScript) {
    switch (operation.op) {
      case "common": {
        // A `common` entry means idsA[ai] === idsB[bi], i.e. the elements are
        // proven deep-equal by interning (§2.4). The old code still called
        // onModification here, which re-ran a full deep-equal that could only
        // return "equal" and emit nothing — dead re-verification, up to a
        // second (or, with a plan, third) full structural walk per element on
        // mostly-unchanged arrays (F20). It is deleted. `onModification` is
        // retained as a parameter for the granular-descent of collapsed
        // `replace` pairs (§5.5.4.2 / F10), which lands in the compactness
        // phase; do NOT route common entries through it.
        currentIndex++;
        break;
      }
      case "replace": {
        patches.push({
          op: "replace",
          path: prefixPath + currentIndex,
          value: arr2[lo + (operation.bi as number)] as JsonValue,
          oldValue: arr1[lo + (operation.ai as number)],
        });
        currentIndex++;
        break;
      }
      case "remove": {
        patches.push({
          op: "remove",
          path: prefixPath + currentIndex,
          oldValue: arr1[lo + (operation.ai as number)],
        });
        // Don't increment currentIndex for removes
        break;
      }
      case "add": {
        patches.push({
          op: "add",
          path: prefixPath + currentIndex,
          value: arr2[lo + (operation.bi as number)] as JsonValue,
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
    for (let i = 0; i < patches_temp.length; i++) {
      patches.push(patches_temp[i] as Operation);
    }
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
    for (let i = 0; i < patches_temp.length; i++) {
      patches.push(patches_temp[i] as Operation);
    }
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

  // Plain loop rather than spread push to avoid RangeError on large arrays (F13).
  for (let i = 0; i < patches_temp.length; i++) {
    patches.push(patches_temp[i] as Operation);
  }
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
