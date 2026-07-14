package schemapatch

import (
	"bytes"
	"sort"
	"strconv"
	"strings"
)

// Strategy names the array-diff algorithm a [Plan] selects for an array path
// (SPEC §4.1). Its string values are the normative tokens compared by the
// plan-snapshot conformance vectors (SPEC §10.6).
type Strategy string

const (
	// StrategyPrimaryKey diffs a keyed array of objects by a primary-key field
	// (SPEC §5.4).
	StrategyPrimaryKey Strategy = "primaryKey"
	// StrategyUnique diffs an array of unique primitives by position (SPEC §5.6).
	StrategyUnique Strategy = "unique"
	// StrategyLCS diffs by shortest edit script (SPEC §5.5). It is the default
	// and the universal fallback.
	StrategyLCS Strategy = "lcs"
)

// ArrayPlan is the derived diff strategy for one array document path (SPEC
// §4.1). PrimaryKey, Strategy, and RequiredFields are output-relevant; HashFields
// is a non-normative prefilter hint (SPEC §4.1.1, §5.4.4).
type ArrayPlan struct {
	// PrimaryKey is the key field for StrategyPrimaryKey, or "" (meaning null)
	// for unique/lcs arrays.
	PrimaryKey string
	// Strategy is the selected array-diff algorithm.
	Strategy Strategy
	// RequiredFields is the item schema's required[] set, in schema order
	// (deduplicated); nil when auto-detection did not run or found no key. It is
	// compared order-insensitively by the §10.6 vectors.
	RequiredFields []string
	// HashFields is the subset of RequiredFields whose declared type is string
	// or number, in RequiredFields order (SPEC §4.5.4). A prefilter hint only
	// (§5.4.6); MUST be output-neutral. nil when empty.
	HashFields []string
}

// Plan maps document paths to array strategies, derived once from a JSON Schema
// by [BuildPlan] and reused across diffs (SPEC §4). It holds both the flat
// path→[ArrayPlan] map (queryable with [Plan.Lookup]) and the compiled trie
// (SPEC §5.4.5) the differ threads for structural strategy selection.
type Plan struct {
	paths map[string]*ArrayPlan
	root  *PlanNode
}

// PlanNode is one node of the compiled plan trie (SPEC §5.4.5.1). The differ
// threads a node down its recursion instead of normalizing concrete path
// strings. All accessors are nil-receiver-safe so a caller can thread a nil node
// (the "empty plan threads no node" case, §5.4.5.2) without branching.
type PlanNode struct {
	plan     *ArrayPlan
	children map[string]*PlanNode
	wildcard *PlanNode
}

// ArrayPlan returns the strategy registered at this node, or nil when the node
// carries no plan (SPEC §5.4.5.3: absent plan ⇒ lcs).
func (n *PlanNode) ArrayPlan() *ArrayPlan {
	if n == nil {
		return nil
	}
	return n.plan
}

// Member advances the trie for an object member key (SPEC §5.4.5.2): the exact
// child edge for key if present, else the wildcard edge, else nil. Exact edges
// take precedence over the wildcard at every level.
func (n *PlanNode) Member(key string) *PlanNode {
	if n == nil {
		return nil
	}
	if c, ok := n.children[key]; ok {
		return c
	}
	return n.wildcard
}

// Wildcard advances the trie for a nested-array element (array-of-arrays, SPEC
// §5.4.5.2 / §4.3.5): the node's wildcard edge, or nil.
func (n *PlanNode) Wildcard() *PlanNode {
	if n == nil {
		return nil
	}
	return n.wildcard
}

// Lookup returns the [ArrayPlan] registered at path in the flat map and whether
// one exists. It is a direct map probe; the differ uses the trie ([Plan.Root])
// instead, but Lookup is convenient for tests and introspection.
func (p Plan) Lookup(path string) (*ArrayPlan, bool) {
	ap, ok := p.paths[path]
	return ap, ok
}

