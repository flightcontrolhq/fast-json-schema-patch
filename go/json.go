package schemapatch

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"unicode/utf8"
)

// Decode parses JSON bytes into the ordered [Value] model. Object member order
// and number literal text are preserved. It rejects trailing non-whitespace
// after the top-level value.
func Decode(data []byte) (Value, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	// Reject trailing tokens after the top-level value.
	if _, err := dec.Token(); err != io.EOF {
		if err == nil {
			return nil, fmt.Errorf("schemapatch: unexpected trailing data after JSON value")
		}
		return nil, err
	}
	return v, nil
}

func decodeValue(dec *json.Decoder) (Value, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return decodeFromToken(dec, tok)
}

func decodeFromToken(dec *json.Decoder, tok json.Token) (Value, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			return decodeObject(dec)
		case '[':
			return decodeArray(dec)
		default:
			return nil, fmt.Errorf("schemapatch: unexpected delimiter %q", t)
		}
	case json.Number:
		return Number{text: t.String()}, nil
	case string:
		return t, nil
	case bool:
		return t, nil
	case nil:
		return nil, nil
	default:
		return nil, fmt.Errorf("schemapatch: unexpected token type %T", tok)
	}
}

func decodeObject(dec *json.Decoder) (Value, error) {
	obj := NewObject()
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, fmt.Errorf("schemapatch: object key is not a string: %v", keyTok)
		}
		val, err := decodeValue(dec)
		if err != nil {
			return nil, err
		}
		obj.Set(key, val)
	}
	// Consume the closing '}'.
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return obj, nil
}

func decodeArray(dec *json.Decoder) (Value, error) {
	arr := []Value{}
	for dec.More() {
		val, err := decodeValue(dec)
		if err != nil {
			return nil, err
		}
		arr = append(arr, val)
	}
	// Consume the closing ']'.
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	return arr, nil
}

