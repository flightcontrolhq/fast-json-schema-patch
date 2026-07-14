import { describe, test, expect, spyOn, it } from "bun:test";
import {
  applyPatch as applySchemaPatch,
  buildPlan,
  JsonSchemaPatcher,
} from "../src/index";
import { deepEqual } from "../src/performance/deepEqual";
import { fastHash } from "../src/performance/fashHash";
import { _resolveRef } from "../src/core/buildPlan";
import { _traverseSchema } from "../src/core/buildPlan";
import type { Operation } from "../src/types";
import originalSchema from "../schema/schema.json";
import { faker } from "@faker-js/faker";
import {
  applyPatch,
  type Operation as FastJsonPatchOperation,
} from "fast-json-patch";

const schema = originalSchema as any;

const userSchema = {
  type: "object",
  properties: {
    userId: { type: "string" },
    username: { type: "string" },
    email: { type: "string" },
    avatar: { type: "string" },
    password: { type: "string" },
    birthdate: { type: "string", format: "date-time" },
    registeredAt: { type: "string", format: "date-time" },
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zipCode: { type: "string" },
      },
      required: ["street", "city", "zipCode"],
    },
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          postId: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
          likes: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["postId", "title", "content", "timestamp", "likes"],
      },
    },
  },
  required: ["userId", "username", "email", "registeredAt"],
};

function createRandomUser() {
  return {
    userId: faker.string.uuid(),
    username: faker.internet.username(),
    email: faker.internet.email(),
    avatar: faker.image.avatar(),
    birthdate: faker.date.past().toISOString(),
    registeredAt: faker.date.past().toISOString(),
    address: {
      street: faker.location.streetAddress(),
      city: faker.location.city(),
      zipCode: faker.location.zipCode(),
    },
    posts: Array.from({ length: faker.number.int({ min: 2, max: 5 }) }, () => ({
      postId: faker.string.uuid(),
      title: faker.lorem.sentence(),
      content: faker.lorem.paragraphs(),
      timestamp: faker.date.recent().toISOString(),
      likes: faker.number.int({ min: 0, max: 1000 }),
      tags: Array.from({ length: faker.number.int({ min: 1, max: 5 }) }, () =>
        faker.lorem.word()
      ),
    })),
  };
}

describe("Faker-based tests", () => {
  test("should correctly patch complex objects with various changes", () => {
    const doc1 = createRandomUser();
    // A deep copy is needed to avoid modifying the original object
    const doc2 = JSON.parse(JSON.stringify(doc1));

    // 1. Change a simple property
    doc2.username = faker.internet.username();

    // 2. Add a new property
    doc2.lastLogin = faker.date.recent().toISOString();

    // 3. Remove a property
    delete doc2.address;

    // 4. Modify an array: remove, add, and change an item
    if (doc2.posts.length > 0) {
      // remove
      doc2.posts.splice(0, 1);
      // change
      if (doc2.posts.length > 0) {
        doc2.posts[0].title = "A new title";
        doc2.posts[0].likes += 10;
        // remove a tag
        if (doc2.posts[0].tags.length > 0) {
          doc2.posts[0].tags.pop();
        }
      }
    }
    // add a new post
    doc2.posts.push({
      postId: faker.string.uuid(),
      title: "Newly Added Post",
      content: faker.lorem.paragraphs(),
      timestamp: faker.date.recent().toISOString(),
      likes: 0,
      tags: ["new", "post"],
    });

    const plan = buildPlan({
      schema: userSchema,
      primaryKeyMap: { "/posts": "postId" },
    });
    const patcher = new JsonSchemaPatcher({ plan });

    const patch = patcher.execute({ original: doc1, modified: doc2 });

    const { newDocument } = applyPatch(doc1, patch as FastJsonPatchOperation[]);

    expect(newDocument).toEqual(doc2);
  });
});

describe("buildPlan", () => {
  it("should identify a primary key from a simple schema", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    expect(plan.get("/users")?.primaryKey).toBe("id");
  });

  it("should not identify a primary key when none are suitable", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    expect(plan.get("/users")?.primaryKey).toBe(null);
  });

  it("should allow customizing the primary key", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              userId: { type: "string" },
              name: { type: "string" },
            },
          },
        },
      },
    };
    const plan = buildPlan({
      schema,
      primaryKeyMap: {
        "/users": "userId",
      },
    });
    expect(plan.get("/users")?.primaryKey).toBe("userId");
  });

  it("should handle nested arrays and custom keys", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              userId: { type: "string" },
              posts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    postId: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const plan = buildPlan({
      schema,
      primaryKeyMap: {
        "/users": "userId",
        "/users/posts": "postId",
      },
    });
    expect(plan.get("/users")?.primaryKey).toBe("userId");
    expect(plan.get("/users/posts")?.primaryKey).toBe("postId");
  });

  it("should handle schemas with $ref", () => {
    const schema = {
      definitions: {
        user: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
      },
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            $ref: "#/definitions/user",
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    expect(plan.get("/users")?.primaryKey).toBe("id");
  });

  it("should handle anyOf/oneOf correctly", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
              },
              {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" } },
              },
            ],
          },
        },
      },
    };
    const plan = buildPlan({ schema: schema as any });
    // It should pick the first valid one
    expect(plan.get("/items")?.primaryKey).toBe("id");
  });

  it("basePath must match on a segment boundary, not a sibling prefix (F14)", () => {
    const schema = {
      type: "object",
      properties: {
        env: {
          type: "object",
          properties: {
            vars: {
              type: "array",
              items: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
              },
            },
          },
        },
        envelope: {
          type: "object",
          properties: {
            stamps: {
              type: "array",
              items: {
                type: "object",
                required: ["id"],
                properties: { id: { type: "string" } },
              },
            },
          },
        },
      },
    };
    const plan = buildPlan({ schema, basePath: "/env" });
    // "/env" must NOT capture the sibling "/envelope/stamps".
    const keys = [...plan.keys()].sort();
    expect(keys).toEqual(["/vars"]);
    expect(plan.get("/vars")?.primaryKey).toBe("id");
    // The corrupted "elope/stamps" key produced by string-prefix stripping
    // must never appear.
    expect(plan.has("elope/stamps")).toBe(false);
  });

  it("traverses draft-2020 schemas that omit explicit type:object (F40)", () => {
    // No "type" keyword anywhere at the object levels — legal in draft 2019/2020.
    const schema = {
      properties: {
        users: {
          type: "array",
          items: {
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    // At HEAD the root's missing type:"object" yielded an empty plan and the
    // array degraded to LCS; the array must now be discovered.
    expect(plan.get("/users")?.strategy).toBe("primaryKey");
    expect(plan.get("/users")?.primaryKey).toBe("id");
  });

  it("traverses typeless nodes carrying only an items keyword (F40)", () => {
    const schema = {
      properties: {
        // Object node with no "type", array node with no "type".
        tags: {
          items: { type: "string" },
        },
      },
    };
    const plan = buildPlan({ schema });
    expect(plan.get("/tags")?.strategy).toBe("unique");
  });

  it("merges allOf item branches for primary-key detection (F35)", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            allOf: [
              {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
              },
              {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
              },
            ],
          },
        },
      },
    };
    const plan = buildPlan({ schema: schema as any });
    const arrayPlan = plan.get("/users");
    // At HEAD allOf was never inspected -> lcs/null; now the id declared in the
    // first branch is found and required fields are merged across branches.
    expect(arrayPlan?.strategy).toBe("primaryKey");
    expect(arrayPlan?.primaryKey).toBe("id");
    expect(arrayPlan?.requiredFields).toEqual(new Set(["id", "name"]));
    expect(arrayPlan?.hashFields?.sort()).toEqual(["id", "name"]);
  });

  it("merges allOf nested inside an anyOf/oneOf branch (F35)", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            oneOf: [
              {
                allOf: [
                  {
                    type: "object",
                    properties: { id: { type: "number" } },
                    required: ["id"],
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const plan = buildPlan({ schema: schema as any });
    expect(plan.get("/users")?.primaryKey).toBe("id");
    expect(plan.get("/users")?.strategy).toBe("primaryKey");
  });

  it("should give priority to custom key over inferred key", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              customId: { type: "string" },
            },
          },
        },
      },
    };
    const plan = buildPlan({
      schema,
      primaryKeyMap: {
        "/users": "customId",
      },
    });
    expect(plan.get("/users")?.primaryKey).toBe("customId");
  });
});

describe("nested arrays-of-arrays (F04)", () => {
  const matrixSchema = {
    type: "object",
    properties: {
      matrix: {
        type: "array",
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              v: { type: "number" },
            },
          },
        },
      },
    },
  };

  it("registers the inner array at a distinct wildcard element path", () => {
    const plan = buildPlan({ schema: matrixSchema as any });
    // Outer array: elements are arrays, not keyed objects -> lcs, no clobber.
    expect(plan.get("/matrix")?.strategy).toBe("lcs");
    expect(plan.get("/matrix")?.primaryKey).toBe(null);
    // Inner array registers under the wildcard element key, not "/matrix".
    expect(plan.get("/matrix/*")?.strategy).toBe("primaryKey");
    expect(plan.get("/matrix/*")?.primaryKey).toBe("id");
  });

  it("compiles the inner array into the matrix node's wildcard trie edge", () => {
    // The path-string getPlanForPath lookup was replaced by a compiled plan
    // trie threaded structurally through the recursion (SPEC §5.4.5). The inner
    // array's `/matrix/*` plan is reachable as the wildcard child of the matrix
    // node — the structural equivalent of the old element-wildcard lookup, and
    // the node a nested-array element (array-of-arrays) descends to at diff time.
    const patcher = new JsonSchemaPatcher({
      plan: buildPlan({ schema: matrixSchema as any }),
    });
    const trie = (patcher as any).planTrie;
    const innerPlan = trie.children.get("matrix").wildcard.plan;
    expect(innerPlan?.strategy).toBe("primaryKey");
    expect(innerPlan?.primaryKey).toBe("id");
  });

  it("produces correct, non-empty patches for a matrix diff that apply cleanly", () => {
    const plan = buildPlan({ schema: matrixSchema as any });
    const patcher = new JsonSchemaPatcher({ plan });

    const original = { matrix: [[{ id: "a", v: 1 }]] };
    const modified = {
      matrix: [
        [
          { id: "a", v: 1 },
          { id: "b", v: 2 },
        ],
        [{ id: "c", v: 3 }],
      ],
    };

    const patches = patcher.execute({ original, modified });
    // At HEAD the inner primaryKey plan clobbered the outer lcs plan and the
    // outer array (whose elements are arrays) emitted ZERO ops.
    expect(patches.length).toBeGreaterThan(0);

    const result = applySchemaPatch(original, patches);
    expect(result).toEqual(modified);
  });
});

