package schemapatch

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// ignoreNode is one node of the compiled ignore trie for the ignorePaths
// capability (GEN §10). It mirrors [PlanNode]: a "*" segment is the wildcard
// edge, any other segment is an UNESCAPED exact child edge; end marks a node
// where an ignore pointer terminates ("ignored here"). The differ threads a node
// down its recursion in parallel with the plan trie; a nil node means "nothing
// ignored here" and all accessors are nil-receiver-safe so callers thread nil
// without branching. The empty/absent set compiles to a nil root, so output
// stays byte-for-byte identical to the pre-capability tree.
type ignoreNode struct {
	end      bool
	children map[string]*ignoreNode
	wildcard *ignoreNode
}

// terminal reports whether this node ends an ignore pointer (the subtree here is
// EQUAL in both directions, GEN §10.4). Nil-safe.
func (n *ignoreNode) terminal() bool { return n != nil && n.end }

// member advances the trie for an object member key (GEN §10.3): the exact
// child edge if present, else the wildcard, else nil. Exact edges take
// precedence at every level. Nil-safe.
func (n *ignoreNode) member(key string) *ignoreNode {
	if n == nil {
		return nil
	}
	if c, ok := n.children[key]; ok {
		return c
	}
	return n.wildcard
}

// item advances the trie for an ARRAY element (GEN §10.3): the array index
// level is represented by a single "*", so every element — object, array, or
// primitive — advances through the wildcard edge. Nil-safe.
func (n *ignoreNode) item() *ignoreNode {
	if n == nil {
		return nil
	}
	return n.wildcard
}

// isIgnoreIndexSegment reports whether an unescaped ignore-pointer segment is a
// canonical array index (CORE §1.3.2 — "0" or a nonzero digit run, value in
// 0..2^32-2). Such a segment (or "-") is rejected at construction (GEN §10.1): an
// array level is matched only by "*". A merely numeric-looking segment that is
// not a canonical in-range index (leading zero, or > 2^32-2) is a legal
// object-member name (§F33) and is accepted.
func isIgnoreIndexSegment(seg string) bool {
	if !ValidArrayIndexSyntax(seg) {
		return false
	}
	n, err := strconv.ParseUint(seg, 10, 64)
	return err == nil && n <= (1<<32)-2
}

// compileIgnoreTrie validates an ignorePaths set and compiles it into an ignore
// trie (GEN §10.1/GEN §10.2). It returns (nil, nil) for an empty/absent set
// (threads no node). It returns a non-nil error on the first invalid pointer: a
// non-"/"-leading or empty/root pointer, or any segment that is a canonical
// array index or "-".
func compileIgnoreTrie(paths []string) (*ignoreNode, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	root := &ignoreNode{}
	for _, path := range paths {
		if path == "" {
			return nil, fmt.Errorf(`schemapatch: ignorePaths: the empty/root pointer "" is not an object-member location (GEN §10.1)`)
		}
		if path[0] != '/' {
			return nil, fmt.Errorf(`schemapatch: ignorePaths: pointer %q must begin with "/" (GEN §10.1)`, path)
		}
		node := root
		for _, rawSeg := range strings.Split(path[1:], "/") {
			if rawSeg == "*" {
				if node.wildcard == nil {
					node.wildcard = &ignoreNode{}
				}
				node = node.wildcard
				continue
			}
			seg := UnescapeToken(rawSeg)
			if seg == "-" || isIgnoreIndexSegment(seg) {
				return nil, fmt.Errorf(`schemapatch: ignorePaths: pointer %q contains an array-index (or "-") segment %q; ignore pointers address object members only — use "*" for an array level (GEN §10.1)`, path, seg)
			}
			if node.children == nil {
				node.children = make(map[string]*ignoreNode)
			}
			child := node.children[seg]
			if child == nil {
				child = &ignoreNode{}
				node.children[seg] = child
			}
			node = child
		}
		node.end = true
	}
	return root, nil
}

