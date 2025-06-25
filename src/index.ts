import { performance } from "perf_hooks";

type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
type JsonObject = { [Key in string]?: JsonValue };
type JsonArray = JsonValue[];

interface JSONSchema extends JsonObject {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  required?: string[];
}

export interface Operation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: JsonValue;
  from?: string;
}

type Schema = JSONSchema;

interface ArrayPlan {
  primaryKey: string | null;
  // Pre-resolved item schema to avoid repeated $ref resolution
  itemSchema?: JSONSchema;
  // Set of required fields for faster validation and comparison
  requiredFields?: Set<string>;
  // Fields to use for quick equality hashing before deep comparison
  hashFields?: string[];
  // Strategy hint for array comparison
  strategy?: "primaryKey" | "lcs" | "unique";
}

type Plan = Map<string, ArrayPlan>;

export interface BuildPlanOptions {
  primaryKeyMap?: Record<string, string>;
  basePath?: string;
}

export function _resolveRef(ref: string, schema: Schema): JSONSchema | null {
  if (!ref.startsWith("#/")) {
    // We only support local references for now.
    console.warn(`Unsupported reference: ${ref}`);
    return null;
  }
  const path = ref.substring(2).split("/");
  let current: unknown = schema;
  for (const part of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, part)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as JSONSchema;
}

export function _traverseSchema(
  subSchema: JSONSchema | boolean,
  docPath: string,
  plan: Plan,
  schema: Schema,
  visited: Set<object> = new Set(),
  options?: BuildPlanOptions
) {
  if (!subSchema || typeof subSchema !== "object" || visited.has(subSchema)) {
    return;
  }
  visited.add(subSchema);

  if (subSchema.$ref) {
    const resolved = _resolveRef(subSchema.$ref, schema);
    if (resolved) {
      // Note: We don't change the docPath when resolving a ref
      _traverseSchema(resolved, docPath, plan, schema, visited, options);
    }
    // The visited check at the start of the function handles cycles.
    // We should remove the subSchema from visited before returning,
    // so it can be visited again via a different path.
    visited.delete(subSchema);
    return;
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(subSchema[keyword])) {
      for (const s of subSchema[keyword]) {
        _traverseSchema(s, docPath, plan, schema, visited, options);
      }
    }
  }

  if (subSchema.type === "object") {
    if (subSchema.properties) {
      for (const key in subSchema.properties) {
        _traverseSchema(
          subSchema.properties[key] as JSONSchema,
          `${docPath}/${key}`,
          plan,
          schema,
          visited,
          options
        );
      }
    }
    if (
      typeof subSchema.additionalProperties === "object" &&
      subSchema.additionalProperties
    ) {
      _traverseSchema(
        subSchema.additionalProperties,
        `${docPath}/*`,
        plan,
        schema,
        visited,
        options
      );
    }
  }

  if (subSchema.type === "array" && subSchema.items) {
    const arrayPlan: ArrayPlan = { primaryKey: null, strategy: "lcs" };

    let itemsSchema = subSchema.items;
    if (itemsSchema.$ref) {
      itemsSchema = _resolveRef(itemsSchema.$ref, schema) || itemsSchema;
    }

    // Store the resolved item schema to avoid repeated resolution
    arrayPlan.itemSchema = itemsSchema;

    // Check if items are primitives
    const isPrimitive =
      itemsSchema &&
      (itemsSchema.type === "string" ||
        itemsSchema.type === "number" ||
        itemsSchema.type === "boolean");

    if (isPrimitive) {
      arrayPlan.strategy = "unique";
    }

    const customKey = options?.primaryKeyMap?.[docPath];
    if (customKey) {
      arrayPlan.primaryKey = customKey;
      arrayPlan.strategy = "primaryKey";
    } else if (!isPrimitive) {
      // Find primary key and other metadata only for non-primitive object arrays
      const findMetadata = (
        s: JSONSchema
      ): Pick<
        ArrayPlan,
        "primaryKey" | "requiredFields" | "hashFields"
      > | null => {
        let currentSchema = s;
        if (!currentSchema || typeof currentSchema !== "object") return null;

        if (currentSchema.$ref) {
          const resolved = _resolveRef(currentSchema.$ref, schema);
          if (!resolved) return null;
          currentSchema = resolved;
        }
        if (
          !currentSchema ||
          currentSchema.type !== "object" ||
          !currentSchema.properties
        ) {
          return null;
        }

        const props = currentSchema.properties;
        const required = new Set(currentSchema.required || []) as Set<string>;
        const hashFields: string[] = [];

        // Identify potential hash fields (required, primitive types)
        for (const key of required) {
          const prop = props[key];
          if (prop && (prop.type === "string" || prop.type === "number")) {
            hashFields.push(key);
          }
        }

        const potentialKeys = ["id", "name", "port"];
        for (const key of potentialKeys) {
          if (required.has(key)) {
            const prop = props[key];
            if (prop && (prop.type === "string" || prop.type === "number")) {
              return {
                primaryKey: key,
                requiredFields: required,
                hashFields,
              };
            }
          }
        }

        return null;
      };

      const schemas = itemsSchema.anyOf || itemsSchema.oneOf;
      let metadata: ReturnType<typeof findMetadata> | null = null;
      if (schemas) {
        for (const s of schemas) {
          metadata = findMetadata(s);
          if (metadata?.primaryKey) {
            break;
          }
        }
      } else {
        metadata = findMetadata(itemsSchema);
      }

      if (metadata?.primaryKey) {
        arrayPlan.primaryKey = metadata.primaryKey;
        arrayPlan.requiredFields = metadata.requiredFields;
        arrayPlan.hashFields = metadata.hashFields;
        arrayPlan.strategy = "primaryKey";
      }
    }

    if (options?.basePath) {
      if (docPath.startsWith(options.basePath)) {
        plan.set(docPath.replace(options.basePath, ""), arrayPlan);
      }
    } else {
      plan.set(docPath, arrayPlan);
    }

    // We continue traversal into array items. The path does not change here
    // as the diffing logic will add array indices.
    _traverseSchema(subSchema.items, docPath, plan, schema, visited, options);
  }
  visited.delete(subSchema);
}

