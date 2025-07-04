import type {ArrayPlan} from "../core/buildPlan"
import {deepEqual, deepEqualMemo, deepEqualSchemaAware} from "../performance/deepEqual"
import {getEffectiveHashFields} from "../performance/getEffectiveHashFields"
import type {JsonArray, JsonObject, JsonValue, Operation} from "../types"

export type ModificationCallback = (
  item1: JsonValue,
  item2: JsonValue,
  path: string,
  patches: Operation[],
  skipEqualityCheck?: boolean,
) => void


export function diffArrayByPrimaryKey(
  arr1: JsonArray,
  arr2: JsonArray,
  primaryKey: string,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  hashFields?: string[],
  plan?: ArrayPlan,
) {
  const effectiveHashFields = getEffectiveHashFields(plan, undefined, undefined, hashFields || [])
  const hashFieldsLength = effectiveHashFields.length
  const hasHashFields = hashFieldsLength > 0
  
  // V8 optimization: Pre-size Map with estimated capacity
  const map1 = new Map<string | number, {item: JsonValue; index: number}>()
  const arr1Length = arr1.length
  
  // V8/Safari: Monomorphic loop structure - consistent types and operations
  for (let i = 0; i < arr1Length; i++) {
    const item = arr1[i]
    // V8: Check type first, then null (more efficient branch prediction)
    if (typeof item === "object" && item !== null) {
      // V8: Use 'in' operator for property existence (faster than hasOwnProperty)
      if (primaryKey in item) {
        const key = item[primaryKey as keyof typeof item]
        const keyType = typeof key
        // V8: Combined type check is faster than separate checks
        if (keyType === "string" || keyType === "number") {
          map1.set(key, {item, index: i})
        }
      }
    }
  }

  // Pre-allocate arrays with realistic sizes to avoid resizing
  const modificationPatches: Operation[] = []
  const additionPatches: Operation[] = []
  const removalEntries: Array<{item: JsonValue; index: number}> = []
  
  const arr2Length = arr2.length
  const pathPrefix = path + "/"
  
  // V8/Safari: Monomorphic loop with consistent variable types
  for (let i = 0; i < arr2Length; i++) {
    const newItem = arr2[i]
    
    // V8: Early continue to keep hot path clean
    if (typeof newItem !== "object" || newItem === null || !(primaryKey in newItem)) {
      continue
    }
    
    const key = newItem[primaryKey as keyof typeof newItem]
    const keyType = typeof key
    if (keyType !== "string" && keyType !== "number") {
      continue
    }

    const oldEntry = map1.get(key)
    if (oldEntry !== undefined) {
      // V8: Delete immediately to avoid later iteration
      map1.delete(key)
      
      const oldItem = oldEntry.item
      let needsDiff = false

      // V8: Branch prediction optimization - most common case first
      if (plan) {
        needsDiff = !deepEqualSchemaAware(oldItem, newItem, plan, effectiveHashFields)
      } else if (hasHashFields) {
        // V8: Optimize hot loop with local variables
        const oldItemObj = oldItem as JsonObject
        const newItemObj = newItem as JsonObject
        
        // V8: Use for loop instead of for...of (better optimization)
        for (let j = 0; j < hashFieldsLength; j++) {
          const field = effectiveHashFields[j]
          if (field && oldItemObj[field] !== newItemObj[field]) {
            needsDiff = true
            break
          }
        }
        
        // V8: Only do expensive deep equal if hash fields match
        if (!needsDiff && oldItem !== newItem) {
          needsDiff = !deepEqual(oldItem, newItem)
        }
      } else {
        // V8: Reference equality check first (fastest)
        needsDiff = oldItem !== newItem && !deepEqual(oldItem, newItem)
      }

      if (needsDiff) {
        // V8: String concatenation is optimized, but template literals can be slower
        const itemPath = pathPrefix + oldEntry.index
        onModification(oldItem, newItem, itemPath, modificationPatches, true)
      }
    } else {
      // V8: Reuse string constant for path
      additionPatches.push({op: "add", path: pathPrefix + "-", value: newItem})
    }
  }

  // V8/Safari: Collect remaining entries efficiently
  // Using for...of on Map is well-optimized in modern engines
  for (const entry of map1.values()) {
    removalEntries.push(entry)
  }

  // V8: Sort with inline comparison function (better JIT optimization)
  if (removalEntries.length > 1) {
    removalEntries.sort((a, b) => b.index - a.index)
  }
  
  // V8: Pre-allocate array with known size
  const removalPatches: Operation[] = new Array(removalEntries.length)
  const removalCount = removalEntries.length
  
  // V8: Simple for loop with local variable
  for (let i = 0; i < removalCount; i++) {
    const entry = removalEntries[i] as {item: JsonValue; index: number}
    removalPatches[i] = {
      op: "remove",
      path: pathPrefix + entry.index,
      oldValue: entry.item,
    }
  }

  // V8/Safari: Batch push is more efficient than individual pushes
  const totalPatches = modificationPatches.length + removalPatches.length + additionPatches.length
  if (totalPatches > 0) {
    patches.push(...modificationPatches, ...removalPatches, ...additionPatches)
  }
}

function collapseReplace(
  ops: ("common" | "add" | "remove")[],
): ("common" | "add" | "remove" | "replace")[] {
  const out: ("common" | "add" | "remove" | "replace")[] = []
  for (let i = 0; i < ops.length; i++) {
    if (ops[i] === "remove" && ops[i + 1] === "add") {
      out.push("replace")
      i++ // skip next add
    } else {
      out.push(ops[i] as "common" | "add" | "remove" | "replace")
    }
  }
  return out
}

