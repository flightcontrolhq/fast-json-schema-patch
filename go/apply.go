package schemapatch

// ApplyOptions configures [ApplyPatch] (SPEC §8.7). All fields default to their
// zero value (false), reproducing RFC 6902 immutable-apply semantics.
type ApplyOptions struct {
	// ValidateOldValues, when true, checks every remove/replace op that carries
	// an oldValue against the current document value before applying it, failing
	// with OLD_VALUE_MISMATCH on a mismatch (SPEC §8.4). Ops without oldValue are
	// applied unchecked (§8.4.2).
	ValidateOldValues bool
	// CloneValues, when true, deep-clones each op's value payload before
	// insertion so the result never aliases objects owned by the patch (SPEC
	// §8.7.2). When false, values are inserted by reference.
	CloneValues bool
	// CloneResult, when true, deep-clones the returned document so it shares no
	// structure with the input or the patch (SPEC §8.7.3). When false, untouched
	// subtrees are shared by reference with the input (copy-on-write, §8.7.1).
	CloneResult bool
}

// ApplyPatch applies patch to doc and returns the resulting document (SPEC §8).
// It supports all six RFC 6902 ops (add, remove, replace, move, copy, test)
// plus this library's oldValue extension (optionally validated via
// ApplyOptions.ValidateOldValues) and "-" array-append paths (§3.5).
//
// The input doc is NEVER mutated. Application is atomic (SPEC §8.1.2): on the
// first failing op a *[PatchError] is returned (with its Code and OpIndex) and
// the input is left untouched — the returned Value is nil. Atomicity is
// structural: every op only ever mutates containers freshly cloned along its
// own touched path (copy-on-write, §8.7.1), so the original nodes are only ever
// read. Values in the [Value] model are therefore immutable by discipline:
// apply treats every input node as read-only and copies before writing.
//
// Ops are applied strictly in the order given (SPEC §8.1.1); they are never
// reordered, batched, or deduplicated. The empty patch returns doc itself
// (§8.7.5) unless CloneResult forces an independent copy.
//
// Note on structural sharing: unlike the reference, which clones each container
// at most once across the whole patch via a per-call cloned-set, this port
// re-clones the touched path per op. That is coarser sharing but produces a
// document deep-equal to the reference result for the same input+patch
// (SPEC §8.7.4), which is all conformance requires.
func ApplyPatch(doc Value, patch []Operation, opts ApplyOptions) (Value, error) {
	root := doc
	for i := range patch {
		next, err := applyOp(root, &patch[i], i, opts)
		if err != nil {
			return nil, err
		}
		root = next
	}
	if opts.CloneResult {
		return Clone(root), nil
	}
	return root, nil
}

