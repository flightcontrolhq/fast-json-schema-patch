import { describe, test, expect } from "bun:test";
import { deepEqual, deepEqualMemo } from "../src/performance/deepEqual";
import { buildPlan, JsonSchemaPatcher } from "../src/index";

// F16: Non-JSON inputs are documented as out of scope (SPEC §2.1.2), but a
// cheap guard prevents the worst silent-data-loss failure mode: two
// different `Date`s (or other class instances) both have zero *own*
// enumerable keys, so the plain own-key comparison used for objects treated
// them as equal and any diff over a Date-valued field produced an empty
// patch. deepEqual/deepEqualMemo now treat any object whose prototype isn't
// Object.prototype (or null) as an opaque leaf compared via valueOf()/===.

describe("F16 deepEqual treats non-plain objects as opaque leaves", () => {
  test("two different Dates are NOT equal", () => {
    expect(deepEqual(new Date(2020, 0, 1), new Date(2021, 0, 1))).toBe(false);
  });

  test("two equal-valued Dates ARE equal", () => {
    expect(deepEqual(new Date(2020, 0, 1), new Date(2020, 0, 1))).toBe(true);
  });

  test("a Date is not equal to a plain object with the same (lack of) own keys", () => {
    expect(deepEqual(new Date(2020, 0, 1), {})).toBe(false);
    expect(deepEqual({}, new Date(2020, 0, 1))).toBe(false);
  });

  test("two different RegExps are NOT equal, two equal RegExps ARE", () => {
    expect(deepEqual(/a/, /b/)).toBe(false);
    // Same source/flags -> same .toString(), but valueOf() on RegExp returns
    // the RegExp object itself (not a primitive), so distinct instances are
    // intentionally treated as unequal (opaque leaves), matching the
    // documented "out of scope" contract rather than silently matching.
    expect(deepEqual(/a/, /a/)).toBe(false);
  });

  test("deepEqualMemo also distinguishes two different Dates", () => {
    expect(deepEqualMemo(new Date(2020, 0, 1), new Date(2021, 0, 1))).toBe(false);
    expect(deepEqualMemo(new Date(2020, 0, 1), new Date(2020, 0, 1))).toBe(true);
  });

  test("plain objects and arrays are unaffected (structural comparison still applies)", () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([], {})).toBe(false);
  });

  test("end-to-end: JsonSchemaPatcher.execute detects a changed Date-valued field", () => {
    const schema = {
      type: "object",
      properties: {
        updatedAt: { type: "string" },
      },
    } as any;
    const plan = buildPlan({ schema });
    const patcher = new JsonSchemaPatcher({ plan });

    const original = { updatedAt: new Date(2020, 0, 1) } as any;
    const modified = { updatedAt: new Date(2021, 0, 1) } as any;

    const patch = patcher.execute({ original, modified });
    expect(patch.length).toBeGreaterThan(0);
    expect(patch.some((op) => op.path === "/updatedAt")).toBe(true);
  });
});
