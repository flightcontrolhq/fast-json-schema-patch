import { type IExplainer, type DiffDelta, type Plan } from "../../types";

export class NoOpExplainer implements IExplainer {
  explain(delta: DiffDelta, plan: Plan): string {
    return "";
  }
} 