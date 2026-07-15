import type {JsonObject} from "../types"
import {escapeJsonPointer} from "../utils/pathUtils"

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
  // spec-v2 declared-topology extensions (CORE §8.2). Placed on the array/object
  // schema node they govern. Absent every one of these, buildPlan behaves exactly
  // as spec-v1 (the compatibility profile, CORE §8.8).
  "x-schema-patch-topology"?: string
  "x-schema-patch-keys"?: string[]
  "x-schema-patch-order"?: string
  "x-schema-patch-granularity"?: string
}

type Schema = JSONSchema

export type ArraySemantics = "sequence" | "set" | "map" | "atomic"

export interface ArrayPlan {
  primaryKey: string | null
  /**
   * @deprecated F19: write-only since this field's introduction — no code
   * outside buildPlan.ts ever read it (deepEqualSchemaAware/
   * getEffectiveHashFields, the only consumers of an ArrayPlan at diff time,
   * use only primaryKey/hashFields/requiredFields). Because it references
   * into the parsed schema object graph, retaining it pinned ~2x plan memory
   * (CORE §3.1.1 already documents itemSchema as non-normative and MAY be
   * omitted). `buildPlan` no longer sets this field. Kept in the exported
   * type only so 0.x consumers who read it directly do not get a type error;
   * it will always be `undefined` from `buildPlan` going forward.
   */
  itemSchema?: JSONSchema
  // Set of required fields for faster validation and comparison
  requiredFields?: Set<string>
  // Fields to use for quick equality hashing before deep comparison
  hashFields?: string[]
  // Strategy hint for array comparison
  strategy?: "primaryKey" | "lcs" | "unique"
  /**
   * spec-v2 declared topology (CORE §8.3.1). Present iff the array node carries
   * an `x-schema-patch-topology` extension. When present it is AUTHORITATIVE for
   * dispatch (GEN §11), overriding the compat `strategy`/`primaryKey` fields
   * (which are still filled to the topology's compatibility view for
   * introspection, CORE §8.3.1). Absent, the entry is identical to a spec-v1
   * ArrayPlan and dispatch is exactly spec-v1 (CORE §8.8).
   */
  topology?: ArraySemantics
  /** `map` only: the composite key tuple in DECLARED order (CORE §8.4). */
  keys?: string[]
  /** `map` only: `"significant"` | `"insignificant"` (default `"insignificant"`). */
  order?: "significant" | "insignificant"
  /**
   * CORE §3.3.7 recursion alias: this path's subtree repeats the subtree at
   * `recurseTo` (always a proper path prefix — the on-stack entry path of the
   * schema node whose re-entry was cut short by the cycle guard). At trie
   * compilation the aliased node inherits the anchor node's plan and edges,
   * which is what extends strategy selection to unbounded recursion depth. An
   * entry may be alias-only (`strategy` undefined, carrying just `recurseTo`)
   * when the cycle guard fired before any array registered at the path.
   */
  recurseTo?: string
}

/**
 * spec-v2 object plan (CORE §8.3.2). Registered ONLY for a declared
 * `x-schema-patch-granularity: "atomic"` object node; a `granular` (default)
 * object is not registered, keeping the plan/trie minimal and byte-for-byte
 * spec-v1 compatible (CORE §8.8). The runtime object is exactly
 * `{ granularity: "atomic" }`; it extends `Partial<ArrayPlan>` purely at the
 * type level so that existing consumers of the (now union) `Plan` value type —
 * which read `ArrayPlan` fields like `primaryKey`/`strategy` — keep compiling
 * without per-site narrowing (those fields simply read back `undefined`). Use
 * `isObjectPlan` (the `granularity` discriminant) to narrow when the distinction
 * matters.
 */
export interface ObjectPlan extends Partial<ArrayPlan> {
  granularity: "atomic"
}

export type PlanEntry = ArrayPlan | ObjectPlan

export type Plan = Map<string, PlanEntry>

/** Discriminate an ObjectPlan from an ArrayPlan within a `PlanEntry`. */
export function isObjectPlan(entry: PlanEntry): entry is ObjectPlan {
  return "granularity" in entry
}

/**
 * True for an alias-only entry (CORE §3.3.7): a `recurseTo` recorded at a path
 * where no array ever registered a strategy. Such an entry contributes no plan
 * of its own — at trie compilation it inherits the anchor's.
 */
