import {
  checkArraysSetUnique,
  checkArraysUnique,
  checkCompositeKeyApplicable,
  checkPrimaryKeyApplicable,
  diffArrayByCompositeKey,
  diffArrayByCompositeKeyMoves,
  diffArrayByPrimaryKey,
  diffArrayByPrimaryKeyMoves,
  diffArrayLCS,
  diffArraySet,
  diffArrayUnique,
  diffArrayUniqueMoves,
  type ModificationCallback,
} from "./arrayDiffAlgorithms";
import { isObjectPlan, isRecursionAliasOnly, type ArrayPlan, type ObjectPlan, type Plan, type PlanEntry } from "./buildPlan";
import {
  compileIgnoreTrie,
  ignoreMember,
  ignoreSubtreeHasTerminal,
  validateAtomicNotIgnored,
  validatePrimaryKeysNotIgnored,
  type IgnoreTrieNode,
} from "./ignorePaths";
import { deepEqualMemo, isOpaqueObject } from "../performance/deepEqual";
import { bumpEpoch } from "../performance/epoch";
import type { DiffOperation, JsonArray, JsonObject, JsonValue, Operation } from "../types";
import { escapeJsonPointer, unescapeJsonPointer } from "../utils/pathUtils";

/**
 * A node in the compiled plan trie (GEN §4.5). The public `Plan` is still a
 * flat `Map<documentPath, ArrayPlan>`; the constructor compiles it once into
 * this trie so strategy selection at diff time is *structural* — the current
 * node is threaded down the recursion instead of re-deriving and string-keying
 * a concrete path per array (which grew four unbounded per-instance caches, F18,
 * and mis-routed numeric object keys via index-normalization, F33).
 *
 * Each plan-key segment is either a literal property name (an exact `children`
 * edge, stored UNESCAPED so it matches raw object keys) or the wildcard `*`
 * (the `wildcard` edge — an `additionalProperties` value schema, CORE §3.3.2, or the
 * nested-array element level, CORE §3.3.5). `plan` is set iff a plan key terminates
 * at this node (the array registered at that path).
 */
interface PlanTrieNode {
  plan?: PlanEntry;
  children?: Map<string, PlanTrieNode>;
  wildcard?: PlanTrieNode;
}

export class JsonSchemaPatcher {
  private plan: Plan;
  private readonly planIsEmpty: boolean;
  private readonly planTrie: PlanTrieNode;
  /**
   * F11 / capability `includeOldValue` (CORE §4.4, CONF §5). When `true`
   * (default, back-compat) every `remove`/`replace` op carries the complete
   * pre-change subtree in `oldValue`. When `false`, NO emission site attaches
   * `oldValue`, yielding strict RFC 6902-shaped ops (add/remove/replace with
   * only path/value) and measurably smaller patches on remove/replace-heavy
   * diffs. `invertPatch` still round-trips because it recovers old values from
   * the original document, not from `oldValue` (CORE §4.4.2, CORE §6).
   */
  private readonly includeOldValue: boolean;
  /**
   * emitMoves capability (GEN §8, CONF §5.4). When `false` (default) output is
   * byte-stable versus the pre-capability tree. When `true`, relocated
   * (deep-equal) array elements are expressed as single RFC 6902 `move` ops
   * instead of remove+add pairs, and both the `unique` and `primaryKey`
   * strategies reconstruct `modified` ORDER EXACTLY (upgrading the CORE §7.2
   * primaryKey contract from keyed-collection to exact). Applies across LCS
   * relocations (F22), unique reorders (F23), and primaryKey order fidelity
   * (F07).
   */
  private readonly emitMoves: boolean;
  /**
   * wholesaleReplaceFallback capability (GEN §9 / CONF §5.5, F24). When
   * `false` (default) output is byte-stable versus the pre-capability tree.
   * When `true`, each array diff is first generated into a local buffer as
   * usual; if the GEN §9.2 byte estimate of that buffer exceeds
   * `JSON.stringify(modified-array).length`, the buffer is discarded and
   * replaced with a single whole-array `{op:"replace"}` (carrying `oldValue`
   * per `includeOldValue`). This caps a heavily-rewritten array's patch size
   * at roughly the new array's own serialized size instead of letting a
   * granular op stream exceed it.
   */
  private readonly wholesaleReplaceFallback: boolean;
  /**
   * ignorePaths capability (GEN §10, CONF §5.6). The compiled ignore trie, or
   * `undefined` when no ignore paths were given (byte-stable pre-capability
   * output — every `ignoreNode?.` thread short-circuits). Object-member JSON
   * Pointers whose subtrees are treated as EQUAL: no ops at or beneath a matched
   * location, in any strategy. Threaded down the recursion in parallel with the
   * plan trie.
   */
  private readonly ignoreTrie: IgnoreTrieNode | undefined;

