// Package schemapatch is a Go port of the fast-json-schema-patch engine. It
// implements the normative specification "spec-v1" (see SPEC.md at the repository
// root) using only the Go standard library.
//
// # Value model
//
// Documents are represented by an ordered JSON value model rooted at [Value]
// (an alias for any). The concrete dynamic types a decoded document ever holds
// are:
//
//   - nil            for JSON null
//   - bool           for JSON true/false
//   - string         for JSON strings
//   - [Number]       for JSON numbers (preserves the original literal text)
//   - []Value        for JSON arrays (order-significant)
//   - *[Object]      for JSON objects (member order preserved, O(1) key lookup)
//
// Objects preserve member iteration order because the diff generator's output is
// order-sensitive (SPEC §2.3); equality and apply are order-insensitive over
// object members (SPEC §2.4.2). Numbers retain their source text so large
// integers round-trip byte-faithfully through a patch even though all equality
// and comparison happens at IEEE-754 f64 semantics (SPEC §2.2).
package schemapatch

import (
	"fmt"
	"strconv"
)

// Value is any node of the ordered JSON value model. Its dynamic type is one of
// nil, bool, string, [Number], []Value, or *[Object]. It is an alias for any so
// that []Value is identical to []any and decoded values interoperate freely.
type Value = any

// Number is a JSON number that preserves its original literal text. All equality
// and ordering is defined at IEEE-754 double precision (SPEC §2.2): two Numbers
// whose texts differ but whose f64 images match (e.g. "1" and "1.0", "0" and
// "-0", "10" and "1e1") are equal. The text is retained only so that echoing a
// value into a patch round-trips faithfully (SPEC §2.2.3); it never affects
// equality.
type Number struct {
	text string
}

// NewNumber returns a Number carrying the given literal text. text MUST be a
// valid JSON number per RFC 8259 (see [ValidNumberText]); an invalid literal —
// "NaN", "Infinity", "1.", ".5", "01", "+1", "" — is a programming error and
// panics, so an out-of-band non-JSON number can never enter the value model
// through this constructor and later corrupt an [Encode]. Callers holding
// untrusted text should use [ParseNumber], which reports the error instead of
// panicking; callers with already-parsed JSON should use [Decode].
func NewNumber(text string) Number {
	n, err := ParseNumber(text)
	if err != nil {
		panic(err)
	}
	return n
}

// ParseNumber returns a Number for text, or an error if text is not a valid JSON
// number per RFC 8259 (see [ValidNumberText]). It is the non-panicking form of
// [NewNumber] for untrusted input.
func ParseNumber(text string) (Number, error) {
	if !ValidNumberText(text) {
		return Number{}, fmt.Errorf("schemapatch: %q is not a valid JSON number", text)
	}
	return Number{text: text}, nil
}

// ValidNumberText reports whether s is a valid JSON number literal per the RFC
// 8259 grammar:
//
//	number = [ "-" ] int [ frac ] [ exp ]
//	int    = "0" / ( digit1-9 *DIGIT )
//	frac   = "." 1*DIGIT
//	exp    = ("e" / "E") [ "+" / "-" ] 1*DIGIT
//
// It rejects everything JSON forbids that Go's own float parsing would wave
// through — the non-finite words NaN/Inf/Infinity, a leading "+", leading zeros,
// a bare-point "1." or ".5", hex floats, and underscore separators — so it is
// the single grammar gate shared by [ParseNumber], [FromAny], and [Encode]. It
// matches the numbers [Decode] accepts, so decoded Numbers always pass.
func ValidNumberText(s string) bool {
	i, n := 0, len(s)
	if n == 0 {
		return false
	}
	if s[i] == '-' {
		i++
	}
	// int: single "0", or a nonzero digit followed by more digits.
	if i >= n {
		return false
	}
	if s[i] == '0' {
		i++
	} else if s[i] >= '1' && s[i] <= '9' {
		i++
		for i < n && s[i] >= '0' && s[i] <= '9' {
			i++
		}
	} else {
		return false
	}
	// frac: "." then at least one digit.
	if i < n && s[i] == '.' {
		i++
		start := i
		for i < n && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if i == start {
			return false
		}
	}
	// exp: e/E, optional sign, then at least one digit.
	if i < n && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < n && (s[i] == '+' || s[i] == '-') {
			i++
		}
		start := i
		for i < n && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		if i == start {
			return false
		}
	}
	return i == n
}

