/**
 * comparison/bench-v2/fix-matrix.ts — the correctness fix matrix (Unit 3).
 *
 *   bun run comparison/bench-v2/fix-matrix.ts
 *
 * Runs the audit's named bug repros against the OLD published engine
 * (fjsp-v040 = fast-json-schema-patch@0.4.0) and THIS branch's engine
 * IN-PROCESS, and emits a machine-readable verdict table to
 * analysis/results/fix-matrix.json. This is the "really fixed" evidence the
 * notebook renders: every OLD verdict is derived from ACTUALLY RUNNING the old
 * engine here (never hard-coded), so the table can never drift from reality.
 *
 * Verdicts:
 *   PASS    — emitted a patch that reconstructs `modified` with a compliant applier
 *   FAIL    — emitted an empty/incomplete patch; the change was SILENTLY lost
 *   CORRUPT — emitted a patch that is unappliable or reconstructs the WRONG doc
 *   CRASH   — the diff (or the whole process) threw / died
 *   N/A     — not directly comparable (internal-only surface absent in 0.4.0)
 *
 * The spread-push repro is run in a fresh subprocess (spread-probe.ts) because
 * the old engine's failure mode is an uncatchable RangeError that would abort
 * this runner.
 */
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as NEW from "../../src/index";
import * as OLD from "fjsp-v040";

const ROOT = join(import.meta.dir, "..", "..");
const RESULTS_DIR = join(ROOT, "analysis", "results");

type Verdict = "PASS" | "FAIL" | "CORRUPT" | "CRASH" | "N/A";
type Outcome = { verdict: Verdict; detail: string; ops?: number | null };

const clone = <T>(v: T): T => structuredClone(v);
const jsonEq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const applyNew = (doc: unknown, patch: unknown) =>
  NEW.applyPatch(clone(doc) as never, patch as never);

// --- schema-aware diff drivers for each engine ---
function newDiff(schema: unknown, original: unknown, modified: unknown, opts: any = {}) {
  const plan = schema ? NEW.buildPlan({ schema: schema as never, ...opts }) : new Map();
  return new NEW.JsonSchemaPatcher({ plan }).execute({
    original: original as never,
    modified: modified as never,
  });
}
function oldDiff(schema: unknown, original: unknown, modified: unknown, opts: any = {}) {
  const o: any = { schema };
  if (opts.primaryKeyMap) o.primaryKeyMap = opts.primaryKeyMap;
  if (opts.basePath !== undefined) o.basePath = opts.basePath;
  const plan = schema ? (OLD as any).buildPlan(o) : new Map();
  return new (OLD as any).JsonSchemaPatcher({ plan }).execute({ original, modified });
}

/**
 * Diff with `diff`, apply with THIS branch's compliant applier, and classify.
 * An empty patch that fails to reconstruct is FAIL (silent loss); a non-empty
 * one that fails is CORRUPT; an unappliable one is CORRUPT; a throwing diff is
 * CRASH.
 */
function roundtripVerdict(
  diff: () => unknown,
  original: unknown,
  modified: unknown,
  eq: (a: unknown, b: unknown) => boolean = jsonEq,
): Outcome {
  let patch: unknown;
  try {
    patch = diff();
  } catch (e) {
    return { verdict: "CRASH", detail: `diff threw: ${(e as Error).message.slice(0, 80)}`, ops: null };
  }
  const ops = Array.isArray(patch) ? patch.length : null;
  let applied: unknown;
  try {
    applied = applyNew(original, patch);
  } catch (e) {
    return { verdict: "CORRUPT", detail: `patch unappliable: ${(e as Error).message.slice(0, 80)}`, ops };
  }
  if (eq(applied, modified)) return { verdict: "PASS", detail: `reconstructs modified`, ops };
  if (ops === 0) return { verdict: "FAIL", detail: "empty patch — change silently lost", ops };
  return { verdict: "CORRUPT", detail: "applied patch does not reconstruct modified", ops };
}

