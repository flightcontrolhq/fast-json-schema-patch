package schemapatch

import (
	"encoding/json"
	"testing"
)

func TestDecodeEncodeRoundTrip(t *testing.T) {
	// Each input is already in the compact form Encode produces, so decode then
	// encode MUST reproduce the exact bytes (member order + number text fidelity).
	cases := []struct {
		name string
		in   string
	}{
		{"null", `null`},
		{"true", `true`},
		{"false", `false`},
		{"empty-string", `""`},
		{"string", `"hello"`},
		{"string-escapes", `"a\"b\\c\n\t\r\b\f"`},
		{"string-control", "\"\\u0000\\u001f\""},
		{"unicode-kept-raw", `"café ☃ 𝄞"`},
		{"int", `1`},
		{"float", `1.5`},
		{"neg", `-42`},
		{"exp", `6.022e23`},
		{"neg-zero", `-0`},
		{"big-int", `9007199254740993`},
		{"empty-array", `[]`},
		{"empty-object", `{}`},
		{"array", `[1,2,3]`},
		{"nested", `{"a":[1,{"b":null}],"c":true}`},
		{"member-order-preserved", `{"z":1,"a":2,"m":3}`},
		{"integer-like-keys-insertion-order", `{"10":1,"2":2,"b":3,"0":4}`},
		{"empty-key", `{"":1}`},
		{"slash-tilde-key", `{"a/b~c":1}`},
		{"deep", `{"x":{"y":{"z":[[],[1],[1,2]]}}}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v, err := Decode([]byte(c.in))
			if err != nil {
				t.Fatalf("Decode(%q) error: %v", c.in, err)
			}
			out, err := Encode(v)
			if err != nil {
				t.Fatalf("Encode error: %v", err)
			}
			if string(out) != c.in {
				t.Fatalf("round-trip mismatch:\n in:  %s\n out: %s", c.in, out)
			}
		})
	}
}

func TestDecodeNumberTextPreserved(t *testing.T) {
	v, err := Decode([]byte(`{"a":9007199254740993,"b":1.0,"c":1e1}`))
	if err != nil {
		t.Fatal(err)
	}
	obj := v.(*Object)
	for _, tc := range []struct{ key, text string }{
		{"a", "9007199254740993"},
		{"b", "1.0"},
		{"c", "1e1"},
	} {
		got, _ := obj.Get(tc.key)
		n, ok := got.(Number)
		if !ok {
			t.Fatalf("key %s: expected Number, got %T", tc.key, got)
		}
		if n.String() != tc.text {
			t.Fatalf("key %s: text = %q, want %q", tc.key, n.String(), tc.text)
		}
	}
}

func TestDecodeWhitespaceNormalized(t *testing.T) {
	// Input with whitespace decodes to the same value; Encode is compact.
	v, err := Decode([]byte("  {\n  \"a\" : [ 1 , 2 ]\n}  "))
	if err != nil {
		t.Fatal(err)
	}
	out, err := Encode(v)
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != `{"a":[1,2]}` {
		t.Fatalf("got %s", out)
	}
}

func TestDecodeRejectsTrailingData(t *testing.T) {
	for _, in := range []string{`1 2`, `{} {}`, `[1] x`, `null null`} {
		if _, err := Decode([]byte(in)); err == nil {
			t.Fatalf("Decode(%q): expected trailing-data error, got nil", in)
		}
	}
}

func TestDecodeRejectsInvalid(t *testing.T) {
	for _, in := range []string{``, `{`, `[1,]`, `{"a"}`, `tru`, `01`} {
		if _, err := Decode([]byte(in)); err == nil {
			t.Fatalf("Decode(%q): expected error, got nil", in)
		}
	}
}

func TestDuplicateKeyLastWinsFirstPosition(t *testing.T) {
	v, err := Decode([]byte(`{"a":1,"b":2,"a":3}`))
	if err != nil {
		t.Fatal(err)
	}
	obj := v.(*Object)
	if obj.Len() != 2 {
		t.Fatalf("Len = %d, want 2", obj.Len())
	}
	if k, _ := obj.At(0); k != "a" {
		t.Fatalf("first key = %q, want a", k)
	}
	got, _ := obj.Get("a")
	if n := got.(Number); n.String() != "3" {
		t.Fatalf("a = %s, want 3 (last value wins)", n.String())
	}
}

func TestFromAnyToAny(t *testing.T) {
	in := map[string]any{
		"n":   float64(2),
		"s":   "x",
		"b":   true,
		"nil": nil,
		"arr": []any{float64(1), "y"},
		"jn":  json.Number("42"),
	}
	v, err := FromAny(in)
	if err != nil {
		t.Fatal(err)
	}
	obj := v.(*Object)
	// FromAny sorts map keys for determinism.
	wantOrder := []string{"arr", "b", "jn", "n", "nil", "s"}
	for i, k := range wantOrder {
		if gk, _ := obj.At(i); gk != k {
			t.Fatalf("key[%d] = %q, want %q", i, gk, k)
		}
	}
	if nv, _ := obj.Get("jn"); nv.(Number).String() != "42" {
		t.Fatalf("json.Number not preserved: %v", nv)
	}
	// ToAny round-trips numbers as json.Number.
	back := ToAny(v).(map[string]any)
	if back["jn"].(json.Number).String() != "42" {
		t.Fatalf("ToAny jn = %v", back["jn"])
	}
}

func TestFromAnyRejectsUnsupported(t *testing.T) {
	if _, err := FromAny(struct{ X int }{1}); err == nil {
		t.Fatal("expected error for unsupported type")
	}
}
