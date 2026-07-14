import type {JsonObject, JsonValue} from "../types"

/**
 * Cache for path resolution results to avoid repeated computations
 */
const pathResolutionCache = new Map<string, WeakMap<object, JsonValue | undefined>>()

/**
 * Resolves a JSON Pointer path to get a value from an object
 * Handles JSON Pointer escaping (~0 for ~, ~1 for /)
 */
export function getValueByPath<T = JsonValue>(obj: JsonValue, path: string): T | undefined {
  if (path === "") return obj as T

  // Check cache first
  let objCache = pathResolutionCache.get(path)
  if (!objCache) {
    objCache = new WeakMap()
    pathResolutionCache.set(path, objCache)
  }

  if (typeof obj === "object" && obj !== null && objCache.has(obj)) {
    return objCache.get(obj) as T | undefined
  }

  const parts = path.split("/").slice(1)
  let current: JsonValue = obj

  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      if (typeof obj === "object" && obj !== null) {
        objCache.set(obj, undefined)
      }
      return undefined
    }

    const key = unescapeJsonPointer(part)

    if (Array.isArray(current)) {
      const index = Number.parseInt(key, 10)
      if (Number.isNaN(index) || index < 0 || index >= current.length) {
        if (typeof obj === "object" && obj !== null) {
          objCache.set(obj, undefined)
        }
        return undefined
      }
      current = current[index] as JsonValue
    } else {
      const objCurrent = current as JsonObject
      if (!Object.hasOwn(objCurrent, key)) {
        if (typeof obj === "object" && obj !== null) {
          objCache.set(obj, undefined)
        }
        return undefined
      }
      current = objCurrent[key] as JsonValue
    }
  }

  if (typeof obj === "object" && obj !== null) {
    objCache.set(obj, current)
  }

  return current as T
}

/**
 * Resolves a patch path, handling special cases like "/-" for array append operations
 */
export function resolvePatchPath(
  path: string,
  jsonObj: JsonValue,
  isForNewVersion = false,
): string | null {
  if (path.endsWith("/-")) {
    const parentPath = path.slice(0, -2)

    if (parentPath === "") {
      if (Array.isArray(jsonObj)) {
        return isForNewVersion ? `/${jsonObj.length - 1}` : `/${jsonObj.length}`
      }
      return null
    }

    const parentValue = getValueByPath(jsonObj, parentPath)
    if (Array.isArray(parentValue)) {
      return isForNewVersion ? `${parentPath}/${parentValue.length - 1}` : parentPath
    }
  }

  return path
}

/**
 * Unescapes JSON Pointer special characters
 * ~1 becomes /, ~0 becomes ~
 */
export function unescapeJsonPointer(part: string): string {
  return part.replace(/~1/g, "/").replace(/~0/g, "~")
}

/**
 * Escapes JSON Pointer special characters
 * / becomes ~1, ~ becomes ~0
 */
export function escapeJsonPointer(part: string): string {
  // Fast path: most keys contain no special characters
  if (part.indexOf("~") === -1 && part.indexOf("/") === -1) return part
  return part.replace(/~/g, "~0").replace(/\//g, "~1")
}

/**
 * Splits a path into its component parts, handling escaping
 */
export function splitPath(path: string): string[] {
  if (path === "") return []
  return path.split("/").slice(1).map(unescapeJsonPointer)
}

/**
 * Joins path parts into a JSON Pointer path, handling escaping
 */
export function joinPath(parts: string[]): string {
  if (parts.length === 0) return ""
  return `/${parts.map(escapeJsonPointer).join("/")}`
}
