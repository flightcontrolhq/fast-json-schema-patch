import chalk from "chalk";
import Chartscii from "chartscii";
import type { BenchmarkMetrics, FormattedDiffMetrics, PerformanceStats } from "./types";
import { groupBy, calculatePerformanceStats, formatBytes } from "./utils";

// Visualization Functions
export function generatePerformanceCharts(metrics: BenchmarkMetrics[]) {
  console.log("\n📊 PERFORMANCE ANALYSIS");
  console.log("=".repeat(80));

  const libraryGroups: Record<string, BenchmarkMetrics[]> = groupBy(metrics, "library");
  const libraryNames = Object.keys(libraryGroups);
  const colors = ["green", "blue", "purple", "yellow"];

  // 1. Average Execution Time Chart
  console.log("\n⚡ Average Execution Time by Library:");
  const timeData = libraryNames.map((library, index) => {
    const items = libraryGroups[library] || [];
    const avgTime =
      items.length > 0
        ? items.reduce((sum, item) => sum + item.executionTime, 0) /
          items.length
        : 0;
    return {
      value: Number(avgTime.toFixed(2)),
      label: library,
      color: colors[index % colors.length],
    };
  });

  const timeChart = new Chartscii(timeData, {
    width: 60,
    height: 8,
    theme: "pastel",
    colorLabels: true,
    valueLabels: true,
    valueLabelsPrefix: "",
    title: "Execution Time (ms)",
    orientation: "horizontal",
    sort: true,
  });
  console.log(timeChart.create());

  // 2. Patch Count Efficiency Chart
  console.log("\n📏 Patch Count Efficiency (Lower is Better):");
  const patchData = libraryNames.map((library, index) => {
    const items = libraryGroups[library] || [];
    const avgPatches =
      items.length > 0
        ? items.reduce((sum, item) => sum + item.patchCount, 0) / items.length
        : 0;
    return {
      value: Number(avgPatches.toFixed(1)),
      label: library,
      color: colors[index % colors.length],
    };
  }).sort((a, b) => a.value - b.value); // Sort by value ascending (fewer patches = better = appears first)

  const patchChart = new Chartscii(patchData, {
    width: 60,
    height: 8,
    theme: "pastel",
    colorLabels: true,
    valueLabels: true,
    title: "Average Patches Generated (Fewer = Better)",
    orientation: "horizontal",
    sort: false, // Don't sort automatically, data is ordered by efficiency
  });
  console.log(patchChart.create());

  console.log("\n🎯 Comparative Algorithm Performance Analysis:");

  // Debug: Check data distribution and identify samples outside ranges
  const allComplexityScores = metrics.map((m) => m.complexityScore);
  const minComplexity = Math.min(...allComplexityScores);
  const maxComplexity = Math.max(...allComplexityScores);
  console.log(
    `\n🔍 DEBUG: Complexity score range: ${minComplexity} to ${maxComplexity}`
  );

  const byLibraryDebug: Record<string, BenchmarkMetrics[]> = groupBy(metrics, "library");
  Object.entries(byLibraryDebug).forEach(([library, items]) => {
    const avgTime =
      items.reduce((sum, m) => sum + m.executionTime, 0) / items.length;
    console.log(
      `${library}: ${items.length} samples, avg time: ${avgTime.toFixed(3)}ms`
    );
  });

  const complexityRanges = [
    { label: "Low", min: 0, max: 50 },
    { label: "Medium", min: 51, max: 200 },
    { label: "High", min: 201, max: 500 },
    { label: "Very High", min: 501, max: 3000 }, // Adjusted to capture all samples
  ];

  const libraries = ["fast-json-schema-patch", "fast-json-patch", "jsondiffpatch"];
  const libraryColors = ["green", "blue", "purple", "yellow"];

  console.log("\n📏 Average Time by Complexity Range - All Algorithms:");

  // Debug: Check sample distribution across ranges
  let totalCategorized = 0;
  complexityRanges.forEach((range) => {
    const rangeCount = metrics.filter(
      (m) => m.complexityScore >= range.min && m.complexityScore <= range.max
    ).length;
    console.log(
      `${range.label} (${range.min}-${range.max}): ${rangeCount} samples`
    );
    totalCategorized += rangeCount;
  });
  console.log(
    `Total categorized: ${totalCategorized} out of ${metrics.length} total samples`
  );
  const uncategorized = metrics.length - totalCategorized;
  if (uncategorized > 0) {
    console.log(
      `⚠️  WARNING: ${uncategorized} samples fall outside complexity ranges!`
    );
  }

  const allTimeData: any[] = [];
  complexityRanges.forEach((range) => {
    libraries.forEach((library, libIndex) => {
      const libraryMetrics = metrics.filter(
        (m) =>
          m.library === library &&
          m.complexityScore >= range.min &&
          m.complexityScore <= range.max
      );
      if (libraryMetrics.length > 0) {
        const avgTime =
          libraryMetrics.reduce((sum, item) => sum + item.executionTime, 0) /
          libraryMetrics.length;
        allTimeData.push({
          value: Number(avgTime.toFixed(3)),
          label: `${library}-${range.label} (n=${libraryMetrics.length})`,
          color: libraryColors[libIndex],
        });
      }
    });
  });

  if (allTimeData.length > 0) {
    const timeChart = new Chartscii(allTimeData, {
      width: 90,
      height: 12,
      theme: "pastel",
      colorLabels: true,
      valueLabels: true,
      title: "Average Time by Algorithm & Complexity Range",
      orientation: "horizontal",
      sort: false,
    });
    console.log(timeChart.create());
  }

  console.log("\n📏 Average Patch Count by Complexity Range - All Algorithms:");
  const allPatchData: any[] = [];

  complexityRanges.forEach((range) => {
    libraries.forEach((library, libIndex) => {
      const libraryMetrics = metrics.filter(
        (m) =>
          m.library === library &&
          m.complexityScore >= range.min &&
          m.complexityScore <= range.max
      );
      if (libraryMetrics.length > 0) {
        const avgPatches =
          libraryMetrics.reduce((sum, item) => sum + item.patchCount, 0) /
          libraryMetrics.length;
        const sampleCount = libraryMetrics.length;
        allPatchData.push({
          value: Number(avgPatches.toFixed(1)),
          label: `${library}-${range.label} (n=${sampleCount})`,
          color: libraryColors[libIndex],
        });
      }
    });
  });

  if (allPatchData.length > 0) {
    const patchChart = new Chartscii(allPatchData, {
      width: 90,
      height: 12,
      theme: "pastel",
      colorLabels: true,
      valueLabels: true,
      title: "Average Patch Count by Algorithm & Complexity Range",
      orientation: "horizontal",
      sort: false,
    });
    console.log(patchChart.create());
  }

  console.log("\n📊 Chart Legend:");
  console.log("🟢 Schema = fast-json-schema-patch");
  console.log("🟡 FastJSON = fast-json-patch");
  console.log("🟠 JSONDiff = jsondiffpatch");
  console.log("\n💡 Efficiency Interpretation:");
  console.log("  • Execution Time: Lower values = Faster (Better)");
  console.log("  • Patch Count: Lower values = More Efficient (Better)");
  console.log("  • Compression Ratio: Lower values = Smaller patches relative to document size (Better)");
  console.log("  • Memory Usage: Lower values = More Memory Efficient (Better)");
  console.log("-".repeat(80));

  // 5. Compression Efficiency Chart
  console.log("\n💾 Patch Size Efficiency (Lower is Better):");
  const compressionData = libraryNames.map((library, index) => {
    const items = libraryGroups[library] || [];
    const avgCompression =
      items.length > 0
        ? items.reduce((sum, item) => sum + item.compressionRatio, 0) /
          items.length
        : 0;
    return {
      value: Number(avgCompression.toFixed(1)),
      label: library,
      color: colors[index % colors.length],
    };
  }).sort((a, b) => a.value - b.value); // Sort by value ascending (lower ratio = better = appears first)

  const compressionChart = new Chartscii(compressionData, {
    width: 60,
    height: 8,
    theme: "standard",
    colorLabels: true,
    valueLabels: true,
    valueLabelsPrefix: "",
    title: "Compression Ratio - % of Document Size (Lower = Better)",
    orientation: "horizontal",
    sort: false, // Don't sort automatically, data is pre-sorted by efficiency
  });
  console.log(compressionChart.create());

  // Summary Statistics Table
  console.log("\n📊 Detailed Performance Summary:");
  const summaryTable = Object.entries(libraryGroups).map(([library, items]) => {
    const times = items.map((m) => m.executionTime);
    const stats = calculatePerformanceStats(times);
    const accuracy =
      (items.filter((m) => m.accuracy).length / items.length) * 100;
    const avgPatchSize =
      items.reduce((sum, m) => sum + m.patchSize, 0) / items.length;
    const avgPatchCount =
      items.reduce((sum, m) => sum + m.patchCount, 0) / items.length;
    const avgMemory =
      items.reduce((sum, m) => sum + m.memoryUsage, 0) / items.length;
    const throughput = stats.mean > 0 ? 1000 / stats.mean : 0; // ops per second

    return {
      Library: library,
      "Avg Time (ms)": stats.mean.toFixed(2),
      "Throughput (ops/s)": throughput.toFixed(0),
      "P95 Time (ms)": stats.p95?.toFixed(2),
      "Accuracy (%)": accuracy.toFixed(1),
      "Avg Patches": avgPatchCount.toFixed(1),
      "Avg Size (bytes)": avgPatchSize.toFixed(0),
      "Memory (KB)": (avgMemory / 1024).toFixed(1),
    };
  });

  console.table(summaryTable);
}

