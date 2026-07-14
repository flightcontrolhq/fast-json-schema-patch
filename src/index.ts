import {
  checkArraysUnique,
  checkPrimaryKeyApplicable,
  diffArrayByPrimaryKey,
  diffArrayByPrimaryKeyMoves,
  diffArrayLCS,
  diffArrayUnique,
  diffArrayUniqueMoves,
  type ModificationCallback,
} from "./core/arrayDiffAlgorithms";
import type { ArrayPlan, Plan } from "./core/buildPlan";
import { deepEqualMemo, isOpaqueObject } from "./performance/deepEqual";
import { bumpEpoch } from "./performance/epoch";
import type { JsonArray, JsonObject, JsonValue, Operation } from "./types";
import { escapeJsonPointer, unescapeJsonPointer } from "./utils/pathUtils";

export { buildPlan } from "./core/buildPlan";
export { StructuredDiff } from "./aggregators/StructuredDiff";
export { applyPatch, invertPatch, toRfc6902, JsonPatchError } from "./apply/applyPatch";
export type { ApplyPatchOptions, PatchErrorCode } from "./apply/applyPatch";

export type {
  StructuredDiffConfig,
  StructuredDiffResult,
  FormattedParentDiff,
  FormattedChildDiff,
  StructuredDiffLine,
  Operation,
} from "./types";
export type { Plan, BuildPlanOptions } from "./core/buildPlan";

/**
 * A node in the compiled plan trie (SPEC §5.4.5). The public `Plan` is still a
 * flat `Map<documentPath, ArrayPlan>`; the constructor compiles it once into
 * this trie so strategy selection at diff time is *structural* — the current
 * node is threaded down the recursion instead of re-deriving and string-keying
 * a concrete path per array (which grew four unbounded per-instance caches, F18,
 * and mis-routed numeric object keys via index-normalization, F33).
 *
 * Each plan-key segment is either a literal property name (an exact `children`
 * edge, stored UNESCAPED so it matches raw object keys) or the wildcard `*`
 * (the `wildcard` edge — an `additionalProperties` value schema, §4.3.2, or the
 * nested-array element level, §4.3.5). `plan` is set iff a plan key terminates
 * at this node (the array registered at that path).
 */
interface PlanTrieNode {
  plan?: ArrayPlan;
  children?: Map<string, PlanTrieNode>;
  wildcard?: PlanTrieNode;
}

export class JsonSchemaPatcher {
  private plan: Plan;
  private readonly planIsEmpty: boolean;
  private readonly planTrie: PlanTrieNode;
  /**
   * F11 / capability `includeOldValue` (SPEC §6.4, §10.4). When `true`
   * (default, back-compat) every `remove`/`replace` op carries the complete
   * pre-change subtree in `oldValue`. When `false`, NO emission site attaches
   * `oldValue`, yielding strict RFC 6902-shaped ops (add/remove/replace with
   * only path/value) and measurably smaller patches on remove/replace-heavy
   * diffs. `invertPatch` still round-trips because it recovers old values from
   * the original document, not from `oldValue` (SPEC §6.4.2, §9).
   */
  private readonly includeOldValue: boolean;
  /**
   * emitMoves capability (SPEC §5.8, §10.4.4). When `false` (default) output is
   * byte-stable versus the pre-capability tree. When `true`, relocated
   * (deep-equal) array elements are expressed as single RFC 6902 `move` ops
   * instead of remove+add pairs, and both the `unique` and `primaryKey`
   * strategies reconstruct `modified` ORDER EXACTLY (upgrading the §7.2
   * primaryKey contract from keyed-collection to exact). Applies across LCS
   * relocations (F22), unique reorders (F23), and primaryKey order fidelity
   * (F07).
   */
  private readonly emitMoves: boolean;
  /**
   * wholesaleReplaceFallback capability (SPEC §5.5.6 / §10.4.5, F24). When
   * `false` (default) output is byte-stable versus the pre-capability tree.
   * When `true`, each array diff is first generated into a local buffer as
   * usual; if the SPEC §5.5.6.1 byte estimate of that buffer exceeds
   * `JSON.stringify(modified-array).length`, the buffer is discarded and
   * replaced with a single whole-array `{op:"replace"}` (carrying `oldValue`
   * per `includeOldValue`). This caps a heavily-rewritten array's patch size
   * at roughly the new array's own serialized size instead of letting a
   * granular op stream exceed it.
   */
  private readonly wholesaleReplaceFallback: boolean;

