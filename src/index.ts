import {diffArrayByPrimaryKey, diffArrayLCS, diffArrayUnique, type ModificationCallback} from "./core/arrayDiffAlgorithms"
import type {ArrayPlan, Plan} from "./core/buildPlan"
import {deepEqualMemo} from "./performance/deepEqual"
import type {JsonArray, JsonObject, JsonValue, Operation} from "./types"
import {getWildcardPath, normalizePath} from "./utils/pathUtils"

export {buildPlan} from "./core/buildPlan"
export {StructuredDiff} from "./aggregators/StructuredDiff"

export type {
  StructuredDiffConfig,
  StructuredDiffResult,
  FormattedParentDiff,
  FormattedChildDiff,
  StructuredDiffLine,
  Operation,
} from "./types"
export type {
  Plan,
  BuildPlanOptions
} from "./core/buildPlan"

export class JsonSchemaPatcher {
  private plan: Plan
  private planLookupCache = new Map<string, ArrayPlan | undefined>()
  private wildcardPathCache = new Map<string, string | null>()
  private negativePlanCache = new Set<string>()
  private readonly planIsEmpty: boolean
  private simplePathCache = new Set<string>()

  constructor(options: {plan: Plan}) {
    this.plan = options.plan
    this.planIsEmpty = this.plan.size === 0
  }

  private getWildcardPathCached(path: string): string | null {
    if (this.wildcardPathCache.has(path)) {
      return this.wildcardPathCache.get(path) as string | null
    }

    const wildcardPath = getWildcardPath(path)
    this.wildcardPathCache.set(path, wildcardPath)
    return wildcardPath
  }

  execute({original, modified}: {original: JsonValue, modified: JsonValue}): Operation[] {
    const patches: Operation[] = []
    this.diff(original, modified, "", patches)
    return patches
  }

  private diff(
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
      patches.push({op: "remove", path, oldValue: obj1})
      return
    }

    if (
      typeof obj1 !== "object" ||
      obj1 === null ||
      typeof obj2 !== "object" ||
      obj2 === null ||
      Array.isArray(obj1) !== Array.isArray(obj2)
    ) {
      patches.push({op: "replace", path, value: obj2, oldValue: obj1})
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

      if (val1 === undefined && val2 !== undefined) {
        patches.push({op: "add", path: newPath, value: val2})
      } else if (val2 === undefined && val1 !== undefined) {
        patches.push({op: "remove", path: newPath, oldValue: val1})
      } else {
        this.diff(val1, val2, newPath, patches)
      }
    }
  }

  private diffArray(arr1: JsonArray, arr2: JsonArray, path: string, patches: Operation[]) {
    // Fast path for very simple cases - avoid all plan lookups
    if (this.planIsEmpty || this.simplePathCache.has(path)) {
      this.simpleArrayDiff(arr1, arr2, path, patches)
      return
    }

    const plan = this.getPlanForPath(path)
    
    // Cache simple paths for future calls
    if (!plan && arr1.length < 10 && arr2.length < 10) {
      this.simplePathCache.add(path)
      this.simpleArrayDiff(arr1, arr2, path, patches)
      return
    }

    const strategy = plan?.strategy || "lcs"

    const createModificationCallback = (hashFields: string[]): ModificationCallback => {
      return (oldVal: JsonValue, newVal: JsonValue, path: string, patches: Operation[], skipEqualityCheck?: boolean) => {
        this.refine(oldVal, newVal, path, patches, hashFields, skipEqualityCheck || false)
      }
    }

    if (strategy === "primaryKey" && plan?.primaryKey) {
      diffArrayByPrimaryKey(
        arr1,
        arr2,
        plan.primaryKey,
        path,
        patches,
        createModificationCallback(plan.hashFields || []),
        plan.hashFields,
      )
      return
    }

    if (strategy === "unique" && arr1.length === arr2.length && arr1.length <= 10000) {
      const isArr1Unique = new Set(arr1).size === arr1.length
      const isArr2Unique = new Set(arr2).size === arr2.length
      if (isArr1Unique && isArr2Unique) {
        diffArrayUnique(arr1, arr2, path, patches)
        return
      }
    }

    diffArrayLCS(
      arr1,
      arr2,
      path,
      patches,
      createModificationCallback(plan?.hashFields || []),
      plan?.hashFields,
      plan,
    )
  }

  // Fast, simple array diffing for cases without plans
  private simpleArrayDiff(arr1: JsonArray, arr2: JsonArray, path: string, patches: Operation[]) {
    diffArrayLCS(
      arr1,
      arr2,
      path,
      patches,
      (oldVal: JsonValue, newVal: JsonValue, path: string, patches: Operation[], skipEqualityCheck?: boolean) => {
        // Use simple equality check for fast path
        if (skipEqualityCheck || oldVal !== newVal) {
          this.diff(oldVal, newVal, path, patches)
        }
      },
      [],
    )
  }

  private getPlanForPath(path: string): ArrayPlan | undefined {
    if (this.planIsEmpty) return undefined
    
    // Check negative cache first - fastest check
    if (this.negativePlanCache.has(path)) {
      return undefined
    }
    
    // Check positive cache
    if (this.planLookupCache.has(path)) {
      return this.planLookupCache.get(path)
    }

    let plan: ArrayPlan | undefined

    // Try exact match first
    plan = this.plan.get(path)
    if (plan) {
      this.planLookupCache.set(path, plan)
      return plan
    }

    // Lazy path operations - only do expensive operations if exact match fails
    // Try normalized path (remove array indices) - only if path contains digits
    if (path.includes('/') && /\/\d+/.test(path)) {
      const normalizedPath = normalizePath(path)
      if (normalizedPath !== path) {
        plan = this.plan.get(normalizedPath)
        if (plan) {
          this.planLookupCache.set(path, plan)
          return plan
        }
      }
    }

    // Try parent wildcard path - only if no plan found yet and path has parent
    if (path.lastIndexOf('/') > 0) {
      const wildcardPath = this.getWildcardPathCached(path)
      if (wildcardPath) {
        plan = this.plan.get(wildcardPath)
        if (plan) {
          this.planLookupCache.set(path, plan)
          return plan
        }
      }
    }

    // No plan found - cache the negative result
    this.negativePlanCache.add(path)
    return undefined
  }

  private refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: Operation[],
    hashFields: string[] = [],
    skipEqualityCheck: boolean = false,
  ) {
    if (skipEqualityCheck) {
      this.diff(oldVal, newVal, path, patches);
      return;
    }
    
    // Fast reference equality check first
    if (oldVal === newVal) return;
    
    // Check for simple type differences
    if (typeof oldVal !== typeof newVal || 
        oldVal === null || newVal === null ||
        (typeof oldVal !== "object" && oldVal !== newVal)) {
      this.diff(oldVal, newVal, path, patches);
      return;
    }
    
    // Only use expensive deep equality for complex objects
    if (!deepEqualMemo(oldVal, newVal, hashFields)) {
      this.diff(oldVal, newVal, path, patches);
    }
  }
}
