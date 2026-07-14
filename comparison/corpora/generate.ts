/**
 * comparison/corpora/generate.ts — seeded, deterministic shared-corpus generator.
 *
 * Regenerate with:  bun run comparison/corpora/generate.ts
 *
 * Emits comparison/corpora/cases/*.json (one file per case) plus a manifest.json
 * index. Every case is a self-describing document pair
 *
 *     { name, category, description, schema, options?, original, modified,
 *       roundtrip, measureMemory, tags }
 *
 * consumed IDENTICALLY by the TS benchmark runner (bench-v2/run.ts) and the Go
 * benchmark runner, so the two engines and every competitor library diff the
 * exact same corpora. `schema` + `options` let a schema-aware engine build its
 * plan; schema-blind competitors ignore them.
 *
 * DETERMINISM
 * -----------
 *  - The realistic cloud-config / e-commerce cases reuse the faker-driven
 *    generators in ../data-generators and ../ecommerceModifications. faker's
 *    global RNG is pinned with a single literal seed (SEED) and every generator
 *    is invoked in a FIXED order, so the faker stream — and therefore every
 *    generated document — is identical on every run. (Relative imports are
 *    load-bearing: importing the generators by absolute path spawns a duplicate
 *    faker module instance whose RNG our seed would not reach.)
 *  - The e-commerce generator additionally draws structural randomness (array
 *    lengths, optional-property presence) from json-schema-faker, whose RNG is
 *    Math.random by default and IGNORES faker's seed. We override it with a
 *    seeded mulberry32 PRNG via jsf.option({ random }) so those draws are pinned
 *    too. Without this the e-commerce case is non-reproducible.
 *  - Every synthetic case (keyed-array workloads, pathological LCS shapes, root
 *    arrays, deep nesting, pointer-escaping keys, duplicate keys) is built from
 *    pure index arithmetic with NO randomness at all.
 *
 * Re-running produces byte-identical files; a CI check can diff the tree.
 *
 * SIZING
 * ------
 * Pathological arrays top out at 100k primitive elements (~1.5 MB serialised)
 * so the committed corpus stays modest and the full TS bench run stays well
 * under ~5 minutes. Elements are short strings/objects, not deep trees.
 */
import { faker } from "@faker-js/faker";
import jsf from "json-schema-faker";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../../src/types";
import { createRandomCloudConfig } from "../data-generators";
import { applyModificationsForTargetComplexity } from "../modification-functions";
import {
  applyECommerceModificationsForTargetComplexity,
  generateRandomECommerceConfig,
} from "../ecommerceModifications";
import mainSchema from "../../schema/schema.json";
import ecommerceSchema from "../../schema/e-commerce.json";

// The single literal seed that pins every faker-driven document. Change it to
// intentionally resample the realistic corpus; leave it fixed for reproducible
// benchmark numbers.
const SEED = 20240521;

// ---------------------------------------------------------------------------
// Case model
// ---------------------------------------------------------------------------
type Options = {
  primaryKeyMap?: Record<string, string>;
  basePath?: string;
  primaryKeyCandidates?: string[];
  /**
   * ignorePaths capability (GEN §10): JSON Pointers whose subtrees the diff MUST
   * treat as equal. Passed to the JsonSchemaPatcher constructor (not buildPlan).
   * Round-trip verdicts for such a case are evaluated MODULO these subtrees
   * (CORE §7.6): apply(original, patch) equals modified everywhere except at a
   * matched ignore location, where it retains original's value.
   */
  ignorePaths?: string[];
};

type Roundtrip = "exact" | "multiset";