  constructor(options: {
    plan: Plan;
    includeOldValue?: boolean;
    emitMoves?: boolean;
    wholesaleReplaceFallback?: boolean;
    ignorePaths?: string[];
  }) {
    // F42: fail fast with an actionable message instead of a cryptic
    // "undefined is not an object (evaluating this.plan.size)" TypeError
    // thrown later from the planIsEmpty computation below. Any Map instance
    // is accepted, including an empty one (`new Map()`), which is the
    // documented schemaless mode (CONF §2: "schema omitted/null -> diff
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
    // Default on for back-compat (CORE §4.4.1); opt out with `false`.
    this.includeOldValue = options.includeOldValue ?? true;
    // Default OFF (CONF §5.4): byte-stable output unless explicitly enabled.
    this.emitMoves = options.emitMoves ?? false;
    // Default OFF (CONF §5.5): byte-stable output unless explicitly enabled.
    this.wholesaleReplaceFallback = options.wholesaleReplaceFallback ?? false;
    // ignorePaths (GEN §10, CONF §5.6). compileIgnoreTrie validates each pointer
    // and throws TypeError on the first invalid one (GEN §10.1); an empty/absent
    // set compiles to `undefined` (no ignore node threaded -> byte-stable). When
    // a trie is present, a plan primaryKey field must not be ignorable (GEN §10.7).
    this.ignoreTrie = compileIgnoreTrie(options.ignorePaths);
    if (this.ignoreTrie) {
      validatePrimaryKeysNotIgnored(this.plan, this.ignoreTrie);
      // CORE §8.2.3: an `ignorePaths` terminal at or beneath a declared atomic
      // array/object node is a construction error — an atomic container is
      // replaced whole and cannot express "replace everything except this".
      validateAtomicNotIgnored(this.plan, this.ignoreTrie);
    }
  }

