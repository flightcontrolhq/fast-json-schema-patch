import { join } from "path";
import { faker } from "@faker-js/faker";
import chalk from "chalk";
import Chartscii from "chartscii";
import * as cliProgress from "cli-progress";
import * as fastJsonPatch from "fast-json-patch";
import { writeFile, mkdir } from "fs/promises";
import * as jsondiffpatch from "jsondiffpatch";
import { performance } from "perf_hooks";
import { Differ } from "json-diff-kit";
import { SchemaPatcher, buildPlan, deepEqual } from "../src/index";
import { PatchAggregator } from "../src/formatting/PatchAggregator";
import mainSchema from "../test/schema.json";
import { isDeepStrictEqual } from "node:util";
import rfc6902 from "rfc6902";

// Enhanced Types and Interfaces
enum ModificationComplexity {
  SIMPLE = 1, // Single property changes
  MEDIUM = 5, // Service additions/removals, multi-property changes
  COMPLEX = 10, // Environment changes, dependency chains, batch operations
}

interface BenchmarkMetrics {
  library: string;
  patchCount: number;
  patchSize: number;
  executionTime: number;
  memoryUsage: number;
  accuracy: boolean;
  compressionRatio: number;
  complexityScore: number;
  operationType: string;
  documentSize: number;
  semanticAccuracy: number;
  iteration: number;
}

interface FormattedDiffMetrics {
  library: string;
  executionTime: number;
  memoryUsage: number;
  outputSize: number;
  compressionRatio: number;
  complexityScore: number;
  operationType: string;
  documentSize: number;
  iteration: number;
}

interface PerformanceStats {
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  stdDev: number;
}

interface SchemaAdvantageMetrics {
  typeAwareOptimizations: number;
  arrayOrderingConsistency: number;
  schemaConstraintValidation: number;
  semanticUnderstanding: number;
  compressionEfficiency: number;
}

interface ModificationDescriptor {
  name: string;
  complexity: ModificationComplexity;
  operationType: string;
  cost: number;
  modify: (doc: any) => void;
}

// Utility Functions
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (
    Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i]
  );
}

function groupBy<T>(array: T[], key: keyof T): Record<string, T[]> {
  return array.reduce((groups, item) => {
    const value = String(item[key]);
    if (!groups[value]) {
      groups[value] = [];
    }
    groups[value].push(item);
    return groups;
  }, {} as Record<string, T[]>);
}

