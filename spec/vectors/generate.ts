/**
 * spec/vectors/generate.ts — deterministic conformance-vector generator.
 *
 * Regenerate with:  bun run spec/vectors/generate.ts
 *
 * This script is the single source of truth for the vector suite under
 * spec/vectors/{diff,apply,plan,invert}/*.json. It imports the TypeScript
 * reference implementation (../../src) and RUNS it to produce every
 * `expectedPatch` (diff), `expectedPlan` (plan) and `expectedInverse` (invert),
 * so the vectors are regenerable and can never silently drift from the
 * reference. Apply vectors are hand-authored (their `expected`/`error` is the
 * oracle) and this script re-runs the reference applier against each one as a
 * self-check.
 *
 * Determinism: there is NO randomness. Map iteration is normalised (plan
 * entries sorted by path); JSON is emitted with a stable 2-space indent and a
 * fixed record-field order. Re-running produces byte-identical files.
 *
 * The generator additionally VERIFIES each vector as it emits it (round-trip
 * for diff, double-apply identity for invert, oracle match for apply); a
 * malformed vector aborts generation with a thrown error, so a green run is
 * itself a conformance check of the reference against CORE §7/CORE §6/CONF.
 *
 * Spec references (SPEC.md, spec-v1):
 *   diff vector format   CONF §2     conformance gate CONF §4
 *   apply vector format  CONF §3     gate            CONF §3.1
 *   plan-snapshot format CONF §7
 *   invert vector format CONF §8
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPatch,
  buildPlan,
  invertPatch,
  JsonPatchError,
  JsonSchemaPatcher,
} from "../../src/index";
import type { PatchErrorCode } from "../../src/index";
import type { Plan } from "../../src/core/buildPlan";
import type { JsonValue, Operation } from "../../src/types";

// ---------------------------------------------------------------------------
// JSON-semantics helpers (CORE §1.4). Local, dependency-free, so the generator does
// not inherit the reference's memoised deepEqual (which is what we are testing).
// ---------------------------------------------------------------------------
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true; // covers primitives incl. 0/-0, and reference id
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++)
      if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    for (const k of ak) {
      if (!Object.hasOwn(bo, k)) return false;
      if (!deepEqual(ao[k], bo[k])) return false;
    }
    return true;
  }
  return false;
}

/** Recursively sort arrays (by canonical JSON) and object keys — a multiset
 *  canonicalisation used only to verify the CORE §7.2 primaryKey contract (survivors
 *  ++ appends is multiset-equal to `modified`). NOT used for exact strategies. */
function canonSort(v: JsonValue): JsonValue {
  if (Array.isArray(v)) {
    const arr = v.map(canonSort);
    arr.sort((x, y) => {
      const sx = JSON.stringify(x);
      const sy = JSON.stringify(y);
      return sx < sy ? -1 : sx > sy ? 1 : 0;
    });
    return arr;
  }
  if (v && typeof v === "object") {
    const o: Record<string, JsonValue> = {};
    for (const k of Object.keys(v).sort()) o[k] = canonSort((v as Record<string, JsonValue>)[k]!);
    return o;
  }
  return v;
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`VECTOR SELF-CHECK FAILED: ${msg}`);
}

// ---------------------------------------------------------------------------
// Collectors. Each category is a map of output-filename -> record[].
// ---------------------------------------------------------------------------
type Caps = {
  includeOldValue?: boolean;
  emitMoves?: boolean;
  wholesaleReplaceFallback?: boolean;
  ignorePaths?: string[];
};
type PlanOpts = {
  primaryKeyMap?: Record<string, string>;
  basePath?: string;
  primaryKeyCandidates?: string[];
};

type DiffSpec = {
  name: string;
  comment: string;
  schema?: object | null;
  planOpts?: PlanOpts;
  capabilities?: Caps;
  original: JsonValue;
  modified: JsonValue;
  /** how applyPatch(original, expectedPatch) relates to `modified` (CORE §7). */
  roundtrip?: "exact" | "multiset" | "none";
};
type PlanSpec = {
  name: string;
  comment?: string;
  schema: object;
  planOpts?: PlanOpts;
};
type InvertSpec = {
  name: string;
  comment: string;
  document: JsonValue;
  patch: Operation[];
};
type ApplySpec = {
  name: string;
  comment: string;
  doc: JsonValue;
  patch: Operation[];
  options?: { validateOldValues?: boolean; cloneValues?: boolean; cloneResult?: boolean };
  expected?: JsonValue;
  error?: { code: PatchErrorCode; index: number };
};

const diffFiles: Record<string, DiffSpec[]> = {};
const planFiles: Record<string, PlanSpec[]> = {};
const invertFiles: Record<string, InvertSpec[]> = {};
const applyFiles: Record<string, ApplySpec[]> = {};

const seenNames = new Set<string>();
function uniq(name: string) {
  assert(!seenNames.has(name), `duplicate vector name: ${name}`);
  seenNames.add(name);
}

function D(file: string, spec: DiffSpec) {
  uniq(spec.name);
  (diffFiles[file] ??= []).push(spec);
}
function P(file: string, spec: PlanSpec) {
  uniq(spec.name);
  (planFiles[file] ??= []).push(spec);
}
function I(file: string, spec: InvertSpec) {
  uniq(spec.name);
  (invertFiles[file] ??= []).push(spec);
}
function A(file: string, spec: ApplySpec) {
  uniq(spec.name);
  assert(
    (spec.expected !== undefined) !== (spec.error !== undefined),
    `apply vector ${spec.name} must have exactly one of expected/error`,
  );
  (applyFiles[file] ??= []).push(spec);
}

// ---------------------------------------------------------------------------
// Runners. Each turns a spec into a wire record, verifying it on the way.
// ---------------------------------------------------------------------------
function buildDiffRecord(spec: DiffSpec): Record<string, unknown> {
  const plan: Plan = spec.schema
    ? // biome-ignore lint: schemas are authored as plain objects
      buildPlan({ schema: spec.schema as never, ...spec.planOpts })
    : new Map();
  const expectedPatch = new JsonSchemaPatcher({ plan, ...spec.capabilities }).execute({
    original: spec.original,
    modified: spec.modified,
  }) as Operation[];

  // --- self-check: round-trip (CORE §7 / CONF §4.1) ---
  const mode = spec.roundtrip ?? "exact";
  if (mode !== "none") {
    const applied = applyPatch(spec.original, expectedPatch);
    if (mode === "exact") {
      assert(
        deepEqual(applied, spec.modified),
        `${spec.name}: exact round-trip failed (${JSON.stringify(applied)} != ${JSON.stringify(spec.modified)})`,
      );
    } else {
      assert(
        deepEqual(canonSort(applied), canonSort(spec.modified)),
        `${spec.name}: multiset round-trip failed`,
      );
    }
  }

  // --- assemble the options block (only non-defaults) ---
  const options: Record<string, unknown> = {};
  if (spec.planOpts?.primaryKeyMap) options.primaryKeyMap = spec.planOpts.primaryKeyMap;
  if (spec.planOpts?.basePath !== undefined) options.basePath = spec.planOpts.basePath;
  if (spec.planOpts?.primaryKeyCandidates !== undefined)
    options.primaryKeyCandidates = spec.planOpts.primaryKeyCandidates;
  const caps: Record<string, unknown> = {};
  if (spec.capabilities?.includeOldValue === false) caps.includeOldValue = false;
  if (spec.capabilities?.emitMoves === true) caps.emitMoves = true;
  if (spec.capabilities?.wholesaleReplaceFallback === true)
    caps.wholesaleReplaceFallback = true;
  if (spec.capabilities?.ignorePaths && spec.capabilities.ignorePaths.length)
    caps.ignorePaths = spec.capabilities.ignorePaths;
  if (Object.keys(caps).length) options.capabilities = caps;

  const rec: Record<string, unknown> = { name: spec.name, comment: spec.comment };
  if (spec.schema) rec.schema = spec.schema;
  if (Object.keys(options).length) rec.options = options;
  rec.original = spec.original;
  rec.modified = spec.modified;
  rec.expectedPatch = expectedPatch;
  return rec;
}

