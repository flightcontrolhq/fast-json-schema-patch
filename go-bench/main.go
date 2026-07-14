// Command go-bench is the Go-side benchmark runner for the schema-json-patch
// deep-dive comparison. It benchmarks THIS repo's Go engine (BuildPlan+Execute,
// default and emitMoves; and ApplyPatch) against the Go RFC 6902 competitors
// wI2L/jsondiff, snorwin/jsonpatch, mattbaird/jsonpatch (diff generation) and
// evanphx/json-patch/v5 (apply side) on the IDENTICAL shared corpora that the
// TS runner uses (comparison/corpora), and emits analysis/results/go-bench.json
// in the same schema as the TS results (analysis/results/bench-v2.json).
//
// Methodology (documented inline so the numbers are reproducible and fair):
//
//   - Timing: manual warmup + adaptive-budget sample loop (timing.go), mean/p99/min,
//     matching the TS tinybench budgets so the two engines are timed alike.
//   - Decode cost: our engine consumes the ordered Value model, competitors take
//     []byte or interface{}. Each diff row therefore reports THREE framings:
//     diff   — patch produced from PRE-PARSED inputs (Value / any); no I/O.
//     decode — bytes -> parsed input form (nil for byte-only libs).
//     e2e    — bytes -> patch(-> bytes); the fair end-to-end comparison.
//   - Allocations: bytes/op and allocs/op for the diff op (Go analogue of
//     b.ReportAllocs); pathological shapes additionally record a live-heap proxy.
//   - Round-trip verdict: PASS / CORRUPT / CRASH / NO-APPLIER / SKIPPED. Competitor
//     patches are judged with evanphx as the NEUTRAL applier; our own patches with
//     our ApplyPatch (the subject). Multiset cases use an order-normalized contract.
//   - Apply race: ours-apply and evanphx apply the IDENTICAL canonical patch (the
//     jsondiff default original->modified output), pre-decoded once.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	sp "github.com/flightcontrolhq/fast-json-schema-patch/go"
	jd "github.com/wI2L/jsondiff"
)

// ---------------------------------------------------------------------------
// Output schema (parity with analysis/results/bench-v2.json + Go-specific rows)
// ---------------------------------------------------------------------------

type Memory struct {
	HeapInuseBytes  uint64 `json:"heapInuseBytes"`
	AllocBytesPerOp uint64 `json:"allocBytesPerOp"`
	AllocsPerOp     uint64 `json:"allocsPerOp"`
	Note            string `json:"note"`
}

type LibResult struct {
	Library       string  `json:"library"`
	Label         string  `json:"label"`
	Kind          string  `json:"kind"`
	Role          string  `json:"role"` // "diff" | "apply"
	Verdict       string  `json:"verdict"`
	VerdictDetail string  `json:"verdictDetail"`
	PatchBytes    *int    `json:"patchBytes"`
	PatchOps      *int    `json:"patchOps"`
	Diff          *Timing `json:"diff"`
	Decode        *Timing `json:"decode"`
	E2E           *Timing `json:"e2e"`
	Apply         *Timing `json:"apply"`
	Alloc         *Alloc  `json:"alloc"`
	Memory        *Memory `json:"memory"`
	SkippedReason string  `json:"skippedReason,omitempty"`
}

type CaseResult struct {
	Case          string      `json:"case"`
	Category      string      `json:"category"`
	Description   string      `json:"description"`
	Roundtrip     string      `json:"roundtrip"`
	MeasureMemory bool        `json:"measureMemory"`
	Tags          []string    `json:"tags"`
	MaxArrayLen   int         `json:"maxArrayLen"`
	Libraries     []LibResult `json:"libraries"`
}

// ---------------------------------------------------------------------------
// Diff-adapter measurement
// ---------------------------------------------------------------------------

