# analysis/ — benchmark & analysis pipeline

Reproducible proof that the overhaul on `feat/deep-dive-overhaul` is (a) **correct** — the
audit bugs are fixed with data, old `fjsp@0.4.0` vs this branch — and (b) **competitive** —
the TS engine vs JS competitors and the Go engine vs Go competitors, on one **identical,
seeded corpus**.

## Layout

| Path | What it is |
|---|---|
| `results/bench-v2.json` | TS engine (`ours`, `ours+emitMoves`) vs old `fjsp@0.4.0` vs JS competitors. Written by `comparison/bench-v2/run.ts`. |
| `results/go-bench.json` | Go engine vs Go competitors + the `ApplyPatch` vs `evanphx` apply race. Written by `go-bench/`. |
| `results/fix-matrix.json` | Audit-bug verdict matrix (old vs new), one repro per bug. Written by `comparison/bench-v2/fix-matrix.ts`. |
| `benchmark_visualization.ipynb` | The analysis narrative. **Committed with executed outputs.** Reads every number from `results/` — nothing is hardcoded. |
| `pyproject.toml` | `uv` environment for executing the notebook. |

The result JSON files are **versioned artifacts** — we want them in git. Corpora generation
is seeded (`seed 20240521`) and deterministic, so a re-run reproduces byte-identical inputs;
the TS and Go runners assert their `manifestSha256` match before trusting a cross-engine
comparison.

## Regenerate — three commands (from the repo root)

```bash
# 1. Seeded, deterministic shared corpora -> comparison/corpora/cases/*.json + manifest.json
bun run comparison/corpora/generate.ts

# 2. Run both engine benches -> analysis/results/*.json
bun run bench:ts        # TS: ours (+emitMoves) vs old fjsp@0.4.0 vs JS competitors
bun run bench:go        # Go: ours (+emitMoves) vs Go competitors + apply race
#    (fix-matrix.json is (re)produced by:)
bun run comparison/bench-v2/fix-matrix.ts

# 3. Execute the notebook in place (committed output = real executed cells)
cd analysis && uv run jupyter nbconvert --to notebook --execute --inplace benchmark_visualization.ipynb
```

`uv` reads `analysis/pyproject.toml` for the pinned pandas / matplotlib / jupyter / nbconvert
stack. No global Python setup is required.

## Notebook sections

1. **Header** — what changed, commit SHAs + generation dates + machine, corpus manifest, regen steps (all read from the JSON).
2. **"Really fixed"** — styled verdict matrix, old `@0.4.0` vs new, each row citing its repro line in `comparison/bench-v2/fix-matrix.ts`.
3. **Correctness / round-trip rate** across every library, with the honest multiset caveat and the `emitMoves` exact-order bar alongside.
4. **TS perf** — old-vs-new grouped bars per corpus class (log y), the LCS pathologies isolated (65 536 cliff, 4k-disjoint, historical crash/OOM notes from the fix matrix), then TS vs JS competitors (diff time + patch bytes, separate charts).
5. **Go** — engine vs Go competitors (diff time with the decode-cost-split methodology note, patch bytes, `ApplyPatch` vs `evanphx`).
6. **Cross-engine** — TS vs Go on identical cases, captioned as an apples-to-oranges runtime snapshot.
7. **Patch-size scoreboard** — all libraries × representative cases, with our capability modes as distinct rows.
8. **Takeaways** — honest summary computed programmatically: where we win, where competitors win.

## Guardrails

- **No hardcoded metrics.** Every figure and table reads from `results/`. Repro citations grep
  `fix-matrix.ts` for line numbers at render time.
- **Zero-dependency engine.** `go/` has no third-party deps; the competitor benchmark lives in
  its own `go-bench/` module.
- **Corpus determinism** is enforced by seed + a manifest hash asserted equal across the TS and
  Go runners.
