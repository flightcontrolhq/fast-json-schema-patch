import * as fastJsonPatch from "fast-json-patch";
import * as jsondiffpatch from "jsondiffpatch";
import { deepEqual } from "../src/performance/deepEqual";
import { deepSortArrays } from "./utils";

const diffpatcher = jsondiffpatch.create({
  objectHash: (obj: any) => {
    return obj.id || obj.postId || obj.name;
  },
  arrays: {
    detectMove: false
  }
});

// Enhanced Patch Counting
export function countJsonDiffPatches(diff: any): number {
  if (!diff || typeof diff !== "object") {
    return 0;
  }

  let patchCount = 0;

  function traverse(obj: any): void {
    if (!obj || typeof obj !== "object") {
      return;
    }

    for (const key in obj) {
      if (!obj.hasOwnProperty(key)) {
        continue;
      }

      const value = obj[key];

      // Skip array type markers
      if (key === "_t") {
        continue;
      }

      // Handle deletion operations (keys starting with '_')
      if (key.startsWith("_")) {
        // This is a deletion operation
        patchCount++;
        continue;
      }

      // Handle arrays that represent patch operations
      if (Array.isArray(value)) {
        if (value.length === 1) {
          // Addition: [newValue]
          patchCount++;
        } else if (value.length === 2) {
          // Replacement: [newValue, oldValue]
          patchCount++;
        } else if (value.length === 3 && value[1] === 0 && value[2] === 0) {
          // Deletion: [deletedValue, 0, 0] - but this is handled above with '_' prefix
          patchCount++;
        }
        continue;
      }

      // Recursively traverse nested objects
      if (typeof value === "object" && value !== null) {
        traverse(value);
      }
    }
  }

  traverse(diff);
  return patchCount;
}

export function isPatchValid(
  doc1: any,
  doc2: any,
  patch: any,
  library: string,
  modificationIndexs: string[]
) {
  try {
    const doc1Copy = JSON.parse(JSON.stringify(doc1));
    const patchCopy = JSON.parse(JSON.stringify(patch));

    const { newDocument: patchedDoc } = fastJsonPatch.applyPatch(
      doc1Copy,
      patchCopy,
      true
    );

    const sortedPatchedDoc = deepSortArrays(patchedDoc);
    const sortedDoc2 = deepSortArrays(doc2);

    const valid = deepEqual(sortedPatchedDoc, sortedDoc2);

    if (!valid) {
      console.error(
        `Patch from ${library} generated an invalid result for ${modificationIndexs.join(
          ", "
        )}. The diff is:`
      );
      const delta = diffpatcher.diff(sortedPatchedDoc, sortedDoc2);
      console.error(JSON.stringify(delta, null, 2));
    }
    return valid;
  } catch (e) {
    // Errors are expected for invalid patches. We return false and don't log to keep the output clean.
    return false;
  }
}

// Enhanced Semantic Accuracy Functions
export function calculateSemanticAccuracy(
  originalDoc: any,
  modifiedDoc: any,
  patch: any,
  library: string,
  schema: any
): number {
  let score = 100;

  try {
    const typeViolations = validateTypePreservation(patch, schema);
    score -= typeViolations * 5;

    const arrayEfficiency = calculateArrayHandlingEfficiency(patch);
    score -= (100 - arrayEfficiency) * 0.2;

    const semanticScore = calculatePatchSemantics(patch, library);
    score = (score + semanticScore) / 2;

    return Math.max(0, Math.min(100, score));
  } catch (error) {
    return 50;
  }
}

function validateTypePreservation(patch: any, schema: any): number {
  if (!Array.isArray(patch)) return 0;

  let violations = 0;
  for (const operation of patch) {
    if (
      operation.op === "replace" &&
      operation.path &&
      operation.value !== undefined
    ) {
      const pathParts = operation.path.split("/").filter(Boolean);
      if (pathParts.length > 0) {
        const oldType = typeof operation.oldValue;
        const newType = typeof operation.value;
        if (oldType !== "undefined" && oldType !== newType) {
          violations++;
        }
      }
    }
  }
  return violations;
}

function calculateArrayHandlingEfficiency(patch: any): number {
  if (!Array.isArray(patch)) return 100;

  let arrayOperations = 0;
  let efficientOperations = 0;

  for (const operation of patch) {
    if (operation.path && operation.path.includes("[")) {
      arrayOperations++;
      if (operation.op === "move") {
        efficientOperations++;
      } else if (operation.op === "add" || operation.op === "remove") {
        efficientOperations += 0.5;
      }
    }
  }

  return arrayOperations === 0
    ? 100
    : (efficientOperations / arrayOperations) * 100;
}

function calculatePatchSemantics(patch: any, library: string): number {
  if (!Array.isArray(patch)) return 50;

  let score = 100;
  const paths = new Set();
  let redundant = 0;

  for (const operation of patch) {
    if (operation.path) {
      if (paths.has(operation.path)) {
        redundant++;
      }
      paths.add(operation.path);
    }
  }

  if (patch.length > 0) {
    score -= (redundant / patch.length) * 30;
  }

  return Math.max(0, score);
} 