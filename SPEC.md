# fast-json-schema-patch — Normative Specification

**Spec version:** `spec-v1-draft`
**Status:** Draft. Finalized as `spec-v1` after the compactness phase (see §1.3).
**Reference implementation:** the TypeScript package in this repository (branch `feat/deep-dive-overhaul`).

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

- This is `spec-v1-draft`. Section numbers (e.g. `5.3.2`) are stable citation anchors;
  vectors and implementations SHOULD cite them.
- `spec-v1` is finalized after the **compactness phase** (the phase that lands granular LCS
  descent, §5.5.4). Until then, sections marked *(draft-pending)* MAY change.
- **Normative vs. buggy HEAD.** This spec describes the *intended* post-bugfix semantics, not
  the behavior of any particular commit. Several behaviors specified here (primaryKey
  fallback §5.4.3, nested-array plan paths §4.3.5, `basePath` segment matching §4.6.2,
  schema traversal without explicit `type` §4.3.1, granular LCS descent §5.5.4) are landed in
  the P1 / compactness phases *after* this spec. The spec is the contract those fixes
  implement; where a phase is pending, the section is marked *(draft-pending)*.
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

`2.3.1` Object member **insertion order** is significant to the *generator only*: it fixes the
order in which object members are visited and therefore the order in which per-member ops are
emitted (§5.2.3, §5.7). It is **not** significant to *equality* (§2.4.2) nor to *apply* (§8).

`2.3.2` The reference uses JavaScript own-key insertion order (`Object.keys`). A conforming
generator MUST reproduce this order. Because a plain hash map (e.g. Go `map[string]any`) does not
preserve insertion order, a conforming generator implemented in such a language **MUST** use an
order-preserving JSON representation (an ordered decoder, or a parallel key-order slice) for the
documents it diffs. Apply/invert (§8, §9) do not depend on key order.

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
§4). It is valid **only as the final segment of an `add` op path** (§8.3). Apply MUST reject `-`:
in any non-final segment; on `remove`, `replace`, `test`, or as a `move`/`copy` destination final
segment — with `INVALID_POINTER` (§8.6). (An OPTIONAL non-RFC "remove last" extension is reserved
but not part of spec-v1; §10.4.)

`3.6` **Array-index syntax.** An array-index segment MUST match `^(0|[1-9][0-9]*)$`: a single `0`,
or a nonzero digit followed by digits. Leading zeros (`01`), signs (`-0`, `+1`), decimals
(`1.5`), and non-digits are invalid indices and MUST be rejected with `INVALID_POINTER` when the
container at that point is an array (§8.6). A segment is interpreted as an array index only when
the container it addresses is an array; against an object the same segment is an ordinary member
key (§8.2.3).

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
output-relevant fields.

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

`4.3.1` *(draft-pending — P1 fix F40)* A schema node is traversed as an **object** when it has
`properties` or `additionalProperties`, and as an **array** when it has `items`, **regardless of
whether an explicit `type` keyword is present**. (The reference at HEAD gates on
`type === "object"` / `type === "array"` and MUST be updated to key off the shape keywords; a
node with `properties` but no `type` currently yields no plan and its arrays degrade to `lcs`.)

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

`4.3.5` *(draft-pending — P1 fix F04)* **Nested arrays (array-of-arrays).** When an array's
`items` is itself an array schema, the inner array MUST be registered at a **distinct** document
path (a wildcard element segment is appended, e.g. `parentPath + "/*"`), so the inner plan never
overwrites the outer array's plan at the same key. (At HEAD, `items` is traversed at the same
path, so an inner primaryKey plan clobbers the outer `lcs` plan and the outer array — whose
elements are arrays, not keyed objects — silently produces no ops. The fix gives each array
nesting level its own plan path and teaches the diff-time lookup, §5.4.5, about the extra level.)

`4.3.6` **`anyOf` / `oneOf` / `allOf`.** For each of these keywords present on a node, traverse
every branch schema at the **current** path. Branches are **de-duplicated by structural
fingerprint**: a canonical JSON string with recursively sorted object keys (a stable stringify) is
computed per branch, and a branch whose fingerprint was already seen at this node is skipped. The
fingerprint's cycle guard treats a re-encountered node as `undefined`.

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
  first branch that yields a primary key (§4.5.3). (`allOf` branches are **not** merged for
  detection at HEAD; a `primaryKey` declared only inside an `allOf` branch is not found and the
  array degrades to its base strategy. Merging `allOf` is a possible later enhancement, not
  required for spec-v1.)
