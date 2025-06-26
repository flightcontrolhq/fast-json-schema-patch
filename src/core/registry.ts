import { SimpleParser } from '../modules/parsers/simple-parser';
import { JsoncParser } from '../modules/parsers/jsonc-parser';
import { SchemaPlanner } from '../modules/planners/schema-planner';
import { CoreDiffEngine } from '../modules/diff-engines/core-diff-engine';
import { LineAwareAggregator } from '../modules/aggregators/line-aware-aggregator';
import { SimpleAggregator } from '../modules/aggregators/simple-aggregator';
import { DefaultExplainer } from '../modules/explainers/default-explainer';
import { NoOpExplainer } from '../modules/explainers/noop-explainer';

export const BuildingBlockRegistry = {
  parsers: {
    'default': () => new JsoncParser(),
    'jsonc': () => new JsoncParser(),
    'simple': () => new SimpleParser(),
  },
  planners: {
    'default': () => new SchemaPlanner(),
    'schema-aware': () => new SchemaPlanner(),
    'no-op': () => ({ createPlan: () => new Map() }), // No-op planner
  },
  diffEngines: {
    'default': () => new CoreDiffEngine(),
    'core': () => new CoreDiffEngine(),
  },
  aggregators: {
    'default': () => new LineAwareAggregator(),
    'line-aware': () => new LineAwareAggregator(),
    'simple': () => new SimpleAggregator(),
  },
  explainers: {
    'default': () => new DefaultExplainer(),
    'detailed': () => new DefaultExplainer(),
    'none': () => new NoOpExplainer(),
  }
}; 