/**
 * spec/fuzz/generate-corpus.ts — deterministic differential-fuzz corpus generator.
 *
 * Regenerate with:  bun run spec/fuzz/generate-corpus.ts
 *
 * PURPOSE
 * -------
 * Produces a large, seeded corpus of (schema, options, original, modified)
 * triples together with the TypeScript reference's answer for each one:
 *   - `tsPatch`   — the ops emitted by `JsonSchemaPatcher.execute()`
 *   - `tsApplied` — the document produced by `applyPatch(original, tsPatch)`
 *
 * The Go port's differential test (go/differential_test.go) replays every
 * record: it builds the same plan, diffs the same documents, asserts its patch
 * is STRUCTURALLY EQUAL to `tsPatch` (CONF §4.2), then applies ITS OWN patch and
 * asserts the result deep-equals `tsApplied` (CORE §5.7.4). Zero mismatches are
 * required; any divergence is a bug in one engine or a spec hole.
 *
 * DETERMINISM
 * -----------
 * A single fixed faker seed drives every random draw — document shapes,
 * modification selection, everything. Re-running produces byte-identical
 * corpus files. Nothing here reads the clock or an unseeded RNG.
 *
 * COVERAGE
 * --------
 * The config matrix crosses two document families (flightcontrol cloud-config
 * and e-commerce) against plan-option variants that force each array-diff
 * strategy (primaryKey / unique / lcs) and against every capability toggle
 * (includeOldValue, emitMoves, wholesaleReplaceFallback — CONF §5). See the
 * `configs` and `capabilityVariants` tables below.
 *
 * SCHEMA STORAGE
 * --------------
 * Schemas are written once to corpus/schemas/<ref>.json and referenced by
 * `schemaRef` in each record rather than inlined: the cloud schema alone is
 * ~150 KB, so inlining it into every one of ~500 records would bloat the
 * committed corpus by two orders of magnitude. The referenced file IS the
 * record's `schema` — the Go test resolves it the same way. (This is the only
 * deviation from a literally self-contained record and is intentional.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { faker } from "@faker-js/faker";
import jsf from "json-schema-faker";
import { applyPatch, buildPlan, JsonSchemaPatcher } from "../../src/index";
import type { JsonValue, Operation } from "../../src/types";
import mainSchema from "../../schema/schema.json";
import ecommerceSchema from "../../schema/e-commerce.json";
import { createRandomCloudConfig } from "../../comparison/data-generators";
import { applyModificationsForTargetComplexity } from "../../comparison/modification-functions";
import {
  applyECommerceModificationsForTargetComplexity,
  generateRandomECommerceConfig,
} from "../../comparison/ecommerceModifications";

// ---------------------------------------------------------------------------
// Determinism: one fixed seed for the entire run.
// ---------------------------------------------------------------------------
const SEED = 0xc0ffee;
faker.seed(SEED);

// The e-commerce family is built by json-schema-faker (jsf), which has its OWN
// internal RNG defaulting to Math.random — faker.seed() does NOT cover it, so
// without this the e-commerce corpus would differ on every run. jsf routes all
// of its structural randomness through the `random` option, so installing a
// seeded PRNG here makes jsf.generate() fully reproducible. (Format values that
// jsf delegates to faker via jsf.extend("faker", …) are already covered by
// faker.seed above.) mulberry32 is a small, well-distributed seedable PRNG.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
jsf.option({ random: mulberry32(SEED ^ 0x5eed) });

type Complexity = "Low" | "Medium";
const RANGES: Record<Complexity, { label: string; min: number; max: number }> = {
  Low: { label: "Low", min: 1, max: 30 },
  Medium: { label: "Medium", min: 30, max: 80 },
};
// Modification budget per complexity (drives how many edits are applied).
const TARGET: Record<Complexity, number> = { Low: 12, Medium: 45 };

type PlanOpts = {
  primaryKeyMap?: Record<string, string>;
  basePath?: string;
  primaryKeyCandidates?: string[];
};

type Family = "cloud" | "ecommerce";

interface Config {
  label: string;
  family: Family;
  schemaRef: string;
  schema: unknown;
  planOpts: PlanOpts;
  complexities: Complexity[];
  /** doc pairs to generate per (capability variant); total = docsPer × caps. */
  docsPer: number;
}

