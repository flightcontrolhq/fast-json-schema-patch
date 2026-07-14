package main

import (
	"encoding/json"
	"fmt"

	evan "github.com/evanphx/json-patch/v5"
	sp "github.com/flightcontrolhq/fast-json-schema-patch/go"
	mb "github.com/mattbaird/jsonpatch"
	sn "github.com/snorwin/jsonpatch"
	jd "github.com/wI2L/jsondiff"
)

// diffAdapter is a patch-producing library. Every field is a closure so the
// runner can (a) produce one patch for size + round-trip verdict, and (b) time
// the pre-parsed diff, the byte->parsed decode, and the byte->patch end-to-end
// path independently — the three framings that make a schema-aware engine over
// the ordered Value model comparable to competitors that take []byte or any.
type diffAdapter struct {
	id, label, kind string
	requiresSchema  bool // emitMoves is only meaningful for a planned (schema) case
	hasApplier      bool // a round-trip applier exists (ours = own applier, others = evanphx)
	verifyCanonical bool // judge round-trip order-insensitively (Compare re-marshals, sorting keys)

	// produce yields the patch as canonical RFC 6902 JSON bytes, its op count, and
	// — for our own engine only — the native []Operation (so our applier times its
	// own in-memory patch rather than a re-decoded one). err => CRASH.
	produce func(c *CorpusCase) (patchBytes []byte, ops int, ourOps []sp.Operation, err error)

	diffFn   func(c *CorpusCase) func() // pre-parsed inputs -> patch (no decode/marshal)
	decodeFn func(c *CorpusCase) func() // bytes -> parsed input form (nil if library has no pre-parse entry)
	e2eFn    func(c *CorpusCase) func() // bytes -> patch(-> bytes)

	// applyVerify applies the produced patch with this row's applier and returns
	// the reconstructed document. applyFn is the timing closure for the same.
	applyVerify func(c *CorpusCase, pb []byte, ourOps []sp.Operation) (sp.Value, error)
	applyFn     func(c *CorpusCase, pb []byte, ourOps []sp.Operation) func()
}

func jsonLen(v any) int {
	b, _ := json.Marshal(v)
	return len(b)
}

// mustPatcher wraps sp.NewPatcher for the benchmark adapters, whose plans and
// options are statically valid; a construction error here is a harness bug.
func mustPatcher(plan sp.Plan, opts ...sp.PatcherOption) *sp.Patcher {
	p, err := sp.NewPatcher(plan, opts...)
	if err != nil {
		panic(fmt.Sprintf("go-bench: NewPatcher: %v", err))
	}
	return p
}

// casePatcherOpts collects the per-case generator capability toggles our engine
// must honour — currently the ignorePaths capability (GEN §10) — merged with any
// static extras (e.g. EmitMoves). Competitors have no such vocabulary; that is the
// comparison.
func casePatcherOpts(c *CorpusCase, extra ...sp.PatcherOption) []sp.PatcherOption {
	opts := append([]sp.PatcherOption(nil), extra...)
	if len(c.Options.IgnorePaths) > 0 {
		opts = append(opts, sp.IgnorePaths(c.Options.IgnorePaths...))
	}
	return opts
}

// compareSchemaArg returns the schema argument for the Compare(any) front door:
// the schema's canonical JSON as a json.RawMessage, or nil for a schemaless case
// (Compare then diffs schemalessly, exactly as the "ours" row does).
func compareSchemaArg(c *CorpusCase) any {
	if c.SchemaBytes == nil {
		return nil
	}
	return json.RawMessage(c.SchemaBytes)
}

