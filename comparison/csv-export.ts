import { writeFile } from "fs/promises";
import { BenchmarkMetrics, FormattedDiffMetrics } from "./types";

// CSV Export Functions
export function exportFormattedDiffMetricsToCSV(
  metrics: FormattedDiffMetrics[],
  filename: string
): Promise<void> {
  const headers = [
    "library",
    "executionTime",
    "memoryUsage",
    "outputSize",
    "compressionRatio",
    "complexityScore",
    "operationType",
    "documentSize",
    "iteration",
    "timestamp",
    "complexityRange",
    "throughput",
    "memoryKB",
    "outputSizeKB",
  ];

  const csvRows = [headers.join(",")];

  metrics.forEach((metric) => {
    // Determine complexity range
    let complexityRange = "Unknown";
    if (metric.complexityScore >= 0 && metric.complexityScore <= 50)
      complexityRange = "Low";
    else if (metric.complexityScore >= 51 && metric.complexityScore <= 200)
      complexityRange = "Medium";
    else if (metric.complexityScore >= 201 && metric.complexityScore <= 500)
      complexityRange = "High";
    else if (metric.complexityScore >= 501) complexityRange = "Very High";

    // Calculate additional metrics
    const throughput =
      metric.executionTime > 0 ? 1000 / metric.executionTime : 0;
    const memoryKB = metric.memoryUsage / 1024;
    const outputSizeKB = metric.outputSize / 1024;

    const row = [
      `"${metric.library}"`,
      metric.executionTime,
      metric.memoryUsage,
      metric.outputSize,
      metric.compressionRatio,
      metric.complexityScore,
      `"${metric.operationType.replace(/"/g, '""')}"`,
      metric.documentSize,
      metric.iteration,
      new Date().toISOString(),
      `"${complexityRange}"`,
      throughput.toFixed(2),
      memoryKB.toFixed(2),
      outputSizeKB.toFixed(2),
    ];

    csvRows.push(row.join(","));
  });

  return writeFile(filename, csvRows.join("\n"));
}

export function exportMetricsToCSV(
  metrics: BenchmarkMetrics[],
  filename: string
): Promise<void> {
  const headers = [
    "library",
    "patchCount",
    "patchSize",
    "executionTime",
    "memoryUsage",
    "accuracy",
    "compressionRatio",
    "complexityScore",
    "operationType",
    "documentSize",
    "semanticAccuracy",
    "iteration",
    "timestamp",
    "complexityRange",
    "throughput",
    "memoryKB",
    "patchEfficiency",
  ];

  const csvRows = [headers.join(",")];

  metrics.forEach((metric) => {
    // Determine complexity range
    let complexityRange = "Unknown";
    if (metric.complexityScore >= 0 && metric.complexityScore <= 50)
      complexityRange = "Low";
    else if (metric.complexityScore >= 51 && metric.complexityScore <= 200)
      complexityRange = "Medium";
    else if (metric.complexityScore >= 201 && metric.complexityScore <= 500)
      complexityRange = "High";
    else if (metric.complexityScore >= 501) complexityRange = "Very High";

    // Calculate additional metrics
    const throughput =
      metric.executionTime > 0 ? 1000 / metric.executionTime : 0;
    const memoryKB = metric.memoryUsage / 1024;
    const patchEfficiency =
      metric.documentSize > 0
        ? (metric.patchCount / metric.documentSize) * 1000
        : 0;

    const row = [
      `"${metric.library}"`,
      metric.patchCount,
      metric.patchSize,
      metric.executionTime,
      metric.memoryUsage,
      metric.accuracy,
      metric.compressionRatio,
      metric.complexityScore,
      `"${metric.operationType.replace(/"/g, '""')}"`, // Escape quotes in operation type
      metric.documentSize,
      metric.semanticAccuracy,
      metric.iteration,
      new Date().toISOString(),
      `"${complexityRange}"`,
      throughput.toFixed(2),
      memoryKB.toFixed(2),
      patchEfficiency.toFixed(4),
    ];

    csvRows.push(row.join(","));
  });

  return writeFile(filename, csvRows.join("\n"));
} 