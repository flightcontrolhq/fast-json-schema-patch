import { describe, expect, test } from "bun:test"
import {
  escapeJsonPointer,
  getValueByPath,
  joinPath,
  splitPath,
  unescapeJsonPointer,
} from "../src/utils/pathUtils"

// F31: direct unit coverage for src/utils/pathUtils.ts. These helpers are
// exercised indirectly all over the suite (apply.test.ts, comprehensive.test.ts,
// formatter.test.ts, ...) but had no dedicated unit tests pinning their
// escaping/round-trip contract in isolation.

describe("escapeJsonPointer / unescapeJsonPointer (RFC 6901)", () => {
  test("plain keys with no special characters pass through unchanged", () => {
    expect(escapeJsonPointer("foo")).toBe("foo")
    expect(unescapeJsonPointer("foo")).toBe("foo")
  })

  test("escapes ~ to ~0 and / to ~1", () => {
    expect(escapeJsonPointer("a~b")).toBe("a~0b")
    expect(escapeJsonPointer("a/b")).toBe("a~1b")
    expect(escapeJsonPointer("a~b/c")).toBe("a~0b~1c")
  })

  test("unescapes ~1 to / and ~0 to ~", () => {
    expect(unescapeJsonPointer("a~0b")).toBe("a~b")
    expect(unescapeJsonPointer("a~1b")).toBe("a/b")
    expect(unescapeJsonPointer("a~0b~1c")).toBe("a~b/c")
  })

  // The RFC mandates unescaping ~1 before ~0 (and, symmetrically, escaping ~
  // before /) specifically so that a literal "~1" in a *decoded* key doesn't
  // get misinterpreted as an escape sequence for "/" once it's been produced
  // by a naive single-pass replace. `~01` is the canonical stress case: it is
  // the *escaped* form of a decoded key that is literally the two characters
  // "~1" (a tilde followed by the digit one), not a slash.
  test("'~01' ordering: unescapes to the literal two-char string '~1', not '/'", () => {
    expect(unescapeJsonPointer("~01")).toBe("~1")
  })

  test("escapes the literal two-char key '~1' to '~01' (tilde-first ordering)", () => {
    expect(escapeJsonPointer("~1")).toBe("~01")
  })

  const roundTripCases = [
    "",
    "simple",
    "a/b",
    "a~b",
    "~",
    "/",
    "~0",
    "~1",
    "~01",
    "~10",
    "a~1b/c~0d",
    "//",
    "~~~",
    "trailing~",
    "/leading",
  ]

  for (const original of roundTripCases) {
    test(`round-trips through escape -> unescape: ${JSON.stringify(original)}`, () => {
      expect(unescapeJsonPointer(escapeJsonPointer(original))).toBe(original)
    })
  }
})

describe("splitPath / joinPath", () => {
  test("splitPath('') returns an empty array (root)", () => {
    expect(splitPath("")).toEqual([])
  })

  test("joinPath([]) returns the empty string (root)", () => {
    expect(joinPath([])).toBe("")
  })

  test("splitPath splits a simple multi-segment path", () => {
    expect(splitPath("/a/b/c")).toEqual(["a", "b", "c"])
  })

  test("splitPath unescapes each segment", () => {
    expect(splitPath("/a~1b/c~0d")).toEqual(["a/b", "c~d"])
  })

  test("joinPath escapes each part and joins with '/'", () => {
    expect(joinPath(["a/b", "c~d"])).toBe("/a~1b/c~0d")
  })

  test("joinPath handles a single part", () => {
    expect(joinPath(["foo"])).toBe("/foo")
  })

  const pathRoundTripCases = [
    "/a/b/c",
    "/a~1b/c~0d",
    "/~01",
    "/0/1/2",
    "/foo/-",
  ]

  for (const path of pathRoundTripCases) {
    test(`round-trips through splitPath -> joinPath: ${path}`, () => {
      expect(joinPath(splitPath(path))).toBe(path)
    })
  }

  test("splitPath -> joinPath round-trips a part that is itself a literal '~1'", () => {
    // Regression guard for the same ordering concern as the escape/unescape
    // suite above, exercised through the split/join pair instead of the raw
    // primitives.
    const parts = ["~1", "normal"]
    const joined = joinPath(parts)
    expect(joined).toBe("/~01/normal")
    expect(splitPath(joined)).toEqual(parts)
  })
})

