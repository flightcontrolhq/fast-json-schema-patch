import { parse } from "json-source-map";
import type {
  DiffLine,
  JsonObject,
  JsonValue,
  Operation,
  PathMap,
  SideBySideDiff,
  UnifiedDiffLine,
} from "./types";

function buildPathMap(jsonText: string): PathMap {
  try {
    const { pointers } = parse(jsonText);
    return pointers as unknown as PathMap;
  } catch (error) {
    console.error("Error building path map:", error);
    return {};
  }
}

function resolvePatchPath(
  path: string,
  jsonObj: JsonValue,
  isForNewVersion = false
): string | null {
  if (path.endsWith("/-")) {
    const parentPath = path.slice(0, -2);
    if (parentPath === "") {
      if (Array.isArray(jsonObj)) {
        if (isForNewVersion) {
          return `/${jsonObj.length - 1}`;
        }
        return `/${jsonObj.length}`;
      }
      return null;
    }
    const pathParts = parentPath.split("/").filter((p) => p !== "");
    let current: JsonValue = jsonObj;

    for (const part of pathParts) {
      if (typeof current !== "object" || current === null) return null;
      let next: JsonValue | undefined;
      if (Array.isArray(current)) {
        next = current[Number.parseInt(part)];
      } else {
        const obj = current as JsonObject;
        if (!Object.hasOwn(obj, part)) return null;
        next = obj[part];
      }
      if (next === undefined) return null;
      current = next;
    }

    if (Array.isArray(current)) {
      if (isForNewVersion) {
        return `${parentPath}/${current.length - 1}`;
      }
      return parentPath;
    }
  }
  return path;
}

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
    const originalFormatted = JSON.stringify(originalJson, null, 2);
    this.originalPathMap = buildPathMap(originalFormatted);
    const newFormatted = JSON.stringify(newJson, null, 2);
    this.newPathMap = buildPathMap(newFormatted);
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

    const originalFormatted = JSON.stringify(this.originalJson, null, 2);
    const newFormatted = JSON.stringify(this.newJson, null, 2);

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
