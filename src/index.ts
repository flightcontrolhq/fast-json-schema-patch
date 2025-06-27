import {
  diffArrayByPrimaryKey,
  diffArrayLCS,
  diffArrayUnique,
} from "./diffing-utils";
import { normalizePath, getWildcardPath } from "./path-utils";
import type {
  JsonArray,
  JsonObject,
  JsonValue,
  Operation,
} from "./types";

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

type Schema = JSONSchema;

export interface ArrayPlan {
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

export type Plan = Map<string, ArrayPlan>;

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
// Enhanced cache for schema-aware equality with plan information
const schemaEqCache = new WeakMap<object, WeakMap<object, Map<string, boolean>>>();

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

  // Enhanced hash-based pre-filtering - use for all object comparisons
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

/**
 * Schema-aware deep equality that prioritizes comparison of significant fields first
 * Uses plan information to optimize equality checks
 */
export function deepEqualSchemaAware(
  obj1: unknown,
  obj2: unknown,
  plan?: ArrayPlan,
  hotFields?: string[]
): boolean {
  if (obj1 === obj2) return true;
  if (obj1 == null || obj2 == null) return obj1 === obj2;

  const type1 = typeof obj1;
  const type2 = typeof obj2;
  if (type1 !== type2) return false;
  if (type1 !== "object") {
    return obj1 === obj2;
  }

  const a = obj1 as JsonObject;
  const b = obj2 as JsonObject;

  // Use plan-derived hash fields for faster pre-filtering
  const effectiveHashFields = plan?.hashFields || hotFields || [];
  
  // Enhanced hash-based pre-filtering with plan information
  if (effectiveHashFields.length > 0 && !Array.isArray(a) && !Array.isArray(b)) {
    const h1 = fastHash(a, effectiveHashFields);
    const h2 = fastHash(b, effectiveHashFields);
    if (h1 !== h2) return false;
  }

  // Schema-aware memoization cache with plan fingerprint
  const planFingerprint = plan ? 
    `${plan.primaryKey || ''}-${plan.hashFields?.join(',') || ''}-${plan.strategy || ''}` : 
    'default';
  
  let planCache = schemaEqCache.get(a);
  if (planCache?.has(b)) {
    const cached = planCache.get(b)?.get(planFingerprint);
    if (cached !== undefined) return cached;
  }

  // Schema-aware comparison: check significant fields first
  if (plan?.requiredFields && plan.requiredFields.size > 0) {
    // Check required fields first - early exit if they differ
    for (const field of plan.requiredFields) {
      if (!deepEqual(a[field], b[field])) {
        // Cache the negative result
        if (!planCache) {
          planCache = new WeakMap();
          schemaEqCache.set(a, planCache);
        }
        if (!planCache.has(b)) {
          planCache.set(b, new Map());
        }
        planCache.get(b)?.set(planFingerprint, false);
        return false;
      }
    }
  }

  // Check primary key field with high priority if available
  if (plan?.primaryKey && plan.primaryKey in a && plan.primaryKey in b) {
    const primaryKey = plan.primaryKey;
    const keyEqual = deepEqual(a[primaryKey], b[primaryKey]);
    if (!keyEqual) {
      // Cache the negative result
      if (!planCache) {
        planCache = new WeakMap();
        schemaEqCache.set(a, planCache);
      }
      if (!planCache.has(b)) {
        planCache.set(b, new Map());
      }
      planCache.get(b)?.set(planFingerprint, false);
      return false;
    }
  }

  // Fall back to full deep equality check
  const result = deepEqual(a, b);

  // Cache the result with plan fingerprint
  if (!planCache) {
    planCache = new WeakMap();
    schemaEqCache.set(a, planCache);
  }
  if (!planCache.has(b)) {
    planCache.set(b, new Map());
  }
  planCache.get(b)?.set(planFingerprint, result);

  return result;
}

/**
 * A simple, non-cryptographic FNV-1a hash function.
 * 
 * @param {string} str The string to hash.
 * @returns {string} A 32-bit hash as a hex string.
 */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5; // FNV_offset_basis

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  // Return as a hex string
  return (hash >>> 0).toString(16);
}

export function fastHash(obj: JsonObject, fields: string[]): string {
  if (fields.length === 0) return '';
  
  let combined = '';
  for (let i = 0; i < fields.length; i++) {
    const key = fields[i];
    if (!key) continue;
    const value = obj[key];
    if (value !== undefined) {
      // Create a string representation with field position to avoid collision from reordering
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      combined += `${i}:${key}=${str}|`;
    }
  }
  
  return combined ? fnv1aHash(combined) : '';
}

