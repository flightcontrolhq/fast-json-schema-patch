import { performance } from "perf_hooks";
import type { PerformanceStats } from "./types";

// Utility Functions
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (
    Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  );
}

export function groupBy(arr: any[], key: string) {
  return arr.reduce((acc, item) => {
    const group = item[key];
    if (!acc[group]) {
      acc[group] = [];
    }
    acc[group].push(item);
    return acc;
  }, {});
}

export function calculatePerformanceStats(data: number[]) {
  if (data.length === 0) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      stdDev: 0,
    };
  }
  const sorted = [...data].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / sorted.length;
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.floor(sorted.length * 0.95)];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const stdDev = Math.sqrt(
    sorted.map((x) => Math.pow(x - mean, 2)).reduce((a, b) => a + b, 0) /
      sorted.length
  );

  return { min, max, mean, p50, p95, p99, stdDev };
}

export async function measureExecutionTime<T>(
  fn: () => T
): Promise<{ result: T; duration: number }> {
  const startTime = performance.now();
  const result = await Promise.resolve(fn());
  const endTime = performance.now();
  return { result, duration: endTime - startTime };
}

export async function measureMemoryUsage<T>(
  fn: () => T
): Promise<{ result: T; duration: number; memoryUsage: number }> {
  global.gc?.();
  const startMemory = process.memoryUsage().heapUsed;
  const startTime = performance.now();

  const result = await Promise.resolve(fn());

  const endTime = performance.now();
  const endMemory = process.memoryUsage().heapUsed;

  const duration = endTime - startTime;
  const memoryUsage = Math.max(0, endMemory - startMemory);

  return { result, duration, memoryUsage };
}

export function deepSortArrays(obj: any): any {
  if (Array.isArray(obj)) {
    // First, recursively sort items within the array
    const sortedItems = obj.map(deepSortArrays);

    // Then, sort the array itself using a stable, deterministic method.
    // Stringifying is a simple way to achieve this for complex objects.
    return sortedItems.sort((a, b) => {
      const aStr = JSON.stringify(a);
      const bStr = JSON.stringify(b);
      if (aStr < bStr) return -1;
      if (aStr > bStr) return 1;
      return 0;
    });
  }
  if (typeof obj === "object" && obj !== null) {
    // Also sort keys for a canonical object representation
    const newObj: { [key: string]: any } = {};
    for (const key of Object.keys(obj).sort()) {
      newObj[key] = deepSortArrays((obj as any)[key]);
    }
    return newObj;
  }
  return obj;
} 