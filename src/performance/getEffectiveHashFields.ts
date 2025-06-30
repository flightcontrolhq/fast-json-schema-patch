import type {ArrayPlan} from "../core/buildPlan"
import type {JsonObject} from "../types"

/**
 * Utility to create hash fields from a plan or infer them from objects
 */
export function getEffectiveHashFields(
  plan?: ArrayPlan,
  obj1?: JsonObject,
  obj2?: JsonObject,
  fallbackFields: string[] = [],
): string[] {
  if (plan?.hashFields && plan.hashFields.length > 0) {
    return plan.hashFields
  }

  if (plan?.primaryKey) {
    return [plan.primaryKey]
  }

  if (fallbackFields.length > 0) {
    return fallbackFields
  }

  // Infer common fields from both objects
  if (obj1 && obj2) {
    const keys1 = Object.keys(obj1)
    const keys2 = Object.keys(obj2)
    const commonKeys = keys1.filter((k) => keys2.includes(k))
    // Prioritize likely identifier fields
    const idFields = commonKeys.filter(
      (k) => k.includes("id") || k.includes("key") || k.includes("name"),
    )
    return idFields.length > 0 ? idFields.slice(0, 3) : commonKeys.slice(0, 3)
  }

  return []
}