type CorpusCase = {
  /** Unique, filename-safe case id. */
  name: string;
  /** Grouping for the notebook: realistic | keyed | lcs | structural | edge | staleness. */
  category: string;
  /** One-line human description of the workload. */
  description: string;
  /** JSON Schema a schema-aware engine plans against, or null for schema-less. */
  schema: object | null;
  /** Non-default buildPlan options (primaryKeyMap etc.). Omitted when empty. */
  options?: Options;
  original: JsonValue;
  modified: JsonValue;
  /**
   * Correctness contract for a round-trip check (apply(original, patch) vs
   * modified): "exact" for order-preserving strategies (LCS / plain), "multiset"
   * for the primaryKey strategy whose survivors++appends are order-insensitive.
   */
  roundtrip: Roundtrip;
  /** True for the pathological shapes the memory probe should sample. */
  measureMemory: boolean;
  /** Free-form labels (e.g. "past-65536-cliff", "reorder"). */
  tags: string[];
  /**
   * Only present on the mutate-rediff staleness descriptor: the sequence of
   * in-place mutations a runner must replay between two diffs to probe cache
   * staleness. `original`/`modified` still hold the first diff's pair.
   */
  staleness?: {
    steps: string[];
    note: string;
  };
};

const cases: CorpusCase[] = [];
const seen = new Set<string>();
function push(c: CorpusCase) {
  if (seen.has(c.name)) throw new Error(`duplicate case name: ${c.name}`);
  seen.add(c.name);
  cases.push(c);
}

const deepCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A tiny seeded PRNG (mulberry32) — used to pin json-schema-faker's RNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// 1. Realistic documents (faker-driven; order is load-bearing for determinism)
// ===========================================================================
faker.seed(SEED);
// Pin json-schema-faker's structural RNG (used only by the e-commerce generator).
jsf.option({ random: mulberry32(SEED) });

function cloudConfigCase(
  name: string,
  complexity: "Low" | "Medium" | "High",
  target: number,
  range: { label: string; min: number; max: number },
  description: string,
): void {
  const original = createRandomCloudConfig({ complexity });
  const modified = deepCopy(original);
  // Modifications mutate `modified` in place with faker; deterministic under SEED.
  applyModificationsForTargetComplexity(modified, target, range);
  push({
    name,
    category: "realistic",
    description,
    schema: mainSchema,
    original: original as unknown as JsonValue,
    modified: modified as unknown as JsonValue,
    roundtrip: "multiset", // cloud config keys services/environments by id
    measureMemory: false,
    tags: ["cloud-config", complexity.toLowerCase()],
  });
}

cloudConfigCase(
  "realistic-cloud-config-small",
  "Low",
  15,
  { label: "Low", min: 1, max: 30 },
  "Small FlightControl cloud config (~1 env, a handful of keyed services) with a low-complexity edit set",
);
cloudConfigCase(
  "realistic-cloud-config-medium",
  "Medium",
  60,
  { label: "Medium", min: 30, max: 80 },
  "Medium cloud config (dozens of keyed services across envs) with a medium-complexity edit set",
);
cloudConfigCase(
  "realistic-cloud-config-large",
  "High",
  120,
  { label: "High", min: 80, max: 150 },
  "Large cloud config (~100 keyed services) with a high-complexity edit set",
);

// E-commerce realistic case (different generator, keyed products/users/etc.)
{
  const original = generateRandomECommerceConfig({ complexity: "Medium" });
  const modified = deepCopy(original);
  applyECommerceModificationsForTargetComplexity(modified, 150, {
    label: "Medium",
    min: 51,
    max: 200,
  });
  push({
    name: "realistic-ecommerce-medium",
    category: "realistic",
    description:
      "Medium e-commerce platform config (keyed products, users, categories, orders) with a realistic edit set",
    schema: ecommerceSchema,
    original: original as unknown as JsonValue,
    modified: modified as unknown as JsonValue,
    roundtrip: "multiset",
    measureMemory: false,
    tags: ["e-commerce", "medium"],
  });
}

// ===========================================================================
// 2. Keyed-array workloads (modify / add / remove / reorder mixes)
// ===========================================================================
// A plain array of {id, name, qty, tag}. No schema-declared key — selected via
// primaryKeyMap so the primaryKey strategy is exercised. roundtrip = multiset.
const KEYED_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          qty: { type: "number" },
          tag: { type: "string" },
        },
      },
    },
  },
};
const KEYED_OPTS: Options = { primaryKeyMap: { "/items": "id" } };

