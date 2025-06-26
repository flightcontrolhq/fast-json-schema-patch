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
import { fastHash } from "../utils/fast-hash";
import { SchemaPlanner } from "../modules/planners/schema-planner";
import { DefaultExplainer } from "../modules/explainers/default-explainer";
import { SimpleParser } from "../modules/parsers/simple-parser";
import { LegacyDiffEngine } from "../modules/diff-engines/legacy-diff-engine";
import { SimpleAggregator } from "../modules/aggregators/simple-aggregator";
import { PerformanceTracker } from "../utils/performance-tracker";

function filterDeltas(deltas: DiffDelta[], partialKeys: string[]): DiffDelta[] {
  return deltas.filter((delta) =>
    partialKeys.some((key) => delta.path.startsWith(key))
  );
}

export function createPatcher(
  schema: JSONSchema,
  options?: PatcherOptions
): PatcherInstance {
  const planner: IPlanner = new SchemaPlanner();
  // TODO: Implement module registry to handle string-based module selection
  const explainer: IExplainer = (options?.explainer as IExplainer) || new DefaultExplainer();
  const plan: Plan = planner.createPlan(schema, options?.plannerOptions);
  const parser: IParser = (options?.parser as IParser) || new SimpleParser();
  const diffEngine: IDiffEngine = new LegacyDiffEngine();
  const aggregator: IAggregator = (options?.aggregator as IAggregator) || new SimpleAggregator();
  const performance = options?.verbose ? new PerformanceTracker() : null;

  const instance: PatcherInstance = {
    _plan: plan,
    _options: options || {},
    _resultsCache: new Map<string, DiffDelta[]>(),
    _eqCache: new WeakMap(),
    performance: performance,

    diff(
      this: PatcherInstance,
      doc1: string,
      doc2: string,
      diffOptions?: DiffOptions
    ): FinalPatch {
      const cacheKey = fastHash(doc1) + ":" + fastHash(doc2);
      let allDeltas: DiffDelta[];
      this.performance?.start("parse");
      const parsedDoc1 = parser.parse(doc1);
      const parsedDoc2 = parser.parse(doc2);
      this.performance?.end("parse");

      if (this._resultsCache.has(cacheKey)) {
        allDeltas = this._resultsCache.get(cacheKey) as DiffDelta[];
        this.performance?.addContext("cache", "hit");
      } else {
        this.performance?.addContext("cache", "miss");
        this.performance?.start("diffEngine");
        allDeltas = diffEngine.diff(
          parsedDoc1,
          parsedDoc2,
          this._plan,
          undefined,
          this.performance,
          this._eqCache
        );
        this.performance?.end("diffEngine");
        this._resultsCache.set(cacheKey, allDeltas);
      }

      const isPartial = !!(
        diffOptions?.partialDiffKeys && diffOptions.partialDiffKeys.length > 0
      );
      const deltasToProcess = isPartial
        ? filterDeltas(allDeltas, diffOptions?.partialDiffKeys || [])
        : allDeltas;

      this.performance?.start("aggregator");
      const finalPatch = aggregator.aggregate(deltasToProcess, {
        plan: this._plan,
        isPartial: isPartial,
        explainer: explainer,
        parsedDoc1: parsedDoc1,
        parsedDoc2: parsedDoc2,
        partialKeys: diffOptions?.partialDiffKeys,
      });
      this.performance?.end("aggregator");
      if (this.performance) {
        this.performance.addContext("inputs", {
          doc1_hash: fastHash(doc1),
          doc2_hash: fastHash(doc2),
        });
        this.performance.logSummary("📊 In-memory Performance Summary:");
      }

      return finalPatch;
    },

    getPlan(this: PatcherInstance): Plan {
      return this._plan;
    },

    async savePerformanceReport(this: PatcherInstance, filePath: string): Promise<void> {
      if (this.performance) {
        await this.performance.saveReportToFile(filePath);
      } else {
        console.warn("Performance tracking is not enabled. To enable, set `verbose: true` in patcher options.");
      }
    },

    clearCache(this: PatcherInstance): void {
      this._resultsCache.clear();
      this._eqCache = new WeakMap();
      this.performance?.clear();
    },
  };

  return instance;
}