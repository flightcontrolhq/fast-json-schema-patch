# fast-json-schema-patch — Core semantics (CORE)

**Spec version:** `spec-v1-rc`  ·  **Status:** Release Candidate  ·  part of the four-document specification (see [`SPEC.md`](../SPEC.md)).

This document is the stable *what*: the data model, JSON Pointer usage, the plan/semantic
model, the patch wire format and its extensions, apply semantics (errors and security),
invert semantics, and the round-trip contracts — everything an applier or consumer needs.
The deterministic generator profile is in [GEN](02-generator-profile.md); conformance and
versioning in [CONF](03-conformance.md); non-normative history in [RATIONALE](04-rationale.md).
Conformance language (RFC 2119) is defined in CONF §1.4.

---

## 1. Data model

### 1.1 JSON values

`1.1.1` A document is a **JSON value**: one of `null`, boolean, number, string, array (ordered
sequence of JSON values), or object (unordered-by-key set of string→JSON-value members). This is
exactly the value space produced by `JSON.parse`. Inputs MUST be treated as if produced by
`JSON.parse`.

`1.1.2` Behavior on non-JSON inputs (JavaScript `Date`, functions, `undefined` as a value,
`Map`, `RegExp`, circular references, class instances) is **out of scope**. Implementations
SHOULD document their handling. The reference implementation does not defend against these; a
conforming implementation MAY reject them, treat them as opaque leaves, or inherit host
behavior, but MUST document the choice.

`1.1.3` A JSON object MUST NOT contain a member whose value is `undefined` (the absence of a
member and a member mapping to `undefined` are treated identically throughout: see GEN §2.1). An
array MUST NOT contain `undefined` elements.

### 1.2 Number semantics

`1.2.1` Numbers are compared and treated as **IEEE-754 double-precision floats** (`f64`). This is
the normative common denominator (JavaScript has no other number type).

`1.2.2` Consequently: `1` and `1.0` are **equal**; `-0` and `0` are **equal** (per `===`; but see
§1.4.3 for `NaN`, which cannot occur in JSON); integers with magnitude `> 2^53` are **not**
faithfully distinguishable (e.g. `9007199254740993` collapses to `9007199254740992`).

`1.2.3` Implementations in languages with richer numeric types (e.g. Go `json.Number`, Rust
`serde_json` arbitrary precision) **MUST** compute all equality and comparison at `f64`
semantics (§1.4). They **SHOULD** preserve the original number *text* when echoing a value into a
patch (`value`, `oldValue`) so that faithful round-tripping of large integers survives
application, even though the differ cannot *distinguish* two numbers that share an `f64` image.
Preserving text MUST NOT change equality: two numbers equal under `f64` MUST be treated as equal
regardless of source text.

`1.2.4` **Non-finite numbers are excluded (normative).** `NaN`, `+Infinity`, and `-Infinity` are
**not** JSON values (§1.1) and cannot appear in valid JSON text (RFC 8259 §6). An implementation
**MUST NOT** admit a non-finite number into the value model: constructing a number value from a
non-finite float, and encoding a value that contains one to JSON text, **MUST fail** rather than
emit a non-JSON token (`NaN`, `Infinity`, `-Infinity`) or silently coerce it (e.g. to `null` or
`0`). Number *text* accepted at construction (§1.2.3) MUST match the JSON number grammar
(RFC 8259 §6); non-numeric or non-finite text MUST be rejected. (§1.4.3 already excludes `NaN`
from equality; this pins the construction/encode boundary — normative for a language whose native
float type can hold non-finite values, e.g. the Go engine's `FromAny`/`NewNumber`/`Encode`, D6.)

### 1.3 Object key order

`1.3.1` Object member **iteration order** is significant to the *generator only*: it fixes the
order in which object members are visited and therefore the order in which per-member ops are
emitted (GEN §2.3, GEN §7). It is **not** significant to *equality* (§1.4.2) nor to *apply* (§5).

`1.3.2` **Pinned member order (normative).** The reference visits an object's members in
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
integer-like-ascending-first reordering above. Apply/invert (§5, §6) do not depend on key order.

### 1.4 Equality

`1.4.1` **Deep JSON equality** (`deepEqual`) is the sole equality relation used for diffing,
`test` ops, and `oldValue` validation. It is defined recursively:

- Two values are equal iff they have the same JSON type and:
  - **null / boolean / string:** equal by value.
  - **number:** equal under `f64` (§1.2).
  - **array:** same length and, for every index `i`, `arr1[i]` deep-equals `arr2[i]`
    (**order-sensitive**).
  - **object:** same set of member keys and, for every key `k`, `a[k]` deep-equals `b[k]`
    (**key-order-insensitive**).

`1.4.2` Equality is **array-order-sensitive** and **object-key-order-insensitive**. `{"a":1,"b":2}`
equals `{"b":2,"a":1}`; `[1,2]` does not equal `[2,1]`. Because equality first requires the **same
JSON type**, an **empty array is never equal to an empty object** (`[] ≠ {}`): a "both sides have
zero members" fast path that skips the array-vs-object type check is non-conforming (§1.4.4; the
trap behind D1, whose vector is `diff/kind-mismatch.json`).