// Plan-option variants chosen to exercise every strategy (CORE §3.4/CORE §3.5):
//   *-auto  → primaryKey on id-keyed arrays, unique on primitive arrays, lcs on
//             keyless object arrays (shipping.rates); the natural mix.
//   *-lcs   → primaryKeyCandidates:[] disables auto-detection, so every object
//             array falls back to lcs (CORE §3.5.3) while primitive arrays stay unique.
//   *-empty → schema {} yields the empty plan: every array (incl. primitive) is
//             lcs (GEN §4.5.3), the pure schemaless path.
//   *-pkmap → primaryKeyMap forces a non-default key, overriding auto-detection.
// Low-complexity documents dominate (small, so the corpus stays committable);
// a dedicated *-stress config contributes a handful of large Medium documents
// per family to exercise long-array LCS / primary-key reconciliation.
const configs: Config[] = [
  {
    label: "cloud-auto",
    family: "cloud",
    schemaRef: "cloud",
    schema: mainSchema,
    planOpts: {},
    complexities: ["Low"],
    docsPer: 31,
  },
  {
    label: "cloud-lcs",
    family: "cloud",
    schemaRef: "cloud",
    schema: mainSchema,
    planOpts: { primaryKeyCandidates: [] },
    complexities: ["Low"],
    docsPer: 16,
  },
  {
    label: "cloud-pkmap",
    family: "cloud",
    schemaRef: "cloud",
    schema: mainSchema,
    planOpts: { primaryKeyMap: { "/environments": "name" } },
    complexities: ["Low"],
    docsPer: 10,
  },
  {
    label: "cloud-empty",
    family: "cloud",
    schemaRef: "empty",
    schema: {},
    planOpts: {},
    complexities: ["Low"],
    docsPer: 8,
  },
  {
    label: "cloud-stress",
    family: "cloud",
    schemaRef: "cloud",
    schema: mainSchema,
    planOpts: {},
    complexities: ["Medium"],
    docsPer: 2,
  },
  {
    label: "ecommerce-auto",
    family: "ecommerce",
    schemaRef: "ecommerce",
    schema: ecommerceSchema,
    planOpts: {},
    complexities: ["Low"],
    docsPer: 25,
  },
  {
    label: "ecommerce-lcs",
    family: "ecommerce",
    schemaRef: "ecommerce",
    schema: ecommerceSchema,
    planOpts: { primaryKeyCandidates: [] },
    complexities: ["Low"],
    docsPer: 10,
  },
  {
    label: "ecommerce-stress",
    family: "ecommerce",
    schemaRef: "ecommerce",
    schema: ecommerceSchema,
    planOpts: {},
    complexities: ["Medium"],
    docsPer: 2,
  },
];

// Capability variants (CONF §5). Defaults reproduce pre-capability output.
const capabilityVariants: {
  includeOldValue: boolean;
  emitMoves: boolean;
  wholesaleReplaceFallback: boolean;
}[] = [
  { includeOldValue: true, emitMoves: false, wholesaleReplaceFallback: false },
  { includeOldValue: false, emitMoves: false, wholesaleReplaceFallback: false },
  { includeOldValue: true, emitMoves: true, wholesaleReplaceFallback: false },
  { includeOldValue: false, emitMoves: true, wholesaleReplaceFallback: false },
  { includeOldValue: true, emitMoves: false, wholesaleReplaceFallback: true },
];

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function makePair(family: Family, complexity: Complexity): { original: JsonValue; modified: JsonValue } {
  const range = RANGES[complexity];
  const target = TARGET[complexity];
  if (family === "cloud") {
    const original = createRandomCloudConfig({ complexity });
    const modified = clone(original);
    applyModificationsForTargetComplexity(modified, target, range);
    return { original: original as JsonValue, modified: modified as JsonValue };
  }
  const original = generateRandomECommerceConfig({ complexity });
  const modified = clone(original);
  applyECommerceModificationsForTargetComplexity(modified, target, range);
  return { original: original as unknown as JsonValue, modified: modified as unknown as JsonValue };
}

interface FuzzRecord {
  name: string;
  schemaRef: string;
  options: PlanOpts & {
    includeOldValue: boolean;
    emitMoves: boolean;
    wholesaleReplaceFallback: boolean;
  };
  original: JsonValue;
  modified: JsonValue;
  tsPatch: Operation[];
  tsApplied: JsonValue;
}