export function isRecursionAliasOnly(entry: PlanEntry): boolean {
  return !isObjectPlan(entry) && entry.strategy === undefined && entry.recurseTo !== undefined
}

export interface BuildPlanOptions {
  schema: Schema
  primaryKeyMap?: Record<string, string>
  basePath?: string
  /**
   * F25 (CORE §3.5.3, CORE §3.5.5): override the ordered candidate list consulted by
   * primary-key auto-detection. The first candidate that is a `required`
   * `string`/`number` property of the (allOf-merged) item schema is selected.
   * Defaults to `["id", "name", "port"]` when omitted. An **empty array**
   * disables auto-detection entirely (every object array falls back to `lcs`);
   * a `primaryKeyMap` entry still wins because it is applied before
   * auto-detection and bypasses the candidate list (CORE §3.4.3).
   */
  primaryKeyCandidates?: string[]
  /**
   * F32: called instead of writing to `console.warn` when schema traversal
   * hits a `$ref` it cannot resolve. Only local same-document references
   * (`$ref` starting with `#/`) are ever resolved — a `$ref` pointing outside
   * the document (a relative/absolute URL, or any string not starting with
   * `#/`) always triggers this callback and is treated as unresolvable (the
   * branch is skipped; traversal continues elsewhere). Omit to stay silent
   * (the default — no warnings are printed unless a handler is supplied).
   */
  onWarning?: (message: string) => void
}

/** CORE §3.5.3 default primary-key candidate list (the default of `primaryKeyCandidates`). */
const DEFAULT_PRIMARY_KEY_CANDIDATES = ["id", "name", "port"]

const ARRAY_TOPOLOGIES = new Set(["sequence", "set", "map", "atomic"])

/**
 * Parse the declared array-topology extensions on a node (CORE §8.2/§8.3.1).
 * Returns the declared topology fields, or `null` when the node declares no
 * `x-schema-patch-topology`. Construction-time validation (CORE §8.2.3) throws a
 * `TypeError` on an unknown topology value, a `map` without a non-empty string
 * `keys` tuple, or an unknown `order` value.
 */
function parseArrayTopology(
  node: JSONSchema,
  onWarning?: (message: string) => void,
): Pick<ArrayPlan, "topology" | "keys" | "order"> | null {
  const topology = node["x-schema-patch-topology"]
  if (topology === undefined) {
    // A stray `x-schema-patch-keys`/`-order` on a node without a topology has no
    // effect (CORE §8.2.3); surface the mismatch through the warning channel.
    if (node["x-schema-patch-keys"] !== undefined || node["x-schema-patch-order"] !== undefined) {
      onWarning?.(
        "x-schema-patch-keys/-order present without x-schema-patch-topology: ignored (CORE §8.2.3)",
      )
    }
    return null
  }
  if (typeof topology !== "string" || !ARRAY_TOPOLOGIES.has(topology)) {
    throw new TypeError(
      `x-schema-patch-topology: unknown value ${JSON.stringify(topology)} ` +
        `(expected "sequence" | "set" | "map" | "atomic") (CORE §8.2.3)`,
    )
  }
  const result: Pick<ArrayPlan, "topology" | "keys" | "order"> = {
    topology: topology as ArraySemantics,
  }
  if (topology === "map") {
    const keys = node["x-schema-patch-keys"]
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new TypeError(
        'x-schema-patch-topology: "map" REQUIRES a non-empty x-schema-patch-keys ' +
          "array (the key tuple is the identity) (CORE §8.2.3)",
      )
    }
    for (const k of keys) {
      if (typeof k !== "string") {
        throw new TypeError(
          `x-schema-patch-keys entries must be strings (member-field names); got ${typeof k} (CORE §8.2.3)`,
        )
      }
    }
    result.keys = [...keys]
    const order = node["x-schema-patch-order"] ?? "insignificant"
    if (order !== "significant" && order !== "insignificant") {
      throw new TypeError(
        `x-schema-patch-order: unknown value ${JSON.stringify(order)} ` +
          `(expected "significant" | "insignificant") (CORE §8.2.3)`,
      )
    }
    result.order = order
  } else {
    // keys/order on a non-map topology are ignored (CORE §8.2.3).
    if (node["x-schema-patch-keys"] !== undefined || node["x-schema-patch-order"] !== undefined) {
      onWarning?.(
        `x-schema-patch-keys/-order on a non-map topology (${topology}): ignored (CORE §8.2.3)`,
      )
    }
  }
  return result
}

