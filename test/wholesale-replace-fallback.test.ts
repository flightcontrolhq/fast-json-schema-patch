import { describe, expect, test } from "bun:test"
import { JsonSchemaPatcher, applyPatch, buildPlan } from "../src/index"
import type { JsonValue, Operation } from "../src/types"

// wholesaleReplaceFallback capability (GEN §9 / CONF §5.5, F24). Default
// OFF: output is byte-identical to omitting the option. ON: a per-array byte
// estimate (GEN §9.2) decides whether the granular op stream for THAT array is
// discarded in favor of a single whole-array `replace` (carrying `oldValue`
// per `includeOldValue`). This file pins the audit's repro shape (a complete
// rewrite of a 12-item, no-common-elements array) as the trigger case, and
// asserts small/typical diffs never trigger the fallback.

// Audit repro shape (scratchpad compactness.ts S5), sharpened for the GEN §9.3
// wholesale-op threshold: 12 objects where EVERY field of EVERY item differs
// between original and modified, so the granular stream carries the full old
// and new content plus per-op overhead and genuinely exceeds the single
// wholesale replace. (The earlier fixture shared a fat constant `description`
// across items — granular per-field ops legitimately beat wholesale there,
// which is exactly what the corrected threshold preserves.)
const bigItem = (i: number) => ({
  title: `Item ${i}`,
  description: `desc-${i}-` + "x".repeat(400),
  tagsList: [`alpha${i}`, `beta${i}`, `gamma${i}`, `delta${i}`],
  metadata: {
    created: `2024-01-${i}`,
    updated: `2024-06-${i}`,
    author: `someone-${i}`,
    flags: { a: i % 2 === 0, b: false },
  },
  score: i * 10,
})

const rewriteSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "score"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          tagsList: { type: "array", items: { type: "string" } },
          metadata: { type: "object" },
          score: { type: "number" },
        },
      },
    },
  },
}

function rewriteDocs() {
  const original = { items: Array.from({ length: 12 }, (_, i) => bigItem(i)) }
  const modified = { items: Array.from({ length: 12 }, (_, i) => bigItem(i + 100)) }
  return { original, modified }
}

describe("wholesaleReplaceFallback capability (F24)", () => {
  test("default off: identical output to omitting the option", () => {
    const { original, modified } = rewriteDocs()
    const plan = buildPlan({ schema: rewriteSchema })
    const omitted = new JsonSchemaPatcher({ plan }).execute({ original, modified })
    const explicitFalse = new JsonSchemaPatcher({
      plan,
      wholesaleReplaceFallback: false,
    }).execute({ original, modified })
    expect(JSON.stringify(explicitFalse)).toBe(JSON.stringify(omitted))
    // Sanity: this shape really is granular (many ops), not already collapsed.
    expect(omitted.length).toBeGreaterThan(1)
  })

  test("triggers on the audit repro shape: granular stream collapses to one whole-array replace", () => {
    const { original, modified } = rewriteDocs()
    const plan = buildPlan({ schema: rewriteSchema })

    const withFallback = new JsonSchemaPatcher({
      plan,
      wholesaleReplaceFallback: true,
    }).execute({ original, modified })

    expect(withFallback).toEqual([
      { op: "replace", path: "/items", value: modified.items, oldValue: original.items },
    ])

    // With oldValue suppressed the size win is unambiguous: granular (no
    // collapse possible — every element differs, F24's whole point) carries
    // ~2x the array's own bytes (value+oldValue per touched element) while
    // wholesale carries exactly the new array's bytes.
    const granularNoOld = new JsonSchemaPatcher({ plan, includeOldValue: false }).execute({
      original,
      modified,
    })
    const wholesaleNoOld = new JsonSchemaPatcher({
      plan,
      wholesaleReplaceFallback: true,
      includeOldValue: false,
    }).execute({ original, modified })
    expect(JSON.stringify(wholesaleNoOld).length).toBeLessThan(
      JSON.stringify(granularNoOld).length
    )

    // Round-trips exactly like the granular stream does.
    expect(applyPatch(structuredClone(original), withFallback)).toEqual(modified as JsonValue)
  })

  test("respects includeOldValue:false on the wholesale replace", () => {
    const { original, modified } = rewriteDocs()
    const plan = buildPlan({ schema: rewriteSchema })
    const ops = new JsonSchemaPatcher({
      plan,
      wholesaleReplaceFallback: true,
      includeOldValue: false,
    }).execute({ original, modified })
    expect(ops).toEqual([{ op: "replace", path: "/items", value: modified.items }])
  })

  test("small diffs never trigger the fallback: single-field change in a 12-item array", () => {
    const original = { items: Array.from({ length: 12 }, (_, i) => bigItem(i)) }
    const modified = structuredClone(original)
    ;(modified.items[3] as { score: number }).score = 999

    const plan = buildPlan({ schema: rewriteSchema })
    const without = new JsonSchemaPatcher({ plan }).execute({ original, modified })
    const withFallback = new JsonSchemaPatcher({
      plan,
      wholesaleReplaceFallback: true,
    }).execute({ original, modified })

    expect(JSON.stringify(withFallback)).toBe(JSON.stringify(without))
    // A single field replace, not a whole-array/whole-item replace.
    expect(withFallback.some((op: Operation) => op.path === "/items")).toBe(false)
  })

  test("small diffs on a schemaless (no-plan) array never trigger the fallback", () => {
    // Large enough that the per-op estimate overhead (GEN §9.2, ~30B) is
    // dwarfed by the array's own serialized size — a tiny array with a
    // one-element diff is a separate, legitimate trigger case (the fixed
    // per-op overhead can exceed a handful of small primitives).
    const original = { list: Array.from({ length: 50 }, (_, i) => i) }
    const modified = { list: original.list.slice() }
    modified.list[25] = 999
    const without = new JsonSchemaPatcher({ plan: new Map() }).execute({ original, modified })
    const withFallback = new JsonSchemaPatcher({
      plan: new Map(),
      wholesaleReplaceFallback: true,
    }).execute({ original, modified })
    expect(JSON.stringify(withFallback)).toBe(JSON.stringify(without))
  })

  test("composes with emitMoves: fallback estimate is computed on the moves-emitted stream", () => {
    const { original, modified } = rewriteDocs()
    const plan = buildPlan({ schema: rewriteSchema })
    const ops = new JsonSchemaPatcher({
      plan,
      wholesaleReplaceFallback: true,
      emitMoves: true,
    }).execute({ original, modified })
    expect(ops).toEqual([
      { op: "replace", path: "/items", value: modified.items, oldValue: original.items },
    ])
    expect(applyPatch(structuredClone(original), ops)).toEqual(modified as JsonValue)
  })
})
