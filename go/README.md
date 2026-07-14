# fast-json-schema-patch (Go)

A Go port of [`fast-json-schema-patch`](../README.md) — schema-aware JSON patch
generation, application, and inversion. This is the **Go engine**: a separate
implementation of the same normative behavior described in [`SPEC.md`](../SPEC.md)
(spec-v1), verified against the shared conformance vectors under
[`spec/vectors`](../spec/vectors) and a differential-fuzz corpus that pins it
byte-for-byte to the TypeScript reference.

- Module path: `github.com/flightcontrolhq/fast-json-schema-patch/go`
- Package name: `schemapatch`
- Requires Go >= 1.22
- **Zero third-party dependencies** — standard library only.

## Install

```sh
go get github.com/flightcontrolhq/fast-json-schema-patch/go
```

## Quick start

Unlike `encoding/json`'s `map[string]any`, this library uses an **ordered value
model** so that object member order and numeric literal text survive a
decode→diff→encode round-trip (SPEC §2.2). You bring your documents in as JSON
bytes and decode them with `Decode`; you serialize patches and results back out
with `EncodeOperations` / `Encode`.

```go
package main

import (
	"fmt"

	schemapatch "github.com/flightcontrolhq/fast-json-schema-patch/go"
)

func main() {
	// 0. Describe your data with a JSON Schema. `id` is `required`, so the
	//    `users` array auto-detects the `primaryKey` diffing strategy (§4.5).
	schema, err := schemapatch.Decode([]byte(`{
		"type": "object",
		"properties": {
			"users": {
				"type": "array",
				"items": {
					"type": "object",
					"required": ["id"],
					"properties": {
						"id":     {"type": "string"},
						"name":   {"type": "string"},
						"status": {"type": "string"}
					}
				}
			}
		}
	}`))
	if err != nil {
		panic(err)
	}

	// 1. Build a plan from the schema — done once per schema.
	plan, err := schemapatch.BuildPlan(schema, schemapatch.BuildPlanOptions{})
	if err != nil {
		panic(err)
	}

	// 2. Decode the documents through the ordered value model.
	original, _ := schemapatch.Decode([]byte(`{
		"users": [
			{"id": "user1", "name": "John Doe",   "status": "active"},
			{"id": "user2", "name": "Jane Smith", "status": "inactive"}
		]
	}`))
	modified, _ := schemapatch.Decode([]byte(`{
		"users": [
			{"id": "user1", "name": "John Doe", "status": "online"},
			{"id": "user3", "name": "Sam Ray",  "status": "active"}
		]
	}`))

	// 3. Diff. NewPatcher takes the plan plus optional capability toggles.
	patch := schemapatch.NewPatcher(plan).Execute(original, modified)

	out, _ := schemapatch.EncodeOperations(patch)
	fmt.Println(string(out))
	// Output (modifications first, then removals, then `/-` appends — see
	// SPEC.md §5.4.1.4 for the primaryKey strategy's normative emission order):
	// [
	//   {"op":"replace","path":"/users/0/status","value":"online","oldValue":"active"},
	//   {"op":"remove","path":"/users/1","oldValue":{"id":"user2","name":"Jane Smith","status":"inactive"}},
	//   {"op":"add","path":"/users/-","value":{"id":"user3","name":"Sam Ray","status":"active"}}
	// ]
}
```

This is the same schema, documents, and output as the [TypeScript quick
start](../README.md#-quick-start) — the two engines emit byte-identical patches.

## Applying and inverting

```go
// Reconstruct the modified document from original + patch.
result, err := schemapatch.ApplyPatch(original, patch, schemapatch.ApplyOptions{})

// Compute an undo patch (uses the original, pre-patch document).
undo, err := schemapatch.InvertPatch(original, patch)
applied, _ := schemapatch.ApplyPatch(result, undo, schemapatch.ApplyOptions{})
// applied deep-equals original — check with schemapatch.DeepEqual(applied, original)
```

`ApplyPatch` guarantees (SPEC §8):

- **Immutable** — the input document is never mutated; untouched subtrees are
  shared by reference (copy-on-write). Pass `ApplyOptions{CloneResult: true}` if
  you need a fully independent copy to mutate afterwards.
- **Atomic** — on the first failing op it returns a `*PatchError` (with `Code`
  and `OpIndex`) and the input is left untouched. Match specific failures with
  `errors.Is(err, schemapatch.ErrTestFailed)` (one exported sentinel per code)
  or pull out the `*PatchError` with `errors.As`.
- **Validating** — `ApplyOptions{ValidateOldValues: true}` checks each
  `remove`/`replace` op's `oldValue` against the current document first (an
  implicit `test`), failing with `OLD_VALUE_MISMATCH` on drift.