const outDir = join(import.meta.dir, "corpus");
const schemaDir = join(outDir, "schemas");
mkdirSync(schemaDir, { recursive: true });

// Emit the referenced schema files (deduped by ref).
const schemasByRef = new Map<string, unknown>();
for (const c of configs) schemasByRef.set(c.schemaRef, c.schema);
schemasByRef.set("empty", {});
for (const [ref, schema] of schemasByRef) {
  writeFileSync(join(schemaDir, `${ref}.json`), `${JSON.stringify(schema, null, 2)}\n`);
}

// Stats accumulators for the run summary.
const stats = {
  total: 0,
  byConfig: new Map<string, number>(),
  byCapability: new Map<string, number>(),
  emptyPatches: 0,
  totalOps: 0,
  opCounts: new Map<string, number>(),
};

// One .jsonl file per config label (corpus/*.jsonl).
for (const config of configs) {
  const lines: string[] = [];
  let seq = 0;
  for (const complexity of config.complexities) {
    for (let d = 0; d < config.docsPer; d++) {
      const { original, modified } = makePair(config.family, complexity);
      for (const caps of capabilityVariants) {
        const plan = buildPlan({ schema: config.schema as never, ...config.planOpts });
        const patcher = new JsonSchemaPatcher({
          plan,
          includeOldValue: caps.includeOldValue,
          emitMoves: caps.emitMoves,
          wholesaleReplaceFallback: caps.wholesaleReplaceFallback,
        });
        const tsPatch = patcher.execute({ original, modified });
        // Apply against a fresh clone so the pristine `original` stays intact
        // for the record; applyPatch inserts patch values by reference.
        const tsApplied = applyPatch(clone(original), tsPatch, {});

        const capLabel = `iov=${caps.includeOldValue ? 1 : 0},mov=${
          caps.emitMoves ? 1 : 0
        },whole=${caps.wholesaleReplaceFallback ? 1 : 0}`;
        const record: FuzzRecord = {
          name: `${config.label}/${complexity}/${seq}/${capLabel}`,
          schemaRef: config.schemaRef,
          options: { ...config.planOpts, ...caps },
          original,
          modified,
          tsPatch,
          tsApplied,
        };
        lines.push(JSON.stringify(record));

        // Stats.
        stats.total++;
        stats.byConfig.set(config.label, (stats.byConfig.get(config.label) ?? 0) + 1);
        stats.byCapability.set(capLabel, (stats.byCapability.get(capLabel) ?? 0) + 1);
        if (tsPatch.length === 0) stats.emptyPatches++;
        stats.totalOps += tsPatch.length;
        for (const op of tsPatch) {
          stats.opCounts.set(op.op, (stats.opCounts.get(op.op) ?? 0) + 1);
        }
        seq++;
      }
    }
  }
  writeFileSync(join(outDir, `${config.label}.jsonl`), `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// ignorePaths differential corpus (GEN §10). A dedicated, self-contained
// family: a fixed schema (keyed users + unique tags + a meta object) and
// deterministically-generated doc pairs whose modifications DELIBERATELY include
// ignored-field drift, reorders (for move-pairing under emitMoves), and real
// changes. Crossed with ignore-path sets (none of which covers the `id` key,
// GEN §10.7) and capability toggles. The Go differential test replays each record
// with the same ignorePaths and asserts structural op equality + apply equality
// (CONF §4.2/CORE §5.7.4). A SEPARATE seeded PRNG is used so the faker/jsf-driven
// corpus above stays byte-identical.
// ---------------------------------------------------------------------------
interface IgnoreVariant {
  ignorePaths: string[];
  includeOldValue: boolean;
  emitMoves: boolean;
  wholesaleReplaceFallback: boolean;
}
const IGNORE_SCHEMA = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          updatedAt: { type: "number" },
          score: { type: "number" },
        },
      },
    },
    tags: { type: "array", items: { type: "string" } },
    meta: {
      type: "object",
      properties: { ts: { type: "number" }, rev: { type: "number" }, note: { type: "string" } },
    },
  },
};
writeFileSync(join(schemaDir, "ignore.json"), `${JSON.stringify(IGNORE_SCHEMA, null, 2)}\n`);

const ignoreVariants: IgnoreVariant[] = [
  { ignorePaths: ["/users/*/updatedAt", "/meta/ts"], includeOldValue: true, emitMoves: false, wholesaleReplaceFallback: false },
  { ignorePaths: ["/users/*/updatedAt"], includeOldValue: false, emitMoves: true, wholesaleReplaceFallback: false },
  { ignorePaths: ["/meta/ts", "/meta/rev"], includeOldValue: true, emitMoves: false, wholesaleReplaceFallback: true },
  { ignorePaths: ["/users/*/updatedAt", "/meta/ts", "/meta/rev"], includeOldValue: true, emitMoves: true, wholesaleReplaceFallback: false },
];

const irng = mulberry32(SEED ^ 0x1970);
const iri = (n: number) => Math.floor(irng() * n);
const WORDS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
const TAGPOOL = ["x", "y", "z", "p", "q", "r", "s", "t"];

interface IgnoreUser {
  id: string;
  name: string;
  updatedAt: number;
  score: number;
}
interface IgnoreDoc {
  users: IgnoreUser[];
  tags: string[];
  meta: { ts: number; rev: number; note: string };
}

function makeIgnoreDoc(nUsers: number): IgnoreDoc {
  const users: IgnoreUser[] = [];
  for (let i = 0; i < nUsers; i++) {
    users.push({ id: `u${i}`, name: WORDS[iri(WORDS.length)] as string, updatedAt: iri(1000), score: iri(100) });
  }
  const tags: string[] = [];
  const nt = 2 + iri(4);
  const used = new Set<string>();
  for (let i = 0; i < nt; i++) {
    const t = TAGPOOL[iri(TAGPOOL.length)] as string;
    if (used.has(t)) continue;
    used.add(t);
    tags.push(t);
  }
  return { users, tags, meta: { ts: iri(10000), rev: iri(50), note: WORDS[iri(WORDS.length)] as string } };
}

function mutateIgnoreDoc(doc: IgnoreDoc): IgnoreDoc {
  const m: IgnoreDoc = clone(doc);
  // Per-user: ignored drift (updatedAt), real changes (name/score).
  for (const u of m.users) {
    if (iri(2) === 0) u.updatedAt = iri(1000); // ignored under most variants
    if (iri(3) === 0) u.name = WORDS[iri(WORDS.length)] as string; // real
    if (iri(3) === 0) u.score = iri(100); // real
  }
  // Reorder (exercises move-pairing under emitMoves).
  if (m.users.length > 1 && iri(2) === 0) {
    const i = iri(m.users.length);
    const j = iri(m.users.length);
    const tmp = m.users[i] as IgnoreUser;
    m.users[i] = m.users[j] as IgnoreUser;
    m.users[j] = tmp;
  }
  // Add / remove a keyed user.
  if (iri(3) === 0) m.users.push({ id: `u${100 + iri(50)}`, name: WORDS[iri(WORDS.length)] as string, updatedAt: iri(1000), score: iri(100) });
  if (m.users.length > 1 && iri(3) === 0) m.users.splice(iri(m.users.length), 1);
  // tags (unique/lcs): tweak one.
  if (m.tags.length > 0 && iri(2) === 0) m.tags[iri(m.tags.length)] = TAGPOOL[iri(TAGPOOL.length)] as string;
  // meta: ignored (ts/rev) + real (note).
  if (iri(2) === 0) m.meta.ts = iri(10000);
  if (iri(2) === 0) m.meta.rev = iri(50);
  if (iri(2) === 0) m.meta.note = WORDS[iri(WORDS.length)] as string;
  return m;
}

{
  const lines: string[] = [];
  let seq = 0;
  const ignorePlanCache = new Map<string, ReturnType<typeof buildPlan>>();
  for (let d = 0; d < 14; d++) {
    const original = makeIgnoreDoc(2 + iri(6)) as unknown as JsonValue;
    const modified = mutateIgnoreDoc(original as unknown as IgnoreDoc) as unknown as JsonValue;
    for (const v of ignoreVariants) {
      let plan = ignorePlanCache.get("ignore");
      if (!plan) {
        plan = buildPlan({ schema: IGNORE_SCHEMA as never });
        ignorePlanCache.set("ignore", plan);
      }
      const patcher = new JsonSchemaPatcher({
        plan,
        includeOldValue: v.includeOldValue,
        emitMoves: v.emitMoves,
        wholesaleReplaceFallback: v.wholesaleReplaceFallback,
        ignorePaths: v.ignorePaths,
      });
      const tsPatch = patcher.execute({ original, modified });
      const tsApplied = applyPatch(clone(original), tsPatch, {});
      const capLabel = `ig=${v.ignorePaths.length},iov=${v.includeOldValue ? 1 : 0},mov=${
        v.emitMoves ? 1 : 0
      },whole=${v.wholesaleReplaceFallback ? 1 : 0}`;
      lines.push(
        JSON.stringify({
          name: `ignore-paths/${seq}/${capLabel}`,
          schemaRef: "ignore",
          options: {
            includeOldValue: v.includeOldValue,
            emitMoves: v.emitMoves,
            wholesaleReplaceFallback: v.wholesaleReplaceFallback,
            ignorePaths: v.ignorePaths,
          },
          original,
          modified,
          tsPatch,
          tsApplied,
        }),
      );
      stats.total++;
      stats.byConfig.set("ignore-paths", (stats.byConfig.get("ignore-paths") ?? 0) + 1);
      stats.byCapability.set(capLabel, (stats.byCapability.get(capLabel) ?? 0) + 1);
      if (tsPatch.length === 0) stats.emptyPatches++;
      stats.totalOps += tsPatch.length;
      for (const op of tsPatch) stats.opCounts.set(op.op, (stats.opCounts.get(op.op) ?? 0) + 1);
      seq++;
    }
  }
  writeFileSync(join(outDir, "ignore-paths.jsonl"), `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// spec-v2 declared-topology differential corpus (CORE §8). A dedicated,
// self-contained family whose schema declares every array/object topology via
// x-schema-patch-* extensions: a composite-key map (order insignificant), an
// order-SIGNIFICANT single-key map (exercises the move machinery, GEN §11.4), a
// primitive `set` (membership diff), an `atomic` array, and an `atomic` object.
// Doc pairs are generated + mutated with a SEPARATE seeded PRNG (so the
// faker/jsf corpus above stays byte-identical) whose modifications hit every
// topology: composite add/remove/modify, ordered reorder, set membership churn,
// atomic whole-container replace. The Go differential replays each record and
// asserts structural op equality + apply equality (CONF §4.2/CORE §5.7.4). The
// element generators keep composite tuples / set members / ordered keys UNIQUE so
// each array stays on its topology's fast path (gate fallbacks are covered by
// the conformance vectors, spec/vectors/diff/topology-gate-fallbacks.json).
// ---------------------------------------------------------------------------
const TOPOLOGY_SCHEMA = {
  type: "object",
  properties: {
    servers: {
      type: "array",
      "x-schema-patch-topology": "map",
      "x-schema-patch-keys": ["region", "id"],
      items: {
        type: "object",
        required: ["region", "id"],
        properties: {
          region: { type: "string" },
          id: { type: "number" },
          cpu: { type: "number" },
          name: { type: "string" },
        },
      },
    },
    routes: {
      type: "array",
      "x-schema-patch-topology": "map",
      "x-schema-patch-keys": ["path"],
      "x-schema-patch-order": "significant",
      items: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, handler: { type: "string" } },
      },
    },
    tags: { type: "array", "x-schema-patch-topology": "set", items: { type: "string" } },
    matrix: {
      type: "array",
      "x-schema-patch-topology": "atomic",
      items: { type: "array", items: { type: "number" } },
    },
    settings: {
      type: "object",
      "x-schema-patch-granularity": "atomic",
      properties: {
        theme: { type: "string" },
        retries: { type: "number" },
        nested: { type: "object", properties: { a: { type: "number" } } },
      },
    },
  },
};
writeFileSync(join(schemaDir, "topology.json"), `${JSON.stringify(TOPOLOGY_SCHEMA, null, 2)}\n`);