// Paths returns the document paths that carry a plan, in unspecified order.
func (p Plan) Paths() []string {
	out := make([]string, 0, len(p.paths))
	for k := range p.paths {
		out = append(out, k)
	}
	return out
}

// Len returns the number of array paths in the plan.
func (p Plan) Len() int { return len(p.paths) }

// Root returns the trie root for structural strategy selection (SPEC §5.4.5.2).
// It is nil for an empty plan ("an empty plan threads no node").
func (p Plan) Root() *PlanNode { return p.root }

// BuildPlanOptions configures [BuildPlan] (SPEC §4.2, §4.5.5, §4.3.4).
type BuildPlanOptions struct {
	// PrimaryKeyMap overrides the strategy per document path: a path present
	// here is diffed by StrategyPrimaryKey on the given key, bypassing
	// auto-detection and the primitive check (SPEC §4.4.3). The path is the full
	// path from the root (before any BasePath relativization).
	PrimaryKeyMap map[string]string
	// BasePath restricts and relativizes plan keys to the subtree at or under it
	// on a segment boundary (SPEC §4.6). Empty means no restriction.
	BasePath string
	// PrimaryKeyCandidates replaces the ordered auto-detection candidate list
	// (SPEC §4.5.3, §4.5.5). nil selects the default ["id","name","port"]; a
	// non-nil empty slice disables auto-detection entirely.
	PrimaryKeyCandidates []string
	// OnWarning, when non-nil, receives a message for each unsupported (non-local
	// or unresolvable) $ref encountered during traversal (SPEC §4.3.4). The
	// default is silent.
	OnWarning func(message string)
}

// defaultPrimaryKeyCandidates is the SPEC §4.5.3 default candidate list.
var defaultPrimaryKeyCandidates = []string{"id", "name", "port"}

// BuildPlan derives a [Plan] from a JSON Schema (SPEC §4). schema is a decoded
// [Value] (typically a *[Object]); traversal keys off the shape keywords
// (properties/additionalProperties/items) regardless of an explicit type (SPEC
// §4.3.1). The error return is reserved for future input validation; the current
// implementation never fails, mirroring the reference buildPlan.
func BuildPlan(schema Value, opts BuildPlanOptions) (Plan, error) {
	candidates := opts.PrimaryKeyCandidates
	if candidates == nil {
		candidates = defaultPrimaryKeyCandidates
	}
	b := &planBuilder{
		root:          schema,
		plan:          make(map[string]*ArrayPlan),
		primaryKeyMap: opts.PrimaryKeyMap,
		basePath:      opts.BasePath,
		candidates:    candidates,
		onWarning:     opts.OnWarning,
	}
	b.traverse(schema, "", make(map[*Object]bool))
	return Plan{paths: b.plan, root: b.buildTrie()}, nil
}

type planBuilder struct {
	root          Value
	plan          map[string]*ArrayPlan
	primaryKeyMap map[string]string
	basePath      string
	candidates    []string
	onWarning     func(string)
}

func (b *planBuilder) warn(msg string) {
	if b.onWarning != nil {
		b.onWarning(msg)
	}
}

