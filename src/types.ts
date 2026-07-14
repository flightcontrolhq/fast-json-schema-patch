import type { Location } from "json-source-map";

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export type JsonObject = { [Key in string]?: JsonValue };
export type JsonArray = JsonValue[];

export interface StructuredDiffConfig {
  pathPrefix: string
  original: JsonValue
  modified: JsonValue
  patches?: Operation[]
}

export interface StructuredDiffResult {
  parentDiff: FormattedParentDiff
  childDiffs: Record<string, FormattedChildDiff>
}

export interface FormattedParentDiff {
  original: JsonValue
  new: JsonValue
  patches: Operation[]
  diffLines: StructuredDiffLine[]
  addCount: number
  removeCount: number
}

export interface FormattedChildDiff {
  id: string
  original: JsonObject
  new: JsonObject
  patches: Operation[]
  diffLines: StructuredDiffLine[]
  addCount: number
  removeCount: number
}

export interface FormattedDiffLines {
  originalLines: DiffLine[]
  newLines: DiffLine[]
  unifiedDiffLines: StructuredDiffLine[]
}

export interface Operation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: JsonValue;
  from?: string;
  oldValue?: JsonValue;
}

/**
 * F27: the narrow, discriminated shape `JsonSchemaPatcher.execute()` actually
 * emits — a strict subset of the wide RFC 6902 `Operation` used by
 * `applyPatch`/`invertPatch` (which must also accept hand-written `copy`/
 * `test` ops and `move` ops as valid patch input). The diff generator never
 * emits `copy` or `test`; `move` is only ever emitted when the P3 `emitMoves`
 * capability (SPEC §5.8, §10.4.4) is enabled on the `JsonSchemaPatcher`, but
 * the type itself is unconditional — callers that never opt into `emitMoves`
 * simply never observe the `move` variant at runtime.
 *
 * Each `DiffOperation` variant is structurally assignable to `Operation`, so
 * `DiffOperation[]` is usable anywhere `Operation[]` is expected (e.g. as
 * input to `applyPatch`/`invertPatch`/`toRfc6902`) without a cast.
 */
export type DiffOperation =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "remove"; path: string; oldValue?: JsonValue }
  | { op: "replace"; path: string; value: JsonValue; oldValue?: JsonValue }
  | { op: "move"; path: string; from: string };

export interface DiffLine {
  lineNumber: number;
  content: string;
  type: "added" | "removed" | "unchanged";
}

export interface StructuredDiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  key: string;
}

export interface PathMap {
  [path: string]: {
    key: Location;
    value: Location;
    valueEnd: Location;
  };
} 