/** Parse the declared object granularity (CORE §8.2/§8.3.2); throws on unknown value. */
function parseObjectGranularity(
  node: JSONSchema,
): "granular" | "atomic" | undefined {
  const g = node["x-schema-patch-granularity"]
  if (g === undefined) return undefined
  if (g !== "granular" && g !== "atomic") {
    throw new TypeError(
      `x-schema-patch-granularity: unknown value ${JSON.stringify(g)} ` +
        `(expected "granular" | "atomic") (CORE §8.2.3)`,
    )
  }
  return g
}

/** Resolve `docPath` to its plan key under `basePath`, or `null` if out of base (CORE §3.6.2). */
function resolveTargetPath(
  docPath: string,
  basePath: string | undefined,
): string | null {
  const inBase =
    !basePath || docPath === basePath || docPath.startsWith(`${basePath}/`)
  if (!inBase) return null
  return basePath ? docPath.slice(basePath.length) : docPath
}

function sameStringArray(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * A declared topology is an assertion about identity, not a rankable preference:
 * two schema nodes at the same document path MUST NOT declare conflicting
 * topologies (CORE §8.2.2), and an array node MUST NOT collide with a declared
 * atomic object node.
 */
function declaredTopologyConflict(path: string): TypeError {
  return new TypeError(
    `Conflicting declared topology at ${JSON.stringify(path || "/")}: ` +
      "two schema nodes mapping to the same document path declare incompatible " +
      "x-schema-patch-* semantics (CORE §8.2.2)",
  )
}

/**
 * Register a recursion alias at `docPath` pointing at `anchorPath` (CORE §3.3.7):
 * the cycle guard cut a re-entry of an on-stack schema node short, so the
 * subtree at `docPath` repeats the subtree at `anchorPath`. An existing entry
 * keeps its own plan and merely gains the alias; a declared-atomic object
 * ignores it (its subtree is pruned, CORE §8.3.3).
 */
function registerRecursionAlias(
  plan: Plan,
  docPath: string,
  anchorPath: string,
  basePath: string | undefined,
): void {
  const targetPath = resolveTargetPath(docPath, basePath)
  const targetAnchor = resolveTargetPath(anchorPath, basePath)
  if (targetPath === null || targetAnchor === null || targetPath === targetAnchor) return
  const existing = plan.get(targetPath)
  if (!existing) {
    plan.set(targetPath, {primaryKey: null, recurseTo: targetAnchor})
    return
  }
  if (isObjectPlan(existing)) return
  existing.recurseTo ??= targetAnchor
}

/** Register an ArrayPlan at `docPath`, reconciling with any existing entry (CORE §3.7/§8.2.2). */
function registerArrayPlan(
  plan: Plan,
  docPath: string,
  arrayPlan: ArrayPlan,
  basePath: string | undefined,
): void {
  const targetPath = resolveTargetPath(docPath, basePath)
  if (targetPath === null) return
  const existing = plan.get(targetPath)
  if (!existing) {
    plan.set(targetPath, arrayPlan)
    return
  }
  if (isObjectPlan(existing)) {
    // An ObjectPlan only exists for a declared-atomic object; an array node at
    // the same path is a conflicting declared assertion.
    throw declaredTopologyConflict(targetPath)
  }
  if (isRecursionAliasOnly(existing)) {
    // An alias-only entry yields to a real plan; the alias itself survives on
    // the winning entry (CORE §3.3.7).
    arrayPlan.recurseTo ??= existing.recurseTo
    plan.set(targetPath, arrayPlan)
    return
  }
  const candDeclared = arrayPlan.topology !== undefined
  const existDeclared = existing.topology !== undefined
  if (candDeclared && existDeclared) {
    if (
      existing.topology !== arrayPlan.topology ||
      !sameStringArray(existing.keys, arrayPlan.keys) ||
      existing.order !== arrayPlan.order
    ) {
      throw declaredTopologyConflict(targetPath)
    }
    return // identical declaration — idempotent
  }
  if (candDeclared) {
    // Declared topology ALWAYS wins over a compat-derived plan (CORE §8.2.2).
    mergePlanMetadata(arrayPlan, existing)
    plan.set(targetPath, arrayPlan)
    return
  }
  if (existDeclared) {
    // Keep the declared topology; a compat plan never downgrades it.
    mergePlanMetadata(existing, arrayPlan)
    return
  }
  // Neither declared: spec-v1 rank-based reconciliation (CORE §3.7).
  if (isBetterPlan(arrayPlan, existing)) {
    mergePlanMetadata(arrayPlan, existing)
    plan.set(targetPath, arrayPlan)
  } else {
    mergePlanMetadata(existing, arrayPlan)
  }
}

/** Register a declared-atomic ObjectPlan at `docPath` (CORE §8.3.2), guarding conflicts. */
function registerObjectPlan(
  plan: Plan,
  docPath: string,
  basePath: string | undefined,
): void {
  const targetPath = resolveTargetPath(docPath, basePath)
  if (targetPath === null) return
  const existing = plan.get(targetPath)
  if (existing && !isObjectPlan(existing) && !isRecursionAliasOnly(existing)) {
    // An array node already registered at this object's path is a conflict.
    // (An alias-only entry is not an assertion about the node itself — the
    // atomic object wins and prunes the subtree, CORE §8.3.3.)
    throw declaredTopologyConflict(targetPath)
  }
  plan.set(targetPath, { granularity: "atomic" })
}

export function _resolveRef(
  ref: string,
  schema: Schema,
  onWarning?: (message: string) => void,
): JSONSchema | null {
  if (!ref.startsWith("#/")) {
    // We only support local '#/' references. Anything else (a relative/
    // absolute URL, or a document-scoped ref not rooted at '#/') is reported
    // via onWarning (F32) instead of console.warn and treated as
    // unresolvable.
    onWarning?.(`Unsupported reference: ${ref}`)
    return null
  }
  const path = ref.substring(2).split("/")
  let current: unknown = schema
  for (const part of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
      return null
    }
    current = (current as Record<string, unknown>)[part]
  }
  return current as JSONSchema
}

