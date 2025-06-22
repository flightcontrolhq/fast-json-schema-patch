"use client"

import { useState, useId } from "react"
import JsonDiffCodeblock from "./components/json-diff-codeblock"

const originalJsonExample = `{
  "name": "John Doe",
  "age": 30,
  "email": "john@example.com",
  "address": {
    "street": "123 Main St",
    "city": "New York",
    "zipCode": "10001"
  },
  "hobbies": ["reading", "swimming"],
  "isActive": true,
  "metadata": {
    "createdAt": "2023-01-01",
    "updatedAt": "2023-06-01"
  }
}`

const newJsonExample = `{
  "name": "John Smith",
  "age": 31,
  "email": "john.smith@example.com",
  "address": {
    "street": "456 Oak Ave",
    "city": "New York",
    "zipCode": "10001",
    "country": "USA"
  },
  "hobbies": ["reading", "swimming", "cycling"],
  "isActive": true,
  "metadata": {
    "createdAt": "2023-01-01",
    "updatedAt": "2023-12-01"
  },
  "preferences": {
    "theme": "dark",
    "notifications": true
  }
}`

export default function Demo() {
  const [originalJson, setOriginalJson] = useState(originalJsonExample)
  const [newJson, setNewJson] = useState(newJsonExample)
  const originalId = useId()
  const newId = useId()

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold mb-4" style={{ color: "var(--color-grey-12)" }}>
          JSON Diff Codeblock Demo
        </h1>
        <p className="text-sm mb-6" style={{ color: "var(--color-grey-11)" }}>
          Compare two JSON objects and see the differences with RFC 6902 patch operations.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <div>
          <label htmlFor={originalId} className="block text-sm font-medium mb-2" style={{ color: "var(--color-grey-12)" }}>
            Original JSON
          </label>
          <textarea
            id={originalId}
            value={originalJson}
            onChange={(e) => setOriginalJson(e.currentTarget.value)}
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
          <label htmlFor={newId} className="block text-sm font-medium mb-2" style={{ color: "var(--color-grey-12)" }}>
            New JSON
          </label>
          <textarea
            id={newId}
            value={newJson}
            onChange={(e) => setNewJson(e.currentTarget.value)}
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

      <JsonDiffCodeblock
        originalJson={originalJson}
        newJson={newJson}
        className="border"
      />
    </div>
  )
}
