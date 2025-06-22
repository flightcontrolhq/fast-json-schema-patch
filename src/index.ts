export interface Operation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: any;
  from?: string;
}

type Schema = Record<string, any>;

interface ArrayPlan {
  primaryKey: string | null;
}

type Plan = Map<string, ArrayPlan>;

export interface BuildPlanOptions {
  primaryKeyMap?: Record<string, string>;
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
    const arrayPlan: ArrayPlan = { primaryKey: null };

    const customKey = options?.primaryKeyMap?.[docPath];
    if (customKey) {
      arrayPlan.primaryKey = customKey;
    } else {
      let itemsSchema = subSchema.items;
      if (itemsSchema.$ref) {
        itemsSchema = _resolveRef(itemsSchema.$ref, schema);
      }

      const findPrimaryKey = (s: any): string | null => {
        if (!s || typeof s !== "object") return null;

        if (s.$ref) {
          s = _resolveRef(s.$ref, schema);
        }
        if (!s || s.type !== "object" || !s.properties) {
          return null;
        }

        const props = s.properties;
        const required = new Set(s.required || []);

        const potentialKeys = ["id", "name", "port"];
        for (const key of potentialKeys) {
          if (
            props[key] &&
            (props[key].type === "string" || props[key].type === "number") &&
            required.has(key)
          ) {
            return key;
          }
        }

        return null;
      };

      const schemas = itemsSchema.anyOf || itemsSchema.oneOf;
      if (schemas) {
        for (const s of schemas) {
          const pk = findPrimaryKey(s);
          if (pk) {
            arrayPlan.primaryKey = pk;
            break;
          }
        }
      } else {
        arrayPlan.primaryKey = findPrimaryKey(itemsSchema);
      }
    }

    plan.set(docPath, arrayPlan);

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

  if (
    obj1 &&
    obj2 &&
    typeof obj1 === "object" &&
    typeof obj2 === "object"
  ) {
    if (obj1.constructor !== obj2.constructor) return false;

    let length: number, i: number;
    if (Array.isArray(obj1)) {
      length = obj1.length;
      if (length !== obj2.length) return false;
      for (i = length; i-- !== 0; )
        if (!deepEqual(obj1[i], obj2[i])) return false;
      return true;
    }

    const keys = Object.keys(obj1);
    length = keys.length;
    if (length !== Object.keys(obj2).length) return false;

    for (i = length; i-- !== 0; ) {
      const key = keys[i] as keyof typeof obj1;
      if (!obj2.hasOwnProperty(key) || !deepEqual(obj1[key], obj2[key]))
        return false;
    }

    return true;
  }

  // true if both NaN, false otherwise
  return Number.isNaN(obj1) && Number.isNaN(obj2);
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
    const type1 = typeof obj1;
    const type2 = typeof obj2;

    if (obj1 === obj2) {
      return;
    }

    if (obj1 === undefined) {
      patches.push({ op: "add", path, value: obj2 });
      return;
    }

    if (obj2 === undefined) {
      patches.push({ op: "remove", path });
      return;
    }

    if (type1 !== type2 || Array.isArray(obj1) !== Array.isArray(obj2)) {
      patches.push({ op: "replace", path, value: obj2 });
      return;
    }

    if (Array.isArray(obj1)) {
      this.diffArray(obj1, obj2, path, patches);
    } else if (type1 === "object" && obj1 !== null && obj2 !== null) {
      this.diffObject(obj1, obj2, path, patches);
    } else {
      patches.push({ op: "replace", path, value: obj2 });
    }
  }

  private diffObject(
    obj1: Record<string, any>,
    obj2: Record<string, any>,
    path: string,
    patches: Operation[]
  ) {
    const keys1 = new Set(Object.keys(obj1));
    const keys2 = new Set(Object.keys(obj2));

    for (const key of keys1) {
      if (!keys2.has(key)) {
        patches.push({ op: "remove", path: `${path}/${key}` });
      }
    }

    for (const key of keys2) {
      const newPath = `${path}/${key}`;
      if (!keys1.has(key)) {
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

    if (!plan || !plan.primaryKey) {
      // Fallback for arrays without a primary key in the plan
      this.diffArrayLCS(arr1, arr2, path, patches);
      return;
    }

    const { primaryKey } = plan;

    const map1 = new Map(
      arr1.map((item, index) => [item[primaryKey], { item, index }])
    );
    const map2 = new Map(
      arr2.map((item, index) => [item[primaryKey], { item, index }])
    );

    const removed: { index: number }[] = [];
    for (const [key, { index }] of map1.entries()) {
      if (!map2.has(key)) {
        removed.push({ index });
      }
    }

    // Remove from the end to avoid index shifting issues
    removed.sort((a, b) => b.index - a.index);
    for (const { index } of removed) {
      patches.push({ op: "remove", path: `${path}/${index}` });
    }

    const added: { item: any }[] = [];
    for (const [key, { item }] of map2.entries()) {
      if (!map1.has(key)) {
        added.push({ item });
      } else {
        // It exists in both, so diff the items.
        // We need original index from arr1 for path
        const original = map1.get(key)!;
        this.diff(original.item, item, `${path}/${original.index}`, patches);
      }
    }

    for (const { item } of added) {
      // RFC6902 says for add to an array, you can use a high index or '-'
      patches.push({ op: "add", path: `${path}/-`, value: item });
    }
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