// traverse walks a schema node, accumulating an escaped document path and
// registering array plans (SPEC §4.3). visited guards against $ref cycles by
// schema-node identity: a node on the current stack is not re-entered and is
// removed when its subtree completes (SPEC §4.3).
func (b *planBuilder) traverse(sub Value, docPath string, visited map[*Object]bool) {
	obj, ok := sub.(*Object)
	if !ok {
		return
	}
	if visited[obj] {
		return
	}
	visited[obj] = true
	defer delete(visited, obj)

	// $ref: resolve local references only; a non-local/unresolvable ref skips
	// this node and its subtree (SPEC §4.3.4). Resolving does not change docPath.
	if ref, ok := stringProp(obj, "$ref"); ok && ref != "" {
		if resolved := b.resolveRef(ref); resolved != nil {
			b.traverse(resolved, docPath, visited)
		}
		return
	}

	// anyOf/oneOf/allOf: traverse every branch at the current path, deduplicated
	// by structural fingerprint within each keyword's own branch list (SPEC §4.3.6).
	for _, kw := range [...]string{"anyOf", "oneOf", "allOf"} {
		branches, ok := arrayProp(obj, kw)
		if !ok {
			continue
		}
		seen := make(map[string]bool)
		for _, s := range branches {
			fp := stableStringify(s)
			if seen[fp] {
				continue
			}
			seen[fp] = true
			b.traverse(s, docPath, visited)
		}
	}

	// Object node: recurse into properties (schema key order) and, if
	// additionalProperties is a schema, into the "*" wildcard segment (SPEC §4.3.2).
	if props, ok := obj.Get("properties"); ok {
		if p, ok := props.(*Object); ok {
			for i := 0; i < p.Len(); i++ {
				k, v := p.At(i)
				b.traverse(v, docPath+"/"+EscapeToken(k), visited)
			}
		}
	}
	if ap, ok := obj.Get("additionalProperties"); ok {
		if apObj, ok := ap.(*Object); ok {
			b.traverse(apObj, docPath+"/*", visited)
		}
	}

	// Array node: build and register an ArrayPlan, then recurse into items
	// (SPEC §4.3.3, §4.3.5).
	if items, ok := obj.Get("items"); ok && truthy(items) {
		b.registerArray(obj, items, docPath, visited)
	}
}

// registerArray constructs the ArrayPlan for an array node, registers it subject
// to basePath, and recurses into the item schema (SPEC §4.4, §4.6, §4.3.5).
func (b *planBuilder) registerArray(_ *Object, items Value, docPath string, visited map[*Object]bool) {
	// Resolve a leading $ref on items once (SPEC §4.4); keep the original on
	// failure.
	itemsSchema := items
	if io, ok := items.(*Object); ok {
		if ref, ok := stringProp(io, "$ref"); ok && ref != "" {
			if resolved := b.resolveRef(ref); resolved != nil {
				itemsSchema = resolved
			}
		}
	}

	plan := &ArrayPlan{Strategy: StrategyLCS}

	// Primitive items → unique (SPEC §4.4.2).
	isPrimitive := false
	if it, ok := itemsSchema.(*Object); ok {
		if t, ok := stringProp(it, "type"); ok {
			isPrimitive = t == "string" || t == "number" || t == "boolean"
		}
	}
	if isPrimitive {
		plan.Strategy = StrategyUnique
	}

	// primaryKeyMap override (SPEC §4.4.3), else auto-detect for object items (§4.5).
	customKey := ""
	if b.primaryKeyMap != nil {
		customKey = b.primaryKeyMap[docPath]
	}
	if customKey != "" {
		plan.PrimaryKey = customKey
		plan.Strategy = StrategyPrimaryKey
	} else if !isPrimitive {
		if md := b.detectKey(itemsSchema); md != nil {
			plan.PrimaryKey = md.primaryKey
			plan.RequiredFields = md.requiredFields
			plan.HashFields = md.hashFields
			plan.Strategy = StrategyPrimaryKey
		}
	}

	b.register(docPath, plan)

	// Recurse into items. An array-of-arrays inner array registers at a distinct
	// "*" wildcard path so it never overwrites the outer plan (SPEC §4.3.5).
	nextPath := docPath
	if it, ok := itemsSchema.(*Object); ok {
		inner, hasItems := it.Get("items")
		if (hasItems && truthy(inner)) || isType(it, "array") {
			nextPath = docPath + "/*"
		}
	}
	b.traverse(items, nextPath, visited)
}

