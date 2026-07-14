/**
 * comparison/bench-v2/mem-probe.ts — single-shot peak-memory probe, run as a
 * FRESH bun subprocess per (case, adapter) by run.ts.
 *
 *   bun run comparison/bench-v2/mem-probe.ts <caseFile> <adapterId>
 *
 * A fresh process is spawned per measurement so heap/RSS reflect only that one
 * diff (no cross-measurement accumulation, no GC coupling). It prints a single
 * JSON line to stdout:
 *
 *   { ok, ms, rssBytes, heapUsedBytes, maxRssBytes, rssUnit }
 *
 * or, on failure, exits non-zero (crash) — the parent records CRASH. The parent
 * additionally imposes a hard wall-clock timeout to catch super-linear hangs.
 *
 * Note on maxRSS units: process.resourceUsage().maxRSS is BYTES on macOS/Darwin
 * and KILOBYTES on Linux; `rssUnit` records which so downstream analysis can
 * normalise. `rssBytes` (process.memoryUsage().rss) is always bytes.
 */
import { readFileSync } from "node:fs";
import { ADAPTERS, type CorpusCase } from "./libs";

const [, , caseFile, adapterId] = process.argv;
if (!caseFile || !adapterId) {
  console.error("usage: mem-probe.ts <caseFile> <adapterId>");
  process.exit(2);
}

const c = JSON.parse(readFileSync(caseFile, "utf8")) as CorpusCase;
const adapter = ADAPTERS.find((a) => a.id === adapterId);
if (!adapter) {
  console.error(`unknown adapter ${adapterId}`);
  process.exit(2);
}

// Touch the parsed doc so lazy costs are realised, then measure a single diff.
const before = process.memoryUsage().heapUsed;
const t0 = performance.now();
const patch = adapter.diff(c); // may throw -> non-zero exit -> parent records CRASH
const ms = performance.now() - t0;

const mem = process.memoryUsage();
// process.resourceUsage() is unavailable on some runtimes (e.g. Bun); fall back
// to memoryUsage().rss as the peak proxy when it is missing.
const ru =
  typeof (process as any).resourceUsage === "function"
    ? (process as any).resourceUsage()
    : { maxRSS: mem.rss };
const rssUnit =
  typeof (process as any).resourceUsage === "function" && process.platform === "linux"
    ? "kilobytes"
    : "bytes";

// Keep `patch` reachable through the measurement so it is not GC'd early.
const patchBytes = patch === undefined ? 0 : JSON.stringify(patch).length;

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    ms,
    patchBytes,
    heapUsedBytes: mem.heapUsed,
    heapDeltaBytes: mem.heapUsed - before,
    rssBytes: mem.rss,
    maxRss: ru.maxRSS,
    rssUnit,
  })}\n`,
);
