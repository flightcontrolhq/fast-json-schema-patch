/**
 * test/ignore-paths.test.ts — the `ignorePaths` capability (GEN §10, CONF §5.6).
 *
 * Covers the construction-time validation errors (GEN §10.1/GEN §10.7 — not
 * expressible as diff/apply vectors, CONF §6.2) plus the happy-path and
 * interaction semantics in both directions.
 */
import { describe, expect, test } from "bun:test";
import { buildPlan, JsonSchemaPatcher } from "../src/index";
import type { JsonValue, Operation } from "../src/types";

const EMPTY = () => new Map();

function diff(
  opts: {
    plan?: Map<string, never>;
    ignorePaths?: string[];
    emitMoves?: boolean;
    wholesaleReplaceFallback?: boolean;
    includeOldValue?: boolean;
    // biome-ignore lint: test convenience
    planObj?: any;
  },
  original: JsonValue,
  modified: JsonValue,
): Operation[] {
  const plan = opts.planObj
    ? buildPlan({ schema: opts.planObj })
    : (opts.plan ?? EMPTY());
  const p = new JsonSchemaPatcher({
    plan,
    ignorePaths: opts.ignorePaths,
    emitMoves: opts.emitMoves,
    wholesaleReplaceFallback: opts.wholesaleReplaceFallback,
    includeOldValue: opts.includeOldValue,
  });
  return p.execute({ original, modified });
}

const PK_USERS = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, updatedAt: { type: "number" }, name: { type: "string" } },
        required: ["id"],
      },
    },
  },
};

describe("ignorePaths validation (GEN §10.1)", () => {
  test("rejects a canonical array-index segment", () => {
    expect(() => new JsonSchemaPatcher({ plan: EMPTY(), ignorePaths: ["/users/0/id"] })).toThrow(
      TypeError,
    );
  });
  test("rejects the '-' segment", () => {
    expect(() => new JsonSchemaPatcher({ plan: EMPTY(), ignorePaths: ["/a/-"] })).toThrow(TypeError);
  });
  test("rejects the empty/root pointer", () => {
    expect(() => new JsonSchemaPatcher({ plan: EMPTY(), ignorePaths: [""] })).toThrow(TypeError);
  });
  test("rejects a pointer without a leading slash", () => {
    expect(() => new JsonSchemaPatcher({ plan: EMPTY(), ignorePaths: ["a/b"] })).toThrow(TypeError);
  });
  test("accepts a non-canonical numeric-looking segment (leading zero, object member)", () => {
    // "01" is a legal member name, not an array index (§F33).
    expect(() => new JsonSchemaPatcher({ plan: EMPTY(), ignorePaths: ["/x/01"] })).not.toThrow();
  });
  test("accepts '*' wildcard and normal members", () => {
    expect(
      () => new JsonSchemaPatcher({ plan: EMPTY(), ignorePaths: ["/users/*/updatedAt", "/meta/ts"] }),
    ).not.toThrow();
  });
  test("accepts an escaped member name containing a slash", () => {
    expect(() => new JsonSchemaPatcher({ plan: EMPTY(), ignorePaths: ["/a~1b/c"] })).not.toThrow();
  });
});

describe("ignorePaths primaryKey guard (GEN §10.7)", () => {
  test("rejects ignoring the primaryKey field itself", () => {
    const plan = buildPlan({ schema: PK_USERS });
    expect(() => new JsonSchemaPatcher({ plan, ignorePaths: ["/users/*/id"] })).toThrow(TypeError);
  });
  test("rejects ignoring the whole keyed item (covers the key)", () => {
    const plan = buildPlan({ schema: PK_USERS });
    expect(() => new JsonSchemaPatcher({ plan, ignorePaths: ["/users/*"] })).toThrow(TypeError);
  });
  test("rejects ignoring the whole keyed array (covers the key)", () => {
    const plan = buildPlan({ schema: PK_USERS });
    expect(() => new JsonSchemaPatcher({ plan, ignorePaths: ["/users"] })).toThrow(TypeError);
  });
  test("allows ignoring a NON-key field of a keyed item", () => {
    const plan = buildPlan({ schema: PK_USERS });
    expect(() => new JsonSchemaPatcher({ plan, ignorePaths: ["/users/*/updatedAt"] })).not.toThrow();
  });
  test("catches a primaryKey under an additionalProperties (*) plan path", () => {
    const schema = {
      type: "object",
      additionalProperties: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    };
    const plan = buildPlan({ schema }); // plan key "/*"
    // ignore "/envA/*/id" covers the key field of /envA (matched via /* at diff time)
    expect(() => new JsonSchemaPatcher({ plan, ignorePaths: ["/envA/*/id"] })).toThrow(TypeError);
  });
});