function keyedItem(i: number) {
  return { id: `k${i}`, name: `item-${i}`, qty: i, tag: i % 2 === 0 ? "even" : "odd" };
}
function keyedItems(n: number) {
  return Array.from({ length: n }, (_, i) => keyedItem(i));
}
function keyedCase(
  name: string,
  description: string,
  tags: string[],
  original: unknown,
  modified: unknown,
): void {
  push({
    name,
    category: "keyed",
    description,
    schema: KEYED_SCHEMA,
    options: KEYED_OPTS,
    original: { items: original } as JsonValue,
    modified: { items: modified } as JsonValue,
    roundtrip: "multiset",
    measureMemory: false,
    tags,
  });
}

// modify-only: change a field on ~1/3 of items, order preserved
{
  const base = keyedItems(60);
  const mod = base.map((it, i) => (i % 3 === 0 ? { ...it, qty: it.qty + 1000 } : { ...it }));
  keyedCase(
    "keyed-modify-only",
    "60 keyed items, one field changed on every third item, order preserved",
    ["modify"],
    base,
    mod,
  );
}
// add-only: append 20 new keyed items
{
  const base = keyedItems(60);
  const mod = [...base.map((it) => ({ ...it })), ...Array.from({ length: 20 }, (_, i) => keyedItem(100 + i))];
  keyedCase("keyed-add-only", "60 keyed items plus 20 appended new keys", ["add"], base, mod);
}
// remove-only: drop every fourth item
{
  const base = keyedItems(60);
  const mod = base.filter((_, i) => i % 4 !== 0).map((it) => ({ ...it }));
  keyedCase("keyed-remove-only", "60 keyed items with every fourth key removed", ["remove"], base, mod);
}
// reorder-only: pure permutation of identical items (should be ~0 ops)
{
  const base = keyedItems(60);
  const mod = [...base].reverse().map((it) => ({ ...it }));
  keyedCase(
    "keyed-reorder-only",
    "60 keyed items reversed with identical content (order-insensitive no-op territory)",
    ["reorder", "noop"],
    base,
    mod,
  );
}
// mixed: modify + add + remove + reorder together
{
  const base = keyedItems(80);
  let mod = base
    .filter((_, i) => i % 5 !== 0) // remove every fifth
    .map((it, i) => (i % 3 === 0 ? { ...it, name: `${it.name}-x`, qty: it.qty + 7 } : { ...it }));
  mod = [...mod].reverse(); // reorder
  mod.push(keyedItem(200), keyedItem(201), keyedItem(202)); // add
  keyedCase(
    "keyed-mixed-modify-add-remove-reorder",
    "80 keyed items with a combined remove/modify/reorder/add workload",
    ["modify", "add", "remove", "reorder", "mixed"],
    base,
    mod,
  );
}

// ===========================================================================
// 3. Pathological LCS shapes (schema-less primitive arrays -> Myers LCS)
// ===========================================================================
// A nested primitive-string array with NO primaryKey so the LCS strategy runs.
const LCS_SCHEMA = {
  type: "object",
  properties: { seq: { type: "array", items: { type: "string" } } },
};
function seqEl(i: number) {
  // Fixed-width label so equality is purely by value; distinct per index.
  return `s${String(i).padStart(7, "0")}`;
}
function lcsSeq(n: number) {
  return Array.from({ length: n }, (_, i) => seqEl(i));
}
function lcsCase(
  name: string,
  description: string,
  tags: string[],
  original: string[],
  modified: string[],
): void {
  push({
    name,
    category: "lcs",
    description,
    schema: LCS_SCHEMA,
    original: { seq: original } as JsonValue,
    modified: { seq: modified } as JsonValue,
    roundtrip: "exact", // LCS is order-preserving
    measureMemory: true,
    tags,
  });
}

// single-edit at the midpoint of 10k / 70k / 100k sequences. The 70k case sits
// PAST the old 16-bit (65,536) interning cliff that corrupted long LCS windows.
for (const n of [10_000, 70_000, 100_000]) {
  const base = lcsSeq(n);
  const mod = base.slice();
  mod[Math.floor(n / 2)] = "s-EDITED"; // one changed element
  const cliff = n > 65_536 ? " (past the old 65,536 interning cliff)" : "";
  lcsCase(
    `lcs-${n / 1000}k-single-edit`,
    `${n.toLocaleString()}-element sequence with a single mid-array element change${cliff}`,
    n > 65_536 ? ["single-edit", "past-65536-cliff"] : ["single-edit"],
    base,
    mod,
  );
}
// 4k fully-disjoint: no common subsequence -> worst-case Myers path.
{
  const original = Array.from({ length: 4_000 }, (_, i) => `a${String(i).padStart(6, "0")}`);
  const modified = Array.from({ length: 4_000 }, (_, i) => `b${String(i).padStart(6, "0")}`);
  lcsCase(
    "lcs-4k-disjoint",
    "Two 4,000-element sequences with zero common elements (worst-case LCS diagonal)",
    ["disjoint", "worst-case"],
    original,
    modified,
  );
}

