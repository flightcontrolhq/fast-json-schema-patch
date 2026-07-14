export { JsonSchemaPatcher } from "./core/JsonSchemaPatcher";
export { buildPlan } from "./core/buildPlan";
// Back-compat: StructuredDiff historically lived on the root entry. It now
// has a dedicated `./aggregators` subpath (F12), but the root re-export stays
// so `import { StructuredDiff } from "fast-json-schema-patch"` keeps working.
export { StructuredDiff } from "./aggregators/StructuredDiff";
export { applyPatch, invertPatch, toRfc6902, JsonPatchError } from "./apply/applyPatch";
export type { ApplyPatchOptions, PatchErrorCode } from "./apply/applyPatch";

export type {
  StructuredDiffConfig,
  StructuredDiffResult,
  FormattedParentDiff,
  FormattedChildDiff,
  StructuredDiffLine,
  Operation,
} from "./types";
export type { Plan, BuildPlanOptions } from "./core/buildPlan";
