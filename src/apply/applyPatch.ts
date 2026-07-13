import type { JsonArray, JsonObject, JsonValue, Operation } from "../types"
import { deepEqual } from "../performance/deepEqual"
import { splitPath } from "../utils/pathUtils"

export type PatchErrorCode =
  | "INVALID_POINTER" // malformed pointer; "-" where it is not allowed; "01"-style indices
  | "PATH_UNRESOLVABLE" // the target location (or an intermediate segment) does not exist
  | "INDEX_OUT_OF_BOUNDS" // array index out of range for the operation
  | "TEST_FAILED" // RFC 6902 `test` value mismatch
  | "OLD_VALUE_MISMATCH" // validateOldValues: document value differs from op.oldValue
  | "INVALID_OPERATION" // unknown op, missing field, remove at root, move into own child
  | "UNSAFE_KEY" // "__proto__" | "constructor" | "prototype" pointer segment

export interface ApplyPatchOptions {
  /**
   * When true, remove/replace operations that carry an `oldValue` (this
   * library's extension) are validated against the current document value
   * before being applied, similar to an implicit RFC 6902 `test` op.
   * Operations without `oldValue` are applied unchecked. Defaults to false.
   */
  validateOldValues?: boolean
  /**
   * When true, operation `value` payloads are deep-cloned before insertion so
   * the result never aliases objects owned by the patch. Defaults to false
   * (values are inserted by reference, matching fast-json-patch semantics).
   */
  cloneValues?: boolean
  /**
   * When true, the returned document is a fully independent deep clone that
   * shares no structure with the input document or the patch. Use this when
   * you intend to MUTATE the result afterwards: with the default structural
   * sharing, mutating an untouched subtree of the result would also mutate
   * the input document. Defaults to false.
   */
  cloneResult?: boolean
}

export class JsonPatchError extends Error {
  readonly code: PatchErrorCode
  readonly operation: Operation | undefined
  readonly operationIndex: number

  constructor(
    message: string,
    code: PatchErrorCode,
    operation: Operation | undefined,
    operationIndex: number,
  ) {
    super(message)
    this.name = "JsonPatchError"
    this.code = code
    this.operation = operation
    this.operationIndex = operationIndex
  }
}

function fail(message: string, code: PatchErrorCode, op: Operation | undefined, index: number): never {
  throw new JsonPatchError(message, code, op, index)
}

const ARRAY_INDEX_RE = /^(0|[1-9]\d*)$/

/**
 * Rejects pointer segments that would mutate the prototype chain instead of
 * (or in addition to) an own property — the classic JSON Patch
 * prototype-pollution vector (e.g. CVE-2021-4279 in fast-json-patch).
 * `__proto__` is unsafe anywhere; `prototype` only via a preceding
 * `constructor` segment. Standalone "constructor"/"prototype" keys are
 * legitimate JSON and stay usable.
 */
function checkSafeKey(key: string, previousKey: string | undefined, op: Operation, opIndex: number): void {
  if (key === "__proto__" || (key === "prototype" && previousKey === "constructor")) {
    fail(`Refusing to touch unsafe object key "${key}" in path "${op.path}"`, "UNSAFE_KEY", op, opIndex)
  }
}

function parseArrayIndex(
  part: string,
  length: number,
  allowEnd: boolean,
  op: Operation,
  opIndex: number,
): number {
  if (part === "-") {
    if (!allowEnd) {
      fail(`Cannot use "-" with "${op.op}" at "${op.path}"`, "INVALID_POINTER", op, opIndex)
    }
    return length
  }
  if (!ARRAY_INDEX_RE.test(part)) {
    fail(`Invalid array index "${part}" in path "${op.path}"`, "INVALID_POINTER", op, opIndex)
  }
  const index = Number.parseInt(part, 10)
  const max = allowEnd ? length : length - 1
  if (index > max) {
    fail(
      `Index ${index} out of bounds (length ${length}) in path "${op.path}"`,
      "INDEX_OUT_OF_BOUNDS",
      op,
      opIndex,
    )
  }
  return index
}

/**
 * Clones a container unless it was already cloned during this applyPatch
 * call. This gives copy-on-write structural sharing: untouched subtrees of
 * the input document are shared by reference with the result.
 */
function cloneNode(node: JsonValue, cloned: WeakSet<object>): JsonValue {
  if (typeof node !== "object" || node === null || cloned.has(node)) {
    return node
  }
  const copy: JsonValue = Array.isArray(node) ? node.slice() : { ...node }
  cloned.add(copy as object)
  return copy
}

