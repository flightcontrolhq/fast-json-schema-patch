package schemapatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// invertVector mirrors the §10.7 invert vector format.
type invertVector struct {
	Name            string          `json:"name"`
	Comment         string          `json:"comment"`
	Document        json.RawMessage `json:"document"`
	Patch           json.RawMessage `json:"patch"`
	ExpectedInverse json.RawMessage `json:"expectedInverse"`
}

func TestInvertConformanceVectors(t *testing.T) {
	dir := filepath.Join("..", "spec", "vectors", "invert")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skip("invert vector directory absent (published-module case)")
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
		var vectors []invertVector
		if err := json.Unmarshal(data, &vectors); err != nil {
			t.Fatalf("parse %s: %v", entry.Name(), err)
		}
		for _, vec := range vectors {
			vec := vec
			total++
			t.Run(entry.Name()+"/"+vec.Name, func(t *testing.T) {
				runInvertVector(t, vec)
			})
		}
	}
	if total == 0 {
		t.Fatal("no invert vectors found")
	}
	t.Logf("invert vectors executed: %d", total)
}

func runInvertVector(t *testing.T, vec invertVector) {
	t.Helper()

	document, err := Decode(vec.Document)
	if err != nil {
		t.Fatalf("decode document: %v", err)
	}
	patch, err := DecodeOperations(vec.Patch)
	if err != nil {
		t.Fatalf("decode patch: %v", err)
	}

	docBefore := Clone(document)
	got, err := InvertPatch(document, patch)
	if err != nil {
		t.Fatalf("InvertPatch: %v", err)
	}
	if !DeepEqual(document, docBefore) {
		t.Errorf("invert mutated the input document")
	}

	// Clause (a): structural inverse equality (§10.7.2a).
	want := decodeExpectedPatch(t, vec.ExpectedInverse)
	assertOpsEqual(t, got, want)

	// Clause (b): double-apply identity (§10.7.2b) — apply(apply(D,patch),inverse) == D.
	forward, err := ApplyPatch(document, patch, ApplyOptions{})
	if err != nil {
		t.Fatalf("forward apply (vector must apply cleanly, §10.7.1): %v", err)
	}
	roundtrip, err := ApplyPatch(forward, got, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply inverse: %v", err)
	}
	if !DeepEqual(roundtrip, document) {
		t.Errorf("double-apply identity failed\n got: %s\nwant: %s",
			mustEncode(t, roundtrip), mustEncode(t, document))
	}
}
