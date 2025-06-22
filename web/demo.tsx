"use client"

import { useState } from "react"
import { useJsonPatch } from "./hooks/use-json-patch"
import DiffCard from "./components/diff-card"

const originalJsonExample = `{
  "$schema": "https://app.flightcontrol.dev/schema.json",
  "environments": [
    {
      "id": "production",
      "name": "NLB",
      "region": "eu-west-1",
      "source": {
        "branch": "main",
        "pr": false,
        "trigger": "push"
      },
      "services": [
        {
          "id": "nlb-server",
          "name": "NLB Server",
          "type": "network-server",
          "target": {
            "type": "fargate"
          },
          "ports": [
            {
              "id": "tcp-8001",
              "port": 8001,
              "protocol": "tcp",
              "healthCheck": {
                "type": "tcp",
                "timeoutSecs": 5,
                "intervalSecs": 30
              },
              "tls": false
            },
            {
              "id": "udp-8002",
              "port": 8007,
              "protocol": "udp",
              "healthCheck": {
                "type": "udp",
                "tcpPort": 8001,
                "timeoutSecs": 5,
                "intervalSecs": 30
              }
            }
          ],
          "cpu": 1,
          "memory": 2,
          "buildType": "docker"
        },
        {
          "id": "nlb-client-scheduler",
          "name": "NLB Client Scheduler",
          "type": "scheduler",
          "cpu": 0.25,
          "memory": 0.5,
          "buildType": "fromService"
        }
      ]
    }
  ]
}`

const newJsonExample = `{
  "$schema": "https://app.flightcontrol.dev/schema.json",
  "environments": [
    {
      "id": "production",
      "name": "NLB",
      "region": "eu-west-1",
      "source": {
        "branch": "main",
        "pr": false,
        "trigger": "push"
      },
      "services": [
        {
          "id": "nlb-server",
          "name": "NLB Server",
          "type": "network-server",
          "target": {
            "type": "fargate"
          },
          "ports": [
            {
              "id": "tcp-8001",
              "port": 8001,
              "protocol": "tcp",
              "healthCheck": {
                "type": "tcp",
                "timeoutSecs": 5,
                "intervalSecs": 30
              },
              "tls": false
            },
            {
              "id": "udp-8002",
              "port": 8002,
              "protocol": "udp",
              "healthCheck": {
                "type": "udp",
                "tcpPort": 8001,
                "timeoutSecs": 5,
                "intervalSecs": 30
              }
            },
            {
              "id": "http-8004",
              "port": 8004,
              "protocol": "http",
              "healthCheck": {
                "type": "http",
                "path": "/health",
                "timeoutSecs": 5,
                "intervalSecs": 30
              },
              "tls": false
            }
          ],
          "cpu": 2,
          "memory": 4,
          "buildType": "docker"
        }
      ]
    }
  ]
}`

export default function Demo() {
  const [originalJson, setOriginalJson] = useState(originalJsonExample)
  const [newJson, setNewJson] = useState(newJsonExample)

  const { environmentDiff, serviceDiffs, error } = useJsonPatch(originalJson, newJson)

  if (error) {
    return (
      <div className="max-w-6xl mx-auto p-6">
        <div
          className="border rounded-lg p-4"
          style={{
            borderColor: "var(--color-red-6)",
            backgroundColor: "var(--color-red-2)",
          }}
        >
          <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--color-red-11)" }}>
            Error
          </h2>
          <pre className="text-sm whitespace-pre-wrap" style={{ color: "var(--color-red-11)" }}>
            {error}
          </pre>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-4" style={{ color: "var(--color-grey-12)" }}>
          Schema-Aware JSON Diff - Card View
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--color-grey-11)" }}>
          Environment and service-level changes with expandable diff views.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--color-grey-12)" }}>
            Original JSON
          </label>
          <textarea
            value={originalJson}
            onChange={(e) => setOriginalJson(e.target.value)}
            className="w-full h-64 p-3 border rounded-lg font-mono text-sm resize-none"
            style={{
              backgroundColor: "var(--color-grey-1)",
              borderColor: "var(--color-grey-6)",
              color: "var(--color-grey-12)",
            }}
            placeholder="Enter original JSON..."
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2" style={{ color: "var(--color-grey-12)" }}>
            New JSON
          </label>
          <textarea
            value={newJson}
            onChange={(e) => setNewJson(e.target.value)}
            className="w-full h-64 p-3 border rounded-lg font-mono text-sm resize-none"
            style={{
              backgroundColor: "var(--color-grey-1)",
              borderColor: "var(--color-grey-6)",
              color: "var(--color-grey-12)",
            }}
            placeholder="Enter new JSON..."
          />
        </div>
      </div>

      {/* Environment Card */}
      {environmentDiff && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-grey-12)" }}>
            Environment Configuration
          </h2>
          <DiffCard
            title={environmentDiff.environmentName}
            addCount={environmentDiff.addCount}
            removeCount={environmentDiff.removeCount}
            originalObject={environmentDiff.originalEnvironment}
            newObject={environmentDiff.newEnvironment}
            diffLines={environmentDiff.diffLines}
          />
        </div>
      )}

      {/* Services Cards */}
      {serviceDiffs.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-grey-12)" }}>
            Services
          </h2>
          <div className="space-y-3">
            {serviceDiffs.map((serviceDiff, index) => (
              <DiffCard
                key={serviceDiff.serviceId}
                title={serviceDiff.serviceName}
                addCount={serviceDiff.addCount}
                removeCount={serviceDiff.removeCount}
                originalObject={serviceDiff.originalService}
                newObject={serviceDiff.newService}
                diffLines={serviceDiff.diffLines}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
