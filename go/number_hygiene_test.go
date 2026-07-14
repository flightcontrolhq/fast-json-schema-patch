package schemapatch

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// TestValidNumberText pins the RFC 8259 grammar gate (D6): every accept/reject
// the JSON number grammar mandates, including the non-JSON forms Go's own float
// parsing would otherwise wave through.
func TestValidNumberText(t *testing.T) {
	valid := []string{
		"0", "-0", "1", "-1", "42", "1234567890",
		"0.5", "-0.5", "1.25", "3.0",
		"1e10", "1E10", "1e+10", "1e-10", "-2.5e-3",
		"0e0", "9007199254740993", // large int kept as text
	}
	for _, s := range valid {
		if !ValidNumberText(s) {
			t.Errorf("ValidNumberText(%q) = false, want true", s)
		}
	}
	invalid := []string{
		"", " ", "1 ", " 1", "+1", "01", "00", "-01",
		"1.", ".5", "-.5", "1..2", "1.2.3",
		"1e", "1e+", "1e-", "e10", "1ee2",
		"NaN", "Inf", "+Inf", "-Inf", "Infinity",
		"0x1p2", "1_000", "abc", "-", ".", "1,2",
	}
	for _, s := range invalid {
		if ValidNumberText(s) {
			t.Errorf("ValidNumberText(%q) = true, want false", s)
		}
	}
}

// TestParseNumberAndNewNumber covers the two hand-construction ingress points.
func TestParseNumberAndNewNumber(t *testing.T) {
	if n, err := ParseNumber("1e3"); err != nil || n.String() != "1e3" {
		t.Fatalf("ParseNumber(1e3) = %v, %v; want 1e3, nil", n, err)
	}
	if _, err := ParseNumber("NaN"); err == nil {
		t.Fatal("ParseNumber(NaN) = nil error, want error")
	}
	if _, err := ParseNumber(""); err == nil {
		t.Fatal("ParseNumber(\"\") = nil error, want error")
	}

	// NewNumber accepts valid text.
	if got := NewNumber("-2.5e-3").String(); got != "-2.5e-3" {
		t.Fatalf("NewNumber text = %q", got)
	}
	// NewNumber panics on an invalid literal.
	func() {
		defer func() {
			if recover() == nil {
				t.Error("NewNumber(\"NaN\") did not panic")
			}
		}()
		_ = NewNumber("NaN")
	}()
}

// TestFromAnyRejectsNonFiniteFloats covers the float ingress points (D6).
func TestFromAnyRejectsNonFiniteFloats(t *testing.T) {
	bad := []any{
		math.NaN(),
		math.Inf(1),
		math.Inf(-1),
		float32(math.Inf(1)),
		float32(math.NaN()),
	}
	for _, v := range bad {
		if _, err := FromAny(v); err == nil {
			t.Errorf("FromAny(%v) = nil error, want rejection", v)
		}
	}

	// Finite floats still convert, and a float32 keeps 32-bit shortest text
	// rather than gaining spurious f64 digits.
	v, err := FromAny(float32(0.1))
	if err != nil {
		t.Fatalf("FromAny(float32 0.1): %v", err)
	}
	if got := v.(Number).String(); got != "0.1" {
		t.Errorf("FromAny(float32 0.1) = %q, want 0.1", got)
	}
}

// TestFromAnyRejectsMalformedJSONNumber covers the json.Number ingress (D6): a
// hand-built json.Number carrying non-JSON text is rejected rather than trusted.
func TestFromAnyRejectsMalformedJSONNumber(t *testing.T) {
	if _, err := FromAny(json.Number("NaN")); err == nil {
		t.Error("FromAny(json.Number(NaN)) = nil error, want rejection")
	}
	if _, err := FromAny(json.Number("1e")); err == nil {
		t.Error("FromAny(json.Number(1e)) = nil error, want rejection")
	}
	if v, err := FromAny(json.Number("42")); err != nil || v.(Number).String() != "42" {
		t.Errorf("FromAny(json.Number(42)) = %v, %v; want 42, nil", v, err)
	}
}

// TestEncodeRejectsInvalidNumber is the backstop: even if a malformed Number
// reached the value model, Encode refuses to emit invalid JSON (D6).
func TestEncodeRejectsInvalidNumber(t *testing.T) {
	// text is unexported, so no external caller can build this — the struct
	// literal here (same package) stands in for any future internal ingress that
	// forgets to validate.
	bad := []Number{{text: "NaN"}, {text: ""}, {text: "1."}, {text: "+5"}}
	for _, n := range bad {
		if _, err := Encode(n); err == nil {
			t.Errorf("Encode(%q) = nil error, want rejection", n.text)
		}
	}
	// A valid Number still encodes to its exact literal text.
	out, err := Encode(NewNumber("9007199254740993"))
	if err != nil || string(out) != "9007199254740993" {
		t.Fatalf("Encode(valid) = %q, %v", out, err)
	}
	// And inside a container the error propagates rather than being swallowed.
	arr := []Value{Number{text: "Infinity"}}
	if _, err := Encode(arr); err == nil || !strings.Contains(err.Error(), "invalid JSON number") {
		t.Fatalf("Encode([Infinity]) err = %v, want invalid-number error", err)
	}
}
