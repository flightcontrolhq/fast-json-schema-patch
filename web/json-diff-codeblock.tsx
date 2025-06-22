"use client"

import type React from "react"
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light"
import { useJsonPatch, generateObjectDiff } from "./hooks/use-json-patch"

interface JsonDiffCodeblockProps {
  originalJson: string
  newJson: string
  className?: string
  style?: React.CSSProperties
  useFullDiff?: boolean
}

export default function JsonDiffCodeblock({
  originalJson,
  newJson,
  className = "",
  style,
  useFullDiff = true,
}: JsonDiffCodeblockProps) {
  // Use different logic based on useFullDiff prop
  const fullDiffResult = useJsonPatch(originalJson, newJson)

  // For simple object comparison (used in cards)
  const simpleDiff = !useFullDiff
    ? (() => {
        try {
          const originalObj = JSON.parse(originalJson)
          const newObj = JSON.parse(newJson)
          return {
            diffLines: generateObjectDiff(originalObj, newObj),
            patch: [],
            error: null,
          }
        } catch (error) {
          return {
            diffLines: { originalLines: [], newLines: [] },
            patch: [],
            error: `JSON Parse Error: ${error.message}`,
          }
        }
      })()
    : null

  const { patch, diffLines, error } = useFullDiff ? fullDiffResult : simpleDiff!

  // Show error state if there's a JSON parsing error
  if (error) {
    return (
      <div
        className={`border rounded-lg overflow-hidden ${className}`}
        style={{ borderColor: "var(--color-red-6)", ...style }}
      >
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
        </div>
      </div>
    )
  }

  const getLineStyle = (type: string) => {
    const baseStyle = {
      padding: "0.5rem 0.75rem",
      margin: "0",
      minHeight: "1.5rem",
      display: "flex",
      alignItems: "center",
    }

    switch (type) {
      case "added":
        return {
          ...baseStyle,
          backgroundColor: "var(--color-green-4)",
        }
      case "removed":
        return {
          ...baseStyle,
          backgroundColor: "var(--color-red-4)",
        }
      case "unchanged":
        return {
          ...baseStyle,
          backgroundColor: "transparent",
        }
      default:
        return baseStyle
    }
  }

  const renderSide = (lines: any[], title: string, isLeft = false) => {
    return (
      <div className="flex-1">
        {/* Column header */}
        <div
          className={`px-4 py-2 text-sm font-medium ${isLeft ? "border-r" : ""}`}
          style={{
            color: "var(--color-grey-11)",
            backgroundColor: "var(--color-grey-3)",
            borderRightColor: isLeft ? "var(--color-grey-6)" : undefined,
          }}
        >
          {title}
        </div>

        {/* Content */}
        <div className={`${isLeft ? "border-r" : ""}`} style={{ borderRightColor: "var(--color-grey-6)" }}>
          {lines.map((line, index) => (
            <div key={index} style={getLineStyle(line.type)}>
              <div className="flex w-full items-start">
                {/* Line number */}
                <span
                  className="inline-block w-12 text-right pr-3 select-none text-xs leading-6 flex-shrink-0"
                  style={{ color: "var(--color-grey-9)" }}
                >
                  {line.lineNumber}
                </span>

                {/* Change indicator */}
                <span className="w-4 flex-shrink-0 text-xs font-bold leading-6">
                  {line.type === "added" && <span style={{ color: "var(--color-green-10)" }}>+</span>}
                  {line.type === "removed" && <span style={{ color: "var(--color-red-10)" }}>-</span>}
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
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`border rounded-lg overflow-hidden ${className}`}
      style={{ borderColor: "var(--color-grey-6)", ...style }}
    >
      {/* Header with patch info - only show for full diff */}
      {useFullDiff && (
        <div
          className="px-4 py-3 border-b text-sm font-medium flex items-center justify-between"
          style={{
            backgroundColor: "var(--color-grey-2)",
            color: "var(--color-grey-12)",
            borderBottomColor: "var(--color-grey-6)",
          }}
        >
          <span>Schema-Aware JSON Diff</span>
          <span className="text-xs" style={{ color: "var(--color-grey-10)" }}>
            {patch.length} change{patch.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {/* Diff content */}
      <div className="overflow-x-auto" style={{ backgroundColor: "var(--color-grey-1)" }}>
        {diffLines && (diffLines.originalLines?.length > 0 || diffLines.newLines?.length > 0) ? (
          <div className="min-w-full font-mono text-sm flex">
            {/* Left side (original) */}
            {renderSide(diffLines.originalLines || [], "Original", true)}
            {/* Right side (new) */}
            {renderSide(diffLines.newLines || [], "Modified", false)}
          </div>
        ) : (
          <div className="p-8 text-center" style={{ color: "var(--color-grey-9)" }}>
            <div className="text-lg mb-2">✓</div>
            <div>No changes detected</div>
          </div>
        )}
      </div>

      {/* Patch operations summary - only show for full diff */}
      {useFullDiff && patch.length > 0 && (
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
              {patch.map((op, index) => (
                <div
                  key={index}
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