- Otherwise examine `itemsSchema` directly.

`4.5.2` For a candidate schema `s`: resolve a leading `$ref` (§4.3.4); require `s.type ===
"object"` **and** `s.properties` present, else no key. Let `required = new Set(s.required || [])`.

`4.5.3` **Candidate key list.** Check the ordered list **`["id", "name", "port"]`** (§4.5.5). For
each candidate `key` in order: if `required.has(key)` **and** `properties[key].type` is `"string"`
or `"number"`, select it as the primary key and stop. If none qualifies, there is no primary key.

`4.5.4` **Effect of selection.** If a primary key is found, set `primaryKey = key`,
`strategy = "primaryKey"`, `requiredFields = required`, and `hashFields` = the required fields
whose `properties[f].type` is `"string"` or `"number"` (built by iterating `required` in set
order; §5.4.4 uses these only as a prefilter). If no key is found, the plan keeps its base
strategy from §4.4.1/§4.4.2.

`4.5.5` The candidate list `["id","name","port"]` is the **DEFAULT** of a configurable option.
A `primaryKeyCandidates` option to override the list ships in a later phase; spec-v1 pins the
default list. Because `name` and `port` are commonly user-editable, editing the chosen key field
turns an in-place edit into a remove+append under the primaryKey strategy (§7.2) — a known
compactness cost, not an error.

### 4.6 `basePath`

`4.6.1` When `basePath` is absent, plan keys are the full document paths from the root.

`4.6.2` *(draft-pending — P1 fix F14)* When `basePath` is set, only array paths **at or under**
`basePath` on a **segment boundary** are registered, and their keys are **relativized** by
stripping the `basePath` prefix. Formally, a path `P` is in-base iff `P === basePath` **or**
`P` starts with `basePath + "/"`; the registered key is `P.slice(basePath.length)`. (The
reference at HEAD uses `startsWith(basePath)` + string `replace`, which wrongly matches sibling
prefixes — `/env` captures `/envelope` — and can strip mid-segment, producing keys that never
match at diff time. The fix uses segment-boundary matching and length-based slicing.) Traversal
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
hints) but is specified so implementations produce identical `hashFields` for vector comparison.

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
**all of `original`'s keys in `original` insertion order, followed by the keys present only in
`modified` in `modified` insertion order.** (Reference forms `new Set([...keys(original),
...keys(modified)])`; Set iteration yields exactly this order.) A conforming generator MUST
reproduce this visitation order (§2.3.2).

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

This ordering is REQUIRED (§5.7 explains why it is round-trip-correct under sequential apply).

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

#### 5.4.3 Applicability gate and fallback *(draft-pending — P1 fixes F05/F06)*

Before committing to the primaryKey strategy, the differ MUST verify, in one `O(n+m)` pass over
both arrays, that:

- **(a)** every element of both arrays is an **object** whose value at `k` is a **string or
  number** (present, non-null); **and**
- **(b)** there are **no duplicate** key values within `original` and none within `modified`.

If either check fails, the array **MUST fall back to `lcs` (§5.5)** for this diff. (At HEAD,
neither check is performed: non-conforming elements are silently skipped — added/removed items
vanish from the patch — and duplicate keys corrupt the index, so even identical arrays can emit a
growing patch. The gate makes both cases well-defined via `lcs`, which is exact.) A
`primaryKeyMap` override (§4.4.3) selects the strategy but does **not** bypass this gate; a
gate-failing array still falls back to `lcs`.

#### 5.4.4 `checkArraysUnique` (gate for `unique`)

`checkArraysUnique(a, b)` returns true iff: `a.length === b.length`, **and** `a` has no two
deep-equal elements, **and** `b` has no two deep-equal elements. (The reference uses a `Set` of
element references over primitive arrays; because `unique` is only assigned to primitive item
schemas, reference-set uniqueness coincides with deep-equal uniqueness for the values it sees.)
If the check fails, the array falls back to `lcs`.