// ===========================================================================
// 4. Structural edge cases
// ===========================================================================
// Root array (document IS an array). Schema-less; LCS over the root.
{
  const original = lcsSeq(200);
  const modified = original.slice();
  modified.splice(100, 0, "s-INSERTED"); // insert one in the middle
  modified[10] = "s-CHANGED";
  push({
    name: "structural-root-array",
    category: "structural",
    description: "A root-level array (not wrapped in an object) with an insert and a change",
    schema: { type: "array", items: { type: "string" } },
    original: original as unknown as JsonValue,
    modified: modified as unknown as JsonValue,
    roundtrip: "exact",
    measureMemory: false,
    tags: ["root-array"],
  });
}
// Root keyed array: document is an array keyed by id.
{
  const base = keyedItems(40);
  const mod = base.filter((_, i) => i !== 3).map((it, i) => (i % 4 === 0 ? { ...it, qty: it.qty + 1 } : { ...it }));
  push({
    name: "structural-root-keyed-array",
    category: "structural",
    description: "A root-level array keyed by id (primaryKeyMap '') with a remove + modify workload",
    schema: {
      type: "array",
      items: { type: "object", properties: { id: { type: "string" }, qty: { type: "number" } } },
    },
    options: { primaryKeyMap: { "": "id" } },
    original: base as unknown as JsonValue,
    modified: mod as unknown as JsonValue,
    roundtrip: "multiset",
    measureMemory: false,
    tags: ["root-array", "keyed"],
  });
}
// Deep nesting: a chain of nested objects with a change at the leaf.
{
  const DEPTH = 40;
  function nest(depth: number, leaf: JsonValue): JsonValue {
    let node: JsonValue = leaf;
    for (let i = 0; i < depth; i++) node = { [`level${depth - 1 - i}`]: node, sibling: depth - 1 - i };
    return node;
  }
  const original = nest(DEPTH, { value: "original-leaf", n: 1 });
  const modified = nest(DEPTH, { value: "modified-leaf", n: 2 });
  push({
    name: "structural-deep-nesting",
    category: "structural",
    description: `Object nested ${DEPTH} levels deep with a change only at the deepest leaf`,
    schema: null,
    original,
    modified,
    roundtrip: "exact",
    measureMemory: false,
    tags: ["deep-nesting"],
  });
}

// ===========================================================================
// 5. JSON-Pointer edge cases (escaping, duplicate keys)
// ===========================================================================
// Pointer-escaping keys: object member keys containing '/' and '~' (RFC 6901
// escapes ~1 and ~0). A silent-sibling-corruption regression lived here.
{
  const original: JsonValue = {
    "a/b": { note: "slash-key original" },
    "c~d": { note: "tilde-key original" },
    "~/weird/~": 1,
    plain: { nested: { "x/y~z": [1, 2, 3] } },
  };
  const modified: JsonValue = {
    "a/b": { note: "slash-key MODIFIED" },
    "c~d": { note: "tilde-key original" },
    "~/weird/~": 2,
    plain: { nested: { "x/y~z": [1, 2, 4] } },
  };
  push({
    name: "edge-pointer-escaping-keys",
    category: "edge",
    description: "Object keys containing '/' and '~' (RFC 6901 ~1/~0 escapes) changed at several depths",
    schema: null,
    original,
    modified,
    roundtrip: "exact",
    measureMemory: false,
    tags: ["pointer-escaping"],
  });
}
// Duplicate-key array: two items share a primary-key value. The primaryKey gate
// must NOT silently mutate; both engines fall back to a safe strategy.
{
  const original: JsonValue = {
    items: [
      { id: "dup", name: "first", qty: 1 },
      { id: "dup", name: "second", qty: 2 },
      { id: "uniq", name: "third", qty: 3 },
    ],
  };
  const modified: JsonValue = {
    items: [
      { id: "dup", name: "first", qty: 10 },
      { id: "dup", name: "second", qty: 2 },
      { id: "uniq", name: "third-renamed", qty: 3 },
    ],
  };
  push({
    name: "edge-duplicate-primary-key",
    category: "edge",
    description:
      "Array with two items sharing the primary-key value 'dup' (gate must not silently mutate identical keys)",
    schema: KEYED_SCHEMA,
    options: KEYED_OPTS,
    original,
    modified,
    roundtrip: "exact", // non-unique keys disqualify primaryKey -> positional/LCS, order preserved
    measureMemory: false,
    tags: ["duplicate-key"],
  });
}

