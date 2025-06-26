// Public API
export { createPatcher } from "./core/patcher";

// Core Types
export type {
	DiffDelta,
	JsonValue,
	JsonObject,
	JsonArray,
	FinalPatch,
	FormattedOperation,
	PatcherOptions,
	DiffOptions,
	PatcherInstance,
	Plan,
	JSONSchema,
} from "./types";

// Module interfaces
export type {
	IAggregator,
	IDiffEngine,
	IExplainer,
	IParser,
	IPlanner,
} from "./types";
