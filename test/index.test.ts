import { SchemaPatcher, type Operation, buildPlan } from "../src/index";
import { test, expect } from "bun:test";
import schema from "./schema.json";

test("SchemaPatcher generates correct patches for array with primary key", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
          {
            id: "service2",
            name: "worker",
            type: "worker",
            cpu: 0.5,
            memory: 1,
          },
        ],
      },
    ],
  };

  const doc2 = {
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

  const plan = buildPlan(schema);
  const patcher = new SchemaPatcher({ plan });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    { op: "remove", path: "/environments/0/services/1" },
    { op: "replace", path: "/environments/0/services/0/cpu", value: 2 },
    {
      op: "add",
      path: "/environments/0/services/-",
      value: {
        id: "service3",
        name: "new-worker",
        type: "worker",
        cpu: 1,
        memory: 2,
      },
    },
  ];

  // Sort patches by path to ensure deterministic comparison
  const sortFn = (a: any, b: any) => a.path.localeCompare(b.path);
  patches.sort(sortFn);
  expectedPatches.sort(sortFn);

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher handles empty arrays correctly", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
        ],
      },
    ],
  };

  const patcher = new SchemaPatcher({ plan: buildPlan(schema) });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    {
      op: "add",
      path: "/environments/0/services/-",
      value: { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
    },
  ];

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher handles array with all items removed", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
          {
            id: "service2",
            name: "worker",
            type: "worker",
            cpu: 0.5,
            memory: 1,
          },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [],
      },
    ],
  };

  const patcher = new SchemaPatcher({ plan: buildPlan(schema) });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    { op: "remove", path: "/environments/0/services/1" },
    { op: "remove", path: "/environments/0/services/0" },
  ];

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher handles no changes", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
        ],
      },
    ],
  };

  const patcher = new SchemaPatcher({ plan: buildPlan(schema) });
  const patches = patcher.createPatch(doc1, doc1);
  expect(patches).toEqual([]);
});

