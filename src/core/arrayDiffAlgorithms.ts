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
import { emitArrayMovesPatch, type MatchedPair } from "./arrayMoves";
import { ignoreMember, type IgnoreTrieNode } from "./ignorePaths";

/**
 * Canonical, key-sorted fingerprint of a JSON value (F21). Two values produce
 * the SAME string iff they are deep-equal per CORE §1.4.1: primitives via
 * `JSON.stringify`, arrays order-sensitively, objects with their keys sorted
 * (so CORE §1.4.2 object-key-order-insensitivity holds). This is exact for JSON
 * inputs, so interning by this fingerprint needs no deepEqual confirmation.
 *
 * Non-JSON inputs are out of scope (CORE §1.1.2). Opaque objects (Date, RegExp, Map,
 * class instances — §F16) have no reliable structural form, so each distinct
 * *reference* is assigned a unique tag via `opaqueId`. This is SOUND (never a
 * false positive that would drop a real change): distinct references compare
 * unequal (matching deepEqual's treatment of two different Dates), and the same
 * reference compares equal. It may over-emit for two equal-valued-but-distinct
 * opaque instances, which is acceptable for out-of-scope inputs.
 */
export function canonicalFingerprint(
  value: JsonValue,
  opaqueId: (o: object) => number,
  // ignorePaths (GEN §10.5): when present, ignored members/elements are
  // OMITTED from the fingerprint, so two items differing only in ignored fields
  // produce the SAME string and intern to the same id (common / move-pairable).
  // When `undefined` (no ignore paths, or none beneath here) the output is
  // byte-identical to the pre-capability fingerprint — byte-stable.
  ignoreNode?: IgnoreTrieNode
): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) as string;
  }
  if (isOpaqueObject(value)) {
    return ` O${opaqueId(value as object)}`;
  }
  if (Array.isArray(value)) {
    // Array element -> the ignore node advances through one wildcard (GEN §10.3).
    const elemIgnore = ignoreNode?.wildcard;
    let s = "[";
    let first = true;
    for (let i = 0; i < value.length; i++) {
      if (elemIgnore?.end) continue; // a fully-ignored element is omitted
      if (!first) s += ",";
      first = false;
      s += canonicalFingerprint(value[i] as JsonValue, opaqueId, elemIgnore);
    }
    return `${s}]`;
  }
  const obj = value as JsonObject;
  const keys = Object.keys(obj).sort();
  let s = "{";
  let first = true;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as string;
    const childIgnore = ignoreNode ? ignoreMember(ignoreNode, k) : undefined;
    if (childIgnore?.end) continue; // an ignored member is omitted (GEN §10.5)
    if (!first) s += ",";
    first = false;
    s += `${JSON.stringify(k)}:${canonicalFingerprint(obj[k] as JsonValue, opaqueId, childIgnore)}`;
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
 * primaryKey applicability gate (GEN §4.3).
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
 * Key equality is by JSON type AND value (no coercion, GEN §4.1.5): a Set
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
  hashFields?: string[],
  // F11 (CORE §4.4.2): when false, removals omit `oldValue`. Additions never
  // carry one, and modifications recurse through `onModification` -> the
  // class differ, which honors the flag itself.
  includeOldValue: boolean = true
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
    const op: Operation = { op: "remove", path: pathPrefix + index };
    if (includeOldValue) op.oldValue = itemsByIndex[index];
    removalPatches[i] = op;
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

/**
 * primaryKey-strategy emitMoves path (F07, GEN §8.7). The caller guarantees
 * the GEN §4.3 gate passed (every element an object with a unique string/number
 * key). Instead of the order-insensitive three-phase emission (GEN §4.1), build
 * the key bijection and hand it to the shared staged emitter, so survivors are
 * REORDERED into `modified` order via `move`s and new keys are INDEXED adds —
 * making `applyPatch(original, p)` equal `modified` byte-exactly (CORE §7.4).
 */
