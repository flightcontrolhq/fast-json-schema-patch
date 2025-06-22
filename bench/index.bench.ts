import { Bench } from "tinybench";
import { SchemaPatcher, buildPlan } from "../src/index";
import schema from "../test/schema.json";
import * as fastJsonPatch from "fast-json-patch";
import rfc6902 from "rfc6902";
import { faker } from "@faker-js/faker";
import * as jsondiffpatch from "jsondiffpatch";

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
    posts: Array.from({ length: faker.number.int({ min: 2, max: 10 }) }, () => ({
      postId: faker.string.uuid(),
      title: faker.lorem.sentence(),
      content: faker.lorem.paragraphs(),
      timestamp: faker.date.recent().toISOString(),
      likes: faker.number.int({ min: 0, max: 1000 }),
      tags: Array.from(
        { length: faker.number.int({ min: 1, max: 10 }) },
        () => faker.lorem.word()
      ),
    })),
  };
}

const bench = new Bench({ time: 100 });

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
        { id: "service3", name: "new-worker", type: "worker", cpu: 1, memory: 2 },
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
largeDoc2.environments[0].services.push({ // add one
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

const plan = buildPlan(schema);
const patcherWithPlan = new SchemaPatcher({ plan });

const diffpatcher = jsondiffpatch.create({
  objectHash: (obj: any) => {
    return obj.id || obj.postId || obj.name;
  },
});

// Faker docs
const fakerDoc1 = createRandomUser();
const fakerDoc2 = JSON.parse(JSON.stringify(fakerDoc1));
fakerDoc2.username = faker.internet.username();
if (fakerDoc2.posts.length > 1) {
  fakerDoc2.posts.splice(1, 1);
}
if (fakerDoc2.posts.length > 0) {
    fakerDoc2.posts[0].title = "A totally new title";
}
fakerDoc2.posts.push({
  postId: faker.string.uuid(),
  title: "Newly Added Post",
  content: faker.lorem.paragraphs(),
  timestamp: faker.date.recent().toISOString(),
  likes: 0,
  tags: ["new", "post"],
});

const fakerPlan = buildPlan(userSchema as any, { primaryKeyMap: { "/posts": "postId" } });
const fakerPatcher = new SchemaPatcher({ plan: fakerPlan });

bench
  .add("SchemaPatcher (pre-built plan) - Small Config", () => {
    patcherWithPlan.createPatch(smallDoc1, smallDoc2);
  })
  .add("fast-json-patch - Small Config", () => {
    fastJsonPatch.compare(smallDoc1, smallDoc2);
  })
  .add("rfc6902 - Small Config", () => {
    rfc6902.createPatch(smallDoc1, smallDoc2);
  })
  .add("jsondiffpatch - Small Config", () => {
    diffpatcher.diff(smallDoc1, smallDoc2);
  })
  .add("SchemaPatcher (pre-built plan) - Large Config", () => {
    patcherWithPlan.createPatch(largeDoc1, largeDoc2);
  })
  .add("fast-json-patch - Large Config", () => {
    fastJsonPatch.compare(largeDoc1, largeDoc2);
  })
  .add("rfc6902 - Large Config", () => {
    rfc6902.createPatch(largeDoc1, largeDoc2);
  })
  .add("jsondiffpatch - Large Config", () => {
    diffpatcher.diff(largeDoc1, largeDoc2);
  })
  .add("SchemaPatcher (pre-built plan) - Real-world Config", () => {
    patcherWithPlan.createPatch(realWorldDoc1, realWorldDoc2);
  })
  .add("fast-json-patch - Real-world Config", () => {
    fastJsonPatch.compare(realWorldDoc1, realWorldDoc2);
  })
  .add("rfc6902 - Real-world Config", () => {
    rfc6902.createPatch(realWorldDoc1, realWorldDoc2);
  })
  .add("jsondiffpatch - Real-world Config", () => {
    diffpatcher.diff(realWorldDoc1, realWorldDoc2);
  })
  .add("SchemaPatcher (pre-built plan) - Faker Config", () => {
    fakerPatcher.createPatch(fakerDoc1, fakerDoc2);
  })
  .add("fast-json-patch - Faker Config", () => {
    fastJsonPatch.compare(fakerDoc1, fakerDoc2);
  })
  .add("rfc6902 - Faker Config", () => {
    rfc6902.createPatch(fakerDoc1, fakerDoc2);
  })
  .add("jsondiffpatch - Faker Config", () => {
    diffpatcher.diff(fakerDoc1, fakerDoc2);
  });

await bench.run();

console.table(bench.table()); 