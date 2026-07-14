# fast-json-schema-patch — Normative Specification

**Spec version:** `spec-v1`
**Status:** Final. Finalized 2026-07-14 (see §1.3).
**Reference implementation:** the TypeScript package in this repository, `fast-json-schema-patch` v0.4.0 (branch `feat/deep-dive-overhaul`).

---

## 1. Scope, audience, and versioning

### 1.1 Purpose

This document is the single normative source from which independent implementations of
`fast-json-schema-patch` are written. It defines, precisely enough that an implementer never
needs to read the reference source:

- how a *plan* is derived from a JSON Schema (§4);
- how a *diff* between two JSON documents is computed and emitted as an ordered patch (§5);
- the wire format of the emitted patch (§6);
- the round-trip guarantees each array strategy provides (§7);
- how a patch is *applied* to a document (§8) and *inverted* (§9);
- the conformance vector formats and the pass/fail gate (§10).

### 1.2 Audience

Implementers porting the engine to another language (a Go engine is the immediate next
consumer), and authors of conformance vectors.

### 1.3 Spec versioning and stability

- This is `spec-v1`, finalized **2026-07-14** against reference implementation
  `fast-json-schema-patch` v0.4.0 (branch `feat/deep-dive-overhaul`). Section numbers
  (e.g. `5.3.2`) are stable citation anchors; vectors and implementations SHOULD cite them.
- `spec-v1` was finalized after the P1–P4 phases landed (correctness, performance,
  compactness, packaging). Every section the draft marked *(draft-pending)* is now landed in
  the reference implementation and reads as normative; Appendix A records each landed fix
  with its section for provenance.
- **Normative vs. pre-audit HEAD.** This spec describes the semantics of the finalized
  reference implementation. Several behaviors specified here were bug-fixes over the
  pre-audit HEAD (primaryKey fallback §5.4.3, nested-array plan paths §4.3.5, `basePath`
  segment matching §4.6.2, schema traversal without explicit `type` §4.3.1, granular LCS
  descent §5.5.4); all are now landed. Appendix A is the contract-vs-pre-audit-HEAD summary.
- **Patch-format stability.** The patch wire format (§6) is the cross-language compatibility
  surface. Within a major spec version, the set of emitted op kinds, the guaranteed per-op
  fields (§6.3), and the pointer-escaping rules (§3) are stable. Consumers MAY rely on them.
  The *choice of strategy* and the *exact op sequence* for a given input MAY change between
  minor spec versions (they are generator-defined, not format-defined); consumers MUST NOT
  assume byte-identical patches across spec versions, only that any conforming patch applies
  to reproduce the strategy's round-trip contract (§7).

### 1.4 Conformance language (RFC 2119)

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described
in RFC 2119. A conforming implementation MUST satisfy every MUST/MUST NOT/REQUIRED/SHALL in
this document that applies to the capabilities it implements. Capabilities marked OPTIONAL
(§10.4) MAY be omitted.

### 1.5 Out of scope

The human-readable diff/formatting layer (`StructuredDiff`, `DiffFormatter`) is **not** part of
this spec. Behavioral options that do not affect the wire format (structural sharing,
`cloneValues`, `cloneResult`, `validateOldValues`; §8.7) are specified because they govern
apply semantics, but they are not part of the patch format.

---

## 2. Data model

### 2.1 JSON values

`2.1.1` A document is a **JSON value**: one of `null`, boolean, number, string, array (ordered
sequence of JSON values), or object (unordered-by-key set of string→JSON-value members). This is
exactly the value space produced by `JSON.parse`. Inputs MUST be treated as if produced by
`JSON.parse`.

`2.1.2` Behavior on non-JSON inputs (JavaScript `Date`, functions, `undefined` as a value,
`Map`, `RegExp`, circular references, class instances) is **out of scope**. Implementations
SHOULD document their handling. The reference implementation does not defend against these; a
conforming implementation MAY reject them, treat them as opaque leaves, or inherit host
behavior, but MUST document the choice.

`2.1.3` A JSON object MUST NOT contain a member whose value is `undefined` (the absence of a
member and a member mapping to `undefined` are treated identically throughout: see §5.2.1). An
array MUST NOT contain `undefined` elements.

### 2.2 Number semantics

`2.2.1` Numbers are compared and treated as **IEEE-754 double-precision floats** (`f64`). This is
the normative common denominator (JavaScript has no other number type).

`2.2.2` Consequently: `1` and `1.0` are **equal**; `-0` and `0` are **equal** (per `===`; but see
§2.4.3 for `NaN`, which cannot occur in JSON); integers with magnitude `> 2^53` are **not**
faithfully distinguishable (e.g. `9007199254740993` collapses to `9007199254740992`).

`2.2.3` Implementations in languages with richer numeric types (e.g. Go `json.Number`, Rust
`serde_json` arbitrary precision) **MUST** compute all equality and comparison at `f64`
semantics (§2.4). They **SHOULD** preserve the original number *text* when echoing a value into a
patch (`value`, `oldValue`) so that faithful round-tripping of large integers survives
application, even though the differ cannot *distinguish* two numbers that share an `f64` image.
Preserving text MUST NOT change equality: two numbers equal under `f64` MUST be treated as equal
regardless of source text.

### 2.3 Object key order

`2.3.1` Object member **iteration order** is significant to the *generator only*: it fixes the
order in which object members are visited and therefore the order in which per-member ops are
emitted (§5.2.3, §5.7). It is **not** significant to *equality* (§2.4.2) nor to *apply* (§8).

`2.3.2` **Pinned member order (normative).** The reference visits an object's members in
ECMAScript `[[OwnPropertyKeys]]` order — equivalently `Object.keys` — which is **not** pure
insertion order: **all integer-like keys first, in ascending numeric order, followed by every
remaining key in insertion order.** A key is **integer-like** iff it is the *canonical* decimal
string of an array index in the range `0 … 2^32 − 2`; canonical means the exact string `ToString`
would produce — no leading zeros (`"0"` itself is integer-like, `"02"` is not), no sign (`"+2"`,
`"-0"` are not), and no other numeric form (`"2.0"`, `"1e1"`, `" 2"` are not). Thus `"2"` and
`"10"` are integer-like and sort ahead of, and numerically among, each other (`"2"` before
`"10"`), while `"b"`, `"02"`, `"-1"`, and `"3.5"` are ordinary keys kept in insertion order after
all integer-like keys. A conforming generator MUST reproduce this order. Because a plain hash map
(e.g. Go `map[string]any`) preserves **neither** insertion order **nor** the integer-like-first
rule, a conforming generator implemented in such a language **MUST** reconstruct both: read the
document with an order-preserving decoder to recover insertion order, then apply the
integer-like-ascending-first reordering above. Apply/invert (§8, §9) do not depend on key order.

### 2.4 Equality

`2.4.1` **Deep JSON equality** (`deepEqual`) is the sole equality relation used for diffing,
`test` ops, and `oldValue` validation. It is defined recursively:

- Two values are equal iff they have the same JSON type and:
  - **null / boolean / string:** equal by value.
  - **number:** equal under `f64` (§2.2).
  - **array:** same length and, for every index `i`, `arr1[i]` deep-equals `arr2[i]`
    (**order-sensitive**).
  - **object:** same set of member keys and, for every key `k`, `a[k]` deep-equals `b[k]`
    (**key-order-insensitive**).

`2.4.2` Equality is **array-order-sensitive** and **object-key-order-insensitive**. `{"a":1,"b":2}`
equals `{"b":2,"a":1}`; `[1,2]` does not equal `[2,1]`.

`2.4.3` There is no type coercion: `1 ≠ "1"`, `null ≠ false`, `null ≠ 0`, `null ≠ absent-member`.
(`NaN`/`Infinity` are not representable in JSON and cannot appear in a conforming input.)

`2.4.4` Hash prefilters, fingerprint interning, and memoization caches are **implementation
details** and **MUST** be output-neutral: their presence or absence MUST NOT change any emitted
patch, any `test`/validation verdict, or any equality result relative to §2.4.1. In particular, a
cache MUST NOT return a stale verdict after an input is mutated between diffs; implementations
that cache across calls MUST document a no-mutation contract or scope caches per call.

---

## 3. JSON Pointer usage (RFC 6901)

`3.1` All paths in emitted patches and all `path`/`from` fields consumed by apply are **JSON
Pointers** per RFC 6901.

`3.2` **Escaping (encode).** When building a pointer segment from an object key, replace `~`
with `~0`, then `/` with `~1`, **in that order**. Array-index segments and the append token `-`
are never escaped (they contain no `~` or `/`). A conforming generator MUST escape every object
key it places into a pointer (§5.2.3). The empty string is a valid object key and produces the
segment `` (so pointer `/` addresses the member named `""`).

`3.3` **Unescaping (decode).** When resolving a pointer segment, replace `~1` with `/`, then `~0`
with `~`, **in that order**.

`3.4` **Path construction.** A child path is `parentPath + "/" + escape(segment)`. The root
document has path `""` (empty string). A pointer is `""` or a sequence of `/`-prefixed escaped
segments. `splitPath("")` is the empty list; `splitPath("/a/b")` is `["a","b"]` after unescaping.

`3.5` **The `-` append token.** `-` denotes the position one past the last array element (RFC 6901
§4). It is valid as the final segment of an `add` op path and, by delegation to `add`, as a
`move`/`copy` **destination** final segment (§8.3). Apply MUST reject `-` **in any non-final
segment**, and as the final segment of a `remove`, `replace`, or `test`, or as a `move`/`copy`
**source** final segment. On the **write side** (`remove`/`replace` finals and any non-final
segment) rejection is `INVALID_POINTER`; on the **read side** (`test` finals and `move`/`copy`
**source** finals) `-` fails own-index resolution and surfaces as `PATH_UNRESOLVABLE` (§3.6, §8.6).
(An OPTIONAL non-RFC "remove last" extension is **deferred to a future spec version** and is
not part of spec-v1: the reference implementation does not implement it and the §10.4 capability
registry does not list it. See Appendix A, *Deferred to a future spec version*.)

`3.6` **Array-index syntax.** An array-index segment MUST match `^(0|[1-9][0-9]*)$`: a single `0`,
or a nonzero digit followed by digits. Leading zeros (`01`), signs (`-0`, `+1`), decimals
(`1.5`), and non-digits are invalid indices against an array container (§8.6). Rejection is
`INVALID_POINTER` **only on write-side resolution** — an `add`/`remove`/`replace` target or any
intermediate segment along the way. On **read-side resolution** (a `test` target, or a
`move`/`copy` **source**) the malformed segment instead fails existence and surfaces as
`PATH_UNRESOLVABLE` (§8.6). A segment is interpreted as an array index only when the container it
addresses is an array; against an object the same segment is an ordinary member key (§8.2.3).

---

## 4. Plan model

A **Plan** is derived once from a JSON Schema by `buildPlan` and reused across many diffs. It maps
*document paths* to *array strategies*. A conforming implementation MUST produce an equivalent
plan (same array-path → strategy/primaryKey/required-fields mapping) so that strategy selection
at diff time (§5.4) matches.

### 4.1 Types

```
ArrayPlan = {
  primaryKey:     string | null            // the key field, or null
  strategy:       "primaryKey" | "unique" | "lcs"
  requiredFields: Set<string>  (optional)  // item schema's required[]
  hashFields:     string[]     (optional)  // required + primitive-typed fields (prefilter hint)
  itemSchema:     Schema        (optional)  // NON-NORMATIVE: internal, never read at diff time
}
Plan = Map<documentPath, ArrayPlan>
```

