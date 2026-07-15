package schemapatch

import (
	"encoding/json"
	"testing"
)

// CORE §3.3.7 recursion aliases and the CORE §3.4.3 unreached-primaryKeyMap
// post-pass. The cross-engine behavior is pinned by the conformance vectors
// (spec/vectors/{plan,diff}); these tests cover Go-side introspection and the
// registration edge cases vectors cannot express.

const recursiveStepsSchema = `{
  "type": "object",
  "properties": {
    "steps": {"$ref": "#/$defs/stepList"}
  },
  "$defs": {
    "stepList": {"type": "array", "items": {"$ref": "#/$defs/step"}},
    "step": {
      "type": "object",
      "required": ["id"],
      "properties": {
        "id": {"type": "string"},
        "parallel": {"$ref": "#/$defs/stepList"}
      }
    }
  }
}`

func TestRecursionAliasPlanEntries(t *testing.T) {
	schema, err := Decode([]byte(recursiveStepsSchema))
	if err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	plan, err := BuildPlan(schema, BuildPlanOptions{})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}

	steps, ok := plan.Lookup("/steps")
	if !ok || steps.Strategy != StrategyPrimaryKey || steps.PrimaryKey != "id" {
		t.Fatalf("/steps plan = %+v, want primaryKey id", steps)
	}
	alias, ok := plan.Lookup("/steps/parallel")
	if !ok {
		t.Fatalf("missing alias entry at /steps/parallel (paths %v)", plan.Paths())
	}
	if !alias.HasRecurseTo || alias.RecurseTo != "/steps" || !alias.isRecursionAliasOnly() {
		t.Fatalf("alias = %+v, want alias-only recurseTo /steps", alias)
	}
}

func TestRecursionAliasKeyedDiffAtDepth(t *testing.T) {
	original := []byte(`{"steps":[{"id":"a"},{"id":"group","parallel":[{"id":"p1","parallel":[{"id":"q1"},{"id":"q2"}]},{"id":"p2"}]}]}`)
	modified := []byte(`{"steps":[{"id":"a"},{"id":"group","parallel":[{"id":"p1","parallel":[{"id":"q1"}]},{"id":"p2"}]}]}`)
	patch, err := CompareJSON([]byte(recursiveStepsSchema), original, modified)
	if err != nil {
		t.Fatalf("CompareJSON: %v", err)
	}
	out, err := EncodeOperations(patch)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := `[{"op":"remove","path":"/steps/1/parallel/0/parallel/1","oldValue":{"id":"q2"}}]`
	if string(out) != want {
		t.Fatalf("patch = %s, want %s", out, want)
	}
}

func TestUnreachedPrimaryKeyMapRegistersAndDiffsKeyed(t *testing.T) {
	schema, err := Decode([]byte(`{"type":"object"}`))
	if err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	plan, err := BuildPlan(schema, BuildPlanOptions{PrimaryKeyMap: map[string]string{"/users": "email"}})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	users, ok := plan.Lookup("/users")
	if !ok || users.Strategy != StrategyPrimaryKey || users.PrimaryKey != "email" {
		t.Fatalf("/users plan = %+v, want primaryKey email", users)
	}

	patcher, err := NewPatcher(plan)
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	original, _ := Decode([]byte(`{"users":[{"email":"a@x.io","role":"admin"},{"email":"b@x.io","role":"user"}]}`))
	modified, _ := Decode([]byte(`{"users":[{"email":"b@x.io","role":"user"},{"email":"a@x.io","role":"owner"}]}`))
	out, err := EncodeOperations(patcher.Execute(original, modified))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := `[{"op":"replace","path":"/users/0/role","value":"owner","oldValue":"admin"}]`
	if string(out) != want {
		t.Fatalf("patch = %s, want %s", out, want)
	}
}

