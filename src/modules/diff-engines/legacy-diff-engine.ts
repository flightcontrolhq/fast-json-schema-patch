import type {
  IDiffEngine,
  Plan,
  ParsedDocument,
  DiffDelta,
  JsonValue,
  JsonArray,
  JsonObject,
  ArrayPlan,
} from "../../types";
import {
  diffArrayByPrimaryKey,
  diffArrayLCS,
  diffArrayUnique,
} from "./utils/array-diff";
import { deepEqualMemo } from "../../utils/deep-equal";
import type { PerformanceTracker } from "../../utils/performance-tracker";

export class LegacyDiffEngine implements IDiffEngine {
  diff(
    doc1: ParsedDocument,
    doc2: ParsedDocument,
    plan: Plan,
    partialDiffKeys?: string[],
    performance?: PerformanceTracker | null,
    eqCache?: WeakMap<object, WeakMap<object, boolean>>
  ): DiffDelta[] {
    const patches: DiffDelta[] = [];
    this.diffValues(
      doc1.data,
      doc2.data,
      "",
      patches,
      plan,
      eqCache ?? new WeakMap()
    );
    return patches;
  }

  private diffValues(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    path: string,
    patches: DiffDelta[],
    plan: Plan,
    eqCache: WeakMap<object, WeakMap<object, boolean>>
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
      this.diffArray(
        obj1,
        obj2 as JsonArray,
        path,
        patches,
        plan,
        eqCache
      );
      return;
    }

    this.diffObject(
      obj1,
      obj2 as JsonObject,
      path,
      patches,
      plan,
      eqCache
    );
  }

  private diffObject(
    obj1: JsonObject,
    obj2: JsonObject,
    path: string,
    patches: DiffDelta[],
    plan: Plan,
    eqCache: WeakMap<object, WeakMap<object, boolean>>
  ) {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    const allKeys = new Set([...keys1, ...keys2]);

    for (const key of allKeys) {
      const newPath = `${path}/${key}`;
      const val1 = obj1[key];
      const val2 = obj2[key];

      if (!Object.hasOwn(obj2, key)) {
        patches.push({ op: "remove", path: newPath, oldValue: val1 });
      } else if (!Object.hasOwn(obj1, key)) {
        patches.push({ op: "add", path: newPath, value: val2 });
      } else {
        this.diffValues(val1, val2, newPath, patches, plan, eqCache);
      }
    }
  }

  private diffArray(
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: DiffDelta[],
    plan: Plan,
    eqCache: WeakMap<object, WeakMap<object, boolean>>
  ) {
    const arrayPlan = this.getPlanForPath(path, plan);
    const strategy = arrayPlan?.strategy || "lcs";

    if (strategy === "primaryKey" && arrayPlan?.primaryKey) {
      diffArrayByPrimaryKey(
        arr1,
        arr2,
        arrayPlan.primaryKey,
        path,
        patches,
        (item1, item2, itemPath) =>
          this.diffValues(item1, item2, itemPath, patches, plan, eqCache),
        arrayPlan.hashFields,
        null, // No performance tracker for this legacy path
        eqCache
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
      (item1, item2, itemPath) =>
        this.refine(
          item1,
          item2,
          itemPath,
          patches,
          plan,
          eqCache,
          arrayPlan?.hashFields ?? []
        ),
      arrayPlan?.getIdentity,
      arrayPlan?.hashFields,
      null, // No performance tracker for this legacy path
      eqCache
    );
  }

  private getPlanForPath(path: string, plan: Plan): ArrayPlan | undefined {
    let arrayPlan = plan.get(path);
    if (arrayPlan) {
      return arrayPlan;
    }

    const normalizedPath = path.replace(/\/\d+/g, "");
    arrayPlan = plan.get(normalizedPath);
    if (arrayPlan) {
      return arrayPlan;
    }

    const lastSlash = normalizedPath.lastIndexOf("/");
    if (lastSlash >= 0) {
      const parentPath = `${normalizedPath.substring(0, lastSlash)}/*`;
      arrayPlan = plan.get(parentPath);
    }

    return arrayPlan;
  }

  private refine(
    oldVal: JsonValue,
    newVal: JsonValue,
    path: string,
    patches: DiffDelta[],
    plan: Plan,
    eqCache: WeakMap<object, WeakMap<object, boolean>>,
    hashFields: string[] = []
  ) {
    if (!deepEqualMemo(oldVal, newVal, hashFields, eqCache)) {
      this.diffValues(oldVal, newVal, path, patches, plan, eqCache);
    }
  }
}

