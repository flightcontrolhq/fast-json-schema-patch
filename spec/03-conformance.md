# fast-json-schema-patch — Conformance (CONF)

**Spec version:** `spec-v1-rc`  ·  **Status:** Release Candidate  ·  part of the four-document specification (see [`SPEC.md`](../SPEC.md)).

This document defines the vector formats (diff / apply / plan / invert), the conformance
gates, the required coverage classes, the capability registry, and the spec versioning
rules. The stable semantics are in [CORE](01-core-semantics.md); the generator profile in
[GEN](02-generator-profile.md); non-normative history in [RATIONALE](04-rationale.md).

---

## 1. Scope, audience, and versioning

### 1.1 Purpose

This specification — the CORE, GEN, and CONF documents — is the normative source from which
independent implementations of `fast-json-schema-patch` are written. It defines, precisely enough
that an implementer never needs to read the reference source:

- how a *plan* is derived from a JSON Schema (CORE §3);
- how a *diff* between two JSON documents is computed and emitted as an ordered patch (GEN);
- the wire format of the emitted patch (CORE §4);
- the round-trip guarantees each array strategy provides (CORE §7);
- how a patch is *applied* to a document (CORE §5) and *inverted* (CORE §6);
- the conformance vector formats and the pass/fail gate (CONF).

### 1.2 Audience

Implementers porting the engine to another language (a Go engine is the immediate next
consumer), and authors of conformance vectors.

### 1.3 Spec versioning and stability

- This is `spec-v1-rc`, dated **2026-07-14** against reference implementation
  `fast-json-schema-patch` v0.4.0 (branch `feat/deep-dive-overhaul`). Section numbers
  (e.g. `5.3.2`) are stable citation anchors; vectors and implementations SHOULD cite them.
- `spec-v1` was first finalized after the P1–P4 phases landed (correctness, performance,
  compactness, packaging). Every section the draft marked *(draft-pending)* is now landed in
  the reference implementation and reads as normative; RATIONALE §2 records each landed fix
  with its section for provenance.
- **Release-candidate status (2026-07-14).** An external review reopened the spec from *Final* to *Release Candidate* to pin corrected behavior normatively (CORE §1.2.4 non-finite numbers, CORE §2.7 malformed pointer, CORE §5.3 `test` requiring `value`) and to add conformance vectors for it; the D1–D7 defect narrative that prompted this is in RATIONALE §1. `spec-v1` returns to *Final* once every engine passes the augmented suite.
- **Normative vs. pre-audit HEAD.** This spec describes the semantics of the finalized
  reference implementation. Several behaviors specified here were bug-fixes over the
  pre-audit HEAD (primaryKey fallback GEN §4.3, nested-array plan paths CORE §3.3.5, `basePath`
  segment matching CORE §3.6.2, schema traversal without explicit `type` CORE §3.3.1, granular LCS
  descent GEN §5.4); all are now landed. RATIONALE §2 is the contract-vs-pre-audit-HEAD summary.
- **Patch-format stability.** The patch wire format (CORE §4) is the cross-language compatibility
  surface. Within a major spec version, the set of emitted op kinds, the guaranteed per-op
  fields (CORE §4.3), and the pointer-escaping rules (CORE §2) are stable. Consumers MAY rely on them.
  The *choice of strategy* and the *exact op sequence* for a given input MAY change between
  minor spec versions (they are generator-defined, not format-defined); consumers MUST NOT
  assume byte-identical patches across spec versions, only that any conforming patch applies
  to reproduce the strategy's round-trip contract (CORE §7).

### 1.4 Conformance language (RFC 2119)

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**,
**SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** are to be interpreted as described
in RFC 2119. A conforming implementation MUST satisfy every MUST/MUST NOT/REQUIRED/SHALL across
this specification (CORE, GEN, and CONF) that applies to the capabilities it implements.
Capabilities marked OPTIONAL (§5) MAY be omitted.

### 1.5 Out of scope

The human-readable diff/formatting layer (`StructuredDiff`, `DiffFormatter`) is **not** part of
this spec. Behavioral options that do not affect the wire format (structural sharing,
`cloneValues`, `cloneResult`, `validateOldValues`; CORE §5.7) are specified because they govern
apply semantics, but they are not part of the patch format.

---


## 2. Diff vector format

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

`2.1` The implementation under test computes `buildPlan(schema, options)` (empty plan when
`schema` is null), then `execute({original, modified})`, and compares against `expectedPatch` per
the gate (§4).

## 3. Apply vector format

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

`3.1` For an `error` vector, apply MUST throw `JsonPatchError` with the given `code` and
`operationIndex === index`. For an `expected` vector, the result MUST deep-equal `expected`
(CORE §1.4.1) and MUST NOT throw. Invert round-trips have their own dedicated vector format (§8).