/**
 * Utility to create hash fields from a plan or infer them from objects
 */
export function getEffectiveHashFields(
  plan?: ArrayPlan,
  obj1?: JsonObject,
  obj2?: JsonObject,
  fallbackFields: string[] = []
): string[] {
  if (plan?.hashFields && plan.hashFields.length > 0) {
    return plan.hashFields;
  }
  
  if (plan?.primaryKey) {
    return [plan.primaryKey];
  }
  
  if (fallbackFields.length > 0) {
    return fallbackFields;
  }
  
  // Infer common fields from both objects
  if (obj1 && obj2) {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    const commonKeys = keys1.filter(k => keys2.includes(k));
    // Prioritize likely identifier fields
    const idFields = commonKeys.filter(k => 
      k.includes('id') || k.includes('key') || k.includes('name')
    );
    return idFields.length > 0 ? idFields.slice(0, 3) : commonKeys.slice(0, 3);
  }
  
  return [];
}

export class SchemaPatcher {
  private plan: Plan;

  constructor(options: { plan: Plan }) {
    this.plan = options.plan;
  }

  createPatch(doc1: JsonValue, doc2: JsonValue): Operation[] {
    const patches: Operation[] = [];
    this.diff(doc1, doc2, "", patches);
    return patches;
  }

  private diff(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string,
    patches: Operation[]
  ) {
    if (obj1 === obj2) return;

    if (obj1 === undefined) {
      patches.push({ op: "add", path, value: obj2 });
      return;
    }

    if (obj2 === undefined) {
      patches.push({ op: "remove", path, oldValue: obj1 });
      return;
    }

    if (
      typeof obj1 !== "object" ||
      obj1 === null ||
      typeof obj2 !== "object" ||
      obj2 === null ||
      Array.isArray(obj1) !== Array.isArray(obj2)
    ) {
      patches.push({ op: "replace", path, value: obj2, oldValue: obj1 });
      return;
    }

    if (Array.isArray(obj1)) {
      this.diffArray(obj1, obj2 as JsonArray, path, patches);
      return;
    }

    this.diffObject(obj1, obj2 as JsonObject, path, patches);
  }

  private diffObject(
    obj1: JsonObject,
    obj2: JsonObject,
    path: string,
    patches: Operation[]
  ) {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    const allKeys = new Set([...keys1, ...keys2]);

    for (const key of allKeys) {
      const newPath = `${path}/${key}`;
      const val1 = obj1[key];
      const val2 = obj2[key];

      if (val1 === undefined && val2 !== undefined) {
        patches.push({ op: "add", path: newPath, value: val2 });
      } else if (val2 === undefined && val1 !== undefined) {
        patches.push({ op: "remove", path: newPath, oldValue: val1 });
      } else {
        this.diff(val1, val2, newPath, patches);
      }
    }
  }

  private diffArray(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[]
  ) {
    const plan = this.getPlanForPath(path);
    const strategy = plan?.strategy || "lcs";

    if (strategy === "primaryKey" && plan?.primaryKey) {
      diffArrayByPrimaryKey(
        arr1,
        arr2,
        plan.primaryKey,
        path,
        patches,
        this.diff.bind(this),
        plan.hashFields
      );
      return;
    }

    if (strategy === "unique") {
      diffArrayUnique(arr1, arr2, path, patches);
      return;
    }

    diffArrayLCS(
      arr1,
      arr2,
      path,
      patches,
      this.#refine.bind(this),
      this.getPlanForPath(path)?.hashFields
    );
  }

  private getPlanForPath(path: string): ArrayPlan | undefined {
    // Try exact match first
    let plan = this.plan.get(path);
    if (plan) {
      return plan;
    }

    // Try normalized path (remove array indices)
    const normalizedPath = normalizePath(path);
    plan = this.plan.get(normalizedPath);
    if (plan) {
      return plan;
    }

    // Try parent wildcard path
    const wildcardPath = getWildcardPath(path);
    if (wildcardPath) {
      plan = this.plan.get(wildcardPath);
    }

    return plan;
  }

  #refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: Operation[],
    hashFields: string[] = []
  ) {
    if (!deepEqualMemo(oldVal, newVal, hashFields)) {
      this.diff(oldVal, newVal, path, patches);
    }
  }
}