import { describe, expect, test } from "bun:test"
import { buildPlan } from "../src/index"
import type { JSONSchema } from "../src/core/buildPlan"

// F25 / capability `primaryKeyCandidates` (CORE §3.5.3, CORE §3.5.5, CONF §5.3).

const arraySchema = (
  itemProps: Record<string, { type: string }>,
  required: string[]
): JSONSchema =>
  ({
    type: "object",
    properties: {
      items: {
        type: "array",
        items: { type: "object", properties: itemProps, required },
      },
    },
  }) as unknown as JSONSchema

describe("primaryKeyCandidates option (F25)", () => {
  test("default (omitted) keeps the ['id','name','port'] list", () => {
    // `name` is required primitive, no `id` -> default list picks `name`.
    const plan = buildPlan({ schema: arraySchema({ name: { type: "string" } }, ["name"]) })
    const p = plan.get("/items")
    expect(p?.strategy).toBe("primaryKey")
    expect(p?.primaryKey).toBe("name")
  })

  test("custom candidates are picked up (and override the default order)", () => {
    // Item has both `slug` and `name` required; default would pick `name`, but a
    // custom list beginning with `slug` selects `slug`.
    const schema = arraySchema(
      { slug: { type: "string" }, name: { type: "string" } },
      ["slug", "name"]
    )
    const plan = buildPlan({ schema, primaryKeyCandidates: ["slug", "name"] })
    const p = plan.get("/items")
    expect(p?.strategy).toBe("primaryKey")
    expect(p?.primaryKey).toBe("slug")
  })

  test("custom candidates ignore fields not in the list", () => {
    // Only `id` is required; a custom list that omits `id` finds no key -> lcs.
    const schema = arraySchema({ id: { type: "string" } }, ["id"])
    const plan = buildPlan({ schema, primaryKeyCandidates: ["uuid", "key"] })
    const p = plan.get("/items")
    expect(p?.strategy).toBe("lcs")
    expect(p?.primaryKey).toBe(null)
  })

  test("empty list disables auto-detection (yields lcs)", () => {
    // `id` is a required string; the default would pick it, but [] disables.
    const schema = arraySchema({ id: { type: "string" } }, ["id"])
    const plan = buildPlan({ schema, primaryKeyCandidates: [] })
    const p = plan.get("/items")
    expect(p?.strategy).toBe("lcs")
    expect(p?.primaryKey).toBe(null)
  })

  test("primaryKeyMap wins over an empty candidate list", () => {
    const schema = arraySchema({ id: { type: "string" } }, ["id"])
    const plan = buildPlan({
      schema,
      primaryKeyCandidates: [],
      primaryKeyMap: { "/items": "id" },
    })
    const p = plan.get("/items")
    expect(p?.strategy).toBe("primaryKey")
    expect(p?.primaryKey).toBe("id")
  })

  test("primaryKeyMap wins over a custom candidate list (map key not in list)", () => {
    const schema = arraySchema(
      { id: { type: "string" }, name: { type: "string" } },
      ["id", "name"]
    )
    const plan = buildPlan({
      schema,
      primaryKeyCandidates: ["name"],
      primaryKeyMap: { "/items": "id" },
    })
    const p = plan.get("/items")
    expect(p?.strategy).toBe("primaryKey")
    // The map value wins outright and does not consult the candidate list.
    expect(p?.primaryKey).toBe("id")
  })
})
