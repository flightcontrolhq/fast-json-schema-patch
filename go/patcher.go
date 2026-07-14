package schemapatch

import (
	"bytes"
	"math"
	"sort"
	"strconv"
)

// Patcher computes an RFC 6902-style patch (with an added oldValue on
// remove/replace) that transforms one JSON document into another, using a
// schema-derived [Plan] to select per-array diff strategies (GEN). Construct
// one with [NewPatcher] and call [Patcher.Execute]. A Patcher is immutable after
// construction and safe for concurrent use (each Execute call keeps all mutable
// state local).
type Patcher struct {
	plan                     Plan
	planIsEmpty              bool
	includeOldValue          bool
	emitMoves                bool
	wholesaleReplaceFallback bool
	// ignorePaths capability (GEN §10, CONF §5.6). ignorePaths holds the raw
	// pointers set by the IgnorePaths option; NewPatcher compiles+validates them
	// into ignoreRoot (nil when empty/absent -> byte-stable output).
	ignorePaths []string
	ignoreRoot  *ignoreNode
}

// PatcherOption configures a [Patcher] (CONF §5). The defaults reproduce the
// pre-capability output byte-for-byte: oldValue present, no moves, no wholesale
// fallback.
type PatcherOption func(*Patcher)

// IncludeOldValue controls whether every remove/replace op carries the complete
// pre-change subtree in oldValue (CORE §4.4, CONF §5.2). Default true (back-compat).
// When set false, NO emission site attaches oldValue, yielding strict RFC 6902
// ops and measurably smaller patches; invert still round-trips because it
// recovers old values from the original document, not from oldValue.
func IncludeOldValue(b bool) PatcherOption { return func(p *Patcher) { p.includeOldValue = b } }

// EmitMoves enables the emitMoves capability (GEN §8, CONF §5.4). Default false.
// When true, all three array strategies route through the shared move machinery:
// a relocated deep-equal element becomes a single RFC 6902 move instead of a
// remove+add pair, and the unique/primaryKey strategies reconstruct modified
// order exactly.
func EmitMoves(b bool) PatcherOption { return func(p *Patcher) { p.emitMoves = b } }

// WholesaleReplaceFallback enables the wholesaleReplaceFallback capability (SPEC
// GEN §9, CONF §5.5). Default false. When true, each array-diff call site buffers its
// would-be op list and — if the pinned byte estimate exceeds the array's own
// serialized size — discards it in favor of a single whole-array replace.
func WholesaleReplaceFallback(b bool) PatcherOption {
	return func(p *Patcher) { p.wholesaleReplaceFallback = b }
}

// IgnorePaths enables the ignorePaths capability (GEN §10, CONF §5.6): a set of
// object-member JSON Pointers whose subtrees are treated as EQUAL in both
// directions — no ops at or beneath a matched location, in any strategy. An
// array level is matched only by a "*" wildcard; a literal array-index or "-"
// segment, a rootless/empty pointer, or a pointer covering a plan primaryKey
// field makes [NewPatcher] return a non-nil error (GEN §10.1/GEN §10.7). Default
// empty (byte-stable). Modeled on wI2L/jsondiff's Ignores.
func IgnorePaths(paths ...string) PatcherOption {
	return func(p *Patcher) { p.ignorePaths = append(p.ignorePaths, paths...) }
}

// NewPatcher returns a [Patcher] over plan (build one with [BuildPlan], or pass
// an empty [Plan] for schemaless diffing where every array uses lcs). Options
// override the defaults documented on each [PatcherOption]. It returns a non-nil
// error only when [IgnorePaths] was given an invalid pointer, or a pointer that
// covers a plan primaryKey field (GEN §10.1/GEN §10.7); with no ignore paths
// the error is always nil.
func NewPatcher(plan Plan, opts ...PatcherOption) (*Patcher, error) {
	p := &Patcher{
		plan:            plan,
		planIsEmpty:     plan.Len() == 0,
		includeOldValue: true, // CORE §4.4.1: default on for back-compat.
	}
	for _, o := range opts {
		o(p)
	}
	// Compile+validate ignorePaths after all options are applied (GEN §10.1).
	root, err := compileIgnoreTrie(p.ignorePaths)
	if err != nil {
		return nil, err
	}
	p.ignoreRoot = root
	if root != nil {
		if err := validatePrimaryKeysNotIgnored(p.plan, root); err != nil {
			return nil, err
		}
	}
	return p, nil
}