// register inserts plan at the basePath-relativized key, reconciling with any
// existing plan by strategy rank (SPEC §4.6.2, §4.7).
func (b *planBuilder) register(docPath string, plan *ArrayPlan) {
	inBase := b.basePath == "" || docPath == b.basePath || strings.HasPrefix(docPath, b.basePath+"/")
	if !inBase {
		return
	}
	target := docPath
	if b.basePath != "" {
		target = docPath[len(b.basePath):]
	}

	existing, ok := b.plan[target]
	switch {
	case !ok:
		b.plan[target] = plan
	case isBetterPlan(plan, existing):
		mergePlanMetadata(plan, existing)
		b.plan[target] = plan
	default:
		mergePlanMetadata(existing, plan)
	}
}

// keyMetadata is the result of a successful primary-key detection (SPEC §4.5.4).
type keyMetadata struct {
	primaryKey     string
	requiredFields []string
	hashFields     []string
}

// detectKey runs primary-key auto-detection over an object item schema (SPEC
// §4.5). anyOf/oneOf branches are examined in order; the first branch that
// yields a key wins.
func (b *planBuilder) detectKey(itemsSchema Value) *keyMetadata {
	it, ok := itemsSchema.(*Object)
	if !ok {
		return nil
	}
	branches, ok := arrayProp(it, "anyOf")
	if !ok {
		branches, ok = arrayProp(it, "oneOf")
	}
	if ok {
		var md *keyMetadata
		for _, s := range branches {
			md = b.findMetadata(s)
			if md != nil {
				break
			}
		}
		return md
	}
	return b.findMetadata(itemsSchema)
}

// findMetadata reduces a candidate schema by the allOf merge (SPEC §4.5.1.1) and
// checks the candidate key list against its required string/number properties
// (SPEC §4.5.2, §4.5.3). It returns nil when no key qualifies.
func (b *planBuilder) findMetadata(s Value) *keyMetadata {
	if _, ok := s.(*Object); !ok {
		return nil
	}
	cur, ok := b.mergeAllOf(s).(*Object)
	if !ok {
		return nil
	}
	if t, _ := stringProp(cur, "type"); t != "object" {
		return nil
	}
	propsVal, ok := cur.Get("properties")
	if !ok {
		return nil
	}
	props, ok := propsVal.(*Object)
	if !ok {
		return nil
	}

	required := requiredList(cur)
	requiredSet := make(map[string]bool, len(required))
	for _, r := range required {
		requiredSet[r] = true
	}

	// hashFields: required fields whose type is string/number, in required order.
	var hashFields []string
	for _, key := range required {
		if isStringOrNumberProp(props, key) {
			hashFields = append(hashFields, key)
		}
	}

	for _, key := range b.candidates {
		if requiredSet[key] && isStringOrNumberProp(props, key) {
			return &keyMetadata{
				primaryKey:     key,
				requiredFields: required,
				hashFields:     hashFields,
			}
		}
	}
	return nil
}

// mergeAllOf reduces a schema to a single synthetic object view, unioning allOf
// branch properties/required (SPEC §4.5.1.1). A schema without allOf is returned
// unchanged; a leading $ref is resolved (kept unchanged on failure).
func (b *planBuilder) mergeAllOf(s Value) Value {
	cur := s
	if o, ok := cur.(*Object); ok {
		if ref, ok := stringProp(o, "$ref"); ok && ref != "" {
			resolved := b.resolveRef(ref)
			if resolved == nil {
				return cur
			}
			cur = resolved
		}
	}
	co, ok := cur.(*Object)
	if !ok {
		return cur
	}
	allOf, ok := arrayProp(co, "allOf")
	if !ok {
		return cur
	}

	mergedProps := NewObject()
	if p, ok := co.Get("properties"); ok {
		if po, ok := p.(*Object); ok {
			for i := 0; i < po.Len(); i++ {
				k, v := po.At(i)
				mergedProps.Set(k, v)
			}
		}
	}
	mergedRequired := requiredList(co)
	reqSeen := make(map[string]bool, len(mergedRequired))
	for _, r := range mergedRequired {
		reqSeen[r] = true
	}

	for _, branch := range allOf {
		view, ok := b.mergeAllOf(branch).(*Object)
		if !ok {
			continue
		}
		if vp, ok := view.Get("properties"); ok {
			if vpo, ok := vp.(*Object); ok {
				for i := 0; i < vpo.Len(); i++ {
					k, v := vpo.At(i)
					mergedProps.Set(k, v) // later branches override earlier
				}
			}
		}
		for _, r := range requiredList(view) {
			if !reqSeen[r] {
				reqSeen[r] = true
				mergedRequired = append(mergedRequired, r)
			}
		}
	}

	out := NewObject()
	out.Set("type", "object")
	out.Set("properties", mergedProps)
	reqArr := make([]Value, len(mergedRequired))
	for i, r := range mergedRequired {
		reqArr[i] = r
	}
	out.Set("required", reqArr)
	return out
}

