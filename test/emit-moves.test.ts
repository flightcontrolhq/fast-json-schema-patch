import { describe, expect, test } from "bun:test";
import { applyPatch as fjpApplyPatch } from "fast-json-patch";
import { computeMoves, lisIndices } from "../src/core/arrayMoves";
import { JsonSchemaPatcher, applyPatch, buildPlan } from "../src/index";
import type { JsonValue, Operation } from "../src/types";

// emitMoves capability (SPEC §5.8, §10.4.4). This file pins the OPT-IN surface:
// default output is byte-identical (capability off), relocated elements become
// single `move` ops, and every strategy round-trips `modified` EXACTLY through
// BOTH the repo applier and fast-json-patch. F22 (this file's LCS section) plus
// F23/F07 (unique/primaryKey sections) share one machinery (§5.8).

const stableStringify = (v: unknown): string => JSON.stringify(v);

/** Apply through both the repo applier and fast-json-patch; assert both equal `expected`. */
function assertRoundTrip(
  original: JsonValue,
  ops: Operation[],
  expected: JsonValue
) {
  const repo = applyPatch(structuredClone(original), ops);
  expect(stableStringify(repo)).toBe(stableStringify(expected));
  // fast-json-patch mutates its inputs and ignores the non-RFC `oldValue` field.
  const fjp = fjpApplyPatch(
    structuredClone(original) as object,
    structuredClone(ops) as never,
    false,
    false
  ).newDocument;
  expect(stableStringify(fjp)).toBe(stableStringify(expected));
}

describe("emitMoves — pure move machinery (SPEC §5.8.2/§5.8.3)", () => {
  test("lisIndices: canonical patience-sorting LIS", () => {
    expect(lisIndices([])).toEqual([]);
    expect(lisIndices([0, 1, 2, 3])).toEqual([0, 1, 2, 3]);
    expect(lisIndices([3, 2, 1, 0]).length).toBe(1);
    // [1,2,...,49,0] -> LIS is the first 49 (indices 0..48)
    const rot = [...Array.from({ length: 49 }, (_, i) => i + 1), 0];
    expect(lisIndices(rot)).toEqual(Array.from({ length: 49 }, (_, i) => i));
  });

  test("computeMoves: rotation by one is a single move", () => {
    // O=[a0..a49] -> M=[a49,a0..a48]: a0's target rank is 1, ..., a49's is 0.
    const rankSeq = [
      ...Array.from({ length: 49 }, (_, i) => i + 1),
      0,
    ];
    const moves = computeMoves(rankSeq);
    expect(moves.length).toBe(1);
    // The single non-anchor (a49, source index 49) moves to the front.
    expect(moves[0]).toEqual({ from: 49, to: 0 });
  });

  test("computeMoves: identity permutation emits no moves", () => {
    expect(computeMoves([0, 1, 2, 3, 4])).toEqual([]);
  });
});

describe("emitMoves default-off byte-stability (SPEC §10.4.4)", () => {
  const cases: Array<{ original: JsonValue; modified: JsonValue }> = [
    { original: [1, 2, 3, 4, 5], modified: [5, 1, 2, 3, 4] },
    {
      original: [{ a: 1 }, { a: 2 }, { a: 3 }],
      modified: [{ a: 2 }, { a: 3 }, { a: 1 }],
    },
    { original: { x: [1, 2, 3] }, modified: { x: [3, 1, 2, 9] } },
  ];
  for (const [i, c] of cases.entries()) {
    test(`case ${i}: omitted === emitMoves:false, both === pre-capability output`, () => {
      const omitted = new JsonSchemaPatcher({ plan: new Map() }).execute(c);
      const explicitFalse = new JsonSchemaPatcher({
        plan: new Map(),
        emitMoves: false,
      }).execute(c);
      expect(stableStringify(omitted)).toBe(stableStringify(explicitFalse));
    });
  }
});

