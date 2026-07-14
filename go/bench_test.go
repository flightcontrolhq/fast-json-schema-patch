package schemapatch

import (
	"strconv"
	"testing"
)

// Benchmarks guarding the two performance-sensitive engines. They use only the
// public API (ApplyPatch, NewPatcher/Execute, BuildPlan), so the same file
// measures a pre-change tree unchanged — run `go test -bench .` (see
// CONTRIBUTING) to compare before/after a perf-relevant edit.

// BenchmarkApply100OpsUnderOneObject applies 100 replace ops all under one large
// object (D7). With the per-invocation cloned-container set that object is
// cloned once; without it, once per op (quadratic clone traffic).
func BenchmarkApply100OpsUnderOneObject(b *testing.B) {
	obj := NewObject()
	for i := 0; i < 200; i++ {
		obj.Set("k"+strconv.Itoa(i), NewNumber(strconv.Itoa(i)))
	}
	doc := NewObject()
	doc.Set("obj", obj)

	patch := make([]Operation, 100)
	for i := 0; i < 100; i++ {
		patch[i] = Operation{
			Op:       OpReplace,
			Path:     "/obj/k" + strconv.Itoa(i),
			Value:    NewNumber(strconv.Itoa(i + 1000)),
			HasValue: true,
		}
	}

	b.ReportAllocs()
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		if _, err := ApplyPatch(doc, patch, ApplyOptions{}); err != nil {
			b.Fatal(err)
		}
	}
}

// seqDoc builds {"seq":[ "s0000000" .. ]} of length n, applying an optional edit
// to the array before wrapping. Mirrors the shared corpus's LCS_SCHEMA shape.
func seqDoc(n int, edit func([]Value)) Value {
	arr := make([]Value, n)
	for i := range arr {
		arr[i] = "s" + pad(i, 7)
	}
	if edit != nil {
		edit(arr)
	}
	o := NewObject()
	o.Set("seq", arr)
	return o
}

func pad(i, width int) string {
	s := strconv.Itoa(i)
	for len(s) < width {
		s = "0" + s
	}
	return s
}

func benchDiff(b *testing.B, plan Plan, a, bb Value) {
	b.Helper()
	p, _ := NewPatcher(plan)
	b.ReportAllocs()
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		_ = p.Execute(a, bb)
	}
}

// BenchmarkDiffLCSSingleEdit: 10k-element sequence, one mid-array element
// changed — exercises the common prefix/suffix trim then a single Myers edit
// (audit shape "trimmed single edit").
func BenchmarkDiffLCSSingleEdit(b *testing.B) {
	a := seqDoc(10_000, nil)
	bb := seqDoc(10_000, func(arr []Value) { arr[5_000] = "s-EDITED" })
	benchDiff(b, Plan{}, a, bb)
}

// BenchmarkDiffLCSDisjoint4k: two 4,000-element sequences with zero common
// elements — the worst-case LCS diagonal (audit shape "disjoint 4k").
func BenchmarkDiffLCSDisjoint4k(b *testing.B) {
	build := func(prefix string) Value {
		arr := make([]Value, 4_000)
		for i := range arr {
			arr[i] = prefix + pad(i, 6)
		}
		o := NewObject()
		o.Set("seq", arr)
		return o
	}
	benchDiff(b, Plan{}, build("a"), build("b"))
}

// keyedItemsDoc builds {"items":[ {id,name,qty,tag} .. ]} of length n; when
// modEveryThird, one field changes on every third item (audit shape "keyed
// modify"). Matches the corpus keyedItem shape.
func keyedItemsDoc(n int, modEveryThird bool) Value {
	arr := make([]Value, n)
	for i := 0; i < n; i++ {
		it := NewObject()
		it.Set("id", "k"+strconv.Itoa(i))
		name := "item-" + strconv.Itoa(i)
		if modEveryThird && i%3 == 0 {
			name += "-CHANGED"
		}
		it.Set("name", name)
		it.Set("qty", NewNumber(strconv.Itoa(i)))
		if i%2 == 0 {
			it.Set("tag", "even")
		} else {
			it.Set("tag", "odd")
		}
		arr[i] = it
	}
	o := NewObject()
	o.Set("items", arr)
	return o
}

// BenchmarkDiffKeyedModify: 60 keyed items, one field changed on every third,
// order preserved — exercises the primaryKey strategy (audit shape "keyed
// modify").
func BenchmarkDiffKeyedModify(b *testing.B) {
	schema, err := Decode([]byte(`{
		"properties": {"items": {"type": "array", "items": {
			"type": "object",
			"properties": {"id": {"type": "string"}, "name": {"type": "string"}, "qty": {"type": "number"}, "tag": {"type": "string"}},
			"required": ["id"]
		}}}
	}`))
	if err != nil {
		b.Fatal(err)
	}
	plan, err := BuildPlan(schema, BuildPlanOptions{})
	if err != nil {
		b.Fatal(err)
	}
	benchDiff(b, plan, keyedItemsDoc(60, false), keyedItemsDoc(60, true))
}
