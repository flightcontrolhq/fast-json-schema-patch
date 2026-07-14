package schemapatch

import "strconv"

// InvertPatch returns the inverse of patch relative to doc (SPEC §9).
//
// doc MUST be the ORIGINAL (pre-patch) document (SPEC §9.1.1): it is required to
// resolve "/-" append paths to concrete indices, to recover removed/replaced
// values when oldValue is absent, and to restore values overwritten by
// add/move/copy onto an existing member. The guarantee (§9.1.2) is that
// ApplyPatch(ApplyPatch(doc, patch), InvertPatch(doc, patch)) deep-equals doc
// for any doc on which patch applies cleanly.
//
// Inversion is forward-simulated (SPEC §9.2): each op's inverse is computed
// against the correct pre-op state (a copy of doc advanced op-by-op), the
// inverses are collected, then the list is reversed. doc is never mutated (the
// simulation uses copy-on-write, sharing [applyOp] with ApplyPatch).
//
// Errors: a remove/replace whose forward target does not exist in the simulated
// document yields PATH_UNRESOLVABLE; an unknown op or a move/copy missing "from"
// yields INVALID_OPERATION (SPEC §9.2.1). The error is a *[PatchError].
func InvertPatch(doc Value, patch []Operation) ([]Operation, error) {
	inverse := make([]Operation, 0, len(patch))
	root := doc

	for i := range patch {
		op := &patch[i]
		parts, err := SplitPath(op.Path)
		if err != nil {
			return nil, opErr(CodeInvalidPointer, `malformed JSON Pointer`, i, op)
		}

		switch op.Op {
		case OpAdd:
			inverse = append(inverse, invertInsertion(root, op.Path, parts, op.HasValue, op.Value))

		case OpRemove:
			val, exists := getAtPath(root, parts)
			if !exists {
				return nil, opErr(CodePathUnresolvable, `cannot invert "remove" of nonexistent path`, i, op)
			}
			inverse = append(inverse, Operation{Op: OpAdd, Path: op.Path, Value: val, HasValue: true})

		case OpReplace:
			val, exists := getAtPath(root, parts)
			if !exists {
				return nil, opErr(CodePathUnresolvable, `cannot invert "replace" of nonexistent path`, i, op)
			}
			inverse = append(inverse, replaceInverse(op.Path, val, op.HasValue, op.Value))

		case OpMove:
			if !op.HasFrom {
				return nil, opErr(CodeInvalidOperation, `"move" is missing "from"`, i, op)
			}
			if len(parts) == 0 {
				// Moving to the root replaces the whole document; restore it.
				inverse = append(inverse, Operation{Op: OpReplace, Path: "", Value: root, HasValue: true})
				break
			}
			destVal, destExists := getAtPath(root, parts)
			parentVal, _ := getAtPath(root, parts[:len(parts)-1])
			_, parentIsArray := parentVal.([]Value)
			// A move onto an existing OBJECT member overwrites it; the inverse
			// must also restore that value. Push the restore before the
			// move-back so it survives the final reversal (SPEC §9.2).
			if destExists && !parentIsArray {
				inverse = append(inverse, Operation{Op: OpAdd, Path: op.Path, Value: destVal, HasValue: true})
			}
			inverse = append(inverse, Operation{Op: OpMove, Path: op.From, From: op.Path, HasFrom: true})

		case OpCopy:
			// copy inserts without a value field of its own, so its inverse
			// carries no oldValue (HasValue=false, SPEC §9.2).
			inverse = append(inverse, invertInsertion(root, op.Path, parts, false, nil))

		case OpTest:
			inverse = append(inverse, *op) // passed through unchanged (SPEC §9.2)

		default:
			return nil, opErr(CodeInvalidOperation, `unknown operation "`+string(op.Op)+`"`, i, op)
		}

		// Advance the simulated document so later ops invert against post-op
		// state. Uses default options (no oldValue validation).
		next, perr := applyOp(root, op, i, ApplyOptions{})
		if perr != nil {
			return nil, perr
		}
		root = next
	}

	reverseOps(inverse)
	return inverse, nil
}

// invertInsertion computes the inverse of an insertion (add, or copy) at path
// (SPEC §9.2). At the root it restores the whole document. On an array it always
// inverts to a remove (arrays insert, never overwrite), resolving "/-" to the
// concrete pre-op index. On an object it inverts to a remove for a new member,
// or a replace restoring the pre-op value for an overwritten member. hasValue /
// value carry the forward op's value: when hasValue is false (copy) the inverse
// carries no oldValue.
func invertInsertion(root Value, path string, parts []string, hasValue bool, value Value) Operation {
	if len(parts) == 0 {
		// add/replace at root replaces the whole document (SPEC §8.5.1).
		return Operation{Op: OpReplace, Path: "", Value: root, HasValue: true, OldValue: value, HasOldValue: hasValue}
	}

	last := parts[len(parts)-1]
	parentVal, _ := getAtPath(root, parts[:len(parts)-1])

	if arr, ok := parentVal.([]Value); ok {
		if last == AppendToken {
			// "/-" appended at the pre-op array length; the concrete index is len.
			concrete := path[:len(path)-1] + strconv.Itoa(len(arr))
			return Operation{Op: OpRemove, Path: concrete, OldValue: value, HasOldValue: hasValue}
		}
		return Operation{Op: OpRemove, Path: path, OldValue: value, HasOldValue: hasValue}
	}

	if existing, exists := getAtPath(root, parts); exists {
		// Overwrote an existing object member (RFC 6902 §4.1); restore it.
		return Operation{Op: OpReplace, Path: path, Value: existing, HasValue: true, OldValue: value, HasOldValue: hasValue}
	}
	return Operation{Op: OpRemove, Path: path, OldValue: value, HasOldValue: hasValue}
}

// replaceInverse builds the inverse of a replace: a replace restoring the pre-op
// value, carrying the forward value as oldValue when the forward op had one.
func replaceInverse(path string, preValue Value, hasValue bool, value Value) Operation {
	return Operation{Op: OpReplace, Path: path, Value: preValue, HasValue: true, OldValue: value, HasOldValue: hasValue}
}

// reverseOps reverses ops in place (SPEC §9.2: collect then reverse).
func reverseOps(ops []Operation) {
	for i, j := 0, len(ops)-1; i < j; i, j = i+1, j-1 {
		ops[i], ops[j] = ops[j], ops[i]
	}
}