func measureDiff(a diffAdapter, c *CorpusCase) LibResult {
	res := LibResult{Library: a.id, Label: a.label, Kind: a.kind, Role: "diff", Verdict: VerdictPass}

	if a.requiresSchema && c.Schema == nil {
		res.Verdict = VerdictSkipped
		res.SkippedReason = "no schema -> no plan; emitMoves not applicable"
		return res
	}

	// Produce one patch (panic-safe) for size + round-trip verdict.
	pb, ops, ourOps, prodErr, panicked, pmsg := produce(a, c)
	if panicked || prodErr != nil {
		res.Verdict = VerdictCrash
		if panicked {
			res.VerdictDetail = "diff panicked: " + pmsg
		} else {
			res.VerdictDetail = "diff errored: " + prodErr.Error()
		}
		return res
	}
	pbN, opsN := len(pb), ops
	res.PatchBytes, res.PatchOps = &pbN, &opsN

	// Round-trip verdict.
	if a.hasApplier {
		applied, err := applyVerifySafe(a, c, pb, ourOps)
		reconstructed := c.reconstructs(applied)
		if a.verifyCanonical {
			reconstructed = c.reconstructsMode(applied, true)
		}
		switch {
		case err != nil:
			res.Verdict = VerdictCorrupt
			res.VerdictDetail = "patch unappliable: " + err.Error()
		case reconstructed:
			res.Verdict = VerdictPass
			if c.Roundtrip == "multiset" {
				res.VerdictDetail = "multiset-canonical"
			}
		default:
			res.Verdict = VerdictCorrupt
			res.VerdictDetail = "applied patch does not reconstruct modified"
		}
	} else {
		res.Verdict = VerdictNoApplier
	}

	// Diff wall-time (pre-parsed inputs).
	diffSingle, _, _ := singleRun(a.diffFn(c))
	dt := timeIt(a.diffFn(c), diffSingle)
	res.Diff = &dt

	// Decode wall-time (bytes -> parsed) where the library has a pre-parse entry.
	if a.decodeFn != nil {
		ds, _, _ := singleRun(a.decodeFn(c))
		d := timeIt(a.decodeFn(c), ds)
		res.Decode = &d
	}

	// End-to-end wall-time (bytes -> patch(-> bytes)).
	es, _, _ := singleRun(a.e2eFn(c))
	e := timeIt(a.e2eFn(c), es)
	res.E2E = &e

	// Apply wall-time (own patch, this row's applier).
	if a.hasApplier && res.Verdict != VerdictCorrupt {
		as, ap, _ := singleRun(a.applyFn(c, pb, ourOps))
		if !ap {
			aT := timeIt(a.applyFn(c, pb, ourOps), as)
			res.Apply = &aT
		}
	}

	// Allocation stats for the diff op.
	al := measureAllocs(a.diffFn(c), diffSingle)
	res.Alloc = &al

	// Pathological-shape live-heap proxy.
	if c.MeasureMemory {
		res.Memory = captureMemory(a.diffFn(c), al)
	}
	return res
}

func produce(a diffAdapter, c *CorpusCase) (pb []byte, ops int, ourOps []sp.Operation, err error, panicked bool, pmsg string) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
			pmsg = toStr(r)
		}
	}()
	pb, ops, ourOps, err = a.produce(c)
	return
}

func applyVerifySafe(a diffAdapter, c *CorpusCase, pb []byte, ourOps []sp.Operation) (v sp.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("applier panicked: %s", toStr(r))
		}
	}()
	return a.applyVerify(c, pb, ourOps)
}

func captureMemory(fn func(), al Alloc) *Memory {
	runtime.GC()
	fn()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return &Memory{
		HeapInuseBytes:  m.HeapInuse,
		AllocBytesPerOp: al.BytesPerOp,
		AllocsPerOp:     al.AllocsPerOp,
		Note:            "in-process live-heap proxy (HeapInuse after one diff); the TS side reports subprocess peak RSS — the two memory columns are not directly comparable across engines",
	}
}

// ---------------------------------------------------------------------------
// Apply-adapter measurement (ours-apply vs evanphx on the identical patch)
// ---------------------------------------------------------------------------

func measureApply(a applyAdapter, c *CorpusCase, canonical []byte, canonOps int) LibResult {
	res := LibResult{Library: a.id, Label: a.label, Kind: "apply-only", Role: "apply", Verdict: VerdictPass}
	if canonical == nil {
		res.Verdict = VerdictSkipped
		res.SkippedReason = "no canonical patch (jsondiff diff unavailable for this case)"
		return res
	}
	pbN, opsN := len(canonical), canonOps
	res.PatchBytes, res.PatchOps = &pbN, &opsN

	prepared, err, panicked, pmsg := prepareSafe(a, canonical)
	if panicked || err != nil {
		res.Verdict = VerdictCrash
		if panicked {
			res.VerdictDetail = "patch decode panicked: " + pmsg
		} else {
			res.VerdictDetail = "patch decode errored: " + err.Error()
		}
		return res
	}

	applied, aerr := applySafe(a, c, prepared)
	switch {
	case aerr != nil:
		res.Verdict = VerdictCorrupt
		res.VerdictDetail = "apply failed: " + aerr.Error()
		return res
	case c.reconstructs(applied):
		res.Verdict = VerdictPass
		if c.Roundtrip == "multiset" {
			res.VerdictDetail = "multiset-canonical"
		}
	default:
		res.Verdict = VerdictCorrupt
		res.VerdictDetail = "applied patch does not reconstruct modified"
	}

	// Decode (prepare) wall-time.
	ds, _, _ := singleRun(func() { _, _ = a.prepare(canonical) })
	d := timeIt(func() { _, _ = a.prepare(canonical) }, ds)
	res.Decode = &d

	// Apply wall-time on the pre-decoded patch.
	as, _, _ := singleRun(func() { _, _ = a.apply(c, prepared) })
	aT := timeIt(func() { _, _ = a.apply(c, prepared) }, as)
	res.Apply = &aT

	al := measureAllocs(func() { _, _ = a.apply(c, prepared) }, as)
	res.Alloc = &al
	return res
}

