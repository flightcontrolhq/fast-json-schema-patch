export type JsonValue = string | number | boolean | null | JsonObject | JsonArray;
export type JsonObject = { [Key in string]?: JsonValue };
export type JsonArray = JsonValue[];

export interface JSONSchema extends JsonObject {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  additionalProperties?: boolean | JSONSchema;
  items?: JSONSchema;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  required?: string[];
}

// Low-level change event produced by the diff engine
export interface DiffDelta {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string; // JSON Pointer path to the change
  value?: any;
  oldValue?: any;
  from?: string;
}

// The final, rich output from the aggregator
export interface FinalPatch {
  operations: FormattedOperation[];
  // Could also include summary stats, etc.
}

export interface FormattedOperation extends DiffDelta {
  explanation: string;
  line?: number;      // Line in the new document
  oldLine?: number;   // Line in the old document
}

// Document parsed with location info
export interface ParsedDocument {
    data: JsonValue;
    // Essential for line awareness: maps a JSON pointer to its location
    getNodeLocation(path: string): { line: number, column: number, position: number };
}

// Schema-aware execution plan
export interface Plan extends Map<string, ArrayPlan> {}

export interface ArrayPlan {
  strategy: "lcs" | "primaryKey" | "unique" | "hash";
  primaryKey: string | null;
  itemSchema?: JSONSchema;
  requiredFields?: Set<string>;
  hashFields?: string[];
  getIdentity?: (item: JsonValue) => JsonValue;
}


// --- Module Contracts (Interfaces) ---

export interface IParser {
  parse(jsonString: string): ParsedDocument;
}

export interface IPlanner {
  // The plan contains strategies for diffing (e.g., array diffing by primary key)
  createPlan(
    schema: JSONSchema,
    options?: {
      primaryKeyMap?: Record<string, string>;
      basePath?: string;
    }
  ): Plan;
}

export interface IDiffEngine {
  // Returns an iterator, which allows for JIT processing.
  diff(doc1: ParsedDocument, doc2: ParsedDocument, plan: Plan, partialDiffKeys?: string[]): Iterable<DiffDelta>;
}

export interface IAggregator {
  // Consumes deltas and produces the final formatted patch.
  aggregate(
    deltas: Iterable<DiffDelta>,
    options: {
      plan: Plan;
      isPartial: boolean;
      explainer: IExplainer;
      parsedDoc1: ParsedDocument;
      parsedDoc2: ParsedDocument;
      partialKeys?: string[];
    }
  ): FinalPatch;
}

export interface IExplainer {
    // Translates a technical delta into a human-readable string.
    explain(delta: DiffDelta, plan: Plan): string;
}


// --- Patcher Instance and Options ---

// The user-facing instance returned by the factory.
export interface PatcherInstance {
  _plan: Plan;
  _options: PatcherOptions;
  _resultsCache: Map<string, DiffDelta[]>;
  diff(doc1: string, doc2: string, diffOptions?: DiffOptions): FinalPatch;
  getPlan(): Plan;
  clearCache(): void;
}

// Options for the one-time factory function.
export type ModuleOption<T> = string | T;

export interface PatcherOptions {
  planner?: ModuleOption<IPlanner>;
  plannerOptions?: {
    primaryKeyMap?: Record<string, string>;
    basePath?: string;
  };
  explainer?: ModuleOption<IExplainer>;
  parser?: ModuleOption<IParser>;
  diffEngine?: ModuleOption<IDiffEngine>;
  aggregator?: ModuleOption<IAggregator>;
}

// Options for each individual diff operation.
export interface DiffOptions {
  partialDiffKeys?: string[];
  parser?: ModuleOption<IParser>;
  diffEngine?: ModuleOption<IDiffEngine>;
  aggregator?: ModuleOption<IAggregator>;
} 