"use client"

import { useMemo } from "react"
import { SchemaPatcher, buildPlan, type Operation } from "@/lib/schema-patcher"
// @ts-ignore - json-source-map types
import { parse as parseWithMap } from "json-source-map"
import schema from "@/schema.json"

interface DiffLine {
  lineNumber: number
  content: string
  type: "unchanged" | "added" | "removed" | "modified"
  path?: string
}

interface SideBySideDiff {
  originalLines: DiffLine[]
  newLines: DiffLine[]
}

interface PathMap {
  [jsonPointer: string]: {
    key?: { line: number; column: number; pos: number }
    value: { line: number; column: number; pos: number }
    valueEnd: { line: number; column: number; pos: number }
  }
}

interface ServiceDiff {
  serviceId: string
  serviceName: string
  originalService: any
  newService: any
  patches: Operation[]
  addCount: number
  removeCount: number
  diffLines: SideBySideDiff
}

interface EnvironmentDiff {
  environmentName: string
  originalEnvironment: any
  newEnvironment: any
  patches: Operation[]
  addCount: number
  removeCount: number
  diffLines: SideBySideDiff
}

export function useJsonPatch(originalJson: string, newJson: string) {
  const { patch, error: patchError } = useMemo(() => {
    try {
      // Validate JSON syntax first
      let original, updated

      try {
        original = JSON.parse(originalJson)
      } catch (e) {
        return { patch: [], error: `Invalid original JSON: ${e.message}` }
      }

      try {
        updated = JSON.parse(newJson)
      } catch (e) {
        return { patch: [], error: `Invalid new JSON: ${e.message}` }
      }

      // Build plan from schema and create schema-aware patcher
      const plan = buildPlan(schema, {
        primaryKeyMap: {
          "/environments": "id",
          "/environments/*/services": "id",
          "/environments/*/services/*/ports": "id",
          "/environments/*/services/*/sidecars": "name",
        },
      })

      const patcher = new SchemaPatcher({ plan })
      const patches = patcher.createPatch(original, updated)

      return { patch: patches, error: null }
    } catch (error) {
      return { patch: [], error: `Error generating patch: ${error.message}` }
    }
  }, [originalJson, newJson])

  const {
    environmentDiff,
    serviceDiffs,
    diffLines,
    error: diffError,
  } = useMemo(() => {
    if (patchError) {
      return {
        environmentDiff: null,
        serviceDiffs: [],
        diffLines: { originalLines: [], newLines: [] },
        error: patchError,
      }
    }

    try {
      const original = JSON.parse(originalJson)
      const updated = JSON.parse(newJson)
      const categorized = categorizePatches(original, updated, patch)
      const fullDiff = generateSideBySideDiff(originalJson, newJson, patch)
      return { ...categorized, diffLines: fullDiff, error: null }
    } catch (error) {
      return {
        environmentDiff: null,
        serviceDiffs: [],
        diffLines: { originalLines: [], newLines: [] },
        error: `Error categorizing patches: ${error.message}`,
      }
    }
  }, [originalJson, newJson, patch, patchError])

  return { patch, environmentDiff, serviceDiffs, diffLines, error: patchError || diffError }
}

/**
 * Count lines that are actually changed in a diff
 */
function countChangedLines(diffLines: SideBySideDiff): { addCount: number; removeCount: number } {
  const addCount = diffLines.newLines.filter((line) => line.type === "added").length
  const removeCount = diffLines.originalLines.filter((line) => line.type === "removed").length
  return { addCount, removeCount }
}

/**
 * Categorize patches by environment config vs individual services
 */
