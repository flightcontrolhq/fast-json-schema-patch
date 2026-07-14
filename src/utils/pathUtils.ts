import type {JsonObject, JsonValue} from "../types"

/**
 * Resolves a JSON Pointer path to get a value from an object.
 * Handles JSON Pointer escaping (~0 for ~, ~1 for /).
 *
 * D3 (spec-v1-rc external-review defect round, CORE §1.4.4): this previously
 * memoised results in a module-level `Map<path, WeakMap<obj, value>>` keyed on
 * object identity and NEVER epoch-scoped, so after an in-place mutation of a
 * cached document it returned the stale pre-mutation value (probe:
 * getValueByPath(doc,"/a")===1, then doc.a=999, then still 1). Unlike the
 * equality caches (deepEqual.ts, F02) this cache was not on any SPEC hot path —
 * its only callers are the StructuredDiff aggregator (out of SPEC scope, CONF §1.5)
 * and DiffFormatter's `-` resolution, both resolving short prefixes a couple of
 * times per execute. A micro-bench of an epoch-scoped variant vs no cache on
 * that exact pattern showed the cache as dead weight once made correct
 * (~0.97x — the bookkeeping cost exceeded the ~2 intra-execute reuse hits), and
 * the module-level Map leaked one entry per distinct path string forever. So the
 * cache was removed rather than epoch-scoped: a plain, always-fresh resolver.
 */
export function getValueByPath<T = JsonValue>(obj: JsonValue, path: string): T | undefined {
  if (path === "") return obj as T

  const parts = path.split("/").slice(1)
  let current: JsonValue = obj

  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined

    const key = unescapeJsonPointer(part)

    if (Array.isArray(current)) {
      const index = Number.parseInt(key, 10)
      if (Number.isNaN(index) || index < 0 || index >= current.length) return undefined
      current = current[index] as JsonValue
    } else {
      const objCurrent = current as JsonObject
      if (!Object.hasOwn(objCurrent, key)) return undefined
      current = objCurrent[key] as JsonValue
    }
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