func prepareSafe(a applyAdapter, canonical []byte) (prepared any, err error, panicked bool, pmsg string) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
			pmsg = toStr(r)
		}
	}()
	prepared, err = a.prepare(canonical)
	return
}

func applySafe(a applyAdapter, c *CorpusCase, prepared any) (v sp.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("apply panicked: %s", toStr(r))
		}
	}()
	return a.apply(c, prepared)
}

// canonicalPatch produces the shared RFC 6902 patch (jsondiff default) that the
// apply-only adapters race on, plus its op count.
func canonicalPatch(c *CorpusCase) (pb []byte, ops int) {
	defer func() { _ = recover() }()
	p, err := jd.Compare(c.OriginalAny, c.ModifiedAny)
	if err != nil {
		return nil, 0
	}
	b, err := json.Marshal(p)
	if err != nil {
		return nil, 0
	}
	return b, len(p)
}

// ---------------------------------------------------------------------------
// Environment metadata
// ---------------------------------------------------------------------------

func sh(dir, name string, args ...string) string {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

// moduleVersions parses the go-bench go.mod require block for the pinned
// competitor versions (deterministic and independent of build-info embedding).
func moduleVersions(goBenchDir string) map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(filepath.Join(goBenchDir, "go.mod"))
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(raw), "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) >= 2 && strings.HasPrefix(f[0], "github.com/") {
			out[f[0]] = f[1]
		}
	}
	return out
}

func ourVersion(root string) string {
	raw, err := os.ReadFile(filepath.Join(root, "package.json"))
	if err != nil {
		return "unknown"
	}
	var pkg struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(raw, &pkg) != nil {
		return "unknown"
	}
	return pkg.Version
}

