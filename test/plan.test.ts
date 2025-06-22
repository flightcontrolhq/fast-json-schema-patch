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
    const plan = buildPlan(schema);
    const arrayPlan = plan.get("/users");

    expect(arrayPlan?.primaryKey).toBe("id");
    expect(arrayPlan?.strategy).toBe("primaryKey");
    expect(arrayPlan?.isPrimitiveItems).toBeFalsy();
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
    const plan = buildPlan(schema);
    const arrayPlan = plan.get("/users");
    expect(arrayPlan?.primaryKey).toBe(null);
    expect(arrayPlan?.strategy).toBe("lcs");
    expect(arrayPlan?.isPrimitiveItems).toBeFalsy();
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
    const plan = buildPlan(schema);
    const arrayPlan = plan.get("/tags");
    expect(arrayPlan?.primaryKey).toBe(null);
    expect(arrayPlan?.strategy).toBe("lcs");
    expect(arrayPlan?.isPrimitiveItems).toBe(true);
  });

  it("should pre-resolve itemSchema for refs", () => {
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
    const arrayPlan = plan.get("/users");
    expect(arrayPlan?.itemSchema).toEqual({
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
      },
    });
  });
}); 

describe("SchemaPatcher", () => {
  it("should match snapshot for schema.json", () => {
    const schema = require("./schema.json");
    const plan = buildPlan(schema);
    expect(plan).toMatchSnapshot();
  });
});