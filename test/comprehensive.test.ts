import { describe, test, expect, spyOn } from "bun:test";
import { 
  buildPlan, 
  SchemaPatcher, 
  _resolveRef, 
  _traverseSchema, 
  deepEqual, 
  fastHash,
  type Operation,
  type BuildPlanOptions 
} from "../src/index";

describe("_resolveRef function", () => {
  test("should resolve valid local references", () => {
    const schema = {
      definitions: {
        user: { type: "object", properties: { name: { type: "string" } } }
      }
    };
    
    const result = _resolveRef("#/definitions/user", schema);
    expect(result).toEqual({
      type: "object",
      properties: { name: { type: "string" } }
    });
  });

  test("should handle invalid reference format", () => {
    const schema = { type: "object" };
    const consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
    
    const result = _resolveRef("http://example.com/schema", schema);
    expect(result).toBeNull();
    expect(consoleWarnSpy).toHaveBeenCalledWith("Unsupported reference: http://example.com/schema");
    
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
              properties: { city: { type: "string" } }
            }
          }
        }
      }
    };
    
    const result = _resolveRef("#/definitions/user/properties/address/properties/city", schema);
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
        users: { type: "array" }
      }
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
    expect(hash).toBe("1|test|");
  });

  test("should handle missing fields", () => {
    const obj = { id: 1 };
    const hash = fastHash(obj, ["id", "missing"]);
    expect(hash).toBe("1|undefined|");
  });

  test("should handle empty fields", () => {
    const obj = { id: 1 };
    const hash = fastHash(obj, []);
    expect(hash).toBe("");
  });

  test("should handle null/undefined values", () => {
    const obj = { id: null, name: undefined };
    const hash = fastHash(obj, ["id", "name"]);
    expect(hash).toBe("null|undefined|");
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
        user: { type: "array", items: { type: "string" } }
      }
    };
    
    _traverseSchema({ $ref: "#/definitions/user" }, "/users", plan, schema, new Set());
    expect(plan.has("/users")).toBe(true);
  });

  test("should handle unresolvable $ref", () => {
    const plan = new Map();
    const schema = {};
    
    _traverseSchema({ $ref: "#/definitions/nonexistent" }, "/test", plan, schema, new Set());
    expect(plan.size).toBe(0);
  });

  test("should handle anyOf/oneOf/allOf", () => {
    const plan = new Map();
    const schema = {};
    
    const subSchema = {
      anyOf: [{ type: "array", items: { type: "string" } }],
      oneOf: [{ type: "array", items: { type: "number" } }],
      allOf: [{ type: "object" }]
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
        items: { type: "array", items: { type: "string" } }
      }
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
        items: { type: "string" }
      }
    };
    
    _traverseSchema(subSchema, "/test", plan, schema, new Set());
    expect(plan.has("/test/*")).toBe(true);
  });

  test("should handle array with primitive items", () => {
    const plan = new Map();
    _traverseSchema({ type: "array", items: { type: "string" } }, "/tags", plan, {}, new Set());
    
    const arrayPlan = plan.get("/tags");
    expect(arrayPlan?.isPrimitiveItems).toBe(true);
    expect(arrayPlan?.strategy).toBe("lcs");
  });

  test("should handle array with object items", () => {
    const plan = new Map();
    const subSchema = {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, name: { type: "string" } }
      }
    };
    
    _traverseSchema(subSchema, "/users", plan, {}, new Set());
    const arrayPlan = plan.get("/users");
    expect(arrayPlan?.primaryKey).toBe("id");
    expect(arrayPlan?.strategy).toBe("primaryKey");
  });

  test("should handle basePath option", () => {
    const plan = new Map();
    const options = { basePath: "/root" };
    
    _traverseSchema({ type: "array", items: { type: "string" } }, "/root/items", plan, {}, new Set(), options);
    expect(plan.has("/items")).toBe(true);
    
    plan.clear();
    _traverseSchema({ type: "array", items: { type: "string" } }, "/other/items", plan, {}, new Set(), options);
    expect(plan.size).toBe(0);
  });

  test("should handle array items with $ref", () => {
    const plan = new Map();
    const schema = {
      definitions: {
        user: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } }
        }
      }
    };
    
    const subSchema = {
      type: "array",
      items: { $ref: "#/definitions/user" }
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
        properties: { description: { type: "string" } }
      }
    };
    
    _traverseSchema(subSchema, "/items", plan, {}, new Set());
    const arrayPlan = plan.get("/items");
    expect(arrayPlan?.primaryKey).toBe(null);
    expect(arrayPlan?.strategy).toBe("lcs");
  });

  test("should handle array items with oneOf for primary key detection", () => {
    const plan = new Map();
    const subSchema = {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string" } }
          },
          {
            type: "object", 
            required: ["name"],
            properties: { name: { type: "string" } }
          }
        ]
      }
    } as any;
    
    _traverseSchema(subSchema, "/items", plan, {}, new Set());
    const arrayPlan = plan.get("/items");
    expect(arrayPlan?.primaryKey).toBe("id");
  });
});

