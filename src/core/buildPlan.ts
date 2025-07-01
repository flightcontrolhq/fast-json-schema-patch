import type {JsonObject} from "../types"

export interface JSONSchema extends JsonObject {
  $ref?: string
  type?: string | string[]
  properties?: Record<string, JSONSchema>
  additionalProperties?: boolean | JSONSchema
  items?: JSONSchema
  anyOf?: JSONSchema[]
  oneOf?: JSONSchema[]
  allOf?: JSONSchema[]
  required?: string[]
}

type Schema = JSONSchema

export interface ArrayPlan {
  primaryKey: string | null
  // Pre-resolved item schema to avoid repeated $ref resolution
  itemSchema?: JSONSchema
  // Set of required fields for faster validation and comparison
  requiredFields?: Set<string>
  // Fields to use for quick equality hashing before deep comparison
  hashFields?: string[]
  // Strategy hint for array comparison
  strategy?: "primaryKey" | "lcs" | "unique"
}

export type Plan = Map<string, ArrayPlan>

export interface BuildPlanOptions {
  primaryKeyMap?: Record<string, string>
  basePath?: string
}

export function _resolveRef(ref: string, schema: Schema): JSONSchema | null {
  if (!ref.startsWith("#/")) {
    // We only support local references for now.
    console.warn(`Unsupported reference: ${ref}`)
    return null
  }
  const path = ref.substring(2).split("/")
  let current: unknown = schema
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
      return null
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current as JSONSchema
}

export function _traverseSchema(
  subSchema: JSONSchema | boolean,
  docPath: string,
  plan: Plan,
  schema: Schema,
  visited: Set<object> = new Set(),
  options?: BuildPlanOptions,
) {
  if (!subSchema || typeof subSchema !== "object" || visited.has(subSchema)) {
    return
  }
  visited.add(subSchema)

  if (subSchema.$ref) {
    const resolved = _resolveRef(subSchema.$ref, schema)
    if (resolved) {
      // Note: We don't change the docPath when resolving a ref
      _traverseSchema(resolved, docPath, plan, schema, visited, options)
    }
    // The visited check at the start of the function handles cycles.
    // We should remove the subSchema from visited before returning,
    // so it can be visited again via a different path.
    visited.delete(subSchema)
    return
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const schemas = subSchema[keyword]
    if (schemas && Array.isArray(schemas)) {
      const seenFingerprints = new Set<string>()
      for (const s of schemas) {
        const fp = stableStringify(s)
        if (seenFingerprints.has(fp)) continue // skip duplicate branch
        seenFingerprints.add(fp)
        _traverseSchema(s, docPath, plan, schema, visited, options)
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
          options,
        )
      }
    }
    if (typeof subSchema.additionalProperties === "object" && subSchema.additionalProperties) {
      _traverseSchema(
        subSchema.additionalProperties,
        `${docPath}/*`,
        plan,
        schema,
        visited,
        options,
      )
    }
  }

  if (subSchema.type === "array" && subSchema.items) {
    const arrayPlan: ArrayPlan = {primaryKey: null, strategy: "lcs"}

    let itemsSchema = subSchema.items
    if (itemsSchema.$ref) {
      itemsSchema = _resolveRef(itemsSchema.$ref, schema) || itemsSchema
    }

    // Store the resolved item schema to avoid repeated resolution
    arrayPlan.itemSchema = itemsSchema

    // Check if items are primitives
    const isPrimitive =
      itemsSchema &&
      (itemsSchema.type === "string" ||
        itemsSchema.type === "number" ||
        itemsSchema.type === "boolean")

    if (isPrimitive) {
      arrayPlan.strategy = "unique"
    }

    const customKey = options?.primaryKeyMap?.[docPath]
    if (customKey) {
      arrayPlan.primaryKey = customKey
      arrayPlan.strategy = "primaryKey"
    } else if (!isPrimitive) {
      // Find primary key and other metadata only for non-primitive object arrays
      const findMetadata = (
        s: JSONSchema,
      ): Pick<ArrayPlan, "primaryKey" | "requiredFields" | "hashFields"> | null => {
        let currentSchema = s
        if (!currentSchema || typeof currentSchema !== "object") return null

        if (currentSchema.$ref) {
          const resolved = _resolveRef(currentSchema.$ref, schema)
          if (!resolved) return null
          currentSchema = resolved
        }
        if (!currentSchema || currentSchema.type !== "object" || !currentSchema.properties) {
          return null
        }

        const props = currentSchema.properties
        const required = new Set(currentSchema.required || []) as Set<string>
        const hashFields: string[] = []

        // Identify potential hash fields (required, primitive types)
        for (const key of required) {
          const prop = props[key]
          if (prop && (prop.type === "string" || prop.type === "number")) {
            hashFields.push(key)
          }
        }

        const potentialKeys = ["id", "name", "port"]
        for (const key of potentialKeys) {
          if (required.has(key)) {
            const prop = props[key]
            if (prop && (prop.type === "string" || prop.type === "number")) {
              return {
                primaryKey: key,
                requiredFields: required,
                hashFields,
              }
            }
          }
        }

        return null
      }

      const schemas = itemsSchema.anyOf || itemsSchema.oneOf
      let metadata: ReturnType<typeof findMetadata> | null = null
      if (schemas) {
        for (const s of schemas) {
          metadata = findMetadata(s)
          if (metadata?.primaryKey) {
            break
          }
        }
      } else {
        metadata = findMetadata(itemsSchema)
      }

      if (metadata?.primaryKey) {
        arrayPlan.primaryKey = metadata.primaryKey
        arrayPlan.requiredFields = metadata.requiredFields
        arrayPlan.hashFields = metadata.hashFields
        arrayPlan.strategy = "primaryKey"
      }
    }

    if (options?.basePath && !docPath.startsWith(options.basePath)) {
      // Skip paths outside the requested basePath
      // Note: we still continue traversal into child schemas so nested arrays under
      // a non-matching prefix aren't processed either.
    } else {
      const targetPath = options?.basePath
        ? docPath.replace(options.basePath as string, "")
        : docPath

      const existingPlan = plan.get(targetPath)
      if (!existingPlan) {
        plan.set(targetPath, arrayPlan)
      } else if (isBetterPlan(arrayPlan, existingPlan)) {
        mergePlanMetadata(arrayPlan, existingPlan)
        plan.set(targetPath, arrayPlan)
      } else {
        // Keep existing but merge any useful metadata from the candidate.
        mergePlanMetadata(existingPlan, arrayPlan)
      }
    }

    // We continue traversal into array items. The path does not change here
    // as the diffing logic will add array indices.
    _traverseSchema(subSchema.items, docPath, plan, schema, visited, options)
  }
  visited.delete(subSchema)
}

