import { type JsonObject, type JsonValue } from "../types";

export function deepEqual(obj1: unknown, obj2: unknown): boolean {
  if (obj1 === obj2) return true;

  if (obj1 && obj2 && typeof obj1 === "object" && typeof obj2 === "object") {
    const arrA = Array.isArray(obj1);
    const arrB = Array.isArray(obj2);
    let i: number;
    let length: number;
    let key: string;

    if (arrA && arrB) {
      const arr1 = obj1 as unknown[];
      const arr2 = obj2 as unknown[];
      length = arr1.length;
      if (length !== arr2.length) return false;
      for (i = length; i-- !== 0; )
        if (!deepEqual(arr1[i], arr2[i])) return false;
      return true;
    }

    if (arrA !== arrB) return false;

    const keys = Object.keys(obj1);
    length = keys.length;

    if (length !== Object.keys(obj2).length) return false;

    for (i = length; i-- !== 0; ) {
      const currentKey = keys[i];
      if (currentKey !== undefined && !Object.hasOwn(obj2, currentKey))
        return false;
    }

    for (i = length; i-- !== 0; ) {
      key = keys[i] as string;
      if (
        !deepEqual(
          (obj1 as JsonObject)[key] as JsonValue,
          (obj2 as JsonObject)[key] as JsonValue
        )
      )
        return false;
    }

    return true;
  }

  // Handle NaN case
  return Number.isNaN(obj1) && Number.isNaN(obj2);
}

export function deepEqualMemo(
  obj1: unknown,
  obj2: unknown,
  hotFields: string[] = [],
  eqCache?: WeakMap<object, WeakMap<object, boolean>> | null
): boolean {
 return deepEqual(obj1, obj2);
} 