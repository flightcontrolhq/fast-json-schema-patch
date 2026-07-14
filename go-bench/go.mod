module github.com/flightcontrolhq/fast-json-schema-patch/go-bench

go 1.24

replace github.com/flightcontrolhq/fast-json-schema-patch/go => ../go

require (
	github.com/evanphx/json-patch/v5 v5.9.11
	github.com/flightcontrolhq/fast-json-schema-patch/go v0.0.0-00010101000000-000000000000
	github.com/mattbaird/jsonpatch v0.0.0-20240118010651-0ba75a80ca38
	github.com/snorwin/jsonpatch v1.5.0
	github.com/wI2L/jsondiff v0.7.1
)

require (
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/evanphx/json-patch v0.5.2 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	github.com/tidwall/gjson v1.18.0 // indirect
	github.com/tidwall/match v1.1.1 // indirect
	github.com/tidwall/pretty v1.2.1 // indirect
	github.com/tidwall/sjson v1.2.5 // indirect
)
