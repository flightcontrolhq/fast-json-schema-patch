import { SchemaPatcher, buildPlan } from "../src/index";
import schema from "../test/schema.json";
import * as fastJsonPatch from "fast-json-patch";
import rfc6902 from "rfc6902";
import * as jsondiffpatch from "jsondiffpatch";
import { writeFile } from "fs/promises";
import { join } from "path";
import { faker } from "@faker-js/faker";

const userSchema = {
  type: "object",
  properties: {
    userId: { type: "string" },
    username: { type: "string" },
    email: { type: "string" },
    avatar: { type: "string" },
    password: { type: "string" },
    birthdate: { type: "string", format: "date-time" },
    registeredAt: { type: "string", format: "date-time" },
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zipCode: { type: "string" },
      },
      required: ["street", "city", "zipCode"],
    },
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          postId: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
          likes: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["postId", "title", "content", "timestamp", "likes"],
      },
    },
  },
  required: ["userId", "username", "email", "registeredAt"],
};

function createRandomUser() {
  return {
    userId: faker.string.uuid(),
    username: faker.internet.username(),
    email: faker.internet.email(),
    avatar: faker.image.avatar(),
    birthdate: faker.date.past().toISOString(),
    registeredAt: faker.date.past().toISOString(),
    address: {
      street: faker.location.streetAddress(),
      city: faker.location.city(),
      zipCode: faker.location.zipCode(),
    },
    posts: Array.from({ length: faker.number.int({ min: 2, max: 5 }) }, () => ({
      postId: faker.string.uuid(),
      title: faker.lorem.sentence(),
      content: faker.lorem.paragraphs(),
      timestamp: faker.date.recent().toISOString(),
      likes: faker.number.int({ min: 0, max: 1000 }),
      tags: Array.from(
        { length: faker.number.int({ min: 1, max: 5 }) },
        () => faker.lorem.word()
      ),
    })),
  };
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
    small: { doc1: smallDoc1, doc2: smallDoc2, schema },
    large: { doc1: largeDoc1, doc2: largeDoc2, schema },
    "real-world": { doc1: realWorldDoc1, doc2: realWorldDoc2, schema },
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
    console.log(`- fast-json-patch patch length: ${fastPatch.length}`);
    console.log(`- rfc6902 patch length: ${rfcPatch.length}`);
    console.log(`- jsondiffpatch patch length: ${jsonDiffPatch ? Object.keys(jsonDiffPatch).length : 0}`);
    console.log(`- Wrote patches to comparison/${name}-*.json`);
    console.log("");
  }

  // Faker scenario
  console.log("Comparing faker-generated config...");
  const plan = buildPlan(userSchema as any, { primaryKeyMap: { "/posts": "postId" } });
  const patcher = new SchemaPatcher({ plan });
  let totalSchemaPatches = 0;
  let totalFastPatches = 0;
  let totalRfcPatches = 0;
  let totalJsonDiffPatches = 0;
  const numFakerRuns = 10;

  for (let i = 0; i < numFakerRuns; i++) {
    const doc1 = createRandomUser();
    const doc2 = JSON.parse(JSON.stringify(doc1));

    // Make some changes
    doc2.username = faker.internet.username();
    if (doc2.posts.length > 1) {
      doc2.posts.splice(1, 1);
    }
    doc2.posts[0].title = "A totally new title";
    doc2.posts.push({
      postId: faker.string.uuid(),
      title: "Newly Added Post",
      content: faker.lorem.paragraphs(),
      timestamp: faker.date.recent().toISOString(),
      likes: 0,
      tags: ["new", "post"],
    });

    const schemaPatch = patcher.createPatch(doc1, doc2);
    const fastPatch = fastJsonPatch.compare(doc1, doc2);
    const rfcPatch = rfc6902.createPatch(doc1, doc2);
    const jsonDiffPatch = diffpatcher.diff(doc1, doc2);

    totalSchemaPatches += schemaPatch.length;
    totalFastPatches += fastPatch.length;
    totalRfcPatches += rfcPatch.length;
    if (jsonDiffPatch) {
      totalJsonDiffPatches += Object.keys(jsonDiffPatch).length;
    }

    if (i === 0) {
      // Save one example
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
  
  console.log(`- SchemaPatcher average patch length: ${totalSchemaPatches / numFakerRuns}`);
  console.log(`- fast-json-patch average patch length: ${totalFastPatches / numFakerRuns}`);
  console.log(`- rfc6902 average patch length: ${totalRfcPatches / numFakerRuns}`);
  console.log(`- jsondiffpatch average patch length: ${totalJsonDiffPatches / numFakerRuns}`);
  console.log("- Wrote first faker patches to comparison/faker-*.json");
  console.log("");
}

compare().catch(console.error);