// findRepoRoot walks up from the working directory until it finds the shared
// corpus, so the runner works from any invocation directory.
func findRepoRoot() (root, corpora string, err error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", "", err
	}
	for i := 0; i < 8; i++ {
		cand := filepath.Join(dir, "comparison", "corpora")
		if st, e := os.Stat(cand); e == nil && st.IsDir() {
			return dir, cand, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", "", fmt.Errorf("could not locate comparison/corpora above %s", root)
}

func main() {
	startedAt := time.Now().UTC()
	wall0 := time.Now()

	root, corpora, err := findRepoRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	goBenchDir := filepath.Join(root, "go-bench")

	manifest, manifestRaw, err := loadManifest(corpora)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load manifest:", err)
		os.Exit(1)
	}
	sum := sha256.Sum256(manifestRaw)
	corpusSha := hex.EncodeToString(sum[:])[:16]

	diffAdapters := newDiffAdapters()
	applyAdapters := newApplyAdapters()

	var results []CaseResult
	for _, entry := range manifest.Cases {
		c, err := loadCase(corpora, entry.File)
		if err != nil {
			fmt.Fprintln(os.Stderr, "load case:", err)
			os.Exit(1)
		}
		var libs []LibResult
		for _, a := range diffAdapters {
			r := measureDiff(a, c)
			libs = append(libs, r)
			printRow(c.Name, r)
		}
		canonical, canonOps := canonicalPatch(c)
		for _, a := range applyAdapters {
			r := measureApply(a, c, canonical, canonOps)
			libs = append(libs, r)
			printRow(c.Name, r)
		}
		results = append(results, CaseResult{
			Case:          c.Name,
			Category:      c.Category,
			Description:   c.Description,
			Roundtrip:     c.Roundtrip,
			MeasureMemory: c.MeasureMemory,
			Tags:          c.Tags,
			MaxArrayLen:   maxArrayLength(c.Original),
			Libraries:     libs,
		})
	}

	wallMs := time.Since(wall0).Milliseconds()
	vers := moduleVersions(goBenchDir)

	out := map[string]any{
		"schemaVersion": 1,
		"runner":        "go-bench/ (go run .)",
		"generatedAt":   startedAt.Format(time.RFC3339),
		"wallClockMs":   wallMs,
		"commit":        sh(root, "git", "rev-parse", "HEAD"),
		"branch":        sh(root, "git", "rev-parse", "--abbrev-ref", "HEAD"),
		"corpus": map[string]any{
			"seed":           manifest.Seed,
			"caseCount":      manifest.Count,
			"manifestSha256": corpusSha,
			"note":           "identical shared corpus as the TS runner; manifestSha256 must match analysis/results/bench-v2.json",
		},
		"engines": map[string]any{
			"ours": map[string]any{
				"source":  "this branch (go/)",
				"version": ourVersion(root),
			},
			"wI2L/jsondiff":       map[string]any{"source": "github.com/wI2L/jsondiff", "version": vers["github.com/wI2L/jsondiff"], "role": "diff"},
			"snorwin/jsonpatch":   map[string]any{"source": "github.com/snorwin/jsonpatch", "version": vers["github.com/snorwin/jsonpatch"], "role": "diff"},
			"mattbaird/jsonpatch": map[string]any{"source": "github.com/mattbaird/jsonpatch", "version": vers["github.com/mattbaird/jsonpatch"], "role": "diff (historic)"},
			"evanphx/json-patch":  map[string]any{"source": "github.com/evanphx/json-patch/v5", "version": vers["github.com/evanphx/json-patch/v5"], "role": "apply (neutral applier)"},
		},
		"platform": map[string]any{
			"os":   runtime.GOOS,
			"arch": runtime.GOARCH,
			"go":   runtime.Version(),
			"cpus": sh(root, "sysctl", "-n", "machdep.cpu.brand_string"),
		},
		"methodology": map[string]any{
			"timing":      "manual warmup + adaptive-budget sample loop (mean/p99/min), budgets matched to the TS tinybench runner",
			"diff":        "patch produced from PRE-PARSED inputs (our Value model / competitors' any); excludes decode & marshal",
			"decode":      "bytes -> parsed input form; null for byte-only libraries (mattbaird) whose diff already embeds the parse",
			"e2e":         "bytes -> patch(-> bytes); the fair cross-input end-to-end comparison",
			"apply":       "diff rows apply their OWN patch (ours=our ApplyPatch, competitors=evanphx neutral applier); the ours-apply/evanphx rows race on the IDENTICAL jsondiff canonical patch",
			"verdict":     "PASS/CORRUPT/CRASH/NO-APPLIER/SKIPPED; competitor patches judged by evanphx (neutral), our patches by our applier; multiset cases use an order-normalized contract (verdictDetail=multiset-canonical)",
			"alloc":       "bytes/op and allocs/op for the diff op (Go analogue of b.ReportAllocs)",
			"memory":      "measureMemory cases add an in-process live-heap proxy; NOT comparable to the TS subprocess RSS probe",
			"competitors": "wI2L/jsondiff and snorwin/jsonpatch take any; mattbaird takes []byte; none are schema/primary-key aware, so keyed reorders differ structurally from our planned output",
		},
		"adapters": adapterMeta(diffAdapters, applyAdapters),
		"results":  results,
	}

	resultsDir := filepath.Join(root, "analysis", "results")
	if err := os.MkdirAll(resultsDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	outFile := filepath.Join(resultsDir, "go-bench.json")
	buf, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := os.WriteFile(outFile, append(buf, '\n'), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("\nwrote %s\n", outFile)
	fmt.Printf("full run: %.1fs over %d cases\n", float64(wallMs)/1000, manifest.Count)
}

func adapterMeta(diffs []diffAdapter, applies []applyAdapter) []map[string]any {
	var out []map[string]any
	for _, a := range diffs {
		out = append(out, map[string]any{"id": a.id, "label": a.label, "kind": a.kind, "role": "diff", "hasApplier": a.hasApplier})
	}
	for _, a := range applies {
		out = append(out, map[string]any{"id": a.id, "label": a.label, "kind": "apply-only", "role": "apply", "hasApplier": true})
	}
	return out
}

func printRow(caseName string, r LibResult) {
	v := r.Verdict
	if r.SkippedReason != "" {
		v = r.Verdict + " (" + r.SkippedReason + ")"
	}
	dt := "-"
	if r.Diff != nil {
		dt = fmt.Sprintf("%.3fms", r.Diff.MeanMs)
	} else if r.Apply != nil {
		dt = fmt.Sprintf("apply=%.4fms", r.Apply.MeanMs)
	}
	bytes := "-"
	if r.PatchBytes != nil {
		bytes = fmt.Sprintf("%d", *r.PatchBytes)
	}
	fmt.Printf("  %-38s %-14s %-34s %-16s bytes=%s\n", caseName, r.Library, v, dt, bytes)
}