function categorizePatches(original: any, updated: any, patches: Operation[]) {
  // Safely access environments
  const originalEnv = original?.environments?.[0] || {}
  const updatedEnv = updated?.environments?.[0] || {}

  // Separate environment-level patches from service-level patches
  const environmentPatches: Operation[] = []
  const servicePatches: Map<string, Operation[]> = new Map()

  patches.forEach((patch) => {
    // Check if this is a service-related patch
    const serviceMatch = patch.path.match(/^\/environments\/0\/services(?:\/(\d+|-)(.*))?$/)

    if (serviceMatch) {
      const serviceIndex = serviceMatch[1]
      const servicePath = serviceMatch[2]

      // If there's no service index, this is about the services array itself
      if (serviceIndex === undefined) {
        // This is a change to the services array structure, not individual services
        // We'll ignore these as they're handled by individual service add/remove
        return
      }

      // Handle the "-" case for array append
      let actualServiceIndex = serviceIndex
      if (serviceIndex === "-") {
        const updatedServices = updatedEnv.services || []
        actualServiceIndex = Math.max(0, updatedServices.length - 1).toString()
      }

      if (!servicePatches.has(actualServiceIndex)) {
        servicePatches.set(actualServiceIndex, [])
      }

      // Create a new patch with the service-relative path
      servicePatches.get(actualServiceIndex)!.push({
        ...patch,
        path: servicePath || "/", // Root of service if no sub-path
      })
    } else {
      // This is an environment-level patch
      environmentPatches.push(patch)
    }
  })

  // Create environment diff (excluding services)
  const originalEnvWithoutServices = { ...originalEnv }
  const updatedEnvWithoutServices = { ...updatedEnv }
  delete originalEnvWithoutServices.services
  delete updatedEnvWithoutServices.services

  // Generate environment diff
  const environmentDiffLines = generateObjectDiff(originalEnvWithoutServices, updatedEnvWithoutServices)
  const environmentLineCounts = countChangedLines(environmentDiffLines)

  const environmentDiff: EnvironmentDiff = {
    environmentName: originalEnv.name || updatedEnv.name || "Environment",
    originalEnvironment: originalEnvWithoutServices,
    newEnvironment: updatedEnvWithoutServices,
    patches: environmentPatches,
    addCount: environmentLineCounts.addCount,
    removeCount: environmentLineCounts.removeCount,
    diffLines: environmentDiffLines,
  }

  // Create service diffs
  const serviceDiffs: ServiceDiff[] = []

  // Get all unique service indices (from both original and updated)
  const allServiceIndices = new Set<string>()

  // Add indices from original services
  const originalServices = originalEnv.services || []
  originalServices.forEach((_: any, index: number) => {
    allServiceIndices.add(index.toString())
  })

  // Add indices from updated services
  const updatedServices = updatedEnv.services || []
  updatedServices.forEach((_: any, index: number) => {
    allServiceIndices.add(index.toString())
  })

  // Add indices from patches
  servicePatches.forEach((_, index) => {
    allServiceIndices.add(index)
  })

  allServiceIndices.forEach((indexStr) => {
    const index = Number.parseInt(indexStr)
    const originalService = originalServices[index] || null
    const updatedService = updatedServices[index] || null
    const patches = servicePatches.get(indexStr) || []

    if (originalService || updatedService) {
      // Generate service-specific diff
      const serviceDiffLines = generateObjectDiff(originalService, updatedService)
      const serviceLineCounts = countChangedLines(serviceDiffLines)

      serviceDiffs.push({
        serviceId: originalService?.id || updatedService?.id || `service-${index}`,
        serviceName: originalService?.name || updatedService?.name || `Service ${index + 1}`,
        originalService: originalService,
        newService: updatedService,
        patches,
        addCount: serviceLineCounts.addCount,
        removeCount: serviceLineCounts.removeCount,
        diffLines: serviceDiffLines,
      })
    }
  })

  return { environmentDiff, serviceDiffs }
}

/**
 * Generate diff for a specific object pair with actual highlighting
 */
export function generateObjectDiff(originalObj: any, newObj: any): SideBySideDiff {
  // Handle null objects
  const safeOriginal = originalObj || {}
  const safeNew = newObj || {}

  // Create a mini-patcher for this specific comparison
  const plan = buildPlan(schema)
  const patcher = new SchemaPatcher({ plan })
  const patches = patcher.createPatch(safeOriginal, safeNew)

  // Format both objects consistently
  const originalFormatted = JSON.stringify(safeOriginal, null, 2)
  const newFormatted = JSON.stringify(safeNew, null, 2)

  const originalLines = originalFormatted.split("\n")
  const newLines = newFormatted.split("\n")

  // Build path maps for both versions
  const originalPathMap = buildPathMap(originalFormatted)
  const newPathMap = buildPathMap(newFormatted)

  // Track affected line numbers based on patches
  const originalAffectedLines = new Set<number>()
  const newAffectedLines = new Set<number>()

  patches.forEach((patch) => {
    if (patch.op === "remove") {
      const range = getPathLineRange(originalPathMap, patch.path, safeOriginal, false)
      if (range) {
        for (let i = range.start; i <= range.end; i++) {
          originalAffectedLines.add(i)
        }
      }
    } else if (patch.op === "add") {
      const range = getPathLineRange(newPathMap, patch.path, safeNew, true)
      if (range) {
        for (let i = range.start; i <= range.end; i++) {
          newAffectedLines.add(i)
        }
      }
    } else if (patch.op === "replace") {
      const originalRange = getPathLineRange(originalPathMap, patch.path, safeOriginal, false)
      const newRange = getPathLineRange(newPathMap, patch.path, safeNew, true)

      if (originalRange) {
        for (let i = originalRange.start; i <= originalRange.end; i++) {
          originalAffectedLines.add(i)
        }
      }

      if (newRange) {
        for (let i = newRange.start; i <= newRange.end; i++) {
          newAffectedLines.add(i)
        }
      }
    }
  })

  // Create diff lines with proper highlighting
  const originalDiffLines: DiffLine[] = originalLines.map((line, index) => ({
    lineNumber: index + 1,
    content: line,
    type: originalAffectedLines.has(index + 1) ? "removed" : "unchanged",
  }))

  const newDiffLines: DiffLine[] = newLines.map((line, index) => ({
    lineNumber: index + 1,
    content: line,
    type: newAffectedLines.has(index + 1) ? "added" : "unchanged",
  }))

  return {
    originalLines: originalDiffLines,
    newLines: newDiffLines,
  }
}

