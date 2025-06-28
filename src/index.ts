import type { ArrayPlan, Plan } from "./core/buildPlan";
import {
  diffArrayByPrimaryKey,
  diffArrayByPrimaryKeyWithMoves,
  diffArrayLCS,
  diffArrayUnique,
} from "./core/arrayDiffAlgorithms";
import { normalizePath, getWildcardPath } from "./utils/pathUtils";
import { deepEqualMemo } from "./performance/deepEqual";
import type { JsonArray, JsonObject, JsonValue, Operation } from "./types";

export { buildPlan } from "./core/buildPlan";
export { deepEqual } from "./performance/deepEqual";

export class SchemaPatcher {
  private plan: Plan;
  // Path lookup optimizations
  private planLookupCache = new Map<string, ArrayPlan | undefined>();
  private wildcardPathCache = new Map<string, string | null>();

  constructor(options: { plan: Plan }) {
    this.plan = options.plan;
  }

  private getWildcardPathCached(path: string): string | null {
    if (this.wildcardPathCache.has(path)) {
      return this.wildcardPathCache.get(path) as string | null;
    }

    const wildcardPath = getWildcardPath(path);
    this.wildcardPathCache.set(path, wildcardPath);
    return wildcardPath;
  }

  createPatch(doc1: JsonValue, doc2: JsonValue): Operation[] {
    const patches: Operation[] = [];
    this.diff(doc1, doc2, "", patches);
    return patches;
  }

  private diff(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string,
    patches: Operation[]
  ) {
    if (obj1 === obj2) return;

    if (obj1 === undefined) {
      patches.push({ op: "add", path, value: obj2 });
      return;
    }

    if (obj2 === undefined) {
      patches.push({ op: "remove", path, oldValue: obj1 });
      return;
    }

    if (
      typeof obj1 !== "object" ||
      obj1 === null ||
      typeof obj2 !== "object" ||
      obj2 === null ||
      Array.isArray(obj1) !== Array.isArray(obj2)
    ) {
      patches.push({ op: "replace", path, value: obj2, oldValue: obj1 });
      return;
    }

    if (Array.isArray(obj1)) {
      this.diffArray(obj1, obj2 as JsonArray, path, patches);
      return;
    }

    this.diffObject(obj1, obj2 as JsonObject, path, patches);
  }

  private diffObject(
    obj1: JsonObject,
    obj2: JsonObject,
    path: string,
    patches: Operation[]
  ) {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    const allKeys = new Set([...keys1, ...keys2]);

    for (const key of allKeys) {
      const newPath = `${path}/${key}`;
      const val1 = obj1[key];
      const val2 = obj2[key];

      if (val1 === undefined && val2 !== undefined) {
        patches.push({ op: "add", path: newPath, value: val2 });
      } else if (val2 === undefined && val1 !== undefined) {
        patches.push({ op: "remove", path: newPath, oldValue: val1 });
      } else {
        this.diff(val1, val2, newPath, patches);
      }
    }
  }

  private diffArray(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[]
  ) {
    const plan = this.getPlanForPath(path);
    const strategy = plan?.strategy || "lcs";

    if (strategy === "primaryKey" && plan?.primaryKey) {
      diffArrayByPrimaryKeyWithMoves(
        arr1,
        arr2,
        plan.primaryKey,
        path,
        patches,
        this.diff.bind(this),
        plan.hashFields
      );
      return;
    }

    if (strategy === "unique") {
      diffArrayUnique(arr1, arr2, path, patches);
      return;
    }

    diffArrayLCS(
      arr1,
      arr2,
      path,
      patches,
      this.#refine.bind(this),
      this.getPlanForPath(path)?.hashFields
    );
  }

  private getPlanForPath(path: string): ArrayPlan | undefined {
    // Check cache first
    if (this.planLookupCache.has(path)) {
      return this.planLookupCache.get(path);
    }

    let plan: ArrayPlan | undefined;

    // Try exact match first
    plan = this.plan.get(path);
    if (plan) {
      this.planLookupCache.set(path, plan);
      return plan;
    }

    // Try normalized path (remove array indices)
    const normalizedPath = normalizePath(path);
    plan = this.plan.get(normalizedPath);
    if (plan) {
      this.planLookupCache.set(path, plan);
      return plan;
    }

    // Try parent wildcard path
    const wildcardPath = this.getWildcardPathCached(path);
    if (wildcardPath) {
      plan = this.plan.get(wildcardPath);
    }

    // Cache the result (even if undefined)
    this.planLookupCache.set(path, plan);
    return plan;
  }

  #refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: Operation[],
    hashFields: string[] = []
  ) {
    if (!deepEqualMemo(oldVal, newVal, hashFields)) {
      this.diff(oldVal, newVal, path, patches);
    }
  }
}