function calculatePerformanceStats(values: number[]): PerformanceStats {
  if (values.length === 0) {
    return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, mean: 0, stdDev: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const len = sorted.length;
  const mean = values.reduce((sum, val) => sum + val, 0) / len;

  return {
    p50: sorted[Math.floor(len * 0.5)] || 0,
    p95: sorted[Math.floor(len * 0.95)] || 0,
    p99: sorted[Math.floor(len * 0.99)] || 0,
    min: sorted[0] || 0,
    max: sorted[len - 1] || 0,
    mean,
    stdDev: Math.sqrt(
      values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / len
    ),
  };
}

function measureMemoryUsage<T>(fn: () => T): { result: T; memoryUsed: number } {
  const startMemory = process.memoryUsage().heapUsed;
  const result = fn();
  const endMemory = process.memoryUsage().heapUsed;
  return {
    result,
    memoryUsed: Math.max(0, endMemory - startMemory),
  };
}

// Enhanced Patch Counting
export function countJsonDiffPatches(diff: any): number {
  if (!diff || typeof diff !== "object") {
    return 0;
  }

  let patchCount = 0;

  function traverse(obj: any): void {
    if (!obj || typeof obj !== "object") {
      return;
    }

    for (const key in obj) {
      if (!obj.hasOwnProperty(key)) {
        continue;
      }

      const value = obj[key];

      // Skip array type markers
      if (key === "_t") {
        continue;
      }

      // Handle deletion operations (keys starting with '_')
      if (key.startsWith("_")) {
        // This is a deletion operation
        patchCount++;
        continue;
      }

      // Handle arrays that represent patch operations
      if (Array.isArray(value)) {
        if (value.length === 1) {
          // Addition: [newValue]
          patchCount++;
        } else if (value.length === 2) {
          // Replacement: [newValue, oldValue]
          patchCount++;
        } else if (value.length === 3 && value[1] === 0 && value[2] === 0) {
          // Deletion: [deletedValue, 0, 0] - but this is handled above with '_' prefix
          patchCount++;
        }
        continue;
      }

      // Recursively traverse nested objects
      if (typeof value === "object" && value !== null) {
        traverse(value);
      }
    }
  }

  traverse(diff);
  return patchCount;
}

async function isPatchValid(
  doc1: any,
  doc2: any,
  patch: any,
  library: string,
  modificationIndexs: string[]
): Promise<boolean> {
  try {
    const doc1Copy = JSON.parse(JSON.stringify(doc1));
    const patchCopy = JSON.parse(JSON.stringify(patch));

    rfc6902.applyPatch(
      doc1Copy,
      patchCopy,
    );

    const valid = isDeepStrictEqual(doc1Copy, doc2);

    if (!valid) {
      // console.error(
      //   `Patch from ${library} generated an invalid result for ${modificationIndexs.join(
      //     ", "
      //   )}. The diff is:`
      // );
      const delta = rfc6902.createPatch(doc1Copy, doc2);
      // console.error(JSON.stringify(delta, null, 2));

      const errorData = {
        library,
        modifications: modificationIndexs,
        originalDocument: doc1,
        expectedDocument: doc2,
        generatedPatch: patch,
        patchedDocument: doc1Copy,
        diff: delta,
      };

      const filename = `${library}-${Date.now()}.json`;
      const errorDir = join(__dirname, "errors");
      await mkdir(errorDir, { recursive: true });
      const errorFilePath = join(errorDir, filename);

      await writeFile(errorFilePath, JSON.stringify(errorData, null, 2));
      console.log(
        chalk.red(`[ERROR] Invalid patch data saved to ${errorFilePath}`)
      );
    }
    return valid;
  } catch (e) {
    // Errors are expected for invalid patches. We return false and don't log to keep the output clean.
    const errorData = {
      library,
      modifications: modificationIndexs,
      originalDocument: doc1,
      expectedDocument: doc2,
      generatedPatch: patch,
      error: e instanceof Error ? { message: e.message, stack: e.stack } : e,
    };

    const filename = `${library}-apply-error-${Date.now()}.json`;
    const errorDir = join(__dirname, "errors");
    await mkdir(errorDir, { recursive: true });
    const errorFilePath = join(errorDir, filename);

    await writeFile(errorFilePath, JSON.stringify(errorData, null, 2));
    console.log(
      chalk.red(
        `[ERROR] Patch application error data saved to ${errorFilePath}`
      )
    );
    return false;
  }
}

function createRandomWebService() {
  return {
    id: faker.string.uuid(),
    name: faker.internet.domainName(),
    type: "web",
    cpu: faker.number.float({ min: 0.25, max: 4 }),
    memory: faker.number.float({ min: 0.5, max: 8 }),
    minInstances: 1,
    maxInstances: faker.number.int({ min: 1, max: 5 }),
    healthCheckPath: `/${faker.lorem.word()}`,
    envVariables: {
      NODE_ENV: "production",
      DB_HOST: faker.internet.ip(),
    },
  };
}

function createRandomWorkerService() {
  return {
    id: faker.string.uuid(),
    name: `${faker.hacker.verb()}-worker`,
    type: "worker",
    cpu: faker.number.float({ min: 0.25, max: 2 }),
    memory: faker.number.float({ min: 0.5, max: 4 }),
    startCommand: `node start-${faker.lorem.word()}.js`,
  };
}

function createRandomDbService() {
  return {
    id: faker.string.uuid(),
    name: "database",
    type: "rds",
    engine: "postgres",
    engineVersion: "15",
    instanceSize: "db.t3.micro",
    storage: faker.number.int({ min: 20, max: 100 }),
  };
}

function generateUniqueServiceId(env: any): string {
  if (!env || !env.services) {
    // Fallback if environment not found, though this shouldn't happen in the test's flow
    return faker.lorem.slug();
  }
  const existingIds = new Set(env.services.map((s: any) => s.id));
  let newId = faker.lorem.slug();
  while (existingIds.has(newId)) {
    newId = faker.lorem.slug();
  }
  return newId;
}

function createRandomCloudConfig() {
  const config: any = {
    environments: [],
  };

  const numEnvs = 1;
  for (let i = 0; i < numEnvs; i++) {
    const services = [];
    const numServices = faker.number.int({ min: 2, max: 1000 });

    // Ensure at least one of each for variety
    services.push(createRandomWebService());
    services.push(createRandomWorkerService());
    services.push(createRandomDbService());

    for (let j = 3; j < numServices; j++) {
      const serviceType = faker.helpers.arrayElement(["web", "worker"]);
      if (serviceType === "web") {
        services.push(createRandomWebService());
      } else {
        services.push(createRandomWorkerService());
      }
    }

    config.environments.push({
      id: faker.lorem.slug(),
      name: `env-${i}`,
      region: faker.location.countryCode(),
      source: { branch: "main" },
      services: faker.helpers.shuffle(services),
    });
  }
  return config;
}

// Small Config - from existing test
const smallDoc1 = {
  environments: [
    {
      id: "env1",
      name: "production",
      region: "us-east-1",
      source: { branch: "main" },
      services: [
        { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
        { id: "service2", name: "worker", type: "worker", cpu: 0.5, memory: 1 },
      ],
    },
  ],
};

const smallDoc2 = {
  environments: [
    {
      id: "env1",
      name: "production",
      region: "us-east-1",
      source: { branch: "main" },
      services: [
        { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
        {
          id: "service3",
          name: "new-worker",
          type: "worker",
          cpu: 1,
          memory: 2,
        },
      ],
    },
  ],
};

// Large Config
const createLargeDoc = (numServices: number) => {
  const services = [];
  for (let i = 0; i < numServices; i++) {
    services.push({
      id: `service${i}`,
      name: `service-name-${i}`,
      type: "web",
      cpu: Math.random() * 4,
      memory: Math.random() * 8,
      dependsOn: [`service${i - 1}`],
    });
  }
  return {
    environments: [
      {
        id: "large-env",
        name: "stress-test",
        region: "us-west-2",
        source: { branch: "develop" },
        services,
      },
    ],
  };
};

const largeDoc1 = createLargeDoc(10);
const largeDoc2 = JSON.parse(JSON.stringify(largeDoc1)); // deep copy

// Make some changes to largeDoc2
largeDoc2.environments[0].services.splice(5, 1); // remove one
largeDoc2.environments[0].services[2].cpu = 100; // modify one
largeDoc2.environments[0].services.push({
  // add one
  id: "service-new",
  name: "new-service",
  type: "worker",
  cpu: 1,
  memory: 1,
});

// Real-world config
const realWorldDoc1 = require("../test/test.json");
const realWorldDoc2 = JSON.parse(JSON.stringify(realWorldDoc1));

// More complex, real-world changes to simulate user behavior

// 1. In env1, service1, move a port from the end to the beginning
const portToMove = realWorldDoc2.environments[0].services[0].ports.pop();
if (portToMove) {
  realWorldDoc2.environments[0].services[0].ports.unshift(portToMove);
}

// 2. In env1, service1, change a deeply nested health check path
const httpPort = realWorldDoc2.environments[0].services[0].ports.find(
  (p: any) => p.id === "http-8004"
);
if (httpPort) {
  httpPort.healthCheck.path = "/new-health";
}

// 3. In env1, add a new service that depends on an existing one
realWorldDoc2.environments[0].services.push({
  id: "new-worker-service",
  name: "New Worker Service",
  type: "worker",
  cpu: 1,
  memory: 2,
  dependsOn: ["nlb-server"],
});

// 4. In env2, service1, modify cpu/memory and remove a port
realWorldDoc2.environments[1].services[0].cpu = 4;
realWorldDoc2.environments[1].services[0].memory = 8;
realWorldDoc2.environments[1].services[0].ports.splice(1, 1); // remove udp-8002

// 5. Re-order services in the first environment
const serviceToMove = realWorldDoc2.environments[0].services.splice(1, 1)[0];
realWorldDoc2.environments[0].services.push(serviceToMove);

const diffpatcher = jsondiffpatch.create({
  objectHash: (obj: any) => {
    return obj.id || obj.postId || obj.name;
  },
});

const jsonDiffKitDiffer = new Differ({
  detectCircular: true,
  maxDepth: Infinity,
  showModifications: true,
  arrayDiffMethod: "lcs", // Use LCS for better array handling
});

// Enhanced Semantic Accuracy Functions
function calculateSemanticAccuracy(
  originalDoc: any,
  modifiedDoc: any,
  patch: any,
  library: string,
  schema: any
): number {
  let score = 100;

  try {
    const typeViolations = validateTypePreservation(patch, schema);
    score -= typeViolations * 5;

    const arrayEfficiency = calculateArrayHandlingEfficiency(patch);
    score -= (100 - arrayEfficiency) * 0.2;

    const semanticScore = calculatePatchSemantics(patch, library);
    score = (score + semanticScore) / 2;

    return Math.max(0, Math.min(100, score));
  } catch (error) {
    return 50;
  }
}

function validateTypePreservation(patch: any, schema: any): number {
  if (!Array.isArray(patch)) return 0;

  let violations = 0;
  for (const operation of patch) {
    if (
      operation.op === "replace" &&
      operation.path &&
      operation.value !== undefined
    ) {
      const pathParts = operation.path.split("/").filter(Boolean);
      if (pathParts.length > 0) {
        const oldType = typeof operation.oldValue;
        const newType = typeof operation.value;
        if (oldType !== "undefined" && oldType !== newType) {
          violations++;
        }
      }
    }
  }
  return violations;
}

function calculateArrayHandlingEfficiency(patch: any): number {
  if (!Array.isArray(patch)) return 100;

  let arrayOperations = 0;
  let efficientOperations = 0;

  for (const operation of patch) {
    if (operation.path && operation.path.includes("[")) {
      arrayOperations++;
      if (operation.op === "move") {
        efficientOperations++;
      } else if (operation.op === "add" || operation.op === "remove") {
        efficientOperations += 0.5;
      }
    }
  }

  return arrayOperations === 0
    ? 100
    : (efficientOperations / arrayOperations) * 100;
}

function calculatePatchSemantics(patch: any, library: string): number {
  if (!Array.isArray(patch)) return 50;

  let score = 100;
  const paths = new Set();
  let redundant = 0;

  for (const operation of patch) {
    if (operation.path) {
      if (paths.has(operation.path)) {
        redundant++;
      }
      paths.add(operation.path);
    }
  }

  if (patch.length > 0) {
    score -= (redundant / patch.length) * 30;
  }

  return Math.max(0, score);
}

// Visualization Functions
function generatePerformanceCharts(metrics: BenchmarkMetrics[]) {
  console.log("\n📊 PERFORMANCE ANALYSIS");
  console.log("=".repeat(80));

  const libraryGroups = groupBy(metrics, "library");
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
  console.log("\n📏 Average Patch Count by Library:");
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
  });

  const patchChart = new Chartscii(patchData, {
    width: 60,
    height: 8,
    theme: "pastel",
    colorLabels: true,
    valueLabels: true,
    title: "Average Patches Generated",
    orientation: "horizontal",
    sort: true,
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

  const byLibraryDebug = groupBy(metrics, "library");
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

  const libraries = ["schema-json-patch", "fast-json-patch", "jsondiffpatch"];
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
  console.log("🟢 Schema = schema-json-patch");
  console.log("🟡 FastJSON = fast-json-patch");
  console.log("🟠 JSONDiff = jsondiffpatch");
  console.log("-".repeat(80));

  // 5. Compression Efficiency Chart
  console.log("\n💾 Patch Size Efficiency:");
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
  });

  const compressionChart = new Chartscii(compressionData, {
    width: 60,
    height: 8,
    theme: "standard",
    colorLabels: true,
    valueLabels: true,
    valueLabelsPrefix: "",
    title: "Compression Ratio (% of document size)",
    orientation: "horizontal",
    sort: true,
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
      "P95 Time (ms)": stats.p95.toFixed(2),
      "Accuracy (%)": accuracy.toFixed(1),
      "Avg Patches": avgPatchCount.toFixed(1),
      "Avg Size (bytes)": avgPatchSize.toFixed(0),
      "Memory (KB)": (avgMemory / 1024).toFixed(1),
    };
  });

  console.table(summaryTable);
}

