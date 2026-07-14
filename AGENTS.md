# Agent Guidelines for fast-json-schema-patch

## Build/Test Commands

- `bun test` - Run all tests
- `bun test test/specific.test.ts` - Run single test file
- `bun run build` - Build the project (`tsc` type-check, then `tsdown` bundles `dist/`)
- `bun run compare` - Run performance comparisons

## Code Style

- **Indentation**: 2 spaces (the actual convention across `src/`; `biome.json` declares
  `indentStyle: "tab"`, but the source tree does not conform to it — `biome check` reports
  formatting diffs on every file. Match the surrounding file's style, not `biome.json`.)
- **Quotes**: Double quotes for strings (this one *is* consistently followed)
- **JSX**: Not used anywhere in this codebase (no `.tsx` files) — `tsconfig.json` sets
  `"jsx": "react-jsx"` only because it's part of bun's default template, not because any
  code depends on it.
- **Imports**: Prefer organized/grouped imports, but this is not currently enforced by a
  passing `biome check` (see above).

## TypeScript Configuration

- **Strict mode**: Enabled with `noUncheckedIndexedAccess`
- **Module system**: ESNext with bundler resolution
- **Target**: ESNext for modern JavaScript features

## Naming Conventions

- **Classes**: PascalCase (e.g., `JsonSchemaPatcher`, `StructuredDiff`)
- **Functions/Variables**: camelCase (e.g., `buildPlan`, `diffArray`)
- **Types/Interfaces**: PascalCase (e.g., `Operation`, `JsonValue`)
- **Constants**: camelCase for local, UPPER_CASE for module-level

## Error Handling

- Use explicit type checking before operations
- Prefer early returns over nested conditionals
- Handle undefined/null values explicitly in type guards