export function generateFormattedDiffReport(formattedMetrics: FormattedDiffMetrics[], title?: string) {
  const byLibrary = groupBy(formattedMetrics, "library");

  if (title) {
    console.log(chalk.bold.magenta(`\n\n--- ${title} Formatted Diff Report ---`));
  }
  console.log("\n🎨 FORMATTED DIFF COMPARISON REPORT");
  console.log("=".repeat(80));

  console.log("\n📋 SchemaPatch + StructuredDiff vs json-diff-kit:");
  console.log(
    "  This compares formatted, human-readable diff generation capabilities"
  );

  const schemaMetrics: FormattedDiffMetrics[] = byLibrary["schema-aggregated"] || [];
  const jsonDiffKitMetrics: FormattedDiffMetrics[] = byLibrary["json-diff-kit"] || [];

  if (schemaMetrics.length > 0 && jsonDiffKitMetrics.length > 0) {
    const avgSchemaTime =
      schemaMetrics.reduce((sum, m) => sum + m.executionTime, 0) /
      schemaMetrics.length;
    const avgJsonDiffKitTime =
      jsonDiffKitMetrics.reduce((sum, m) => sum + m.executionTime, 0) /
      jsonDiffKitMetrics.length;

    const avgSchemaSize =
      schemaMetrics.reduce((sum, m) => sum + m.outputSize, 0) /
      schemaMetrics.length;
    const avgJsonDiffKitSize =
      jsonDiffKitMetrics.reduce((sum, m) => sum + m.outputSize, 0) /
      jsonDiffKitMetrics.length;

    const avgSchemaMemory =
      schemaMetrics.reduce((sum, m) => sum + m.memoryUsage, 0) /
      schemaMetrics.length;
    const avgJsonDiffKitMemory =
      jsonDiffKitMetrics.reduce((sum, m) => sum + m.memoryUsage, 0) /
      jsonDiffKitMetrics.length;

    console.table([
      {
        Library: "SchemaPatch + Aggregator",
        "Avg Time (ms)": avgSchemaTime.toFixed(2),
        "Avg Output Size": formatBytes(avgSchemaSize),
        "Avg Memory (KB)": (avgSchemaMemory / 1024).toFixed(1),
        "Throughput (ops/s)": (1000 / avgSchemaTime).toFixed(0),
      },
      {
        Library: "json-diff-kit",
        "Avg Time (ms)": avgJsonDiffKitTime.toFixed(2),
        "Avg Output Size": formatBytes(avgJsonDiffKitSize),
        "Avg Memory (KB)": (avgJsonDiffKitMemory / 1024).toFixed(1),
        "Throughput (ops/s)": (1000 / avgJsonDiffKitTime).toFixed(0),
      },
    ]);

    const timeRatio = avgSchemaTime / avgJsonDiffKitTime;
    const sizeRatio = avgSchemaSize / avgJsonDiffKitSize;
    const memoryRatio = avgSchemaMemory / avgJsonDiffKitMemory;

    console.log("\n🏆 Formatted Diff Comparison Summary:");
    console.log(
      `  • Performance: ${
        timeRatio <= 1 ? "SchemaPatch" : "json-diff-kit"
      } is ${
        timeRatio <= 1 ? (1/timeRatio).toFixed(2) : timeRatio.toFixed(2)
      }x faster`
    );
    console.log(
      `  • Output size: ${
        sizeRatio <= 1 ? "SchemaPatch" : "json-diff-kit"
      } produces ${
        sizeRatio <= 1 ? (1/sizeRatio).toFixed(2) : sizeRatio.toFixed(2)
      }x smaller output`
    );
    console.log(
      `  • Memory usage: ${
        memoryRatio <= 1 ? "SchemaPatch" : "json-diff-kit"
      } uses ${
        memoryRatio <= 1 ? (1/memoryRatio).toFixed(2) : memoryRatio.toFixed(2)
      }x less memory`
    );
  }
}