export function _traverseSchema(
  subSchema: JSONSchema | boolean,
  docPath: string,
  plan: Plan,
  schema: Schema,
  visited: Map<object, string> = new Map(),
  options?: Omit<BuildPlanOptions, "schema">,
) {
  if (!subSchema || typeof subSchema !== "object") {
    return
  }
  // Cycle guard (CORE §3.3): a node currently on the traversal stack is not
  // re-entered. When the re-entry happens at a DEEPER path, the subtree there
  // repeats the on-stack subtree — record a recursion alias so the compiled
  // trie can extend strategy selection to unbounded depth (CORE §3.3.7).
  const anchorPath = visited.get(subSchema)
  if (anchorPath !== undefined) {
    if (anchorPath !== docPath) {
      registerRecursionAlias(plan, docPath, anchorPath, options?.basePath)
    }
    return
  }
  visited.set(subSchema, docPath)

  if (subSchema.$ref) {
    const resolved = _resolveRef(subSchema.$ref, schema, options?.onWarning)
    if (resolved) {
      // Note: We don't change the docPath when resolving a ref
      _traverseSchema(resolved, docPath, plan, schema, visited, options)
    }
    // The visited check at the start of the function handles cycles.
    // We should remove the subSchema from visited before returning,
    // so it can be visited again via a different path.
    visited.delete(subSchema)
    return
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const schemas = subSchema[keyword]
    if (schemas && Array.isArray(schemas)) {
      const seenFingerprints = new Set<string>()
      for (const s of schemas) {
        const fp = stableStringify(s)
        if (seenFingerprints.has(fp)) continue // skip duplicate branch
        seenFingerprints.add(fp)
        _traverseSchema(s, docPath, plan, schema, visited, options)
      }
    }
  }

  // spec-v2 object granularity (CORE §8.3.2). An object node is one carrying the
  // shape keywords `properties`/`additionalProperties` (CORE §3.3.1).
  const granularity = parseObjectGranularity(subSchema)
  const isObjectNode =
    !!subSchema.properties ||
    (typeof subSchema.additionalProperties === "object" && !!subSchema.additionalProperties)
  if (granularity !== undefined && !isObjectNode) {
    // x-schema-patch-granularity on a non-object node has no effect (CORE §8.2.3).
    options?.onWarning?.(
      "x-schema-patch-granularity on a non-object node: ignored (CORE §8.2.3)",
    )
  }
  if (granularity === "atomic" && isObjectNode) {
    // CORE §8.3.2/§8.3.3: register the atomic object and PRUNE its whole subtree —
    // nothing recurses below an atomic node (CORE §8.6.2).
    registerObjectPlan(plan, docPath, options?.basePath)
    visited.delete(subSchema)
    return
  }

  // Traverse as an object whenever the shape keywords are present, regardless of
  // whether an explicit `type: "object"` is declared (CORE §3.3.1). JSON Schema does
  // not require `type` alongside `properties`/`additionalProperties` (common in
  // draft 2019/2020 schemas and anyOf branches); gating on the type keyword lost
  // every plan beneath such nodes and degraded their arrays to whole-object LCS.
  if (subSchema.properties) {
    for (const key in subSchema.properties) {
      _traverseSchema(
        subSchema.properties[key] as JSONSchema,
        // Escape so plan paths line up with the escaped patch paths the
        // differ emits for keys containing "/" or "~".
        `${docPath}/${escapeJsonPointer(key)}`,
        plan,
        schema,
        visited,
        options,
      )
    }
  }
  if (typeof subSchema.additionalProperties === "object" && subSchema.additionalProperties) {
    _traverseSchema(
      subSchema.additionalProperties,
      `${docPath}/*`,
      plan,
      schema,
      visited,
      options,
    )
  }

  // Likewise, traverse as an array whenever `items` is present (CORE §3.3.1).
  if (subSchema.items) {
    // spec-v2: a declared topology short-circuits the compat derivation
    // (CORE §3.4.0/§8.3.1) and overrides primaryKeyMap + auto-detection.
    const declaredTopology = parseArrayTopology(subSchema, options?.onWarning)
    const arrayPlan: ArrayPlan = {primaryKey: null, strategy: "lcs"}

    let itemsSchema = subSchema.items
    if (itemsSchema.$ref) {
      itemsSchema = _resolveRef(itemsSchema.$ref, schema, options?.onWarning) || itemsSchema
    }

    // F19: itemsSchema is resolved and used locally below (primitive check,
    // primary-key auto-detection, array-of-arrays detection) but is
    // deliberately NOT stored onto arrayPlan.itemSchema — nothing at diff
    // time ever read it, and retaining it pinned the resolved schema graph
    // in memory for the plan's lifetime (~2x plan memory, see the
    // @deprecated note on ArrayPlan.itemSchema).

    // Check if items are primitives
    const isPrimitive =
      itemsSchema &&
      (itemsSchema.type === "string" ||
        itemsSchema.type === "number" ||
        itemsSchema.type === "boolean")

    // Resolve a leading $ref and merge `allOf` branches into a single synthetic
    // object view (CORE §3.5.1). Items composed with allOf — e.g. a branch that
    // declares a required "id" — otherwise never surface a primary key, and
    // required fields split across allOf branches are never combined, so the
    // array silently degrades to LCS. Nested allOf and $ref branches are merged
    // recursively; branch properties/required are unioned.
    const mergeAllOf = (s: JSONSchema): JSONSchema => {
      let cur = s
      if (cur?.$ref) {
        const resolved = _resolveRef(cur.$ref, schema, options?.onWarning)
        if (!resolved) return cur
        cur = resolved
      }
      if (!cur?.allOf || !Array.isArray(cur.allOf)) return cur

      const mergedProps: Record<string, JSONSchema> = {...(cur.properties || {})}
      const mergedRequired = new Set<string>(cur.required || [])
      for (const branch of cur.allOf) {
        const view = mergeAllOf(branch as JSONSchema)
        if (view?.properties) Object.assign(mergedProps, view.properties)
        for (const req of view?.required || []) mergedRequired.add(req)
      }
      return {type: "object", properties: mergedProps, required: [...mergedRequired]}
    }

    // Find primary key and other metadata only for non-primitive object arrays
    const findMetadata = (
      s: JSONSchema,
    ): Pick<ArrayPlan, "primaryKey" | "requiredFields" | "hashFields"> | null => {
      if (!s || typeof s !== "object") return null

      const currentSchema = mergeAllOf(s)
      if (!currentSchema || currentSchema.type !== "object" || !currentSchema.properties) {
        return null
      }

      const props = currentSchema.properties
      const required = new Set(currentSchema.required || []) as Set<string>
      const hashFields: string[] = []

      // Identify potential hash fields (required, primitive types)
      for (const key of required) {
        const prop = props[key]
        if (prop && (prop.type === "string" || prop.type === "number")) {
          hashFields.push(key)
        }
      }

      // F25: the candidate list is configurable (CORE §3.5.5); default when the
      // option is omitted. An explicit empty array iterates zero candidates,
      // disabling auto-detection so the array keeps its base strategy.
      const potentialKeys =
        options?.primaryKeyCandidates ?? DEFAULT_PRIMARY_KEY_CANDIDATES
      for (const key of potentialKeys) {
        if (required.has(key)) {
          const prop = props[key]
          if (prop && (prop.type === "string" || prop.type === "number")) {
            return {
              primaryKey: key,
              requiredFields: required,
              hashFields,
            }
          }
        }
      }

      return null
    }

    // Auto-detection over the (allOf-merged) item schema, following anyOf/oneOf
    // branches in array order (CORE §3.5.1).
    const detectMetadata = (): ReturnType<typeof findMetadata> => {
      const schemas = itemsSchema.anyOf || itemsSchema.oneOf
      if (schemas) {
        let metadata: ReturnType<typeof findMetadata> | null = null
        for (const s of schemas) {
          metadata = findMetadata(s)
          if (metadata?.primaryKey) return metadata
        }
        return metadata
      }
      return findMetadata(itemsSchema)
    }

    if (declaredTopology) {
      // CORE §3.4.0: declared topology governs dispatch; fill the compat
      // strategy/primaryKey view for introspection (CORE §8.3.1).
      arrayPlan.topology = declaredTopology.topology
      if (declaredTopology.topology === "map") {
        arrayPlan.keys = declaredTopology.keys
        arrayPlan.order = declaredTopology.order
        arrayPlan.strategy = "primaryKey"
        arrayPlan.primaryKey = declaredTopology.keys?.[0] ?? null
        // requiredFields/hashFields are non-normative prefilter hints
        // (CORE §8.3.1); populate from the item object schema where present.
        if (!isPrimitive) {
          const meta = detectMetadata()
          if (meta) {
            arrayPlan.requiredFields = meta.requiredFields
            arrayPlan.hashFields = meta.hashFields
          }
        }
      } else {
        // sequence / set / atomic: strategy "lcs", no primaryKey (CORE §8.3.1).
        arrayPlan.strategy = "lcs"
        arrayPlan.primaryKey = null
      }
    } else {
      // Compatibility derivation (CORE §3.4.1–§3.5) — spec-v1 behavior.
      if (isPrimitive) {
        arrayPlan.strategy = "unique"
      }

      const customKey = options?.primaryKeyMap?.[docPath]
      if (customKey) {
        arrayPlan.primaryKey = customKey
        arrayPlan.strategy = "primaryKey"
      } else if (!isPrimitive) {
        const metadata = detectMetadata()
        if (metadata?.primaryKey) {
          arrayPlan.primaryKey = metadata.primaryKey
          arrayPlan.requiredFields = metadata.requiredFields
          arrayPlan.hashFields = metadata.hashFields
          arrayPlan.strategy = "primaryKey"
        }
      }
    }

    // Register, reconciling with any existing entry at this path (CORE §3.7);
    // a declared topology overrides a compat plan and conflicts fail
    // construction (CORE §8.2.2). basePath restriction/relativization is applied
    // inside registerArrayPlan (CORE §3.6.2).
    registerArrayPlan(plan, docPath, arrayPlan, options?.basePath)

    // Continue traversal into array items — UNLESS this is a declared `atomic`
    // array, which prunes its whole subtree (CORE §8.3.3/§8.6.2: nothing
    // recurses below an atomic node). For an object item the path is unchanged
    // (the differ adds the array index at diff time, so an item property
    // registers at `${docPath}/<prop>`). But when `items` is itself an array
    // schema (array-of-arrays), the inner array MUST register at a DISTINCT
    // path — a wildcard element segment `${docPath}/*` — so its plan never
    // overwrites the outer array's plan at the same key (CORE §3.3.5).
    if (declaredTopology?.topology !== "atomic") {
      const itemsIsArray = !!(
        itemsSchema &&
        typeof itemsSchema === "object" &&
        (itemsSchema.items || itemsSchema.type === "array")
      )
      _traverseSchema(
        subSchema.items,
        itemsIsArray ? `${docPath}/*` : docPath,
        plan,
        schema,
        visited,
        options,
      )
    }
  }
  visited.delete(subSchema)
}

