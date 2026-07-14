package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	sp "github.com/flightcontrolhq/fast-json-schema-patch/go"
)

// Manifest mirrors comparison/corpora/manifest.json (the shared corpus contract
// written by the seeded TS generator). Only the fields the Go runner needs are
// decoded.
type Manifest struct {
	SchemaVersion int   `json:"schemaVersion"`
	Seed          int64 `json:"seed"`
	Count         int   `json:"count"`
	Cases         []struct {
		Name          string `json:"name"`
		File          string `json:"file"`
		MeasureMemory bool   `json:"measureMemory"`
	} `json:"cases"`
}

// CorpusCase is one benchmark case parsed into the engine's ordered Value model
// (so number-literal text and object member order survive) plus the raw bytes of
// the original/modified documents for the byte-oriented competitor libraries.
type CorpusCase struct {
	Name          string
	Category      string
	Description   string
	Roundtrip     string // "exact" | "multiset"
	MeasureMemory bool
	Tags          []string

	// Ordered Value-model documents (our engine's native input).
	Original sp.Value
	Modified sp.Value

	// Canonical JSON bytes of the same documents, produced by the engine encoder
	// (deterministic; used by byte/interface competitors and the neutral applier).
	OriginalBytes []byte
	ModifiedBytes []byte

	// interface{} forms for libraries whose entry point takes any (jsondiff.Compare,
	// snorwin.CreateJSONPatch). Decoded from the canonical bytes.
	OriginalAny any
	ModifiedAny any

	// Schema + plan options for the schema-aware engine. Schema is nil when the
	// case carries no schema (every array then falls to the LCS strategy).
	Schema  sp.Value
	Options PlanOptions
}

// PlanOptions is the case's plan configuration, lifted from the case JSON's
// "options" object into the engine's BuildPlanOptions fields.
type PlanOptions struct {
	PrimaryKeyMap        map[string]string
	BasePath             string
	HasBasePath          bool
	PrimaryKeyCandidates []string
}

func loadManifest(corporaDir string) (Manifest, []byte, error) {
	raw, err := os.ReadFile(filepath.Join(corporaDir, "manifest.json"))
	if err != nil {
		return Manifest{}, nil, err
	}
	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, nil, err
	}
	return m, raw, nil
}

func loadCase(corporaDir, relFile string) (*CorpusCase, error) {
	raw, err := os.ReadFile(filepath.Join(corporaDir, relFile))
	if err != nil {
		return nil, err
	}
	v, err := sp.Decode(raw)
	if err != nil {
		return nil, fmt.Errorf("decode case %s: %w", relFile, err)
	}
	obj, ok := v.(*sp.Object)
	if !ok {
		return nil, fmt.Errorf("case %s: top-level is not an object", relFile)
	}

	c := &CorpusCase{
		Name:        getStr(obj, "name"),
		Category:    getStr(obj, "category"),
		Description: getStr(obj, "description"),
		Roundtrip:   getStr(obj, "roundtrip"),
		Tags:        getStrSlice(obj, "tags"),
	}
	if mm, present := obj.Get("measureMemory"); present {
		if b, ok := mm.(bool); ok {
			c.MeasureMemory = b
		}
	}

	orig, _ := obj.Get("original")
	mod, _ := obj.Get("modified")
	c.Original = orig
	c.Modified = mod
	c.OriginalBytes = mustEncode(orig)
	c.ModifiedBytes = mustEncode(mod)
	if err := json.Unmarshal(c.OriginalBytes, &c.OriginalAny); err != nil {
		return nil, fmt.Errorf("case %s: reparse original: %w", relFile, err)
	}
	if err := json.Unmarshal(c.ModifiedBytes, &c.ModifiedAny); err != nil {
		return nil, fmt.Errorf("case %s: reparse modified: %w", relFile, err)
	}

	if sch, present := obj.Get("schema"); present && sch != nil {
		c.Schema = sch
	}
	if optsV, present := obj.Get("options"); present && optsV != nil {
		if optsObj, ok := optsV.(*sp.Object); ok {
			c.Options = parsePlanOptions(optsObj)
		}
	}
	return c, nil
}

func parsePlanOptions(o *sp.Object) PlanOptions {
	var po PlanOptions
	if pk, present := o.Get("primaryKeyMap"); present {
		if pkObj, ok := pk.(*sp.Object); ok {
			po.PrimaryKeyMap = map[string]string{}
			for _, k := range pkObj.Keys() {
				val, _ := pkObj.Get(k)
				if s, ok := val.(string); ok {
					po.PrimaryKeyMap[k] = s
				}
			}
		}
	}
	if bp, present := o.Get("basePath"); present {
		if s, ok := bp.(string); ok {
			po.BasePath = s
			po.HasBasePath = true
		}
	}
	if cand, present := o.Get("primaryKeyCandidates"); present {
		if arr, ok := cand.([]sp.Value); ok {
			po.PrimaryKeyCandidates = []string{}
			for _, e := range arr {
				if s, ok := e.(string); ok {
					po.PrimaryKeyCandidates = append(po.PrimaryKeyCandidates, s)
				}
			}
		}
	}
	return po
}

// buildPlan derives the engine plan for the case, mirroring the TS runner's
// oursPlan(): a schemaless case yields an empty plan (all arrays LCS).
func (c *CorpusCase) buildPlan() sp.Plan {
	if c.Schema == nil {
		return sp.Plan{}
	}
	opts := sp.BuildPlanOptions{
		PrimaryKeyMap:        c.Options.PrimaryKeyMap,
		PrimaryKeyCandidates: c.Options.PrimaryKeyCandidates,
	}
	if c.Options.HasBasePath {
		opts.BasePath = c.Options.BasePath
	}
	plan, _ := sp.BuildPlan(c.Schema, opts)
	return plan
}

func getStr(o *sp.Object, key string) string {
	if v, present := o.Get(key); present {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func getStrSlice(o *sp.Object, key string) []string {
	out := []string{}
	if v, present := o.Get(key); present {
		if arr, ok := v.([]sp.Value); ok {
			for _, e := range arr {
				if s, ok := e.(string); ok {
					out = append(out, s)
				}
			}
		}
	}
	return out
}

func mustEncode(v sp.Value) []byte {
	b, err := sp.Encode(v)
	if err != nil {
		panic(fmt.Sprintf("encode: %v", err))
	}
	return b
}

// maxArrayLength returns the largest array length anywhere in v (drives the
// per-adapter size cap; parity with the TS runner's maxArrayLength).
func maxArrayLength(v sp.Value) int {
	max := 0
	stack := []sp.Value{v}
	for len(stack) > 0 {
		n := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		switch t := n.(type) {
		case []sp.Value:
			if len(t) > max {
				max = len(t)
			}
			for _, e := range t {
				stack = append(stack, e)
			}
		case *sp.Object:
			for _, k := range t.Keys() {
				val, _ := t.Get(k)
				stack = append(stack, val)
			}
		}
	}
	return max
}