## 4. The conformance gate (normative)

A diff vector **passes** iff **both** hold:

`4.1` **(a) Round-trip.** The emitted op sequence, applied sequentially under RFC 6902 (CORE §5) to
the vector's `original`, reproduces the expected document per the strategy's round-trip contract
(CORE §7): **exact** deep-equality for LCS/unique/object-only diffs; **multiset-equal with canonical
survivor+append order** for primaryKey diffs.

`4.2` **(b) Structural op equality.** The emitted op sequence is **structurally equal** to the
vector's `expectedPatch`: same length, same ordered sequence of ops, each op equal by `op`, `path`
(as a string), and — where present — `value`/`oldValue`/`from` under deep JSON equality (CORE §1.4.1,
so numbers compare at `f64` and object key order within values is insignificant).

`4.3` **Byte-identity of serialized JSON is NOT required.** Differences in number *text*
(CORE §1.2.3), object key *order within values* (CORE §1.4.2), or insignificant whitespace do not fail a
vector. Op *ordering* in the sequence **is** significant and is checked by §4.2.

`4.4` A conforming generator MUST pass every default-mode diff vector; a conforming applier
MUST pass every apply vector for the ops it supports.

## 5. Capability registry

Capabilities are **OPTIONAL** features, default off, with **no spec-v1 vectors** unless noted.
An implementation advertises which it supports; conformance is evaluated only over supported
capabilities.

| capability | default | status | effect |
|------------|---------|--------|--------|
| `includeOldValue=false` | on (oldValue present) | OPTIONAL — **landed** (§5.2) | suppress `oldValue` on all remove/replace (CORE §4.4.2); disables document-free invert |
| `emitMoves` | off | OPTIONAL — **landed** (§5.4) | emit RFC 6902 `move` for relocated elements; exact-order `unique`/`primaryKey` (GEN §8) |
| `wholesaleReplaceFallback` | off | OPTIONAL — **landed** (§5.5) | emit a single container `replace` when the granular patch would exceed the container's own serialized size (GEN §9) |
| `primaryKeyCandidates` | `["id","name","port"]` | OPTIONAL — **landed** (§5.3) | override the auto-detection candidate list (CORE §3.5.5) |
| `ignorePaths` | `[]` (none) | OPTIONAL — **landed** (§5.6) | a set of object-member JSON Pointers whose subtrees are treated as equal — no ops at or beneath them, in any strategy (GEN §10) |

`5.1` **Granular LCS descent (GEN §5.4.2) is NOT a capability** — it is normative default
behavior in `spec-v1`, landed in the compactness phase (F10). It is always on; there is no flag to
disable it. `spec-v1` conformance vectors are generated from this finalized behavior: a same-kind
(object↔object or array↔array) changed LCS element yields the granular nested ops descent emits,
while primitive or mismatched-kind replacements stay whole-item (GEN §5.4.2).

`5.2` **`includeOldValue` (F11).** Surfaced as the `JsonSchemaPatcher` constructor option
`includeOldValue?: boolean`, **default `true`** (back-compat: identical, byte-for-byte, to the
pre-capability output). When `false`, **every** `oldValue`-producing emission site is suppressed —
object-member removes/replaces (GEN §2), the type-mismatch/opaque-leaf replace (GEN §1.4), primaryKey
removals (GEN §4), LCS removals and whole-item replaces including the empty-window fast paths (GEN §5),
and unique removals/replaces (GEN §6). `add` ops are identical in both modes (they never carry
`oldValue`). Granular same-kind descent (GEN §5.4.2) recurses through the shared object/array differ,
so nested ops it emits also honor the flag. The flag changes **only** the presence of the
`oldValue` key; `op`, `path`, `value`, op ordering, and op count are unchanged. `invertPatch`
(CORE §6) is unaffected because it recovers pre-change values from the **original document** it is given,
not from `oldValue`; the round-trip identity CORE §6.1.2 holds under either mode. Measured savings on the
compactness repro shapes: 26–51% on typical remove/replace-heavy diffs, up to ~86x when a large
subtree is removed (a 2.7 KB removal drops from 2680 B to 31 B).

