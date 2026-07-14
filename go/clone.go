package schemapatch

// Clone returns a deep copy of v in the [Value] model. Scalars (nil, bool,
// string, [Number]) are immutable and returned as-is; arrays and objects are
// copied recursively so the result shares no mutable structure with v. An empty
// array clones to a non-nil empty []Value.
func Clone(v Value) Value {
	switch x := v.(type) {
	case []Value:
		out := make([]Value, len(x))
		for i, e := range x {
			out[i] = Clone(e)
		}
		return out
	case *Object:
		return x.Clone()
	default:
		// nil, bool, string, Number: immutable value types.
		return v
	}
}

// shallowClone returns a copy of the object whose member slots can be
// reassigned without affecting o, but whose member VALUES are shared by
// reference with o. It is the copy-on-write primitive apply uses to clone one
// container on a touched path (CORE §5.7.1); descent then clones the next level
// as needed.
func (o *Object) shallowClone() *Object {
	c := &Object{
		keys:  make([]string, len(o.keys)),
		vals:  make([]Value, len(o.vals)),
		index: make(map[string]int, len(o.index)),
	}
	copy(c.keys, o.keys)
	copy(c.vals, o.vals)
	for k, i := range o.index {
		c.index[k] = i
	}
	return c
}

// Clone returns a deep copy of the object, preserving member order.
func (o *Object) Clone() *Object {
	c := &Object{
		keys:  make([]string, len(o.keys)),
		vals:  make([]Value, len(o.vals)),
		index: make(map[string]int, len(o.index)),
	}
	copy(c.keys, o.keys)
	for i, v := range o.vals {
		c.vals[i] = Clone(v)
	}
	for k, i := range o.index {
		c.index[k] = i
	}
	return c
}