describe("structural plan-trie matching (F18/F33)", () => {
  // A reorder of a primaryKey-keyed array is a 0-op diff (§7.2 keyed-collection
  // semantics); under `lcs`/`unique` the same reorder emits ops. So "reorder ==
  // 0 ops" is a clean proof that the primaryKey plan was actually reached.
  const keyedItems = {
    type: "array",
    items: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" }, v: { type: "number" } },
    },
  };

  it("matches a TOP-LEVEL additionalProperties `/*` keyed array (was §B.5, unreachable at HEAD)", () => {
    const schema = { type: "object", additionalProperties: keyedItems };
    const plan = buildPlan({ schema: schema as any });
    expect([...plan.keys()]).toContain("/*");

    const patcher = new JsonSchemaPatcher({ plan });
    const original = { svcA: [{ id: "a", v: 1 }, { id: "b", v: 2 }] };
    const modified = { svcA: [{ id: "b", v: 2 }, { id: "a", v: 1 }] };
    // primaryKey reached -> reorder is a no-op.
    expect(patcher.execute({ original, modified })).toEqual([]);

    // A real add/modify routes through the keyed strategy (append via `/-`,
    // field op at the ORIGINAL index) and still round-trips as a keyed set.
    const o2 = { svcA: [{ id: "a", v: 1 }] };
    const m2 = { svcA: [{ id: "a", v: 9 }, { id: "c", v: 3 }] };
    const p2 = patcher.execute({ original: o2, modified: m2 });
    expect(p2).toEqual([
      { op: "replace", path: "/svcA/0/v", value: 9, oldValue: 1 },
      { op: "add", path: "/svcA/-", value: { id: "c", v: 3 } },
    ]);
    expect(applySchemaPatch(o2, p2)).toEqual(m2);
  });

  it("matches a DEEP `/*/x/*/items` wildcard array at any depth (was §B.1, unreachable at HEAD)", () => {
    const schema = {
      type: "object",
      additionalProperties: {
        type: "object",
        properties: {
          x: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: { items: keyedItems },
            },
          },
        },
      },
    };
    const plan = buildPlan({ schema: schema as any });
    expect([...plan.keys()]).toContain("/*/x/*/items");

    const patcher = new JsonSchemaPatcher({ plan });
    const original = { envA: { x: { grp: { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }] } } } };
    const modified = { envA: { x: { grp: { items: [{ id: "b", v: 2 }, { id: "a", v: 1 }] } } } };
    // Wildcard matched through two additionalProperties levels + a literal `x`.
    expect(patcher.execute({ original, modified })).toEqual([]);
  });

  it("disambiguates a numeric-STRING object key from an array index (F33 / former §B.2)", () => {
    // A numeric object key sits MID-PATH. The old index-normalization stripped
    // `/0`, collapsing `/registry/0/list` -> `/registry/list`, which collided
    // with the sibling LITERAL `list` property plan (a primitive-string `unique`
    // array) instead of the additionalProperties object-array (`primaryKey`).
    const schema = {
      type: "object",
      properties: {
        registry: {
          type: "object",
          properties: { list: { type: "array", items: { type: "string" } } },
          additionalProperties: {
            type: "object",
            properties: { list: keyedItems },
          },
        },
      },
    };
    const plan = buildPlan({ schema: schema as any });
    expect(plan.get("/registry/list")?.strategy).toBe("unique");
    expect(plan.get("/registry/*/list")?.strategy).toBe("primaryKey");

    const patcher = new JsonSchemaPatcher({ plan });

    // The object-array under numeric key "0" must reach its primaryKey plan:
    // a reorder is a no-op (the old misroute to `unique` emitted positional ops).
    const original = { registry: { "0": { list: [{ id: "a", v: 1 }, { id: "b", v: 2 }] } } };
    const modified = { registry: { "0": { list: [{ id: "b", v: 2 }, { id: "a", v: 1 }] } } };
    expect(patcher.execute({ original, modified })).toEqual([]);

    // A field edit emits a granular op at the item's ORIGINAL index — proof the
    // keyed strategy (not positional `unique`) handled the numeric-keyed bucket.
    const o2 = { registry: { "0": { list: [{ id: "a", v: 1 }, { id: "b", v: 2 }] } } };
    const m2 = { registry: { "0": { list: [{ id: "a", v: 1 }, { id: "b", v: 99 }] } } };
    expect(patcher.execute({ original: o2, modified: m2 })).toEqual([
      { op: "replace", path: "/registry/0/list/1/v", value: 99, oldValue: 2 },
    ]);

    // The sibling LITERAL `list` (a primitive `unique` array) still routes to
    // its own plan, unaffected by the numeric-keyed bucket.
    const o3 = { registry: { list: ["x", "y", "z"] } };
    const m3 = { registry: { list: ["x", "Y", "z"] } };
    const p3 = patcher.execute({ original: o3, modified: m3 });
    expect(applySchemaPatch(o3, p3)).toEqual(m3);
  });

  it("exact property edge takes precedence over the wildcard edge at each level", () => {
    // `known` is a literal property (lcs whole-object array); everything else is
    // additionalProperties (primaryKey). The exact edge must win for `known`.
    const schema = {
      type: "object",
      properties: {
        known: { type: "array", items: { type: "object" } }, // /known -> lcs
      },
      additionalProperties: keyedItems, // /* -> primaryKey
    };
    const plan = buildPlan({ schema: schema as any });
    const patcher = new JsonSchemaPatcher({ plan });

    // `known` (exact) is lcs: a reorder of opaque objects DOES emit ops.
    const knownReorder = patcher.execute({
      original: { known: [{ a: 1 }, { a: 2 }] },
      modified: { known: [{ a: 2 }, { a: 1 }] },
    });
    expect(knownReorder.length).toBeGreaterThan(0);

    // `other` (wildcard) is primaryKey: the same-shaped reorder is a no-op.
    const otherReorder = patcher.execute({
      original: { other: [{ id: "a", v: 1 }, { id: "b", v: 2 }] },
      modified: { other: [{ id: "b", v: 2 }, { id: "a", v: 1 }] },
    });
    expect(otherReorder).toEqual([]);
  });
});

describe("plan dispatch carries no per-instance path caches (F18)", () => {
  it("removed the four unbounded caches and retains no per-diff state after a 20k-element execute", () => {
    const schema = {
      type: "object",
      properties: {
        services: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            properties: {
              id: { type: "string" },
              ports: { type: "array", items: { type: "number" } },
            },
          },
        },
      },
    };
    const patcher = new JsonSchemaPatcher({ plan: buildPlan({ schema: schema as any }) }) as any;

    // The four path-string caches that grew with data (one 20k execute left
    // planLookupCache.size === 20001) no longer exist as fields.
    expect(patcher.planLookupCache).toBeUndefined();
    expect(patcher.negativePlanCache).toBeUndefined();
    expect(patcher.wildcardPathCache).toBeUndefined();
    expect(patcher.simplePathCache).toBeUndefined();

    const mk = (n: number, portsLen: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `s${i}`,
        ports: Array.from({ length: portsLen }, (_, p) => p),
      }));

    const original = { services: mk(20000, 3) };
    const modified = { services: mk(20000, 4) }; // every nested ports array grows

    // Snapshot every own enumerable field's collection size before/after so any
    // accidental reintroduction of a data-proportional cache is caught.
    const sizes = () =>
      Object.values(patcher).map((v: any) =>
        v instanceof Map || v instanceof Set ? v.size : -1
      );
    const before = sizes();
    const patches = patcher.execute({ original, modified });
    expect(patches.length).toBeGreaterThan(0);
    // Second run must not accumulate anything either.
    patcher.execute({ original, modified });
    const after = sizes();

    // No per-instance Map/Set grew with the 20k elements; the only Maps are the
    // compiled trie (built once in the constructor, size fixed by the schema).
    expect(after).toEqual(before);
    for (const v of Object.values(patcher)) {
      if (v instanceof Map || v instanceof Set) {
        expect(v.size).toBeLessThan(100); // schema-sized, never data-sized
      }
    }
  });
});

describe("buildPlan > ArrayPlan metadata", () => {
  it("should identify strategy, hashFields, and requiredFields for a primary key array", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            required: ["id", "email", "age"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              email: { type: "string" },
              age: { type: "number" },
            },
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    const arrayPlan = plan.get("/users");

    expect(arrayPlan?.primaryKey).toBe("id");
    expect(arrayPlan?.strategy).toBe("primaryKey");
    expect(arrayPlan?.requiredFields).toEqual(new Set(["id", "email", "age"]));
    // name is not required, so it shouldn't be a hash field
    expect(arrayPlan?.hashFields).toEqual(["id", "email", "age"]);
  });

  it("should identify 'lcs' strategy for object arrays without a primary key", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    const arrayPlan = plan.get("/users");
    expect(arrayPlan?.primaryKey).toBe(null);
    expect(arrayPlan?.strategy).toBe("lcs");
  });

  it("should identify 'lcs' strategy and primitive items for primitive arrays", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: {
            type: "string",
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    const arrayPlan = plan.get("/tags");
    expect(arrayPlan?.primaryKey).toBe(null);
    expect(arrayPlan?.strategy).toBe("unique");
  });

  it("resolves $ref items for primary-key detection without retaining itemSchema (F19)", () => {
    // Historically this test asserted that buildPlan pre-resolved and stored
    // the item schema on ArrayPlan.itemSchema. F19 found that field
    // write-only (nothing at diff time ever read it — deepEqualSchemaAware/
    // getEffectiveHashFields use only primaryKey/hashFields/requiredFields)
    // and retaining it pinned the resolved schema graph in memory for the
    // plan's lifetime (~2x plan memory). buildPlan still resolves the $ref
    // internally to run primary-key auto-detection (§4.5) correctly — that
    // behavior is unchanged and asserted below — it just no longer stores
    // the resolved schema onto the plan. SPEC §4.1.1 already documents
    // itemSchema as non-normative and MAY be omitted, so this is valid.
    const schema = {
      definitions: {
        user: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
          },
        },
      },
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            $ref: "#/definitions/user",
          },
        },
      },
    };
    const plan = buildPlan({ schema });
    const arrayPlan = plan.get("/users");
    // $ref resolution still worked (primary key found through the ref).
    expect(arrayPlan?.primaryKey).toBe("id");
    expect(arrayPlan?.strategy).toBe("primaryKey");
    // ...but the resolved schema itself is no longer retained on the plan.
    expect(arrayPlan?.itemSchema).toBeUndefined();
  });
});

