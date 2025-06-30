# JSON Patch Library Comparison Benchmark

This directory contains a comprehensive benchmark suite for evaluating the performance and effectiveness of various JSON patch libraries. The primary script, `index.ts`, is designed to compare `schema-json-patch` against several other popular libraries.

## Purpose

The main goal of this benchmark is to provide a detailed, data-driven comparison of different JSON patch generation approaches. It assesses libraries not just on raw speed, but also on a variety of other metrics including:

-   Patch size and count (efficiency)
-   Execution time (performance)
-   Memory usage
-   Patch application accuracy
-   Semantic correctness of the generated patch

## Libraries Compared

The benchmark compares the following libraries:

-   `schema-json-patch`: The library developed in this repository, which leverages a schema to create more efficient and semantically meaningful patches.
-   `fast-json-patch`: A popular and fast library that implements RFC 6902.
-   `jsondiffpatch`: A library that focuses on generating human-readable diffs and can detect object moves within arrays.
-   `json-diff-kit`: A library for generating formatted, human-readable diffs, used for comparison against `schema-json-patch`'s `PatchAggregator`.

## Benchmark Scenarios

The `index.ts` script runs two main types of benchmarks:

### 1. Static Scenarios

These benchmarks use predefined JSON documents to test performance on specific, controlled cases:
-   **Small**: A small configuration with minor changes.
-   **Large**: A larger configuration with more significant changes (additions, removals, modifications).
-   **Real-world**: A complex, nested configuration simulating a realistic cloud infrastructure setup, with a series of typical user-driven changes.

For these scenarios, the generated patches from each library are saved as `.json` files in this directory.

### 2. Comprehensive Dynamic Benchmark

This is the core of the benchmark suite. It uses `@faker-js/faker` to:
1.  Generate a large, random cloud service configuration document based on `schema/schema.json`.
2.  Intelligently apply a series of random modifications to the document. These modifications are weighted with a `complexity` score.
3.  Use a stratified sampling method to ensure that tests are run across a balanced distribution of complexities (Low, Medium, High, Very High).
4.  Run each of the patch libraries on the original and modified documents.
5.  Collect detailed performance and quality metrics for thousands of generated samples.

## Output

The benchmark produces two forms of output:

1.  **Console Report**: A detailed report is printed to the console, including:
    -   Summary statistics for each library.
    -   ASCII bar charts visualizing average execution time, patch count, and compression efficiency.
    -   A comparative analysis of performance across different complexity ranges.
    -   A specific comparison for formatted diff generation between `schema-json-patch`'s aggregator and `json-diff-kit`.

2.  **CSV Files**: Two CSV files are generated in this directory with a timestamp in the filename (e.g., `benchmark-results-YYYY-MM-DD.csv`):
    -   `benchmark-results-....csv`: Contains the raw metrics for every run of the main patch generation benchmark.
    -   `formatted-diff-results-....csv`: Contains the raw metrics for the formatted diff generation benchmark.

These CSV files can be used for more in-depth analysis and visualization (e.g., using the `analysis/benchmark_visualization.ipynb` notebook).

## How to Run

To execute the benchmark suite, run the following command from the root of the project:

```bash
bun run compare
```

**Note**: The benchmark can take several minutes to complete due to the large number of samples being generated and tested. 