export function diffArrayByPrimaryKeyMoves(
  arr1: JsonArray,
  arr2: JsonArray,
  primaryKey: string,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  includeOldValue: boolean = true
): void {
  // Phase 1: index original by key (GEN §4.1.1). The gate guarantees each item is
  // an object with a string|number key, so no conforming check is needed here.
  const keyToIndex = new Map<string | number, number>();
  for (let i = 0; i < arr1.length; i++) {
    const item = arr1[i] as JsonObject;
    keyToIndex.set(item[primaryKey] as string | number, i);
  }

  const matched: MatchedPair[] = [];
  const pureInserts: number[] = [];
  for (let j = 0; j < arr2.length; j++) {
    const item = arr2[j] as JsonObject;
    const key = item[primaryKey] as string | number;
    const src = keyToIndex.get(key);
    if (src !== undefined) {
      keyToIndex.delete(key);
      matched.push({
        src,
        tgt: j,
        changed: !deepEqual(arr1[src], arr2[j]),
      });
    } else {
      pureInserts.push(j);
    }
  }

  // Keys left in the index are original items with no match -> pure deletes.
  const pureDeletes = Array.from(keyToIndex.values());

  emitArrayMovesPatch(
    arr1,
    arr2,
    path,
    patches,
    matched,
    pureDeletes,
    pureInserts,
    onModification,
    includeOldValue
  );
}

/**
 * Composite-tuple encoding for `map` topology (CORE §8.4.3, determinism pin).
 * The canonical serialization of the JSON array `[e[keys[0]], …, e[keys[t-1]]]`
 * in DECLARED key order, using the pinned scalar serializer (`JSON.stringify`:
 * numbers as canonical f64 text, standard string escaping). Two tuples are the
 * same map key IFF these serializations are byte-identical — preserving
 * type-vs-value distinctness (`[1]` ≠ `["1"]`) and declared-order significance
 * (`[1,2]` ≠ `[2,1]`). The gate (CORE §8.4.2) guarantees every key component is
 * a string or number, so the encoding is total. For `|keys|=1` this generalizes
 * spec-v1's raw `string|number` `Map` key and is OUTPUT-NEUTRAL (CORE §1.4.4),
 * so single-key `map` output is byte-identical to spec-v1 primaryKey.
 */
export function encodeTupleKey(item: JsonObject, keys: string[]): string {
  const tuple: JsonValue[] = new Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    tuple[i] = item[keys[i] as string] as JsonValue;
  }
  return JSON.stringify(tuple) as string;
}

/**
 * `map` per-element applicability gate (CORE §8.4.2). In one O(n+m) pass verify:
 * (a) every element of both arrays is a plain object; (b) every key field is
 * present with a string|number value; (c/d) no duplicate tuple within `arr1` and
 * none within `arr2` (tuple identity by JSON type-and-value per CORE §8.4.1,
 * realized by the CORE §8.4.3 encoding). Any violation → the caller MUST fall
 * back to `sequence`/LCS (§5). For `|keys|=1` this is identical to the spec-v1
 * primaryKey gate (`checkPrimaryKeyApplicable`).
 */
export function checkCompositeKeyApplicable(
  arr1: JsonArray,
  arr2: JsonArray,
  keys: string[]
): boolean {
  const validate = (arr: JsonArray): boolean => {
    const seen = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        return false;
      }
      const obj = item as JsonObject;
      for (let k = 0; k < keys.length; k++) {
        const v = obj[keys[k] as string];
        const t = typeof v;
        if (t !== "string" && t !== "number") return false;
      }
      const tupleKey = encodeTupleKey(obj, keys);
      if (seen.has(tupleKey)) return false;
      seen.add(tupleKey);
    }
    return true;
  };
  return validate(arr1) && validate(arr2);
}