// Execute computes the patch transforming original into modified (GEN). It
// walks both documents in lockstep from the root path "", dispatching per GEN §1.
// The returned slice is empty (never nil-panicking) when the documents are
// deep-equal. Inputs MUST be [Value]-model JSON (the output of [Decode] or
// [FromAny]); behavior on non-JSON dynamic types is out of scope (CORE §1.1.2).
func (p *Patcher) Execute(original, modified Value) []Operation {
	var patches []Operation
	// Thread the compiled plan trie from the root (GEN §4.5); an empty plan threads
	// a nil node so every array falls to lcs.
	var node *PlanNode
	if !p.planIsEmpty {
		node = p.plan.Root()
	}
	// Thread the ignore trie from the root in parallel with the plan trie (SPEC
	// GEN §10.2); nil when no ignore paths were given.
	p.diff(original, modified, "", &patches, node, p.ignoreRoot)
	return patches
}

// diff dispatches a value pair at path per GEN §1. It is only ever called
// with both sides present (object add/remove are emitted directly by the parent
// container); the absent cases of the reference are unreachable for the
// [Value]-model JSON contract.
func (p *Patcher) diff(a, b Value, path string, patches *[]Operation, node *PlanNode, ignoreNode *ignoreNode) {
	// ignorePaths (GEN §10.4): a terminal ignore node makes this subtree EQUAL
	// in both directions — emit nothing at or beneath it. Per-member add/remove
	// are guarded in diffObject (which does not route through diff).
	if ignoreNode.terminal() {
		return
	}

	_, aIsArr := a.([]Value)
	_, bIsArr := b.([]Value)

	// GEN §1.4 Type mismatch or primitive: emit a single replace when unequal. The
	// deep-equal check reproduces the reference's === fast path, which for
	// primitives is value equality (equal primitives emit nothing).
	if isPrimitiveValue(a) || isPrimitiveValue(b) || aIsArr != bIsArr {
		if DeepEqual(a, b) {
			return
		}
		*patches = append(*patches, p.replaceOp(path, a, b))
		return
	}

	// GEN §1.5 Both arrays.
	if aIsArr {
		p.diffArray(a.([]Value), b.([]Value), path, patches, node, ignoreNode)
		return
	}

	// GEN §1.6 Both objects.
	p.diffObject(a.(*Object), b.(*Object), path, patches, node, ignoreNode)
}

// diffObject diffs two objects in ECMAScript [[OwnPropertyKeys]] visitation
// order (GEN §2.2): all of original's keys (integer-like ascending, then
// insertion order), followed by keys present only in modified in the same
// ordering.
func (p *Patcher) diffObject(obj1, obj2 *Object, path string, patches *[]Operation, node *PlanNode, ignoreNode *ignoreNode) {
	for _, key := range ecmaOwnKeys(obj1) {
		// ignorePaths (GEN §10.3/GEN §10.4): a terminal child ignore node means
		// this member is EQUAL — emit no remove/recursion (add/remove are pushed
		// here without routing through diff, so the check must be at this site).
		childIgnore := ignoreNode.member(key)
		if childIgnore.terminal() {
			continue
		}
		newPath := path + "/" + EscapeToken(key)
		val1, _ := obj1.Get(key) // present: key is an own member of obj1
		val2, has2 := obj2.Get(key)
		if !has2 {
			*patches = append(*patches, p.removeOp(newPath, val1))
			continue
		}
		// Descend the trie by RAW property key: an exact child edge takes
		// precedence over the wildcard at each level (GEN §4.5.2).
		p.diff(val1, val2, newPath, patches, node.Member(key), childIgnore)
	}

	for _, key := range ecmaOwnKeys(obj2) {
		if _, present := obj1.Get(key); present {
			continue // already visited in pass 1
		}
		// A modified-only member under a terminal ignore node emits no add.
		if ignoreNode.member(key).terminal() {
			continue
		}
		val2, _ := obj2.Get(key)
		*patches = append(*patches, p.addOp(path+"/"+EscapeToken(key), val2))
	}
}

