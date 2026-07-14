# fast-json-schema-patch — Generator profile (GEN)

**Spec version:** `spec-v1-rc`  ·  **Status:** Release Candidate  ·  part of the four-document specification (see [`SPEC.md`](../SPEC.md)).

This document is the deterministic generator profile: strategy selection and gates, the
Myers pass with pinned tie-breaks and trimming, emission ordering (including ECMAScript key
order), granular descent, the moves machinery and LIS, the wholesale byte formula, and the
capability behaviors — everything needed to reproduce byte-deterministic output
cross-language. The data model and plan model it builds on are in
[CORE](01-core-semantics.md); conformance in [CONF](03-conformance.md). RFC 2119 language:
CONF §1.4.

---


`JsonSchemaPatcher.execute({ original, modified })` returns an ordered `Operation[]`. It walks
`original` and `modified` in lockstep from the root path `""`, dispatching per §1.

## 1. Dispatch (`diff(a, b, path)`)

Given values `a` (from original) and `b` (from modified) at `path`:

`1.1` If `a` and `b` are the **same reference**, emit nothing. (Reference identity is a fast
path; it MUST be output-equivalent to CORE §1.4.1, i.e. only taken when the values are truly equal.)

`1.2` If `a` is absent (`undefined`) and `b` is present: emit `add` (handled by the parent
container; see §2 for objects, and note the root is always present).

`1.3` If `b` is absent and `a` is present: emit `remove` (handled by the parent container).

`1.4` **Type mismatch or primitive.** If either value is a primitive (`null`, boolean, number,
string), or one is an array and the other is not, emit a single
`{ op: "replace", path, value: b, oldValue: a }` and stop. (Two values of different container kind
— object vs array — are a replace, never a structural merge.)

`1.5` If both are **arrays**, dispatch to array diff (§4).

`1.6` If both are **objects**, dispatch to object diff (§2).

Values equal under CORE §1.4.1 but not reference-identical produce no ops because the recursion bottoms
out with no differing leaf.

## 2. Object diff

`2.1` A member with value `undefined` is treated as **absent** (CORE §1.1.3). "Present" means the key
is an own member with a non-`undefined` value.

`2.2` **Key visitation order.** Visit the union of `original`'s keys and `modified`'s keys as:
**all of `original`'s keys in `original`'s pinned member order (CORE §1.3.2), followed by the keys
present only in `modified` in `modified`'s pinned member order (CORE §1.3.2).** Because the pinned
order places integer-like keys ascending-first, this means the integer-like keys of `original`
(ascending) precede its ordinary keys (insertion order), and likewise for the `modified`-only
keys. (The reference implements this as two passes — `Object.keys(original)`, then
`Object.keys(modified)` skipping any already own-present on `original` — each of which yields
`[[OwnPropertyKeys]]` order natively; this is output-equivalent to, but allocates less than,
forming `new Set([...keys(original), ...keys(modified)])` and iterating it; F36.) A conforming
generator MUST reproduce this visitation order (CORE §1.3.2).

`2.3` For each visited `key`, let `childPath = path + "/" + escape(key)` (CORE §2.2):

- present in `modified` only → `{ op: "add", path: childPath, value: modified[key] }` (no
  `oldValue`).
- present in `original` only → `{ op: "remove", path: childPath, oldValue: original[key] }`.
- present in both → recurse `diff(original[key], modified[key], childPath)` (§1).

## 3. Array diff dispatch

`3.1` The array's strategy is looked up from the plan by path (§4.5). If no plan is found, the
strategy is `lcs` (§5).

`3.2` Selection then applies **runtime gates**:

- `strategy === "primaryKey"` **and** `plan.primaryKey` set **and** the arrays satisfy the
  primaryKey applicability gate (§4.3) → primaryKey diff (§4).
- else `strategy === "unique"` **and** `checkArraysUnique(a, b)` true (§4.4) → unique diff
  (§6).
- else → LCS diff (§5).

`3.3` The dispatcher MAY use per-path caches (a "plan is empty" flag, a "simple path" set, a
negative-plan set). These are **non-normative** and MUST be output-neutral: the emitted patch MUST
equal what §3.1–§3.2 produce with a direct lookup.

## 4. primaryKey strategy

Applies when a plan gives `strategy === "primaryKey"` with a non-null `primaryKey` **and** the
gate (§4.3) passes. Let `k = plan.primaryKey` and `prefix = path + "/"`.

### 4.1 Normative three-phase emission

`4.1.1` **Phase 1 — index the original.** For each index `i` in `original`, if `original[i]` is
an object with a key-value `original[i][k]` that is a **string or number** (not `undefined`/
`null`/other), record `keyToIndex[keyValue] = i` and remember the item.