interface TopoServer {
  region: string;
  id: number;
  cpu: number;
  name: string;
}
interface TopoRoute {
  path: string;
  handler: string;
}
interface TopoDoc {
  servers: TopoServer[];
  routes: TopoRoute[];
  tags: string[];
  matrix: number[][];
  settings: { theme: string; retries: number; nested: { a: number } };
}

const trng = mulberry32(SEED ^ 0x709010); // "topolo" — independent stream.
const tri = (n: number) => Math.floor(trng() * n);
const REGIONS = ["us", "eu", "ap", "sa"];
const HANDLERS = ["h1", "h2", "h3", "h4", "h5"];
const THEMES = ["light", "dark", "auto"];

function makeTopoDoc(): TopoDoc {
  // servers: unique (region,id) tuples (composite map fast path).
  const nServers = 2 + tri(5);
  const servers: TopoServer[] = [];
  const seenTuple = new Set<string>();
  for (let i = 0; i < nServers; i++) {
    const region = REGIONS[tri(REGIONS.length)] as string;
    const id = tri(8);
    const key = `${region}:${id}`;
    if (seenTuple.has(key)) continue;
    seenTuple.add(key);
    servers.push({ region, id, cpu: tri(100), name: WORDS[tri(WORDS.length)] as string });
  }
  // routes: unique paths (ordered map fast path).
  const nRoutes = 2 + tri(4);
  const routes: TopoRoute[] = [];
  const seenPath = new Set<string>();
  for (let i = 0; i < nRoutes; i++) {
    const path = `/${WORDS[tri(WORDS.length)]}/${i}`;
    if (seenPath.has(path)) continue;
    seenPath.add(path);
    routes.push({ path, handler: HANDLERS[tri(HANDLERS.length)] as string });
  }
  // tags: unique set members.
  const tags: string[] = [];
  const usedTag = new Set<string>();
  const nt = 2 + tri(5);
  for (let i = 0; i < nt; i++) {
    const t = `${TAGPOOL[tri(TAGPOOL.length)]}${tri(3)}`;
    if (usedTag.has(t)) continue;
    usedTag.add(t);
    tags.push(t);
  }
  const matrix: number[][] = [];
  const rows = 1 + tri(3);
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    const cols = 1 + tri(3);
    for (let c = 0; c < cols; c++) row.push(tri(50));
    matrix.push(row);
  }
  return {
    servers,
    routes,
    tags,
    matrix,
    settings: { theme: THEMES[tri(THEMES.length)] as string, retries: tri(5), nested: { a: tri(10) } },
  };
}