#### 5.4.5 Plan lookup by path *(matching algorithm — normative for strategy selection)*

To find the plan for a concrete array at document path `P`, resolve in this order and use the
first hit:

1. **Exact:** `plan.get(P)`.
2. **Index-normalized:** remove every `/<digits>` segment from `P` (regex `/\/\d+/g` → ``) and
   look that up. (This is how an array nested under array elements — path
   `/services/3/ports` — matches its schema key `/services/ports`.)
3. **Immediate-parent wildcard:** take the index-normalized `P`, replace its **last** segment
   with `*`, and look that up (matches an `additionalProperties`-array key such as `/*` for a
   direct wildcard-keyed array, or `/foo/*`).

If none hits, there is no plan (strategy `lcs`). **Known limitations an implementation MUST
reproduce for conformance:** (i) the wildcard match forms **only a single trailing `*`**, so an
`additionalProperties` plan registered at a *deeper* key such as `/*/items` is **not** reachable
for a concrete path `/envA/items` — that array falls back to `lcs`; (ii) index-normalization
strips **all** `/<digits>` segments, so an object member whose key is a decimal-digit string
(e.g. `"0"`) is also stripped and may mis-route the lookup (§F33). These are pinned behaviors, not
latitude. *(draft-pending §4.3.5 adds one wildcard element level for nested arrays and the lookup
MUST be extended to match it.)*

#### 5.4.6 Hash-field prefilter (non-normative)

`hashFields` MAY be used to fast-path the "items differ" decision in Phase 2: if any hash field
differs, the items differ without a full deep-equal; only if all hash fields match is a full
deep-equal performed. This MUST be output-neutral (§2.4.4) — it may only *shortcut to a
deep-equal-consistent verdict*, never override it.

### 5.5 LCS strategy (default)

Applies when no plan matches, when the plan strategy is `lcs`, or as the fallback from §5.4.3 /
§5.4.4 / §5.6. It computes a shortest edit script by **Myers' O(ND) diff** and emits positional
ops. LCS reconstruction is **always exact** (§7.1).

#### 5.5.1 Empty-array fast paths

Let `prefix = (path === "" ? "/" : path + "/")` (so a root-level array uses `/` before the index,
never a bare `/`).

- `original` empty, `modified` length `m`: for `i` from `0` to `m-1`, emit
  `{ op: "add", path: prefix + i, value: modified[i] }` (ascending).
- `modified` empty, `original` length `n`: for `i` from `n-1` down to `0`, emit
  `{ op: "remove", path: prefix + i, oldValue: original[i] }` (**descending**, each carrying
  `oldValue`).

#### 5.5.2 Myers forward pass and tie-break (pinned)

Standard greedy Myers with these pinned choices (an implementer MUST match them, since they fix
*which* shortest script is chosen and therefore the exact op sequence):

- `max = n + m`; diagonal index `k` ranges `-d..d` step 2 at edit-distance `d`; the V-array is
  offset by `max`. `V[offset+1] = 0` seeds the pass.
- For each `k`: **go down** (advance in `modified`, i.e. an insertion) when `k === -d`, **or**
  (`k !== d` **and** `V[k-1] < V[k+1]`); otherwise **go right** (advance in `original`, a
  deletion). "Down" takes `x = V[k+1]`; "right" takes `x = V[k-1] + 1`. Then `y = x - k`.
- **Snake:** while `x < n` and `y < m` and `original[x]` deep-equals `modified[y]` (§2.4.1),
  advance both. Equality here MAY be memoized/interned but MUST equal deep-equal.
- Terminate when `x >= n` and `y >= m`; that `d` is the edit distance.

Equality comparisons during the pass MUST be exact deep-equal. Any per-pair cache key MUST be
collision-free for the array sizes in play (the reference keys by `x*(m+1)+y`, exact for arrays up
to ~`2^53` elements; a `(x<<16)|y` style key that collides past 65535 elements is
**non-conforming**).

#### 5.5.3 Backtracking and the edit script

