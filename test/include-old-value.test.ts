import { describe, expect, test } from "bun:test"
import { JsonSchemaPatcher, applyPatch, buildPlan, invertPatch } from "../src/index"
import type { JsonValue, Operation } from "../src/types"

// F11 / capability `includeOldValue` (CORE §4.4.2, CONF §5). Default-on behavior
// is covered exhaustively by the rest of the suite (which asserts oldValue on
// every remove/replace); this file pins the OPT-OUT surface: no op carries
// oldValue when the option is off, default mode is unchanged, and invertPatch
// still round-trips because it recovers old values from the original document.

const hasOldValue = (ops: Operation[]): boolean =>
  ops.some((op) => Object.hasOwn(op, "oldValue"))

const removeReplaceOps = (ops: Operation[]): Operation[] =>
  ops.filter((op) => op.op === "remove" || op.op === "replace")

describe("includeOldValue capability (F11)", () => {
  test("default (option omitted) still attaches oldValue on remove/replace", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map() })
    const ops = patcher.execute({
      original: { a: 1, b: { c: 2 }, gone: "x" },
      modified: { a: 9, b: { c: 2 } },
    })
    const rr = removeReplaceOps(ops)
    expect(rr.length).toBeGreaterThan(0)
    for (const op of rr) expect(Object.hasOwn(op, "oldValue")).toBe(true)
  })

  test("includeOldValue:true is byte-identical to the default", () => {
    const original: JsonValue = { a: 1, list: [1, 2, 3], nested: { drop: true } }
    const modified: JsonValue = { a: 2, list: [1, 9, 3], nested: {} }
    const def = new JsonSchemaPatcher({ plan: new Map() }).execute({ original, modified })
    const on = new JsonSchemaPatcher({ plan: new Map(), includeOldValue: true }).execute({
      original,
      modified,
    })
    expect(JSON.stringify(on)).toBe(JSON.stringify(def))
  })

  test("includeOldValue:false suppresses oldValue at every emission site (object + LCS)", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map(), includeOldValue: false })
    const ops = patcher.execute({
      original: { a: 1, b: { c: 2 }, gone: "x", arr: [1, 2, 3, 4] },
      modified: { a: 9, b: { c: 3 }, arr: [1, 9, 4] },
    })
    // Something was removed/replaced, but nothing carries oldValue.
    expect(removeReplaceOps(ops).length).toBeGreaterThan(0)
    expect(hasOldValue(ops)).toBe(false)
  })

  test("includeOldValue:false suppresses oldValue in an empty-array truncation (LCS m===0)", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map(), includeOldValue: false })
    const ops = patcher.execute({ original: { arr: [1, 2, 3] }, modified: { arr: [] } })
    expect(ops.every((op) => op.op === "remove")).toBe(true)
    expect(hasOldValue(ops)).toBe(false)
  })

  test("includeOldValue:false suppresses oldValue on a root-array truncation", () => {
    const patcher = new JsonSchemaPatcher({ plan: new Map(), includeOldValue: false })
    const ops = patcher.execute({ original: [1, 2, 3], modified: [] })
    expect(ops.length).toBe(3)
    expect(hasOldValue(ops)).toBe(false)
  })

  test("includeOldValue:false suppresses oldValue in the primaryKey strategy", () => {
    const schema = {
      type: "object",
      properties: {
        users: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, status: { type: "string" } },
            required: ["id"],
          },
        },
      },
    }
    const plan = buildPlan({ schema: schema as never })
    const patcher = new JsonSchemaPatcher({ plan, includeOldValue: false })
    const ops = patcher.execute({
      original: { users: [{ id: "a", status: "on" }, { id: "b", status: "on" }] },
      modified: { users: [{ id: "a", status: "off" }] },
    })
    // A removal of id "b" and a status change on "a"; no op carries oldValue.
    expect(removeReplaceOps(ops).length).toBeGreaterThan(0)
    expect(hasOldValue(ops)).toBe(false)
  })

  test("includeOldValue:false suppresses oldValue in the unique strategy", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    }
    const plan = buildPlan({ schema: schema as never })
    const patcher = new JsonSchemaPatcher({ plan, includeOldValue: false })
    const ops = patcher.execute({
      original: { tags: ["a", "b", "c"] },
      modified: { tags: ["a", "X", "c"] },
    })
    expect(ops.some((op) => op.op === "replace")).toBe(true)
    expect(hasOldValue(ops)).toBe(false)
  })

  test("diff(includeOldValue:false) -> applyPatch -> invertPatch round-trips", () => {
    const cases: Array<{ original: JsonValue; modified: JsonValue }> = [
      { original: { a: 1, b: 2, c: { d: 3 } }, modified: { a: 9, c: { d: 4 }, e: 5 } },
      { original: { arr: [1, 2, 3, 4, 5] }, modified: { arr: [1, 9, 3, 5] } },
      { original: [1, 2, 3], modified: [] },
      { original: { nested: { drop: { big: [1, 2, 3] } }, keep: true }, modified: { keep: true } },
      { original: { x: "old" }, modified: { x: "new", y: "added" } },
    ]

    for (const { original, modified } of cases) {
      const patcher = new JsonSchemaPatcher({ plan: new Map(), includeOldValue: false })
      const forward = patcher.execute({ original, modified })
      // No oldValue anywhere in the forward patch.
      expect(hasOldValue(forward)).toBe(false)

      // Forward patch reconstructs `modified`.
      const applied = applyPatch(original, forward, { cloneValues: true })
      expect(applied).toEqual(modified as never)

      // invertPatch reads the ORIGINAL document (not oldValue) and restores it.
      const inverse = invertPatch(original, forward)
      const restored = applyPatch(applied, inverse, { cloneValues: true })
      expect(restored).toEqual(original as never)
    }
  })
})
