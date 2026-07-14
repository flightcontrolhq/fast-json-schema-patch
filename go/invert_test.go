package schemapatch

import (
	"errors"
	"testing"
)

// roundTrip asserts the §9.1.2 identity: apply(apply(D,patch),invert(D,patch))
// deep-equals D.
func roundTrip(t *testing.T, doc string, ops []Operation) {
	t.Helper()
	d := mustDecode(t, doc)
	inv, err := InvertPatch(d, ops)
	if err != nil {
		t.Fatalf("InvertPatch: %v", err)
	}
	forward, err := ApplyPatch(d, ops, ApplyOptions{})
	if err != nil {
		t.Fatalf("forward apply: %v", err)
	}
	back, err := ApplyPatch(forward, inv, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply inverse: %v", err)
	}
	if !DeepEqual(back, d) {
		t.Errorf("round-trip failed: got %s, want %s", mustEncode(t, back), mustEncode(t, doc))
	}
}

// TestInvertRoundTripWithoutOldValue proves §9.2.2 / §10.4.2: invert recovers
// pre-change values from the ORIGINAL document, so a patch generated with
// includeOldValue=false (no oldValue on any op) still round-trips.
func TestInvertRoundTripWithoutOldValue(t *testing.T) {
	orig := `{"a":{"x":1},"b":[1,2,3],"c":"gone"}`
	mod := `{"a":{"x":9},"b":[1,2,3,4]}`
	patcher, err := NewPatcher(Plan{}, IncludeOldValue(false))
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	ops := patcher.Execute(mustDecode(t, orig), mustDecode(t, mod))
	for i := range ops {
		if ops[i].HasOldValue {
			t.Fatalf("expected no oldValue with includeOldValue=false, op %d has one", i)
		}
	}
	roundTrip(t, orig, ops)
}

// TestInvertRoundTripGeneratedPrimaryKey exercises a real keyed patch (mods,
// removals, /- appends) through invert (SPEC §7.3).
func TestInvertRoundTripGeneratedPrimaryKey(t *testing.T) {
	schema := `{"type":"object","properties":{"users":{"type":"array","items":{"type":"object","required":["id"],"properties":{"id":{"type":"string"},"name":{"type":"string"}}}}}}`
	plan, err := BuildPlan(mustDecode(t, schema), BuildPlanOptions{})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	orig := `{"users":[{"id":"a","name":"A"},{"id":"b","name":"B"},{"id":"c","name":"C"}]}`
	mod := `{"users":[{"id":"c","name":"C2"},{"id":"a","name":"A"},{"id":"d","name":"D"}]}`
	patcher, err := NewPatcher(plan)
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	ops := patcher.Execute(mustDecode(t, orig), mustDecode(t, mod))
	roundTrip(t, orig, ops)
}

func TestInvertErrors(t *testing.T) {
	cases := []struct {
		name, doc, patch string
		sentinel         error
	}{
		{"remove-nonexistent", `{"a":1}`, `[{"op":"remove","path":"/b"}]`, ErrPathUnresolvable},
		{"replace-nonexistent", `{"a":1}`, `[{"op":"replace","path":"/b","value":1}]`, ErrPathUnresolvable},
		{"unknown-op", `{"a":1}`, `[{"op":"frobnicate","path":"/a"}]`, ErrInvalidOperation},
		{"move-missing-from", `{"a":1}`, `[{"op":"move","path":"/b"}]`, ErrInvalidOperation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ops, err := DecodeOperations([]byte(tc.patch))
			if err != nil {
				t.Fatalf("decode: %v", err)
			}
			_, err = InvertPatch(mustDecode(t, tc.doc), ops)
			if !errors.Is(err, tc.sentinel) {
				t.Errorf("err = %v, want %v", err, tc.sentinel)
			}
		})
	}
}