  /**
   * GEN §9.2 (F24): a deterministic, cheap-to-compute estimate of the
   * serialized size of `ops` — NOT an exact `JSON.stringify(ops).length`, but
   * pinned exactly so a reimplementation reproduces the identical cutover
   * decision. For each op: `+30` (fixed per-op overhead standing in for the
   * `{"op":"...","path":""}` structure) plus `op.path.length` (paths are real
   * serialized bytes and deep paths dominate small values) plus
   * `JSON.stringify(op.value).length` when `value` is present, plus
   * `JSON.stringify(op.oldValue).length` when `oldValue` is present. `move`
   * ops contribute the overhead and their path only.
   */
  private static estimatePatchBytes(ops: Operation[]): number {
    let total = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as Operation;
      total += 30 + op.path.length;
      if (op.value !== undefined) total += JSON.stringify(op.value).length;
      if (op.oldValue !== undefined) total += JSON.stringify(op.oldValue).length;
    }
    return total;
  }

  /**
   * Compile the flat `Plan` map into a trie (GEN §4.5). Each key is split on
   * `/`; a `*` segment is the wildcard edge, any other segment is unescaped and
   * stored as an exact `children` edge. The empty key `""` (a root-level array
   * document) terminates at the root node itself.
   *
   * Recursion aliases (CORE §3.3.7) wire second: a node whose entry carries
   * `recurseTo` inherits the anchor node's plan and edges (explicit edges win),
   * iterated to a fixpoint so nested cycles resolve regardless of map order.
   * The resulting trie may be CYCLIC; diff recursion is bounded by document
   * depth, but any exhaustive trie walk must guard against revisits.
   */
  private compilePlanTrie(plan: Plan): PlanTrieNode {
    const root: PlanTrieNode = {};
    const ensureNode = (key: string): PlanTrieNode => {
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
      return node;
    };

    const aliases: Array<[PlanTrieNode, PlanTrieNode]> = [];
    for (const [key, entry] of plan) {
      const node = ensureNode(key);
      if (!isRecursionAliasOnly(entry)) {
        node.plan = entry;
      }
      const recurseTo = isObjectPlan(entry) ? undefined : entry.recurseTo;
      if (recurseTo !== undefined) {
        aliases.push([node, ensureNode(recurseTo)]);
      }
    }

    let changed = true;
    while (changed) {
      changed = false;
      for (const [target, anchor] of aliases) {
        if (anchor.plan && !target.plan) {
          target.plan = anchor.plan;
          changed = true;
        }
        if (anchor.wildcard && !target.wildcard) {
          target.wildcard = anchor.wildcard;
          changed = true;
        }
        if (anchor.children) {
          target.children ??= new Map();
          for (const [key, child] of anchor.children) {
            if (!target.children.has(key)) {
              target.children.set(key, child);
              changed = true;
            }
          }
        }
      }
    }
    return root;
  }

  /**
   * Computes an RFC 6902-style patch (with an added `oldValue` on `remove`/
   * `replace`) that transforms `original` into `modified`.
   *
   * **JSON-only contract (CORE §1.1.2):** `original` and `modified` MUST be
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
  }): DiffOperation[] {
    // Advance the cache epoch so identity-keyed memoization caches (deepEqual,
    // stringify, path-map, formatter) from any earlier diff are treated as
    // stale. This makes a mutate-then-rediff loop recompute instead of
    // returning a cached verdict for an object that was mutated in place, while
    // preserving memo hits WITHIN this single call (CORE §1.4.4).
    bumpEpoch();
    const patches: Operation[] = [];
    // Thread the compiled plan trie from the root (GEN §4.5). An empty plan
    // threads `undefined` so every `node?.` access short-circuits with no work.
    this.diff(
      original,
      modified,
      "",
      patches,
      this.planIsEmpty ? undefined : this.planTrie,
      // Thread the ignore trie from the root in parallel with the plan trie
      // (GEN §10.2). `undefined` when no ignore paths were given.
      this.ignoreTrie
    );
    // F27: every emission site above only ever pushes add/remove/replace (and,
    // under emitMoves, move) ops shaped exactly like `DiffOperation` — never
    // RFC 6902's `copy`/`test`. The internal buffer stays `Operation[]` (it is
    // threaded through helpers shared with `applyPatch`'s wider vocabulary),
    // so the narrowing here is a type-level assertion of an invariant the
    // implementation above already upholds, not a runtime transform.
    return patches as DiffOperation[];
  }

  private diff(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string,
    patches: Operation[],
    node: PlanTrieNode | undefined,
    ignoreNode: IgnoreTrieNode | undefined
  ) {
    // ignorePaths (GEN §10.4): a terminal ignore node makes this subtree
    // EQUAL in both directions — emit nothing at or beneath it. This guards the
    // whole-subtree cases (a whole array/object/leaf reached via recursion or an
    // ignored array element `/arr/*`); per-member add/remove are guarded in
    // diffObject (which does not route through diff).
    if (ignoreNode?.end) return;

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
      this.diffArray(obj1, obj2 as JsonArray, path, patches, node, ignoreNode);
      return;
    }

    // CORE §1.1.2 / F16: a non-JSON object value (Date, RegExp, Map, a class
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

    this.diffObject(obj1, obj2 as JsonObject, path, patches, node, ignoreNode);
  }

  private diffObject(
    obj1: JsonObject,
    obj2: JsonObject,
    path: string,
    patches: Operation[],
    node: PlanTrieNode | undefined,
    ignoreNode: IgnoreTrieNode | undefined
  ) {
    // spec-v2 object dispatch (GEN §11.1): a declared `granularity: "atomic"`
    // object emits ONE whole-object replace when it differs and STOPS — no §2
    // per-member walk, no recursion (CORE §8.6). The plan trie has no children
    // beneath an atomic node (buildPlan pruned the subtree, CORE §8.3.3), so the
    // check belongs here at the object's own node.
    const objectPlan = node?.plan;
    if (objectPlan && isObjectPlan(objectPlan)) {
      if (!deepEqualMemo(obj1, obj2)) {
        const op: Operation = { op: "replace", path, value: obj2 };
        if (this.includeOldValue) op.oldValue = obj1;
        patches.push(op);
      }
      return;
    }

    // F36: GEN §2.2 visitation order is "all of original's keys in
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
      // ignorePaths (GEN §10.3/GEN §10.4): advance the ignore trie for this
      // member; a terminal child means the member is EQUAL in both directions —
      // emit no add/remove/recursion for it (add/remove are pushed here without
      // routing through diff, so the check must be at this site).
      const childIgnore = ignoreMember(ignoreNode, key);
      if (childIgnore?.end) continue;
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
        // precedence over the `*` wildcard edge at each level (GEN §4.5). A literal
        // numeric key (e.g. "0") is an ordinary exact edge — never confused with
        // an array index, which is handled structurally in diffArray (F33).
        const childNode = node
          ? node.children?.get(key) ?? node.wildcard
          : undefined;
        this.diff(val1, val2, newPath, patches, childNode, childIgnore);
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
      // ignorePaths (GEN §10.4): a modified-only member under a terminal
      // ignore node emits no add.
      if (ignoreMember(ignoreNode, key)?.end) continue;
      const val2 = obj2[key];
      // val1 is implicitly undefined here (key not own-present on obj1). Only
      // an add is possible; val2 === undefined here degenerates to the
      // original's `diff(undefined, undefined, ...)` no-op (GEN §1.1).
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
    node: PlanTrieNode | undefined,
    ignoreNode: IgnoreTrieNode | undefined
  ) {
    // ignorePaths (GEN §10.4): an ignore entry ending at the array-element
    // level (its item node is terminal, e.g. `/arr/*`) makes EVERY element — and
    // thus the whole array — equal, in any strategy. Short-circuit to no ops.
    if (ignoreNode?.wildcard?.end) return;

    // spec-v2 array dispatch (GEN §11.2): a declared `atomic` array emits ONE
    // whole-array replace when it differs and STOPS — no recursion beneath
    // (CORE §8.6.2). Handled BEFORE the wholesaleReplaceFallback wrapper because
    // an atomic node is EXEMPT from that capability (it is already wholesale,
    // CORE §8.6.3) and forbids an ignore terminal beneath it (construction error,
    // CORE §8.2.3), so no ignore filtering applies here.
    const arrPlan = node?.plan;
    if (arrPlan && !isObjectPlan(arrPlan) && arrPlan.topology === "atomic") {
      if (!deepEqualMemo(arr1, arr2)) {
        const op: Operation = { op: "replace", path, value: arr2 };
        if (this.includeOldValue) op.oldValue = arr1;
        patches.push(op);
      }
      return;
    }

    // wholesaleReplaceFallback (GEN §9 / CONF §5.5, F24). OFF by default:
    // dispatch straight into the caller's `patches` exactly as before — zero
    // extra allocation and byte-identical output. ON: generate into a local
    // buffer first so the estimate (and a possible discard) can be applied
    // before anything reaches the shared `patches` array. This applies
    // per-array, including recursively to nested arrays (each nested
    // `diffArray` call — reached via granular descent or a plain nested-array
    // member — makes its own independent cutover decision).
    //
    // ignorePaths interaction (GEN §10.6): if any ignore terminal lies
    // BENEATH this array, a wholesale replace would leak ignored content into its
    // `value` — so the capability is DISABLED for that array and the ignore-
    // filtered granular stream is kept.
    if (
      !this.wholesaleReplaceFallback ||
      ignoreSubtreeHasTerminal(ignoreNode)
    ) {
      this.dispatchArrayStrategy(arr1, arr2, path, patches, node, ignoreNode);
      return;
    }
    const local: Operation[] = [];
    this.dispatchArrayStrategy(arr1, arr2, path, local, node, ignoreNode);
    const estimate = JsonSchemaPatcher.estimatePatchBytes(local);
    // GEN §9.3: the threshold is the SAME pinned estimate applied to the single
    // wholesale replace this cutover would emit — 30 + value + oldValue (when
    // includeOldValue is on). Comparing against just the array's serialized
    // size under-counted the wholesale side and could cut over to a LARGER
    // patch, breaking the capability's never-worse guarantee.
    const wholesaleThreshold =
      30 +
      path.length +
      JSON.stringify(arr2).length +
      (this.includeOldValue ? JSON.stringify(arr1).length : 0);
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
    node: PlanTrieNode | undefined,
    ignoreNode: IgnoreTrieNode | undefined
  ) {
    // The item-level ignore node: descending into an array element consumes one
    // wildcard `*` (the array index level, GEN §10.3). Every element — object,
    // array, or primitive — advances the same way, so this is used both for the
    // element recursion (below) and for the ignore-filtered LCS interning.
    const itemIgnore = ignoreNode?.wildcard;
    // Strategy is read straight off the trie node for THIS array (GEN §3.1):
    // O(1) pointer access, no string normalization and no per-path caches. An
    // ObjectPlan can never legitimately sit at an array path; treat it as no plan.
    const rawPlan = node?.plan;
    const plan =
      rawPlan && !isObjectPlan(rawPlan) ? (rawPlan as ArrayPlan) : undefined;
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
        // plan registered at `${path}/*` (CORE §3.3.5). An object element stays at
        // THIS array's node, because array items recurse at the same document
        // path (CORE §3.3.3): the item's property plans are the node's `children`. A
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
          elementNode,
          // The element's ignore node is ALWAYS the array's wildcard child (the
          // array index consumes one `*`, GEN §10.3), regardless of element
          // kind — unlike the plan trie, where an object element stays put.
          itemIgnore
        );
      };
    };

    // spec-v2 declared-topology dispatch (GEN §11.2). A declared topology
    // REPLACES the §3.1/§3.2 runtime-gated selection below (`atomic` was already
    // handled in diffArray). Each topology's identity gate falls back to
    // `sequence`/LCS on violation (CORE §8.4.2/§8.5.1). LCS is invoked with the
    // same arguments as the compat tail so the fallback is byte-identical.
    const topology = plan?.topology;
    if (topology) {
      const lcsFallback = () =>
        diffArrayLCS(
          arr1,
          arr2,
          path,
          patches,
          createModificationCallback(plan?.hashFields || []),
          plan?.hashFields,
          plan,
          this.includeOldValue,
          this.emitMoves,
          itemIgnore
        );
      if (topology === "sequence") {
        // Forced LCS even where a primary key would auto-detect (CORE §8.7).
        lcsFallback();
        return;
      }
      if (topology === "set") {
        if (checkArraysSetUnique(arr1, arr2)) {
          diffArraySet(arr1, arr2, path, patches, this.includeOldValue);
          return;
        }
        lcsFallback();
        return;
      }
      if (topology === "map") {
        const keys = plan?.keys as string[];
        if (checkCompositeKeyApplicable(arr1, arr2, keys)) {
          // order=significant → moves machinery, run unconditionally (GEN §11.4.2,
          // independent of the emitMoves option). order=insignificant → the
          // keyed three-phase emission (CORE §7.2).
          if (plan?.order === "significant") {
            diffArrayByCompositeKeyMoves(
              arr1,
              arr2,
              keys,
              path,
              patches,
              createModificationCallback(plan?.hashFields || []),
              this.includeOldValue
            );
          } else {
            diffArrayByCompositeKey(
              arr1,
              arr2,
              keys,
              path,
              patches,
              createModificationCallback(plan?.hashFields || []),
              this.includeOldValue
            );
          }
          return;
        }
        lcsFallback();
        return;
      }
      // topology === "atomic" is unreachable here (handled in diffArray).
    }

    // primaryKey applicability gate (GEN §4.3): commit to the keyed strategy
    // only when every element of both arrays is a plain object with a unique
    // string|number key. Any violation (non-object/keyless element, or duplicate
    // key within either array) falls back to LCS below, which is exact. A
    // primaryKeyMap override selects the strategy but does NOT bypass this gate.
    if (
      strategy === "primaryKey" &&
      plan?.primaryKey &&
      checkPrimaryKeyApplicable(arr1, arr2, plan.primaryKey)
    ) {
      // emitMoves (GEN §8.7 / F07): reorder survivors + indexed adds for exact
      // order fidelity, upgrading the CORE §7.2 keyed-collection contract to CORE §7.4.
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
      // emitMoves (GEN §8.6 / F23): a multiset-equal reorder becomes `move`s;
      // a non-multiset-equal pair falls through to positional replaces (GEN §6).
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
      this.emitMoves,
      // ignorePaths (GEN §10.5): the item-level ignore node makes the LCS
      // interning fingerprint ignore-filtered, so two items differing only in
      // ignored fields intern equal (common / move-pairable, never remove+add).
      itemIgnore
    );
  }

  private refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: Operation[],
    hashFields: string[] = [],
    skipEqualityCheck: boolean = false,
    node?: PlanTrieNode,
    ignoreNode?: IgnoreTrieNode
  ) {
    if (skipEqualityCheck) {
      this.diff(oldVal, newVal, path, patches, node, ignoreNode);
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
      this.diff(oldVal, newVal, path, patches, node, ignoreNode);
      return;
    }

    // Only use expensive deep equality for complex objects
    if (!deepEqualMemo(oldVal, newVal, hashFields)) {
      this.diff(oldVal, newVal, path, patches, node, ignoreNode);
    }
  }
}