`4.1.2` **Phase 2 — scan the modified.** For each index `j` in `modified` (in order), let
`item = modified[j]`; skip if `item` is not an object or `item[k]` is `undefined` or not a
string/number. Look up `keyToIndex[item[k]]`:

- **Matched** (`oldIndex` found): remove that entry from `keyToIndex`. If the original item and
  the modified item are **not deep-equal** (CORE §1.4.1; a hash prefilter §4.6 may fast-path the
  negative but MUST agree with deep-equal), recurse `diff(originalItem, modifiedItem, prefix +
  oldIndex)` — emitting **field-level ops at the item's ORIGINAL index** — into the
  *modification* group.
- **Unmatched** (new key): append `{ op: "add", path: prefix + "-", value: item }` to the
  *addition* group (CORE §2.5 append token).

`4.1.3` **Phase 3 — removals.** The keys remaining in `keyToIndex` are original items with no
match in modified. Collect their original indices, **sort descending**, and for each emit
`{ op: "remove", path: prefix + index, oldValue: originalItem }` into the *removal* group.

`4.1.4` **Concatenation order (normative).** The final ops for this array are
`modifications ++ removals ++ additions`, in that order:

1. **modifications** — field-level ops at original indices, in the order modified items were
   scanned (Phase 2 order);
2. **removals** — in **descending original index** order;
3. **additions** — `/-` appends, in modified appearance order.

This ordering is REQUIRED (§7 explains why it is round-trip-correct under sequential apply). It
is the **default** emission; with the optional `emitMoves` capability on, the three-phase emission
is replaced by the move machinery (§8.7) that reconstructs `modified` order exactly.

`4.1.5` **Key equality (normative).** Index construction (Phase 1) and lookup (Phase 2) MUST
treat two primaryKey values as the same key **iff they are equal by JSON type AND value** (CORE §1.4.3):
no coercion is performed, so a numeric key `1` and a string key `"1"` are **distinct** keys and
never match each other (as are, e.g., `true` and `"true"` — though only string/number keys are
indexed at all, §4.1.1). The reference stores keys in a `Map` keyed by the raw string/number
value, which distinguishes `1` from `"1"` natively.

### 4.2 Worked example

Original `users = [{id:a,name:A},{id:b,name:B},{id:c,name:C}]`; modified
`[{id:c,name:C2},{id:a,name:A},{id:d,name:D},{id:e,name:E}]` (schema keys on `id`) emits, in
order:

```
{op:"replace", path:"/users/2/name", value:"C2", oldValue:"C"}   // mod: c at ORIGINAL index 2
{op:"remove",  path:"/users/1", oldValue:{id:"b",name:"B"}}       // removal (b), descending
{op:"add",     path:"/users/-", value:{id:"d",name:"D"}}          // additions in modified order
{op:"add",     path:"/users/-", value:{id:"e",name:"E"}}
```

### 4.3 Applicability gate and fallback *(landed — P1 fixes F05/F06)*

Before committing to the primaryKey strategy, the differ MUST verify, in one `O(n+m)` pass over
both arrays, that:

- **(a)** every element of both arrays is an **object** whose value at `k` is a **string or
  number** (present, non-null); **and**
- **(b)** there are **no duplicate** key values within `original` and none within `modified`.

If either check fails, the array **MUST fall back to `lcs` (§5)** for this diff. (At pre-audit
HEAD, neither check was performed: non-conforming elements were silently skipped — added/removed
items vanished from the patch — and duplicate keys corrupted the index, so even identical arrays
could emit a growing patch. The gate makes both cases well-defined via `lcs`, which is exact.) A
`primaryKeyMap` override (CORE §3.4.3) selects the strategy but does **not** bypass this gate; a
gate-failing array still falls back to `lcs`.

### 4.4 `checkArraysUnique` (gate for `unique`)

`checkArraysUnique(a, b)` returns true iff: `a.length === b.length`, **and** `a` has no two
deep-equal elements, **and** `b` has no two deep-equal elements. (The reference uses a `Set` of
element references over primitive arrays; because `unique` is only assigned to primitive item
schemas, reference-set uniqueness coincides with deep-equal uniqueness for the values it sees.)
If the check fails, the array falls back to `lcs`.

### 4.5 Plan lookup by structural trie matching *(matching algorithm — normative for strategy selection)* *(landed — P2 fixes F18/F33)*

