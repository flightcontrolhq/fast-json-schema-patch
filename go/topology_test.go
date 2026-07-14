package schemapatch

import (
	"strings"
	"testing"
)

// topology_test.go mirrors test/topology.test.ts for the Go engine: spec-v2
// declared semantic topologies (CORE §8, GEN §11). It pins (1) the ZERO
// default-output-change compatibility profile (§8.8); (2) each topology's
// emission and round-trip contract; (3) extension overrides of auto-detection and
// primaryKeyMap; (4) the per-element identity gates and their sequence/LCS
// fallback; (5) construction-time validation.

// topoOps builds a plan from schemaJSON and diffs aJSON→bJSON with the given
// options, returning the ops. It fails the test on any construction error.
func topoOps(t *testing.T, schemaJSON, aJSON, bJSON string, bopts BuildPlanOptions, popts ...PatcherOption) []Operation {
	t.Helper()
	plan := mustPlan(t, schemaJSON, bopts)
	p, err := NewPatcher(plan, popts...)
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	return p.Execute(mustDecode(t, aJSON), mustDecode(t, bJSON))
}

func encodeOps(t *testing.T, ops []Operation) string {
	t.Helper()
	b, err := EncodeOperations(ops)
	if err != nil {
		t.Fatalf("EncodeOperations: %v", err)
	}
	return string(b)
}

// topoRoundTrip applies ops to aJSON and asserts the result deep-equals
// expectedJSON (the topology's reconstruction contract).
func topoRoundTrip(t *testing.T, aJSON string, ops []Operation, expectedJSON string) {
	t.Helper()
	got, err := ApplyPatch(mustDecode(t, aJSON), ops, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply failed: %v", err)
	}
	want := mustDecode(t, expectedJSON)
	if !DeepEqual(got, want) {
		ge, _ := Encode(got)
		we, _ := Encode(want)
		t.Errorf("round-trip mismatch:\n got  %s\n want %s", ge, we)
	}
}

