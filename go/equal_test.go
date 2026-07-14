package schemapatch

import "testing"

func mustDecode(t *testing.T, s string) Value {
	t.Helper()
	v, err := Decode([]byte(s))
	if err != nil {
		t.Fatalf("Decode(%q): %v", s, err)
	}
	return v
}

func TestDeepEqual(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want bool
	}{
		// number f64 semantics (CORE §1.2)
		{"int-vs-float-equal", `1`, `1.0`, true},
		{"zero-vs-neg-zero", `0`, `-0`, true},
		{"exp-vs-decimal", `1e1`, `10`, true},
		{"big-int-collapse", `9007199254740993`, `9007199254740992`, true},
		{"distinct-numbers", `1`, `2`, false},
		// no coercion (CORE §1.4.3)
		{"num-vs-string", `1`, `"1"`, false},
		{"null-vs-false", `null`, `false`, false},
		{"null-vs-zero", `null`, `0`, false},
		{"true-vs-string", `true`, `"true"`, false},
		// scalars
		{"null-null", `null`, `null`, true},
		{"string-eq", `"abc"`, `"abc"`, true},
		{"string-ne", `"abc"`, `"abd"`, false},
		// arrays are order-sensitive (CORE §1.4.2)
		{"array-eq", `[1,2,3]`, `[1,2,3]`, true},
		{"array-order-ne", `[1,2]`, `[2,1]`, false},
		{"array-len-ne", `[1,2]`, `[1,2,3]`, false},
		// objects are member-order-insensitive (CORE §1.4.2)
		{"object-reordered-eq", `{"a":1,"b":2}`, `{"b":2,"a":1}`, true},
		{"object-value-ne", `{"a":1}`, `{"a":2}`, false},
		{"object-keyset-ne", `{"a":1}`, `{"b":1}`, false},
		{"object-len-ne", `{"a":1}`, `{"a":1,"b":2}`, false},
		// nesting + number-in-container equality
		{"nested-eq", `{"x":[1,{"y":1.0}]}`, `{"x":[1,{"y":1}]}`, true},
		{"nested-ne", `{"x":[1,{"y":1}]}`, `{"x":[1,{"y":2}]}`, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := mustDecode(t, c.a)
			b := mustDecode(t, c.b)
			if got := DeepEqual(a, b); got != c.want {
				t.Fatalf("DeepEqual(%s, %s) = %v, want %v", c.a, c.b, got, c.want)
			}
			// symmetric
			if got := DeepEqual(b, a); got != c.want {
				t.Fatalf("DeepEqual(%s, %s) [swapped] = %v, want %v", c.b, c.a, got, c.want)
			}
		})
	}
}
