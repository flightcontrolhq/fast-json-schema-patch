import {parse} from "json-source-map"
import type {JsonValue, PathMap} from "../types"
import {getEpoch} from "./epoch"

// These caches key on object identity, so they cannot detect an in-place
// mutation of a previously-cached object. Per CORE §1.4.4 they MUST be
// output-neutral: a cache MUST NOT return a stale result after an input is
// mutated between diffs. Each entry therefore records the epoch it was written
// in and is treated as a MISS once the epoch advances; a public diff entry
// point (JsonSchemaPatcher.execute / StructuredDiff.execute) bumps the epoch,
// scoping identity-keyed memoization to a single execute() call.

/**
 * Cache for JSON.stringify results
 * Using WeakMap with object identity as keys to avoid memory leaks
 */
const jsonStringCache = new WeakMap<object, {epoch: number; value: string}>()

/**
 * Cache for buildPathMap results
 * Using WeakMap with object identity as keys to avoid memory leaks
 */
const pathMapCache = new WeakMap<object, {epoch: number; value: PathMap}>()

/**
 * Cache for DiffFormatter instances
 * Using a composite key approach for (original, new) pairs
 */
const formatterCache = new WeakMap<
  object,
  WeakMap<object, {epoch: number; value: unknown}>
>()

// F32: `cachedBuildPathMap`'s parse-failure fallback used to write straight
// to `console.error`. Threading an `onWarning` option down to it would touch
// every public call chain that reaches it (JsonSchemaPatcher -> StructuredDiff
// -> DiffFormatter -> cache.ts) for a single internal fallback path, so this
// is a module-level hook instead. `undefined` (the default — no handler ever
// registered) means silent: the fallback still returns `{}` either way.
let warningHandler: ((message: string) => void) | undefined

/**
 * Register (or clear, by passing `undefined`) a callback invoked in place of
 * `console.error` when `cachedBuildPathMap` fails to parse a document's own
 * `JSON.stringify` output (not expected in normal operation, but defended
 * against rather than left to throw).
 */
export function setWarningHandler(handler: ((message: string) => void) | undefined): void {
  warningHandler = handler
}

/**
 * Cached version of JSON.stringify with 2-space indentation
 */
export function cachedJsonStringify(obj: JsonValue): string {
  if (typeof obj !== "object" || obj === null) {
    return JSON.stringify(obj, null, 2)
  }

  const cached = jsonStringCache.get(obj)
  if (cached && cached.epoch === getEpoch()) {
    return cached.value
  }

  const result = JSON.stringify(obj, null, 2)
  jsonStringCache.set(obj, {epoch: getEpoch(), value: result})
  return result
}

export function cachedBuildPathMap(obj: JsonValue): PathMap {
  if (typeof obj !== "object" || obj === null) {
    // For primitives, just return empty path map since they don't have complex structure
    return {}
  }

  const cached = pathMapCache.get(obj)
  if (cached && cached.epoch === getEpoch()) {
    return cached.value
  }

  const jsonText = cachedJsonStringify(obj)
  let pathMap: PathMap

  try {
    const {pointers} = parse(jsonText)
    pathMap = pointers as unknown as PathMap
  } catch (error) {
    warningHandler?.(`Error building path map: ${error}`)
    pathMap = {}
  }

  pathMapCache.set(obj, {epoch: getEpoch(), value: pathMap})
  return pathMap
}

export function getCachedFormatter<T>(
  originalObj: JsonValue,
  newObj: JsonValue,
  createFormatter: (original: JsonValue, newValue: JsonValue) => T,
): T {
  if (
    typeof originalObj !== "object" ||
    originalObj === null ||
    typeof newObj !== "object" ||
    newObj === null
  ) {
    return createFormatter(originalObj, newObj)
  }

  let innerCache = formatterCache.get(originalObj)
  if (!innerCache) {
    innerCache = new WeakMap()
    formatterCache.set(originalObj, innerCache)
  }

  const cached = innerCache.get(newObj)
  if (cached && cached.epoch === getEpoch()) {
    return cached.value as T
  }

  const formatter = createFormatter(originalObj, newObj)
  innerCache.set(newObj, {epoch: getEpoch(), value: formatter})
  return formatter
}
