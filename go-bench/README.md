# go-bench

Go-side benchmark + analysis runner for the deep-dive comparison. It is a
**separate module** (its own `go.mod`, `replace` directive to `../go`) so the
engine module `go/` stays **zero-dependency**; all third-party competitor libs
live here.

```sh
bun run bench:go        # from the repo root
# or:
cd go-bench && go run .
```

Output: `analysis/results/go-bench.json` — same schema as the TS runner's
`analysis/results/bench-v2.json` (`schemaVersion`, commit SHA, corpus
`manifestSha256`, per-case per-library records). Runs on the **identical shared
corpus** (`comparison/corpora`); the `manifestSha256` must match the TS file
(both `1fd566d5dc7059c4`), which is what proves the two engines are measured on
the same inputs. Total runtime ~4 min.

## What is measured

Per case, per library:

| adapter        | role | notes |
|----------------|------|-------|
| `ours`         | diff | our Go engine, `BuildPlan` + `Execute`, default caps |
| `ours-moves`   | diff | our engine with `EmitMoves(true)` (schema cases only) |
| `jsondiff`     | diff | `github.com/wI2L/jsondiff` (RFC 6902 — closest Go analogue) |
| `snorwin`      | diff | `github.com/snorwin/jsonpatch` |
| `mattbaird`    | diff | `github.com/mattbaird/jsonpatch` (historic) |
| `ours-apply`   | apply | our `ApplyPatch` |
| `evanphx`      | apply | `github.com/evanphx/json-patch/v5` |

## Methodology (fairness notes)

- **Timing** — manual warmup + adaptive-budget sample loop (`timing.go`),
  reporting `mean`/`p99`/`min`. Budgets mirror the TS tinybench runner so both
  engines are timed under equivalent regimes. `ours` diff timing includes plan
  build + patcher construction per call, matching the TS `ours` adapter.
- **Decode cost** — our engine consumes the ordered `Value` model; competitors
  take `[]byte` or `interface{}`. Each diff row reports **three framings** so
  the comparison is fair regardless of input form:
  - `diff` — patch from **pre-parsed** inputs (no I/O).
  - `decode` — bytes → parsed input form (`null` for byte-only `mattbaird`,
    whose diff already embeds the parse).
  - `e2e` — bytes → patch(→ bytes); the end-to-end comparison.
- **Allocations** — `alloc.bytesPerOp` / `allocsPerOp` for the diff op (the Go
  analogue of `b.ReportAllocs`). Pathological (`measureMemory`) cases add an
  in-process `memory` live-heap proxy — **not** comparable to the TS side's
  subprocess peak-RSS probe.
- **Round-trip verdicts** — `PASS` / `CORRUPT` / `CRASH` / `NO-APPLIER` /
  `SKIPPED`. Competitor patches are judged with **evanphx as the neutral
  applier**; our own patches with our `ApplyPatch` (the subject). `multiset`
  cases use an order-normalized contract (`verdictDetail=multiset-canonical`).
- **Apply race** — `ours-apply` and `evanphx` apply the **identical** canonical
  patch (the `jsondiff` default `original→modified` output), pre-decoded once,
  so the two appliers are compared on the same work.

Competitor versions are pinned in `go.mod` and echoed into the result file's
`engines` block.
