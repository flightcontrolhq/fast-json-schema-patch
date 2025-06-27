import { parse } from "json-source-map";
import { resolvePatchPath } from "./path-utils";
import { cachedJsonStringify, cachedBuildPathMap } from "./json-cache";
import type {
  DiffLine,
  JsonValue,
  Operation,
  PathMap,
  SideBySideDiff,
  UnifiedDiffLine,
} from "./types";



function getPathLineRange(
  pathMap: PathMap,
  path: string,
  jsonObj: JsonValue,
  isForNewVersion = false
): { start: number; end: number } | null {
  const resolvedPath = resolvePatchPath(path, jsonObj, isForNewVersion);
  if (!resolvedPath) return null;

  const info = pathMap[resolvedPath];
  if (info?.value && info.valueEnd) {
    return {
      start: info.value.line + 1,
      end: info.valueEnd.line + 1,
    };
  }

  const pathParts = resolvedPath.split("/").filter((p) => p !== "");
  for (let i = pathParts.length; i > 0; i--) {
    const parentPath = `/${pathParts.slice(0, i).join("/")}`;
    const parentInfo = pathMap[parentPath];
    if (parentInfo?.value && parentInfo.valueEnd) {
      return {
        start: parentInfo.value.line + 1,
        end: parentInfo.valueEnd.line + 1,
      };
    }
  }
  return null;
}

export class DiffFormatter {
  private originalJson: JsonValue;
  private newJson: JsonValue;
  private originalPathMap: PathMap;
  private newPathMap: PathMap;

  constructor(originalJson: JsonValue, newJson: JsonValue) {
    this.originalJson = originalJson;
    this.newJson = newJson;
    this.originalPathMap = cachedBuildPathMap(originalJson);
    this.newPathMap = cachedBuildPathMap(newJson);
  }

  format(patches: Operation[]): SideBySideDiff {
    const originalAffectedLines = new Set<number>();
    const newAffectedLines = new Set<number>();

    for (const op of patches) {
      if (op.op === "remove" || op.op === "replace") {
        const range = getPathLineRange(
          this.originalPathMap,
          op.path,
          this.originalJson,
          false
        );
        if (range) {
          for (let i = range.start; i <= range.end; i++) {
            originalAffectedLines.add(i);
          }
        }
      }

      if (op.op === "add" || op.op === "replace") {
        const range = getPathLineRange(
          this.newPathMap,
          op.path,
          this.newJson,
          true
        );
        if (range) {
          for (let i = range.start; i <= range.end; i++) {
            newAffectedLines.add(i);
          }
        }
      }
    }

    const originalFormatted = cachedJsonStringify(this.originalJson);
    const newFormatted = cachedJsonStringify(this.newJson);

    const originalLines = originalFormatted.split("\n");
    const newLines = newFormatted.split("\n");

    const originalDiffLines: DiffLine[] = originalLines.map((line, index) => ({
      lineNumber: index + 1,
      content: line,
      type: originalAffectedLines.has(index + 1) ? "removed" : "unchanged",
    }));

    const newDiffLines: DiffLine[] = newLines.map((line, index) => ({
      lineNumber: index + 1,
      content: line,
      type: newAffectedLines.has(index + 1) ? "added" : "unchanged",
    }));

    const unified: UnifiedDiffLine[] = [];
    let i = 0;
    let j = 0;

    while (i < originalDiffLines.length || j < newDiffLines.length) {
      const iLine = originalDiffLines[i];
      const jLine = newDiffLines[j];

      if (iLine?.type === "unchanged" && jLine?.type === "unchanged") {
        if (iLine && jLine) {
          unified.push({
            type: "unchanged",
            content: iLine.content,
            oldLineNumber: iLine.lineNumber,
            newLineNumber: jLine.lineNumber,
            key: `unchanged-${iLine.lineNumber}-${jLine.lineNumber}`,
          });
        }
        i++;
        j++;
        continue;
      }

      const iBefore = i;
      const jBefore = j;

      while (
        i < originalDiffLines.length &&
        originalDiffLines[i]?.type === "removed"
      ) {
        const line = originalDiffLines[i];
        if (line) {
          unified.push({
            type: "removed",
            content: line.content,
            oldLineNumber: line.lineNumber,
            key: `removed-${line.lineNumber}`,
          });
        }
        i++;
      }

      while (j < newDiffLines.length && newDiffLines[j]?.type === "added") {
        const line = newDiffLines[j];
        if (line) {
          unified.push({
            type: "added",
            content: line.content,
            newLineNumber: line.lineNumber,
            key: `added-${line.lineNumber}`,
          });
        }
        j++;
      }

      // If we're stuck, advance pointers to avoid infinite loop
      if (i === iBefore && j === jBefore) {
        if (i < originalDiffLines.length) {
          const line = originalDiffLines[i];
          if (line) {
            unified.push({
              type: line.type,
              content: line.content,
              oldLineNumber: line.lineNumber,
              key: `stuck-i-${line.lineNumber}`,
            });
          }
          i++;
        }
        if (j < newDiffLines.length) {
          const line = newDiffLines[j];
          if (line) {
            unified.push({
              type: line.type,
              content: line.content,
              newLineNumber: line.lineNumber,
              key: `stuck-j-${line.lineNumber}`,
            });
          }
          j++;
        }
      }
    }

    return {
      originalLines: originalDiffLines,
      newLines: newDiffLines,
      unifiedDiffLines: unified,
    };
  }
}
