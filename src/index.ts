/** biome-ignore-all lint/suspicious/noExplicitAny: because I know what I'm doing */
/** biome-ignore-all lint/suspicious/noPrototypeBuiltins: because I know what I'm doing */
export interface Operation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: any;
  from?: string;
}

type Schema = Record<string, any>;

interface ArrayPlan {
  primaryKey: string | null;
  // Pre-resolved item schema to avoid repeated $ref resolution
  itemSchema?: any;
  // Set of required fields for faster validation and comparison
  requiredFields?: Set<string>;
  // Fields to use for quick equality hashing before deep comparison
  hashFields?: string[];
  // Strategy hint for array comparison
  strategy?: "primaryKey" | "lcs";
  // Whether array items are primitives (for faster comparison)
  isPrimitiveItems?: boolean;
}

type Plan = Map<string, ArrayPlan>;

export interface BuildPlanOptions {
  primaryKeyMap?: Record<string, string>;
  basePath?: string;
}

function _resolveRef(ref: string, schema: Schema): any {
  if (!ref.startsWith("#/")) {
    // We only support local references for now.
    console.warn(`Unsupported reference: ${ref}`);
    return null;
  }
  const path = ref.substring(2).split("/");
  let current: any = schema;
  for (const part of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      !current.hasOwnProperty(part)
    ) {
      return null;
    }
    current = current[part];
  }
  return current;
}