test("SchemaPatcher handles array without primary key (fallback)", () => {
  // We'll test this on a property that is an array of strings
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          {
            id: "service1",
            name: "api",
            type: "web",
            cpu: 1,
            memory: 2,
            dependsOn: ["a", "b"],
          },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          {
            id: "service1",
            name: "api",
            type: "web",
            cpu: 1,
            memory: 2,
            dependsOn: ["a", "c", "d"],
          },
        ],
      },
    ],
  };

  const patcher = new SchemaPatcher({ plan: buildPlan(schema) });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    {
      op: "replace",
      path: "/environments/0/services/0/dependsOn/1",
      value: "c",
    },
    { op: "add", path: "/environments/0/services/0/dependsOn/2", value: "d" },
  ];

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher handles deeply nested changes", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "prod",
        services: [
          {
            id: "service1",
            name: "api",
            type: "web",
            cpu: 1,
            memory: 1,
            autoscaling: {
              cpuThreshold: 80,
            },
          },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "prod",
        services: [
          {
            id: "service1",
            name: "api",
            type: "web",
            cpu: 1,
            memory: 1,
            autoscaling: {
              cpuThreshold: 90,
              memoryThreshold: 85,
            },
          },
        ],
      },
    ],
  };

  const patcher = new SchemaPatcher({ plan: buildPlan(schema) });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    {
      op: "replace",
      path: "/environments/0/services/0/autoscaling/cpuThreshold",
      value: 90,
    },
    {
      op: "add",
      path: "/environments/0/services/0/autoscaling/memoryThreshold",
      value: 85,
    },
  ];

  const sortFn = (a: any, b: any) => a.path.localeCompare(b.path);
  patches.sort(sortFn);
  expectedPatches.sort(sortFn);

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher works with a pre-built plan", () => {
  const doc1 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 1, memory: 2 },
        ],
      },
    ],
  };

  const doc2 = {
    environments: [
      {
        id: "env1",
        name: "production",
        region: "us-east-1",
        source: { branch: "main" },
        services: [
          { id: "service1", name: "api", type: "web", cpu: 2, memory: 2 },
        ],
      },
    ],
  };

  const plan = buildPlan(schema);
  const patcher = new SchemaPatcher({ plan });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    { op: "replace", path: "/environments/0/services/0/cpu", value: 2 },
  ];

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher handles real-world schema and data", () => {
  // Use the actual schema and a test data file
  const doc1 = JSON.parse(JSON.stringify(require("./test.json")));
  const doc2 = JSON.parse(JSON.stringify(require("./test.json")));

  // 1. Add a new port to the first service in the first environment
  doc2.environments[0].services[0].ports.push({
    id: "new-port",
    port: 9999,
    protocol: "tcp",
    healthCheck: { type: "tcp" },
  });

  // 2. Remove the second service from the first environment
  doc2.environments[0].services.splice(1, 1);

  // 3. Replace a value in the second environment
  doc2.environments[1].services[0].cpu = 5;

  const plan = buildPlan(schema);
  const patcher = new SchemaPatcher({ plan });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    {
      op: "add",
      path: "/environments/0/services/0/ports/-",
      value: {
        id: "new-port",
        port: 9999,
        protocol: "tcp",
        healthCheck: { type: "tcp" },
      },
    },
    { op: "remove", path: "/environments/0/services/1" },
    { op: "replace", path: "/environments/1/services/0/cpu", value: 5 },
  ];

  const sortFn = (a: any, b: any) => a.path.localeCompare(b.path);
  patches.sort(sortFn);
  expectedPatches.sort(sortFn);

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher handles multiple removals from array with primary key", () => {
  const doc1 = {
    $schema: "https://app.flightcontrol.dev/schema.json",
    environments: [
      {
        id: "production",
        name: "NLB",
        region: "eu-west-1",
        source: {
          branch: "main",
          pr: false,
          trigger: "push",
        },
        services: [
          {
            id: "nlb-server",
            name: "NLB Server",
            type: "network-server",
            target: {
              type: "fargate",
            },
            ports: [
              {
                id: "tcp-8001",
                port: 8001,
                protocol: "tcp",
                healthCheck: {
                  type: "tcp",
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
                tls: false,
              },
              {
                id: "udp-8002",
                port: 8007,
                protocol: "udp",
                healthCheck: {
                  type: "udp",
                  tcpPort: 8001,
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
              },
            ],
            cpu: 1,
            memory: 2,
            buildType: "docker",
          },
          {
            id: "nlb-server-2",
            name: "NLB Server 2",
            type: "network-server",
            target: {
              type: "fargate",
            },
            ports: [
              {
                id: "tcp-8001",
                port: 8001,
                protocol: "tcp",
                healthCheck: {
                  type: "tcp",
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
                tls: false,
              },
              {
                id: "udp-8002",
                port: 8007,
                protocol: "udp",
                healthCheck: {
                  type: "udp",
                  tcpPort: 8001,
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
              },
            ],
            cpu: 1,
            memory: 2,
            buildType: "docker",
          },
          {
            id: "nlb-client-scheduler",
            name: "NLB Client Scheduler",
            type: "scheduler",
            cpu: 0.25,
            memory: 0.5,
            buildType: "fromService",
          },
        ],
      },
    ],
  };

  const doc2 = {
    $schema: "https://app.flightcontrol.dev/schema.json",
    environments: [
      {
        id: "production",
        name: "NLB",
        region: "eu-west-1",
        source: {
          branch: "main",
          pr: false,
          trigger: "push",
        },
        services: [
          {
            id: "nlb-server-2",
            name: "NLB Server 2",
            type: "network-server",
            target: {
              type: "fargate",
            },
            ports: [
              {
                id: "tcp-8001",
                port: 8001,
                protocol: "tcp",
                healthCheck: {
                  type: "tcp",
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
                tls: false,
              },
              {
                id: "udp-8002",
                port: 8007,
                protocol: "udp",
                healthCheck: {
                  type: "udp",
                  tcpPort: 8001,
                  timeoutSecs: 5,
                  intervalSecs: 30,
                },
              },
            ],
            cpu: 1,
            memory: 2,
            buildType: "docker",
          },
        ],
      },
    ],
  };

  const plan = buildPlan(schema);
  const patcher = new SchemaPatcher({ plan });
  const patches = patcher.createPatch(doc1, doc2);

  const expectedPatches: Operation[] = [
    { op: "remove", path: "/environments/0/services/2" },
    { op: "remove", path: "/environments/0/services/0" },
  ];

  // Sort patches by path to ensure deterministic comparison
  const sortFn = (a: any, b: any) => a.path.localeCompare(b.path);
  patches.sort(sortFn);
  expectedPatches.sort(sortFn);

  expect(patches).toEqual(expectedPatches);
});

test("SchemaPatcher correctly diffs a single service property", () => {
  const doc1 = {
    id: "nlb-server",
    name: "NLB Server",
    type: "network-server",
    target: {
      type: "fargate",
    },
    ports: [
      {
        id: "tcp-8001",
        port: 8001,
        protocol: "tcp",
        healthCheck: {
          type: "tcp",
          timeoutSecs: 5,
          intervalSecs: 30,
        },
        tls: false,
      },
      {
        id: "udp-8002",
        port: 8007,
        protocol: "udp",
        healthCheck: {
          type: "udp",
          tcpPort: 8001,
          timeoutSecs: 5,
          intervalSecs: 30,
        },
      },
    ],
    cpu: 1,
    memory: 2,
    buildType: "docker",
  };

  const doc2 = {
    id: "nlb-server",
    name: "NLB Servers",
    type: "network-server",
    target: {
      type: "fargate",
    },
    ports: [
      {
        id: "tcp-8001",
        port: 8001,
        protocol: "tcp",
        healthCheck: {
          type: "tcp",
          timeoutSecs: 5,
          intervalSecs: 30,
        },
        tls: false,
      },
      {
        id: "udp-8002",
        port: 8002,
        protocol: "udp",
        healthCheck: {
          type: "udp",
          tcpPort: 8001,
          timeoutSecs: 5,
          intervalSecs: 30,
        },
      },
      {
        id: "http-8004",
        port: 8004,
        protocol: "http",
        healthCheck: {
          type: "http",
          path: "/health",
          timeoutSecs: 5,
          intervalSecs: 30,
        },
        tls: false,
      },
    ],
    cpu: 2,
    memory: 4,
    buildType: "docker",
  };

  const plan = buildPlan(schema, { basePath: "/environments/services" });
  const patcher = new SchemaPatcher({ plan });
  const patches = patcher.createPatch(doc1, doc2);

  expect(patches).toMatchInlineSnapshot(`
    [
      {
        "op": "replace",
        "path": "/name",
        "value": "NLB Servers",
      },
      {
        "op": "remove",
        "path": "/ports/1",
      },
      {
        "op": "add",
        "path": "/ports/-",
        "value": {
          "healthCheck": {
            "intervalSecs": 30,
            "tcpPort": 8001,
            "timeoutSecs": 5,
            "type": "udp",
          },
          "id": "udp-8002",
          "port": 8002,
          "protocol": "udp",
        },
      },
      {
        "op": "add",
        "path": "/ports/-",
        "value": {
          "healthCheck": {
            "intervalSecs": 30,
            "path": "/health",
            "timeoutSecs": 5,
            "type": "http",
          },
          "id": "http-8004",
          "port": 8004,
          "protocol": "http",
          "tls": false,
        },
      },
      {
        "op": "replace",
        "path": "/cpu",
        "value": 2,
      },
      {
        "op": "replace",
        "path": "/memory",
        "value": 4,
      },
    ]
  `);
});