// ===========================================================================
// 6. Mutate-rediff staleness scenario DESCRIPTOR
// ===========================================================================
// Not a plain pair: a descriptor telling the runner to diff once, mutate the
// original in place, then diff again against a fresh target — probing whether
// any per-run memoisation leaks across diffs (the F02 identity-cache bug).
{
  const original: JsonValue = { items: keyedItems(30) };
  const firstModified: JsonValue = {
    items: keyedItems(30).map((it, i) => (i === 5 ? { ...it, qty: it.qty + 1 } : it)),
  };
  push({
    name: "staleness-mutate-rediff",
    category: "staleness",
    description:
      "Diff a keyed array, then mutate the SAME original object in place and re-diff; a correct engine must not reuse stale per-run memoised state across the two diffs",
    schema: KEYED_SCHEMA,
    options: KEYED_OPTS,
    original,
    modified: firstModified,
    roundtrip: "multiset",
    measureMemory: false,
    tags: ["staleness", "cache"],
    staleness: {
      steps: [
        "diff(original, modified) -> patchA",
        "mutate original in place: original.items[10].qty += 500",
        "diff(original, original) -> MUST be empty (no stale ops from patchA's memo)",
        "diff(original, modified) -> patchB MUST equal a fresh diff of the mutated original vs modified",
      ],
      note:
        "The runner replays these steps in-process against both engines; the notebook renders PASS/FAIL. Corpus original/modified hold the first diff's pair.",
    },
  });
}

// ===========================================================================
// 7. spec-v2 declared-topology workloads (W2/W3) + ignorePaths + dense apply (D7)
// ===========================================================================
// These are the surfaces a schema-aware engine expresses that a generic RFC 6902
// differ cannot: a composite (multi-field) key, an order-significant keyed array,
// set membership, atomic (whole-container) replacement, ignored volatile fields,
// and a dense many-ops-under-one-object apply shape. Every competitor diffs these
// SCHEMALESSLY (it has no topology vocabulary) — that IS the comparison. All data
// is pure index arithmetic (no faker/jsf), so appending this section leaves every
// pre-existing case file byte-identical.

// --- composite-key map: identity spans TWO fields (region, sku) (CORE §8.4) ---
{
  const COMPOSITE_SCHEMA = {
    type: "object",
    properties: {
      inventory: {
        type: "array",
        "x-schema-patch-topology": "map",
        "x-schema-patch-keys": ["region", "sku"],
        items: {
          type: "object",
          properties: {
            region: { type: "string" },
            sku: { type: "string" },
            qty: { type: "number" },
            price: { type: "number" },
          },
        },
      },
    },
  };
  const regions = ["us", "eu", "ap"];
  const invItem = (r: number, s: number) => ({
    region: regions[r],
    sku: `sku-${String(s).padStart(4, "0")}`,
    qty: r * 100 + s,
    price: (s + 1) * 3,
  });
  const base: JsonValue[] = [];
  for (let r = 0; r < 3; r++) for (let s = 0; s < 20; s++) base.push(invItem(r, s));
  let mod: JsonValue[] = (base as ReturnType<typeof invItem>[])
    .filter((_, i) => i % 9 !== 0) // remove ~1/9 of the (region,sku) pairs
    .map((it, i) => (i % 4 === 0 ? { ...it, price: it.price + 5, qty: it.qty + 1 } : { ...it }));
  // add new pairs reusing an existing region with a fresh sku (a NEW composite key)
  mod = [...mod, invItem(0, 100), invItem(1, 101), invItem(2, 102)];
  push({
    name: "topology-map-composite-key",
    category: "topology",
    description:
      "Array keyed by a 2-field composite tuple (region, sku) via x-schema-patch-keys; modify/add/remove by composite identity (a generic differ sees only positions)",
    schema: COMPOSITE_SCHEMA,
    original: { inventory: base } as JsonValue,
    modified: { inventory: mod } as JsonValue,
    roundtrip: "multiset", // map/insignificant: survivors++appends, order-insensitive
    measureMemory: false,
    tags: ["topology", "map", "composite-key"],
  });
}