describe("JsonSchemaPatcher", () => {
  it("should match snapshot for schema.json", () => {
    const schema = require("../schema/schema.json");
    const plan = buildPlan({ schema });
    expect(plan).toMatchSnapshot();
  });
});

describe("JsonSchemaPatcher constructor validation (F42)", () => {
  it("throws an actionable TypeError (not a cryptic one) when plan is undefined", () => {
    expect(() => new JsonSchemaPatcher({ plan: undefined as any })).toThrow(
      TypeError
    );
    try {
      new JsonSchemaPatcher({ plan: undefined as any });
      throw new Error("expected constructor to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      const message = (e as TypeError).message;
      // Actionable: names buildPlan() and the schemaless `new Map()` escape hatch.
      expect(message).toContain("buildPlan");
      expect(message).toContain("new Map()");
    }
  });

  it("throws when options itself is missing entirely", () => {
    expect(() => new JsonSchemaPatcher({} as any)).toThrow(TypeError);
  });

  it("throws when plan is a plain object instead of a Map", () => {
    expect(() => new JsonSchemaPatcher({ plan: {} as any })).toThrow(TypeError);
  });

  it("accepts an empty Map for documented schemaless mode", () => {
    expect(() => new JsonSchemaPatcher({ plan: new Map() })).not.toThrow();
    const patcher = new JsonSchemaPatcher({ plan: new Map() });
    const patch = patcher.execute({
      original: { a: 1 },
      modified: { a: 2 },
    });
    expect(patch).toEqual([
      { op: "replace", path: "/a", value: 2, oldValue: 1 },
    ]);
  });

  it("accepts a real buildPlan() Map", () => {
    const plan = buildPlan({
      schema: { type: "object", properties: { a: { type: "number" } } } as any,
    });
    expect(() => new JsonSchemaPatcher({ plan })).not.toThrow();
  });
});

test("JsonSchemaPatcher generates correct patches for array with primary key", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
          {
            id: "service2",
            name: "worker",
            type: "worker",
            cpu: 0.5,
            memory: 1,
          },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
          {
            id: "service3",
            name: "new-worker",
            type: "worker",
            cpu: 1,
            memory: 2,
          },
        ],
      },
    ],
  };

  const plan = buildPlan({ schema });
  const patcher = new JsonSchemaPatcher({ plan });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  const expectedPatches: Operation[] = [
    {
      op: "remove",
      path: "/environments/0/services/1",
      oldValue: doc1.environments[0]?.services[1],
    },
    {
      op: "replace",
      path: "/environments/0/services/0/cpu",
      value: 2,
      oldValue: 1,
    },
    {
      op: "add",
      path: "/environments/0/services/-",
      value: {
        id: "service3",
        name: "new-worker",
        type: "worker",
        cpu: 1,
        memory: 2,
      },
    },
  ];

  // Sort patches by path to ensure deterministic comparison
  const sortFn = (a: any, b: any) => a.path.localeCompare(b.path);
  patches.sort(sortFn);
  expectedPatches.sort(sortFn);

  expect(patches).toEqual(expectedPatches);
});

test("JsonSchemaPatcher handles empty arrays correctly", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
        ],
      },
    ],
  };

  const patcher = new JsonSchemaPatcher({ plan: buildPlan({ schema }) });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  const expectedPatches: Operation[] = [
    {
      op: "add",
      path: "/environments/0/services/-",
      value: { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
    },
  ];

  expect(patches).toEqual(expectedPatches);
});

test("JsonSchemaPatcher handles array with all items removed", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
          {
            id: "service2",
            name: "worker",
            type: "worker",
            cpu: 0.5,
            memory: 1,
          },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [],
      },
    ],
  };

  const patcher = new JsonSchemaPatcher({ plan: buildPlan({ schema }) });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  const expectedPatches: Operation[] = [
    {
      op: "remove",
      path: "/environments/0/services/1",
      oldValue: doc1.environments[0]?.services[1],
    },
    {
      op: "remove",
      path: "/environments/0/services/0",
      oldValue: doc1.environments[0]?.services[0],
    },
  ];

  expect(patches).toEqual(expectedPatches);
});

test("JsonSchemaPatcher handles no changes", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
        ],
      },
    ],
  };

  const patcher = new JsonSchemaPatcher({ plan: buildPlan({ schema }) });
  const patches = patcher.execute({ original: doc1, modified: doc1 });
  expect(patches).toEqual([]);
});

test("JsonSchemaPatcher handles array without primary key (fallback)", () => {
  // We'll test this on a property that is an array of strings
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          {
            id: "service1",
            name: "api",
            type: "web",
            cpu: 1,
            memory: 2,
            dependsOn: ["a", "b"],
          },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          {
            id: "service1",
            name: "api",
            type: "web",
            cpu: 1,
            memory: 2,
            dependsOn: ["a", "c", "d"],
          },
        ],
      },
    ],
  };

  const patcher = new JsonSchemaPatcher({ plan: buildPlan({ schema }) });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  const expectedPatches: Operation[] = [
    {
      op: "replace",
      path: "/environments/0/services/0/dependsOn/1",
      value: "c",
      oldValue: "b",
    },
    { op: "add", path: "/environments/0/services/0/dependsOn/-", value: "d" },
  ];

  // The unique/lcs algorithm is not stable for where it adds items, so we check for presence
  // instead of exact equality
  expect(patches).toMatchInlineSnapshot(`
    [
      {
        "oldValue": "b",
        "op": "replace",
        "path": "/environments/0/services/0/dependsOn/1",
        "value": "c",
      },
      {
        "op": "add",
        "path": "/environments/0/services/0/dependsOn/2",
        "value": "d",
      },
    ]
  `);
});

test("JsonSchemaPatcher works with a pre-built plan", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
        ],
      },
    ],
  };

  const plan = buildPlan({ schema });
  const patcher = new JsonSchemaPatcher({ plan });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  const expectedPatches: Operation[] = [
    {
      op: "replace",
      path: "/environments/0/services/0/cpu",
      value: 2,
      oldValue: 1,
    },
  ];

  expect(patches).toEqual(expectedPatches);
});

test("JsonSchemaPatcher handles real-world schema and data", () => {
  // Use the actual schema and a test data file
  const doc1 = JSON.parse(JSON.stringify(require("../schema/test.json")));
  const doc2 = JSON.parse(JSON.stringify(require("../schema/test.json")));

  // 1. Add a new port to the first service in the first environment
  doc2.environments[0].services[0].ports.push({
    id: "new-port",
    port: 9999,
    protocol: "tcp",
    healthCheck: { type: "tcp" },
  });

  // 2. Remove the second service from the first environment
  doc2.environments[0].services.splice(1, 1);

  // 3. Replace a value in the second environment
  doc2.environments[1].services[0].cpu = 5;

  const plan = buildPlan({ schema });
  const patcher = new JsonSchemaPatcher({ plan });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  expect(patches).toMatchInlineSnapshot(`
    [
      {
        "op": "add",
        "path": "/environments/0/services/0/ports/-",
        "value": {
          "healthCheck": {
            "type": "tcp",
          },
          "id": "new-port",
          "port": 9999,
          "protocol": "tcp",
        },
      },
      {
        "oldValue": {
          "buildType": "fromService",
          "containerImage": {
            "fromService": "nlb-server",
          },
          "containerInsights": false,
          "cpu": 0.25,
          "envVariables": {
            "LOAD_BALANCER_HOST": {
              "fromService": {
                "id": "nlb-server",
                "value": "loadBalancerHost",
              },
            },
          },
          "id": "nlb-client-scheduler",
          "jobs": {
            "nlb-client-test": {
              "schedule": "manual",
              "startCommand": [
                "/bin/sh",
                "-c",
                ". ./certs.env && ./client",
              ],
            },
          },
          "memory": 0.5,
          "name": "NLB Client Scheduler",
          "target": {
            "type": "fargate",
          },
          "type": "scheduler",
          "versionHistoryCount": 10,
        },
        "op": "remove",
        "path": "/environments/0/services/1",
      },
      {
        "oldValue": 1,
        "op": "replace",
        "path": "/environments/1/services/0/cpu",
        "value": 5,
      },
    ]
  `);
});