func newDiffAdapters() []diffAdapter {
	// --- our engine, default capabilities ---------------------------------------
	ours := diffAdapter{
		id: "ours", label: "ours (Go engine, default)", kind: "schema-aware", hasApplier: true,
		produce: func(c *CorpusCase) ([]byte, int, []sp.Operation, error) {
			ops := mustPatcher(c.buildPlan(), casePatcherOpts(c)...).Execute(c.Original, c.Modified)
			pb, err := json.Marshal(ops)
			return pb, len(ops), ops, err
		},
		diffFn: func(c *CorpusCase) func() {
			return func() { mustPatcher(c.buildPlan(), casePatcherOpts(c)...).Execute(c.Original, c.Modified) }
		},
		decodeFn: func(c *CorpusCase) func() {
			return func() { _, _ = sp.Decode(c.OriginalBytes); _, _ = sp.Decode(c.ModifiedBytes) }
		},
		e2eFn: func(c *CorpusCase) func() {
			return func() {
				o, _ := sp.Decode(c.OriginalBytes)
				m, _ := sp.Decode(c.ModifiedBytes)
				ops := mustPatcher(c.buildPlan(), casePatcherOpts(c)...).Execute(o, m)
				_, _ = json.Marshal(ops)
			}
		},
		applyVerify: func(c *CorpusCase, _ []byte, ourOps []sp.Operation) (sp.Value, error) {
			return sp.ApplyPatch(c.Original, ourOps, sp.ApplyOptions{})
		},
		applyFn: func(c *CorpusCase, _ []byte, ourOps []sp.Operation) func() {
			return func() { _, _ = sp.ApplyPatch(c.Original, ourOps, sp.ApplyOptions{}) }
		},
	}

	// --- our engine, emitMoves capability ---------------------------------------
	oursMoves := diffAdapter{
		id: "ours-moves", label: "ours (Go engine, emitMoves)", kind: "schema-aware",
		requiresSchema: true, hasApplier: true,
		produce: func(c *CorpusCase) ([]byte, int, []sp.Operation, error) {
			ops := mustPatcher(c.buildPlan(), casePatcherOpts(c, sp.EmitMoves(true))...).Execute(c.Original, c.Modified)
			pb, err := json.Marshal(ops)
			return pb, len(ops), ops, err
		},
		diffFn: func(c *CorpusCase) func() {
			return func() {
				mustPatcher(c.buildPlan(), casePatcherOpts(c, sp.EmitMoves(true))...).Execute(c.Original, c.Modified)
			}
		},
		decodeFn: func(c *CorpusCase) func() {
			return func() { _, _ = sp.Decode(c.OriginalBytes); _, _ = sp.Decode(c.ModifiedBytes) }
		},
		e2eFn: func(c *CorpusCase) func() {
			return func() {
				o, _ := sp.Decode(c.OriginalBytes)
				m, _ := sp.Decode(c.ModifiedBytes)
				ops := mustPatcher(c.buildPlan(), casePatcherOpts(c, sp.EmitMoves(true))...).Execute(o, m)
				_, _ = json.Marshal(ops)
			}
		},
		applyVerify: func(c *CorpusCase, _ []byte, ourOps []sp.Operation) (sp.Value, error) {
			return sp.ApplyPatch(c.Original, ourOps, sp.ApplyOptions{})
		},
		applyFn: func(c *CorpusCase, _ []byte, ourOps []sp.Operation) func() {
			return func() { _, _ = sp.ApplyPatch(c.Original, ourOps, sp.ApplyOptions{}) }
		},
	}

	// --- our engine via the Compare(any) typed-entry front door -------------------
	// The ergonomic API a Go caller holding typed structs/maps actually uses: it
	// json.Marshals schema+source+target on the way in, decodes with the ordered
	// value model, builds the plan, and runs Execute. Timed ALONGSIDE the pre-parsed
	// "ours" row so the marshal-included cost of the convenience entry point is
	// visible (this is what a wI2L/jsondiff-style `Compare(a, b)` caller pays). Its
	// re-marshal sorts object keys, so it is verified order-insensitively
	// (verifyCanonical) — correctness of the underlying diff is already pinned by the
	// "ours" row; this row exists for the timing.
	oursCompare := diffAdapter{
		id: "ours-compare", label: "ours (Go engine, Compare(any))", kind: "schema-aware",
		hasApplier: true, verifyCanonical: true,
		produce: func(c *CorpusCase) ([]byte, int, []sp.Operation, error) {
			ops, err := sp.Compare(compareSchemaArg(c), c.OriginalAny, c.ModifiedAny, casePatcherOpts(c)...)
			if err != nil {
				return nil, 0, nil, err
			}
			pb, err := json.Marshal(ops)
			return pb, len(ops), ops, err
		},
		diffFn: func(c *CorpusCase) func() {
			return func() {
				_, _ = sp.Compare(compareSchemaArg(c), c.OriginalAny, c.ModifiedAny, casePatcherOpts(c)...)
			}
		},
		decodeFn: nil, // the marshal step is INSIDE Compare; there is no separate pre-parse
		e2eFn: func(c *CorpusCase) func() {
			return func() {
				ops, _ := sp.Compare(compareSchemaArg(c), c.OriginalAny, c.ModifiedAny, casePatcherOpts(c)...)
				_, _ = json.Marshal(ops)
			}
		},
		applyVerify: func(c *CorpusCase, _ []byte, ourOps []sp.Operation) (sp.Value, error) {
			return sp.ApplyPatch(c.Original, ourOps, sp.ApplyOptions{})
		},
		applyFn: func(c *CorpusCase, _ []byte, ourOps []sp.Operation) func() {
			return func() { _, _ = sp.ApplyPatch(c.Original, ourOps, sp.ApplyOptions{}) }
		},
	}

	// --- github.com/wI2L/jsondiff (RFC 6902 generation; closest Go analogue) -----
	jsondiff := diffAdapter{
		id: "jsondiff", label: "wI2L/jsondiff", kind: "generic", hasApplier: true,
		produce: func(c *CorpusCase) ([]byte, int, []sp.Operation, error) {
			p, err := jd.Compare(c.OriginalAny, c.ModifiedAny)
			if err != nil {
				return nil, 0, nil, err
			}
			pb, err := json.Marshal(p)
			return pb, len(p), nil, err
		},
		diffFn: func(c *CorpusCase) func() {
			return func() { _, _ = jd.Compare(c.OriginalAny, c.ModifiedAny) }
		},
		decodeFn: func(c *CorpusCase) func() {
			return func() {
				var a, b any
				_ = json.Unmarshal(c.OriginalBytes, &a)
				_ = json.Unmarshal(c.ModifiedBytes, &b)
			}
		},
		e2eFn: func(c *CorpusCase) func() {
			return func() {
				p, _ := jd.CompareJSON(c.OriginalBytes, c.ModifiedBytes)
				_, _ = json.Marshal(p)
			}
		},
		applyVerify: func(c *CorpusCase, pb []byte, _ []sp.Operation) (sp.Value, error) {
			return evanphxApply(c, pb)
		},
		applyFn: func(c *CorpusCase, pb []byte, _ []sp.Operation) func() {
			return func() { _, _ = evanphxApply(c, pb) }
		},
	}

	// --- github.com/snorwin/jsonpatch (RFC 6902 generation) ----------------------
	snorwin := diffAdapter{
		id: "snorwin", label: "snorwin/jsonpatch", kind: "generic", hasApplier: true,
		produce: func(c *CorpusCase) ([]byte, int, []sp.Operation, error) {
			list, err := sn.CreateJSONPatch(c.ModifiedAny, c.OriginalAny)
			if err != nil {
				return nil, 0, nil, err
			}
			return list.Raw(), len(list.List()), nil, nil
		},
		diffFn: func(c *CorpusCase) func() {
			return func() { _, _ = sn.CreateJSONPatch(c.ModifiedAny, c.OriginalAny) }
		},
		decodeFn: func(c *CorpusCase) func() {
			return func() {
				var a, b any
				_ = json.Unmarshal(c.OriginalBytes, &a)
				_ = json.Unmarshal(c.ModifiedBytes, &b)
			}
		},
		e2eFn: func(c *CorpusCase) func() {
			return func() {
				var a, b any
				_ = json.Unmarshal(c.OriginalBytes, &a)
				_ = json.Unmarshal(c.ModifiedBytes, &b)
				list, _ := sn.CreateJSONPatch(b, a)
				_ = list.Raw()
			}
		},
		applyVerify: func(c *CorpusCase, pb []byte, _ []sp.Operation) (sp.Value, error) {
			return evanphxApply(c, pb)
		},
		applyFn: func(c *CorpusCase, pb []byte, _ []sp.Operation) func() {
			return func() { _, _ = evanphxApply(c, pb) }
		},
	}

	// --- github.com/mattbaird/jsonpatch (historic RFC 6902 generation) -----------
	// Takes []byte only, so it has no pre-parse entry: its "diff" already includes
	// an internal unmarshal (decodeFn is nil; diff == e2e minus the final marshal).
	mattbaird := diffAdapter{
		id: "mattbaird", label: "mattbaird/jsonpatch", kind: "generic", hasApplier: true,
		produce: func(c *CorpusCase) ([]byte, int, []sp.Operation, error) {
			ops, err := mb.CreatePatch(c.OriginalBytes, c.ModifiedBytes)
			if err != nil {
				return nil, 0, nil, err
			}
			pb, err := json.Marshal(ops)
			return pb, len(ops), nil, err
		},
		diffFn: func(c *CorpusCase) func() {
			return func() { _, _ = mb.CreatePatch(c.OriginalBytes, c.ModifiedBytes) }
		},
		decodeFn: nil,
		e2eFn: func(c *CorpusCase) func() {
			return func() {
				ops, _ := mb.CreatePatch(c.OriginalBytes, c.ModifiedBytes)
				_, _ = json.Marshal(ops)
			}
		},
		applyVerify: func(c *CorpusCase, pb []byte, _ []sp.Operation) (sp.Value, error) {
			return evanphxApply(c, pb)
		},
		applyFn: func(c *CorpusCase, pb []byte, _ []sp.Operation) func() {
			return func() { _, _ = evanphxApply(c, pb) }
		},
	}

	return []diffAdapter{ours, oursMoves, oursCompare, jsondiff, snorwin, mattbaird}
}

