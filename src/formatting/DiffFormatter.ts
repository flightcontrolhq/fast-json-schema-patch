import { resolvePatchPath } from "../utils/pathUtils";
import { cachedJsonStringify, cachedBuildPathMap } from "../performance/cache";
import { fastHash } from "../performance/fashHash";
import type {
  DiffLine,
  JsonValue,
  JsonObject,
  Operation,
  PathMap,
  SideBySideDiff,
  UnifiedDiffLine,
} from "../types";
import type { ArrayPlan } from "../core/buildPlan";

// Enhanced caching for diff formatters with content-based keys
const diffFormatterCache = new Map<string, SideBySideDiff>();

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
  private plan?: ArrayPlan;

  constructor(originalJson: JsonValue, newJson: JsonValue, plan?: ArrayPlan) {
    this.originalJson = originalJson;
    this.newJson = newJson;
    this.originalPathMap = cachedBuildPathMap(originalJson);
    this.newPathMap = cachedBuildPathMap(newJson);
    this.plan = plan;
  }

  format(patches: Operation[]): SideBySideDiff {
    // Enhanced caching: create a cache key based on patches and plan
    const patchesKey = this.createPatchesKey(patches);
    const planKey = this.plan
      ? `${this.plan.primaryKey || ""}-${
          this.plan.hashFields?.join(",") || ""
        }-${this.plan.strategy || ""}`
      : "default";
    const contentHash = fastHash(
      {
        original: JSON.stringify(this.originalJson).substring(0, 100),
        new: JSON.stringify(this.newJson).substring(0, 100),
      },
      ["original", "new"]
    );
    const cacheKey = `${contentHash}-${patchesKey}-${planKey}`;

    // Check cache first
    const cached = diffFormatterCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Generate the diff
    const result = this.generateDiff(patches);

    // Cache the result (keep cache size reasonable)
    if (diffFormatterCache.size > 1000) {
      // Simple cache eviction - clear half when full
      const keys = Array.from(diffFormatterCache.keys());
      for (let i = 0; i < keys.length / 2; i++) {
        diffFormatterCache.delete(keys[i] as string);
      }
    }
    diffFormatterCache.set(cacheKey, result);

    return result;
  }

  private createPatchesKey(patches: Operation[]): string {
    // Create a lightweight hash of the patches for caching
    if (patches.length === 0) return "empty";

    // Use enhanced hashing for consistent cache keys
    const patchData = {
      count: patches.length,
      operations: patches.map((p) => `${p.op}:${p.path}`).join(","),
      // Include a sample of patch content for uniqueness
      sample: patches
        .slice(0, 3)
        .map((p) => p.op)
        .join(""),
    };

    return fastHash(patchData as JsonObject, ["count", "operations", "sample"]);
  }

  private generateDiff(patches: Operation[]): SideBySideDiff {
    const originalAffectedLines = new Set<number>();
    const newAffectedLines = new Set<number>();

    // Enhanced patch processing with schema awareness
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

    // Use cached JSON stringification
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

    // Enhanced unified diff generation
    const unified = this.generateUnifiedDiff(originalDiffLines, newDiffLines);

    return {
      originalLines: originalDiffLines,
      newLines: newDiffLines,
      unifiedDiffLines: unified,
    };
  }

  private generateUnifiedDiff(
    originalDiffLines: DiffLine[],
    newDiffLines: DiffLine[]
  ): UnifiedDiffLine[] {
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

    return unified;
  }
}