test("JsonSchemaPatcher handles multiple removals from array with primary key", () => {
  const doc1 = {
    $schema: "https://app.flightcontrol.dev/schema.json",
    environments: [
      {
        id: "production",
        name: "NLB",
        region: "eu-west-1",
        source: {
          branch: "main",
          pr: false,
          trigger: "push",
        },
        services: [
          {
            id: "nlb-server",
            name: "NLB Server",
            type: "network-server",
            target: {
              type: "fargate",
            },
            ports: [
              {
                id: "tcp-8001",
                port: 8001,
                protocol: "tcp",
                healthCheck: {
                  type: "tcp",
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
                tls: false,
              },
              {
                id: "udp-8002",
                port: 8007,
                protocol: "udp",
                healthCheck: {
                  type: "udp",
                  tcpPort: 8001,
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
              },
            ],
            cpu: 1,
            memory: 2,
            buildType: "docker",
          },
          {
            id: "nlb-server-2",
            name: "NLB Server 2",
            type: "network-server",
            target: {
              type: "fargate",
            },
            ports: [
              {
                id: "tcp-8001",
                port: 8001,
                protocol: "tcp",
                healthCheck: {
                  type: "tcp",
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
                tls: false,
              },
              {
                id: "udp-8002",
                port: 8007,
                protocol: "udp",
                healthCheck: {
                  type: "udp",
                  tcpPort: 8001,
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
              },
            ],
            cpu: 1,
            memory: 2,
            buildType: "docker",
          },
          {
            id: "nlb-client-scheduler",
            name: "NLB Client Scheduler",
            type: "scheduler",
            cpu: 0.25,
            memory: 0.5,
            buildType: "fromService",
          },
        ],
      },
    ],
  };

  const doc2 = {
    $schema: "https://app.flightcontrol.dev/schema.json",
    environments: [
      {
        id: "production",
        name: "NLB",
        region: "eu-west-1",
        source: {
          branch: "main",
          pr: false,
          trigger: "push",
        },
        services: [
          {
            id: "nlb-server-2",
            name: "NLB Server 2",
            type: "network-server",
            target: {
              type: "fargate",
            },
            ports: [
              {
                id: "tcp-8001",
                port: 8001,
                protocol: "tcp",
                healthCheck: {
                  type: "tcp",
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
                tls: false,
              },
              {
                id: "udp-8002",
                port: 8007,
                protocol: "udp",
                healthCheck: {
                  type: "udp",
                  tcpPort: 8001,
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
              },
            ],
            cpu: 1,
            memory: 2,
            buildType: "docker",
          },
        ],
      },
    ],
  };

  const plan = buildPlan({ schema });
  const patcher = new JsonSchemaPatcher({ plan });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  expect(patches).toMatchInlineSnapshot(`
    [
      {
        "oldValue": {
          "buildType": "fromService",
          "cpu": 0.25,
          "id": "nlb-client-scheduler",
          "memory": 0.5,
          "name": "NLB Client Scheduler",
          "type": "scheduler",
        },
        "op": "remove",
        "path": "/environments/0/services/2",
      },
      {
        "oldValue": {
          "buildType": "docker",
          "cpu": 1,
          "id": "nlb-server",
          "memory": 2,
          "name": "NLB Server",
          "ports": [
            {
              "healthCheck": {
                "intervalSecs": 30,
                "timeoutSecs": 5,
                "type": "tcp",
              },
              "id": "tcp-8001",
              "port": 8001,
              "protocol": "tcp",
              "tls": false,
            },
            {
              "healthCheck": {
                "intervalSecs": 30,
                "tcpPort": 8001,
                "timeoutSecs": 5,
                "type": "udp",
              },
              "id": "udp-8002",
              "port": 8007,
              "protocol": "udp",
            },
          ],
          "target": {
            "type": "fargate",
          },
          "type": "network-server",
        },
        "op": "remove",
        "path": "/environments/0/services/0",
      },
    ]
  `);
});

test("JsonSchemaPatcher correctly diffs a single service property", () => {
  const doc1 = {
    id: "nlb-server",
    name: "NLB Server",
    type: "network-server",
    target: {
      type: "fargate",
    },
    ports: [
      {
        id: "tcp-8001",
        port: 8001,
        protocol: "tcp",
        healthCheck: {
          type: "tcp",
          timeoutSecs: 5,
          intervalSecs: 30,
        },
        tls: false,
      },
      {
        id: "udp-8002",
        port: 8007,
        protocol: "udp",
        healthCheck: {
          type: "udp",
          tcpPort: 8001,
          timeoutSecs: 5,
          intervalSecs: 30,
        },
      },
    ],
    cpu: 1,
    memory: 2,
    buildType: "docker",
  };

  const doc2 = {
    id: "nlb-server",
    name: "NLB Servers",
    type: "network-server",
    target: {
      type: "fargate",
    },
    ports: [
      {
        id: "tcp-8001",
        port: 8001,
        protocol: "tcp",
        healthCheck: {
          type: "tcp",
          timeoutSecs: 5,
          intervalSecs: 30,
        },
        tls: false,
      },
      {
        id: "udp-8002",
        port: 8002,
        protocol: "udp",
        healthCheck: {
          type: "udp",
          tcpPort: 8001,
          timeoutSecs: 5,
          intervalSecs: 30,
        },
      },
      {
        id: "http-8004",
        port: 8004,
        protocol: "http",
        healthCheck: {
          type: "http",
          path: "/health",
          timeoutSecs: 5,
          intervalSecs: 30,
        },
        tls: false,
      },
    ],
    cpu: 2,
    memory: 4,
    buildType: "docker",
  };

  const plan = buildPlan({ schema, basePath: "/environments/services" });
  const patcher = new JsonSchemaPatcher({ plan });
  const patches = patcher.execute({ original: doc1, modified: doc2 });

  expect(patches).toMatchInlineSnapshot(`
    [
      {
        "oldValue": "NLB Server",
        "op": "replace",
        "path": "/name",
        "value": "NLB Servers",
      },
      {
        "oldValue": {
          "healthCheck": {
            "intervalSecs": 30,
            "tcpPort": 8001,
            "timeoutSecs": 5,
            "type": "udp",
          },
          "id": "udp-8002",
          "port": 8007,
          "protocol": "udp",
        },
        "op": "remove",
        "path": "/ports/1",
      },
      {
        "op": "add",
        "path": "/ports/-",
        "value": {
          "healthCheck": {
            "intervalSecs": 30,
            "tcpPort": 8001,
            "timeoutSecs": 5,
            "type": "udp",
          },
          "id": "udp-8002",
          "port": 8002,
          "protocol": "udp",
        },
      },
      {
        "op": "add",
        "path": "/ports/-",
        "value": {
          "healthCheck": {
            "intervalSecs": 30,
            "path": "/health",
            "timeoutSecs": 5,
            "type": "http",
          },
          "id": "http-8004",
          "port": 8004,
          "protocol": "http",
          "tls": false,
        },
      },
      {
        "oldValue": 1,
        "op": "replace",
        "path": "/cpu",
        "value": 2,
      },
      {
        "oldValue": 2,
        "op": "replace",
        "path": "/memory",
        "value": 4,
      },
    ]
  `);
});

test("should handle reordering of items in an array with primary keys", () => {
  const plan = buildPlan({ schema: schema as any });
  const patcher = new JsonSchemaPatcher({ plan });

  const doc1 = {
    environments: [
      {
        id: "env1",
        services: [
          { id: "service1", name: "api" },
          { id: "service2", name: "worker" },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        services: [
          { id: "service2", name: "worker" },
          { id: "service1", name: "api" },
        ],
      },
    ],
  };

  const patch = patcher.execute({ original: doc1, modified: doc2 });

  // Reordering items should not produce any patches if primary keys are used for identity.
  expect(patch).toEqual([]);
});

test("should handle changing a primary key of an item in an array", () => {
  const plan = buildPlan({ schema: schema as any });
  const patcher = new JsonSchemaPatcher({ plan });

  const doc1 = {
    environments: [
      {
        id: "env1",
        services: [
          { id: "service1", name: "api" },
          { id: "service2", name: "worker" },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        services: [
          { id: "service1-renamed", name: "api" },
          { id: "service2", name: "worker" },
        ],
      },
    ],
  };

  const patch = patcher.execute({ original: doc1, modified: doc2 });

  // Changing a primary key should be treated as a remove and an add.
  expect(patch).toMatchInlineSnapshot(`
    [
      {
        "oldValue": {
          "id": "service1",
          "name": "api",
        },
        "op": "remove",
        "path": "/environments/0/services/0",
      },
      {
        "op": "add",
        "path": "/environments/0/services/-",
        "value": {
          "id": "service1-renamed",
          "name": "api",
        },
      },
    ]
  `);

  // Now, let's validate the patch application
  const patchedDoc = JSON.parse(JSON.stringify(doc1));

  // Manually apply the remove and add to avoid issues with array index changes
  const itemToAdd = patch.find((p) => p.op === "add")?.value;

  // Remove first by index
  patchedDoc.environments[0].services.splice(0, 1);

  // Add the new item
  if (itemToAdd) {
    patchedDoc.environments[0].services.push(itemToAdd);
  }

  // The end result is not identical, but the items are there, just reordered, which is acceptable for this test.
  // We're mainly testing that the correct 'remove' and 'add' ops are generated.
  expect(patchedDoc.environments[0].services).toHaveLength(2);
  expect(
    patchedDoc.environments[0].services.find(
      (s: any) => s.id === "service1-renamed"
    )
  ).toBeDefined();
});

describe("_resolveRef function", () => {
  test("should resolve valid local references", () => {
    const schema = {
      definitions: {
        user: { type: "object", properties: { name: { type: "string" } } },
      },
    };

    const result = _resolveRef("#/definitions/user", schema);
    expect(result).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
    });
  });

  test("should handle invalid reference format", () => {
    const schema = { type: "object" };
    const consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const result = _resolveRef("http://example.com/schema", schema);
    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "Unsupported reference: http://example.com/schema"
    );

    consoleWarnSpy.mockRestore();
  });

  test("should handle reference to non-existent path", () => {
    const schema = { definitions: { user: { type: "object" } } };
    const result = _resolveRef("#/definitions/nonexistent", schema);
    expect(result).toBeNull();
  });

  test("should handle reference path with null values", () => {
    const schema = { definitions: null };
    const result = _resolveRef("#/definitions/user", schema);
    expect(result).toBeNull();
  });

  test("should handle deep reference paths", () => {
    const schema = {
      definitions: {
        user: {
          properties: {
            address: {
              properties: { city: { type: "string" } },
            },
          },
        },
      },
    };

    const result = _resolveRef(
      "#/definitions/user/properties/address/properties/city",
      schema
    );
    expect(result).toEqual({ type: "string" });
  });

  test("should handle reference with empty path components", () => {
    const schema = { type: "object" };
    // "#/" would split to [""], and accessing schema[""] returns undefined
    const result = _resolveRef("#/", schema);
    expect(result).toBeNull();
  });

  test("should handle reference to root-level property", () => {
    const schema = {
      type: "object",
      properties: {
        users: { type: "array" },
      },
    };
    const result = _resolveRef("#/properties/users", schema);
    expect(result).toEqual({ type: "array" });
  });
});

describe("deepEqual function", () => {
  test("should handle identical references", () => {
    const obj = { a: 1 };
    expect(deepEqual(obj, obj)).toBe(true);
  });

  test("should handle primitive types", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("hello", "hello")).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual("hello", "world")).toBe(false);
  });

  test("should handle null and undefined", () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(null, 0)).toBe(false);
  });

  test("should handle NaN", () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
    expect(deepEqual(NaN, 0)).toBe(false);
  });

  test("should handle different types", () => {
    expect(deepEqual(1, "1")).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });

  test("should handle arrays", () => {
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([], [])).toBe(true);
  });

  test("should handle objects", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true);
    expect(deepEqual({}, {})).toBe(true);
  });

  test("should handle nested structures", () => {
    const obj1 = { a: { b: [1, { c: "test" }] } };
    const obj2 = { a: { b: [1, { c: "test" }] } };
    const obj3 = { a: { b: [1, { c: "different" }] } };

    expect(deepEqual(obj1, obj2)).toBe(true);
    expect(deepEqual(obj1, obj3)).toBe(false);
  });
});