// applyAdapter is an apply-only competitor. Both appliers race on the IDENTICAL
// canonical RFC 6902 patch (the jsondiff default original->modified output),
// pre-decoded once via prepare(); decode cost and apply cost are reported
// separately so our Value-model applier and evanphx's []byte applier compare
// fairly.
type applyAdapter struct {
	id, label string
	prepare   func(canonical []byte) (any, error)
	apply     func(c *CorpusCase, prepared any) (sp.Value, error)
}

func newApplyAdapters() []applyAdapter {
	return []applyAdapter{
		{
			id: "ours-apply", label: "ours (Go engine ApplyPatch)",
			prepare: func(canonical []byte) (any, error) {
				return sp.DecodeOperations(canonical)
			},
			apply: func(c *CorpusCase, prepared any) (sp.Value, error) {
				return sp.ApplyPatch(c.Original, prepared.([]sp.Operation), sp.ApplyOptions{})
			},
		},
		{
			id: "evanphx", label: "evanphx/json-patch v5 (apply)",
			prepare: func(canonical []byte) (any, error) {
				return evan.DecodePatch(canonical)
			},
			apply: func(c *CorpusCase, prepared any) (sp.Value, error) {
				out, err := prepared.(evan.Patch).Apply(c.OriginalBytes)
				if err != nil {
					return nil, err
				}
				return sp.Decode(out)
			},
		},
	}
}