`5.4` **`emitMoves` (F22/F23/F07).** Surfaced as the `JsonSchemaPatcher` constructor option
`emitMoves?: boolean`, **default `false`** (byte-for-byte identical to the pre-capability output).
When `true`, all three array strategies route through the shared move machinery (GEN §8): a relocated
**deep-equal** element becomes a single RFC 6902 `move` instead of a remove+add pair, and the
`unique`/`primaryKey` strategies reconstruct `modified` **order exactly**. The one capability
defines three landings, each pinned in GEN §8: **LCS relocations** (GEN §8.5, F22 — a relocated ~596 B
item drops from 1279 B as remove+add to ~39 B as a move); **unique reorders** (GEN §8.6, F23 — a
50-element rotation drops from 4271 B as 50 replaces to ~40 B as one move); and **primaryKey order
fidelity** (GEN §8.7, F07 — survivors are reordered and insertions are INDEXED adds so the applied
result equals `modified` byte-exactly, upgrading CORE §7.2 to CORE §7.4). A `move` NEVER pairs non-identical
values (GEN §8.5). The pinned **LIS** tie-break (GEN §8.2) and right-to-left move emission (GEN §8.3) make
the emitted op sequence deterministic and Go-reproducible. `move` ops carry no `oldValue`;
`remove`/`replace` still honor `includeOldValue` (CORE §4.4.2), and `emitMoves` composes with it. The
apply layer (CORE §5.3) already supports `move`, so emitted patches round-trip through both the reference
applier and any conforming RFC 6902 applier (verified against fast-json-patch).

`5.3` **`primaryKeyCandidates` (F25).** Surfaced as the `buildPlan` option
`primaryKeyCandidates?: string[]`, **default `["id", "name", "port"]`** (CORE §3.5.3/CORE §3.5.5 —
byte-for-byte identical plans when omitted). It replaces the ordered candidate list consulted by
primary-key auto-detection **wholesale** (no merge with the default). `[]` disables auto-detection
so every object array keeps its base strategy (`lcs`/`unique`). A `primaryKeyMap` entry is applied
before auto-detection and bypasses the candidate list, so it wins under any list, empty included
(CORE §3.5.3). Only strategy **selection** is affected; the diff/apply algorithms and every emitted op
are unchanged given the resulting plan.

`5.5` **`wholesaleReplaceFallback` (F24).** Surfaced as the `JsonSchemaPatcher` constructor
option `wholesaleReplaceFallback?: boolean`, **default `false`** (byte-for-byte identical to the
pre-capability output). When `true`, every array-diff call site (GEN §9) buffers its would-be op list,
applies the pinned byte estimate (GEN §9.2), and — if the estimate exceeds the array's own serialized
size (GEN §9.3) — discards it in favor of a single whole-array `replace`. Measured on the audit's
12-item/~7.2 KB complete-rewrite repro shape (every element's LCS-comparable fields differ, so
Myers finds no common elements and the granular stream is a full remove-all + add-all): the
`includeOldValue:false` granular stream is well over 2x the array's own bytes, while the wholesale
replace is capped at exactly the new array's bytes (plus the fixed op envelope); the decision is
strict — a small diff's estimate (typically a few touched fields) stays far under the whole array's
own size and never triggers. Composes with `emitMoves` (the estimate is computed on the
moves-emitted stream, GEN §9.5) and with `includeOldValue` (governs whether the wholesale replace
itself carries `oldValue`, and is folded into the estimate for the discarded stream via GEN §9.2).

