package schemapatch

import (
	"encoding/json"
	"testing"
)

func TestOperationUnmarshalPresence(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		op          Op
		path        string
		hasFrom     bool
		from        string
		hasValue    bool
		valueIsNull bool
		hasOld      bool
		oldIsNull   bool
	}{
		{
			name: "add-with-value", in: `{"op":"add","path":"/a","value":1}`,
			op: OpAdd, path: "/a", hasValue: true,
		},
		{
			name: "add-value-null-present", in: `{"op":"add","path":"/a","value":null}`,
			op: OpAdd, path: "/a", hasValue: true, valueIsNull: true,
		},
		{
			name: "remove-no-value", in: `{"op":"remove","path":"/a","oldValue":5}`,
			op: OpRemove, path: "/a", hasOld: true,
		},
		{
			name: "remove-oldvalue-null-present", in: `{"op":"remove","path":"/a","oldValue":null}`,
			op: OpRemove, path: "/a", hasOld: true, oldIsNull: true,
		},
		{
			name: "replace-value-and-old", in: `{"op":"replace","path":"/a","value":2,"oldValue":1}`,
			op: OpReplace, path: "/a", hasValue: true, hasOld: true,
		},
		{
			name: "move-with-from", in: `{"op":"move","path":"/b","from":"/a"}`,
			op: OpMove, path: "/b", hasFrom: true, from: "/a",
		},
		{
			name: "from-empty-root-present", in: `{"op":"copy","path":"/b","from":""}`,
			op: OpCopy, path: "/b", hasFrom: true, from: "",
		},
		{
			name: "root-path", in: `{"op":"replace","path":"","value":{"x":1}}`,
			op: OpReplace, path: "", hasValue: true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var op Operation
			if err := json.Unmarshal([]byte(c.in), &op); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if op.Op != c.op || op.Path != c.path {
				t.Fatalf("op/path = %q/%q, want %q/%q", op.Op, op.Path, c.op, c.path)
			}
			if op.HasFrom != c.hasFrom || op.From != c.from {
				t.Fatalf("from present=%v val=%q, want %v %q", op.HasFrom, op.From, c.hasFrom, c.from)
			}
			if op.HasValue != c.hasValue {
				t.Fatalf("HasValue=%v, want %v", op.HasValue, c.hasValue)
			}
			if c.hasValue && (op.Value == nil) != c.valueIsNull {
				t.Fatalf("value null=%v, want %v", op.Value == nil, c.valueIsNull)
			}
			if op.HasOldValue != c.hasOld {
				t.Fatalf("HasOldValue=%v, want %v", op.HasOldValue, c.hasOld)
			}
			if c.hasOld && (op.OldValue == nil) != c.oldIsNull {
				t.Fatalf("oldValue null=%v, want %v", op.OldValue == nil, c.oldIsNull)
			}
		})
	}
}

func TestOperationPresenceDistinguishesAbsentFromNull(t *testing.T) {
	var absent Operation
	if err := json.Unmarshal([]byte(`{"op":"remove","path":"/a"}`), &absent); err != nil {
		t.Fatal(err)
	}
	var null Operation
	if err := json.Unmarshal([]byte(`{"op":"remove","path":"/a","oldValue":null}`), &null); err != nil {
		t.Fatal(err)
	}
	if absent.HasOldValue {
		t.Error("absent oldValue must have HasOldValue=false")
	}
	if !null.HasOldValue || null.OldValue != nil {
		t.Error("null oldValue must be present with nil value")
	}
}

func TestOperationMarshalOmitsAbsent(t *testing.T) {
	op := Operation{Op: OpRemove, Path: "/a"}
	b, err := op.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"op":"remove","path":"/a"}` {
		t.Fatalf("marshal = %s", b)
	}

	op2 := Operation{Op: OpReplace, Path: "/a", Value: "new", HasValue: true, OldValue: "old", HasOldValue: true}
	b2, err := op2.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(b2) != `{"op":"replace","path":"/a","value":"new","oldValue":"old"}` {
		t.Fatalf("marshal = %s", b2)
	}
}

func TestOperationMarshalNullValuePresent(t *testing.T) {
	// A present null value MUST serialize the "value" field.
	op := Operation{Op: OpAdd, Path: "/a", Value: nil, HasValue: true}
	b, err := op.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"op":"add","path":"/a","value":null}` {
		t.Fatalf("marshal = %s", b)
	}
}

func TestOperationRoundTripPresence(t *testing.T) {
	inputs := []string{
		`{"op":"add","path":"/a","value":null}`,
		`{"op":"remove","path":"/a"}`,
		`{"op":"remove","path":"/a","oldValue":null}`,
		`{"op":"replace","path":"/x/0","value":[1,2],"oldValue":{"k":9007199254740993}}`,
		`{"op":"move","path":"/b","from":"/a"}`,
	}
	for _, in := range inputs {
		var op Operation
		if err := json.Unmarshal([]byte(in), &op); err != nil {
			t.Fatalf("unmarshal %s: %v", in, err)
		}
		out, err := op.MarshalJSON()
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if string(out) != in {
			t.Fatalf("round-trip:\n in:  %s\n out: %s", in, out)
		}
	}
}

func TestDecodeEncodeOperations(t *testing.T) {
	in := `[{"op":"replace","path":"/a","value":2,"oldValue":1},{"op":"add","path":"/b/-","value":{"id":"x"}}]`
	ops, err := DecodeOperations([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 2 {
		t.Fatalf("len = %d", len(ops))
	}
	if ops[1].Op != OpAdd || ops[1].Path != "/b/-" || !ops[1].HasValue {
		t.Fatalf("op[1] = %+v", ops[1])
	}
	out, err := EncodeOperations(ops)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != in {
		t.Fatalf("round-trip:\n in:  %s\n out: %s", in, out)
	}
}

func TestDecodeOperationsRejectsNonArray(t *testing.T) {
	if _, err := DecodeOperations([]byte(`{"op":"add"}`)); err == nil {
		t.Fatal("expected error for non-array patch")
	}
	if _, err := DecodeOperations([]byte(`[1,2]`)); err == nil {
		t.Fatal("expected error for non-object element")
	}
}

func TestUnmarshalRejectsMissingRequired(t *testing.T) {
	for _, in := range []string{`{"path":"/a"}`, `{"op":"add"}`, `{"op":1,"path":"/a"}`, `[1]`} {
		var op Operation
		if err := json.Unmarshal([]byte(in), &op); err == nil {
			t.Fatalf("Unmarshal(%s): expected error", in)
		}
	}
}
