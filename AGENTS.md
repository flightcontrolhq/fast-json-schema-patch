# Agent Guidelines for fast-json-schema-patch

## Build/Test Commands

- `bun test` - Run all tests
- `bun test test/specific.test.ts` - Run single test file
- `bun build` - Build the project (TypeScript compilation + bundling)
- `bun run compare` - Run performance comparisons

## Code Style (Biome)

- **Indentation**: Tabs (not spaces)
- **Quotes**: Double quotes for strings
- **Imports**: Auto-organized imports enabled
- **Formatting**: Use `biome format` for consistent styling
- **Linting**: Use `biome lint` for code quality checks

## TypeScript Configuration

- **Strict mode**: Enabled with `noUncheckedIndexedAccess`
- **Module system**: ESNext with bundler resolution
- **Target**: ESNext for modern JavaScript features
- **JSX**: React JSX transform enabled

## Naming Conventions

- **Classes**: PascalCase (e.g., `JsonSchemaPatcher`, `StructuredDiff`)
- **Functions/Variables**: camelCase (e.g., `buildPlan`, `diffArray`)
- **Types/Interfaces**: PascalCase (e.g., `Operation`, `JsonValue`)
- **Constants**: camelCase for local, UPPER_CASE for module-level

## Error Handling

- Use explicit type checking before operations
- Prefer early returns over nested conditionals
- Handle undefined/null values explicitly in type guards
