import { describe, expect, test } from "bun:test";
import { applyPatch as fjpApplyPatch } from "fast-json-patch";
import { JsonSchemaPatcher, applyPatch, buildPlan } from "../src/index";
import type { JSONSchema } from "../src/core/buildPlan";
import type { JsonValue, Operation } from "../src/types";

// spec-v2 declared semantic topologies (CORE §8, GEN §11). A schema node may
// declare, via `x-schema-patch-*` extensions, that an array is a sequence /
// set / map / atomic container, and that an object is granular / atomic. This
// file pins: (1) the ZERO-default-output-change compatibility profile (§8.8);
// (2) each topology's emission and round-trip contract; (3) extension overrides
// of auto-detection and primaryKeyMap; (4) the per-element identity gates and
// their sequence/LCS fallback; (5) construction-time validation.

function diff(
  schema: JSONSchema | null,
  original: JsonValue,
  modified: JsonValue,
  opts: {
    primaryKeyMap?: Record<string, string>;
    emitMoves?: boolean;
    ignorePaths?: string[];
    primaryKeyCandidates?: string[];
  } = {}
): Operation[] {
  const plan = schema
    ? buildPlan({
        schema,
        primaryKeyMap: opts.primaryKeyMap,
        primaryKeyCandidates: opts.primaryKeyCandidates,
      })
    : new Map();
  const patcher = new JsonSchemaPatcher({
    plan,
    emitMoves: opts.emitMoves,
    ignorePaths: opts.ignorePaths,
  });
  return patcher.execute({ original, modified });
}

const S = (v: unknown) => JSON.stringify(v);

/** Apply through BOTH the repo applier and fast-json-patch; assert both equal `expected`. */
function assertRoundTrip(
  original: JsonValue,
  ops: Operation[],
  expected: JsonValue
) {
  const repo = applyPatch(structuredClone(original), ops);
  expect(S(repo)).toBe(S(expected));
  const fjp = fjpApplyPatch(
    structuredClone(original) as object,
    structuredClone(ops) as never,
    false,
    false
  ).newDocument;
  expect(S(fjp)).toBe(S(expected));
}

// ---------------------------------------------------------------------------
// 1. Compatibility profile — zero default-output change (CORE §8.8)
// ---------------------------------------------------------------------------
describe("compat profile: absent extensions == spec-v1 (CORE §8.8)", () => {
  const usersSchema: JSONSchema = {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, name: { type: "string" } },
          required: ["id"],
        },
      },
    },
  };

  const original = {
    users: [
      { id: "a", name: "Al" },
      { id: "b", name: "Bo" },
      { id: "c", name: "Cy" },
    ],
  };
  const modified = {
    users: [
      { id: "a", name: "Alice" },
      { id: "c", name: "Cy" },
      { id: "d", name: "Dee" },
    ],
  };

  test("auto-detected primaryKey === declared map keys:[id] insignificant, byte-for-byte", () => {
    const compat = diff(usersSchema, original, modified);

    const declared: JSONSchema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          "x-schema-patch-topology": "map",
          "x-schema-patch-keys": ["id"],
          items: usersSchema.properties!.users!.items,
        },
      },
    };
    const mapped = diff(declared, original, modified);
    expect(S(mapped)).toBe(S(compat));
    // And it is the keyed-collection contract (survivors ++ appends).
    assertRoundTrip(original, compat, {
      users: [
        { id: "a", name: "Alice" },
        { id: "c", name: "Cy" },
        { id: "d", name: "Dee" },
      ],
    });
  });

  test("primaryKeyMap === declared map keys:[k] insignificant", () => {
    const schemaNoKey: JSONSchema = {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", properties: { sku: { type: "string" } } } },
      },
    };
    const o = { rows: [{ sku: "x", q: 1 }, { sku: "y", q: 2 }] };
    const m = { rows: [{ sku: "y", q: 2 }, { sku: "x", q: 9 }] };
    const viaMap = diff(schemaNoKey, o, m, { primaryKeyMap: { "/rows": "sku" } });

    const declared: JSONSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          "x-schema-patch-topology": "map",
          "x-schema-patch-keys": ["sku"],
          items: { type: "object", properties: { sku: { type: "string" } } },
        },
      },
    };
    expect(S(diff(declared, o, m))).toBe(S(viaMap));
  });
});

