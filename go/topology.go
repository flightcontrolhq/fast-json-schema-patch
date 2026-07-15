package schemapatch

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
)

// ArraySemantics is a declared array topology (CORE §8.1.1): the identity
// relation an array's elements are diffed by. Empty means no topology was
// declared and the compatibility derivation (CORE §3.4/§3.5, §8.8) applies.
type ArraySemantics string

const (
	// TopologySequence: order significant, positional identity → LCS (CORE §8.7).
	TopologySequence ArraySemantics = "sequence"
	// TopologySet: value identity, order insignificant → membership (CORE §8.5).
	TopologySet ArraySemantics = "set"
	// TopologyMap: composite key-tuple identity → keyed strategy (CORE §8.4).
	TopologyMap ArraySemantics = "map"
	// TopologyAtomic: any deep difference → one whole-array replace (CORE §8.6).
	TopologyAtomic ArraySemantics = "atomic"
)

// isArrayTopology reports whether s is one of the four declared array topologies.
func isArrayTopology(s string) bool {
	switch ArraySemantics(s) {
	case TopologySequence, TopologySet, TopologyMap, TopologyAtomic:
		return true
	default:
		return false
	}
}

// declaredTopology is the parsed result of the x-schema-patch-* array extensions
// on a single node (CORE §8.2/§8.3.1). order/keys are set only for a map.
type declaredTopology struct {
	topology ArraySemantics
	keys     []string
	order    string
}

// parseArrayTopology parses the declared array-topology extensions on an array
// node (CORE §8.2/§8.3.1) and performs construction-time validation (CORE §8.2.3).
// It returns (nil, nil) when the node declares no x-schema-patch-topology. It
// returns a non-nil error on an unknown topology value, a map without a
// non-empty string keys tuple, or an unknown order value. Stray keys/order on a
// node without a topology, or on a non-map topology, are ignored with a warning.
func parseArrayTopology(obj *Object, warn func(string)) (*declaredTopology, error) {
	tv, hasT := obj.Get("x-schema-patch-topology")
	if !hasT {
		_, hasK := obj.Get("x-schema-patch-keys")
		_, hasO := obj.Get("x-schema-patch-order")
		if hasK || hasO {
			warn("x-schema-patch-keys/-order present without x-schema-patch-topology: ignored (CORE §8.2.3)")
		}
		return nil, nil
	}
	ts, ok := tv.(string)
	if !ok || !isArrayTopology(ts) {
		return nil, fmt.Errorf(
			`schemapatch: x-schema-patch-topology: unknown value %s (expected "sequence" | "set" | "map" | "atomic") (CORE §8.2.3)`,
			describeValue(tv))
	}
	dt := &declaredTopology{topology: ArraySemantics(ts)}
	if ts == "map" {
		kv, hasK := obj.Get("x-schema-patch-keys")
		arr, isArr := kv.([]Value)
		if !hasK || !isArr || len(arr) == 0 {
			return nil, fmt.Errorf(
				`schemapatch: x-schema-patch-topology: "map" REQUIRES a non-empty x-schema-patch-keys array (the key tuple is the identity) (CORE §8.2.3)`)
		}
		keys := make([]string, len(arr))
		for i, e := range arr {
			s, ok := e.(string)
			if !ok {
				return nil, fmt.Errorf(
					"schemapatch: x-schema-patch-keys entries must be strings (member-field names) (CORE §8.2.3)")
			}
			keys[i] = s
		}
		dt.keys = keys
		order := "insignificant"
		if ov, hasO := obj.Get("x-schema-patch-order"); hasO {
			os, ok := ov.(string)
			if !ok || (os != "significant" && os != "insignificant") {
				return nil, fmt.Errorf(
					`schemapatch: x-schema-patch-order: unknown value %s (expected "significant" | "insignificant") (CORE §8.2.3)`,
					describeValue(ov))
			}
			order = os
		}
		dt.order = order
	} else {
		_, hasK := obj.Get("x-schema-patch-keys")
		_, hasO := obj.Get("x-schema-patch-order")
		if hasK || hasO {
			warn(fmt.Sprintf("x-schema-patch-keys/-order on a non-map topology (%s): ignored (CORE §8.2.3)", ts))
		}
	}
	return dt, nil
}