function mutateTopoDoc(doc: TopoDoc): TopoDoc {
  const m: TopoDoc = clone(doc);
  // servers (composite map, insignificant): modify content, remove, add a fresh tuple.
  for (const s of m.servers) {
    if (tri(2) === 0) s.cpu = tri(100); // modify (matched by tuple)
    if (tri(3) === 0) s.name = WORDS[tri(WORDS.length)] as string;
  }
  if (m.servers.length > 1 && tri(3) === 0) m.servers.splice(tri(m.servers.length), 1);
  if (tri(2) === 0) {
    // add a tuple guaranteed unique (id offset into a disjoint band).
    m.servers.push({ region: REGIONS[tri(REGIONS.length)] as string, id: 100 + tri(50), cpu: tri(100), name: WORDS[tri(WORDS.length)] as string });
  }
  // reorder servers — order is insignificant, so this must produce NO extra ops.
  if (m.servers.length > 1 && tri(2) === 0) {
    const i = tri(m.servers.length);
    const j = tri(m.servers.length);
    const t = m.servers[i] as TopoServer;
    m.servers[i] = m.servers[j] as TopoServer;
    m.servers[j] = t;
  }
  // routes (ordered map, significant): reorder (→ moves), modify handler, add/remove.
  if (m.routes.length > 1 && tri(2) === 0) {
    const i = tri(m.routes.length);
    const j = tri(m.routes.length);
    const t = m.routes[i] as TopoRoute;
    m.routes[i] = m.routes[j] as TopoRoute;
    m.routes[j] = t;
  }
  for (const r of m.routes) if (tri(3) === 0) r.handler = HANDLERS[tri(HANDLERS.length)] as string;
  if (m.routes.length > 1 && tri(3) === 0) m.routes.splice(tri(m.routes.length), 1);
  if (tri(3) === 0) {
    const path = `/added/${100 + tri(50)}`;
    if (!m.routes.some((r) => r.path === path)) m.routes.push({ path, handler: HANDLERS[tri(HANDLERS.length)] as string });
  }
  // tags (set): remove some, add fresh unique members, occasionally reorder (no ops).
  m.tags = m.tags.filter(() => tri(3) !== 0);
  const used = new Set(m.tags);
  if (tri(2) === 0) {
    const t = `new${tri(100)}`;
    if (!used.has(t)) m.tags.push(t);
  }
  if (m.tags.length > 1 && tri(2) === 0) m.tags.reverse();
  // matrix (atomic array): sometimes mutate one cell → whole-array replace.
  if (tri(2) === 0 && m.matrix.length > 0) {
    const r = tri(m.matrix.length);
    const row = m.matrix[r] as number[];
    if (row.length > 0) row[tri(row.length)] = tri(50);
  }
  // settings (atomic object): sometimes change a field → whole-object replace.
  if (tri(2) === 0) m.settings.theme = THEMES[tri(THEMES.length)] as string;
  if (tri(3) === 0) m.settings.nested.a = tri(10);
  return m;
}

