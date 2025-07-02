import fs from 'fs';

interface PerformanceMeasurement {
  name: string;
  duration: number;
  path?: string;
  context?: Record<string, any>;
}

class PerformanceTracker {
  private measurements: PerformanceMeasurement[] = [];
  private static instance: PerformanceTracker;

  public static getInstance(): PerformanceTracker {
    if (!PerformanceTracker.instance) {
      PerformanceTracker.instance = new PerformanceTracker();
    }
    return PerformanceTracker.instance;
  }

  public measure<T>(
    name: string,
    fn: () => T,
    path?: string,
    context?: Record<string, any>
  ): T {
    const start = performance.now();
    const result = fn();
    const end = performance.now();
    this.measurements.push({
      name,
      duration: end - start,
      path,
      context,
    });
    return result;
  }

  public getMeasurements(): PerformanceMeasurement[] {
    return this.measurements;
  }
  
  public clearMeasurements(): void {
    this.measurements = [];
  }

  public exportToCsv(filename: string = "performance-run.csv"): void {
    if (this.measurements.length === 0) {
        console.log("No performance measurements to export.");
        return;
    }
    const headers = [...new Set(this.measurements.flatMap(m => Object.keys(m)))];
    const csvRows = [headers.join(",")];

    for (const measurement of this.measurements) {
        const values = headers.map(header => {
            const value = (measurement as any)[header];
            if (value === undefined) {
                return "";
            }
            if (typeof value === 'object' && value !== null) {
                return `"${JSON.stringify(value).replace(/"/g, '""')}"`;
            }
            return value;
        });
        csvRows.push(values.join(","));
    }
    
    fs.writeFileSync(filename, csvRows.join('\n'));
  }
}

export const performanceTracker = PerformanceTracker.getInstance(); 