// parseObjectGranularity parses the declared object granularity (CORE §8.2/§8.3.2).
// It returns "" when the node declares none, "granular"/"atomic" when valid, and
// an error on an unknown value.
func parseObjectGranularity(obj *Object) (string, error) {
	gv, has := obj.Get("x-schema-patch-granularity")
	if !has {
		return "", nil
	}
	gs, ok := gv.(string)
	if !ok || (gs != "granular" && gs != "atomic") {
		return "", fmt.Errorf(
			`schemapatch: x-schema-patch-granularity: unknown value %s (expected "granular" | "atomic") (CORE §8.2.3)`,
			describeValue(gv))
	}
	return gs, nil
}

// describeValue renders a schema value for an error message: quoted when a
// string, else Go's default formatting.
func describeValue(v Value) string {
	if s, ok := v.(string); ok {
		return strconv.Quote(s)
	}
	return fmt.Sprintf("%v", v)
}

// declaredTopologyConflict is the construction error for two schema nodes at the
// same document path declaring incompatible topologies (CORE §8.2.2).
func declaredTopologyConflict(path string) error {
	disp := path
	if disp == "" {
		disp = "/"
	}
	return fmt.Errorf(
		"schemapatch: conflicting declared topology at %q: two schema nodes mapping to the same document path declare incompatible x-schema-patch-* semantics (CORE §8.2.2)",
		disp)
}

// resolveTarget resolves docPath to its basePath-relativized plan key, reporting
// whether it is in-base (CORE §3.6.2).
func (b *planBuilder) resolveTarget(docPath string) (string, bool) {
	inBase := b.basePath == "" || docPath == b.basePath || hasPathPrefix(docPath, b.basePath)
	if !inBase {
		return "", false
	}
	if b.basePath != "" {
		return docPath[len(b.basePath):], true
	}
	return docPath, true
}

// hasPathPrefix reports whether docPath lies under base on a segment boundary
// (docPath == base is handled by the caller).
func hasPathPrefix(docPath, base string) bool {
	return len(docPath) > len(base) && docPath[:len(base)] == base && docPath[len(base)] == '/'
}

// registerArrayPlan registers ap at docPath, reconciling with any existing entry
// (CORE §3.7/§8.2.2). A declared topology ALWAYS overrides a compat-derived plan;
// two conflicting declared topologies at one path fail construction; identical
// declarations are idempotent; two compat plans reconcile by strategy rank.
func (b *planBuilder) registerArrayPlan(docPath string, ap *ArrayPlan) {
	target, ok := b.resolveTarget(docPath)
	if !ok {
		return
	}
	existing, exists := b.plan[target]
	if !exists {
		b.plan[target] = ap
		return
	}
	if existing.isRecursionAliasOnly() {
		// An alias-only entry yields to a real plan; the alias itself survives
		// on the winning entry (CORE §3.3.7).
		if !ap.HasRecurseTo {
			ap.RecurseTo, ap.HasRecurseTo = existing.RecurseTo, true
		}
		b.plan[target] = ap
		return
	}
	if existing.Granularity != "" {
		// A declared-atomic object already sits here; an array node is a conflict.
		b.fail(declaredTopologyConflict(target))
		return
	}
	candDeclared := ap.Topology != ""
	existDeclared := existing.Topology != ""
	switch {
	case candDeclared && existDeclared:
		if existing.Topology != ap.Topology ||
			!sameStringSlice(existing.Keys, ap.Keys) ||
			existing.Order != ap.Order {
			b.fail(declaredTopologyConflict(target))
			return
		}
		// identical declaration — idempotent
	case candDeclared:
		// Declared topology ALWAYS wins over a compat-derived plan (CORE §8.2.2).
		mergePlanMetadata(ap, existing)
		b.plan[target] = ap
	case existDeclared:
		// Keep the declared topology; a compat plan never downgrades it.
		mergePlanMetadata(existing, ap)
	default:
		// Neither declared: spec-v1 rank-based reconciliation (CORE §3.7).
		if isBetterPlan(ap, existing) {
			mergePlanMetadata(ap, existing)
			b.plan[target] = ap
		} else {
			mergePlanMetadata(existing, ap)
		}
	}
}

