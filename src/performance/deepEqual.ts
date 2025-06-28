import type { ArrayPlan } from "../core/buildPlan";
import type { JsonObject } from "../types";
import { fastHash } from "./fashHash";

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
const schemaEqCache = new WeakMap<
  object,
  WeakMap<object, Map<string, boolean>>
>();

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
  if (
    effectiveHashFields.length > 0 &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const h1 = fastHash(a, effectiveHashFields);
    const h2 = fastHash(b, effectiveHashFields);
    if (h1 !== h2) return false;
  }

  // Schema-aware memoization cache with plan fingerprint
  const planFingerprint = plan
    ? `${plan.primaryKey || ""}-${plan.hashFields?.join(",") || ""}-${
        plan.strategy || ""
      }`
    : "default";

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

export function deepEqualPlanned(
  obj1: JsonObject,
  obj2: JsonObject,
  plan: ArrayPlan
): boolean {
  if (!plan.itemSchema?.properties) {
    // Fallback for safety, though plan should always have this for planned arrays
    return deepEqualSchemaAware(obj1, obj2, plan);
  }

  const props = Object.keys(plan.itemSchema.properties);
  for (const prop of props) {
    if (!deepEqual(obj1[prop], obj2[prop])) {
      return false;
    }
  }

  // Also ensure no extra properties exist in obj2 that are not in obj1 (schema)
  if (Object.keys(obj1).length !== Object.keys(obj2).length) {
    return false;
  }

  return true;
}