The `Plan` map (CORE §3.1) is **compiled once** into a **trie** and matched **structurally** by
threading the current trie node down the diff recursion — no concrete path string is ever
normalized or looked up, and no per-path caches are kept. (Pre-audit HEAD instead re-derived
a concrete path per array and probed the flat map with exact / index-normalized / single-trailing-
wildcard string keys, which grew four unbounded per-instance caches, F18, mis-routed numeric
object keys via index-normalization, F33, and could not reach a wildcard plan at arbitrary depth
or at the top level. The trie makes all four issues structural.)

`4.5.1` **Trie construction.** Each plan key is split on `/` into segments (the empty key `""`
— a root-level array document — has zero segments and terminates at the root node). A `*` segment
is the node's **wildcard edge**; any other segment is **unescaped** (CORE §2.3) and is an exact
**child edge** keyed by the raw property name. The `ArrayPlan` is stored on the node where its key
terminates. (Because `buildPlan` emits both an `additionalProperties` value and a nested-array
element level as the literal segment `*`, a schema property whose name is literally `"*"` is
indistinguishable from the wildcard edge — a pinned edge case, RATIONALE §3.1, not latitude.)

`4.5.2` **Threaded matching.** The diff starts at the trie root (an **empty plan threads no
node**, so every array is `lcs`). The node is advanced by the container being descended:

- **Object member `key`** (§2): the child node is the node's **exact child** for `key` if one
  exists, **else** its **wildcard** edge, **else none**. *Exact edges take precedence over the
  wildcard edge at every level* — an `id` property beats `additionalProperties`. A member whose key
  is a decimal-digit string (e.g. `"0"`) is an ordinary exact/​wildcard descent and is **never**
  conflated with an array index (§F33), because array indices are consumed only in the array rule.
- **Array element** (§4/§5 recursing into an item): an **object** element **stays at the
  array's own node** (array items share the array's document path, CORE §3.3.3, so an item property's
  plan is a child of the array's node); an **array** element (array-of-arrays) descends to the
  array node's **wildcard** edge — the inner array's `${path}/*` plan (CORE §3.3.5). A mixed-kind
  element pair does not descend (§1 emits a whole `replace`), so its node is immaterial.

`4.5.3` **Strategy selection.** An array's strategy is the `plan` on the trie node reached for
that array, or `lcs` when the node is absent or carries no plan. Under the (non-normative,
output-neutral, §3.3) `hashFields`/negative caches the reference may keep, the result MUST equal
this structural lookup.

**Consequences (formerly pinned limitations, now specified matches):** an `additionalProperties`
(wildcard) plan is reachable at **any depth**, including a **deeper** key such as `/*/items` for a
concrete path `/envA/items`, a nested `/*/x/*/items`, **and a top-level `/*`** plan key for a
concrete root array member such as `/foo` (the old `lastIndexOf('/') > 0` guard is gone). Numeric-
string object keys route by construction. The exact-over-wildcard precedence is the only tie-break.
The nested-array wildcard element level (CORE §3.3.5) is matched by the array-element rule above.

### 4.6 Hash-field prefilter (non-normative)

`hashFields` MAY be used to fast-path the "items differ" decision in Phase 2: if any hash field
differs, the items differ without a full deep-equal; only if all hash fields match is a full
deep-equal performed. This MUST be output-neutral (CORE §1.4.4) — it may only *shortcut to a
deep-equal-consistent verdict*, never override it.

## 5. LCS strategy (default)

Applies when no plan matches, when the plan strategy is `lcs`, or as the fallback from §4.3 /
§4.4 / §6. It computes a shortest edit script by **Myers' O(ND) diff** and emits positional
ops. LCS reconstruction is **always exact** (CORE §7.1).

Let `prefix = (path === "" ? "/" : path + "/")` throughout §5 (so a root-level array uses `/`
before the index, never a bare `/`).

### 5.0 Common prefix/suffix trimming (normative step 0)

Before running Myers, the differ **MUST** trim the shared ends of the two arrays and run the
remainder of the algorithm on the trimmed **window** only. This is step 0 of the normative LCS
algorithm; §5.1–§5.5 operate on the window it produces.

`5.0.1` **Trim order (pinned).** Compute the **maximal common prefix first**, then the
**maximal common suffix of the remainder**, using the same deep-equal predicate (CORE §1.4.1) as the
snake (§5.2):

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

`5.0.2` **Index offset.** Emission (§5.5) begins with `currentIndex = lo`: the `lo` trimmed
prefix elements are unchanged `common` entries that occupy output indices `0..lo-1` and are never
emitted. Window coordinates `(x, y)` map to array indices `(lo + x, lo + y)` for both equality
comparisons and value retrieval. The pinned Myers tie-breaks (§5.2) therefore apply to the
**window**.

