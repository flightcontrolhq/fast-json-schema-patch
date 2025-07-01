import { faker } from "@faker-js/faker";

export function createRandomWebService() {
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

export function createRandomWorkerService() {
  return {
    id: faker.string.uuid(),
    name: `${faker.hacker.verb()}-worker`,
    type: "worker",
    cpu: faker.number.float({ min: 0.25, max: 2 }),
    memory: faker.number.float({ min: 0.5, max: 4 }),
    startCommand: `node start-${faker.lorem.word()}.js`,
  };
}

export function createRandomDbService() {
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

export function generateUniqueServiceId(env: any): string {
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

export function getMinMax(complexity: "Low" | "Medium" | "High" | "Very High") {
  if (complexity === "Low") {
    return { min: 1, max: 20 };
  }
  if (complexity === "Medium") {
    return { min: 20, max: 50 };
  }
  if (complexity === "High") {
    return { min: 50, max: 100 };
  }
  if (complexity === "Very High") {
    return { min: 100, max: 500 };
  }
  throw new Error(`Invalid complexity: ${complexity}`);
}

export function createRandomCloudConfig({complexity}: {complexity: "Low" | "Medium" | "High" | "Very High"}) {
  const config: any = {
    environments: [],
  };

  const numEnvs = complexity === "Low" ? 1 : faker.number.int({ min: 1, max: 10 });
  for (let i = 0; i < numEnvs; i++) {
    const services = [];
    const { min, max } = getMinMax(complexity);
    const numServices = faker.number.int({ min, max });

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
export const smallDoc1 = {
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

export const smallDoc2 = {
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
export const createLargeDoc = (numServices: number) => {
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

export const largeDoc1 = createLargeDoc(10);
export const largeDoc2 = JSON.parse(JSON.stringify(largeDoc1)); // deep copy

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
export const realWorldDoc1 = require("../schema/test.json");
export const realWorldDoc2 = JSON.parse(JSON.stringify(realWorldDoc1));

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