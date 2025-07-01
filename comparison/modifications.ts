import { faker } from "@faker-js/faker";
import { generateUniqueServiceId } from "./data-generators";

export const modifications = [
    // SIMPLE MODIFICATIONS (1-30) - Basic property changes
    {
      name: "Change environment name",
      complexity: 2, // Single property change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) env.name = faker.lorem.words(2);
      },
    },
    {
      name: "Change environment region",
      complexity: 2, // Single property change
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
      complexity: 3, // Single property change with potential cascading effects
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env) env.id = faker.lorem.slug();
      },
    },
    {
      name: "Change source branch",
      complexity: 2, // Single nested property change
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
      complexity: 2, // Single nested property change
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.source)
          env.source.trigger = faker.helpers.arrayElement(["push", "manual"]);
      },
    },
    {
      name: "Change service ID",
      complexity: 4, // Service property change with high impact
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
      complexity: 3, // Service property change
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
      complexity: 3, // Resource allocation change
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
      complexity: 3, // Resource allocation change
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
      complexity: 2, // Simple boolean toggle
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
      complexity: 3, // Resource allocation change
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
      complexity: 4, // Scaling configuration change
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
      complexity: 4, // Scaling configuration change
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
      complexity: 2, // Simple configuration change
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
      complexity: 3, // Build configuration change
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
      complexity: 5, // Significant build configuration change
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
      complexity: 3, // Docker configuration change
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
      complexity: 3, // Docker configuration change
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
      complexity: 4, // Security configuration change
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
      complexity: 3, // Health monitoring configuration
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
      complexity: 3, // Health monitoring configuration
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
      complexity: 3, // Health monitoring configuration
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
      complexity: 3, // Health monitoring configuration
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
      complexity: 4, // Network configuration change
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
      complexity: 3, // Load balancer configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service) service.stickySessionsEnabled = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Change sticky sessions duration",
      complexity: 3, // Load balancer configuration
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
      complexity: 3, // CDN configuration
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
      complexity: 3, // CDN configuration
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(env.services);
          if (service)
            service.cloudfrontAutoCacheInvalidation = faker.datatype.boolean();
        }
      },
    },
    {
      name: "Add single environment variable",
      complexity: 5, // Object creation + property addition
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
      complexity: 4, // Property deletion
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
      complexity: 25, // Create complete service object with 10+ properties
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
      complexity: 20, // Create service object with 7+ properties
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
      complexity: 22, // Create database service with 8+ properties
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
      complexity: 18, // Create static service with 6+ properties
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
      complexity: 20, // Create cache service with 7+ properties
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
      complexity: 15, // Array splice operation with potential cascading effects
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
      complexity: 12, // Array shuffle operation affecting multiple services
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 1) {
          env.services = faker.helpers.shuffle(env.services);
        }
      },
    },
    {
      name: "Add dependency between services",
      complexity: 8, // Add array property and push dependency
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
      complexity: 6, // Delete property
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
      complexity: 12, // Create object with 3 nested properties
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
      complexity: 7, // Modify 2 nested properties
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
      complexity: 8, // Create nested object with type property
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
      complexity: 10, // Create nested object with 2 properties
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
      complexity: 11, // Create nested object with 3 properties
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
      complexity: 6, // Create array with 1 element
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
      complexity: 8, // Add 2 properties
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
      complexity: 4, // Add single property
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
      complexity: 8, // Add 2 properties
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
      complexity: 8, // Create nested object with type
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
      complexity: 11, // Modify 3 properties of specific service type
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
      complexity: 18, // Create complex port object with nested healthCheck and push to array
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
      complexity: 12, // Modify 1 property + 2 nested properties conditionally
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
      complexity: 25, // Auto-generated based on operation complexity
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
      complexity: 60, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 45, // Auto-generated based on operation complexity
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
      complexity: 45, // Auto-generated based on operation complexity
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
      complexity: 20, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const service: any = faker.helpers.arrayElement(
            env.services.filter((s: any) => ["web", "worker"].includes(s.type))
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 10, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 10, // Auto-generated based on operation complexity
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
      complexity: 75, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length >= 3) {
          const services = faker.helpers.shuffle([...env.services]).slice(0, 3);

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
      complexity: 75, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const scalingFactor = faker.number.float({ min: 0.5, max: 2.0 });

          env.services.forEach((service: any) => {
            if (service.cpu)
              service.cpu = Math.max(0.125, service.cpu * scalingFactor);
            if (service.memory)
              service.memory = Math.max(0.125, service.memory * scalingFactor);
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
      complexity: 65, // Auto-generated based on operation complexity
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
      complexity: 65, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 65, // Auto-generated based on operation complexity
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
      complexity: 45, // Auto-generated based on operation complexity
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
      complexity: 65, // Auto-generated based on operation complexity
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
                      Resource: [`arn:aws:s3:::${s3Service.bucketNameBase}/*`],
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
      complexity: 45, // Auto-generated based on operation complexity
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
      complexity: 15, // Auto-generated based on operation complexity
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
      complexity: 15, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const rdsService: any = env.services.find(
            (s: any) => s.type === "rds"
          );
          if (rdsService) {
            rdsService.connectionStringEnvVarName = faker.helpers.arrayElement([
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 65, // Auto-generated based on operation complexity
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
      complexity: 15, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
      modify: (doc: any) => {
        const env: any = faker.helpers.arrayElement(doc.environments);
        if (env && env.services.length > 0) {
          const s3Service: any = env.services.find((s: any) => s.type === "s3");
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
      complexity: 45, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 15, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 25, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
      complexity: 8, // Auto-generated based on operation complexity
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
      complexity: 35, // Auto-generated based on operation complexity
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
            rdsService.deleteBackupsWithRdsDeletion = faker.datatype.boolean();

            if (rdsService.port === undefined) {
              rdsService.port = rdsService.engine === "postgres" ? 5432 : 3306;
            }
          }
        }
      },
    },
    {
      name: "Add comprehensive service with all features",
      complexity: 65, // Auto-generated based on operation complexity
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