`4.1.1` `hashFields` and `itemSchema` are **non-normative optimization metadata**. `hashFields`
is a prefilter hint only (§5.4.4) and MUST be output-neutral; `itemSchema` is never consulted at
diff time and MAY be omitted entirely. `primaryKey`, `strategy`, and `requiredFields` are the
output-relevant fields; their derivation from a schema is directly falsifiable via the
plan-snapshot vector format (§10.6).

### 4.2 `buildPlan` inputs

```
BuildPlanOptions = {
  schema:         Schema                    // the JSON Schema (REQUIRED)
  primaryKeyMap?: Record<documentPath, string>   // per-path primaryKey override
  basePath?:      string                    // restrict/relativize plan keys (§4.6)
}
```

### 4.3 Schema traversal

Traversal starts at the root schema with document path `""` and recurses, accumulating an
escaped document path. A `visited` set of schema-node object identities guards against reference
cycles: a node currently on the traversal stack is not re-entered; it is removed from the set when
its subtree completes (so the same shared subschema may be reached again via a different path).

`4.3.1` A schema node is traversed as an **object** when it has `properties` or
`additionalProperties`, and as an **array** when it has `items`, **regardless of whether an
explicit `type` keyword is present**. (Landed, P1 fix F40. Pre-audit HEAD gated on
`type === "object"` / `type === "array"`, so a node with `properties` but no `type` yielded no
plan and its arrays degraded to `lcs`; the reference now keys off the shape keywords.)

`4.3.2` **Object node.** For each member `key` in `properties`, recurse into
`properties[key]` at path `parentPath + "/" + escape(key)`. If `additionalProperties` is a schema
object (not a boolean), recurse into it at path `parentPath + "/*"` (the literal wildcard segment
`*`). Member keys are visited in the schema's own-key order.

`4.3.3` **Array node.** Construct an `ArrayPlan` (§4.4), register it at the current path
(subject to `basePath`, §4.6), then recurse into `items` at the **same** path (array element
paths gain their index at diff time, not during plan building) — except as amended by §4.3.5 for
nested arrays.

`4.3.4` **`$ref`.** Only **local** references (`#/...`) are resolved, by walking the `/`-split
JSON Pointer into the root schema. A non-local `$ref` (e.g. `http://…`, `#no-slash`) resolves to
nothing: the node is skipped and its subtree is not traversed (arrays beneath it get no plan and
fall back to `lcs`). Resolving a `$ref` does **not** change the document path. Implementations
SHOULD route the "unsupported reference" notice through a caller-suppressible channel rather than
writing to stdout/stderr unconditionally.

`4.3.5` **Nested arrays (array-of-arrays).** When an array's `items` is itself an array schema,
the inner array MUST be registered at a **distinct** document path (a wildcard element segment is
appended, e.g. `parentPath + "/*"`), so the inner plan never overwrites the outer array's plan at
the same key. (Landed, P1 fix F04. At pre-audit HEAD, `items` was traversed at the same path, so
an inner primaryKey plan clobbered the outer `lcs` plan and the outer array — whose elements are
arrays, not keyed objects — silently produced no ops. The fix gives each array nesting level its
own plan path and the diff-time lookup, §5.4.5, resolves the extra level.)

`4.3.6` **`anyOf` / `oneOf` / `allOf`.** For each of these keywords present on a node, traverse
every branch schema at the **current** path. Branches are **de-duplicated by structural
fingerprint within the same keyword's branch list only** (the dedup set is reset per keyword): a
canonical JSON string with recursively sorted object keys (a stable stringify) is computed per
branch, and a branch whose fingerprint was already seen **in that same keyword's list** is
skipped. Fingerprints are **not** shared across `anyOf`/`oneOf`/`allOf` at a node, so an identical
branch appearing under two different keywords is traversed once per keyword. The fingerprint's
cycle guard treats a re-encountered node as `undefined`.

### 4.4 Constructing an ArrayPlan

Given an array node with resolved item schema `itemsSchema` (if `items` is a `$ref`, it is
resolved once per §4.3.4; if resolution fails, the unresolved `items` is used):

`4.4.1` Start with `{ primaryKey: null, strategy: "lcs" }`.

`4.4.2` **Primitive items → `unique`.** If `itemsSchema.type` is exactly `"string"`, `"number"`,
or `"boolean"`, set `strategy = "unique"`. (A primitive item array is a candidate for the
`unique` strategy, gated at diff time by §5.4.4.)

`4.4.3` **`primaryKeyMap` override.** If `primaryKeyMap[currentPath]` is set, set
`primaryKey = that value` and `strategy = "primaryKey"` unconditionally (overriding §4.4.2 and
§4.5). The override is trusted; no property-existence check is performed at plan time.

`4.4.4` Otherwise, if items are **not** primitive, run primary-key auto-detection (§4.5).

### 4.5 Primary-key auto-detection

`4.5.1` Auto-detection runs over an **object item schema**. Resolve the candidate schema:

- If `itemsSchema` has `anyOf` or `oneOf`, examine each branch **in array order** and use the
  first branch that yields a primary key (§4.5.3).
- Otherwise examine `itemsSchema` directly.

Each candidate schema (a branch, or `itemsSchema` itself) is first reduced to a synthetic object
view by the **`allOf` merge** (§4.5.1.1) before §4.5.2/§4.5.3 run against it.

`4.5.1.1` **`allOf` merge.** (Landed, P1 fix F35.) Reduce a candidate schema `s` to a
single object view, `mergeAllOf(s)`:

1. If `s` has a `$ref`, resolve it (§4.3.4); if resolution fails, `s` is used unchanged (no merge).
2. If the (resolved) node has **no** `allOf`, it is returned unchanged.
3. Otherwise a synthetic view `{ type: "object", properties, required }` is built: `properties` is
   the union of the node's own `properties` with each `allOf` branch's **recursively merged** view
   `properties`, later branches overriding earlier ones on a key collision (base first, then
   branches in array order); `required` is the **set-union** of the node's own `required` with each
   branch's merged `required`. Nested `allOf` and a branch's leading `$ref` are handled by the
   recursion. (At pre-audit HEAD `allOf` was skipped entirely, so a `primaryKey` — or required fields —
   declared only inside an `allOf` branch was never found and the array degraded to its base
   strategy. This merge makes such schemas surface a key. `allOf` merging applies inside `anyOf`/
   `oneOf` branches too, since each branch is passed through `mergeAllOf`.)

`4.5.2` For the merged candidate view `s` (§4.5.1.1): require `s.type === "object"` **and**
`s.properties` present, else no key. Let `required = new Set(s.required || [])`.

`4.5.3` **Candidate key list.** Check the ordered candidate list — the `primaryKeyCandidates`
option, **defaulting to `["id", "name", "port"]`** when the option is omitted (§4.5.5). For
each candidate `key` in order: if `required.has(key)` **and** `properties[key].type` is `"string"`
or `"number"`, select it as the primary key and stop. If none qualifies, there is no primary key.
An **empty** candidate list checks nothing, so auto-detection never selects a key (the array keeps
its base strategy); a `primaryKeyMap` override (§4.4.3) is applied **before** this step and does
not consult the list, so it still wins under any candidate list, empty included.

`4.5.4` **Effect of selection.** If a primary key is found, set `primaryKey = key`,
`strategy = "primaryKey"`, `requiredFields = required`, and `hashFields` = the required fields
whose `properties[f].type` is `"string"` or `"number"` (built by iterating `required` in set
order; §5.4.4 uses these only as a prefilter). If no key is found, the plan keeps its base
strategy from §4.4.1/§4.4.2.

`4.5.5` (Landed, F25.) The candidate list `["id","name","port"]` is the **DEFAULT** of
the `primaryKeyCandidates` build-plan option (§10.4, capability registry). Passing an ordered list
replaces the default wholesale (no merge); passing `[]` disables auto-detection. `primaryKeyMap`
takes precedence over any candidate list (§4.5.3). Because `name` and `port` are commonly
user-editable, editing the chosen key field turns an in-place edit into a remove+append under the
primaryKey strategy (§7.2) — a known compactness cost, not an error; overriding the list (e.g. to
`["id"]`) avoids it.

### 4.6 `basePath`

`4.6.1` When `basePath` is absent, plan keys are the full document paths from the root.

`4.6.2` (Landed, P1 fix F14.) When `basePath` is set, only array paths **at or under**
`basePath` on a **segment boundary** are registered, and their keys are **relativized** by
stripping the `basePath` prefix. Formally, a path `P` is in-base iff `P === basePath` **or**
`P` starts with `basePath + "/"`; the registered key is `P.slice(basePath.length)`. (Pre-audit
HEAD used `startsWith(basePath)` + string `replace`, which wrongly matched sibling prefixes —
`/env` capturing `/envelope` — and could strip mid-segment, producing keys that never matched at
diff time. The reference now uses segment-boundary matching and length-based slicing.) Traversal
still descends through non-matching prefixes so nested in-base arrays are reachable.

### 4.7 Strategy ranking and plan merge

When two schema nodes map to the **same** document path (e.g. via `anyOf` branches, or
`$ref` fan-in), their plans are reconciled:

`4.7.1` **Rank:** `primaryKey` (3) > `unique` (2) > `lcs` (1). The higher-ranked strategy wins.

`4.7.2` If ranks tie, the plan **with** a `primaryKey` beats the one without.

`4.7.3` If still tied, the plan with **more** `hashFields` wins (a non-normative preference among
otherwise output-equivalent plans).

`4.7.4` **Metadata merge.** When the incoming candidate wins, supplemental metadata from the
displaced plan is merged into it; when it loses, its metadata is merged into the retained plan.
Merge rules: `hashFields` become the set-union of both; `requiredFields` are taken from whichever
plan has them if the target lacks them. This merge is non-normative (it only affects prefilter
hints) but is specified so implementations produce identical `hashFields` for vector comparison
(the plan-snapshot vector format, §10.6, compares `hashFields` order-insensitively).

---

## 5. Diff algorithm

`JsonSchemaPatcher.execute({ original, modified })` returns an ordered `Operation[]`. It walks
`original` and `modified` in lockstep from the root path `""`, dispatching per §5.1.

### 5.1 Dispatch (`diff(a, b, path)`)

Given values `a` (from original) and `b` (from modified) at `path`:

`5.1.1` If `a` and `b` are the **same reference**, emit nothing. (Reference identity is a fast
path; it MUST be output-equivalent to §2.4.1, i.e. only taken when the values are truly equal.)

`5.1.2` If `a` is absent (`undefined`) and `b` is present: emit `add` (handled by the parent
container; see §5.2 for objects, and note the root is always present).

`5.1.3` If `b` is absent and `a` is present: emit `remove` (handled by the parent container).

`5.1.4` **Type mismatch or primitive.** If either value is a primitive (`null`, boolean, number,
string), or one is an array and the other is not, emit a single
`{ op: "replace", path, value: b, oldValue: a }` and stop. (Two values of different container kind
— object vs array — are a replace, never a structural merge.)

`5.1.5` If both are **arrays**, dispatch to array diff (§5.4).

`5.1.6` If both are **objects**, dispatch to object diff (§5.2).

Values equal under §2.4.1 but not reference-identical produce no ops because the recursion bottoms
out with no differing leaf.

### 5.2 Object diff

`5.2.1` A member with value `undefined` is treated as **absent** (§2.1.3). "Present" means the key
is an own member with a non-`undefined` value.