// ===========================================================================
// Repro registry. Each `run()` ACTUALLY exercises both engines.
// ===========================================================================
type Repro = {
  id: string;
  finding: string;
  title: string;
  spec: string;
  category: "correctness" | "crash" | "regression-guard";
  expectation: string;
  run(): { old: Outcome; new: Outcome };
};

const KEYED_SCHEMA = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, name: { type: "string" } },
      },
    },
  },
};
const NUM_ITEMS_SCHEMA = {
  type: "object",
  properties: { items: { type: "array", items: { type: "number" } } },
};
const DUP_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" }, v: { type: "number" } },
      },
    },
  },
};

const repros: Repro[] = [
  {
    id: "root-array-to-empty",
    finding: "apply/root",
    title: "Root array cleared to [] emits an unappliable patch",
    spec: "§8.2 (root pointer)",
    category: "correctness",
    expectation:
      "OLD emits `remove '/'` ops that throw on apply; NEW emits descending index removes that reconstruct [].",
    run() {
      const schema = { type: "array", items: { type: "number" } };
      const original = [1, 2, 3];
      const modified: number[] = [];
      return {
        old: roundtripVerdict(() => oldDiff(schema, original, modified), original, modified),
        new: roundtripVerdict(() => newDiff(schema, original, modified), original, modified),
      };
    },
  },
  {
    id: "slash-in-key-sibling-corruption",
    finding: "F-pointer",
    title: "'/' in an object key silently corrupts a sibling on apply",
    spec: "§8.2.3 (RFC 6901 ~1 escaping)",
    category: "correctness",
    expectation:
      "OLD emits unescaped path `/a/b`, which apply routes into the sibling object `a.b`; NEW escapes to `/a~1b`.",
    run() {
      const original = { "a/b": 1, a: { b: 2 } };
      const modified = { "a/b": 9, a: { b: 2 } };
      return {
        old: roundtripVerdict(() => oldDiff(null, original, modified), original, modified),
        new: roundtripVerdict(() => newDiff(null, original, modified), original, modified),
      };
    },
  },
  {
    id: "duplicate-primary-key-mutation",
    finding: "F05/F06",
    title: "Duplicate primaryKey mutates an UNCHANGED array",
    spec: "§5.4.3 (uniqueness gate)",
    category: "correctness",
    expectation:
      "With two items sharing a key and original===modified, OLD emits spurious ops; NEW gates the strategy off and emits nothing.",
    run() {
      const doc = { items: [{ id: "dup", v: 1 }, { id: "dup", v: 2 }] };
      return {
        old: roundtripVerdict(() => oldDiff(DUP_SCHEMA, doc, clone(doc)), doc, clone(doc)),
        new: roundtripVerdict(() => newDiff(DUP_SCHEMA, doc, clone(doc)), doc, clone(doc)),
      };
    },
  },
  {
    id: "keyless-item-silent-drop",
    finding: "F05",
    title: "Keyless item added to a keyed array is silently dropped",
    spec: "§5.4.3 (applicability gate -> LCS fallback)",
    category: "correctness",
    expectation:
      "OLD skips the key-less element (empty patch, add lost); NEW falls back to LCS and round-trips.",
    run() {
      const original = { users: [{ id: "a", name: "A" }] };
      const modified = { users: [{ id: "a", name: "A" }, { name: "no-id-yet" }] };
      return {
        old: roundtripVerdict(() => oldDiff(KEYED_SCHEMA, original, modified), original, modified),
        new: roundtripVerdict(() => newDiff(KEYED_SCHEMA, original, modified), original, modified),
      };
    },
  },
  {
    id: "date-silent-equality",
    finding: "F16",
    title: "Two different Dates compare equal (silent data loss)",
    spec: "§2.1.2 (non-JSON opaque leaves)",
    category: "correctness",
    expectation:
      "Both Dates have zero own keys, so OLD's own-key compare treats them equal (empty patch); NEW compares them as opaque leaves.",
    run() {
      const schema = { type: "object", properties: { updatedAt: { type: "string" } } };
      const original = { updatedAt: new Date(2020, 0, 1) } as any;
      const modified = { updatedAt: new Date(2021, 0, 1) } as any;
      // JSON serialisation renders Dates as ISO strings, so jsonEq is exact here.
      return {
        old: roundtripVerdict(() => oldDiff(schema, original, modified), original, modified),
        new: roundtripVerdict(() => newDiff(schema, original, modified), original, modified),
      };
    },
  },
  {
    id: "mutate-then-rediff-staleness",
    finding: "F02",
    title: "Mutate-in-place then re-diff returns a stale (empty) verdict",
    spec: "§2.4.4 (output-neutral memoisation)",
    category: "correctness",
    expectation:
      "A field mutated in place outside the hash-prefilter set is missed on the second diff by OLD's stale equality cache; NEW's caches are epoch-invalidated.",
    run() {
      const schema = {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                a: { type: "number" },
                b: { type: "number" },
                c: { type: "number" },
                d: { type: "number" },
              },
            },
          },
        },
      };
      function drive(engine: "old" | "new"): Outcome {
        const modRow = { a: 1, b: 2, c: 3, d: 4 };
        const original = { rows: [{ a: 1, b: 2, c: 3, d: 4 }] };
        const modified = { rows: [modRow] };
        try {
          const plan =
            engine === "new"
              ? NEW.buildPlan({ schema: schema as never })
              : (OLD as any).buildPlan({ schema });
          const patcher =
            engine === "new"
              ? new NEW.JsonSchemaPatcher({ plan: plan as never })
              : new (OLD as any).JsonSchemaPatcher({ plan });
          const first = patcher.execute({ original: original as never, modified: modified as never });
          if ((first as unknown[]).length !== 0)
            return { verdict: "CORRUPT", detail: "first diff of equal docs was non-empty", ops: (first as unknown[]).length };
          modRow.d = 999; // in-place mutation of a field outside the prefilter set
          const second = patcher.execute({ original: original as never, modified: modified as never });
          const ops = (second as unknown[]).length;
          if (ops === 0) return { verdict: "FAIL", detail: "second diff missed the in-place mutation (stale cache)", ops };
          const applied = applyNew(original, second);
          return jsonEq(applied, modified)
            ? { verdict: "PASS", detail: "second diff saw the mutation and round-trips", ops }
            : { verdict: "CORRUPT", detail: "second diff did not reconstruct modified", ops };
        } catch (e) {
          return { verdict: "CRASH", detail: `threw: ${(e as Error).message.slice(0, 80)}` };
        }
      }
      return { old: drive("old"), new: drive("new") };
    },
  },
  {
    id: "basepath-segment-boundary",
    finding: "plan/basePath",
    title: "basePath prefix-match captures a sibling and corrupts the plan key",
    spec: "§4.6.2 (segment-boundary matching)",
    category: "correctness",
    expectation:
      "basePath '/env' string-prefix-matches sibling '/envelope/stamps', stripped mid-segment to the unmatchable key 'elope/stamps'; NEW matches on a segment boundary.",
    run() {
      const schema = {
        type: "object",
        properties: {
          env: {
            type: "object",
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id"],
                  properties: { id: { type: "string" }, v: { type: "number" } },
                },
              },
            },
          },
          envelope: {
            type: "object",
            properties: {
              stamps: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id"],
                  properties: { id: { type: "string" }, v: { type: "number" } },
                },
              },
            },
          },
        },
      };
      function classify(keys: string[]): Outcome {
        const corrupt = keys.filter((k) => k !== "" && !k.startsWith("/"));
        return corrupt.length
          ? { verdict: "CORRUPT", detail: `plan keys never matchable at diff time: ${JSON.stringify(corrupt)}` }
          : { verdict: "PASS", detail: `all plan keys segment-boundary-relative: ${JSON.stringify(keys)}` };
      }
      let oldOut: Outcome;
      let newOut: Outcome;
      try {
        oldOut = classify([...(OLD as any).buildPlan({ schema, basePath: "/env" }).keys()]);
      } catch (e) {
        oldOut = { verdict: "CRASH", detail: `buildPlan threw: ${(e as Error).message.slice(0, 80)}` };
      }
      try {
        newOut = classify([...NEW.buildPlan({ schema: schema as never, basePath: "/env" }).keys()]);
      } catch (e) {
        newOut = { verdict: "CRASH", detail: `buildPlan threw: ${(e as Error).message.slice(0, 80)}` };
      }
      return { old: oldOut, new: newOut };
    },
  },
  {
    id: "structured-diff-digit-regex",
    finding: "F17",
    title: "StructuredDiff remove-fallback `\\d` regex cooked to literal 'd'",
    spec: "§6 (StructuredDiff aggregation)",
    category: "correctness",
    expectation:
      "The index-extraction regex was built in an untagged template where `\\d` becomes 'd', so numeric indices never matched. NEW's extractIndexAfterPrefix rejects literal-'d' paths and extracts real indices; v0.4.0 has no such helper to compare against.",
    run() {
      // NEW: verify the fixed helper directly.
      let newOut: Outcome;
      try {
        const sd = new NEW.StructuredDiff({ plan: new Map() as never }) as unknown as {
          extractIndexAfterPrefix?: (p: string, pre: string) => number | undefined;
        };
        const fn = sd.extractIndexAfterPrefix?.bind(sd);
        if (typeof fn !== "function") {
          newOut = { verdict: "N/A", detail: "extractIndexAfterPrefix not exposed" };
        } else {
          const rejectsLiteralD = fn("/users/ddd", "/users") === undefined;
          const extractsIndex = fn("/users/42", "/users") === 42;
          const nested = fn("/users/12/name", "/users") === 12;
          newOut =
            rejectsLiteralD && extractsIndex && nested
              ? { verdict: "PASS", detail: "regex extracts numeric indices and rejects literal 'd' segments" }
              : { verdict: "CORRUPT", detail: `unexpected: rejectsLiteralD=${rejectsLiteralD} extractsIndex=${extractsIndex} nested=${nested}` };
        }
      } catch (e) {
        newOut = { verdict: "CRASH", detail: `threw: ${(e as Error).message.slice(0, 80)}` };
      }
      // OLD: the buggy helper is a private of a differently-shaped 0.4.0
      // aggregator with no exposed counterpart; recorded N/A with the root cause.
      const sdOld = new (OLD as any).StructuredDiff({ plan: new Map() }) as any;
      const oldOut: Outcome = {
        verdict: "N/A",
        detail:
          typeof sdOld.extractIndexAfterPrefix === "function"
            ? "0.4.0 exposes the helper (unexpected)"
            : "0.4.0 aggregator predates the helper; buggy `\\d`->'d' path documented in F17",
      };
      return { old: oldOut, new: newOut };
    },
  },
  {
    id: "spread-push-rangeerror",
    finding: "F13",
    title: "Clearing a huge keyed array RangeErrors via `push(...ops)`",
    spec: "§5.4 (op emission)",
    category: "crash",
    expectation:
      "OLD emits removals with `patches.push(...removalPatches)`; past the runtime arg cap this throws an uncatchable RangeError. NEW emits with a loop. Run in a fresh subprocess.",
    run() {
      const probe = join(import.meta.dir, "spread-probe.ts");
      function runChild(which: "old" | "new"): Outcome {
        const res = spawnSync("bun", ["run", probe, which], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        if (res.status === 0) {
          try {
            const p = JSON.parse(res.stdout.trim().split("\n").pop() as string);
            return { verdict: "PASS", detail: `emitted ${p.len} removals (first ${p.first})`, ops: p.len };
          } catch {
            return { verdict: "PASS", detail: "completed (unparsed output)" };
          }
        }
        const err = (res.stderr || "").match(/RangeError[^\n]*/)?.[0] ?? `exit ${res.status}`;
        return { verdict: "CRASH", detail: err.slice(0, 100) };
      }
      return { old: runChild("old"), new: runChild("new") };
    },
  },
  {
    id: "lcs-65536-cliff",
    finding: "F21/F34",
    title: "70k single-edit at the exact 65,536 interning cliff",
    spec: "§5.5 (interned LCS)",
    category: "regression-guard",
    expectation:
      "NEW's interned-LCS packs window elements to integer ids; the edit at index 65,536 sits on the old 16-bit packing boundary. NEW is proven correct here (regression guard). Published v0.4.0 also passes (its LCS predates the interning rewrite).",
    run() {
      const a = Array.from({ length: 70_000 }, (_, i) => i);
      const b = [...a];
      b[65_536] = -1;
      const original = { items: a };
      const modified = { items: b };
      return {
        old: roundtripVerdict(() => oldDiff(NUM_ITEMS_SCHEMA, original, modified), original, modified),
        new: roundtripVerdict(() => newDiff(NUM_ITEMS_SCHEMA, original, modified), original, modified),
      };
    },
  },
];

