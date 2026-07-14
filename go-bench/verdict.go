package main

import (
	"bytes"
	"sort"

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
func (c *CorpusCase) reconstructs(applied sp.Value) bool {
	if c.Roundtrip == "exact" {
		return bytes.Equal(mustEncode(applied), c.ModifiedBytes)
	}
	return bytes.Equal(mustEncode(canonSort(applied)), mustEncode(canonSort(c.Modified)))
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