`5.2.2` **Key visitation order.** Visit the union of `original`'s keys and `modified`'s keys as:
**all of `original`'s keys in `original`'s pinned member order (§2.3.2), followed by the keys
present only in `modified` in `modified`'s pinned member order (§2.3.2).** Because the pinned
order places integer-like keys ascending-first, this means the integer-like keys of `original`
(ascending) precede its ordinary keys (insertion order), and likewise for the `modified`-only
keys. (The reference implements this as two passes — `Object.keys(original)`, then
`Object.keys(modified)` skipping any already own-present on `original` — each of which yields
`[[OwnPropertyKeys]]` order natively; this is output-equivalent to, but allocates less than,
forming `new Set([...keys(original), ...keys(modified)])` and iterating it; F36.) A conforming
generator MUST reproduce this visitation order (§2.3.2).

`5.2.3` For each visited `key`, let `childPath = path + "/" + escape(key)` (§3.2):

- present in `modified` only → `{ op: "add", path: childPath, value: modified[key] }` (no
  `oldValue`).
- present in `original` only → `{ op: "remove", path: childPath, oldValue: original[key] }`.
- present in both → recurse `diff(original[key], modified[key], childPath)` (§5.1).

### 5.3 Array diff dispatch

`5.3.1` The array's strategy is looked up from the plan by path (§5.4.5). If no plan is found, the
strategy is `lcs` (§5.5).

`5.3.2` Selection then applies **runtime gates**:

- `strategy === "primaryKey"` **and** `plan.primaryKey` set **and** the arrays satisfy the
  primaryKey applicability gate (§5.4.3) → primaryKey diff (§5.4).
- else `strategy === "unique"` **and** `checkArraysUnique(a, b)` true (§5.4.4) → unique diff
  (§5.6).
- else → LCS diff (§5.5).

`5.3.3` The dispatcher MAY use per-path caches (a "plan is empty" flag, a "simple path" set, a
negative-plan set). These are **non-normative** and MUST be output-neutral: the emitted patch MUST
equal what §5.3.1–§5.3.2 produce with a direct lookup.

### 5.4 primaryKey strategy

Applies when a plan gives `strategy === "primaryKey"` with a non-null `primaryKey` **and** the
gate (§5.4.3) passes. Let `k = plan.primaryKey` and `prefix = path + "/"`.

#### 5.4.1 Normative three-phase emission

`5.4.1.1` **Phase 1 — index the original.** For each index `i` in `original`, if `original[i]` is
an object with a key-value `original[i][k]` that is a **string or number** (not `undefined`/
`null`/other), record `keyToIndex[keyValue] = i` and remember the item.

`5.4.1.2` **Phase 2 — scan the modified.** For each index `j` in `modified` (in order), let
`item = modified[j]`; skip if `item` is not an object or `item[k]` is `undefined` or not a
string/number. Look up `keyToIndex[item[k]]`:

- **Matched** (`oldIndex` found): remove that entry from `keyToIndex`. If the original item and
  the modified item are **not deep-equal** (§2.4.1; a hash prefilter §5.4.6 may fast-path the
  negative but MUST agree with deep-equal), recurse `diff(originalItem, modifiedItem, prefix +
  oldIndex)` — emitting **field-level ops at the item's ORIGINAL index** — into the
  *modification* group.
- **Unmatched** (new key): append `{ op: "add", path: prefix + "-", value: item }` to the
  *addition* group (§3.5 append token).

`5.4.1.3` **Phase 3 — removals.** The keys remaining in `keyToIndex` are original items with no
match in modified. Collect their original indices, **sort descending**, and for each emit
`{ op: "remove", path: prefix + index, oldValue: originalItem }` into the *removal* group.

`5.4.1.4` **Concatenation order (normative).** The final ops for this array are
`modifications ++ removals ++ additions`, in that order:

1. **modifications** — field-level ops at original indices, in the order modified items were
   scanned (Phase 2 order);
2. **removals** — in **descending original index** order;
3. **additions** — `/-` appends, in modified appearance order.

This ordering is REQUIRED (§5.7 explains why it is round-trip-correct under sequential apply). It
is the **default** emission; with the optional `emitMoves` capability on, the three-phase emission
is replaced by the move machinery (§5.8.7) that reconstructs `modified` order exactly.

`5.4.1.5` **Key equality (normative).** Index construction (Phase 1) and lookup (Phase 2) MUST
treat two primaryKey values as the same key **iff they are equal by JSON type AND value** (§2.4.3):
no coercion is performed, so a numeric key `1` and a string key `"1"` are **distinct** keys and
never match each other (as are, e.g., `true` and `"true"` — though only string/number keys are
indexed at all, §5.4.1.1). The reference stores keys in a `Map` keyed by the raw string/number
value, which distinguishes `1` from `"1"` natively.

#### 5.4.2 Worked example

Original `users = [{id:a,name:A},{id:b,name:B},{id:c,name:C}]`; modified
`[{id:c,name:C2},{id:a,name:A},{id:d,name:D},{id:e,name:E}]` (schema keys on `id`) emits, in
order:

```
{op:"replace", path:"/users/2/name", value:"C2", oldValue:"C"}   // mod: c at ORIGINAL index 2
{op:"remove",  path:"/users/1", oldValue:{id:"b",name:"B"}}       // removal (b), descending
{op:"add",     path:"/users/-", value:{id:"d",name:"D"}}          // additions in modified order
{op:"add",     path:"/users/-", value:{id:"e",name:"E"}}
```

#### 5.4.3 Applicability gate and fallback *(landed — P1 fixes F05/F06)*

Before committing to the primaryKey strategy, the differ MUST verify, in one `O(n+m)` pass over
both arrays, that:

- **(a)** every element of both arrays is an **object** whose value at `k` is a **string or
  number** (present, non-null); **and**
- **(b)** there are **no duplicate** key values within `original` and none within `modified`.

If either check fails, the array **MUST fall back to `lcs` (§5.5)** for this diff. (At pre-audit
HEAD, neither check was performed: non-conforming elements were silently skipped — added/removed
items vanished from the patch — and duplicate keys corrupted the index, so even identical arrays
could emit a growing patch. The gate makes both cases well-defined via `lcs`, which is exact.) A
`primaryKeyMap` override (§4.4.3) selects the strategy but does **not** bypass this gate; a
gate-failing array still falls back to `lcs`.

#### 5.4.4 `checkArraysUnique` (gate for `unique`)

`checkArraysUnique(a, b)` returns true iff: `a.length === b.length`, **and** `a` has no two
deep-equal elements, **and** `b` has no two deep-equal elements. (The reference uses a `Set` of
element references over primitive arrays; because `unique` is only assigned to primitive item
schemas, reference-set uniqueness coincides with deep-equal uniqueness for the values it sees.)
If the check fails, the array falls back to `lcs`.

#### 5.4.5 Plan lookup by structural trie matching *(matching algorithm — normative for strategy selection)* *(landed — P2 fixes F18/F33)*

The `Plan` map (§4.1) is **compiled once** into a **trie** and matched **structurally** by
threading the current trie node down the diff recursion — no concrete path string is ever
normalized or looked up, and no per-path caches are kept. (Pre-audit HEAD instead re-derived
a concrete path per array and probed the flat map with exact / index-normalized / single-trailing-
wildcard string keys, which grew four unbounded per-instance caches, F18, mis-routed numeric
object keys via index-normalization, F33, and could not reach a wildcard plan at arbitrary depth
or at the top level. The trie makes all four issues structural.)

`5.4.5.1` **Trie construction.** Each plan key is split on `/` into segments (the empty key `""`
— a root-level array document — has zero segments and terminates at the root node). A `*` segment
is the node's **wildcard edge**; any other segment is **unescaped** (§3.3) and is an exact
**child edge** keyed by the raw property name. The `ArrayPlan` is stored on the node where its key
terminates. (Because `buildPlan` emits both an `additionalProperties` value and a nested-array
element level as the literal segment `*`, a schema property whose name is literally `"*"` is
indistinguishable from the wildcard edge — a pinned edge case, §B.1, not latitude.)

`5.4.5.2` **Threaded matching.** The diff starts at the trie root (an **empty plan threads no
node**, so every array is `lcs`). The node is advanced by the container being descended:

- **Object member `key`** (§5.2): the child node is the node's **exact child** for `key` if one
  exists, **else** its **wildcard** edge, **else none**. *Exact edges take precedence over the
  wildcard edge at every level* — an `id` property beats `additionalProperties`. A member whose key
  is a decimal-digit string (e.g. `"0"`) is an ordinary exact/​wildcard descent and is **never**
  conflated with an array index (§F33), because array indices are consumed only in the array rule.
- **Array element** (§5.4/§5.5 recursing into an item): an **object** element **stays at the
  array's own node** (array items share the array's document path, §4.3.3, so an item property's
  plan is a child of the array's node); an **array** element (array-of-arrays) descends to the
  array node's **wildcard** edge — the inner array's `${path}/*` plan (§4.3.5). A mixed-kind
  element pair does not descend (§5.1 emits a whole `replace`), so its node is immaterial.

`5.4.5.3` **Strategy selection.** An array's strategy is the `plan` on the trie node reached for
that array, or `lcs` when the node is absent or carries no plan. Under the (non-normative,
output-neutral, §5.3.3) `hashFields`/negative caches the reference may keep, the result MUST equal
this structural lookup.

**Consequences (formerly pinned limitations, now specified matches):** an `additionalProperties`
(wildcard) plan is reachable at **any depth**, including a **deeper** key such as `/*/items` for a
concrete path `/envA/items`, a nested `/*/x/*/items`, **and a top-level `/*`** plan key for a
concrete root array member such as `/foo` (the old `lastIndexOf('/') > 0` guard is gone). Numeric-
string object keys route by construction. The exact-over-wildcard precedence is the only tie-break.
The nested-array wildcard element level (§4.3.5) is matched by the array-element rule above.

#### 5.4.6 Hash-field prefilter (non-normative)

`hashFields` MAY be used to fast-path the "items differ" decision in Phase 2: if any hash field
differs, the items differ without a full deep-equal; only if all hash fields match is a full
deep-equal performed. This MUST be output-neutral (§2.4.4) — it may only *shortcut to a
deep-equal-consistent verdict*, never override it.

### 5.5 LCS strategy (default)

Applies when no plan matches, when the plan strategy is `lcs`, or as the fallback from §5.4.3 /
§5.4.4 / §5.6. It computes a shortest edit script by **Myers' O(ND) diff** and emits positional
ops. LCS reconstruction is **always exact** (§7.1).

Let `prefix = (path === "" ? "/" : path + "/")` throughout §5.5 (so a root-level array uses `/`
before the index, never a bare `/`).

#### 5.5.0 Common prefix/suffix trimming (normative step 0)

Before running Myers, the differ **MUST** trim the shared ends of the two arrays and run the
remainder of the algorithm on the trimmed **window** only. This is step 0 of the normative LCS
algorithm; §5.5.1–§5.5.5 operate on the window it produces.

`5.5.0.1` **Trim order (pinned).** Compute the **maximal common prefix first**, then the
**maximal common suffix of the remainder**, using the same deep-equal predicate (§2.4.1) as the
snake (§5.5.2):

- `lo` ← the largest value such that `original[i]` deep-equals `modified[i]` for every
  `i` in `0..lo-1` (so `lo` stops at the first differing pair, or at `min(n, m)`).
- `hi` ← the largest value such that `original[n-1-j]` deep-equals `modified[m-1-j]` for every
  `j` in `0..hi-1`, **subject to** `hi ≤ n - lo` and `hi ≤ m - lo` (the suffix scan never crosses
  into the already-consumed prefix).

The **window** is `original[lo .. n-hi)` (length `wn = n - lo - hi`) and
`modified[lo .. m-hi)` (length `wm = m - lo - hi`). Because prefix is taken before suffix, the
split is deterministic even when the same element could belong to either end — e.g.
`[a,b,a] → [a,a]` fixes the prefix `a` first (`lo=1`), then the suffix `a` (`hi=1`), leaving the
window `[b] → []` and emitting a single `remove` at index `lo`.

