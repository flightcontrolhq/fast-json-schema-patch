package schemapatch

import (
	"strconv"
	"testing"
)

// TestApplyCloneSetStructuralSharing proves the per-invocation cloned-container
// set (D7) keeps apply copy-on-write: containers on a touched path are cloned
// (never the input's), untouched sibling subtrees are shared by reference with
// the input, and the input is never mutated even across multiple ops that land
// under the same subtree.
func TestApplyCloneSetStructuralSharing(t *testing.T) {
	doc := mustDecode(t, `{"a":{"x":1,"y":2},"b":{"keep":true}}`).(*Object)
	before := Clone(doc)

	ops, err := DecodeOperations([]byte(`[
		{"op":"replace","path":"/a/x","value":10},
		{"op":"replace","path":"/a/y","value":20}
	]`))
	if err != nil {
		t.Fatalf("decode patch: %v", err)
	}

	res, err := ApplyPatch(doc, ops, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	got := res.(*Object)

	// Input untouched.
	if !DeepEqual(doc, before) {
		t.Fatalf("input mutated: %s", mustEncode(t, doc))
	}
	// Result correct: both ops landed in one coherent /a.
	want := mustDecode(t, `{"a":{"x":10,"y":20},"b":{"keep":true}}`)
	if !DeepEqual(got, want) {
		t.Fatalf("result = %s, want %s", mustEncode(t, got), mustEncode(t, want))
	}

	// Untouched /b is shared by reference with the input.
	bGot, _ := got.Get("b")
	bDoc, _ := doc.Get("b")
	if bGot.(*Object) != bDoc.(*Object) {
		t.Errorf("/b was copied; untouched subtree should be shared by reference")
	}
	// Touched /a is a fresh clone, not the input's object.
	aGot, _ := got.Get("a")
	aDoc, _ := doc.Get("a")
	if aGot.(*Object) == aDoc.(*Object) {
		t.Errorf("/a was mutated in place; touched container must be cloned")
	}
}

// TestApplyCloneSetArraySharing proves the array side: ops under distinct array
// elements clone the array once, leave an untouched element shared, and never
// mutate the input array.
func TestApplyCloneSetArraySharing(t *testing.T) {
	doc := mustDecode(t, `{"arr":[{"n":0},{"keep":9},{"n":2}]}`).(*Object)
	before := Clone(doc)

	ops, _ := DecodeOperations([]byte(`[
		{"op":"replace","path":"/arr/0/n","value":100},
		{"op":"replace","path":"/arr/2/n","value":102}
	]`))

	res, err := ApplyPatch(doc, ops, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	got := res.(*Object)

	if !DeepEqual(doc, before) {
		t.Fatalf("input mutated: %s", mustEncode(t, doc))
	}
	want := mustDecode(t, `{"arr":[{"n":100},{"keep":9},{"n":102}]}`)
	if !DeepEqual(got, want) {
		t.Fatalf("result = %s, want %s", mustEncode(t, got), mustEncode(t, want))
	}

	// The untouched middle element is shared by reference.
	arrGot := mustGetArr(t, got, "arr")
	arrDoc := mustGetArr(t, doc, "arr")
	if arrGot[1].(*Object) != arrDoc[1].(*Object) {
		t.Errorf("untouched array element was copied; should be shared by reference")
	}
}

// TestApplyCloneSetManyOpsUnderOneObject is the D7 workload's correctness twin:
// 100 replaces under one object must compose correctly and leave the input
// untouched (the benchmark covers that this now clones the object once).
func TestApplyCloneSetManyOpsUnderOneObject(t *testing.T) {
	obj := NewObject()
	for i := 0; i < 200; i++ {
		obj.Set("k"+strconv.Itoa(i), NewNumber(strconv.Itoa(i)))
	}
	doc := NewObject()
	doc.Set("obj", obj)
	before := Clone(doc)

	patch := make([]Operation, 100)
	for i := 0; i < 100; i++ {
		patch[i] = Operation{Op: OpReplace, Path: "/obj/k" + strconv.Itoa(i), Value: NewNumber(strconv.Itoa(i + 1000)), HasValue: true}
	}

	res, err := ApplyPatch(doc, patch, ApplyOptions{})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}

	if !DeepEqual(doc, before) {
		t.Fatal("input mutated by many-op apply")
	}
	got := res.(*Object)
	gotObj, _ := got.Get("obj")
	for i := 0; i < 200; i++ {
		v, _ := gotObj.(*Object).Get("k" + strconv.Itoa(i))
		want := strconv.Itoa(i)
		if i < 100 {
			want = strconv.Itoa(i + 1000)
		}
		if v.(Number).String() != want {
			t.Fatalf("k%d = %v, want %s", i, v, want)
		}
	}
}

func mustGetArr(t *testing.T, o *Object, key string) []Value {
	t.Helper()
	v, ok := o.Get(key)
	if !ok {
		t.Fatalf("missing key %q", key)
	}
	a, ok := v.([]Value)
	if !ok {
		t.Fatalf("key %q is %T, not array", key, v)
	}
	return a
}
