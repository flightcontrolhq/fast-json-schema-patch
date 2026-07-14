package schemapatch

import (
	"reflect"
	"testing"
)

// mustPlan decodes a schema literal and builds a plan, failing the test on error.
func mustPlan(t *testing.T, schemaJSON string, opts BuildPlanOptions) Plan {
	t.Helper()
	schema, err := Decode([]byte(schemaJSON))
	if err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	plan, err := BuildPlan(schema, opts)
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	return plan
}

func TestBuildPlanTypelessNodeTraversed(t *testing.T) {
	// SPEC §4.3.1: a node with properties/items but no `type` is still traversed.
	plan := mustPlan(t, `{
		"properties": {
			"list": { "items": {
				"type": "object",
				"properties": {"id": {"type": "string"}},
				"required": ["id"]
			}}
		}
	}`, BuildPlanOptions{})

	ap, ok := plan.Lookup("/list")
	if !ok {
		t.Fatalf("expected /list plan, got paths %v", plan.Paths())
	}
	if ap.Strategy != StrategyPrimaryKey || ap.PrimaryKey != "id" {
		t.Errorf("got %+v, want primaryKey id", ap)
	}
}

func TestBuildPlanNestedArraysDistinctPaths(t *testing.T) {
	// SPEC §4.3.5: array-of-arrays yields distinct outer (lcs) and inner (keyed)
	// plans that do not clobber each other.
	plan := mustPlan(t, `{
		"properties": {
			"matrix": {
				"type": "array",
				"items": {
					"type": "array",
					"items": {
						"type": "object",
						"properties": {"id": {"type": "string"}},
						"required": ["id"]
					}
				}
			}
		}
	}`, BuildPlanOptions{})

	outer, ok := plan.Lookup("/matrix")
	if !ok || outer.Strategy != StrategyLCS || outer.PrimaryKey != "" {
		t.Errorf("/matrix = %+v (ok=%v), want lcs/no-key", outer, ok)
	}
	inner, ok := plan.Lookup("/matrix/*")
	if !ok || inner.Strategy != StrategyPrimaryKey || inner.PrimaryKey != "id" {
		t.Errorf("/matrix/* = %+v (ok=%v), want primaryKey id", inner, ok)
	}
}

func TestBuildPlanNonLocalRefWarns(t *testing.T) {
	// SPEC §4.3.4: a non-local $ref is unresolvable, routed through OnWarning.
	var warnings []string
	plan := mustPlan(t, `{
		"properties": {
			"list": { "type": "array", "items": {"$ref": "http://example.com/item"} }
		}
	}`, BuildPlanOptions{OnWarning: func(m string) { warnings = append(warnings, m) }})

	ap, ok := plan.Lookup("/list")
	if !ok || ap.Strategy != StrategyLCS {
		t.Errorf("/list = %+v (ok=%v), want lcs fallback", ap, ok)
	}
	// The same unresolvable ref is probed at several call sites (items-$ref
	// resolution, mergeAllOf, and the items traversal), so it may warn more than
	// once; each warning MUST carry the same unsupported-reference message. This
	// mirrors the reference (multiplicity is unspecified by §4.3.4).
	if len(warnings) == 0 {
		t.Error("expected at least one unsupported-reference warning")
	}
	for _, w := range warnings {
		if w != "Unsupported reference: http://example.com/item" {
			t.Errorf("unexpected warning %q", w)
		}
	}
}

func TestBuildPlanRefCycleSafe(t *testing.T) {
	// SPEC §4.3: a self-referential $ref must terminate. `node.children` is an
	// array of `node`, so traversal would loop without the visited guard.
	plan := mustPlan(t, `{
		"$defs": {
			"node": {
				"type": "object",
				"properties": {
					"id": {"type": "string"},
					"children": {"type": "array", "items": {"$ref": "#/$defs/node"}}
				},
				"required": ["id"]
			}
		},
		"type": "object",
		"properties": {"root": {"$ref": "#/$defs/node"}}
	}`, BuildPlanOptions{})

	// The children array beneath the root node must register a keyed plan.
	ap, ok := plan.Lookup("/root/children")
	if !ok || ap.PrimaryKey != "id" {
		t.Errorf("/root/children = %+v (ok=%v), want primaryKey id", ap, ok)
	}
}

func TestBuildPlanAnyOfBranchDedup(t *testing.T) {
	// SPEC §4.3.6: identical branches within one keyword are traversed once.
	// Two identical anyOf branches on the item schema must not corrupt the plan.
	plan := mustPlan(t, `{
		"properties": {
			"list": { "type": "array", "items": {
				"anyOf": [
					{"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]},
					{"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
				]
			}}
		}
	}`, BuildPlanOptions{})
	ap, ok := plan.Lookup("/list")
	if !ok || ap.PrimaryKey != "id" {
		t.Errorf("/list = %+v (ok=%v), want primaryKey id", ap, ok)
	}
}

func TestPlanTrieExactBeatsWildcard(t *testing.T) {
	// SPEC §5.4.5.2: an exact child edge takes precedence over the wildcard edge.
	// A schema with both a named `id` array property and additionalProperties
	// arrays produces `/id` (exact) and `/*` (wildcard) plans.
	plan := mustPlan(t, `{
		"type": "object",
		"properties": {
			"id": { "type": "array", "items": {"type": "string"} }
		},
		"additionalProperties": {
			"type": "array",
			"items": {
				"type": "object",
				"properties": {"id": {"type": "string"}},
				"required": ["id"]
			}
		}
	}`, BuildPlanOptions{})

	root := plan.Root()
	if root == nil {
		t.Fatal("expected non-nil trie root")
	}
	// Exact edge "id" -> unique primitive plan.
	if got := root.Member("id").ArrayPlan(); got == nil || got.Strategy != StrategyUnique {
		t.Errorf("Member(id) plan = %+v, want unique (exact wins over wildcard)", got)
	}
	// Any other key falls to the wildcard edge -> primaryKey plan.
	if got := root.Member("other").ArrayPlan(); got == nil || got.Strategy != StrategyPrimaryKey {
		t.Errorf("Member(other) plan = %+v, want primaryKey (wildcard)", got)
	}
}