describe("fastHash function", () => {
  test("should generate hash from fields", () => {
    const obj = { id: 1, name: "test", unused: "ignored" };
    const hash = fastHash(obj, ["id", "name"]);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("should handle missing fields", () => {
    const obj = { id: 1 };
    const hash = fastHash(obj, ["id", "missing"]);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("should handle empty fields", () => {
    const obj = { id: 1 };
    const hash = fastHash(obj, []);
    expect(hash).toBe("");
  });

  test("should handle null/undefined values", () => {
    const obj = { id: null, name: undefined };
    const hash = fastHash(obj, ["id", "name"]);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
  });

  test("should produce consistent hashes for same input", () => {
    const obj1 = { id: 1, name: "test" };
    const obj2 = { id: 1, name: "test" };
    const hash1 = fastHash(obj1, ["id", "name"]);
    const hash2 = fastHash(obj2, ["id", "name"]);
    expect(hash1).toBe(hash2);
  });

  test("should produce different hashes for different inputs", () => {
    const obj1 = { id: 1, name: "test" };
    const obj2 = { id: 2, name: "test" };
    const hash1 = fastHash(obj1, ["id", "name"]);
    const hash2 = fastHash(obj2, ["id", "name"]);
    expect(hash1).not.toBe(hash2);
  });
});

describe("_traverseSchema function", () => {
  test("should handle boolean schemas", () => {
    const plan = new Map();
    _traverseSchema(true, "/test", plan, {}, new Set());
    expect(plan.size).toBe(0);

    _traverseSchema(false, "/test", plan, {}, new Set());
    expect(plan.size).toBe(0);
  });

  test("should handle null schemas", () => {
    const plan = new Map();
    _traverseSchema(null as unknown as any, "/test", plan, {}, new Set());
    expect(plan.size).toBe(0);
  });

  test("should handle visited schemas", () => {
    const plan = new Map();
    const schema = { type: "object" };
    const visited = new Set([schema]);

    _traverseSchema(schema, "/test", plan, {}, visited);
    expect(plan.size).toBe(0);
  });

  test("should handle $ref schemas", () => {
    const plan = new Map();
    const schema = {
      definitions: {
        user: { type: "array", items: { type: "string" } },
      },
    };

    _traverseSchema(
      { $ref: "#/definitions/user" },
      "/users",
      plan,
      schema,
      new Set()
    );
    expect(plan.has("/users")).toBe(true);
  });

  test("should handle unresolvable $ref", () => {
    const plan = new Map();
    const schema = {};

    _traverseSchema(
      { $ref: "#/definitions/nonexistent" },
      "/test",
      plan,
      schema,
      new Set()
    );
    expect(plan.size).toBe(0);
  });

  test("should handle anyOf/oneOf/allOf", () => {
    const plan = new Map();
    const schema = {};

    const subSchema = {
      anyOf: [{ type: "array", items: { type: "string" } }],
      oneOf: [{ type: "array", items: { type: "number" } }],
      allOf: [{ type: "object" }],
    };

    _traverseSchema(subSchema, "/test", plan, schema, new Set());
    expect(plan.size).toBeGreaterThan(0);
  });

  test("should handle object properties", () => {
    const plan = new Map();
    const schema = {};

    const subSchema = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
      },
    };

    _traverseSchema(subSchema, "", plan, schema, new Set());
    expect(plan.has("/items")).toBe(true);
  });

  test("should handle additionalProperties", () => {
    const plan = new Map();
    const schema = {};

    const subSchema = {
      type: "object",
      additionalProperties: {
        type: "array",
        items: { type: "string" },
      },
    };

    _traverseSchema(subSchema, "/test", plan, schema, new Set());
    expect(plan.has("/test/*")).toBe(true);
  });

  test("should handle array with primitive items", () => {
    const plan = new Map();
    _traverseSchema(
      { type: "array", items: { type: "string" } },
      "/tags",
      plan,
      {},
      new Set()
    );

    const arrayPlan = plan.get("/tags");
    expect(arrayPlan?.strategy).toBe("unique");
  });

  test("should handle array with object items", () => {
    const plan = new Map();
    const subSchema = {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    };

    _traverseSchema(subSchema, "/users", plan, {}, new Set());
    const arrayPlan = plan.get("/users");
    expect(arrayPlan?.primaryKey).toBe("id");
    expect(arrayPlan?.strategy).toBe("primaryKey");
  });

  test("should handle basePath option", () => {
    const plan = new Map();
    const options = { basePath: "/root" };

    _traverseSchema(
      { type: "array", items: { type: "string" } },
      "/root/items",
      plan,
      {},
      new Set(),
      options
    );
    expect(plan.has("/items")).toBe(true);

    plan.clear();
    _traverseSchema(
      { type: "array", items: { type: "string" } },
      "/other/items",
      plan,
      {},
      new Set(),
      options
    );
    expect(plan.size).toBe(0);
  });

  test("should handle array items with $ref", () => {
    const plan = new Map();
    const schema = {
      definitions: {
        user: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
      },
    };

    const subSchema = {
      type: "array",
      items: { $ref: "#/definitions/user" },
    };

    _traverseSchema(subSchema, "/users", plan, schema, new Set());
    const arrayPlan = plan.get("/users");
    expect(arrayPlan?.primaryKey).toBe("id");
  });

  test("should handle object items without primary key", () => {
    const plan = new Map();
    const subSchema = {
      type: "array",
      items: {
        type: "object",
        properties: { description: { type: "string" } },
      },
    };

    _traverseSchema(subSchema, "/items", plan, {}, new Set());
    const arrayPlan = plan.get("/items");
    expect(arrayPlan?.primaryKey).toBe(null);
    expect(arrayPlan?.strategy).toBe("lcs");
  });

  test("should handle array items with oneOf for primary key detection", () => {
    const s = {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
          {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        ],
      },
    };
    const plan = buildPlan({ schema: s as any });
    const arrayPlan = plan.get("");
    expect(arrayPlan?.primaryKey).toBe("id");
  });
});

describe("JsonSchemaPatcher comprehensive tests", () => {
  test("should handle all diff operations", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map() });

    // Add operation (using the internal diff method since createPatch expects JsonValue)
    const patches1: Operation[] = [];
    (patcher as any).diff(undefined, "new", "", patches1);
    expect(patches1).toEqual([{ op: "add", path: "", value: "new" }]);

    // Remove operation
    const patches2: Operation[] = [];
    (patcher as any).diff("old", undefined, "", patches2);
    expect(patches2).toEqual([{ op: "remove", path: "", oldValue: "old" }]);

    // Replace operation
    const patches3: Operation[] = [];
    (patcher as any).diff("old", "new", "", patches3);
    expect(patches3).toEqual([
      { op: "replace", path: "", value: "new", oldValue: "old" },
    ]);
  });

  test("should handle primary key array diffing", () => {
    const plan = buildPlan({
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" }, name: { type: "string" } },
            },
          },
        },
      },
      primaryKeyMap: { "/items": "id" },
    });
    const patcher = new JsonSchemaPatcher({ plan });

    const doc1 = { items: [{ id: "1", name: "first" }] };
    const doc2 = { items: [{ id: "1", name: "updated" }] };

    const patches = patcher.execute({ original: doc1, modified: doc2 });
    expect(patches).toEqual([
      {
        op: "replace",
        path: "/items/0/name",
        value: "updated",
        oldValue: "first",
      },
    ]);
  });

  test("should handle LCS array diffing", () => {
    const plan = buildPlan({
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
            },
          },
        },
      },
    });
    const patcher = new JsonSchemaPatcher({ plan });
    const doc1 = { items: [{ name: "A" }, { name: "B" }] };
    const doc2 = { items: [{ name: "A" }, { name: "C" }, { name: "B" }] };
    const patches = patcher.execute({ original: doc1, modified: doc2 });
    expect(patches).toEqual([
      { op: "add", path: "/items/1", value: { name: "C" } },
    ]);
  });

  test("should handle mixed array types", () => {
    const plan = buildPlan({
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: [
              { type: "string" },
              { type: "number" },
              { type: "object", properties: { a: { type: "string" } } },
            ] as any,
          },
        },
      },
    });
    const patcher = new JsonSchemaPatcher({ plan });
    const doc1 = { items: ["a", 1, { a: "b" }] };
    const doc2 = { items: ["a", 2, { a: "c" }] };
    const patches = patcher.execute({ original: doc1, modified: doc2 });
    expect(patches).toMatchInlineSnapshot(`
      [
        {
          "oldValue": 1,
          "op": "remove",
          "path": "/items/1",
        },
        {
          "oldValue": {
            "a": "b",
          },
          "op": "replace",
          "path": "/items/1",
          "value": 2,
        },
        {
          "op": "add",
          "path": "/items/2",
          "value": {
            "a": "c",
          },
        },
      ]
    `);
  });

  test("should handle empty arrays", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map() });

    // Empty to filled
    const patches1 = patcher.execute({
      original: { items: [] },
      modified: { items: [{ id: "1" }] },
    });
    expect(patches1).toEqual([
      { op: "add", path: "/items/0", value: { id: "1" } },
    ]);

    // Filled to empty
    const patches2 = patcher.execute({
      original: { items: [{ id: "1" }] },
      modified: { items: [] },
    });
    expect(patches2).toMatchInlineSnapshot(`
      [
        {
          "oldValue": {
            "id": "1",
          },
          "op": "remove",
          "path": "/items/0",
        },
      ]
    `);
  });

  test("should handle complex nested changes", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map() });

    const doc1 = {
      user: {
        profile: { name: "John", settings: { theme: "dark" } },
        posts: [{ title: "First" }],
      },
    };

    const doc2 = {
      user: {
        profile: { name: "Jane", settings: { theme: "light", lang: "en" } },
        posts: [{ title: "Updated" }],
      },
    };

    const patches = patcher.execute({ original: doc1, modified: doc2 });
    expect(
      patches.some((p) => p.path.includes("name") && p.value === "Jane")
    ).toBe(true);
    expect(
      patches.some((p) => p.path.includes("theme") && p.value === "light")
    ).toBe(true);
    expect(
      patches.some((p) => p.path.includes("lang") && p.value === "en")
    ).toBe(true);
  });

  test("should handle diffObject with undefined keys", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map() });

    // Simulate array with sparse elements
    const obj1 = { items: ["a", null, "c"] };
    const obj2 = { items: ["a", "b", "c"] };

    const patches = patcher.execute({ original: obj1, modified: obj2 });
    expect(patches.some((p) => p.value === "b")).toBe(true);
  });

  test("should handle array diffing with parent wildcard path", () => {
    const plan = new Map([
      ["/*", { primaryKey: null, strategy: "lcs" as const }],
    ]);

    const patcher = new JsonSchemaPatcher({ plan });

    const doc1 = { nested: { deep: { items: [1, 2, 3] } } };
    const doc2 = { nested: { deep: { items: [1, 3, 4] } } };

    const patches = patcher.execute({ original: doc1, modified: doc2 });
    expect(patches.length).toBeGreaterThan(0);
  });

  test("should handle primary key arrays with missing or invalid keys", () => {
    const plan = new Map([
      ["/items", { primaryKey: "id", strategy: "primaryKey" as const }],
    ]);

    const patcher = new JsonSchemaPatcher({ plan });

    const doc1 = {
      items: [
        { id: "1", name: "valid" },
        { name: "no-id" }, // Missing primary key
        "not-an-object", // Not an object
        { id: { complex: "key" }, name: "invalid-key-type" }, // Invalid key type
      ],
    };

    const doc2 = {
      items: [
        { id: "1", name: "updated" },
        { id: "2", name: "new" },
      ],
    };

    const patches = patcher.execute({ original: doc1, modified: doc2 });
    expect(patches.length).toBeGreaterThan(0);
  });

  test("should handle hashing optimization in primary key arrays", () => {
    const plan = new Map([
      [
        "/items",
        {
          primaryKey: "id",
          strategy: "primaryKey" as const,
          hashFields: ["id", "category"],
        },
      ],
    ]);

    const patcher = new JsonSchemaPatcher({ plan });

    // Items with same hash but different deep content
    const item1 = { id: "1", category: "A", nested: { value: "old" } };
    const item2 = { id: "1", category: "A", nested: { value: "new" } };

    const doc1 = { items: [item1] };
    const doc2 = { items: [item2] };

    const patches = patcher.execute({ original: doc1, modified: doc2 });
    expect(patches.some((p) => p.path.includes("nested"))).toBe(true);
  });
});

