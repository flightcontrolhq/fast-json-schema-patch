package schemapatch

import "testing"

func TestCloneDeepEqualButIndependent(t *testing.T) {
	orig := mustDecode(t, `{"a":[1,{"b":2}],"c":"s","d":null}`).(*Object)
	clone := Clone(orig).(*Object)

	if !DeepEqual(orig, clone) {
		t.Fatal("clone not deep-equal to original")
	}
	if orig == clone {
		t.Fatal("clone shares the object pointer")
	}

	// Mutating the clone must not affect the original.
	inner := func(o *Object) []Value {
		v, _ := o.Get("a")
		return v.([]Value)
	}
	cloneArr := inner(clone)
	cloneArr[0] = NewNumber("99")
	nested := cloneArr[1].(*Object)
	nested.Set("b", NewNumber("100"))
	clone.Set("c", "changed")

	origArr := inner(orig)
	if n := origArr[0].(Number); n.String() != "1" {
		t.Fatalf("original array element mutated: %s", n.String())
	}
	origNested := origArr[1].(*Object)
	if v, _ := origNested.Get("b"); v.(Number).String() != "2" {
		t.Fatal("original nested object mutated")
	}
	if v, _ := orig.Get("c"); v.(string) != "s" {
		t.Fatal("original scalar member mutated")
	}
}

func TestCloneEmptyArrayNonNil(t *testing.T) {
	c := Clone([]Value{})
	arr, ok := c.([]Value)
	if !ok {
		t.Fatalf("clone of []Value is %T", c)
	}
	if arr == nil {
		t.Fatal("clone of empty array is nil")
	}
}

func TestCloneScalars(t *testing.T) {
	for _, s := range []string{`null`, `true`, `"x"`, `42`} {
		v := mustDecode(t, s)
		if !DeepEqual(v, Clone(v)) {
			t.Fatalf("scalar clone mismatch for %s", s)
		}
	}
}
