package schemapatch

import (
	"fmt"
)

// CompareJSON computes the schema-aware patch that transforms original into
// modified, taking all three documents as raw JSON bytes. It is the one-call
// convenience over the ordered-[Value] pipeline: it decodes each document with
// [Decode] (so the full determinism guarantees of the value model apply — object
// member order and numeric literal text are preserved, SPEC §2.2), derives a
// [Plan] from schema with [BuildPlan], and runs [Patcher.Execute].
//
// schema may be nil for schemaless diffing, in which case every array falls back
// to the lcs strategy (SPEC §5.3). When non-nil it is a JSON Schema whose array
// item shapes select per-array diff strategies — a `required` primary-key field,
// for example, auto-detects the primaryKey strategy (SPEC §4.5). Plan derivation
// uses default [BuildPlanOptions]; callers needing PrimaryKeyMap, BasePath, or a
// custom candidate list should build the plan with [BuildPlan] and drive
// [NewPatcher] directly.
//
// opts are the same capability toggles accepted by [NewPatcher]
// ([IncludeOldValue], [EmitMoves], [WholesaleReplaceFallback]).
//
// A non-nil error is returned only for malformed JSON in one of the byte inputs;
// the returned slice is empty (never nil-panicking) when the documents are
// deep-equal. The result is deterministic for fixed inputs (SPEC §2.3).
func CompareJSON(schema, original, modified []byte, opts ...PatcherOption) ([]Operation, error) {
	plan, err := planFromJSONSchema(schema)
	if err != nil {
		return nil, err
	}
	orig, err := Decode(original)
	if err != nil {
		return nil, fmt.Errorf("schemapatch: decode original: %w", err)
	}
	mod, err := Decode(modified)
	if err != nil {
		return nil, fmt.Errorf("schemapatch: decode modified: %w", err)
	}
	patcher, err := NewPatcher(plan, opts...)
	if err != nil {
		return nil, err
	}
	return patcher.Execute(orig, mod), nil
}

// planFromJSONSchema decodes a JSON-Schema byte slice and builds a [Plan] with
// default options. A nil (or empty) schema yields the zero [Plan], which drives
// schemaless (lcs-everywhere) diffing.
func planFromJSONSchema(schema []byte) (Plan, error) {
	if len(schema) == 0 {
		return Plan{}, nil
	}
	schemaVal, err := Decode(schema)
	if err != nil {
		return Plan{}, fmt.Errorf("schemapatch: decode schema: %w", err)
	}
	plan, err := BuildPlan(schemaVal, BuildPlanOptions{})
	if err != nil {
		return Plan{}, fmt.Errorf("schemapatch: build plan: %w", err)
	}
	return plan, nil
}
