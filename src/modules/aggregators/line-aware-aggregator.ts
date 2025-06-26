import type {
  IAggregator,
  DiffDelta,
  Plan,
  FinalPatch,
  FormattedOperation,
  IExplainer,
  ParsedDocument,
} from "../../types";

export class LineAwareAggregator implements IAggregator {
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
  ): FinalPatch {
    const operations: FormattedOperation[] = [];
    const { parsedDoc1, parsedDoc2, isPartial, explainer, plan, partialKeys } =
      options;

    const partialKeyLocations = new Map<
      string,
      { old: { line: number; column: number }; new: { line: number; column: number } }
    >();

    if (isPartial && partialKeys) {
      for (const key of partialKeys) {
        partialKeyLocations.set(key, {
          old: parsedDoc1.getNodeLocation(key),
          new: parsedDoc2.getNodeLocation(key),
        });
      }
    }

    for (const delta of deltas) {
      let line: number | undefined;
      let oldLine: number | undefined;

      if (delta.op !== "add") {
        const locationOld = parsedDoc1.getNodeLocation(delta.path);
        oldLine = locationOld.line;
      }

      if (delta.op !== "remove") {
        const locationNew = parsedDoc2.getNodeLocation(delta.path);
        line = locationNew.line;
      }

      if (isPartial && partialKeys && partialKeys.length > 0) {
        // Find the most specific matching partial key for the current delta.
        const matchingKey = partialKeys
          .filter((key) => delta.path.startsWith(key))
          .sort((a, b) => b.length - a.length)[0];

        if (matchingKey) {
          const baseLocations = partialKeyLocations.get(matchingKey);
          if (baseLocations) {
            if (line !== undefined) {
              line = line - baseLocations.new.line + 1;
            }
            if (oldLine !== undefined) {
              oldLine = oldLine - baseLocations.old.line + 1;
            }
          }
        }
      }

      operations.push({
        ...delta,
        explanation: explainer.explain(delta, plan),
        line,
        oldLine,
      });
    }
    return { operations };
  }
}