`5.5.0.2` **Index offset.** Emission (§5.5.5) begins with `currentIndex = lo`: the `lo` trimmed
prefix elements are unchanged `common` entries that occupy output indices `0..lo-1` and are never
emitted. Window coordinates `(x, y)` map to array indices `(lo + x, lo + y)` for both equality
comparisons and value retrieval. The pinned Myers tie-breaks (§5.5.2) therefore apply to the
**window**.

`5.5.0.3` **Window fast paths.** If `wn = 0` and `wm = 0`, the arrays are deep-equal and **no ops**
are emitted. If `wn = 0` (pure insertion — append, prepend, or interior insert), emit
`{ op: "add", path: prefix + (lo + j), value: modified[lo + j] }` for `j` from `0` to `wm-1`
(ascending). If `wm = 0` (pure deletion — truncate, or prefix/suffix/interior removal), emit
`{ op: "remove", path: prefix + (lo + j), oldValue: original[lo + j] }` for `j` from `wn-1` down
to `0` (**descending**). The §5.5.1 empty-array paths are the `lo = 0, hi = 0` special case of
these window fast paths.

#### 5.5.1 Empty-array fast paths

These are the degenerate case of §5.5.0 when one array is empty (`lo = hi = 0`); an implementation
MAY special-case them ahead of the trim scan.

- `original` empty, `modified` length `m`: for `i` from `0` to `m-1`, emit
  `{ op: "add", path: prefix + i, value: modified[i] }` (ascending).
- `modified` empty, `original` length `n`: for `i` from `n-1` down to `0`, emit
  `{ op: "remove", path: prefix + i, oldValue: original[i] }` (**descending**, each carrying
  `oldValue`).

#### 5.5.2 Myers forward pass and tie-break (pinned)

Throughout §5.5.2–§5.5.3, `n`, `m`, `original`, and `modified` denote the **trimmed window** of
§5.5.0: `n = wn`, `m = wm`, `original[x]` is array element `original[lo + x]`, and `modified[y]`
is array element `modified[lo + y]`. (When no trimming applies, `lo = hi = 0` and the window is the
whole array.)

Standard greedy Myers with these pinned choices (an implementer MUST match them, since they fix
*which* shortest script is chosen and therefore the exact op sequence):

- `max = n + m`; diagonal index `k` ranges `-d..d` step 2 at edit-distance `d`; the V-array is
  offset by `max`. `V[offset+1] = 0` seeds the pass.
- **V-buffer initialization (pinned).** The V-buffers are sized `2·max + 1` and **all cells
  initialize to `-1`**; only `V[offset+1]` is then seeded to `0`. Any read of a diagonal outside
  the allocated range (`kOffset ≤ 0` on the left, `kOffset ≥ bufSize-1` on the right) is likewise
  taken as `-1`. These `-1` sentinels feed the `V[k-1] < V[k+1]` tie-break (next bullet) at the
  diagonal extremes, fixing the down/right choice there and therefore the exact shortest script
  chosen.
- For each `k`: **go down** (advance in `modified`, i.e. an insertion) when `k === -d`, **or**
  (`k !== d` **and** `V[k-1] < V[k+1]`); otherwise **go right** (advance in `original`, a
  deletion). "Down" takes `x = V[k+1]`; "right" takes `x = V[k-1] + 1`. Then `y = x - k`.
- **Snake:** while `x < n` and `y < m` and `original[x]` deep-equals `modified[y]` (§2.4.1),
  advance both. Equality here MAY be memoized/interned but MUST equal deep-equal.
- Terminate when `x >= n` and `y >= m`; that `d` is the edit distance.

Equality comparisons during the pass MUST be exact deep-equal (§2.4.4). The reference implementation
**interns** each window element to an integer id via a canonical, key-sorted fingerprint shared
across both arrays (equal fingerprint ⟺ deep-equal for JSON inputs, §2.4.1–§2.4.2), so the snake
compares `idsA[x] === idsB[y]` in O(1). Fingerprint interning is an output-neutral implementation
detail (§2.4.4); a lossy hash MUST confirm id-equality collisions with full deep-equal. An
implementation MAY instead memoize deep-equal per visited pair, but any such pair-cache key MUST be
collision-free for the array sizes in play (`x*(m+1)+y` is exact to ~`2^53` elements; a `(x<<16)|y`
style key that collides past 65535 elements is **non-conforming**).

#### 5.5.3 Backtracking and the edit script

Backtrack from `(n, m)` to `(0, 0)` following the same down/right rule against the recorded
V-rows, producing a forward-ordered script of `common(ai,bi)`, `remove(ai)`, and `add(bi)`
entries.

#### 5.5.4 Replace collapse and granular descent

`5.5.4.1` **Collapse.** Scan the forward script; whenever a `remove` is immediately followed by an
`add`, collapse the pair into a single `replace` at the same output index.

`5.5.4.2` **Granular descent (normative default).** For a collapsed `replace` pair
`(original[ai], modified[bi])`: if **both** sides are objects, **or both** are arrays, the differ
**MUST recurse** — `diff(original[ai], modified[bi], prefix + currentIndex)` — emitting granular
nested ops instead of a whole-item replace. If the pair is primitive, or the two sides are of
mismatched container kind (object vs array), it stays a **whole-item** `{ op: "replace", path,
value: modified[bi], oldValue: original[ai] }`. The recursion reuses the ordinary `diff` dispatch,
so nested plans apply: an object element recurses at the array's own plan node (item property plans
are its children, §4.3.3); an array element recurses into the nested-array wildcard plan at
`${path}/*` (§4.3.5). This descent (F10) is the one LCS behavior that changed during the
compactness phase; before it, a whole-item replace was always emitted for a collapsed pair.

#### 5.5.5 Emission from the script

Walk the (collapsed) script maintaining `currentIndex` starting at `lo` (§5.5.0.2 — the trimmed
common prefix occupies output indices `0..lo-1`); `prefix` as above:

- **common:** if both `original[ai]` and `modified[bi]` are objects/arrays, recurse
  `diff(...)` at `prefix + currentIndex` (they are already deep-equal per the snake, so this
  yields no ops; it is a no-op that MUST NOT emit anything — an implementation MAY skip it).
  `currentIndex++`.
- **replace** (§5.5.4): emit a whole-item replace at `prefix + currentIndex`; `currentIndex++` —
  **unless granular descent applies** (§5.5.4.2), in which case recurse
  `diff(original[ai], modified[bi], prefix + currentIndex)` at `prefix + currentIndex` instead of
  emitting a whole-item replace, and still `currentIndex++`.
- **remove:** emit `{ op: "remove", path: prefix + currentIndex, oldValue: original[ai] }`;
  `currentIndex` is **not** incremented (subsequent ops address the shifted array).
- **add:** emit `{ op: "add", path: prefix + currentIndex, value: modified[bi] }`;
  `currentIndex++`.

The resulting ops are index-correct under strict sequential application (§7.1).

### 5.6 unique strategy

Applies when `strategy === "unique"` **and** `checkArraysUnique(a, b)` passed (§5.4.4), which
requires **equal lengths**. Let `prefix = path + "/"`.

`5.6.1` **Normative behavior: positional replaces.** For each index `i` in `0..length-1`, if
`original[i]` is not deep-equal to `modified[i]`, emit
`{ op: "replace", path: prefix + i, value: modified[i], oldValue: original[i] }`. Because the gate
guarantees equal lengths, no adds or removes are emitted. spec-v1 defines `unique` solely as
equal-length positional replacement (F38: a HEAD-era removal/addition phase built atop this loop was
provably unreachable behind the equal-length gate and has been deleted from the reference
implementation — this **is** the whole function now, not a fallback path).

`5.6.2` **Unequal lengths fall back to `lcs`** (§5.4.4 gate fails → §5.5). Set-diff / move
semantics for `unique` are **not** specified in spec-v1.

`5.6.3` **`emitMoves` (§5.8.6).** With the optional `emitMoves` capability on, a **multiset-equal**
(pure-permutation) unique array is emitted as `move`s instead of positional replaces (a 50-element
rotation drops from 50 replaces to one move); a non-multiset-equal pair keeps the §5.6.1 positional
replaces. Default output (capability off) is unchanged.

### 5.7 Emission-order guarantees (normative)

`5.7.1` Ops are emitted in **document order** and are correct **only under strict sequential
application** (§8.1). A consumer MUST NOT reorder, batch, deduplicate, or parallelize them.

`5.7.2` Within a keyed array, the order is fixed as §5.4.1.4 (modifications at original indices,
then removals descending, then `/-` appends in modified order). Within an LCS array, ops follow
the evolving index per §5.5.5. Across object members, ops follow §5.2.2.

`5.7.3` The reason descending removals + trailing appends round-trips: removing higher indices
first keeps lower indices valid; modifications are addressed at pre-removal indices and applied
before any removal shifts them; `/-` appends land after all removals so they target the final
tail. See §7.

### 5.8 `emitMoves` capability (normative when enabled)

`emitMoves` is an **OPTIONAL** capability (default **off**, §10.4.4). When **off**, every array
strategy emits exactly the ops specified in §5.4–§5.6 and output is byte-stable versus the
pre-capability tree. When **on**, all three strategies share **one** machinery that expresses a
relocated (unchanged) array element as a single RFC 6902 `move` instead of a remove+add pair, and
makes `unique` and `primaryKey` reconstruct `modified` **order exactly** (§7.2 is upgraded, §7.4).
This section pins that machinery so a reimplementation emits byte-identical ops.

`5.8.1` **Bijection model.** Each strategy reduces its array diff to: a set of **matched** pairs
`(src, tgt, changed)` — a bijection between a subset of `original` indices `src` and a subset of
`modified` indices `tgt`, where `changed` is true iff `original[src]` is **not** deep-equal
(§2.4.1) to `modified[tgt]`; a set of **pureDeletes** (original indices with no match); and a set
of **pureInserts** (modified indices with no match). `matched ∪ pureDeletes` partitions
`0..n-1`; `matched ∪ pureInserts` partitions `0..m-1`. How each strategy computes the bijection is
§5.8.5–§5.8.7; the emission (§5.8.2–§5.8.4) is shared and identical.

`5.8.2` **LIS (pinned tie-break).** Let `seq` be a permutation of `0..S-1`. `LIS(seq)` is the set
of **indices into `seq`** forming a longest strictly-increasing subsequence, computed by this
**exact** canonical procedure (a Go implementer MUST reproduce it verbatim, since which LIS is
chosen when several tie fixes which elements move):

```
tails = []            // tails[k] = index into seq of the smallest tail of an increasing
prev  = [-1] * S      //            subsequence of length k+1
for i in 0..S-1:
    // lower_bound: smallest pos with seq[tails[pos]] >= seq[i]
    lo, hi = 0, len(tails)
    while lo < hi:
        mid = (lo + hi) >> 1
        if seq[tails[mid]] < seq[i]: lo = mid + 1
        else:                        hi = mid
    if lo > 0:            prev[i] = tails[lo - 1]
    if lo == len(tails):  tails.append(i)
    else:                 tails[lo] = i
// reconstruct by following prev from the LAST appended tail
result = []
k = tails[last]
while k != -1: result.append(k); k = prev[k]
reverse(result)
```

Because `seq` has distinct values, `lower_bound` and `upper_bound` coincide; the reconstruction
from `tails[last]` realizes the **leftmost/smallest-source-index** LIS (the pinned tie-break).