`1.4.3` There is no type coercion: `1 ≠ "1"`, `null ≠ false`, `null ≠ 0`, `null ≠ absent-member`.
(`NaN`/`Infinity` are not representable in JSON and cannot appear in a conforming input.)

`1.4.4` Hash prefilters, fingerprint interning, and memoization caches are **implementation
details** and **MUST** be output-neutral: their presence or absence MUST NOT change any emitted
patch, any `test`/validation verdict, or any equality result relative to §1.4.1. In particular, a
cache MUST NOT return a stale verdict after an input is mutated between diffs; implementations
that cache across calls MUST document a no-mutation contract or scope caches per call.

---

## 2. JSON Pointer usage (RFC 6901)

`2.1` All paths in emitted patches and all `path`/`from` fields consumed by apply are **JSON
Pointers** per RFC 6901.

`2.2` **Escaping (encode).** When building a pointer segment from an object key, replace `~`
with `~0`, then `/` with `~1`, **in that order**. Array-index segments and the append token `-`
are never escaped (they contain no `~` or `/`). A conforming generator MUST escape every object
key it places into a pointer (GEN §2.3). The empty string is a valid object key and produces the
segment `` (so pointer `/` addresses the member named `""`).

`2.3` **Unescaping (decode).** When resolving a pointer segment, replace `~1` with `/`, then `~0`
with `~`, **in that order**.

`2.4` **Path construction.** A child path is `parentPath + "/" + escape(segment)`. The root
document has path `""` (empty string). A pointer is `""` or a sequence of `/`-prefixed escaped
segments. `splitPath("")` is the empty list; `splitPath("/a/b")` is `["a","b"]` after unescaping.

`2.5` **The `-` append token.** `-` denotes the position one past the last array element (RFC 6901
§3). It is valid as the final segment of an `add` op path and, by delegation to `add`, as a
`move`/`copy` **destination** final segment (§5.3). Apply MUST reject `-` **in any non-final
segment**, and as the final segment of a `remove`, `replace`, or `test`, or as a `move`/`copy`
**source** final segment. On the **write side** (`remove`/`replace` finals and any non-final
segment) rejection is `INVALID_POINTER`; on the **read side** (`test` finals and `move`/`copy`
**source** finals) `-` fails own-index resolution and surfaces as `PATH_UNRESOLVABLE` (§2.6, §5.6).
(An OPTIONAL non-RFC "remove last" extension is **deferred to a future spec version** and is
not part of spec-v1: the reference implementation does not implement it and the CONF §5 capability
registry does not list it. See RATIONALE §4.)

`2.6` **Array-index syntax.** An array-index segment MUST match `^(0|[1-9][0-9]*)$`: a single `0`,
or a nonzero digit followed by digits. Leading zeros (`01`), signs (`-0`, `+1`), decimals
(`1.5`), and non-digits are invalid indices against an array container (§5.6). Rejection is
`INVALID_POINTER` **only on write-side resolution** — an `add`/`remove`/`replace` target or any
intermediate segment along the way. On **read-side resolution** (a `test` target, or a
`move`/`copy` **source**) the malformed segment instead fails existence and surfaces as
`PATH_UNRESOLVABLE` (§5.6). A segment is interpreted as an array index only when the container it
addresses is an array; against an object the same segment is an ordinary member key (§5.2.3).

`2.7` **Malformed pointer — no leading `/` (normative).** A valid pointer is either the empty
string `""` (the root) or a sequence of `/`-prefixed escaped segments (§2.4). A **non-empty**
pointer that does **not** begin with `/` is therefore malformed: it is neither the root nor a
segment sequence, and it MUST NOT be split into a segment list (in particular an implementation
MUST NOT treat `"foo"` as equivalent to the root pointer `""` or to `"/foo"`). Apply **MUST reject**
such a `path` or `from` with `INVALID_POINTER`, on **all six ops** and for **both** `path` and
`from`. This is a whole-pointer **syntactic** rejection evaluated at parse time (§5.3.5 tier 2),
**before** read-side/write-side resolution — so, unlike the per-segment `-`/bad-index softening of
§2.5/§2.6 (which fails *existence* and surfaces read-side as `PATH_UNRESOLVABLE`), a leading-`/`-less
pointer is `INVALID_POINTER` even for a `test` target or a `move`/`copy` **source**. A conforming
generator MUST NOT emit such a pointer (every emitted path is built by `parentPath + "/" + escape(segment)`
from a root of `""`, §2.4, so it is always `""` or `/`-prefixed).

