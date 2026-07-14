package schemapatch

import (
	"errors"
	"strings"
	"testing"
)

func TestPatchErrorIsBySentinel(t *testing.T) {
	pairs := []struct {
		err      *PatchError
		sentinel error
		code     ErrorCode
	}{
		{NewPatchError(CodeInvalidPointer, "m", 0, nil), ErrInvalidPointer, CodeInvalidPointer},
		{NewPatchError(CodePathUnresolvable, "m", 1, nil), ErrPathUnresolvable, CodePathUnresolvable},
		{NewPatchError(CodeIndexOutOfBounds, "m", 2, nil), ErrIndexOutOfBounds, CodeIndexOutOfBounds},
		{NewPatchError(CodeTestFailed, "m", 3, nil), ErrTestFailed, CodeTestFailed},
		{NewPatchError(CodeOldValueMismatch, "m", 4, nil), ErrOldValueMismatch, CodeOldValueMismatch},
		{NewPatchError(CodeInvalidOperation, "m", 5, nil), ErrInvalidOperation, CodeInvalidOperation},
		{NewPatchError(CodeUnsafeKey, "m", 6, nil), ErrUnsafeKey, CodeUnsafeKey},
	}
	for _, p := range pairs {
		var err error = p.err
		if !errors.Is(err, p.sentinel) {
			t.Errorf("errors.Is(%s, sentinel) = false", p.code)
		}
		// A different code must not match.
		if errors.Is(err, ErrTestFailed) && p.code != CodeTestFailed {
			t.Errorf("%s wrongly matched ErrTestFailed", p.code)
		}
	}
}

func TestPatchErrorMessage(t *testing.T) {
	e := NewPatchError(CodeTestFailed, "value mismatch", 3, nil)
	msg := e.Error()
	if !strings.Contains(msg, "TEST_FAILED") || !strings.Contains(msg, "value mismatch") || !strings.Contains(msg, "3") {
		t.Fatalf("Error() = %q", msg)
	}
	// Empty message still reports the code and index.
	bare := NewPatchError(CodeUnsafeKey, "", 7, nil)
	if !strings.Contains(bare.Error(), "UNSAFE_KEY") || !strings.Contains(bare.Error(), "7") {
		t.Fatalf("bare Error() = %q", bare.Error())
	}
}

func TestPatchErrorCarriesOpAndIndex(t *testing.T) {
	op := &Operation{Op: OpRemove, Path: "/a"}
	e := NewPatchError(CodePathUnresolvable, "missing", 5, op)
	if e.OpIndex != 5 || e.Op != op || e.Code != CodePathUnresolvable {
		t.Fatalf("fields not preserved: %+v", e)
	}
}