`5.8.3` **`computeMoves(seq)` (pinned).** `seq` is a permutation of `0..S-1`: the element at
source position `p` must end at target rank `seq[p]`. The elements whose **source positions** are
in `LIS(seq)` are the **fixed skeleton** and are NEVER moved; every other element is relocated by
exactly one `move`. Maintain a `working` list (source positions, initially identity `0..S-1`) and
`srcOfTarget[t]` = the source position with target rank `t`. Process target ranks **right-to-left**
(`t` from `S-1` down to `0`); for each non-skeleton `srcOfTarget[t]`: let `from` = its current
index in `working`; splice it out; let `to` = `working.length` when `t === S-1`, else the current
index in `working` of `srcOfTarget[t+1]` (insert immediately before the already-final element to
its right); splice it back at `to`. Emit `{from, to}` **unless `from === to`** (no-op moves are
dropped). Both indices are in the length-`S` array's own coordinate space.

`5.8.4` **Staged emission (pinned order).** Emit ops in exactly four stages, in this order:

1. **removes** — `pureDeletes` in **descending** index; each `{op:"remove", path: prefix+src,
   oldValue?}` (`oldValue` per §6.4.2). After this the array is the survivors in original order.
2. **moves** — build `seq` by ordering `matched` by `src` (ascending) and mapping each to its rank
   in the `matched`-ordered-by-`tgt` list; emit `computeMoves(seq)` as `{op:"move", from:
   prefix+from, path: prefix+to}` (moves carry NO `value`/`oldValue`). Indices are in the
   survivors-only space of this moment (after removes, before inserts).
3. **inserts** — `pureInserts` in **ascending** target index; each `{op:"add", path: prefix+tgt,
   value: modified[tgt]}` — an **INDEXED** add, never `/-`.
4. **replaces** — `matched` with `changed === true`, in **ascending** target index; a same-kind
   pair (both objects or both arrays) **recurses** (granular descent, §5.5.4.2) at `prefix+tgt`,
   otherwise a whole-item `{op:"replace", path: prefix+tgt, value: modified[tgt], oldValue?}`. The
   array is at full `modified` length here, so every target index is final.

`prefix = (path === "" ? "/" : path + "/")`. This sequence reconstructs `modified` **exactly**
(order and duplicates) under sequential apply (§8.1); verified by exhaustive small-permutation and
randomized bijection fuzzing against both the reference applier and fast-json-patch.

`5.8.5` **LCS mapping (F22).** With `emitMoves` on, the LCS strategy (§5.5) runs unchanged through
the trim (§5.5.0), Myers pass (§5.5.2), backtrack, and collapse (§5.5.4.1), then — on the main
window path only (the move-free fast paths §5.5.0.3/§5.5.1 already emit the staged ops) — builds
the bijection instead of the §5.5.5 walk: trimmed-prefix indices `i<lo` and trimmed-suffix indices
are `matched(i, i', changed:false)`; a `common` script entry is `matched(changed:false)`; a
`replace` entry is `matched(changed:true)`; a leftover `remove` and leftover `add` are **paired
into a relocation `matched(changed:false)` iff their interned ids are equal** (exact deep-equal,
§5.5.2 — so a move NEVER pairs non-identical values). Pairing is deterministic: for each interned
id, leftover adds are queued in ascending target order, and each leftover remove (in script order)
claims the **earliest unused** add of its id. Unpaired removes are `pureDeletes`; unpaired adds are
`pureInserts`. Then §5.8.4 emits. Granular descent (§5.5.4.2) still applies via stage 4.

`5.8.6` **unique mapping (F23).** With `emitMoves` on, when the `unique` gate passes (§5.4.4 —
equal length, no duplicates in either side) **and** the two arrays are **multiset-equal** (same
value set, hence a pure permutation), the bijection is `matched(src, tgt, changed:false)` for every
element, where `tgt` is the (unique) index of `original[src]`'s value in `modified`; `pureDeletes`
and `pureInserts` are empty; §5.8.4 emits pure `move`s (stages 1/3/4 empty). If the arrays are
**not** multiset-equal, the strategy keeps the §5.6 positional-replace emission unchanged (moves buy
nothing there and would cost a remove+add per differing element). Equal-length + unique + multiset-
equal is exactly the reorder case §5.6 emits as `N` positional replaces by default (`emitMoves` off).

`5.8.7` **primaryKey mapping (F07).** With `emitMoves` on, the primaryKey strategy (§5.4), under the
same applicability gate (§5.4.3), replaces its three-phase emission (§5.4.1) with the bijection:
index `original` by key (§5.4.1.1); for each `modified[j]`, if its key matches an original index
`i`, add `matched(i, j, changed: !deepEqual(original[i], modified[j]))`; unmatched `modified[j]`
are `pureInserts` (`j`); original keys never matched are `pureDeletes`. Then §5.8.4 emits — so
survivors are **reordered** into `modified` order via `move`s and new keys are **INDEXED** adds at
their `modified` position (never `/-`), making `applyPatch(original, p)` equal `modified`
**byte-exactly** (order included). This upgrades §7.2 to §7.4 for this array. The gate still governs:
non-conforming / duplicate-key arrays fall back to `lcs`, which under `emitMoves` uses §5.8.5.

### 5.9 `wholesaleReplaceFallback` capability (normative when enabled)

`wholesaleReplaceFallback` is an **OPTIONAL** capability (default **off**, §10.4.5). When **off**,
array diffing is exactly §5.4–§5.8 and output is byte-stable versus the pre-capability tree. When
**on**, it is evaluated **per array, at every array-diff call site** (the top-level array of a diff
and, independently, every nested array reached through granular descent, §5.5.4.2 / §5.8.4 stage 4) —
**after** the array's strategy (§5.4/§5.6/§5.5, composing with `emitMoves` §5.8 if also on) has
produced its op list for that array:

`5.9.1` **Nesting order (bottom-up).** Because granular descent recurses through the ordinary `diff`
dispatch, a nested array is itself a `diffArray` call site and makes its **own** independent
cutover decision — using only the ops it itself would emit and its own array's serialized size —
**before** whatever it emits (its granular ops, or its own single wholesale replace) becomes part
of its parent array's op list. The parent's cutover decision is then made over its own op list,
which may already contain a child's wholesale replace.

`5.9.2` **Byte estimate (pinned).** For an array's produced op list `ops`, the estimate is:

```
estimate = sum over op in ops of:
    30                                              // fixed per-op overhead
  + (op.value    !== undefined ? len(JSON.stringify(op.value))    : 0)
  + (op.oldValue !== undefined ? len(JSON.stringify(op.oldValue)) : 0)
```

This is a **cheap, deterministic stand-in** for the serialized patch size — NOT
`len(JSON.stringify(ops))` — pinned exactly (including the `30` constant) so a reimplementation
reaches the identical cutover decision on the identical input. `move` ops (no `value`/`oldValue`)
contribute only the 30B overhead.

`5.9.3` **Threshold and cutover.** Let `threshold = len(JSON.stringify(modified))` (the array's own
serialized size). If `estimate > threshold`, **discard** the array's op list entirely and emit
instead a single `{ op: "replace", path, value: modified, oldValue: original }` (`oldValue` present
iff `includeOldValue`, §6.4.2) at the array's own path. Otherwise emit the array's op list
unchanged. The comparison is **strict `>`** — a tie keeps the granular ops.

`5.9.4` **Determinism.** §5.9.2–§5.9.3 depend only on the op list a supported strategy/capability
combination would otherwise produce and on `JSON.stringify` of the array values, both of which are
themselves normatively pinned elsewhere in this spec (§5.4–§5.8, §2.2) — so the cutover decision is
fully deterministic and Go-reproducible given a conforming `JSON.stringify`-equivalent serializer
(same number/string encoding, §2.2–§2.3; key order does not affect the byte **count**).

`5.9.5` This capability is orthogonal to strategy selection (§4.7) and to `emitMoves`/
`includeOldValue`: it never changes *which* strategy runs, only whether that strategy's output (or
`emitMoves`'s, if also on) is kept or replaced wholesale for a given array.

---

## 6. Patch format

### 6.1 Operation object

An emitted operation is a JSON object:

```
Operation = {
  op:       "add" | "remove" | "replace" | "move"  // "move" ONLY under emitMoves (§5.8, §6.1.1)
  path:     JSONPointer                      // always present
  value?:   JsonValue                        // present on add and replace (never on move)
  oldValue?: JsonValue                       // this library's extension; see §6.4
  from?:    JSONPointer                      // ONLY on emitted `move` ops under emitMoves (§6.1.1)
}
```

`6.1.1` **In the default capability mode** (`emitMoves` off), the **generator** (`execute`) emits
only `add`, `remove`, and `replace`, and never emits `from`. The remaining RFC 6902 ops (`copy`,
`test`) and `from` are **accepted by apply** (§8) for third-party patches but are not produced by
diffing in this mode.

**Carve-out — `emitMoves` (§5.8).** When the OPTIONAL `emitMoves` capability is enabled (§5.8,
§10.4.4), the generator **additionally emits `move` ops**, each carrying a `from` pointer and no
`value`/`oldValue` (§5.8.4). This is the only path by which `execute` produces a `move` op or a
`from` field. With `emitMoves` off — the default, and the only mode the spec-v1 conformance
vectors cover (§10.4) — the "add/remove/replace only, never `from`" guarantee holds exactly.
`copy` and `test` are never emitted in either mode.

### 6.2 RFC 6902 conformance

`6.2.1` With `oldValue` stripped (§6.4, `toRfc6902`), every emitted op is a valid RFC 6902
operation and applies under any conforming RFC 6902 applier — with the single caveat that `/-`
append paths (used by primaryKey/unique adds, §6.3) require the applier to support RFC 6901's `-`
token (RFC 6902-standard; the reference and fast-json-patch both accept it, including at root).

### 6.3 Guaranteed fields per op

| op | `path` | `value` | `oldValue` | notes |
|----|--------|---------|------------|-------|
| `add` | ✔ | ✔ | ✘ (never) | `value` is the added value; adds carry no `oldValue`. |
| `remove` | ✔ | ✘ | ✔ (default mode) | `oldValue` is the removed subtree (§6.4). |
| `replace` | ✔ | ✔ | ✔ (default mode) | `value` new, `oldValue` old (§6.4). |

`6.3.1` **Append paths.** primaryKey additions (§5.4.1.2) and — in the general/primitive case —
`unique` additions use `path` ending in `/-`. **LCS never emits `/-`:** it emits **concrete
indices** for all adds, including empty-source additions (`/0`, `/1`, …; §5.5.1) and in-place adds
(§5.5.5). A conforming consumer MUST handle both concrete-index and `/-` add paths.

`6.3.2` **`oldValue` presence is capability-governed.** The "✔ (default mode)" cells for
`remove`/`replace` above hold under the **default** `includeOldValue = true` (SPEC §6.4, capability
registry §10.4). Under the opt-out `includeOldValue = false`, `oldValue` is present on **no** op;
`add` never carries it in either mode. The `path`/`value` cells are unaffected.

`6.3.3` **`move` ops are capability-governed.** The table above is the default-mode op set. Under
the OPTIONAL `emitMoves` capability (§5.8, §10.4.4) the generator also emits `move` ops; a `move`
carries `path` and `from` and **no** `value`/`oldValue` (§5.8.4, §6.1.1). No `move` op is emitted
with `emitMoves` off.

### 6.4 `oldValue` extension

`6.4.1` `oldValue` is a **non-RFC-6902 extension**. In the **default** capability mode it is
present on every `remove` and `replace`, carrying the complete pre-change subtree. It exists to
support `invertPatch` without the original document and to feed the formatting layer. It is
back-compat default-on.