function buildPlanRecord(spec: PlanSpec): Record<string, unknown> {
  // biome-ignore lint: schemas are authored as plain objects
  const plan = buildPlan({ schema: spec.schema as never, ...spec.planOpts });
  const expectedPlan = [...plan.entries()]
    .map(([path, ap]) => ({
      path,
      primaryKey: ap.primaryKey ?? null,
      strategy: ap.strategy ?? "lcs",
      requiredFields: ap.requiredFields ? [...ap.requiredFields].sort() : [],
      hashFields: ap.hashFields ? [...ap.hashFields].sort() : [],
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const rec: Record<string, unknown> = { name: spec.name };
  if (spec.comment) rec.comment = spec.comment;
  rec.schema = spec.schema;
  const options: Record<string, unknown> = {};
  if (spec.planOpts?.primaryKeyMap) options.primaryKeyMap = spec.planOpts.primaryKeyMap;
  if (spec.planOpts?.basePath !== undefined) options.basePath = spec.planOpts.basePath;
  if (spec.planOpts?.primaryKeyCandidates !== undefined)
    options.primaryKeyCandidates = spec.planOpts.primaryKeyCandidates;
  if (Object.keys(options).length) rec.options = options;
  rec.expectedPlan = expectedPlan;
  return rec;
}

function buildInvertRecord(spec: InvertSpec): Record<string, unknown> {
  // CONF §8.1: patch MUST apply cleanly to document.
  const forward = applyPatch(spec.document, spec.patch);
  const expectedInverse = invertPatch(spec.document, spec.patch);
  // CONF §8.2(b): double-apply identity against the ORIGINAL document.
  const back = applyPatch(forward, expectedInverse);
  assert(
    deepEqual(back, spec.document),
    `${spec.name}: double-apply identity failed`,
  );
  return {
    name: spec.name,
    comment: spec.comment,
    document: spec.document,
    patch: spec.patch,
    expectedInverse,
  };
}

function buildApplyRecord(spec: ApplySpec): Record<string, unknown> {
  // Self-check the hand-authored oracle against the reference applier: an error
  // vector must throw the pinned code at the pinned index; a value vector must
  // apply to the pinned result. A mismatch aborts generation.
  if (spec.error) {
    let threw: JsonPatchError | undefined;
    try {
      applyPatch(spec.doc, spec.patch, spec.options ?? {});
    } catch (e) {
      assert(e instanceof JsonPatchError, `${spec.name}: threw non-JsonPatchError ${e}`);
      threw = e;
    }
    assert(threw !== undefined, `${spec.name}: expected throw, none happened`);
    assert(
      threw.code === spec.error.code,
      `${spec.name}: code ${threw.code} != ${spec.error.code}`,
    );
    assert(
      threw.operationIndex === spec.error.index,
      `${spec.name}: index ${threw.operationIndex} != ${spec.error.index}`,
    );
  } else {
    const result = applyPatch(spec.doc, spec.patch, spec.options ?? {});
    assert(
      deepEqual(result, spec.expected),
      `${spec.name}: apply result ${JSON.stringify(result)} != ${JSON.stringify(spec.expected)}`,
    );
  }
  const rec: Record<string, unknown> = { name: spec.name, comment: spec.comment };
  rec.doc = spec.doc;
  rec.patch = spec.patch;
  if (spec.options) rec.options = spec.options;
  if (spec.error) rec.error = spec.error;
  else rec.expected = spec.expected;
  return rec;
}

// ===========================================================================
// VECTOR DEFINITIONS  (inserted below; see the //<<THEMES>> marker)
// ===========================================================================
// --- diff/pointer-escaping: RFC 6901 segment escaping in emitted paths (CORE §2.2) ---
D("pointer-escaping", { name: "ptr-slash-key-replace", comment: "CORE §2.2: object key containing '/' escapes to ~1 in the pointer", schema: null, original: { "a/b": 1 }, modified: { "a/b": 2 } });
D("pointer-escaping", { name: "ptr-tilde-key-replace", comment: "CORE §2.2: object key containing '~' escapes to ~0", schema: null, original: { "a~b": 1 }, modified: { "a~b": 2 } });
D("pointer-escaping", { name: "ptr-tilde1-lookalike-key", comment: "CORE §2.2: key literally 'a~1b' escapes ~ FIRST then / -> 'a~01b' (order matters)", schema: null, original: { "a~1b": 1 }, modified: { "a~1b": 2 } });
D("pointer-escaping", { name: "ptr-empty-string-key", comment: "CORE §2.2: the empty string is a valid key; pointer '/' addresses member ''", schema: null, original: { "": 1 }, modified: { "": 2 } });
D("pointer-escaping", { name: "ptr-nested-slash-key", comment: "CORE §2.2: escaping applies at each segment; /x/a~1b", schema: null, original: { x: { "a/b": 1 } }, modified: { x: { "a/b": 9 } } });
D("pointer-escaping", { name: "ptr-add-slash-key", comment: "CORE §2.2/GEN §2.3: add op path escapes the new key", schema: null, original: {}, modified: { "c/d": 5 } });
D("pointer-escaping", { name: "ptr-remove-tilde-key", comment: "CORE §2.2/GEN §2.3: remove op path escapes the removed key", schema: null, original: { "e~f": 7 }, modified: {} });
D("pointer-escaping", { name: "ptr-both-escapes-key", comment: "CORE §2.2: '~/' escapes to '~0~1' (~ before /)", schema: null, original: { "~/": 1 }, modified: { "~/": 2 } });
D("pointer-escaping", { name: "ptr-unicode-key", comment: "CORE §2.2: non-ASCII keys pass through unescaped (only ~ and / are escaped)", schema: null, original: { "café": 1 }, modified: { "café": 2 } });
D("pointer-escaping", { name: "ptr-emoji-key", comment: "CORE §2.2: astral-plane key passes through unescaped", schema: null, original: { "🔑": 1 }, modified: { "🔑": 2 } });
D("pointer-escaping", { name: "ptr-numeric-string-object-key", comment: "CORE §5.2.3: a decimal-digit key on an OBJECT is an ordinary member key, not an index", schema: null, original: { "0": 1, "10": "x" }, modified: { "0": 9, "10": "x" } });
D("pointer-escaping", { name: "ptr-slash-inside-array-item-object", comment: "CORE §2.2: escaping still applies inside array-item object diffs", schema: null, original: [{ "p/q": 1 }], modified: [{ "p/q": 2 }] });

// --- diff/primitives-and-numbers: CORE §1.2 number semantics, CORE §1.4.3 no coercion, GEN §1.4 ---
D("primitives-and-numbers", { name: "num-1-vs-1.0-equal", comment: "CORE §1.2.2: 1 and 1.0 are equal at f64 -> no ops", schema: null, original: { a: 1 }, modified: { a: 1.0 } });
D("primitives-and-numbers", { name: "num-neg-zero-vs-zero-equal", comment: "CORE §1.2.2: -0 and 0 are equal -> no ops (JSON serialises -0 as 0)", schema: null, original: { a: 0 }, modified: { a: -0 } });
D("primitives-and-numbers", { name: "num-2pow53-collapse-equal", comment: "CORE §1.2.2: 2^53 and 2^53+1 share one f64 image -> equal, no ops", schema: null, original: { a: 9007199254740992 }, modified: { a: 9007199254740993 } });
D("primitives-and-numbers", { name: "num-2pow53-distinct-replace", comment: "CORE §1.2.2: 2^53 vs 2^53+2 are distinct f64 -> replace", schema: null, original: { a: 9007199254740992 }, modified: { a: 9007199254740994 } });
D("primitives-and-numbers", { name: "num-large-int-replace", comment: "CORE §1.2.3: large-int replace carries value/oldValue verbatim", schema: null, original: { a: 9007199254740992 }, modified: { a: 1 } });
D("primitives-and-numbers", { name: "num-simple-replace", comment: "GEN §1.4: primitive number replace", schema: null, original: { a: 1 }, modified: { a: 2 } });
D("primitives-and-numbers", { name: "null-to-absent-remove", comment: "CORE §1.4.3: null != absent; dropping a null member is a remove with oldValue:null", schema: null, original: { a: null }, modified: {} });
D("primitives-and-numbers", { name: "absent-to-null-add", comment: "CORE §1.4.3: adding a null member is an add with value:null", schema: null, original: {}, modified: { a: null } });
D("primitives-and-numbers", { name: "null-to-value-replace", comment: "GEN §1.4: null -> number is a primitive replace, oldValue null", schema: null, original: { a: null }, modified: { a: 5 } });
D("primitives-and-numbers", { name: "value-to-null-replace", comment: "GEN §1.4: number -> null is a primitive replace", schema: null, original: { a: 5 }, modified: { a: null } });
D("primitives-and-numbers", { name: "num-vs-string-no-coercion", comment: "CORE §1.4.3: 1 != \"1\"; type change is a replace", schema: null, original: { a: 1 }, modified: { a: "1" } });
D("primitives-and-numbers", { name: "bool-vs-num-no-coercion", comment: "CORE §1.4.3: true != 1; replace", schema: null, original: { a: true }, modified: { a: 1 } });
D("primitives-and-numbers", { name: "string-replace", comment: "GEN §1.4: string replace", schema: null, original: { a: "x" }, modified: { a: "y" } });
D("primitives-and-numbers", { name: "kind-object-to-array-replace", comment: "GEN §1.4: object vs array is a whole replace, never a structural merge", schema: null, original: { a: { x: 1 } }, modified: { a: [1] } });
D("primitives-and-numbers", { name: "kind-array-to-object-replace", comment: "GEN §1.4: array vs object is a whole replace", schema: null, original: { a: [1] }, modified: { a: { x: 1 } } });
D("primitives-and-numbers", { name: "kind-array-to-primitive-replace", comment: "GEN §1.4: array vs primitive is a whole replace", schema: null, original: { a: [1] }, modified: { a: 5 } });
D("primitives-and-numbers", { name: "root-primitive-replace", comment: "GEN §1.4: root-level primitive change replaces at path ''", schema: null, original: 1, modified: 2 });
D("primitives-and-numbers", { name: "root-null-to-object-replace", comment: "GEN §1.4: root null vs object is a whole replace at ''", schema: null, original: null, modified: { a: 1 } });

// --- diff/objects: GEN §2 object member diff, key visitation order GEN §2.2 ---
D("objects", { name: "obj-add-member", comment: "GEN §2.3: modified-only key -> add (no oldValue)", schema: null, original: { a: 1 }, modified: { a: 1, b: 2 } });
D("objects", { name: "obj-remove-member", comment: "GEN §2.3: original-only key -> remove with oldValue", schema: null, original: { a: 1, b: 2 }, modified: { a: 1 } });
D("objects", { name: "obj-replace-member", comment: "GEN §2.3/GEN §1.4: present-in-both primitive change -> replace", schema: null, original: { a: 1 }, modified: { a: 2 } });
D("objects", { name: "obj-nested-change", comment: "GEN §2.3: recurse into nested object member", schema: null, original: { a: { b: { c: 1 } } }, modified: { a: { b: { c: 2 } } } });
D("objects", { name: "obj-key-visitation-order", comment: "GEN §2.2: original keys in original order, then modified-only keys in modified order", schema: null, original: { b: 1, a: 1 }, modified: { b: 2, a: 2, c: 3 } });
D("objects", { name: "obj-mixed-add-remove-replace", comment: "GEN §2.2/GEN §2.3: mixed member operations in visitation order", schema: null, original: { keep: 1, drop: 2, chg: 3 }, modified: { keep: 1, chg: 4, gain: 5 } });
D("objects", { name: "obj-empty-to-populated", comment: "GEN §2.3: all members added", schema: null, original: {}, modified: { a: 1, b: 2, c: 3 } });
D("objects", { name: "obj-populated-to-empty", comment: "GEN §2.3: all members removed (visitation = original order)", schema: null, original: { a: 1, b: 2, c: 3 }, modified: {} });
D("objects", { name: "obj-replaced-by-different-object", comment: "GEN §2.3: recurse into object-vs-object member yielding nested ops", schema: null, original: { a: { x: 1, y: 2 } }, modified: { a: { x: 1, y: 9 } } });
D("objects", { name: "obj-identical-noop", comment: "GEN §1: deep-equal objects (key order differs) emit nothing", schema: null, original: { a: 1, b: 2 }, modified: { b: 2, a: 1 } });
D("objects", { name: "obj-add-object-valued-member", comment: "GEN §2.3: adding a whole subtree is a single add", schema: null, original: {}, modified: { a: { deep: { tree: [1, 2, 3] } } } });
D("objects", { name: "obj-remove-then-add-different-keys", comment: "GEN §2.2: remove of original-only precedes add of modified-only", schema: null, original: { x: 1 }, modified: { y: 2 } });

// --- diff/arrays-empty-and-root: empty arrays both directions + root-level arrays (GEN §5.0.3, GEN §5.1) ---
D("arrays-empty-and-root", { name: "arr-empty-to-populated-nested", comment: "GEN §5.1: empty original -> ascending adds at concrete indices", schema: null, original: { a: [] }, modified: { a: [1, 2, 3] } });
D("arrays-empty-and-root", { name: "arr-populated-to-empty-nested", comment: "GEN §5.1: empty modified -> DESCENDING removes, each with oldValue", schema: null, original: { a: [1, 2, 3] }, modified: { a: [] } });
D("arrays-empty-and-root", { name: "arr-both-empty-noop", comment: "GEN §5.0.3: wn=wm=0 -> no ops", schema: null, original: { a: [] }, modified: { a: [] } });
D("arrays-empty-and-root", { name: "arr-root-empty-to-populated", comment: "GEN §5: root array uses prefix '/' before the index (/0,/1)", schema: null, original: [], modified: [1, 2] });
D("arrays-empty-and-root", { name: "arr-root-populated-to-empty", comment: "GEN §5.1: root array cleared, descending removes at /2,/1,/0", schema: null, original: [1, 2, 3], modified: [] });
D("arrays-empty-and-root", { name: "arr-root-modify-middle", comment: "GEN §5: root array element replace", schema: null, original: [1, 2, 3], modified: [1, 9, 3] });
D("arrays-empty-and-root", { name: "arr-root-append", comment: "GEN §5.0.3: pure append at root", schema: null, original: [1, 2], modified: [1, 2, 3] });
D("arrays-empty-and-root", { name: "arr-root-prepend", comment: "GEN §5.0.3: pure prepend at root (interior insert at index 0)", schema: null, original: [2, 3], modified: [1, 2, 3] });
D("arrays-empty-and-root", { name: "arr-nested-empty-add-first", comment: "GEN §5.1: first element added to an empty nested array", schema: null, original: { a: [] }, modified: { a: [42] } });
D("arrays-empty-and-root", { name: "arr-with-nulls-replace", comment: "CORE §1.4.3/GEN §5: null array elements compare by value", schema: null, original: [null, 1], modified: [null, 2] });
D("arrays-empty-and-root", { name: "arr-root-to-primitive-replace", comment: "GEN §1.4: root array vs primitive is a whole replace at ''", schema: null, original: [1, 2], modified: "x" });
D("arrays-empty-and-root", { name: "arr-root-null-to-array-replace", comment: "GEN §1.4: root null vs array is a whole replace at ''", schema: null, original: null, modified: [1, 2, 3] });

// --- diff/lcs-trimming: GEN §5.0 common prefix/suffix trim + Myers window edges ---
D("lcs-trimming", { name: "lcs-all-equal-noop", comment: "GEN §5.0.3: identical arrays trim to empty window -> no ops", schema: null, original: [1, 2, 3, 4], modified: [1, 2, 3, 4] });
D("lcs-trimming", { name: "lcs-pure-append", comment: "GEN §5.0.3: prefix trims all common; window is pure insertion", schema: null, original: [1, 2, 3], modified: [1, 2, 3, 4, 5] });
D("lcs-trimming", { name: "lcs-pure-prepend", comment: "GEN §5.0.3: suffix trims all common; inserts at head", schema: null, original: [3, 4, 5], modified: [1, 2, 3, 4, 5] });
D("lcs-trimming", { name: "lcs-pure-truncate-tail", comment: "GEN §5.0.3: wm=0 window -> descending removes at the tail", schema: null, original: [1, 2, 3, 4, 5], modified: [1, 2, 3] });
D("lcs-trimming", { name: "lcs-pure-truncate-head", comment: "GEN §5.0.3: suffix-trim leaves a head-only removal window", schema: null, original: [1, 2, 3, 4, 5], modified: [3, 4, 5] });
D("lcs-trimming", { name: "lcs-interior-insert", comment: "GEN §5.0: prefix+suffix trim isolate an interior insertion", schema: null, original: [1, 4], modified: [1, 2, 3, 4] });
D("lcs-trimming", { name: "lcs-interior-remove", comment: "GEN §5.0: prefix+suffix trim isolate an interior deletion", schema: null, original: [1, 2, 3, 4], modified: [1, 4] });
D("lcs-trimming", { name: "lcs-abab-to-aa", comment: "GEN §5.0.1 pinned: [a,b,a]->[a,a] fixes prefix a (lo=1) then suffix a (hi=1) -> single remove at index 1", schema: null, original: ["a", "b", "a"], modified: ["a", "a"] });
D("lcs-trimming", { name: "lcs-prefix-and-suffix-trim", comment: "GEN §5.0.1: shared ends trimmed, only the middle primitive replaces", schema: null, original: ["a", "X", "c"], modified: ["a", "Y", "c"] });
D("lcs-trimming", { name: "lcs-replace-in-middle", comment: "GEN §5.4: single interior primitive replace", schema: null, original: [1, 2, 3, 4, 5], modified: [1, 2, 9, 4, 5] });
D("lcs-trimming", { name: "lcs-swap-adjacent", comment: "GEN §5.2: adjacent swap has no common window element; Myers picks the pinned shortest script", schema: null, original: [1, 2], modified: [2, 1] });
D("lcs-trimming", { name: "lcs-full-reversal", comment: "GEN §5.2: full reversal exercises the Myers tie-break", schema: null, original: [1, 2, 3], modified: [3, 2, 1] });
D("lcs-trimming", { name: "lcs-mixed-add-remove", comment: "GEN §5.5: interleaved insertions and deletions in one window", schema: null, original: ["a", "b", "c", "d"], modified: ["a", "x", "c", "y", "d"] });
D("lcs-trimming", { name: "lcs-duplicates-preserved", comment: "CORE §7.1.1: LCS reconstructs duplicates exactly", schema: null, original: [1, 1, 2, 1], modified: [1, 2, 1, 1] });

// --- diff/lcs-granular: GEN §5.4.2 granular descent shapes ---
D("lcs-granular", { name: "gran-object-item-field-change", comment: "GEN §5.4.2: collapsed object<->object replace recurses to a field-level op", schema: null, original: [{ x: 1, y: 2 }], modified: [{ x: 1, y: 9 }] });
D("lcs-granular", { name: "gran-nested-array-in-item", comment: "GEN §5.4.2: recurse into item then into its nested array (LCS)", schema: null, original: [{ list: [1, 2] }], modified: [{ list: [1, 3] }] });
D("lcs-granular", { name: "gran-primitive-stays-whole", comment: "GEN §5.4.2: a primitive collapsed pair stays a whole-item replace", schema: null, original: [1], modified: [2] });
D("lcs-granular", { name: "gran-kind-mismatch-stays-whole", comment: "GEN §5.4.2: object vs array (mismatched kind) stays a whole-item replace, no descent", schema: null, original: [{ x: 1 }], modified: [[1]] });
D("lcs-granular", { name: "gran-arrays-of-arrays", comment: "GEN §5.4.2: both-array collapsed pair recurses (array-of-arrays via default LCS)", schema: null, original: [[1, 2], [3, 4]], modified: [[1, 9], [3, 4]] });
D("lcs-granular", { name: "gran-object-add-in-item", comment: "GEN §5.4.2: descent yields an add inside a changed item", schema: null, original: [{ a: 1 }], modified: [{ a: 1, b: 2 }] });
D("lcs-granular", { name: "gran-object-remove-in-item", comment: "GEN §5.4.2: descent yields a remove inside a changed item", schema: null, original: [{ a: 1, b: 2 }], modified: [{ a: 1 }] });
D("lcs-granular", { name: "gran-deep-nested-descent", comment: "GEN §5.4.2: descent recurses arbitrarily deep", schema: null, original: [{ o: { p: 1 } }], modified: [{ o: { p: 2 } }] });
D("lcs-granular", { name: "gran-changed-and-appended", comment: "GEN §5.4.2 + GEN §5.5: item 0 descends granularly, item 1 is a fresh add", schema: null, original: [{ x: 1 }], modified: [{ x: 2 }, { z: 3 }] });
D("lcs-granular", { name: "gran-nested-array-add-in-item", comment: "GEN §5.4.2: descent into item then add into its nested array", schema: null, original: [{ arr: [1] }], modified: [{ arr: [1, 2] }] });
D("lcs-granular", { name: "gran-two-items-first-changed", comment: "GEN §5.4.2: only the differing item descends; the equal one is trimmed", schema: null, original: [{ x: 1 }, { y: 1 }], modified: [{ x: 2 }, { y: 1 }] });

// ---- shared schemas for keyed/unique themes ----
const PK_USERS = { type: "object", properties: { users: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id"] } } } };
const PK_USERS_NUM = { type: "object", properties: { users: { type: "array", items: { type: "object", properties: { id: { type: "number" }, name: { type: "string" } }, required: ["id"] } } } };
const PK_NESTED = { type: "object", properties: { groups: { type: "array", items: { type: "object", properties: { id: { type: "string" }, members: { type: "array", items: { type: "object", properties: { id: { type: "string" }, role: { type: "string" } }, required: ["id"] } } }, required: ["id"] } } } };
const UNIQ_TAGS = { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } };
const UNIQ_NUMS = { type: "object", properties: { tags: { type: "array", items: { type: "number" } } } };
const UNIQ_BOOL = { type: "object", properties: { tags: { type: "array", items: { type: "boolean" } } } };
// Plain object-item schema (no required id) used only with a primaryKeyMap override.
const ITEMS_PLAIN = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, v: { type: "number" } } } } } };

