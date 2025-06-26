import { describe, it, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { createPatcher } from "../src";
import schema from "./schema.json";
import originalDoc from "./test.json";

describe("Performance Tracker", () => {
  it("should generate a performance report", async () => {
    const patcher = createPatcher(schema as any as JSONSchema, { verbose: true });

    const doc1 = JSON.stringify(originalDoc);

    const modifiedDoc = JSON.parse(doc1);
    modifiedDoc.environments[0].name = "NLB-renamed";
    modifiedDoc.environments[0].services[0].cpu = 2;
    const doc2 = JSON.stringify(modifiedDoc, null, 2);

    const patch = patcher.diff(doc1, doc2);

    expect(patch.operations.length).toBeGreaterThan(0);

    const reportPath = path.join(__dirname, "test-output", "performance-report.json");
    await patcher.savePerformanceReport(reportPath);

    const reportExists = fs.existsSync(reportPath);
    expect(reportExists).toBe(true);

    const cached = patcher.diff(doc1, doc2);
    expect(cached.operations.length).toBeGreaterThan(0);

    const cachedReportPath = path.join(__dirname, "test-output", "cached-performance-report.json");
    await patcher.savePerformanceReport(cachedReportPath);

    const cachedReportExists = fs.existsSync(cachedReportPath);
    expect(cachedReportExists).toBe(true);
  });
}); 