describe("ignorePaths happy paths", () => {
  test("object member: ignored-only change -> []", () => {
    expect(diff({ ignorePaths: ["/meta/ts"] }, { meta: { ts: 1, n: "a" } }, { meta: { ts: 2, n: "a" } })).toEqual(
      [],
    );
  });
  test("object member: real change survives, ignored suppressed", () => {
    expect(
      diff({ ignorePaths: ["/meta/ts"] }, { meta: { ts: 1, n: "a" } }, { meta: { ts: 2, n: "b" } }),
    ).toEqual([{ op: "replace", path: "/meta/n", value: "b", oldValue: "a" }]);
  });
  test("wildcard: ignore any member at a level", () => {
    expect(diff({ ignorePaths: ["/*/ts"] }, { a: { ts: 1 }, b: { ts: 1, k: 2 } }, { a: { ts: 9 }, b: { ts: 9, k: 3 } })).toEqual(
      [{ op: "replace", path: "/b/k", value: 3, oldValue: 2 }],
    );
  });
  test("modified-only ignored member is not added", () => {
    expect(diff({ ignorePaths: ["/meta/ts"] }, { meta: {} }, { meta: { ts: 5 } })).toEqual([]);
  });
  test("whole array ignored via `/arr` -> []", () => {
    expect(diff({ ignorePaths: ["/arr"] }, { arr: [1, 2, 3] }, { arr: [4, 5] })).toEqual([]);
  });
  test("every element ignored via `/arr/*` -> []", () => {
    expect(diff({ ignorePaths: ["/arr/*"] }, { arr: [{ a: 1 }] }, { arr: [{ a: 2 }, { b: 3 }] })).toEqual([]);
  });
});

describe("ignorePaths under keyed arrays (GEN §10.3)", () => {
  test("primaryKey: ignored-field-only change -> []", () => {
    const ops = diff(
      { planObj: PK_USERS, ignorePaths: ["/users/*/updatedAt"] },
      { users: [{ id: "a", updatedAt: 1 }, { id: "b", updatedAt: 1 }] },
      { users: [{ id: "a", updatedAt: 2 }, { id: "b", updatedAt: 1 }] },
    );
    expect(ops).toEqual([]);
  });
  test("primaryKey: real field change survives while ignored drifts", () => {
    const ops = diff(
      { planObj: PK_USERS, ignorePaths: ["/users/*/updatedAt"] },
      { users: [{ id: "a", updatedAt: 1, name: "A" }] },
      { users: [{ id: "a", updatedAt: 2, name: "A2" }] },
    );
    expect(ops).toEqual([{ op: "replace", path: "/users/0/name", value: "A2", oldValue: "A" }]);
  });
});

describe("ignorePaths under LCS (GEN §10.5)", () => {
  test("ignored-field-only change -> []", () => {
    expect(
      diff({ ignorePaths: ["/items/*/ts"] }, { items: [{ v: 1, ts: 1 }, { v: 2, ts: 1 }] }, { items: [{ v: 1, ts: 9 }, { v: 2, ts: 1 }] }),
    ).toEqual([]);
  });
  test("move-pairing with ignored drift (emitMoves): a relocation, not remove+add", () => {
    const ops = diff(
      { emitMoves: true, ignorePaths: ["/items/*/ts"] },
      { items: [{ v: "X", ts: 1 }, { v: "Y", ts: 1 }] },
      { items: [{ v: "Y", ts: 9 }, { v: "X", ts: 1 }] },
    );
    // Y (ts drift) and X reorder -> exactly one move; NO replace for the ts drift.
    expect(ops.filter((o) => o.op === "replace")).toEqual([]);
    expect(ops.filter((o) => o.op === "move").length).toBe(1);
  });
});

describe("ignorePaths x wholesaleReplaceFallback (GEN §10.6)", () => {
  const RW = {
    type: "object",
    properties: {
      a: { type: "array", items: { type: "object", properties: { t: { type: "string" }, ts: { type: "number" } } } },
    },
  };
  test("wholesale disabled when an ignore path lies beneath the array", () => {
    const ops = diff(
      { planObj: RW, wholesaleReplaceFallback: true, ignorePaths: ["/a/*/ts"] },
      { a: [{ t: "AAAAAAAAAA", ts: 1 }, { t: "BBBBBBBBBB", ts: 2 }] },
      { a: [{ t: "ZZZZZZZZZZ", ts: 5 }, { t: "YYYYYYYYYY", ts: 6 }] },
    );
    // A whole-array replace at /a would carry the ignored `ts` values and leak
    // them; the capability is disabled, so we get a granular (ignore-filtered)
    // stream instead — no single replace whose path is exactly "/a".
    expect(ops.some((o) => o.op === "replace" && o.path === "/a")).toBe(false);
    // And no emitted op mentions ts (all touched fields are /t or whole items).
    const changed = ops.filter((o) => o.op === "replace");
    for (const o of changed) expect(o.path.endsWith("/ts")).toBe(false);
  });
});

describe("ignorePaths byte-stability (GEN §10.2)", () => {
  test("absent ignorePaths is byte-identical to the pre-capability output", () => {
    const orig = { meta: { ts: 1, n: "a" }, arr: [{ id: "x", v: 1 }] };
    const mod = { meta: { ts: 2, n: "b" }, arr: [{ id: "x", v: 2 }] };
    const base = diff({}, orig, mod);
    const withEmptyList = diff({ ignorePaths: [] }, orig, mod);
    expect(withEmptyList).toEqual(base);
  });
});
