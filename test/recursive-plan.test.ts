import { describe, expect, test } from "bun:test";
import { buildPlan, type JSONSchema } from "../src/core/buildPlan";
import { JsonSchemaPatcher } from "../src/core/JsonSchemaPatcher";

// CORE §3.3.7: recursion aliases extend strategy selection to unbounded
// recursion depth, and CORE §3.4.3: a primaryKeyMap entry works without
// schema coverage.

const recursiveStepsSchema = {
  type: "object",
  properties: {
    steps: { $ref: "#/$defs/stepList" },
    rollback: { $ref: "#/$defs/stepList" },
  },
  $defs: {
    stepList: {
      type: "array",
      items: { $ref: "#/$defs/step" },
    },
    step: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        parallel: { $ref: "#/$defs/stepList" },
      },
    },
  },
};

describe("recursion aliases (CORE §3.3.7)", () => {
  test("plan records an alias where the cycle guard fired", () => {
    const plan = buildPlan({ schema: recursiveStepsSchema });
    expect(plan.get("/steps")).toMatchObject({ primaryKey: "id", strategy: "primaryKey" });
    expect(plan.get("/steps/parallel")).toEqual({ primaryKey: null, recurseTo: "/steps" });
    expect(plan.get("/rollback/parallel")).toEqual({ primaryKey: null, recurseTo: "/rollback" });
  });

  test("keyed diffing reaches arbitrary recursion depth", () => {
    const plan = buildPlan({ schema: recursiveStepsSchema });
    const patcher = new JsonSchemaPatcher({ plan });
    const original = {
      steps: [
        { id: "a" },
        {
          id: "group",
          parallel: [
            { id: "p1", parallel: [{ id: "q1" }, { id: "q2" }] },
            { id: "p2" },
          ],
        },
      ],
    };
    const modified = {
      steps: [
        { id: "a" },
        {
          id: "group",
          parallel: [
            // q2 removed two recursion levels down; p2 untouched.
            { id: "p1", parallel: [{ id: "q1" }] },
            { id: "p2" },
          ],
        },
      ],
    };
    const patch = patcher.execute({ original, modified });
    expect(patch).toEqual([
      {
        op: "remove",
        path: "/steps/1/parallel/0/parallel/1",
        oldValue: { id: "q2" },
      },
    ]);
  });

  test("direct object cycle (no $ref wrapper) also aliases", () => {
    const step: JSONSchema = {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    };
    const parallel: JSONSchema = { type: "array", items: step };
    (step.properties as Record<string, JSONSchema>).parallel = parallel;
    const schema: JSONSchema = { type: "object", properties: { parallel } };

    const plan = buildPlan({ schema });
    expect(plan.get("/parallel")).toMatchObject({
      primaryKey: "id",
      strategy: "primaryKey",
    });
    expect(plan.get("/parallel/parallel")).toEqual({
      primaryKey: null,
      recurseTo: "/parallel",
    });

    const patcher = new JsonSchemaPatcher({ plan });
    const patch = patcher.execute({
      original: { parallel: [{ id: "x", parallel: [{ id: "y" }, { id: "z" }] }] },
      modified: { parallel: [{ id: "x", parallel: [{ id: "z" }] }] },
    });
    expect(patch).toEqual([
      { op: "remove", path: "/parallel/0/parallel/0", oldValue: { id: "y" } },
    ]);
  });
});

describe("primaryKeyMap without schema coverage (CORE §3.4.3)", () => {
  test("registers at paths the schema never reaches", () => {
    const plan = buildPlan({
      schema: { type: "object" },
      primaryKeyMap: { "/users": "email" },
    });
    expect(plan.get("/users")).toEqual({ primaryKey: "email", strategy: "primaryKey" });
  });

  test("keyed diffing works with an empty schema", () => {
    const plan = buildPlan({
      schema: {},
      primaryKeyMap: { "/users": "email" },
    });
    const patcher = new JsonSchemaPatcher({ plan });
    const patch = patcher.execute({
      original: { users: [{ email: "a@x.io", role: "admin" }, { email: "b@x.io", role: "user" }] },
      modified: { users: [{ email: "b@x.io", role: "user" }, { email: "a@x.io", role: "owner" }] },
    });
    // Keyed matching absorbs the reorder; only the changed field emits.
    expect(patch).toEqual([
      { op: "replace", path: "/users/0/role", value: "owner", oldValue: "admin" },
    ]);
  });

  test("schema-discovered paths keep construction-time override precedence", () => {
    const plan = buildPlan({
      schema: {
        type: "object",
        properties: {
          users: {
            type: "array",
            items: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          },
        },
      },
      primaryKeyMap: { "/users": "email" },
    });
    // The traversal-time override (CORE §3.4.3 first paragraph) already won;
    // the post-pass must not double-register or clobber it.
    expect(plan.get("/users")).toMatchObject({ primaryKey: "email", strategy: "primaryKey" });
  });
});