// ---------------------------------------------------------------------------
// 2. sequence topology (CORE §8.7)
// ---------------------------------------------------------------------------
describe("sequence topology forces LCS (CORE §8.7)", () => {
  const seqSchema: JSONSchema = {
    type: "object",
    properties: {
      items: {
        type: "array",
        "x-schema-patch-topology": "sequence",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    },
  };

  test("declared sequence overrides an auto-detectable primaryKey → positional LCS", () => {
    const original = { items: [{ id: "a" }, { id: "b" }, { id: "c" }] };
    // A pure reorder: primaryKey would emit ZERO ops (§7.2.3); sequence/LCS must
    // emit positional ops to reconstruct the new order exactly.
    const modified = { items: [{ id: "c" }, { id: "a" }, { id: "b" }] };
    const ops = diff(seqSchema, original, modified);
    expect(ops.length).toBeGreaterThan(0);
    assertRoundTrip(original, ops, modified);
  });
});

// ---------------------------------------------------------------------------
// 3. set topology (CORE §8.5, GEN §11.3)
// ---------------------------------------------------------------------------
describe("set topology (CORE §8.5)", () => {
  const setSchema: JSONSchema = {
    type: "object",
    properties: {
      tags: {
        type: "array",
        "x-schema-patch-topology": "set",
        items: { type: "string" },
      },
    },
  };

  test("add + remove members; survivors get no op; descending removals then /- adds", () => {
    const original = { tags: ["a", "b", "c", "d"] };
    const modified = { tags: ["a", "c", "e", "f"] };
    const ops = diff(setSchema, original, modified);
    // b (idx1) and d (idx3) vanish → removes descending: /3 then /1. e,f appended.
    expect(ops).toEqual([
      { op: "remove", path: "/tags/3", oldValue: "d" },
      { op: "remove", path: "/tags/1", oldValue: "b" },
      { op: "add", path: "/tags/-", value: "e" },
      { op: "add", path: "/tags/-", value: "f" },
    ]);
    // Content-equal to modified (order insignificant): survivors kept in original
    // relative order, vanished removed, new appended.
    assertRoundTrip(original, ops, { tags: ["a", "c", "e", "f"] });
  });

  test("pure reorder of a set emits ZERO ops (order insignificant)", () => {
    const original = { tags: ["a", "b", "c"] };
    const modified = { tags: ["c", "a", "b"] };
    expect(diff(setSchema, original, modified)).toEqual([]);
  });

  test("set of objects: identity is the whole value (deep-equal)", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        pts: {
          type: "array",
          "x-schema-patch-topology": "set",
          items: { type: "object", properties: { x: { type: "number" } } },
        },
      },
    };
    const original = { pts: [{ x: 1 }, { x: 2 }] };
    const modified = { pts: [{ x: 2 }, { x: 3 }] };
    const ops = diff(schema, original, modified);
    expect(ops).toEqual([
      { op: "remove", path: "/pts/0", oldValue: { x: 1 } },
      { op: "add", path: "/pts/-", value: { x: 3 } },
    ]);
    assertRoundTrip(original, ops, { pts: [{ x: 2 }, { x: 3 }] });
  });

  test("gate: a deep-equal duplicate falls back to sequence/LCS", () => {
    const original = { tags: ["a", "a", "b"] }; // dup "a" in original
    const modified = { tags: ["a", "b"] };
    const ops = diff(setSchema, original, modified);
    // Falls back to LCS: a positional removal, NOT a membership /- diff.
    assertRoundTrip(original, ops, modified);
    // membership emission would never remove a survivor of "a"; LCS removes one.
    expect(ops.some((o) => o.op === "remove")).toBe(true);
    expect(ops.some((o) => o.op === "add")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. map topology — composite keys (CORE §8.4, GEN §11.4)
// ---------------------------------------------------------------------------
describe("map topology — composite key tuple (CORE §8.4)", () => {
  // k8s-style: identity = (containerPort, protocol).
  const portsSchema: JSONSchema = {
    type: "object",
    properties: {
      ports: {
        type: "array",
        "x-schema-patch-topology": "map",
        "x-schema-patch-keys": ["containerPort", "protocol"],
        items: {
          type: "object",
          properties: {
            containerPort: { type: "number" },
            protocol: { type: "string" },
            name: { type: "string" },
          },
          required: ["containerPort", "protocol"],
        },
      },
    },
  };

  test("composite identity: same port, different protocol are DISTINCT elements", () => {
    const original = {
      ports: [
        { containerPort: 80, protocol: "TCP", name: "http" },
        { containerPort: 80, protocol: "UDP", name: "http-udp" },
      ],
    };
    const modified = {
      ports: [
        { containerPort: 80, protocol: "TCP", name: "web" }, // modify TCP:80
        { containerPort: 443, protocol: "TCP", name: "https" }, // add
      ],
    };
    const ops = diff(portsSchema, original, modified);
    // (80,TCP) matched+modified at index 0; (80,UDP) removed; (443,TCP) added.
    expect(ops).toContainEqual({
      op: "replace",
      path: "/ports/0/name",
      value: "web",
      oldValue: "http",
    });
    expect(ops).toContainEqual({
      op: "remove",
      path: "/ports/1",
      oldValue: { containerPort: 80, protocol: "UDP", name: "http-udp" },
    });
    expect(ops).toContainEqual({
      op: "add",
      path: "/ports/-",
      value: { containerPort: 443, protocol: "TCP", name: "https" },
    });
  });

  test("insignificant order: keyed-collection round-trip (survivors ++ appends)", () => {
    const original = {
      ports: [
        { containerPort: 80, protocol: "TCP", name: "a" },
        { containerPort: 81, protocol: "TCP", name: "b" },
      ],
    };
    // reorder + modify + add
    const modified = {
      ports: [
        { containerPort: 81, protocol: "TCP", name: "B" },
        { containerPort: 80, protocol: "TCP", name: "a" },
        { containerPort: 82, protocol: "TCP", name: "c" },
      ],
    };
    const ops = diff(portsSchema, original, modified);
    // Keyed-collection: survivors in ORIGINAL order carrying modified content,
    // ++ new keys appended.
    assertRoundTrip(original, ops, {
      ports: [
        { containerPort: 80, protocol: "TCP", name: "a" },
        { containerPort: 81, protocol: "TCP", name: "B" },
        { containerPort: 82, protocol: "TCP", name: "c" },
      ],
    });
  });

  test("significant order: EXACT reconstruction (survivors reordered + indexed adds)", () => {
    const sig: JSONSchema = {
      type: "object",
      properties: {
        ports: {
          ...portsSchema.properties!.ports,
          "x-schema-patch-order": "significant",
        },
      },
    };
    const original = {
      ports: [
        { containerPort: 80, protocol: "TCP", name: "a" },
        { containerPort: 81, protocol: "TCP", name: "b" },
      ],
    };
    const modified = {
      ports: [
        { containerPort: 81, protocol: "TCP", name: "B" },
        { containerPort: 80, protocol: "TCP", name: "a" },
        { containerPort: 82, protocol: "TCP", name: "c" },
      ],
    };
    const ops = diff(sig, original, modified);
    // Order-significant map reconstructs modified EXACTLY (order included),
    // definitionally via the move machinery, WITHOUT the emitMoves option.
    assertRoundTrip(original, ops, modified);
    expect(ops.some((o) => o.op === "move")).toBe(true);
  });

  test("gate: duplicate composite tuple in a side falls back to sequence/LCS", () => {
    const original = {
      ports: [
        { containerPort: 80, protocol: "TCP", name: "a" },
        { containerPort: 80, protocol: "TCP", name: "dup" }, // dup tuple (80,TCP)
      ],
    };
    const modified = { ports: [{ containerPort: 80, protocol: "TCP", name: "a" }] };
    const ops = diff(portsSchema, original, modified);
    assertRoundTrip(original, ops, modified);
  });

  test("gate: a missing key field falls back to sequence/LCS", () => {
    const original = { ports: [{ containerPort: 80, name: "no-proto" }] }; // protocol absent
    const modified = { ports: [{ containerPort: 80, name: "still" }] };
    const ops = diff(portsSchema, original, modified);
    assertRoundTrip(original, ops, modified);
  });

  test("declared order is significant to identity: keys [a,b] != [b,a]", () => {
    // Two elements that are swaps of each other's key values are distinct tuples.
    const schema: JSONSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          "x-schema-patch-topology": "map",
          "x-schema-patch-keys": ["a", "b"],
          items: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
        },
      },
    };
    const original = { rows: [{ a: 1, b: 2, v: "x" }] };
    const modified = { rows: [{ a: 2, b: 1, v: "y" }] };
    const ops = diff(schema, original, modified);
    // (1,2) removed, (2,1) added — not a modify.
    expect(ops).toContainEqual({ op: "remove", path: "/rows/0", oldValue: { a: 1, b: 2, v: "x" } });
    expect(ops).toContainEqual({ op: "add", path: "/rows/-", value: { a: 2, b: 1, v: "y" } });
  });
});