// diffArray applies the wholesaleReplaceFallback wrapper (GEN §9) around the
// strategy dispatch. With the capability off it dispatches straight into patches
// (byte-identical output); with it on it buffers locally, applies the pinned
// byte estimate, and either flushes the granular ops or emits a single
// whole-array replace.
func (p *Patcher) diffArray(arr1, arr2 []Value, path string, patches *[]Operation, node *PlanNode, ignoreNode *ignoreNode) {
	// ignorePaths (GEN §10.4): an ignore entry ending at the array-element
	// level (e.g. `/arr/*`) makes EVERY element — and thus the whole array —
	// equal, in any strategy. Short-circuit to no ops.
	if ignoreNode.item().terminal() {
		return
	}
	// ignorePaths interaction (GEN §10.6): if any ignore terminal lies BENEATH
	// this array, a wholesale replace would leak ignored content into its value —
	// so the capability is DISABLED for that array and the ignore-filtered
	// granular stream is kept.
	if !p.wholesaleReplaceFallback || ignoreSubtreeHasTerminal(ignoreNode) {
		p.dispatchArrayStrategy(arr1, arr2, path, patches, node, ignoreNode)
		return
	}
	var local []Operation
	p.dispatchArrayStrategy(arr1, arr2, path, &local, node, ignoreNode)
	estimate := estimatePatchBytes(local)
	threshold := jsStringifyLen(arr2)
	if estimate > threshold { // strict >: a tie keeps the granular ops (GEN §9.3)
		*patches = append(*patches, p.replaceOp(path, arr1, arr2))
		return
	}
	*patches = append(*patches, local...)
}

// dispatchArrayStrategy selects and runs the array-diff strategy for one array
// (GEN §3). Strategy is read straight off the trie node; the runtime gates
// (GEN §3.2) may still force an LCS fallback.
func (p *Patcher) dispatchArrayStrategy(arr1, arr2 []Value, path string, patches *[]Operation, node *PlanNode, ignoreNode *ignoreNode) {
	plan := node.arrayPlan()
	strategy := StrategyLCS
	if plan != nil && plan.Strategy != "" {
		strategy = plan.Strategy
	}

	// The item-level ignore node: descending into an array element consumes one
	// wildcard "*" (the array index level, GEN §10.3). Every element advances
	// the same way, so this is used both for element recursion and for the
	// ignore-filtered LCS interning.
	itemIgnore := ignoreNode.item()

	// The modification callback recurses a matched element pair, threading the
	// correct child node: a nested-array element descends to the wildcard child
	// (the inner array's plan at ${path}/*, CORE §3.3.5); an object element stays at
	// THIS array's node (item property plans are its children, CORE §3.3.3). The
	// element's ignore node is ALWAYS itemIgnore (the array wildcard, GEN §10.3).
	onMod := func(oldVal, newVal Value, cbPath string, cbPatches *[]Operation, skipEqualityCheck bool) {
		var elementNode *PlanNode
		_, oa := oldVal.([]Value)
		_, na := newVal.([]Value)
		if oa && na {
			elementNode = node.Wildcard()
		} else {
			elementNode = node
		}
		p.refine(oldVal, newVal, cbPath, cbPatches, skipEqualityCheck, elementNode, itemIgnore)
	}

	// primaryKey applicability gate (GEN §4.3). A primaryKeyMap override selects the
	// strategy but does NOT bypass this gate.
	if strategy == StrategyPrimaryKey && plan.PrimaryKey != "" &&
		checkPrimaryKeyApplicable(arr1, arr2, plan.PrimaryKey) {
		if p.emitMoves {
			p.diffArrayByPrimaryKeyMoves(arr1, arr2, plan.PrimaryKey, path, patches, onMod)
			return
		}
		p.diffArrayByPrimaryKey(arr1, arr2, plan.PrimaryKey, path, patches, onMod)
		return
	}

	if strategy == StrategyUnique && checkArraysUnique(arr1, arr2) {
		if p.emitMoves && p.diffArrayUniqueMoves(arr1, arr2, path, patches, onMod) {
			return
		}
		p.diffArrayUnique(arr1, arr2, path, patches)
		return
	}

	p.diffArrayLCS(arr1, arr2, path, patches, onMod, itemIgnore)
}

