import {
  deepEqualMemo,
  diffArrayByPrimaryKey,
  diffArrayLCS,
  diffArrayUnique,
} from "./arrayDiffAlgorithms"
import type {
  ArrayPlan,
  BuildPlanOptions,
  JSONSchema,
  JsonArray,
  JsonObject,
  JsonValue,
  Operation,
  Plan,
} from "./types"

export function _resolveRef(ref: string, schema: JSONSchema): JSONSchema | null {
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
  schema: JSONSchema,
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

    arrayPlan.itemSchema = itemsSchema

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

    switch (arrayPlan.strategy) {
      case "primaryKey":
        arrayPlan.compiledDiff = (arr1, arr2, path, patches, diffFn) =>
          diffArrayByPrimaryKey(
            arr1,
            arr2,
            arrayPlan.primaryKey as string,
            path,
            patches,
            diffFn,
            arrayPlan.hashFields,
          )
        break
      case "unique":
        arrayPlan.compiledDiff = (arr1, arr2, path, patches) =>
          diffArrayUnique(arr1, arr2, path, patches)
        break
      default:
        arrayPlan.compiledDiff = (arr1, arr2, path, patches, diffFn) =>
          diffArrayLCS(
            arr1,
            arr2,
            path,
            patches,
            (obj1, obj2, path) => {
              if (!deepEqualMemo(obj1, obj2, arrayPlan.hashFields)) {
                diffFn(obj1, obj2, path, patches)
              }
            },
            arrayPlan.hashFields,
          )
        break
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

export function buildPlan(schema: JSONSchema, options?: BuildPlanOptions): Plan {
  const plan: Plan = new Map()
  _traverseSchema(schema, "", plan, schema, new Set(), options)
  return plan
}

export class SchemaPatcher {
  private plan: Plan

  constructor(options: {plan: Plan}) {
    this.plan = options.plan
  }

  createPatch(doc1: JsonValue, doc2: JsonValue): Operation[] {
    const patches: Operation[] = []
    this.diff(doc1, doc2, "", patches)
    return patches
  }

  diff(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string,
    patches: Operation[],
  ) {
    if (obj1 === obj2) return

    if (obj1 === undefined) {
      patches.push({op: "add", path, value: obj2})
      return
    }

    if (obj2 === undefined) {
      patches.push({op: "remove", path})
      return
    }

    if (
      typeof obj1 !== "object" ||
      obj1 === null ||
      typeof obj2 !== "object" ||
      obj2 === null ||
      Array.isArray(obj1) !== Array.isArray(obj2)
    ) {
      patches.push({op: "replace", path, value: obj2})
      return
    }

    if (Array.isArray(obj1)) {
      this.diffArray(obj1, obj2 as JsonArray, path, patches)
      return
    }

    this.diffObject(obj1, obj2 as JsonObject, path, patches)
  }

  private diffObject(obj1: JsonObject, obj2: JsonObject, path: string, patches: Operation[]) {
    const keys1 = Object.keys(obj1)
    const keys2 = Object.keys(obj2)
    const allKeys = new Set([...keys1, ...keys2])

    for (const key of allKeys) {
      const newPath = `${path}/${key}`
      const val1 = obj1[key]
      const val2 = obj2[key]

      if (val1 === undefined) {
        patches.push({op: "add", path: newPath, value: val2})
      } else if (val2 === undefined) {
        patches.push({op: "remove", path: newPath})
      } else {
        this.diff(val1, val2, newPath, patches)
      }
    }
  }

  private diffArray(arr1: JsonArray, arr2: JsonArray, path: string, patches: Operation[]) {
    const plan = this.getPlanForPath(path)

    if (plan?.compiledDiff) {
      plan.compiledDiff(arr1, arr2, path, patches, this.diff.bind(this))
      return
    }

    const strategy = plan?.strategy || "lcs"

    if (strategy === "primaryKey" && plan?.primaryKey) {
      diffArrayByPrimaryKey(
        arr1,
        arr2,
        plan.primaryKey,
        path,
        patches,
        this.diff.bind(this),
        plan.hashFields,
      )
      return
    }

    if (strategy === "unique") {
      diffArrayUnique(arr1, arr2, path, patches)
      return
    }

    diffArrayLCS(
      arr1,
      arr2,
      path,
      patches,
      this.refine.bind(this),
      this.getPlanForPath(path)?.hashFields,
    )
  }

  private getPlanForPath(path: string): ArrayPlan | undefined {
    let plan = this.plan.get(path)
    if (plan) {
      return plan
    }

    const normalizedPath = path.replace(/\/\d+/g, "")
    plan = this.plan.get(normalizedPath)
    if (plan) {
      return plan
    }

    const lastSlash = normalizedPath.lastIndexOf("/")
    if (lastSlash >= 0) {
      const parentPath = `${normalizedPath.substring(0, lastSlash)}/*`
      plan = this.plan.get(parentPath)
    }

    return plan
  }

  private refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: Operation[],
    hashFields: string[] = [],
  ) {
    if (!deepEqualMemo(oldVal, newVal, hashFields)) {
      this.diff(oldVal, newVal, path, patches)
    }
  }
}