`5.0.3` **Window fast paths.** If `wn = 0` and `wm = 0`, the arrays are deep-equal and **no ops**
are emitted. If `wn = 0` (pure insertion — append, prepend, or interior insert), emit
`{ op: "add", path: prefix + (lo + j), value: modified[lo + j] }` for `j` from `0` to `wm-1`
(ascending). If `wm = 0` (pure deletion — truncate, or prefix/suffix/interior removal), emit
`{ op: "remove", path: prefix + (lo + j), oldValue: original[lo + j] }` for `j` from `wn-1` down
to `0` (**descending**). The §5.1 empty-array paths are the `lo = 0, hi = 0` special case of
these window fast paths.

### 5.1 Empty-array fast paths

These are the degenerate case of §5.0 when one array is empty (`lo = hi = 0`); an implementation
MAY special-case them ahead of the trim scan.

- `original` empty, `modified` length `m`: for `i` from `0` to `m-1`, emit
  `{ op: "add", path: prefix + i, value: modified[i] }` (ascending).
- `modified` empty, `original` length `n`: for `i` from `n-1` down to `0`, emit
  `{ op: "remove", path: prefix + i, oldValue: original[i] }` (**descending**, each carrying
  `oldValue`).

### 5.2 Myers forward pass and tie-break (pinned)

Throughout §5.2–§5.3, `n`, `m`, `original`, and `modified` denote the **trimmed window** of
§5.0: `n = wn`, `m = wm`, `original[x]` is array element `original[lo + x]`, and `modified[y]`
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
- **Snake:** while `x < n` and `y < m` and `original[x]` deep-equals `modified[y]` (CORE §1.4.1),
  advance both. Equality here MAY be memoized/interned but MUST equal deep-equal.
- Terminate when `x >= n` and `y >= m`; that `d` is the edit distance.

Equality comparisons during the pass MUST be exact deep-equal (CORE §1.4.4). The reference implementation
**interns** each window element to an integer id via a canonical, key-sorted fingerprint shared
across both arrays (equal fingerprint ⟺ deep-equal for JSON inputs, CORE §1.4.1–CORE §1.4.2), so the snake
compares `idsA[x] === idsB[y]` in O(1). Fingerprint interning is an output-neutral implementation
detail (CORE §1.4.4); a lossy hash MUST confirm id-equality collisions with full deep-equal. An
implementation MAY instead memoize deep-equal per visited pair, but any such pair-cache key MUST be
collision-free for the array sizes in play (`x*(m+1)+y` is exact to ~`2^53` elements; a `(x<<16)|y`
style key that collides past 65535 elements is **non-conforming**).

### 5.3 Backtracking and the edit script

Backtrack from `(n, m)` to `(0, 0)` following the same down/right rule against the recorded
V-rows, producing a forward-ordered script of `common(ai,bi)`, `remove(ai)`, and `add(bi)`
entries.

### 5.4 Replace collapse and granular descent

`5.4.1` **Collapse.** Scan the forward script; whenever a `remove` is immediately followed by an
`add`, collapse the pair into a single `replace` at the same output index.

`5.4.2` **Granular descent (normative default).** For a collapsed `replace` pair
`(original[ai], modified[bi])`: if **both** sides are objects, **or both** are arrays, the differ
**MUST recurse** — `diff(original[ai], modified[bi], prefix + currentIndex)` — emitting granular
nested ops instead of a whole-item replace. If the pair is primitive, or the two sides are of
mismatched container kind (object vs array), it stays a **whole-item** `{ op: "replace", path,
value: modified[bi], oldValue: original[ai] }`. The recursion reuses the ordinary `diff` dispatch,
so nested plans apply: an object element recurses at the array's own plan node (item property plans
are its children, CORE §3.3.3); an array element recurses into the nested-array wildcard plan at
`${path}/*` (CORE §3.3.5). This descent (F10) is the one LCS behavior that changed during the
compactness phase; before it, a whole-item replace was always emitted for a collapsed pair.

### 5.5 Emission from the script

Walk the (collapsed) script maintaining `currentIndex` starting at `lo` (§5.0.2 — the trimmed
common prefix occupies output indices `0..lo-1`); `prefix` as above:

- **common:** if both `original[ai]` and `modified[bi]` are objects/arrays, recurse
  `diff(...)` at `prefix + currentIndex` (they are already deep-equal per the snake, so this
  yields no ops; it is a no-op that MUST NOT emit anything — an implementation MAY skip it).
  `currentIndex++`.
- **replace** (§5.4): emit a whole-item replace at `prefix + currentIndex`; `currentIndex++` —
  **unless granular descent applies** (§5.4.2), in which case recurse
  `diff(original[ai], modified[bi], prefix + currentIndex)` at `prefix + currentIndex` instead of
  emitting a whole-item replace, and still `currentIndex++`.