`5.6` **`ignorePaths` (wI2L/jsondiff parity).** Surfaced as the `JsonSchemaPatcher` constructor
option `ignorePaths?: string[]` (TS — an invalid pointer throws a `TypeError` at construction) and as
the `IgnorePaths(...)` `PatcherOption` (Go — an invalid pointer makes `NewPatcher` return a non-nil
`error`), **default empty** (byte-for-byte identical to the pre-capability output; an empty/absent set
threads no ignore node, GEN §10.2). Each pointer addresses **object-member** locations (validated per
GEN §10.1: leading `/`, no `""`/root, no array-index or `-` segment, `*` allowed); the compiled ignore
trie (GEN §10.2) is threaded in parallel with the plan trie and marks matched subtrees **equal in both
directions** — **no** ops at or beneath them in any strategy (GEN §10.3–GEN §10.4), including inside keyed
(GEN §4) and LCS (GEN §5) array items via the transparent array-level wildcard (`/users/*/updatedAt`
ignores every user's `updatedAt`). Interactions are pinned: LCS interning is ignore-filtered so two
items differing only in ignored fields are `common`/`move`-pairable, not remove+add (GEN §10.5);
`wholesaleReplaceFallback` is **disabled** for any array with an ignore terminal beneath it, so ignored
content can never leak through an ancestor's wholesale replace (GEN §10.6); and a plan's `primaryKey`
field is **not ignorable** — an ignore entry covering it fails construction (GEN §10.7). Round-trip
contracts (CORE §7) hold **modulo the ignored subtrees** (CORE §7.6). Because construction-time validation errors
are not expressible in the diff/apply/plan/invert vector wire formats (they precede any diff), they are
covered by unit tests in both engines rather than by vectors (§6.2); the happy-path and interaction
behaviors ARE covered by diff vectors and the differential corpus.

## 6. Vector provenance

Vectors SHOULD be harvested from the reference test suite and from randomized fuzzing (the
primaryKey contract CORE §7.2 was pinned at 500/500 trials; LCS exactness at 800/800; invert at
300/300). New vectors for schema-derived plan corners (CORE §3) SHOULD be authored by hand, since the
existing suite under-covers plan derivation.

`6.1` **primaryKey gate coverage (REQUIRED).** The vector suite MUST include at least one diff
vector for **each** GEN §4.3 gate-failure class, each asserting the `lcs` **fallback** (exact
reconstruction, CORE §7.1) rather than keyed emission: (a) an array element that is **not an object**;
(b) an element whose primaryKey value is **missing, `null`, or not a string/number**; and (c) a
**duplicate** primaryKey value within `original` **or** within `modified`. A `primaryKeyMap`
override (CORE §3.4.3) MUST NOT bypass the gate — a gate-failing override case SHOULD also be covered.

`6.2` **`ignorePaths` construction-error coverage (REQUIRED, engine-local).** The GEN §10.1/GEN §10.7
construction-time validation errors — an array-index or `-` segment, a rootless/empty pointer, and an
ignore entry covering a plan `primaryKey` field — occur **before any diff runs**, so they are not
expressible in the diff/apply/plan/invert vector wire formats (which encode only a document pair or a
patch, never a constructor rejection). Each engine MUST therefore cover them with **unit tests**
(`test/ignore-paths.test.ts` in TS, `ignore_paths_test.go` in Go), asserting the same rejection set.
The happy-path and interaction semantics (GEN §10.3–GEN §10.6) ARE vector-covered (`diff/capabilities-ignore-paths`)
and exercised differentially (`spec/fuzz/corpus/ignore-*.jsonl`).

## 7. Plan-snapshot vector format (normative)

To make CORE §3 plan derivation falsifiable independently of any diff, a **plan-snapshot vector** is a
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

`7.1` The implementation under test computes `buildPlan(schema, options)` and compares the
resulting `documentPath → ArrayPlan` map against `expectedPlan`: the **set of paths** must match,
and for each path the `primaryKey`, `strategy`, `requiredFields` (as a sorted string array), and
`hashFields` (as a sorted string array) must match. `itemSchema` (CORE §3.1.1) is **never** compared.
Both the entry list and the two field arrays are compared **order-insensitively** (by sorting);
the `expectedPlan` array is authored sorted by `path` for readability. This format makes the CORE §3
derivation — including CORE §3.1.1 (which fields are output-relevant) and CORE §3.7.4 (metadata merge /
`hashFields`) — directly falsifiable.

## 8. Invert vector format (normative)

To make CORE §6 inversion falsifiable independently of the diff generator, an **invert vector** is a
JSON record:

```
{
  "name":            string,          // unique id
  "comment":         string,          // optional human note / spec citation
  "document":        JsonValue,       // the ORIGINAL (pre-patch) document (CORE §6.1.1)
  "patch":           Operation[],     // the forward patch to invert
  "expectedInverse": Operation[]      // the op list invertPatch(document, patch) MUST produce
}
```

`8.1` `document` is the **ORIGINAL** (pre-patch) document, exactly as CORE §6.1.1 requires: it is
the document `patch` was generated from (and applies cleanly to), and `invertPatch` resolves `/-`
append paths to concrete indices and recovers overwritten/removed values against it (CORE §6.1.1,
CORE §6.2). `patch` MUST apply cleanly to `document` (CORE §6.1.2); a `patch` that does not is not a valid
invert vector.

`8.2` **Conformance rule.** An invert vector **passes** iff **both** hold:

- **(a) Structural inverse equality.** `invertPatch(document, patch)` is **structurally equal** to
  `expectedInverse` — same length and the same ordered sequence of ops, each op equal by `op`,
  `path` (as a string), and — where present — `value`/`oldValue`/`from` under deep JSON equality
  (CORE §1.4.1). This is the identical structural op-equality relation the diff gate uses (§4.2),
  and it pins the exact inverse op sequence CORE §6.2 defines (forward-simulated, then reversed).
- **(b) Double-apply identity.** `applyPatch(applyPatch(document, patch), expectedInverse)`
  **deep-equals `document`** (CORE §1.4.1), evaluated through the reference apply semantics (CORE §5) under
  strict sequential application (CORE §5.1). This is the round-trip guarantee of CORE §6.1.2 / CORE §7.3.1.

`8.3` Both clauses are REQUIRED and use the same terminology as CORE §6: clause (a) pins the exact
inverse op list `invertPatch` produces (the ordering and per-op fields of CORE §6.2), while clause (b)
is the semantic round-trip `invertPatch` guarantees against the forward-applied state (CORE §6.1.2).
Because the inverse is computed against the ORIGINAL `document` (CORE §6.1.1), clause (b) is asserted
against that same `document`, not against an arbitrary document that merely deep-equals it up to
array order (CORE §6.1.2).