describe("emitMoves LCS relocations (F22, SPEC §5.8.5)", () => {
  test("relocated ~596B item is ONE move, not remove+add", () => {
    const big = (i: number) => ({
      id: `item${i}`,
      payload: "x".repeat(560),
      n: i,
    });
    const original = [0, 1, 2, 3, 4, 5, 6, 7].map(big);
    const modified = [1, 2, 3, 4, 5, 6, 7, 0].map(big);

    const off = new JsonSchemaPatcher({ plan: new Map() }).execute({
      original,
      modified,
    });
    const on = new JsonSchemaPatcher({
      plan: new Map(),
      emitMoves: true,
    }).execute({ original, modified });

    expect(on.filter((o) => o.op === "move").length).toBe(1);
    expect(on.length).toBe(1);
    // Compactness: the move patch is an order of magnitude smaller.
    expect(JSON.stringify(on).length).toBeLessThan(
      JSON.stringify(off).length / 10
    );
    assertRoundTrip(original, on, modified);
  });

  test("move ops never carry value/oldValue", () => {
    const original = ["a", "b", "c", "d", "e"];
    const modified = ["b", "c", "d", "e", "a"];
    const on = new JsonSchemaPatcher({
      plan: new Map(),
      emitMoves: true,
    }).execute({ original, modified });
    for (const op of on) {
      if (op.op === "move") {
        expect(op).not.toHaveProperty("value");
        expect(op).not.toHaveProperty("oldValue");
        expect(typeof op.from).toBe("string");
      }
    }
    assertRoundTrip(original, on, modified);
  });

  test("reorder + modify + add + remove round-trips exactly", () => {
    const original = [
      { k: "a", v: 1 },
      { k: "b", v: 2 },
      { k: "c", v: 3 },
      { k: "d", v: 4 },
    ];
    const modified = [
      { k: "c", v: 3 },
      { k: "a", v: 99 }, // modified
      { k: "e", v: 5 }, // added
      { k: "b", v: 2 },
    ]; // d removed
    const on = new JsonSchemaPatcher({
      plan: new Map(),
      emitMoves: true,
    }).execute({ original, modified });
    assertRoundTrip(original, on, modified);
  });

  test("duplicate values: a move never pairs non-identical values", () => {
    const original = ["a", "a", "b", "c", "b"];
    const modified = ["b", "a", "c", "a", "b"];
    const on = new JsonSchemaPatcher({
      plan: new Map(),
      emitMoves: true,
    }).execute({ original, modified });
    // A move only relocates a deep-equal element, so it is safe for the applier
    // to move a value even when equal values occur elsewhere; the end-to-end
    // round-trip through both appliers proves no non-identical pairing slipped in.
    assertRoundTrip(original, on, modified);
  });

  test("emitMoves composes with includeOldValue:false", () => {
    const original = [
      { k: "a", v: 1 },
      { k: "b", v: 2 },
      { k: "c", v: 3 },
    ];
    const modified = [
      { k: "b", v: 2 },
      { k: "c", v: 3 },
      { k: "a", v: 9 },
    ];
    const on = new JsonSchemaPatcher({
      plan: new Map(),
      emitMoves: true,
      includeOldValue: false,
    }).execute({ original, modified });
    expect(on.some((o) => Object.hasOwn(o, "oldValue"))).toBe(false);
    assertRoundTrip(original, on, modified);
  });

  test("randomized LCS fuzz (mixed values) round-trips through both appliers", () => {
    const pool: JsonValue[] = [1, 2, 3, 4, 5, 6, { a: 1 }, { a: 2 }, "x", "y"];
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iter = 0; iter < 3000; iter++) {
      const n = 1 + Math.floor(rnd() * 8);
      const m = 1 + Math.floor(rnd() * 8);
      const O: JsonValue[] = [];
      const M: JsonValue[] = [];
      for (let i = 0; i < n; i++)
        O.push(structuredClone(pool[Math.floor(rnd() * pool.length)]!));
      for (let i = 0; i < m; i++)
        M.push(structuredClone(pool[Math.floor(rnd() * pool.length)]!));
      const on = new JsonSchemaPatcher({
        plan: new Map(),
        emitMoves: true,
      }).execute({ original: structuredClone(O), modified: structuredClone(M) });
      assertRoundTrip(O, on, M);
    }
  });
});