// registerObject registers a declared-atomic object plan at docPath (CORE §8.3.2),
// guarding a conflict with an array plan already registered at the same path.
func (b *planBuilder) registerObject(docPath string) {
	target, ok := b.resolveTarget(docPath)
	if !ok {
		return
	}
	if existing, exists := b.plan[target]; exists && existing.Granularity == "" && !existing.isRecursionAliasOnly() {
		// An array node already registered at this object's path is a conflict.
		// (An alias-only entry is not an assertion about the node itself — the
		// atomic object wins and prunes the subtree, CORE §8.3.3.)
		b.fail(declaredTopologyConflict(target))
		return
	}
	b.plan[target] = &ArrayPlan{Granularity: "atomic"}
}

// registerRecursionAlias records that the subtree at docPath repeats the
// subtree at anchorPath (CORE §3.3.7): the cycle guard cut a re-entry of an
// on-stack schema node short. An existing entry keeps its own plan and merely
// gains the alias; a declared-atomic object ignores it (its subtree is pruned,
// CORE §8.3.3). Both paths must resolve under BasePath.
func (b *planBuilder) registerRecursionAlias(docPath, anchorPath string) {
	target, ok := b.resolveTarget(docPath)
	if !ok {
		return
	}
	anchor, ok := b.resolveTarget(anchorPath)
	if !ok || target == anchor {
		return
	}
	existing, exists := b.plan[target]
	if !exists {
		b.plan[target] = &ArrayPlan{RecurseTo: anchor, HasRecurseTo: true}
		return
	}
	if existing.isObjectPlan() {
		return
	}
	if !existing.HasRecurseTo {
		existing.RecurseTo, existing.HasRecurseTo = anchor, true
	}
}

// fail records the first construction error; later errors are dropped.
func (b *planBuilder) fail(err error) {
	if b.err == nil {
		b.err = err
	}
}

func sameStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// --- map topology: composite-tuple identity and emission (CORE §8.4, GEN §11.4) ---

// encodeTupleKey is the composite-tuple encoding for the map topology (SPEC
// CORE §8.4.3, determinism pin): the canonical serialization of the JSON array
// [e[keys[0]], …, e[keys[t-1]]] in DECLARED key order, using the pinned scalar
// serializer (numbers as canonical f64 text via jsNumberString, standard JSON
// string escaping). Two tuples are the same map key IFF these serializations are
// byte-identical, preserving type-vs-value distinctness ([1] != ["1"]) and
// declared-order significance ([1,2] != [2,1]). The gate (CORE §8.4.2) guarantees
// every component is a string or number, so the encoding is total. For |keys|=1
// this realizes the same identity relation as the spec-v1 primaryKey Map key, so
// single-key map output is byte-identical to spec-v1 primaryKey.
func encodeTupleKey(obj *Object, keys []string) string {
	var buf bytes.Buffer
	buf.WriteByte('[')
	for i, k := range keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		v, _ := obj.Get(k)
		switch x := v.(type) {
		case string:
			encodeString(&buf, x)
		case Number:
			if f, err := x.Float64(); err == nil {
				buf.WriteString(jsNumberString(f))
			} else {
				buf.WriteString(x.text)
			}
		case float64:
			buf.WriteString(jsNumberString(x))
		default:
			// The gate guarantees string|number; defensive only.
			buf.WriteString("null")
		}
	}
	buf.WriteByte(']')
	return buf.String()
}

