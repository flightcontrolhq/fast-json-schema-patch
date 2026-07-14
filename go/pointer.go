package schemapatch

import (
	"errors"
	"strconv"
	"strings"
)

// ErrMalformedPointer is returned by SplitPath for a non-empty pointer that does
// not begin with "/". Apply-side callers translate it into a PatchError with
// code INVALID_POINTER (SPEC §8.6); it is exposed as an errors.Is-able sentinel
// so the pointer layer stays free of the apply error model.
var ErrMalformedPointer = errors.New("schemapatch: malformed JSON Pointer")

// AppendToken is the RFC 6901 §4 token denoting the position one past the last
// array element. It is valid only as the final segment of an add (and, by
// delegation, a move/copy destination); apply rejects it elsewhere (SPEC §3.5).
const AppendToken = "-"

// EscapeToken escapes a single reference token for embedding in a JSON Pointer
// (SPEC §3.2): replace "~" with "~0", THEN "/" with "~1", in that order. The
// append token and array indices contain neither character and pass through
// unchanged.
func EscapeToken(tok string) string {
	if !strings.ContainsAny(tok, "~/") {
		return tok
	}
	tok = strings.ReplaceAll(tok, "~", "~0")
	tok = strings.ReplaceAll(tok, "/", "~1")
	return tok
}

// UnescapeToken reverses EscapeToken (SPEC §3.3): replace "~1" with "/", THEN
// "~0" with "~", in that order. The order matters: a literal "~01" decodes to
// "~1" (the ~1 pass runs first and leaves the trailing 1, then ~0 -> ~).
func UnescapeToken(tok string) string {
	if !strings.Contains(tok, "~") {
		return tok
	}
	tok = strings.ReplaceAll(tok, "~1", "/")
	tok = strings.ReplaceAll(tok, "~0", "~")
	return tok
}

// SplitPath splits a JSON Pointer into its unescaped reference tokens (SPEC §3.4).
// The empty pointer "" yields an empty (nil) slice. "/a/b" yields ["a","b"].
// "/" (a single slash) yields [""] — the member named "". A non-empty pointer
// that does not begin with "/" is malformed and returns ErrMalformedPointer.
func SplitPath(path string) ([]string, error) {
	if path == "" {
		return nil, nil
	}
	if path[0] != '/' {
		return nil, ErrMalformedPointer
	}
	raw := strings.Split(path[1:], "/")
	out := make([]string, len(raw))
	for i, seg := range raw {
		out[i] = UnescapeToken(seg)
	}
	return out, nil
}

// JoinPath builds a JSON Pointer from unescaped reference tokens, escaping each
// (SPEC §3.4). An empty token list yields "" (the root pointer); a single empty
// token yields "/".
func JoinPath(tokens []string) string {
	if len(tokens) == 0 {
		return ""
	}
	var b strings.Builder
	for _, tok := range tokens {
		b.WriteByte('/')
		b.WriteString(EscapeToken(tok))
	}
	return b.String()
}

// IsAppendToken reports whether tok is the "-" append token (SPEC §3.5).
func IsAppendToken(tok string) bool { return tok == AppendToken }

// ValidArrayIndexSyntax reports whether tok is a syntactically valid array-index
// segment per SPEC §3.6: it MUST match ^(0|[1-9][0-9]*)$ — a single "0" or a
// nonzero leading digit followed by more digits. Leading zeros ("01"), signs
// ("-0", "+1"), decimals ("1.5"), the append token "-", the empty string, and
// non-digits are all invalid. This is a pure syntax check: it does NOT bound the
// value against any array length, and a syntactically valid but astronomically
// large index may still overflow int (see ParseArrayIndex).
func ValidArrayIndexSyntax(tok string) bool {
	if tok == "" {
		return false
	}
	if tok == "0" {
		return true
	}
	if tok[0] < '1' || tok[0] > '9' {
		return false
	}
	for i := 1; i < len(tok); i++ {
		if tok[i] < '0' || tok[i] > '9' {
			return false
		}
	}
	return true
}

// ParseArrayIndex validates tok as an array index (SPEC §3.6) and returns its
// integer value. ok is false when the syntax is invalid per
// ValidArrayIndexSyntax, or when the value is syntactically valid but does not
// fit in an int (an index no real array can hold). Callers that must distinguish
// "bad syntax" (INVALID_POINTER / PATH_UNRESOLVABLE per read/write side) from
// "in-range syntax, out-of-bounds value" (INDEX_OUT_OF_BOUNDS) should first
// consult ValidArrayIndexSyntax, then ParseArrayIndex.
func ParseArrayIndex(tok string) (int, bool) {
	if !ValidArrayIndexSyntax(tok) {
		return 0, false
	}
	n, err := strconv.Atoi(tok)
	if err != nil {
		return 0, false
	}
	return n, true
}