// --- diff/primary-key: GEN §4 three-phase keyed emission (default mode, order-insensitive CORE §7.2) ---
D("primary-key", { name: "pk-modify-one-field", comment: "GEN §4.1: matched item changed -> field-level replace at the ORIGINAL index", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [{ id: "a", name: "A2" }, { id: "b", name: "B" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-add-new-key", comment: "GEN §4.1.2: unmatched modified key -> add at /-", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }] }, modified: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-remove-key", comment: "GEN §4.1.3: unmatched original key -> remove", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [{ id: "a", name: "A" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-reorder-noop", comment: "CORE §7.2.3: pure reorder of deep-equal items emits ZERO ops", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] }, modified: { users: [{ id: "c", name: "C" }, { id: "a", name: "A" }, { id: "b", name: "B" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-worked-example", comment: "GEN §4.2: the normative worked example — modifications(orig idx) ++ removals(desc) ++ /- appends", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] }, modified: { users: [{ id: "c", name: "C2" }, { id: "a", name: "A" }, { id: "d", name: "D" }, { id: "e", name: "E" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-numeric-key", comment: "GEN §4.1.5: numeric primaryKey values index natively; distinct from strings", schema: PK_USERS_NUM, original: { users: [{ id: 1, name: "A" }, { id: 2, name: "B" }] }, modified: { users: [{ id: 1, name: "A9" }, { id: 2, name: "B" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-reorder-and-modify", comment: "GEN §4.1: survivors kept at original index while content updates; order not preserved", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] }, modified: { users: [{ id: "c", name: "C" }, { id: "b", name: "B2" }, { id: "a", name: "A" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-remove-multiple-descending", comment: "GEN §4.1.4: multiple removals emit in DESCENDING original index", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }] }, modified: { users: [{ id: "b", name: "B" }, { id: "d", name: "D" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-all-removed", comment: "GEN §4.1.3: every original key drops -> descending removals only", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-all-new", comment: "GEN §4.1.2: empty original, all modified keys are /- appends", schema: PK_USERS, original: { users: [] }, modified: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-key-field-change-is-remove-add", comment: "CORE §3.5.5: editing the key field turns an in-place edit into remove+append", schema: PK_USERS, original: { users: [{ id: "x", name: "A" }] }, modified: { users: [{ id: "y", name: "A" }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-nested-keyed-arrays", comment: "CORE §7.2.4: keyed arrays inside keyed arrays inherit the per-level contract", schema: PK_NESTED, original: { groups: [{ id: "g1", members: [{ id: "m1", role: "r1" }, { id: "m2", role: "r2" }] }] }, modified: { groups: [{ id: "g1", members: [{ id: "m1", role: "R1" }, { id: "m2", role: "r2" }] }] }, roundtrip: "multiset" });
D("primary-key", { name: "pk-via-primaryKeyMap-override", comment: "CORE §3.4.3: primaryKeyMap selects primaryKey strategy without a schema-declared key", schema: ITEMS_PLAIN, planOpts: { primaryKeyMap: { "/items": "id" } }, original: { items: [{ id: "a", v: 1 }, { id: "b", v: 2 }] }, modified: { items: [{ id: "a", v: 9 }, { id: "b", v: 2 }] }, roundtrip: "multiset" });

// --- diff/primary-key-gate: GEN §4.3 gate-failure classes MUST fall back to LCS (exact, CORE §7.1) [CONF §6.1] ---
D("primary-key-gate", { name: "gate-non-object-element", comment: "CONF §6.1(a): a non-object array element fails the gate -> LCS fallback", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [{ id: "a", name: "A" }, 99] }, roundtrip: "exact" });
D("primary-key-gate", { name: "gate-non-object-both-numbers", comment: "CONF §6.1(a): all-primitive arrays under a keyed schema fall back to LCS", schema: PK_USERS, original: { users: [1, 2] }, modified: { users: [1, 3] }, roundtrip: "exact" });
D("primary-key-gate", { name: "gate-missing-key", comment: "CONF §6.1(b): an element whose primaryKey is absent -> LCS fallback", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }] }, modified: { users: [{ id: "a", name: "A" }, { name: "orphan" }] }, roundtrip: "exact" });
D("primary-key-gate", { name: "gate-null-key", comment: "CONF §6.1(b): a null primaryKey value -> LCS fallback", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }] }, modified: { users: [{ id: null, name: "A" }] }, roundtrip: "exact" });
D("primary-key-gate", { name: "gate-non-string-number-key", comment: "CONF §6.1(b): a boolean primaryKey value (not string/number) -> LCS fallback", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }] }, modified: { users: [{ id: true, name: "A" }] }, roundtrip: "exact" });
D("primary-key-gate", { name: "gate-duplicate-in-original", comment: "CONF §6.1(c): duplicate key within ORIGINAL -> LCS fallback", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }, modified: { users: [{ id: "a", name: "C" }] }, roundtrip: "exact" });
D("primary-key-gate", { name: "gate-duplicate-in-modified", comment: "CONF §6.1(c): duplicate key within MODIFIED -> LCS fallback", schema: PK_USERS, original: { users: [{ id: "a", name: "A" }] }, modified: { users: [{ id: "a", name: "A" }, { id: "a", name: "B" }] }, roundtrip: "exact" });
D("primary-key-gate", { name: "gate-override-does-not-bypass", comment: "GEN §4.3/CONF §6.1: a primaryKeyMap override does NOT bypass the gate; duplicate keys still fall back to LCS", schema: ITEMS_PLAIN, planOpts: { primaryKeyMap: { "/items": "id" } }, original: { items: [{ id: "a", v: 1 }, { id: "a", v: 2 }] }, modified: { items: [{ id: "a", v: 3 }] }, roundtrip: "exact" });

// --- diff/unique: GEN §6 equal-length positional replaces; unequal/duplicate -> LCS ---
D("unique", { name: "uniq-single-replace", comment: "GEN §6.1: equal-length unique arrays -> positional replace at differing index", schema: UNIQ_TAGS, original: { tags: ["a", "b", "c"] }, modified: { tags: ["a", "x", "c"] }, roundtrip: "exact" });
D("unique", { name: "uniq-multiple-replaces", comment: "GEN §6.1: one replace per differing position", schema: UNIQ_TAGS, original: { tags: ["a", "b", "c"] }, modified: { tags: ["x", "y", "z"] }, roundtrip: "exact" });
D("unique", { name: "uniq-noop", comment: "GEN §6.1: identical unique arrays emit nothing", schema: UNIQ_TAGS, original: { tags: ["a", "b", "c"] }, modified: { tags: ["a", "b", "c"] }, roundtrip: "exact" });
D("unique", { name: "uniq-reorder-as-replaces", comment: "GEN §6.1/GEN §8.6: default mode emits a permutation as positional replaces (NOT moves)", schema: UNIQ_TAGS, original: { tags: ["a", "b", "c"] }, modified: { tags: ["c", "b", "a"] }, roundtrip: "exact" });
D("unique", { name: "uniq-numbers", comment: "CORE §3.4.2: number-typed items get the unique strategy", schema: UNIQ_NUMS, original: { tags: [1, 2, 3] }, modified: { tags: [1, 9, 3] }, roundtrip: "exact" });
D("unique", { name: "uniq-booleans", comment: "CORE §3.4.2/GEN §6.1: boolean items, positional replaces", schema: UNIQ_BOOL, original: { tags: [true, false] }, modified: { tags: [false, true] }, roundtrip: "exact" });
D("unique", { name: "uniq-unequal-length-lcs-fallback", comment: "GEN §6.2: unequal lengths fail checkArraysUnique -> LCS (add)", schema: UNIQ_TAGS, original: { tags: ["a", "b"] }, modified: { tags: ["a", "b", "c"] }, roundtrip: "exact" });
D("unique", { name: "uniq-dup-in-modified-lcs-fallback", comment: "GEN §4.4: duplicate in modified fails uniqueness -> LCS fallback", schema: UNIQ_TAGS, original: { tags: ["a", "b"] }, modified: { tags: ["a", "a"] }, roundtrip: "exact" });
D("unique", { name: "uniq-dup-in-original-lcs-fallback", comment: "GEN §4.4: duplicate in original fails uniqueness -> LCS fallback", schema: UNIQ_TAGS, original: { tags: ["a", "a"] }, modified: { tags: ["a", "b"] }, roundtrip: "exact" });

// ---- schemas exercising plan derivation / trie lookup ----
const ITEM_ID = { type: "object", properties: { id: { type: "string" }, v: { type: "number" } }, required: ["id"] };
const AP_DEEP = { type: "object", properties: { envs: { type: "object", additionalProperties: { type: "array", items: ITEM_ID } } } };
const AP_TOPLEVEL = { type: "object", additionalProperties: { type: "array", items: ITEM_ID } };
const ALLOF_KEY = { type: "object", properties: { list: { type: "array", items: { allOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, { type: "object", properties: { name: { type: "string" } } }] } } } };
const TYPELESS = { properties: { list: { items: ITEM_ID } } };
const BASEPATH_SCHEMA = { type: "object", properties: { config: { type: "object", properties: { servers: { type: "array", items: ITEM_ID } } } } };
const SKU_SCHEMA = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "number" } }, required: ["sku"] } } } };
const NAME_SCHEMA = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { name: { type: "string" }, qty: { type: "number" } }, required: ["name"] } } } };
const MATRIX_SCHEMA = { type: "object", properties: { matrix: { type: "array", items: { type: "array", items: ITEM_ID } } } };
const EXACT_OVER_WILDCARD = { type: "object", properties: { special: { type: "array", items: ITEM_ID } }, additionalProperties: { type: "array", items: { type: "object", properties: { q: { type: "number" } } } } };