describe("buildPlan function", () => {
  test("should build plan without options", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } },
          },
        },
      },
    };

    const plan = buildPlan({ schema });
    expect(plan.has("/users")).toBe(true);
    expect(plan.get("/users")?.primaryKey).toBe("id");
  });

  test("should build plan with options", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: { customId: { type: "string" } },
          },
        },
      },
    };

    const plan = buildPlan({ schema, primaryKeyMap: { "/users": "customId" } });
    expect(plan.get("/users")?.primaryKey).toBe("customId");
  });

  test("should build plan with basePath", () => {
    const schema = {
      type: "object",
      properties: {
        root: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    };

    const plan = buildPlan({ schema, basePath: "/root" });
    expect(plan.has("/items")).toBe(true);
    expect(plan.has("/root/items")).toBe(false);
  });
});

describe("Array diffing strategies", () => {
  describe("LCS (Longest Common Subsequence) strategy", () => {
    test("should handle basic string array changes", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "lcs" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { items: ["a", "b", "c", "d"] };
      const doc2 = { items: ["a", "x", "c", "e"] };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      // Should generate replace operations for changed elements
      expect(patches).toEqual([
        { op: "replace", path: "/items/1", value: "x", oldValue: "b" },
        { op: "replace", path: "/items/3", value: "e", oldValue: "d" },
      ]);
    });

    test("should handle array insertions and deletions", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "lcs" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { items: ["a", "b", "c"] };
      const doc2 = { items: ["a", "x", "b", "c", "d"] };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      // Should handle insertions efficiently
      expect(patches.some((p) => p.op === "add" && p.value === "x")).toBe(true);
      expect(patches.some((p) => p.op === "add" && p.value === "d")).toBe(true);
    });

    test("should handle complex object arrays with LCS", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "lcs" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = {
        items: [
          { name: "item1", value: 10 },
          { name: "item2", value: 20 },
          { name: "item3", value: 30 },
        ],
      };
      const doc2 = {
        items: [
          { name: "item1", value: 15 }, // modified
          { name: "new", value: 25 }, // inserted
          { name: "item3", value: 30 }, // unchanged
        ],
      };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      // §5.5.4.2 granular descent (F10): whenever the LCS window collapses a
      // remove+add into a replace of two same-kind objects, the differ recurses
      // and emits FIELD-level ops (paths like `/items/N/<field>`) instead of a
      // whole-item object replace. The exact Myers alignment is generator-
      // defined (§1.3), so assert the granular *shape* rather than one alignment:
      // at least one field-level replace is emitted...
      expect(
        patches.some((p) => /^\/items\/\d+\/[^/]+$/.test(p.path))
      ).toBe(true);
      // ...and no `replace` op carries a whole object value (the pre-F10 bloat).
      expect(
        patches.some(
          (p) =>
            p.op === "replace" &&
            typeof p.value === "object" &&
            p.value !== null
        )
      ).toBe(false);
      // The whole diff still round-trips under strict sequential application.
      const applied = applySchemaPatch(structuredClone(doc1) as any, patches);
      expect(applied).toEqual(doc2);
    });

    test("should handle empty to non-empty arrays", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "lcs" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { items: [] };
      const doc2 = { items: ["a", "b", "c"] };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      expect(patches.every((p) => p.op === "add")).toBe(true);
      expect(patches).toHaveLength(3);
    });
  });

  describe("LCS common prefix/suffix trimming (§5.5.0, F09)", () => {
    const lcsPatcher = () =>
      new JsonSchemaPatcher({
        plan: new Map([
          ["/items", { primaryKey: null, strategy: "lcs" as const }],
        ]),
      });

    const roundtrips = (a: any[], b: any[]) => {
      const patches = lcsPatcher().execute({
        original: { items: a } as any,
        modified: { items: b } as any,
      });
      const applied = applySchemaPatch(
        structuredClone({ items: a }) as any,
        patches
      );
      expect(applied).toEqual({ items: b });
      return patches;
    };

    test("all-equal arrays emit no ops", () => {
      const patches = roundtrips(
        ["a", "b", "c", "d"],
        ["a", "b", "c", "d"]
      );
      expect(patches).toHaveLength(0);
    });

    test("pure append emits only ascending adds at the tail", () => {
      const patches = roundtrips(["a", "b", "c"], ["a", "b", "c", "d", "e"]);
      expect(patches).toEqual([
        { op: "add", path: "/items/3", value: "d" },
        { op: "add", path: "/items/4", value: "e" },
      ]);
    });

    test("pure prepend emits only ascending adds at the head", () => {
      const patches = roundtrips(["c", "d"], ["a", "b", "c", "d"]);
      expect(patches).toEqual([
        { op: "add", path: "/items/0", value: "a" },
        { op: "add", path: "/items/1", value: "b" },
      ]);
    });

    test("pure truncate emits only descending removes", () => {
      const patches = roundtrips(["a", "b", "c", "d"], ["a", "b"]);
      expect(patches).toEqual([
        { op: "remove", path: "/items/3", oldValue: "d" },
        { op: "remove", path: "/items/2", oldValue: "c" },
      ]);
    });

    test("single interior edit only touches the changed window", () => {
      const a = Array.from({ length: 200 }, (_, i) => `x${i}`);
      const b = [...a];
      b[100] = "CHANGED";
      const patches = roundtrips(a, b);
      expect(patches).toEqual([
        { op: "replace", path: "/items/100", value: "CHANGED", oldValue: "x100" },
      ]);
    });

    test("prefix is trimmed before suffix ([a,b,a] -> [a,a])", () => {
      // Deterministic per §5.5.0.1: prefix 'a' (lo=1) then suffix 'a' (hi=1),
      // leaving window [b] -> [] and a single remove at the prefix boundary.
      const patches = roundtrips(["a", "b", "a"], ["a", "a"]);
      expect(patches).toEqual([
        { op: "remove", path: "/items/1", oldValue: "b" },
      ]);
    });

    test("overlapping prefix/suffix candidates still round-trip ([a,a,a] -> [a])", () => {
      const patches = roundtrips(["a", "a", "a"], ["a"]);
      expect(patches).toHaveLength(2);
      expect(patches.every((p) => p.op === "remove")).toBe(true);
    });

    test("disjoint arrays round-trip (deep backtrack, band-trace indexing F08)", () => {
      // Fully disjoint: no common prefix/suffix, large edit distance D≈2*len,
      // so backtracking walks every stored V-band — guards the O(D²) band
      // indexing against the old full-buffer copy.
      const a = Array.from({ length: 400 }, (_, i) => `A-${i}`);
      const b = Array.from({ length: 400 }, (_, i) => `B-${i}`);
      const patches = roundtrips(a, b);
      // Every element differs: 400 replaces (collapsed remove+add) round-trip.
      expect(patches.length).toBeGreaterThan(0);
    });

    test("many scattered interior edits round-trip", () => {
      const a = Array.from({ length: 600 }, (_, i) => i);
      const b = a.map((v, i) => (i % 7 === 0 ? v + 10000 : v));
      roundtrips(a, b);
    });

    test("object elements with reordered keys are common, not changed (F21 canonical fingerprint)", () => {
      // §2.4.2: object equality is key-order-insensitive. Canonical (key-sorted)
      // interning must treat these as identical -> zero ops.
      const a = [
        { id: 1, name: "x", tags: ["p", "q"] },
        { id: 2, name: "y" },
      ];
      const b = [
        { name: "x", tags: ["p", "q"], id: 1 },
        { name: "y", id: 2 },
      ];
      const patches = roundtrips(a, b);
      expect(patches).toHaveLength(0);
    });

    test("f64-equal numbers intern equal (1 vs 1.0), array order-sensitive", () => {
      // 1 and 1.0 are the same f64 (§2.2) -> same fingerprint -> common.
      expect(roundtrips([1, 2, 3], [1.0, 2.0, 3.0])).toHaveLength(0);
      // But array order matters (§2.4.2): [1,2] != [2,1] within an element.
      const patches = roundtrips([{ v: [1, 2] }], [{ v: [2, 1] }]);
      expect(patches.length).toBeGreaterThan(0);
    });

    test("a single changed object element in a long common run round-trips", () => {
      const mk = (i: number, val: number) => ({ id: i, payload: `p${i}`, val });
      const a = Array.from({ length: 300 }, (_, i) => mk(i, i));
      const b = a.map((o, i) => (i === 150 ? mk(150, 99999) : o));
      const patches = roundtrips(a, b);
      // Only element 150 changed; the interned run trims to a 1-element window.
      // §5.5.4.2 granular descent (F10): the collapsed replace pair are both
      // plain objects, so the differ recurses into the item and emits a
      // field-level op for the single changed field (`val`) rather than a
      // whole-item replace carrying the full new object + oldValue.
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({
        op: "replace",
        path: "/items/150/val",
        value: 99999,
        oldValue: 150,
      });
    });

    test("70k-element single-edit array round-trips (regression, no cliff)", () => {
      const a = Array.from({ length: 70000 }, (_, i) => i);
      const b = [...a];
      b[65536] = -1; // past the old 65535 packing cliff
      const patches = lcsPatcher().execute({
        original: { items: a },
        modified: { items: b },
      });
      expect(patches).toEqual([
        { op: "replace", path: "/items/65536", value: -1, oldValue: 65536 },
      ]);
      const applied = applySchemaPatch(
        structuredClone({ items: a }) as any,
        patches
      );
      expect(applied).toEqual({ items: b });
    });
  });

  describe("LCS granular descent into changed items (§5.5.4.2, F10)", () => {
    const lcsPatcher = () =>
      new JsonSchemaPatcher({
        plan: new Map([
          ["/items", { primaryKey: null, strategy: "lcs" as const }],
        ]),
      });

    // A ~600B object item with no key field (LCS default strategy).
    const bigItem = (bio: string) => ({
      slug: "the-quick-brown-fox-jumps",
      title: "A Reasonably Long Human Readable Title For This Record",
      bio,
      tags: ["alpha", "beta", "gamma", "delta", "epsilon"],
      meta: {
        createdAt: "2024-01-02T03:04:05.000Z",
        updatedAt: "2024-06-07T08:09:10.000Z",
        author: "Jane Q. Public",
        revision: 7,
      },
      score: 42,
    });

    test("single-field change in an object item emits a granular nested replace, not a whole-item replace (byte win vs 23x audit baseline)", () => {
      const longBio =
        "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do " +
        "eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim " +
        "ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut " +
        "aliquip ex ea commodo consequat. Duis aute irure dolor in " +
        "reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla " +
        "pariatur. Excepteur sint occaecat cupidatat non proident.";
      const items = Array.from({ length: 10 }, () => bigItem(longBio));
      const doc1 = { items: structuredClone(items) };
      const doc2 = structuredClone(doc1);
      // One scalar field on one item changes.
      (doc2.items[4] as any).score = 43;

      // Each item is roughly ~600 bytes.
      const itemBytes = JSON.stringify(items[0]).length;
      expect(itemBytes).toBeGreaterThan(500);

      const patches = lcsPatcher().execute({ original: doc1, modified: doc2 });

      // Exactly one granular op targeting the changed field, no whole item.
      expect(patches).toEqual([
        { op: "replace", path: "/items/4/score", value: 43, oldValue: 42 },
      ]);

      // Byte proof: granular patch vs the whole-item replace the pre-F10 code
      // emitted (full value + full oldValue). Audit baseline was ~1252B (23x);
      // the granular op is an order of magnitude smaller.
      const granularBytes = JSON.stringify(patches).length;
      const wholeItemBytes = JSON.stringify([
        {
          op: "replace",
          path: "/items/4",
          value: doc2.items[4],
          oldValue: doc1.items[4],
        },
      ]).length;
      expect(wholeItemBytes).toBeGreaterThan(1200); // matches ~1252B audit baseline
      expect(granularBytes).toBeLessThan(80);
      expect(granularBytes * 15).toBeLessThan(wholeItemBytes); // >15x smaller

      // Round-trips.
      const applied = applySchemaPatch(structuredClone(doc1) as any, patches);
      expect(applied).toEqual(doc2);
    });

    test("changed nested arrays inside an lcs item descend (array-of-arrays)", () => {
      // Outer array of objects (lcs); each object holds a `rows` array.
      const doc1 = {
        items: [
          { id: "a", rows: [1, 2, 3] },
          { id: "b", rows: [4, 5, 6] },
        ],
      };
      const doc2 = {
        items: [
          { id: "a", rows: [1, 2, 3] },
          { id: "b", rows: [4, 5, 7] }, // one nested element changes
        ],
      };
      const patches = lcsPatcher().execute({ original: doc1, modified: doc2 });
      // Granular descent recurses through the object into the nested array and
      // emits a single element-level op, not a whole-item object replace.
      expect(patches).toEqual([
        { op: "replace", path: "/items/1/rows/2", value: 7, oldValue: 6 },
      ]);
      const applied = applySchemaPatch(structuredClone(doc1) as any, patches);
      expect(applied).toEqual(doc2);
    });

    test("array-typed items descend granularly through the nested-array wildcard plan", () => {
      // Array-of-arrays: outer `/matrix` is lcs (elements are arrays); the inner
      // array is registered at the wildcard element path `/matrix/*`. A collapsed
      // replace of two array elements must recurse into that wildcard plan.
      const schema = {
        type: "object",
        properties: {
          matrix: {
            type: "array",
            items: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            },
          },
        },
      };
      const patcher = new JsonSchemaPatcher({
        plan: buildPlan({ schema: schema as any }),
      });
      const doc1 = { matrix: [[{ id: "a", v: 1 }], [{ id: "b", v: 2 }]] };
      const doc2 = { matrix: [[{ id: "a", v: 1 }], [{ id: "b", v: 9 }]] };
      const patches = patcher.execute({ original: doc1, modified: doc2 });
      // Descends outer lcs -> inner primaryKey plan (`/matrix/*`, keyed by id) ->
      // granular field op. No whole-array or whole-item replace.
      expect(patches.some((p) => typeof p.value === "object")).toBe(false);
      expect(patches).toContainEqual({
        op: "replace",
        path: "/matrix/1/0/v",
        value: 9,
        oldValue: 2,
      });
      const applied = applySchemaPatch(structuredClone(doc1) as any, patches);
      expect(applied).toEqual(doc2);
    });

    test("primitive replace stays a whole-item replace (no descent)", () => {
      const doc1 = { items: ["a", "b", "c"] };
      const doc2 = { items: ["a", "X", "c"] };
      const patches = lcsPatcher().execute({ original: doc1, modified: doc2 });
      expect(patches).toEqual([
        { op: "replace", path: "/items/1", value: "X", oldValue: "b" },
      ]);
      const applied = applySchemaPatch(structuredClone(doc1) as any, patches);
      expect(applied).toEqual(doc2);
    });

    test("mismatched container kind (object vs array) stays a whole-item replace", () => {
      const doc1 = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      const doc2 = { items: [{ id: 1 }, [9, 9], { id: 3 }] };
      const patches = lcsPatcher().execute({ original: doc1, modified: doc2 });
      // object -> array is a type change; no granular descent, whole replace.
      expect(patches).toEqual([
        { op: "replace", path: "/items/1", value: [9, 9], oldValue: { id: 2 } },
      ]);
      const applied = applySchemaPatch(structuredClone(doc1) as any, patches);
      expect(applied).toEqual(doc2);
    });
  });

  describe("unique (Longest Increasing Subsequence) strategy", () => {
    test("should be selected for primitive arrays", () => {
      const schema = {
        type: "object",
        properties: {
          numbers: {
            type: "array",
            items: { type: "number" },
          },
          strings: {
            type: "array",
            items: { type: "string" },
          },
          booleans: {
            type: "array",
            items: { type: "boolean" },
          },
        },
      };

      const plan = buildPlan({ schema });

      expect(plan.get("/numbers")?.strategy).toBe("unique");
      expect(plan.get("/strings")?.strategy).toBe("unique");
      expect(plan.get("/booleans")?.strategy).toBe("unique");
    });

    test("should handle number array reordering efficiently", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "unique" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { items: [1, 2, 3, 4, 5] };
      const doc2 = { items: [1, 3, 2, 4, 6] }; // reordered + changed

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      // Should generate efficient patches for reordering
      expect(patches.some((p) => p.value === 6)).toBe(true);
      expect(patches.length).toBeGreaterThan(0);
    });

    test("should handle string array with duplicates removal", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "unique" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { items: ["a", "b", "b", "c", "d"] };
      const doc2 = { items: ["a", "b", "c", "e"] };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      expect(patches.some((p) => p.op === "remove")).toBe(true);
      expect(patches.some((p) => p.value === "e")).toBe(true);
    });

    test("should generate replace operations for primitive changes", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "unique" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { items: [1, 2, 3, 4] };
      const doc2 = { items: [1, 5, 3, 6] };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      // Should use replace operations efficiently
      expect(patches.some((p) => p.op === "replace" && p.value === 5)).toBe(
        true
      );
      expect(patches.some((p) => p.op === "replace" && p.value === 6)).toBe(
        true
      );
    });

    test("should handle large primitive arrays efficiently", () => {
      const plan = new Map([
        ["/items", { primaryKey: null, strategy: "unique" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { items: Array.from({ length: 1000 }, (_, i) => i) };
      const doc2 = {
        items: Array.from({ length: 1000 }, (_, i) => (i === 500 ? 9999 : i)),
      };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      // Should generate minimal patches
      expect(patches).toHaveLength(1);
      expect(patches[0]).toEqual({
        op: "replace",
        path: "/items/500",
        value: 9999,
        oldValue: 500,
      });
    });

    test("should handle boolean arrays", () => {
      const plan = new Map([
        ["/flags", { primaryKey: null, strategy: "unique" as const }],
      ]);
      const patcher = new JsonSchemaPatcher({ plan });

      const doc1 = { flags: [true, false, true, false] };
      const doc2 = { flags: [true, true, false, false] };

      const patches = patcher.execute({ original: doc1, modified: doc2 });

      // These arrays are not unique (booleans repeat), so the strategy falls
      // back to LCS. With common prefix/suffix trimming (§5.5.0) the trimmed
      // window is [false,true] -> [true,false]; Myers emits a 2-op script.
      // (Before trimming the same edit distance produced add at /flags/3; the
      // add now lands at /flags/2 — still 2 ops, still an exact round-trip.)
      expect(patches).toHaveLength(2);
      expect(patches).toEqual([
        {
          op: "remove",
          path: "/flags/1",
          oldValue: false,
        },
        {
          op: "add",
          path: "/flags/2",
          value: false,
        },
      ]);
    });
  });

  describe("Strategy selection", () => {
    test("should select primaryKey strategy when available", () => {
      const schema = {
        type: "object",
        properties: {
          users: {
            type: "array",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
        },
      };

      const plan = buildPlan({ schema });
      expect(plan.get("/users")?.strategy).toBe("primaryKey");
      expect(plan.get("/users")?.primaryKey).toBe("id");
    });

    test("should select unique strategy for primitive arrays", () => {
      const schema = {
        type: "object",
        properties: {
          numbers: {
            type: "array",
            items: { type: "number" },
          },
        },
      };

      const plan = buildPlan({ schema });
      expect(plan.get("/numbers")?.strategy).toBe("unique");
    });

    test("should fallback to lcs for complex arrays without primary keys", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                value: { type: "number" },
              },
            },
          },
        },
      };

      const plan = buildPlan({ schema });
      expect(plan.get("/items")?.strategy).toBe("lcs");
    });

    test("should override strategy with custom primaryKeyMap", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                customId: { type: "string" },
                data: { type: "string" },
              },
            },
          },
        },
      };

      const plan = buildPlan({
        schema,
        primaryKeyMap: { "/items": "customId" },
      });

      expect(plan.get("/items")?.strategy).toBe("primaryKey");
      expect(plan.get("/items")?.primaryKey).toBe("customId");
    });

    test("should handle mixed array types in schema", () => {
      const schema = {
        type: "object",
        properties: {
          primitives: {
            type: "array",
            items: { type: "string" },
          },
          objects: {
            type: "array",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string" },
                name: { type: "string" },
              },
            },
          },
          complex: {
            type: "array",
            items: {
              type: "object",
              properties: {
                data: { type: "string" },
              },
            },
          },
        },
      };

      const plan = buildPlan({ schema });

      expect(plan.get("/primitives")?.strategy).toBe("unique");
      expect(plan.get("/objects")?.strategy).toBe("primaryKey");
      expect(plan.get("/complex")?.strategy).toBe("lcs");
    });
  });

  describe("Strategy performance comparison", () => {
    test("should demonstrate unique performance advantage for primitive arrays", () => {
      const largeArray = Array.from({ length: 1000 }, (_, i) => `item-${i}`);
      const modifiedArray = [...largeArray];
      modifiedArray[500] = "modified-item";

      const uniqueplan = new Map([
        ["/items", { primaryKey: null, strategy: "unique" as const }],
      ]);
      const lcsplan = new Map([
        ["/items", { primaryKey: null, strategy: "lcs" as const }],
      ]);

      const uniquePatcher = new JsonSchemaPatcher({ plan: uniqueplan as any });
      const lcsPatcher = new JsonSchemaPatcher({ plan: lcsplan as any });

      const doc1 = { items: largeArray };
      const doc2 = { items: modifiedArray };

      const uniquePatches = uniquePatcher.execute({
        original: doc1,
        modified: doc2,
      });
      const lcsPatches = lcsPatcher.execute({ original: doc1, modified: doc2 });

      // Both should produce the same result
      expect(uniquePatches).toEqual(lcsPatches);
      expect(uniquePatches).toHaveLength(1);
      expect(uniquePatches).toMatchInlineSnapshot(`
        [
          {
            "oldValue": "item-500",
            "op": "replace",
            "path": "/items/500",
            "value": "modified-item",
          },
        ]
      `);
    });
  });
});

