package schemapatch

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// diffVector mirrors the CONF §2 diff vector format. schema is kept raw so it can
// be decoded with the order-preserving [Decode] that BuildPlan consumes; the
// documents and expected patch are likewise decoded through the value model so
// number text and member order survive.
type diffVector struct {
	Name          string          `json:"name"`
	Comment       string          `json:"comment"`
	Schema        json.RawMessage `json:"schema"`
	Options       diffVectorOpts  `json:"options"`
	Original      json.RawMessage `json:"original"`
	Modified      json.RawMessage `json:"modified"`
	ExpectedPatch json.RawMessage `json:"expectedPatch"`
}

type diffVectorOpts struct {
	PrimaryKeyMap        map[string]string `json:"primaryKeyMap"`
	BasePath             string            `json:"basePath"`
	PrimaryKeyCandidates []string          `json:"primaryKeyCandidates"`
	Capabilities         struct {
		IncludeOldValue          *bool    `json:"includeOldValue"`
		EmitMoves                *bool    `json:"emitMoves"`
		WholesaleReplaceFallback *bool    `json:"wholesaleReplaceFallback"`
		IgnorePaths              []string `json:"ignorePaths"`
	} `json:"capabilities"`
}

func TestDiffConformanceVectors(t *testing.T) {
	dir := filepath.Join("..", "spec", "vectors", "diff")
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			t.Skip("diff vector directory absent (published-module case)")
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
		var vectors []diffVector
		if err := json.Unmarshal(data, &vectors); err != nil {
			t.Fatalf("parse %s: %v", entry.Name(), err)
		}
		for _, vec := range vectors {
			vec := vec
			total++
			t.Run(entry.Name()+"/"+vec.Name, func(t *testing.T) {
				runDiffVector(t, vec)
			})
		}
	}
	if total == 0 {
		t.Fatal("no diff vectors found")
	}
	t.Logf("diff vectors executed: %d", total)
}

func runDiffVector(t *testing.T, vec diffVector) {
	t.Helper()

	// Build the plan. A null/absent schema means the schemaless empty plan.
	var plan Plan
	if len(vec.Schema) > 0 && string(vec.Schema) != "null" {
		schema, err := Decode(vec.Schema)
		if err != nil {
			t.Fatalf("decode schema: %v", err)
		}
		plan, err = BuildPlan(schema, BuildPlanOptions{
			PrimaryKeyMap:        vec.Options.PrimaryKeyMap,
			BasePath:             vec.Options.BasePath,
			PrimaryKeyCandidates: vec.Options.PrimaryKeyCandidates,
		})
		if err != nil {
			t.Fatalf("BuildPlan: %v", err)
		}
	}

	var opts []PatcherOption
	if c := vec.Options.Capabilities; true {
		if c.IncludeOldValue != nil {
			opts = append(opts, IncludeOldValue(*c.IncludeOldValue))
		}
		if c.EmitMoves != nil {
			opts = append(opts, EmitMoves(*c.EmitMoves))
		}
		if c.WholesaleReplaceFallback != nil {
			opts = append(opts, WholesaleReplaceFallback(*c.WholesaleReplaceFallback))
		}
		if len(c.IgnorePaths) > 0 {
			opts = append(opts, IgnorePaths(c.IgnorePaths...))
		}
	}

	original, err := Decode(vec.Original)
	if err != nil {
		t.Fatalf("decode original: %v", err)
	}
	modified, err := Decode(vec.Modified)
	if err != nil {
		t.Fatalf("decode modified: %v", err)
	}

	patcher, err := NewPatcher(plan, opts...)
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	got := patcher.Execute(original, modified)

	// (b) Structural op equality (CONF §4.2).
	want := decodeExpectedPatch(t, vec.ExpectedPatch)
	assertOpsEqual(t, got, want)
}

