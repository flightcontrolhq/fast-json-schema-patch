# Conformance vectors

Language-agnostic test vectors for the `spec-v1` contract in
[`SPEC.md`](../../SPEC.md). They exist so a **second implementation** (the
planned Go engine) can be validated against the TypeScript reference from the
spec plus these vectors **alone** — every vector is self-describing, cites its
governing spec section, and is checked by a normative gate (below).

`SPEC.md` is the normative source. Where this README paraphrases it, the spec
wins.

## Layout

```
spec/vectors/
  generate.ts     # the deterministic generator (source of truth; see "Regenerating")
  README.md       # this file
  diff/*.json     # CONF §2  diff vectors            (buildPlan + execute -> expectedPatch)
  apply/*.json    # CONF §3  apply vectors           (applyPatch -> expected | error)
  plan/*.json     # CONF §7  plan-snapshot vectors   (buildPlan -> expectedPlan)
  invert/*.json   # CONF §8  invert vectors          (invertPatch -> expectedInverse)
```

Each `*.json` file is a flat **array of vector records** grouped by theme (the
filename names the theme, e.g. `diff/primary-key-gate.json`). Every record has a
**unique `name`** (unique across the whole suite) and a one-line `comment`
stating what it pins and citing its spec section.

### Counts (this revision)

| category | vectors | files |
|----------|--------:|------:|
| diff     | 215     | 25    |
| apply    | 93      | 11    |
| plan     | 33      | 3     |
| invert   | 28      | 3     |
| **total**| **369** | **42**|

Seven of these (one diff, six apply) are the **spec-v1-rc external-review defect round**
(D1/D2/D4): `diff/kind-mismatch.json`, `apply/malformed-pointer.json`,
`apply/test-required-value.json`. They pin the **corrected** behavior for defects the
external review found in the reference engines; the engine fixes have landed, so they are
derived/self-checked against the (fixed) reference like every other vector.

#### spec-v2 declared-topology groups (CONF §6.3)

54 vectors cover the declared semantic topology model (CORE §8, the
`x-schema-patch-*` extensions). Each is an ordinary vector whose **`schema`
carries the extensions** — no new wire field (CONF §2.2). Construction-time
errors (CORE §8.2.3) precede any diff and live in the engines' unit tests
(`test/topology.test.ts`, `go/topology_test.go`), not here.

| group | file | vectors |
|-------|------|--------:|
| set membership (value identity) | `diff/topology-set.json` | 6 |
| composite-key map, order insignificant | `diff/topology-map-composite.json` | 5 |
| order-significant map (moves normative) | `diff/topology-map-ordered.json` | 4 |
| atomic array | `diff/topology-atomic.json` | 5 |
| atomic object | `diff/topology-object-atomic.json` | 4 |
| declared topology beats auto-detect/`primaryKeyMap` | `diff/topology-overrides.json` | 4 |
| gate failure → `sequence`/LCS fallback | `diff/topology-gate-fallbacks.json` | 8 |
| compat equivalence (declared == spec-v1 output) | `diff/profile-equivalence.json` | 8 |
| topology plan snapshots | `plan/topology-plan.json` | 10 |

Every **spec-v1** (extension-free) vector is unchanged byte-for-byte — the
primary guard that spec-v2 changed no default output (CORE §8.8, CONF §6.3f).

## Vector record formats

### diff (`diff/`, CONF §2)

```jsonc
{
  "name": "pk-worked-example",
  "comment": "GEN §4.2: the normative worked example ...",
  "schema": { /* JSON Schema */ },          // OMITTED when the diff runs schemaless (empty plan)
  "options": {                               // OMITTED when empty
    "primaryKeyMap":        { "/path": "key" },
    "basePath":             "/config",
    "primaryKeyCandidates": ["sku"],
    "capabilities": { "includeOldValue": false, "emitMoves": true, "wholesaleReplaceFallback": true, "ignorePaths": ["/users/*/updatedAt"] }
  },
  "original": <JsonValue>,
  "modified": <JsonValue>,
  "expectedPatch": [ /* Operation[] in default capability mode unless options.capabilities says otherwise */ ]
}
```

`primaryKeyMap`, `basePath`, `primaryKeyCandidates` are **`buildPlan` options**
(CORE §3.2, CORE §3.5.5); `options.capabilities` are **`JsonSchemaPatcher` constructor
options** (CONF §5). All are omitted when at their default, so a plain vector is
`{name, comment, original, modified, expectedPatch}` with an empty plan.

To run a diff vector: build the plan (empty when `schema` is absent), construct
the patcher with the given capabilities, `execute({original, modified})`, and
compare against `expectedPatch` per the gate (CONF §4, below).

**spec-v2 topologies** are declared **inside `schema`** via `x-schema-patch-*`
extensions on the relevant array/object nodes (CORE §8.2) — a topology vector is
an ordinary diff vector, no extra field (CONF §2.2). `BuildPlan` parses the
extensions, so the same build-plan-then-execute path runs unchanged.

### apply (`apply/`, CONF §3)

