import type {
  JSONSchema,
  PatcherOptions,
  PatcherInstance,
  DiffOptions,
  FinalPatch,
  Plan,
  IPlanner,
  IExplainer,
  IParser,
  IDiffEngine,
  IAggregator,
  DiffDelta,
} from "../types";
import { resolveModule } from "./pipeline";
import { fastHash } from "../utils/fast-hash";

function filterDeltas(deltas: DiffDelta[], partialKeys: string[]): DiffDelta[] {
  return deltas.filter((delta) =>
    partialKeys.some((key) => delta.path.startsWith(key))
  );
}

export function createPatcher(
  schema: JSONSchema,
  options?: PatcherOptions
): PatcherInstance {
  const planner = resolveModule<IPlanner>(
    "planners",
    options?.planner || "default"
  );
  const explainer = resolveModule<IExplainer>(
    "explainers",
    options?.explainer || "default"
  );
  const plan: Plan = planner.createPlan(schema, options?.plannerOptions);

  const instance: PatcherInstance = {
    _plan: plan,
    _options: options || {},
    _resultsCache: new Map<string, DiffDelta[]>(),

    diff(
      this: PatcherInstance,
      doc1: string,
      doc2: string,
      diffOptions?: DiffOptions
    ): FinalPatch {
      const cacheKey = fastHash(doc1) + ":" + fastHash(doc2);
      let allDeltas: DiffDelta[];

      if (this._resultsCache.has(cacheKey)) {
        allDeltas = this._resultsCache.get(cacheKey) as DiffDelta[];
      } else {
        const diffEngine = resolveModule<IDiffEngine>(
          "diffEngines",
          this._options.diffEngine || diffOptions?.diffEngine || "default"
        );
        const parser = resolveModule<IParser>(
          "parsers",
          this._options.parser || diffOptions?.parser || "default"
        );
        const parsedDoc1 = parser.parse(doc1);
        const parsedDoc2 = parser.parse(doc2);

        const deltaIterator = diffEngine.diff(
          parsedDoc1,
          parsedDoc2,
          this._plan
        );
        allDeltas = Array.from(deltaIterator);
        this._resultsCache.set(cacheKey, allDeltas);
      }

      const isPartial = !!(
        diffOptions?.partialDiffKeys && diffOptions.partialDiffKeys.length > 0
      );
      const deltasToProcess = isPartial
        ? filterDeltas(allDeltas, diffOptions?.partialDiffKeys || [])
        : allDeltas;

      const aggregator = resolveModule<IAggregator>(
        "aggregators",
        this._options.aggregator || diffOptions?.aggregator || "default"
      );
      const finalParser = resolveModule<IParser>(
        "parsers",
        this._options.parser || diffOptions?.parser || "default"
      );
      const finalParsedDoc1 = finalParser.parse(doc1);
      const finalParsedDoc2 = finalParser.parse(doc2);

      const finalPatch = aggregator.aggregate(deltasToProcess, {
        plan: this._plan,
        isPartial: isPartial,
        explainer: explainer,
        parsedDoc1: finalParsedDoc1,
        parsedDoc2: finalParsedDoc2,
        partialKeys: diffOptions?.partialDiffKeys,
      });

      return finalPatch;
    },

    getPlan(this: PatcherInstance): Plan {
      return this._plan;
    },

    clearCache(this: PatcherInstance): void {
      this._resultsCache.clear();
    },
  };

  return instance;
}
