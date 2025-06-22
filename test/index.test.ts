import { expect, test } from "bun:test";
import { SchemaPatcher, type Operation, buildPlan } from "../src/index";
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

  const patcher = new SchemaPatcher({ schema });
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

  const patcher = new SchemaPatcher({ schema });
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

  const patcher = new SchemaPatcher({ schema });
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

  const patcher = new SchemaPatcher({ schema });
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

  const patcher = new SchemaPatcher({ schema });
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

  const patcher = new SchemaPatcher({ schema });
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
