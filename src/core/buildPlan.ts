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
      for (const s of schemas) {
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

    if (options?.basePath) {
      if (docPath.startsWith(options.basePath)) {
        plan.set(docPath.replace(options.basePath, ""), arrayPlan)
      }
    } else {
      plan.set(docPath, arrayPlan)
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
