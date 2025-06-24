import { SchemaPatcher, buildPlan, deepEqual } from "../src/index";
import * as fastJsonPatch from "fast-json-patch";
import rfc6902 from "rfc6902";
import * as jsondiffpatch from "jsondiffpatch";
import { writeFile } from "fs/promises";
import { join } from "path";
import { faker } from "@faker-js/faker";
import mainSchema from "../test/schema.json";

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

function isPatchValid(
  doc1: any,
  doc2: any,
  patch: any,
  library: string,
  modificationIndexs: string[]
) {
  try {
    const doc1Copy = JSON.parse(JSON.stringify(doc1));
    const patchCopy = JSON.parse(JSON.stringify(patch));

    const { newDocument: patchedDoc } = fastJsonPatch.applyPatch(
      doc1Copy,
      patchCopy,
      true
    );

    const sortedPatchedDoc = deepSortArrays(patchedDoc);
    const sortedDoc2 = deepSortArrays(doc2);

    const valid = deepEqual(sortedPatchedDoc, sortedDoc2);

    if (!valid) {
      console.error(
        `Patch from ${library} generated an invalid result for ${modificationIndexs.join(
          ", "
        )}. The diff is:`
      );
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
    "real-world": {
      doc1: realWorldDoc1,
      doc2: realWorldDoc2,
      schema: mainSchema,
    },
  };

  for (const [name, { doc1, doc2, schema: scenarioSchema }] of Object.entries(
    scenarios
  )) {
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
    console.log(`- fast-json-patch patch length: ${fastPatch.length}`);
    console.log(`- rfc6902 patch length: ${rfcPatch.length}`);
    console.log(
      `- jsondiffpatch patch length: ${countJsonDiffPatches(jsonDiffPatch)}`
    );
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

    const modifications = [
      // SIMPLE MODIFICATIONS (1-30) - Basic property changes
      {
        name: "Change environment name",
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env) env.name = faker.lorem.words(2);
        },
      },
      {
        name: "Change environment region",
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env) env.id = faker.lorem.slug();
        },
      },
      {
        name: "Change source branch",
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.source)
            env.source.trigger = faker.helpers.arrayElement(["push", "manual"]);
        },
      },
      {
        name: "Change service ID",
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length > 0) {
            const service: any = faker.helpers.arrayElement(env.services);
            if (service)
              service.stickySessionsEnabled = faker.datatype.boolean();
          }
        },
      },
      {
        name: "Change sticky sessions duration",
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length > 0) {
            const service: any = faker.helpers.arrayElement(env.services);
            if (service)
              service.cloudfrontAutoCacheInvalidation =
                faker.datatype.boolean();
          }
        },
      },
      {
        name: "Add single environment variable",
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length > 1) {
            env.services = faker.helpers.shuffle(env.services);
          }
        },
      },
      {
        name: "Add dependency between services",
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length > 0) {
            const service: any = faker.helpers.arrayElement(
              env.services.filter((s: any) =>
                ["web", "worker"].includes(s.type)
              )
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length >= 3) {
            const services = faker.helpers
              .shuffle([...env.services])
              .slice(0, 3);

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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length > 0) {
            const scalingFactor = faker.number.float({ min: 0.5, max: 2.0 });

            env.services.forEach((service: any) => {
              if (service.cpu)
                service.cpu = Math.max(0.125, service.cpu * scalingFactor);
              if (service.memory)
                service.memory = Math.max(
                  0.125,
                  service.memory * scalingFactor
                );
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
                        Resource: [
                          `arn:aws:s3:::${s3Service.bucketNameBase}/*`,
                        ],
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length > 0) {
            const rdsService: any = env.services.find(
              (s: any) => s.type === "rds"
            );
            if (rdsService) {
              rdsService.connectionStringEnvVarName =
                faker.helpers.arrayElement([
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
        modify: (doc: any) => {
          const env: any = faker.helpers.arrayElement(doc.environments);
          if (env && env.services.length > 0) {
            const s3Service: any = env.services.find(
              (s: any) => s.type === "s3"
            );
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
              rdsService.deleteBackupsWithRdsDeletion =
                faker.datatype.boolean();

              if (rdsService.port === undefined) {
                rdsService.port =
                  rdsService.engine === "postgres" ? 5432 : 3306;
              }
            }
          }
        },
      },
      {
        name: "Add comprehensive service with all features",
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

    const numModifications = faker.number.int({ min: 2, max: 100 });
    const modificationIndexs: string[] = [];
    for (let j = 0; j < numModifications; j++) {
      const { name, modify } = faker.helpers.arrayElement(modifications);
      modificationIndexs.push(name);
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
    const schemaValid = isPatchValid(
      doc1,
      doc2,
      schemaPatch,
      "SchemaPatcher",
      modificationIndexs
    );
    const fastValid = isPatchValid(
      doc1,
      doc2,
      fastPatch,
      "fast-json-patch",
      modificationIndexs
    );
    const rfcValid = isPatchValid(
      doc1,
      doc2,
      rfcPatch,
      "rfc6902",
      modificationIndexs
    );

    totalSchemaValid += schemaValid ? 1 : 0;
    totalFastValid += fastValid ? 1 : 0;
    totalRfcValid += rfcValid ? 1 : 0;

    totalSchemaPatches += schemaPatch.length;
    totalSchemaPatchLines += JSON.stringify(schemaPatch).length;
    totalFastPatches += fastPatch.length;
    totalFastPatchLines += JSON.stringify(fastPatch).length;
    totalRfcPatches += rfcPatch.length;
    totalRfcPatchLines += JSON.stringify(rfcPatch).length;
    if (jsonDiffPatch) {
      totalJsonDiffPatches += countJsonDiffPatches(jsonDiffPatch);
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
      accuracy: (totalSchemaValid / numFakerRuns) * 100,
      time: `${schemaPatchTime}ms`,
      averageTime: `${schemaPatchTime / numFakerRuns}ms`,
    },
    {
      name: "fast-json-patch",
      totalPatches: totalFastPatches,
      averagePatches: totalFastPatches / numFakerRuns,
      patchLength: totalFastPatchLines,
      averagePatchLength: totalFastPatchLines / numFakerRuns,
      valid: totalFastValid,
      accuracy: (totalFastValid / numFakerRuns) * 100,
      time: `${fastPatchTime}ms`,
      averageTime: `${fastPatchTime / numFakerRuns}ms`,
    },
    {
      name: "rfc6902",
      totalPatches: totalRfcPatches,
      averagePatches: totalRfcPatches / numFakerRuns,
      patchLength: totalRfcPatchLines,
      averagePatchLength: totalRfcPatchLines / numFakerRuns,
      valid: totalRfcValid,
      accuracy: (totalRfcValid / numFakerRuns) * 100,
      time: `${rfcPatchTime}ms`,
      averageTime: `${rfcPatchTime / numFakerRuns}ms`,
    },
    {
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