- **remove:** emit `{ op: "remove", path: prefix + currentIndex, oldValue: original[ai] }`;
  `currentIndex` is **not** incremented (subsequent ops address the shifted array).
- **add:** emit `{ op: "add", path: prefix + currentIndex, value: modified[bi] }`;
  `currentIndex++`.

The resulting ops are index-correct under strict sequential application (CORE §7.1).

## 6. unique strategy

Applies when `strategy === "unique"` **and** `checkArraysUnique(a, b)` passed (§4.4), which
requires **equal lengths**. Let `prefix = path + "/"`.

`6.1` **Normative behavior: positional replaces.** For each index `i` in `0..length-1`, if
`original[i]` is not deep-equal to `modified[i]`, emit
`{ op: "replace", path: prefix + i, value: modified[i], oldValue: original[i] }`. Because the gate
guarantees equal lengths, no adds or removes are emitted. spec-v1 defines `unique` solely as
equal-length positional replacement (F38: a HEAD-era removal/addition phase built atop this loop was
provably unreachable behind the equal-length gate and has been deleted from the reference
implementation — this **is** the whole function now, not a fallback path).

`6.2` **Unequal lengths fall back to `lcs`** (§4.4 gate fails → §5). Set-diff / move
semantics for `unique` are **not** specified in spec-v1.

`6.3` **`emitMoves` (§8.6).** With the optional `emitMoves` capability on, a **multiset-equal**
(pure-permutation) unique array is emitted as `move`s instead of positional replaces (a 50-element
rotation drops from 50 replaces to one move); a non-multiset-equal pair keeps the §6.1 positional
replaces. Default output (capability off) is unchanged.

## 7. Emission-order guarantees (normative)

`7.1` Ops are emitted in **document order** and are correct **only under strict sequential
application** (CORE §5.1). A consumer MUST NOT reorder, batch, deduplicate, or parallelize them.

`7.2` Within a keyed array, the order is fixed as §4.1.4 (modifications at original indices,
then removals descending, then `/-` appends in modified order). Within an LCS array, ops follow
the evolving index per §5.5. Across object members, ops follow §2.2.

`7.3` The reason descending removals + trailing appends round-trips: removing higher indices
first keeps lower indices valid; modifications are addressed at pre-removal indices and applied
before any removal shifts them; `/-` appends land after all removals so they target the final
tail. See CORE §7.

## 8. `emitMoves` capability (normative when enabled)

`emitMoves` is an **OPTIONAL** capability (default **off**, CONF §5.4). When **off**, every array
strategy emits exactly the ops specified in §4–§6 and output is byte-stable versus the
pre-capability tree. When **on**, all three strategies share **one** machinery that expresses a
relocated (unchanged) array element as a single RFC 6902 `move` instead of a remove+add pair, and
makes `unique` and `primaryKey` reconstruct `modified` **order exactly** (CORE §7.2 is upgraded, CORE §7.4).
This section pins that machinery so a reimplementation emits byte-identical ops.

`8.1` **Bijection model.** Each strategy reduces its array diff to: a set of **matched** pairs
`(src, tgt, changed)` — a bijection between a subset of `original` indices `src` and a subset of
`modified` indices `tgt`, where `changed` is true iff `original[src]` is **not** deep-equal
(CORE §1.4.1) to `modified[tgt]`; a set of **pureDeletes** (original indices with no match); and a set
of **pureInserts** (modified indices with no match). `matched ∪ pureDeletes` partitions
`0..n-1`; `matched ∪ pureInserts` partitions `0..m-1`. How each strategy computes the bijection is
§8.5–§8.7; the emission (§8.2–§8.4) is shared and identical.

`8.2` **LIS (pinned tie-break).** Let `seq` be a permutation of `0..S-1`. `LIS(seq)` is the set
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

`8.3` **`computeMoves(seq)` (pinned).** `seq` is a permutation of `0..S-1`: the element at
source position `p` must end at target rank `seq[p]`. The elements whose **source positions** are
in `LIS(seq)` are the **fixed skeleton** and are NEVER moved; every other element is relocated by
exactly one `move`. Maintain a `working` list (source positions, initially identity `0..S-1`) and
`srcOfTarget[t]` = the source position with target rank `t`. Process target ranks **right-to-left**
(`t` from `S-1` down to `0`); for each non-skeleton `srcOfTarget[t]`: let `from` = its current
index in `working`; splice it out; let `to` = `working.length` when `t === S-1`, else the current
index in `working` of `srcOfTarget[t+1]` (insert immediately before the already-final element to
its right); splice it back at `to`. Emit `{from, to}` **unless `from === to`** (no-op moves are
dropped). Both indices are in the length-`S` array's own coordinate space.

