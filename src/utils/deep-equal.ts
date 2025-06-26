import type { JsonObject } from '../types';

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
      if (!deepEqual((obj1 as JsonObject)[key], (obj2 as JsonObject)[key]))
        return false;
    }

    return true;
  }

  return obj1 === obj2;
}


const eqCache = new WeakMap<object, WeakMap<object, boolean>>();

function fastHash(obj: JsonObject, fields: string[]): string {
  let hash = "";
  for (const key of fields) {
    hash += `${obj[key]}|`;
  }
  return hash;
}

export function deepEqualMemo(
  obj1: unknown,
  obj2: unknown,
  hotFields: string[] = []
): boolean {
  if (obj1 === obj2) return true;
  if (obj1 == null || obj2 == null) return obj1 === obj2;

  const type1 = typeof obj1;
  const type2 = typeof obj2;
  if (type1 !== type2) return false;
  if (type1 !== "object") {
    return obj1 === obj2;
  }

  const a = obj1 as JsonObject;
  const b = obj2 as JsonObject;

  if (hotFields.length > 0 && !Array.isArray(a) && !Array.isArray(b)) {
    const h1 = fastHash(a, hotFields);
    const h2 = fastHash(b, hotFields);
    if (h1 !== h2) return false;
  }

  let inner = eqCache.get(a);
  if (inner?.has(b)) return inner.get(b) ?? false;

  const result = deepEqual(a, b);

  if (!inner) {
    inner = new WeakMap();
    eqCache.set(a, inner);
  }
  inner.set(b, result);

  return result;
} 