export function buildPlan(schema: Schema, options?: BuildPlanOptions): Plan {
  const plan: Plan = new Map()
  _traverseSchema(schema, "", plan, schema, new Set(), options)
  return plan
}

// Utility: produce a canonical JSON string with sorted keys so we can deduplicate
// semantically identical schema fragments during traversal.
function stableStringify(obj: unknown): string {
  const seen = new WeakSet<object>()
  const stringify = (value: unknown): unknown => {
    if (value && typeof value === "object") {
      if (seen.has(value as object)) return undefined
      seen.add(value as object)
      const keys = Object.keys(value as Record<string, unknown>).sort()
      const result: Record<string, unknown> = {}
      for (const k of keys) {
        result[k] = stringify((value as Record<string, unknown>)[k])
      }
      return result
    }
    return value
  }
  return JSON.stringify(stringify(obj))
}

// Rank diffing strategies so we can decide which ArrayPlan is "better".
const STRATEGY_RANK: Record<NonNullable<ArrayPlan["strategy"]>, number> = {
  primaryKey: 3,
  unique: 2,
  lcs: 1,
}

function isBetterPlan(candidate: ArrayPlan, current: ArrayPlan): boolean {
  const rankA = STRATEGY_RANK[candidate.strategy ?? "lcs"]
  const rankB = STRATEGY_RANK[current.strategy ?? "lcs"]

  if (rankA !== rankB) return rankA > rankB

  // If strategies tie, prefer presence of primaryKey.
  if (candidate.primaryKey && !current.primaryKey) return true
  if (!candidate.primaryKey && current.primaryKey) return false

  // Otherwise, prefer the plan with more hashFields (better cheap-equality hints).
  const lenA = candidate.hashFields?.length ?? 0
  const lenB = current.hashFields?.length ?? 0
  return lenA > lenB
}

// Merge supplemental metadata from src into dst (in-place).
function mergePlanMetadata(dst: ArrayPlan, src: ArrayPlan) {
  if (!dst.hashFields && src.hashFields) dst.hashFields = [...src.hashFields]
  if (dst.hashFields && src.hashFields) {
    const merged = new Set([...dst.hashFields, ...src.hashFields])
    dst.hashFields = Array.from(merged)
  }
  if (!dst.requiredFields && src.requiredFields) dst.requiredFields = new Set(src.requiredFields)
}
