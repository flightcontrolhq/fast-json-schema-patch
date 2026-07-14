package schemapatch

import (
	"errors"
	"testing"
)

// applyJSON is a test convenience: decode doc + patch from JSON strings, apply,
// and return the encoded result.
func applyJSON(t *testing.T, doc, patch string, opts ApplyOptions) (string, error) {
	t.Helper()
	d := mustDecode(t, doc)
	ops, err := DecodeOperations([]byte(patch))
	if err != nil {
		t.Fatalf("decode patch: %v", err)
	}
	got, err := ApplyPatch(d, ops, opts)
	if err != nil {
		return "", err
	}
	return mustEncode(t, got), nil
}

func TestApplyEmptyPatchReturnsSameReference(t *testing.T) {
	doc := mustDecode(t, `{"a":1}`)
	got, err := ApplyPatch(doc, nil, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	// §8.7.5: empty patch in immutable mode returns the same reference.
	gm, dm := got.(*Object), doc.(*Object)
	if gm != dm {
		t.Errorf("empty patch did not return the same document reference")
	}
}

func TestApplyDoesNotMutateInputAcrossOps(t *testing.T) {
	doc := mustDecode(t, `{"a":{"x":1},"b":[1,2,3]}`)
	before := Clone(doc)
	patch := `[
		{"op":"replace","path":"/a/x","value":2},
		{"op":"add","path":"/b/-","value":4},
		{"op":"remove","path":"/b/0"}
	]`
	ops, _ := DecodeOperations([]byte(patch))
	got, err := ApplyPatch(doc, ops, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if !DeepEqual(doc, before) {
		t.Errorf("input mutated:\n got %s\nwant %s", mustEncode(t, doc), mustEncode(t, before))
	}
	want := mustDecode(t, `{"a":{"x":2},"b":[2,3,4]}`)
	if !DeepEqual(got, want) {
		t.Errorf("result = %s, want %s", mustEncode(t, got), mustEncode(t, want))
	}
}

func TestApplyAtomicOnFailureLeavesInputUntouched(t *testing.T) {
	doc := mustDecode(t, `{"a":1}`)
	before := Clone(doc)
	// op0 succeeds structurally (on a clone), op1 fails: input must be intact.
	patch := `[
		{"op":"add","path":"/b","value":2},
		{"op":"test","path":"/a","value":999}
	]`
	ops, _ := DecodeOperations([]byte(patch))
	_, err := ApplyPatch(doc, ops, ApplyOptions{})
	if !errors.Is(err, ErrTestFailed) {
		t.Fatalf("err = %v, want TEST_FAILED", err)
	}
	var pe *PatchError
	if errors.As(err, &pe) && pe.OpIndex != 1 {
		t.Errorf("OpIndex = %d, want 1", pe.OpIndex)
	}
	if !DeepEqual(doc, before) {
		t.Errorf("input mutated after atomic abort: %s", mustEncode(t, doc))
	}
}

func TestApplyCloneValuesBreaksAlias(t *testing.T) {
	doc := mustDecode(t, `{}`)
	ops, _ := DecodeOperations([]byte(`[{"op":"add","path":"/a","value":{"n":1}}]`))
	// Without cloneValues the inserted value aliases the patch op's value.
	got, err := ApplyPatch(doc, ops, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	inserted, _ := got.(*Object).Get("a")
	if inserted != ops[0].Value {
		t.Errorf("default apply should insert value by reference")
	}
	// With cloneValues the result is deep-equal but not aliased.
	got2, _ := ApplyPatch(doc, ops, ApplyOptions{CloneValues: true})
	inserted2, _ := got2.(*Object).Get("a")
	if inserted2 == ops[0].Value {
		t.Errorf("cloneValues should not alias the patch op's value")
	}
	if !DeepEqual(inserted2, ops[0].Value) {
		t.Errorf("cloneValues result not deep-equal to source")
	}
}

func TestApplyErrorSentinels(t *testing.T) {
	cases := []struct {
		name, doc, patch string
		sentinel         error
	}{
		{"unsafe", `{"a":1}`, `[{"op":"add","path":"/__proto__","value":1}]`, ErrUnsafeKey},
		{"bad-pointer", `[1]`, `[{"op":"remove","path":"/-"}]`, ErrInvalidPointer},
		{"oob", `[1]`, `[{"op":"add","path":"/5","value":1}]`, ErrIndexOutOfBounds},
		{"unresolvable", `{"a":1}`, `[{"op":"replace","path":"/b","value":1}]`, ErrPathUnresolvable},
		{"invalid-op", `{"a":1}`, `[{"op":"remove","path":""}]`, ErrInvalidOperation},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := applyJSON(t, tc.doc, tc.patch, ApplyOptions{})
			if !errors.Is(err, tc.sentinel) {
				t.Errorf("err = %v, want %v", err, tc.sentinel)
			}
		})
	}
}
