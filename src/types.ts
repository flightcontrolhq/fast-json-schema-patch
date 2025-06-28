import type { Location } from "json-source-map";

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export type JsonObject = { [Key in string]?: JsonValue };
export type JsonArray = JsonValue[];

export type Operation =
  | { op: "add"; path: string; value: JsonValue }
  | { op: "remove"; path: string; oldValue?: JsonValue }
  | { op: "replace"; path: string; value: JsonValue; oldValue?: JsonValue }
  | { op: "move"; from: string; path: string };

export interface DiffLine {
  lineNumber: number;
  content: string;
  type: "added" | "removed" | "unchanged";
}

export interface SideBySideDiff {
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