describe("primaryKey applicability gate (SPEC §5.4.3, F05/F06)", () => {
  const keyedSchema = {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
  };

  function patcherFor(s: any) {
    return new JsonSchemaPatcher({ plan: buildPlan({ schema: s }) });
  }

  it("selects the primaryKey strategy when the gate passes (sanity)", () => {
    const plan = buildPlan({ schema: keyedSchema });
    expect(plan.get("/users")?.strategy).toBe("primaryKey");
    expect(plan.get("/users")?.primaryKey).toBe("id");
  });

  it("F05: adding a keyless item falls back to LCS and round-trips", () => {
    const patcher = patcherFor(keyedSchema);
    const original = { users: [{ id: "a", name: "A" }] };
    const modified = {
      users: [{ id: "a", name: "A" }, { name: "no-id-yet" }],
    };
    const patches = patcher.execute({ original, modified });
    // At HEAD the keyless item was silently skipped -> the add was lost.
    expect(patches.length).toBeGreaterThan(0);
    expect(applySchemaPatch(original, patches)).toEqual(modified);
  });

  it("F05: removing a keyless item falls back to LCS and round-trips", () => {
    const patcher = patcherFor(keyedSchema);
    const original = {
      users: [{ id: "a", name: "A" }, { name: "no-id-yet" }],
    };
    const modified = { users: [{ id: "a", name: "A" }] };
    const patches = patcher.execute({ original, modified });
    // At HEAD the keyless item was silently skipped -> resurrected on apply.
    expect(patches.length).toBeGreaterThan(0);
    expect(applySchemaPatch(original, patches)).toEqual(modified);
  });

  it("F05: a string element in a keyed array falls back to LCS and round-trips", () => {
    const patcher = patcherFor(keyedSchema);
    const original = { users: [{ id: "a", name: "A" }] };
    const modified = { users: [{ id: "a", name: "A" }, "just-a-string"] };
    const patches = patcher.execute({ original, modified });
    // At HEAD the non-object element was silently skipped -> patches empty.
    expect(patches.length).toBeGreaterThan(0);
    expect(applySchemaPatch(original, patches)).toEqual(modified);
  });

  it("F05: an item whose key is null falls back to LCS and round-trips", () => {
    const patcher = patcherFor(keyedSchema);
    const original = { users: [{ id: "a", name: "A" }] };
    const modified = {
      users: [{ id: "a", name: "A" }, { id: null, name: "B" }],
    };
    const patches = patcher.execute({ original, modified });
    expect(patches.length).toBeGreaterThan(0);
    expect(applySchemaPatch(original, patches)).toEqual(modified);
  });

  it("F06: identical arrays with duplicate keys produce zero patches", () => {
    const patcher = patcherFor(keyedSchema);
    const shape = {
      users: [
        { id: "u1", name: "a" },
        { id: "u1", name: "b" },
      ],
    };
    // Fresh deep copies so no reference-equality shortcut masks the bug.
    const original = JSON.parse(JSON.stringify(shape));
    const modified = JSON.parse(JSON.stringify(shape));
    const patches = patcher.execute({ original, modified });
    // At HEAD the last-write-wins index corrupted the diff, emitting a
    // mutating patch that grew the array even for identical content.
    expect(patches).toEqual([]);
  });

  it("F06: changed duplicate-key arrays fall back to LCS and round-trip", () => {
    const patcher = patcherFor(keyedSchema);
    const original = {
      users: [
        { id: "u1", name: "a" },
        { id: "u1", name: "b" },
      ],
    };
    const modified = {
      users: [
        { id: "u1", name: "a" },
        { id: "u1", name: "c" },
      ],
    };
    const patches = patcher.execute({ original, modified });
    expect(patches.length).toBeGreaterThan(0);
    expect(applySchemaPatch(original, patches)).toEqual(modified);
  });

  it("gate is not bypassed by a primaryKeyMap override (duplicate keys -> LCS)", () => {
    const plan = buildPlan({
      schema: keyedSchema,
      primaryKeyMap: { "/users": "id" },
    });
    const patcher = new JsonSchemaPatcher({ plan });
    const original = {
      users: [
        { id: "u1", v: 1 },
        { id: "u1", v: 2 },
      ],
    };
    const modified = {
      users: [
        { id: "u1", v: 1 },
        { id: "u1", v: 9 },
      ],
    };
    const patches = patcher.execute({ original, modified });
    expect(patches.length).toBeGreaterThan(0);
    expect(applySchemaPatch(original, patches)).toEqual(modified);
  });
});