interface ResolvedParent {
  /** Possibly-new root after copy-on-write cloning along the path */
  root: JsonValue
  /** The (cloned, safe-to-mutate) container holding the final segment */
  parent: JsonObject | JsonArray
  /** Final path segment, unescaped */
  key: string
}

/**
 * Walks to the parent of the location addressed by `parts`, cloning every
 * container along the way (copy-on-write). Every intermediate segment must
 * exist per RFC 6902.
 */
function resolveParent(
  root: JsonValue,
  parts: string[],
  cloned: WeakSet<object>,
  op: Operation,
  opIndex: number,
): ResolvedParent {
  const newRoot = cloneNode(root, cloned)
  let current = newRoot

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string
    if (typeof current !== "object" || current === null) {
      fail(`Path "${op.path}" does not exist (at segment "${part}")`, "PATH_UNRESOLVABLE", op, opIndex)
    }
    let child: JsonValue | undefined
    if (Array.isArray(current)) {
      const index = parseArrayIndex(part, current.length, false, op, opIndex)
      child = current[index]
      const clonedChild = cloneNode(child as JsonValue, cloned)
      current[index] = clonedChild
      current = clonedChild
    } else {
      checkSafeKey(part, parts[i - 1], op, opIndex)
      const obj = current as JsonObject
      if (!Object.hasOwn(obj, part)) {
        fail(`Path "${op.path}" does not exist (at segment "${part}")`, "PATH_UNRESOLVABLE", op, opIndex)
      }
      child = obj[part]
      const clonedChild = cloneNode(child as JsonValue, cloned)
      obj[part] = clonedChild
      current = clonedChild
    }
  }

  const key = parts[parts.length - 1] as string
  if (typeof current !== "object" || current === null) {
    fail(`Path "${op.path}" does not exist`, "PATH_UNRESOLVABLE", op, opIndex)
  }
  if (!Array.isArray(current)) {
    checkSafeKey(key, parts[parts.length - 2], op, opIndex)
  }

  return { root: newRoot, parent: current as JsonObject | JsonArray, key }
}

function getAtPath(root: JsonValue, parts: string[]): { exists: boolean; value: JsonValue | undefined } {
  let current: JsonValue | undefined = root
  for (const part of parts) {
    if (typeof current !== "object" || current === null) {
      return { exists: false, value: undefined }
    }
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_RE.test(part)) return { exists: false, value: undefined }
      const index = Number.parseInt(part, 10)
      if (index >= current.length) return { exists: false, value: undefined }
      current = current[index]
    } else {
      const obj: JsonObject = current
      if (!Object.hasOwn(obj, part)) return { exists: false, value: undefined }
      current = obj[part]
    }
  }
  return { exists: true, value: current }
}