- **Safe** — pointer segments that would mutate the prototype chain
  (`__proto__`, `constructor`) are rejected with `UNSAFE_KEY`.

## Capability options

`NewPatcher` accepts functional options mirroring the TypeScript capabilities
(SPEC §10.4). The defaults reproduce pre-capability output byte-for-byte:

| Option                              | Default | Effect |
| ----------------------------------- | ------- | ------ |
| `IncludeOldValue(bool)`             | `true`  | Attach the full prior value as `oldValue` on every `remove`/`replace` (§6.4). Pass `false` to omit it. |
| `EmitMoves(bool)`                   | `false` | Express relocations of otherwise-identical items as `move` ops so the applied document matches `modified`'s order exactly, not just its content (§5.8). |
| `WholesaleReplaceFallback(bool)`    | `false` | For a heavily-rewritten array, replace it wholesale when that is smaller than the element-wise edit script (§5.9), capping patch size. |

```go
patch := schemapatch.NewPatcher(plan,
	schemapatch.IncludeOldValue(false),
	schemapatch.EmitMoves(true),
).Execute(original, modified)
```

`BuildPlan` takes plan-shaping options via `BuildPlanOptions`:

| Field                   | Effect |
| ----------------------- | ------ |
| `PrimaryKeyMap`         | `map[docPath]keyField` — force the `primaryKey` strategy on specific array paths, overriding auto-detection (§4.4.3). |
| `PrimaryKeyCandidates`  | Override the ordered auto-detection candidate list (default `["id","name","port"]`, §4.5.3). An **empty, non-nil** slice disables auto-detection entirely — every object array falls back to `lcs`. A `nil` slice keeps the default. |
| `BasePath`              | Restrict and relativize the plan to the subtree at or under this pointer, for diffing a sub-document (§4.3.1). |

## Value model

Documents are represented as an ordered JSON value model rooted at `Value`
(an alias for `any`):

- **objects** → `*Object`, preserving member order with O(1) key lookup
  (`NewObject`, `(*Object).Get`, `(*Object).Set`);
- **arrays** → `[]Value`;
- **numbers** → `Number`, preserving the original literal text while comparing
  at `float64` (SPEC §2.2);
- **strings / bools / null** → `string` / `bool` / `nil`.

Helpers: `Decode([]byte) (Value, error)` and `Encode(Value) ([]byte, error)`
round-trip preserving member order and number text; `EncodeOperations` /
`DecodeOperations` do the same for `[]Operation`. For interop with ordinary Go
values there are `FromAny(any) (Value, error)` and `ToAny(Value) any`.
`DeepEqual(a, b Value) bool` compares under JSON semantics (§2.4); `Clone` makes
a deep copy.

## Conformance

This engine implements **spec-v1** ([`SPEC.md`](../SPEC.md), final) and is
verified two ways from the `go/` directory:

- `*_conformance_test.go` replay every vector under
  [`spec/vectors/{diff,apply,plan,invert}`](../spec/vectors) — the shared,
  language-neutral oracle (SPEC §10).
- `differential_test.go` replays a seeded differential-fuzz corpus
  ([`spec/fuzz`](../spec/fuzz)) of ~520 records, asserting each Go patch is
  structurally equal to the TypeScript reference's patch and that applying it
  reproduces the reference's applied document — currently **zero mismatches**.

Both suites read `../spec` and `t.Skip` when it is absent (the published-module
case, where only `go/` ships).

```sh
cd go
go vet ./...
go test ./...
gofmt -l .   # must print nothing
```

## Releasing / tagging

This is a **subdirectory module** (it lives in `go/`, not the repo root), so its
Go module version tags MUST be prefixed with the subdirectory path:

```
go/v1.2.3
```

A bare `v1.2.3` tag is **not** picked up by the Go toolchain for this module.
Consumers then depend on it as usual:

```sh
go get github.com/flightcontrolhq/fast-json-schema-patch/go@v1.2.3
```

The Go engine is versioned independently of the npm package; keep its changelog
and tags separate from the TypeScript releases (see [`CONTRIBUTING.md`](../CONTRIBUTING.md)).