// isScalarKeyValue reports whether v is an admissible map/primaryKey component:
// a string or a number (CORE §8.4.2(b)). null/bool/array/object are not.
func isScalarKeyValue(v Value) bool {
	switch v.(type) {
	case string, Number, float64:
		return true
	default:
		return false
	}
}

// checkCompositeKeyApplicable is the map per-element applicability gate (SPEC
// CORE §8.4.2). In one O(n+m) pass it verifies (a) every element of both arrays
// is an object; (b) every key field is present with a string|number value; (c/d)
// no duplicate tuple within either array (tuple identity by JSON type-and-value,
// CORE §8.4.1, realized by encodeTupleKey). Any violation → the caller MUST fall
// back to sequence/LCS (GEN §5). For |keys|=1 this is identical to the spec-v1
// primaryKey gate (checkPrimaryKeyApplicable).
func checkCompositeKeyApplicable(arr1, arr2 []Value, keys []string) bool {
	validate := func(arr []Value) bool {
		seen := make(map[string]bool, len(arr))
		for _, item := range arr {
			obj, ok := item.(*Object)
			if !ok {
				return false
			}
			for _, k := range keys {
				v, has := obj.Get(k)
				if !has || !isScalarKeyValue(v) {
					return false
				}
			}
			tk := encodeTupleKey(obj, keys)
			if seen[tk] {
				return false
			}
			seen[tk] = true
		}
		return true
	}
	return validate(arr1) && validate(arr2)
}

// diffArrayByCompositeKey is the map / order-INSIGNIFICANT emission (GEN §11.4,
// CORE §7.2): the spec-v1 three-phase primaryKey strategy (GEN §4.1) generalized
// from a single field to the composite tuple. Emits modifications ++ removals ++
// additions: matched elements recurse field-level at their ORIGINAL index,
// vanished elements become removes in DESCENDING original index, new elements
// become "/-" appends in modified order. For |keys|=1 this is byte-identical to
// diffArrayByPrimaryKey (CORE §8.8.1). The caller guarantees the gate passed.
func (p *Patcher) diffArrayByCompositeKey(arr1, arr2 []Value, keys []string, path string, patches *[]Operation, onMod modCallback) {
	prefix := path + "/"

	// Phase 1: index the original by tuple key.
	keyToIndex := make(map[string]int, len(arr1))
	for i, item := range arr1 {
		keyToIndex[encodeTupleKey(item.(*Object), keys)] = i
	}

	var mods, adds []Operation

	// Phase 2: scan the modified by tuple key.
	for _, newItem := range arr2 {
		obj := newItem.(*Object)
		id := encodeTupleKey(obj, keys)
		oldIndex, found := keyToIndex[id]
		if found {
			delete(keyToIndex, id)
			oldItem := arr1[oldIndex]
			if !DeepEqual(oldItem, newItem) {
				onMod(oldItem, newItem, prefix+strconv.Itoa(oldIndex), &mods, true)
			}
		} else {
			adds = append(adds, p.addOp(prefix+"-", newItem))
		}
	}

	// Phase 3: removals of unmatched originals, descending original index.
	removalIdx := make([]int, 0, len(keyToIndex))
	for _, idx := range keyToIndex {
		removalIdx = append(removalIdx, idx)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(removalIdx)))
	var removals []Operation
	for _, idx := range removalIdx {
		removals = append(removals, p.removeOp(prefix+strconv.Itoa(idx), arr1[idx]))
	}

	// Concatenation order (GEN §4.1.4): modifications ++ removals ++ additions.
	*patches = append(*patches, mods...)
	*patches = append(*patches, removals...)
	*patches = append(*patches, adds...)
}

