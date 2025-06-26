export interface DiffLine {
  lineNumber: number
  content: string
  type: "unchanged" | "added" | "removed" | "modified"
  path?: string
}

export interface SideBySideDiff {
  originalLines: DiffLine[]
  newLines: DiffLine[]
}

export interface PathMap {
  [jsonPointer: string]: {
    key?: {line: number; column: number; pos: number}
    value: {line: number; column: number; pos: number}
    valueEnd: {line: number; column: number; pos: number}
  }
}

export type JsonValue = string | number | boolean | null | JsonObject | JsonArray
export type JsonObject = {[Key in string]?: JsonValue}
export type JsonArray = JsonValue[]

export interface JSONSchema extends JsonObject {
  $ref?: string
  type?: string | string[]
  properties?: Record<string, JSONSchema>
  additionalProperties?: boolean | JSONSchema
  items?: JSONSchema
  anyOf?: JSONSchema[]
  oneOf?: JSONSchema[]
  allOf?: JSONSchema[]
  required?: string[]
}

export interface Operation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test"
  path: string
  value?: JsonValue
  from?: string
}

export interface ArrayPlan {
  primaryKey: string | null
  // Pre-resolved item schema to avoid repeated $ref resolution
  itemSchema?: JSONSchema
  // Set of required fields for faster validation and comparison
  requiredFields?: Set<string>
  // Fields to use for quick equality hashing before deep comparison
  hashFields?: string[]
  // Strategy hint for array comparison
  strategy?: "primaryKey" | "lcs" | "unique"
  // Pre-compiled diffing function for maximum performance
  compiledDiff?: (
    arr1: JsonArray,
    arr2: JsonArray,
    path: string,
    patches: Operation[],
    diffFn: (
      obj1: JsonValue | undefined,
      obj2: JsonValue | undefined,
      path: string,
      patches: Operation[],
    ) => void,
  ) => void
}

export type Plan = Map<string, ArrayPlan>

export interface BuildPlanOptions {
  primaryKeyMap?: Record<string, string>
  basePath?: string
}

export interface UnifiedDiffLine {
  type: DiffLine["type"]
  content: string
  key: string
  oldLineNumber?: number
  newLineNumber?: number
}

export interface Operation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test"
  path: string
  value?: JsonValue
  from?: string
}
