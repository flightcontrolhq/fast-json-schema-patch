import { describe, test, expect, spyOn, it } from "bun:test";
import {
  createPatcher,
  type FormattedOperation,
  type FinalPatch,
  type PatcherInstance,
  type Plan,
} from "../src/index";
import originalSchema from "./schema.json";
import { faker } from "@faker-js/faker";
import {
  applyPatch,
  type Operation as FastJsonPatchOperation,
} from "fast-json-patch";
import { deepEqual } from "../src/utils/deep-equal";
import { fastHash as fastHashUtil } from "../src/utils/fast-hash";

const schema = originalSchema as any;

// Helper to convert FinalPatch to a simplified format for tests
function toLegacy(patch: FinalPatch): FastJsonPatchOperation[] {
  return patch.operations.map(({ op, path, value }) => ({ op, path, value }));
}

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
      tags: Array.from(
        { length: faker.number.int({ min: 1, max: 5 }) },
        () => faker.lorem.word()
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

    const patcher = createPatcher(userSchema, {
      plannerOptions: { primaryKeyMap: { "/posts": "postId" } },
    });

    const result = patcher.diff(JSON.stringify(doc1), JSON.stringify(doc2));
    const patch = toLegacy(result);

    const { newDocument } = applyPatch(doc1, patch);
    expect(newDocument).toEqual(doc2);
  });
});

describe("Planner (from createPatcher)", () => {
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
    const patcher = createPatcher(schema);
    const plan = patcher.getPlan();
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
    const patcher = createPatcher(schema);
    const plan = patcher.getPlan();
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
    const patcher = createPatcher(schema, {
      plannerOptions: {
        primaryKeyMap: {
          "/users": "userId",
        },
      },
    });
    const plan = patcher.getPlan();
    expect(plan.get("/users")?.primaryKey).toBe("userId");
  });
});

describe("Patcher Instance", () => {
  it("should generate correct patches for array with primary key", () => {
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
            { id: "service1", name: "api-updated" },
            { id: "service3", name: "new-worker" },
          ],
        },
      ],
    };

    const patcher = createPatcher(schema);
    const result = patcher.diff(JSON.stringify(doc1), JSON.stringify(doc2));
    const patches = toLegacy(result);

    const expectedPatches = [
      { op: "remove", path: "/environments/0/services/1" },
      { op: "replace", path: "/environments/0/services/0/name", value: "api-updated" },
      {
        op: "add",
        path: "/environments/0/services/-",
        value: { id: "service3", name: "new-worker" },
      },
    ];

    // Sort patches for deterministic comparison
    patches.sort((a, b) => a.path.localeCompare(b.path));
    expectedPatches.sort((a, b) => a.path.localeCompare(b.path));

    expect(patches).toEqual(expectedPatches);
  });

  test("should handle reordering of items in an array with primary keys (no patch)", () => {
    const patcher = createPatcher(schema);

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

    const result = patcher.diff(JSON.stringify(doc1), JSON.stringify(doc2));
    expect(result.operations).toEqual([]);
  });

  test("should handle changing a primary key of an item (remove and add)", () => {
    const patcher = createPatcher(schema);
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

    const result = patcher.diff(JSON.stringify(doc1), JSON.stringify(doc2));
    const patch = toLegacy(result);

    expect(patch).toContainEqual({
      op: "remove",
      path: "/environments/0/services/0",
      value: undefined
    });
    expect(patch).toContainEqual({
      op: "add",
      path: "/environments/0/services/-",
      value: { id: "service1-renamed", name: "api" },
    });
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

describe("fastHashUtil function", () => {
    test("should generate a consistent hash", () => {
        const str1 = "hello world";
        const str2 = "hello world";
        const str3 = "hello world!";

        expect(fastHashUtil(str1)).toBe(fastHashUtil(str2));
        expect(fastHashUtil(str1)).not.toBe(fastHashUtil(str3));
    });

    test("should handle empty strings", () => {
        expect(fastHashUtil("")).toBe("811c9dc5");
    });
}); 