// applyOp applies one op against root and returns the new root (or a
// *PatchError). It is the shared core used by both [ApplyPatch] and the invert
// simulation (SPEC §9.2). It never mutates root's original containers.
func applyOp(root Value, op *Operation, idx int, opts ApplyOptions) (Value, *PatchError) {
	parts, perr := splitPathW(op.Path, op, idx)
	if perr != nil {
		return nil, perr
	}

	switch op.Op {
	case OpAdd:
		if !op.HasValue {
			return nil, opErr(CodeInvalidOperation, `"add" is missing "value"`, idx, op)
		}
		value := op.Value
		if opts.CloneValues {
			value = Clone(value)
		}
		if len(parts) == 0 { // root add replaces the whole document (§8.5.1)
			return value, nil
		}
		rootPtr, parent, key, assign, perr := resolveParent(root, parts, op, idx)
		if perr != nil {
			return nil, perr
		}
		switch p := parent.(type) {
		case []Value:
			n, perr := parseArrayIndex(key, len(p), true, op, idx)
			if perr != nil {
				return nil, perr
			}
			assign(arrInsert(p, n, value))
		case *Object:
			p.Set(key, value)
		}
		return *rootPtr, nil

	case OpRemove:
		if len(parts) == 0 { // root remove is invalid (§8.5.2)
			return nil, opErr(CodeInvalidOperation, `cannot "remove" the document root`, idx, op)
		}
		rootPtr, parent, key, assign, perr := resolveParent(root, parts, op, idx)
		if perr != nil {
			return nil, perr
		}
		switch p := parent.(type) {
		case []Value:
			n, perr := parseArrayIndex(key, len(p), false, op, idx)
			if perr != nil {
				return nil, perr
			}
			if opts.ValidateOldValues && op.HasOldValue && !DeepEqual(p[n], op.OldValue) {
				return nil, opErr(CodeOldValueMismatch, `"oldValue" mismatch`, idx, op)
			}
			assign(arrRemoveAt(p, n))
		case *Object:
			cur, ok := p.Get(key)
			if !ok {
				return nil, opErr(CodePathUnresolvable, `cannot remove nonexistent path`, idx, op)
			}
			if opts.ValidateOldValues && op.HasOldValue && !DeepEqual(cur, op.OldValue) {
				return nil, opErr(CodeOldValueMismatch, `"oldValue" mismatch`, idx, op)
			}
			p.Delete(key)
		}
		return *rootPtr, nil

	case OpReplace:
		if !op.HasValue {
			return nil, opErr(CodeInvalidOperation, `"replace" is missing "value"`, idx, op)
		}
		value := op.Value
		if opts.CloneValues {
			value = Clone(value)
		}
		if len(parts) == 0 { // root replace swaps the document (§8.5.1)
			return value, nil
		}
		rootPtr, parent, key, _, perr := resolveParent(root, parts, op, idx)
		if perr != nil {
			return nil, perr
		}
		switch p := parent.(type) {
		case []Value:
			n, perr := parseArrayIndex(key, len(p), false, op, idx)
			if perr != nil {
				return nil, perr
			}
			if opts.ValidateOldValues && op.HasOldValue && !DeepEqual(p[n], op.OldValue) {
				return nil, opErr(CodeOldValueMismatch, `"oldValue" mismatch`, idx, op)
			}
			p[n] = value
		case *Object:
			cur, ok := p.Get(key)
			if !ok {
				return nil, opErr(CodePathUnresolvable, `cannot replace nonexistent path`, idx, op)
			}
			if opts.ValidateOldValues && op.HasOldValue && !DeepEqual(cur, op.OldValue) {
				return nil, opErr(CodeOldValueMismatch, `"oldValue" mismatch`, idx, op)
			}
			p.Set(key, value)
		}
		return *rootPtr, nil

	case OpMove:
		if !op.HasFrom {
			return nil, opErr(CodeInvalidOperation, `"move" is missing "from"`, idx, op)
		}
		fromParts, perr := splitPathW(op.From, op, idx)
		if perr != nil {
			return nil, perr
		}
		if isProperPrefix(fromParts, parts) {
			return nil, opErr(CodeInvalidOperation, `"move" cannot move a node into its own child`, idx, op)
		}
		val, exists := getAtPath(root, fromParts)
		if !exists {
			return nil, opErr(CodePathUnresolvable, `"move" source does not exist`, idx, op)
		}
		afterRemove, perr := applyOp(root, &Operation{Op: OpRemove, Path: op.From}, idx, opts)
		if perr != nil {
			return nil, perr
		}
		return applyOp(afterRemove, &Operation{Op: OpAdd, Path: op.Path, Value: val, HasValue: true}, idx, opts)

	case OpCopy:
		if !op.HasFrom {
			return nil, opErr(CodeInvalidOperation, `"copy" is missing "from"`, idx, op)
		}
		fromParts, perr := splitPathW(op.From, op, idx)
		if perr != nil {
			return nil, perr
		}
		val, exists := getAtPath(root, fromParts)
		if !exists {
			return nil, opErr(CodePathUnresolvable, `"copy" source does not exist`, idx, op)
		}
		// Deep-clone so the result never aliases the source (SPEC §8.3.3).
		copied := Clone(val)
		return applyOp(root, &Operation{Op: OpAdd, Path: op.Path, Value: copied, HasValue: true}, idx, opts)

	case OpTest:
		// D4 (SPEC §8.3/§8.3.5, RFC 6902 §4.6): `test` MUST carry `value`. An
		// ABSENT value is a tier-1 required-field failure -> INVALID_OPERATION,
		// evaluated BEFORE the tier-3 read-side existence check. A value present
		// as JSON null (HasValue true) is VALID and tests against null — the
		// previous code omitted this check, so a value-less test against a null
		// target wrongly PASSED (absent Value defaulted to nil == null).
		if !op.HasValue {
			return nil, opErr(CodeInvalidOperation, `"test" is missing "value"`, idx, op)
		}
		val, exists := getAtPath(root, parts)
		if !exists {
			return nil, opErr(CodePathUnresolvable, `"test" path does not exist`, idx, op)
		}
		if !DeepEqual(val, op.Value) {
			return nil, opErr(CodeTestFailed, `"test" failed`, idx, op)
		}
		return root, nil

	default:
		return nil, opErr(CodeInvalidOperation, `unknown operation "`+string(op.Op)+`"`, idx, op)
	}
}

