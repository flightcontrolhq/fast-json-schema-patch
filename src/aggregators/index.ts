// Entry point for the `fast-json-schema-patch/aggregators` subpath (F12).
// Kept deliberately separate from the root `.` entry: StructuredDiff pulls in
// the formatting stack (DiffFormatter, json-source-map) that patch-only
// consumers of `JsonSchemaPatcher` don't need to bundle (F26).

export type {
	FormattedChildDiff,
	FormattedParentDiff,
	Operation,
	StructuredDiffConfig,
	StructuredDiffLine,
	StructuredDiffResult,
} from "../types";
export { StructuredDiff } from "./StructuredDiff";