// resolveRef resolves a local "#/..." JSON Pointer into the root schema by
// walking raw (non-unescaped) "/"-split segments, matching the reference (SPEC
// §4.3.4). A non-local or unresolvable ref returns nil (and warns for non-local).
func (b *planBuilder) resolveRef(ref string) Value {
	if !strings.HasPrefix(ref, "#/") {
		b.warn("Unsupported reference: " + ref)
		return nil
	}
	parts := strings.Split(ref[2:], "/")
	cur := b.root
	for _, part := range parts {
		switch c := cur.(type) {
		case *Object:
			v, ok := c.Get(part)
			if !ok {
				return nil
			}
			cur = v
		case []Value:
			idx, ok := ParseArrayIndex(part)
			if !ok || idx < 0 || idx >= len(c) {
				return nil
			}
			cur = c[idx]
		default:
			return nil
		}
	}
	return cur
}

// buildTrie compiles the flat plan map into the matching trie (SPEC §5.4.5.1).
// Returns nil for an empty plan.
func (b *planBuilder) buildTrie() *PlanNode {
	if len(b.plan) == 0 {
		return nil
	}
	root := &PlanNode{}
	for path, ap := range b.plan {
		node := root
		for _, seg := range planKeySegments(path) {
			if seg == "*" {
				if node.wildcard == nil {
					node.wildcard = &PlanNode{}
				}
				node = node.wildcard
				continue
			}
			key := UnescapeToken(seg)
			if node.children == nil {
				node.children = make(map[string]*PlanNode)
			}
			child := node.children[key]
			if child == nil {
				child = &PlanNode{}
				node.children[key] = child
			}
			node = child
		}
		node.plan = ap
	}
	return root
}

// planKeySegments splits a plan key on "/" (SPEC §5.4.5.1). The empty key ""
// yields no segments (terminating at the root node).
func planKeySegments(path string) []string {
	if path == "" {
		return nil
	}
	// Plan keys always begin with "/" (property/wildcard segments) except the
	// empty root key handled above.
	return strings.Split(path[1:], "/")
}

// isBetterPlan reports whether candidate should displace current by strategy
// rank, primaryKey presence, then hashField count (SPEC §4.7.1–§4.7.3).
func isBetterPlan(candidate, current *ArrayPlan) bool {
	ra, rb := strategyRank(candidate.Strategy), strategyRank(current.Strategy)
	if ra != rb {
		return ra > rb
	}
	if candidate.PrimaryKey != "" && current.PrimaryKey == "" {
		return true
	}
	if candidate.PrimaryKey == "" && current.PrimaryKey != "" {
		return false
	}
	return len(candidate.HashFields) > len(current.HashFields)
}

func strategyRank(s Strategy) int {
	switch s {
	case StrategyPrimaryKey:
		return 3
	case StrategyUnique:
		return 2
	default:
		return 1
	}
}

