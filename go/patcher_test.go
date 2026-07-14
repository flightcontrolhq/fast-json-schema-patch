package schemapatch

import (
	"testing"
)

// diffJSON is a test convenience: build an empty-plan patcher (unless a plan is
// supplied) and return the compact-encoded patch for two JSON strings.
func diffJSON(t *testing.T, plan Plan, a, b string, opts ...PatcherOption) string {
	t.Helper()
	patcher, err := NewPatcher(plan, opts...)
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	ops := patcher.Execute(mustDecode(t, a), mustDecode(t, b))
	enc, err := EncodeOperations(ops)
	if err != nil {
		t.Fatalf("encode ops: %v", err)
	}
	return string(enc)
}

func TestExecuteObjectBasics(t *testing.T) {
	tests := []struct {
		name, a, b, want string
	}{
		{"no-change", `{"a":1}`, `{"a":1}`, `[]`},
		{"replace", `{"a":1}`, `{"a":2}`, `[{"op":"replace","path":"/a","value":2,"oldValue":1}]`},
		{"add", `{"a":1}`, `{"a":1,"b":2}`, `[{"op":"add","path":"/b","value":2}]`},
		{"remove", `{"a":1,"b":2}`, `{"a":1}`, `[{"op":"remove","path":"/b","oldValue":2}]`},
		{"nested", `{"a":{"x":1}}`, `{"a":{"x":2}}`, `[{"op":"replace","path":"/a/x","value":2,"oldValue":1}]`},
		{"num-1-vs-1.0-equal", `{"a":1}`, `{"a":1.0}`, `[]`},
		{"null-vs-value", `{"a":null}`, `{"a":1}`, `[{"op":"replace","path":"/a","value":1,"oldValue":null}]`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := diffJSON(t, Plan{}, tc.a, tc.b); got != tc.want {
				t.Errorf("diff = %s, want %s", got, tc.want)
			}
		})
	}
}

// TestEcmaKeyOrderReordering proves the object diff visits keys in ECMAScript
// [[OwnPropertyKeys]] order (§2.3.2) even when the DECODED insertion order is
// different — the conformance vectors are authored pre-ordered by JS, so this is
// the case they cannot exercise.
func TestEcmaKeyOrderReordering(t *testing.T) {
	// Decoded insertion order: b, 10, 2, a. ECMAScript order: 2, 10, b, a.
	a := `{"b":1,"10":1,"2":1,"a":1}`
	b := `{"b":2,"10":2,"2":2,"a":2}`
	want := `[` +
		`{"op":"replace","path":"/2","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/10","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/b","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/a","value":2,"oldValue":1}]`
	if got := diffJSON(t, Plan{}, a, b); got != want {
		t.Errorf("diff = %s\nwant %s", got, want)
	}
}

func TestEcmaKeyOrderModifiedOnly(t *testing.T) {
	// original keys {b,5} -> visit /5,/b; modified-only {3,z} -> visit /3,/z.
	a := `{"b":1,"5":1}`
	b := `{"b":2,"5":2,"z":9,"3":9}`
	want := `[` +
		`{"op":"replace","path":"/5","value":2,"oldValue":1},` +
		`{"op":"replace","path":"/b","value":2,"oldValue":1},` +
		`{"op":"add","path":"/3","value":9},` +
		`{"op":"add","path":"/z","value":9}]`
	if got := diffJSON(t, Plan{}, a, b); got != want {
		t.Errorf("diff = %s\nwant %s", got, want)
	}
}

func TestArrayIndexKey(t *testing.T) {
	tests := []struct {
		in   string
		v    uint32
		want bool
	}{
		{"0", 0, true},
		{"1", 1, true},
		{"10", 10, true},
		{"4294967294", 4294967294, true}, // 2^32-2, the max integer-like key
		{"4294967295", 0, false},         // 2^32-1, out of range
		{"02", 0, false},                 // leading zero
		{"-0", 0, false},
		{"+2", 0, false},
		{"2.0", 0, false},
		{"1e1", 0, false},
		{" 2", 0, false},
		{"", 0, false},
		{"b", 0, false},
	}
	for _, tc := range tests {
		v, ok := arrayIndexKey(tc.in)
		if ok != tc.want || (ok && v != tc.v) {
			t.Errorf("arrayIndexKey(%q) = (%d,%v), want (%d,%v)", tc.in, v, ok, tc.v, tc.want)
		}
	}
}

