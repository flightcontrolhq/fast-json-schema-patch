import { Bench } from "tinybench";
import { SchemaPatcher, buildPlan } from "../src/index";
import schema from "../test/schema.json";
import * as fastJsonPatch from "fast-json-patch";

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

const largeDoc1 = createLargeDoc(100);
const largeDoc2 = JSON.parse(JSON.stringify(largeDoc1)); // deep copy

// Make some changes to largeDoc2
largeDoc2.environments[0].services.splice(50, 1); // remove one
largeDoc2.environments[0].services[25].cpu = 100; // modify one
largeDoc2.environments[0].services.push({ // add one
  id: "service-new",
  name: "new-service",
  type: "worker",
  cpu: 1,
  memory: 1,
});

const plan = buildPlan(schema);
const patcherWithPlan = new SchemaPatcher({ plan });

bench
  .add("SchemaPatcher (with plan build) - Small Config", () => {
    const patcher = new SchemaPatcher({ schema });
    patcher.createPatch(smallDoc1, smallDoc2);
  })
  .add("SchemaPatcher (pre-built plan) - Small Config", () => {
    patcherWithPlan.createPatch(smallDoc1, smallDoc2);
  })
  .add("fast-json-patch - Small Config", () => {
    fastJsonPatch.compare(smallDoc1, smallDoc2);
  })
  .add("SchemaPatcher (with plan build) - Large Config", () => {
    const patcher = new SchemaPatcher({ schema });
    patcher.createPatch(largeDoc1, largeDoc2);
  })
  .add("SchemaPatcher (pre-built plan) - Large Config", () => {
    patcherWithPlan.createPatch(largeDoc1, largeDoc2);
  })
  .add("fast-json-patch - Large Config", () => {
    fastJsonPatch.compare(largeDoc1, largeDoc2);
  });

await bench.run();

console.table(bench.table()); 