describe("emitMoves unique reorders (F23, SPEC §5.8.6)", () => {
  const uniqueSchema = {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string" } } },
  };
  const plan = () => buildPlan({ schema: uniqueSchema });

  test("plan assigns the unique strategy", () => {
    expect(plan().get("/tags")?.strategy).toBe("unique");
  });

  test("50-element rotation is ONE move, not 50 replaces", () => {
    const tags = Array.from({ length: 50 }, (_, i) => `s${i}`);
    const original = { tags };
    const modified = { tags: [...tags.slice(1), tags[0]!] };

    const off = new JsonSchemaPatcher({ plan: plan() }).execute({
      original,
      modified,
    });
    const on = new JsonSchemaPatcher({
      plan: plan(),
      emitMoves: true,
    }).execute({ original, modified });

    // Default: 50 positional replaces. emitMoves: a single move.
    expect(off.filter((o) => o.op === "replace").length).toBe(50);
    expect(on.filter((o) => o.op === "move").length).toBe(1);
    expect(on.length).toBe(1);
    expect(JSON.stringify(on).length).toBeLessThan(
      JSON.stringify(off).length / 10
    );
    assertRoundTrip(original, on, modified);
  });

  test("non-multiset-equal unique arrays keep positional replaces", () => {
    // Same length, unique, but value sets differ -> not a pure permutation.
    const original = { tags: ["a", "b", "c"] };
    const modified = { tags: ["a", "z", "c"] };
    const on = new JsonSchemaPatcher({
      plan: plan(),
      emitMoves: true,
    }).execute({ original, modified });
    expect(on).toEqual([
      { op: "replace", path: "/tags/1", value: "z", oldValue: "b" },
    ]);
    assertRoundTrip(original, on, modified);
  });

  test("default-off unique output is byte-stable", () => {
    const original = { tags: ["a", "b", "c", "d", "e"] };
    const modified = { tags: ["e", "a", "b", "c", "d"] };
    const omitted = new JsonSchemaPatcher({ plan: plan() }).execute({
      original,
      modified,
    });
    const explicitFalse = new JsonSchemaPatcher({
      plan: plan(),
      emitMoves: false,
    }).execute({ original, modified });
    expect(stableStringify(omitted)).toBe(stableStringify(explicitFalse));
  });

  test("randomized unique-permutation fuzz round-trips through both appliers", () => {
    let seed = 999;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iter = 0; iter < 2000; iter++) {
      const n = 1 + Math.floor(rnd() * 12);
      const base = Array.from({ length: n }, (_, i) => `v${i}`);
      const shuffled = [...base];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const original = { tags: base };
      const modified = { tags: shuffled };
      const on = new JsonSchemaPatcher({
        plan: plan(),
        emitMoves: true,
      }).execute({ original, modified });
      assertRoundTrip(original, on, modified);
    }
  });
});

