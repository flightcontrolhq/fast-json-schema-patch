# fast-json-schema-patch — Normative Specification

**Spec version:** `spec-v1-rc`
**Status:** Release Candidate. Reopened 2026-07-14 for an external-review defect round (D1–D7); see RATIONALE §1 and CONF §1.3.
**Reference implementation:** the TypeScript package in this repository, `fast-json-schema-patch` v0.4.0 (branch `feat/deep-dive-overhaul`).

---

This specification is split into four documents under [`spec/`](./spec/). Citations use the
short name and the document-local section number, e.g. `CORE §4.2`, `GEN §5.0`, `CONF §5`.

| Short name | Document | Contents |
|------------|----------|----------|
| **CORE** | [`spec/01-core-semantics.md`](./spec/01-core-semantics.md) | Data model (numbers, equality, key order), JSON Pointer, plan/semantic model, patch format + extensions, apply semantics + errors + security, invert semantics, round-trip contracts. The stable *what*. |
| **GEN** | [`spec/02-generator-profile.md`](./spec/02-generator-profile.md) | The deterministic generator profile: strategy selection + gates, Myers pass, emission ordering, granular descent, moves machinery + LIS, wholesale byte formula, capability behaviors. Byte-deterministic output, cross-language. |
| **CONF** | [`spec/03-conformance.md`](./spec/03-conformance.md) | Vector formats (diff/apply/plan/invert), the conformance gates, required coverage classes, the capability registry, and spec versioning rules. |
| **RATIONALE** | [`spec/04-rationale.md`](./spec/04-rationale.md) | **NON-NORMATIVE.** The F-number audit history, the D1–D7 defect narrative, performance measurements, design rationale, known-limitation notes, and the complete old-section → new-section mapping table. |

**Nothing normative lives in this index.** The four documents above are authoritative.

**Versioning and stability:** see CONF §1.3. **Conformance language (RFC 2119):** CONF §1.4.
**Tracing an old `SPEC.md` §-citation:** the mapping table in RATIONALE §5.
