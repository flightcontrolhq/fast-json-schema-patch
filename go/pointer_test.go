package schemapatch

import (
	"errors"
	"reflect"
	"testing"
)

func TestEscapeUnescapeToken(t *testing.T) {
	cases := []struct {
		raw, escaped string
	}{
		{"", ""},
		{"a", "a"},
		{"a/b", "a~1b"},
		{"a~b", "a~0b"},
		{"~", "~0"},
		{"/", "~1"},
		{"~/", "~0~1"},
		{"/~", "~1~0"},
		// CORE §2.2/CORE §2.3 ordering: "~1" as a literal key must survive a
		// round-trip. Encode: ~ -> ~0 first, giving "~01"; then / pass is a
		// no-op -> "~01". Decode: ~1 -> "/" first would corrupt a naive impl,
		// but "~01" has no "~1" substring adjacent, decoding ~0 -> ~ gives "~1".
		{"~1", "~01"},
		{"-", "-"},
		{"10", "10"},
	}
	for _, c := range cases {
		if got := EscapeToken(c.raw); got != c.escaped {
			t.Errorf("EscapeToken(%q) = %q, want %q", c.raw, got, c.escaped)
		}
		if got := UnescapeToken(c.escaped); got != c.raw {
			t.Errorf("UnescapeToken(%q) = %q, want %q", c.escaped, got, c.raw)
		}
	}
}

func TestUnescapeOrder(t *testing.T) {
	// "~1" must be replaced before "~0" (CORE §2.3). "~01" -> "~1": the ~1 pass
	// finds no "~1" (the string is ~,0,1), then ~0 -> ~ yields "~1".
	if got := UnescapeToken("~01"); got != "~1" {
		t.Fatalf("UnescapeToken(~01) = %q, want ~1", got)
	}
	// "~1" decodes to "/" (the slash), not to "~" then "1".
	if got := UnescapeToken("~1"); got != "/" {
		t.Fatalf("UnescapeToken(~1) = %q, want /", got)
	}
}

func TestSplitPath(t *testing.T) {
	cases := []struct {
		path string
		want []string
	}{
		{"", nil},
		{"/", []string{""}},
		{"/a/b", []string{"a", "b"}},
		{"/a~1b/c~0d", []string{"a/b", "c~d"}},
		{"/foo/0/-", []string{"foo", "0", "-"}},
		{"//x", []string{"", "x"}},
	}
	for _, c := range cases {
		got, err := SplitPath(c.path)
		if err != nil {
			t.Fatalf("SplitPath(%q) error: %v", c.path, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("SplitPath(%q) = %#v, want %#v", c.path, got, c.want)
		}
	}
}

func TestSplitPathMalformed(t *testing.T) {
	for _, p := range []string{"a", "a/b", "foo"} {
		_, err := SplitPath(p)
		if !errors.Is(err, ErrMalformedPointer) {
			t.Errorf("SplitPath(%q) err = %v, want ErrMalformedPointer", p, err)
		}
	}
}

func TestJoinPathRoundTrip(t *testing.T) {
	cases := []struct {
		tokens []string
		want   string
	}{
		{nil, ""},
		{[]string{}, ""},
		{[]string{""}, "/"},
		{[]string{"a", "b"}, "/a/b"},
		{[]string{"a/b", "c~d"}, "/a~1b/c~0d"},
		{[]string{"foo", "-"}, "/foo/-"},
	}
	for _, c := range cases {
		if got := JoinPath(c.tokens); got != c.want {
			t.Errorf("JoinPath(%#v) = %q, want %q", c.tokens, got, c.want)
		}
		// Split(Join(x)) == x (modulo nil/empty).
		if c.want != "" {
			back, err := SplitPath(c.want)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(back, c.tokens) && !(len(back) == 0 && len(c.tokens) == 0) {
				t.Errorf("Split(Join(%#v)) = %#v", c.tokens, back)
			}
		}
	}
}

func TestIsAppendToken(t *testing.T) {
	if !IsAppendToken("-") {
		t.Error("- should be the append token")
	}
	for _, tok := range []string{"", "0", "--", "a", "-0"} {
		if IsAppendToken(tok) {
			t.Errorf("%q should not be the append token", tok)
		}
	}
}

func TestValidArrayIndexSyntax(t *testing.T) {
	valid := []string{"0", "1", "10", "12345", "4294967295"}
	invalid := []string{"", "-", "-0", "-1", "+1", "01", "00", "1.5", "1e1", " 2", "2 ", "0x1", "abc"}
	for _, tok := range valid {
		if !ValidArrayIndexSyntax(tok) {
			t.Errorf("ValidArrayIndexSyntax(%q) = false, want true", tok)
		}
	}
	for _, tok := range invalid {
		if ValidArrayIndexSyntax(tok) {
			t.Errorf("ValidArrayIndexSyntax(%q) = true, want false", tok)
		}
	}
}

func TestParseArrayIndex(t *testing.T) {
	cases := []struct {
		tok string
		n   int
		ok  bool
	}{
		{"0", 0, true},
		{"7", 7, true},
		{"42", 42, true},
		{"-", 0, false},
		{"01", 0, false},
		{"-1", 0, false},
		{"1.5", 0, false},
		{"", 0, false},
		// Syntactically all-digits but overflows int -> ok=false (no real array
		// can hold it), while the syntax check alone still reports valid.
		{"99999999999999999999999999", 0, false},
	}
	for _, c := range cases {
		n, ok := ParseArrayIndex(c.tok)
		if ok != c.ok || (ok && n != c.n) {
			t.Errorf("ParseArrayIndex(%q) = (%d,%v), want (%d,%v)", c.tok, n, ok, c.n, c.ok)
		}
	}
	// The overflow case is valid syntax but unparseable to int.
	if !ValidArrayIndexSyntax("99999999999999999999999999") {
		t.Error("all-digit overflow should pass the pure syntax check")
	}
}
