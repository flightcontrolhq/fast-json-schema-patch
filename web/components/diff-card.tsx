"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import JsonDiffCodeblock from "../json-diff-codeblock"

interface DiffCardProps {
  title: string
  addCount: number
  removeCount: number
  originalObject: any
  newObject: any
  diffLines?: any // Pre-computed diff lines
  className?: string
}

export default function DiffCard({
  title,
  addCount,
  removeCount,
  originalObject,
  newObject,
  diffLines,
  className = "",
}: DiffCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  const hasChanges = addCount > 0 || removeCount > 0

  // Handle null objects by providing empty objects
  const safeOriginalObject = originalObject || {}
  const safeNewObject = newObject || {}

  return (
    <div className={`border rounded-lg overflow-hidden ${className}`} style={{ borderColor: "var(--color-grey-6)" }}>
      {/* Card Header */}
      <div
        className={`px-4 py-3 cursor-pointer hover:bg-opacity-80 transition-colors ${
          hasChanges ? "cursor-pointer" : "cursor-default"
        }`}
        style={{ backgroundColor: "var(--color-grey-2)" }}
        onClick={() => hasChanges && setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center justify-between">
          {/* Left side - Title with expand icon */}
          <div className="flex items-center gap-2">
            {hasChanges && (
              <div className="w-4 h-4 flex items-center justify-center">
                {isExpanded ? (
                  <ChevronDown size={16} style={{ color: "var(--color-grey-10)" }} />
                ) : (
                  <ChevronRight size={16} style={{ color: "var(--color-grey-10)" }} />
                )}
              </div>
            )}
            <h3 className="text-sm font-medium" style={{ color: "var(--color-grey-12)" }}>
              {title}
            </h3>
          </div>

          {/* Right side - Diff counts */}
          <div className="flex items-center gap-2">
            {removeCount > 0 && (
              <span
                className="px-2 py-1 rounded text-xs font-medium"
                style={{
                  backgroundColor: "var(--color-red-4)",
                  color: "var(--color-red-11)",
                }}
              >
                -{removeCount}
              </span>
            )}
            {addCount > 0 && (
              <span
                className="px-2 py-1 rounded text-xs font-medium"
                style={{
                  backgroundColor: "var(--color-green-4)",
                  color: "var(--color-green-11)",
                }}
              >
                +{addCount}
              </span>
            )}
            {!hasChanges && (
              <span
                className="px-2 py-1 rounded text-xs font-medium"
                style={{
                  backgroundColor: "var(--color-grey-4)",
                  color: "var(--color-grey-10)",
                }}
              >
                No changes
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Expanded Content */}
      {isExpanded && hasChanges && (
        <div className="border-t" style={{ borderTopColor: "var(--color-grey-6)" }}>
          <div className="p-4">
            <JsonDiffCodeblock
              originalJson={JSON.stringify(safeOriginalObject, null, 2)}
              newJson={JSON.stringify(safeNewObject, null, 2)}
              useFullDiff={false} // Use simple diff for cards
            />
          </div>
        </div>
      )}
    </div>
  )
}
