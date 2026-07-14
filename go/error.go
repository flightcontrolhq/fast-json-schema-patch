package schemapatch

import "fmt"

// ErrorCode identifies the reason a patch operation failed (SPEC §8.6).
type ErrorCode string

// The complete set of failure codes (SPEC §8.6). These string values are the
// normative codes carried by conformance vectors and MUST match exactly.
const (
	// CodeInvalidPointer is a malformed pointer on WRITE-side resolution: "-" on
	// a remove/replace final or any non-final segment (SPEC §3.5), or a
	// leading-zero/sign/decimal array index (SPEC §3.6).
	CodeInvalidPointer ErrorCode = "INVALID_POINTER"
	// CodePathUnresolvable is a target or intermediate segment that does not
	// exist (SPEC §8.2.2), including a malformed or "-" segment met during
	// READ-side resolution (test, move/copy source) and a read-side
	// __proto__/constructor/prototype segment (SPEC §8.6.1).
	CodePathUnresolvable ErrorCode = "PATH_UNRESOLVABLE"
	// CodeIndexOutOfBounds is an array index out of range for the op (SPEC §8.3.1).
	CodeIndexOutOfBounds ErrorCode = "INDEX_OUT_OF_BOUNDS"
	// CodeTestFailed is a test op value mismatch (SPEC §8.3).
	CodeTestFailed ErrorCode = "TEST_FAILED"
	// CodeOldValueMismatch is a validateOldValues failure: the document value
	// differs from op.oldValue (SPEC §8.4).
	CodeOldValueMismatch ErrorCode = "OLD_VALUE_MISMATCH"
	// CodeInvalidOperation is an unknown op, a missing required field
	// (value/from), a remove at the document root, or a move into own child
	// (SPEC §8.6).
	CodeInvalidOperation ErrorCode = "INVALID_OPERATION"
	// CodeUnsafeKey is the prototype-pollution guard tripping on a write-side
	// __proto__/constructor.prototype segment (SPEC §8.6.1).
	CodeUnsafeKey ErrorCode = "UNSAFE_KEY"
)

// Sentinel errors, one per code, usable as errors.Is targets. A concrete
// *PatchError matches its code's sentinel: errors.Is(err, ErrTestFailed) is true
// for any *PatchError whose Code is CodeTestFailed.
var (
	ErrInvalidPointer   = &PatchError{Code: CodeInvalidPointer}
	ErrPathUnresolvable = &PatchError{Code: CodePathUnresolvable}
	ErrIndexOutOfBounds = &PatchError{Code: CodeIndexOutOfBounds}
	ErrTestFailed       = &PatchError{Code: CodeTestFailed}
	ErrOldValueMismatch = &PatchError{Code: CodeOldValueMismatch}
	ErrInvalidOperation = &PatchError{Code: CodeInvalidOperation}
	ErrUnsafeKey        = &PatchError{Code: CodeUnsafeKey}
)

// PatchError is returned by apply/invert when an operation fails. It mirrors the
// reference JsonPatchError (SPEC §8.6): Code is the failure category, OpIndex is
// the 0-based index of the failing op within the patch, and Op is the failing
// operation (nil when the failure is not attributable to a specific op).
type PatchError struct {
	Code    ErrorCode
	Message string
	OpIndex int
	Op      *Operation
}

// NewPatchError constructs a PatchError.
func NewPatchError(code ErrorCode, message string, opIndex int, op *Operation) *PatchError {
	return &PatchError{Code: code, Message: message, OpIndex: opIndex, Op: op}
}

// Error implements error.
func (e *PatchError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("schemapatch: %s (op %d)", e.Code, e.OpIndex)
	}
	return fmt.Sprintf("schemapatch: %s: %s (op %d)", e.Code, e.Message, e.OpIndex)
}

// Is reports whether target is a *PatchError with the same Code, enabling
// errors.Is(err, ErrTestFailed)-style matching against the sentinels above.
func (e *PatchError) Is(target error) bool {
	t, ok := target.(*PatchError)
	return ok && t.Code == e.Code
}
