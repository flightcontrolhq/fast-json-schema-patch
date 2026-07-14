# fast-json-schema-patch — Rationale & history (RATIONALE)

**Spec version:** `spec-v1-rc`  ·  part of the four-document specification (see [`SPEC.md`](../SPEC.md)).

> **This entire document is NON-NORMATIVE.** Nothing here defines conforming behavior. It
> records the audit history (the F-number fixes), the external-review defect round (D1–D7),
> performance measurements, design rationale, known-limitation notes, and a complete
> old-section → new-section mapping table so every existing §-citation can be traced. The
> normative documents are [CORE](01-core-semantics.md), [GEN](02-generator-profile.md), and
> [CONF](03-conformance.md).

---

## 1. External-review defect round (D1–D7)

The spec was reopened from *Final* to *Release Candidate* on 2026-07-14 after an external
review found seven real defects (D1–D7) in the reference implementations. The corrected
behavior is pinned normatively in the documents cited below; this narrative is historical.

- **Release-candidate status (2026-07-14).** An external review found seven real defects
  (D1–D7) in the reference implementations — the TS differ's empty-container equality
  (D1, CORE §1.4.1/GEN §5.0), TS apply accepting a leading-`/`-less pointer as the root (D2, CORE §2.7),
  a stale non-epoch-scoped path cache (D3), `test` accepting a missing `value` (D4, CORE §5.3),
  and Go-side plan aliasing, non-finite numbers, and per-op re-cloning (D5–D7). The spec was
  reopened from *Final* to *Release Candidate* to pin the corrected behavior normatively
  (CORE §1.2.4 non-finite numbers, CORE §2.7 malformed pointer, CORE §5.3 `test` requiring `value`) and to
  add conformance vectors for it. `spec-v1` returns to *Final* once every engine passes the
  augmented suite.

---

## 2. Summary of spec-v1 fixes (contract vs. pre-audit HEAD)

`spec-v1` was finalized 2026-07-14 against reference implementation v0.4.0 after the P1–P4
phases. Every section below specifies the finalized (post-bugfix) semantics and is **landed** in
the reference; the "pre-audit HEAD" column records the behavior each fix replaced.

**Normative behavioral fixes (a Go implementer MUST reproduce these):**

| § | behavior specified | pre-audit HEAD state | phase (finding) |
|---|--------------------|----------------------|-----------------|
| CORE §1.1.2 | `Date`/`RegExp`/`Map`/class instances treated as opaque equality leaves | host-dependent / could recurse into non-JSON | P1 (F16) |
| CORE §1.4.4 | memoization/identity caches are output-neutral (no stale verdict after input mutation) | identity-keyed caches could leak a stale verdict across mutated inputs | P1 (F02) |
| CORE §3.1.1 | `itemSchema` is non-normative and no longer populated by `buildPlan` | write-only `itemSchema` pinned ~2x plan memory | P2 (F19) |
| CORE §3.3.1 | traverse nodes with `properties`/`items` even without `type` | gated on explicit `type` | P1 (F40) |
| CORE §3.3.4 | unsupported-`$ref` notice routed through caller-suppressible `onWarning` | wrote to `console.warn` unconditionally | P4 (F32) |
| CORE §3.3.5 | nested arrays get distinct plan paths (`${path}/*`) | inner plan clobbered outer at same key | P1 (F04) |
| CORE §3.5.1 | `allOf` item branches merged (union `properties`+`required`) for primary-key detection | `allOf` skipped; a key declared only in an `allOf` branch was not found | P1 (F35) |
| CORE §3.5.5 | `primaryKeyCandidates` overrides the auto-detection list; `[]` disables it | candidate list hardcoded `["id","name","port"]` | P3 (F25) |
| CORE §3.6.2 | `basePath` matches on segment boundary, slices by length | `startsWith`+`replace`, sibling-prefix / mid-segment bugs | P1 (F14) |
| GEN §2.2 | union-key visitation as two passes (output-equivalent to `Set` union) | `Set`-union allocation per object | P2 (F36) |
| GEN §4.3 | primaryKey gate + `lcs` fallback (non-conforming elements, duplicate keys) | silently skipped / corrupted the index | P1 (F05/F06) |
| GEN §4.5 | structural trie matching: wildcard reachable at **any** depth incl top-level `/*`; numeric object keys route by construction; no per-path caches | flat string lookup (exact / index-normalize / single trailing `*`) with four unbounded per-instance caches | P2 (F18/F33) |
| GEN §5.0 | common prefix/suffix trim before Myers (normative step 0) | no trim; Myers ran on the whole array | P2 (F09) |
| GEN §5.4.2 | granular LCS descent into same-kind changed items | whole-item replace always | P3 (F10) |
| GEN §6 | `unique` is equal-length positional replaces only | dead removal/addition phase behind the equal-length gate | P3 (F38) |
| GEN §8 | `emitMoves` capability: LCS relocations, `unique`/`primaryKey` exact-order via `move`s | no move emission; primaryKey order-insensitive only | P3 (F22/F23/F07) |
| GEN §9 | `wholesaleReplaceFallback` capability: size-capped whole-array replace | none | P3 (F24) |
| CORE §4.1.1 | `emitMoves` carve-out: generator emits `move`/`from` only under the capability | spec claimed generator never emits `move`/`from` | P3 (spec finalization) |
| CORE §4.4.2 | `includeOldValue` capability suppresses `oldValue` | `oldValue` always emitted | P3 (F11) |