// ignoreSubtreeHasTerminal reports whether the subtree rooted at n contains ANY
// ignore terminal (GEN §10.6). It disables wholesaleReplaceFallback for an
// array with an ignore path beneath it, so ignored content never leaks through a
// whole-array replace of an ancestor. Nil-safe.
func ignoreSubtreeHasTerminal(n *ignoreNode) bool {
	if n == nil {
		return false
	}
	if n.end {
		return true
	}
	if ignoreSubtreeHasTerminal(n.wildcard) {
		return true
	}
	for _, c := range n.children {
		if ignoreSubtreeHasTerminal(c) {
			return true
		}
	}
	return false
}

// validatePrimaryKeysNotIgnored enforces GEN §10.7: a plan's primaryKey field
// MUST NOT be ignorable. It returns a non-nil error when any array plan's
// key-field location (P / "*" / key) is at or beneath an ignore terminal — the
// field itself, the whole item (P/*), or the whole array (P).
func validatePrimaryKeysNotIgnored(plan Plan, root *ignoreNode) error {
	for planKey, ap := range plan.paths {
		if ap == nil || ap.isObjectPlan() {
			continue
		}
		// A declared map topology's identity is its whole composite key tuple, so
		// NO key field may be ignorable (same spirit as GEN §10.7 for primaryKey).
		// Compat plans carry only a single PrimaryKey.
		keyFields := ap.Keys
		if len(keyFields) == 0 {
			if ap.PrimaryKey == "" {
				continue
			}
			keyFields = []string{ap.PrimaryKey}
		}
		for _, key := range keyFields {
			if ignoreCoversKeyField(root, planKeySegments(planKey), 0, key) {
				display := planKey
				if display == "" {
					display = "/"
				}
				return fmt.Errorf("schemapatch: ignorePaths: an ignore entry covers the key field %q of the array plan at %q — a primaryKey/map key field must not be ignorable (GEN §10.7)", key, display)
			}
		}
	}
	return nil
}

// validateAtomicNotIgnored enforces CORE §8.2.3: an ignorePaths terminal at or
// beneath a declared atomic array/object node is a construction error. An atomic
// container is replaced whole and cannot express an ignored subtree. It returns a
// non-nil error on the first such collision.
func validateAtomicNotIgnored(plan Plan, root *ignoreNode) error {
	for planKey, ap := range plan.paths {
		if ap == nil {
			continue
		}
		if ap.Granularity != "atomic" && ap.Topology != TopologyAtomic {
			continue
		}
		if ignoreTerminalAtOrBeneath(root, planKeySegments(planKey), 0) {
			display := planKey
			if display == "" {
				display = "/"
			}
			return fmt.Errorf("schemapatch: ignorePaths: an ignore entry lies at or beneath the declared atomic node at %q — an atomic container is replaced whole and cannot express an ignored subtree (CORE §8.2.3)", display)
		}
	}
	return nil
}

// ignoreTerminalAtOrBeneath reports whether, following the plan path segs into the
// ignore trie, the reached node has any terminal at or below it (CORE §8.2.3). A
// "*" plan segment (additionalProperties or nested-array level) matches any member
// at diff time, so both the ignore wildcard and every exact child are explored.
// Ignore terminals strictly ABOVE the node are NOT flagged (they ignore the whole
// atomic container, which is permitted).
func ignoreTerminalAtOrBeneath(node *ignoreNode, segs []string, i int) bool {
	if node == nil {
		return false
	}
	if i >= len(segs) {
		return ignoreSubtreeHasTerminal(node)
	}
	seg := segs[i]
	if seg == "*" {
		if ignoreTerminalAtOrBeneath(node.wildcard, segs, i+1) {
			return true
		}
		for _, c := range node.children {
			if ignoreTerminalAtOrBeneath(c, segs, i+1) {
				return true
			}
		}
		return false
	}
	raw := UnescapeToken(seg)
	if exact, ok := node.children[raw]; ok {
		if ignoreTerminalAtOrBeneath(exact, segs, i+1) {
			return true
		}
	}
	return ignoreTerminalAtOrBeneath(node.wildcard, segs, i+1)
}