export function buildPlan(schema: Schema, options?: BuildPlanOptions): Plan {
  const plan: Plan = new Map();
  _traverseSchema(schema, "", plan, schema, new Set(), options);
  return plan;
}

export function deepEqual(obj1: unknown, obj2: unknown): boolean {
  if (obj1 === obj2) return true;

  if (obj1 && obj2 && typeof obj1 === "object" && typeof obj2 === "object") {
    const arrA = Array.isArray(obj1);
    const arrB = Array.isArray(obj2);
    let i: number;
    let length: number;
    let key: string;

    if (arrA && arrB) {
      const arr1 = obj1 as unknown[];
      const arr2 = obj2 as unknown[];
      length = arr1.length;
      if (length !== arr2.length) return false;
      for (i = length; i-- !== 0; )
        if (!deepEqual(arr1[i], arr2[i])) return false;
      return true;
    }

    if (arrA !== arrB) return false;

    const keys = Object.keys(obj1);
    length = keys.length;

    if (length !== Object.keys(obj2).length) return false;

    for (i = length; i-- !== 0; ) {
      const currentKey = keys[i];
      if (currentKey !== undefined && !Object.hasOwn(obj2, currentKey))
        return false;
    }

    for (i = length; i-- !== 0; ) {
      key = keys[i] as string;
      if (!deepEqual((obj1 as JsonObject)[key], (obj2 as JsonObject)[key]))
        return false;
    }

    return true;
  }

  // Handle NaN case
  return Number.isNaN(obj1) && Number.isNaN(obj2);
}

