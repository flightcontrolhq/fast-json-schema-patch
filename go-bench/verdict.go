package main

import (
	"bytes"
	"sort"
	"strings"

	evan "github.com/evanphx/json-patch/v5"
	sp "github.com/flightcontrolhq/fast-json-schema-patch/go"
)

// Verdict vocabulary mirrors the TS runner (comparison/bench-v2/libs.ts):
//
//	PASS       — the patch round-trips to `modified` under the case's contract
//	CORRUPT    — a patch was produced but does not reconstruct `modified`
//	CRASH      — diff (or patch decode) panicked / errored before a patch existed
//	NO-APPLIER — a diff was produced but the library ships no round-trip applier
//	SKIPPED    — the adapter is not applicable to this case (size/schema gate)
//
// Multiset cases (roundtrip == "multiset") are compared under an order-normalized
// canonical form, exactly as the TS runner's reconstructs()/canonSort do; a pass
// there is still reported as PASS, with verdictDetail recording "multiset-canonical"
// so the relaxed contract is visible in the data.
const (
	VerdictPass      = "PASS"
	VerdictCorrupt   = "CORRUPT"
	VerdictCrash     = "CRASH"
	VerdictNoApplier = "NO-APPLIER"
	VerdictSkipped   = "SKIPPED"
)

// reconstructs reports whether `applied` matches the case's `modified` under the
// case's round-trip contract: byte-exact serialization for "exact", order-
// normalized canonical form for "multiset".
//
// ignorePaths cases (CORE §7.6): apply(original, patch) equals modified
// EVERYWHERE except at or beneath a matched ignore location, where it retains
// original's value. Such a case is therefore compared MODULO the ignored subtrees
// — both sides have the ignored members stripped before comparison — so a
// schema-aware engine that (correctly) emitted no op for a volatile field is not
// judged CORRUPT, and a generic engine that DID rewrite it still passes (both
// agree off the ignored projection). Parity with the TS runner's reconstructs().
func (c *CorpusCase) reconstructs(applied sp.Value) bool {
	return c.reconstructsMode(applied, c.Roundtrip == "multiset")
}

// reconstructsMode is reconstructs with an explicit canonical (order-insensitive)
// flag. The Compare(any) typed-entry adapter re-marshals its inputs through
// encoding/json, which sorts object keys, so it is verified canonically regardless
// of the case's declared contract (its correctness is already pinned by the
// pre-parsed "ours" row; this row measures the marshal-included path's cost).
func (c *CorpusCase) reconstructsMode(applied sp.Value, canonical bool) bool {
	got, exp := applied, c.Modified
	if len(c.Options.IgnorePaths) > 0 {
		got = stripIgnored(sp.Clone(got), c.Options.IgnorePaths)
		exp = stripIgnored(sp.Clone(exp), c.Options.IgnorePaths)
	}
	if canonical {
		return bytes.Equal(mustEncode(canonSort(got)), mustEncode(canonSort(exp)))
	}
	return bytes.Equal(mustEncode(got), mustEncode(exp))
}

// stripIgnored deletes the subtrees addressed by `pointers` from v (mutating it).
// Segment rules mirror GEN §10.3: a `*` segment matches every array element or
// every object member at that level; any other segment is an exact object-member
// key (unescaped per RFC 6901). Every corpus ignore pointer terminates on a
// literal member name, so the terminal is always an object-member delete.
func stripIgnored(v sp.Value, pointers []string) sp.Value {
	for _, ptr := range pointers {
		raw := strings.Split(ptr, "/")
		segs := make([]string, 0, len(raw))
		for _, s := range raw[1:] { // raw[0] is the empty string before the leading '/'
			s = strings.ReplaceAll(s, "~1", "/")
			s = strings.ReplaceAll(s, "~0", "~")
			segs = append(segs, s)
		}
		delSeg(v, segs)
	}
	return v
}

func delSeg(node sp.Value, segs []string) {
	if len(segs) == 0 {
		return
	}
	seg, rest := segs[0], segs[1:]
	if len(rest) == 0 {
		if o, ok := node.(*sp.Object); ok {
			o.Delete(seg)
		}
		return
	}
	if seg == "*" {
		switch t := node.(type) {
		case []sp.Value:
			for _, el := range t {
				delSeg(el, rest)
			}
		case *sp.Object:
			for _, k := range t.Keys() {
				val, _ := t.Get(k)
				delSeg(val, rest)
			}
		}
		return
	}
	if o, ok := node.(*sp.Object); ok {
		if child, present := o.Get(seg); present {
			delSeg(child, rest)
		}
	}
}

// canonSort recursively sorts arrays by their encoded form and sorts object keys,
// producing an order-insensitive canonical value (parity with libs.ts canonSort).
func canonSort(v sp.Value) sp.Value {
	switch t := v.(type) {
	case []sp.Value:
		out := make([]sp.Value, len(t))
		for i, e := range t {
			out[i] = canonSort(e)
		}
		sort.Slice(out, func(i, j int) bool {
			return string(mustEncode(out[i])) < string(mustEncode(out[j]))
		})
		return out
	case *sp.Object:
		keys := append([]string(nil), t.Keys()...)
		sort.Strings(keys)
		no := sp.NewObject()
		for _, k := range keys {
			val, _ := t.Get(k)
			no.Set(k, canonSort(val))
		}
		return no
	default:
		return v
	}
}

// evanphxApply applies an RFC 6902 patch (as JSON bytes) to the case's original
// document using github.com/evanphx/json-patch/v5 — the neutral applier used to
// judge every competitor whose own applier is not the subject of measurement. It
// returns the reconstructed document as a Value or an error (unappliable patch).
func evanphxApply(c *CorpusCase, patchJSON []byte) (sp.Value, error) {
	p, err := evan.DecodePatch(patchJSON)
	if err != nil {
		return nil, err
	}
	out, err := p.Apply(c.OriginalBytes)
	if err != nil {
		return nil, err
	}
	return sp.Decode(out)
}