  constructor(options: {
    plan: Plan;
    includeOldValue?: boolean;
    emitMoves?: boolean;
    wholesaleReplaceFallback?: boolean;
  }) {
    // F42: fail fast with an actionable message instead of a cryptic
    // "undefined is not an object (evaluating this.plan.size)" TypeError
    // thrown later from the planIsEmpty computation below. Any Map instance
    // is accepted, including an empty one (`new Map()`), which is the
    // documented schemaless mode (SPEC §10.1: "schema omitted/null -> diff
    // with an empty plan").
    if (!(options?.plan instanceof Map)) {
      throw new TypeError(
        "JsonSchemaPatcher requires { plan: Map<string, ArrayPlan> }. " +
          "Build one with buildPlan({ schema }), or pass { plan: new Map() } " +
          "to diff without a schema (schemaless mode)."
      );
    }
    this.plan = options.plan;
    this.planIsEmpty = this.plan.size === 0;
    this.planTrie = this.compilePlanTrie(this.plan);
    // Default on for back-compat (SPEC §6.4.1); opt out with `false`.
    this.includeOldValue = options.includeOldValue ?? true;
    // Default OFF (SPEC §10.4.4): byte-stable output unless explicitly enabled.
    this.emitMoves = options.emitMoves ?? false;
    // Default OFF (SPEC §10.4.5): byte-stable output unless explicitly enabled.
    this.wholesaleReplaceFallback = options.wholesaleReplaceFallback ?? false;
  }

