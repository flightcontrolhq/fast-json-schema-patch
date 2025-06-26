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
import { diffArrayLCS } from "./utils";

export class CoreDiffEngine implements IDiffEngine {
  *diff(
    doc1: ParsedDocument,
    doc2: ParsedDocument,
    plan: Plan,
    partialDiffKeys?: string[]
  ): Iterable<DiffDelta> {
    if (partialDiffKeys && partialDiffKeys.length > 0) {
      for (const key of partialDiffKeys) {
        const subDoc1 = this.getSubDoc(doc1.data, key);
        const subDoc2 = this.getSubDoc(doc2.data, key);
        yield* this.diffValues(subDoc1, subDoc2, plan, key);
      }
    } else {
      yield* this.diffValues(doc1.data, doc2.data, plan, "");
    }
  }

  private getSubDoc(doc: JsonValue, path: string): JsonValue | undefined {
    if (path === "") return doc;
    const segments = path.split("/").slice(1);
    let current: JsonValue | undefined = doc;
    for (const segment of segments) {
      if (typeof current !== "object" || current === null) return undefined;
      current = (current as JsonObject)[segment];
    }
    return current;
  }

  private *diffValues(
    obj1: JsonValue | undefined,
    obj2: JsonValue | undefined,
    plan: Plan,
    path: string
  ): Iterable<DiffDelta> {
    if (obj1 === obj2) return;

    if (obj1 === undefined) {
      yield { op: "add", path, value: obj2, oldValue: undefined };
      return;
    }

    if (obj2 === undefined) {
      yield { op: "remove", path, value: undefined, oldValue: obj1 };
      return;
    }

    if (
      typeof obj1 !== "object" ||
      obj1 === null ||
      typeof obj2 !== "object" ||
      obj2 === null ||
      Array.isArray(obj1) !== Array.isArray(obj2)
    ) {
      yield { op: "replace", path, value: obj2, oldValue: obj1 };
      return;
    }

    if (Array.isArray(obj1)) {
      yield* this.diffArray(obj1, obj2 as JsonArray, plan, path);
    } else {
      yield* this.diffObject(obj1, obj2 as JsonObject, plan, path);
    }
  }

  private *diffObject(
    obj1: JsonObject,
    obj2: JsonObject,
    plan: Plan,
    path: string
  ): Iterable<DiffDelta> {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    const allKeys = new Set([...keys1, ...keys2]);

    for (const key of allKeys) {
      const newPath = `${path}/${key}`;
      const val1 = obj1[key];
      const val2 = obj2[key];
      yield* this.diffValues(val1, val2, plan, newPath);
    }
  }

  private *diffArray(
    arr1: JsonArray,
    arr2: JsonArray,
    plan: Plan,
    path: string
  ): Iterable<DiffDelta> {
    const arrayPlan = this.getPlanForPath(plan, path);
    const getIdentity = arrayPlan?.getIdentity;
    const patches: DiffDelta[] = [];

    const onModification = (
      item1: JsonValue | undefined,
      item2: JsonValue | undefined,
      itemPath: string
    ) => this.diffValues(item1, item2, plan, itemPath);

    diffArrayLCS(arr1, arr2, path, patches, onModification, getIdentity);

    for (const patch of patches) {
      yield patch;
    }
  }

  private getPlanForPath(plan: Plan, path: string): ArrayPlan | undefined {
    let arrayPlan = plan.get(path);
    if (arrayPlan) return arrayPlan;

    const normalizedPath = path.replace(/\/\d+/g, "");
    arrayPlan = plan.get(normalizedPath);
    if (arrayPlan) return arrayPlan;

    const lastSlash = normalizedPath.lastIndexOf("/");
    if (lastSlash >= 0) {
      const parentPath = `${normalizedPath.substring(0, lastSlash)}/*`;
      arrayPlan = plan.get(parentPath);
    }

    return arrayPlan;
  }
}
