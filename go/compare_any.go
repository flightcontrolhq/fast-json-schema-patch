package schemapatch

import (
	"encoding/json"
	"fmt"
)

// Compare computes the schema-aware patch that transforms source into target,
// accepting arbitrary Go values — typed structs, maps, slices, or already-decoded
// JSON. Each argument is marshaled with [encoding/json.Marshal] and the result is
// delegated to [CompareJSON], so this is the ergonomic front door for callers who
// hold typed Go data rather than JSON bytes (the wI2L/jsondiff headline use case).
//
// schema is a JSON Schema as any Go value (a map, a struct, a
// json.RawMessage, …), or nil for schemaless diffing. source and target are the
// two documents to diff. opts are the [NewPatcher] capability toggles.
//
// # Determinism contract
//
// The result is deterministic for fixed inputs, but callers should understand how
// encoding/json canonicalizes on the way in, because it differs from [Decode] on
// raw bytes:
//
//   - Struct fields marshal in declaration order — deterministic, and the order
//     you control by field ordering (and `json:` tags).
//   - map[K]V members marshal in sorted key order — deterministic, but the map's
//     original insertion order is NOT preserved (Go maps have none). If you need a
//     specific member order to survive into the patch, model it with a struct or
//     diff raw bytes via [CompareJSON]/[Decode], which preserve source order
//     (CORE §1.2).
//   - Non-finite floats (NaN, +Inf, -Inf) in a float field are rejected by
//     encoding/json, so Compare returns an error rather than emitting a number
//     with no JSON representation — consistent with the value model's own
//     rejection (CORE §1.2, D6).
//
// A non-nil error is returned when any argument fails to marshal (e.g. a NaN
// float, or an unsupported type such as a channel or func). The returned slice is
// empty when source and target marshal to deep-equal JSON.
func Compare(schema, source, target any, opts ...PatcherOption) ([]Operation, error) {
	var schemaBytes []byte
	if schema != nil {
		b, err := marshalJSON("schema", schema)
		if err != nil {
			return nil, err
		}
		schemaBytes = b
	}
	sourceBytes, err := marshalJSON("source", source)
	if err != nil {
		return nil, err
	}
	targetBytes, err := marshalJSON("target", target)
	if err != nil {
		return nil, err
	}
	return CompareJSON(schemaBytes, sourceBytes, targetBytes, opts...)
}

// marshalJSON is the shared encoding/json marshaling step behind [Compare]. It is
// pulled out so the determinism contract lives in one place: struct fields
// serialize in declaration order (deterministic); map[string]T members serialize
// in sorted-key order (deterministic, but the source insertion order — if any —
// is NOT preserved, unlike [Decode] on raw bytes); and non-finite floats (NaN,
// +Inf, -Inf) are rejected by encoding/json, consistent with the value model's
// own rejection of numbers that have no JSON representation (CORE §1.2, D6).
func marshalJSON(label string, v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("schemapatch: marshal %s: %w", label, err)
	}
	return b, nil
}
