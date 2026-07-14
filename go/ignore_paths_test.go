package schemapatch

import (
	"strings"
	"testing"
)

// ignore_paths_test.go covers the ignorePaths capability (GEN §10, CONF §5.6),
// including the construction-time validation errors (GEN §10.1/GEN §10.7) that the
// diff vector wire format cannot express (CONF §6.2), plus happy-path and
// interaction semantics — mirroring test/ignore-paths.test.ts.

func ignoreDiff(t *testing.T, schema string, ignore []string, opts []PatcherOption, orig, mod string) []Operation {
	t.Helper()
	var plan Plan
	if schema != "" {
		var err error
		plan, err = BuildPlan(mustDecode(t, schema), BuildPlanOptions{})
		if err != nil {
			t.Fatalf("BuildPlan: %v", err)
		}
	}
	allOpts := append([]PatcherOption{IgnorePaths(ignore...)}, opts...)
	p, err := NewPatcher(plan, allOpts...)
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	return p.Execute(mustDecode(t, orig), mustDecode(t, mod))
}

const pkUsersSchema = `{"type":"object","properties":{"users":{"type":"array","items":{"type":"object","required":["id"],"properties":{"id":{"type":"string"},"updatedAt":{"type":"number"},"name":{"type":"string"}}}}}}`

func TestIgnorePathsValidation(t *testing.T) {
	cases := []struct {
		name   string
		schema string
		paths  []string
	}{
		{"array-index-segment", "", []string{"/users/0/id"}},
		{"dash-segment", "", []string{"/a/-"}},
		{"empty-root-pointer", "", []string{""}},
		{"no-leading-slash", "", []string{"a/b"}},
		{"pk-field-itself", pkUsersSchema, []string{"/users/*/id"}},
		{"whole-keyed-item", pkUsersSchema, []string{"/users/*"}},
		{"whole-keyed-array", pkUsersSchema, []string{"/users"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var plan Plan
			if tc.schema != "" {
				var err error
				plan, err = BuildPlan(mustDecode(t, tc.schema), BuildPlanOptions{})
				if err != nil {
					t.Fatalf("BuildPlan: %v", err)
				}
			}
			_, err := NewPatcher(plan, IgnorePaths(tc.paths...))
			if err == nil {
				t.Fatalf("expected NewPatcher to reject ignorePaths %v", tc.paths)
			}
			if !strings.Contains(err.Error(), "ignorePaths") {
				t.Errorf("error should mention ignorePaths, got %q", err.Error())
			}
		})
	}
}

func TestIgnorePathsAccepts(t *testing.T) {
	cases := [][]string{
		{"/x/01"},              // leading-zero segment is a legal member name, not an index
		{"/users/*/updatedAt"}, // wildcard + member
		{"/meta/ts"},
		{"/a~1b/c"}, // escaped member name containing a slash
	}
	for _, paths := range cases {
		if _, err := NewPatcher(Plan{}, IgnorePaths(paths...)); err != nil {
			t.Errorf("ignorePaths %v should be accepted, got %v", paths, err)
		}
	}
}

func TestIgnorePathsPrimaryKeyUnderAdditionalProps(t *testing.T) {
	// A primaryKey under an additionalProperties (*) plan path must still be
	// caught (GEN §10.7): plan key "/*", ignore "/envA/*/id".
	schema := `{"type":"object","additionalProperties":{"type":"array","items":{"type":"object","required":["id"],"properties":{"id":{"type":"string"}}}}}`
	plan, err := BuildPlan(mustDecode(t, schema), BuildPlanOptions{})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if _, err := NewPatcher(plan, IgnorePaths("/envA/*/id")); err == nil {
		t.Fatal("expected rejection: ignore covers the primaryKey field of the /* plan")
	}
}

func TestIgnorePathsHappyPaths(t *testing.T) {
	t.Run("obj-member-ignored-only", func(t *testing.T) {
		ops := ignoreDiff(t, "", []string{"/meta/ts"}, nil, `{"meta":{"ts":1,"n":"a"}}`, `{"meta":{"ts":2,"n":"a"}}`)
		if len(ops) != 0 {
			t.Fatalf("want [], got %s", dumpOps(ops))
		}
	})
	t.Run("obj-member-real-change-survives", func(t *testing.T) {
		ops := ignoreDiff(t, "", []string{"/meta/ts"}, nil, `{"meta":{"ts":1,"n":"a"}}`, `{"meta":{"ts":2,"n":"b"}}`)
		if len(ops) != 1 || string(ops[0].Op) != "replace" || ops[0].Path != "/meta/n" {
			t.Fatalf("want single replace /meta/n, got %s", dumpOps(ops))
		}
	})
	t.Run("whole-array-ignored", func(t *testing.T) {
		ops := ignoreDiff(t, "", []string{"/arr"}, nil, `{"arr":[1,2,3]}`, `{"arr":[4,5]}`)
		if len(ops) != 0 {
			t.Fatalf("want [], got %s", dumpOps(ops))
		}
	})
	t.Run("every-element-ignored", func(t *testing.T) {
		ops := ignoreDiff(t, "", []string{"/arr/*"}, nil, `{"arr":[{"a":1}]}`, `{"arr":[{"a":2},{"b":3}]}`)
		if len(ops) != 0 {
			t.Fatalf("want [], got %s", dumpOps(ops))
		}
	})
}