---

## 3. Plan model

A **Plan** is derived once from a JSON Schema by `buildPlan` and reused across many diffs. It maps
*document paths* to *array strategies*. A conforming implementation MUST produce an equivalent
plan (same array-path → strategy/primaryKey/required-fields mapping) so that strategy selection
at diff time (GEN §4) matches.

### 3.1 Types

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

`3.1.1` `hashFields` and `itemSchema` are **non-normative optimization metadata**. `hashFields`
is a prefilter hint only (GEN §4.4) and MUST be output-neutral; `itemSchema` is never consulted at
diff time and MAY be omitted entirely. `primaryKey`, `strategy`, and `requiredFields` are the
output-relevant fields; their derivation from a schema is directly falsifiable via the
plan-snapshot vector format (CONF §7).

### 3.2 `buildPlan` inputs

```
BuildPlanOptions = {
  schema:         Schema                    // the JSON Schema (REQUIRED)
  primaryKeyMap?: Record<documentPath, string>   // per-path primaryKey override
  basePath?:      string                    // restrict/relativize plan keys (§3.6)
}
```

### 3.3 Schema traversal

Traversal starts at the root schema with document path `""` and recurses, accumulating an
escaped document path. A `visited` set of schema-node object identities guards against reference
cycles: a node currently on the traversal stack is not re-entered; it is removed from the set when
its subtree completes (so the same shared subschema may be reached again via a different path).

`3.3.1` A schema node is traversed as an **object** when it has `properties` or
`additionalProperties`, and as an **array** when it has `items`, **regardless of whether an
explicit `type` keyword is present**. (Landed, P1 fix F40. Pre-audit HEAD gated on
`type === "object"` / `type === "array"`, so a node with `properties` but no `type` yielded no
plan and its arrays degraded to `lcs`; the reference now keys off the shape keywords.)

`3.3.2` **Object node.** For each member `key` in `properties`, recurse into
`properties[key]` at path `parentPath + "/" + escape(key)`. If `additionalProperties` is a schema
object (not a boolean), recurse into it at path `parentPath + "/*"` (the literal wildcard segment
`*`). Member keys are visited in the schema's own-key order.

`3.3.3` **Array node.** Construct an `ArrayPlan` (§3.4), register it at the current path
(subject to `basePath`, §3.6), then recurse into `items` at the **same** path (array element
paths gain their index at diff time, not during plan building) — except as amended by §3.3.5 for
nested arrays.

`3.3.4` **`$ref`.** Only **local** references (`#/...`) are resolved, by walking the `/`-split
JSON Pointer into the root schema. A non-local `$ref` (e.g. `http://…`, `#no-slash`) resolves to
nothing: the node is skipped and its subtree is not traversed (arrays beneath it get no plan and
fall back to `lcs`). Resolving a `$ref` does **not** change the document path. Implementations
SHOULD route the "unsupported reference" notice through a caller-suppressible channel rather than
writing to stdout/stderr unconditionally.

`3.3.5` **Nested arrays (array-of-arrays).** When an array's `items` is itself an array schema,
the inner array MUST be registered at a **distinct** document path (a wildcard element segment is
appended, e.g. `parentPath + "/*"`), so the inner plan never overwrites the outer array's plan at
the same key. (Landed, P1 fix F04. At pre-audit HEAD, `items` was traversed at the same path, so
an inner primaryKey plan clobbered the outer `lcs` plan and the outer array — whose elements are
arrays, not keyed objects — silently produced no ops. The fix gives each array nesting level its
own plan path and the diff-time lookup, GEN §4.5, resolves the extra level.)

`3.3.6` **`anyOf` / `oneOf` / `allOf`.** For each of these keywords present on a node, traverse
every branch schema at the **current** path. Branches are **de-duplicated by structural
fingerprint within the same keyword's branch list only** (the dedup set is reset per keyword): a
canonical JSON string with recursively sorted object keys (a stable stringify) is computed per
branch, and a branch whose fingerprint was already seen **in that same keyword's list** is
skipped. Fingerprints are **not** shared across `anyOf`/`oneOf`/`allOf` at a node, so an identical
branch appearing under two different keywords is traversed once per keyword. The fingerprint's
cycle guard treats a re-encountered node as `undefined`.

### 3.4 Constructing an ArrayPlan

Given an array node with resolved item schema `itemsSchema` (if `items` is a `$ref`, it is
resolved once per §3.3.4; if resolution fails, the unresolved `items` is used):

`3.4.1` Start with `{ primaryKey: null, strategy: "lcs" }`.

