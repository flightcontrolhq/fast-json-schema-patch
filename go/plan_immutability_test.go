package schemapatch

import "testing"

// keyedPlanSchema is a schema whose "/items" array is keyed by "id", so the
// differ selects StrategyPrimaryKey there. A pure reorder of keyed items with
// unchanged values therefore diffs to the empty patch (matched by key, not
// position); an LCS fallback would instead emit positional replaces. That
// difference is the behavioral probe the mutation-safety tests rely on.
const keyedPlanSchema = `{
	"properties": {
		"items": { "type": "array", "items": {
			"type": "object",
			"properties": {"id": {"type": "string"}, "v": {"type": "number"}},
			"required": ["id"]
		}}
	}
}`

// reorderPreservesEmptyDiff asserts that diffing a keyed array against its
// reorder still yields the empty patch under plan — i.e. StrategyPrimaryKey is
// intact. Used before and after an attempted mutation of an introspection copy.
func reorderPreservesEmptyDiff(t *testing.T, plan Plan) {
	t.Helper()
	const a = `{"items":[{"id":"a","v":1},{"id":"b","v":2}]}`
	const b = `{"items":[{"id":"b","v":2},{"id":"a","v":1}]}`
	got := diffJSON(t, plan, a, b)
	if got != "[]" {
		t.Fatalf("keyed reorder diff = %s, want [] (primaryKey strategy no longer active)", got)
	}
}

// TestLookupCopyMutationCannotAlterPlan proves that mutating the ArrayPlan
// returned by Plan.Lookup — its scalar fields and its slices — cannot reach the
// plan the patcher relies on (D5).
func TestLookupCopyMutationCannotAlterPlan(t *testing.T) {
	plan := mustPlan(t, keyedPlanSchema, BuildPlanOptions{})

	reorderPreservesEmptyDiff(t, plan) // baseline: strategy active

	ap, ok := plan.Lookup("/items")
	if !ok || ap.Strategy != StrategyPrimaryKey || ap.PrimaryKey != "id" {
		t.Fatalf("Lookup(/items) = %+v, %v; want primaryKey id", ap, ok)
	}

	// Vandalize the returned copy every way a caller could.
	ap.Strategy = StrategyLCS
	ap.PrimaryKey = "zzz"
	ap.RequiredFields = append(ap.RequiredFields, "injected")
	if len(ap.RequiredFields) > 0 {
		ap.RequiredFields[0] = "clobbered"
	}
	ap.HashFields = append(ap.HashFields, "injected")

	// A fresh Lookup must show the pristine plan.
	again, _ := plan.Lookup("/items")
	if again.Strategy != StrategyPrimaryKey || again.PrimaryKey != "id" {
		t.Errorf("Lookup after mutation = %+v; internal plan was mutated", again)
	}
	if len(again.RequiredFields) != 1 || again.RequiredFields[0] != "id" {
		t.Errorf("RequiredFields after mutation = %v; want [id]", again.RequiredFields)
	}

	// And the differ still behaves as if primaryKey were selected.
	reorderPreservesEmptyDiff(t, plan)
}

// TestArrayPlanCopyMutationCannotAlterPlan proves the same for the ArrayPlan
// returned by PlanNode.ArrayPlan() off the trie (D5).
func TestArrayPlanCopyMutationCannotAlterPlan(t *testing.T) {
	plan := mustPlan(t, keyedPlanSchema, BuildPlanOptions{})

	node := plan.Root().Member("items")
	ap := node.ArrayPlan()
	if ap == nil || ap.Strategy != StrategyPrimaryKey || ap.PrimaryKey != "id" {
		t.Fatalf("ArrayPlan() = %+v; want primaryKey id", ap)
	}

	ap.Strategy = StrategyLCS
	ap.PrimaryKey = "zzz"
	if len(ap.RequiredFields) > 0 {
		ap.RequiredFields[0] = "clobbered"
	}
	ap.HashFields = append(ap.HashFields, "injected")

	again := plan.Root().Member("items").ArrayPlan()
	if again.Strategy != StrategyPrimaryKey || again.PrimaryKey != "id" {
		t.Errorf("ArrayPlan() after mutation = %+v; trie plan was mutated", again)
	}

	reorderPreservesEmptyDiff(t, plan)
}

// TestObjectKeysReturnsCopy proves Object.Keys() hands back a copy the caller
// cannot use to mutate the object's member order (D5 related wart).
func TestObjectKeysReturnsCopy(t *testing.T) {
	v, err := Decode([]byte(`{"a":1,"b":2,"c":3}`))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	obj := v.(*Object)

	keys := obj.Keys()
	want := []string{"a", "b", "c"}
	for i, k := range want {
		if keys[i] != k {
			t.Fatalf("Keys()[%d] = %q, want %q", i, keys[i], k)
		}
	}

	// Mutating the returned slice must not disturb the object.
	keys[0] = "HACKED"
	keys = append(keys, "extra")
	_ = keys

	after := obj.Keys()
	if after[0] != "a" || obj.Len() != 3 {
		t.Errorf("object mutated through Keys() copy: keys=%v len=%d", after, obj.Len())
	}
	if k, _ := obj.At(0); k != "a" {
		t.Errorf("At(0) key = %q, want a", k)
	}
}

// TestObjectMembersIterates proves the allocation-free iterator visits every
// member in order and honors early termination.
func TestObjectMembersIterates(t *testing.T) {
	v, _ := Decode([]byte(`{"a":1,"b":2,"c":3}`))
	obj := v.(*Object)

	var order []string
	obj.Members(func(k string, _ Value) bool {
		order = append(order, k)
		return true
	})
	if len(order) != 3 || order[0] != "a" || order[1] != "b" || order[2] != "c" {
		t.Errorf("Members order = %v, want [a b c]", order)
	}

	// Early stop after the first member.
	var stopped []string
	obj.Members(func(k string, _ Value) bool {
		stopped = append(stopped, k)
		return false
	})
	if len(stopped) != 1 || stopped[0] != "a" {
		t.Errorf("Members early-stop visited %v, want [a]", stopped)
	}
}