// --- diff/plan-selection: plan-driven strategy selection at diff time (CORE §3, GEN §4.5) ---
D("plan-selection", { name: "sel-additionalProperties-at-depth", comment: "GEN §4.5.3: a /envs/* wildcard plan matches a concrete /envs/prod keyed array", schema: AP_DEEP, original: { envs: { prod: [{ id: "a", v: 1 }] } }, modified: { envs: { prod: [{ id: "a", v: 2 }] } }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-additionalProperties-top-level", comment: "GEN §4.5.3: a TOP-LEVEL /* plan matches a root object's member array /foo", schema: AP_TOPLEVEL, original: { foo: [{ id: "a", v: 1 }] }, modified: { foo: [{ id: "a", v: 2 }] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-allOf-merged-primary-key", comment: "CORE §3.5.1.1: a primaryKey declared only in an allOf branch is detected", schema: ALLOF_KEY, original: { list: [{ id: "a", name: "A" }] }, modified: { list: [{ id: "a", name: "A2" }] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-typeless-schema-node", comment: "CORE §3.3.1: nodes with properties/items but no `type` are still traversed -> keyed", schema: TYPELESS, original: { list: [{ id: "a", v: 1 }, { id: "b", v: 2 }] }, modified: { list: [{ id: "a", v: 9 }, { id: "b", v: 2 }] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-basePath-relativized", comment: "CORE §3.6.2: basePath '/config' relativizes the plan key to '/servers'; diffing the subtree matches", schema: BASEPATH_SCHEMA, planOpts: { basePath: "/config" }, original: { servers: [{ id: "a", v: 1 }] }, modified: { servers: [{ id: "a", v: 2 }] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-primaryKeyCandidates-override", comment: "CORE §3.5.5: primaryKeyCandidates ['sku'] selects a key the default list would miss", schema: SKU_SCHEMA, planOpts: { primaryKeyCandidates: ["sku"] }, original: { rows: [{ sku: "s1", qty: 1 }] }, modified: { rows: [{ sku: "s1", qty: 2 }] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-primaryKeyCandidates-default-misses-sku", comment: "CORE §3.5.5: without the option, 'sku' is not a default candidate -> LCS", schema: SKU_SCHEMA, original: { rows: [{ sku: "s1", qty: 1 }] }, modified: { rows: [{ sku: "s1", qty: 2 }] }, roundtrip: "exact" });
D("plan-selection", { name: "sel-primaryKeyCandidates-empty-disables", comment: "CORE §3.5.5: empty candidate list disables auto-detection even with a required id -> LCS", schema: PK_USERS, planOpts: { primaryKeyCandidates: [] }, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [{ id: "a", name: "A9" }, { id: "b", name: "B" }] }, roundtrip: "exact" });
D("plan-selection", { name: "sel-name-candidate-default", comment: "CORE §3.5.3: 'name' is a default candidate and is selected when required string", schema: NAME_SCHEMA, original: { rows: [{ name: "a", qty: 1 }] }, modified: { rows: [{ name: "a", qty: 2 }] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-nested-array-of-arrays-wildcard", comment: "CORE §3.3.5/GEN §4.5.2: outer array-of-arrays is LCS; inner /matrix/* keyed plan applies on descent", schema: MATRIX_SCHEMA, original: { matrix: [[{ id: "a", v: 1 }]] }, modified: { matrix: [[{ id: "a", v: 2 }]] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-exact-beats-wildcard", comment: "GEN §4.5.2: an exact property edge (/special keyed) wins over additionalProperties (wildcard lcs)", schema: EXACT_OVER_WILDCARD, original: { special: [{ id: "a", v: 1 }] }, modified: { special: [{ id: "a", v: 2 }] }, roundtrip: "multiset" });
D("plan-selection", { name: "sel-wildcard-sibling-is-lcs", comment: "GEN §4.5.2: a non-special member routes to the wildcard (plain) plan -> LCS", schema: EXACT_OVER_WILDCARD, original: { other: [{ q: 1 }, { q: 2 }] }, modified: { other: [{ q: 1 }, { q: 9 }] }, roundtrip: "exact" });

// --- diff/capabilities-include-old-value: CORE §4.4.2/CONF §5.2 includeOldValue=false suppresses oldValue ---
const IOV: Caps = { includeOldValue: false };
D("capabilities-include-old-value", { name: "iov-object-remove-no-oldvalue", comment: "CORE §4.4.2: remove carries no oldValue under includeOldValue=false", schema: null, capabilities: IOV, original: { a: 1, b: 2 }, modified: { a: 1 }, roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-object-replace-no-oldvalue", comment: "CORE §4.4.2: replace carries value but no oldValue", schema: null, capabilities: IOV, original: { a: 1 }, modified: { a: 2 }, roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-large-subtree-removal", comment: "CONF §5.2: removing a large subtree drops to a tiny op (no oldValue payload)", schema: null, capabilities: IOV, original: { big: { deep: [1, 2, 3, 4, 5], more: { x: "yyyyyyyy" } }, keep: 1 }, modified: { keep: 1 }, roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-array-lcs-remove", comment: "CORE §4.4.2: LCS remove suppresses oldValue", schema: null, capabilities: IOV, original: [1, 2, 3], modified: [1, 3], roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-kind-mismatch-replace", comment: "GEN §1.4/CORE §4.4.2: opaque-kind replace suppresses oldValue", schema: null, capabilities: IOV, original: { a: [1] }, modified: { a: 5 }, roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-primaryKey-removal", comment: "GEN §4/CORE §4.4.2: primaryKey removal suppresses oldValue", schema: PK_USERS, capabilities: IOV, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [{ id: "a", name: "A" }] }, roundtrip: "multiset" });
D("capabilities-include-old-value", { name: "iov-lcs-whole-item-replace", comment: "GEN §5/CORE §4.4.2: LCS whole-item (primitive) replace suppresses oldValue", schema: null, capabilities: IOV, original: [1], modified: [2], roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-unique-replace", comment: "GEN §6/CORE §4.4.2: unique positional replace suppresses oldValue", schema: UNIQ_TAGS, capabilities: IOV, original: { tags: ["a", "b", "c"] }, modified: { tags: ["a", "x", "c"] }, roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-add-unaffected", comment: "CORE §4.3.2: add never carries oldValue in either mode (identical to default)", schema: null, capabilities: IOV, original: {}, modified: { a: 1 }, roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-mixed-only-remove-replace-suppressed", comment: "CORE §4.4.2: only remove/replace lose oldValue; add and paths/values unchanged", schema: null, capabilities: IOV, original: { keep: 1, drop: 2, chg: 3 }, modified: { keep: 1, chg: 4, gain: 5 }, roundtrip: "exact" });
D("capabilities-include-old-value", { name: "iov-granular-descent-honored", comment: "CONF §5.2: nested ops from granular descent also honor the flag", schema: null, capabilities: IOV, original: [{ a: 1, b: 2 }], modified: [{ a: 1 }], roundtrip: "exact" });

// --- diff/capabilities-emit-moves: GEN §8/CONF §5.4 emitMoves — relocations become moves, all strategies exact ---
const EM: Caps = { emitMoves: true };
const EM_IOV: Caps = { emitMoves: true, includeOldValue: false };
D("capabilities-emit-moves", { name: "em-lcs-relocation-primitive", comment: "GEN §8.5: a relocated deep-equal element becomes a single move (front->back)", schema: null, capabilities: EM, original: [1, 2, 3, 4], modified: [2, 3, 4, 1], roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-lcs-relocation-object", comment: "GEN §8.5: an object element relocated intact becomes a move (no value/oldValue)", schema: null, capabilities: EM, original: [{ id: "x", n: 1 }, { id: "y", n: 2 }, { id: "z", n: 3 }], modified: [{ id: "y", n: 2 }, { id: "z", n: 3 }, { id: "x", n: 1 }], roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-lcs-non-relocation-stays-replace", comment: "GEN §8.5: a changed (non-identical) element is NOT a move; stays a replace", schema: null, capabilities: EM, original: [1, 2], modified: [1, 9], roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-unique-rotation", comment: "GEN §8.6: a multiset-equal unique reorder collapses to moves (5 replaces -> moves)", schema: UNIQ_NUMS, capabilities: EM, original: { tags: [1, 2, 3, 4, 5] }, modified: { tags: [2, 3, 4, 5, 1] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-unique-non-multiset-keeps-replaces", comment: "GEN §8.6: a non-permutation unique diff keeps GEN §6 positional replaces", schema: UNIQ_NUMS, capabilities: EM, original: { tags: [1, 2, 3] }, modified: { tags: [1, 9, 3] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-primaryKey-reorder-exact", comment: "GEN §8.7: primaryKey survivors reordered via moves -> exact order (upgrades CORE §7.2 to CORE §7.4)", schema: PK_USERS, capabilities: EM, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] }, modified: { users: [{ id: "c", name: "C" }, { id: "a", name: "A" }, { id: "b", name: "B" }] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-primaryKey-reorder-and-modify", comment: "GEN §8.7: reordered survivors plus a field change, exact order", schema: PK_USERS, capabilities: EM, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] }, modified: { users: [{ id: "c", name: "C" }, { id: "b", name: "B2" }, { id: "a", name: "A" }] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-primaryKey-indexed-add", comment: "GEN §8.7: a new key is an INDEXED add at its modified position (never /-)", schema: PK_USERS, capabilities: EM, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [{ id: "b", name: "B" }, { id: "n", name: "N" }, { id: "a", name: "A" }] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-primaryKey-full-mixed", comment: "GEN §8.7: reorder + modify + add + remove together reconstruct modified exactly", schema: PK_USERS, capabilities: EM, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }] }, modified: { users: [{ id: "c", name: "C2" }, { id: "a", name: "A" }, { id: "e", name: "E" }] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-primaryKey-duplicate-content-distinct-keys", comment: "GEN §8.7: items with duplicate non-key content but distinct keys reorder exactly", schema: PK_USERS, capabilities: EM, original: { users: [{ id: "a", name: "SAME" }, { id: "b", name: "SAME" }, { id: "c", name: "SAME" }] }, modified: { users: [{ id: "c", name: "SAME" }, { id: "b", name: "SAME" }, { id: "a", name: "SAME" }] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-compose-with-include-old-value-false", comment: "CONF §5.4: emitMoves composes with includeOldValue=false (moves already carry none; replaces drop oldValue)", schema: PK_USERS, capabilities: EM_IOV, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] }, modified: { users: [{ id: "c", name: "C2" }, { id: "a", name: "A" }, { id: "b", name: "B" }] }, roundtrip: "exact" });
D("capabilities-emit-moves", { name: "em-gate-failure-uses-lcs-moves", comment: "GEN §8.7: a gate-failing keyed array falls back to LCS, which under emitMoves uses GEN §8.5", schema: PK_USERS, capabilities: EM, original: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, modified: { users: [99, { id: "a", name: "A" }, { id: "b", name: "B" }] }, roundtrip: "exact" });

// --- diff/capabilities-wholesale: GEN §9/CONF §5.5 wholesaleReplaceFallback — size-capped cutover ---
const WRF: Caps = { wholesaleReplaceFallback: true };
const WRF_IOV: Caps = { wholesaleReplaceFallback: true, includeOldValue: false };
const ARR_STR_SCHEMA = { type: "object", properties: { a: { type: "array", items: { type: "string" } } } };
const REWRITE_SCHEMA = { type: "object", properties: { a: { type: "array", items: { type: "object", properties: { t: { type: "string" }, d: { type: "string" }, s: { type: "number" } } } } } };
const rewriteOrig = { a: Array.from({ length: 4 }, (_, i) => ({ t: `T${i}`, d: "x".repeat(20), s: i })) };
const rewriteMod = { a: Array.from({ length: 4 }, (_, i) => ({ t: `Q${i + 9}`, d: "x".repeat(20), s: i + 100 })) };
const smallOrig = { a: Array.from({ length: 6 }, (_, i) => ({ t: `T${i}`, d: "y".repeat(20), s: i })) };
const smallMod = { a: Array.from({ length: 6 }, (_, i) => ({ t: `T${i}`, d: "y".repeat(20), s: i === 2 ? 999 : i })) };
D("capabilities-wholesale", { name: "wrf-estimate-equals-threshold-keeps-granular", comment: "GEN §9.3: estimate(43) == threshold(43); strict > false, so the granular replace is KEPT", schema: ARR_STR_SCHEMA, capabilities: WRF_IOV, original: { a: ["AAAAAAAAAAA", "u1ccccccccc", "u2ccccccccc"] }, modified: { a: ["BBBBBBBBBBB", "u1ccccccccc", "u2ccccccccc"] }, roundtrip: "exact" });
D("capabilities-wholesale", { name: "wrf-estimate-exceeds-by-one-goes-wholesale", comment: "GEN §9.3: same shape, one unchanged element 1 byte shorter -> threshold(42) < estimate(43) -> WHOLESALE replace of /a", schema: ARR_STR_SCHEMA, capabilities: WRF_IOV, original: { a: ["AAAAAAAAAAA", "u1ccccccccc", "u2cccccccc"] }, modified: { a: ["BBBBBBBBBBB", "u1ccccccccc", "u2cccccccc"] }, roundtrip: "exact" });
D("capabilities-wholesale", { name: "wrf-full-rewrite-triggers", comment: "GEN §9.3: a no-common-element full rewrite (8 granular ops) exceeds the array size -> one whole-array replace", schema: REWRITE_SCHEMA, capabilities: WRF, original: rewriteOrig, modified: rewriteMod, roundtrip: "exact" });
D("capabilities-wholesale", { name: "wrf-full-rewrite-no-oldvalue", comment: "CONF §5.5: the wholesale replace itself honors includeOldValue=false (no oldValue)", schema: REWRITE_SCHEMA, capabilities: WRF_IOV, original: rewriteOrig, modified: rewriteMod, roundtrip: "exact" });
D("capabilities-wholesale", { name: "wrf-off-default-is-granular", comment: "GEN §9: with the capability OFF, the same rewrite stays a granular op stream (byte-stability baseline)", schema: REWRITE_SCHEMA, original: rewriteOrig, modified: rewriteMod, roundtrip: "exact" });
D("capabilities-wholesale", { name: "wrf-small-diff-keeps-granular", comment: "GEN §9.3: a one-field change in a 6-item array stays far under threshold -> granular kept", schema: REWRITE_SCHEMA, capabilities: WRF, original: smallOrig, modified: smallMod, roundtrip: "exact" });
const NESTED_ARR_SCHEMA = { type: "object", properties: { outer: { type: "array", items: { type: "object", properties: { id: { type: "string" }, inner: { type: "array", items: { type: "string" } } } } } } };
D("capabilities-wholesale", { name: "wrf-nested-inner-triggers-outer-keeps", comment: "GEN §9.1 bottom-up: the inner array crosses its own threshold and goes wholesale while the outer array keeps granular descent", schema: NESTED_ARR_SCHEMA, capabilities: WRF_IOV, original: { outer: [{ id: "g", inner: ["AAAAAAAAAAA", "u1ccccccccc", "u2cccccccc"] }, { id: "h", inner: ["z"] }] }, modified: { outer: [{ id: "g", inner: ["BBBBBBBBBBB", "u1ccccccccc", "u2cccccccc"] }, { id: "h", inner: ["z"] }] }, roundtrip: "exact" });

// --- diff/capabilities-ignore-paths: GEN §10/CONF §5.6 ignorePaths — subtrees treated as equal ---
// Round-trip is checked modulo the ignored subtrees (CORE §7.6): a vector whose
// ignored fields DRIFT reconstructs `modified` only up to the ignore projection,
// so its self-check uses roundtrip:"none" (structural op equality is the gate,
// and apply is cross-checked by the differential corpus). A vector with no
// ignored drift stays exact. Construction-time validation errors (GEN §10.1/
// GEN §10.7) are not expressible as diff vectors and live in the engine unit tests
// (CONF §6.2: test/ignore-paths.test.ts, go/ignore_paths_test.go).
const IP_TS = (paths: string[]): Caps => ({ ignorePaths: paths });
const PK_USERS_TS = { type: "object", properties: { users: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, updatedAt: { type: "number" } }, required: ["id"] } } } };
const LCS_ITEMS_TS = { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { v: { type: "string" }, ts: { type: "number" } } } } } };
const UNIQ_PLUS_META = { type: "object", properties: { tags: { type: "array", items: { type: "string" } }, meta: { type: "object", properties: { ts: { type: "number" } } } } };
const RW_TS_SCHEMA = { type: "object", properties: { a: { type: "array", items: { type: "object", properties: { t: { type: "string" }, ts: { type: "number" } } } } } };
D("capabilities-ignore-paths", { name: "ip-object-member-ignored-noop", comment: "GEN §10.4: an ignored object member changing alone yields NO ops", schema: null, capabilities: IP_TS(["/meta/ts"]), original: { meta: { ts: 1, n: "a" } }, modified: { meta: { ts: 2, n: "a" } }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-object-member-real-change-survives", comment: "GEN §10.4: a real sibling change survives while the ignored member is suppressed", schema: null, capabilities: IP_TS(["/meta/ts"]), original: { meta: { ts: 1, n: "a" } }, modified: { meta: { ts: 2, n: "b" } }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-real-change-no-ignored-drift-exact", comment: "CORE §7.6: with the ignored field unchanged, reconstruction is exact", schema: null, capabilities: IP_TS(["/meta/ts"]), original: { meta: { ts: 1, n: "a" } }, modified: { meta: { ts: 1, n: "b" } }, roundtrip: "exact" });
D("capabilities-ignore-paths", { name: "ip-wildcard-any-member-at-level", comment: "GEN §10.3: a `/*/ts` wildcard ignores `ts` under any top-level member", schema: null, capabilities: IP_TS(["/*/ts"]), original: { a: { ts: 1 }, b: { ts: 1, k: 2 } }, modified: { a: { ts: 9 }, b: { ts: 9, k: 3 } }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-modified-only-ignored-member-not-added", comment: "GEN §10.4: a modified-only ignored member emits no add", schema: null, capabilities: IP_TS(["/meta/ts"]), original: { meta: {} }, modified: { meta: { ts: 5 } }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-whole-array-ignored-noop", comment: "GEN §10.4: ignoring `/arr` treats the whole array as equal -> no ops", schema: null, capabilities: IP_TS(["/arr"]), original: { arr: [1, 2, 3] }, modified: { arr: [4, 5] }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-every-element-ignored-noop", comment: "GEN §10.4: `/arr/*` ignores every element (item node terminal) -> no ops", schema: null, capabilities: IP_TS(["/arr/*"]), original: { arr: [{ a: 1 }] }, modified: { arr: [{ a: 2 }, { b: 3 }] }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-lcs-ignored-field-only-noop", comment: "GEN §10.5: LCS items differing only in an ignored field intern equal -> no ops", schema: LCS_ITEMS_TS, capabilities: IP_TS(["/items/*/ts"]), original: { items: [{ v: "a", ts: 1 }, { v: "b", ts: 1 }] }, modified: { items: [{ v: "a", ts: 9 }, { v: "b", ts: 1 }] }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-lcs-real-and-ignored-mixed", comment: "GEN §10.5: a real field change descends granularly; ignored drift is dropped", schema: LCS_ITEMS_TS, capabilities: IP_TS(["/items/*/ts"]), original: { items: [{ v: "a", ts: 1 }] }, modified: { items: [{ v: "A", ts: 9 }] }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-pk-wildcard-under-keyed-items", comment: "GEN §10.3: `/users/*/updatedAt` ignores updatedAt in each keyed item", schema: PK_USERS_TS, capabilities: IP_TS(["/users/*/updatedAt"]), original: { users: [{ id: "a", name: "A", updatedAt: 1 }, { id: "b", name: "B", updatedAt: 1 }] }, modified: { users: [{ id: "a", name: "A", updatedAt: 2 }, { id: "b", name: "B", updatedAt: 1 }] }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-pk-real-field-survives-ignored-drift", comment: "GEN §10.3/GEN §10.5: a keyed item's real field change survives while updatedAt drifts", schema: PK_USERS_TS, capabilities: IP_TS(["/users/*/updatedAt"]), original: { users: [{ id: "a", name: "A", updatedAt: 1 }] }, modified: { users: [{ id: "a", name: "A2", updatedAt: 2 }] }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-unique-coexists-with-unrelated-ignore", comment: "GEN §10: an unrelated ignore leaves a unique array's positional replaces intact", schema: UNIQ_PLUS_META, capabilities: IP_TS(["/meta/ts"]), original: { tags: ["a", "b"], meta: { ts: 1 } }, modified: { tags: ["a", "x"], meta: { ts: 2 } }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-emitmoves-move-pairing-with-drift", comment: "GEN §10.5: under emitMoves, a relocated item whose ignored field drifted is ONE move, not remove+add", schema: LCS_ITEMS_TS, capabilities: { emitMoves: true, ignorePaths: ["/items/*/ts"] }, original: { items: [{ v: "X", ts: 1 }, { v: "Y", ts: 1 }] }, modified: { items: [{ v: "Y", ts: 9 }, { v: "X", ts: 1 }] }, roundtrip: "none" });
D("capabilities-ignore-paths", { name: "ip-wholesale-disabled-by-ignore-beneath", comment: "GEN §10.6: wholesaleReplaceFallback is DISABLED for an array with an ignore path beneath it (no leaked ignored content)", schema: RW_TS_SCHEMA, capabilities: { wholesaleReplaceFallback: true, ignorePaths: ["/a/*/ts"] }, original: { a: [{ t: "AAAAAAAAAA", ts: 1 }, { t: "BBBBBBBBBB", ts: 2 }] }, modified: { a: [{ t: "ZZZZZZZZZZ", ts: 5 }, { t: "YYYYYYYYYY", ts: 6 }] }, roundtrip: "none" });

// ===========================================================================
// PLAN-SNAPSHOT VECTORS (CONF §7): buildPlan derivation, falsifiable per-path.
// ===========================================================================
const PLAN_LCS_OBJ = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { q: { type: "number" } } } } } };
const PLAN_ANYOF = { type: "object", properties: { list: { type: "array", items: { anyOf: [{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }, { type: "object", properties: { q: { type: "number" } } }] } } } };
const PLAN_ONEOF = { type: "object", properties: { list: { type: "array", items: { oneOf: [{ type: "object", properties: { code: { type: "string" } } }, { type: "object", properties: { id: { type: "number" } }, required: ["id"] }] } } } };
const PLAN_HASH_MULTI = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, port: { type: "number" } }, required: ["id", "name", "port"] } } } };
const PLAN_HASH_EXCLUDES = { type: "object", properties: { rows: { type: "array", items: { type: "object", properties: { id: { type: "string" }, meta: { type: "object" } }, required: ["id", "meta"] } } } };
const PLAN_ROOT_ARRAY = { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const PLAN_MERGE_ANYOF = { type: "object", anyOf: [{ properties: { list: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } } }, { properties: { list: { type: "array", items: { type: "object", properties: { q: { type: "number" } } } } } }] };
const PLAN_LOCAL_REF = { $defs: { item: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, type: "object", properties: { list: { type: "array", items: { $ref: "#/$defs/item" } } } };
const PLAN_NONLOCAL_REF = { type: "object", properties: { list: { type: "array", items: { $ref: "http://example.com/item" } } } };

P("schema-derivation", { name: "plan-primaryKey-id", comment: "CORE §3.5.3: default candidate 'id' selected; requiredFields/hashFields populated", schema: PK_USERS });
P("schema-derivation", { name: "plan-primaryKey-name", comment: "CORE §3.5.3: 'name' is a default candidate", schema: NAME_SCHEMA });
P("schema-derivation", { name: "plan-primaryKey-numeric-id", comment: "CORE §3.5.3: a number-typed id still qualifies", schema: PK_USERS_NUM });
P("schema-derivation", { name: "plan-unique-primitive-items", comment: "CORE §3.4.2: string item schema -> unique strategy, no primaryKey", schema: UNIQ_TAGS });
P("schema-derivation", { name: "plan-lcs-plain-objects", comment: "CORE §3.4.1: object items with no candidate key -> lcs", schema: PLAN_LCS_OBJ });
P("schema-derivation", { name: "plan-allOf-merge-key", comment: "CORE §3.5.1.1: a key declared only in an allOf branch is detected", schema: ALLOF_KEY });
P("schema-derivation", { name: "plan-anyOf-first-branch-key", comment: "CORE §3.5.1: anyOf branches examined in order; first branch yielding a key wins", schema: PLAN_ANYOF });
P("schema-derivation", { name: "plan-oneOf-branch-key", comment: "CORE §3.5.1: oneOf branch order; the keyed branch supplies the primaryKey", schema: PLAN_ONEOF });
P("schema-derivation", { name: "plan-additionalProperties-wildcard-at-depth", comment: "CORE §3.3.2: additionalProperties registers a /envs/* wildcard array plan", schema: AP_DEEP });
P("schema-derivation", { name: "plan-additionalProperties-top-level", comment: "CORE §3.3.2: a top-level additionalProperties array -> /* plan", schema: AP_TOPLEVEL });
P("schema-derivation", { name: "plan-nested-arrays-distinct-paths", comment: "CORE §3.3.5: array-of-arrays gives outer /matrix (lcs) and inner /matrix/* (keyed) distinct paths", schema: MATRIX_SCHEMA });
P("schema-derivation", { name: "plan-nested-keyed-arrays", comment: "CORE §3.3.3: keyed array within keyed array -> /groups and /groups/members", schema: PK_NESTED });
P("schema-derivation", { name: "plan-typeless-node-traversed", comment: "CORE §3.3.1: nodes with properties/items but no `type` are still traversed", schema: TYPELESS });
P("schema-derivation", { name: "plan-hashFields-multiple-required", comment: "CORE §3.5.4: hashFields = required string/number fields (sorted, order-insensitive compare)", schema: PLAN_HASH_MULTI });
P("schema-derivation", { name: "plan-hashFields-excludes-non-primitive", comment: "CORE §3.5.4: a required object-typed field is in requiredFields but NOT hashFields", schema: PLAN_HASH_EXCLUDES });
P("schema-derivation", { name: "plan-root-level-array", comment: "GEN §4.5.1: a root array schema registers at path '' (empty key)", schema: PLAN_ROOT_ARRAY });
P("schema-derivation", { name: "plan-basePath-relativized", comment: "CORE §3.6.2: basePath '/config' relativizes the key to '/servers'", schema: BASEPATH_SCHEMA, planOpts: { basePath: "/config" } });
P("schema-derivation", { name: "plan-primaryKeyMap-override", comment: "CORE §3.4.3: primaryKeyMap sets primaryKey+strategy without auto-detect (no requiredFields/hashFields)", schema: ITEMS_PLAIN, planOpts: { primaryKeyMap: { "/items": "id" } } });
P("schema-derivation", { name: "plan-primaryKeyCandidates-override-sku", comment: "CORE §3.5.5: candidate list ['sku'] selects a non-default key", schema: SKU_SCHEMA, planOpts: { primaryKeyCandidates: ["sku"] } });
P("schema-derivation", { name: "plan-primaryKeyCandidates-empty-disables", comment: "CORE §3.5.5: empty candidate list -> no auto-detected key, base lcs strategy", schema: PK_USERS, planOpts: { primaryKeyCandidates: [] } });

P("references-and-merge", { name: "plan-merge-anyOf-ranking", comment: "CORE §3.7.1: same /list reached via two anyOf branches; primaryKey(3) outranks lcs(1)", schema: PLAN_MERGE_ANYOF });
P("references-and-merge", { name: "plan-local-ref-resolved", comment: "CORE §3.3.4: a local #/$defs/item $ref is resolved -> keyed plan", schema: PLAN_LOCAL_REF });
P("references-and-merge", { name: "plan-non-local-ref-skipped", comment: "CORE §3.3.4: a non-local $ref is unresolvable; the array falls back to lcs (no key)", schema: PLAN_NONLOCAL_REF });

// ===========================================================================
// INVERT VECTORS (CONF §8): expectedInverse = invertPatch(ORIGINAL document, patch)
// The generator verifies clause (b): apply(apply(doc, patch), inverse) == doc.
// ===========================================================================
// --- invert/basic: adds / removes / replaces / root ops ---
I("invert-basic", { name: "inv-add-new-member", comment: "CORE §6.2: add of a new object member inverts to remove", document: { a: 1 }, patch: [{ op: "add", path: "/b", value: 2 }] });
I("invert-basic", { name: "inv-add-new-array-index", comment: "CORE §6.2: add at a new array index inverts to remove at that index", document: [1, 2], patch: [{ op: "add", path: "/2", value: 3 }] });
I("invert-basic", { name: "inv-add-append-dash", comment: "CORE §6.1.1/CORE §6.2: /- append inverts to remove at the resolved concrete index", document: [1, 2], patch: [{ op: "add", path: "/-", value: 3 }] });
I("invert-basic", { name: "inv-add-overwrite-member", comment: "CORE §6.2: add OVERWRITING an existing member inverts to replace restoring the pre-op value", document: { a: 1 }, patch: [{ op: "add", path: "/a", value: 9 }] });
I("invert-basic", { name: "inv-remove-member-no-oldvalue", comment: "CORE §6.2: remove (no oldValue) inverts to add with the value recovered from the document", document: { a: 1, b: 2 }, patch: [{ op: "remove", path: "/b" }] });
I("invert-basic", { name: "inv-remove-array-element", comment: "CORE §6.2: array remove inverts to add restoring the spliced element", document: [1, 2, 3], patch: [{ op: "remove", path: "/1" }] });
I("invert-basic", { name: "inv-remove-subtree-no-oldvalue", comment: "CORE §6.1.1: a whole-subtree remove is recovered from the document even without oldValue", document: { a: { deep: [1, 2] }, keep: 0 }, patch: [{ op: "remove", path: "/a" }] });
I("invert-basic", { name: "inv-replace-member", comment: "CORE §6.2: replace inverts to replace restoring the pre-op value", document: { a: 1 }, patch: [{ op: "replace", path: "/a", value: 9 }] });
I("invert-basic", { name: "inv-replace-array-element", comment: "CORE §6.2: array replace inverts to replace at the same index", document: [1, 2], patch: [{ op: "replace", path: "/0", value: 9 }] });
I("invert-basic", { name: "inv-replace-with-oldvalue-present", comment: "CORE §6.2.2: oldValue is sufficient but not necessary; inverse recovered from the document", document: { a: { x: 1 } }, patch: [{ op: "replace", path: "/a", value: 2, oldValue: { x: 1 } }] });
I("invert-basic", { name: "inv-root-add-replaces-document", comment: "CORE §5.5.1/CORE §6.2: add at '' replaces the whole document; inverts to replace '' restoring the root", document: { a: 1 }, patch: [{ op: "add", path: "", value: { b: 2 } }] });
I("invert-basic", { name: "inv-root-replace", comment: "CORE §6.2: replace at '' inverts to replace '' with the pre-op root", document: [1, 2], patch: [{ op: "replace", path: "", value: "x" }] });
I("invert-basic", { name: "inv-add-nested-member", comment: "CORE §6.2: nested add inverts to nested remove", document: { a: {} }, patch: [{ op: "add", path: "/a/b", value: 1 }] });

// --- invert/moves-copies: move/copy incl. overwrite cases ---
I("invert-moves-copies", { name: "inv-move-member", comment: "CORE §6.2: move inverts to the reverse move (from<->path)", document: { a: 1, keep: 0 }, patch: [{ op: "move", from: "/a", path: "/b" }] });
I("invert-moves-copies", { name: "inv-move-array-element", comment: "CORE §6.2: array move inverts to the reverse move", document: [1, 2, 3], patch: [{ op: "move", from: "/0", path: "/2" }] });
I("invert-moves-copies", { name: "inv-move-overwrite-member", comment: "CORE §6.2: move overwriting an existing member inverts to reverse move + restore the overwritten value", document: { a: 1, b: 2 }, patch: [{ op: "move", from: "/a", path: "/b" }] });
I("invert-moves-copies", { name: "inv-copy-member", comment: "CORE §6.2: copy of a value to a new member inverts to remove", document: { a: 1 }, patch: [{ op: "copy", from: "/a", path: "/b" }] });
I("invert-moves-copies", { name: "inv-copy-overwrite-member", comment: "CORE §6.2: copy overwriting an existing member inverts to replace restoring it", document: { a: 1, b: 2 }, patch: [{ op: "copy", from: "/a", path: "/b" }] });
I("invert-moves-copies", { name: "inv-copy-array-append", comment: "CORE §6.1.1/CORE §6.2: copy to /- inverts to remove at the resolved index", document: [1, 2], patch: [{ op: "copy", from: "/0", path: "/-" }] });

// --- invert/sequences: sequences whose intermediate state matters (CORE §6.2 forward-simulation) ---
I("invert-sequences", { name: "inv-seq-add-then-replace", comment: "CORE §6.2: each inverse computed against the correct pre-op state, then reversed", document: { a: 1 }, patch: [{ op: "add", path: "/b", value: 2 }, { op: "replace", path: "/b", value: 3 }] });
I("invert-sequences", { name: "inv-seq-remove-then-readd-same-path", comment: "CORE §6.2: remove then add at the same path; intermediate state distinguishes the inverses", document: { a: 1 }, patch: [{ op: "remove", path: "/a" }, { op: "add", path: "/a", value: 9 }] });
I("invert-sequences", { name: "inv-seq-two-array-removes", comment: "CORE §6.2: two removes; inverses reversed reconstruct the original array", document: [10, 20, 30], patch: [{ op: "remove", path: "/2" }, { op: "remove", path: "/0" }] });
I("invert-sequences", { name: "inv-seq-non-trailing-dash-interleave", comment: "CORE §6.2.2: a /- append resolved mid-sequence, then a subsequent index op, inverts correctly", document: [10, 20], patch: [{ op: "add", path: "/-", value: 30 }, { op: "replace", path: "/2", value: 99 }] });
I("invert-sequences", { name: "inv-seq-add-remove-replace-mixed", comment: "CORE §6.2: mixed op sequence inverts as the reversed per-op inverses", document: { a: 1, b: 2 }, patch: [{ op: "remove", path: "/a" }, { op: "add", path: "/c", value: 3 }, { op: "replace", path: "/b", value: 9 }] });
I("invert-sequences", { name: "inv-seq-move-then-modify", comment: "CORE §6.2: move then edit the moved subtree; simulation tracks the live state", document: { a: { x: 1 }, keep: 0 }, patch: [{ op: "move", from: "/a", path: "/b" }, { op: "replace", path: "/b/x", value: 2 }] });
I("invert-sequences", { name: "inv-seq-with-test-passthrough", comment: "CORE §6.2: a test op is passed through unchanged in the inverse", document: { a: 1 }, patch: [{ op: "test", path: "/a", value: 1 }, { op: "replace", path: "/a", value: 2 }] });
I("invert-sequences", { name: "inv-seq-build-nested-object", comment: "CORE §6.2: building a nested object step by step inverts to staged removes", document: {}, patch: [{ op: "add", path: "/a", value: {} }, { op: "add", path: "/a/b", value: 1 }, { op: "add", path: "/a/c", value: 2 }] });
I("invert-sequences", { name: "inv-seq-generated-primaryKey-patch", comment: "CORE §7.3/CORE §6: a real generated keyed patch (mods ++ removals ++ /- appends) round-trips through invert", document: { users: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }] }, patch: [{ op: "replace", path: "/users/2/name", value: "C2", oldValue: "C" }, { op: "remove", path: "/users/1", oldValue: { id: "b", name: "B" } }, { op: "add", path: "/users/-", value: { id: "d", name: "D" } }] });

