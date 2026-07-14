package schemapatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// planVector mirrors the CONF §7 plan-snapshot vector format. The schema is kept
// raw so it can be decoded with the order-preserving [Decode] that BuildPlan
// consumes; options are plain JSON.
type planVector struct {
	Name    string          `json:"name"`
	Comment string          `json:"comment"`
	Schema  json.RawMessage `json:"schema"`
	Options struct {
		PrimaryKeyMap map[string]string `json:"primaryKeyMap"`
		BasePath      string            `json:"basePath"`
		// PrimaryKeyCandidates distinguishes absent (nil → default) from an
		// explicit [] (non-nil empty → disabled), which encoding/json preserves.
		PrimaryKeyCandidates []string `json:"primaryKeyCandidates"`
	} `json:"options"`
	ExpectedPlan []expectedArrayPlan `json:"expectedPlan"`
}

type expectedArrayPlan struct {
	Path           string   `json:"path"`
	PrimaryKey     *string  `json:"primaryKey"`
	Strategy       string   `json:"strategy"`
	RequiredFields []string `json:"requiredFields"`
	HashFields     []string `json:"hashFields"`
}

func TestPlanConformanceVectors(t *testing.T) {
	dir := filepath.Join("..", "spec", "vectors", "plan")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skip("plan vector directory absent (published-module case)")
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
		var vectors []planVector
		if err := json.Unmarshal(data, &vectors); err != nil {
			t.Fatalf("parse %s: %v", entry.Name(), err)
		}
		for _, vec := range vectors {
			vec := vec
			total++
			t.Run(entry.Name()+"/"+vec.Name, func(t *testing.T) {
				schema, err := Decode(vec.Schema)
				if err != nil {
					t.Fatalf("decode schema: %v", err)
				}
				plan, err := BuildPlan(schema, BuildPlanOptions{
					PrimaryKeyMap:        vec.Options.PrimaryKeyMap,
					BasePath:             vec.Options.BasePath,
					PrimaryKeyCandidates: vec.Options.PrimaryKeyCandidates,
				})
				if err != nil {
					t.Fatalf("BuildPlan: %v", err)
				}
				assertPlanEquals(t, plan, vec.ExpectedPlan)
			})
		}
	}
	if total == 0 {
		t.Fatal("no plan vectors found")
	}
	t.Logf("plan vectors executed: %d", total)
}

// assertPlanEquals compares a built plan against the expected snapshot per
// CONF §7.1: the set of paths must match, and per path the primaryKey, strategy,
// and (order-insensitively) requiredFields and hashFields must match.
func assertPlanEquals(t *testing.T, plan Plan, expected []expectedArrayPlan) {
	t.Helper()

	if got, want := plan.Len(), len(expected); got != want {
		t.Fatalf("plan has %d paths, want %d (got paths %v)", got, want, plan.Paths())
	}
	for _, exp := range expected {
		ap, ok := plan.Lookup(exp.Path)
		if !ok {
			t.Fatalf("plan missing path %q (got paths %v)", exp.Path, plan.Paths())
		}
		wantKey := ""
		if exp.PrimaryKey != nil {
			wantKey = *exp.PrimaryKey
		}
		if ap.PrimaryKey != wantKey {
			t.Errorf("path %q: primaryKey = %q, want %q", exp.Path, ap.PrimaryKey, wantKey)
		}
		if string(ap.Strategy) != exp.Strategy {
			t.Errorf("path %q: strategy = %q, want %q", exp.Path, ap.Strategy, exp.Strategy)
		}
		if !sameStringSet(ap.RequiredFields, exp.RequiredFields) {
			t.Errorf("path %q: requiredFields = %v, want %v (order-insensitive)", exp.Path, ap.RequiredFields, exp.RequiredFields)
		}
		if !sameStringSet(ap.HashFields, exp.HashFields) {
			t.Errorf("path %q: hashFields = %v, want %v (order-insensitive)", exp.Path, ap.HashFields, exp.HashFields)
		}
	}
}

// sameStringSet compares two string slices order-insensitively, treating nil and
// [] as equal (CONF §7: [] when absent).
func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	ac := append([]string(nil), a...)
	bc := append([]string(nil), b...)
	sort.Strings(ac)
	sort.Strings(bc)
	for i := range ac {
		if ac[i] != bc[i] {
			return false
		}
	}
	return true
}
