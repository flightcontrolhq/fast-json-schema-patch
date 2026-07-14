package schemapatch

import "math"

// DeepEqual reports whether two [Value]s are equal under the sole equality
// relation used for diffing, test ops, and oldValue validation (SPEC §2.4):
//
//   - null, bool, string: equal by value; there is no type coercion
//     (1 != "1", null != false, null != 0).
//   - number: equal at IEEE-754 f64 (SPEC §2.2) — "1" == "1.0", "0" == "-0",
//     large integers that share an f64 image compare equal.
//   - array: same length and element-wise DeepEqual, ORDER-SENSITIVE.
//   - object: same set of member keys with DeepEqual values, member-order
//     INSENSITIVE.
func DeepEqual(a, b Value) bool {
	switch av := a.(type) {
	case nil:
		return b == nil
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case Number:
		return numberEqual(av, b)
	case []Value:
		bv, ok := b.([]Value)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !DeepEqual(av[i], bv[i]) {
				return false
			}
		}
		return true
	case *Object:
		bv, ok := b.(*Object)
		if !ok || av.Len() != bv.Len() {
			return false
		}
		for i, k := range av.keys {
			ov, present := bv.Get(k)
			if !present || !DeepEqual(av.vals[i], ov) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// numberEqual compares a Number against another Value at f64 semantics. It is a
// helper for DeepEqual; only a Number (or, defensively, a bare float64) on the
// right can be equal.
func numberEqual(a Number, b Value) bool {
	bf, ok := asFloat(b)
	if !ok {
		return false
	}
	af, aok := a.Float64()
	if aok != nil {
		// Non-parseable text (never produced by Decode): fall back to text.
		if bn, isNum := b.(Number); isNum {
			return a.text == bn.text
		}
		return false
	}
	// f64 equality: -0 == 0 holds naturally; NaN cannot occur in JSON.
	if math.IsNaN(af) || math.IsNaN(bf) {
		return false
	}
	return af == bf
}

func asFloat(v Value) (float64, bool) {
	switch x := v.(type) {
	case Number:
		f, err := x.Float64()
		if err != nil {
			return 0, false
		}
		return f, true
	case float64:
		return x, true
	default:
		return 0, false
	}
}
