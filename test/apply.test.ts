import { describe, expect, test } from "bun:test"
import {
  JsonSchemaPatcher,
  applyPatch,
  buildPlan,
  invertPatch,
  toRfc6902,
  JsonPatchError,
} from "../src/index"
import type { JsonValue, Operation } from "../src/types"

describe("applyPatch - RFC 6902 Appendix A", () => {
  test("A.1 adding an object member", () => {
    expect(applyPatch({ foo: "bar" }, [{ op: "add", path: "/baz", value: "qux" }])).toEqual({
      baz: "qux",
      foo: "bar",
    })
  })

  test("A.2 adding an array element", () => {
    expect(applyPatch({ foo: ["bar", "baz"] }, [{ op: "add", path: "/foo/1", value: "qux" }])).toEqual({
      foo: ["bar", "qux", "baz"],
    })
  })

  test("A.3 removing an object member", () => {
    expect(applyPatch({ baz: "qux", foo: "bar" }, [{ op: "remove", path: "/baz" }])).toEqual({
      foo: "bar",
    })
  })

  test("A.4 removing an array element", () => {
    expect(applyPatch({ foo: ["bar", "qux", "baz"] }, [{ op: "remove", path: "/foo/1" }])).toEqual({
      foo: ["bar", "baz"],
    })
  })

  test("A.5 replacing a value", () => {
    expect(applyPatch({ baz: "qux", foo: "bar" }, [{ op: "replace", path: "/baz", value: "boo" }])).toEqual({
      baz: "boo",
      foo: "bar",
    })
  })

  test("A.6 moving a value", () => {
    expect(
      applyPatch({ foo: { bar: "baz", waldo: "fred" }, qux: { corge: "grault" } }, [
        { op: "move", from: "/foo/waldo", path: "/qux/thud" },
      ]),
    ).toEqual({ foo: { bar: "baz" }, qux: { corge: "grault", thud: "fred" } })
  })

  test("A.7 moving an array element", () => {
    expect(
      applyPatch({ foo: ["all", "grass", "cows", "eat"] }, [{ op: "move", from: "/foo/1", path: "/foo/3" }]),
    ).toEqual({ foo: ["all", "cows", "eat", "grass"] })
  })

  test("A.8 testing a value: success", () => {
    const doc = { baz: "qux", foo: ["a", 2, "c"] }
    expect(
      applyPatch(doc, [
        { op: "test", path: "/baz", value: "qux" },
        { op: "test", path: "/foo/1", value: 2 },
      ]),
    ).toEqual(doc)
  })

  test("A.9 testing a value: error", () => {
    expect(() => applyPatch({ baz: "qux" }, [{ op: "test", path: "/baz", value: "bar" }])).toThrow(
      JsonPatchError,
    )
  })

  test("A.10 adding a nested member object", () => {
    expect(applyPatch({ foo: "bar" }, [{ op: "add", path: "/child", value: { grandchild: {} } }])).toEqual({
      foo: "bar",
      child: { grandchild: {} },
    })
  })

  test("A.12 adding to a nonexistent target errors", () => {
    expect(() => applyPatch({ foo: "bar" }, [{ op: "add", path: "/baz/bat", value: "qux" }])).toThrow(
      JsonPatchError,
    )
  })

  test("A.14 ~ escape ordering", () => {
    const doc = { "/": 9, "~1": 10 }
    expect(applyPatch(doc, [{ op: "test", path: "/~01", value: 10 }])).toEqual(doc)
  })

  test("A.16 adding an array value", () => {
    expect(applyPatch({ foo: ["bar"] }, [{ op: "add", path: "/foo/-", value: ["abc", "def"] }])).toEqual({
      foo: ["bar", ["abc", "def"]],
    })
  })

  test("copy copies a value without aliasing", () => {
    const result = applyPatch({ a: { x: 1 }, list: [] }, [{ op: "copy", from: "/a", path: "/list/-" }]) as {
      a: { x: number }
      list: Array<{ x: number }>
    }
    expect(result.list[0]).toEqual({ x: 1 })
    expect(result.list[0]).not.toBe(result.a)
  })
})