const eqCache = new WeakMap<object, WeakMap<object, boolean>>();
export function deepEqualMemo(
  obj1: unknown,
  obj2: unknown,
  hotFields: string[] = []
): boolean {
  if (obj1 === obj2) return true;
  if (obj1 == null || obj2 == null) return obj1 === obj2;

  const type1 = typeof obj1;
  const type2 = typeof obj2;
  if (type1 !== type2) return false;
  if (type1 !== "object") {
    // primitives: fallback to strict equals (NaN handled above)
    return obj1 === obj2;
  }

  // both are non-null objects
  const a = obj1 as JsonObject;
  const b = obj2 as JsonObject;

  // fast pre-hash: if both plain objects and hotFields provided
  if (hotFields.length > 0 && !Array.isArray(a) && !Array.isArray(b)) {
    const h1 = fastHash(a, hotFields);
    const h2 = fastHash(b, hotFields);
    if (h1 !== h2) return false;
  }

  // memoization cache
  let inner = eqCache.get(a);
  if (inner?.has(b)) return inner.get(b) ?? false;

  // deep recursive compare (original implementation)
  const result = deepEqual(a, b);

  // store in cache
  if (!inner) {
    inner = new WeakMap();
    eqCache.set(a, inner);
  }
  inner.set(b, result);

  return result;
}

// A lightweight hash function for quick object comparison.
export function fastHash(obj: JsonObject, fields: string[]): string {
  // This is a simple, non-cryptographic hash.
  // The goal is speed and reducing collisions for similar objects.
  let hash = "";
  for (const key of fields) {
    hash += `${obj[key]}|`;
  }
  return hash;
}

export class SchemaPatcher {
  private readonly plan: Plan;
  private pathPlanCache = new Map<string, ArrayPlan | undefined>();
  public debug: Record<string, number>;

  constructor({ plan }: { plan: Plan }) {
    this.plan = plan;
    this.debug = {};
  }

  public createPatch(doc1: JsonValue, doc2: JsonValue): Operation[] {
    this.debug = {}; // Reset for each run
    const start = performance.now();

    const patches: Operation[] = [];
    this.diff(doc1, doc2, "", patches);

    const end = performance.now();
    this.debug["createPatch"] =
      (this.debug["createPatch"] || 0) + (end - start);

    return patches;
  }

  private diff(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string,
    patches: Operation[]
  ) {
    // Fast path for identical references (most common case)
    if (obj1 === obj2) {
      return;
    }

    // Fast path for undefined values
    if (obj1 === undefined) {
      patches.push({ op: "add", path, value: obj2 });
      return;
    }

    if (obj2 === undefined) {
      patches.push({ op: "remove", path });
      return;
    }

    // Fast path for null values
    if (obj1 === null || obj2 === null) {
      patches.push({ op: "replace", path, value: obj2 });
      return;
    }

    const type1 = typeof obj1;
    const type2 = typeof obj2;

    // Fast path for different types
    if (type1 !== type2) {
      patches.push({ op: "replace", path, value: obj2 });
      return;
    }

    // Fast path for primitives
    if (type1 !== "object") {
      patches.push({ op: "replace", path, value: obj2 });
      return;
    }

    // Both are objects, check array status
    const isArray1 = Array.isArray(obj1);
    const isArray2 = Array.isArray(obj2);

    if (isArray1 !== isArray2) {
      patches.push({ op: "replace", path, value: obj2 });
      return;
    }

    // Delegate to appropriate diffing method
    if (isArray1) {
      this.diffArray(obj1 as JsonArray, obj2 as JsonArray, path, patches);
    } else {
      this.diffObject(obj1 as JsonObject, obj2 as JsonObject, path, patches);
    }
  }