function generateFormattedDiffReport(formattedMetrics: FormattedDiffMetrics[]) {
  const byLibrary = groupBy(formattedMetrics, "library");

  console.log("\n🎨 FORMATTED DIFF COMPARISON REPORT");
  console.log("=".repeat(80));

  console.log("\n📋 SchemaPatch + PatchAggregator vs json-diff-kit:");
  console.log(
    "  This compares formatted, human-readable diff generation capabilities"
  );

  const schemaMetrics = byLibrary["schema-aggregated"] || [];
  const jsonDiffKitMetrics = byLibrary["json-diff-kit"] || [];

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
        timeRatio > 1 ? "json-diff-kit" : "SchemaPatch"
      } is ${Math.abs(timeRatio - 1).toFixed(2)}x faster`
    );
    console.log(
      `  • Output size: ${
        sizeRatio > 1 ? "json-diff-kit" : "SchemaPatch"
      } produces ${Math.abs(sizeRatio - 1).toFixed(2)}x smaller output`
    );
    console.log(
      `  • Memory usage: ${
        memoryRatio > 1 ? "json-diff-kit" : "SchemaPatch"
      } uses ${Math.abs(memoryRatio - 1).toFixed(2)}x less memory`
    );
  }
}

function generateComprehensiveReport(allMetrics: BenchmarkMetrics[]) {
  const byLibrary = groupBy(allMetrics, "library");

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

  console.log("\n🏆 Schema-Based Advantages Analysis:");
  const newSchemaMetrics = byLibrary["schema-json-patch"] || [];
  const fastJsonMetrics = byLibrary["fast-json-patch"] || [];

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
      `• schema-json-patch (new) generates ${avgSchemaPatches.toFixed(
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

async function compare() {
  console.log("🚀 Starting Enhanced JSON Patch Benchmark...\n");

  const scenarios = {
    small: { doc1: smallDoc1, doc2: smallDoc2, schema: mainSchema },
    large: { doc1: largeDoc1, doc2: largeDoc2, schema: mainSchema },
    "real-world": {
      doc1: realWorldDoc1,
      doc2: realWorldDoc2,
      schema: mainSchema,
    },
  };

  console.log("📊 Running static scenarios...");
  for (const [name, { doc1, doc2, schema: scenarioSchema }] of Object.entries(
    scenarios
  )) {
    console.log(`\n📋 Analyzing ${name} configuration...`);

    const plan = buildPlan(scenarioSchema as any);
    const newPatcher = new SchemaPatcher({ plan });

    const newSchemaPatch = newPatcher.createPatch(doc1, doc2);
    const fastPatch = fastJsonPatch.compare(doc1, doc2);
    const jsonDiffPatch = diffpatcher.diff(doc1, doc2);

    await writeFile(
      join(__dirname, `${name}-schema-patch.json`),
      JSON.stringify(newSchemaPatch, null, 2)
    );
    await writeFile(
      join(__dirname, `${name}-fast-json-patch.json`),
      JSON.stringify(fastPatch, null, 2)
    );
    await writeFile(
      join(__dirname, `${name}-jsondiffpatch-patch.json`),
      JSON.stringify(jsonDiffPatch, null, 2)
    );

    console.log(`  • schema-json-patch: ${newSchemaPatch.length} operations`);
    console.log(`  • fast-json-patch: ${fastPatch.length} operations`);
    console.log(
      `  • jsondiffpatch: ${countJsonDiffPatches(jsonDiffPatch)} operations`
    );
  }

  // Enhanced faker scenario with stratified sampling for balanced complexity distribution
  console.log(
    "\n🎲 Running comprehensive faker-based benchmark with stratified sampling..."
  );

  const plan = buildPlan(mainSchema as any);
  const newPatcher = new SchemaPatcher({ plan });

  // Define complexity ranges and target sample counts
  const complexityRanges = [
    { label: "Low", min: 0, max: 50, targetSamples: 25  },
    { label: "Medium", min: 51, max: 200, targetSamples: 25 },
    { label: "High", min: 201, max: 500, targetSamples: 25 },
    { label: "Very High", min: 501, max: 3000, targetSamples: 25 },
  ];

  const allMetrics: BenchmarkMetrics[] = [];
  const formattedDiffMetrics: FormattedDiffMetrics[] = [];
  const totalTargetSamples = complexityRanges.reduce(
    (sum, range) => sum + range.targetSamples,
    0
  );

  console.log(
    `Running stratified sampling for ${totalTargetSamples} balanced samples across complexity ranges...`
  );
  complexityRanges.forEach((range) => {
    console.log(
      `  • ${range.label} (${range.min}-${range.max}): ${range.targetSamples} samples`
    );
  });

  // Create progress bar
  const progressBar = new cliProgress.SingleBar({
    format:
      "  Progress |" +
      chalk.cyan("{bar}") +
      "| {percentage}% | {value}/{total} | ETA: {eta}s | Elapsed: {duration}s",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  });

  progressBar.start(totalTargetSamples, 0);

  // Generate samples for each complexity range
  for (const complexityRange of complexityRanges) {
    let samplesGenerated = 0;
    let attempts = 0;
    const maxAttempts = complexityRange.targetSamples * 10; // Prevent infinite loops

    while (
      samplesGenerated < complexityRange.targetSamples &&
      attempts < maxAttempts
    ) {
      attempts++;

      const doc1 = createRandomCloudConfig();
      const doc1Size = JSON.stringify(doc1).length;
      const doc2 = JSON.parse(JSON.stringify(doc1));

      // Generate complexity score within target range
      const targetComplexity = faker.number.int({
        min: complexityRange.min,
        max: complexityRange.max,
      });

      const { appliedModifications, actualComplexity } =
        applyModificationsForTargetComplexity(
          doc2,
          targetComplexity,
          complexityRange
        );

      // Only keep samples that fall within the target range
      if (
        actualComplexity >= complexityRange.min &&
        actualComplexity <= complexityRange.max
      ) {
        const libraries = [
          {
            name: "schema-json-patch",
            fn: () => newPatcher.createPatch(doc1, doc2),
          },
          {
            name: "fast-json-patch",
            fn: () => fastJsonPatch.compare(doc1, doc2),
          },
          { name: "jsondiffpatch", fn: () => diffpatcher.diff(doc1, doc2) },
        ];

        for (const library of libraries) {
          const startTime = performance.now();
          const memoryResult = measureMemoryUsage(() => library.fn() as any);
          const endTime = performance.now();

          const patch = memoryResult.result;
          const patchCount =
            library.name === "jsondiffpatch"
              ? countJsonDiffPatches(patch)
              : library.name === "schema-json-patch (new)"
              ? patch.operations.length
              : Array.isArray(patch)
              ? patch.length
              : 0;

          const patchSize = JSON.stringify(patch || {}).length;
          const executionTime = endTime - startTime;

          // Calculate accuracy
          const isValid =
            library.name === "jsondiffpatch"
              ? true // jsondiffpatch doesn't follow RFC 6902, so we skip validation
              : await isPatchValid(
                  doc1,
                  doc2,
                  patch,
                  library.name,
                  appliedModifications
                );

          // Calculate semantic accuracy
          const semanticAccuracy = calculateSemanticAccuracy(
            doc1,
            doc2,
            patch,
            library.name,
            mainSchema
          );

          const metrics: BenchmarkMetrics = {
            library: library.name,
            patchCount,
            patchSize,
            executionTime,
            memoryUsage: memoryResult.memoryUsed,
            accuracy: isValid,
            compressionRatio: doc1Size > 0 ? (patchSize / doc1Size) * 100 : 0,
            complexityScore: actualComplexity,
            operationType: appliedModifications.join(","),
            documentSize: doc1Size,
            semanticAccuracy,
            iteration: samplesGenerated,
          };

          allMetrics.push(metrics);
        }

        // Run formatted diff comparison for this sample
        const formattedDiffLibraries = [
          {
            name: "schema-aggregated",
            fn: () => {
              const freshPatcher = new SchemaPatcher({ plan });
              const aggregator = new PatchAggregator(doc1, doc2);
              const rawPatch = freshPatcher.createPatch(doc1, doc2);
              return aggregator.aggregate(rawPatch, {
                pathPrefix: "/environments/0/services",
                plan: plan,
              });
            },
          },
          {
            name: "json-diff-kit",
            fn: () => jsonDiffKitDiffer.diff(doc1, doc2),
          },
        ];

        for (const [index , library] of formattedDiffLibraries.entries()) {
          const startTime = performance.now();
          const memoryResult = measureMemoryUsage(() => library.fn() as any);
          const endTime = performance.now();

          const result = memoryResult.result;
          
          // Convert Map to plain object for proper serialization
          let serializableResult = result;
          if (library.name === "schema-aggregated" && result && result.childDiffs instanceof Map) {
            serializableResult = {
              parentDiff: result.parentDiff,
              childDiffs: Object.fromEntries(result.childDiffs)
            };
          }
          
          const outputSize = JSON.stringify(serializableResult || {}).length;
          const executionTime = endTime - startTime;

          const formattedMetrics: FormattedDiffMetrics = {
            library: library.name,
            executionTime,
            memoryUsage: memoryResult.memoryUsed,
            outputSize,
            compressionRatio: doc1Size > 0 ? (outputSize / doc1Size) * 100 : 0,
            complexityScore: actualComplexity,
            operationType: appliedModifications.join(","),
            documentSize: doc1Size,
            iteration: samplesGenerated,
          };

          formattedDiffMetrics.push(formattedMetrics);
          if (attempts === 1) {
            await writeFile(
              join(__dirname, "formatted-diff", `${library.name}-input.json`),
              JSON.stringify(doc1, null, 2)
            );
            await writeFile(
              join(__dirname, "formatted-diff", `${library.name}-output.json`),
              JSON.stringify(doc2, null, 2)
            );
            await writeFile(
              join(__dirname, "formatted-diff", `${library.name}-formatted-diff.json`),
              JSON.stringify(serializableResult, null, 2)
            );
          }
        }

        samplesGenerated++;
        progressBar.update(
          (allMetrics.length + formattedDiffMetrics.length) / 5
        ); // 3 patch libraries + 2 formatted diff libraries
      }
    }

    if (attempts >= maxAttempts) {
      console.warn(
        `\n⚠️  Warning: Could only generate ${samplesGenerated}/${complexityRange.targetSamples} samples for ${complexityRange.label} range after ${maxAttempts} attempts`
      );
    }
  }

  // Stop progress bar
  progressBar.stop();

  console.log(
    "\n✅ Stratified benchmark completed! Generating comprehensive report...\n"
  );

  // Generate comprehensive report
  generateComprehensiveReport(allMetrics);

  // Generate formatted diff report
  generateFormattedDiffReport(formattedDiffMetrics);

  // Export metrics to CSV
  const csvFilename = join(
    __dirname,
    `benchmark-results-${new Date().toISOString().split("T")[0]}.csv`
  );
  console.log("\n💾 Exporting detailed metrics to CSV...");
  await exportMetricsToCSV(allMetrics, csvFilename);
  console.log(`✅ Metrics exported to: ${csvFilename}`);

  // Export formatted diff metrics to CSV
  const formattedCsvFilename = join(
    __dirname,
    `formatted-diff-results-${new Date().toISOString().split("T")[0]}.csv`
  );
  console.log("\n💾 Exporting formatted diff metrics to CSV...");
  await exportFormattedDiffMetricsToCSV(
    formattedDiffMetrics,
    formattedCsvFilename
  );
  console.log(`✅ Formatted diff metrics exported to: ${formattedCsvFilename}`);

  console.log("\n📁 Sample patch files written to comparison/ directory");
  console.log("🎉 Comprehensive benchmark analysis complete!");
}

// Helper function to apply modifications targeting a specific complexity score
function applyModificationsForTargetComplexity(
  doc: any,
  targetComplexity: number,
  complexityRange: { label: string; min: number; max: number }
): { appliedModifications: string[]; actualComplexity: number } {
  const modifications = [
    // SIMPLE MODIFICATIONS (1-30) - Basic property changes
    {
      name: "Change environment name",
      complexity: 2, // Single property change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) env.name = faker.lorem.words(2);
      },
    },
    {
      name: "Change environment region",
      complexity: 2, // Single property change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env)
          env.region = faker.helpers.arrayElement([
            "us-east-1",
            "us-west-2",
            "eu-west-1",
            "ap-southeast-1",
          ]);
      },
    },
    {
      name: "Change environment ID",
      complexity: 3, // Single property change with potential cascading effects
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) env.id = faker.lorem.slug();
      },
    },
    {
      name: "Change source branch",
      complexity: 2, // Single nested property change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.source && !env.source.pr)
          env.source.branch = faker.helpers.arrayElement([
            "main",
            "develop",
            "staging",
          ]);
      },
    },
    {
      name: "Toggle source trigger",
      complexity: 2, // Single nested property change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.source)
          env.source.trigger = faker.helpers.arrayElement(["push", "manual"]);
      },
    },
    {
      name: "Change service ID",
      complexity: 4, // Service property change with high impact
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.id = faker.lorem.slug();
        }
      },
    },
    {
      name: "Change service name",
      complexity: 3, // Service property change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.name = faker.company.buzzPhrase();
        }
      },
    },
    {
      name: "Change service CPU",
      complexity: 3, // Resource allocation change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(
            env.services.filter((s: any) => s.cpu !== undefined)
          );
          if (service)
            service.cpu = faker.helpers.arrayElement([
              0.125, 0.25, 0.5, 1, 2, 4,
            ]);
        }
      },
    },
    {
      name: "Change service memory",
      complexity: 3, // Resource allocation change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) service.gpu = faker.number.int({ min: 0, max: 4 });
        }
      },
    },
    {
      name: "Toggle container insights",
      complexity: 2, // Simple boolean toggle
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) service.containerInsights = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Change storage size",
      complexity: 3, // Resource allocation change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.storage = faker.number.int({ min: 20, max: 200 });
        }
      },
    },
    {
      name: "Change min instances",
      complexity: 4, // Scaling configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.minInstances = faker.number.int({ min: 1, max: 3 });
        }
      },
    },
    {
      name: "Change max instances",
      complexity: 4, // Scaling configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.maxInstances = faker.number.int({ min: 1, max: 10 });
        }
      },
    },
    {
      name: "Change version history count",
      complexity: 2, // Simple configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.versionHistoryCount = faker.number.int({
              min: 1,
              max: 20,
            });
        }
      },
    },
    {
      name: "Change base path",
      complexity: 3, // Build configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.basePath = faker.helpers.arrayElement([
              ".",
              "./src",
              "./app",
            ]);
        }
      },
    },
    {
      name: "Change build type",
      complexity: 5, // Significant build configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.buildType = faker.helpers.arrayElement([
              "nodejs",
              "nixpacks",
              "docker",
            ]);
        }
      },
    },
    {
      name: "Change dockerfile path",
      complexity: 3, // Docker configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.dockerfilePath = faker.helpers.arrayElement([
              "Dockerfile",
              "Dockerfile.prod",
              "docker/Dockerfile",
            ]);
        }
      },
    },
    {
      name: "Change docker context",
      complexity: 3, // Docker configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.dockerContext = faker.helpers.arrayElement([
              ".",
              "./app",
              "./src",
            ]);
        }
      },
    },
    {
      name: "Toggle privileged mode",
      complexity: 4, // Security configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) service.privileged = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Change health check path",
      complexity: 3, // Health monitoring configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.healthCheckPath = faker.helpers.arrayElement([
              "/",
              "/health",
              "/status",
              "/ping",
            ]);
        }
      },
    },
    {
      name: "Change health check timeout",
      complexity: 3, // Health monitoring configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.healthCheckTimeoutSecs = faker.number.int({
              min: 2,
              max: 30,
            });
        }
      },
    },
    {
      name: "Change health check interval",
      complexity: 3, // Health monitoring configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.healthCheckTimeoutSecs = faker.number.int({
              min: 2,
              max: 30,
            });
        }
      },
    },
    {
      name: "Change health check interval",
      complexity: 3, // Health monitoring configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.healthCheckIntervalSecs = faker.number.int({
              min: 5,
              max: 60,
            });
        }
      },
    },
    {
      name: "Change port number",
      complexity: 4, // Network configuration change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.port = faker.number.int({ min: 3000, max: 8080 });
        }
      },
    },
    {
      name: "Toggle sticky sessions",
      complexity: 3, // Load balancer configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) service.stickySessionsEnabled = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Change sticky sessions duration",
      complexity: 3, // Load balancer configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.stickySessionsDurationSecs = faker.number.int({
              min: 3600,
              max: 86400,
            });
        }
      },
    },
    {
      name: "Toggle origin shield",
      complexity: 3, // CDN configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) service.originShieldEnabled = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Toggle CloudFront cache invalidation",
      complexity: 3, // CDN configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.cloudfrontAutoCacheInvalidation = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Add single environment variable",
      complexity: 5, // Object creation + property addition
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) {
            if (!service.envVariables) service.envVariables = {};
            const key = faker.hacker.noun().toUpperCase();
            service.envVariables[key] = faker.internet.url();
          }
        }
      },
    },
    {
      name: "Remove environment variable",
      complexity: 4, // Property deletion
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service && service.envVariables) {
            const keys = Object.keys(service.envVariables);
            if (keys.length > 0) {
              const keyToRemove = faker.helpers.arrayElement(keys);
              delete service.envVariables[keyToRemove];
            }
          }
        }
      },
    },

    // MEDIUM COMPLEXITY MODIFICATIONS (31-70) - Service-level changes
    {
      name: "Add new web service",
      complexity: 25, // Create complete service object with 10+ properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: faker.company.buzzPhrase(),
            type: "web",
            cpu: faker.helpers.arrayElement([0.25, 0.5, 1, 2]),
            memory: faker.helpers.arrayElement([0.5, 1, 2, 4]),
            buildType: "nixpacks",
            healthCheckPath: "/health",
            port: 3000,
            minInstances: 1,
            maxInstances: faker.number.int({ min: 1, max: 5 }),
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Add new worker service",
      complexity: 20, // Create service object with 7+ properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: `${faker.hacker.verb()} Worker`,
            type: "worker",
            cpu: faker.helpers.arrayElement([0.25, 0.5, 1, 2]),
            memory: faker.helpers.arrayElement([0.5, 1, 2, 4]),
            buildType: "nixpacks",
            startCommand: `node ${faker.lorem.word()}.js`,
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Add new RDS service",
      complexity: 22, // Create database service with 8+ properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const engine = faker.helpers.arrayElement(["postgres", "mysql"]);
          const newService = {
            id: generateUniqueServiceId(env),
            name: `${faker.lorem.word()}-database`,
            type: "rds",
            engine: engine,
            engineVersion: engine === "postgres" ? "15" : "8.0",
            instanceSize: "db.t3.micro",
            storage: faker.number.int({ min: 20, max: 100 }),
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Add new static service",
      complexity: 18, // Create static service with 6+ properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: `${faker.lorem.word()} Site`,
            type: "static",
            buildType: "nodejs",
            buildCommand: "npm run build",
            outputDirectory: "dist",
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Add elasticache service",
      complexity: 20, // Create cache service with 7+ properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: "redis-cache",
            type: "elasticache",
            engine: "redis",
            engineVersion: "7.0",
            instanceSize: "cache.t3.micro",
            numberOfReplicas: faker.number.int({ min: 1, max: 3 }),
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Remove a service",
      complexity: 15, // Array splice operation with potential cascading effects
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(
          doc.environments.filter((e: any) => e.services.length > 1)
        );
        if (env) {
          const indexToRemove = faker.number.int({
            min: 0,
            max: env.services.length - 1,
          });
          env.services.splice(indexToRemove, 1);
        }
      },
    },
    {
      name: "Reorder services",
      complexity: 12, // Array shuffle operation affecting multiple services
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 1) {
          env.services = faker.helpers.shuffle(env.services);
        }
      },
    },
    {
      name: "Add dependency between services",
      complexity: 8, // Add array property and push dependency
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length >= 2) {
          const [service1, service2]: any[] = faker.helpers.shuffle(
            env.services
          );
          if (!service1.dependsOn) service1.dependsOn = [];
          if (!service1.dependsOn.includes(service2.id)) {
            service1.dependsOn.push(service2.id);
          }
        }
      },
    },
    {
      name: "Remove dependencies",
      complexity: 6, // Delete property
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) delete service.dependsOn;
        }
      },
    },
    {
      name: "Add autoscaling configuration",
      complexity: 12, // Create object with 3 nested properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) {
            service.autoscaling = {
              cpuThreshold: faker.number.int({ min: 60, max: 80 }),
              memoryThreshold: faker.number.int({ min: 60, max: 80 }),
              cooldownTimerSecs: faker.number.int({ min: 300, max: 600 }),
            };
          }
        }
      },
    },
    {
      name: "Modify autoscaling thresholds",
      complexity: 7, // Modify 2 nested properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service && service.autoscaling) {
            service.autoscaling.cpuThreshold = faker.number.int({
              min: 50,
              max: 90,
            });
            service.autoscaling.memoryThreshold = faker.number.int({
              min: 50,
              max: 90,
            });
          }
        }
      },
    },
    {
      name: "Add CI configuration",
      complexity: 8, // Create nested object with type property
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.ci = {
            type: faker.helpers.arrayElement(["codebuild", "ec2"]),
          };
        }
      },
    },
    {
      name: "Add logging configuration",
      complexity: 10, // Create nested object with 2 properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.logging = {
            cloudwatchLogsEnabled: faker.datatype.boolean(),
            cloudwatchLogsRetentionDays: faker.helpers.arrayElement([
              7, 14, 30, 90,
            ]),
          };
        }
      },
    },
    {
      name: "Add docker labels",
      complexity: 11, // Create nested object with 3 properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.dockerLabels = {
            team: faker.hacker.noun(),
            version: faker.system.semver(),
            environment: env.name,
          };
        }
      },
    },
    {
      name: "Add watch paths",
      complexity: 6, // Create array with 1 element
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.watchPaths = [
            faker.helpers.arrayElement([
              "src/**",
              "app/**",
              "**/*.js",
              "**/*.ts",
            ]),
          ];
        }
      },
    },
    {
      name: "Add build commands",
      complexity: 8, // Add 2 properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) {
            service.buildCommand = faker.helpers.arrayElement([
              "npm run build",
              "yarn build",
              "pnpm build",
            ]);
            service.installCommand = faker.helpers.arrayElement([
              "npm install",
              "yarn install",
              "pnpm install",
            ]);
          }
        }
      },
    },
    {
      name: "Add start command",
      complexity: 4, // Add single property
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) {
            service.startCommand = faker.helpers.arrayElement([
              "npm start",
              "node server.js",
              "yarn start",
            ]);
          }
        }
      },
    },
    {
      name: "Add pre/post deploy commands",
      complexity: 8, // Add 2 properties
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) {
            service.preDeployCommand = 'echo "Pre-deploy"';
            service.postDeployCommand = 'echo "Post-deploy"';
          }
        }
      },
    },
    {
      name: "Change target type",
      complexity: 8, // Create nested object with type
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) {
            service.target = {
              type: faker.helpers.arrayElement(["fargate", "ecs-ec2"]),
            };
          }
        }
      },
    },
    {
      name: "Modify RDS settings",
      complexity: 11, // Modify 3 properties of specific service type
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const rdsService: any = env.services.find(
            (s: any) => s.type === "rds"
          );
          if (rdsService) {
            rdsService.autoUpgradeMinorVersions = faker.datatype.boolean();
            rdsService.deletionProtection = faker.datatype.boolean();
            rdsService.backupRetentionPeriodInDays = faker.number.int({
              min: 1,
              max: 35,
            });
          }
        }
      },
    },
    {
      name: "Add network server ports",
      complexity: 18, // Create complex port object with nested healthCheck and push to array
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = env.services.find(
            (s: any) => s.type === "network-server"
          );
          if (service && service.ports) {
            const newPort = {
              id: faker.lorem.slug(),
              port: faker.number.int({ min: 8000, max: 9000 }),
              protocol: faker.helpers.arrayElement(["tcp", "udp", "http"]),
              healthCheck: {
                type: "tcp",
                timeoutSecs: 5,
                intervalSecs: 30,
              },
            };
            service.ports.push(newPort);
          }
        }
      },
    },
    {
      name: "Modify port configuration",
      complexity: 12, // Modify 1 property + 2 nested properties conditionally
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = env.services.find(
            (s: any) => s.ports && s.ports.length > 0
          );
          if (service) {
            const port: any = faker.helpers.arrayElement(service.ports);
            port.port = faker.number.int({ min: 8000, max: 9000 });
            if (port.healthCheck) {
              port.healthCheck.timeoutSecs = faker.number.int({
                min: 2,
                max: 10,
              });
              port.healthCheck.intervalSecs = faker.number.int({
                min: 10,
                max: 60,
              });
            }
          }
        }
      },
    },
    {
      name: "Add scheduler jobs",
      complexity: 25, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const schedulerService: any = env.services.find(
            (s: any) => s.type === "scheduler"
          );
          if (schedulerService && schedulerService.jobs) {
            const jobName = faker.lorem.slug();
            schedulerService.jobs[jobName] = {
              startCommand: faker.helpers.arrayElement([
                "npm run job",
                "node job.js",
              ]),
              schedule: faker.helpers.arrayElement([
                "0 * * * *",
                "0 0 * * *",
                "manual",
              ]),
            };
          }
        }
      },
    },
    {
      name: "Add environment-level env variables",
      complexity: 60, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          if (!env.envVariables) env.envVariables = {};
          const key = `ENV_${faker.hacker.noun().toUpperCase()}`;
          env.envVariables[key] = faker.internet.url();
        }
      },
    },
    {
      name: "Add VPC configuration",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          env.vpc = {
            id: faker.string.alphanumeric(10),
            cidr: "10.0.0.0/16",
            private: faker.datatype.boolean(),
          };
        }
      },
    },
    {
      name: "Change service type from web to worker",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const webService: any = env.services.find(
            (s: any) => s.type === "web"
          );
          if (webService) {
            webService.type = "worker";
            delete webService.healthCheckPath;
            delete webService.port;
            delete webService.stickySessionsEnabled;
            webService.startCommand = "node worker.js";
          }
        }
      },
    },
    {
      name: "Modify container image source",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service && service.containerImage) {
            service.containerImage = {
              fromService: faker.helpers.arrayElement(
                env.services.map((s: any) => s.id)
              ),
            };
          }
        }
      },
    },
    {
      name: "Add lambda function service",
      complexity: 45, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: `${faker.lorem.word()}-function`,
            type: "lambda-function",
            buildType: "nixpacks",
            outputDirectory: "dist",
            lambda: {
              packageType: "zip",
              handler: "index.handler",
              runtime: "nodejs20.x",
              memory: faker.number.int({ min: 128, max: 1024 }),
              timeoutSecs: faker.number.int({ min: 3, max: 60 }),
            },
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Add S3 bucket service",
      complexity: 45, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: `${faker.lorem.word()}-bucket`,
            type: "s3",
            bucketNameBase: faker.lorem.slug(),
            bucketVersioning: faker.datatype.boolean(),
            blockAllPublicAccess: faker.datatype.boolean(),
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Add fromService environment variable",
      complexity: 20, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length >= 2) {
          const [service1, service2]: any[] = faker.helpers.shuffle(
            env.services
          );
          if (!service1.envVariables) service1.envVariables = {};
          const key = `${service2.name.toUpperCase()}_HOST`;
          service1.envVariables[key] = {
            fromService: {
              id: service2.id,
              value: faker.helpers.arrayElement([
                "host",
                "port",
                "connectionString",
              ]),
            },
          };
        }
      },
    },
    {
      name: "Change PR source configuration",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.source) {
          env.source = {
            pr: true,
            trigger: faker.helpers.arrayElement(["push", "manual"]),
            filter: {
              toBranches: ["main", "develop"],
              labels: [faker.lorem.word()],
            },
          };
        }
      },
    },
    {
      name: "Add experimental features",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.experimental = {
            runAsNonRootUser: faker.datatype.boolean(),
          };
        }
      },
    },
    {
      name: "Add permissions configuration",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.permissions = {
            inline: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["s3:GetObject"],
                  Resource: ["arn:aws:s3:::bucket/*"],
                },
              ],
            },
          };
        }
      },
    },
    {
      name: "Add sidecar containers",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(
            env.services.filter((s: any) => ["web", "worker"].includes(s.type))
          );
          if (service) {
            service.sidecars = [
              {
                cpuAllotment: 0.1,
                memoryAllotment: 0.2,
                name: "logging-sidecar",
                image: "fluent/fluent-bit:latest",
              },
            ];
          }
        }
      },
    },
    {
      name: "Modify storage type for RDS",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const rdsService: any = env.services.find(
            (s: any) => s.type === "rds"
          );
          if (rdsService) {
            rdsService.storageType = faker.helpers.arrayElement([
              "gp2",
              "gp3",
              "io1",
            ]);
            if (rdsService.storageType === "io1") {
              rdsService.storageProvisionedIops = faker.number.int({
                min: 1000,
                max: 3000,
              });
            }
          }
        }
      },
    },
    {
      name: "Toggle multi-AZ for RDS",
      complexity: 10, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const rdsService: any = env.services.find(
            (s: any) => s.type === "rds"
          );
          if (rdsService) {
            rdsService.multiAvailabilityZones = faker.datatype.boolean();
            rdsService.encryptionAtRest = faker.datatype.boolean();
          }
        }
      },
    },
    {
      name: "Add integrations",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.integrations = {
            uploadSentrySourceMap: faker.datatype.boolean(),
          };
        }
      },
    },
    {
      name: "Configure lambda function URL",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const lambdaService: any = env.services.find(
            (s: any) => s.type === "lambda-function"
          );
          if (lambdaService && lambdaService.lambda) {
            lambdaService.lambda.fnUrl = {
              enabled: true,
              authType: "None",
              cors: {
                allowMethods: ["GET", "POST"],
                allowOrigin: ["*"],
              },
            };
          }
        }
      },
    },
    {
      name: "Add health check grace period",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) {
            service.healthCheckGracePeriodSecs = faker.number.int({
              min: 0,
              max: 300,
            });
          }
        }
      },
    },
    {
      name: "Toggle inject env variables",
      complexity: 10, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service.injectEnvVariablesInDockerfile !== undefined) {
            service.injectEnvVariablesInDockerfile = faker.datatype.boolean();
          }
          if (service.includeEnvVariablesInBuild !== undefined) {
            service.includeEnvVariablesInBuild = faker.datatype.boolean();
          }
        }
      },
    },

    // COMPLEX MODIFICATIONS (71-100) - Multi-service and environment-level changes
    {
      name: "Create service dependency chain",
      complexity: 75, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length >= 3) {
          const services = faker.helpers.shuffle([...env.services]).slice(0, 3);

          // Clear existing dependencies
          services.forEach((service: any) => delete service.dependsOn);

          // Create chain: service1 -> service2 -> service3
          services[1].dependsOn = [services[0].id];
          services[2].dependsOn = [services[1].id];
        }
      },
    },
    {
      name: "Batch update service resources",
      complexity: 75, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const scalingFactor = faker.number.float({ min: 0.5, max: 2.0 });

          env.services.forEach((service: any) => {
            if (service.cpu)
              service.cpu = Math.max(0.125, service.cpu * scalingFactor);
            if (service.memory)
              service.memory = Math.max(0.125, service.memory * scalingFactor);
            if (service.maxInstances)
              service.maxInstances = Math.max(
                1,
                Math.floor(service.maxInstances * scalingFactor)
              );
          });
        }
      },
    },
    {
      name: "Add comprehensive logging setup",
      complexity: 65, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          env.services.forEach((service: any) => {
            service.logging = {
              cloudwatchLogsEnabled: true,
              cloudwatchLogsRetentionDays: faker.helpers.arrayElement([
                7, 14, 30, 90,
              ]),
              ecsLogsMetadataEnabled: true,
              firelens: {
                configSource: "inline",
                config: [
                  {
                    name: "forward",
                    match: "*",
                    options: {
                      Host: "logs.example.com",
                      Port: "443",
                    },
                  },
                ],
              },
            };
          });
        }
      },
    },
    {
      name: "Setup multi-service network configuration",
      complexity: 65, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length >= 2) {
          const networkServices = env.services.filter((s: any) =>
            ["web", "worker"].includes(s.type)
          );

          if (networkServices.length >= 2) {
            // Create a load balancer setup
            const mainService = networkServices[0];
            const backendServices = networkServices.slice(1);

            mainService.name = "Load Balancer";
            backendServices.forEach((service: any, index: number) => {
              service.name = `Backend ${index + 1}`;
              if (!service.dependsOn) service.dependsOn = [];
              service.dependsOn.push(mainService.id);
            });
          }
        }
      },
    },
    {
      name: "Configure cross-service environment variables",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length >= 2) {
          const services = env.services;
          const rdsService = services.find((s: any) => s.type === "rds");
          const webServices = services.filter((s: any) => s.type === "web");

          if (rdsService && webServices.length > 0) {
            webServices.forEach((service: any) => {
              if (!service.envVariables) service.envVariables = {};
              service.envVariables.DATABASE_URL = {
                fromService: {
                  id: rdsService.id,
                  value: "connectionString",
                },
              };
            });
          }
        }
      },
    },
    {
      name: "Add comprehensive autoscaling",
      complexity: 65, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const scalableServices = env.services.filter((s: any) =>
            ["web", "worker"].includes(s.type)
          );

          scalableServices.forEach((service: any) => {
            service.autoscaling = {
              cpuThreshold: faker.number.int({ min: 70, max: 80 }),
              memoryThreshold: faker.number.int({ min: 75, max: 85 }),
              cooldownTimerSecs: faker.number.int({ min: 300, max: 600 }),
            };

            if (service.type === "web") {
              service.autoscaling.requestsPerTarget = faker.number.int({
                min: 100,
                max: 1000,
              });
            }
          });
        }
      },
    },
    {
      name: "Setup scheduler with multiple jobs",
      complexity: 45, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const schedulerService = {
            id: generateUniqueServiceId(env),
            name: "Task Scheduler",
            type: "scheduler",
            cpu: 0.25,
            memory: 0.5,
            buildType: "nixpacks",
            jobs: {
              "daily-backup": {
                startCommand: "npm run backup",
                schedule: "0 2 * * *", // Daily at 2 AM
              },
              "hourly-cleanup": {
                startCommand: "npm run cleanup",
                schedule: "0 * * * *", // Every hour
              },
              "weekly-report": {
                startCommand: "npm run report",
                schedule: "0 0 * * 0", // Weekly on Sunday
              },
            },
          };
          env.services.push(schedulerService);
        }
      },
    },
    {
      name: "Configure comprehensive permissions",
      complexity: 65, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const s3Service = env.services.find((s: any) => s.type === "s3");
          const otherServices = env.services.filter((s: any) =>
            ["web", "worker"].includes(s.type)
          );

          if (s3Service && otherServices.length > 0) {
            otherServices.forEach((service: any) => {
              service.permissions = {
                inline: {
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Action: ["s3:GetObject", "s3:PutObject"],
                      Resource: [`arn:aws:s3:::${s3Service.bucketNameBase}/*`],
                    },
                  ],
                },
              };
            });
          }
        }
      },
    },
    {
      name: "Add network-server service",
      complexity: 45, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: "Network Load Balancer",
            type: "network-server",
            cpu: 1,
            memory: 2,
            ports: [
              {
                id: "tcp-8000",
                port: 8000,
                protocol: "tcp",
                healthCheck: {
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
              },
            ],
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Modify elasticache settings",
      complexity: 15, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        const elasticacheService: any = env.services.find(
          (s: any) => s.type === "elasticache"
        );
        if (elasticacheService) {
          elasticacheService.evictionPolicy = faker.helpers.arrayElement([
            "volatile-lru",
            "allkeys-lru",
            "noeviction",
          ]);
          elasticacheService.port = faker.helpers.arrayElement([6379, 6380]);
          elasticacheService.encryptionAtRest = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Add lambda function with docker",
      complexity: 15, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: "Docker Lambda",
            type: "lambda-function",
            buildType: "docker",
            dockerfilePath: "Dockerfile.lambda",
            lambda: {
              packageType: "image",
              memory: faker.number.int({ min: 512, max: 2048 }),
              timeoutSecs: faker.number.int({ min: 30, max: 300 }),
            },
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Configure RDS connection string env var",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const rdsService: any = env.services.find(
            (s: any) => s.type === "rds"
          );
          if (rdsService) {
            rdsService.connectionStringEnvVarName = faker.helpers.arrayElement([
              "DATABASE_URL",
              "DB_CONNECTION_STRING",
              "RDS_URL",
            ]);
            rdsService.performanceInsights = faker.datatype.boolean();
          }
        }
      },
    },
    {
      name: "Add static site with SPA config",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: "React App",
            type: "static",
            buildType: "nodejs",
            buildCommand: "npm run build",
            outputDirectory: "build",
            singlePageApp: true,
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Configure target with ECS EC2",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const eligibleServices = env.services.filter((s: any) =>
            ["web", "worker"].includes(s.type)
          );
          if (eligibleServices.length > 0) {
            const service: any = faker.helpers.arrayElement(eligibleServices);
            service.target = {
              type: "ecs-ec2",
              clusterInstanceSize: faker.helpers.arrayElement([
                "t3.medium",
                "t3.large",
              ]),
              clusterMinInstances: faker.number.int({ min: 1, max: 3 }),
              clusterMaxInstances: faker.number.int({ min: 3, max: 10 }),
            };
          }
        }
      },
    },
    {
      name: "Add comprehensive CI config",
      complexity: 65, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.ci = {
            type: "ec2",
            instanceSize: "t3.medium",
            instanceStorage: faker.number.int({ min: 30, max: 100 }),
            storageType: "gp3",
          };
        }
      },
    },
    {
      name: "Add firelens logging config",
      complexity: 15, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.logging = {
            cloudwatchLogsEnabled: true,
            firelens: {
              configSource: "file",
              configFilePath: "./fluent-bit.conf",
            },
          };
        }
      },
    },
    {
      name: "Configure container registry",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const eligibleServices = env.services.filter(
            (s: any) => s.buildType === "fromRepository"
          );
          if (eligibleServices.length > 0) {
            const service: any = faker.helpers.arrayElement(eligibleServices);
            service.containerImage = {
              registryId: faker.string.alphanumeric(12),
              repository: faker.lorem.slug(),
              tag: faker.system.semver(),
            };
          }
        }
      },
    },
    {
      name: "Add S3 bucket policy",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const s3Service: any = env.services.find((s: any) => s.type === "s3");
          if (s3Service) {
            s3Service.bucketPolicy = {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: "*",
                  Action: "s3:GetObject",
                  Resource: `arn:aws:s3:::${s3Service.bucketNameBase}/*`,
                },
              ],
            };
          }
        }
      },
    },
    {
      name: "Add private web service",
      complexity: 45, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: "Internal API",
            type: "web-private",
            cpu: faker.helpers.arrayElement([0.5, 1, 2]),
            memory: faker.helpers.arrayElement([1, 2, 4]),
            buildType: "docker",
            port: 8080,
          };
          env.services.push(newService);
        }
      },
    },
    {
      name: "Configure datadog integration",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          service.experimental = {
            datadog: {
              enabled: true,
              datadogSite: "datadoghq.com",
              datadogApiKey: faker.string.alphanumeric(32),
              logging: faker.datatype.boolean(),
            },
          };
        }
      },
    },
    {
      name: "Add post build command",
      complexity: 15, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const eligibleServices = env.services.filter((s: any) =>
            ["web", "worker", "static"].includes(s.type)
          );
          if (eligibleServices.length > 0) {
            const service: any = faker.helpers.arrayElement(eligibleServices);
            service.postBuildCommand = faker.helpers.arrayElement([
              "npm run postbuild",
              'echo "Build complete"',
              "cp -r dist/ public/",
            ]);
          }
        }
      },
    },
    {
      name: "Configure Lambda VPC",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const lambdaService: any = env.services.find(
            (s: any) => s.type === "lambda-function"
          );
          if (lambdaService && lambdaService.lambda) {
            lambdaService.lambda.vpc = true;
            lambdaService.lambda.tracing = faker.datatype.boolean();
            lambdaService.lambda.reservedConcurrency = faker.number.int({
              min: 1,
              max: 100,
            });
          }
        }
      },
    },
    {
      name: "Add environment variables with different types",
      complexity: 25, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (!service.envVariables) service.envVariables = {};

          // String env var
          service.envVariables.STRING_VAR = faker.lorem.word();

          // Number env var
          service.envVariables.NUMBER_VAR = faker.number.int({
            min: 1,
            max: 100,
          });

          // Boolean env var
          service.envVariables.BOOLEAN_VAR = faker.datatype.boolean();

          // Parameter store env var
          service.envVariables.PARAM_VAR = {
            fromParameterStore: `/app/${faker.lorem.word()}`,
          };

          // Secrets manager env var
          service.envVariables.SECRET_VAR = {
            fromSecretsManager: `${faker.lorem.word()}-secret`,
          };
        }
      },
    },
    {
      name: "Configure port health checks for network server",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const networkService: any = env.services.find((s: any) =>
            ["network-server", "private-network-server"].includes(s.type)
          );
          if (
            networkService &&
            networkService.ports &&
            networkService.ports.length > 0
          ) {
            networkService.ports.forEach((port: any) => {
              if (port.healthCheck) {
                port.healthCheck.gracePeriodSecs = faker.number.int({
                  min: 0,
                  max: 300,
                });
                if (port.protocol === "http" || port.protocol === "http2") {
                  port.healthCheck.path = faker.helpers.arrayElement([
                    "/health",
                    "/status",
                    "/ping",
                  ]);
                }
              }
            });
          }
        }
      },
    },
    {
      name: "Add scheduler with job timeout and resource overrides",
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const schedulerService: any = env.services.find(
            (s: any) => s.type === "scheduler"
          );
          if (schedulerService && schedulerService.jobs) {
            const jobNames = Object.keys(schedulerService.jobs);
            if (jobNames.length > 0) {
              const jobName = faker.helpers.arrayElement(jobNames);
              schedulerService.jobs[jobName].timeout = faker.number.int({
                min: 60,
                max: 1440,
              });
              schedulerService.jobs[jobName].cpu = faker.number.float({
                min: 0.125,
                max: 2,
              });
              schedulerService.jobs[jobName].memory = faker.number.float({
                min: 0.25,
                max: 4,
              });
            }
          }
        }
      },
    },
    {
      name: "Configure RDS with advanced settings",
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const rdsService: any = env.services.find(
            (s: any) => s.type === "rds"
          );
          if (rdsService) {
            rdsService.private = faker.datatype.boolean();
            rdsService.maxStorage = faker.number.int({ min: 100, max: 1000 });
            rdsService.applyChangesImmediately = faker.datatype.boolean();
            rdsService.deleteBackupsWithRdsDeletion = faker.datatype.boolean();

            if (rdsService.port === undefined) {
              rdsService.port = rdsService.engine === "postgres" ? 5432 : 3306;
            }
          }
        }
      },
    },
    {
      name: "Add comprehensive service with all features",
      complexity: 65, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) {
          const newService = {
            id: generateUniqueServiceId(env),
            name: "Full Featured Service",
            type: "web",
            cpu: 2,
            memory: 4,
            gpu: 1,
            buildType: "docker",
            dockerfilePath: "Dockerfile",
            dockerContext: ".",
            privileged: false,
            healthCheckPath: "/health",
            healthCheckTimeoutSecs: 10,
            healthCheckIntervalSecs: 30,
            healthCheckGracePeriodSecs: 60,
            port: 3000,
            minInstances: 2,
            maxInstances: 10,
            stickySessionsEnabled: true,
            stickySessionsDurationSecs: 3600,
            originShieldEnabled: true,
            cloudfrontAutoCacheInvalidation: true,
            containerInsights: true,
            storage: 50,
            versionHistoryCount: 15,
            basePath: ".",
            includeEnvVariablesInBuild: true,
            injectEnvVariablesInDockerfile: true,
            autoscaling: {
              cpuThreshold: 75,
              memoryThreshold: 80,
              requestsPerTarget: 500,
              cooldownTimerSecs: 300,
            },
            envVariables: {
              NODE_ENV: "production",
              LOG_LEVEL: "info",
            },
            logging: {
              cloudwatchLogsEnabled: true,
              cloudwatchLogsRetentionDays: 30,
              ecsLogsMetadataEnabled: true,
            },
            integrations: {
              uploadSentrySourceMap: true,
            },
          };
          env.services.push(newService);
        }
      },
    },
  ];

  // Apply intelligent modification selection based on target complexity
  const selectedModifications = selectModificationsForComplexity(
    modifications,
    targetComplexity,
    complexityRange
  );
  let totalComplexity = 0;
  const appliedModifications: string[] = [];

  for (const modification of selectedModifications) {
    modification.modify(doc);
    totalComplexity += modification.complexity || 1;
    appliedModifications.push(modification.name);
  }

  return { appliedModifications, actualComplexity: totalComplexity };
}