Backtrack from `(n, m)` to `(0, 0)` following the same down/right rule against the recorded
V-rows, producing a forward-ordered script of `common(ai,bi)`, `remove(ai)`, and `add(bi)`
entries.

#### 5.5.4 Replace collapse and granular descent *(§5.5.4.2 draft-pending — compactness phase F10)*

`5.5.4.1` **Collapse.** Scan the forward script; whenever a `remove` is immediately followed by an
`add`, collapse the pair into a single `replace` at the same output index.

`5.5.4.2` **Granular descent (normative default, draft-pending).** For a collapsed `replace` pair
`(original[ai], modified[bi])`: if **both** sides are objects, **or both** are arrays, the differ
**MUST recurse** — `diff(original[ai], modified[bi], prefix + currentIndex)` — emitting granular
nested ops instead of a whole-item replace. If the pair is primitive, or the two sides are of
mismatched container kind (object vs array), it stays a **whole-item** `{ op: "replace", path,
value: modified[bi], oldValue: original[ai] }`. (At HEAD every collapsed pair is a whole-item
replace; the compactness phase adds the same-kind recursion. This is the one LCS behavior that
changes between `spec-v1-draft` and `spec-v1`.)

#### 5.5.5 Emission from the script

Walk the (collapsed) script maintaining `currentIndex` starting at `0`; `prefix` as in §5.5.1:

- **common:** if both `original[ai]` and `modified[bi]` are objects/arrays, recurse
  `diff(...)` at `prefix + currentIndex` (they are already deep-equal per the snake, so this
  yields no ops; it is a no-op that MUST NOT emit anything — an implementation MAY skip it).
  `currentIndex++`.
- **replace** (§5.5.4): emit at `prefix + currentIndex`; `currentIndex++`.
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
guarantees equal lengths, no adds or removes are emitted. (The reference contains removal/addition
phases; under the equal-length gate they are provably unreachable. spec-v1 defines `unique` solely
as equal-length positional replacement.)

`5.6.2` **Unequal lengths fall back to `lcs`** (§5.4.4 gate fails → §5.5). Set-diff / move
semantics for `unique` are **not** specified in spec-v1.

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

---

## 6. Patch format

### 6.1 Operation object

An emitted operation is a JSON object:

```
Operation = {
  op:       "add" | "remove" | "replace"    // the generator emits ONLY these three
  path:     JSONPointer                      // always present
  value?:   JsonValue                        // present on add and replace
  oldValue?: JsonValue                       // this library's extension; see §6.4
  from?:    JSONPointer                      // NEVER emitted by the generator
}
```

`6.1.1` The **generator** (`execute`) emits only `add`, `remove`, and `replace`. The wider RFC
6902 op set (`move`, `copy`, `test`) and `from` are **accepted by apply** (§8) for third-party
patches but are never produced by diffing.

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
unique/LCS empty-source additions use `path` ending in `/-`. LCS emits **concrete indices** for
in-place adds (§5.5.5). A conforming consumer MUST handle both concrete-index and `/-` add paths.

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

### 7.3 Invert round-trip

`7.3.1` For the original document `D` and `p = execute` output, `applyPatch(applyPatch(D, p),
invertPatch(D, p))` **deep-equals `D`** (§9). The inverse is computed against the ORIGINAL `D`.

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
→ `INDEX_OUT_OF_BOUNDS`. **`remove`/`replace` index range:** index `< length` required; index
`>= length` (or `-`) → `INDEX_OUT_OF_BOUNDS` / `INVALID_POINTER`.

`8.3.2` **`add` overwrites an existing object member** (does not error); a member mapping to
`undefined` and an absent member behave identically.

`8.3.3` **`move`** rejects `from` being a proper prefix of `path` (moving a node into its own
descendant) with `INVALID_OPERATION`. **`copy`** MUST deep-clone so the result never aliases the
source (later ops mutating one must not affect the other).