```jsonc
{
  "name": "a9-test-failure",
  "comment": "RFC 6902 A.9: a failing test throws TEST_FAILED",
  "doc":   <JsonValue>,
  "patch": [ /* Operation[] — may include copy/test/move and the oldValue extension */ ],
  "options": { "validateOldValues": true },  // OMITTED when empty
  // EXACTLY ONE of:
  "expected": <JsonValue>,                    // applyPatch(doc, patch, options) MUST deep-equal this
  "error":    { "code": "<PatchErrorCode>", "index": <number> }  // OR apply MUST throw this
}
```

Apply vectors are the only **hand-authored** oracle (the applier is the thing
under test). The generator re-runs the reference applier against each one as a
self-check, so a regenerated suite is also a reference-applier conformance run.

### plan-snapshot (`plan/`, CONF §7)

```jsonc
{
  "name": "plan-nested-arrays-distinct-paths",
  "comment": "CORE §3.3.5: ...",
  "schema":  { /* JSON Schema, REQUIRED */ },
  "options": { "primaryKeyMap": {...}, "basePath": "...", "primaryKeyCandidates": [...] },  // OMITTED when empty
  "expectedPlan": [                            // sorted by `path`
    { "path": "/matrix",   "primaryKey": null, "strategy": "lcs",        "requiredFields": [], "hashFields": [] },
    { "path": "/matrix/*", "primaryKey": "id", "strategy": "primaryKey", "requiredFields": ["id"], "hashFields": ["id"] },
    // spec-v2: an array entry declaring a topology adds topology / keys (map, DECLARED order) / order (map):
    { "path": "/ports",    "primaryKey": "containerPort", "strategy": "primaryKey", "requiredFields": [], "hashFields": [],
      "topology": "map", "keys": ["containerPort", "protocol"], "order": "insignificant" },
    // spec-v2: a declared-ATOMIC object is a distinct entry shape — just path + granularity:
    { "path": "/settings", "granularity": "atomic" },
    // spec-v2: a recursion alias (CORE §3.3.7) — alias-only entries are just path + recurseTo:
    { "path": "/steps/parallel", "recurseTo": "/steps" }
  ]
}
```

`buildPlan(schema, options)` MUST produce, for the same **set of paths**, the
same `primaryKey`, `strategy`, `requiredFields` and `hashFields`. `itemSchema`
(CORE §3.1.1) is **never** compared. The entry list and both field arrays are
compared **order-insensitively** (they are authored sorted for readability).

**spec-v2 fields (CONF §7.2), present iff the node declares a topology:**
`topology` (array) and `granularity` (object) match **exactly**; `order` (map)
matches exactly (a `map` entry omitting it means `"insignificant"`); `keys` (map)
is compared **ORDER-SENSITIVELY** — unlike `requiredFields`/`hashFields` — because
the declared tuple order is significant to identity (CORE §8.4.3). An `atomic`
node **prunes its subtree**: a plan MUST NOT contain any entry for a path beneath
it (CORE §8.3.3).

**Recursion aliases (CONF §7.3, CORE §3.3.7):** `recurseTo` is compared by
presence and value (`""` — the document root — is a valid, present anchor). An
alias-only entry is exactly `{ path, recurseTo }`; a real array entry may carry
`recurseTo` alongside its ordinary fields.

### invert (`invert/`, CONF §8)

```jsonc
{
  "name": "inv-move-overwrite-member",
  "comment": "CORE §6.2: ...",
  "document": <JsonValue>,   // the ORIGINAL (pre-patch) document (CORE §6.1.1); patch MUST apply cleanly to it
  "patch":    [ /* Operation[] */ ],
  "expectedInverse": [ /* Operation[] that invertPatch(document, patch) MUST produce */ ]
}
```

## The conformance gates (normative)

A vector **passes** iff its category's gate holds. These restate CONF; the
spec is authoritative.

- **diff (CONF §4).** Both must hold:
  1. **Round-trip (CONF §4.1).** Applying `expectedPatch` sequentially (CORE §5) to
     `original` reproduces `modified` per the strategy's round-trip contract
     (CORE §7, per-topology summary CORE §8.9): **exact** deep-equality for LCS /
     unique / object-only / `sequence` / `atomic` / order-significant `map` /
     `emitMoves` / `wholesaleReplaceFallback`; **multiset-equal** (survivors in
     original order ++ tail appends) for default-mode `primaryKey` and
     `map`/insignificant; **content/multiset-equal** (order insignificant) for
     `set` (CORE §8.5.4). Runners derive which contract applies **from the plan**
     (topology + strategy), not from a wire field. For `ignorePaths`
     vectors the reconstruction is exact **modulo the ignored subtrees** (CORE §7.6),
     so runners skip the whole-document round-trip and rely on gate 2 plus the
     differential corpus (`spec/fuzz`).
  2. **Structural op equality (CONF §4.2).** The emitted op sequence equals
     `expectedPatch`: same length, same **ordered** sequence, each op equal by
     `op`, `path` (string), and — where present — `value` / `oldValue` / `from`
     under deep JSON equality (CORE §1.4.1).
  Byte-identity of serialized JSON is **not** required (CONF §4.3): number *text*,
  object-key *order within values*, and whitespace are insignificant. Op
  **ordering in the sequence is significant.**
