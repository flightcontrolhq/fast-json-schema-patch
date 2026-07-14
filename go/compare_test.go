package schemapatch

import (
	"testing"
)

// mustEncodeOps renders a patch to compact JSON or fails the test.
func mustEncodeOps(t *testing.T, ops []Operation) string {
	t.Helper()
	b, err := EncodeOperations(ops)
	if err != nil {
		t.Fatalf("EncodeOperations: %v", err)
	}
	return string(b)
}

func TestCompareJSON_SchemaKeyedDiff(t *testing.T) {
	schema := []byte(`{
		"type": "object",
		"properties": {
			"users": {
				"type": "array",
				"items": {
					"type": "object",
					"required": ["id"],
					"properties": {"id": {"type": "string"}, "status": {"type": "string"}}
				}
			}
		}
	}`)
	original := []byte(`{"users":[{"id":"user1","status":"active"},{"id":"user2","status":"inactive"}]}`)
	modified := []byte(`{"users":[{"id":"user1","status":"online"},{"id":"user3","status":"active"}]}`)

	ops, err := CompareJSON(schema, original, modified)
	if err != nil {
		t.Fatalf("CompareJSON: %v", err)
	}
	got := mustEncodeOps(t, ops)
	want := `[{"op":"replace","path":"/users/0/status","value":"online","oldValue":"active"},` +
		`{"op":"remove","path":"/users/1","oldValue":{"id":"user2","status":"inactive"}},` +
		`{"op":"add","path":"/users/-","value":{"id":"user3","status":"active"}}]`
	if got != want {
		t.Fatalf("primaryKey diff mismatch:\n got: %s\nwant: %s", got, want)
	}
}

func TestCompareJSON_NilSchemaSchemaless(t *testing.T) {
	// With no schema the array uses lcs; a leading insertion is expressed
	// positionally rather than by key.
	ops, err := CompareJSON(nil,
		[]byte(`{"xs":[1,2,3]}`),
		[]byte(`{"xs":[1,2,3,4]}`))
	if err != nil {
		t.Fatalf("CompareJSON: %v", err)
	}
	got := mustEncodeOps(t, ops)
	want := `[{"op":"add","path":"/xs/3","value":4}]`
	if got != want {
		t.Fatalf("schemaless diff mismatch:\n got: %s\nwant: %s", got, want)
	}
}

func TestCompareJSON_EqualDocumentsEmptyPatch(t *testing.T) {
	ops, err := CompareJSON(nil, []byte(`{"a":1,"b":[1,2]}`), []byte(`{"a":1,"b":[1,2]}`))
	if err != nil {
		t.Fatalf("CompareJSON: %v", err)
	}
	if len(ops) != 0 {
		t.Fatalf("expected empty patch for equal docs, got %d ops", len(ops))
	}
}

func TestCompareJSON_Options(t *testing.T) {
	// IncludeOldValue(false) drops oldValue from the remove op.
	ops, err := CompareJSON(nil,
		[]byte(`{"a":1}`),
		[]byte(`{}`),
		IncludeOldValue(false))
	if err != nil {
		t.Fatalf("CompareJSON: %v", err)
	}
	got := mustEncodeOps(t, ops)
	want := `[{"op":"remove","path":"/a"}]`
	if got != want {
		t.Fatalf("IncludeOldValue(false) mismatch:\n got: %s\nwant: %s", got, want)
	}
}

func TestCompareJSON_InvalidJSON(t *testing.T) {
	cases := []struct {
		name                       string
		schema, original, modified []byte
	}{
		{"bad schema", []byte(`{`), []byte(`{}`), []byte(`{}`)},
		{"bad original", nil, []byte(`{`), []byte(`{}`)},
		{"bad modified", nil, []byte(`{}`), []byte(`}`)},
		{"trailing data", nil, []byte(`{} garbage`), []byte(`{}`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := CompareJSON(tc.schema, tc.original, tc.modified); err == nil {
				t.Fatalf("expected error for %s, got nil", tc.name)
			}
		})
	}
}

func TestCompareJSON_NumberTextPreserved(t *testing.T) {
	// A large integer literal survives the decode→diff→encode round-trip
	// byte-faithfully (SPEC §2.2) even though comparison is at f64.
	ops, err := CompareJSON(nil,
		[]byte(`{"n":1}`),
		[]byte(`{"n":10000000000000000001}`))
	if err != nil {
		t.Fatalf("CompareJSON: %v", err)
	}
	got := mustEncodeOps(t, ops)
	want := `[{"op":"replace","path":"/n","value":10000000000000000001,"oldValue":1}]`
	if got != want {
		t.Fatalf("number text mismatch:\n got: %s\nwant: %s", got, want)
	}
}