// Helper functions
export function buildPathMap(jsonText: string): PathMap {
  try {
    const { pointers } = parseWithMap(jsonText)
    const map: PathMap = {}

    for (const [pointer, info] of Object.entries(pointers)) {
      map[pointer] = {
        key: info.key,
        value: info.value,
        valueEnd: info.valueEnd,
      }
    }
    return map
  } catch (error) {
    console.error("Error building path map:", error)
    return {}
  }
}

function resolvePatchPath(path: string, jsonObj: any, isForNewVersion = false): string | null {
  if (path.endsWith("/-")) {
    const parentPath = path.slice(0, -2)
    const pathParts = parentPath.split("/").filter((p) => p !== "")
    let current = jsonObj

    for (const part of pathParts) {
      if (/^\d+$/.test(part)) {
        current = current[Number.parseInt(part)]
      } else {
        current = current[part]
      }
      if (current === undefined) return null
    }

    if (Array.isArray(current)) {
      if (isForNewVersion) {
        return `${parentPath}/${current.length - 1}`
      } else {
        return parentPath
      }
    }
  }
  return path
}

function getPathLineRange(
  pathMap: PathMap,
  path: string,
  jsonObj: any,
  isForNewVersion = false,
): { start: number; end: number } | null {
  const resolvedPath = resolvePatchPath(path, jsonObj, isForNewVersion)
  if (!resolvedPath) return null

  const info = pathMap[resolvedPath]
  if (!info) {
    const pathParts = resolvedPath.split("/").filter((p) => p !== "")
    for (let i = pathParts.length - 1; i >= 0; i--) {
      const parentPath = "/" + pathParts.slice(0, i).join("/")
      const parentInfo = pathMap[parentPath]
      if (parentInfo) {
        return {
          start: parentInfo.value.line + 1,
          end: parentInfo.valueEnd.line + 1,
        }
      }
    }
    return null
  }

  return {
    start: info.value.line + 1,
    end: info.valueEnd.line + 1,
  }
}

/**
 * Generate side-by-side diff with precise line highlighting using json-source-map
 */
function generateSideBySideDiff(originalJson: string, newJson: string, patches: Operation[]): SideBySideDiff {
  const originalObj = JSON.parse(originalJson)
  const newObj = JSON.parse(newJson)

  const originalFormatted = JSON.stringify(originalObj, null, 2)
  const newFormatted = JSON.stringify(newObj, null, 2)

  const originalLines = originalFormatted.split("\n")
  const newLines = newFormatted.split("\n")

  const originalPathMap = buildPathMap(originalFormatted)
  const newPathMap = buildPathMap(newFormatted)

  const originalAffectedLines = new Set<number>()
  const newAffectedLines = new Set<number>()

  patches.forEach((patch) => {
    if (patch.op === "remove") {
      const range = getPathLineRange(originalPathMap, patch.path, originalObj, false)
      if (range) {
        for (let i = range.start; i <= range.end; i++) {
          originalAffectedLines.add(i)
        }
      }
    } else if (patch.op === "add") {
      const range = getPathLineRange(newPathMap, patch.path, newObj, true)
      if (range) {
        for (let i = range.start; i <= range.end; i++) {
          newAffectedLines.add(i)
        }
      }
    } else if (patch.op === "replace") {
      const originalRange = getPathLineRange(originalPathMap, patch.path, originalObj, false)
      const newRange = getPathLineRange(newPathMap, patch.path, newObj, true)

      if (originalRange) {
        for (let i = originalRange.start; i <= originalRange.end; i++) {
          originalAffectedLines.add(i)
        }
      }

      if (newRange) {
        for (let i = newRange.start; i <= newRange.end; i++) {
          newAffectedLines.add(i)
        }
      }
    }
  })

  const originalDiffLines: DiffLine[] = originalLines.map((line, index) => ({
    lineNumber: index + 1,
    content: line,
    type: originalAffectedLines.has(index + 1) ? "removed" : "unchanged",
  }))

  const newDiffLines: DiffLine[] = newLines.map((line, index) => ({
    lineNumber: index + 1,
    content: line,
    type: newAffectedLines.has(index + 1) ? "added" : "unchanged",
  }))

  return {
    originalLines: originalDiffLines,
    newLines: newDiffLines,
  }
}
