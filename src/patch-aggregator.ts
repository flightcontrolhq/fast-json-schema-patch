import { DiffFormatter } from "./diff-formatters";
import { getValueByPath } from "./path-utils";
import type { JsonValue, JsonObject, Operation, SideBySideDiff } from "./types";

function countChangedLines(diff: SideBySideDiff): {
  addCount: number;
  removeCount: number;
} {
  const addCount = diff.newLines.filter((line) => line.type === "added").length;
  const removeCount = diff.originalLines.filter(
    (line) => line.type === "removed"
  ).length;
  return { addCount, removeCount };
}



export interface AggregationConfig {
  pathPrefix: string;
  idKey: string;
}

export interface AggregatedDiffResult {
  parentDiff: AggregatedParentDiff;
  childDiffs: Map<string, AggregatedChildDiff>;
}

export interface AggregatedParentDiff {
  original: JsonValue;
  new: JsonValue;
  patches: Operation[];
  diffLines: SideBySideDiff;
  addCount: number;
  removeCount: number;
}

export interface AggregatedChildDiff {
  id: string;
  original: JsonObject | null;
  new: JsonObject | null;
  patches: Operation[];
  diffLines: SideBySideDiff;
  addCount: number;
  removeCount: number;
}

export class PatchAggregator {
  private originalDoc: JsonValue;
  private newDoc: JsonValue;

  constructor(originalDoc: JsonValue, newDoc: JsonValue) {
    this.originalDoc = originalDoc;
    this.newDoc = newDoc;
  }

  aggregate(
    patches: Operation[],
    config: AggregationConfig
  ): AggregatedDiffResult {
    const { pathPrefix, idKey } = config;

    const parentPatches: Operation[] = [];
    const childPatchesById = new Map<string, Operation[]>();

    const originalChildren =
      getValueByPath<JsonObject[]>(this.originalDoc, pathPrefix) || [];
    const originalChildIdsByIndex = originalChildren.map(
      (child) => child[idKey] as string
    );

    for (const patch of patches) {
      if (!patch.path.startsWith(pathPrefix)) {
        parentPatches.push(patch);
        continue;
      }

      const relativePath = patch.path.substring(pathPrefix.length);
      const match = relativePath.match(/^\/(\d+|-)$/);
      const matchIndex = match?.[1];
      let childId: string | undefined;

      if (matchIndex) {
        if (matchIndex === "-" && patch.op === "add") {
          // This is an add operation at the end of the array
          childId = (patch.value as JsonObject)?.[idKey] as string;
        } else if (matchIndex !== "-") {
          // This is a specific index operation
          const index = Number.parseInt(matchIndex, 10);
          
          if (patch.op === "add") {
            childId = (patch.value as JsonObject)?.[idKey] as string;
          } else {
            childId = originalChildIdsByIndex[index];
          }
        }
      } else {
        // Check if this is a nested operation within a specific child
        const nestedMatch = relativePath.match(/^\/(\d+)/);
        const nestedIndex = nestedMatch?.[1];
        if (nestedIndex) {
          const index = Number.parseInt(nestedIndex, 10);
          childId = originalChildIdsByIndex[index];
        }
      }

      if (childId) {
        if (!childPatchesById.has(childId)) {
          childPatchesById.set(childId, []);
        }
        childPatchesById.get(childId)?.push(patch);
      } else {
        parentPatches.push(patch);
      }
    }

    const pathParts = pathPrefix.split("/").filter(Boolean);
    const childArrayKey = pathParts.pop();

    const originalParent = this.stripChildArray(
      this.originalDoc,
      pathParts,
      childArrayKey
    );
    const newParent = this.stripChildArray(
      this.newDoc,
      pathParts,
      childArrayKey
    );

    const parentFormatter = new DiffFormatter(originalParent, newParent);
    const parentDiffLines = parentFormatter.format(parentPatches);
    const parentLineCounts = countChangedLines(parentDiffLines);

    const childDiffs = new Map<string, AggregatedChildDiff>();
    const newChildren =
      getValueByPath<JsonObject[]>(this.newDoc, pathPrefix) || [];
    const originalChildrenById = new Map(
      originalChildren.map((c) => [c[idKey] as string, c])
    );
    const newChildrenById = new Map(
      newChildren.map((c) => [c[idKey] as string, c])
    );
    const allChildIds = new Set([
      ...originalChildrenById.keys(),
      ...newChildrenById.keys(),
    ]);

    for (const childId of allChildIds) {
      const originalChild = originalChildrenById.get(childId) || null;
      const newChild = newChildrenById.get(childId) || null;
      const patchesForChild = childPatchesById.get(childId) || [];

      const transformedPatches = patchesForChild.map((p) => {
        const originalIndex = originalChildren.findIndex(
          (c) => c[idKey] === childId
        );

        if (p.op === "add" && p.path.endsWith("/-")) {
          // It's a new object being added to the end of the array
          return { ...p, path: "" };
        } else if (p.op === "add" && originalIndex === -1) {
          // It's a new object, so the patch is adding the whole object.
          // The path should point to the root of the object being added.
          return { ...p, path: "" };
        } else if (originalIndex >= 0) {
          const childPathPrefix = `${pathPrefix}/${originalIndex}`;
          return { ...p, path: p.path.substring(childPathPrefix.length) };
        } else {
          // For remove operations, we need to find the path differently
          const pathMatch = p.path.match(new RegExp(`^${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\d+)`));
          const pathIndex = pathMatch?.[1];
          if (pathIndex) {
            const index = Number.parseInt(pathIndex, 10);
            const childPathPrefix = `${pathPrefix}/${index}`;
            return { ...p, path: p.path.substring(childPathPrefix.length) };
          }
          return p;
        }
      });

      const formatter = new DiffFormatter(originalChild, newChild);
      let diffLines: SideBySideDiff;
      let lineCounts: { addCount: number; removeCount: number };

      if (originalChild && !newChild) {
        // Entire object was removed - generate diff without patches
        diffLines = formatter.format([]);
        // For removed objects, count all original lines as removed
        lineCounts = {
          addCount: 0,
          removeCount: diffLines.originalLines.length
        };
      } else if (!originalChild && newChild) {
        // Entire object was added - generate diff without patches  
        diffLines = formatter.format([]);
        // For added objects, count all new lines as added
        lineCounts = {
          addCount: diffLines.newLines.length,
          removeCount: 0
        };
      } else {
        // Normal case - use transformed patches
        diffLines = formatter.format(transformedPatches);
        lineCounts = countChangedLines(diffLines);
      }

      childDiffs.set(childId, {
        id: childId,
        original: originalChild,
        new: newChild,
        patches: transformedPatches,
        diffLines,
        ...lineCounts,
      });
    }

    return {
      parentDiff: {
        original: originalParent,
        new: newParent,
        patches: parentPatches,
        diffLines: parentDiffLines,
        ...parentLineCounts,
      },
      childDiffs,
    };
  }

  private stripChildArray(
    doc: JsonValue,
    parentPathParts: string[],
    childKey?: string
  ): JsonValue {
    if (!childKey) return doc;
    const newDoc = JSON.parse(JSON.stringify(doc));
    let current = newDoc;
    for (const part of parentPathParts) {
      const value = current?.[part];
      if (!value) break;
      current = value;
    }
    if (current && typeof current === "object" && !Array.isArray(current)) {
      delete current[childKey];
    }
    return newDoc;
  }
}