  private diffObject(
    obj1: JsonObject,
    obj2: JsonObject,
    path: string,
    patches: Operation[]
  ) {
    const start = performance.now();

    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    const keys2Set = new Set(keys2);

    // Process removals - optimized loop
    for (let i = keys1.length; i-- > 0; ) {
      const key = keys1[i];
      if (key !== undefined && !keys2Set.has(key)) {
        patches.push({ op: "remove", path: `${path}/${key}` });
      }
    }

    // Process additions and changes - optimized loop
    for (let i = keys2.length; i-- > 0; ) {
      const key = keys2[i];
      if (key === undefined) continue;

      const newPath = `${path}/${key}`;

      if (!Object.hasOwn(obj1, key)) {
        patches.push({ op: "add", path: newPath, value: obj2[key] });
      } else {
        const val1 = obj1[key];
        const val2 = obj2[key];

        // Inline fast path checks to avoid function call overhead
        if (val1 !== val2) {
          if (val1 == null || val2 == null) {
            patches.push({ op: "replace", path: newPath, value: val2 });
          } else {
            const type1 = typeof val1;
            const type2 = typeof val2;

            if (type1 !== type2 || type1 !== "object") {
              patches.push({ op: "replace", path: newPath, value: val2 });
            } else {
              const isArray1 = Array.isArray(val1);
              const isArray2 = Array.isArray(val2);

              if (isArray1 !== isArray2) {
                patches.push({ op: "replace", path: newPath, value: val2 });
              } else if (isArray1) {
                this.diffArray(
                  val1 as JsonArray,
                  val2 as JsonArray,
                  newPath,
                  patches
                );
              } else {
                this.diffObject(
                  val1 as JsonObject,
                  val2 as JsonObject,
                  newPath,
                  patches
                );
              }
            }
          }
        }
      }
    }

    const end = performance.now();
    this.debug["diffObject"] = (this.debug["diffObject"] || 0) + (end - start);
  }

