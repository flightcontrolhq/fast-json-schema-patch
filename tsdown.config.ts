import { defineConfig } from "tsdown";

// Two entries (F12): the root `.` export (JsonSchemaPatcher, buildPlan,
// apply/invert/toRfc6902, and a back-compat StructuredDiff re-export) and the
// `./aggregators` subpath (StructuredDiff + its types), which is what
// actually pulls in the formatting stack (DiffFormatter, json-source-map).
// Object-form `entry` keys become output paths under `outDir`, so this
// produces dist/index.{js,cjs,d.ts,d.cts} and dist/aggregators/index.{js,cjs,d.ts,d.cts}.
export default defineConfig({
	entry: {
		index: "src/index.ts",
		"aggregators/index": "src/aggregators/index.ts",
		// Not a public subpath (no package.json "exports" entry) — declaring it as
		// its own entry forces rolldown to give JsonSchemaPatcher its own chunk
		// instead of merging it into a chunk shared with StructuredDiff (both
		// "index" and "aggregators/index" reach JsonSchemaPatcher, so without this
		// it lands in the SAME shared chunk as StructuredDiff/DiffFormatter/
		// json-source-map, defeating the point of splitting the entries at all: a
		// consumer importing only JsonSchemaPatcher from `.` would still pull in
		// that chunk). With JsonSchemaPatcher isolated in its own chunk, a
		// downstream bundler can tree-shake the unused `export { StructuredDiff }`
		// back-compat re-export (and everything only it needs) out of a
		// JsonSchemaPatcher-only build (F26).
		"internal/JsonSchemaPatcher": "src/core/JsonSchemaPatcher.ts",
	},
	dts: true,
	format: ["esm", "cjs"],
	outDir: "./dist",
	platform: "neutral",
	sourcemap: true,
});
