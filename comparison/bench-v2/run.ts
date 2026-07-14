/**
 * comparison/bench-v2/run.ts — the TS benchmark runner (Unit 2).
 *
 *   bun run comparison/bench-v2/run.ts
 *
 * For every case in comparison/corpora it benchmarks THIS branch's engine
 * (default + emitMoves), the OLD published engine (fjsp-v040 npm alias), and
 * the generic competitors fast-json-patch / rfc6902 / jsondiffpatch /
 * json-diff-kit on the IDENTICAL corpora, measuring per (case, library):
 *
 *   - diff wall-time      (tinybench, warmup + adaptive budget, mean + p99)
 *   - patch size bytes     (JSON.stringify of the native patch/delta)
 *   - apply wall-time      (where the library has a real applier)
 *   - peak memory          (fresh-subprocess probe, pathological shapes only)
 *   - round-trip verdict   (PASS / CORRUPT / CRASH / NO-APPLIER / SKIPPED)
 *
 * Robustness: diff/apply throws are caught and recorded (CRASH/CORRUPT) rather
 * than aborting the run; json-diff-kit is pre-SKIPPED on very large arrays (it
 * is O(n^2) and would hang); rfc6902 stack-overflows on huge arrays and is
 * recorded as CRASH. The full run is budgeted to stay well under ~5 minutes.
 *
 * Output: analysis/results/bench-v2.json — versioned (schemaVersion), with the
 * commit SHA, corpus manifest SHA, engine versions and platform embedded.
 */
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Bench } from "tinybench";
import { ADAPTERS, type Adapter, type CorpusCase, maxArrayLength, verdictFor } from "./libs";