function _traverseSchema(
  subSchema: any,
  docPath: string,
  plan: Plan,
  schema: Schema,
  visited: Set<any> = new Set(),
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

  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
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
          subSchema.properties[key],
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
      itemsSchema = _resolveRef(itemsSchema.$ref, schema);
    }

    // Store the resolved item schema to avoid repeated resolution
    arrayPlan.itemSchema = itemsSchema;

    // Check if items are primitives
    const isPrimitive =
      itemsSchema &&
      (itemsSchema.type === "string" ||
        itemsSchema.type === "number" ||
        itemsSchema.type === "boolean");
    arrayPlan.isPrimitiveItems = isPrimitive;

    const customKey = options?.primaryKeyMap?.[docPath];
    if (customKey) {
      arrayPlan.primaryKey = customKey;
      arrayPlan.strategy = "primaryKey";
    } else if (!isPrimitive) {
      // Find primary key and other metadata only for non-primitive object arrays
      const findMetadata = (
        s: any
      ): Pick<
        ArrayPlan,
        "primaryKey" | "requiredFields" | "hashFields"
      > | null => {
        if (!s || typeof s !== "object") return null;

        if (s.$ref) {
          s = _resolveRef(s.$ref, schema);
        }
        if (!s || s.type !== "object" || !s.properties) {
          return null;
        }

        const props = s.properties;
        const required = new Set(s.required || []) as Set<string>;
        const hashFields: string[] = [];

        // Identify potential hash fields (required, primitive types)
        for (const key of required) {
          const prop = props[key];
          if (
            prop &&
            (prop.type === "string" || prop.type === "number")
          ) {
            hashFields.push(key);
          }
        }

        const potentialKeys = ["id", "name", "port"];
        for (const key of potentialKeys) {
          if (required.has(key)) {
            const prop = props[key];
            if (
              prop &&
              (prop.type === "string" || prop.type === "number")
            ) {
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

function deepEqual(obj1: any, obj2: any): boolean {
  if (obj1 === obj2) return true;

  // Quick type and null checks
  if (obj1 == null || obj2 == null) return obj1 === obj2;
  
  const type1 = typeof obj1;
  const type2 = typeof obj2;
  if (type1 !== type2) return false;
  
  // For non-objects, they're already not equal if we reach here
  if (type1 !== "object") {
    // Handle NaN case
    return Number.isNaN(obj1) && Number.isNaN(obj2);
  }

  // Both are objects at this point
  const isArray1 = Array.isArray(obj1);
  const isArray2 = Array.isArray(obj2);
  if (isArray1 !== isArray2) return false;

  if (isArray1) {
    // Array comparison - optimized
    const length = obj1.length;
    if (length !== obj2.length) return false;
    for (let i = 0; i < length; i++) {
      if (!deepEqual(obj1[i], obj2[i])) return false;
    }
    return true;
  }

  // Object comparison - optimized
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);
  const length = keys1.length;
  if (length !== keys2.length) return false;

  for (const key of keys1) {
    if (!(key in obj2) || !deepEqual(obj1[key], obj2[key])) {
      return false;
    }
  }

  return true;
}

// A lightweight hash function for quick object comparison.
function fastHash(obj: any, fields: string[]): string {
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

  constructor({ plan }: { plan: Plan }) {
    this.plan = plan;
  }

  public createPatch(doc1: any, doc2: any): Operation[] {
    const patches: Operation[] = [];
    this.diff(doc1, doc2, "", patches);
    return patches;
  }

  private diff(obj1: any, obj2: any, path: string, patches: Operation[]) {
    // Fast path for identical values
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
      this.diffArray(obj1, obj2, path, patches);
    } else {
      this.diffObject(obj1, obj2, path, patches);
    }
  }

  private diffObject(
    obj1: Record<string, any>,
    obj2: Record<string, any>,
    path: string,
    patches: Operation[]
  ) {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    
    // Create sets only when needed for efficient lookup
    const keys2Set = new Set(keys2);

    // Process removals
    for (let i = 0; i < keys1.length; i++) {
      const key = keys1[i];
      if (key === undefined) {
        continue;
      }
      if (!keys2Set.has(key)) {
        patches.push({ op: "remove", path: `${path}/${key}` });
      }
    }

    // Process additions and changes
    for (let i = 0; i < keys2.length; i++) {
      const key = keys2[i];
      if (key === undefined) {
        continue;
      }
      const newPath = `${path}/${key}`;
      
      if (!(key in obj1)) {
        patches.push({ op: "add", path: newPath, value: obj2[key] });
      } else {
        this.diff(obj1[key], obj2[key], newPath, patches);
      }
    }
  }

  private diffArray(
    arr1: any[],
    arr2: any[],
    path: string,
    patches: Operation[]
  ) {
    const normalizedPath = path.replace(/\/\d+/g, "");
    let plan = this.plan.get(normalizedPath);
    if (!plan) {
      const parts = normalizedPath.split("/");
      parts.pop();
      const parentPath = `${parts.join("/")}/*`;
      plan = this.plan.get(parentPath);
    }

    // Use the strategy from the plan, or fallback to LCS
    const strategy = plan?.strategy || "lcs";

    if (strategy === "primaryKey" && plan?.primaryKey) {
      const { primaryKey, hashFields } = plan;
      const useHashing = hashFields && hashFields.length > 0;

      const map1 = new Map<any, number>();
      for (let i = 0; i < arr1.length; i++) {
        map1.set(arr1[i][primaryKey], i);
      }

      const map2 = new Map<any, number>();
      for (let i = 0; i < arr2.length; i++) {
        map2.set(arr2[i][primaryKey], i);
      }

      const modificationPatches: Operation[] = [];
      const additionPatches: Operation[] = [];
      const removalIndices: number[] = [];

      for (const [key, oldIndex] of map1.entries()) {
        if (!map2.has(key)) {
          removalIndices.push(oldIndex);
        }
      }

      for (const [key, newIndex] of map2.entries()) {
        const oldIndex = map1.get(key);
        const newItem = arr2[newIndex];
        if (!newItem) {
          continue;
        }

        if (oldIndex === undefined) {
          additionPatches.push({ op: "add", path: `${path}/-`, value: newItem });
        } else {
          const oldItem = arr1[oldIndex];
          if (!oldItem) {
            continue;
          }
          let areEqual = false;
          // Use hash for a quick check if available
          if (useHashing) {
            if (
              fastHash(oldItem, hashFields) === fastHash(newItem, hashFields)
            ) {
              // If hashes match, do a full deepEqual.
              // This avoids deepEqual for the majority of objects that have changed.
              if (deepEqual(oldItem, newItem)) {
                areEqual = true;
              }
            }
          } else {
            // Fallback to deepEqual if no hashFields are defined
            if (deepEqual(oldItem, newItem)) {
              areEqual = true;
            }
          }

          if (!areEqual) {
            this.diff(oldItem, newItem, `${path}/${oldIndex}`, modificationPatches);
          }
        }
      }

      // Apply patches in a safe order: modifications, then removals, then additions.
      patches.push(...modificationPatches);
      
      removalIndices.sort((a, b) => b - a);
      for (const index of removalIndices) {
        patches.push({ op: "remove", path: `${path}/${index}` });
      }

      patches.push(...additionPatches);
      return;
    }

    // Fallback to LCS for complex cases without a primary key
    this.diffArrayLCS(arr1, arr2, path, patches);
  }

  private diffArrayLCS(
    arr1: any[],
    arr2: any[],
    path: string,
    patches: Operation[]
  ) {
    // Based on https://github.com/google/diff-match-patch/blob/master/javascript/diff_match_patch_uncompressed.js
    // This is the Myers difference algorithm.
    const a = arr1;
    const b = arr2;

    const n = a.length;
    const m = b.length;
    const max = n + m;
    const v: Record<number, number> = { 1: 0 };
    const trace: Record<number, number>[] = [];

    for (let d = 0; d <= max; d++) {
      trace.push({ ...v });
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        const vk_minus_1 = v[k - 1];
        const vk_plus_1 = v[k + 1];

        if (
          k === -d ||
          (k !== d &&
            vk_minus_1 !== undefined &&
            vk_plus_1 !== undefined &&
            vk_minus_1 < vk_plus_1)
        ) {
          x = vk_plus_1 as number;
        } else {
          x = (vk_minus_1 as number) + 1;
        }
        let y = x - k;
        while (x < n && y < m && deepEqual(a[x], b[y])) {
          x++;
          y++;
        }
        v[k] = x;
        if (x >= n && y >= m) {
          // Found the end.
          const ops: ("common" | "add" | "remove")[] = [];
          let i = n;
          let j = m;
          let d_ = d;
          let k_ = i - j;

          while (i > 0 || j > 0) {
            const v_ = trace[d_];
            if (!v_) {
              // Should not happen, but as a safeguard
              break;
            }

            const x_ = v_[k_];
            const x_prev_k = d_ > 0 ? trace[d_ - 1]?.[k_] : undefined;
            const x_prev_k_plus_1 =
              d_ > 0 ? trace[d_ - 1]?.[k_ + 1] : undefined;
            const x_prev_k_minus_1 =
              d_ > 0 ? trace[d_ - 1]?.[k_ - 1] : undefined;

            if (
              x_prev_k_plus_1 !== undefined &&
              (x_prev_k_minus_1 === undefined ||
                x_prev_k_plus_1 > x_prev_k_minus_1) &&
              x_ === x_prev_k_plus_1
            ) {
              // Insertion
              ops.unshift("add");
              j--;
              k_ = k_ + 1;
              d_--;
            } else if (
              x_prev_k_minus_1 !== undefined &&
              x_ === x_prev_k_minus_1 + 1
            ) {
              // Deletion
              ops.unshift("remove");
              i--;
              k_ = k_ - 1;
              d_--;
            } else {
              // Common
              ops.unshift("common");
              i--;
              j--;
              if (
                x_prev_k !== undefined &&
                v_[k_] === x_prev_k &&
                trace[d_ - 1] !== v_
              ) {
                d_--;
              }
            }
          }

          const finalPatches: Operation[] = [];
          const tempPatches: Operation[] = [];
          const removals: Operation[] = [];
          let arr1Index = 0;
          let arr2Index = 0;
          for (const op of ops) {
            if (op === "common") {
              this.diff(
                arr1[arr1Index],
                arr2[arr2Index],
                `${path}/${arr1Index}`,
                tempPatches
              );
              arr1Index++;
              arr2Index++;
            } else if (op === "add") {
              tempPatches.push({
                op: "add",
                path: `${path}/${arr1Index}`,
                value: arr2[arr2Index],
              });
              arr2Index++;
            } else {
              removals.push({
                op: "remove",
                path: `${path}/${arr1Index}`,
              });
              arr1Index++;
            }
          }
          finalPatches.push(...tempPatches, ...removals.reverse());
          patches.push(...finalPatches);
          return;
        }
      }
    }
  }
}