describe("getValueByPath", () => {
  const doc = {
    a: { b: { c: 42 } },
    list: ["x", "y", "z"],
    "weird/key": "slash-value",
    "weird~key": "tilde-value",
    nested: [{ id: 1, name: "first" }, { id: 2, name: "second" }],
  }

  test("root path ('') returns the whole document", () => {
    expect(getValueByPath<typeof doc>(doc, "")).toBe(doc)
  })

  test("resolves a nested object path", () => {
    expect(getValueByPath<number>(doc, "/a/b/c")).toBe(42)
  })

  test("resolves an array index", () => {
    expect(getValueByPath<string>(doc, "/list/1")).toBe("y")
  })

  test("resolves an object key inside an array element", () => {
    expect(getValueByPath<string>(doc, "/nested/1/name")).toBe("second")
  })

  test("resolves a key containing an escaped '/' (~1)", () => {
    expect(getValueByPath<string>(doc, "/weird~1key")).toBe("slash-value")
  })

  test("resolves a key containing an escaped '~' (~0)", () => {
    expect(getValueByPath<string>(doc, "/weird~0key")).toBe("tilde-value")
  })

  test("returns undefined for a missing object key", () => {
    expect(getValueByPath(doc, "/does/not/exist")).toBeUndefined()
  })

  test("returns undefined for an out-of-range array index", () => {
    expect(getValueByPath(doc, "/list/99")).toBeUndefined()
  })

  test("returns undefined for a negative array index", () => {
    expect(getValueByPath(doc, "/list/-1")).toBeUndefined()
  })

  // '-' is the RFC 6901 / JSON Patch token for "one past the last array
  // element" (used for append targets). It is not a resolvable value
  // location, so getValueByPath must report it as absent rather than
  // throwing or coercing it to index 0.
  test("returns undefined for the '-' array token (not a resolvable element)", () => {
    expect(getValueByPath(doc, "/list/-")).toBeUndefined()
  })

  test("returns undefined when indexing into a non-object/non-array leaf", () => {
    expect(getValueByPath(doc, "/a/b/c/d")).toBeUndefined()
  })

  test("resolves consistently across repeated calls (cache does not corrupt result)", () => {
    expect(getValueByPath<number>(doc, "/a/b/c")).toBe(42)
    expect(getValueByPath<number>(doc, "/a/b/c")).toBe(42)
    expect(getValueByPath(doc, "/list/-")).toBeUndefined()
    expect(getValueByPath(doc, "/list/-")).toBeUndefined()
  })

  // D3 (spec-v1-rc external-review defect round, CORE §1.4.4): getValueByPath
  // memoised results keyed on object identity without any epoch scope, so a
  // resolve -> mutate-in-place -> resolve loop returned the STALE pre-mutation
  // value (probe: read "/a" as 1, set doc.a = 999, then read "/a" again and
  // still get 1). The cache was removed; every resolve now reflects the current
  // document state.
  test("mutate-then-resolve reflects the new value, never a stale cached one", () => {
    const mutable: { a: number } = { a: 1 }
    expect(getValueByPath<number>(mutable, "/a")).toBe(1)
    mutable.a = 999
    expect(getValueByPath<number>(mutable, "/a")).toBe(999)
  })

  test("a path that resolved to undefined re-resolves after the key is added", () => {
    const mutable: Record<string, string> = {}
    expect(getValueByPath(mutable, "/late")).toBeUndefined()
    mutable.late = "here"
    expect(getValueByPath<string>(mutable, "/late")).toBe("here")
  })
})