// Encode serializes a [Value] to compact JSON, preserving object member order
// and number literal text. HTML-significant characters are not escaped.
func Encode(v Value) ([]byte, error) {
	var buf bytes.Buffer
	if err := encodeValue(&buf, v); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func encodeValue(buf *bytes.Buffer, v Value) error {
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
		// Backstop grammar gate (CORE §1.2): even though every ingress
		// ([Decode]/[ParseNumber]/[NewNumber]/[FromAny]) validates, Encode
		// re-checks so a malformed literal can never reach the wire — an empty
		// text, or a hand-built non-finite, fails here rather than emitting
		// invalid JSON.
		if !ValidNumberText(x.text) {
			return fmt.Errorf("schemapatch: cannot encode invalid JSON number %q", x.text)
		}
		buf.WriteString(x.text)
	case []Value:
		buf.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encodeValue(buf, e); err != nil {
				return err
			}
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
			if err := encodeValue(buf, x.vals[i]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	default:
		return fmt.Errorf("schemapatch: cannot encode value of type %T", v)
	}
	return nil
}

const hexDigits = "0123456789abcdef"

// encodeString writes a JSON string literal, escaping only the characters JSON
// requires. Valid UTF-8 is emitted as-is (no \uXXXX expansion of multi-byte
// runes, no HTML escaping).
func encodeString(buf *bytes.Buffer, s string) {
	buf.WriteByte('"')
	start := 0
	for i := 0; i < len(s); {
		c := s[i]
		if c >= 0x20 && c != '"' && c != '\\' && c < utf8.RuneSelf {
			i++
			continue
		}
		if c < utf8.RuneSelf {
			if start < i {
				buf.WriteString(s[start:i])
			}
			switch c {
			case '"':
				buf.WriteString(`\"`)
			case '\\':
				buf.WriteString(`\\`)
			case '\n':
				buf.WriteString(`\n`)
			case '\r':
				buf.WriteString(`\r`)
			case '\t':
				buf.WriteString(`\t`)
			case '\b':
				buf.WriteString(`\b`)
			case '\f':
				buf.WriteString(`\f`)
			default:
				buf.WriteString(`\u00`)
				buf.WriteByte(hexDigits[c>>4])
				buf.WriteByte(hexDigits[c&0xF])
			}
			i++
			start = i
			continue
		}
		i++
	}
	if start < len(s) {
		buf.WriteString(s[start:])
	}
	buf.WriteByte('"')
}

// FromAny converts a plain Go value — such as one produced by json.Unmarshal
// into an any, or hand-built by a caller — into the [Value] model. Because Go
// maps have no defined iteration order, map[string]any members are inserted in
// sorted key order for determinism; use [Decode] when source member order must
// be preserved. Recognized dynamic types are nil, bool, string, [Number],
// json.Number, float64, all sized int/uint kinds, []any/[]Value, and
// map[string]any/map[string]Value.
func FromAny(v any) (Value, error) {
	switch x := v.(type) {
	case nil:
		return nil, nil
	case bool:
		return x, nil
	case string:
		return x, nil
	case Number:
		return x, nil
	case *Object:
		return x, nil
	case json.Number:
		if !ValidNumberText(x.String()) {
			return nil, fmt.Errorf("schemapatch: %q is not a valid JSON number", x.String())
		}
		return Number{text: x.String()}, nil
	case float64:
		return numberFromFloat(x, 64)
	case float32:
		return numberFromFloat(float64(x), 32)
	case int:
		return Number{text: strconv.FormatInt(int64(x), 10)}, nil
	case int8:
		return Number{text: strconv.FormatInt(int64(x), 10)}, nil
	case int16:
		return Number{text: strconv.FormatInt(int64(x), 10)}, nil
	case int32:
		return Number{text: strconv.FormatInt(int64(x), 10)}, nil
	case int64:
		return Number{text: strconv.FormatInt(x, 10)}, nil
	case uint:
		return Number{text: strconv.FormatUint(uint64(x), 10)}, nil
	case uint8:
		return Number{text: strconv.FormatUint(uint64(x), 10)}, nil
	case uint16:
		return Number{text: strconv.FormatUint(uint64(x), 10)}, nil
	case uint32:
		return Number{text: strconv.FormatUint(uint64(x), 10)}, nil
	case uint64:
		return Number{text: strconv.FormatUint(x, 10)}, nil
	case []any:
		// []Value is identical to []any under the Value alias.
		out := make([]Value, len(x))
		for i, e := range x {
			c, err := FromAny(e)
			if err != nil {
				return nil, err
			}
			out[i] = c
		}
		return out, nil
	case map[string]any:
		// map[string]Value is identical to map[string]any under the alias.
		return mapToObject(x)
	default:
		return nil, fmt.Errorf("schemapatch: cannot convert value of type %T", v)
	}
}

// numberFromFloat converts a Go float to a [Number], rejecting the non-finite
// values (NaN, +Inf, -Inf) that have no JSON representation (CORE §1.2). bitSize
// (32 or 64) controls the shortest-round-trip formatting so a float32 does not
// gain spurious f64 precision digits.
func numberFromFloat(f float64, bitSize int) (Value, error) {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return nil, fmt.Errorf("schemapatch: %v has no JSON number representation", f)
	}
	return Number{text: strconv.FormatFloat(f, 'g', -1, bitSize)}, nil
}

func mapToObject(m map[string]any) (Value, error) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	obj := NewObject()
	for _, k := range keys {
		c, err := FromAny(any(m[k]))
		if err != nil {
			return nil, err
		}
		obj.Set(k, c)
	}
	return obj, nil
}

// ToAny converts a [Value] into a plain Go value. Objects become
// map[string]any (member order is lost — encode with [Encode] if order matters)
// and Numbers become json.Number (preserving literal text). Scalars pass
// through unchanged.
func ToAny(v Value) any {
	switch x := v.(type) {
	case Number:
		return json.Number(x.text)
	case []Value:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = ToAny(e)
		}
		return out
	case *Object:
		m := make(map[string]any, len(x.keys))
		for i, k := range x.keys {
			m[k] = ToAny(x.vals[i])
		}
		return m
	default:
		return v
	}
}
