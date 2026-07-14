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
