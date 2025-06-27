# TODO: Refactor to Aggregator-Based Architecture

This document outlines the steps to refactor the `SchemaPatcher` to use an aggregator-based architecture for generating rich diffs. This decouples diff generation from formatting.

## 1. Define Core Types (`src/types.ts`)

- [x] Create a central `src/types.ts` file for all shared types.
- [x] Define `JsonValue`, `Operation` (with `oldValue`).
- [x] Define diff-related types: `DiffLine`, `SideBySideDiff`, `UnifiedDiffLine`, `PathMap`.
- [x] Remove the `PatcherPlugin` type.

## 2. Simplify `SchemaPatcher` (`src/index.ts`)

- [x] Remove the plugin system from the `SchemaPatcher`.
- [x] The constructor no longer accepts plugins.
- [x] The `addPatches` method is removed.
- [x] `SchemaPatcher` is now only responsible for creating an array of `Operation` objects.

## 3. Implement Diff Formatter (`src/diff-formatters.ts`)

- [x] Create `src/diff-formatters.ts` to house the formatting logic.
- [x] Implement the `DiffFormatter` class.
  - The constructor takes the original and new JSON documents.
  - A `format(patches: Operation[])` method takes the output from `SchemaPatcher` and returns a `SideBySideDiff` object.
- [x] Keep the `generateUnifiedDiff` function to convert the side-by-side view into a unified diff.
- [x] Include necessary helper functions (`buildPathMap`, `resolvePatchPath`, `getPathLineRange`).

## 4. Implement a Caching Mechanism (Future)

- [ ] **Goal:** Create a global cache to store `Operation[]` results for pairs of documents.
- [ ] This caching layer would wrap the `SchemaPatcher`, checking the cache before calling `createPatch`. The resulting patch array can then be passed to the `DiffFormatter` as needed.

## 5. Performance Optimizations & Caching

### 5.1 Eliminate Redundant Path Resolution Logic
- [x] **Extract Common Path Utilities**: Create a shared `src/path-utils.ts` module to consolidate path resolution logic from:
  - `getValueByPath` in `patch-aggregator.ts`
  - `resolvePatchPath` in `diff-formatters.ts` 
  - Path traversal in schema plan lookups (`index.ts`)
- [x] **Unified Path Resolution**: Implement a single, optimized path resolution function with consistent JSON Pointer handling (including `~0` and `~1` escaping)

### 5.2 JSON Serialization & Path Map Caching
- [x] **JSON String Cache**: Implement a WeakMap cache for `JSON.stringify(obj, null, 2)` results to avoid repeated serialization of the same objects
- [x] **Path Map Cache**: Cache `buildPathMap()` results using object identity as keys, since path maps are expensive to compute
- [x] **Memoized Formatting**: Cache `DiffFormatter` instances for identical (original, new) JSON pairs

### 5.3 Schema Plan Integration in PatchAggregator
- [x] **Plan-Aware Aggregation**: Modify `PatchAggregator` constructor to accept a `Plan` parameter
- [x] **Schema-Driven Array Detection**: Use plan information to identify arrays and their primary keys instead of hardcoded `idKey` parameter
- [x] **Strategy-Aware Processing**: Leverage the plan's diffing strategies (primaryKey, lcs, unique) for optimized aggregation
- [x] **Remove Hardcoded Array Logic**: Replace manual array detection with schema-based path resolution

### 5.4 Path Lookup Optimizations  
- [ ] **Plan Lookup Cache**: Implement caching for `getPlanForPath()` results with normalized path keys
- [ ] **Path Normalization Cache**: Cache normalized paths (with array indices removed) to avoid repeated regex operations
- [ ] **Wildcard Path Cache**: Cache parent wildcard path lookups to reduce string manipulation

### 5.5 Object Cloning Optimizations
- [ ] **Structured Clone Alternative**: Replace `JSON.parse(JSON.stringify())` in `stripChildArray()` with more efficient cloning (structuredClone or custom implementation)
- [ ] **Selective Cloning**: Only clone the specific parts of objects that need modification rather than entire documents
- [ ] **Clone Result Cache**: Cache clone results for identical objects to avoid repeated deep copying

### 5.6 Deep Equality Enhancements ✅
- [x] **Extend Memoization**: Expanded `deepEqualMemo` cache + added schema-aware cache with plan fingerprinting
- [x] **Hash-Based Pre-filtering**: Enhanced `fastHash` with better collision resistance and broader usage across files
- [x] **Schema-Aware Equality**: Added `deepEqualSchemaAware` function that prioritizes required fields and primary keys

