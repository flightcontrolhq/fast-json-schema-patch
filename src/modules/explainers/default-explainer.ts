import { type IExplainer, type DiffDelta, type Plan } from "../../types";

export class DefaultExplainer implements IExplainer {
  explain(delta: DiffDelta, plan: Plan): string {
    const { op, path, value, oldValue } = delta;

    switch (op) {
      case 'add':
        return `Added value at path '${path}'.`;
      case 'remove':
        return `Removed value from path '${path}'.`;
      case 'replace':
        return `Replaced value at path '${path}'.`;
      case 'move':
        return `Moved value from '${delta.from}' to '${path}'.`;
      case 'copy':
          return `Copied value from '${delta.from}' to '${path}'.`;
      default:
        return `Unknown operation '${op}' at path '${path}'.`;
    }
  }
} 