export function diffArrayLCS(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  onModification: ModificationCallback,
  hashFields?: string[],
  plan?: ArrayPlan,
) {
  const effectiveHashFields = getEffectiveHashFields(plan, undefined, undefined, hashFields || [])

  const n = arr1.length
  const m = arr2.length

  const max = n + m
  const offset = max

  const createBuffer = () => {
    const buf = new Int32Array(2 * max + 1)
    buf.fill(-1) // sentinel for unreachable
    return buf
  }

  let vPrev = createBuffer()
  let vCurr = createBuffer()
  vPrev[offset + 1] = 0 // k=1 diagonal starts at x=0

  const trace: Int32Array[] = []
  let endD = -1

  const equalAt = (x: number, y: number): boolean => {
    if (plan) {
      return deepEqualSchemaAware(arr1[x], arr2[y], plan, effectiveHashFields)
    }
    return deepEqualMemo(arr1[x], arr2[y], effectiveHashFields)
  }

  const get = (buf: Int32Array, idx: number): number => {
    return idx >= 0 && idx < buf.length && buf[idx] !== undefined ? buf[idx] : -1
  }

  const prefixPath = path === "" ? "/" : `${path}/`

  // Forward pass ----------------------------------
  outer: for (let d = 0; d <= max; d++) {
    trace.push(vPrev.slice())

    for (let k = -d; k <= d; k += 2) {
      const kOffset = k + offset

      const down = k === -d || (k !== d && get(vPrev, kOffset - 1) < get(vPrev, kOffset + 1))
      let x = down ? get(vPrev, kOffset + 1) : get(vPrev, kOffset - 1) + 1
      let y = x - k

      // snake
      while (x < n && y < m && equalAt(x, y)) {
        x++
        y++
      }

      vCurr[kOffset] = x

      if (x >= n && y >= m) {
        trace.push(vCurr.slice())
        endD = d
        break outer
      }
    }

    // swap buffers & reset vCurr
    const tmp = vPrev
    vPrev = vCurr
    vCurr = tmp
    vCurr.fill(-1)
  }

  if (endD === -1) return // no diff (shouldn't happen)

  // Back-tracking ----------------------------------
  let x = n
  let y = m
  const rawOps: ("common" | "add" | "remove")[] = []

  for (let d = endD; d > 0; d--) {
    const vRow = trace[d] as Int32Array
    const k = x - y
    const kOffset = k + offset

    const down = k === -d || (k !== d && get(vRow, kOffset - 1) < get(vRow, kOffset + 1))
    const prevK = down ? k + 1 : k - 1
    const prevX = get(vRow, prevK + offset)
    const prevY = prevX - prevK

    while (x > prevX && y > prevY) {
      rawOps.unshift("common")
      x--
      y--
    }

    if (down) {
      rawOps.unshift("add")
      y--
    } else {
      rawOps.unshift("remove")
      x--
    }
  }

  while (x > 0 && y > 0) {
    rawOps.unshift("common")
    x--
    y--
  }

  const ops2 = collapseReplace(rawOps)

  let ai = 0
  let bi = 0
  let patchedIndex = 0
     for (const op of ops2) {
     switch (op) {
       case "common":
         // Items are known to be equal by equalAt(), but may have nested differences
         // Skip top-level equality check since equalAt() already verified they're "equal"
         onModification(arr1[ai] as JsonValue, arr2[bi] as JsonValue, `${prefixPath}${patchedIndex}`, patches, true)
         ai++
         bi++
         patchedIndex++
         break
      case "replace":
        patches.push({op: "replace", path: `${prefixPath}${patchedIndex}`, value: arr2[bi] as JsonValue})
        ai++
        bi++
        patchedIndex++
        break
      case "remove":
        patches.push({op: "remove", path: `${prefixPath}${patchedIndex}`})
        ai++
        break
      case "add":
        patches.push({op: "add", path: `${prefixPath}${patchedIndex}`, value: arr2[bi] as JsonValue})
        bi++
        patchedIndex++
        break
    }
  }
}

export function diffArrayUnique(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
) {
  const n = arr1.length
  const m = arr2.length
  const set1 = new Set(arr1)
  const set2 = new Set(arr2)
  const minLength = Math.min(n, m)
  const replacedAtIndex = new Set<number>()
  const replacedValues2 = new Set<JsonValue>()

  for (let i = 0; i < minLength; i++) {
    const val1 = arr1[i]
    const val2 = arr2[i]
    if (val1 !== val2) {
      patches.push({op: "replace", path: `${path}/${i}`, value: val2})
      replacedAtIndex.add(i)
      if (val2 !== undefined) replacedValues2.add(val2)
    }
  }

  const removalIndices: number[] = []
  for (let i = n - 1; i >= 0; i--) {
    const item = arr1[i]
    if (item !== undefined && !set2.has(item) && !replacedAtIndex.has(i)) {
      removalIndices.push(i)
    }
  }
  for (const index of removalIndices) {
    patches.push({op: "remove", path: `${path}/${index}`})
  }

  for (const item of set2) {
    if (item !== undefined && !set1.has(item) && !replacedValues2.has(item)) {
      patches.push({op: "add", path: `${path}/-`, value: item})
    }
  }
}