/**
 * `map` / order-INSIGNIFICANT emission (GEN §11.4, CORE §7.2). The spec-v1
 * primaryKey three-phase strategy (GEN §4.1) generalized from a single field to
 * the composite tuple (CORE §8.4.3 encoding as the index Map key). Emits
 * `modifications ++ removals ++ additions`: matched elements recurse field-level
 * at their ORIGINAL index, vanished elements become `remove`s in DESCENDING
 * original index, new elements become `/-` appends in `modified` order. For
 * `|keys|=1` this is byte-identical to `diffArrayByPrimaryKey` (CORE §8.8.1).
 * The caller guarantees the CORE §8.4.2 gate passed.
 */
export function diffArrayByCompositeKey(
  arr1: JsonArray,
  arr2: JsonArray,
  keys: string[],
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  includeOldValue: boolean = true
): void {
  const pathPrefix = path + "/";
  // Phase 1: index original by tuple key (GEN §11.4.1).
  const keyToIndex = new Map<string, number>();
  for (let i = 0; i < arr1.length; i++) {
    keyToIndex.set(encodeTupleKey(arr1[i] as JsonObject, keys), i);
  }

  const modificationPatches: Operation[] = [];
  const additionPatches: Operation[] = [];

  // Phase 2: scan modified by tuple key (GEN §11.4.1).
  for (let i = 0; i < arr2.length; i++) {
    const newItem = arr2[i] as JsonObject;
    const tupleKey = encodeTupleKey(newItem, keys);
    const oldIndex = keyToIndex.get(tupleKey);
    if (oldIndex !== undefined) {
      keyToIndex.delete(tupleKey);
      const oldItem = arr1[oldIndex] as JsonValue;
      if (oldItem !== newItem && !deepEqual(oldItem, newItem)) {
        onModification(oldItem, newItem, pathPrefix + oldIndex, modificationPatches, true);
      }
    } else {
      additionPatches.push({ op: "add", path: pathPrefix + "-", value: newItem });
    }
  }

  // Phase 3: unmatched originals → removals, DESCENDING original index (GEN §11.4.1).
  const removalIndices = Array.from(keyToIndex.values());
  removalIndices.sort((a, b) => b - a);
  const removalPatches: Operation[] = new Array(removalIndices.length);
  for (let i = 0; i < removalIndices.length; i++) {
    const index = removalIndices[i] as number;
    const op: Operation = { op: "remove", path: pathPrefix + index };
    if (includeOldValue) op.oldValue = arr1[index] as JsonValue;
    removalPatches[i] = op;
  }

  // Concatenate modifications ++ removals ++ additions (GEN §4.1.4). Plain loops
  // (not spread) to avoid the argument-count ceiling on very large arrays (F13).
  for (let i = 0; i < modificationPatches.length; i++) patches.push(modificationPatches[i] as Operation);
  for (let i = 0; i < removalPatches.length; i++) patches.push(removalPatches[i] as Operation);
  for (let i = 0; i < additionPatches.length; i++) patches.push(additionPatches[i] as Operation);
}

/**
 * `map` / order-SIGNIFICANT emission (GEN §11.4.2, CORE §7.4). Build the tuple
 * bijection between surviving `original` indices and their `modified` targets and
 * hand it to the shared staged move-emitter, so survivors are REORDERED into
 * `modified` order via `move`s and new keys are INDEXED adds — making
 * `applyPatch(original, p)` equal `modified` byte-exactly. The move machinery
 * runs UNCONDITIONALLY for this topology (independent of the `emitMoves` option;
 * GEN §8.8). The caller guarantees the CORE §8.4.2 gate passed.
 */