  private diffArray(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[]
  ) {
    const plan = this.getPlanForPath(path);

    // Use the strategy from the plan, or fallback to LCS
    const strategy = plan?.strategy || "lcs";

    if (strategy === "primaryKey" && plan?.primaryKey) {
      const start = performance.now();
      const { primaryKey, hashFields } = plan;
      const useHashing = hashFields && hashFields.length > 0;

      // Timing: Map building phase
      const mapBuildStart = performance.now();
      const map1 = new Map<
        string | number,
        { item: JsonValue; index: number }
      >();
      for (let i = 0; i < arr1.length; i++) {
        const item = arr1[i];
        if (typeof item === "object" && item !== null && primaryKey in item) {
          const key = item[primaryKey as keyof typeof item];
          if (typeof key === "string" || typeof key === "number") {
            map1.set(key, { item, index: i });
          }
        }
      }
      const mapBuildEnd = performance.now();
      this.debug["diffArray-primaryKey-mapBuild"] =
        (this.debug["diffArray-primaryKey-mapBuild"] || 0) +
        (mapBuildEnd - mapBuildStart);

      const seenKeys = new Set<string | number>();
      const modificationPatches: Operation[] = [];
      const additionPatches: Operation[] = [];

      // Timing: Comparison phase
      const comparisonStart = performance.now();
      for (let i = 0; i < arr2.length; i++) {
        const newItem = arr2[i];
        if (
          typeof newItem !== "object" ||
          newItem === null ||
          !(primaryKey in newItem)
        ) {
          continue; // Skip items without a primary key in the new array
        }
        const key = newItem[primaryKey as keyof typeof newItem];
        if (typeof key !== "string" && typeof key !== "number") {
          continue;
        }

        seenKeys.add(key);
        const oldEntry = map1.get(key);

        if (oldEntry) {
          // Key exists in both arrays, check for modification
          const equalityStart = performance.now();
          const oldItem = oldEntry.item;
          let needsDiff = false;

          if (useHashing && hashFields && hashFields.length > 0) {
            // Check hash fields directly first (faster than string hashing)
            let hashFieldsDiffer = false;
            for (let j = 0; j < hashFields.length; j++) {
              const field = hashFields[j];
              if (
                field &&
                (oldItem as JsonObject)[field] !==
                  (newItem as JsonObject)[field]
              ) {
                hashFieldsDiffer = true;
                break;
              }
            }

            if (hashFieldsDiffer) {
              needsDiff = true;
            } else {
              // Hash fields match - check if objects are identical reference first
              if (oldItem === newItem) {
                needsDiff = false;
              } else {
                // Do full equality check only if needed
                needsDiff = !deepEqual(oldItem, newItem);
              }
            }
          } else {
            // No hashing - check reference equality first
            if (oldItem === newItem) {
              needsDiff = false;
            } else {
              needsDiff = !deepEqual(oldItem, newItem);
            }
          }

          const equalityEnd = performance.now();
          this.debug["diffArray-primaryKey-equality"] =
            (this.debug["diffArray-primaryKey-equality"] || 0) +
            (equalityEnd - equalityStart);

          if (needsDiff) {
            const diffStart = performance.now();
            this.diff(
              oldItem,
              newItem,
              `${path}/${oldEntry.index}`,
              modificationPatches
            );
            const diffEnd = performance.now();
            this.debug["diffArray-primaryKey-diff"] =
              (this.debug["diffArray-primaryKey-diff"] || 0) +
              (diffEnd - diffStart);
          }
        } else {
          // Key only in new array, it's an addition
          additionPatches.push({
            op: "add",
            path: `${path}/-`,
            value: newItem,
          });
        }
      }
      const comparisonEnd = performance.now();
      this.debug["diffArray-primaryKey-comparison"] =
        (this.debug["diffArray-primaryKey-comparison"] || 0) +
        (comparisonEnd - comparisonStart);

      // Timing: Removal phase
      const removalStart = performance.now();
      const removalIndices: number[] = [];
      for (const [key, oldEntry] of map1.entries()) {
        if (!seenKeys.has(key)) {
          removalIndices.push(oldEntry.index);
        }
      }

      // Sort removal indices descending to apply them safely
      removalIndices.sort((a, b) => b - a);

      const removalPatches: Operation[] = [];
      for (const index of removalIndices) {
        removalPatches.push({
          op: "remove",
          path: `${path}/${index}`,
        });
      }
      const removalEnd = performance.now();
      this.debug["diffArray-primaryKey-removal"] =
        (this.debug["diffArray-primaryKey-removal"] || 0) +
        (removalEnd - removalStart);

      // Timing: Patch assembly
      const assemblyStart = performance.now();
      patches.push(
        ...modificationPatches,
        ...removalPatches,
        ...additionPatches
      );
      const assemblyEnd = performance.now();
      this.debug["diffArray-primaryKey-assembly"] =
        (this.debug["diffArray-primaryKey-assembly"] || 0) +
        (assemblyEnd - assemblyStart);

      const end = performance.now();
      this.debug["diffArray-primaryKey"] =
        (this.debug["diffArray-primaryKey"] || 0) + (end - start);
      return;
    }

    if (strategy === "unique") {
      const start = performance.now();
      this.diffArrayUnique(arr1, arr2, path, patches);
      const end = performance.now();
      this.debug["diffArray-unique"] =
        (this.debug["diffArray-unique"] || 0) + (end - start);
      return;
    }

    const start = performance.now();
    this.diffArrayLCS(arr1, arr2, path, patches);
    const end = performance.now();
    this.debug["diffArray-lcs"] =
      (this.debug["diffArray-lcs"] || 0) + (end - start);
  }

  /**
   * Optimized diff algorithm for arrays with unique elements.
   * Time complexity: O(n + m) where n and m are array lengths.
   * Space complexity: O(min(n, m)) for the sets.
   *
   * This algorithm is highly efficient for:
   * - Arrays where all elements are unique
   * - Primitive arrays (strings, numbers, booleans)
   * - Cases where order is not semantically important
   *
   * Performance characteristics:
   * - Best case: O(n + m) when arrays have no common elements
   * - Average case: O(n + m) for typical unique element arrays
   * - Memory efficient: uses Sets instead of frequency Maps
   * - Patch optimized: prioritizes replace operations over add/remove pairs
   */
  private diffArrayUnique(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[]
  ) {
    const n = arr1.length;
    const m = arr2.length;

    // Build sets for O(1) lookup
    const set1 = new Set(arr1);
    const set2 = new Set(arr2);

    // Phase 1: Generate replace operations for overlapping positions
    const minLength = Math.min(n, m);
    const replacedAtIndex = new Set<number>();
    const replacedValues1 = new Set<JsonValue>();
    const replacedValues2 = new Set<JsonValue>();

    for (let i = 0; i < minLength; i++) {
      const val1 = arr1[i];
      const val2 = arr2[i];

      if (val1 !== val2) {
        patches.push({ op: "replace", path: `${path}/${i}`, value: val2 });
        replacedAtIndex.add(i);
        if (val1 !== undefined) replacedValues1.add(val1);
        if (val2 !== undefined) replacedValues2.add(val2);
      }
    }

    // Phase 2: Handle removals - elements in arr1 that aren't in arr2
    // excluding those already replaced
    const removalIndices: number[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const item = arr1[i];
      if (item !== undefined && !set2.has(item) && !replacedAtIndex.has(i)) {
        removalIndices.push(i);
      }
    }

    // Apply removals
    for (const index of removalIndices) {
      patches.push({ op: "remove", path: `${path}/${index}` });
    }

    // Phase 3: Handle additions - elements in arr2 that aren't in arr1
    // excluding those already used in replace operations
    for (const item of set2) {
      if (item !== undefined && !set1.has(item) && !replacedValues2.has(item)) {
        patches.push({ op: "add", path: `${path}/-`, value: item });
      }
    }
  }

