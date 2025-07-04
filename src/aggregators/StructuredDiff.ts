import type { ArrayPlan, Plan } from "../core/buildPlan";
import { cachedJsonStringify, getCachedFormatter } from "../performance/cache";
import { deepEqualSchemaAware } from "../performance/deepEqual";
import { fastHash } from "../performance/fashHash";
import { getEffectiveHashFields } from "../performance/getEffectiveHashFields";
import type {
  FormattedChildDiff,
  StructuredDiffResult,
  StructuredDiffConfig,
  JsonObject,
  JsonValue,
  Operation,
  FormattedDiffLines,
} from "../types";
import { getValueByPath } from "../utils/pathUtils";
import { DiffFormatter } from "../formatting/DiffFormatter";
import { JsonSchemaPatcher } from "..";

function countChangedLines(diff: FormattedDiffLines): {
  addCount: number;
  removeCount: number;
} {
  const addCount = diff.newLines.filter((line) => line.type === "added").length;
  const removeCount = diff.originalLines.filter(
    (line) => line.type === "removed"
  ).length;
  return { addCount, removeCount };
}

export class StructuredDiff {
  private plan: Plan;

  constructor(options: { plan: Plan }) {
    this.plan = options.plan;
  }

  private getIdKeyForPath(pathPrefix: string): string {
    const arrayPlan = this.getArrayPlanForPath(pathPrefix, this.plan);
    if (arrayPlan?.primaryKey) {
      return arrayPlan.primaryKey;
    }
    return "id";
  }

  private supportsAggregation(pathPrefix: string): boolean {
    // Support aggregation if we have any way to identify array items
    const hasSchemaKey = this.getArrayPlanForPath(
      pathPrefix,
      this.plan
    )?.primaryKey;
    return Boolean(hasSchemaKey);
  }

  private isArrayPath(pathPrefix: string, config: StructuredDiffConfig): boolean {
    // First check if we have plan information
    if (this.plan) {
      const arrayPlan = this.getArrayPlanForPath(pathPrefix, this.plan);
      if (arrayPlan) {
        return true; // Found in plan, definitely an array
      }
    }

    // Fallback: check if the path actually points to an array in the data
    const originalValue = getValueByPath(config.original, pathPrefix);
    const newValue = getValueByPath(config.modified, pathPrefix);

    return Array.isArray(originalValue) || Array.isArray(newValue);
  }

  private getArrayPlanForPath(path: string, plan: Plan): ArrayPlan | undefined {
    const normalizedPath = path.replace(/\/\d+/g, "");
    const hasLeadingSlash = path.startsWith("/");

    // We build the list of candidates in a specific order of priority.
    // Using a Set handles deduplication automatically (e.g., if path === normalizedPath).
    const candidatePaths = new Set([
      path,
      normalizedPath,
      hasLeadingSlash ? path.substring(1) : `/${path}`,
      hasLeadingSlash ? normalizedPath.substring(1) : `/${normalizedPath}`,
    ]);

    for (const candidate of candidatePaths) {
      const arrayPlan = plan.get(candidate);
      if (arrayPlan) {
        return arrayPlan;
      }
    }

    return undefined;
  }

  private aggregateWithoutChildSeparation(
    patches: Operation[],
    config: StructuredDiffConfig
  ): StructuredDiffResult {
    const { pathPrefix } = config;
    // For non-primaryKey strategies, we can't meaningfully separate child patches
    // So we treat all patches as "parent" patches and don't generate child diffs
    const originalParent = this.getAndStripChildArray(
      config.original,
      pathPrefix
    );
    const newParent = this.getAndStripChildArray(config.modified, pathPrefix);

    const parentFormatter = getCachedFormatter(
      originalParent,
      newParent,
      (orig, newVal) => new DiffFormatter(orig, newVal)
    );
    const parentDiffLines = parentFormatter.format(patches);
    const parentLineCounts = countChangedLines(parentDiffLines);

    return {
      parentDiff: {
        original: originalParent,
        new: newParent,
        patches: patches,
        diffLines: parentDiffLines.unifiedDiffLines,
        ...parentLineCounts,
      },
      childDiffs: {}, // Empty - no child separation for non-primaryKey strategies
    };
  }

