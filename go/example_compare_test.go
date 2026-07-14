package schemapatch_test

import (
	"encoding/json"
	"fmt"

	schemapatch "github.com/flightcontrolhq/fast-json-schema-patch/go"
)

// Deployment-like types mirror the headline "diff two typed values" use case:
// a keyed containers slice whose elements are matched by name, not position.
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

// ExampleCompare diffs two typed Go structs. The schema marks each container's
// `name` as required, so the containers slice is matched by key (SPEC §4.5): a
// reordering with one image bump collapses to a single replace, instead of the
// two positional rewrites a schemaless diff would emit.
func ExampleCompare() {
	// `name` required => primaryKey strategy on /template/containers.
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
	// Output:
	// [
	//   {
	//     "op": "replace",
	//     "path": "/replicas",
	//     "value": 3,
	//     "oldValue": 2
	//   },
	//   {
	//     "op": "replace",
	//     "path": "/template/containers/0/image",
	//     "value": "nginx:1.27",
	//     "oldValue": "nginx:1.25"
	//   }
	// ]
}