`8.3.4` **`test`** uses **exact deep-equal** (§2.4.1), never a hash/memo prefilter that could be
fooled.

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
| `INVALID_POINTER` | malformed pointer: `-` where not allowed (§3.5), leading-zero/sign/decimal array index (§3.6) |
| `PATH_UNRESOLVABLE` | a target or intermediate segment does not exist (§8.2.2); remove/replace of a nonexistent member |
| `INDEX_OUT_OF_BOUNDS` | array index out of range for the op (§8.3.1) |
| `TEST_FAILED` | `test` value mismatch (§8.3) |
| `OLD_VALUE_MISMATCH` | `validateOldValues`: document value ≠ `oldValue` (§8.4) |
| `INVALID_OPERATION` | unknown op; missing required field (`value`/`from`); remove at root; `move` into own child |
| `UNSAFE_KEY` | prototype-pollution guard tripped (§8.6.1) |

`8.6.1` **Prototype-pollution guard.** A pointer segment equal to `__proto__` (**anywhere**) is
rejected with `UNSAFE_KEY`. A segment equal to `prototype` is rejected **only** when its
*immediately preceding* segment is `constructor`. Standalone `constructor` and standalone
`prototype` (not preceded by `constructor`) are legitimate JSON object keys and MUST remain
usable. The guard is checked on every object segment traversed and on the final object segment;
it does not apply to array-index segments.

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
(§2.4.1) and MUST NOT throw. Invert vectors MAY reuse this shape by asserting the double-apply
identity (§9.1.2).

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
| `includeOldValue=false` | on (oldValue present) | OPTIONAL | suppress `oldValue` on all remove/replace (§6.4.2); disables document-free invert |
| `emitMoves` | off | OPTIONAL (reserved) | emit RFC 6902 `move` for LCS relocations and primaryKey order fidelity |
| `wholesaleReplaceFallback` | off | OPTIONAL (reserved) | emit a single container `replace` when the granular patch would exceed the container's own serialized size |
| `primaryKeyCandidates` | `["id","name","port"]` | OPTIONAL (reserved) | override the auto-detection candidate list (§4.5.5) |

`10.4.1` **Granular LCS descent (§5.5.4.2) is NOT a capability** — it is normative default
behavior in `spec-v1` (landed in the compactness phase). `spec-v1-draft` vectors that predate it
use whole-item replaces; they are re-baselined at spec-v1 finalization.

### 10.5 Vector provenance

Vectors SHOULD be harvested from the reference test suite and from randomized fuzzing (the
primaryKey contract §7.2 was pinned at 500/500 trials; LCS exactness at 800/800; invert at
300/300). New vectors for schema-derived plan corners (§4) SHOULD be authored by hand, since the
existing suite under-covers plan derivation.

---

## Appendix A. Summary of draft-pending fixes (contract vs. HEAD)

These sections specify the intended post-bugfix semantics; the listed phase lands them.

| § | behavior specified | HEAD state | phase |
|---|--------------------|------------|-------|
| 4.3.1 | traverse nodes with `properties`/`items` even without `type` | gates on explicit `type` | P1 (F40) |
| 4.3.5 | nested arrays get distinct plan paths | inner plan clobbers outer at same key | P1 (F04) |
| 4.6.2 | `basePath` matches on segment boundary, slices by length | `startsWith`+`replace`, mid-segment bugs | P1 (F14) |
| 5.4.3 | primaryKey gate + `lcs` fallback (non-conforming elements, duplicate keys) | silently skips / corrupts | P1 (F05/F06) |
| 5.5.4.2 | granular LCS descent into same-kind changed items | whole-item replace always | compactness (F10) |

All other sections describe behavior already present at HEAD (verified by probing: pointer
escaping in object diff, root-array-to-empty removals with `oldValue`, collision-free LCS cache
key, prototype-pollution guard, error codes, invert round-trip).

## Appendix B. Known pinned limitations (reproduce for conformance)

- **B.1** primaryKey plan keys registered at a deeper `additionalProperties` path (`/*/items`) are
  not reachable at diff time; such arrays fall back to LCS (§5.4.5).
- **B.2** Index-normalization for plan lookup strips **all** decimal-digit segments, so an object
  member literally keyed `"0"` may mis-route (§5.4.5, F33).
- **B.3** `allOf` item schemas are not merged for primary-key detection; a key declared only in an
  `allOf` branch is not found (§4.5.1).
- **B.4** `unique` set-diff/move semantics are unspecified in spec-v1; unequal lengths fall back to
  LCS (§5.6.2).