**Implementation Notes:**
- Added `deepEqualSchemaAware()` function that uses plan information to optimize comparisons
- Enhanced `fastHash()` with proper hashing algorithm instead of simple concatenation
- Added `getEffectiveHashFields()` utility to intelligently select hash fields from plans or infer from data
- Updated `diffArrayByPrimaryKey()` and `diffArrayLCS()` to use schema-aware equality when plan is available
- Enhanced `PatchAggregator` with `compareObjects()` method for optimized child comparisons
- Added comprehensive caching in `DiffFormatter` with cache size management and content-based keys
- All three files now leverage enhanced equality checking and memoization strategies 

## 6. Benchmark Data Export & Visualization 📊

### 6.1 CSV Data Export
- [x] **Enhanced CSV Export**: Implement comprehensive CSV export functionality for benchmark results
  - Export all `BenchmarkMetrics` fields: library, patchCount, patchSize, executionTime, memoryUsage, accuracy, compressionRatio, complexityScore, operationType, documentSize, semanticAccuracy, iteration
  - Add computed fields: timestamp, complexityRange, throughput (ops/sec), memoryKB, patchEfficiency
  - Handle CSV escaping for string fields (operation types)
  - Generate filename with timestamp for unique exports
  - Export location: `comparison/benchmark-results-YYYY-MM-DD.csv`

### 6.2 Jupyter Notebook Analysis Suite
- [x] **Interactive Analysis Notebook**: Create `analysis/benchmark_visualization.ipynb` with comprehensive visualization capabilities
  - **Main Line Graph**: Performance trends across complexity ranges for each library (primary deliverable)
  - **Interactive Plotly Charts**: Hover details, zooming, and interactive exploration
  - **Multi-Metric Dashboard**: 4-panel comparison of execution time, patch count, memory usage, and throughput
  - **Statistical Analysis**: Performance rankings, improvement analysis, and comparative metrics
  - **Data Preprocessing**: Automatic feature engineering and data preparation

### 6.3 Notebook Features & Capabilities
- [x] **Comprehensive Visualizations**:
  - **Primary Line Graph**: Execution time vs complexity score with error bars and sample sizes
  - **Interactive Charts**: Plotly-based interactive visualizations with hover details
  - **Multi-Metric Dashboard**: Patch count, memory usage, throughput trends over complexity
  - **Performance Summary**: Rankings and comparative analysis tables
  - **Statistical Insights**: Performance improvement percentages and throughput ratios

### 6.4 Dependencies & Setup
```bash
# Install required Python packages
pip install pandas matplotlib seaborn plotly numpy scipy jupyter

# Start Jupyter notebook
jupyter notebook analysis/benchmark_visualization.ipynb
```

### 6.5 Usage Workflow
1. **Generate Benchmark Data**:
   ```bash
   npm run comparison  # Generates CSV with 5000 stratified samples
   ```

2. **Update CSV Path** in notebook:
   ```python
   CSV_PATH = '../comparison/benchmark-results-YYYY-MM-DD.csv'
   ```

3. **Run Notebook Cells** sequentially for complete analysis

4. **Export Results**: Notebook automatically saves processed data and summary statistics

### 6.6 Expected Deliverables
- [x] **CSV Export**: Automated generation of comprehensive benchmark data
- [x] **Primary Line Graph**: Clear visualization showing performance trends across complexity ranges
- [x] **Interactive Analysis**: Jupyter notebook for ongoing benchmark exploration  
- [x] **Performance Insights**: Data-driven conclusions about library performance characteristics
- [x] **Multi-Metric Analysis**: Comprehensive dashboard comparing all performance aspects

**Key Visualizations Implemented:**
- ✅ Primary: Execution Time vs Complexity Score (line graph with error bars)
- ✅ Interactive: Plotly version with hover details and zooming
- ✅ Dashboard: Multi-metric performance comparison across complexity ranges
- ✅ Rankings: Performance improvement analysis and library comparisons
- ✅ Statistics: Comprehensive performance insights and comparative metrics

**Notebook Structure:**
1. **Data Loading & Preprocessing** - CSV import and feature engineering
2. **Main Comparative Line Graph** - Primary visualization with error bars
3. **Interactive Plotly Visualization** - Enhanced interactive version
4. **Multi-Metric Dashboard** - 4-panel performance comparison
5. **Performance Insights** - Statistical analysis and rankings 