func TestPlanTrieRootLevelArray(t *testing.T) {
	// SPEC §5.4.5.1: a root array schema registers at the empty key and its plan
	// lives on the trie root node itself.
	plan := mustPlan(t, `{
		"type": "array",
		"items": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
	}`, BuildPlanOptions{})

	if ap := plan.Root().ArrayPlan(); ap == nil || ap.PrimaryKey != "id" {
		t.Errorf("root plan = %+v, want primaryKey id", ap)
	}
}

func TestPlanTrieNestedWildcardDepth(t *testing.T) {
	// SPEC §5.4.5.2: a wildcard plan is reachable at depth; thread member then
	// wildcard for `/envs/*`.
	plan := mustPlan(t, `{
		"properties": {
			"envs": { "type": "object", "additionalProperties": {
				"type": "array",
				"items": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
			}}
		}
	}`, BuildPlanOptions{})

	// /envs is an object node (no plan); the array lives at /envs/<anyKey>.
	envs := plan.Root().Member("envs")
	if envs == nil {
		t.Fatal("expected /envs node")
	}
	if ap := envs.Member("production").ArrayPlan(); ap == nil || ap.PrimaryKey != "id" {
		t.Errorf("/envs/production plan = %+v, want primaryKey id", ap)
	}
}

func TestBuildPlanEmptyIsNilRoot(t *testing.T) {
	// SPEC §5.4.5.2: an empty plan threads no node.
	plan := mustPlan(t, `{"type": "object", "properties": {"a": {"type": "string"}}}`, BuildPlanOptions{})
	if plan.Len() != 0 {
		t.Fatalf("expected empty plan, got %v", plan.Paths())
	}
	if plan.Root() != nil {
		t.Error("expected nil trie root for empty plan")
	}
	// Nil-node threading is safe and yields no plan (⇒ lcs).
	if plan.Root().Member("x").ArrayPlan() != nil {
		t.Error("nil node threading should yield no plan")
	}
}

func TestBuildPlanBasePathSegmentBoundary(t *testing.T) {
	// SPEC §4.6.2: basePath matches on a segment boundary; a sibling prefix
	// (/env vs /envelope) must NOT be captured, and matched keys are relativized.
	plan := mustPlan(t, `{
		"type": "object",
		"properties": {
			"env": { "type": "object", "properties": {
				"servers": {"type": "array", "items": {
					"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]
				}}
			}},
			"envelope": { "type": "object", "properties": {
				"rows": {"type": "array", "items": {
					"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]
				}}
			}}
		}
	}`, BuildPlanOptions{BasePath: "/env"})

	if _, ok := plan.Lookup("/servers"); !ok {
		t.Errorf("expected relativized /servers, got paths %v", plan.Paths())
	}
	// /envelope/rows shares the "/env" string prefix but not a segment boundary.
	for _, p := range plan.Paths() {
		if p == "elope/rows" || p == "/envelope/rows" || p == "/rows" {
			t.Errorf("basePath wrongly captured sibling: path %q present", p)
		}
	}
	if plan.Len() != 1 {
		t.Errorf("expected exactly 1 in-base plan, got paths %v", plan.Paths())
	}
}

func TestBuildPlanPrimaryKeyMapOverrideNoMetadata(t *testing.T) {
	// SPEC §4.4.3: override sets key+strategy without requiredFields/hashFields.
	plan := mustPlan(t, `{
		"properties": {
			"items": { "type": "array", "items": {
				"type": "object", "properties": {"id": {"type": "string"}, "v": {"type": "number"}}
			}}
		}
	}`, BuildPlanOptions{PrimaryKeyMap: map[string]string{"/items": "id"}})

	ap, ok := plan.Lookup("/items")
	if !ok {
		t.Fatal("expected /items plan")
	}
	if ap.PrimaryKey != "id" || ap.Strategy != StrategyPrimaryKey {
		t.Errorf("got %+v, want primaryKey id", ap)
	}
	if ap.RequiredFields != nil || ap.HashFields != nil {
		t.Errorf("override should carry no metadata, got required=%v hash=%v", ap.RequiredFields, ap.HashFields)
	}
}

func TestBuildPlanHashFieldsOrderFollowsRequired(t *testing.T) {
	// SPEC §4.5.4: hashFields are the required string/number fields in required
	// order, excluding non-primitive required fields.
	plan := mustPlan(t, `{
		"properties": {
			"rows": { "type": "array", "items": {
				"type": "object",
				"properties": {
					"id": {"type": "string"},
					"meta": {"type": "object"},
					"port": {"type": "number"}
				},
				"required": ["id", "meta", "port"]
			}}
		}
	}`, BuildPlanOptions{})

	ap, _ := plan.Lookup("/rows")
	if !reflect.DeepEqual(ap.RequiredFields, []string{"id", "meta", "port"}) {
		t.Errorf("requiredFields = %v, want [id meta port]", ap.RequiredFields)
	}
	if !reflect.DeepEqual(ap.HashFields, []string{"id", "port"}) {
		t.Errorf("hashFields = %v, want [id port] (meta excluded, required order)", ap.HashFields)
	}
}
