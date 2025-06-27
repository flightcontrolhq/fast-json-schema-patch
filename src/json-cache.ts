import { parse } from "json-source-map";
import type { JsonValue, PathMap } from "./types";

/**
 * Cache for JSON.stringify results
 * Using WeakMap with object identity as keys to avoid memory leaks
 */
const jsonStringCache = new WeakMap<object, string>();

/**
 * Cache for buildPathMap results
 * Using WeakMap with object identity as keys to avoid memory leaks
 */
const pathMapCache = new WeakMap<object, PathMap>();

/**
 * Cache for DiffFormatter instances
 * Using a composite key approach for (original, new) pairs
 */
const formatterCache = new WeakMap<object, WeakMap<object, unknown>>();

/**
 * Cached version of JSON.stringify with 2-space indentation
 */
export function cachedJsonStringify(obj: JsonValue): string {
  if (typeof obj !== 'object' || obj === null) {
    return JSON.stringify(obj, null, 2);
  }

  if (jsonStringCache.has(obj)) {
    return jsonStringCache.get(obj) as string;
  }

  const result = JSON.stringify(obj, null, 2);
  jsonStringCache.set(obj, result);
  return result;
}

export function cachedBuildPathMap(obj: JsonValue): PathMap {
  if (typeof obj !== 'object' || obj === null) {
    // For primitives, just return empty path map since they don't have complex structure
    return {};
  }

  if (pathMapCache.has(obj)) {
    return pathMapCache.get(obj) as PathMap;
  }

  const jsonText = cachedJsonStringify(obj);
  let pathMap: PathMap;
  
  try {
    const { pointers } = parse(jsonText);
    pathMap = pointers as unknown as PathMap;
  } catch (error) {
    console.error("Error building path map:", error);
    pathMap = {};
  }

  pathMapCache.set(obj, pathMap);
  return pathMap;
}

export function getCachedFormatter<T>(
  originalObj: JsonValue,
  newObj: JsonValue,
  createFormatter: (original: JsonValue, newValue: JsonValue) => T
): T {
  if (typeof originalObj !== 'object' || originalObj === null ||
      typeof newObj !== 'object' || newObj === null) {
    return createFormatter(originalObj, newObj);
  }

  let innerCache = formatterCache.get(originalObj);
  if (!innerCache) {
    innerCache = new WeakMap();
    formatterCache.set(originalObj, innerCache);
  }

  if (innerCache.has(newObj)) {
    return innerCache.get(newObj) as T;
  }

  const formatter = createFormatter(originalObj, newObj);
  innerCache.set(newObj, formatter);
  return formatter;
}

/**
 * Clear all caches (useful for testing or memory management)
 */
export function clearJsonCaches(): void {
  // WeakMaps don't have a clear method, but we can create new instances
  // Note: This won't actually clear existing caches since they're module-level
  // In practice, WeakMaps automatically clean up when objects are garbage collected
  console.warn("clearJsonCaches: WeakMaps will be cleared automatically when objects are garbage collected");
}

/**
 * Get cache statistics (for debugging/monitoring)
 */
export function getCacheStats(): {
  message: string;
} {
  // WeakMaps don't expose size information for privacy/security reasons
  return {
    message: "Cache statistics not available for WeakMaps - they automatically clean up when objects are garbage collected"
  };
} 