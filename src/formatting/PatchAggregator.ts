import { DiffFormatter } from "./DiffFormatter";
import { getValueByPath } from "../utils/pathUtils";
import { getCachedFormatter } from "../performance/cache";
import { deepEqualSchemaAware } from "../performance/deepEqual";
import { getEffectiveHashFields } from "../performance/getEffectiveHashFields";
import { fastHash } from "../performance/fashHash";
import type {
  JsonValue,
  JsonObject,
  Operation,
  SideBySideDiff,
} from "../types";
import type { Plan, ArrayPlan } from "../core/buildPlan";

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
  idKey?: string; // Optional - will be inferred from plan if not provided
  plan?: Plan; // Optional schema plan for optimization
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

  private getIdKeyForPath(
    pathPrefix: string,
    config: AggregationConfig
  ): string {
    if (config.idKey) {
      return config.idKey;
    }

    if (config.plan) {
      const arrayPlan = this.getArrayPlanForPath(pathPrefix, config.plan);
      if (arrayPlan?.primaryKey) {
        return arrayPlan.primaryKey;
      }
    }

    return "id";
  }

  private getArrayStrategy(
    pathPrefix: string,
    config: AggregationConfig
  ): "primaryKey" | "lcs" | "unique" {
    if (config.plan) {
      const arrayPlan = this.getArrayPlanForPath(pathPrefix, config.plan);
      if (arrayPlan?.strategy) {
        return arrayPlan.strategy;
      }
    }

    // Default to primaryKey if we have an idKey or if the plan suggests a primary key
    if (config.idKey) {
      return "primaryKey";
    }

    if (config.plan) {
      const arrayPlan = this.getArrayPlanForPath(pathPrefix, config.plan);
      if (arrayPlan?.primaryKey) {
        return "primaryKey";
      }
    }

    return "lcs";
  }

  private supportsAggregation(
    pathPrefix: string,
    config: AggregationConfig
  ): boolean {
    // Support aggregation if we have any way to identify array items
    const hasIdKey = Boolean(config.idKey);
    const hasSchemaKey =
      config.plan &&
      this.getArrayPlanForPath(pathPrefix, config.plan)?.primaryKey;

    return hasIdKey || Boolean(hasSchemaKey);
  }

  private isArrayPath(pathPrefix: string, config: AggregationConfig): boolean {
    // First check if we have plan information
    if (config.plan) {
      const arrayPlan = this.getArrayPlanForPath(pathPrefix, config.plan);
      if (arrayPlan) {
        return true; // Found in plan, definitely an array
      }
    }

    // Fallback: check if the path actually points to an array in the data
    const originalValue = getValueByPath(this.originalDoc, pathPrefix);
    const newValue = getValueByPath(this.newDoc, pathPrefix);

    return Array.isArray(originalValue) || Array.isArray(newValue);
  }

  private getArrayPlanForPath(path: string, plan: Plan): ArrayPlan | undefined {
    // Try exact match first
    let arrayPlan = plan.get(path);
    if (arrayPlan) {
      return arrayPlan;
    }

    // Normalize path by removing array indices (e.g., /environments/0/services -> /environments/services)
    const normalizedPath = path.replace(/\/\d+/g, "");
    arrayPlan = plan.get(normalizedPath);
    if (arrayPlan) {
      return arrayPlan;
    }

    // Try with/without leading slash variants
    if (path.startsWith("/")) {
      const pathWithoutSlash = path.substring(1);
      arrayPlan = plan.get(pathWithoutSlash);
      if (arrayPlan) {
        return arrayPlan;
      }

      // Also try normalized version without leading slash
      const normalizedWithoutSlash = normalizedPath.substring(1);
      arrayPlan = plan.get(normalizedWithoutSlash);
      if (arrayPlan) {
        return arrayPlan;
      }
    } else {
      const pathWithSlash = "/" + path;
      arrayPlan = plan.get(pathWithSlash);
      if (arrayPlan) {
        return arrayPlan;
      }
    }

    return undefined;
  }

  private aggregateWithoutChildSeparation(
    patches: Operation[],
    config: AggregationConfig
  ): AggregatedDiffResult {
    const { pathPrefix } = config;
    // For non-primaryKey strategies, we can't meaningfully separate child patches
    // So we treat all patches as "parent" patches and don't generate child diffs
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
        diffLines: parentDiffLines,
        ...parentLineCounts,
      },
      childDiffs: new Map(), // Empty - no child separation for non-primaryKey strategies
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
    return JSON.stringify(obj1) === JSON.stringify(obj2);
  }

  aggregate(
    patches: Operation[],
    config: AggregationConfig
  ): AggregatedDiffResult {
    const { pathPrefix } = config;

    // Validate that the path actually represents an array
    if (!this.isArrayPath(pathPrefix, config)) {
      throw new Error(
        `Path ${pathPrefix} does not represent an array in the schema or data`
      );
    }

    // Check if this array configuration supports proper aggregation
    if (!this.supportsAggregation(pathPrefix, config)) {
      return this.aggregateWithoutChildSeparation(patches, config);
    }

    const idKey = this.getIdKeyForPath(pathPrefix, config);
    const arrayPlan = config.plan
      ? this.getArrayPlanForPath(pathPrefix, config.plan)
      : undefined;
    const parentPatches: Operation[] = [];
    const childPatchesById = new Map<string, Operation[]>();

    const originalChildren =
      getValueByPath<JsonObject[]>(this.originalDoc, pathPrefix) || [];
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

    const parentFormatter = getCachedFormatter(
      originalParent,
      newParent,
      (orig, newVal) => new DiffFormatter(orig, newVal)
    );
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

      // Enhanced optimization: skip processing if objects are identical
      if (
        originalChild &&
        newChild &&
        this.compareObjects(originalChild, newChild, arrayPlan)
      ) {
        continue; // Skip identical children - no diff needed
      }

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
        }
      });

      const formatter = getCachedFormatter(
        originalChild,
        newChild,
        (orig, newVal) => new DiffFormatter(orig, newVal)
      );
      let diffLines: SideBySideDiff;
      let lineCounts: { addCount: number; removeCount: number };

      if (originalChild && !newChild) {
        // Entire object was removed - generate diff without patches
        diffLines = formatter.format([]);
        // For removed objects, count all original lines as removed
        lineCounts = {
          addCount: 0,
          removeCount: diffLines.originalLines.length,
        };
      } else if (!originalChild && newChild) {
        // Entire object was added - generate diff without patches
        diffLines = formatter.format([]);
        // For added objects, count all new lines as added
        lineCounts = {
          addCount: diffLines.newLines.length,
          removeCount: 0,
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
