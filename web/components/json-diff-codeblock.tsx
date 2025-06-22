"use client"

import { useState, useCallback } from "react"
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light"
import { useJsonPatch } from "../hooks/use-json-patch"
import type { Operation } from "../../src"

interface JsonDiffCodeblockProps {
  originalJson: string
  newJson: string
  className?: string
}

interface ExpandedSection {
  id: string
  expandedRanges: Array<{ start: number; end: number }>
}

export default function JsonDiffCodeblock({ originalJson, newJson, className = "" }: JsonDiffCodeblockProps) {
  const { patch, diffLines, error } = useJsonPatch(originalJson, newJson)
  const [expandedSections, setExpandedSections] = useState<Map<string, ExpandedSection>>(new Map())

  // Helper function to merge overlapping ranges
  const mergeRanges = useCallback((ranges: Array<{ start: number; end: number }>) => {
    if (ranges.length === 0) return []

    const sorted = ranges.sort((a, b) => a.start - b.start)
    const merged = [sorted[0]]

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i]
      const last = merged[merged.length - 1]

      if (current && last && current.start <= last.end + 1) {
        // Overlapping or adjacent ranges, merge them
        last.end = Math.max(last.end, current.end)
      } else {
        merged.push(current)
      }
    }

    return merged.filter(Boolean) as Array<{ start: number; end: number }>
  }, [])

  const expandSection = useCallback(
    (expandableId: string, direction: "up" | "down" | "all", count: number, startIndex: number, endIndex: number) => {
      setExpandedSections((prev) => {
        const newMap = new Map(prev)
        const existing = newMap.get(expandableId) || { id: expandableId, expandedRanges: [] }

        if (direction === "all") {
          // Expand everything
          existing.expandedRanges = [{ start: startIndex, end: endIndex }]
        } else if (direction === "up") {
          // Expand from the top
          const newStart = Math.max(startIndex, endIndex - count)
          const newRange = { start: newStart, end: endIndex }

          // Merge with existing ranges
          const merged = mergeRanges([...existing.expandedRanges, newRange])
          existing.expandedRanges = merged
        } else if (direction === "down") {
          // Expand from the bottom
          const newEnd = Math.min(endIndex, startIndex + count)
          const newRange = { start: startIndex, end: newEnd }

          // Merge with existing ranges
          const merged = mergeRanges([...existing.expandedRanges, newRange])
          existing.expandedRanges = merged
        }

        newMap.set(expandableId, existing)
        return newMap
      })
    },
    [mergeRanges],
  )

  const collapseSection = useCallback((expandableId: string) => {
    setExpandedSections((prev) => {
      const newMap = new Map(prev)
      newMap.delete(expandableId)
      return newMap
    })
  }, [])

  const expandAll = () => {
    const allExpandableIds = diffLines.filter((line) => line.expandableId && line.type === "ellipsis")
    setExpandedSections((prev) => {
      const newMap = new Map(prev)
      allExpandableIds.forEach((line) => {
        if (line.expandableId && line.startIndex !== undefined && line.endIndex !== undefined) {
          newMap.set(line.expandableId, {
            id: line.expandableId,
            expandedRanges: [{ start: line.startIndex, end: line.endIndex }],
          })
        }
      })
      return newMap
    })
  }

  const collapseAll = () => {
    setExpandedSections(new Map())
  }

  // Check if a line should be shown based on expanded ranges
  const isLineExpanded = (expandableId: string, lineIndex: number) => {
    const section = expandedSections.get(expandableId)
    if (!section) return false

    return section.expandedRanges.some((range) => lineIndex >= range.start && lineIndex < range.end)
  }

  // Show error state if there's a JSON parsing error
  if (error) {
    return (
      <div className={`border rounded-lg overflow-hidden ${className}`} style={{ borderColor: "var(--color-red-6)" }}>
        <div
          className="px-4 py-3 border-b text-sm font-medium flex items-center gap-2"
          style={{
            backgroundColor: "var(--color-red-2)",
            color: "var(--color-red-11)",
            borderBottomColor: "var(--color-red-6)",
          }}
        >
          <span>⚠️</span>
          <span>JSON Parse Error</span>
        </div>
        <div className="p-4" style={{ backgroundColor: "var(--color-red-2)" }}>
          <pre className="text-sm whitespace-pre-wrap" style={{ color: "var(--color-red-11)" }}>
            {error}
          </pre>
          <div className="mt-3 text-xs" style={{ color: "var(--color-red-10)" }}>
            Please check your JSON syntax. Common issues:
            <ul className="mt-1 ml-4 list-disc">
              <li>Trailing commas</li>
              <li>Missing quotes around keys</li>
              <li>Missing values after colons</li>
              <li>Unclosed brackets or braces</li>
            </ul>
          </div>
        </div>
      </div>
    )
  }

  const getLineStyle = (type: string, isParentContext?: boolean) => {
    const baseStyle: React.CSSProperties = {
      padding: "0.5rem 0.75rem",
      margin: "0",
      borderLeftWidth: "3px",
      borderLeftStyle: "solid",
      borderLeftColor: "transparent",
      minHeight: "1.5rem",
      display: "flex",
      alignItems: "center",
    }

    switch (type) {
      case "added":
        return {
          ...baseStyle,
          backgroundColor: "var(--color-green-4)",
          borderLeftColor: "var(--color-green-9)",
        }
      case "removed":
        return {
          ...baseStyle,
          backgroundColor: "var(--color-red-4)",
          borderLeftColor: "var(--color-red-9)",
        }
      case "ellipsis":
        return {
          ...baseStyle,
          color: "var(--color-grey-9)",
          fontStyle: "italic",
          justifyContent: "center",
          backgroundColor: "var(--color-grey-2)",
          borderLeftColor: "var(--color-grey-6)",
        }
      case "expand-control":
        return {
          ...baseStyle,
          justifyContent: "center",
          backgroundColor: "var(--color-blue-2)",
          borderLeftColor: "var(--color-blue-6)",
          cursor: "pointer",
          minHeight: "2rem",
        }
      case "context":
        return {
          ...baseStyle,
          backgroundColor: isParentContext ? "var(--color-blue-2)" : "transparent",
          borderLeftColor: isParentContext ? "var(--color-blue-6)" : "transparent",
        }
      default:
        return baseStyle
    }
  }

  const renderExpandControl = (line: any, index: number) => {
    const { expandableId, expandDirection, expandCount, startIndex, endIndex } = line
    const section = expandedSections.get(expandableId!)
    const isFullyExpanded = section?.expandedRanges.some(
      (range) => range.start <= startIndex! && range.end >= endIndex!,
    )

    if (isFullyExpanded) return null

    const remainingLines =
      expandDirection === "up"
        ? endIndex! -
          Math.max(
            startIndex!,
            section?.expandedRanges.reduce((max, range) => Math.max(max, range.end), startIndex!) || startIndex!,
          )
        : Math.min(
            endIndex!,
            section?.expandedRanges.reduce((min, range) => Math.min(min, range.start), endIndex!) || endIndex!,
          ) - startIndex!

    const actualExpandCount = Math.min(expandCount!, remainingLines)

    if (actualExpandCount <= 0) return null

    return (
      <button
        type="button"
        key={`expand-${expandDirection}-${index}`}
        style={getLineStyle("expand-control")}
        className="hover:bg-opacity-80 transition-colors group w-full"
        onClick={() => expandSection(expandableId!, expandDirection!, actualExpandCount, startIndex!, endIndex!)}
      >
        <div className="flex items-center gap-2 text-sm justify-center">
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            className="fill-current"
            style={{ color: "var(--color-blue-9)" }}
          >
            <title>{`Expand ${expandDirection}`}</title>
            {expandDirection === "up" ? <path d="M8 4l-4 4h8l-4-4z" /> : <path d="M8 12l4-4H4l4 4z" />}
          </svg>
          <span style={{ color: "var(--color-blue-10)" }}>
            Expand {actualExpandCount} lines {expandDirection}
          </span>
        </div>
      </button>
    )
  }

  const renderDiffLine = (line: any, index: number) => {
    if (line.type === "expand-control") {
      return renderExpandControl(line, index)
    }

    if (line.type === "ellipsis") {
      const section = expandedSections.get(line.expandableId!)
      const isFullyExpanded = section?.expandedRanges.some(
        (range) => range.start <= line.startIndex! && range.end >= line.endIndex!,
      )

      if (isFullyExpanded) {
        // Show all expanded lines
        return (
          <div key={`expanded-${index}`}>
            {line.hiddenLines
              ?.map((hiddenLine: any, hiddenIndex: number) => {
                const lineIndex = line.startIndex! + hiddenIndex
                if (isLineExpanded(line.expandableId!, lineIndex)) {
                  return renderRegularLine(hiddenLine, `expanded-${index}-${hiddenIndex}`)
                }
                return null
              })
              .filter(Boolean)}

            {/* Add collapse button */}
            <button
              type="button"
              style={getLineStyle("expand-control")}
              className="hover:bg-opacity-80 transition-colors cursor-pointer w-full"
              onClick={() => collapseSection(line.expandableId!)}
            >
              <div className="flex items-center gap-2 text-sm justify-center">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  className="fill-current"
                  style={{ color: "var(--color-grey-9)" }}
                >
                  <title>Collapse</title>
                  <path d="M8 4l-4 4h8l-4-4z" />
                </svg>
                <span style={{ color: "var(--color-grey-10)" }}>Collapse expanded lines</span>
              </div>
            </button>
          </div>
        )
      }

      // Show partially expanded lines
      const expandedLines =
        line.hiddenLines?.filter((hiddenLine: any, hiddenIndex: number) => {
          const lineIndex = line.startIndex! + hiddenIndex
          return isLineExpanded(line.expandableId!, lineIndex)
        }) || []

      const remainingCount = (line.hiddenLines?.length || 0) - expandedLines.length

      return (
        <div key={`ellipsis-${index}`}>
          {expandedLines.map((hiddenLine: any, hiddenIndex: number) =>
            renderRegularLine(hiddenLine, `partial-${index}-${hiddenIndex}`),
          )}

          {remainingCount > 0 && (
            <div style={getLineStyle("ellipsis")} className="select-none">
              <span className="text-sm">... {remainingCount} more lines ...</span>
            </div>
          )}
        </div>
      )
    }

    return renderRegularLine(line, `line-${index}`)
  }

  const renderRegularLine = (line: any, key: string) => {
    return (
      <div key={key} style={getLineStyle(line.type, line.isParentContext)} className="group">
        <div className="flex w-full items-start">
          {/* Line number */}
          <span
            className="inline-block w-12 text-right pr-3 select-none text-xs leading-6 flex-shrink-0"
            style={{ color: "var(--color-grey-9)" }}
          >
            {line.lineNumber > 0 ? line.lineNumber : ""}
          </span>

          {/* Change indicator */}
          <span className="w-4 flex-shrink-0 text-xs font-bold leading-6">
            {line.type === "added" && <span style={{ color: "var(--color-green-10)" }}>+</span>}
            {line.type === "removed" && <span style={{ color: "var(--color-red-10)" }}>-</span>}
            {line.isParentContext && <span style={{ color: "var(--color-blue-9)" }}>◦</span>}
          </span>

          {/* Code content */}
          <div className="flex-1 min-w-0">
            <SyntaxHighlighter
              language="json"
              style={{}}
              customStyle={{
                margin: 0,
                padding: 0,
                background: "transparent",
                fontSize: "14px",
                lineHeight: "1.5",
                fontFamily:
                  'ui-monospace, SFMono-Regular, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              }}
              PreTag="div"
              CodeTag="code"
            >
              {line.content}
            </SyntaxHighlighter>
          </div>
        </div>
      </div>
    )
  }

  const hasExpandableSections = diffLines.some((line) => line.expandableId)

  return (
    <div className={`border rounded-lg overflow-hidden ${className}`} style={{ borderColor: "var(--color-grey-6)" }}>
      {/* Header with patch info and expand/collapse controls */}
      <div
        className="px-4 py-3 border-b text-sm font-medium flex items-center justify-between"
        style={{
          backgroundColor: "var(--color-grey-2)",
          color: "var(--color-grey-12)",
          borderBottomColor: "var(--color-grey-6)",
        }}
      >
        <span>JSON Diff</span>
        <div className="flex items-center gap-4">
          {hasExpandableSections && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={expandAll}
                className="text-xs px-2 py-1 rounded hover:bg-opacity-80 transition-colors"
                style={{
                  color: "var(--color-blue-10)",
                  backgroundColor: "var(--color-blue-2)",
                }}
              >
                Expand All
              </button>
              <button
                type="button"
                onClick={collapseAll}
                className="text-xs px-2 py-1 rounded hover:bg-opacity-80 transition-colors"
                style={{
                  color: "var(--color-grey-10)",
                  backgroundColor: "var(--color-grey-3)",
                }}
              >
                Collapse All
              </button>
            </div>
          )}
          <span className="text-xs" style={{ color: "var(--color-grey-10)" }}>
            {patch.length} change{patch.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      {/* Diff content */}
      <div className="overflow-x-auto" style={{ backgroundColor: "var(--color-grey-1)" }}>
        {diffLines.length > 0 ? (
          <div className="min-w-full font-mono text-sm">
            {diffLines.map((line, index) => renderDiffLine(line, index))}
          </div>
        ) : (
          <div className="p-8 text-center" style={{ color: "var(--color-grey-9)" }}>
            <div className="text-lg mb-2">✓</div>
            <div>No changes detected</div>
          </div>
        )}
      </div>

      {/* Patch operations summary */}
      {patch.length > 0 && (
        <div
          className="border-t"
          style={{
            backgroundColor: "var(--color-grey-2)",
            borderTopColor: "var(--color-grey-6)",
          }}
        >
          <details className="group">
            <summary
              className="px-4 py-3 cursor-pointer hover:bg-opacity-80 text-sm font-medium flex items-center justify-between"
              style={{ color: "var(--color-grey-11)" }}
            >
              <span>RFC 6902 Patch Operations ({patch.length})</span>
              <span className="text-xs group-open:rotate-180 transition-transform">▼</span>
            </summary>
            <div className="px-4 pb-4 space-y-2">
              {patch.map((op: Operation) => (
                <div
                  key={op.path}
                  className="font-mono text-xs flex items-start gap-3 p-3 rounded"
                  style={{ backgroundColor: "var(--color-grey-1)" }}
                >
                  <span
                    className="inline-block w-16 font-bold uppercase flex-shrink-0"
                    style={{
                      color:
                        op.op === "add"
                          ? "var(--color-green-10)"
                          : op.op === "remove"
                            ? "var(--color-red-10)"
                            : op.op === "replace"
                              ? "var(--color-orange-10)"
                              : "var(--color-blue-10)",
                    }}
                  >
                    {op.op}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div style={{ color: "var(--color-grey-11)" }} className="break-all">
                      <strong>Path:</strong> {op.path}
                    </div>
                    {op.value !== undefined && (
                      <div style={{ color: "var(--color-grey-10)" }} className="mt-1 break-all">
                        <strong>Value:</strong>{" "}
                        <pre className="inline whitespace-pre-wrap">
                          {typeof op.value === "string" ? `"${op.value}"` : JSON.stringify(op.value, null, 2)}
                        </pre>
                      </div>
                    )}
                    {op.from !== undefined && (
                      <div style={{ color: "var(--color-grey-10)" }} className="mt-1 break-all">
                        <strong>From:</strong> {op.from}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  )
} 