// --- order-significant map: exact keyed order via moves (reorder + modify) -----
{
  const ORDERED_SCHEMA = {
    type: "object",
    properties: {
      steps: {
        type: "array",
        "x-schema-patch-topology": "map",
        "x-schema-patch-keys": ["id"],
        "x-schema-patch-order": "significant",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            label: { type: "string" },
            weight: { type: "number" },
          },
        },
      },
    },
  };
  const base = Array.from({ length: 40 }, (_, i) => ({
    id: `st${String(i).padStart(3, "0")}`,
    label: `step-${i}`,
    weight: i,
  }));
  let mod = base.map((it, i) => (i % 5 === 0 ? { ...it, label: `${it.label}-v2` } : { ...it }));
  mod = [...mod.slice(7), ...mod.slice(0, 7)]; // rotate by 7 -> a real reordering
  push({
    name: "topology-map-order-significant",
    category: "topology",
    description:
      "Keyed array declared x-schema-patch-order:significant, rotated by 7 with in-place label edits; exact order is reconstructed by the move machinery (CORE §7.4/§8.4)",
    schema: ORDERED_SCHEMA,
    original: { steps: base } as JsonValue,
    modified: { steps: mod } as JsonValue,
    roundtrip: "exact", // map/significant: exact order reconstruction
    measureMemory: false,
    tags: ["topology", "map", "order-significant", "reorder"],
  });
}

// --- set topology (scalars): membership identity, order insignificant (CORE §8.5)
{
  const SET_SCALAR_SCHEMA = {
    type: "object",
    properties: {
      tags: { type: "array", "x-schema-patch-topology": "set", items: { type: "string" } },
    },
  };
  const base = Array.from({ length: 50 }, (_, i) => `tag-${String(i).padStart(3, "0")}`);
  let mod = base.filter((_, i) => i % 7 !== 0); // remove ~1/7 of the members
  mod = [...mod].reverse(); // reorder survivors (a set no-op)
  mod = [...mod, "tag-900", "tag-901", "tag-902"]; // add new members
  push({
    name: "topology-set-scalars",
    category: "topology",
    description:
      "Array declared x-schema-patch-topology:set over distinct strings; add/remove members and reverse the survivors (reorder is a no-op for a set)",
    schema: SET_SCALAR_SCHEMA,
    original: { tags: base } as JsonValue,
    modified: { tags: mod } as JsonValue,
    roundtrip: "multiset", // set: content/multiset round-trip, order insignificant
    measureMemory: false,
    tags: ["topology", "set", "scalars", "reorder"],
  });
}

// --- set topology (objects): identity is the whole (deep-equal) element ---------
{
  const SET_OBJ_SCHEMA = {
    type: "object",
    properties: {
      members: {
        type: "array",
        "x-schema-patch-topology": "set",
        items: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } },
      },
    },
  };
  const base = Array.from({ length: 30 }, (_, i) => ({ a: `m${i}`, b: i }));
  let mod = base.filter((_, i) => i % 6 !== 0).map((it) => ({ ...it }));
  mod = [...mod].reverse();
  mod = [...mod, { a: "m100", b: 100 }, { a: "m101", b: 101 }];
  push({
    name: "topology-set-objects",
    category: "topology",
    description:
      "Set of distinct objects (identity = whole deep value); membership add/remove plus a reverse (no in-place edits, since a value change IS a remove+add for a set)",
    schema: SET_OBJ_SCHEMA,
    original: { members: base } as JsonValue,
    modified: { members: mod } as JsonValue,
    roundtrip: "multiset",
    measureMemory: false,
    tags: ["topology", "set", "objects", "reorder"],
  });
}