`6.4.2` The `includeOldValue = false` capability (§10.4) suppresses `oldValue` on all
remove/replace ops. It is **OPTIONAL**, default off, and **spec-v1 conformance vectors cover
default mode only.** Suppressing `oldValue` disables `invertPatch` without the original document
(§9).

`6.4.3` `toRfc6902(patches)` returns a copy with `oldValue` stripped from every op, yielding
strict RFC 6902 patches. It changes no other field and MUST NOT double-escape paths.

---

## 7. Round-trip contracts

These are testable guarantees relating `execute` output to sequential `applyPatch` (§8). Let
`p = execute({original, modified})`.

### 7.1 LCS and unique: exact reconstruction

`7.1.1` For any array diffed by **LCS** (§5.5), `applyPatch(original-context, p)` reproduces
`modified` **exactly**, including array order and duplicates. LCS ops are purely positional.

`7.1.2` For any array diffed by **unique** (§5.6), reconstruction is likewise **exact** (positional
replaces at equal length); the unequal-length case is exact via its LCS fallback (§5.6.2).

`7.1.3` Whole-document: for documents whose arrays are all LCS/unique (or object-only, §5.2),
`applyPatch(original, p)` deep-equals `modified` exactly (object key order MAY differ; equality is
key-order-insensitive, §2.4.2).

### 7.2 primaryKey: keyed-collection contract

`7.2.1` The primaryKey strategy is **order-insensitive by design**. Applying `p` yields:

> **[ surviving items in ORIGINAL relative order, each carrying the field-level content from
> `modified` ] ++ [ new keys in `modified` appearance order ]**

`7.2.2` The result is **multiset-equal** to `modified` (same items by key with modified content),
but array **position is not preserved**: a survivor keeps its original relative position; new
items are appended at the tail. This was verified 500/500 in randomized fuzzing.

`7.2.3` **Pure reorders emit zero ops** (matched items are deep-equal, so nothing is emitted).
Applying an empty patch reproduces `original`, a permutation of `modified`. This is intentional,
not a defect.

`7.2.4` `applyPatch(original, p)` is **byte-exact** to `modified` only when `modified` already has
the canonical shape (survivors in original order, additions only at the tail). Nested primaryKey
arrays (keyed arrays inside keyed arrays) inherit the same per-level contract.

`7.2.5` Under the §5.4.3 gate, arrays that would violate keyed-collection assumptions (non-object
/ keyless / non-string-number-key elements, or duplicate keys) fall back to LCS and therefore get
the **exact** contract (§7.1) instead.

`7.2.6` `7.2.1`–`7.2.4` describe the **default** (`emitMoves` off). With the optional `emitMoves`
capability on (§5.8.7, §10.4.4), this contract is **upgraded to exact byte-for-byte reconstruction**
(order included): survivors are reordered via `move`s and new keys are INDEXED adds. See §7.4.

### 7.3 Invert round-trip

`7.3.1` For the original document `D` and `p = execute` output, `applyPatch(applyPatch(D, p),
invertPatch(D, p))` **deep-equals `D`** (§9). The inverse is computed against the ORIGINAL `D`.

### 7.4 `emitMoves`: exact reconstruction across all strategies

`7.4.1` With `emitMoves` on (§5.8, §10.4.4), **every** strategy reconstructs `modified`
**exactly** (deep-equal including array order and duplicates) under sequential apply (§8):

| strategy | `emitMoves` off | `emitMoves` on |
|----------|-----------------|-----------------|
| LCS (§5.5) | exact (§7.1.1) | exact — relocations become `move`s (§5.8.5) |
| unique (§5.6) | exact (§7.1.2) | exact — multiset-equal reorders become `move`s (§5.8.6); non-multiset-equal keeps §5.6 positional replaces |
| primaryKey (§5.4) | keyed-collection, order-insensitive (§7.2) | **exact** — survivors reordered + INDEXED adds (§5.8.7) |

`7.4.2` The upgrade is strict for **primaryKey**: §7.2's contract ("survivors in original relative
order ++ new keys at the tail", order **not** preserved) becomes byte-exact order equality when the
capability is on. LCS and unique were already exact (§7.1); `emitMoves` only changes *which ops*
express the same reconstruction (fewer, smaller ops), never the reconstructed document.

`7.4.3` Verified by exhaustive small-permutation enumeration and >1M randomized bijection trials
(deletes + inserts + changes + reorders, with duplicate values) against **both** the reference
applier and fast-json-patch; every trial reproduced `modified` exactly.

### 7.5 `wholesaleReplaceFallback`: size-capped reconstruction

`7.5.1` With `wholesaleReplaceFallback` on (§5.9, §10.4.5), an array whose granular op stream is
discarded for size reasons is instead reconstructed by a single whole-array `replace`, which is
trivially exact (§7.1-style) regardless of which strategy would otherwise have applied. The
capability changes **only** the op stream for oversized arrays; it never changes the reconstructed
document, and composes with `emitMoves`/`includeOldValue` (the estimate is computed on whatever
those capabilities would otherwise emit).

---

## 8. Apply semantics

`applyPatch(document, patches, options?) → document'` applies an `Operation[]` and returns the
new document. It accepts all six RFC 6902 ops plus this library's `oldValue` and `/-` extensions,
so it can consume both generated and third-party patches.

### 8.1 Sequential, atomic application

`8.1.1` Ops are applied **strictly in order**, never reordered/batched/deduplicated (§5.7).

`8.1.2` Application is **atomic (all-or-nothing)** in the default (immutable) mode: if any op
fails, a `JsonPatchError` is thrown and the input document is left **untouched**. Structural
sharing (§8.7.1) provides this rollback for free.

`8.1.3` The input document is **never mutated** in the default mode. The result shares untouched
subtrees by reference with the input (copy-on-write; §8.7.1).

### 8.2 Path resolution

`8.2.1` `path` is split into unescaped segments (§3.3). An empty path (`""`) addresses the whole
document (§8.5).

`8.2.2` To reach the **parent** of the target, every intermediate segment MUST already exist (RFC
6902: no implicit creation). A missing intermediate → `PATH_UNRESOLVABLE`. Descending through a
primitive → `PATH_UNRESOLVABLE`.

`8.2.3` **Container-type dispatch.** At each step, the *actual* container type decides
interpretation: against an **array**, the segment is an index (§3.6) or `-` (add only); against an
**object**, the segment is a member key (numeric-looking keys are ordinary keys). Never infer from
the path shape.

### 8.3 Per-op behavior

| op | precondition | effect | new-root? |
|----|--------------|--------|-----------|
| `add` | must have `value`; parent exists | array: **insert** at index (or append at `-`), shifting; object: **set** member (overwrites if present, RFC 6902 §4.1) | path `""` → returns `value` as new document |
| `remove` | path non-empty; target exists | array: **splice out** at index; object: **delete** member | never (root remove invalid, §8.5) |
| `replace` | must have `value`; target exists | array: **overwrite** at index; object: **set** existing member | path `""` → returns `value` |
| `move` | must have `from`; `from` exists; `from` not a proper prefix of `path` | `remove(from)` then `add(path, from-value)` | via add |
| `copy` | must have `from`; `from` exists | **deep-clone** `from`-value then `add(path, clone)` | via add |
| `test` | target exists | assert target deep-equals `value` (§2.4.1); else `TEST_FAILED` | no change |

`8.3.1` **`add` index range:** `add` accepts index `== length` (append) and `-`; index `> length`
→ `INDEX_OUT_OF_BOUNDS`. **`remove`/`replace` index range (split rule):** the `-` append token is
rejected with `INVALID_POINTER`; a well-formed numeric index `>= length` is rejected with
`INDEX_OUT_OF_BOUNDS` (index `< length` is required). **`test` index range:** because `test`
resolves **read-side** (§8.6), both a `-` final and a numeric index `>= length` fail existence and
surface as `PATH_UNRESOLVABLE`, not `INVALID_POINTER`/`INDEX_OUT_OF_BOUNDS`.

`8.3.2` **`add` overwrites an existing object member** (does not error); a member mapping to
`undefined` and an absent member behave identically.

`8.3.3` **`move`** rejects `from` being a proper prefix of `path` (moving a node into its own
descendant) with `INVALID_OPERATION`. **`copy`** MUST deep-clone so the result never aliases the
source (later ops mutating one must not affect the other).

`8.3.4` **`test`** uses **exact deep-equal** (§2.4.1), never a hash/memo prefilter that could be
fooled.

`8.3.5` **Error precedence (normative).** When an op could fail for more than one reason, checks
are evaluated in this fixed order and the **first** applicable failure is thrown: (1) a **missing
required field** — `value` on `add`/`replace`, `from` on `move`/`copy` — → `INVALID_OPERATION`;
then (2) **pointer/index syntax and bounds** (§3.5, §3.6, §8.3.1: `INVALID_POINTER`,
`INDEX_OUT_OF_BOUNDS`, and, on write-side object segments, the `UNSAFE_KEY` guard §8.6.1); then
(3) **existence** of the target or an intermediate segment (§8.2.2) → `PATH_UNRESOLVABLE`; then
(4) **value checks** — `OLD_VALUE_MISMATCH` (§8.4) or `TEST_FAILED` (§8.3). (Thus e.g. an `add`
missing `value` with an also-malformed index throws `INVALID_OPERATION`, not `INVALID_POINTER`;
verified by probe.)

### 8.4 `oldValue` validation

`8.4.1` When `options.validateOldValues` is true, every `remove`/`replace` op **that carries
`oldValue`** is checked before applying: the current document value at `path` MUST deep-equal
`oldValue`, else `OLD_VALUE_MISMATCH` (atomic abort). This is equivalent to an interleaved `test`.

`8.4.2` Ops **without** `oldValue` (all adds; third-party patches; suppressed-mode removes/
replaces) are applied **unchecked** even when `validateOldValues` is true (validation is skipped,
not failed).

### 8.5 Root operations

`8.5.1` `add` or `replace` at path `""` **replaces the entire document** with `value` (possibly
changing its type); the new root is the return value.

`8.5.2` `remove` at path `""` is **invalid** → `INVALID_OPERATION`.

### 8.6 Error codes

A failing op throws `JsonPatchError { message, code, operation, operationIndex }`. `code` is one
of:

| code | meaning |
|------|---------|
| `INVALID_POINTER` | malformed pointer on **write-side** resolution (add/remove/replace targets and intermediates, move/copy destinations): `-` on a remove/replace final or any non-final segment (§3.5), leading-zero/sign/decimal array index (§3.6). Read-side malformed/`-` segments surface as `PATH_UNRESOLVABLE` instead. |
| `PATH_UNRESOLVABLE` | a target or intermediate segment does not exist (§8.2.2); remove/replace of a nonexistent member; a malformed or `-` segment encountered during **read-side** resolution — `test`, or a `move`/`copy` **source** (§3.5, §3.6); a read-side `__proto__`/`constructor`/`prototype` segment (§8.6.1) |
| `INDEX_OUT_OF_BOUNDS` | array index out of range for the op (§8.3.1) |
| `TEST_FAILED` | `test` value mismatch (§8.3) |
| `OLD_VALUE_MISMATCH` | `validateOldValues`: document value ≠ `oldValue` (§8.4) |
| `INVALID_OPERATION` | unknown op; missing required field (`value`/`from`); remove at root; `move` into own child |
| `UNSAFE_KEY` | prototype-pollution guard tripped (§8.6.1) |