const ROOT = join(import.meta.dir, "..", "..");
const CORPORA = join(ROOT, "comparison", "corpora");
const RESULTS_DIR = join(ROOT, "analysis", "results");
const MEM_PROBE = join(import.meta.dir, "mem-probe.ts");
const MEM_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------
function sh(cmd: string): string {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
const manifestRaw = readFileSync(join(CORPORA, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestRaw) as {
  seed: number;
  count: number;
  cases: { name: string; file: string; measureMemory: boolean }[];
};
const corpusSha = createHash("sha256").update(manifestRaw).digest("hex").slice(0, 16);
const oldVersion = JSON.parse(
  readFileSync(join(ROOT, "node_modules", "fjsp-v040", "package.json"), "utf8"),
).version as string;
const ourVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

// ---------------------------------------------------------------------------
// Timing helper (adaptive budget so slow libraries never blow the time cap)
// ---------------------------------------------------------------------------
type Timing = { meanMs: number; p99Ms: number; minMs: number; samples: number };

async function timeIt(label: string, fn: () => void, singleMs: number): Promise<Timing> {
  // Choose a budget from a first (already-measured) single run.
  let cfg: ConstructorParameters<typeof Bench>[0];
  if (singleMs > 300) cfg = { time: 0, iterations: 3, warmupTime: 0, warmupIterations: 1 };
  else if (singleMs > 30) cfg = { time: 250, warmupTime: 80, warmupIterations: 2 };
  else cfg = { time: 400, warmupTime: 150 };
  const bench = new Bench(cfg);
  bench.add(label, fn);
  await bench.run();
  const l = (bench.tasks[0]?.result as any).latency;
  return { meanMs: l.mean, p99Ms: l.p99, minMs: l.min, samples: l.samplesCount };
}

/** One timed single run; returns ms and whether it threw. */
function singleRun(fn: () => void): { ms: number; threw: boolean; error?: string } {
  const t0 = performance.now();
  try {
    fn();
    return { ms: performance.now() - t0, threw: false };
  } catch (e) {
    return { ms: performance.now() - t0, threw: true, error: (e as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Per-(case, adapter) measurement
// ---------------------------------------------------------------------------
type LibResult = {
  library: string;
  label: string;
  kind: string;
  verdict: string;
  verdictDetail: string;
  patchBytes: number | null;
  patchOps: number | null;
  diff: Timing | null;
  apply: Timing | null;
  memory: {
    heapUsedBytes: number;
    heapDeltaBytes: number;
    rssBytes: number;
    maxRss: number;
    rssUnit: string;
  } | null;
  skippedReason?: string;
};

function applicable(a: Adapter, c: CorpusCase): { ok: boolean; reason?: string } {
  // emitMoves variant is only meaningful for schema-aware (planned) cases.
  if (a.id === "ours-moves" && c.schema === null)
    return { ok: false, reason: "no schema -> no plan; emitMoves not applicable" };
  if (a.maxArrayLen !== undefined) {
    const n = maxArrayLength(c.original) > maxArrayLength(c.modified) ? maxArrayLength(c.original) : maxArrayLength(c.modified);
    if (n > a.maxArrayLen)
      return { ok: false, reason: `array length ${n} > ${a.maxArrayLen} (O(n^2); would hang)` };
  }
  return { ok: true };
}

function probeMemory(caseFile: string, adapterId: string): LibResult["memory"] | { crash: string } {
  const res = spawnSync("bun", ["run", MEM_PROBE, caseFile, adapterId], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: MEM_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error && (res.error as any).code === "ETIMEDOUT") return { crash: "TIMEOUT" };
  if (res.status !== 0) return { crash: (res.stderr || "nonzero exit").slice(0, 120) };
  try {
    const line = res.stdout.trim().split("\n").pop() as string;
    const p = JSON.parse(line);
    return {
      heapUsedBytes: p.heapUsedBytes,
      heapDeltaBytes: p.heapDeltaBytes,
      rssBytes: p.rssBytes,
      maxRss: p.maxRss,
      rssUnit: p.rssUnit,
    };
  } catch (e) {
    return { crash: `unparseable probe output: ${(e as Error).message}` };
  }
}

async function measure(a: Adapter, c: CorpusCase, caseFile: string): Promise<LibResult> {
  const base: LibResult = {
    library: a.id,
    label: a.label,
    kind: a.kind,
    verdict: "PASS",
    verdictDetail: "",
    patchBytes: null,
    patchOps: null,
    diff: null,
    apply: null,
    memory: null,
  };

  const app = applicable(a, c);
  if (!app.ok) {
    return { ...base, verdict: "SKIPPED", skippedReason: app.reason };
  }

  // Round-trip verdict (runs diff+apply once; catches CRASH/CORRUPT).
  const { verdict, detail } = verdictFor(a, c);
  base.verdict = verdict;
  base.verdictDetail = detail;

  if (verdict === "CRASH") return base; // no timing/size/memory for a crashing diff

  // Patch size + op count (single diff).
  let patch: unknown;
  const first = singleRun(() => {
    patch = a.diff(c);
  });
  if (!first.threw && patch !== undefined) {
    base.patchBytes = JSON.stringify(patch).length;
    base.patchOps = Array.isArray(patch) ? patch.length : null;
  } else if (!first.threw) {
    base.patchBytes = 0; // e.g. jsondiffpatch empty delta
    base.patchOps = null;
  }

  // Diff wall-time.
  base.diff = await timeIt(`diff:${a.id}:${c.name}`, () => a.diff(c), first.ms);

  // Apply wall-time (only for adapters with a real applier and a valid patch;
  // CRASH verdicts already returned above).
  if (a.hasApplier) {
    const p = patch;
    const applySingle = singleRun(() => a.apply(c, p));
    if (!applySingle.threw)
      base.apply = await timeIt(`apply:${a.id}:${c.name}`, () => a.apply(c, p), applySingle.ms);
  }

  // Peak memory (pathological shapes only), via fresh subprocess.
  if (c.measureMemory) {
    const mem = probeMemory(caseFile, a.id);
    if (mem && "crash" in mem) {
      // Do not overwrite a PASS/CORRUPT verdict; annotate memory failure.
      base.memory = null;
      base.verdictDetail = base.verdictDetail
        ? `${base.verdictDetail}; memory-probe: ${mem.crash}`
        : `memory-probe: ${mem.crash}`;
    } else {
      base.memory = mem;
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date().toISOString();
  const wall0 = performance.now();
  const results: Array<{
    case: string;
    category: string;
    description: string;
    roundtrip: string;
    measureMemory: boolean;
    tags: string[];
    maxArrayLen: number;
    libraries: LibResult[];
  }> = [];

  for (const entry of manifest.cases) {
    const caseFile = join(CORPORA, entry.file);
    const c = JSON.parse(readFileSync(caseFile, "utf8")) as CorpusCase;
    const libraries: LibResult[] = [];
    for (const a of ADAPTERS) {
      const r = await measure(a, c, caseFile);
      libraries.push(r);
      const v = r.verdict === "PASS" ? r.verdict : `${r.verdict}${r.skippedReason ? ` (${r.skippedReason})` : ""}`;
      const dt = r.diff ? `${r.diff.meanMs.toFixed(3)}ms` : "-";
      process.stdout.write(`  ${c.name} :: ${a.id.padEnd(16)} ${v.padEnd(10)} diff=${dt} bytes=${r.patchBytes ?? "-"}\n`);
    }
    results.push({
      case: c.name,
      category: c.category,
      description: c.description,
      roundtrip: c.roundtrip,
      measureMemory: c.measureMemory,
      tags: c.tags,
      maxArrayLen: Math.max(maxArrayLength(c.original), maxArrayLength(c.modified)),
      libraries,
    });
  }

  const wallMs = performance.now() - wall0;
  const out = {
    schemaVersion: 1,
    runner: "comparison/bench-v2/run.ts",
    generatedAt: startedAt,
    wallClockMs: Math.round(wallMs),
    commit: sh("git rev-parse HEAD"),
    branch: sh("git rev-parse --abbrev-ref HEAD"),
    corpus: {
      seed: manifest.seed,
      caseCount: manifest.count,
      manifestSha256: corpusSha,
    },
    engines: {
      ours: { source: "this branch (src/)", version: ourVersion },
      "fjsp-v040": { source: "npm:fast-json-schema-patch", version: oldVersion },
    },
    platform: {
      os: process.platform,
      arch: process.arch,
      bun: (globalThis as any).Bun?.version ?? "unknown",
      node: process.version,
      cpus: sh("sysctl -n machdep.cpu.brand_string") || "unknown",
    },
    adapters: ADAPTERS.map((a) => ({ id: a.id, label: a.label, kind: a.kind, hasApplier: a.hasApplier })),
    results,
  };

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = join(RESULTS_DIR, "bench-v2.json");
  writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`\nwrote ${outFile}\n`);
  process.stdout.write(`full run: ${(wallMs / 1000).toFixed(1)}s over ${manifest.count} cases\n`);
}

await main();