// ===========================================================================
// APPLY VECTORS (CONF §3): hand-authored oracle; the generator re-runs the
// reference applier against each as a self-check.
// ===========================================================================
// --- apply/rfc6902-appendix: RFC 6902 Appendix A equivalents ---
A("rfc6902-appendix", { name: "a1-add-object-member", comment: "RFC 6902 A.1: add an object member (CORE §5.3)", doc: { foo: "bar" }, patch: [{ op: "add", path: "/baz", value: "qux" }], expected: { foo: "bar", baz: "qux" } });
A("rfc6902-appendix", { name: "a2-add-array-element", comment: "RFC 6902 A.2: insert into an array, shifting (CORE §5.3)", doc: { foo: ["bar", "baz"] }, patch: [{ op: "add", path: "/foo/1", value: "qux" }], expected: { foo: ["bar", "qux", "baz"] } });
A("rfc6902-appendix", { name: "a3-remove-object-member", comment: "RFC 6902 A.3: remove an object member", doc: { baz: "qux", foo: "bar" }, patch: [{ op: "remove", path: "/baz" }], expected: { foo: "bar" } });
A("rfc6902-appendix", { name: "a4-remove-array-element", comment: "RFC 6902 A.4: splice out an array element", doc: { foo: ["bar", "qux", "baz"] }, patch: [{ op: "remove", path: "/foo/1" }], expected: { foo: ["bar", "baz"] } });
A("rfc6902-appendix", { name: "a5-replace-value", comment: "RFC 6902 A.5: replace an existing member value", doc: { baz: "qux", foo: "bar" }, patch: [{ op: "replace", path: "/baz", value: "boo" }], expected: { baz: "boo", foo: "bar" } });
A("rfc6902-appendix", { name: "a6-move-value", comment: "RFC 6902 A.6: move a value between objects (CORE §5.3)", doc: { foo: { bar: "baz", waldo: "fred" }, qux: { corge: "grault" } }, patch: [{ op: "move", from: "/foo/waldo", path: "/qux/thud" }], expected: { foo: { bar: "baz" }, qux: { corge: "grault", thud: "fred" } } });
A("rfc6902-appendix", { name: "a7-move-array-element", comment: "RFC 6902 A.7: move an array element (remove then add)", doc: { foo: ["all", "grass", "cows", "eat"] }, patch: [{ op: "move", from: "/foo/1", path: "/foo/3" }], expected: { foo: ["all", "cows", "eat", "grass"] } });
A("rfc6902-appendix", { name: "a8-test-success", comment: "RFC 6902 A.8: test ops that succeed leave the document unchanged", doc: { baz: "qux", foo: ["a", 2, "c"] }, patch: [{ op: "test", path: "/baz", value: "qux" }, { op: "test", path: "/foo/1", value: 2 }], expected: { baz: "qux", foo: ["a", 2, "c"] } });
A("rfc6902-appendix", { name: "a9-test-failure", comment: "RFC 6902 A.9: a failing test throws TEST_FAILED", doc: { baz: "qux" }, patch: [{ op: "test", path: "/baz", value: "bar" }], error: { code: "TEST_FAILED", index: 0 } });
A("rfc6902-appendix", { name: "a10-add-nested-member", comment: "RFC 6902 A.10: add a nested object member value", doc: { foo: "bar" }, patch: [{ op: "add", path: "/child", value: { grandchild: {} } }], expected: { foo: "bar", child: { grandchild: {} } } });
A("rfc6902-appendix", { name: "a11-ignore-unrecognized-fields", comment: "RFC 6902 A.11: unrecognized op fields are ignored", doc: { foo: "bar" }, patch: [{ op: "add", path: "/baz", value: "qux", xyz: 123 } as unknown as Operation], expected: { foo: "bar", baz: "qux" } });
A("rfc6902-appendix", { name: "a12-add-to-nonexistent-target", comment: "RFC 6902 A.12: add through a missing intermediate -> PATH_UNRESOLVABLE (CORE §5.2.2)", doc: { foo: "bar" }, patch: [{ op: "add", path: "/baz/bat", value: "qux" }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("rfc6902-appendix", { name: "a14-escape-ordering", comment: "RFC 6902 A.14: '/~01' decodes ~1->/ then ~0->~ = key '~1' (CORE §2.3)", doc: { "/": 9, "~1": 10 }, patch: [{ op: "test", path: "/~01", value: 10 }], expected: { "/": 9, "~1": 10 } });
A("rfc6902-appendix", { name: "a15-compare-string-vs-number", comment: "RFC 6902 A.15: 10 != \"10\"; test with no coercion fails (CORE §1.4.3)", doc: { "/": 9, "~1": 10 }, patch: [{ op: "test", path: "/~01", value: "10" }], error: { code: "TEST_FAILED", index: 0 } });
A("rfc6902-appendix", { name: "a16-add-array-value-at-dash", comment: "RFC 6902 A.16: add an array VALUE at /- appends the whole value (CORE §2.5)", doc: { foo: ["bar"] }, patch: [{ op: "add", path: "/foo/-", value: ["abc", "def"] }], expected: { foo: ["bar", ["abc", "def"]] } });

// --- apply/error-codes: one pinned scenario per PatchErrorCode (CORE §5.6) ---
A("error-codes", { name: "err-invalid-pointer-remove-dash", comment: "CORE §5.6/CORE §2.5: '-' final on a remove (write-side) -> INVALID_POINTER", doc: [1, 2], patch: [{ op: "remove", path: "/-" }], error: { code: "INVALID_POINTER", index: 0 } });
A("error-codes", { name: "err-invalid-pointer-leading-zero", comment: "CORE §2.6: a leading-zero array index on write-side -> INVALID_POINTER", doc: [1, 2], patch: [{ op: "replace", path: "/01", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });
A("error-codes", { name: "err-path-unresolvable-missing-member", comment: "CORE §5.2.2: replace of a nonexistent member -> PATH_UNRESOLVABLE", doc: { a: 1 }, patch: [{ op: "replace", path: "/b", value: 9 }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("error-codes", { name: "err-path-unresolvable-missing-intermediate", comment: "CORE §5.2.2: descending through a missing intermediate -> PATH_UNRESOLVABLE", doc: { a: 1 }, patch: [{ op: "add", path: "/x/y", value: 1 }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("error-codes", { name: "err-index-out-of-bounds-replace", comment: "CORE §5.3.1: replace index >= length -> INDEX_OUT_OF_BOUNDS", doc: [1, 2], patch: [{ op: "replace", path: "/5", value: 9 }], error: { code: "INDEX_OUT_OF_BOUNDS", index: 0 } });
A("error-codes", { name: "err-index-out-of-bounds-add", comment: "CORE §5.3.1: add index > length -> INDEX_OUT_OF_BOUNDS", doc: [1], patch: [{ op: "add", path: "/5", value: 9 }], error: { code: "INDEX_OUT_OF_BOUNDS", index: 0 } });
A("error-codes", { name: "err-test-failed", comment: "CORE §5.3: test value mismatch -> TEST_FAILED", doc: { a: 1 }, patch: [{ op: "test", path: "/a", value: 2 }], error: { code: "TEST_FAILED", index: 0 } });
A("error-codes", { name: "err-old-value-mismatch", comment: "CORE §5.4: validateOldValues with a stale oldValue -> OLD_VALUE_MISMATCH", doc: { a: 1 }, patch: [{ op: "replace", path: "/a", value: 2, oldValue: 9 }], options: { validateOldValues: true }, error: { code: "OLD_VALUE_MISMATCH", index: 0 } });
A("error-codes", { name: "err-invalid-operation-unknown-op", comment: "CORE §5.6: an unknown op -> INVALID_OPERATION", doc: { a: 1 }, patch: [{ op: "frobnicate", path: "/a" } as unknown as Operation], error: { code: "INVALID_OPERATION", index: 0 } });
A("error-codes", { name: "err-invalid-operation-missing-value", comment: "CORE §5.3.5: add missing `value` -> INVALID_OPERATION", doc: { a: 1 }, patch: [{ op: "add", path: "/b" } as unknown as Operation], error: { code: "INVALID_OPERATION", index: 0 } });
A("error-codes", { name: "err-invalid-operation-missing-from", comment: "CORE §5.3.5: move missing `from` -> INVALID_OPERATION", doc: { a: 1 }, patch: [{ op: "move", path: "/b" } as unknown as Operation], error: { code: "INVALID_OPERATION", index: 0 } });
A("error-codes", { name: "err-invalid-operation-remove-root", comment: "CORE §5.5.2: remove at '' -> INVALID_OPERATION", doc: { a: 1 }, patch: [{ op: "remove", path: "" }], error: { code: "INVALID_OPERATION", index: 0 } });
A("error-codes", { name: "err-invalid-operation-move-into-child", comment: "CORE §5.3.3: move where `from` is a proper prefix of `path` -> INVALID_OPERATION", doc: { a: { b: 1 } }, patch: [{ op: "move", from: "/a", path: "/a/b/c" }], error: { code: "INVALID_OPERATION", index: 0 } });
A("error-codes", { name: "err-unsafe-key-proto", comment: "CORE §5.6.1: a __proto__ write-side segment -> UNSAFE_KEY", doc: { a: 1 }, patch: [{ op: "add", path: "/__proto__/x", value: 1 }], error: { code: "UNSAFE_KEY", index: 0 } });

// --- apply/error-precedence: CORE §5.3.5 fixed check order (first applicable failure) ---
A("error-precedence", { name: "prec-missing-field-before-pointer", comment: "CORE §5.3.5(1 before 2): add missing value AND a malformed index -> INVALID_OPERATION, not INVALID_POINTER", doc: [1], patch: [{ op: "add", path: "/01" } as unknown as Operation], error: { code: "INVALID_OPERATION", index: 0 } });
A("error-precedence", { name: "prec-pointer-before-existence", comment: "CORE §5.3.5(2 before 3): a malformed array index outranks the target being out of range -> INVALID_POINTER", doc: [1], patch: [{ op: "replace", path: "/01", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });
A("error-precedence", { name: "prec-unsafe-key-before-existence", comment: "CORE §5.3.5(2 before 3): the UNSAFE_KEY guard is a pointer-stage check, ahead of existence", doc: { a: 1 }, patch: [{ op: "replace", path: "/__proto__", value: 1 }], error: { code: "UNSAFE_KEY", index: 0 } });
A("error-precedence", { name: "prec-existence-before-value", comment: "CORE §5.3.5(3 before 4): a nonexistent target outranks OLD_VALUE_MISMATCH -> PATH_UNRESOLVABLE", doc: { a: 1 }, patch: [{ op: "replace", path: "/b", value: 9, oldValue: 5 }], options: { validateOldValues: true }, error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("error-precedence", { name: "prec-index-bounds-before-value", comment: "CORE §5.3.5(2/3 before 4): an out-of-range index outranks the value check", doc: [1], patch: [{ op: "replace", path: "/5", value: 9, oldValue: 1 }], options: { validateOldValues: true }, error: { code: "INDEX_OUT_OF_BOUNDS", index: 0 } });
A("error-precedence", { name: "prec-later-op-index-reported", comment: "CORE §5.6.2: operationIndex is the 0-based index of the FAILING op", doc: { a: 1 }, patch: [{ op: "replace", path: "/a", value: 2 }, { op: "test", path: "/a", value: 99 }], error: { code: "TEST_FAILED", index: 1 } });

// --- apply/unsafe-key: CORE §5.6.1 prototype-pollution guard (write-side only) ---
A("unsafe-key", { name: "uk-proto-final", comment: "CORE §5.6.1: __proto__ as the final write-side segment -> UNSAFE_KEY", doc: { a: 1 }, patch: [{ op: "add", path: "/__proto__", value: 1 }], error: { code: "UNSAFE_KEY", index: 0 } });
A("unsafe-key", { name: "uk-proto-intermediate", comment: "CORE §5.6.1: __proto__ anywhere on the write-side path -> UNSAFE_KEY", doc: { a: 1 }, patch: [{ op: "add", path: "/__proto__/x", value: 1 }], error: { code: "UNSAFE_KEY", index: 0 } });
A("unsafe-key", { name: "uk-proto-deep", comment: "CORE §5.6.1: a nested __proto__ segment is still guarded", doc: { a: { b: 1 } }, patch: [{ op: "replace", path: "/a/__proto__", value: 1 }], error: { code: "UNSAFE_KEY", index: 0 } });
A("unsafe-key", { name: "uk-constructor-prototype", comment: "CORE §5.6.1: 'prototype' preceded by an existing 'constructor' -> UNSAFE_KEY", doc: { constructor: {} }, patch: [{ op: "add", path: "/constructor/prototype", value: 1 }], error: { code: "UNSAFE_KEY", index: 0 } });
A("unsafe-key", { name: "uk-constructor-prototype-intermediate", comment: "CORE §5.6.1: constructor/prototype guarded as an intermediate too (fires before existence, CORE §5.3.5)", doc: { constructor: {} }, patch: [{ op: "add", path: "/constructor/prototype/x", value: 1 }], error: { code: "UNSAFE_KEY", index: 0 } });
A("unsafe-key", { name: "uk-move-dest-proto", comment: "CORE §5.6.1: a move DESTINATION of __proto__ is a write-side segment -> UNSAFE_KEY", doc: { a: 1 }, patch: [{ op: "move", from: "/a", path: "/__proto__" }], error: { code: "UNSAFE_KEY", index: 0 } });
A("unsafe-key", { name: "uk-allowed-standalone-constructor", comment: "CORE §5.6.1: standalone 'constructor' is a legitimate key and MUST remain usable", doc: { a: 1 }, patch: [{ op: "add", path: "/constructor", value: 5 }], expected: { a: 1, constructor: 5 } });
A("unsafe-key", { name: "uk-allowed-standalone-prototype", comment: "CORE §5.6.1: 'prototype' NOT preceded by 'constructor' is a legitimate key", doc: { a: 1 }, patch: [{ op: "add", path: "/prototype", value: 5 }], expected: { a: 1, prototype: 5 } });
A("unsafe-key", { name: "uk-allowed-prototype-under-non-constructor", comment: "CORE §5.6.1: 'prototype' under a non-constructor parent is usable", doc: { a: {} }, patch: [{ op: "add", path: "/a/prototype", value: 5 }], expected: { a: { prototype: 5 } } });
A("unsafe-key", { name: "uk-readside-proto-unresolvable", comment: "CORE §5.6.1: read-side (test) __proto__ resolves by own-property -> PATH_UNRESOLVABLE, never UNSAFE_KEY", doc: { a: 1 }, patch: [{ op: "test", path: "/__proto__", value: {} }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("unsafe-key", { name: "uk-readside-move-source-proto", comment: "CORE §5.6.1: a move SOURCE of __proto__ is read-side -> PATH_UNRESOLVABLE", doc: { a: 1 }, patch: [{ op: "move", from: "/__proto__", path: "/b" }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });

// --- apply/append-token: the '-' append token semantics per op (CORE §2.5, CORE §5.3) ---
A("append-token", { name: "dash-add-nested-array", comment: "CORE §2.5: add at /- appends to a nested array", doc: { a: [1] }, patch: [{ op: "add", path: "/a/-", value: 2 }], expected: { a: [1, 2] } });
A("append-token", { name: "dash-add-root-array", comment: "CORE §2.5/CORE §4.2.1: add at /- appends at the array root", doc: [1], patch: [{ op: "add", path: "/-", value: 2 }], expected: [1, 2] });
A("append-token", { name: "dash-add-into-empty-array", comment: "CORE §2.5: /- on an empty array lands at index 0", doc: { a: [] }, patch: [{ op: "add", path: "/a/-", value: 9 }], expected: { a: [9] } });
A("append-token", { name: "dash-remove-invalid-pointer", comment: "CORE §2.5: '-' final on remove (write-side) -> INVALID_POINTER", doc: [1], patch: [{ op: "remove", path: "/-" }], error: { code: "INVALID_POINTER", index: 0 } });
A("append-token", { name: "dash-replace-invalid-pointer", comment: "CORE §2.5: '-' final on replace (write-side) -> INVALID_POINTER", doc: [1], patch: [{ op: "replace", path: "/-", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });
A("append-token", { name: "dash-test-read-side-unresolvable", comment: "CORE §2.5/CORE §5.3.1: '-' final on test (read-side) fails own-index resolution -> PATH_UNRESOLVABLE", doc: [1], patch: [{ op: "test", path: "/-", value: 1 }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("append-token", { name: "dash-move-source-read-side-unresolvable", comment: "CORE §2.5: '-' as a move SOURCE final (read-side) -> PATH_UNRESOLVABLE", doc: { a: [1], b: 2 }, patch: [{ op: "move", from: "/a/-", path: "/c" }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("append-token", { name: "dash-move-dest-appends", comment: "CORE §2.5/CORE §5.3: '-' as a move DESTINATION appends", doc: { a: [1], b: 2 }, patch: [{ op: "move", from: "/b", path: "/a/-" }], expected: { a: [1, 2] } });
A("append-token", { name: "dash-copy-dest-appends", comment: "CORE §2.5/CORE §5.3: '-' as a copy DESTINATION appends a clone", doc: { a: [1], b: 2 }, patch: [{ op: "copy", from: "/b", path: "/a/-" }], expected: { a: [1, 2], b: 2 } });
A("append-token", { name: "dash-non-final-invalid-pointer", comment: "CORE §2.5: '-' in a NON-final segment (write-side) -> INVALID_POINTER", doc: { a: [[1]] }, patch: [{ op: "add", path: "/a/-/0", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });

// --- apply/root-ops: whole-document operations at path '' (CORE §5.5) ---
A("root-ops", { name: "root-add-replaces-document", comment: "CORE §5.5.1: add at '' replaces the whole document", doc: { a: 1 }, patch: [{ op: "add", path: "", value: [1, 2] }], expected: [1, 2] });
A("root-ops", { name: "root-replace-document", comment: "CORE §5.5.1: replace at '' swaps the root (may change type)", doc: [1], patch: [{ op: "replace", path: "", value: { x: 1 } }], expected: { x: 1 } });
A("root-ops", { name: "root-replace-primitive-to-string", comment: "CORE §5.5.1: root type change primitive->string", doc: 1, patch: [{ op: "replace", path: "", value: "str" }], expected: "str" });
A("root-ops", { name: "root-remove-invalid", comment: "CORE §5.5.2: remove at '' -> INVALID_OPERATION", doc: { a: 1 }, patch: [{ op: "remove", path: "" }], error: { code: "INVALID_OPERATION", index: 0 } });
A("root-ops", { name: "root-test-success", comment: "CORE §5.3: test at '' against the whole document (key-order-insensitive) succeeds", doc: { a: 1, b: 2 }, patch: [{ op: "test", path: "", value: { b: 2, a: 1 } }], expected: { a: 1, b: 2 } });
A("root-ops", { name: "root-test-failure", comment: "CORE §5.3: test at '' mismatch -> TEST_FAILED", doc: { a: 1 }, patch: [{ op: "test", path: "", value: { a: 2 } }], error: { code: "TEST_FAILED", index: 0 } });
A("root-ops", { name: "root-empty-patch-noop", comment: "CORE §5.7.5: the empty patch returns the document unchanged", doc: { a: 1 }, patch: [], expected: { a: 1 } });
A("root-ops", { name: "root-copy-from-root", comment: "CORE §5.3: copy from '' clones the whole document into a member", doc: { a: 1 }, patch: [{ op: "add", path: "/self", value: null }, { op: "copy", from: "", path: "/self" }], expected: { a: 1, self: { a: 1, self: null } } });

// --- apply/oldvalue-validation: CORE §5.4 validateOldValues both outcomes ---
A("oldvalue-validation", { name: "val-replace-pass", comment: "CORE §5.4.1: matching oldValue passes validation", doc: { a: 1 }, patch: [{ op: "replace", path: "/a", value: 2, oldValue: 1 }], options: { validateOldValues: true }, expected: { a: 2 } });
A("oldvalue-validation", { name: "val-replace-fail", comment: "CORE §5.4.1: stale oldValue -> OLD_VALUE_MISMATCH (atomic abort)", doc: { a: 1 }, patch: [{ op: "replace", path: "/a", value: 2, oldValue: 9 }], options: { validateOldValues: true }, error: { code: "OLD_VALUE_MISMATCH", index: 0 } });
A("oldvalue-validation", { name: "val-remove-pass", comment: "CORE §5.4.1: remove with matching oldValue passes", doc: { a: 1, b: 2 }, patch: [{ op: "remove", path: "/a", oldValue: 1 }], options: { validateOldValues: true }, expected: { b: 2 } });
A("oldvalue-validation", { name: "val-remove-fail", comment: "CORE §5.4.1: remove with stale oldValue -> OLD_VALUE_MISMATCH", doc: { a: 1 }, patch: [{ op: "remove", path: "/a", oldValue: 9 }], options: { validateOldValues: true }, error: { code: "OLD_VALUE_MISMATCH", index: 0 } });
A("oldvalue-validation", { name: "val-skips-op-without-oldvalue", comment: "CORE §5.4.2: an op lacking oldValue is applied unchecked even when validation is on", doc: { a: 1 }, patch: [{ op: "replace", path: "/a", value: 2 }], options: { validateOldValues: true }, expected: { a: 2 } });
A("oldvalue-validation", { name: "val-off-ignores-oldvalue", comment: "CORE §5.4: with validation OFF, a stale oldValue is ignored", doc: { a: 1 }, patch: [{ op: "replace", path: "/a", value: 2, oldValue: 9 }], expected: { a: 2 } });
A("oldvalue-validation", { name: "val-add-unchecked", comment: "CORE §5.4.2: add never carries oldValue, so it is always unchecked", doc: {}, patch: [{ op: "add", path: "/a", value: 1 }], options: { validateOldValues: true }, expected: { a: 1 } });
A("oldvalue-validation", { name: "val-deep-oldvalue-match", comment: "CORE §5.4.1: oldValue comparison is deep (CORE §1.4.1), key-order-insensitive", doc: { a: { x: 1, y: 2 } }, patch: [{ op: "replace", path: "/a", value: 0, oldValue: { y: 2, x: 1 } }], options: { validateOldValues: true }, expected: { a: 0 } });

// --- apply/index-bounds: CORE §5.3.1 ranges + CORE §2.6 index syntax, write vs read side ---
A("index-bounds", { name: "idx-add-at-length-appends", comment: "CORE §5.3.1: add index == length appends", doc: [1, 2], patch: [{ op: "add", path: "/2", value: 3 }], expected: [1, 2, 3] });
A("index-bounds", { name: "idx-add-beyond-length", comment: "CORE §5.3.1: add index > length -> INDEX_OUT_OF_BOUNDS", doc: [1], patch: [{ op: "add", path: "/5", value: 9 }], error: { code: "INDEX_OUT_OF_BOUNDS", index: 0 } });
A("index-bounds", { name: "idx-replace-at-length", comment: "CORE §5.3.1: replace requires index < length", doc: [1, 2], patch: [{ op: "replace", path: "/2", value: 9 }], error: { code: "INDEX_OUT_OF_BOUNDS", index: 0 } });
A("index-bounds", { name: "idx-remove-at-length", comment: "CORE §5.3.1: remove requires index < length", doc: [1, 2], patch: [{ op: "remove", path: "/2" }], error: { code: "INDEX_OUT_OF_BOUNDS", index: 0 } });
A("index-bounds", { name: "idx-leading-zero-invalid", comment: "CORE §2.6: '01' is not a valid index (write-side) -> INVALID_POINTER", doc: [1, 2], patch: [{ op: "replace", path: "/01", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });
A("index-bounds", { name: "idx-plus-sign-invalid", comment: "CORE §2.6: '+1' is not a valid index -> INVALID_POINTER", doc: [1, 2], patch: [{ op: "replace", path: "/+1", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });
A("index-bounds", { name: "idx-decimal-invalid", comment: "CORE §2.6: '1.5' is not a valid index -> INVALID_POINTER", doc: [1, 2], patch: [{ op: "replace", path: "/1.5", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });
A("index-bounds", { name: "idx-negative-invalid", comment: "CORE §2.6: '-1' is a signed (malformed) index, not the '-' token -> INVALID_POINTER", doc: [1, 2], patch: [{ op: "replace", path: "/-1", value: 9 }], error: { code: "INVALID_POINTER", index: 0 } });
A("index-bounds", { name: "idx-test-oob-read-side", comment: "CORE §5.3.1: a test at an out-of-range index fails existence -> PATH_UNRESOLVABLE", doc: [1], patch: [{ op: "test", path: "/5", value: 1 }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("index-bounds", { name: "idx-test-leading-zero-read-side", comment: "CORE §2.6: a malformed index on read-side (test) -> PATH_UNRESOLVABLE, not INVALID_POINTER", doc: [1, 2], patch: [{ op: "test", path: "/01", value: 1 }], error: { code: "PATH_UNRESOLVABLE", index: 0 } });
A("index-bounds", { name: "idx-numeric-key-on-object", comment: "CORE §5.2.3: a decimal-digit segment against an OBJECT is a member key, not an index", doc: { "0": "x" }, patch: [{ op: "replace", path: "/0", value: "y" }], expected: { "0": "y" } });
A("index-bounds", { name: "idx-add-index-0-empty-array", comment: "CORE §5.3.1: add /0 to an empty array is index == length (append)", doc: [], patch: [{ op: "add", path: "/0", value: 9 }], expected: [9] });

// --- apply/options: behavioral options produce a value deep-equal to default mode (CORE §5.7.4) ---
A("options", { name: "opt-clone-values-value-equal", comment: "CORE §5.7.2: cloneValues yields the same document value (aliasing only differs)", doc: {}, patch: [{ op: "add", path: "/a", value: { n: 1 } }], options: { cloneValues: true }, expected: { a: { n: 1 } } });
A("options", { name: "opt-clone-result-value-equal", comment: "CORE §5.7.3: cloneResult yields the same document value (independent copy)", doc: { a: { x: 1 } }, patch: [{ op: "replace", path: "/a/x", value: 2 }], options: { cloneResult: true }, expected: { a: { x: 2 } } });
A("options", { name: "opt-clone-result-empty-patch", comment: "CORE §5.7.5/CORE §5.7.3: empty patch under cloneResult still returns the document value", doc: { a: 1 }, patch: [], options: { cloneResult: true }, expected: { a: 1 } });

// --- diff/primary-key-numeric-string: GEN §4.1.5 key equality — numeric N and string "N" are DISTINCT keys ---
// id is unconstrained ({}) so both a number and a string value satisfy the gate (GEN §4.3(a): string OR number).
const PK_ID_ANY = { type: "object", properties: { users: { type: "array", items: { type: "object", properties: { id: {}, name: { type: "string" } } } } } };
D("primary-key-numeric-string", { name: "pk-numeric-to-string-key-is-distinct-item", comment: "GEN §4.1.5: numeric key 1 and string key \"1\" are distinct (no coercion) — the numeric-keyed item is removed and the string-keyed item appended, never matched as an in-place edit", schema: PK_ID_ANY, planOpts: { primaryKeyMap: { "/users": "id" } }, original: { users: [{ id: 1, name: "A" }] }, modified: { users: [{ id: "1", name: "A" }] }, roundtrip: "multiset" });
D("primary-key-numeric-string", { name: "pk-numeric-and-string-key-coexist-reorder-noop", comment: "GEN §4.1.5/CORE §7.2.3: numeric 1 and string \"1\" coexist as distinct keys; a pure reorder of the two deep-equal-content items is order-insensitive under the default contract -> zero ops", schema: PK_ID_ANY, planOpts: { primaryKeyMap: { "/users": "id" } }, original: { users: [{ id: 1, name: "X" }, { id: "1", name: "X" }] }, modified: { users: [{ id: "1", name: "X" }, { id: 1, name: "X" }] }, roundtrip: "multiset" });
// CORE §1.2 pins f64 NUMBER equality for key identity: the literals 1 and 1.0 denote the SAME f64 and therefore the SAME primary key. A text-keyed implementation (matching on the raw numeric token) would wrongly see "1" and "1.0" as distinct keys and emit remove+add; the conforming engine matches them and emits a granular in-place field modification. (JSON serialisation normalises 1.0 -> 1, so the emitted key literal is 1 in both documents; the vector proves f64-value identity is what drives matching.)
D("primary-key-numeric-string", { name: "pk-numeric-key-f64-equal-differing-literal-modifies-in-place", comment: "CORE §1.2/GEN §4.1.5: primary keys 1 and 1.0 are equal at f64 -> the SAME key; the matched item's changed field is a granular in-place modification, NOT remove+add (a text-keyed impl would wrongly split them)", schema: PK_ID_ANY, planOpts: { primaryKeyMap: { "/users": "id" } }, original: { users: [{ id: 1, name: "a" }] }, modified: { users: [{ id: 1.0, name: "b" }] }, roundtrip: "multiset" });

// --- diff/key-order: CORE §1.3.2/GEN §2.2 pinned member order — integer-like keys ascending FIRST, then insertion order ---
// Keys authored OUT of numeric order and interleaved with string keys. A pure-insertion-order
// implementation would emit /b,/10,/2,/a and FAIL the CONF §4.2 ordering check; the pinned order is
// integer-like ascending (/2,/10) then remaining keys in insertion order (/b,/a).
D("key-order", { name: "keyorder-integer-like-ascending-first", comment: "CORE §1.3.2/GEN §2.2: object keys {b,\"10\",\"2\",a} all changed — pinned [[OwnPropertyKeys]] order emits integer-like keys ascending (/2,/10) BEFORE the remaining keys in insertion order (/b,/a); pure insertion order (/b,/10,/2,/a) fails CONF §4.2", schema: null, original: { b: 1, "10": 1, "2": 1, a: 1 }, modified: { b: 2, "10": 2, "2": 2, a: 2 } });
// modified-only integer-like keys also obey the pinned order within the second pass.
D("key-order", { name: "keyorder-modified-only-integer-like", comment: "GEN §2.2: original keys {b,\"5\"} visit as /5,/b (integer-like first); modified-only keys {\"3\",z} then visit as /3,/z (integer-like first) — two passes each in pinned order", schema: null, original: { b: 1, "5": 1 }, modified: { b: 2, "5": 2, "3": 9, z: 9 } });

// ===========================================================================
// EXTERNAL-REVIEW DEFECT ROUND (D1/D2/D4) — spec-v1-rc, 2026-07-14.
// These vectors pin the CORRECTED behavior for three defects the external
// review found in the reference engines. The engine fixes have LANDED, so each
// vector is now derived/self-checked against the (fixed) reference exactly like
// every other vector — no hand-pinning or self-check skips remain.
// ===========================================================================

// --- diff/kind-mismatch (D1): empty-array vs empty-object are DISTINCT (CORE §1.4.1/CORE §1.4.2) ---
// deepEqualMemo's empty-container fast path used to treat [] === {} (both zero keys), so the LCS
// trim (GEN §5.0) consumed both positions as "common" and emitted ZERO ops — silent wrong output.
// Fixed (src/performance/deepEqual.ts): an array-vs-object kind check precedes the fast path, so
// [] ≠ {} (CORE §1.4.2), interning distinguishes them, and Myers (GEN §5.2) finds the crossing common
// element (the empty containers appear on both sides at swapped indices, LCS length 1), yielding a
// remove+add pair that round-trips exactly (CORE §7.1). NOTE: a remove+add, not two positional replaces —
// Myers minimises the edit script and matches the equal empty containers rather than replacing
// element-for-element.
D("kind-mismatch", {
  name: "kindmismatch-empty-array-vs-empty-object-not-equal",
  comment: "CORE §1.4.1/CORE §1.4.2 (D1): [] ≠ {} — a zero-members fast path that skips the array-vs-object type check is non-conforming; diff {x:[[],{}]}->{x:[{},[]]} MUST NOT emit zero ops. LCS emits remove /x/0 + add /x/1 (Myers matches the equal empty containers at swapped indices, GEN §5.2).",
  schema: null,
  original: { x: [[], {}] },
  modified: { x: [{}, []] },
});

// --- apply/malformed-pointer (D2): a non-empty pointer without a leading "/" -> INVALID_POINTER (CORE §2.7) ---
// The TS applier's splitPath("foo") returned [] and so ALIASED "foo" to the root document:
// applyPatch({foo:1},[{op:"replace",path:"foo",value:2}]) returned 2 instead of rejecting. Fixed: CORE §2.7
// requires INVALID_POINTER on all six ops and for both `path` and `from`, read-side included.
A("malformed-pointer", { name: "ptr-replace-no-leading-slash-invalid", comment: "CORE §2.7 (D2): replace with path \"foo\" (no leading /) is a malformed whole-pointer -> INVALID_POINTER, NOT an alias to the root document", doc: { foo: 1 }, patch: [{ op: "replace", path: "foo", value: 2 } as unknown as Operation], error: { code: "INVALID_POINTER", index: 0 } });
A("malformed-pointer", { name: "ptr-add-no-leading-slash-invalid", comment: "CORE §2.7 (D2): add with path \"foo\" (no leading /) -> INVALID_POINTER", doc: { foo: 1 }, patch: [{ op: "add", path: "foo", value: 2 } as unknown as Operation], error: { code: "INVALID_POINTER", index: 0 } });
A("malformed-pointer", { name: "ptr-move-from-no-leading-slash-invalid", comment: "CORE §2.7 (D2): move whose `from` is \"foo\" (no leading /) -> INVALID_POINTER on the read-side source too (whole-pointer syntax error precedes read/write resolution)", doc: { foo: 1 }, patch: [{ op: "move", path: "/bar", from: "foo" } as unknown as Operation], error: { code: "INVALID_POINTER", index: 0 } });

// --- apply/test-required-value (D4): `test` MUST carry `value` (RFC 6902 §4.6, CORE §5.3/CORE §5.3.5) ---
// TS fell through to comparing against `undefined` and threw TEST_FAILED (wrong code); Go treated an
// absent value as null, so {op:"test",path:"/a"} on {a:null} wrongly PASSED. Fixed: missing
// `value` is a tier-1 required-field failure -> INVALID_OPERATION, BEFORE the read-side existence check.
A("test-required-value", { name: "test-missing-value-null-target-invalid", comment: "CORE §5.3/CORE §5.3.5 (D4): {op:test,path:/a} on {a:null} with NO `value` -> INVALID_OPERATION (tier 1), NOT a pass treating absent value as null (Go's bug) and NOT TEST_FAILED (TS's bug)", doc: { a: null }, patch: [{ op: "test", path: "/a" } as unknown as Operation], error: { code: "INVALID_OPERATION", index: 0 } });
A("test-required-value", { name: "test-missing-value-present-target-invalid", comment: "CORE §5.3/CORE §5.3.5 (D4): {op:test,path:/a} on {a:1} with NO `value` -> INVALID_OPERATION at tier 1, before any value comparison", doc: { a: 1 }, patch: [{ op: "test", path: "/a" } as unknown as Operation], error: { code: "INVALID_OPERATION", index: 0 } });
A("test-required-value", { name: "test-missing-value-absent-target-invalid", comment: "CORE §5.3.5 (D4): missing `value` (tier 1) precedes read-side non-existence (tier 3) -> INVALID_OPERATION, not PATH_UNRESOLVABLE", doc: { a: 1 }, patch: [{ op: "test", path: "/missing" } as unknown as Operation], error: { code: "INVALID_OPERATION", index: 0 } });

//<<THEMES>>

// ===========================================================================
// EMIT
// ===========================================================================
const OUT = import.meta.dir;
function writeGroup(category: string, files: Record<string, unknown[]>, build: (s: never) => unknown) {
  let total = 0;
  const names = Object.keys(files).sort();
  for (const file of names) {
    const records = files[file]!.map((s) => build(s as never));
    const path = join(OUT, category, `${file}.json`);
    writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
    total += records.length;
    console.log(`  ${category}/${file}.json  (${records.length})`);
  }
  console.log(`${category}: ${total} vectors in ${names.length} files`);
  return total;
}

for (const c of ["diff", "apply", "plan", "invert"])
  mkdirSync(join(OUT, c), { recursive: true });

console.log("Generating conformance vectors...");
const dTotal = writeGroup("diff", diffFiles, (s) => buildDiffRecord(s));
const aTotal = writeGroup("apply", applyFiles, (s) => buildApplyRecord(s));
const pTotal = writeGroup("plan", planFiles, (s) => buildPlanRecord(s));
const iTotal = writeGroup("invert", invertFiles, (s) => buildInvertRecord(s));
console.log(
  `\nTOTAL: ${dTotal} diff, ${aTotal} apply, ${pTotal} plan, ${iTotal} invert = ${
    dTotal + aTotal + pTotal + iTotal
  } vectors`,
);