func TestRecursionAliasSurvivesRealPlanRegistration(t *testing.T) {
	// A hand-built direct cycle (no $ref): step.properties.parallel is the array
	// node whose items are step itself, so the alias lands one level beneath the
	// registered array plan and the trie must still resolve unbounded depth.
	step := NewObject()
	step.Set("type", "object")
	step.Set("required", []Value{"id"})
	props := NewObject()
	idProp := NewObject()
	idProp.Set("type", "string")
	props.Set("id", idProp)
	parallel := NewObject()
	parallel.Set("type", "array")
	parallel.Set("items", step)
	props.Set("parallel", parallel)
	step.Set("properties", props)
	root := NewObject()
	root.Set("type", "object")
	rootProps := NewObject()
	rootProps.Set("parallel", parallel)
	root.Set("properties", rootProps)

	plan, err := BuildPlan(root, BuildPlanOptions{})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	arr, ok := plan.Lookup("/parallel")
	if !ok || arr.Strategy != StrategyPrimaryKey || arr.PrimaryKey != "id" {
		t.Fatalf("/parallel plan = %+v, want primaryKey id", arr)
	}
	alias, ok := plan.Lookup("/parallel/parallel")
	if !ok || !alias.HasRecurseTo || alias.RecurseTo != "/parallel" {
		t.Fatalf("/parallel/parallel = %+v, want recurseTo /parallel", alias)
	}

	patcher, err := NewPatcher(plan)
	if err != nil {
		t.Fatalf("NewPatcher: %v", err)
	}
	original, _ := Decode([]byte(`{"parallel":[{"id":"x","parallel":[{"id":"y"},{"id":"z"}]}]}`))
	modified, _ := Decode([]byte(`{"parallel":[{"id":"x","parallel":[{"id":"z"}]}]}`))
	out, err := EncodeOperations(patcher.Execute(original, modified))
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	want := `[{"op":"remove","path":"/parallel/0/parallel/0","oldValue":{"id":"y"}}]`
	if string(out) != want {
		t.Fatalf("patch = %s, want %s", out, want)
	}
}

func TestRecursionAliasBasePathRelativization(t *testing.T) {
	schema, err := Decode([]byte(recursiveStepsSchema))
	if err != nil {
		t.Fatalf("decode schema: %v", err)
	}

	// BasePath /steps relativizes the array plan to the root key "" and the
	// alias to "/parallel" anchored at "" — a present, root-anchored alias,
	// which is exactly why RecurseTo needs a presence flag.
	plan, err := BuildPlan(schema, BuildPlanOptions{BasePath: "/steps"})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if entry, ok := plan.Lookup(""); !ok || entry.Strategy != StrategyPrimaryKey {
		t.Fatalf("base-relative root plan = %+v, want primaryKey plan", entry)
	}
	alias, ok := plan.Lookup("/parallel")
	if !ok || !alias.HasRecurseTo || alias.RecurseTo != "" || !alias.isRecursionAliasOnly() {
		t.Fatalf("/parallel = %+v, want alias-only recurseTo \"\"", alias)
	}

	// An anchor outside the base cannot be wired: the alias is dropped.
	plan, err = BuildPlan(schema, BuildPlanOptions{BasePath: "/steps/parallel"})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if entry, ok := plan.Lookup(""); ok && entry.HasRecurseTo {
		t.Fatalf("out-of-base anchor produced alias %+v, want none", entry)
	}
}

func TestRecursionAliasJSONRoundTripThroughLookup(t *testing.T) {
	schema, err := Decode([]byte(recursiveStepsSchema))
	if err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	plan, err := BuildPlan(schema, BuildPlanOptions{})
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	// Lookup returns a defensive copy; mutating it must not corrupt the plan.
	alias, _ := plan.Lookup("/steps/parallel")
	alias.RecurseTo = "/elsewhere"
	fresh, _ := plan.Lookup("/steps/parallel")
	if fresh.RecurseTo != "/steps" {
		t.Fatalf("Lookup copy leaked mutation: %+v", fresh)
	}
	if _, err := json.Marshal(fresh); err != nil {
		t.Fatalf("alias entry not marshalable: %v", err)
	}
}