// decodeExpectedPatch parses the expectedPatch array into the value model so op
// fields (value/oldValue) can be compared under deep JSON equality (CONF §4.2).
func decodeExpectedPatch(t *testing.T, raw json.RawMessage) []expectedOp {
	t.Helper()
	v, err := Decode(raw)
	if err != nil {
		t.Fatalf("decode expectedPatch: %v", err)
	}
	arr, ok := v.([]Value)
	if !ok {
		t.Fatalf("expectedPatch is not an array: %T", v)
	}
	out := make([]expectedOp, len(arr))
	for i, e := range arr {
		obj, ok := e.(*Object)
		if !ok {
			t.Fatalf("expectedPatch[%d] is not an object: %T", i, e)
		}
		eo := expectedOp{}
		if op, ok := obj.Get("op"); ok {
			eo.op, _ = op.(string)
		}
		if pth, ok := obj.Get("path"); ok {
			eo.path, _ = pth.(string)
		}
		if from, ok := obj.Get("from"); ok {
			eo.from, _ = from.(string)
			eo.hasFrom = true
		}
		if val, ok := obj.Get("value"); ok {
			eo.value = val
			eo.hasValue = true
		}
		if old, ok := obj.Get("oldValue"); ok {
			eo.oldValue = old
			eo.hasOldValue = true
		}
		out[i] = eo
	}
	return out
}

type expectedOp struct {
	op          string
	path        string
	from        string
	value       Value
	oldValue    Value
	hasFrom     bool
	hasValue    bool
	hasOldValue bool
}

// assertOpsEqual checks structural op equality (CONF §4.2): same length, same
// ordered sequence, each op equal by op, path, and (where present) from/value/
// oldValue under deep JSON equality.
func assertOpsEqual(t *testing.T, got []Operation, want []expectedOp) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("op count = %d, want %d\n got: %s\nwant: %s", len(got), len(want), dumpOps(got), dumpExpected(want))
	}
	for i := range want {
		g := got[i]
		w := want[i]
		if string(g.Op) != w.op {
			t.Errorf("op[%d].op = %q, want %q", i, g.Op, w.op)
		}
		if g.Path != w.path {
			t.Errorf("op[%d].path = %q, want %q", i, g.Path, w.path)
		}
		if w.hasFrom != g.HasFrom || (w.hasFrom && g.From != w.from) {
			t.Errorf("op[%d].from = (%q,present=%v), want (%q,present=%v)", i, g.From, g.HasFrom, w.from, w.hasFrom)
		}
		if w.hasValue != g.HasValue || (w.hasValue && !DeepEqual(g.Value, w.value)) {
			t.Errorf("op[%d].value = (%v,present=%v), want (%v,present=%v)", i, g.Value, g.HasValue, w.value, w.hasValue)
		}
		if w.hasOldValue != g.HasOldValue || (w.hasOldValue && !DeepEqual(g.OldValue, w.oldValue)) {
			t.Errorf("op[%d].oldValue = (%v,present=%v), want (%v,present=%v)", i, g.OldValue, g.HasOldValue, w.oldValue, w.hasOldValue)
		}
	}
	if t.Failed() {
		t.Logf(" got: %s", dumpOps(got))
		t.Logf("want: %s", dumpExpected(want))
	}
}

func dumpOps(ops []Operation) string {
	b, err := EncodeOperations(ops)
	if err != nil {
		return "<encode error: " + err.Error() + ">"
	}
	return string(b)
}

func dumpExpected(ops []expectedOp) string {
	arr := make([]Value, len(ops))
	for i, o := range ops {
		obj := NewObject()
		obj.Set("op", o.op)
		obj.Set("path", o.path)
		if o.hasFrom {
			obj.Set("from", o.from)
		}
		if o.hasValue {
			obj.Set("value", o.value)
		}
		if o.hasOldValue {
			obj.Set("oldValue", o.oldValue)
		}
		arr[i] = obj
	}
	b, _ := Encode(arr)
	return string(b)
}
