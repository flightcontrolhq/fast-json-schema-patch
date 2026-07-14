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

The fastest way in is `Compare` — hand it two Go values (typed structs, maps,
slices, or already-decoded JSON) and a JSON Schema, and it returns the patch. It
marshals each argument with `encoding/json` under the hood, so it feels like the
typed-value diffing you may know from `wI2L/jsondiff`.

```go
package main

import (
	"encoding/json"
	"fmt"

	schemapatch "github.com/flightcontrolhq/fast-json-schema-patch/go"
)

// Deployment-like types with a keyed containers slice.
type Container struct {
	Name  string `json:"name"`
	Image string `json:"image"`
}
type PodSpec struct {
	Containers []Container `json:"containers"`
}
type Deployment struct {
	Replicas int     `json:"replicas"`
	Template PodSpec `json:"template"`
}

func main() {
	// Describe your data with a JSON Schema. Each container's `name` is
	// `required`, so the containers slice auto-detects the `primaryKey` diffing
	// strategy (§4.5): elements are matched by key, not by position.
	schema := json.RawMessage(`{
		"type": "object",
		"properties": {
			"template": {
				"type": "object",
				"properties": {
					"containers": {
						"type": "array",
						"items": {
							"type": "object",
							"required": ["name"],
							"properties": {
								"name":  {"type": "string"},
								"image": {"type": "string"}
							}
						}
					}
				}
			}
		}
	}`)

	original := Deployment{
		Replicas: 2,
		Template: PodSpec{Containers: []Container{
			{Name: "web", Image: "nginx:1.25"},
			{Name: "sidecar", Image: "envoy:1.29"},
		}},
	}
	modified := Deployment{
		Replicas: 3,
		Template: PodSpec{Containers: []Container{
			// containers reordered; only web's image changed
			{Name: "sidecar", Image: "envoy:1.29"},
			{Name: "web", Image: "nginx:1.27"},
		}},
	}

	patch, err := schemapatch.Compare(schema, original, modified)
	if err != nil {
		panic(err)
	}

	out, err := json.MarshalIndent(patch, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(out))
	// The reorder is absorbed by the keyed match — only the changed fields emit:
	// [
	//   {"op":"replace","path":"/replicas","value":3,"oldValue":2},
	//   {"op":"replace","path":"/template/containers/0/image","value":"nginx:1.27","oldValue":"nginx:1.25"}
	// ]
}
```

Pass `nil` for the schema to diff schemalessly (every array uses lcs). The
capability toggles from [NewPatcher](#capability-options) work here too:
`schemapatch.Compare(schema, a, b, schemapatch.EmitMoves(true))`.

### Already have JSON bytes?

`CompareJSON` is the same one-call flow when your documents are already
serialized. It decodes each through the ordered value model, so object member
order and numeric literal text are preserved end-to-end (SPEC §2.2) — a guarantee
`Compare` cannot make because `encoding/json` canonicalizes on the way in (see
[Determinism](#determinism)).

```go
schema := []byte(`{ "type": "object", "properties": { ... } }`)
original := []byte(`{"users":[{"id":"user1","status":"active"}]}`)
modified := []byte(`{"users":[{"id":"user1","status":"online"}]}`)

patch, err := schemapatch.CompareJSON(schema, original, modified)
if err != nil {
	panic(err)
}
out, err := schemapatch.EncodeOperations(patch) // compact JSON patch array
if err != nil {
	panic(err)
}
fmt.Println(string(out))
```

`CompareJSON(nil, a, b)` diffs schemalessly. This emits the same bytes as the
[TypeScript quick start](../README.md#-quick-start) — the two engines are
byte-identical.

### Determinism

Both entry points are deterministic for fixed inputs, but they canonicalize
differently:

- **`CompareJSON` (bytes) preserves source shape.** `Decode` keeps object member
  order and number literal text exactly as written (SPEC §2.2). This is the
  documented deterministic route — use it when member order or a specific numeric
  literal must survive into the patch.
- **`Compare` (values) canonicalizes via `encoding/json`.** Struct fields marshal
  in declaration order (deterministic, and yours to control). `map[K]V` members
  marshal in **sorted key order** — deterministic across runs, but a map's
  original insertion order is not preserved (Go maps have none). Non-finite floats
  (`NaN`, `±Inf`) are rejected with an error, consistent with the value model's
  own rejection of numbers with no JSON representation (SPEC §2.2).

### Advanced: the ordered `Value` pipeline

`Compare`/`CompareJSON` build a `Plan` and run a `Patcher` for you. When you need
plan reuse across many diffs, non-default `BuildPlanOptions` (`PrimaryKeyMap`,
`BasePath`, custom candidates), or to hold documents in the ordered value model
directly, drive the three stages yourself:

```go
schema, err := schemapatch.Decode([]byte(`{ "type": "object", "properties": { ... } }`))
if err != nil {
	panic(err)
}

// Build the plan once, reuse it for every diff against this schema.
plan, err := schemapatch.BuildPlan(schema, schemapatch.BuildPlanOptions{})
if err != nil {
	panic(err)
}
patcher := schemapatch.NewPatcher(plan) // add capability options here

original, err := schemapatch.Decode([]byte(`{"users":[{"id":"user1","status":"active"}]}`))
if err != nil {
	panic(err)
}
modified, err := schemapatch.Decode([]byte(`{"users":[{"id":"user1","status":"online"}]}`))
if err != nil {
	panic(err)
}

patch := patcher.Execute(original, modified)
out, err := schemapatch.EncodeOperations(patch)
if err != nil {
	panic(err)
}
fmt.Println(string(out))
```

## Applying and inverting

```go
// Reconstruct the modified document from original + patch.
result, err := schemapatch.ApplyPatch(original, patch, schemapatch.ApplyOptions{})
if err != nil {
	panic(err)
}

// Compute an undo patch (uses the original, pre-patch document).
undo, err := schemapatch.InvertPatch(original, patch)
if err != nil {
	panic(err)
}
applied, err := schemapatch.ApplyPatch(result, undo, schemapatch.ApplyOptions{})
if err != nil {
	panic(err)
}
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
(SPEC §10.4), and `Compare`/`CompareJSON` forward their trailing `opts` straight
through to it. The defaults reproduce pre-capability output byte-for-byte:

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