`8.4` **Staged emission (pinned order).** Emit ops in exactly four stages, in this order:

1. **removes** — `pureDeletes` in **descending** index; each `{op:"remove", path: prefix+src,
   oldValue?}` (`oldValue` per CORE §4.4.2). After this the array is the survivors in original order.
2. **moves** — build `seq` by ordering `matched` by `src` (ascending) and mapping each to its rank
   in the `matched`-ordered-by-`tgt` list; emit `computeMoves(seq)` as `{op:"move", from:
   prefix+from, path: prefix+to}` (moves carry NO `value`/`oldValue`). Indices are in the
   survivors-only space of this moment (after removes, before inserts).
3. **inserts** — `pureInserts` in **ascending** target index; each `{op:"add", path: prefix+tgt,
   value: modified[tgt]}` — an **INDEXED** add, never `/-`.
4. **replaces** — `matched` with `changed === true`, in **ascending** target index; a same-kind
   pair (both objects or both arrays) **recurses** (granular descent, §5.4.2) at `prefix+tgt`,
   otherwise a whole-item `{op:"replace", path: prefix+tgt, value: modified[tgt], oldValue?}`. The
   array is at full `modified` length here, so every target index is final.

`prefix = (path === "" ? "/" : path + "/")`. This sequence reconstructs `modified` **exactly**
(order and duplicates) under sequential apply (CORE §5.1); verified by exhaustive small-permutation and
randomized bijection fuzzing against both the reference applier and fast-json-patch.

`8.5` **LCS mapping (F22).** With `emitMoves` on, the LCS strategy (§5) runs unchanged through
the trim (§5.0), Myers pass (§5.2), backtrack, and collapse (§5.4.1), then — on the main
window path only (the move-free fast paths §5.0.3/§5.1 already emit the staged ops) — builds
the bijection instead of the §5.5 walk: trimmed-prefix indices `i<lo` and trimmed-suffix indices
are `matched(i, i', changed:false)`; a `common` script entry is `matched(changed:false)`; a
`replace` entry is `matched(changed:true)`; a leftover `remove` and leftover `add` are **paired
into a relocation `matched(changed:false)` iff their interned ids are equal** (exact deep-equal,
§5.2 — so a move NEVER pairs non-identical values). Pairing is deterministic: for each interned
id, leftover adds are queued in ascending target order, and each leftover remove (in script order)
claims the **earliest unused** add of its id. Unpaired removes are `pureDeletes`; unpaired adds are
`pureInserts`. Then §8.4 emits. Granular descent (§5.4.2) still applies via stage 4.

`8.6` **unique mapping (F23).** With `emitMoves` on, when the `unique` gate passes (§4.4 —
equal length, no duplicates in either side) **and** the two arrays are **multiset-equal** (same
value set, hence a pure permutation), the bijection is `matched(src, tgt, changed:false)` for every
element, where `tgt` is the (unique) index of `original[src]`'s value in `modified`; `pureDeletes`
and `pureInserts` are empty; §8.4 emits pure `move`s (stages 1/3/4 empty). If the arrays are
**not** multiset-equal, the strategy keeps the §6 positional-replace emission unchanged (moves buy
nothing there and would cost a remove+add per differing element). Equal-length + unique + multiset-
equal is exactly the reorder case §6 emits as `N` positional replaces by default (`emitMoves` off).

`8.7` **primaryKey mapping (F07).** With `emitMoves` on, the primaryKey strategy (§4), under the
same applicability gate (§4.3), replaces its three-phase emission (§4.1) with the bijection:
index `original` by key (§4.1.1); for each `modified[j]`, if its key matches an original index
`i`, add `matched(i, j, changed: !deepEqual(original[i], modified[j]))`; unmatched `modified[j]`
are `pureInserts` (`j`); original keys never matched are `pureDeletes`. Then §8.4 emits — so
survivors are **reordered** into `modified` order via `move`s and new keys are **INDEXED** adds at
their `modified` position (never `/-`), making `applyPatch(original, p)` equal `modified`
**byte-exactly** (order included). This upgrades CORE §7.2 to CORE §7.4 for this array. The gate still governs:
non-conforming / duplicate-key arrays fall back to `lcs`, which under `emitMoves` uses §8.5.

## 9. `wholesaleReplaceFallback` capability (normative when enabled)