// resolveParent walks to the parent of the location addressed by parts, cloning
// every container along the way (copy-on-write). Every intermediate segment
// MUST already exist (SPEC §8.2.2). It returns a pointer to the (possibly-new)
// root cell, the cloned parent container (*Object or []Value), the final
// unescaped segment, and an assign closure that writes an updated parent back
// into its grandparent (needed when a splice changes an array's length; for the
// top level the closure updates the root cell, hence the pointer).
//
// The write-side prototype-pollution guard (SPEC §8.6.1) is enforced on every
// object segment traversed and on the final object segment; it does not apply
// to array-index segments.
func resolveParent(root Value, parts []string, op *Operation, idx int) (rootPtr *Value, parent Value, key string, assign func(Value), err *PatchError) {
	rt := cloneNode(root)
	rootPtr = &rt
	current := rt
	assignCurrent := func(v Value) { *rootPtr = v }

	for i := 0; i < len(parts)-1; i++ {
		part := parts[i]
		switch c := current.(type) {
		case []Value:
			n, perr := parseArrayIndex(part, len(c), false, op, idx)
			if perr != nil {
				return nil, nil, "", nil, perr
			}
			child := cloneNode(c[n])
			c[n] = child
			arr, ni := c, n
			assignCurrent = func(v Value) { arr[ni] = v }
			current = child
		case *Object:
			var prev string
			var hasPrev bool
			if i > 0 {
				prev, hasPrev = parts[i-1], true
			}
			if perr := checkSafeKey(part, prev, hasPrev, op, idx); perr != nil {
				return nil, nil, "", nil, perr
			}
			child, ok := c.Get(part)
			if !ok {
				return nil, nil, "", nil, opErr(CodePathUnresolvable, `path does not exist`, idx, op)
			}
			cloned := cloneNode(child)
			c.Set(part, cloned)
			obj, pk := c, part
			assignCurrent = func(v Value) { obj.Set(pk, v) }
			current = cloned
		default:
			// Descending through a primitive or null (SPEC §8.2.2).
			return nil, nil, "", nil, opErr(CodePathUnresolvable, `path does not exist`, idx, op)
		}
	}

	switch c := current.(type) {
	case []Value:
		_ = c
	case *Object:
		var prev string
		var hasPrev bool
		if len(parts) >= 2 {
			prev, hasPrev = parts[len(parts)-2], true
		}
		if perr := checkSafeKey(parts[len(parts)-1], prev, hasPrev, op, idx); perr != nil {
			return nil, nil, "", nil, perr
		}
	default:
		return nil, nil, "", nil, opErr(CodePathUnresolvable, `path does not exist`, idx, op)
	}

	return rootPtr, current, parts[len(parts)-1], assignCurrent, nil
}

// getAtPath resolves parts read-side by own-property / own-index lookup (SPEC
// §8.6): a malformed or "-" segment, an out-of-range index, or descent through
// a primitive all fail existence and return (nil, false) — never an error code.
// The prototype-pollution guard is NOT run: __proto__/constructor/prototype are
// resolved by ordinary own-key lookup and simply miss (§8.6.1). An empty parts
// list addresses the whole document.
func getAtPath(root Value, parts []string) (Value, bool) {
	current := root
	for _, part := range parts {
		switch c := current.(type) {
		case []Value:
			if !ValidArrayIndexSyntax(part) {
				return nil, false
			}
			n, ok := ParseArrayIndex(part)
			if !ok || n >= len(c) {
				return nil, false
			}
			current = c[n]
		case *Object:
			v, ok := c.Get(part)
			if !ok {
				return nil, false
			}
			current = v
		default:
			return nil, false
		}
	}
	return current, true
}

