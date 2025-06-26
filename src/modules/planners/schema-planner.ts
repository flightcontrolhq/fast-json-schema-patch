import type {
  IPlanner,
  JSONSchema,
  Plan,
  ArrayPlan,
  JsonValue,
  JsonObject,
} from "../../types";
import { fastHash } from "../../utils/fast-hash";

interface PlannerOptions {
    primaryKeyMap?: Record<string, string>;
    basePath?: string;
}

function createIdentityGetter(
  arrayPlan: ArrayPlan
): ((item: JsonValue) => JsonValue) | null {
  switch (arrayPlan.strategy) {
    case "primaryKey":
      if (arrayPlan.primaryKey) {
        const pk = arrayPlan.primaryKey;
        return (item: JsonValue) => {
          if (typeof item === "object" && item !== null && !Array.isArray(item)) {
            const obj = item as JsonObject;
            if (Object.hasOwn(obj, pk)) {
              const value = obj[pk];
              if (value !== undefined) {
                return value;
              }
            }
          }
          return item;
        };
      }
      return null;
    case "unique":
      return (item: JsonValue) => item;
    case "hash":
      return (item: JsonValue) =>
        typeof item === "object" && item !== null
          ? fastHash(JSON.stringify(item))
          : item;
    default:
      return null;
  }
}

export class SchemaPlanner implements IPlanner {
  createPlan(
    schema: JSONSchema,
    options?: {
      primaryKeyMap?: Record<string, string>;
      basePath?: string;
    }
  ): Plan {
    const plan: Plan = new Map();
    this._traverseSchema(schema, "", plan, schema, new Set(), options);
    return plan;
  }

  private _resolveRef(ref: string, schema: JSONSchema): JSONSchema | null {
    if (!ref.startsWith("#/")) {
      console.warn(`Unsupported reference: ${ref}`);
      return null;
    }
    const path = ref.substring(2).split("/");
    let current: unknown = schema;
    for (const part of path) {
      if (typeof current !== "object" || current === null || !Object.hasOwn(current, part)) {
        return null;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current as JSONSchema;
  }

  private _traverseSchema(
    subSchema: JSONSchema | boolean,
    docPath: string,
    plan: Plan,
    schema: JSONSchema,
    visited: Set<object> = new Set(),
    options?: PlannerOptions,
  ) {
    if (!subSchema || typeof subSchema !== "object" || visited.has(subSchema)) {
      return;
    }
    visited.add(subSchema);

    if (subSchema.$ref) {
      const resolved = this._resolveRef(subSchema.$ref, schema);
      if (resolved) {
        this._traverseSchema(resolved, docPath, plan, schema, visited, options);
      }
      visited.delete(subSchema);
      return;
    }

    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      const schemas = subSchema[keyword];
      if (schemas && Array.isArray(schemas)) {
        for (const s of schemas) {
          this._traverseSchema(s, docPath, plan, schema, visited, options);
        }
      }
    }

    if (subSchema.type === "object") {
      if (subSchema.properties) {
        for (const key in subSchema.properties) {
          this._traverseSchema(
            subSchema.properties[key] as JSONSchema,
            `${docPath}/${key}`,
            plan,
            schema,
            visited,
            options,
          );
        }
      }
      if (typeof subSchema.additionalProperties === "object" && subSchema.additionalProperties) {
        this._traverseSchema(
          subSchema.additionalProperties,
          `${docPath}/*`,
          plan,
          schema,
          visited,
          options,
        );
      }
    }

    if (subSchema.type === "array" && subSchema.items) {
      const arrayPlan: ArrayPlan = { primaryKey: null, strategy: "lcs" };

      let itemsSchema = subSchema.items;
      if (typeof itemsSchema === 'object' && itemsSchema.$ref) {
        itemsSchema = this._resolveRef(itemsSchema.$ref, schema) || itemsSchema;
      }

      arrayPlan.itemSchema = itemsSchema as JSONSchema;

      const isPrimitive =
        typeof itemsSchema === 'object' &&
        (itemsSchema.type === "string" ||
          itemsSchema.type === "number" ||
          itemsSchema.type === "boolean");

      if (isPrimitive) {
        arrayPlan.strategy = "unique";
      }

      const customKey = options?.primaryKeyMap?.[docPath];
      if (customKey) {
        arrayPlan.primaryKey = customKey;
        arrayPlan.strategy = "primaryKey";
      } else if (!isPrimitive && typeof itemsSchema === 'object') {
        const findMetadata = (s: JSONSchema): Pick<ArrayPlan, "primaryKey" | "requiredFields" | "hashFields"> | null => {
            let currentSchema = s;
            if (typeof currentSchema !== "object") return null;
    
            if (currentSchema.$ref) {
              const resolved = this._resolveRef(currentSchema.$ref, schema);
              if (!resolved) return null;
              currentSchema = resolved;
            }
            if (currentSchema.type !== "object" || !currentSchema.properties) {
              return null;
            }
    
            const props = currentSchema.properties;
            const required = new Set(currentSchema.required || []) as Set<string>;
            const hashFields: string[] = [];
    
            for (const key of required) {
              const prop = props[key];
              if (typeof prop === 'object' && (prop.type === "string" || prop.type === "number")) {
                hashFields.push(key);
              }
            }
    
            const potentialKeys = ["id", "name", "port"];
            for (const key of potentialKeys) {
              if (required.has(key)) {
                const prop = props[key];
                if (typeof prop === 'object' && (prop.type === "string" || prop.type === "number")) {
                  return {
                    primaryKey: key,
                    requiredFields: required,
                    hashFields,
                  };
                }
              }
            }
    
            return { primaryKey: null, requiredFields: required, hashFields };
        };

        const schemas = itemsSchema.anyOf || itemsSchema.oneOf;
        let metadata: ReturnType<typeof findMetadata> | null = null;
        if (schemas) {
          for (const s of schemas) {
            if (typeof s === 'object') {
                metadata = findMetadata(s);
                if (metadata?.primaryKey) break;
            }
          }
        } else {
          metadata = findMetadata(itemsSchema);
        }

        if (metadata) {
          arrayPlan.primaryKey = metadata.primaryKey;
          arrayPlan.requiredFields = metadata.requiredFields;
          arrayPlan.hashFields = metadata.hashFields;
          if (metadata.primaryKey) {
            arrayPlan.strategy = "primaryKey";
          }
        }
      }

      arrayPlan.getIdentity = createIdentityGetter(arrayPlan) || undefined;

      if (options?.basePath) {
        if (docPath.startsWith(options.basePath)) {
          plan.set(docPath.replace(options.basePath, ""), arrayPlan);
        }
      } else {
        plan.set(docPath, arrayPlan);
      }
      
      if (typeof subSchema.items === 'object') {
        this._traverseSchema(subSchema.items, docPath, plan, schema, visited, options);
      }
    }
    visited.delete(subSchema);
  }
} 