export function generateComprehensiveReport(allMetrics: BenchmarkMetrics[], title?: string) {
  const byLibrary: Record<string, BenchmarkMetrics[]> = groupBy(allMetrics, "library");

  if (title) {
    console.log(chalk.bold.cyan(`\n\n--- ${title} Benchmark Report ---`));
  }
  console.log("\n🎯 COMPREHENSIVE BENCHMARK REPORT");
  console.log("=".repeat(80));

  console.log("\n📋 Executive Summary:");
  const totalRuns = allMetrics.length / Object.keys(byLibrary).length;
  const avgComplexity =
    allMetrics.reduce((sum, m) => sum + m.complexityScore, 0) /
    allMetrics.length;
  console.log(`• Total test runs: ${totalRuns.toFixed(0)} per library`);
  console.log(`• Average complexity score: ${avgComplexity.toFixed(1)}`);
  console.log(`• Libraries tested: ${Object.keys(byLibrary).join(", ")}`);

  generatePerformanceCharts(allMetrics);

  console.log("\n📈 Latency Distribution Analysis (ms)");
  const latencyBins = [0, 10, 50, 100, 250, 500, 1000, 2500, 5000];
  const latencyData = Object.entries(byLibrary).flatMap(([library, items], libIndex) => {
    const times = items.map(item => item.executionTime);
    const bins = new Array(latencyBins.length).fill(0);
    times.forEach(time => {
      const binIndex = latencyBins.findIndex(bin => time <= bin);
      if (binIndex >= 0) {
        bins[binIndex]++;
      } else {
        bins[bins.length - 1]++;
      }
    });

    return bins.map((count, i) => {
      const binLabel = i < latencyBins.length -1 ? `<${latencyBins[i+1]}ms` : `>${latencyBins[latencyBins.length-1]}ms`;
      return {
        value: count,
        label: `${library.split('-')[0]}-${binLabel}`,
        color: ['green', 'blue', 'purple', 'yellow'][libIndex]
      }
    });
  });

  if (latencyData.length > 0) {
    const latencyChart = new Chartscii(latencyData, {
      width: 100,
      height: 15,
      theme: 'pastel',
      colorLabels: true,
      valueLabels: true,
      title: 'Latency Distribution by Library (count of operations in each bucket)',
      orientation: 'horizontal',
      sort: false
    });
    console.log(latencyChart.create());
  }

  console.log("\n🏆 Schema-Based Advantages Analysis:");
  const newSchemaMetrics: BenchmarkMetrics[] = byLibrary["fast-json-schema-patch"] || [];
  const fastJsonMetrics: BenchmarkMetrics[] = byLibrary["fast-json-patch"] || [];

  if (newSchemaMetrics.length > 0 && fastJsonMetrics.length > 0) {
    const avgSchemaPatches =
      newSchemaMetrics.reduce((sum: number, m: any) => sum + m.patchCount, 0) /
      newSchemaMetrics.length;
    const avgFastPatches =
      fastJsonMetrics.reduce((sum: number, m: any) => sum + m.patchCount, 0) /
      fastJsonMetrics.length;
    const avgSchemaTime =
      newSchemaMetrics.reduce(
        (sum: number, m: any) => sum + m.executionTime,
        0
      ) / newSchemaMetrics.length;
    const avgFastTime =
      fastJsonMetrics.reduce(
        (sum: number, m: any) => sum + m.executionTime,
        0
      ) / fastJsonMetrics.length;
    const avgSchemaSize =
      newSchemaMetrics.reduce((sum: number, m: any) => sum + m.patchSize, 0) /
      newSchemaMetrics.length;
    const avgFastSize =
      fastJsonMetrics.reduce((sum: number, m: any) => sum + m.patchSize, 0) /
      fastJsonMetrics.length;
    const avgSemanticAccuracy =
      newSchemaMetrics.reduce(
        (sum: number, m: any) => sum + m.semanticAccuracy,
        0
      ) / newSchemaMetrics.length;

    const patchReduction = Math.max(
      0,
      ((avgFastPatches - avgSchemaPatches) / avgFastPatches) * 100
    );
    const sizeReduction = Math.max(
      0,
      ((avgFastSize - avgSchemaSize) / avgFastSize) * 100
    );
    const accuracyRate =
      (newSchemaMetrics.filter((m: any) => m.accuracy).length /
        newSchemaMetrics.length) *
      100;

    console.table([
      {
        "Patch Count Reduction (%)": patchReduction.toFixed(1),
        "Size Reduction (%)": sizeReduction.toFixed(1),
        "Accuracy Rate (%)": accuracyRate.toFixed(1),
        "Semantic Accuracy Score": avgSemanticAccuracy.toFixed(1),
        "Avg Time vs fast-json-patch": `${(avgSchemaTime / avgFastTime).toFixed(
          2
        )}x`,
      },
    ]);
  }

  console.log("\n🚀 Performance Insights:");
  if (newSchemaMetrics.length > 0) {
    const avgSchemaTime =
      newSchemaMetrics.reduce(
        (sum: number, m: any) => sum + m.executionTime,
        0
      ) / newSchemaMetrics.length;
    const avgSchemaPatches =
      newSchemaMetrics.reduce((sum: number, m: any) => sum + m.patchCount, 0) /
      newSchemaMetrics.length;
    console.log(
      `• fast-json-schema-patch (new) generates ${avgSchemaPatches.toFixed(
        1
      )} patches on average`
    );
    console.log(`• Average execution time: ${avgSchemaTime.toFixed(2)}ms`);

    if (fastJsonMetrics.length > 0) {
      const avgFastTime =
        fastJsonMetrics.reduce((sum, m) => sum + m.executionTime, 0) /
        fastJsonMetrics.length;
      const avgFastPatches =
        fastJsonMetrics.reduce((sum, m) => sum + m.patchCount, 0) /
        fastJsonMetrics.length;
      const patchReduction =
        ((avgFastPatches - avgSchemaPatches) / avgFastPatches) * 100;
      const timeRatio = avgSchemaTime / avgFastTime;

      if (patchReduction > 0) {
        console.log(
          `• ${patchReduction.toFixed(1)}% fewer patches than fast-json-patch`
        );
      }
      console.log(`• ${timeRatio.toFixed(2)}x time ratio vs fast-json-patch`);
    }
  }
} 