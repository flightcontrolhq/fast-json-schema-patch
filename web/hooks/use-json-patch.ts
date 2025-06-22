"use client";

import { useMemo, useState } from "react";
import { buildPlan, SchemaPatcher } from "../../src";

// Define the structure of a line in the diff output
interface DiffLine {
  type: "added" | "removed" | "context" | "ellipsis" | "expand-control";
  content: string;
  lineNumber: number;
  originalLineNumber?: number;
  isParentContext?: boolean;
  expandableId?: string;
  startIndex?: number;
  endIndex?: number;
  hiddenLines?: DiffLine[];
  expandDirection?: "up" | "down";
  expandCount?: number;
}

export function useJsonPatch(originalJson: string, newJson: string) {
  const [error, setError] = useState<string | null>(null);

  const { patch, diffLines } = useMemo(() => {
    try {
      setError(null);
      // This is a simplified diff generation.
      // A proper implementation would involve a more complex diffing algorithm
      // to generate line-by-line changes and context folding.
      const plan = buildPlan({});
      const patcher = new SchemaPatcher({ plan });
      const patch = patcher.createPatch(
        JSON.parse(originalJson || "{}"),
        JSON.parse(newJson || "{}")
      );
      const newLines = newJson.split('\n');
      
      const lines : DiffLine[] = [];
      
      // NOTE: This is a very simplified placeholder.
      // A real implementation would use a diffing algorithm (like Myers)
      // on the lines of the JSON strings, and then correlate those changes
      // with the JSON patch operations to provide context.
      
      patch.forEach(op => {
          if (op.op === 'add') {
              lines.push({ type: 'added', content: `+ ${op.path}: ${JSON.stringify(op.value)}`, lineNumber: 0 });
          } else if (op.op === 'remove') {
              lines.push({ type: 'removed', content: `- ${op.path}`, lineNumber: 0 });
          } else if (op.op === 'replace') {
              lines.push({ type: 'removed', content: `- ${op.path}`, lineNumber: 0 });
              lines.push({ type: 'added', content: `+ ${op.path}: ${JSON.stringify(op.value)}`, lineNumber: 0 });
          }
      });


      if (patch.length === 0) {
        newLines.forEach((l, i) => lines.push({ type: 'context', content: l, lineNumber: i+1, originalLineNumber: i+1 }))
      }


      return { patch, diffLines: lines };

    } catch (e: any) {
      setError(e.message);
      return { patch: [], diffLines: [] };
    }
  }, [originalJson, newJson]);

  return { patch, diffLines, error };
} 