`wholesaleReplaceFallback` is an **OPTIONAL** capability (default **off**, CONF §5.5). When **off**,
array diffing is exactly §4–§8 and output is byte-stable versus the pre-capability tree. When
**on**, it is evaluated **per array, at every array-diff call site** (the top-level array of a diff
and, independently, every nested array reached through granular descent, §5.4.2 / §8.4 stage 4) —
**after** the array's strategy (§4/§6/§5, composing with `emitMoves` §8 if also on) has
produced its op list for that array:

`9.1` **Nesting order (bottom-up).** Because granular descent recurses through the ordinary `diff`
dispatch, a nested array is itself a `diffArray` call site and makes its **own** independent
cutover decision — using only the ops it itself would emit and its own array's serialized size —
**before** whatever it emits (its granular ops, or its own single wholesale replace) becomes part
of its parent array's op list. The parent's cutover decision is then made over its own op list,
which may already contain a child's wholesale replace.

`9.2` **Byte estimate (pinned).** For an array's produced op list `ops`, the estimate is:

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

`9.3` **Threshold and cutover.** Let `threshold = len(JSON.stringify(modified))` (the array's own
serialized size). If `estimate > threshold`, **discard** the array's op list entirely and emit
instead a single `{ op: "replace", path, value: modified, oldValue: original }` (`oldValue` present
iff `includeOldValue`, CORE §4.4.2) at the array's own path. Otherwise emit the array's op list
unchanged. The comparison is **strict `>`** — a tie keeps the granular ops.

`9.4` **Determinism.** §9.2–§9.3 depend only on the op list a supported strategy/capability
combination would otherwise produce and on `JSON.stringify` of the array values, both of which are
themselves normatively pinned elsewhere in this spec (§4–§8, CORE §1.2) — so the cutover decision is
fully deterministic and Go-reproducible given a conforming `JSON.stringify`-equivalent serializer
(same number/string encoding, CORE §1.2–CORE §1.3; key order does not affect the byte **count**).

`9.5` This capability is orthogonal to strategy selection (CORE §3.7) and to `emitMoves`/
`includeOldValue`: it never changes *which* strategy runs, only whether that strategy's output (or
`emitMoves`'s, if also on) is kept or replaced wholesale for a given array.

## 10. `ignorePaths` capability (normative when enabled)

`ignorePaths` is an **OPTIONAL** generator capability (default **off**, CONF §5.6). It is a
**set of JSON Pointers**, each addressing **object-member locations**, that mark subtrees the diff
MUST treat as **equal in both directions**: no operation is emitted **at or beneath** any matched
location, in **any** strategy. When the set is empty/absent, diffing is exactly §1–§9 and output
is byte-stable versus the pre-capability tree. Surfaced as the `JsonSchemaPatcher` constructor
option `ignorePaths?: string[]` (TS) / the `IgnorePaths(...)` `PatcherOption` (Go). Modeled on
wI2L/jsondiff's `Ignores`.

`10.1` **Construction and validation (pinned).** Each pointer is validated when the patcher is
constructed; a violation is a **construction-time error** (`TypeError` in TS, a returned `error` in
Go), never a silent no-op:

- A pointer MUST be `""`-less and begin with `/` — the empty/root pointer `""` is **rejected** (the
  document root is not an object-member location), and a non-empty pointer without a leading `/` is
  **rejected** (malformed, mirroring CORE §5.2's pointer grammar).
- Each `/`-separated segment (unescaped per CORE §2.3) MUST NOT be a **canonical array index** (CORE §1.3.2 —
  `"0"`, or a non-zero digit followed by digits, in `0..2^32-2`) and MUST NOT be `-`. Such a segment
  is **rejected**: ignore pointers address object members structurally, and an array level is only
  ever matched by a `*` wildcard (§10.3), never a literal index. *(A segment that merely looks
  numeric but is not a canonical index — e.g. `"01"` — is a legal object-member name and is
  accepted; this mirrors §F33's numeric-string object keys.)*
- A `*` segment is the **wildcard** — "any member at this level", identical semantics to plan
  wildcards (§4.5.1). Duplicate pointers are permitted (idempotent).

`10.2` **Trie compilation.** The validated pointer set is compiled **once** into an **ignore trie**
mirroring the plan trie (§4.5.1): each pointer is split on `/`; a `*` segment is the node's
**wildcard** edge, any other segment is **unescaped** (CORE §2.3) and an exact **child** edge keyed by the
raw member name; the node where a pointer terminates is marked **terminal** ("ignored here"). The
trie is threaded down the diff recursion **in parallel with** the plan trie, as an independent node
pointer. An **absent** ignore set threads no node (every location is diffable), preserving byte-for-
byte pre-capability output.

`10.3` **Threaded matching (pinned).** Starting at the ignore-trie root, the node is advanced by
the container being descended, **mirroring §4.5.2 for object members** and traversing array levels
**transparently through the wildcard**:

- **Object member `key`** (§2): advance to the node's **exact child** for `key` if present, **else**
  its **wildcard** edge, **else none**. *Exact edges take precedence over the wildcard at every
  level.* A decimal-digit member key is an ordinary exact/​wildcard descent, never an array index
  (§F33) — array indices are consumed only by the array rule below.
- **Array element** (§4/§5/§6 recursing into an item — object, array, or primitive alike):
  advance to the node's **wildcard** edge, **else none**. The array index level is represented by a
  single `*` (there is no literal-index edge, §10.1), so `/users/*/updatedAt` reaches, for each
  element of a `users` array, the member `updatedAt` under that element: `users` (child) → `*`
  (array-element wildcard) → `updatedAt` (child, terminal). This is how "the wildcard matches the
  object-member level under array items exactly as plan paths do" — the array level is traversed
  transparently, one `*` per nesting, and the item's members are matched against the node **beyond**
  it. It holds identically inside keyed (§4) and LCS (§5) array items.

`10.4` **Effect (pinned).** When the recursion reaches a node that is **terminal**, that entire
subtree is **equal**: emit **nothing** at or beneath it. Concretely:

- **`diff` (§1)** emits nothing when the threaded ignore node is terminal.
- **Object diff (§2)** computes each member's child ignore node (§10.3) and, when it is terminal,
  emits **no** `add`/`remove`/recursion for that member — so a member present on only one side but
  ignored produces no op, and a member present on both but ignored is not descended.
- **Array diff (§3–§6)** short-circuits to **no ops** for the whole array when the array-element
  ignore node (the node's wildcard) is terminal (e.g. `/arr/*` — every element ignored). Otherwise it
  recurses element members through §10.3.

`10.5` **Post-ignore equality for keyed/relocation matching (pinned).** The equality used to decide
element identity in the array strategies is taken **after** ignore-filtering, so two items that
differ **only** in ignored members compare **equal**:

- **LCS interning (§5.2).** The canonical fingerprint used to intern window elements is computed
  with the item's ignore node, **omitting** ignored members (and ignored array elements). Two items
  differing only in ignored fields therefore share an interned id and are treated as **common** (no
  op) or, under `emitMoves` (§8), as a single **relocation** — never a spurious remove+add. The
  prefix/suffix **trim** predicate (§5.0) MAY remain full deep-equal (CORE §1.4.1): a fully-equal pair is
  necessarily ignore-equal, so the window handles the remainder.
- **primaryKey (§4) and unique (§6).** Element pairing is by key/position, unaffected by ignored
  members. The change flag MAY be computed by full deep-equal; when it is conservatively `true` for an
  ignored-only difference, the element recursion (§10.4) emits nothing, so the emitted patch is
  **output-equivalent** to post-ignore equality.

`10.6` **Interaction with `wholesaleReplaceFallback` (§9, pinned).** A wholesale replace emits the
**entire** modified array as one `replace` value, which would **leak** ignored content (re-writing
ignored members on apply). Therefore, when **any** ignore terminal lies **beneath** an array (i.e. the
array's ignore node has a terminal anywhere in its subtree), `wholesaleReplaceFallback` is **disabled
for that array**: it keeps the ignore-filtered granular op stream. When no ignore path lies beneath an
array, the §9 estimate/threshold are computed on the (already ignore-filtered) granular ops exactly
as in §9.

`10.7` **Interaction with `primaryKey` (CORE §3.5/§4, pinned).** A plan's `primaryKey` **field** MUST
NOT be ignorable. At construction, for every array plan carrying a non-null `primaryKey k` at plan key
`P`, the key-field location `P` `/` `*` `/` `k` is checked against the ignore trie; if that location is
**at or beneath** any ignore terminal (the field itself, or an ancestor container such as the whole
item `P/*` or the whole array `P`), construction **fails** with a validation error. (Walking `P`: a
literal segment follows exact-child-else-wildcard; a `*` segment in `P` — an `additionalProperties` or
nested-array level, CORE §3.3.2/CORE §3.3.5 — explores both exact children and the wildcard, since either may
match at diff time.) This keeps keyed pairing well-defined: the field that establishes item identity
can never be filtered away.

`10.8` **Determinism.** All of §10 depends only on the pinned trie construction (§10.1–§10.2),
the pinned traversal (§10.3), and the pinned ignore-filtered fingerprint (§10.5) — no per-instance
caches, no data-dependent ordering — so the emitted patch is fully deterministic and Go/TS-identical
for a given `(ignorePaths, plan, original, modified)`.
