package schemapatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// applyVector mirrors the §10.2 apply vector format. doc/patch/expected are kept
// raw so they decode through the order-preserving [Decode]/[DecodeOperations]
// the engine consumes. Exactly one of Expected or Error is present.
type applyVector struct {
	Name     string          `json:"name"`
	Comment  string          `json:"comment"`
	Doc      json.RawMessage `json:"doc"`
	Patch    json.RawMessage `json:"patch"`
	Options  applyVectorOpts `json:"options"`
	Expected json.RawMessage `json:"expected"`
	Error    *struct {
		Code  string `json:"code"`
		Index int    `json:"index"`
	} `json:"error"`
}

type applyVectorOpts struct {
	ValidateOldValues bool `json:"validateOldValues"`
	CloneValues       bool `json:"cloneValues"`
	CloneResult       bool `json:"cloneResult"`
}

func TestApplyConformanceVectors(t *testing.T) {
	dir := filepath.Join("..", "spec", "vectors", "apply")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skip("apply vector directory absent (published-module case)")
		}
		t.Fatalf("read vector dir: %v", err)
	}

	total := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		if err != nil {
			t.Fatalf("read %s: %v", entry.Name(), err)
		}
		var vectors []applyVector
		if err := json.Unmarshal(data, &vectors); err != nil {
			t.Fatalf("parse %s: %v", entry.Name(), err)
		}
		for _, vec := range vectors {
			vec := vec
			total++
			t.Run(entry.Name()+"/"+vec.Name, func(t *testing.T) {
				runApplyVector(t, vec)
			})
		}
	}
	if total == 0 {
		t.Fatal("no apply vectors found")
	}
	t.Logf("apply vectors executed: %d", total)
}

func runApplyVector(t *testing.T, vec applyVector) {
	t.Helper()

	doc, err := Decode(vec.Doc)
	if err != nil {
		t.Fatalf("decode doc: %v", err)
	}
	patch, err := DecodeOperations(vec.Patch)
	if err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	opts := ApplyOptions{
		ValidateOldValues: vec.Options.ValidateOldValues,
		CloneValues:       vec.Options.CloneValues,
		CloneResult:       vec.Options.CloneResult,
	}

	// Snapshot the input to prove apply never mutates it (SPEC §8.1.3).
	before := Clone(doc)

	got, err := ApplyPatch(doc, patch, opts)

	if !DeepEqual(doc, before) {
		t.Errorf("input document was mutated by apply")
	}

	if vec.Error != nil {
		if err == nil {
			t.Fatalf("expected error %s at %d, got success: %v", vec.Error.Code, vec.Error.Index, got)
		}
		pe, ok := err.(*PatchError)
		if !ok {
			t.Fatalf("expected *PatchError, got %T: %v", err, err)
		}
		if string(pe.Code) != vec.Error.Code {
			t.Errorf("error code = %q, want %q", pe.Code, vec.Error.Code)
		}
		if pe.OpIndex != vec.Error.Index {
			t.Errorf("error index = %d, want %d", pe.OpIndex, vec.Error.Index)
		}
		return
	}

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	want, err := Decode(vec.Expected)
	if err != nil {
		t.Fatalf("decode expected: %v", err)
	}
	if !DeepEqual(got, want) {
		t.Errorf("result mismatch\n got: %s\nwant: %s", mustEncode(t, got), mustEncode(t, want))
	}
}

func mustEncode(t *testing.T, v Value) string {
	t.Helper()
	b, err := Encode(v)
	if err != nil {
		return "<encode error: " + err.Error() + ">"
	}
	return string(b)
}