// String returns the original literal text of the number.
func (n Number) String() string { return n.text }

// Float64 parses the number's text as an IEEE-754 double. The error is non-nil
// only for texts that are not valid JSON numbers (which [Decode] never produces).
func (n Number) Float64() (float64, error) { return strconv.ParseFloat(n.text, 64) }

// Object is a JSON object that preserves member insertion order while offering
// O(1) key lookup. The zero value is not usable; construct one with [NewObject].
type Object struct {
	keys  []string
	vals  []Value
	index map[string]int
}

// NewObject returns an empty, ready-to-use Object.
func NewObject() *Object {
	return &Object{index: make(map[string]int)}
}

// Len returns the number of members.
func (o *Object) Len() int { return len(o.keys) }

// Keys returns a copy of the member keys in iteration order. The copy is
// defensive: the caller may retain or mutate it freely without disturbing the
// object (an object handed out by a [Plan] or held inside a document must not be
// mutable through a returned slice). The copy costs one allocation of len(o)
// strings per call; hot-path or allocation-sensitive callers that only need to
// iterate should use [Object.Members], which yields each member with no
// allocation.
func (o *Object) Keys() []string {
	if len(o.keys) == 0 {
		return nil
	}
	return append([]string(nil), o.keys...)
}

// Members iterates the object's members in insertion order, invoking yield for
// each (key, value) pair; iteration stops early if yield returns false. It
// allocates nothing and never exposes the object's internal storage, so it is
// the allocation-free counterpart to [Object.Keys] for read-only traversal. The
// signature matches Go 1.23's range-over-func iterator shape, so `for k, v :=
// range obj.Members` works under a 1.23+ toolchain while remaining a plain
// callback under the 1.22 target. The callback MUST NOT mutate the object.
func (o *Object) Members(yield func(key string, value Value) bool) {
	for i := range o.keys {
		if !yield(o.keys[i], o.vals[i]) {
			return
		}
	}
}

// Get returns the value for key and whether the key is present. A present member
// whose value is nil (JSON null) returns (nil, true); an absent member returns
// (nil, false).
func (o *Object) Get(key string) (Value, bool) {
	i, ok := o.index[key]
	if !ok {
		return nil, false
	}
	return o.vals[i], true
}

// At returns the key and value at member position i (0 <= i < Len). It panics if
// i is out of range.
func (o *Object) At(i int) (string, Value) {
	return o.keys[i], o.vals[i]
}

// Set assigns v to key. If key already exists its value is overwritten in place,
// preserving the member's position (matching JSON.parse's last-value-wins,
// first-position semantics). Otherwise the member is appended at the end.
func (o *Object) Set(key string, v Value) {
	if o.index == nil {
		o.index = make(map[string]int)
	}
	if i, ok := o.index[key]; ok {
		o.vals[i] = v
		return
	}
	o.index[key] = len(o.keys)
	o.keys = append(o.keys, key)
	o.vals = append(o.vals, v)
}

// Delete removes key, reporting whether it was present. Remaining members keep
// their relative order.
func (o *Object) Delete(key string) bool {
	i, ok := o.index[key]
	if !ok {
		return false
	}
	o.keys = append(o.keys[:i], o.keys[i+1:]...)
	o.vals = append(o.vals[:i], o.vals[i+1:]...)
	delete(o.index, key)
	for j := i; j < len(o.keys); j++ {
		o.index[o.keys[j]] = j
	}
	return true
}