// ignoreCoversKeyField walks a plan key P (segs) through the ignore trie, then
// consumes the array-element wildcard and the key member, reporting whether the
// key-field location is at or beneath an ignore terminal (GEN §10.7). A
// literal P segment follows exact-child-else-wildcard; a "*" P segment explores
// both exact children and the wildcard (either may match at diff time).
func ignoreCoversKeyField(node *ignoreNode, segs []string, i int, key string) bool {
	if node == nil {
		return false
	}
	if node.end {
		return true // an ancestor terminal covers everything below
	}
	if i < len(segs) {
		seg := segs[i]
		if seg == "*" {
			if ignoreCoversKeyField(node.wildcard, segs, i+1, key) {
				return true
			}
			for _, c := range node.children {
				if ignoreCoversKeyField(c, segs, i+1, key) {
					return true
				}
			}
			return false
		}
		raw := UnescapeToken(seg)
		if exact, ok := node.children[raw]; ok {
			return ignoreCoversKeyField(exact, segs, i+1, key)
		}
		return ignoreCoversKeyField(node.wildcard, segs, i+1, key)
	}
	// node is the array's node. Consume the array-element wildcard, then the key
	// member (exact-else-wildcard).
	itemNode := node.wildcard
	if itemNode == nil {
		return false
	}
	if itemNode.end {
		return true // the whole item is ignored -> covers the key
	}
	keyNode := itemNode.member(key)
	return keyNode.terminal()
}

// ignoreFingerprint returns a canonical, key-sorted fingerprint of v that OMITS
// members/elements ignored under ig (GEN §10.5), so two items differing only
// in ignored fields intern to the same id (common / move-pairable, never
// remove+add). When ig is nil it delegates to [stableStringify], producing
// byte-identical output to the pre-capability interning path.
func ignoreFingerprint(v Value, ig *ignoreNode) string {
	if ig == nil {
		return stableStringify(v)
	}
	var buf bytes.Buffer
	encodeIgnore(&buf, v, ig)
	return buf.String()
}

// encodeIgnore writes the ignore-filtered fingerprint of v (ig is non-nil).
// Non-container values and nil-ig subtrees delegate to [stableStringify] so the
// unignored portions are byte-identical to it.
func encodeIgnore(buf *bytes.Buffer, v Value, ig *ignoreNode) {
	switch x := v.(type) {
	case []Value:
		elemIg := ig.item()
		buf.WriteByte('[')
		first := true
		for _, e := range x {
			if elemIg.terminal() {
				continue // a fully-ignored element is omitted
			}
			if !first {
				buf.WriteByte(',')
			}
			first = false
			encodeIgnoreChild(buf, e, elemIg)
		}
		buf.WriteByte(']')
	case *Object:
		keys := append([]string(nil), x.keys...)
		sort.Strings(keys)
		buf.WriteByte('{')
		first := true
		for _, k := range keys {
			childIg := ig.member(k)
			if childIg.terminal() {
				continue // an ignored member is omitted
			}
			if !first {
				buf.WriteByte(',')
			}
			first = false
			encodeString(buf, k)
			buf.WriteByte(':')
			val, _ := x.Get(k)
			encodeIgnoreChild(buf, val, childIg)
		}
		buf.WriteByte('}')
	default:
		buf.WriteString(stableStringify(v))
	}
}

// encodeIgnoreChild recurses into a child value: a nil child ignore node
// delegates to [stableStringify] (byte-identical), otherwise ignore-filtered.
func encodeIgnoreChild(buf *bytes.Buffer, v Value, ig *ignoreNode) {
	if ig == nil {
		buf.WriteString(stableStringify(v))
		return
	}
	encodeIgnore(buf, v, ig)
}