// mergePlanMetadata folds supplemental metadata from src into dst in place (SPEC
// §4.7.4): hashFields become the set-union (dst order first), and requiredFields
// are taken from src when dst lacks them.
func mergePlanMetadata(dst, src *ArrayPlan) {
	if dst.HashFields == nil && src.HashFields != nil {
		dst.HashFields = append([]string(nil), src.HashFields...)
	}
	if dst.HashFields != nil && src.HashFields != nil {
		seen := make(map[string]bool, len(dst.HashFields))
		for _, f := range dst.HashFields {
			seen[f] = true
		}
		for _, f := range src.HashFields {
			if !seen[f] {
				seen[f] = true
				dst.HashFields = append(dst.HashFields, f)
			}
		}
	}
	if dst.RequiredFields == nil && src.RequiredFields != nil {
		dst.RequiredFields = append([]string(nil), src.RequiredFields...)
	}
}

// --- schema accessor helpers ---

func stringProp(o *Object, key string) (string, bool) {
	v, ok := o.Get(key)
	if !ok {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func arrayProp(o *Object, key string) ([]Value, bool) {
	v, ok := o.Get(key)
	if !ok {
		return nil, false
	}
	a, ok := v.([]Value)
	return a, ok
}

func isType(o *Object, want string) bool {
	t, ok := stringProp(o, "type")
	return ok && t == want
}

// isStringOrNumberProp reports whether props[key] is a schema object declaring
// type "string" or "number".
func isStringOrNumberProp(props *Object, key string) bool {
	pv, ok := props.Get(key)
	if !ok {
		return false
	}
	po, ok := pv.(*Object)
	if !ok {
		return false
	}
	t, ok := stringProp(po, "type")
	return ok && (t == "string" || t == "number")
}

// requiredList returns the schema's required[] as a deduplicated string slice in
// declaration order.
func requiredList(o *Object) []string {
	arr, ok := arrayProp(o, "required")
	if !ok {
		return nil
	}
	var out []string
	seen := make(map[string]bool)
	for _, e := range arr {
		s, ok := e.(string)
		if !ok || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// truthy mirrors JavaScript truthiness for the schema keyword presence checks
// (items/additionalProperties) that the reference performs with `if (value)`.
func truthy(v Value) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case Number:
		f, err := x.Float64()
		return err == nil && f != 0
	default:
		return true
	}
}

// stableStringify produces a canonical JSON string with recursively sorted
// object keys, used to deduplicate anyOf/oneOf/allOf branches (SPEC §4.3.6).
// Numbers are canonicalized to their shortest f64 text. Re-encountered objects
// (only possible with hand-built cyclic Values, never with [Decode] output) are
// rendered as null.
func stableStringify(v Value) string {
	var buf bytes.Buffer
	seen := make(map[*Object]bool)
	var enc func(Value)
	enc = func(v Value) {
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
			encodeString(&buf, x)
		case Number:
			if f, err := x.Float64(); err == nil {
				buf.WriteString(strconv.FormatFloat(f, 'g', -1, 64))
			} else {
				buf.WriteString(x.String())
			}
		case []Value:
			buf.WriteByte('[')
			for i, e := range x {
				if i > 0 {
					buf.WriteByte(',')
				}
				enc(e)
			}
			buf.WriteByte(']')
		case *Object:
			if seen[x] {
				buf.WriteString("null")
				return
			}
			seen[x] = true
			keys := append([]string(nil), x.Keys()...)
			sort.Strings(keys)
			buf.WriteByte('{')
			for i, k := range keys {
				if i > 0 {
					buf.WriteByte(',')
				}
				encodeString(&buf, k)
				buf.WriteByte(':')
				val, _ := x.Get(k)
				enc(val)
			}
			buf.WriteByte('}')
		default:
			buf.WriteString("null")
		}
	}
	enc(v)
	return buf.String()
}