`3.4.2` **Primitive items → `unique`.** If `itemsSchema.type` is exactly `"string"`, `"number"`,
or `"boolean"`, set `strategy = "unique"`. (A primitive item array is a candidate for the
`unique` strategy, gated at diff time by GEN §4.4.)

`3.4.3` **`primaryKeyMap` override.** If `primaryKeyMap[currentPath]` is set, set
`primaryKey = that value` and `strategy = "primaryKey"` unconditionally (overriding §3.4.2 and
§3.5). The override is trusted; no property-existence check is performed at plan time.

`3.4.4` Otherwise, if items are **not** primitive, run primary-key auto-detection (§3.5).

### 3.5 Primary-key auto-detection

`3.5.1` Auto-detection runs over an **object item schema**. Resolve the candidate schema:

- If `itemsSchema` has `anyOf` or `oneOf`, examine each branch **in array order** and use the
  first branch that yields a primary key (§3.5.3).
- Otherwise examine `itemsSchema` directly.

Each candidate schema (a branch, or `itemsSchema` itself) is first reduced to a synthetic object
view by the **`allOf` merge** (§3.5.1.1) before §3.5.2/§3.5.3 run against it.

`3.5.1.1` **`allOf` merge.** (Landed, P1 fix F35.) Reduce a candidate schema `s` to a
single object view, `mergeAllOf(s)`:

1. If `s` has a `$ref`, resolve it (§3.3.4); if resolution fails, `s` is used unchanged (no merge).
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

`3.5.2` For the merged candidate view `s` (§3.5.1.1): require `s.type === "object"` **and**
`s.properties` present, else no key. Let `required = new Set(s.required || [])`.

`3.5.3` **Candidate key list.** Check the ordered candidate list — the `primaryKeyCandidates`
option, **defaulting to `["id", "name", "port"]`** when the option is omitted (§3.5.5). For
each candidate `key` in order: if `required.has(key)` **and** `properties[key].type` is `"string"`
or `"number"`, select it as the primary key and stop. If none qualifies, there is no primary key.
An **empty** candidate list checks nothing, so auto-detection never selects a key (the array keeps
its base strategy); a `primaryKeyMap` override (§3.4.3) is applied **before** this step and does
not consult the list, so it still wins under any candidate list, empty included.

`3.5.4` **Effect of selection.** If a primary key is found, set `primaryKey = key`,
`strategy = "primaryKey"`, `requiredFields = required`, and `hashFields` = the required fields
whose `properties[f].type` is `"string"` or `"number"` (built by iterating `required` in set
order; GEN §4.4 uses these only as a prefilter). If no key is found, the plan keeps its base
strategy from §3.4.1/§3.4.2.

`3.5.5` (Landed, F25.) The candidate list `["id","name","port"]` is the **DEFAULT** of
the `primaryKeyCandidates` build-plan option (CONF §5, capability registry). Passing an ordered list
replaces the default wholesale (no merge); passing `[]` disables auto-detection. `primaryKeyMap`
takes precedence over any candidate list (§3.5.3). Because `name` and `port` are commonly
user-editable, editing the chosen key field turns an in-place edit into a remove+append under the
primaryKey strategy (§7.2) — a known compactness cost, not an error; overriding the list (e.g. to
`["id"]`) avoids it.

### 3.6 `basePath`

`3.6.1` When `basePath` is absent, plan keys are the full document paths from the root.

`3.6.2` (Landed, P1 fix F14.) When `basePath` is set, only array paths **at or under**
`basePath` on a **segment boundary** are registered, and their keys are **relativized** by
stripping the `basePath` prefix. Formally, a path `P` is in-base iff `P === basePath` **or**
`P` starts with `basePath + "/"`; the registered key is `P.slice(basePath.length)`. (Pre-audit
HEAD used `startsWith(basePath)` + string `replace`, which wrongly matched sibling prefixes —
`/env` capturing `/envelope` — and could strip mid-segment, producing keys that never matched at
diff time. The reference now uses segment-boundary matching and length-based slicing.) Traversal
still descends through non-matching prefixes so nested in-base arrays are reachable.

### 3.7 Strategy ranking and plan merge

When two schema nodes map to the **same** document path (e.g. via `anyOf` branches, or
`$ref` fan-in), their plans are reconciled:

`3.7.1` **Rank:** `primaryKey` (3) > `unique` (2) > `lcs` (1). The higher-ranked strategy wins.

`3.7.2` If ranks tie, the plan **with** a `primaryKey` beats the one without.

`3.7.3` If still tied, the plan with **more** `hashFields` wins (a non-normative preference among
otherwise output-equivalent plans).

`3.7.4` **Metadata merge.** When the incoming candidate wins, supplemental metadata from the
displaced plan is merged into it; when it loses, its metadata is merged into the retained plan.
Merge rules: `hashFields` become the set-union of both; `requiredFields` are taken from whichever
plan has them if the target lacks them. This merge is non-normative (it only affects prefilter
hints) but is specified so implementations produce identical `hashFields` for vector comparison
(the plan-snapshot vector format, CONF §7, compares `hashFields` order-insensitively).

