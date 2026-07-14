package schemapatch

import (
	"encoding/json"
	"math"
	"testing"
)

// --- typed struct fixtures (nested, tags, embedded) ---

type addr struct {
	City string `json:"city"`
	Zip  string `json:"zip,omitempty"`
}

type meta struct {
	Version int `json:"version"`
}

type person struct {
	meta             // embedded: promotes "version"
	Name    string   `json:"name"`
	Age     int      `json:"age"`
	Address addr     `json:"address"`
	Tags    []string `json:"tags,omitempty"`
	Ignored string   `json:"-"`
}

func TestCompare_TypedStructs(t *testing.T) {
	src := person{
		meta:    meta{Version: 1},
		Name:    "Ada",
		Age:     36,
		Address: addr{City: "London"},
		Ignored: "secret",
	}
	dst := person{
		meta:    meta{Version: 2},
		Name:    "Ada",
		Age:     37,
		Address: addr{City: "Cambridge"},
		Ignored: "changed-but-not-serialized",
	}

	ops, err := Compare(nil, src, dst)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	got := mustEncodeOps(t, ops)
	// version (embedded), age, and address.city change; `Ignored` (json:"-")
	// never appears. Field visitation follows struct declaration order.
	want := `[{"op":"replace","path":"/version","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/age","value":37,"oldValue":36},` +
		`{"op":"replace","path":"/address/city","value":"Cambridge","oldValue":"London"}]`
	if got != want {
		t.Fatalf("typed-struct diff mismatch:\n got: %s\nwant: %s", got, want)
	}
}

func TestCompare_MapCanonicalizationDeterministic(t *testing.T) {
	// A map with several keys must diff identically across runs: encoding/json
	// sorts keys, so member order is canonical regardless of Go's random map
	// iteration order.
	src := map[string]any{"b": 1, "a": 1, "c": 1, "d": 1, "e": 1}
	dst := map[string]any{"b": 2, "a": 2, "c": 2, "d": 2, "e": 2}

	first, err := Compare(nil, src, dst)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	firstStr := mustEncodeOps(t, first)
	for i := 0; i < 50; i++ {
		again, err := Compare(nil, src, dst)
		if err != nil {
			t.Fatalf("Compare (run %d): %v", i, err)
		}
		if got := mustEncodeOps(t, again); got != firstStr {
			t.Fatalf("nondeterministic map diff on run %d:\n first: %s\n  got:  %s", i, firstStr, got)
		}
	}
	// Sanity: keys appear in sorted order.
	want := `[{"op":"replace","path":"/a","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/b","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/c","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/d","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/e","value":2,"oldValue":1}]`
	if firstStr != want {
		t.Fatalf("map key order mismatch:\n got: %s\nwant: %s", firstStr, want)
	}
}

// deployment-ish fixtures for the schema-driven keyed-diff test.
type container struct {
	Name  string `json:"name"`
	Image string `json:"image"`
}

type podSpec struct {
	Containers []container `json:"containers"`
}

type deployment struct {
	Replicas int     `json:"replicas"`
	Template podSpec `json:"template"`
}

func TestCompare_SchemaDrivenKeyedDiff(t *testing.T) {
	// `name` is required on container items, so the containers array auto-detects
	// the primaryKey strategy (default candidates include "name", CORE §3.5): a
	// reordering plus an image bump is matched by key, not by position.
	schema := json.RawMessage(`{
		"type": "object",
		"properties": {
			"template": {
				"type": "object",
				"properties": {
					"containers": {
						"type": "array",
						"items": {
							"type": "object",
							"required": ["name"],
							"properties": {"name": {"type": "string"}, "image": {"type": "string"}}
						}
					}
				}
			}
		}
	}`)

	src := deployment{
		Replicas: 2,
		Template: podSpec{Containers: []container{
			{Name: "web", Image: "nginx:1.25"},
			{Name: "sidecar", Image: "envoy:1.29"},
		}},
	}
	dst := deployment{
		Replicas: 2,
		Template: podSpec{Containers: []container{
			// order swapped; only web's image changed
			{Name: "sidecar", Image: "envoy:1.29"},
			{Name: "web", Image: "nginx:1.27"},
		}},
	}

	ops, err := Compare(schema, src, dst)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	got := mustEncodeOps(t, ops)
	// Keyed diff: a single image replace on the web container. A positional
	// (schemaless) diff would instead rewrite both elements.
	want := `[{"op":"replace","path":"/template/containers/0/image","value":"nginx:1.27","oldValue":"nginx:1.25"}]`
	if got != want {
		t.Fatalf("keyed diff mismatch:\n got: %s\nwant: %s", got, want)
	}
}

func TestCompare_SchemaDrivenKeyedDiff_SchemalessDiffers(t *testing.T) {
	// Without a schema the same reorder is positional, proving the schema drove
	// the keyed match above.
	src := deployment{Template: podSpec{Containers: []container{
		{Name: "web", Image: "nginx:1.25"},
		{Name: "sidecar", Image: "envoy:1.29"},
	}}}
	dst := deployment{Template: podSpec{Containers: []container{
		{Name: "sidecar", Image: "envoy:1.29"},
		{Name: "web", Image: "nginx:1.27"},
	}}}

	ops, err := Compare(nil, src, dst)
	if err != nil {
		t.Fatalf("Compare: %v", err)
	}
	if len(ops) == 1 {
		t.Fatalf("expected a positional (multi-op) schemaless diff, got a single keyed-looking op: %s", mustEncodeOps(t, ops))
	}
}

func TestCompare_ErrorPaths(t *testing.T) {
	t.Run("NaN float field", func(t *testing.T) {
		type sample struct {
			X float64 `json:"x"`
		}
		_, err := Compare(nil, sample{X: 0}, sample{X: math.NaN()})
		if err == nil {
			t.Fatal("expected error marshaling NaN, got nil")
		}
	})

	t.Run("unsupported type (chan)", func(t *testing.T) {
		type sample struct {
			C chan int `json:"c"`
		}
		_, err := Compare(nil, sample{}, sample{C: make(chan int)})
		if err == nil {
			t.Fatal("expected error marshaling a channel, got nil")
		}
	})

	t.Run("invalid schema bytes propagate from CompareJSON", func(t *testing.T) {
		_, err := Compare(json.RawMessage(`{`), map[string]any{}, map[string]any{})
		if err == nil {
			t.Fatal("expected error for malformed schema, got nil")
		}
	})
}