  /**
   * SPEC §5.5.6.1 (F24): a deterministic, cheap-to-compute estimate of the
   * serialized size of `ops` — NOT an exact `JSON.stringify(ops).length`, but
   * pinned exactly so a reimplementation reproduces the identical cutover
   * decision. For each op: `+30` (fixed per-op overhead standing in for
   * `{"op":"...","path":"..."}` structure) plus `JSON.stringify(op.value).length`
   * when `value` is present, plus `JSON.stringify(op.oldValue).length` when
   * `oldValue` is present. `move` ops (no `value`/`oldValue`) contribute only
   * the 30B overhead.
   */
  private static estimatePatchBytes(ops: Operation[]): number {
    let total = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as Operation;
      total += 30;
      if (op.value !== undefined) total += JSON.stringify(op.value).length;
      if (op.oldValue !== undefined) total += JSON.stringify(op.oldValue).length;
    }
    return total;
  }

  /**
   * Compile the flat `Plan` map into a trie (SPEC §5.4.5). Each key is split on
   * `/`; a `*` segment is the wildcard edge, any other segment is unescaped and
   * stored as an exact `children` edge. The empty key `""` (a root-level array
   * document) terminates at the root node itself.
   */
  private compilePlanTrie(plan: Plan): PlanTrieNode {
    const root: PlanTrieNode = {};
    for (const [key, arrayPlan] of plan) {
      const segments = key.length === 0 ? [] : key.split("/").slice(1);
      let node = root;
      for (const seg of segments) {
        if (seg === "*") {
          node.wildcard ??= {};
          node = node.wildcard;
        } else {
          const raw = unescapeJsonPointer(seg);
          node.children ??= new Map();
          let child = node.children.get(raw);
          if (!child) {
            child = {};
            node.children.set(raw, child);
          }
          node = child;
        }
      }
      node.plan = arrayPlan;
    }
    return root;
  }

  /**
   * Computes an RFC 6902-style patch (with an added `oldValue` on `remove`/
   * `replace`) that transforms `original` into `modified`.
   *
   * **JSON-only contract (SPEC §2.1.2):** `original` and `modified` MUST be
   * JSON values — the value space produced by `JSON.parse` (`null`, boolean,
   * number, string, plain object, or array). Behavior on non-JSON inputs is
   * out of scope and not fully defended against:
   *  - `Date`, `RegExp`, `Map`, and other class instances are treated as
   *    opaque leaves during equality (compared via `valueOf()`/`===`), but
   *    are otherwise serialized/echoed as-is into `value`/`oldValue` — they
   *    will NOT round-trip through `JSON.stringify`/`JSON.parse` the way a
   *    plain object would.
   *  - `undefined` values and `function`-valued fields are not valid JSON;
   *    diffing them can produce operations that omit `value` entirely.
   *  - Circular references are not detected and will overflow the call
   *    stack (`RangeError`).
   * Pass documents that have already round-tripped through `JSON.parse` (or
   * are otherwise known to be JSON-safe) to stay within the supported
   * contract.
   */
  execute({
    original,
    modified,
  }: {
    original: JsonValue;
    modified: JsonValue;
  }): Operation[] {
    // Advance the cache epoch so identity-keyed memoization caches (deepEqual,
    // stringify, path-map, formatter) from any earlier diff are treated as
    // stale. This makes a mutate-then-rediff loop recompute instead of
    // returning a cached verdict for an object that was mutated in place, while
    // preserving memo hits WITHIN this single call (SPEC §2.4.4).
    bumpEpoch();
    const patches: Operation[] = [];
    // Thread the compiled plan trie from the root (SPEC §5.4.5). An empty plan
    // threads `undefined` so every `node?.` access short-circuits with no work.
    this.diff(
      original,
      modified,
      "",
      patches,
      this.planIsEmpty ? undefined : this.planTrie
    );
    return patches;
  }

  private diff(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string,
    patches: Operation[],
    node: PlanTrieNode | undefined
  ) {
    if (obj1 === obj2) return;

    if (obj1 === undefined) {
      patches.push({ op: "add", path, value: obj2 });
      return;
    }

    if (obj2 === undefined) {
      // `oldValue` is inserted LAST so default-mode key order stays byte-stable
      // ({op, path, oldValue}); omitted entirely when includeOldValue is off.
      const op: Operation = { op: "remove", path };
      if (this.includeOldValue) op.oldValue = obj1;
      patches.push(op);
      return;
    }

    if (
      typeof obj1 !== "object" ||
      obj1 === null ||
      typeof obj2 !== "object" ||
      obj2 === null ||
      Array.isArray(obj1) !== Array.isArray(obj2)
    ) {
      const op: Operation = { op: "replace", path, value: obj2 };
      if (this.includeOldValue) op.oldValue = obj1;
      patches.push(op);
      return;
    }

    if (Array.isArray(obj1)) {
      this.diffArray(obj1, obj2 as JsonArray, path, patches, node);
      return;
    }

    // SPEC §2.1.2 / F16: a non-JSON object value (Date, RegExp, Map, a class
    // instance) has no meaningful own-enumerable-key structure to walk as an
    // object member set — diffObject would see zero keys on both sides and
    // silently emit no patch even when the values differ. Treat it as an
    // opaque leaf instead: replace wholesale when unequal (per valueOf()/===).
    if (isOpaqueObject(obj1) || isOpaqueObject(obj2)) {
      if (!deepEqualMemo(obj1, obj2)) {
        const op: Operation = { op: "replace", path, value: obj2 };
        if (this.includeOldValue) op.oldValue = obj1;
        patches.push(op);
      }
      return;
    }

    this.diffObject(obj1, obj2 as JsonObject, path, patches, node);
  }

  private diffObject(
    obj1: JsonObject,
    obj2: JsonObject,
    path: string,
    patches: Operation[],
    node: PlanTrieNode | undefined
  ) {
    // F36: SPEC §5.2.2 visitation order is "all of original's keys in
    // original insertion order, followed by keys present only in modified in
    // modified insertion order." The previous implementation built that order
    // via `new Set([...keys1, ...keys2])` (Set iteration happens to yield
    // exactly that order), which allocates two spread arrays plus a Set on
    // every object node visited — the hottest allocation site for
    // object-heavy documents. A two-pass walk (obj1's own keys, then obj2's
    // own keys skipping ones already own-present on obj1 via
    // `Object.hasOwn`) produces the IDENTICAL order with zero temporary
    // collections. Measured 5x (scratchpad/bench-f36-diffobject.ts): ~5x
    // fewer ms and zero Set/array garbage per node.
    const keys1 = Object.keys(obj1);
    for (let i = 0; i < keys1.length; i++) {
      const key = keys1[i] as string;
      const newPath = `${path}/${escapeJsonPointer(key)}`;
      const val1 = obj1[key];
      const val2 = obj2[key];

      if (val1 === undefined && val2 !== undefined) {
        patches.push({ op: "add", path: newPath, value: val2 });
      } else if (val2 === undefined && val1 !== undefined) {
        const op: Operation = { op: "remove", path: newPath };
        if (this.includeOldValue) op.oldValue = val1;
        patches.push(op);
      } else {
        // Descend the trie by RAW property key: an exact `children` edge takes
        // precedence over the `*` wildcard edge at each level (§5.4.5). A literal
        // numeric key (e.g. "0") is an ordinary exact edge — never confused with
        // an array index, which is handled structurally in diffArray (F33).
        const childNode = node
          ? node.children?.get(key) ?? node.wildcard
          : undefined;
        this.diff(val1, val2, newPath, patches, childNode);
      }
    }

    const keys2 = Object.keys(obj2);
    for (let i = 0; i < keys2.length; i++) {
      const key = keys2[i] as string;
      // Already visited in pass 1 (present on obj1) — skip. This is the only
      // membership check needed to reproduce Set-union dedup semantics: a key
      // own-present on obj1 was already handled above regardless of its value
      // (including an explicit `undefined` value, which Object.keys still
      // reports and which the pass-1 branch above resolves to a no-op diff).
      if (Object.hasOwn(obj1, key)) continue;
      const val2 = obj2[key];
      // val1 is implicitly undefined here (key not own-present on obj1). Only
      // an add is possible; val2 === undefined here degenerates to the
      // original's `diff(undefined, undefined, ...)` no-op (§5.1.1).
      if (val2 !== undefined) {
        const newPath = `${path}/${escapeJsonPointer(key)}`;
        patches.push({ op: "add", path: newPath, value: val2 });
      }
    }
  }

  private diffArray(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[],
    node: PlanTrieNode | undefined
  ) {
    // wholesaleReplaceFallback (SPEC §5.5.6 / §10.4.5, F24). OFF by default:
    // dispatch straight into the caller's `patches` exactly as before — zero
    // extra allocation and byte-identical output. ON: generate into a local
    // buffer first so the estimate (and a possible discard) can be applied
    // before anything reaches the shared `patches` array. This applies
    // per-array, including recursively to nested arrays (each nested
    // `diffArray` call — reached via granular descent or a plain nested-array
    // member — makes its own independent cutover decision).
    if (!this.wholesaleReplaceFallback) {
      this.dispatchArrayStrategy(arr1, arr2, path, patches, node);
      return;
    }
    const local: Operation[] = [];
    this.dispatchArrayStrategy(arr1, arr2, path, local, node);
    const estimate = JsonSchemaPatcher.estimatePatchBytes(local);
    const wholesaleThreshold = JSON.stringify(arr2).length;
    if (estimate > wholesaleThreshold) {
      const op: Operation = { op: "replace", path, value: arr2 };
      if (this.includeOldValue) op.oldValue = arr1;
      patches.push(op);
      return;
    }
    for (let i = 0; i < local.length; i++) patches.push(local[i] as Operation);
  }

  private dispatchArrayStrategy(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[],
    node: PlanTrieNode | undefined
  ) {
    // Strategy is read straight off the trie node for THIS array (SPEC §5.3.1):
    // O(1) pointer access, no string normalization and no per-path caches.
    const plan = node?.plan;
    const strategy = plan?.strategy || "lcs";

    const createModificationCallback = (
      hashFields: string[]
    ): ModificationCallback => {
      return (
        oldVal: JsonValue,
        newVal: JsonValue,
        cbPath: string,
        cbPatches: Operation[],
        skipEqualityCheck?: boolean
      ) => {
        // Choose the child node for the recursed element. A nested-array element
        // (array-of-arrays) descends to the wildcard child — the inner array's
        // plan registered at `${path}/*` (§4.3.5). An object element stays at
        // THIS array's node, because array items recurse at the same document
        // path (§4.3.3): the item's property plans are the node's `children`. A
        // mixed-kind pair never descends (diff emits a whole replace), so the
        // node choice is immaterial there.
        const elementNode =
          Array.isArray(oldVal) && Array.isArray(newVal)
            ? node?.wildcard
            : node;
        this.refine(
          oldVal,
          newVal,
          cbPath,
          cbPatches,
          hashFields,
          skipEqualityCheck || false,
          elementNode
        );
      };
    };

    // primaryKey applicability gate (SPEC §5.4.3): commit to the keyed strategy
    // only when every element of both arrays is a plain object with a unique
    // string|number key. Any violation (non-object/keyless element, or duplicate
    // key within either array) falls back to LCS below, which is exact. A
    // primaryKeyMap override selects the strategy but does NOT bypass this gate.
    if (
      strategy === "primaryKey" &&
      plan?.primaryKey &&
      checkPrimaryKeyApplicable(arr1, arr2, plan.primaryKey)
    ) {
      // emitMoves (SPEC §5.8.7 / F07): reorder survivors + indexed adds for exact
      // order fidelity, upgrading the §7.2 keyed-collection contract to §7.4.
      if (this.emitMoves) {
        diffArrayByPrimaryKeyMoves(
          arr1,
          arr2,
          plan.primaryKey,
          path,
          patches,
          createModificationCallback(plan.hashFields || []),
          this.includeOldValue
        );
        return;
      }
      diffArrayByPrimaryKey(
        arr1,
        arr2,
        plan.primaryKey,
        path,
        patches,
        createModificationCallback(plan.hashFields || []),
        plan.hashFields,
        this.includeOldValue
      );
      return;
    }

    if (strategy === "unique" && checkArraysUnique(arr1, arr2)) {
      // emitMoves (SPEC §5.8.6 / F23): a multiset-equal reorder becomes `move`s;
      // a non-multiset-equal pair falls through to positional replaces (§5.6).
      if (
        this.emitMoves &&
        diffArrayUniqueMoves(
          arr1,
          arr2,
          path,
          patches,
          createModificationCallback([]),
          this.includeOldValue
        )
      ) {
        return;
      }
      diffArrayUnique(arr1, arr2, path, patches, this.includeOldValue);
      return;
    }

    diffArrayLCS(
      arr1,
      arr2,
      path,
      patches,
      createModificationCallback(plan?.hashFields || []),
      plan?.hashFields,
      plan,
      this.includeOldValue,
      this.emitMoves
    );
  }

  private refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: Operation[],
    hashFields: string[] = [],
    skipEqualityCheck: boolean = false,
    node?: PlanTrieNode
  ) {
    if (skipEqualityCheck) {
      this.diff(oldVal, newVal, path, patches, node);
      return;
    }

    // Fast reference equality check first
    if (oldVal === newVal) return;

    // Check for simple type differences
    if (
      typeof oldVal !== typeof newVal ||
      oldVal === null ||
      newVal === null ||
      (typeof oldVal !== "object" && oldVal !== newVal)
    ) {
      this.diff(oldVal, newVal, path, patches, node);
      return;
    }

    // Only use expensive deep equality for complex objects
    if (!deepEqualMemo(oldVal, newVal, hashFields)) {
      this.diff(oldVal, newVal, path, patches, node);
    }
  }
}