---

## 4. Patch format

### 4.1 Operation object

An emitted operation is a JSON object:

```
Operation = {
  op:       "add" | "remove" | "replace" | "move"  // "move" ONLY under emitMoves (GEN §8, §4.1.1)
  path:     JSONPointer                      // always present
  value?:   JsonValue                        // present on add and replace (never on move)
  oldValue?: JsonValue                       // this library's extension; see §4.4
  from?:    JSONPointer                      // ONLY on emitted `move` ops under emitMoves (§4.1.1)
}
```

`4.1.1` **In the default capability mode** (`emitMoves` off), the **generator** (`execute`) emits
only `add`, `remove`, and `replace`, and never emits `from`. The remaining RFC 6902 ops (`copy`,
`test`) and `from` are **accepted by apply** (§5) for third-party patches but are not produced by
diffing in this mode.

**Carve-out — `emitMoves` (GEN §8).** When the OPTIONAL `emitMoves` capability is enabled (GEN §8,
CONF §5.4), the generator **additionally emits `move` ops**, each carrying a `from` pointer and no
`value`/`oldValue` (GEN §8.4). This is the only path by which `execute` produces a `move` op or a
`from` field. With `emitMoves` off — the default, and the only mode the spec-v1 conformance
vectors cover (CONF §5) — the "add/remove/replace only, never `from`" guarantee holds exactly.
`copy` and `test` are never emitted in either mode.

### 4.2 RFC 6902 conformance

`4.2.1` With `oldValue` stripped (§4.4, `toRfc6902`), every emitted op is a valid RFC 6902
operation and applies under any conforming RFC 6902 applier — with the single caveat that `/-`
append paths (used by primaryKey/unique adds, §4.3) require the applier to support RFC 6901's `-`
token (RFC 6902-standard; the reference and fast-json-patch both accept it, including at root).

### 4.3 Guaranteed fields per op

| op | `path` | `value` | `oldValue` | notes |
|----|--------|---------|------------|-------|
| `add` | ✔ | ✔ | ✘ (never) | `value` is the added value; adds carry no `oldValue`. |
| `remove` | ✔ | ✘ | ✔ (default mode) | `oldValue` is the removed subtree (§4.4). |
| `replace` | ✔ | ✔ | ✔ (default mode) | `value` new, `oldValue` old (§4.4). |

`4.3.1` **Append paths.** primaryKey additions (GEN §4.1.2) and — in the general/primitive case —
`unique` additions use `path` ending in `/-`. **LCS never emits `/-`:** it emits **concrete
indices** for all adds, including empty-source additions (`/0`, `/1`, …; GEN §5.1) and in-place adds
(GEN §5.5). A conforming consumer MUST handle both concrete-index and `/-` add paths.

`4.3.2` **`oldValue` presence is capability-governed.** The "✔ (default mode)" cells for
`remove`/`replace` above hold under the **default** `includeOldValue = true` (SPEC §4.4, capability
registry CONF §5). Under the opt-out `includeOldValue = false`, `oldValue` is present on **no** op;
`add` never carries it in either mode. The `path`/`value` cells are unaffected.

`4.3.3` **`move` ops are capability-governed.** The table above is the default-mode op set. Under
the OPTIONAL `emitMoves` capability (GEN §8, CONF §5.4) the generator also emits `move` ops; a `move`
carries `path` and `from` and **no** `value`/`oldValue` (GEN §8.4, §4.1.1). No `move` op is emitted
with `emitMoves` off.

### 4.4 `oldValue` extension

`4.4.1` `oldValue` is a **non-RFC-6902 extension**. In the **default** capability mode it is
present on every `remove` and `replace`, carrying the complete pre-change subtree. It exists to
support `invertPatch` without the original document and to feed the formatting layer. It is
back-compat default-on.

`4.4.2` The `includeOldValue = false` capability (CONF §5) suppresses `oldValue` on all
remove/replace ops. It is **OPTIONAL**, default off, and **spec-v1 conformance vectors cover
default mode only.** Suppressing `oldValue` disables `invertPatch` without the original document
(§6).

`4.4.3` `toRfc6902(patches)` returns a copy with `oldValue` stripped from every op, yielding
strict RFC 6902 patches. It changes no other field and MUST NOT double-escape paths.

---

## 5. Apply semantics

`applyPatch(document, patches, options?) → document'` applies an `Operation[]` and returns the
new document. It accepts all six RFC 6902 ops plus this library's `oldValue` and `/-` extensions,
so it can consume both generated and third-party patches.

### 5.1 Sequential, atomic application