export function diffArrayByCompositeKeyMoves(
  arr1: JsonArray,
  arr2: JsonArray,
  keys: string[],
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  includeOldValue: boolean = true
): void {
  const keyToIndex = new Map<string, number>();
  for (let i = 0; i < arr1.length; i++) {
    keyToIndex.set(encodeTupleKey(arr1[i] as JsonObject, keys), i);
  }

  const matched: MatchedPair[] = [];
  const pureInserts: number[] = [];
  for (let j = 0; j < arr2.length; j++) {
    const tupleKey = encodeTupleKey(arr2[j] as JsonObject, keys);
    const src = keyToIndex.get(tupleKey);
    if (src !== undefined) {
      keyToIndex.delete(tupleKey);
      matched.push({ src, tgt: j, changed: !deepEqual(arr1[src], arr2[j]) });
    } else {
      pureInserts.push(j);
    }
  }

  const pureDeletes = Array.from(keyToIndex.values());

  emitArrayMovesPatch(
    arr1,
    arr2,
    path,
    patches,
    matched,
    pureDeletes,
    pureInserts,
    onModification,
    includeOldValue
  );
}

/** Assign a stable per-reference id to an opaque (non-JSON) object, closed over one Map. */
function makeOpaqueIdAllocator(): (o: object) => number {
  const idMap = new Map<object, number>();
  let seq = 0;
  return (o: object): number => {
    let id = idMap.get(o);
    if (id === undefined) {
      id = seq++;
      idMap.set(o, id);
    }
    return id;
  };
}

/**
 * `set` uniqueness gate (CORE §8.5.1). Every element of `arr1` MUST be unique by
 * deep value (CORE §1.4.1) and every element of `arr2` likewise. A deep-equal
 * duplicate in either array → the caller MUST fall back to `sequence`/LCS (§5):
 * a `set` is only well-defined when its members are distinguishable by value.
 * Uses the canonical fingerprint (exact deep-equal for JSON inputs).
 */
export function checkArraysSetUnique(arr1: JsonArray, arr2: JsonArray): boolean {
  const opaqueId = makeOpaqueIdAllocator();
  const uniqueByValue = (arr: JsonArray): boolean => {
    const seen = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const fp = canonicalFingerprint(arr[i] as JsonValue, opaqueId);
      if (seen.has(fp)) return false;
      seen.add(fp);
    }
    return true;
  };
  return uniqueByValue(arr1) && uniqueByValue(arr2);
}

/**
 * `set` membership emission (GEN §11.3, CORE §8.5). Element identity is the
 * element VALUE itself (deep equality); order is insignificant. Emit removals of
 * `original` values ABSENT from `modified` by DESCENDING original index (each
 * with `oldValue` per `includeOldValue`), THEN additions of `modified` values
 * ABSENT from `original` via `/-` append in `modified` order. No positional
 * replaces: survivors receive no op. The caller guarantees the CORE §8.5.1 gate
 * passed, so "absent from" is unambiguous (multiset = set).
 */
export function diffArraySet(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  includeOldValue: boolean = true
): void {
  const prefix = path === "" ? "/" : path + "/";
  const opaqueId = makeOpaqueIdAllocator();
  // Fingerprint each element once (CORE §1.4.1 interning; output-neutral).
  const fpA: string[] = new Array(arr1.length);
  for (let i = 0; i < arr1.length; i++) fpA[i] = canonicalFingerprint(arr1[i] as JsonValue, opaqueId);
  const fpB: string[] = new Array(arr2.length);
  for (let j = 0; j < arr2.length; j++) fpB[j] = canonicalFingerprint(arr2[j] as JsonValue, opaqueId);
  const setA = new Set(fpA);
  const setB = new Set(fpB);

  // Removals: DESCENDING original index keeps lower survivor indices valid under
  // sequential apply (GEN §11.3.2).
  for (let i = arr1.length - 1; i >= 0; i--) {
    if (!setB.has(fpA[i] as string)) {
      const op: Operation = { op: "remove", path: prefix + i };
      if (includeOldValue) op.oldValue = arr1[i] as JsonValue;
      patches.push(op);
    }
  }
  // Additions: `/-` append in modified order (GEN §11.3.3).
  for (let j = 0; j < arr2.length; j++) {
    if (!setA.has(fpB[j] as string)) {
      patches.push({ op: "add", path: prefix + "-", value: arr2[j] as JsonValue });
    }
  }
}