export function buildPlan(options: BuildPlanOptions): Plan {
  const plan: Plan = new Map()
  const { schema, ...rest } = options
  _traverseSchema(schema, "", plan, schema, new Map(), rest)
  registerUnreachedPrimaryKeyMapEntries(plan, rest.primaryKeyMap, rest.basePath)
  return plan
}

/**
 * CORE §3.4.3: a `primaryKeyMap` path the schema traversal never reached —
 * because the schema does not describe it, or there is no schema at all —
 * still registers a `primaryKey` plan, so the override works without schema
 * coverage. Paths register in sorted order for determinism; an entry the
 * traversal already planned is left alone (the override was applied during
 * construction, and a declared topology outranks it, CORE §3.4.0). The
 * diff-time applicability gate (GEN §4.3) still guards dispatch.
 */
function registerUnreachedPrimaryKeyMapEntries(
  plan: Plan,
  primaryKeyMap: Record<string, string> | undefined,
  basePath: string | undefined,
): void {
  if (!primaryKeyMap) return
  for (const path of Object.keys(primaryKeyMap).sort()) {
    const targetPath = resolveTargetPath(path, basePath)
    if (targetPath === null) continue
    const existing = plan.get(targetPath)
    if (existing && !isRecursionAliasOnly(existing)) continue
    const entry: ArrayPlan = {
      primaryKey: primaryKeyMap[path] as string,
      strategy: "primaryKey",
    }
    if (existing && !isObjectPlan(existing)) entry.recurseTo = existing.recurseTo
    plan.set(targetPath, entry)
  }
}