`5.1.1` Ops are applied **strictly in order**, never reordered/batched/deduplicated (GEN §7).

`5.1.2` Application is **atomic (all-or-nothing)** in the default (immutable) mode: if any op
fails, a `JsonPatchError` is thrown and the input document is left **untouched**. Structural
sharing (§5.7.1) provides this rollback for free.

`5.1.3` The input document is **never mutated** in the default mode. The result shares untouched
subtrees by reference with the input (copy-on-write; §5.7.1).

### 5.2 Path resolution

`5.2.1` `path` is split into unescaped segments (§2.3). An empty path (`""`) addresses the whole
document (§5.5).

`5.2.2` To reach the **parent** of the target, every intermediate segment MUST already exist (RFC
6902: no implicit creation). A missing intermediate → `PATH_UNRESOLVABLE`. Descending through a
primitive → `PATH_UNRESOLVABLE`.

`5.2.3` **Container-type dispatch.** At each step, the *actual* container type decides
interpretation: against an **array**, the segment is an index (§2.6) or `-` (add only); against an
**object**, the segment is a member key (numeric-looking keys are ordinary keys). Never infer from
the path shape.

### 5.3 Per-op behavior

| op | precondition | effect | new-root? |
|----|--------------|--------|-----------|
| `add` | must have `value`; parent exists | array: **insert** at index (or append at `-`), shifting; object: **set** member (overwrites if present, RFC 6902 §4.1) | path `""` → returns `value` as new document |
| `remove` | path non-empty; target exists | array: **splice out** at index; object: **delete** member | never (root remove invalid, §5.5) |
| `replace` | must have `value`; target exists | array: **overwrite** at index; object: **set** existing member | path `""` → returns `value` |
| `move` | must have `from`; `from` exists; `from` not a proper prefix of `path` | `remove(from)` then `add(path, from-value)` | via add |
| `copy` | must have `from`; `from` exists | **deep-clone** `from`-value then `add(path, clone)` | via add |
| `test` | must have `value`; target exists | assert target deep-equals `value` (§1.4.1); else `TEST_FAILED` | no change |

`5.3.1` **`add` index range:** `add` accepts index `== length` (append) and `-`; index `> length`
→ `INDEX_OUT_OF_BOUNDS`. **`remove`/`replace` index range (split rule):** the `-` append token is
rejected with `INVALID_POINTER`; a well-formed numeric index `>= length` is rejected with
`INDEX_OUT_OF_BOUNDS` (index `< length` is required). **`test` index range:** because `test`
resolves **read-side** (§5.6), both a `-` final and a numeric index `>= length` fail existence and
surface as `PATH_UNRESOLVABLE`, not `INVALID_POINTER`/`INDEX_OUT_OF_BOUNDS`.

`5.3.2` **`add` overwrites an existing object member** (does not error); a member mapping to
`undefined` and an absent member behave identically.

`5.3.3` **`move`** rejects `from` being a proper prefix of `path` (moving a node into its own
descendant) with `INVALID_OPERATION`. **`copy`** MUST deep-clone so the result never aliases the
source (later ops mutating one must not affect the other).

`5.3.4` **`test`** uses **exact deep-equal** (§1.4.1), never a hash/memo prefilter that could be
fooled.

`5.3.5` **Error precedence (normative).** When an op could fail for more than one reason, checks
are evaluated in this fixed order and the **first** applicable failure is thrown: (1) a **missing
required field** — `value` on `add`/`replace`/`test`, `from` on `move`/`copy` — → `INVALID_OPERATION`;
then (2) **pointer/index syntax and bounds** (§2.5, §2.6, §2.7, §5.3.1: `INVALID_POINTER`,
`INDEX_OUT_OF_BOUNDS`, and, on write-side object segments, the `UNSAFE_KEY` guard §5.6.1); then
(3) **existence** of the target or an intermediate segment (§5.2.2) → `PATH_UNRESOLVABLE`; then
(4) **value checks** — `OLD_VALUE_MISMATCH` (§5.4) or `TEST_FAILED` (§5.3). (Thus e.g. an `add`
missing `value` with an also-malformed index throws `INVALID_OPERATION`, not `INVALID_POINTER`;
verified by probe.) `test` carries `value` as a **tier-1 required field** (RFC 6902 §4.6: a `test`
op *MUST* contain a `value` member): a `test` with no `value` is `INVALID_OPERATION` at tier 1 —
**before** the tier-3 read-side existence check — so `{op:"test",path:"/a"}` against `{"a":null}`
is `INVALID_OPERATION`, **not** a pass-by-treating-absent-value-as-`null` and **not** `TEST_FAILED`.

### 5.4 `oldValue` validation

