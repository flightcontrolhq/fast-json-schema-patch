import { type IAggregator, type DiffDelta, type Plan, type FinalPatch, type FormattedOperation, type IExplainer, type ParsedDocument } from "../../types";

export class SimpleAggregator implements IAggregator {
  aggregate(
    deltas: Iterable<DiffDelta>,
    options: {
      plan: Plan;
      isPartial: boolean;
      explainer: IExplainer;
      parsedDoc1: ParsedDocument;
      parsedDoc2: ParsedDocument;
    }
  ): FinalPatch {
    const operations: FormattedOperation[] = [];
    for (const delta of deltas) {
      operations.push({
        ...delta,
        explanation: options.explainer.explain(delta, options.plan),
        // Line numbers are not calculated in the simple aggregator.
      });
    }
    return { operations };
  }
} 