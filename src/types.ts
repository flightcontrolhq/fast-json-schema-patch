import type { Location } from "json-source-map";

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export type JsonObject = { [Key in string]?: JsonValue };
export type JsonArray = JsonValue[];

export interface AggregationConfig {
  pathPrefix: string
  original: JsonValue
  modified: JsonValue
  patches?: Operation[]
}

export interface AggregatedDiffResult {
  parentDiff: AggregatedParentDiff
  childDiffs: Record<string, AggregatedChildDiff>
}

export interface AggregatedParentDiff {
  original: JsonValue
  new: JsonValue
  patches: Operation[]
  diffLines: FormattedDiff
  addCount: number
  removeCount: number
}

export interface AggregatedChildDiff {
  id: string
  original: JsonObject
  new: JsonObject
  patches: Operation[]
  diffLines: FormattedDiff
  addCount: number
  removeCount: number
}

export interface Operation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: JsonValue;
  from?: string;
  oldValue?: JsonValue;
}

export interface DiffLine {
  lineNumber: number;
  content: string;
  type: "added" | "removed" | "unchanged";
}

export interface FormattedDiff {
  originalLines: DiffLine[];
  newLines: DiffLine[];
  unifiedDiffLines: UnifiedDiffLine[];
}

export interface UnifiedDiffLine {
  type: "added" | "removed" | "unchanged" | string;
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