// --- atomic array: any deep difference replaces the WHOLE array (CORE §8.6) ------
{
  const ATOMIC_ARR_SCHEMA = {
    type: "object",
    properties: {
      matrix: {
        type: "array",
        "x-schema-patch-topology": "atomic",
        items: { type: "array", items: { type: "number" } },
      },
    },
  };
  const base = { matrix: Array.from({ length: 20 }, (_, i) => Array.from({ length: 5 }, (_, j) => i * 5 + j)) };
  const mod = deepCopy(base);
  mod.matrix[3]![2] = 999; // one deep change -> the whole array is one replace
  push({
    name: "topology-atomic-array",
    category: "topology",
    description:
      "Array declared x-schema-patch-topology:atomic; a single deep element change forces one whole-array replace (a generic differ emits a granular positional op instead)",
    schema: ATOMIC_ARR_SCHEMA,
    original: base as unknown as JsonValue,
    modified: mod as unknown as JsonValue,
    roundtrip: "exact",
    measureMemory: false,
    tags: ["topology", "atomic", "array"],
  });
}

// --- atomic object: any member difference replaces the WHOLE object (CORE §8.6) -
{
  const ATOMIC_OBJ_SCHEMA = {
    type: "object",
    properties: {
      config: {
        type: "object",
        "x-schema-patch-granularity": "atomic",
        properties: {
          host: { type: "string" },
          port: { type: "number" },
          tls: { type: "boolean" },
          region: { type: "string" },
          replicas: { type: "number" },
        },
      },
    },
  };
  const base = { config: { host: "a", port: 8080, tls: false, region: "us", replicas: 3 } };
  const mod = { config: { host: "a", port: 9090, tls: true, region: "us", replicas: 3 } };
  push({
    name: "topology-atomic-object",
    category: "topology",
    description:
      "Object declared x-schema-patch-granularity:atomic; two changed members yield ONE whole-object replace (a generic differ emits a replace per member)",
    schema: ATOMIC_OBJ_SCHEMA,
    original: base as unknown as JsonValue,
    modified: mod as unknown as JsonValue,
    roundtrip: "exact",
    measureMemory: false,
    tags: ["topology", "atomic", "object"],
  });
}