describe("large-array op emission uses loops, not spread pushes (F13)", () => {
  const keyedSchema = {
    type: "object",
    properties: {
      users: {
        type: "array",
        items: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
          },
        },
      },
    },
  };

  it("clearing a very large keyed array does not RangeError and is correct", () => {
    // At HEAD emission ended in `patches.push(...removalPatches)`; spread
    // arguments are passed on the call stack, so under bun this throws
    // RangeError past ~630k args (the threshold is lower under a deeper test
    // stack, and ~125k on Node). The plain-loop emission must handle it.
    // Verify count + a spot index without a full 800k apply (keep runtime sane).
    const N = 800000;
    const users = new Array(N);
    for (let i = 0; i < N; i++) users[i] = { id: `u${i}`, name: `n${i}` };
    const patcher = new JsonSchemaPatcher({
      plan: buildPlan({ schema: keyedSchema }),
    });
    const patches = patcher.execute({
      original: { users },
      modified: { users: [] },
    });
    expect(patches).toHaveLength(N);
    // Removals are emitted in descending original-index order.
    expect(patches[0]).toEqual({
      op: "remove",
      path: `/users/${N - 1}`,
      oldValue: { id: `u${N - 1}`, name: `n${N - 1}` },
    });
    expect(patches[N - 1]?.path).toBe("/users/0");
  });
});
