import { describe, it, expect } from "bun:test";
import { buildPlan } from "../src";

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
    const plan = buildPlan(schema);
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
    const plan = buildPlan(schema);
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
    const plan = buildPlan(schema, {
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
    const plan = buildPlan(schema, {
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
    const plan = buildPlan(schema);
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
    const plan = buildPlan(schema);
    // It should pick the first valid one
    expect(plan.get("/items")?.primaryKey).toBe("id");
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
    const plan = buildPlan(schema, {
      primaryKeyMap: {
        "/users": "customId",
      },
    });
    expect(plan.get("/users")?.primaryKey).toBe("customId");
  });
}); 