`8.6.1` **Prototype-pollution guard (write-side only).** During **write-side** resolution
(`add`/`remove`/`replace` targets and intermediates, and `move`/`copy` **destinations**), a
pointer segment equal to `__proto__` (**anywhere** on the write-side path) is rejected with
`UNSAFE_KEY`. A segment equal to `prototype` is rejected **only** when its *immediately preceding*
segment is `constructor`. Standalone `constructor` and standalone `prototype` (not preceded by
`constructor`) are legitimate JSON object keys and MUST remain usable. The guard is checked on
every object segment traversed and on the final object segment; it does not apply to array-index
segments. **Read-side** resolution (`test` targets and `move`/`copy` **sources**) does **not** run
this guard: it resolves segments by own-property lookup (`Object.hasOwn`), so a `__proto__`,
`constructor`, or `prototype` segment simply fails existence and surfaces as `PATH_UNRESOLVABLE`,
never `UNSAFE_KEY`.

`8.6.2` `operationIndex` is the 0-based index of the failing op within `patches`. `operation` is
the failing op unmodified.

### 8.7 Behavioral options (not part of the wire format)

`8.7.1` **Structural sharing (default).** In immutable mode, only containers **on a touched path**
are cloned (copy-on-write); a per-call set of already-cloned containers ensures each is cloned at
most once across the whole patch, so N ops on one branch clone it once. Untouched sibling subtrees
keep reference identity (`===`) with the input — usable for memo/change-detection. **Hazard:**
because untouched subtrees are shared, **mutating the returned document can mutate the input**; a
caller intending to mutate the result MUST use `cloneResult` (§8.7.3).

`8.7.2` **`cloneValues`** (default false): when true, each op's `value` payload is deep-cloned
before insertion so the result never aliases objects owned by the patch. When false, values are
inserted **by reference** (do not mutate patch ops after applying).

`8.7.3` **`cloneResult`** (default false): when true, the returned document is a fully independent
deep clone sharing no structure with the input or the patch.

`8.7.4` These options change memory/aliasing behavior only; for a given input+patch they produce
a document **deep-equal** to the default-mode result (§2.4.1). They are not encoded in the patch
and are irrelevant to cross-language vector comparison.

`8.7.5` The empty patch (`[]`) returns the input unchanged; in immutable mode it returns the
**same reference**.

---

## 9. Invert semantics

`invertPatch(document, patches) → Operation[]` returns the inverse of `patches` relative to the
document they were generated from.

### 9.1 Contract

`9.1.1` `document` MUST be the **ORIGINAL** (pre-patch) document. It is required to resolve `/-`
append paths to concrete indices, to recover removed/replaced values when `oldValue` is absent,
and to restore values overwritten by `add`/`move`/`copy` onto existing members.

`9.1.2` **Guarantee:** `applyPatch(applyPatch(D, patches), invertPatch(D, patches))` deep-equals
`D` (§7.3), for any `D` on which `patches` applies cleanly. The inverse is guaranteed against the
forward-applied state, not against an arbitrary document that merely deep-equals `D` up to array
order (index-based ops would mistarget after a reorder).

### 9.2 Inversion rules (forward-simulated)

`invertPatch` simulates the forward patch op-by-op against a copy of `document` (so each inverse
is computed against the correct pre-op state), collects inverses, then **reverses** the collected
list. Per op:

| forward | inverse |
|---------|---------|
| `add` at a **new** array position / new object member | `remove` at that path (concrete index for `/-`, resolved against pre-op array length) |
| `add`/`copy` **overwriting** an existing object member | `replace` restoring the pre-op value |
| `add`/`replace` at root `""` | `replace` at `""` restoring the pre-op root |
| `remove` | `add` at the path with the pre-op value (from the live document; `oldValue` not required because `document` is provided) |
| `replace` | `replace` at the path with the pre-op value |
| `move` | reverse `move` (`from`↔`path`); if the destination overwrote an existing member, also restore it |
| `copy` | `remove` (or `replace` restoring an overwritten member) |
| `test` | passed through unchanged |

`9.2.1` A `remove`/`replace` whose forward target does not exist in the simulated document →
`PATH_UNRESOLVABLE`. Unknown op / missing `from` → `INVALID_OPERATION`.

`9.2.2` Because inversion is driven by the live simulated document (not solely by `oldValue`), it
correctly inverts third-party patches and non-trailing `/-` interleavings. Generated patches in
default mode also carry `oldValue`, which is sufficient but not necessary here.

---

## 10. Conformance

### 10.1 Diff vector format

A diff vector is a JSON record:

```
{
  "name":     string,                 // unique id
  "comment":  string,                 // optional human note / spec citation
  "schema":   Schema | null,          // omitted/null → diff with an empty plan (schemaless)
  "options":  { primaryKeyMap?, basePath?, capabilities?: {...} },  // optional
  "original": JsonValue,
  "modified": JsonValue,
  "expectedPatch": Operation[]        // default capability mode (oldValue present)
}
```

`10.1.1` The implementation under test computes `buildPlan(schema, options)` (empty plan when
`schema` is null), then `execute({original, modified})`, and compares against `expectedPatch` per
the gate (§10.3).

### 10.2 Apply vector format

An apply vector is a JSON record:

```
{
  "name":    string,
  "comment": string,                  // optional
  "doc":     JsonValue,
  "patch":   Operation[],
  "options": { validateOldValues?, cloneValues?, cloneResult? },  // optional
  // exactly one of:
  "expected": JsonValue,              // applyPatch(doc, patch, options) MUST deep-equal this
  "error":    { "code": PatchErrorCode, "index": number }   // OR apply MUST throw this
}
```

`10.2.1` For an `error` vector, apply MUST throw `JsonPatchError` with the given `code` and
`operationIndex === index`. For an `expected` vector, the result MUST deep-equal `expected`
(§2.4.1) and MUST NOT throw. Invert round-trips have their own dedicated vector format (§10.7).

### 10.3 The conformance gate (normative)

A diff vector **passes** iff **both** hold:

`10.3.1` **(a) Round-trip.** The emitted op sequence, applied sequentially under RFC 6902 (§8) to
the vector's `original`, reproduces the expected document per the strategy's round-trip contract
(§7): **exact** deep-equality for LCS/unique/object-only diffs; **multiset-equal with canonical
survivor+append order** for primaryKey diffs.

`10.3.2` **(b) Structural op equality.** The emitted op sequence is **structurally equal** to the
vector's `expectedPatch`: same length, same ordered sequence of ops, each op equal by `op`, `path`
(as a string), and — where present — `value`/`oldValue`/`from` under deep JSON equality (§2.4.1,
so numbers compare at `f64` and object key order within values is insignificant).

`10.3.3` **Byte-identity of serialized JSON is NOT required.** Differences in number *text*
(§2.2.3), object key *order within values* (§2.4.2), or insignificant whitespace do not fail a
vector. Op *ordering* in the sequence **is** significant and is checked by §10.3.2.

`10.3.4` A conforming generator MUST pass every default-mode diff vector; a conforming applier
MUST pass every apply vector for the ops it supports.

### 10.4 Capability registry

Capabilities are **OPTIONAL** features, default off, with **no spec-v1 vectors** unless noted.
An implementation advertises which it supports; conformance is evaluated only over supported
capabilities.

| capability | default | status | effect |
|------------|---------|--------|--------|
| `includeOldValue=false` | on (oldValue present) | OPTIONAL — **landed** (§10.4.2) | suppress `oldValue` on all remove/replace (§6.4.2); disables document-free invert |
| `emitMoves` | off | OPTIONAL — **landed** (§10.4.4) | emit RFC 6902 `move` for relocated elements; exact-order `unique`/`primaryKey` (§5.8) |
| `wholesaleReplaceFallback` | off | OPTIONAL — **landed** (§10.4.5) | emit a single container `replace` when the granular patch would exceed the container's own serialized size (§5.9) |
| `primaryKeyCandidates` | `["id","name","port"]` | OPTIONAL — **landed** (§10.4.3) | override the auto-detection candidate list (§4.5.5) |

`10.4.1` **Granular LCS descent (§5.5.4.2) is NOT a capability** — it is normative default
behavior in `spec-v1`, landed in the compactness phase (F10). It is always on; there is no flag to
disable it. `spec-v1` conformance vectors are generated from this finalized behavior: a same-kind
(object↔object or array↔array) changed LCS element yields the granular nested ops descent emits,
while primitive or mismatched-kind replacements stay whole-item (§5.5.4.2).

`10.4.2` **`includeOldValue` (F11).** Surfaced as the `JsonSchemaPatcher` constructor option
`includeOldValue?: boolean`, **default `true`** (back-compat: identical, byte-for-byte, to the
pre-capability output). When `false`, **every** `oldValue`-producing emission site is suppressed —
object-member removes/replaces (§5.2), the type-mismatch/opaque-leaf replace (§5.1.4), primaryKey
removals (§5.4), LCS removals and whole-item replaces including the empty-window fast paths (§5.5),
and unique removals/replaces (§5.6). `add` ops are identical in both modes (they never carry
`oldValue`). Granular same-kind descent (§5.5.4.2) recurses through the shared object/array differ,
so nested ops it emits also honor the flag. The flag changes **only** the presence of the
`oldValue` key; `op`, `path`, `value`, op ordering, and op count are unchanged. `invertPatch`
(§9) is unaffected because it recovers pre-change values from the **original document** it is given,
not from `oldValue`; the round-trip identity §9.1.2 holds under either mode. Measured savings on the
compactness repro shapes: 26–51% on typical remove/replace-heavy diffs, up to ~86x when a large
subtree is removed (a 2.7 KB removal drops from 2680 B to 31 B).

`10.4.4` **`emitMoves` (F22/F23/F07).** Surfaced as the `JsonSchemaPatcher` constructor option
`emitMoves?: boolean`, **default `false`** (byte-for-byte identical to the pre-capability output).
When `true`, all three array strategies route through the shared move machinery (§5.8): a relocated
**deep-equal** element becomes a single RFC 6902 `move` instead of a remove+add pair, and the
`unique`/`primaryKey` strategies reconstruct `modified` **order exactly**. The one capability
defines three landings, each pinned in §5.8: **LCS relocations** (§5.8.5, F22 — a relocated ~596 B
item drops from 1279 B as remove+add to ~39 B as a move); **unique reorders** (§5.8.6, F23 — a
50-element rotation drops from 4271 B as 50 replaces to ~40 B as one move); and **primaryKey order
fidelity** (§5.8.7, F07 — survivors are reordered and insertions are INDEXED adds so the applied
result equals `modified` byte-exactly, upgrading §7.2 to §7.4). A `move` NEVER pairs non-identical
values (§5.8.5). The pinned **LIS** tie-break (§5.8.2) and right-to-left move emission (§5.8.3) make
the emitted op sequence deterministic and Go-reproducible. `move` ops carry no `oldValue`;
`remove`/`replace` still honor `includeOldValue` (§6.4.2), and `emitMoves` composes with it. The
apply layer (§8.3) already supports `move`, so emitted patches round-trip through both the reference
applier and any conforming RFC 6902 applier (verified against fast-json-patch).

`10.4.3` **`primaryKeyCandidates` (F25).** Surfaced as the `buildPlan` option
`primaryKeyCandidates?: string[]`, **default `["id", "name", "port"]`** (§4.5.3/§4.5.5 —
byte-for-byte identical plans when omitted). It replaces the ordered candidate list consulted by
primary-key auto-detection **wholesale** (no merge with the default). `[]` disables auto-detection
so every object array keeps its base strategy (`lcs`/`unique`). A `primaryKeyMap` entry is applied
before auto-detection and bypasses the candidate list, so it wins under any list, empty included
(§4.5.3). Only strategy **selection** is affected; the diff/apply algorithms and every emitted op
are unchanged given the resulting plan.