describe("SchemaPatcher comprehensive tests", () => {
  test("should handle all diff operations", () => {
    const patcher = new SchemaPatcher({ plan: new Map() });
    
    // Add operation (using the internal diff method since createPatch expects JsonValue)
    const patches1: Operation[] = [];
    (patcher as any).diff(undefined, "new", "", patches1);
    expect(patches1).toEqual([{ op: "add", path: "", value: "new" }]);
    
    // Remove operation
    const patches2: Operation[] = [];
    (patcher as any).diff("old", undefined, "", patches2);
    expect(patches2).toEqual([{ op: "remove", path: "" }]);
    
    // Replace operation
    expect(patcher.createPatch("old", "new")).toEqual([
      { op: "replace", path: "", value: "new" }
    ]);
    
    expect(patcher.createPatch(null, "new")).toEqual([
      { op: "replace", path: "", value: "new" }
    ]);
  });

  test("should handle primary key array diffing", () => {
    const plan = new Map([
      ["/items", {
        primaryKey: "id",
        strategy: "primaryKey" as const,
        hashFields: ["id"]
      }]
    ]);
    
    const patcher = new SchemaPatcher({ plan });
    
    const doc1 = { items: [{ id: "1", name: "first" }] };
    const doc2 = { items: [{ id: "1", name: "updated" }] };
    
    const patches = patcher.createPatch(doc1, doc2);
    expect(patches).toEqual([
      { op: "replace", path: "/items/0/name", value: "updated" }
    ]);
  });

  test("should handle LCS array diffing", () => {
    const patcher = new SchemaPatcher({ plan: new Map() });
    
    const doc1 = { items: ["a", "b", "c"] };
    const doc2 = { items: ["a", "x", "c"] };
    
    const patches = patcher.createPatch(doc1, doc2);
    expect(patches.some(p => p.value === "x")).toBe(true);
  });

  test("should handle mixed array types", () => {
    const patcher = new SchemaPatcher({ plan: new Map() });
    
    const doc1 = { items: [1, "two", { three: 3 }] };
    const doc2 = { items: [1, "TWO", { three: 4 }] };
    
    const patches = patcher.createPatch(doc1, doc2);
    expect(patches.length).toBeGreaterThan(0);
  });

  test("should handle empty arrays", () => {
    const plan = new Map([
      ["/items", { primaryKey: "id", strategy: "primaryKey" as const }]
    ]);
    const patcher = new SchemaPatcher({ plan });
    
    // Empty to filled
    const patches1 = patcher.createPatch({ items: [] }, { items: [{ id: "1" }] });
    expect(patches1).toEqual([{ op: "add", path: "/items/-", value: { id: "1" } }]);
    
    // Filled to empty
    const patches2 = patcher.createPatch({ items: [{ id: "1" }] }, { items: [] });
    expect(patches2).toEqual([{ op: "remove", path: "/items/0" }]);
  });

  test("should handle complex nested changes", () => {
    const patcher = new SchemaPatcher({ plan: new Map() });
    
    const doc1 = {
      user: {
        profile: { name: "John", settings: { theme: "dark" } },
        posts: [{ title: "First" }]
      }
    };
    
    const doc2 = {
      user: {
        profile: { name: "Jane", settings: { theme: "light", lang: "en" } },
        posts: [{ title: "Updated" }]
      }
    };
    
    const patches = patcher.createPatch(doc1, doc2);
    expect(patches.some(p => p.path.includes("name") && p.value === "Jane")).toBe(true);
    expect(patches.some(p => p.path.includes("theme") && p.value === "light")).toBe(true);
    expect(patches.some(p => p.path.includes("lang") && p.value === "en")).toBe(true);
  });

  test("should handle diffObject with undefined keys", () => {
    const patcher = new SchemaPatcher({ plan: new Map() });
    
    // Simulate array with sparse elements
    const obj1 = { items: ["a", null, "c"] };
    const obj2 = { items: ["a", "b", "c"] };
    
    const patches = patcher.createPatch(obj1, obj2);
    expect(patches.some(p => p.value === "b")).toBe(true);
  });

  test("should handle array diffing with parent wildcard path", () => {
    const plan = new Map([
      ["/*", { primaryKey: null, strategy: "lcs" as const }]
    ]);
    
    const patcher = new SchemaPatcher({ plan });
    
    const doc1 = { nested: { deep: { items: [1, 2, 3] } } };
    const doc2 = { nested: { deep: { items: [1, 3, 4] } } };
    
    const patches = patcher.createPatch(doc1, doc2);
    expect(patches.length).toBeGreaterThan(0);
  });

  test("should handle primary key arrays with missing or invalid keys", () => {
    const plan = new Map([
      ["/items", { primaryKey: "id", strategy: "primaryKey" as const }]
    ]);
    
    const patcher = new SchemaPatcher({ plan });
    
    const doc1 = {
      items: [
        { id: "1", name: "valid" },
        { name: "no-id" }, // Missing primary key
        "not-an-object", // Not an object
        { id: { complex: "key" }, name: "invalid-key-type" } // Invalid key type
      ]
    };
    
    const doc2 = {
      items: [
        { id: "1", name: "updated" },
        { id: "2", name: "new" }
      ]
    };
    
    const patches = patcher.createPatch(doc1, doc2);
    expect(patches.length).toBeGreaterThan(0);
  });

  test("should handle hashing optimization in primary key arrays", () => {
    const plan = new Map([
      ["/items", {
        primaryKey: "id",
        strategy: "primaryKey" as const,
        hashFields: ["id", "category"]
      }]
    ]);
    
    const patcher = new SchemaPatcher({ plan });
    
    // Items with same hash but different deep content
    const item1 = { id: "1", category: "A", nested: { value: "old" } };
    const item2 = { id: "1", category: "A", nested: { value: "new" } };
    
    const doc1 = { items: [item1] };
    const doc2 = { items: [item2] };
    
    const patches = patcher.createPatch(doc1, doc2);
    expect(patches.some(p => p.path.includes("nested"))).toBe(true);
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
            properties: { id: { type: "string" } }
          }
        }
      }
    };
    
    const plan = buildPlan(schema);
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
            properties: { customId: { type: "string" } }
          }
        }
      }
    };
    
    const plan = buildPlan(schema, {
      primaryKeyMap: { "/users": "customId" }
    });
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
              items: { type: "string" }
            }
          }
        }
      }
    };
    
    const plan = buildPlan(schema, { basePath: "/root" });
    expect(plan.has("/items")).toBe(true);
    expect(plan.has("/root/items")).toBe(false);
  });
}); 