// ---------------------------------------------------------------------------
// 5. atomic array + atomic object (CORE §8.6)
// ---------------------------------------------------------------------------
describe("atomic containers (CORE §8.6)", () => {
  test("atomic array: any deep difference → one whole-array replace, no recursion", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          "x-schema-patch-topology": "atomic",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
    };
    const original = { matrix: [{ id: "a", n: 1 }] };
    const modified = { matrix: [{ id: "a", n: 2 }] };
    const ops = diff(schema, original, modified);
    expect(ops).toEqual([
      {
        op: "replace",
        path: "/matrix",
        value: [{ id: "a", n: 2 }],
        oldValue: [{ id: "a", n: 1 }],
      },
    ]);
    assertRoundTrip(original, ops, modified);
  });

  test("atomic array: equal arrays emit nothing", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        a: { type: "array", "x-schema-patch-topology": "atomic", items: { type: "number" } },
      },
    };
    expect(diff(schema, { a: [1, 2, 3] }, { a: [1, 2, 3] })).toEqual([]);
  });

  test("atomic object: any member difference → one whole-object replace", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          "x-schema-patch-granularity": "atomic",
          properties: { a: { type: "number" }, b: { type: "number" } },
        },
      },
    };
    const original = { config: { a: 1, b: 2 } };
    const modified = { config: { a: 1, b: 3 } };
    const ops = diff(schema, original, modified);
    expect(ops).toEqual([
      { op: "replace", path: "/config", value: { a: 1, b: 3 }, oldValue: { a: 1, b: 2 } },
    ]);
    assertRoundTrip(original, ops, modified);
  });

  test("atomic object: equal objects emit nothing", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          "x-schema-patch-granularity": "atomic",
          properties: { a: { type: "number" } },
        },
      },
    };
    expect(diff(schema, { config: { a: 1 } }, { config: { a: 1 } })).toEqual([]);
  });

  test("nothing recurses below an atomic node: a keyed inner array is NOT diffed granularly", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        box: {
          type: "object",
          "x-schema-patch-granularity": "atomic",
          properties: {
            items: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            },
          },
        },
      },
    };
    const original = { box: { items: [{ id: "a", v: 1 }] } };
    const modified = { box: { items: [{ id: "a", v: 2 }] } };
    const ops = diff(schema, original, modified);
    // A single whole-object replace at /box — NOT /box/items/0/v.
    expect(ops).toEqual([
      { op: "replace", path: "/box", value: modified.box, oldValue: original.box },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Precedence: extensions override auto-detection AND primaryKeyMap
// ---------------------------------------------------------------------------
describe("declared topology precedence (CORE §8.2.2)", () => {
  const original = { items: [{ id: "a" }, { id: "b" }] };
  const modified = { items: [{ id: "b" }, { id: "a" }] }; // pure reorder

  test("sequence overrides auto-detected id primaryKey", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          "x-schema-patch-topology": "sequence",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
    };
    // primaryKey would emit []; sequence must emit ops to reorder.
    expect(diff(schema, original, modified).length).toBeGreaterThan(0);
  });

  test("atomic overrides a primaryKeyMap entry for the same path", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          "x-schema-patch-topology": "atomic",
          items: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    };
    const ops = diff(schema, original, modified, { primaryKeyMap: { "/items": "id" } });
    // atomic wins: one whole-array replace, not a keyed no-op reorder.
    expect(ops).toEqual([
      { op: "replace", path: "/items", value: modified.items, oldValue: original.items },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 7. Construction-time validation (CORE §8.2.3)
// ---------------------------------------------------------------------------
describe("construction validation (CORE §8.2.3)", () => {
  test('map without keys throws', () => {
    expect(() =>
      buildPlan({
        schema: {
          type: "object",
          properties: {
            a: { type: "array", "x-schema-patch-topology": "map", items: { type: "object" } },
          },
        },
      })
    ).toThrow(/map.*REQUIRES.*keys/i);
  });

  test("unknown topology value throws", () => {
    expect(() =>
      buildPlan({
        schema: {
          type: "object",
          properties: {
            a: { type: "array", "x-schema-patch-topology": "bag", items: {} },
          },
        },
      })
    ).toThrow(/unknown value/i);
  });

  test("unknown order value throws", () => {
    expect(() =>
      buildPlan({
        schema: {
          type: "object",
          properties: {
            a: {
              type: "array",
              "x-schema-patch-topology": "map",
              "x-schema-patch-keys": ["id"],
              "x-schema-patch-order": "sorted",
              items: {},
            },
          },
        },
      })
    ).toThrow(/x-schema-patch-order/i);
  });

  test("unknown granularity value throws", () => {
    expect(() =>
      buildPlan({
        schema: {
          type: "object",
          properties: {
            a: {
              type: "object",
              "x-schema-patch-granularity": "coarse",
              properties: { x: {} },
            },
          },
        },
      })
    ).toThrow(/x-schema-patch-granularity/i);
  });

  test("conflicting declared topologies at the same path (anyOf) throw", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        a: {
          anyOf: [
            { type: "array", "x-schema-patch-topology": "set", items: { type: "number" } },
            { type: "array", "x-schema-patch-topology": "sequence", items: { type: "number" } },
          ],
        },
      },
    };
    expect(() => buildPlan({ schema })).toThrow(/[Cc]onflicting/);
  });

  test("atomic array with an ignorePaths terminal beneath it is a construction error", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        box: {
          type: "array",
          "x-schema-patch-topology": "atomic",
          items: { type: "object", properties: { secret: { type: "string" } } },
        },
      },
    };
    const plan = buildPlan({ schema });
    expect(
      () => new JsonSchemaPatcher({ plan, ignorePaths: ["/box/secret"] })
    ).toThrow(/atomic/i);
  });

  test("atomic object with an ignorePaths terminal beneath it is a construction error", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          "x-schema-patch-granularity": "atomic",
          properties: { secret: { type: "string" } },
        },
      },
    };
    const plan = buildPlan({ schema });
    expect(
      () => new JsonSchemaPatcher({ plan, ignorePaths: ["/config/secret"] })
    ).toThrow(/atomic/i);
  });

  test("a map key field covered by ignorePaths is a construction error (GEN §10.7)", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        ports: {
          type: "array",
          "x-schema-patch-topology": "map",
          "x-schema-patch-keys": ["containerPort", "protocol"],
          items: {
            type: "object",
            properties: { containerPort: { type: "number" }, protocol: { type: "string" } },
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    // The element-level wildcard `*` addresses each array element's members.
    expect(
      () => new JsonSchemaPatcher({ plan, ignorePaths: ["/ports/*/protocol"] })
    ).toThrow(/key field/i);
  });
});