`5.4.1` When `options.validateOldValues` is true, every `remove`/`replace` op **that carries
`oldValue`** is checked before applying: the current document value at `path` MUST deep-equal
`oldValue`, else `OLD_VALUE_MISMATCH` (atomic abort). This is equivalent to an interleaved `test`.

`5.4.2` Ops **without** `oldValue` (all adds; third-party patches; suppressed-mode removes/
replaces) are applied **unchecked** even when `validateOldValues` is true (validation is skipped,
not failed).

### 5.5 Root operations

`5.5.1` `add` or `replace` at path `""` **replaces the entire document** with `value` (possibly
changing its type); the new root is the return value.

`5.5.2` `remove` at path `""` is **invalid** → `INVALID_OPERATION`.

### 5.6 Error codes

A failing op throws `JsonPatchError { message, code, operation, operationIndex }`. `code` is one
of:

| code | meaning |
|------|---------|
| `INVALID_POINTER` | a **whole-pointer** syntax error — a non-empty `path`/`from` not beginning with `/` (§2.7) — on **any** op and **either** side; or a malformed segment on **write-side** resolution (add/remove/replace targets and intermediates, move/copy destinations): `-` on a remove/replace final or any non-final segment (§2.5), leading-zero/sign/decimal array index (§2.6). Read-side malformed/`-` *segments* surface as `PATH_UNRESOLVABLE` instead, but a leading-`/`-less whole pointer is `INVALID_POINTER` read-side too (§2.7). |
| `PATH_UNRESOLVABLE` | a target or intermediate segment does not exist (§5.2.2); remove/replace of a nonexistent member; a malformed or `-` segment encountered during **read-side** resolution — `test`, or a `move`/`copy` **source** (§2.5, §2.6); a read-side `__proto__`/`constructor`/`prototype` segment (§5.6.1) |
| `INDEX_OUT_OF_BOUNDS` | array index out of range for the op (§5.3.1) |
| `TEST_FAILED` | `test` value mismatch (§5.3) |
| `OLD_VALUE_MISMATCH` | `validateOldValues`: document value ≠ `oldValue` (§5.4) |
| `INVALID_OPERATION` | unknown op; missing required field (`value` on add/replace/test, `from` on move/copy — RFC 6902 §4.6 requires `test` to carry `value`); remove at root; `move` into own child |
| `UNSAFE_KEY` | prototype-pollution guard tripped (§5.6.1) |

`5.6.1` **Prototype-pollution guard (write-side only).** During **write-side** resolution
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

`5.6.2` `operationIndex` is the 0-based index of the failing op within `patches`. `operation` is
the failing op unmodified.

### 5.7 Behavioral options (not part of the wire format)

`5.7.1` **Structural sharing (default).** In immutable mode, only containers **on a touched path**
are cloned (copy-on-write); a per-call set of already-cloned containers ensures each is cloned at
most once across the whole patch, so N ops on one branch clone it once. Untouched sibling subtrees
keep reference identity (`===`) with the input — usable for memo/change-detection. **Hazard:**
because untouched subtrees are shared, **mutating the returned document can mutate the input**; a
caller intending to mutate the result MUST use `cloneResult` (§5.7.3).

`5.7.2` **`cloneValues`** (default false): when true, each op's `value` payload is deep-cloned
before insertion so the result never aliases objects owned by the patch. When false, values are
inserted **by reference** (do not mutate patch ops after applying).

`5.7.3` **`cloneResult`** (default false): when true, the returned document is a fully independent
deep clone sharing no structure with the input or the patch.

`5.7.4` These options change memory/aliasing behavior only; for a given input+patch they produce
a document **deep-equal** to the default-mode result (§1.4.1). They are not encoded in the patch
and are irrelevant to cross-language vector comparison.

`5.7.5` The empty patch (`[]`) returns the input unchanged; in immutable mode it returns the
**same reference**.

---

## 6. Invert semantics

`invertPatch(document, patches) → Operation[]` returns the inverse of `patches` relative to the
document they were generated from.

### 6.1 Contract

`6.1.1` `document` MUST be the **ORIGINAL** (pre-patch) document. It is required to resolve `/-`
append paths to concrete indices, to recover removed/replaced values when `oldValue` is absent,
and to restore values overwritten by `add`/`move`/`copy` onto existing members.

`6.1.2` **Guarantee:** `applyPatch(applyPatch(D, patches), invertPatch(D, patches))` deep-equals
`D` (§7.3), for any `D` on which `patches` applies cleanly. The inverse is guaranteed against the
forward-applied state, not against an arbitrary document that merely deep-equals `D` up to array
order (index-based ops would mistarget after a reorder).

### 6.2 Inversion rules (forward-simulated)

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

`6.2.1` A `remove`/`replace` whose forward target does not exist in the simulated document →
`PATH_UNRESOLVABLE`. Unknown op / missing `from` → `INVALID_OPERATION`.

