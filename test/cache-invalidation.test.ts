import { describe, test, expect } from "bun:test";
import { buildPlan, JsonSchemaPatcher, StructuredDiff } from "../src/index";
import { applyPatch } from "fast-json-patch";
import type { Operation } from "../src/types";

// F02: module-level identity-keyed memoization caches (eqCache / schemaEqCache
// in deepEqual.ts, jsonStringCache / pathMapCache / formatterCache in cache.ts)
// must be output-neutral (CORE §1.4.4): a cache MUST NOT return a stale verdict
// after an input is mutated in place between diffs. Before the epoch fix, a
// diff -> mutate-in-place -> re-diff loop silently dropped the mutation.

// An object with >3 fields where the mutated field is NOT among the first three
// inferred hash-prefilter fields, so the stale equality cache — not the hash
// prefilter — decides the (wrong) verdict on the second diff.
const schema = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          a: { type: "number" },
          b: { type: "number" },
          c: { type: "number" },
          d: { type: "number" },
        },
        // no required field -> no primaryKey -> lcs strategy WITH a plan,
        // routing element comparisons through deepEqualSchemaAware/schemaEqCache.
      },
    },
  },
} as any;

function apply(original: unknown, patches: Operation[]): unknown {
  return applyPatch(
    structuredClone(original),
    patches as never,
    false,
    false
  ).newDocument;
}

describe("F02 cache invalidation (output-neutral memoization)", () => {
  test("same patcher: mutate nested field in place, re-diff sees the change", () => {
    const plan = buildPlan({ schema });
    const patcher = new JsonSchemaPatcher({ plan });

    const modRow = { a: 1, b: 2, c: 3, d: 4 };
    const original = { rows: [{ a: 1, b: 2, c: 3, d: 4 }] };
    const modified = { rows: [modRow] };

    const first = patcher.execute({ original, modified });
    expect(first).toEqual([]);

    // in-place mutation of a field outside the inferred hash-prefilter set
    modRow.d = 999;

    const second = patcher.execute({ original, modified });
    expect(second.length).toBeGreaterThan(0);
    expect(apply(original, second)).toEqual(modified);
  });

  test("fresh patcher + fresh plan still sees the change (module-global caches)", () => {
    const plan1 = buildPlan({ schema });
    const modRow = { a: 1, b: 2, c: 3, d: 4 };
    const original = { rows: [{ a: 1, b: 2, c: 3, d: 4 }] };
    const modified = { rows: [modRow] };

    const first = new JsonSchemaPatcher({ plan: plan1 }).execute({
      original,
      modified,
    });
    expect(first).toEqual([]);

    modRow.d = 999;

    // brand-new patcher, brand-new plan: caches live at module scope, so this
    // must still recompute rather than reuse the stale identity-keyed verdict.
    const second = new JsonSchemaPatcher({ plan: buildPlan({ schema }) }).execute(
      { original, modified }
    );
    expect(second.length).toBeGreaterThan(0);
    expect(apply(original, second)).toEqual(modified);
  });

  test("mutating back to equal is also honored (no false positive)", () => {
    const plan = buildPlan({ schema });
    const patcher = new JsonSchemaPatcher({ plan });

    const modRow = { a: 1, b: 2, c: 3, d: 999 };
    const original = { rows: [{ a: 1, b: 2, c: 3, d: 4 }] };
    const modified = { rows: [modRow] };

    const first = patcher.execute({ original, modified });
    expect(first.length).toBeGreaterThan(0);

    // mutate back to equal in place
    modRow.d = 4;

    const second = patcher.execute({ original, modified });
    expect(second).toEqual([]);
  });

  test("StructuredDiff formatter path reflects an in-place mutation", () => {
    // primaryKey plan so StructuredDiff does child separation and formats each
    // child via cachedJsonStringify / DiffFormatter path.
    const sdSchema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              a: { type: "number" },
              b: { type: "number" },
              c: { type: "number" },
              d: { type: "number" },
            },
            required: ["id"],
          },
        },
      },
    } as any;

    const plan = buildPlan({ schema: sdSchema });
    const sd = new StructuredDiff({ plan });

    const modUser = { id: "u1", a: 1, b: 2, c: 3, d: 4 };
    const original = { users: [{ id: "u1", a: 1, b: 2, c: 3, d: 4 }] };
    const modified = { users: [modUser] };

    const firstResult = sd.execute({
      original,
      modified,
      pathPrefix: "/users",
    });
    // No change yet: the parent + child diffs carry no patches.
    const firstPatchCount =
      firstResult.parentDiff.patches.length +
      Object.values(firstResult.childDiffs).reduce(
        (n, c) => n + c.patches.length,
        0
      );
    expect(firstPatchCount).toBe(0);

    // Mutate a nested field of the same object identity in place.
    modUser.d = 999;

    const secondResult = sd.execute({
      original,
      modified,
      pathPrefix: "/users",
    });
    const secondPatchCount =
      secondResult.parentDiff.patches.length +
      Object.values(secondResult.childDiffs).reduce(
        (n, c) => n + c.patches.length,
        0
      );
    expect(secondPatchCount).toBeGreaterThan(0);

    // The rendered new-side diff text must contain the mutated value, proving
    // cachedJsonStringify did not return the stale serialization.
    const allNewText = [
      ...secondResult.parentDiff.diffLines,
      ...Object.values(secondResult.childDiffs).flatMap((c) => c.diffLines),
    ]
      .map((l) => l.content)
      .join("\n");
    expect(allNewText).toContain("999");
  });
});