// Intelligent modification selection to hit target complexity ranges
function selectModificationsForComplexity(
  modifications: any[],
  targetComplexity: number,
  complexityRange: { label: string; min: number; max: number }
): any[] {
  // Sort modifications by complexity for better selection
  const sortedMods = [...modifications].sort(
    (a, b) => a.complexity - b.complexity
  );

  // Categorize modifications
  const lowComplexity = sortedMods.filter((m) => m.complexity <= 10);
  const mediumComplexity = sortedMods.filter(
    (m) => m.complexity > 10 && m.complexity <= 35
  );
  const highComplexity = sortedMods.filter((m) => m.complexity > 35);

  const selectedMods: any[] = [];
  let currentComplexity = 0;

  if (complexityRange.label === "Low") {
    // For low complexity, use 2-8 simple modifications
    const numMods = faker.number.int({ min: 2, max: 8 });
    for (let i = 0; i < numMods && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  } else if (complexityRange.label === "Medium") {
    // Mix of low and medium complexity modifications
    const numMedium = faker.number.int({ min: 1, max: 3 });
    const numLow = faker.number.int({ min: 3, max: 8 });

    for (
      let i = 0;
      i < numMedium && currentComplexity < targetComplexity - 20;
      i++
    ) {
      const mod = faker.helpers.arrayElement(mediumComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (let i = 0; i < numLow && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  } else if (complexityRange.label === "High") {
    // Mix with some high complexity modifications
    const numHigh = faker.number.int({ min: 1, max: 2 });
    const numMedium = faker.number.int({ min: 2, max: 4 });
    const numLow = faker.number.int({ min: 3, max: 6 });

    for (
      let i = 0;
      i < numHigh && currentComplexity < targetComplexity - 100;
      i++
    ) {
      const mod = faker.helpers.arrayElement(highComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (
      let i = 0;
      i < numMedium && currentComplexity < targetComplexity - 50;
      i++
    ) {
      const mod = faker.helpers.arrayElement(mediumComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (let i = 0; i < numLow && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  } else {
    // Very High
    // Many high complexity modifications
    const numHigh = faker.number.int({ min: 3, max: 8 });
    const numMedium = faker.number.int({ min: 5, max: 10 });
    const numLow = faker.number.int({ min: 5, max: 15 });

    for (
      let i = 0;
      i < numHigh && currentComplexity < targetComplexity - 200;
      i++
    ) {
      const mod = faker.helpers.arrayElement(highComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (
      let i = 0;
      i < numMedium && currentComplexity < targetComplexity - 100;
      i++
    ) {
      const mod = faker.helpers.arrayElement(mediumComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }

    for (let i = 0; i < numLow && currentComplexity < targetComplexity; i++) {
      const mod = faker.helpers.arrayElement(lowComplexity);
      selectedMods.push(mod);
      currentComplexity += mod.complexity;
    }
  }

  return selectedMods;
}

// CSV Export Functions
function exportFormattedDiffMetricsToCSV(
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

function exportMetricsToCSV(
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

compare().catch(console.error);