// refine recurses a matched element pair back through diff (GEN §5.4.2 /
// GEN §4.1.2). Every real call site passes skipEqualityCheck=true (the pair is
// already known to differ); the equality-gated branch is retained for parity
// with the reference.
func (p *Patcher) refine(oldVal, newVal Value, path string, patches *[]Operation, skipEqualityCheck bool, node *PlanNode, ignoreNode *ignoreNode) {
	if !skipEqualityCheck && DeepEqual(oldVal, newVal) {
		return
	}
	p.diff(oldVal, newVal, path, patches, node, ignoreNode)
}

// --- op builders (honor includeOldValue) ---

func (p *Patcher) addOp(path string, value Value) Operation {
	return Operation{Op: OpAdd, Path: path, Value: value, HasValue: true}
}

func (p *Patcher) removeOp(path string, oldValue Value) Operation {
	op := Operation{Op: OpRemove, Path: path}
	if p.includeOldValue {
		op.OldValue = oldValue
		op.HasOldValue = true
	}
	return op
}

func (p *Patcher) replaceOp(path string, oldValue, value Value) Operation {
	op := Operation{Op: OpReplace, Path: path, Value: value, HasValue: true}
	if p.includeOldValue {
		op.OldValue = oldValue
		op.HasOldValue = true
	}
	return op
}

// --- helpers ---

// isPrimitiveValue reports whether v is a JSON primitive (null, bool, string,
// number) rather than a container (GEN §1.4).
func isPrimitiveValue(v Value) bool {
	switch v.(type) {
	case nil, bool, string, Number, float64:
		return true
	default:
		return false
	}
}

// sameContainerKind reports whether a and b are the same container kind — both
// objects or both arrays — the condition for granular descent (GEN §5.4.2).
// A primitive, a null, or a mismatched object/array pair returns false.
func sameContainerKind(a, b Value) bool {
	_, ao := a.(*Object)
	_, bo := b.(*Object)
	if ao && bo {
		return true
	}
	_, aa := a.([]Value)
	_, ba := b.([]Value)
	return aa && ba
}

// ecmaOwnKeys returns obj's member keys in ECMAScript [[OwnPropertyKeys]] order
// (CORE §1.3.2): integer-like keys first in ascending numeric order, then every
// remaining key in insertion order. When obj has no integer-like key the
// decoded insertion order already matches, so the internal key slice is returned
// directly (read-only).
func ecmaOwnKeys(obj *Object) []string {
	all := obj.keys // same-package read; not exposed to callers
	type ik struct {
		v uint32
		s string
	}
	var ints []ik
	var rest []string
	for _, k := range all {
		if v, ok := arrayIndexKey(k); ok {
			ints = append(ints, ik{v: v, s: k})
		} else {
			rest = append(rest, k)
		}
	}
	if len(ints) == 0 {
		return all // insertion order already equals ECMAScript order
	}
	sort.Slice(ints, func(i, j int) bool { return ints[i].v < ints[j].v })
	out := make([]string, 0, len(all))
	for _, x := range ints {
		out = append(out, x.s)
	}
	out = append(out, rest...)
	return out
}

// arrayIndexKey reports whether s is integer-like per CORE §1.3.2 — the canonical
// decimal string of an index in 0..2^32-2 (no leading zeros, no sign, no other
// numeric form) — and returns its numeric value.
func arrayIndexKey(s string) (uint32, bool) {
	if s == "" {
		return 0, false
	}
	if s == "0" {
		return 0, true
	}
	if s[0] < '1' || s[0] > '9' {
		return 0, false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, false
		}
	}
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil || n > (1<<32)-2 {
		return 0, false
	}
	return uint32(n), true
}

// --- wholesaleReplaceFallback byte accounting (GEN §9.2) ---