function deepCloneValue(value: JsonValue): JsonValue {
  if (typeof value !== "object" || value === null) return value
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function applyOperation(
  root: JsonValue,
  op: Operation,
  opIndex: number,
  cloned: WeakSet<object>,
  options: ApplyPatchOptions,
): JsonValue {
  const parts = splitPath(op.path)

  switch (op.op) {
    case "add": {
      if (!("value" in op)) fail(`"add" operation is missing "value"`, "INVALID_OPERATION", op, opIndex)
      const value = options.cloneValues ? deepCloneValue(op.value as JsonValue) : (op.value as JsonValue)
      if (parts.length === 0) return value

      const { root: newRoot, parent, key } = resolveParent(root, parts, cloned, op, opIndex)
      if (Array.isArray(parent)) {
        const index = parseArrayIndex(key, parent.length, true, op, opIndex)
        parent.splice(index, 0, value)
      } else {
        parent[key] = value
      }
      return newRoot
    }

    case "remove": {
      if (parts.length === 0) fail(`Cannot "remove" the document root`, "INVALID_OPERATION", op, opIndex)

      const { root: newRoot, parent, key } = resolveParent(root, parts, cloned, op, opIndex)
      if (Array.isArray(parent)) {
        const index = parseArrayIndex(key, parent.length, false, op, opIndex)
        if (options.validateOldValues && "oldValue" in op && !deepEqual(parent[index], op.oldValue)) {
          fail(`"oldValue" mismatch at "${op.path}"`, "OLD_VALUE_MISMATCH", op, opIndex)
        }
        parent.splice(index, 1)
      } else {
        if (!Object.hasOwn(parent, key)) {
          fail(`Cannot remove nonexistent path "${op.path}"`, "PATH_UNRESOLVABLE", op, opIndex)
        }
        if (options.validateOldValues && "oldValue" in op && !deepEqual(parent[key], op.oldValue)) {
          fail(`"oldValue" mismatch at "${op.path}"`, "OLD_VALUE_MISMATCH", op, opIndex)
        }
        delete parent[key]
      }
      return newRoot
    }

    case "replace": {
      if (!("value" in op)) fail(`"replace" operation is missing "value"`, "INVALID_OPERATION", op, opIndex)
      const value = options.cloneValues ? deepCloneValue(op.value as JsonValue) : (op.value as JsonValue)
      if (parts.length === 0) return value

      const { root: newRoot, parent, key } = resolveParent(root, parts, cloned, op, opIndex)
      if (Array.isArray(parent)) {
        const index = parseArrayIndex(key, parent.length, false, op, opIndex)
        if (options.validateOldValues && "oldValue" in op && !deepEqual(parent[index], op.oldValue)) {
          fail(`"oldValue" mismatch at "${op.path}"`, "OLD_VALUE_MISMATCH", op, opIndex)
        }
        parent[index] = value
      } else {
        if (!Object.hasOwn(parent, key)) {
          fail(`Cannot replace nonexistent path "${op.path}"`, "PATH_UNRESOLVABLE", op, opIndex)
        }
        if (options.validateOldValues && "oldValue" in op && !deepEqual(parent[key], op.oldValue)) {
          fail(`"oldValue" mismatch at "${op.path}"`, "OLD_VALUE_MISMATCH", op, opIndex)
        }
        parent[key] = value
      }
      return newRoot
    }

    case "move": {
      if (op.from === undefined) fail(`"move" operation is missing "from"`, "INVALID_OPERATION", op, opIndex)
      const fromParts = splitPath(op.from)
      if (fromParts.length < parts.length && fromParts.every((part, i) => part === parts[i])) {
        fail(`"move" cannot move "${op.from}" into its own child "${op.path}"`, "INVALID_OPERATION", op, opIndex)
      }
      const { exists, value } = getAtPath(root, fromParts)
      if (!exists) fail(`"move" source "${op.from}" does not exist`, "PATH_UNRESOLVABLE", op, opIndex)

      const afterRemove = applyOperation(root, { op: "remove", path: op.from }, opIndex, cloned, options)
      return applyOperation(afterRemove, { op: "add", path: op.path, value }, opIndex, cloned, options)
    }

    case "copy": {
      if (op.from === undefined) fail(`"copy" operation is missing "from"`, "INVALID_OPERATION", op, opIndex)
      const { exists, value } = getAtPath(root, splitPath(op.from))
      if (!exists) fail(`"copy" source "${op.from}" does not exist`, "PATH_UNRESOLVABLE", op, opIndex)
      // Deep-copy so the result never aliases another location in the document.
      const copied = deepCloneValue(value as JsonValue)
      return applyOperation(root, { op: "add", path: op.path, value: copied }, opIndex, cloned, options)
    }

    case "test": {
      const { exists, value } = getAtPath(root, parts)
      if (!exists) fail(`"test" path "${op.path}" does not exist`, "PATH_UNRESOLVABLE", op, opIndex)
      if (!deepEqual(value, op.value)) {
        fail(`"test" failed at "${op.path}"`, "TEST_FAILED", op, opIndex)
      }
      return root
    }

    default:
      fail(`Unknown operation "${(op as Operation).op}"`, "INVALID_OPERATION", op, opIndex)
  }
}

/**
 * Applies an RFC 6902 JSON Patch to a document and returns the resulting
 * document. Supports all six RFC operations (add, remove, replace, move,
 * copy, test) plus this library's extensions: `oldValue` on remove/replace
 * (optionally validated via `validateOldValues`) and `-` array-append paths.
 *
 * The input document is never mutated. Untouched subtrees are shared by
 * reference between input and output (copy-on-write), so applying a small
 * patch to a large document is cheap. Application is atomic: if any
 * operation fails, a `JsonPatchError` (with a machine-readable `code`, the
 * failing `operation`, and its `operationIndex`) is thrown and the input
 * document is left untouched.
 *
 * Operations are applied strictly sequentially and are never reordered,
 * batched, or deduplicated — patches generated by `JsonSchemaPatcher` are
 * only correct in their emitted order.
 *
 * Unless `cloneValues` is set, values from the patch are inserted into the
 * result by reference; do not mutate patch operations after applying them.
 */
export function applyPatch(
  document: JsonValue,
  patches: readonly Operation[],
  options: ApplyPatchOptions = {},
): JsonValue {
  let root = document
  // Containers cloned during this call; safe to mutate in later operations.
  const cloned = new WeakSet<object>()
  for (let i = 0; i < patches.length; i++) {
    root = applyOperation(root, patches[i] as Operation, i, cloned, options)
  }
  return options.cloneResult ? deepCloneValue(root) : root
}

/**
 * Computes the inverse of a patch relative to the document it was generated
 * from: `applyPatch(applyPatch(doc, patches), invertPatch(doc, patches))`
 * deep-equals `doc`.
 *
 * `document` must be the ORIGINAL (pre-patch) document. It is required so
 * that `-` append paths can be resolved to concrete indices, so removed/
 * replaced values can be recovered even when `oldValue` is absent, and so
 * overwriting operations (`add` on an existing member, `move`/`copy` onto an
 * existing member) can restore the overwritten value.
 */
export function invertPatch(document: JsonValue, patches: readonly Operation[]): Operation[] {
  const inverse: Operation[] = []
  let root = document
  const cloned = new WeakSet<object>()

  /**
   * Inverse of inserting/overwriting at `path`: if the destination already
   * held a value (root, or an existing object member), the forward op
   * REPLACED it, so the inverse must restore it; array insertions and new
   * object members invert to a remove.
   */
  const invertInsertion = (path: string, parts: string[], op: Operation, i: number): Operation => {
    if (parts.length === 0) {
      // add/replace at root replaces the whole document.
      return { op: "replace", path: "", value: root, oldValue: op.value }
    }
    const lastPart = parts[parts.length - 1] as string
    const { value: parentValue } = getAtPath(root, parts.slice(0, -1))

    if (Array.isArray(parentValue)) {
      if (lastPart === "-") {
        return { op: "remove", path: `${path.slice(0, -1)}${parentValue.length}`, oldValue: op.value }
      }
      // Array "add" inserts (never overwrites): inverse is a remove.
      return { op: "remove", path, oldValue: op.value }
    }

    const { exists, value } = getAtPath(root, parts)
    if (exists) {
      // "add" on an existing object member overwrites it (RFC 6902 §4.1).
      return { op: "replace", path, value, oldValue: op.value }
    }
    return { op: "remove", path, oldValue: op.value }
  }

  for (let i = 0; i < patches.length; i++) {
    const op = patches[i] as Operation
    const parts = splitPath(op.path)

    switch (op.op) {
      case "add": {
        inverse.push(invertInsertion(op.path, parts, op, i))
        break
      }
      case "remove": {
        const { exists, value } = getAtPath(root, parts)
        if (!exists) {
          fail(`Cannot invert "remove" of nonexistent path "${op.path}"`, "PATH_UNRESOLVABLE", op, i)
        }
        inverse.push({ op: "add", path: op.path, value })
        break
      }
      case "replace": {
        const { exists, value } = getAtPath(root, parts)
        if (!exists) {
          fail(`Cannot invert "replace" of nonexistent path "${op.path}"`, "PATH_UNRESOLVABLE", op, i)
        }
        inverse.push({ op: "replace", path: op.path, value, oldValue: op.value })
        break
      }
      case "move": {
        if (op.from === undefined) fail(`"move" operation is missing "from"`, "INVALID_OPERATION", op, i)
        if (parts.length === 0) {
          // Moving to the root replaces the whole document; restore it.
          inverse.push({ op: "replace", path: "", value: root })
          break
        }
        const destination = getAtPath(root, parts)
        const destinationOverwritten =
          destination.exists &&
          parts.length > 0 &&
          !Array.isArray(getAtPath(root, parts.slice(0, -1)).value)
        // Move back first; if the forward move overwrote an existing object
        // member, restore it afterwards (inverse list is reversed later, so
        // push the restore BEFORE the move-back).
        if (destinationOverwritten) {
          inverse.push({ op: "add", path: op.path, value: destination.value })
        }
        inverse.push({ op: "move", path: op.from, from: op.path })
        break
      }
      case "copy": {
        inverse.push(invertInsertion(op.path, parts, { ...op, value: undefined }, i))
        break
      }
      case "test": {
        inverse.push(op)
        break
      }
      default:
        fail(`Unknown operation "${(op as Operation).op}"`, "INVALID_OPERATION", op, i)
    }

    // Advance the simulated document so later ops see post-op state.
    root = applyOperation(root, op, i, cloned, {})
  }

  inverse.reverse()
  return inverse
}

/**
 * Strips this library's non-RFC 6902 fields (`oldValue`) from a patch so it
 * can be consumed by strict third-party appliers and validators.
 */
export function toRfc6902(patches: readonly Operation[]): Operation[] {
  return patches.map((op) => {
    if ("oldValue" in op) {
      const { oldValue: _oldValue, ...rest } = op
      return rest as Operation
    }
    return op
  })
}
