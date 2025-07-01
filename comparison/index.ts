import { join } from "path";
import { faker } from "@faker-js/faker";
import chalk from "chalk";
import * as cliProgress from "cli-progress";
import * as fastJsonPatch from "fast-json-patch";
import { writeFile } from "fs/promises";
import * as jsondiffpatch from "jsondiffpatch";
import { performance } from "perf_hooks";
import { Differ } from "json-diff-kit";
import { SchemaJsonPatcher, buildPlan } from "../src/index";
import { PatchAggregator } from "../src/formatting/PatchAggregator";
import mainSchema from "../schema/schema.json";
import ecommerceSchema from "../schema/e-commerce.json";

import type { BenchmarkMetrics, FormattedDiffMetrics } from "./types";
import {
  calculatePerformanceStats,
  formatBytes,
  groupBy,
  measureMemoryUsage,
} from "./utils";
import { countJsonDiffPatches, isPatchValid, calculateSemanticAccuracy } from "./patch-utils";
import { 
  smallDoc1, 
  smallDoc2, 
  largeDoc1, 
  largeDoc2, 
  realWorldDoc1, 
  realWorldDoc2, 
  createRandomCloudConfig 
} from "./data-generators";
import { applyModificationsForTargetComplexity } from "./modification-functions";
import { 
  generateRandomECommerceConfig,
  applyECommerceModificationsForTargetComplexity 
} from "./ecommerceModifications";
import { generateComprehensiveReport, generateFormattedDiffReport } from "./visualization";
import { exportMetricsToCSV, exportFormattedDiffMetricsToCSV } from "./csv-export";

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

