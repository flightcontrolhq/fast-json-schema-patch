export { JsonSchemaPatcher } from "./core/JsonSchemaPatcher";
export { buildPlan } from "./core/buildPlan";
// Back-compat: StructuredDiff historically lived on the root entry. It now
// has a dedicated `./aggregators` subpath (F12), but the root re-export stays
// so `import { StructuredDiff } from "fast-json-schema-patch"` keeps working.
export { StructuredDiff } from "./aggregators/StructuredDiff";
export { applyPatch, invertPatch, toRfc6902, JsonPatchError } from "./apply/applyPatch";
export type { ApplyPatchOptions, PatchErrorCode } from "./apply/applyPatch";
// F32: register a handler for the one internal warning cache.ts can hit
// (a JSON parse failure while building a path map for formatting/diffLines).
// Silent by default.
export { setWarningHandler } from "./performance/cache";

export type {
  StructuredDiffConfig,
  StructuredDiffResult,
  FormattedParentDiff,
  FormattedChildDiff,
  StructuredDiffLine,
  Operation,
  DiffOperation,
} from "./types";
export type { Plan, BuildPlanOptions } from "./core/buildPlan";
