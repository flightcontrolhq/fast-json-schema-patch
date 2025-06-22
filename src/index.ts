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
  schema: Schema
) {
  if (!subSchema || typeof subSchema !== "object") {
    return;
  }

  if (subSchema.$ref) {
    const resolved = _resolveRef(subSchema.$ref, schema);
    if (resolved) {
      // Note: We don't change the docPath when resolving a ref
      _traverseSchema(resolved, docPath, plan, schema);
    }
    return;
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(subSchema[keyword])) {
      for (const s of subSchema[keyword]) {
        _traverseSchema(s, docPath, plan, schema);
      }
    }
  }

  if (subSchema.type === "object" && subSchema.properties) {
    for (const key in subSchema.properties) {
      _traverseSchema(
        subSchema.properties[key],
        `${docPath}/${key}`,
        plan,
        schema
      );
    }
  }

  if (subSchema.type === "array" && subSchema.items) {
    const arrayPlan: ArrayPlan = { primaryKey: null };

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
        if (props[key] && props[key].type === "string" && required.has(key)) {
          return key;
        }
      }

      return null;
    };

    if (itemsSchema.anyOf) {
      for (const s of itemsSchema.anyOf) {
        const pk = findPrimaryKey(s);
        if (pk) {
          arrayPlan.primaryKey = pk;
          break;
        }
      }
    } else {
      arrayPlan.primaryKey = findPrimaryKey(itemsSchema);
    }

    if (arrayPlan.primaryKey) {
      plan.set(docPath, arrayPlan);
    }

    // We continue traversal into array items. The path does not change here
    // as the diffing logic will add array indices.
    _traverseSchema(subSchema.items, docPath, plan, schema);
  }
}

export function buildPlan(schema: Schema): Plan {
  const plan: Plan = new Map();
  _traverseSchema(schema, "", plan, schema);
  return plan;
}

export class SchemaPatcher {
  private readonly plan: Plan;

  constructor({ plan, schema }: { plan?: Plan; schema?: Schema }) {
    if (plan) {
      this.plan = plan;
    } else {
      if (!schema) {
        throw new Error("Either plan or schema must be provided");
      }
      this.plan = buildPlan(schema);
    }
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
    const plan = this.plan.get(normalizedPath);
    if (!plan || !plan.primaryKey) {
      // Fallback for arrays without a primary key in the plan
      const len1 = arr1.length;
      const len2 = arr2.length;
      const minLen = Math.min(len1, len2);

      for (let i = 0; i < minLen; i++) {
        this.diff(arr1[i], arr2[i], `${path}/${i}`, patches);
      }

      if (len1 > len2) {
        for (let i = len1 - 1; i >= len2; i--) {
          patches.push({ op: "remove", path: `${path}/${i}` });
        }
      } else if (len2 > len1) {
        for (let i = len1; i < len2; i++) {
          patches.push({ op: "add", path: `${path}/${i}`, value: arr2[i] });
        }
      }
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
    for (const [key, { item, index }] of map1.entries()) {
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
}