  private getPlanForPath(path: string): ArrayPlan | undefined {
    if (this.pathPlanCache.has(path)) {
      return this.pathPlanCache.get(path);
    }

    // Try exact match first
    let plan = this.plan.get(path);
    if (plan) {
      this.pathPlanCache.set(path, plan);
      return plan;
    }

    // Try normalized path (remove array indices)
    const normalizedPath = path.replace(/\/\d+/g, "");
    plan = this.plan.get(normalizedPath);
    if (plan) {
      this.pathPlanCache.set(path, plan);
      return plan;
    }

    // Try parent wildcard path
    const lastSlash = normalizedPath.lastIndexOf("/");
    if (lastSlash >= 0) {
      const parentPath = `${normalizedPath.substring(0, lastSlash)}/*`;
      plan = this.plan.get(parentPath);
    }

    this.pathPlanCache.set(path, plan);
    return plan;
  }

  #collapseReplace(
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

  #refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: Operation[],
    hashFields?: string[]
  ) {
    if (!deepEqualMemo(oldVal, newVal, hashFields ?? [])) {
      this.diff(oldVal, newVal, path, patches);
    }
  }

  private diffArrayLCS(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[]
  ) {
    const a = arr1;
    const b = arr2;
    const n = a.length;
    const m = b.length;
    const max = n + m;
    const v: Record<number, number> = { 1: 0 };
    const trace: Record<number, number>[] = [];
    let endD = 0;

    // Pre-compute plan lookup to avoid repeated map access in tight loops
    const pathPlan = this.getPlanForPath(path);
    const hashFields = pathPlan?.hashFields ?? [];

    // Phase 1: forward pass (Myers)
    for (let d = 0; d <= max; d++) {
      const vPrev = { ...v };
      for (let k = -d; k <= d; k += 2) {
        const down =
          k === -d ||
          (k !== d &&
            (vPrev[k - 1] ?? -Infinity) < (vPrev[k + 1] ?? -Infinity));
        let x = down ? (vPrev[k + 1] as number) : (vPrev[k - 1] as number) + 1;
        let y = x - k;
        while (x < n && y < m && deepEqualMemo(a[x], b[y], hashFields)) {
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

    // Phase 2: backtrack to raw ops
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

    // Phase 3: collapse replace
    const ops2 = this.#collapseReplace(rawOps);

    // Phase 4: emit JSON-Patch
    let ai = 0;
    let bi = 0;
    for (const op of ops2) {
      switch (op) {
        case "common":
          this.#refine(
            a[ai] as JsonValue,
            b[bi] as JsonValue,
            `${path}/${ai}`,
            patches,
            hashFields
          );
          ai++;
          bi++;
          break;
        case "replace":
          patches.push({
            op: "replace",
            path: `${path}/${ai}`,
            value: b[bi] as JsonValue,
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
            value: b[bi] as JsonValue,
          });
          bi++;
          break;
      }
    }
  }
}