describe("applyPatch - paths and errors", () => {
  test("replace at root replaces whole document", () => {
    expect(applyPatch({ a: 1 }, [{ op: "replace", path: "", value: [1, 2] }])).toEqual([1, 2])
  })

  test("add at root replaces whole document", () => {
    expect(applyPatch(null, [{ op: "add", path: "", value: { a: 1 } }])).toEqual({ a: 1 })
  })

  test("remove at root errors", () => {
    expect(() => applyPatch({ a: 1 }, [{ op: "remove", path: "" }])).toThrow(JsonPatchError)
  })

  test("sequential appends preserve order", () => {
    expect(
      applyPatch({ list: [1] }, [
        { op: "add", path: "/list/-", value: 2 },
        { op: "add", path: "/list/-", value: 3 },
      ]),
    ).toEqual({ list: [1, 2, 3] })
  })

  test("keys requiring JSON Pointer escaping", () => {
    expect(applyPatch({ "a/b": { "c~d": 1 } }, [{ op: "replace", path: "/a~1b/c~0d", value: 2 }])).toEqual({
      "a/b": { "c~d": 2 },
    })
  })

  test("leading-zero array index errors", () => {
    expect(() => applyPatch({ list: [1, 2] }, [{ op: "remove", path: "/list/01" }])).toThrow(JsonPatchError)
  })

  test("out-of-bounds add index errors", () => {
    expect(() => applyPatch({ list: [1] }, [{ op: "add", path: "/list/2", value: 9 }])).toThrow(JsonPatchError)
  })

  test('"-" is rejected for remove and replace', () => {
    expect(() => applyPatch({ list: [1] }, [{ op: "remove", path: "/list/-" }])).toThrow(JsonPatchError)
    expect(() => applyPatch({ list: [1] }, [{ op: "replace", path: "/list/-", value: 2 }])).toThrow(
      JsonPatchError,
    )
  })

  test("move into own child errors", () => {
    expect(() => applyPatch({ a: { b: {} } }, [{ op: "move", from: "/a", path: "/a/b/c" }])).toThrow(
      JsonPatchError,
    )
  })

  test("replace of nonexistent member errors", () => {
    expect(() => applyPatch({ a: 1 }, [{ op: "replace", path: "/b", value: 2 }])).toThrow(JsonPatchError)
  })

  test("error carries the failing operation, its index, and a code", () => {
    try {
      applyPatch({ a: 1 }, [
        { op: "replace", path: "/a", value: 2 },
        { op: "remove", path: "/missing" },
      ])
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(JsonPatchError)
      expect((error as JsonPatchError).operationIndex).toBe(1)
      expect((error as JsonPatchError).operation?.path).toBe("/missing")
      expect((error as JsonPatchError).code).toBe("PATH_UNRESOLVABLE")
    }
  })

  test("prototype-pollution segments are rejected", () => {
    for (const path of ["/__proto__/polluted", "/constructor/prototype/polluted", "/a/__proto__"]) {
      expect(() => applyPatch({ a: {} }, [{ op: "add", path, value: true }])).toThrow(JsonPatchError)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  test("standalone constructor/prototype keys remain usable", () => {
    expect(applyPatch({}, [{ op: "add", path: "/constructor", value: "Foo" }])).toEqual({
      constructor: "Foo",
    })
    expect(applyPatch({}, [{ op: "add", path: "/prototype", value: 1 }])).toEqual({ prototype: 1 })
  })

  test("cloneResult returns a fully independent document", () => {
    const doc = { touched: { x: 1 }, untouched: { y: 2 } }
    const result = applyPatch(doc, [{ op: "replace", path: "/touched/x", value: 3 }], {
      cloneResult: true,
    }) as typeof doc
    expect(result.untouched).not.toBe(doc.untouched)
    result.untouched.y = 999
    expect(doc.untouched.y).toBe(2)
  })
})

describe("applyPatch - immutability and structural sharing", () => {
  test("input document is never mutated", () => {
    const doc = { a: { x: 1 }, list: [{ id: 1 }, { id: 2 }] }
    const snapshot = JSON.parse(JSON.stringify(doc))
    applyPatch(doc, [
      { op: "replace", path: "/a/x", value: 2 },
      { op: "remove", path: "/list/0" },
      { op: "add", path: "/list/-", value: { id: 3 } },
    ])
    expect(doc).toEqual(snapshot)
  })

  test("untouched subtrees are shared by reference", () => {
    const doc = { touched: { x: 1 }, untouched: { big: [1, 2, 3] } }
    const result = applyPatch(doc, [{ op: "replace", path: "/touched/x", value: 2 }]) as typeof doc
    expect(result.untouched).toBe(doc.untouched)
    expect(result.touched).not.toBe(doc.touched)
  })

  test("failed application leaves the input intact (atomicity)", () => {
    const doc = { a: 1, b: 2 }
    const snapshot = { ...doc }
    expect(() =>
      applyPatch(doc, [
        { op: "replace", path: "/a", value: 99 },
        { op: "test", path: "/b", value: "wrong" },
      ]),
    ).toThrow(JsonPatchError)
    expect(doc).toEqual(snapshot)
  })
})

describe("applyPatch - oldValue validation", () => {
  test("validateOldValues passes on matching oldValue", () => {
    expect(
      applyPatch(
        { a: 1 },
        [{ op: "replace", path: "/a", value: 2, oldValue: 1 }],
        { validateOldValues: true },
      ),
    ).toEqual({ a: 2 })
  })

  test("validateOldValues rejects stale oldValue", () => {
    expect(() =>
      applyPatch(
        { a: 999 },
        [{ op: "replace", path: "/a", value: 2, oldValue: 1 }],
        { validateOldValues: true },
      ),
    ).toThrow(JsonPatchError)
  })

  test("oldValue is ignored by default", () => {
    expect(applyPatch({ a: 999 }, [{ op: "replace", path: "/a", value: 2, oldValue: 1 }])).toEqual({ a: 2 })
  })
})

describe("invertPatch", () => {
  const roundTripInverse = (doc: JsonValue, patches: Operation[]) => {
    const applied = applyPatch(doc, patches)
    const inverse = invertPatch(doc, patches)
    return applyPatch(applied, inverse)
  }

  test("inverts adds, removes, and replaces", () => {
    const doc = { a: 1, b: { c: 2 }, list: [1, 2, 3] }
    const patches: Operation[] = [
      { op: "add", path: "/d", value: 4 },
      { op: "remove", path: "/b" },
      { op: "replace", path: "/a", value: 99 },
      { op: "remove", path: "/list/1" },
    ]
    expect(roundTripInverse(doc, patches)).toEqual(doc)
  })

  test("inverts append adds by resolving the concrete index", () => {
    const doc = { list: [1, 2] }
    const patches: Operation[] = [
      { op: "add", path: "/list/-", value: 3 },
      { op: "add", path: "/list/-", value: 4 },
    ]
    expect(roundTripInverse(doc, patches)).toEqual(doc)
  })

  test("inverts move and copy", () => {
    const doc = { a: { x: 1 }, b: {} }
    const patches: Operation[] = [
      { op: "move", from: "/a/x", path: "/b/x" },
      { op: "copy", from: "/b", path: "/c" },
    ]
    expect(roundTripInverse(doc, patches)).toEqual(doc)
  })

  test("recovers removed values even without oldValue", () => {
    const doc = { list: [{ id: 1, data: "keep me" }] }
    const patches: Operation[] = [{ op: "remove", path: "/list/0" }]
    const inverse = invertPatch(doc, patches)
    expect(inverse).toEqual([{ op: "add", path: "/list/0", value: { id: 1, data: "keep me" } }])
  })

  test("inverts add that overwrites an existing object member (RFC 6902 §4.1)", () => {
    const doc = { a: "original" }
    const patches: Operation[] = [{ op: "add", path: "/a", value: "overwritten" }]
    expect(roundTripInverse(doc, patches)).toEqual(doc)
  })

  test("inverts add and replace at the document root", () => {
    const doc = { a: 1 }
    expect(roundTripInverse(doc, [{ op: "add", path: "", value: [1, 2] }])).toEqual(doc)
    expect(roundTripInverse(doc, [{ op: "replace", path: "", value: null }])).toEqual(doc)
  })

  test("inverts move that overwrites an existing member", () => {
    const doc = { a: "moved", b: "overwritten" }
    const patches: Operation[] = [{ op: "move", from: "/a", path: "/b" }]
    expect(roundTripInverse(doc, patches)).toEqual(doc)
  })

  test("inverts move to the document root", () => {
    const doc = { a: { inner: 1 }, b: 2 }
    const patches: Operation[] = [{ op: "move", from: "/a", path: "" }]
    expect(roundTripInverse(doc, patches)).toEqual(doc)
  })

  test("inverts copy that overwrites an existing member", () => {
    const doc = { a: { x: 1 }, b: "overwritten" }
    const patches: Operation[] = [{ op: "copy", from: "/a", path: "/b" }]
    expect(roundTripInverse(doc, patches)).toEqual(doc)
  })
})

describe("diff -> apply round-trip", () => {
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
            tags: { type: "array", items: { type: "string" } },
            profile: {
              type: "object",
              properties: { age: { type: "number" }, city: { type: "string" } },
            },
          },
        },
      },
    },
  }

  const roundTrip = (original: JsonValue, modified: JsonValue, plan = buildPlan({ schema })) => {
    const patcher = new JsonSchemaPatcher({ plan })
    const patches = patcher.execute({ original, modified })
    return applyPatch(original, patches)
  }

  test("object-only documents reconstruct exactly", () => {
    const original = { a: 1, b: { c: [1, 2], d: "x" }, e: null }
    const modified = { a: 2, b: { c: [1, 2, 3] }, f: { new: true } }
    expect(roundTrip(original, modified)).toEqual(modified)
  })

  test("primaryKey arrays: modify + remove + append reconstructs exactly", () => {
    const original = {
      users: [
        { id: "u1", name: "John", profile: { age: 30, city: "NYC" } },
        { id: "u2", name: "Jane" },
        { id: "u3", name: "Sam" },
      ],
    }
    const modified = {
      users: [
        { id: "u1", name: "Johnny", profile: { age: 31, city: "NYC" } },
        { id: "u3", name: "Sam" },
        { id: "u4", name: "New" },
      ],
    }
    expect(roundTrip(original, modified)).toEqual(modified)
  })

  test("nested primitive arrays reconstruct exactly", () => {
    const original = { users: [{ id: "u1", tags: ["a", "b", "c"] }] }
    const modified = { users: [{ id: "u1", tags: ["a", "x", "c", "d"] }] }
    expect(roundTrip(original, modified)).toEqual(modified)
  })

  test("unplanned arrays (LCS) reconstruct exactly", () => {
    const original = { misc: [1, 2, 3, 4, 5] }
    const modified = { misc: [1, 99, 3, 5, 6] }
    expect(roundTrip(original, modified, new Map())).toEqual(modified)
  })

  test("root-level array reconstructs exactly", () => {
    const original = [{ x: 1 }, { x: 2 }, { x: 3 }]
    const modified = [{ x: 1 }, { x: 99 }, { x: 3 }, { x: 4 }]
    expect(roundTrip(original, modified, new Map())).toEqual(modified)
  })

  test("emptying a nested array reconstructs exactly", () => {
    const original = { misc: [1, 2, 3] }
    const modified = { misc: [] }
    expect(roundTrip(original, modified, new Map())).toEqual(modified)
  })

  test("emptying a root-level array reconstructs exactly", () => {
    const original = [1, 2, 3]
    const modified: JsonValue = []
    expect(roundTrip(original, modified, new Map())).toEqual(modified)
  })

  test("object keys containing '/' and '~' reconstruct exactly", () => {
    const original = { "a/b": { "c~d": 1 }, plain: 1 }
    const modified = { "a/b": { "c~d": 2 }, plain: 1, "e/f~g": true }
    expect(roundTrip(original, modified, new Map())).toEqual(modified)
  })

  test("arrays beyond 65536 elements round-trip exactly (cache-key collision regression)", () => {
    const original = Array.from({ length: 70001 }, (_, i) => i)
    const modified = original.slice(1)
    modified[65536] = -1
    expect(roundTrip(original, modified, new Map())).toEqual(modified)
  })

  test("diff -> apply -> invert returns to the original", () => {
    const original = {
      users: [
        { id: "u1", name: "John" },
        { id: "u2", name: "Jane" },
      ],
    }
    const modified = { users: [{ id: "u1", name: "Johnny" }, { id: "u3", name: "New" }] }
    const patcher = new JsonSchemaPatcher({ plan: buildPlan({ schema }) })
    const patches = patcher.execute({ original, modified })
    const applied = applyPatch(original, patches)
    const inverse = invertPatch(original, patches)
    expect(applyPatch(applied, inverse)).toEqual(original)
  })
})