func TestIgnorePathsKeyedArray(t *testing.T) {
	t.Run("ignored-field-only", func(t *testing.T) {
		ops := ignoreDiff(t, pkUsersSchema, []string{"/users/*/updatedAt"}, nil,
			`{"users":[{"id":"a","updatedAt":1},{"id":"b","updatedAt":1}]}`,
			`{"users":[{"id":"a","updatedAt":2},{"id":"b","updatedAt":1}]}`)
		if len(ops) != 0 {
			t.Fatalf("want [], got %s", dumpOps(ops))
		}
	})
	t.Run("real-change-survives-ignored-drift", func(t *testing.T) {
		ops := ignoreDiff(t, pkUsersSchema, []string{"/users/*/updatedAt"}, nil,
			`{"users":[{"id":"a","updatedAt":1,"name":"A"}]}`,
			`{"users":[{"id":"a","updatedAt":2,"name":"A2"}]}`)
		if len(ops) != 1 || ops[0].Path != "/users/0/name" {
			t.Fatalf("want single replace /users/0/name, got %s", dumpOps(ops))
		}
	})
}

func TestIgnorePathsLCS(t *testing.T) {
	t.Run("ignored-field-only", func(t *testing.T) {
		ops := ignoreDiff(t, "", []string{"/items/*/ts"}, nil,
			`{"items":[{"v":1,"ts":1},{"v":2,"ts":1}]}`,
			`{"items":[{"v":1,"ts":9},{"v":2,"ts":1}]}`)
		if len(ops) != 0 {
			t.Fatalf("want [], got %s", dumpOps(ops))
		}
	})
	t.Run("move-pairing-with-ignored-drift", func(t *testing.T) {
		ops := ignoreDiff(t, "", []string{"/items/*/ts"}, []PatcherOption{EmitMoves(true)},
			`{"items":[{"v":"X","ts":1},{"v":"Y","ts":1}]}`,
			`{"items":[{"v":"Y","ts":9},{"v":"X","ts":1}]}`)
		moves, replaces := 0, 0
		for _, o := range ops {
			switch o.Op {
			case OpMove:
				moves++
			case OpReplace:
				replaces++
			}
		}
		if moves != 1 || replaces != 0 {
			t.Fatalf("want 1 move, 0 replace, got %s", dumpOps(ops))
		}
	})
}

func TestIgnorePathsWholesaleDisabled(t *testing.T) {
	schema := `{"type":"object","properties":{"a":{"type":"array","items":{"type":"object","properties":{"t":{"type":"string"},"ts":{"type":"number"}}}}}}`
	ops := ignoreDiff(t, schema, []string{"/a/*/ts"}, []PatcherOption{WholesaleReplaceFallback(true)},
		`{"a":[{"t":"AAAAAAAAAA","ts":1},{"t":"BBBBBBBBBB","ts":2}]}`,
		`{"a":[{"t":"ZZZZZZZZZZ","ts":5},{"t":"YYYYYYYYYY","ts":6}]}`)
	for _, o := range ops {
		if o.Op == OpReplace && o.Path == "/a" {
			t.Fatalf("wholesale replace at /a leaked ignored content: %s", dumpOps(ops))
		}
		if o.Op == OpReplace && strings.HasSuffix(o.Path, "/ts") {
			t.Fatalf("emitted a replace on an ignored /ts field: %s", dumpOps(ops))
		}
	}
}

func TestIgnorePathsByteStable(t *testing.T) {
	// An empty ignore set must be byte-identical to no option (GEN §10.2).
	orig := `{"meta":{"ts":1,"n":"a"},"arr":[{"id":"x","v":1}]}`
	mod := `{"meta":{"ts":2,"n":"b"},"arr":[{"id":"x","v":2}]}`
	base, err := NewPatcher(Plan{})
	if err != nil {
		t.Fatal(err)
	}
	withEmpty, err := NewPatcher(Plan{}, IgnorePaths())
	if err != nil {
		t.Fatal(err)
	}
	o1 := base.Execute(mustDecode(t, orig), mustDecode(t, mod))
	o2 := withEmpty.Execute(mustDecode(t, orig), mustDecode(t, mod))
	if dumpOps(o1) != dumpOps(o2) {
		t.Fatalf("empty ignorePaths not byte-stable:\n base: %s\nempty: %s", dumpOps(o1), dumpOps(o2))
	}
}