// splitPathW splits a write-side pointer, translating a malformed pointer
// (non-empty and not "/"-prefixed) into a *PatchError with INVALID_POINTER
// (SPEC §8.6). Read-side callers that must map malformed pointers to
// PATH_UNRESOLVABLE resolve via getAtPath instead.
func splitPathW(path string, op *Operation, idx int) ([]string, *PatchError) {
	parts, err := SplitPath(path)
	if err != nil {
		return nil, opErr(CodeInvalidPointer, `malformed JSON Pointer`, idx, op)
	}
	return parts, nil
}

// parseArrayIndex validates part as an array index for a write-side op (SPEC
// §3.6, §8.3.1). "-" returns length when allowEnd (add/move/copy destination
// final) and is INVALID_POINTER otherwise. A malformed index is INVALID_POINTER;
// a well-formed index past the op's max (length for add, length-1 otherwise), or
// one too large to fit an int, is INDEX_OUT_OF_BOUNDS.
func parseArrayIndex(part string, length int, allowEnd bool, op *Operation, idx int) (int, *PatchError) {
	if part == AppendToken {
		if !allowEnd {
			return 0, opErr(CodeInvalidPointer, `cannot use "-" here`, idx, op)
		}
		return length, nil
	}
	if !ValidArrayIndexSyntax(part) {
		return 0, opErr(CodeInvalidPointer, `invalid array index "`+part+`"`, idx, op)
	}
	max := length
	if !allowEnd {
		max = length - 1
	}
	n, ok := ParseArrayIndex(part)
	if !ok || n > max {
		return 0, opErr(CodeIndexOutOfBounds, `array index out of bounds`, idx, op)
	}
	return n, nil
}

// checkSafeKey enforces the write-side prototype-pollution guard (SPEC §8.6.1):
// "__proto__" is rejected anywhere; "prototype" is rejected only when its
// immediately preceding segment is "constructor". Standalone "constructor" and
// standalone "prototype" remain usable. Go has no prototype chain, but the
// conformance vectors assert these rejections, so the same segments are refused
// to stay wire-compatible with the reference.
func checkSafeKey(key, prev string, hasPrev bool, op *Operation, idx int) *PatchError {
	if key == "__proto__" || (key == "prototype" && hasPrev && prev == "constructor") {
		return opErr(CodeUnsafeKey, `refusing to touch unsafe object key "`+key+`"`, idx, op)
	}
	return nil
}

// isProperPrefix reports whether from is a strict prefix of path — the "move a
// node into its own descendant" condition (SPEC §8.3.3). Equal paths are not a
// proper prefix.
func isProperPrefix(from, path []string) bool {
	if len(from) >= len(path) {
		return false
	}
	for i := range from {
		if from[i] != path[i] {
			return false
		}
	}
	return true
}

// cloneNode returns a shallow copy of a container (so its slot can be mutated
// without touching the input), or the value itself for immutable scalars. It is
// the copy-on-write primitive used by resolveParent (SPEC §8.7.1).
func cloneNode(v Value) Value {
	switch x := v.(type) {
	case []Value:
		out := make([]Value, len(x))
		copy(out, x)
		return out
	case *Object:
		return x.shallowClone()
	default:
		return v
	}
}

// arrInsert returns a new slice with v inserted at index at (0 <= at <= len).
func arrInsert(arr []Value, at int, v Value) []Value {
	out := make([]Value, 0, len(arr)+1)
	out = append(out, arr[:at]...)
	out = append(out, v)
	out = append(out, arr[at:]...)
	return out
}

// arrRemoveAt returns a new slice with the element at index at removed.
func arrRemoveAt(arr []Value, at int) []Value {
	out := make([]Value, 0, len(arr)-1)
	out = append(out, arr[:at]...)
	out = append(out, arr[at+1:]...)
	return out
}

// opErr builds a *PatchError for a failed op.
func opErr(code ErrorCode, message string, idx int, op *Operation) *PatchError {
	return &PatchError{Code: code, Message: message, OpIndex: idx, Op: op}
}