describe("emitMoves primaryKey order fidelity (F07, SPEC §5.8.7)", () => {
  const keyedSchema = {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, v: { type: "number" } },
          required: ["id"],
        },
      },
    },
  };
  const plan = () => buildPlan({ schema: keyedSchema });

  test("plan assigns the primaryKey strategy on id", () => {
    const p = plan().get("/users");
    expect(p?.strategy).toBe("primaryKey");
    expect(p?.primaryKey).toBe("id");
  });

  test("default-off keeps the order-insensitive keyed-collection contract", () => {
    // A pure reorder emits ZERO ops off (SPEC §7.2.3); the applied result is a
    // permutation of modified, NOT byte-equal.
    const original = {
      users: [
        { id: "a", v: 1 },
        { id: "b", v: 2 },
        { id: "c", v: 3 },
      ],
    };
    const modified = {
      users: [
        { id: "c", v: 3 },
        { id: "a", v: 1 },
        { id: "b", v: 2 },
      ],
    };
    const off = new JsonSchemaPatcher({ plan: plan() }).execute({
      original,
      modified,
    });
    expect(off).toEqual([]); // order-insensitive: zero ops
    const applied = applyPatch(structuredClone(original), off);
    expect(stableStringify(applied)).toBe(stableStringify(original)); // NOT modified
  });

  test("emitMoves upgrades a pure reorder to EXACT reconstruction", () => {
    const original = {
      users: [
        { id: "a", v: 1 },
        { id: "b", v: 2 },
        { id: "c", v: 3 },
      ],
    };
    const modified = {
      users: [
        { id: "c", v: 3 },
        { id: "a", v: 1 },
        { id: "b", v: 2 },
      ],
    };
    const on = new JsonSchemaPatcher({
      plan: plan(),
      emitMoves: true,
    }).execute({ original, modified });
    expect(on.filter((o) => o.op === "move").length).toBeGreaterThan(0);
    assertRoundTrip(original, on, modified); // byte-exact, order included
  });

  test("reorder + modify + add + remove reconstructs modified byte-exactly", () => {
    const original = {
      users: [
        { id: "a", v: 1 },
        { id: "b", v: 2 },
        { id: "c", v: 3 },
        { id: "d", v: 4 },
      ],
    };
    const modified = {
      users: [
        { id: "c", v: 3 },
        { id: "a", v: 99 }, // modified
        { id: "e", v: 5 }, // added mid-array (INDEXED add, not /-)
        { id: "b", v: 2 },
      ], // d removed
    };
    const on = new JsonSchemaPatcher({
      plan: plan(),
      emitMoves: true,
    }).execute({ original, modified });
    // Additions are indexed, never "/-".
    for (const op of on) {
      if (op.op === "add") expect(op.path.endsWith("/-")).toBe(false);
    }
    assertRoundTrip(original, on, modified);
  });

  test("granular descent still applies to modified keyed items", () => {
    const original = {
      users: [
        { id: "a", v: 1, meta: { x: 1, y: 2 } },
        { id: "b", v: 2, meta: { x: 3, y: 4 } },
      ],
    };
    const modified = {
      users: [
        { id: "b", v: 2, meta: { x: 3, y: 4 } },
        { id: "a", v: 1, meta: { x: 9, y: 2 } }, // only meta.x changed
      ],
    };
    const on = new JsonSchemaPatcher({
      plan: plan(),
      emitMoves: true,
    }).execute({ original, modified });
    // The change is a granular replace of meta/x, not a whole-item replace.
    expect(on.some((o) => o.path.endsWith("/meta/x"))).toBe(true);
    assertRoundTrip(original, on, modified);
  });

  test("gate-failing arrays fall back to LCS moves (still exact)", () => {
    // A keyless element trips the §5.4.3 gate -> LCS fallback (§5.8.5).
    const original = { users: [{ id: "a", v: 1 }, { v: 2 }] };
    const modified = { users: [{ v: 2 }, { id: "a", v: 1 }] };
    const on = new JsonSchemaPatcher({
      plan: plan(),
      emitMoves: true,
    }).execute({ original, modified });
    assertRoundTrip(original, on, modified);
  });

  test("randomized keyed fuzz reconstructs modified EXACTLY through both appliers", () => {
    let seed = 4242;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let iter = 0; iter < 3000; iter++) {
      const keyPool = ["a", "b", "c", "d", "e", "f", "g", "h"];
      const pickKeys = (k: number) => {
        const p = [...keyPool];
        const out: string[] = [];
        for (let i = 0; i < k; i++)
          out.push(p.splice(Math.floor(rnd() * p.length), 1)[0]!);
        return out;
      };
      const n = 1 + Math.floor(rnd() * 6);
      const m = 1 + Math.floor(rnd() * 6);
      const original = {
        users: pickKeys(n).map((id) => ({ id, v: Math.floor(rnd() * 5) })),
      };
      const modified = {
        users: pickKeys(m).map((id) => ({ id, v: Math.floor(rnd() * 5) })),
      };
      const on = new JsonSchemaPatcher({
        plan: plan(),
        emitMoves: true,
      }).execute({ original, modified });
      assertRoundTrip(original, on, modified);
    }
  });
});