// ===========================================================================
// Run + emit
// ===========================================================================
function sh(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const oldVersion = JSON.parse(
  readFileSync(join(ROOT, "node_modules", "fjsp-v040", "package.json"), "utf8"),
).version as string;
const ourVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
let corpusSha = "unknown";
try {
  corpusSha = createHash("sha256")
    .update(readFileSync(join(ROOT, "comparison", "corpora", "manifest.json")))
    .digest("hex")
    .slice(0, 16);
} catch {}

const rows = repros.map((r) => {
  const { old, new: neu } = r.run();
  process.stdout.write(
    `  ${r.id.padEnd(34)} OLD=${old.verdict.padEnd(7)} NEW=${neu.verdict.padEnd(4)}  ${r.title}\n`,
  );
  return {
    id: r.id,
    finding: r.finding,
    title: r.title,
    spec: r.spec,
    category: r.category,
    expectation: r.expectation,
    old,
    new: neu,
  };
});

const summary = {
  oldBroken: rows.filter((r) => ["FAIL", "CORRUPT", "CRASH"].includes(r.old.verdict)).length,
  newPass: rows.filter((r) => r.new.verdict === "PASS").length,
  total: rows.length,
};

const out = {
  schemaVersion: 1,
  runner: "comparison/bench-v2/fix-matrix.ts",
  generatedAt: new Date().toISOString(),
  commit: sh("git rev-parse HEAD"),
  branch: sh("git rev-parse --abbrev-ref HEAD"),
  corpusManifestSha256: corpusSha,
  engines: {
    ours: { source: "this branch (src/)", version: ourVersion },
    "fjsp-v040": { source: "npm:fast-json-schema-patch", version: oldVersion },
  },
  platform: { os: process.platform, arch: process.arch, bun: (globalThis as any).Bun?.version ?? "unknown" },
  verdictLegend: {
    PASS: "reconstructs modified with a compliant applier",
    FAIL: "empty/incomplete patch — change silently lost",
    CORRUPT: "unappliable patch or wrong reconstruction",
    CRASH: "diff or process threw/died",
    "N/A": "internal-only surface not comparable against 0.4.0",
  },
  summary,
  repros: rows,
};

mkdirSync(RESULTS_DIR, { recursive: true });
const outFile = join(RESULTS_DIR, "fix-matrix.json");
writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
process.stdout.write(
  `\nOLD broken on ${summary.oldBroken}/${summary.total}; NEW passes ${summary.newPass}/${summary.total}\n`,
);
process.stdout.write(`wrote ${outFile}\n`);