- **apply (CONF §3.1).** For an `error` vector, apply MUST throw `JsonPatchError`
  with `code === error.code` and `operationIndex === error.index`. For an
  `expected` vector, the result MUST deep-equal `expected` (CORE §1.4.1) and MUST NOT
  throw.
- **plan (CONF §7.1/§7.2).** Path set matches; per path, `primaryKey` / `strategy` /
  `requiredFields` / `hashFields` match (field arrays order-insensitively), and —
  where declared — `topology` / `granularity` / `order` match exactly and `keys`
  matches **order-sensitively**.
- **invert (CONF §8.2).** Both must hold: **(a)** `invertPatch(document, patch)`
  is structurally equal to `expectedInverse` (same relation as CONF §4.2); **(b)**
  `applyPatch(applyPatch(document, patch), expectedInverse)` deep-equals
  `document` (CORE §6.1.2).

A conforming generator MUST pass every default-mode diff vector; a conforming
applier MUST pass every apply vector for the ops it supports (CONF §4.4).
Capability-tagged diff vectors (`options.capabilities`) are evaluated **only**
for implementations that advertise the capability (CONF §5).

## Regenerating

The vectors are produced by [`generate.ts`](./generate.ts), which imports the
TypeScript reference (`../../src`) and runs it to compute every `expectedPatch`
(diff), `expectedPlan` (plan) and `expectedInverse` (invert). Apply
`expected`/`error` outcomes are hand-authored and re-verified against the
reference applier on each run.

```sh
bun run spec/vectors/generate.ts
```

- **Deterministic.** No randomness anywhere. Plan entries and field arrays are
  sorted; JSON is emitted with a fixed 2-space indent and a fixed record-field
  order. Re-running is **byte-identical** — a `git diff` after regeneration
  should be empty unless the reference behavior changed.
- **Self-checking.** The generator verifies each vector as it writes it
  (round-trip for diff, double-apply identity for invert, oracle match for
  apply); a malformed vector aborts the run. A clean run is itself a conformance
  check of the reference against CORE §7 / CORE §6 / CONF.

If the reference implementation changes an **intended** output, regenerate and
commit the vector diff alongside the code change. An **unintended** change shows
up as a vector diff on a run where none was expected — treat that as a
regression.

## Cross-language caveats (flagged for the Go gate)

These are limits of the JSON vector medium, not of the spec. A second
implementation must handle them out of band:

1. **Object key order is load-bearing but not JSON-guaranteed.** The generator's
   op **ordering** follows each object's **pinned member order** (CORE §1.3.2,
   GEN §2.2): ECMAScript `[[OwnPropertyKeys]]` — **integer-like keys first in
   ascending numeric order, then all remaining keys in insertion order**, where
   integer-like means a canonical decimal string for `0 … 2^32 − 2` (no leading
   zeros, no sign; `"2"` is integer-like, `"02"` is not). This is **not** pure
   insertion order: an object authored `{b, "10", "2", a}` is visited as
   `"2", "10", b, a`. The vector files preserve the authored key order, but a
   consumer whose JSON decoder does not preserve object key order (e.g. Go
   `map[string]any`) will reorder members and can emit ops in a different order,
   failing the CONF §4.2 ordering check. Read the vectors with an **order-
   preserving** decoder **and** re-apply the integer-like-first rule to match the
   pinned order (CORE §1.3.2).
2. **`-0` and `1.0` are not representable in JSON text.** `-0` serializes as `0`
   and `1.0` as `1`, so the "equal number" vectors (`num-neg-zero-vs-zero-equal`,
   `num-1-vs-1.0-equal`) degenerate to `0`-vs-`0` / `1`-vs-`1` in the file. They
   still pin the correct behavior (equal → no ops); the *distinctness* of the
   source text simply cannot be carried by the medium.
3. **Integers past 2^53 encode the f64 image.** `expectedPatch` `value`/
   `oldValue` reflect the reference's f64 computation (e.g. `2^53` and `2^53+1`
   are equal → no op). A language with wider integers MUST still compare at f64
   (CORE §1.2.3); if it preserves number *text* when echoing values, the differing
   text is explicitly **not** a gate failure (CONF §4.3).
4. **Structural sharing / reference identity is not a vector.** CORE §5.7.1 copy-on-
   write sharing and `===` identity of untouched subtrees are unobservable
   across languages and are intentionally **not** asserted. The behavioral
   options (`cloneValues`/`cloneResult`) are covered only by **value** equality
   (`apply/options.json`), per CORE §5.7.4.
5. **Capabilities are opt-in.** `emitMoves`, `wholesaleReplaceFallback`,
   `includeOldValue=false`, and `ignorePaths` vectors carry
   `options.capabilities`. An implementation that does not advertise a capability
   skips its vectors (CONF §5); the default suite (no `capabilities`) is mandatory.
   `ignorePaths` **construction-time** validation errors (GEN §10.1/GEN §10.7) precede
   any diff and are not vector-expressible — they are covered by engine unit tests
   (CONF §6.2).
