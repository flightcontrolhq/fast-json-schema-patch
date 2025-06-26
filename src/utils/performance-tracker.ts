import { performance } from "perf_hooks";
import * as fs from "fs";
import * as path from "path";

export type PerformanceEntry = {
  duration: number;
  startTime: number;
  endTime: number;
};

export class PerformanceTracker {
  private entries: Map<string, PerformanceEntry[]> = new Map();
  private activeTimers: Map<string, number[]> = new Map();
  private context: Record<string, any> = {};

  start(label: string): void {
    if (!this.activeTimers.has(label)) {
      this.activeTimers.set(label, []);
    }
    this.activeTimers.get(label)!.push(performance.now());
  }

  end(label: string): void {
    const timerStack = this.activeTimers.get(label);
    if (!timerStack || timerStack.length === 0) {
      console.warn(
        `Timer for "${label}" was not started or was already stopped.`
      );
      return;
    }
    const startTime = timerStack.pop();
    if (startTime === undefined) {
      return;
    }
    const endTime = performance.now();
    const duration = endTime - startTime;

    if (!this.entries.has(label)) {
      this.entries.set(label, []);
    }
    this.entries.get(label)!.push({
      startTime,
      endTime,
      duration,
    });
  }

  addContext(key: string, value: any): void {
    this.context[key] = value;
  }

  getReport(): {
    summary: Record<string, { avg: number; total: number; count: number }>;
    entries: Record<string, PerformanceEntry[]>;
    context: Record<string, any>;
  } {
    const summary = this.getSummary();
    const entries = Object.fromEntries(this.entries.entries());
    return {
      summary,
      entries,
      context: this.context,
    };
  }

  async saveReportToFile(filePath: string): Promise<void> {
    const report = this.getReport();
    const dir = path.dirname(filePath);
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(filePath, JSON.stringify(report, null, 2));
      console.log(`📊 Performance report saved to ${filePath}`);
    } catch (error) {
      console.error(`Error saving performance report: ${error}`);
    }
  }

  getSummary(): Record<
    string,
    { avg: number; total: number; count: number }
  > {
    const summary: Record<string, { avg: number; total: number; count: number }> =
      {};
    for (const [label, entries] of this.entries.entries()) {
      const count = entries.length;
      const total = entries.reduce((acc, entry) => acc + entry.duration, 0);
      const avg = total / count;
      summary[label] = { avg, total, count };
    }
    return summary;
  }

  logSummary(title = "📊 Performance Summary:"): void {
    const summary = this.getSummary();
    if (Object.keys(summary).length === 0) {
      return;
    }
    console.log(title);
    const tableData = Object.entries(summary).map(([label, data]) => ({
      Operation: label,
      "Avg Time (ms)": data.avg.toFixed(3),
      "Total Time (ms)": data.total.toFixed(3),
      Count: data.count,
    }));
    console.table(tableData);
  }

  clear(): void {
    this.entries.clear();
    this.activeTimers.clear();
    this.context = {};
  }
} 