`10.4.5` **`wholesaleReplaceFallback` (F24).** Surfaced as the `JsonSchemaPatcher` constructor
option `wholesaleReplaceFallback?: boolean`, **default `false`** (byte-for-byte identical to the
pre-capability output). When `true`, every array-diff call site (§5.9) buffers its would-be op list,
applies the pinned byte estimate (§5.9.2), and — if the estimate exceeds the array's own serialized
size (§5.9.3) — discards it in favor of a single whole-array `replace`. Measured on the audit's
12-item/~7.2 KB complete-rewrite repro shape (every element's LCS-comparable fields differ, so
Myers finds no common elements and the granular stream is a full remove-all + add-all): the
`includeOldValue:false` granular stream is well over 2x the array's own bytes, while the wholesale
replace is capped at exactly the new array's bytes (plus the fixed op envelope); the decision is
strict — a small diff's estimate (typically a few touched fields) stays far under the whole array's
own size and never triggers. Composes with `emitMoves` (the estimate is computed on the
moves-emitted stream, §5.9.5) and with `includeOldValue` (governs whether the wholesale replace
itself carries `oldValue`, and is folded into the estimate for the discarded stream via §5.9.2).

### 10.5 Vector provenance

Vectors SHOULD be harvested from the reference test suite and from randomized fuzzing (the
primaryKey contract §7.2 was pinned at 500/500 trials; LCS exactness at 800/800; invert at
300/300). New vectors for schema-derived plan corners (§4) SHOULD be authored by hand, since the
existing suite under-covers plan derivation.

`10.5.1` **primaryKey gate coverage (REQUIRED).** The vector suite MUST include at least one diff
vector for **each** §5.4.3 gate-failure class, each asserting the `lcs` **fallback** (exact
reconstruction, §7.1) rather than keyed emission: (a) an array element that is **not an object**;
(b) an element whose primaryKey value is **missing, `null`, or not a string/number**; and (c) a
**duplicate** primaryKey value within `original` **or** within `modified`. A `primaryKeyMap`
override (§4.4.3) MUST NOT bypass the gate — a gate-failing override case SHOULD also be covered.

### 10.6 Plan-snapshot vector format (normative)

To make §4 plan derivation falsifiable independently of any diff, a **plan-snapshot vector** is a
JSON record:

```
{
  "name":    string,                          // unique id
  "schema":  Schema,                          // REQUIRED
  "options": { primaryKeyMap?, basePath? },   // optional
  "expectedPlan": [                           // sorted by `path`
    {
      "path":           documentPath,
      "primaryKey":     string | null,
      "strategy":       "primaryKey" | "unique" | "lcs",
      "requiredFields": string[],   // sorted; [] when absent
      "hashFields":     string[]    // sorted; [] when absent
    }
  ]
}
```

`10.6.1` The implementation under test computes `buildPlan(schema, options)` and compares the
resulting `documentPath → ArrayPlan` map against `expectedPlan`: the **set of paths** must match,
and for each path the `primaryKey`, `strategy`, `requiredFields` (as a sorted string array), and
`hashFields` (as a sorted string array) must match. `itemSchema` (§4.1.1) is **never** compared.
Both the entry list and the two field arrays are compared **order-insensitively** (by sorting);
the `expectedPlan` array is authored sorted by `path` for readability. This format makes the §4
derivation — including §4.1.1 (which fields are output-relevant) and §4.7.4 (metadata merge /
`hashFields`) — directly falsifiable.

### 10.7 Invert vector format (normative)

To make §9 inversion falsifiable independently of the diff generator, an **invert vector** is a
JSON record:

```
{
  "name":            string,          // unique id
  "comment":         string,          // optional human note / spec citation
  "document":        JsonValue,       // the ORIGINAL (pre-patch) document (§9.1.1)
  "patch":           Operation[],     // the forward patch to invert
  "expectedInverse": Operation[]      // the op list invertPatch(document, patch) MUST produce
}
```

`10.7.1` `document` is the **ORIGINAL** (pre-patch) document, exactly as §9.1.1 requires: it is
the document `patch` was generated from (and applies cleanly to), and `invertPatch` resolves `/-`
append paths to concrete indices and recovers overwritten/removed values against it (§9.1.1,
§9.2). `patch` MUST apply cleanly to `document` (§9.1.2); a `patch` that does not is not a valid
invert vector.

`10.7.2` **Conformance rule.** An invert vector **passes** iff **both** hold:

- **(a) Structural inverse equality.** `invertPatch(document, patch)` is **structurally equal** to
  `expectedInverse` — same length and the same ordered sequence of ops, each op equal by `op`,
  `path` (as a string), and — where present — `value`/`oldValue`/`from` under deep JSON equality
  (§2.4.1). This is the identical structural op-equality relation the diff gate uses (§10.3.2),
  and it pins the exact inverse op sequence §9.2 defines (forward-simulated, then reversed).
- **(b) Double-apply identity.** `applyPatch(applyPatch(document, patch), expectedInverse)`
  **deep-equals `document`** (§2.4.1), evaluated through the reference apply semantics (§8) under
  strict sequential application (§8.1). This is the round-trip guarantee of §9.1.2 / §7.3.1.

`10.7.3` Both clauses are REQUIRED and use the same terminology as §9: clause (a) pins the exact
inverse op list `invertPatch` produces (the ordering and per-op fields of §9.2), while clause (b)
is the semantic round-trip `invertPatch` guarantees against the forward-applied state (§9.1.2).
Because the inverse is computed against the ORIGINAL `document` (§9.1.1), clause (b) is asserted
against that same `document`, not against an arbitrary document that merely deep-equals it up to
array order (§9.1.2).

---

## Appendix A. Summary of spec-v1 fixes (contract vs. pre-audit HEAD)

`spec-v1` was finalized 2026-07-14 against reference implementation v0.4.0 after the P1–P4
phases. Every section below specifies the finalized (post-bugfix) semantics and is **landed** in
the reference; the "pre-audit HEAD" column records the behavior each fix replaced.

**Normative behavioral fixes (a Go implementer MUST reproduce these):**

| § | behavior specified | pre-audit HEAD state | phase (finding) |
|---|--------------------|----------------------|-----------------|
| 2.1.2 | `Date`/`RegExp`/`Map`/class instances treated as opaque equality leaves | host-dependent / could recurse into non-JSON | P1 (F16) |
| 2.4.4 | memoization/identity caches are output-neutral (no stale verdict after input mutation) | identity-keyed caches could leak a stale verdict across mutated inputs | P1 (F02) |
| 4.1.1 | `itemSchema` is non-normative and no longer populated by `buildPlan` | write-only `itemSchema` pinned ~2x plan memory | P2 (F19) |
| 4.3.1 | traverse nodes with `properties`/`items` even without `type` | gated on explicit `type` | P1 (F40) |
| 4.3.4 | unsupported-`$ref` notice routed through caller-suppressible `onWarning` | wrote to `console.warn` unconditionally | P4 (F32) |
| 4.3.5 | nested arrays get distinct plan paths (`${path}/*`) | inner plan clobbered outer at same key | P1 (F04) |
| 4.5.1 | `allOf` item branches merged (union `properties`+`required`) for primary-key detection | `allOf` skipped; a key declared only in an `allOf` branch was not found | P1 (F35) |
| 4.5.5 | `primaryKeyCandidates` overrides the auto-detection list; `[]` disables it | candidate list hardcoded `["id","name","port"]` | P3 (F25) |
| 4.6.2 | `basePath` matches on segment boundary, slices by length | `startsWith`+`replace`, sibling-prefix / mid-segment bugs | P1 (F14) |
| 5.2.2 | union-key visitation as two passes (output-equivalent to `Set` union) | `Set`-union allocation per object | P2 (F36) |
| 5.4.3 | primaryKey gate + `lcs` fallback (non-conforming elements, duplicate keys) | silently skipped / corrupted the index | P1 (F05/F06) |
| 5.4.5 | structural trie matching: wildcard reachable at **any** depth incl top-level `/*`; numeric object keys route by construction; no per-path caches | flat string lookup (exact / index-normalize / single trailing `*`) with four unbounded per-instance caches | P2 (F18/F33) |
| 5.5.0 | common prefix/suffix trim before Myers (normative step 0) | no trim; Myers ran on the whole array | P2 (F09) |
| 5.5.4.2 | granular LCS descent into same-kind changed items | whole-item replace always | P3 (F10) |
| 5.6 | `unique` is equal-length positional replaces only | dead removal/addition phase behind the equal-length gate | P3 (F38) |
| 5.8 | `emitMoves` capability: LCS relocations, `unique`/`primaryKey` exact-order via `move`s | no move emission; primaryKey order-insensitive only | P3 (F22/F23/F07) |
| 5.9 | `wholesaleReplaceFallback` capability: size-capped whole-array replace | none | P3 (F24) |
| 6.1.1 | `emitMoves` carve-out: generator emits `move`/`from` only under the capability | spec claimed generator never emits `move`/`from` | P3 (spec finalization) |
| 6.4.2 | `includeOldValue` capability suppresses `oldValue` | `oldValue` always emitted | P3 (F11) |

**Output-neutral performance fixes (§2.4.4-governed; MUST NOT change any emitted patch):** the
Myers V-band-only storage (§5.5.2, F08), window-element interning to integer ids (§5.5.2,
F21/F34), skipping re-verification of proven-equal common elements (§5.5.2/§5.5.5, F20), per-diff
hoisting of plan fingerprint/hash fields (F37), loop-based emission of large op groups (F13), and
plan-trie compilation (§5.4.5, F18) are all invisible to the wire format and need no separate
reproduction — a conforming implementation may use any output-neutral equivalent.

**Non-spec fixes (outside this document's scope, §1.5):** the `DiffOperation` type surface (F27),
plan validation in the `JsonSchemaPatcher` constructor (F42), the aggregator remove-fallback index
regex (F17), and packaging / CI / docs / test-hygiene work (F28, F30, F31, F39, F41) do not affect
diff, patch, apply, invert, or plan semantics and are not tabulated individually.

All other sections describe behavior already present before the audit (verified by probing: pointer
escaping in object diff, root-array-to-empty removals with `oldValue`, collision-free LCS cache
key, prototype-pollution guard, error codes, invert round-trip).

### Deferred to a future spec version

- **"Remove last" array extension (§3.5).** An OPTIONAL non-RFC token to remove the final array
  element without naming its index is **not part of spec-v1**: it is unimplemented in the reference
  and absent from the §10.4 capability registry. It is deferred to a future spec version, where it
  would need its own pointer-syntax rule (§3.5) and apply semantics (§8.3).
- **`unique` set-diff / move semantics (§5.6.2, Appendix B.2).** spec-v1 leaves the unequal-length
  `unique` case as an `lcs` fallback and does not define set-difference or move semantics for the
  `unique` strategy; a future version MAY specify them.

## Appendix B. Known pinned limitations (reproduce for conformance)

- **B.1** A schema property whose name is literally `"*"` is indistinguishable from the wildcard
  (`additionalProperties`/nested-array-element) edge in the compiled plan trie, because `buildPlan`
  emits both as the segment `*`; the wildcard interpretation wins (§5.4.5.1). This is a pinned edge
  case, not latitude. *(Former B.1/B.2/B.5 — deeper/​top-level `/*` unreachable and numeric-object-
  key mis-routing — are **resolved** by structural trie matching, §5.4.5, P2 fixes F18/F33; former
  B.3 — `allOf` not merged — is **resolved** by §4.5.1, P1 fix F35.)*
- **B.2** `unique` set-diff/move semantics are unspecified in spec-v1; unequal lengths fall back to
  LCS (§5.6.2).
