import { SchemaPatcher, buildPlan } from "../src/index";
import schema from "../test/schema.json";
import * as fastJsonPatch from "fast-json-patch";
import rfc6902 from "rfc6902";
import { writeFile } from "fs/promises";
import { join } from "path";

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

async function compare() {
  const plan = buildPlan(schema);
  const patcher = new SchemaPatcher({ plan });

  const scenarios = {
    small: { doc1: smallDoc1, doc2: smallDoc2 },
    large: { doc1: largeDoc1, doc2: largeDoc2 },
  };

  for (const [name, { doc1, doc2 }] of Object.entries(scenarios)) {
    console.log(`Comparing ${name} config...`);

    const schemaPatch = patcher.createPatch(doc1, doc2);
    const fastPatch = fastJsonPatch.compare(doc1, doc2);
    const rfcPatch = rfc6902.createPatch(doc1, doc2);

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

    console.log(`- SchemaPatcher patch length: ${schemaPatch.length}`);
    console.log(`- fast-json-patch patch length: ${fastPatch.length}`);
    console.log(`- rfc6902 patch length: ${rfcPatch.length}`);
    console.log(`- Wrote patches to comparison/${name}-*.json`);
    console.log("");
  }
}

compare().catch(console.error); 