// estimatePatchBytes is the pinned per-op byte estimate (GEN §9.2): 30 bytes
// fixed overhead per op, plus the serialized length of value and oldValue when
// present. move ops (neither present) contribute only the 30. It is a cheap
// deterministic stand-in for the serialized patch size, NOT the exact length.
func estimatePatchBytes(ops []Operation) int {
	total := 0
	for i := range ops {
		op := &ops[i]
		total += 30
		if op.HasValue {
			total += jsStringifyLen(op.Value)
		}
		if op.HasOldValue {
			total += jsStringifyLen(op.OldValue)
		}
	}
	return total
}

// jsStringifyLen returns the byte length of v serialized the way JavaScript's
// JSON.stringify would, which is what the GEN §9 estimate and threshold are
// defined against (see the spec-defect note in the port report): numbers are
// re-serialized at f64 with ECMAScript formatting rather than echoed from their
// preserved literal text, so the cutover decision matches the JS reference.
func jsStringifyLen(v Value) int {
	var buf bytes.Buffer
	jsStringify(&buf, v)
	return buf.Len()
}

// jsStringify writes v to buf mimicking JavaScript JSON.stringify byte output.
// Object member order does not affect the byte COUNT (GEN §9.4), so insertion
// order is used. Numbers use [jsNumberString]; strings reuse the value model's
// JSON string encoder (which matches JSON.stringify escaping).
func jsStringify(buf *bytes.Buffer, v Value) {
	switch x := v.(type) {
	case nil:
		buf.WriteString("null")
	case bool:
		if x {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case string:
		encodeString(buf, x)
	case Number:
		if f, err := x.Float64(); err == nil {
			buf.WriteString(jsNumberString(f))
		} else {
			buf.WriteString(x.text)
		}
	case float64:
		buf.WriteString(jsNumberString(x))
	case []Value:
		buf.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			jsStringify(buf, e)
		}
		buf.WriteByte(']')
	case *Object:
		buf.WriteByte('{')
		for i := range x.keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			encodeString(buf, x.keys[i])
			buf.WriteByte(':')
			jsStringify(buf, x.vals[i])
		}
		buf.WriteByte('}')
	default:
		buf.WriteString("null")
	}
}

// jsNumberString formats f the way JavaScript's Number-to-string (and therefore
// JSON.stringify) would: the shortest round-tripping decimal, with ECMAScript's
// exponent thresholds (exponential form only when the decimal exponent is >= 21
// or <= -7, and a '+' sign on positive exponents, e.g. 1e+21). This differs from
// Go's strconv 'g' formatting and from the value model's preserved literal text;
// it is used ONLY for the GEN §9 byte accounting, never for emitted op values.
func jsNumberString(f float64) string {
	if f == 0 {
		return "0" // JSON.stringify(-0) === "0"
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null" // not representable in JSON
	}
	neg := f < 0
	if neg {
		f = -f
	}
	// Shortest decimal in scientific form: "d", "d.ddd", each with an exponent.
	b := strconv.AppendFloat(nil, f, 'e', -1, 64)
	s := string(b)
	eIdx := -1
	for i := 0; i < len(s); i++ {
		if s[i] == 'e' {
			eIdx = i
			break
		}
	}
	mant := s[:eIdx]
	exp, _ := strconv.Atoi(s[eIdx+1:])
	digits := mant
	if dot := indexByteLocal(mant, '.'); dot >= 0 {
		digits = mant[:dot] + mant[dot+1:]
	}
	k := len(digits)
	// value = digits x 10^(exp-(k-1)); ECMAScript n satisfies value = s x 10^(n-k),
	// so n = exp + 1.
	n := exp + 1

	var out string
	switch {
	case k <= n && n <= 21:
		out = digits + repeatZeros(n-k)
	case 0 < n && n <= 21:
		out = digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		out = "0." + repeatZeros(-n) + digits
	default:
		var m string
		if k == 1 {
			m = digits
		} else {
			m = digits[:1] + "." + digits[1:]
		}
		e := n - 1
		if e >= 0 {
			out = m + "e+" + strconv.Itoa(e)
		} else {
			out = m + "e-" + strconv.Itoa(-e)
		}
	}
	if neg {
		out = "-" + out
	}
	return out
}

func repeatZeros(n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = '0'
	}
	return string(b)
}

func indexByteLocal(s string, c byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == c {
			return i
		}
	}
	return -1
}