// diffArrayByCompositeKeyMoves is the map / order-SIGNIFICANT emission (SPEC
// GEN §11.4.2, CORE §7.4). It builds the tuple bijection between surviving
// original indices and their modified targets and hands it to the shared staged
// move-emitter, so survivors are REORDERED into modified order via moves and new
// keys are INDEXED adds — making apply(original, patch) equal modified
// byte-exactly. The move machinery runs UNCONDITIONALLY for this topology
// (independent of the emitMoves option; GEN §8.8). The caller guarantees the gate
// passed.
func (p *Patcher) diffArrayByCompositeKeyMoves(arr1, arr2 []Value, keys []string, path string, patches *[]Operation, onMod modCallback) {
	keyToIndex := make(map[string]int, len(arr1))
	for i, item := range arr1 {
		keyToIndex[encodeTupleKey(item.(*Object), keys)] = i
	}

	var matched []MatchedPair
	var pureInserts []int
	for j, item := range arr2 {
		id := encodeTupleKey(item.(*Object), keys)
		if src, found := keyToIndex[id]; found {
			delete(keyToIndex, id)
			matched = append(matched, MatchedPair{
				Src:     src,
				Tgt:     j,
				Changed: !DeepEqual(arr1[src], arr2[j]),
			})
		} else {
			pureInserts = append(pureInserts, j)
		}
	}

	pureDeletes := make([]int, 0, len(keyToIndex))
	for _, idx := range keyToIndex {
		pureDeletes = append(pureDeletes, idx)
	}

	p.emitArrayMovesPatch(arr1, arr2, path, patches, matched, pureDeletes, pureInserts, onMod)
}

// --- set topology: value identity, gate, and membership emission (CORE §8.5) ---

// checkArraysSetUnique is the set uniqueness gate (CORE §8.5.1): every element of
// each array MUST be unique by deep value (CORE §1.4.1). A deep-equal duplicate in
// either array → the caller MUST fall back to sequence/LCS (GEN §5). Uses the
// canonical fingerprint (stableStringify), which is exact deep-equal for JSON.
func checkArraysSetUnique(arr1, arr2 []Value) bool {
	unique := func(arr []Value) bool {
		seen := make(map[string]bool, len(arr))
		for _, e := range arr {
			fp := stableStringify(e)
			if seen[fp] {
				return false
			}
			seen[fp] = true
		}
		return true
	}
	return unique(arr1) && unique(arr2)
}

// diffArraySet is the set membership emission (GEN §11.3, CORE §8.5). Element
// identity is the element VALUE itself (deep equality); order is insignificant.
// Emit removals of original values ABSENT from modified by DESCENDING original
// index (each with oldValue per includeOldValue), THEN additions of modified
// values ABSENT from original via "/-" append in modified order. No positional
// replaces: survivors receive no op. The caller guarantees the gate passed, so
// "absent from" is unambiguous (multiset = set).
func (p *Patcher) diffArraySet(arr1, arr2 []Value, path string, patches *[]Operation) {
	prefix := "/"
	if path != "" {
		prefix = path + "/"
	}
	fpA := make([]string, len(arr1))
	for i := range arr1 {
		fpA[i] = stableStringify(arr1[i])
	}
	fpB := make([]string, len(arr2))
	for j := range arr2 {
		fpB[j] = stableStringify(arr2[j])
	}
	setA := make(map[string]bool, len(fpA))
	for _, s := range fpA {
		setA[s] = true
	}
	setB := make(map[string]bool, len(fpB))
	for _, s := range fpB {
		setB[s] = true
	}

	// Removals: DESCENDING original index keeps lower survivor indices valid under
	// sequential apply (GEN §11.3.2).
	for i := len(arr1) - 1; i >= 0; i-- {
		if !setB[fpA[i]] {
			*patches = append(*patches, p.removeOp(prefix+strconv.Itoa(i), arr1[i]))
		}
	}
	// Additions: "/-" append in modified order (GEN §11.3.3).
	for j := 0; j < len(arr2); j++ {
		if !setA[fpB[j]] {
			*patches = append(*patches, p.addOp(prefix+"-", arr2[j]))
		}
	}
}
