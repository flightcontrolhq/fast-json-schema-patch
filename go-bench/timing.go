package main

import (
	"runtime"
	"sort"
	"time"
)

// Timing mirrors the TS runner's { meanMs, p99Ms, minMs, samples } shape so the
// Go and TS result files are directly comparable (analysis/results/*.json).
type Timing struct {
	MeanMs  float64 `json:"meanMs"`
	P99Ms   float64 `json:"p99Ms"`
	MinMs   float64 `json:"minMs"`
	Samples int     `json:"samples"`
}

// Alloc captures per-operation heap allocation statistics for a diff/apply call,
// the Go analogue of testing.B's b.ReportAllocs() (bytes/op, allocs/op).
type Alloc struct {
	BytesPerOp  uint64 `json:"bytesPerOp"`
	AllocsPerOp uint64 `json:"allocsPerOp"`
	Iterations  int    `json:"iterations"`
}

// singleRun times one invocation and reports whether it panicked. Panics are
// recovered so a crashing library is recorded as a verdict, never aborting the
// run (parity with the TS runner catching throws).
func singleRun(fn func()) (ms float64, panicked bool, msg string) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
			msg = toStr(r)
		}
	}()
	t0 := time.Now()
	fn()
	return float64(time.Since(t0).Nanoseconds()) / 1e6, false, ""
}

func toStr(v any) string {
	if e, ok := v.(error); ok {
		return e.Error()
	}
	if s, ok := v.(string); ok {
		return s
	}
	return "panic"
}

// timeIt runs fn under an adaptive budget chosen from a first (already-measured)
// single-run cost, then returns mean/p99/min over the collected samples. The
// budgets mirror the TS tinybench configuration in comparison/bench-v2/run.ts so
// the two engines are timed under equivalent warmup + sample regimes:
//
//	> 300ms  -> 1 warmup + 3 measured iterations (huge, expensive shapes)
//	> 30ms   -> ~80ms warmup, ~250ms measured
//	else     -> ~150ms warmup, ~400ms measured
//
// A hard iteration cap keeps tiny ops from producing millions of samples.
func timeIt(fn func(), singleMs float64) Timing {
	var warmupMs, budgetMs float64
	var maxIters int
	switch {
	case singleMs > 300:
		warmupMs, budgetMs, maxIters = 0, 0, 3
	case singleMs > 30:
		warmupMs, budgetMs, maxIters = 80, 250, 200
	default:
		warmupMs, budgetMs, maxIters = 150, 400, 500_000
	}

	// Warmup.
	if warmupMs > 0 {
		wEnd := time.Now().Add(time.Duration(warmupMs) * float64Ms)
		for time.Now().Before(wEnd) {
			fn()
		}
	} else {
		fn() // one warmup iteration for the expensive branch
	}

	// Measure.
	samples := make([]float64, 0, 1024)
	if budgetMs == 0 {
		for i := 0; i < maxIters; i++ {
			t0 := time.Now()
			fn()
			samples = append(samples, float64(time.Since(t0).Nanoseconds())/1e6)
		}
	} else {
		end := time.Now().Add(time.Duration(budgetMs) * float64Ms)
		for len(samples) < maxIters && time.Now().Before(end) {
			t0 := time.Now()
			fn()
			samples = append(samples, float64(time.Since(t0).Nanoseconds())/1e6)
		}
	}
	return summarize(samples)
}

const float64Ms = time.Millisecond

func summarize(samples []float64) Timing {
	if len(samples) == 0 {
		return Timing{}
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)
	var sum float64
	for _, s := range sorted {
		sum += s
	}
	// p99: nearest-rank, matching tinybench's percentile indexing closely enough
	// for a mean+tail report.
	idx := int(0.99*float64(len(sorted))+0.5) - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(sorted) {
		idx = len(sorted) - 1
	}
	return Timing{
		MeanMs:  sum / float64(len(sorted)),
		P99Ms:   sorted[idx],
		MinMs:   sorted[0],
		Samples: len(sorted),
	}
}

// measureAllocs reports bytes/op and allocs/op for fn over a small fixed batch,
// sized down for expensive shapes so allocation profiling never dominates the
// ~5-minute budget. It brackets the loop with a GC + ReadMemStats pair.
func measureAllocs(fn func(), singleMs float64) Alloc {
	n := 50
	switch {
	case singleMs > 100:
		n = 3
	case singleMs > 10:
		n = 20
	}
	runtime.GC()
	var m0, m1 runtime.MemStats
	runtime.ReadMemStats(&m0)
	for i := 0; i < n; i++ {
		fn()
	}
	runtime.ReadMemStats(&m1)
	return Alloc{
		BytesPerOp:  (m1.TotalAlloc - m0.TotalAlloc) / uint64(n),
		AllocsPerOp: (m1.Mallocs - m0.Mallocs) / uint64(n),
		Iterations:  n,
	}
}