**Output-neutral performance fixes (CORE §1.4.4-governed; MUST NOT change any emitted patch):** the
Myers V-band-only storage (GEN §5.2, F08), window-element interning to integer ids (GEN §5.2,
F21/F34), skipping re-verification of proven-equal common elements (GEN §5.2/GEN §5.5, F20), per-diff
hoisting of plan fingerprint/hash fields (F37), loop-based emission of large op groups (F13), and
plan-trie compilation (GEN §4.5, F18) are all invisible to the wire format and need no separate
reproduction — a conforming implementation may use any output-neutral equivalent.

**Non-spec fixes (outside the specification's scope, CONF §1.5):** the `DiffOperation` type surface (F27),
plan validation in the `JsonSchemaPatcher` constructor (F42), the aggregator remove-fallback index
regex (F17), and packaging / CI / docs / test-hygiene work (F28, F30, F31, F39, F41) do not affect
diff, patch, apply, invert, or plan semantics and are not tabulated individually.

All other sections describe behavior already present before the audit (verified by probing: pointer
escaping in object diff, root-array-to-empty removals with `oldValue`, collision-free LCS cache
key, prototype-pollution guard, error codes, invert round-trip).


---

## 3. Known pinned limitations (reproduce for conformance)

- **B.1** A schema property whose name is literally `"*"` is indistinguishable from the wildcard
  (`additionalProperties`/nested-array-element) edge in the compiled plan trie, because `buildPlan`
  emits both as the segment `*`; the wildcard interpretation wins (GEN §4.5.1). This is a pinned edge
  case, not latitude. *(Former B.1/B.2/B.5 — deeper/​top-level `/*` unreachable and numeric-object-
  key mis-routing — are **resolved** by structural trie matching, GEN §4.5, P2 fixes F18/F33; former
  B.3 — `allOf` not merged — is **resolved** by CORE §3.5.1, P1 fix F35.)*
- **B.2** `unique` set-diff/move semantics are unspecified in spec-v1; unequal lengths fall back to
  LCS (GEN §6.2).

---

## 4. Deferred to a future spec version

- **"Remove last" array extension (CORE §2.5).** An OPTIONAL non-RFC token to remove the final array
  element without naming its index is **not part of spec-v1**: it is unimplemented in the reference
  and absent from the CONF §5 capability registry. It is deferred to a future spec version, where it
  would need its own pointer-syntax rule (CORE §2.5) and apply semantics (CORE §5.3).
- **`unique` set-diff / move semantics (GEN §6.2, §3.2).** spec-v1 leaves the unequal-length
  `unique` case as an `lcs` fallback and does not define set-difference or move semantics for the
  `unique` strategy; a future version MAY specify them.

---

## 5. Old-section → new-section mapping

Every numbered section and paragraph anchor of the former monolithic `SPEC.md` and its
mapping into the four documents. Deeper sub-citations (e.g. an old `§5.4.5.2`) follow the
same doc mapping as their parent. Short names: **CORE** = `01-core-semantics.md`, **GEN** =
`02-generator-profile.md`, **CONF** = `03-conformance.md`, **RATIONALE** =
`04-rationale.md`.

| old | new | title |
|-----|-----|-------|
| §1 | CONF §1 | Scope, audience, and versioning |
| §1.1 | CONF §1.1 | Purpose |
| §1.2 | CONF §1.2 | Audience |
| §1.3 | CONF §1.3 | Spec versioning and stability |
| §1.4 | CONF §1.4 | Conformance language (RFC 2119) |
| §1.5 | CONF §1.5 | Out of scope |
| §2 | CORE §1 | Data model |
| §2.1 | CORE §1.1 | JSON values |
| §2.1.1 | CORE §1.1.1 |  |
| §2.1.2 | CORE §1.1.2 |  |
| §2.1.3 | CORE §1.1.3 |  |
| §2.2 | CORE §1.2 | Number semantics |
| §2.2.1 | CORE §1.2.1 |  |
| §2.2.2 | CORE §1.2.2 |  |
| §2.2.3 | CORE §1.2.3 |  |
| §2.2.4 | CORE §1.2.4 |  |
| §2.3 | CORE §1.3 | Object key order |
| §2.3.1 | CORE §1.3.1 |  |
| §2.3.2 | CORE §1.3.2 |  |
| §2.4 | CORE §1.4 | Equality |
| §2.4.1 | CORE §1.4.1 |  |
| §2.4.2 | CORE §1.4.2 |  |
| §2.4.3 | CORE §1.4.3 |  |
| §2.4.4 | CORE §1.4.4 |  |
| §3 | CORE §2 | JSON Pointer usage (RFC 6901) |
| §3.1 | CORE §2.1 |  |
| §3.2 | CORE §2.2 |  |
| §3.3 | CORE §2.3 |  |
| §3.4 | CORE §2.4 |  |
| §3.5 | CORE §2.5 |  |
| §3.6 | CORE §2.6 |  |
| §3.7 | CORE §2.7 |  |
| §4 | CORE §3 | Plan model |
| §4.1 | CORE §3.1 | Types |
| §4.1.1 | CORE §3.1.1 |  |
| §4.2 | CORE §3.2 | `buildPlan` inputs |
| §4.3 | CORE §3.3 | Schema traversal |
| §4.3.1 | CORE §3.3.1 |  |
| §4.3.2 | CORE §3.3.2 |  |
| §4.3.3 | CORE §3.3.3 |  |
| §4.3.4 | CORE §3.3.4 |  |
| §4.3.5 | CORE §3.3.5 |  |
| §4.3.6 | CORE §3.3.6 |  |
| §4.4 | CORE §3.4 | Constructing an ArrayPlan |
| §4.4.1 | CORE §3.4.1 |  |
| §4.4.2 | CORE §3.4.2 |  |
| §4.4.3 | CORE §3.4.3 |  |
| §4.4.4 | CORE §3.4.4 |  |
| §4.5 | CORE §3.5 | Primary-key auto-detection |
| §4.5.1 | CORE §3.5.1 |  |
| §4.5.1.1 | CORE §3.5.1.1 |  |
| §4.5.2 | CORE §3.5.2 |  |
| §4.5.3 | CORE §3.5.3 |  |
| §4.5.4 | CORE §3.5.4 |  |
| §4.5.5 | CORE §3.5.5 |  |
| §4.6 | CORE §3.6 | `basePath` |
| §4.6.1 | CORE §3.6.1 |  |
| §4.6.2 | CORE §3.6.2 |  |
| §4.7 | CORE §3.7 | Strategy ranking and plan merge |
| §4.7.1 | CORE §3.7.1 |  |
| §4.7.2 | CORE §3.7.2 |  |
| §4.7.3 | CORE §3.7.3 |  |
| §4.7.4 | CORE §3.7.4 |  |
| §5 | GEN | Diff algorithm |
| §5.1 | GEN §1 | Dispatch (`diff(a, b, path)`) |
| §5.1.1 | GEN §1.1 |  |
| §5.1.2 | GEN §1.2 |  |
| §5.1.3 | GEN §1.3 |  |
| §5.1.4 | GEN §1.4 |  |
| §5.1.5 | GEN §1.5 |  |
| §5.1.6 | GEN §1.6 |  |
| §5.2 | GEN §2 | Object diff |
| §5.2.1 | GEN §2.1 |  |
| §5.2.2 | GEN §2.2 |  |
| §5.2.3 | GEN §2.3 |  |
| §5.3 | GEN §3 | Array diff dispatch |
| §5.3.1 | GEN §3.1 |  |
| §5.3.2 | GEN §3.2 |  |
| §5.3.3 | GEN §3.3 |  |
| §5.4 | GEN §4 | primaryKey strategy |
| §5.4.1 | GEN §4.1 | Normative three-phase emission |
| §5.4.1.1 | GEN §4.1.1 |  |
| §5.4.1.2 | GEN §4.1.2 |  |
| §5.4.1.3 | GEN §4.1.3 |  |
| §5.4.1.4 | GEN §4.1.4 |  |
| §5.4.1.5 | GEN §4.1.5 |  |
| §5.4.2 | GEN §4.2 | Worked example |
| §5.4.3 | GEN §4.3 | Applicability gate and fallback |
| §5.4.4 | GEN §4.4 | `checkArraysUnique` (gate for `unique`) |
| §5.4.5 | GEN §4.5 | Plan lookup by structural trie matching *(matching algorithm — normative for strategy selection)* |
| §5.4.5.1 | GEN §4.5.1 |  |
| §5.4.5.2 | GEN §4.5.2 |  |
| §5.4.5.3 | GEN §4.5.3 |  |
| §5.4.6 | GEN §4.6 | Hash-field prefilter (non-normative) |
| §5.5 | GEN §5 | LCS strategy (default) |
| §5.5.0 | GEN §5.0 | Common prefix/suffix trimming (normative step 0) |
| §5.5.0.1 | GEN §5.0.1 |  |
| §5.5.0.2 | GEN §5.0.2 |  |
| §5.5.0.3 | GEN §5.0.3 |  |
| §5.5.1 | GEN §5.1 | Empty-array fast paths |
| §5.5.2 | GEN §5.2 | Myers forward pass and tie-break (pinned) |
| §5.5.3 | GEN §5.3 | Backtracking and the edit script |
| §5.5.4 | GEN §5.4 | Replace collapse and granular descent |
| §5.5.4.1 | GEN §5.4.1 |  |
| §5.5.4.2 | GEN §5.4.2 |  |
| §5.5.5 | GEN §5.5 | Emission from the script |
| §5.6 | GEN §6 | unique strategy |
| §5.6.1 | GEN §6.1 |  |
| §5.6.2 | GEN §6.2 |  |
| §5.6.3 | GEN §6.3 |  |
| §5.7 | GEN §7 | Emission-order guarantees (normative) |
| §5.7.1 | GEN §7.1 |  |
| §5.7.2 | GEN §7.2 |  |
| §5.7.3 | GEN §7.3 |  |
| §5.8 | GEN §8 | `emitMoves` capability (normative when enabled) |
| §5.8.1 | GEN §8.1 |  |
| §5.8.2 | GEN §8.2 |  |
| §5.8.3 | GEN §8.3 |  |
| §5.8.4 | GEN §8.4 |  |
| §5.8.5 | GEN §8.5 |  |
| §5.8.6 | GEN §8.6 |  |
| §5.8.7 | GEN §8.7 |  |
| §5.9 | GEN §9 | `wholesaleReplaceFallback` capability (normative when enabled) |
| §5.9.1 | GEN §9.1 |  |
| §5.9.2 | GEN §9.2 |  |
| §5.9.3 | GEN §9.3 |  |
| §5.9.4 | GEN §9.4 |  |
| §5.9.5 | GEN §9.5 |  |
| §5.10 | GEN §10 | `ignorePaths` capability (normative when enabled) |
| §5.10.1 | GEN §10.1 |  |
| §5.10.2 | GEN §10.2 |  |
| §5.10.3 | GEN §10.3 |  |
| §5.10.4 | GEN §10.4 |  |
| §5.10.5 | GEN §10.5 |  |
| §5.10.6 | GEN §10.6 |  |
| §5.10.7 | GEN §10.7 |  |
| §5.10.8 | GEN §10.8 |  |
| §6 | CORE §4 | Patch format |
| §6.1 | CORE §4.1 | Operation object |
| §6.1.1 | CORE §4.1.1 |  |
| §6.2 | CORE §4.2 | RFC 6902 conformance |
| §6.2.1 | CORE §4.2.1 |  |
| §6.3 | CORE §4.3 | Guaranteed fields per op |
| §6.3.1 | CORE §4.3.1 |  |
| §6.3.2 | CORE §4.3.2 |  |
| §6.3.3 | CORE §4.3.3 |  |
| §6.4 | CORE §4.4 | `oldValue` extension |
| §6.4.1 | CORE §4.4.1 |  |
| §6.4.2 | CORE §4.4.2 |  |
| §6.4.3 | CORE §4.4.3 |  |
| §7 | CORE §7 | Round-trip contracts |
| §7.1 | CORE §7.1 | LCS and unique: exact reconstruction |
| §7.1.1 | CORE §7.1.1 |  |
| §7.1.2 | CORE §7.1.2 |  |
| §7.1.3 | CORE §7.1.3 |  |
| §7.2 | CORE §7.2 | primaryKey: keyed-collection contract |
| §7.2.1 | CORE §7.2.1 |  |
| §7.2.2 | CORE §7.2.2 |  |
| §7.2.3 | CORE §7.2.3 |  |
| §7.2.4 | CORE §7.2.4 |  |
| §7.2.5 | CORE §7.2.5 |  |
| §7.2.6 | CORE §7.2.6 |  |
| §7.3 | CORE §7.3 | Invert round-trip |
| §7.3.1 | CORE §7.3.1 |  |
| §7.4 | CORE §7.4 | `emitMoves`: exact reconstruction across all strategies |
| §7.4.1 | CORE §7.4.1 |  |
| §7.4.2 | CORE §7.4.2 |  |
| §7.4.3 | CORE §7.4.3 |  |
| §7.5 | CORE §7.5 | `wholesaleReplaceFallback`: size-capped reconstruction |
| §7.5.1 | CORE §7.5.1 |  |
| §7.6 | CORE §7.6 | `ignorePaths`: reconstruction modulo ignored subtrees |
| §7.6.1 | CORE §7.6.1 |  |
| §8 | CORE §5 | Apply semantics |
| §8.1 | CORE §5.1 | Sequential, atomic application |
| §8.1.1 | CORE §5.1.1 |  |
| §8.1.2 | CORE §5.1.2 |  |
| §8.1.3 | CORE §5.1.3 |  |
| §8.2 | CORE §5.2 | Path resolution |
| §8.2.1 | CORE §5.2.1 |  |
| §8.2.2 | CORE §5.2.2 |  |
| §8.2.3 | CORE §5.2.3 |  |
| §8.3 | CORE §5.3 | Per-op behavior |
| §8.3.1 | CORE §5.3.1 |  |
| §8.3.2 | CORE §5.3.2 |  |
| §8.3.3 | CORE §5.3.3 |  |
| §8.3.4 | CORE §5.3.4 |  |
| §8.3.5 | CORE §5.3.5 |  |
| §8.4 | CORE §5.4 | `oldValue` validation |
| §8.4.1 | CORE §5.4.1 |  |
| §8.4.2 | CORE §5.4.2 |  |
| §8.5 | CORE §5.5 | Root operations |
| §8.5.1 | CORE §5.5.1 |  |
| §8.5.2 | CORE §5.5.2 |  |
| §8.6 | CORE §5.6 | Error codes |
| §8.6.1 | CORE §5.6.1 |  |
| §8.6.2 | CORE §5.6.2 |  |
| §8.7 | CORE §5.7 | Behavioral options (not part of the wire format) |
| §8.7.1 | CORE §5.7.1 |  |
| §8.7.2 | CORE §5.7.2 |  |
| §8.7.3 | CORE §5.7.3 |  |
| §8.7.4 | CORE §5.7.4 |  |
| §8.7.5 | CORE §5.7.5 |  |
| §9 | CORE §6 | Invert semantics |
| §9.1 | CORE §6.1 | Contract |
| §9.1.1 | CORE §6.1.1 |  |
| §9.1.2 | CORE §6.1.2 |  |
| §9.2 | CORE §6.2 | Inversion rules (forward-simulated) |
| §9.2.1 | CORE §6.2.1 |  |
| §9.2.2 | CORE §6.2.2 |  |
| §10 | CONF | Conformance |
| §10.1 | CONF §2 | Diff vector format |
| §10.1.1 | CONF §2.1 |  |
| §10.2 | CONF §3 | Apply vector format |
| §10.2.1 | CONF §3.1 |  |
| §10.3 | CONF §4 | The conformance gate (normative) |
| §10.3.1 | CONF §4.1 |  |
| §10.3.2 | CONF §4.2 |  |
| §10.3.3 | CONF §4.3 |  |
| §10.3.4 | CONF §4.4 |  |
| §10.4 | CONF §5 | Capability registry |
| §10.4.1 | CONF §5.1 |  |
| §10.4.2 | CONF §5.2 |  |
| §10.4.3 | CONF §5.3 |  |
| §10.4.4 | CONF §5.4 |  |
| §10.4.5 | CONF §5.5 |  |
| §10.4.6 | CONF §5.6 |  |
| §10.5 | CONF §6 | Vector provenance |
| §10.5.1 | CONF §6.1 |  |
| §10.5.2 | CONF §6.2 |  |
| §10.6 | CONF §7 | Plan-snapshot vector format (normative) |
| §10.6.1 | CONF §7.1 |  |
| §10.7 | CONF §8 | Invert vector format (normative) |
| §10.7.1 | CONF §8.1 |  |
| §10.7.2 | CONF §8.2 |  |
| §10.7.3 | CONF §8.3 |  |
| Appendix A | RATIONALE §2 | Summary of spec-v1 fixes |
| Appendix B | RATIONALE §3 | Known pinned limitations |
| Deferred to a future spec version | RATIONALE §4 | (was under Appendix A) |

### 5.1 Sentences changed to survive the split

The refactor moved all normative text **verbatim** apart from renumbering. Four sentences
genuinely had to change because they referenced "this document" as the single monolith, or were
structurally relocated:

| where (new) | change |
|-------------|--------|
| CORE §1.1 wrapper → CONF §1.1 | "This document is the single normative source…" → "This specification — the CORE, GEN, and CONF documents — is the normative source…" (no longer one document). |
| §1.4 → CONF §1.4 | "…every MUST/MUST NOT/REQUIRED/SHALL in **this document**…" → "…across **this specification (CORE, GEN, and CONF)**…" (the MUSTs now span three documents). |
| §1.3 → CONF §1.3 + RATIONALE §1 | The "Release-candidate status" bullet was condensed to a one-line pointer in CONF §1.3; the full D1–D7 narrative was moved **verbatim** (renumbering aside) to RATIONALE §1. |
| Appendix A "Non-spec fixes" → RATIONALE §2 | "outside **this document's** scope" → "outside **the specification's** scope". |

The per-document navigational preambles at the top of CORE, GEN, CONF, and RATIONALE, and this
index's document map, are new **non-normative** wayfinding text (they define the short names and
point across documents); they add no normative content.