  // Enhanced comparison using schema-aware equality
  private compareObjects(
    obj1: JsonObject | null,
    obj2: JsonObject | null,
    plan?: ArrayPlan
  ): boolean {
    if (obj1 === obj2) return true;
    if (!obj1 || !obj2) return false;

    // Use schema-aware equality when plan is available
    if (plan) {
      return deepEqualSchemaAware(obj1, obj2, plan);
    }

    // Fallback to enhanced hash-based comparison
    const hashFields = getEffectiveHashFields(plan, obj1, obj2);
    if (hashFields.length > 0) {
      const h1 = fastHash(obj1, hashFields);
      const h2 = fastHash(obj2, hashFields);
      if (h1 !== h2) return false;
    }

    // Final deep comparison (will use memoization)
    return cachedJsonStringify(obj1) === cachedJsonStringify(obj2);
  }

  execute(config: StructuredDiffConfig): StructuredDiffResult {
    const { pathPrefix } = config;

    // Validate that the path actually represents an array
    if (!this.isArrayPath(pathPrefix, config)) {
      throw new Error(
        `Path ${pathPrefix} does not represent an array in the schema or data`
      );
    }

    const patches =
      config.patches ||
      new JsonSchemaPatcher({ plan: this.plan }).execute({
        original: config.original,
        modified: config.modified,
      });

    // Check if this array configuration supports proper aggregation
    if (!this.supportsAggregation(pathPrefix)) {
      return this.aggregateWithoutChildSeparation(patches, config);
    }

    const idKey = this.getIdKeyForPath(pathPrefix);
    const parentPatches: Operation[] = [];
    const childPatchesById: Record<string, Operation[]> = {};

    const originalChildren =
      getValueByPath<JsonObject[]>(config.original, pathPrefix) || [];
    const originalChildIdsByIndex = originalChildren.map(
      (child) => child[idKey] as string
    );

    // Enhanced child identification using schema information
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
        if (!(childId in childPatchesById)) {
          childPatchesById[childId] = [];
        }
        childPatchesById[childId]?.push(patch);
      } else {
        parentPatches.push(patch);
      }
    }

    const parentPath = pathPrefix.substring(0, pathPrefix.lastIndexOf("/"));

    const originalParent = this.getAndStripChildArray(
      config.original,
      pathPrefix
    );
    const newParent = this.getAndStripChildArray(config.modified, pathPrefix);

    const parentFormatter = getCachedFormatter(
      originalParent,
      newParent,
      (orig, newVal) => new DiffFormatter(orig, newVal)
    );
    const transformedParentPatches = parentPatches.map((p) => {
      // Make patch paths relative to the new parent context
      if (p.path.startsWith(parentPath)) {
        return { ...p, path: p.path.substring(parentPath.length) };
      }
      return p;
    });

    const parentDiffLines = parentFormatter.format(transformedParentPatches);
    const parentLineCounts = countChangedLines(parentDiffLines);

    const childDiffs: Record<string, FormattedChildDiff> = {};
    const newChildren =
      getValueByPath<JsonObject[]>(config.modified, pathPrefix) || [];
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
      const patchesForChild = childPatchesById[childId] || [];

      const transformedPatches = patchesForChild.map((p) => {
        const originalIndex = originalChildren.findIndex(
          (c) => c[idKey] === childId
        );

        // If the child existed in the original array, all its patch paths should be made relative.
        if (originalIndex >= 0) {
          const childPathPrefix = `${pathPrefix}/${originalIndex}`;
          return { ...p, path: p.path.substring(childPathPrefix.length) };
        }

        // If we're here, originalIndex is -1, which means it's a new item being added.
        if (p.op === "add") {
          // The patch path for a new object should be empty, making it relative to the object itself.
          return { ...p, path: "" };
        }

        // This is a fallback for remove operations where the childId might not have been
        // resolved correctly. It extracts the index from the path.
        const pathMatch = p.path.match(
          new RegExp(
            `^${pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(\d+)`
          )
        );
        const pathIndex = pathMatch?.[1];
        if (pathIndex) {
          const index = Number.parseInt(pathIndex, 10);
          const childPathPrefix = `${pathPrefix}/${index}`;
          return { ...p, path: p.path.substring(childPathPrefix.length) };
        }
        return p;
      });

      const formatter = getCachedFormatter(
        originalChild,
        newChild,
        (orig, newVal) => new DiffFormatter(orig, newVal)
      );
      let diffLines: FormattedDiffLines;
      let lineCounts: { addCount: number; removeCount: number };
      if (originalChild && !newChild) {
        // Entire object was removed - create manual diff
        const originalFormatted = cachedJsonStringify(originalChild);
        const originalLines = originalFormatted.split("\n");

        diffLines = {
          originalLines: originalLines.map((line, index) => ({
            lineNumber: index + 1,
            content: line,
            type: "removed" as const,
          })),
          newLines: [
            {
              lineNumber: 1,
              content: "null",
              type: "unchanged" as const,
            },
          ],
          unifiedDiffLines: originalLines.map((line, index) => ({
            type: "removed" as const,
            content: line,
            oldLineNumber: index + 1,
            key: `removed-${index + 1}`,
          })),
        };
        lineCounts = {
          addCount: 0,
          removeCount: originalLines.length,
        };
      } else if (!originalChild && newChild) {
        // Entire object was added - create manual diff
        const newFormatted = cachedJsonStringify(newChild);
        const newLines = newFormatted.split("\n");

        diffLines = {
          originalLines: [
            {
              lineNumber: 1,
              content: "null",
              type: "unchanged" as const,
            },
          ],
          newLines: newLines.map((line, index) => ({
            lineNumber: index + 1,
            content: line,
            type: "added" as const,
          })),
          unifiedDiffLines: newLines.map((line, index) => ({
            type: "added" as const,
            content: line,
            newLineNumber: index + 1,
            key: `added-${index + 1}`,
          })),
        };
        lineCounts = {
          addCount: newLines.length,
          removeCount: 0,
        };
      } else {
        // Normal case - use transformed patches
        diffLines = formatter.format(transformedPatches);
        lineCounts = countChangedLines(diffLines);
      }

      childDiffs[childId] = {
        id: childId,
        original: originalChild || {},
        new: newChild || {},
        patches: transformedPatches,
        diffLines: diffLines.unifiedDiffLines,
        ...lineCounts,
      };
    }

    return {
      parentDiff: {
        original: originalParent,
        new: newParent,
        patches: parentPatches,
        diffLines: parentDiffLines.unifiedDiffLines,
        ...parentLineCounts,
      },
      childDiffs,
    };
  }

  private getAndStripChildArray(
    doc: JsonValue,
    pathPrefix: string
  ): JsonValue {
    const parentPath = pathPrefix.includes("/")
      ? pathPrefix.substring(0, pathPrefix.lastIndexOf("/"))
      : "";
    const childKey = pathPrefix.includes("/")
      ? pathPrefix.substring(pathPrefix.lastIndexOf("/") + 1)
      : pathPrefix;

    const parentContainer = getValueByPath(doc, parentPath);

    if (
      parentContainer &&
      typeof parentContainer === "object" &&
      !Array.isArray(parentContainer)
    ) {
      const result = { ...parentContainer } as JsonObject;
      if (childKey in result) {
        delete result[childKey];
      }
      return result;
    }

    return {};
  }
}