export function diffArrayLCS(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  // Granular descent of collapsed `replace` pairs (GEN §5.4.2 / F10): when both
  // sides of a collapsed replace are the same container kind (both objects, or
  // both arrays), this recurses to emit granular nested ops instead of a
  // whole-item replace. `common` entries are proven equal by interning and are
  // NEVER routed through it (F20) — only genuine same-kind replacements are.
  onModification: ModificationCallback,
  hashFields?: string[],
  plan?: ArrayPlan,
  // F11 (CORE §4.4.2): when false, every `remove`/`replace` this function
  // emits omits `oldValue`. Same-kind granular replacements recurse through
  // `onModification` -> the class differ, which honors the flag itself.
  includeOldValue: boolean = true,
  // emitMoves capability (GEN §8, CONF §5.4): when true, the main Myers path
  // emits a single RFC 6902 `move` for each relocated (deep-equal) element
  // instead of a remove+add pair (F22). Default false — byte-stable output.
  emitMoves: boolean = false,
  // ignorePaths (GEN §10.5): the item-level ignore node (the array's wildcard
  // child). Threaded into the interning fingerprint so ignored members do not
  // participate in element identity. `undefined` when no ignore path lies within
  // these items — then interning is byte-identical to the pre-capability path.
  itemIgnore?: IgnoreTrieNode
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

  // Empty-array fast paths (GEN §5.1).
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
      const op: Operation = { op: "remove", path: prefixPath + i };
      if (includeOldValue) op.oldValue = arr1[i] as JsonValue;
      patches.push(op);
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

  // Deep-equal predicate (CORE §1.4.1) used by the prefix/suffix trim (GEN §5.0).
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

  // GEN §5.0 Trim step 0: maximal common prefix first, then the maximal common
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

  // Windowed fast paths (generalise GEN §5.1 to the trimmed remainder).
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
      const op: Operation = { op: "remove", path: prefixPath + (lo + j) };
      if (includeOldValue) op.oldValue = arr1[lo + j] as JsonValue;
      patches.push(op);
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
  // exact deep-equal for JSON inputs (CORE §1.4), so no deepEqual confirmation is
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
    const fp = canonicalFingerprint(value, opaqueId, itemIgnore);
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
  // tie-breaks (GEN §5.2) therefore apply to the window.
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

  // emitMoves capability (GEN §8.4 / F22). Reconstruct the full original↔
  // modified bijection from the (collapsed) script plus the trimmed prefix/
  // suffix, pair leftover removes with equal-valued leftover adds into
  // relocations (by interned id — exact deep-equal, never pairing non-identical
  // values), and hand the bijection to the shared staged move-emitter. The
  // move-free fast paths above (n/m/wn/wm === 0) already emit the same ops the
  // emitter would, so only this main path branches.
  if (emitMoves) {
    const matched: MatchedPair[] = [];
    const leftoverRemoves: Array<{ src: number; id: number }> = [];
    const leftoverAdds: Array<{ tgt: number; id: number }> = [];
    // Trimmed common prefix: unchanged, in place.
    for (let i = 0; i < lo; i++) matched.push({ src: i, tgt: i, changed: false });
    // Window (collapsed script), offset by lo into absolute array coordinates.
    for (const op of optimizedScript) {
      if (op.op === "common") {
        matched.push({
          src: lo + (op.ai as number),
          tgt: lo + (op.bi as number),
          changed: false,
        });
      } else if (op.op === "replace") {
        matched.push({
          src: lo + (op.ai as number),
          tgt: lo + (op.bi as number),
          changed: true,
        });
      } else if (op.op === "remove") {
        const ai = op.ai as number;
        leftoverRemoves.push({ src: lo + ai, id: idsA[ai] as number });
      } else {
        const bi = op.bi as number;
        leftoverAdds.push({ tgt: lo + bi, id: idsB[bi] as number });
      }
    }
    // Trimmed common suffix: unchanged, in place.
    for (let j = 0; j < hi; j++) {
      matched.push({ src: n - 1 - j, tgt: m - 1 - j, changed: false });
    }
    // Pair leftover removes with equal-id leftover adds -> relocations. For each
    // id, adds are queued in ascending target order; each remove (in script
    // order) claims the earliest unused add of the same id (pinned tie-break).
    const addsById = new Map<number, number[]>();
    for (let a = 0; a < leftoverAdds.length; a++) {
      const id = (leftoverAdds[a] as { id: number }).id;
      let q = addsById.get(id);
      if (!q) {
        q = [];
        addsById.set(id, q);
      }
      q.push(a);
    }
    const addUsed = new Uint8Array(leftoverAdds.length);
    const pureDeletes: number[] = [];
    for (let r = 0; r < leftoverRemoves.length; r++) {
      const rm = leftoverRemoves[r] as { src: number; id: number };
      const q = addsById.get(rm.id);
      const a = q && q.length > 0 ? (q.shift() as number) : -1;
      if (a >= 0) {
        addUsed[a] = 1;
        matched.push({
          src: rm.src,
          tgt: (leftoverAdds[a] as { tgt: number }).tgt,
          changed: false,
        });
      } else {
        pureDeletes.push(rm.src);
      }
    }
    const pureInserts: number[] = [];
    for (let a = 0; a < leftoverAdds.length; a++) {
      if (!addUsed[a]) pureInserts.push((leftoverAdds[a] as { tgt: number }).tgt);
    }
    emitArrayMovesPatch(
      arr1,
      arr2,
      path,
      patches,
      matched,
      pureDeletes,
      pureInserts,
      onModification,
      includeOldValue
    );
    return;
  }

  // Apply operations and generate patches. currentIndex starts at lo: the
  // trimmed common prefix occupies output indices 0..lo-1 unchanged. Window
  // coordinates ai/bi are offset by lo when fetching values (GEN §5.5).
  let currentIndex = lo;

  for (const operation of optimizedScript) {
    switch (operation.op) {
      case "common": {
        // A `common` entry means idsA[ai] === idsB[bi], i.e. the elements are
        // proven deep-equal by interning (CORE §1.4). The old code still called
        // onModification here, which re-ran a full deep-equal that could only
        // return "equal" and emit nothing — dead re-verification, up to a
        // second (or, with a plan, third) full structural walk per element on
        // mostly-unchanged arrays (F20). It is deleted. `onModification` IS used
        // for the granular descent of collapsed `replace` pairs (GEN §5.4.2 / F10,
        // the `replace` case below); do NOT route common entries through it —
        // they are already proven deep-equal by interning.
        currentIndex++;
        break;
      }
      case "replace": {
        const v1 = arr1[lo + (operation.ai as number)] as JsonValue;
        const v2 = arr2[lo + (operation.bi as number)] as JsonValue;
        // GEN §5.4.2 Granular descent (F10). If both sides are the same container
        // kind — both plain objects, or both arrays — recurse via onModification
        // with skipEqualityCheck=true (exactly the diffArrayByPrimaryKey
        // modification path) to emit granular nested ops at this index instead of
        // a whole-item replace carrying full value + oldValue. The callback
        // (index.ts) picks the correct trie node for the recursion: an object
        // element stays at THIS array's node (item property plans are its
        // children, CORE §3.3.3); an array element descends to the wildcard child
        // (the nested array's plan at `${path}/*`, CORE §3.3.5). Primitives and
        // mismatched-kind pairs (object vs array) keep the whole-item replace.
        const bothObjects =
          v1 !== null &&
          v2 !== null &&
          typeof v1 === "object" &&
          typeof v2 === "object" &&
          Array.isArray(v1) === Array.isArray(v2);
        if (bothObjects) {
          onModification(v1, v2, prefixPath + currentIndex, patches, true);
        } else {
          const op: Operation = {
            op: "replace",
            path: prefixPath + currentIndex,
            value: v2,
          };
          if (includeOldValue) op.oldValue = v1;
          patches.push(op);
        }
        currentIndex++;
        break;
      }
      case "remove": {
        const op: Operation = {
          op: "remove",
          path: prefixPath + currentIndex,
        };
        if (includeOldValue) op.oldValue = arr1[lo + (operation.ai as number)];
        patches.push(op);
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

/**
 * `unique` strategy (GEN §6): per-index positional replaces, nothing else.
 *
 * F38: the caller's ONLY call site gates this strategy on
 * `strategy === "unique" && checkArraysUnique(arr1, arr2)` (index.ts), and
 * `checkArraysUnique` requires `arr1.length === arr2.length` (GEN §4.4). Under
 * that equal-length gate, a HEAD-era removal/addition phase built on top of
 * Phase 1's positional replace loop was provably unreachable: a removal
 * required `arr1[i] === arr2[i]` (position untouched by Phase 1) AND
 * `!arr2Map.has(arr1[i])` (value absent from `arr2`) — a contradiction, since
 * `arr1[i] === arr2[i]` is itself a member of `arr2` at index `i`
 * (symmetrically for additions against `arr1Map`). So every element of both
 * arrays was always classified by Phase 1 alone (replace if positions
 * differ, no-op otherwise), and the `arr1Map`/`arr2Map`/`replacedItems`
 * bookkeeping, the two Map builds, and the removal/addition scans (~60 lines)
 * always executed for zero effect on the emitted ops. Deleted; behavior is
 * unchanged (proven by the existing test suite, none of which exercised the
 * dead phases since they cannot fire behind this gate). Set-diff / move
 * semantics for `unique` remain unspecified (GEN §6.2) — an unequal-length pair
 * never reaches this function.
 */
export function diffArrayUnique(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  // F11 (CORE §4.4.2): when false, `replace` ops omit `oldValue`.
  includeOldValue: boolean = true
) {
  const n = arr1.length; // === arr2.length under the equal-length gate (GEN §4.4)
  const pathPrefix = path + "/";

  for (let i = 0; i < n; i++) {
    const val1 = arr1[i];
    const val2 = arr2[i];
    if (val1 !== val2) {
      const op: Operation = { op: "replace", path: pathPrefix + i, value: val2 };
      if (includeOldValue) op.oldValue = val1;
      patches.push(op);
    }
  }
}

/**
 * unique-strategy emitMoves path (F23, GEN §8.6). The caller guarantees the
 * GEN §4.4 gate passed (equal length, no duplicates in either side — so values are
 * primitives that form a bijection candidate by value). If the two arrays are
 * **multiset-equal** (a pure permutation), emit the reorder as `move`s via the
 * shared staged emitter and return `true`. Otherwise return `false` so the
 * caller keeps the GEN §6 positional-replace emission (moves buy nothing when the
 * value sets differ). All matched pairs are `changed:false` (equal values), so
 * `onModification` is never invoked here.
 */
export function diffArrayUniqueMoves(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  includeOldValue: boolean = true
): boolean {
  // Values are primitives (unique strategy is only assigned to primitive item
  // schemas), so the raw value is a sound Map key that distinguishes 1 from "1".
  const idxOf = new Map<JsonValue, number>();
  for (let i = 0; i < arr2.length; i++) idxOf.set(arr2[i] as JsonValue, i);

  const matched: MatchedPair[] = new Array(arr1.length);
  for (let i = 0; i < arr1.length; i++) {
    const tgt = idxOf.get(arr1[i] as JsonValue);
    // A missing value means the sets differ -> not a pure permutation.
    if (tgt === undefined) return false;
    matched[i] = { src: i, tgt, changed: false };
  }

  emitArrayMovesPatch(
    arr1,
    arr2,
    path,
    patches,
    matched,
    [],
    [],
    onModification,
    includeOldValue
  );
  return true;
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
