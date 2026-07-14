package schemapatch

import "fmt"

// Op is a patch operation kind.
type Op string

// The RFC 6902 operation kinds plus the ops apply accepts. The generator emits
// only add/remove/replace by default, and move under the emitMoves capability
// (CORE §4.1); copy and test are accepted by apply but never emitted.
const (
	OpAdd     Op = "add"
	OpRemove  Op = "remove"
	OpReplace Op = "replace"
	OpMove    Op = "move"
	OpCopy    Op = "copy"
	OpTest    Op = "test"
)

// Operation is a single patch operation (CORE §4.1). Presence of the optional
// fields is tracked explicitly so that an ABSENT field is distinguishable from a
// field present with a JSON null — a distinction that matters for conformance
// vectors and for oldValue validation (CORE §5.4):
//
//   - HasFrom marks From as present (From is a JSON Pointer; "" is a valid,
//     present value — the root pointer).
//   - HasValue marks Value as present; Value may itself be nil (JSON null).
//   - HasOldValue marks OldValue as present; OldValue may be nil (JSON null).
//
// Path is always present.
type Operation struct {
	Op          Op
	Path        string
	From        string
	Value       Value
	OldValue    Value
	HasFrom     bool
	HasValue    bool
	HasOldValue bool
}

// MarshalJSON implements json.Marshaler, emitting op, path, then only the
// present optional fields (from, value, oldValue) in that order. It uses the
// value model's encoder so number literal text and object member order are
// preserved.
func (op *Operation) MarshalJSON() ([]byte, error) {
	obj, err := op.toObject()
	if err != nil {
		return nil, err
	}
	return Encode(obj)
}

// UnmarshalJSON implements json.Unmarshaler, decoding into the value model and
// recording which optional fields were present (including those present as
// null).
func (op *Operation) UnmarshalJSON(data []byte) error {
	v, err := Decode(data)
	if err != nil {
		return err
	}
	obj, ok := v.(*Object)
	if !ok {
		return fmt.Errorf("schemapatch: operation must be a JSON object, got %T", v)
	}
	return op.fromObject(obj)
}

// toObject renders the operation into an ordered Object for encoding.
func (op *Operation) toObject() (*Object, error) {
	obj := NewObject()
	obj.Set("op", string(op.Op))
	obj.Set("path", op.Path)
	if op.HasFrom {
		obj.Set("from", op.From)
	}
	if op.HasValue {
		obj.Set("value", op.Value)
	}
	if op.HasOldValue {
		obj.Set("oldValue", op.OldValue)
	}
	return obj, nil
}

// fromObject populates the operation from a decoded Object, setting presence
// flags. It resets all fields first so a reused Operation cannot retain stale
// presence.
func (op *Operation) fromObject(obj *Object) error {
	*op = Operation{}

	opVal, ok := obj.Get("op")
	if !ok {
		return fmt.Errorf("schemapatch: operation missing required \"op\" field")
	}
	opStr, ok := opVal.(string)
	if !ok {
		return fmt.Errorf("schemapatch: operation \"op\" must be a string, got %T", opVal)
	}
	op.Op = Op(opStr)

	pathVal, ok := obj.Get("path")
	if !ok {
		return fmt.Errorf("schemapatch: operation missing required \"path\" field")
	}
	pathStr, ok := pathVal.(string)
	if !ok {
		return fmt.Errorf("schemapatch: operation \"path\" must be a string, got %T", pathVal)
	}
	op.Path = pathStr

	if fromVal, present := obj.Get("from"); present {
		fromStr, ok := fromVal.(string)
		if !ok {
			return fmt.Errorf("schemapatch: operation \"from\" must be a string, got %T", fromVal)
		}
		op.From = fromStr
		op.HasFrom = true
	}
	if val, present := obj.Get("value"); present {
		op.Value = val
		op.HasValue = true
	}
	if old, present := obj.Get("oldValue"); present {
		op.OldValue = old
		op.HasOldValue = true
	}
	return nil
}

// DecodeOperations parses a JSON patch array into a slice of Operations,
// preserving field presence.
func DecodeOperations(data []byte) ([]Operation, error) {
	v, err := Decode(data)
	if err != nil {
		return nil, err
	}
	arr, ok := v.([]Value)
	if !ok {
		return nil, fmt.Errorf("schemapatch: patch must be a JSON array, got %T", v)
	}
	ops := make([]Operation, len(arr))
	for i, e := range arr {
		obj, ok := e.(*Object)
		if !ok {
			return nil, fmt.Errorf("schemapatch: patch[%d] must be a JSON object, got %T", i, e)
		}
		if err := ops[i].fromObject(obj); err != nil {
			return nil, fmt.Errorf("schemapatch: patch[%d]: %w", i, err)
		}
	}
	return ops, nil
}

// EncodeOperations serializes a slice of Operations to a compact JSON patch
// array using the value model's encoder (no HTML escaping; number text and
// member order preserved).
func EncodeOperations(ops []Operation) ([]byte, error) {
	arr := make([]Value, len(ops))
	for i := range ops {
		obj, err := ops[i].toObject()
		if err != nil {
			return nil, err
		}
		arr[i] = obj
	}
	return Encode(arr)
}