// --- ignorePaths: volatile timestamp fields are skipped (GEN §10) ---------------
// modified is deepCopy(base) with values edited in place (key order preserved), so
// the round-trip is verified byte-exact MODULO the ignored subtrees (CORE §7.6).
{
  const IGNORE_SCHEMA = {
    type: "object",
    properties: {
      meta: {
        type: "object",
        properties: { generatedAt: { type: "string" }, version: { type: "number" } },
      },
      records: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            status: { type: "string" },
            updatedAt: { type: "string" },
            lastSeenAt: { type: "string" },
          },
        },
      },
    },
  };
  const base = {
    meta: { generatedAt: "2020-01-01T00:00:00Z", version: 1 },
    records: Array.from({ length: 40 }, (_, i) => ({
      id: `r${String(i).padStart(3, "0")}`,
      status: i % 3 === 0 ? "active" : "idle",
      updatedAt: `2020-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
      lastSeenAt: "2020-01-01T01:00:00Z",
    })),
  };
  const mod = deepCopy(base);
  mod.meta.generatedAt = "2020-06-15T12:00:00Z"; // volatile (ignored)
  for (let i = 0; i < mod.records.length; i++) {
    const rec = mod.records[i]!;
    rec.updatedAt = `2020-06-15T12:00:${String(i % 60).padStart(2, "0")}Z`; // volatile (ignored)
    rec.lastSeenAt = "2020-06-15T13:00:00Z"; // volatile (ignored)
    if (i % 8 === 0) rec.status = rec.status === "active" ? "idle" : "active"; // REAL
  }
  push({
    name: "ignorepaths-volatile-timestamps",
    category: "ignore-paths",
    description:
      "A doc whose every record has churned volatile timestamps plus a handful of real status flips; ignorePaths skips the timestamps so ours emits only the real changes while a generic differ emits ~40x the noise",
    schema: IGNORE_SCHEMA,
    options: { ignorePaths: ["/meta/generatedAt", "/records/*/updatedAt", "/records/*/lastSeenAt"] },
    original: base as unknown as JsonValue,
    modified: mod as unknown as JsonValue,
    roundtrip: "exact", // exact MODULO the ignored subtrees (see reconstructs())
    measureMemory: false,
    tags: ["ignore-paths", "volatile", "timestamps"],
  });
}

// --- dense many-ops-under-one-object apply shape (D7 clone-set workload) ---------
// Every member of one object changes value; a schemaless diff yields N replace ops
// all sharing the parent /obj, so apply must clone that object ONCE (the D7 fix),
// not once per op. This is the case the apply race (ours-apply vs evanphx) exists
// to time.
{
  const N = 5000;
  const pad = (i: number) => `k${String(i).padStart(5, "0")}`;
  const baseObj: Record<string, JsonValue> = {};
  const modObj: Record<string, JsonValue> = {};
  for (let i = 0; i < N; i++) {
    baseObj[pad(i)] = i;
    modObj[pad(i)] = i + 1_000_000;
  }
  push({
    name: "apply-dense-many-ops-under-one-object",
    category: "apply-dense",
    description: `An object with ${N} members whose values ALL change; a schemaless diff is ${N} replace ops under one parent object — the D7 per-invocation clone-set apply workload`,
    schema: null,
    original: { obj: baseObj } as JsonValue,
    modified: { obj: modObj } as JsonValue,
    roundtrip: "exact",
    measureMemory: false,
    tags: ["apply-dense", "d7", "clone-set"],
  });
}

// ===========================================================================
// Emit
// ===========================================================================
const OUT_DIR = join(import.meta.dir, "cases");
mkdirSync(OUT_DIR, { recursive: true });
// Clear stale case files so a renamed/removed case never lingers.
for (const f of readdirSync(OUT_DIR)) {
  if (f.endsWith(".json")) rmSync(join(OUT_DIR, f));
}

// Stable 2-space JSON with a fixed key order per case for byte-identical output.
function emitCase(c: CorpusCase): string {
  const ordered: Record<string, unknown> = {
    name: c.name,
    category: c.category,
    description: c.description,
    schema: c.schema,
  };
  if (c.options && Object.keys(c.options).length) ordered.options = c.options;
  ordered.roundtrip = c.roundtrip;
  ordered.measureMemory = c.measureMemory;
  ordered.tags = c.tags;
  if (c.staleness) ordered.staleness = c.staleness;
  ordered.original = c.original;
  ordered.modified = c.modified;
  const json = `${JSON.stringify(ordered, null, 2)}\n`;
  writeFileSync(join(OUT_DIR, `${c.name}.json`), json);
  return json;
}

const manifest = {
  schemaVersion: 1,
  seed: SEED,
  generatedBy: "comparison/corpora/generate.ts",
  count: cases.length,
  cases: cases.map((c) => {
    const bytesOriginal = JSON.stringify(c.original).length;
    const bytesModified = JSON.stringify(c.modified).length;
    emitCase(c);
    return {
      name: c.name,
      file: `cases/${c.name}.json`,
      category: c.category,
      description: c.description,
      hasSchema: c.schema !== null,
      options: c.options ?? null,
      roundtrip: c.roundtrip,
      measureMemory: c.measureMemory,
      tags: c.tags,
      isStalenessDescriptor: Boolean(c.staleness),
      bytesOriginal,
      bytesModified,
    };
  }),
};

writeFileSync(join(import.meta.dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Console summary.
const byCat = new Map<string, number>();
for (const c of cases) byCat.set(c.category, (byCat.get(c.category) ?? 0) + 1);
console.log(`corpora: ${cases.length} cases -> ${OUT_DIR}`);
for (const [cat, n] of [...byCat.entries()].sort()) console.log(`  ${cat}: ${n}`);
console.log(`manifest: comparison/corpora/manifest.json (seed ${SEED})`);