func hasOp(ops []Operation, op Op) bool {
	for i := range ops {
		if ops[i].Op == op {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 1. Compatibility profile — zero default-output change (CORE §8.8)
// ---------------------------------------------------------------------------

func TestTopologyCompatAutoKeyEqualsDeclaredMap(t *testing.T) {
	// An auto-detected primaryKey and a declared map keys:[id]/insignificant emit
	// BYTE-FOR-BYTE identical ops (CORE §8.8.1).
	compatSchema := `{
		"type":"object","properties":{"users":{"type":"array","items":{
			"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"}},"required":["id"]
		}}}
	}`
	declaredSchema := `{
		"type":"object","properties":{"users":{"type":"array",
			"x-schema-patch-topology":"map","x-schema-patch-keys":["id"],
			"items":{"type":"object","properties":{"id":{"type":"string"},"name":{"type":"string"}},"required":["id"]}
		}}
	}`
	a := `{"users":[{"id":"a","name":"Al"},{"id":"b","name":"Bo"},{"id":"c","name":"Cy"}]}`
	b := `{"users":[{"id":"a","name":"Alice"},{"id":"c","name":"Cy"},{"id":"d","name":"Dee"}]}`

	compat := topoOps(t, compatSchema, a, b, BuildPlanOptions{})
	mapped := topoOps(t, declaredSchema, a, b, BuildPlanOptions{})
	if encodeOps(t, compat) != encodeOps(t, mapped) {
		t.Errorf("declared map != compat auto-key:\n compat %s\n mapped %s", encodeOps(t, compat), encodeOps(t, mapped))
	}
	// Keyed-collection contract (survivors ++ appends).
	topoRoundTrip(t, a, compat, `{"users":[{"id":"a","name":"Alice"},{"id":"c","name":"Cy"},{"id":"d","name":"Dee"}]}`)
}

func TestTopologyCompatPrimaryKeyMapEqualsDeclaredMap(t *testing.T) {
	schemaNoKey := `{"type":"object","properties":{"rows":{"type":"array","items":{"type":"object","properties":{"sku":{"type":"string"}}}}}}`
	a := `{"rows":[{"sku":"x","q":1},{"sku":"y","q":2}]}`
	b := `{"rows":[{"sku":"y","q":2},{"sku":"x","q":9}]}`
	viaMap := topoOps(t, schemaNoKey, a, b, BuildPlanOptions{PrimaryKeyMap: map[string]string{"/rows": "sku"}})

	declared := `{"type":"object","properties":{"rows":{"type":"array",
		"x-schema-patch-topology":"map","x-schema-patch-keys":["sku"],
		"items":{"type":"object","properties":{"sku":{"type":"string"}}}}}}`
	viaDeclared := topoOps(t, declared, a, b, BuildPlanOptions{})
	if encodeOps(t, viaMap) != encodeOps(t, viaDeclared) {
		t.Errorf("declared map != primaryKeyMap:\n map %s\n declared %s", encodeOps(t, viaMap), encodeOps(t, viaDeclared))
	}
}

// ---------------------------------------------------------------------------
// 2. sequence topology (CORE §8.7)
// ---------------------------------------------------------------------------

func TestTopologySequenceForcesLCS(t *testing.T) {
	schema := `{"type":"object","properties":{"items":{"type":"array",
		"x-schema-patch-topology":"sequence",
		"items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}}`
	a := `{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}`
	// A pure reorder: primaryKey would emit ZERO ops; sequence/LCS must emit ops.
	b := `{"items":[{"id":"c"},{"id":"a"},{"id":"b"}]}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	if len(ops) == 0 {
		t.Fatal("sequence must emit positional ops for a reorder, got none")
	}
	topoRoundTrip(t, a, ops, b)
}

// ---------------------------------------------------------------------------
// 3. set topology (CORE §8.5, GEN §11.3)
// ---------------------------------------------------------------------------

func TestTopologySetAddRemove(t *testing.T) {
	schema := `{"type":"object","properties":{"tags":{"type":"array","x-schema-patch-topology":"set","items":{"type":"string"}}}}`
	a := `{"tags":["a","b","c","d"]}`
	b := `{"tags":["a","c","e","f"]}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	want := `[{"op":"remove","path":"/tags/3","oldValue":"d"},{"op":"remove","path":"/tags/1","oldValue":"b"},{"op":"add","path":"/tags/-","value":"e"},{"op":"add","path":"/tags/-","value":"f"}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("set diff = %s\nwant %s", got, want)
	}
	topoRoundTrip(t, a, ops, `{"tags":["a","c","e","f"]}`)
}

func TestTopologySetReorderZeroOps(t *testing.T) {
	schema := `{"type":"object","properties":{"tags":{"type":"array","x-schema-patch-topology":"set","items":{"type":"string"}}}}`
	ops := topoOps(t, schema, `{"tags":["a","b","c"]}`, `{"tags":["c","a","b"]}`, BuildPlanOptions{})
	if len(ops) != 0 {
		t.Errorf("pure reorder of a set must emit zero ops, got %s", encodeOps(t, ops))
	}
}

func TestTopologySetOfObjects(t *testing.T) {
	schema := `{"type":"object","properties":{"pts":{"type":"array","x-schema-patch-topology":"set","items":{"type":"object","properties":{"x":{"type":"number"}}}}}}`
	a := `{"pts":[{"x":1},{"x":2}]}`
	b := `{"pts":[{"x":2},{"x":3}]}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	want := `[{"op":"remove","path":"/pts/0","oldValue":{"x":1}},{"op":"add","path":"/pts/-","value":{"x":3}}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("set-of-objects diff = %s\nwant %s", got, want)
	}
	topoRoundTrip(t, a, ops, `{"pts":[{"x":2},{"x":3}]}`)
}

func TestTopologySetGateDuplicateFallsBack(t *testing.T) {
	schema := `{"type":"object","properties":{"tags":{"type":"array","x-schema-patch-topology":"set","items":{"type":"string"}}}}`
	a := `{"tags":["a","a","b"]}` // dup "a" in original
	b := `{"tags":["a","b"]}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	topoRoundTrip(t, a, ops, b)
	// Falls back to LCS: a positional removal, NOT a membership /- diff.
	if !hasOp(ops, OpRemove) || hasOp(ops, OpAdd) {
		t.Errorf("gate fallback expected LCS remove-only, got %s", encodeOps(t, ops))
	}
}

// ---------------------------------------------------------------------------
// 4. map topology — composite keys (CORE §8.4, GEN §11.4)
// ---------------------------------------------------------------------------

const portsSchema = `{"type":"object","properties":{"ports":{"type":"array",
	"x-schema-patch-topology":"map","x-schema-patch-keys":["containerPort","protocol"],
	"items":{"type":"object","properties":{"containerPort":{"type":"number"},"protocol":{"type":"string"},"name":{"type":"string"}},"required":["containerPort","protocol"]}}}}`

func TestTopologyMapCompositeIdentity(t *testing.T) {
	a := `{"ports":[{"containerPort":80,"protocol":"TCP","name":"http"},{"containerPort":80,"protocol":"UDP","name":"http-udp"}]}`
	b := `{"ports":[{"containerPort":80,"protocol":"TCP","name":"web"},{"containerPort":443,"protocol":"TCP","name":"https"}]}`
	ops := topoOps(t, portsSchema, a, b, BuildPlanOptions{})
	// (80,TCP) matched+modified at index 0; (80,UDP) removed; (443,TCP) added.
	want := `[{"op":"replace","path":"/ports/0/name","value":"web","oldValue":"http"},` +
		`{"op":"remove","path":"/ports/1","oldValue":{"containerPort":80,"protocol":"UDP","name":"http-udp"}},` +
		`{"op":"add","path":"/ports/-","value":{"containerPort":443,"protocol":"TCP","name":"https"}}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("map composite diff = %s\nwant %s", got, want)
	}
}

func TestTopologyMapInsignificantRoundTrip(t *testing.T) {
	a := `{"ports":[{"containerPort":80,"protocol":"TCP","name":"a"},{"containerPort":81,"protocol":"TCP","name":"b"}]}`
	b := `{"ports":[{"containerPort":81,"protocol":"TCP","name":"B"},{"containerPort":80,"protocol":"TCP","name":"a"},{"containerPort":82,"protocol":"TCP","name":"c"}]}`
	ops := topoOps(t, portsSchema, a, b, BuildPlanOptions{})
	// Keyed-collection: survivors in ORIGINAL order carrying modified content ++ new appended.
	topoRoundTrip(t, a, ops, `{"ports":[{"containerPort":80,"protocol":"TCP","name":"a"},{"containerPort":81,"protocol":"TCP","name":"B"},{"containerPort":82,"protocol":"TCP","name":"c"}]}`)
	// It must NOT reorder survivors: no moves in the insignificant emission.
	if hasOp(ops, OpMove) {
		t.Errorf("insignificant map must not emit moves, got %s", encodeOps(t, ops))
	}
}

func TestTopologyMapSignificantExactOrder(t *testing.T) {
	sig := `{"type":"object","properties":{"ports":{"type":"array",
		"x-schema-patch-topology":"map","x-schema-patch-keys":["containerPort","protocol"],"x-schema-patch-order":"significant",
		"items":{"type":"object","properties":{"containerPort":{"type":"number"},"protocol":{"type":"string"},"name":{"type":"string"}},"required":["containerPort","protocol"]}}}}`
	a := `{"ports":[{"containerPort":80,"protocol":"TCP","name":"a"},{"containerPort":81,"protocol":"TCP","name":"b"}]}`
	b := `{"ports":[{"containerPort":81,"protocol":"TCP","name":"B"},{"containerPort":80,"protocol":"TCP","name":"a"},{"containerPort":82,"protocol":"TCP","name":"c"}]}`
	// order-significant map reconstructs modified EXACTLY, via the move machinery,
	// WITHOUT the emitMoves option.
	ops := topoOps(t, sig, a, b, BuildPlanOptions{})
	topoRoundTrip(t, a, ops, b)
	if !hasOp(ops, OpMove) {
		t.Errorf("significant map must emit at least one move, got %s", encodeOps(t, ops))
	}
}

func TestTopologyMapGateDuplicateTupleFallsBack(t *testing.T) {
	a := `{"ports":[{"containerPort":80,"protocol":"TCP","name":"a"},{"containerPort":80,"protocol":"TCP","name":"dup"}]}`
	b := `{"ports":[{"containerPort":80,"protocol":"TCP","name":"a"}]}`
	ops := topoOps(t, portsSchema, a, b, BuildPlanOptions{})
	topoRoundTrip(t, a, ops, b)
}

func TestTopologyMapGateMissingKeyFallsBack(t *testing.T) {
	a := `{"ports":[{"containerPort":80,"name":"no-proto"}]}` // protocol absent
	b := `{"ports":[{"containerPort":80,"name":"still"}]}`
	ops := topoOps(t, portsSchema, a, b, BuildPlanOptions{})
	topoRoundTrip(t, a, ops, b)
}

func TestTopologyMapDeclaredOrderIsIdentity(t *testing.T) {
	// keys [a,b]: (1,2) and (2,1) are distinct tuples (declared order significant).
	schema := `{"type":"object","properties":{"rows":{"type":"array",
		"x-schema-patch-topology":"map","x-schema-patch-keys":["a","b"],
		"items":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}}}}}}`
	a := `{"rows":[{"a":1,"b":2,"v":"x"}]}`
	b := `{"rows":[{"a":2,"b":1,"v":"y"}]}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	want := `[{"op":"remove","path":"/rows/0","oldValue":{"a":1,"b":2,"v":"x"}},{"op":"add","path":"/rows/-","value":{"a":2,"b":1,"v":"y"}}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("tuple-order identity diff = %s\nwant %s", got, want)
	}
}

// ---------------------------------------------------------------------------
// 5. atomic array + atomic object (CORE §8.6)
// ---------------------------------------------------------------------------

func TestTopologyAtomicArray(t *testing.T) {
	schema := `{"type":"object","properties":{"matrix":{"type":"array","x-schema-patch-topology":"atomic",
		"items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}}`
	a := `{"matrix":[{"id":"a","n":1}]}`
	b := `{"matrix":[{"id":"a","n":2}]}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	want := `[{"op":"replace","path":"/matrix","value":[{"id":"a","n":2}],"oldValue":[{"id":"a","n":1}]}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("atomic array diff = %s\nwant %s", got, want)
	}
	topoRoundTrip(t, a, ops, b)
}

func TestTopologyAtomicArrayEqualNoOps(t *testing.T) {
	schema := `{"type":"object","properties":{"a":{"type":"array","x-schema-patch-topology":"atomic","items":{"type":"number"}}}}`
	ops := topoOps(t, schema, `{"a":[1,2,3]}`, `{"a":[1,2,3]}`, BuildPlanOptions{})
	if len(ops) != 0 {
		t.Errorf("equal atomic array must emit nothing, got %s", encodeOps(t, ops))
	}
}

func TestTopologyAtomicObject(t *testing.T) {
	schema := `{"type":"object","properties":{"config":{"type":"object","x-schema-patch-granularity":"atomic",
		"properties":{"a":{"type":"number"},"b":{"type":"number"}}}}}`
	a := `{"config":{"a":1,"b":2}}`
	b := `{"config":{"a":1,"b":3}}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	want := `[{"op":"replace","path":"/config","value":{"a":1,"b":3},"oldValue":{"a":1,"b":2}}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("atomic object diff = %s\nwant %s", got, want)
	}
	topoRoundTrip(t, a, ops, b)
}

func TestTopologyAtomicObjectEqualNoOps(t *testing.T) {
	schema := `{"type":"object","properties":{"config":{"type":"object","x-schema-patch-granularity":"atomic","properties":{"a":{"type":"number"}}}}}`
	ops := topoOps(t, schema, `{"config":{"a":1}}`, `{"config":{"a":1}}`, BuildPlanOptions{})
	if len(ops) != 0 {
		t.Errorf("equal atomic object must emit nothing, got %s", encodeOps(t, ops))
	}
}

func TestTopologyAtomicPrunesSubtree(t *testing.T) {
	// Nothing recurses below an atomic node: a keyed inner array is NOT diffed granularly.
	schema := `{"type":"object","properties":{"box":{"type":"object","x-schema-patch-granularity":"atomic",
		"properties":{"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}}}}`
	a := `{"box":{"items":[{"id":"a","v":1}]}}`
	b := `{"box":{"items":[{"id":"a","v":2}]}}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{})
	want := `[{"op":"replace","path":"/box","value":{"items":[{"id":"a","v":2}]},"oldValue":{"items":[{"id":"a","v":1}]}}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("atomic-subtree diff = %s\nwant %s (must be one /box replace, not /box/items/0/v)", got, want)
	}
}

// ---------------------------------------------------------------------------
// 6. Precedence: extensions override auto-detection AND primaryKeyMap
// ---------------------------------------------------------------------------

func TestTopologySequenceOverridesAutoKey(t *testing.T) {
	schema := `{"type":"object","properties":{"items":{"type":"array","x-schema-patch-topology":"sequence",
		"items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}}`
	a := `{"items":[{"id":"a"},{"id":"b"}]}`
	b := `{"items":[{"id":"b"},{"id":"a"}]}` // pure reorder
	// primaryKey would emit []; sequence must emit ops to reorder.
	if ops := topoOps(t, schema, a, b, BuildPlanOptions{}); len(ops) == 0 {
		t.Error("sequence override must emit ops for a reorder, got none")
	}
}

func TestTopologyAtomicOverridesPrimaryKeyMap(t *testing.T) {
	schema := `{"type":"object","properties":{"items":{"type":"array","x-schema-patch-topology":"atomic",
		"items":{"type":"object","properties":{"id":{"type":"string"}}}}}}`
	a := `{"items":[{"id":"a"},{"id":"b"}]}`
	b := `{"items":[{"id":"b"},{"id":"a"}]}`
	ops := topoOps(t, schema, a, b, BuildPlanOptions{PrimaryKeyMap: map[string]string{"/items": "id"}})
	// atomic wins: one whole-array replace, not a keyed no-op reorder.
	want := `[{"op":"replace","path":"/items","value":[{"id":"b"},{"id":"a"}],"oldValue":[{"id":"a"},{"id":"b"}]}]`
	if got := encodeOps(t, ops); got != want {
		t.Errorf("atomic-over-primaryKeyMap diff = %s\nwant %s", got, want)
	}
}

// ---------------------------------------------------------------------------
// 7. Construction-time validation (CORE §8.2.3)
// ---------------------------------------------------------------------------

func expectBuildError(t *testing.T, schemaJSON, wantSubstr string) {
	t.Helper()
	schema, err := Decode([]byte(schemaJSON))
	if err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	_, err = BuildPlan(schema, BuildPlanOptions{})
	if err == nil {
		t.Fatalf("expected BuildPlan error containing %q, got nil", wantSubstr)
	}
	if !strings.Contains(err.Error(), wantSubstr) {
		t.Errorf("error %q does not contain %q", err.Error(), wantSubstr)
	}
}

func TestTopologyValidationMapWithoutKeys(t *testing.T) {
	expectBuildError(t, `{"type":"object","properties":{"a":{"type":"array","x-schema-patch-topology":"map","items":{"type":"object"}}}}`, "REQUIRES")
}

func TestTopologyValidationUnknownTopology(t *testing.T) {
	expectBuildError(t, `{"type":"object","properties":{"a":{"type":"array","x-schema-patch-topology":"bag","items":{}}}}`, "unknown value")
}

func TestTopologyValidationUnknownOrder(t *testing.T) {
	expectBuildError(t, `{"type":"object","properties":{"a":{"type":"array","x-schema-patch-topology":"map","x-schema-patch-keys":["id"],"x-schema-patch-order":"sorted","items":{}}}}`, "x-schema-patch-order")
}

func TestTopologyValidationUnknownGranularity(t *testing.T) {
	expectBuildError(t, `{"type":"object","properties":{"a":{"type":"object","x-schema-patch-granularity":"coarse","properties":{"x":{}}}}}`, "x-schema-patch-granularity")
}

func TestTopologyValidationConflictingTopologies(t *testing.T) {
	expectBuildError(t, `{"type":"object","properties":{"a":{"anyOf":[
		{"type":"array","x-schema-patch-topology":"set","items":{"type":"number"}},
		{"type":"array","x-schema-patch-topology":"sequence","items":{"type":"number"}}
	]}}}`, "conflicting")
}

func expectPatcherError(t *testing.T, schemaJSON, wantSubstr string, opts ...PatcherOption) {
	t.Helper()
	plan := mustPlan(t, schemaJSON, BuildPlanOptions{})
	_, err := NewPatcher(plan, opts...)
	if err == nil {
		t.Fatalf("expected NewPatcher error containing %q, got nil", wantSubstr)
	}
	if !strings.Contains(err.Error(), wantSubstr) {
		t.Errorf("error %q does not contain %q", err.Error(), wantSubstr)
	}
}

func TestTopologyValidationAtomicArrayIgnored(t *testing.T) {
	schema := `{"type":"object","properties":{"box":{"type":"array","x-schema-patch-topology":"atomic",
		"items":{"type":"object","properties":{"secret":{"type":"string"}}}}}}`
	expectPatcherError(t, schema, "atomic", IgnorePaths("/box/secret"))
}

func TestTopologyValidationAtomicObjectIgnored(t *testing.T) {
	schema := `{"type":"object","properties":{"config":{"type":"object","x-schema-patch-granularity":"atomic",
		"properties":{"secret":{"type":"string"}}}}}`
	expectPatcherError(t, schema, "atomic", IgnorePaths("/config/secret"))
}

func TestTopologyValidationMapKeyIgnored(t *testing.T) {
	schema := `{"type":"object","properties":{"ports":{"type":"array",
		"x-schema-patch-topology":"map","x-schema-patch-keys":["containerPort","protocol"],
		"items":{"type":"object","properties":{"containerPort":{"type":"number"},"protocol":{"type":"string"}}}}}}`
	expectPatcherError(t, schema, "key field", IgnorePaths("/ports/*/protocol"))
}

// ---------------------------------------------------------------------------
// 7b. Capabilities are contract-preserving under topology (CORE §7.7.2)
// ---------------------------------------------------------------------------

func TestTopologyEmitMovesNoUpgradeForInsignificantMap(t *testing.T) {
	schema := `{"type":"object","properties":{"rows":{"type":"array",
		"x-schema-patch-topology":"map","x-schema-patch-keys":["id"],
		"items":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}}}}`
	a := `{"rows":[{"id":"a"},{"id":"b"}]}`
	b := `{"rows":[{"id":"b"},{"id":"a"}]}` // pure reorder
	// With the option OFF and ON the output is identical: a pure reorder of an
	// order-insignificant map emits NOTHING either way (no move upgrade).
	if ops := topoOps(t, schema, a, b, BuildPlanOptions{}); len(ops) != 0 {
		t.Errorf("emitMoves OFF: expected zero ops, got %s", encodeOps(t, ops))
	}
	if ops := topoOps(t, schema, a, b, BuildPlanOptions{}, EmitMoves(true)); len(ops) != 0 {
		t.Errorf("emitMoves ON must NOT upgrade insignificant map, got %s", encodeOps(t, ops))
	}
}

func TestTopologyEmitMovesNoOpForSet(t *testing.T) {
	schema := `{"type":"object","properties":{"tags":{"type":"array","x-schema-patch-topology":"set","items":{"type":"string"}}}}`
	a := `{"tags":["a","b","c"]}`
	b := `{"tags":["c","a","b"]}` // reorder
	if ops := topoOps(t, schema, a, b, BuildPlanOptions{}, EmitMoves(true)); len(ops) != 0 {
		t.Errorf("emitMoves must be a no-op for set reorder, got %s", encodeOps(t, ops))
	}
}

// ---------------------------------------------------------------------------
// 8. Plan-shape introspection (CORE §8.3)
// ---------------------------------------------------------------------------

func TestTopologyPlanShape(t *testing.T) {
	schema := `{"type":"object","properties":{
		"ports":{"type":"array","x-schema-patch-topology":"map","x-schema-patch-keys":["containerPort","protocol"],"x-schema-patch-order":"significant",
			"items":{"type":"object","properties":{"containerPort":{"type":"number"},"protocol":{"type":"string"}}}},
		"config":{"type":"object","x-schema-patch-granularity":"atomic","properties":{"x":{}}}
	}}`
	plan := mustPlan(t, schema, BuildPlanOptions{})

	ports, ok := plan.Lookup("/ports")
	if !ok {
		t.Fatalf("expected /ports plan, got %v", plan.Paths())
	}
	if ports.Topology != TopologyMap || ports.Order != "significant" {
		t.Errorf("/ports topology=%q order=%q, want map/significant", ports.Topology, ports.Order)
	}
	if !sameStringSlice(ports.Keys, []string{"containerPort", "protocol"}) {
		t.Errorf("/ports keys=%v, want [containerPort protocol]", ports.Keys)
	}
	// Lossy compat view: strategy primaryKey, primaryKey=keys[0].
	if ports.Strategy != StrategyPrimaryKey || ports.PrimaryKey != "containerPort" {
		t.Errorf("/ports compat view = %q/%q, want primaryKey/containerPort", ports.Strategy, ports.PrimaryKey)
	}

	config, ok := plan.Lookup("/config")
	if !ok || config.Granularity != "atomic" {
		t.Errorf("/config = %+v (ok=%v), want granularity atomic", config, ok)
	}
}

func TestTopologyGranularObjectNotRegistered(t *testing.T) {
	// A granular (default) object is NOT registered — plan/trie stays minimal.
	schema := `{"type":"object","properties":{"config":{"type":"object","properties":{"x":{"type":"number"}}}}}`
	plan := mustPlan(t, schema, BuildPlanOptions{})
	if _, ok := plan.Lookup("/config"); ok {
		t.Error("a granular object must not be registered in the plan")
	}
}