`6.2.2` Because inversion is driven by the live simulated document (not solely by `oldValue`), it
correctly inverts third-party patches and non-trailing `/-` interleavings. Generated patches in
default mode also carry `oldValue`, which is sufficient but not necessary here.

---

## 7. Round-trip contracts

These are testable guarantees relating `execute` output to sequential `applyPatch` (§5). Let
`p = execute({original, modified})`.

### 7.1 LCS and unique: exact reconstruction

`7.1.1` For any array diffed by **LCS** (GEN §5), `applyPatch(original-context, p)` reproduces
`modified` **exactly**, including array order and duplicates. LCS ops are purely positional.

`7.1.2` For any array diffed by **unique** (GEN §6), reconstruction is likewise **exact** (positional
replaces at equal length); the unequal-length case is exact via its LCS fallback (GEN §6.2).

`7.1.3` Whole-document: for documents whose arrays are all LCS/unique (or object-only, GEN §2),
`applyPatch(original, p)` deep-equals `modified` exactly (object key order MAY differ; equality is
key-order-insensitive, §1.4.2).

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

`7.2.5` Under the GEN §4.3 gate, arrays that would violate keyed-collection assumptions (non-object
/ keyless / non-string-number-key elements, or duplicate keys) fall back to LCS and therefore get
the **exact** contract (§7.1) instead.

`7.2.6` `7.2.1`–`7.2.4` describe the **default** (`emitMoves` off). With the optional `emitMoves`
capability on (GEN §8.7, CONF §5.4), this contract is **upgraded to exact byte-for-byte reconstruction**
(order included): survivors are reordered via `move`s and new keys are INDEXED adds. See §7.4.

### 7.3 Invert round-trip

`7.3.1` For the original document `D` and `p = execute` output, `applyPatch(applyPatch(D, p),
invertPatch(D, p))` **deep-equals `D`** (§6). The inverse is computed against the ORIGINAL `D`.

### 7.4 `emitMoves`: exact reconstruction across all strategies

`7.4.1` With `emitMoves` on (GEN §8, CONF §5.4), **every** strategy reconstructs `modified`
**exactly** (deep-equal including array order and duplicates) under sequential apply (§5):

| strategy | `emitMoves` off | `emitMoves` on |
|----------|-----------------|-----------------|
| LCS (GEN §5) | exact (§7.1.1) | exact — relocations become `move`s (GEN §8.5) |
| unique (GEN §6) | exact (§7.1.2) | exact — multiset-equal reorders become `move`s (GEN §8.6); non-multiset-equal keeps GEN §6 positional replaces |
| primaryKey (GEN §4) | keyed-collection, order-insensitive (§7.2) | **exact** — survivors reordered + INDEXED adds (GEN §8.7) |

`7.4.2` The upgrade is strict for **primaryKey**: §7.2's contract ("survivors in original relative
order ++ new keys at the tail", order **not** preserved) becomes byte-exact order equality when the
capability is on. LCS and unique were already exact (§7.1); `emitMoves` only changes *which ops*
express the same reconstruction (fewer, smaller ops), never the reconstructed document.

`7.4.3` Verified by exhaustive small-permutation enumeration and >1M randomized bijection trials
(deletes + inserts + changes + reorders, with duplicate values) against **both** the reference
applier and fast-json-patch; every trial reproduced `modified` exactly.

### 7.5 `wholesaleReplaceFallback`: size-capped reconstruction

`7.5.1` With `wholesaleReplaceFallback` on (GEN §9, CONF §5.5), an array whose granular op stream is
discarded for size reasons is instead reconstructed by a single whole-array `replace`, which is
trivially exact (§7.1-style) regardless of which strategy would otherwise have applied. The
capability changes **only** the op stream for oversized arrays; it never changes the reconstructed
document, and composes with `emitMoves`/`includeOldValue` (the estimate is computed on whatever
those capabilities would otherwise emit).

### 7.6 `ignorePaths`: reconstruction modulo ignored subtrees

`7.6.1` With `ignorePaths` on (GEN §10, CONF §5.6), the reconstruction contracts of §7.1–§7.5 hold
**modulo the ignored subtrees**: `applyPatch(original, patch)` equals `modified` **everywhere except
at or beneath a matched ignore location**, where it retains `original`'s value (no op touched it). No
contract is *weakened* for non-ignored content — LCS/unique stay exact, primaryKey stays
keyed-collection (exact under `emitMoves`) — over the projection that drops the ignored subtrees.
Because a `move`-paired relocation may carry an item whose *ignored* members still differ from
`modified`'s (GEN §10.5), the exactness is likewise stated over that projection: the moved item is
`modified`-equal on every non-ignored member. Conformance checks that use ignorePaths compare under
this projection (CONF §4.1).