async function compare() {
  console.log("🚀 Starting Enhanced JSON Patch Benchmark...\n");

  // Generate e-commerce test data
  const ecommerceDoc1 = generateRandomECommerceConfig({complexity: "Medium"});
  const ecommerceDoc2 = JSON.parse(JSON.stringify(ecommerceDoc1));
  const { appliedModifications: ecommerceModifications } = applyECommerceModificationsForTargetComplexity(
    ecommerceDoc2,
    150, // Target complexity for e-commerce scenario
    { label: "Medium", min: 51, max: 200 }
  );
  console.log(`📦 Generated e-commerce scenario with modifications: ${ecommerceModifications.slice(0, 3).join(", ")}${ecommerceModifications.length > 3 ? "..." : ""}`);

  const scenarios = {
    small: { doc1: smallDoc1, doc2: smallDoc2, schema: mainSchema },
    large: { doc1: largeDoc1, doc2: largeDoc2, schema: mainSchema },
    "real-world": {
      doc1: realWorldDoc1,
      doc2: realWorldDoc2,
      schema: mainSchema,
    },
    "e-commerce": {
      doc1: ecommerceDoc1,
      doc2: ecommerceDoc2,
      schema: ecommerceSchema,
    },
  };

  console.log("📊 Running static scenarios...");
  for (const [name, { doc1, doc2, schema: scenarioSchema }] of Object.entries(
    scenarios
  )) {
    console.log(`\n📋 Analyzing ${name} configuration...`);

    const plan = buildPlan(scenarioSchema as any);
    const newPatcher = new SchemaJsonPatcher({ plan });

    const newSchemaPatch = newPatcher.createPatch(doc1, doc2);
    const fastPatch = fastJsonPatch.compare(doc1, doc2);
    const jsonDiffPatch = diffpatcher.diff(doc1, doc2);

    await writeFile(
      join(__dirname, `./patches-generated/${name}-schema-patch.json`),
      JSON.stringify(newSchemaPatch, null, 2)
    );
    await writeFile(
      join(__dirname, `./patches-generated/${name}-fast-json-patch.json`),
      JSON.stringify(fastPatch, null, 2)
    );
    await writeFile(
      join(__dirname, `./patches-generated/${name}-jsondiffpatch-patch.json`),
      JSON.stringify(jsonDiffPatch, null, 2)
    );

    console.log(`  • schema-json-patch: ${newSchemaPatch.length} operations`);
    console.log(`  • fast-json-patch: ${fastPatch.length} operations`);
    console.log(
      `  • jsondiffpatch: ${countJsonDiffPatches(jsonDiffPatch)} operations`
    );
    
    // For e-commerce scenario, log the modifications applied
    if (name === "e-commerce") {
      console.log(`  • Applied modifications: ${ecommerceModifications.slice(0, 2).join(", ")}${ecommerceModifications.length > 2 ? "..." : ""}`);
    }
  }

  // Enhanced faker scenario with stratified sampling for balanced complexity distribution
  console.log(
    "\n🎲 Running comprehensive cloud-config faker-based benchmark with stratified sampling..."
  );

  const plan = buildPlan(mainSchema as any);
  const newPatcher = new SchemaJsonPatcher({ plan });

  // Define complexity ranges and target sample counts
  const complexityRanges = [
    { label: "Low", min: 0, max: 50, targetSamples: 2500 },
    { label: "Medium", min: 51, max: 200, targetSamples: 2500 },
    { label: "High", min: 201, max: 500, targetSamples: 2500 },
    { label: "Very High", min: 501, max: 3000, targetSamples: 2500 },
  ];

  const allMetrics: BenchmarkMetrics[] = [];
  const formattedDiffMetrics: FormattedDiffMetrics[] = [];

  const ecommerceMetrics: BenchmarkMetrics[] = [];
  const ecommerceFormattedMetrics: FormattedDiffMetrics[] = [];
  
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

      const doc1 = createRandomCloudConfig({complexity: complexityRange.label as "Low" | "Medium" | "High" | "Very High"});
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
          const { result: patch, duration, memoryUsage } = await measureMemoryUsage(() => library.fn() as any);
          const patchCount =
            library.name === "jsondiffpatch"
              ? countJsonDiffPatches(patch)
              : library.name === "schema-json-patch (new)"
              ? patch.operations.length
              : Array.isArray(patch)
              ? patch.length
              : 0;

          const patchSize = JSON.stringify(patch || {}).length;
          const executionTime = duration;

          // Calculate accuracy
          const isValid =
            library.name === "jsondiffpatch"
              ? true // jsondiffpatch doesn't follow RFC 6902, so we skip validation
              : isPatchValid(
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
            memoryUsage,
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
              const freshPatcher = new SchemaJsonPatcher({ plan });
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
          const { result: formattedDiff, duration, memoryUsage } = await measureMemoryUsage(() => library.fn() as any);
          
          const outputSize = JSON.stringify(formattedDiff || {}).length;
          const executionTime = duration;

          const formattedMetrics: FormattedDiffMetrics = {
            library: library.name,
            executionTime,
            memoryUsage,
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
              JSON.stringify(formattedDiff, null, 2)
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
    "\n✅ Cloud-config stratified benchmark completed!\n"
  );

  // E-commerce faker scenario with stratified sampling
  console.log(
    "\n🛒 Running comprehensive e-commerce faker-based benchmark with stratified sampling..."
  );

  const ecommercePlan = buildPlan(ecommerceSchema as any);
  const ecommercePatcher = new SchemaJsonPatcher({ plan: ecommercePlan });

  const ecommerceComplexityRanges = [
    { label: "Low", min: 0, max: 50, targetSamples: 2500 },
    { label: "Medium", min: 51, max: 200, targetSamples: 2500 },
    { label: "High", min: 201, max: 500, targetSamples: 2500 },
    { label: "Very High", min: 501, max: 3000, targetSamples: 2500 },
  ];

  const ecommerceTotalTargetSamples = ecommerceComplexityRanges.reduce(
    (sum, range) => sum + range.targetSamples,
    0
  );

  console.log(
    `Running e-commerce stratified sampling for ${ecommerceTotalTargetSamples} balanced samples across complexity ranges...`
  );
  ecommerceComplexityRanges.forEach((range) => {
    console.log(
      `  • ${range.label} (${range.min}-${range.max}): ${range.targetSamples} samples`
    );
  });

  // Create progress bar for e-commerce
  const ecommerceProgressBar = new cliProgress.SingleBar({
    format:
      "  E-commerce |" +
      chalk.magenta("{bar}") +
      "| {percentage}% | {value}/{total} | ETA: {eta}s | Elapsed: {duration}s",
    barCompleteChar: "\u2588",
    barIncompleteChar: "\u2591",
    hideCursor: true,
  });

  ecommerceProgressBar.start(ecommerceTotalTargetSamples, 0);

  // Generate e-commerce samples for each complexity range
  let totalEcommerceSamplesGenerated = 0;
  for (const complexityRange of ecommerceComplexityRanges) {
    let samplesGenerated = 0;
    let attempts = 0;
    const maxAttempts = complexityRange.targetSamples * 10; // Prevent infinite loops

    while (
      samplesGenerated < complexityRange.targetSamples &&
      attempts < maxAttempts
    ) {
      attempts++;

      const doc1 = generateRandomECommerceConfig({complexity: complexityRange.label as "Low" | "Medium" | "High" | "Very High"});
      const doc1Size = JSON.stringify(doc1).length;
      const doc2 = JSON.parse(JSON.stringify(doc1));

      // Generate complexity score within target range
      const targetComplexity = faker.number.int({
        min: complexityRange.min,
        max: complexityRange.max,
      });

      const { appliedModifications, actualComplexity } =
        applyECommerceModificationsForTargetComplexity(
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
             fn: () => ecommercePatcher.createPatch(doc1 as any, doc2 as any),
           },
           {
             name: "fast-json-patch",
             fn: () => fastJsonPatch.compare(doc1 as any, doc2 as any),
           },
           { name: "jsondiffpatch", fn: () => diffpatcher.diff(doc1 as any, doc2 as any) },
         ];

        for (const library of libraries) {
          const { result: patch, duration, memoryUsage } = await measureMemoryUsage(() => library.fn() as any);
          const patchCount =
            library.name === "jsondiffpatch"
              ? countJsonDiffPatches(patch)
              : library.name === "schema-json-patch (new)"
              ? patch.operations.length
              : Array.isArray(patch)
              ? patch.length
              : 0;

          const patchSize = JSON.stringify(patch || {}).length;
          const executionTime = duration;

          // Calculate accuracy
          const isValid =
            library.name === "jsondiffpatch"
              ? true // jsondiffpatch doesn't follow RFC 6902, so we skip validation
              : isPatchValid(
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
            ecommerceSchema
          );

          const metrics: BenchmarkMetrics = {
            library: library.name,
            patchCount,
            patchSize,
            executionTime,
            memoryUsage,
            accuracy: isValid,
            compressionRatio: doc1Size > 0 ? (patchSize / doc1Size) * 100 : 0,
            complexityScore: actualComplexity,
            operationType: appliedModifications.join(","),
            documentSize: doc1Size,
            semanticAccuracy,
            iteration: samplesGenerated,
          };

          ecommerceMetrics.push(metrics);
        }

                 // Run formatted diff comparison for this e-commerce sample
         const formattedDiffLibraries = [
           {
             name: "schema-aggregated",
             fn: () => {
               const freshPatcher = new SchemaJsonPatcher({ plan: ecommercePlan });
               const aggregator = new PatchAggregator(doc1 as any, doc2 as any);
               const rawPatch = freshPatcher.createPatch(doc1 as any, doc2 as any);
               return aggregator.aggregate(rawPatch, {
                 pathPrefix: "/products",
                 plan: ecommercePlan,
               });
             },
           },
           {
             name: "json-diff-kit",
             fn: () => jsonDiffKitDiffer.diff(doc1 as any, doc2 as any),
           },
         ];

        for (const [index, library] of formattedDiffLibraries.entries()) {
          const { result: formattedDiff, duration, memoryUsage } = await measureMemoryUsage(() => library.fn() as any);
          
          const outputSize = JSON.stringify(formattedDiff || {}).length;
          const executionTime = duration;

          const formattedMetrics: FormattedDiffMetrics = {
            library: library.name,
            executionTime,
            memoryUsage,
            outputSize,
            compressionRatio: doc1Size > 0 ? (outputSize / doc1Size) * 100 : 0,
            complexityScore: actualComplexity,
            operationType: appliedModifications.join(","),
            documentSize: doc1Size,
            iteration: samplesGenerated,
          };

          ecommerceFormattedMetrics.push(formattedMetrics);
          if (attempts === 1 && samplesGenerated === 0) {
            await writeFile(
              join(__dirname, "formatted-diff", `${library.name}-ecommerce-input.json`),
              JSON.stringify(doc1, null, 2)
            );
            await writeFile(
              join(__dirname, "formatted-diff", `${library.name}-ecommerce-output.json`),
              JSON.stringify(doc2, null, 2)
            );
            await writeFile(
              join(__dirname, "formatted-diff", `${library.name}-ecommerce-formatted-diff.json`),
              JSON.stringify(formattedDiff, null, 2)
            );
          }
        }

                 samplesGenerated++;
         totalEcommerceSamplesGenerated++;
         ecommerceProgressBar.update(totalEcommerceSamplesGenerated);
      }
    }

    if (attempts >= maxAttempts) {
      console.warn(
        `\n⚠️  Warning: Could only generate ${samplesGenerated}/${complexityRange.targetSamples} e-commerce samples for ${complexityRange.label} range after ${maxAttempts} attempts`
      );
    }
  }

  // Stop e-commerce progress bar
  ecommerceProgressBar.stop();

  console.log(
    "\n✅ E-commerce stratified benchmark completed! Generating comprehensive reports...\n"
  );

  // Generate comprehensive report
  generateComprehensiveReport(allMetrics, "Cloud Config");

  // Generate comprehensive report for e-commerce
  generateComprehensiveReport(ecommerceMetrics, "E-commerce");

  // Generate formatted diff report
  generateFormattedDiffReport(formattedDiffMetrics, "Cloud Config");

  // Generate formatted diff report for e-commerce
  generateFormattedDiffReport(ecommerceFormattedMetrics, "E-commerce");

  // Export metrics to CSV
  const csvFilename = join(
    __dirname,
    `./benchmark-results/benchmark-results-${new Date().toISOString().split("T")[0]}.csv`
  );
  console.log("\n💾 Exporting detailed cloud-config metrics to CSV...");
  await exportMetricsToCSV(allMetrics, csvFilename);
  console.log(`✅ Metrics exported to: ${csvFilename}`);

  // Export e-commerce metrics to CSV
  const ecommerceCsvFilename = join(
    __dirname,
    `./benchmark-results/ecommerce-benchmark-results-${new Date().toISOString().split("T")[0]}.csv`
  );
  console.log("\n💾 Exporting detailed e-commerce metrics to CSV...");
  await exportMetricsToCSV(ecommerceMetrics, ecommerceCsvFilename);
  console.log(`✅ E-commerce metrics exported to: ${ecommerceCsvFilename}`);

  // Export formatted diff metrics to CSV
  const formattedCsvFilename = join(
    __dirname,
    `./benchmark-results/formatted-diff-results-${new Date().toISOString().split("T")[0]}.csv`
  );
  console.log("\n💾 Exporting formatted diff metrics to CSV...");
  await exportFormattedDiffMetricsToCSV(
    formattedDiffMetrics,
    formattedCsvFilename
  );
  console.log(`✅ Formatted diff metrics exported to: ${formattedCsvFilename}`);

  // Export e-commerce formatted diff metrics to CSV
  const ecommerceFormattedCsvFilename = join(
    __dirname,
    `./benchmark-results/ecommerce-formatted-diff-results-${new Date().toISOString().split("T")[0]}.csv`
  );
  console.log("\n💾 Exporting e-commerce formatted diff metrics to CSV...");
  await exportFormattedDiffMetricsToCSV(
    ecommerceFormattedMetrics,
    ecommerceFormattedCsvFilename
  );
  console.log(`✅ E-commerce formatted diff metrics exported to: ${ecommerceFormattedCsvFilename}`);

  console.log("\n📁 Sample patch files written to comparison/ directory");
  console.log("🎉 Comprehensive benchmark analysis complete!");
  console.log(`   • Cloud config samples: ${totalTargetSamples}`);
  console.log(`   • E-commerce samples: ${ecommerceTotalTargetSamples}`);
  console.log(`   • Total samples analyzed: ${totalTargetSamples + ecommerceTotalTargetSamples}`);
}

compare().catch(console.error);