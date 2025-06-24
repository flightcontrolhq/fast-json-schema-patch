import { SchemaPatcher, buildPlan, deepEqual } from "../src/index";
import * as fastJsonPatch from "fast-json-patch";
import rfc6902 from "rfc6902";
import * as jsondiffpatch from "jsondiffpatch";
import { writeFile } from "fs/promises";
import { join } from "path";
import { faker } from "@faker-js/faker";
import mainSchema from "../test/schema.json";

function deepSortArrays(obj: any): any {
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
  if (typeof obj === 'object' && obj !== null) {
    // Also sort keys for a canonical object representation
    const newObj: { [key: string]: any } = {};
    for (const key of Object.keys(obj).sort()) {
      newObj[key] = deepSortArrays((obj as any)[key]);
    }
    return newObj;
  }
  return obj;
}

function isPatchValid(doc1: any, doc2: any, patch: any, library: string) {
  try {
    const doc1Copy = JSON.parse(JSON.stringify(doc1));
    const patchCopy = JSON.parse(JSON.stringify(patch));
    
    const {newDocument: patchedDoc} = fastJsonPatch.applyPatch(doc1Copy, patchCopy, true);
    
    const sortedPatchedDoc = deepSortArrays(patchedDoc);
    const sortedDoc2 = deepSortArrays(doc2);

    const valid = deepEqual(sortedPatchedDoc, sortedDoc2);

    if (!valid) {
      console.error(`Patch from ${library} generated an invalid result. The diff is:`);
      const delta = diffpatcher.diff(sortedPatchedDoc, sortedDoc2);
      console.error(JSON.stringify(delta, null, 2));
    }
    return valid;
  } catch (e) {
    // Errors are expected for invalid patches. We return false and don't log to keep the output clean.
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

function createRandomCloudConfig() {
  const config: any = {
    environments: [],
  };

  const numEnvs = 1
  for (let i = 0; i < numEnvs; i++) {
    const services = [];
    const numServices = faker.number.int({ min: 2, max: 100 });
    
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

function countRfc6902Patch(patch: any): number {
  return patch.length;
}

function countJsonDiffPatch(patch: any): number {
  if (!patch || typeof patch !== 'object') {
    return 0;
  }

  let count = 0;
  
  if (Array.isArray(patch)) {
    if (
      patch.length === 1 ||
      patch.length === 2 ||
      (patch.length === 3 && patch[1] === 0 && patch[2] === 0)
    ) {
      return 1;
    }
  }

  if (patch._t === 'a') {
    for (const key in patch) {
      if (key === '_t') {
        continue;
      }

      const val = patch[key];
      if (Array.isArray(val)) {
        count++;
      } else {
        count += countJsonDiffPatch(val);
      }
    }
    return count;
  }

  for (const key in patch) {
    count += countJsonDiffPatch(patch[key]);
  }

  return count;
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

async function compare() {
  const scenarios = {
    small: { doc1: smallDoc1, doc2: smallDoc2, schema: mainSchema },
    large: { doc1: largeDoc1, doc2: largeDoc2, schema: mainSchema },
    "real-world": { doc1: realWorldDoc1, doc2: realWorldDoc2, schema: mainSchema },
  };

  for (const [name, { doc1, doc2, schema: scenarioSchema }] of Object.entries(scenarios)) {
    console.log(`Comparing ${name} config...`);
    
    const plan = buildPlan(scenarioSchema as any);
    const patcher = new SchemaPatcher({ plan });

    const schemaPatch = patcher.createPatch(doc1, doc2);
    const fastPatch = fastJsonPatch.compare(doc1, doc2);
    const rfcPatch = rfc6902.createPatch(doc1, doc2);
    const jsonDiffPatch = diffpatcher.diff(doc1, doc2);

    await writeFile(
      join(__dirname, `${name}-schema-patch.json`),
      JSON.stringify(schemaPatch, null, 2)
    );
    await writeFile(
      join(__dirname, `${name}-fast-json-patch.json`),
      JSON.stringify(fastPatch, null, 2)
    );
    await writeFile(
      join(__dirname, `${name}-rfc6902-patch.json`),
      JSON.stringify(rfcPatch, null, 2)
    );
    await writeFile(
      join(__dirname, `${name}-jsondiffpatch-patch.json`),
      JSON.stringify(jsonDiffPatch, null, 2)
    );

    console.log(`- SchemaPatcher patch length: ${schemaPatch.length}`);
    console.log(`- fast-json-patch patch length: ${countRfc6902Patch(fastPatch)}`);
    console.log(`- rfc6902 patch length: ${countRfc6902Patch(rfcPatch)}`);
    console.log(`- jsondiffpatch patch length: ${countJsonDiffPatch(jsonDiffPatch)}`);
    console.log(`- Wrote patches to comparison/${name}-*.json`);
    console.log("");
  }

  // Faker scenario
  console.log("Comparing faker-generated config...");
  
  const plan = buildPlan(mainSchema as any);
  const patcher = new SchemaPatcher({ plan });
  let totalSchemaPatches = 0;
  let schemaPatchTime = 0;
  let totalSchemaPatchLines = 0;
  let totalSchemaValid = 0;
  let totalFastPatches = 0;
  let fastPatchTime = 0;
  let totalFastPatchLines = 0;
  let totalFastValid = 0;
  let totalRfcPatches = 0;
  let rfcPatchTime = 0;
  let totalRfcPatchLines = 0;
  let totalRfcValid = 0;
  let totalJsonDiffPatches = 0;
  let jsonDiffPatchTime = 0;
  let totalJsonDiffPatchLines = 0;
  const numFakerRuns = 5000;
  let totalJsonLines = 0;

  for (let i = 0; i < numFakerRuns; i++) {
    const doc1 = createRandomCloudConfig();
    totalJsonLines += JSON.stringify(doc1).length;
    const doc2 = JSON.parse(JSON.stringify(doc1));

    // Apply a random number of random modifications based on the new schema
    const modifications = [
      (doc: any) => { // Change environment name
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) env.name = faker.lorem.slug();
      },
      (doc: any) => { // Add a new service
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) env.services.push(createRandomWebService());
      },
      (doc: any) => { // Remove a service
        const envWithServices = doc.environments.find((e: any) => e.services.length > 1);
        if (envWithServices) {
          envWithServices.services.splice(0, 1);
        }
      },
      (doc: any) => { // Modify a service property
         const envWithServices: any = doc.environments.find((e: any) => e.services.length > 0);
         if (envWithServices) {
           const service: any = faker.helpers.arrayElement(envWithServices.services);
           if (service && service.type === 'web') {
             service.cpu = faker.number.float({ min: 0.25, max: 4 });
             service.memory = faker.number.float({ min: 0.5, max: 8 });
           } else if (service && service.type === 'rds') {
             service.storage = faker.number.int({ min: 20, max: 200 });
           }
         }
      },
       (doc: any) => { // Reorder services
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 1) {
          env.services = faker.helpers.shuffle(env.services);
        }
      },
       (doc: any) => { 
         //change the id of a service
         const env: any = faker.helpers.arrayElement(doc.environments);
         if (env && env.services.length > 0) {
           const service: any = faker.helpers.arrayElement(env.services);
           service.id = faker.string.uuid();
         }
       },
       (doc: any) => { // Modify a deeply nested environment variable
        const webServiceEnv = doc.environments.find((e: any) => e.services.some((s:any) => s.type === 'web'));
        if (webServiceEnv) {
          const webService = webServiceEnv.services.find((s: any) => s.type === 'web');
          if (webService && webService.envVariables) {
            const newVar = `VAR_${faker.lorem.word().toUpperCase()}`;
            webService.envVariables[newVar] = faker.internet.password();
          }
        }
      },
      (doc: any) => { // Move a service from one environment to another
        if (doc.environments.length > 1) {
          const sourceEnv: any = faker.helpers.arrayElement(doc.environments.filter((e:any) => e.services.length > 0));
          const targetEnv: any = faker.helpers.arrayElement(doc.environments.filter((e:any) => e.id !== sourceEnv.id));
          if (sourceEnv && targetEnv) {
              const serviceToMove = sourceEnv.services.pop();
              if (serviceToMove) {
                  targetEnv.services.push(serviceToMove);
              }
          }
        }
      },
      (doc: any) => { // Add a dependsOn relationship between services
        const envWithMultipleServices = doc.environments.find((e: any) => e.services.length > 1);
        if (envWithMultipleServices) {
          const [service1, service2]: any[] = faker.helpers.shuffle(envWithMultipleServices.services);
          if (service1 && service2 && service1.id !== service2.id) {
            if (!service1.dependsOn) {
              service1.dependsOn = [];
            }
            if (!service1.dependsOn.includes(service2.id)) {
              service1.dependsOn.push(service2.id);
            }
          }
        }
      },
      (doc: any) => { // Clone a service, modify it, and add a dependency
        const env: any = faker.helpers.arrayElement(doc.environments.filter((e: any) => e.services.length > 0));
        if (env) {
          const originalService: any = faker.helpers.arrayElement(env.services);
          if(originalService) {
              const clonedService = JSON.parse(JSON.stringify(originalService));
              
              clonedService.id = faker.string.uuid();
              clonedService.name = `${originalService.name}-clone`;
              if (clonedService.type === 'web') {
                  clonedService.cpu = faker.number.float({ min: 0.25, max: 4 });
              }
              
              env.services.push(clonedService);
      
              if (!originalService.dependsOn) {
                  originalService.dependsOn = [];
              }
              originalService.dependsOn.push(clonedService.id);
          }
        }
      },
    ];

    const numModifications = faker.number.int({ min: 3, max: 6 });
    for (let j = 0; j < numModifications; j++) {
        const modify = faker.helpers.arrayElement(modifications);
        modify(doc2);
    }

    let start = Date.now();
    const schemaPatch = patcher.createPatch(doc1, doc2);
    schemaPatchTime += Date.now() - start;
    start = Date.now();
    const fastPatch = fastJsonPatch.compare(doc1, doc2);
    fastPatchTime += Date.now() - start;
    start = Date.now();
    const rfcPatch = rfc6902.createPatch(doc1, doc2);
    rfcPatchTime += Date.now() - start;
    start = Date.now();
    const jsonDiffPatch = diffpatcher.diff(doc1, doc2);
    jsonDiffPatchTime += Date.now() - start;

    // Calculate accuracy
    const schemaValid = isPatchValid(doc1, doc2, schemaPatch, "SchemaPatcher");
    const fastValid = isPatchValid(doc1, doc2, fastPatch, "fast-json-patch");
    const rfcValid = isPatchValid(doc1, doc2, rfcPatch, "rfc6902");

    totalSchemaValid += schemaValid ? 1 : 0;
    totalFastValid += fastValid ? 1 : 0;
    totalRfcValid += rfcValid ? 1 : 0;

    totalSchemaPatches += schemaPatch.length;
    totalSchemaPatchLines += JSON.stringify(schemaPatch).length;
    totalFastPatches += countRfc6902Patch(fastPatch);
    totalFastPatchLines += JSON.stringify(fastPatch).length;
    totalRfcPatches += countRfc6902Patch(rfcPatch);
    totalRfcPatchLines += JSON.stringify(rfcPatch).length;
    if (jsonDiffPatch) {
      totalJsonDiffPatches += countJsonDiffPatch(jsonDiffPatch);
      totalJsonDiffPatchLines += JSON.stringify(jsonDiffPatch).length;
    }
    if (i === 0) {
      await writeFile(
        join(__dirname, "faker-schema-patch.json"),
        JSON.stringify(schemaPatch, null, 2)
      );
      await writeFile(
        join(__dirname, "faker-fast-json-patch.json"),
        JSON.stringify(fastPatch, null, 2)
      );
      await writeFile(
        join(__dirname, "faker-rfc6902-patch.json"),
        JSON.stringify(rfcPatch, null, 2)
      );
      await writeFile(
        join(__dirname, "faker-jsondiffpatch-patch.json"),
        JSON.stringify(jsonDiffPatch, null, 2)
      );
    }
  }
  console.log(`Ran ${numFakerRuns} faker runs`);
  console.log(`Total JSON lines: ${totalJsonLines}`);
  console.log(`Average JSON lines: ${totalJsonLines / numFakerRuns}`);
  console.table([
    {
    name: "SchemaPatcher",
    totalPatches: totalSchemaPatches,
    averagePatches: totalSchemaPatches / numFakerRuns,
    patchLength: totalSchemaPatchLines,
    averagePatchLength: totalSchemaPatchLines / numFakerRuns,
    valid: totalSchemaValid,
    accuracy: totalSchemaValid / numFakerRuns * 100,
    time: `${schemaPatchTime}ms`,
    averageTime: `${schemaPatchTime / numFakerRuns}ms`,
  }, {
    name: "fast-json-patch",
    totalPatches: totalFastPatches,
    averagePatches: totalFastPatches / numFakerRuns,
    patchLength: totalFastPatchLines,
    averagePatchLength: totalFastPatchLines / numFakerRuns,
    valid: totalFastValid,
    accuracy: totalFastValid / numFakerRuns * 100,
    time: `${fastPatchTime}ms`,
    averageTime: `${fastPatchTime / numFakerRuns}ms`,
  }, {
    name: "rfc6902",
    totalPatches: totalRfcPatches,
    averagePatches: totalRfcPatches / numFakerRuns,
    patchLength: totalRfcPatchLines,
    averagePatchLength: totalRfcPatchLines / numFakerRuns,
    valid: totalRfcValid,
    accuracy: totalRfcValid / numFakerRuns * 100,
    time: `${rfcPatchTime}ms`,
    averageTime: `${rfcPatchTime / numFakerRuns}ms`,
  }, {
    name: "jsondiffpatch",
    totalPatches: totalJsonDiffPatches,
    averagePatches: totalJsonDiffPatches / numFakerRuns,
    patchLength: totalJsonDiffPatchLines,
    averagePatchLength: totalJsonDiffPatchLines / numFakerRuns,
    time: `${jsonDiffPatchTime}ms`,
    averageTime: `${jsonDiffPatchTime / numFakerRuns}ms`,
  },
  ]);
}

compare().catch(console.error);