// ---------------------------------------------------------------------------
// 7b. Capabilities are contract-preserving under topology (CORE §7.7.2)
// ---------------------------------------------------------------------------
describe("emitMoves is contract-preserving for declared topologies (CORE §7.2.6)", () => {
  test("emitMoves does NOT upgrade map/insignificant to exact order (the spec-v2 correction)", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        rows: {
          type: "array",
          "x-schema-patch-topology": "map",
          "x-schema-patch-keys": ["id"],
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
    };
    const original = { rows: [{ id: "a" }, { id: "b" }] };
    const modified = { rows: [{ id: "b" }, { id: "a" }] }; // pure reorder
    // With the option OFF and ON the output is identical: a pure reorder of an
    // order-insignificant map emits NOTHING either way (no move upgrade).
    expect(diff(schema, original, modified, { emitMoves: false })).toEqual([]);
    expect(diff(schema, original, modified, { emitMoves: true })).toEqual([]);
  });

  test("emitMoves is a no-op for set and atomic", () => {
    const setSchema: JSONSchema = {
      type: "object",
      properties: {
        tags: { type: "array", "x-schema-patch-topology": "set", items: { type: "string" } },
      },
    };
    const o = { tags: ["a", "b", "c"] };
    const m = { tags: ["c", "a", "b"] }; // reorder
    expect(diff(setSchema, o, m, { emitMoves: true })).toEqual([]);
    expect(diff(setSchema, o, m, { emitMoves: false })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Plan-shape introspection (CORE §8.3)
// ---------------------------------------------------------------------------
describe("plan shape (CORE §8.3)", () => {
  test("map plan carries topology/keys/order + compat view; object plan carries granularity", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: {
        ports: {
          type: "array",
          "x-schema-patch-topology": "map",
          "x-schema-patch-keys": ["containerPort", "protocol"],
          "x-schema-patch-order": "significant",
          items: { type: "object", properties: { containerPort: { type: "number" }, protocol: { type: "string" } } },
        },
        config: {
          type: "object",
          "x-schema-patch-granularity": "atomic",
          properties: { x: {} },
        },
      },
    };
    const plan = buildPlan({ schema });
    const ports = plan.get("/ports")!;
    expect(ports).toMatchObject({
      topology: "map",
      keys: ["containerPort", "protocol"],
      order: "significant",
      strategy: "primaryKey", // lossy compat view
      primaryKey: "containerPort", // keys[0]
    });
    expect(plan.get("/config")).toEqual({ granularity: "atomic" });
  });

  test("a granular (default) object is NOT registered — plan/trie stays minimal", () => {
    const schema: JSONSchema = {
      type: "object",
      properties: { config: { type: "object", properties: { x: { type: "number" } } } },
    };
    expect(buildPlan({ schema }).has("/config")).toBe(false);
  });
});
