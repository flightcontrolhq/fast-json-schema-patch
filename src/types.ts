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