// Utility: produce a canonical JSON string with sorted keys so we can deduplicate
// semantically identical schema fragments during traversal.
function stableStringify(obj: unknown): string {
  const seen = new WeakSet<object>()
  const stringify = (value: unknown): unknown => {
    if (value && typeof value === "object") {
      if (seen.has(value as object)) return undefined
      seen.add(value as object)
      const keys = Object.keys(value as Record<string, unknown>).sort()
      const result: Record<string, unknown> = {}
      for (const k of keys) {
        result[k] = stringify((value as Record<string, unknown>)[k])
      }
      return result
    }
    return value
  }
  return JSON.stringify(stringify(obj))
}

// Rank diffing strategies so we can decide which ArrayPlan is "better".
const STRATEGY_RANK: Record<NonNullable<ArrayPlan["strategy"]>, number> = {
  primaryKey: 3,
  unique: 2,
  lcs: 1,
}

function isBetterPlan(candidate: ArrayPlan, current: ArrayPlan): boolean {
  const rankA = STRATEGY_RANK[candidate.strategy ?? "lcs"]
  const rankB = STRATEGY_RANK[current.strategy ?? "lcs"]

  if (rankA !== rankB) return rankA > rankB

  // If strategies tie, prefer presence of primaryKey.
  if (candidate.primaryKey && !current.primaryKey) return true
  if (!candidate.primaryKey && current.primaryKey) return false

  // Otherwise, prefer the plan with more hashFields (better cheap-equality hints).
  const lenA = candidate.hashFields?.length ?? 0
  const lenB = current.hashFields?.length ?? 0
  return lenA > lenB
}

// Merge supplemental metadata from src into dst (in-place).
function mergePlanMetadata(dst: ArrayPlan, src: ArrayPlan) {
  if (!dst.hashFields && src.hashFields) dst.hashFields = [...src.hashFields]
  if (dst.hashFields && src.hashFields) {
    const merged = new Set([...dst.hashFields, ...src.hashFields])
    dst.hashFields = Array.from(merged)
  }
  if (!dst.requiredFields && src.requiredFields) dst.requiredFields = new Set(src.requiredFields)
  // A recursion alias survives plan reconciliation (CORE §3.3.7).
  if (dst.recurseTo === undefined && src.recurseTo !== undefined) dst.recurseTo = src.recurseTo
}