// TestJSNumberString pins the ECMAScript number formatting used by the §5.9 byte
// accounting, including the exponent thresholds that differ from Go's strconv.
func TestJSNumberString(t *testing.T) {
	tests := []struct {
		in   float64
		want string
	}{
		{0, "0"},
		{-0.0, "0"},
		{1, "1"},
		{1.5, "1.5"},
		{100, "100"},
		{-100, "-100"},
		{0.0001, "0.0001"},
		{0.000001, "0.000001"}, // 1e-6 -> decimal
		{1e-7, "1e-7"},         // boundary -> exponential, no '+'
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"}, // boundary -> exponential with '+'
		{1e22, "1e+22"},
		{123456.789, "123456.789"},
	}
	for _, tc := range tests {
		if got := jsNumberString(tc.in); got != tc.want {
			t.Errorf("jsNumberString(%v) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestIncludeOldValueFalse(t *testing.T) {
	got := diffJSON(t, Plan{}, `{"a":1,"b":2}`, `{"a":9}`, IncludeOldValue(false))
	want := `[{"op":"replace","path":"/a","value":9},{"op":"remove","path":"/b"}]`
	if got != want {
		t.Errorf("diff = %s, want %s", got, want)
	}
}

func TestLCSTrimAndInteriorEdit(t *testing.T) {
	// Shared prefix [1,2], interior removal of 3, shared suffix [4,5].
	got := diffJSON(t, Plan{}, `[1,2,3,4,5]`, `[1,2,4,5]`)
	want := `[{"op":"remove","path":"/2","oldValue":3}]`
	if got != want {
		t.Errorf("diff = %s, want %s", got, want)
	}
}

func TestLCSRootArrayPrefix(t *testing.T) {
	// A root-level array uses "/" before the index, never a bare "/".
	got := diffJSON(t, Plan{}, `[]`, `["x"]`)
	want := `[{"op":"add","path":"/0","value":"x"}]`
	if got != want {
		t.Errorf("diff = %s, want %s", got, want)
	}
}

func TestLCSGranularDescent(t *testing.T) {
	// A collapsed same-kind object replace recurses into field-level ops (§5.5.4.2).
	got := diffJSON(t, Plan{}, `[{"x":1}]`, `[{"x":2}]`)
	want := `[{"op":"replace","path":"/0/x","value":2,"oldValue":1}]`
	if got != want {
		t.Errorf("diff = %s, want %s", got, want)
	}
}

// planForKey builds a single-array plan selecting primaryKey on key at the given
// document path.
func planForKey(t *testing.T, schema string) Plan {
	t.Helper()
	plan, err := BuildPlan(mustDecode(t, schema), BuildPlanOptions{})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	return plan
}

func TestPrimaryKeyThreePhase(t *testing.T) {
	schema := `{"type":"array","items":{"type":"object","required":["id"],"properties":{"id":{"type":"string"},"name":{"type":"string"}}}}`
	plan := planForKey(t, schema)
	// Worked example (§5.4.2): mod at original index, removal descending, appends.
	a := `[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]`
	b := `[{"id":"c","name":"C2"},{"id":"a","name":"A"},{"id":"d","name":"D"},{"id":"e","name":"E"}]`
	want := `[` +
		`{"op":"replace","path":"/2/name","value":"C2","oldValue":"C"},` +
		`{"op":"remove","path":"/1","oldValue":{"id":"b","name":"B"}},` +
		`{"op":"add","path":"/-","value":{"id":"d","name":"D"}},` +
		`{"op":"add","path":"/-","value":{"id":"e","name":"E"}}]`
	if got := diffJSON(t, plan, a, b); got != want {
		t.Errorf("diff = %s\nwant %s", got, want)
	}
}

func TestPrimaryKeyGateFallbackToLCS(t *testing.T) {
	schema := `{"type":"array","items":{"type":"object","required":["id"],"properties":{"id":{"type":"string"}}}}`
	plan := planForKey(t, schema)
	// A duplicate key in original fails the gate -> LCS positional emission.
	a := `[{"id":"a"},{"id":"a"}]`
	b := `[{"id":"a"},{"id":"b"}]`
	// LCS: [{id:a}] common prefix, then replace {id:a}->{id:b} at index 1 (granular).
	want := `[{"op":"replace","path":"/1/id","value":"b","oldValue":"a"}]`
	if got := diffJSON(t, plan, a, b); got != want {
		t.Errorf("diff = %s\nwant %s", got, want)
	}
}

func TestEmitMovesLCSRotation(t *testing.T) {
	got := diffJSON(t, Plan{}, `[1,2,3,4]`, `[2,3,4,1]`, EmitMoves(true))
	want := `[{"op":"move","path":"/3","from":"/0"}]`
	if got != want {
		t.Errorf("diff = %s, want %s", got, want)
	}
}

func TestWholesaleReplaceFallback(t *testing.T) {
	schema := `{"type":"object","properties":{"a":{"type":"array","items":{"type":"string"}}}}`
	plan := planForKey(t, schema)
	// Full rewrite where the granular stream exceeds the array's own bytes ->
	// single whole-array replace.
	a := `{"a":["aaaaaaaaaa","bbbbbbbbbb","cccccccccc"]}`
	b := `{"a":["dddddddddd","eeeeeeeeee","ffffffffff"]}`
	got := diffJSON(t, plan, a, b, IncludeOldValue(false), WholesaleReplaceFallback(true))
	want := `[{"op":"replace","path":"/a","value":["dddddddddd","eeeeeeeeee","ffffffffff"]}]`
	if got != want {
		t.Errorf("diff = %s, want %s", got, want)
	}
}

func TestDefaultOptionsIncludeOldValue(t *testing.T) {
	// The zero-option constructor defaults includeOldValue on.
	p, _ := NewPatcher(Plan{})
	if !p.includeOldValue || p.emitMoves || p.wholesaleReplaceFallback {
		t.Errorf("defaults = {iov:%v, moves:%v, wholesale:%v}, want {true,false,false}",
			p.includeOldValue, p.emitMoves, p.wholesaleReplaceFallback)
	}
}

func TestKindMismatchWholeReplace(t *testing.T) {
	// object vs array at the same path is a whole replace, never a merge (§5.1.4).
	got := diffJSON(t, Plan{}, `{"a":{"x":1}}`, `{"a":[1]}`)
	want := `[{"op":"replace","path":"/a","value":[1],"oldValue":{"x":1}}]`
	if got != want {
		t.Errorf("diff = %s, want %s", got, want)
	}
}
