import { describe, test, expect } from "bun:test";
import {
  deepEqual,
  deepEqualMemo,
  deepEqualSchemaAware,
} from "../src/performance/deepEqual";
import { applyPatch, buildPlan, JsonSchemaPatcher } from "../src/index";

// D1 (spec-v1-rc external-review defect round): deepEqualMemo had an empty-keys
// fast path (`keysA.length === 0 && keysB.length === 0 -> true`) that ran BEFORE
// any array-vs-object kind check, so deepEqualMemo([], {}) wrongly returned true
// while the base deepEqual correctly returned false. Because diffArrayLCS interns
// window elements through the memoised comparator, {x:[[],{}]} -> {x:[{},[]]}
// then silently emitted ZERO ops. CORE §1.4.1/CORE §1.4.2: [] is never equal to {}.
describe("D1 array-vs-object kind check precedes any empty-keys fast path", () => {
  test("deepEqualMemo([], {}) is false (was the probe's silent true)", () => {
    expect(deepEqualMemo([], {})).toBe(false);
    expect(deepEqualMemo({}, [])).toBe(false);
  });

  test("deepEqualMemo still equates two empty objects and two empty arrays", () => {
    expect(deepEqualMemo({}, {})).toBe(true);
    expect(deepEqualMemo([], [])).toBe(true);
  });

  test("deepEqualSchemaAware never took the empty fast path, but stays correct", () => {
    expect(deepEqualSchemaAware([], {})).toBe(false);
    expect(deepEqualSchemaAware({}, [])).toBe(false);
    expect(deepEqualSchemaAware({}, {})).toBe(true);
    expect(deepEqualSchemaAware([], [])).toBe(true);
  });

  test("end-to-end LCS swap {x:[[],{}]} -> {x:[{},[]]} emits ops, not zero", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map() });
    const patch = patcher.execute({
      original: { x: [[], {}] },
      modified: { x: [{}, []] },
    });
    expect(patch.length).toBeGreaterThan(0);
    // Applying the emitted patch must reconstruct the modified document.
    expect(applyPatch({ x: [[], {}] }, patch)).toEqual({ x: [{}, []] });
  });
});

// F16: Non-JSON inputs are documented as out of scope (CORE §1.1.2), but a
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