const topoVariants: {
  includeOldValue: boolean;
  emitMoves: boolean;
  wholesaleReplaceFallback: boolean;
}[] = [
  { includeOldValue: true, emitMoves: false, wholesaleReplaceFallback: false },
  { includeOldValue: false, emitMoves: false, wholesaleReplaceFallback: false },
  { includeOldValue: true, emitMoves: true, wholesaleReplaceFallback: false },
  { includeOldValue: false, emitMoves: true, wholesaleReplaceFallback: false },
  { includeOldValue: true, emitMoves: false, wholesaleReplaceFallback: true },
];

{
  const lines: string[] = [];
  let seq = 0;
  const topoPlan = buildPlan({ schema: TOPOLOGY_SCHEMA as never });
  for (let d = 0; d < 30; d++) {
    const original = makeTopoDoc() as unknown as JsonValue;
    const modified = mutateTopoDoc(original as unknown as TopoDoc) as unknown as JsonValue;
    for (const v of topoVariants) {
      const patcher = new JsonSchemaPatcher({
        plan: topoPlan,
        includeOldValue: v.includeOldValue,
        emitMoves: v.emitMoves,
        wholesaleReplaceFallback: v.wholesaleReplaceFallback,
      });
      const tsPatch = patcher.execute({ original, modified });
      const tsApplied = applyPatch(clone(original), tsPatch, {});
      const capLabel = `iov=${v.includeOldValue ? 1 : 0},mov=${v.emitMoves ? 1 : 0},whole=${
        v.wholesaleReplaceFallback ? 1 : 0
      }`;
      lines.push(
        JSON.stringify({
          name: `topology/${seq}/${capLabel}`,
          schemaRef: "topology",
          options: {
            includeOldValue: v.includeOldValue,
            emitMoves: v.emitMoves,
            wholesaleReplaceFallback: v.wholesaleReplaceFallback,
          },
          original,
          modified,
          tsPatch,
          tsApplied,
        }),
      );
      stats.total++;
      stats.byConfig.set("topology", (stats.byConfig.get("topology") ?? 0) + 1);
      stats.byCapability.set(capLabel, (stats.byCapability.get(capLabel) ?? 0) + 1);
      if (tsPatch.length === 0) stats.emptyPatches++;
      stats.totalOps += tsPatch.length;
      for (const op of tsPatch) stats.opCounts.set(op.op, (stats.opCounts.get(op.op) ?? 0) + 1);
      seq++;
    }
  }
  writeFileSync(join(outDir, "topology.jsonl"), `${lines.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// Run summary (also useful as a commit-message reference).
// ---------------------------------------------------------------------------
const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`seed: 0x${SEED.toString(16)}`);
console.log(`records: ${stats.total}`);
console.log(`empty patches: ${stats.emptyPatches}`);
console.log(`total ops: ${stats.totalOps} (avg ${(stats.totalOps / stats.total).toFixed(1)}/record)`);
console.log("by config:");
for (const [k, v] of sorted(stats.byConfig)) console.log(`  ${k}: ${v}`);
console.log("by capability:");
for (const [k, v] of sorted(stats.byCapability)) console.log(`  ${k}: ${v}`);
console.log("ops by type:");
for (const [k, v] of sorted(stats.opCounts)) console.log(`  ${k}: ${v}`);
