# Contributing

## Dev loop

This repo uses [Bun](https://bun.sh) for everything — install, test, and build.

```sh
bun install          # install dependencies
bun test              # run the full test suite
bun test test/foo.test.ts   # run a single test file
bunx tsc --noEmit     # typecheck without emitting
bun run build         # tsc + tsdown -> dist/ (two entries: root + ./aggregators)
bun run check-exports  # attw --pack . — validates the published package's
                        # module resolution (ESM/CJS/node10/bundler) for
                        # every exports subpath
bunx biome ci src test schema --formatter-enabled=false --assist-enabled=false
                        # the lint scope CI runs (see below)
```

Before opening a PR, make sure `bun test`, `bunx tsc --noEmit`, and `bun run build && bun run
check-exports` are all clean — CI runs exactly these.

### Linting

`biome.json` configures tab indentation, but most of the existing source predates that and is
2-space. Reformatting the whole tree is a separate, deliberate cleanup, not something to fold
into an unrelated PR. CI therefore only runs biome's *linter* (correctness/style rules) against
`src/`, `test/`, and `schema/`, with the formatter and import-organizer checks disabled
(`--formatter-enabled=false --assist-enabled=false`). `comparison/` (a benchmarking/demo tool,
never published) is excluded entirely — it carries its own pre-existing debt. Please still run
`bunx biome format --write <files-you-touched>` locally if you're comfortable reformatting just
your own diff to tabs; don't reformat unrelated lines.

### Package exports

The package publishes two subpaths: `.` (`JsonSchemaPatcher`, `buildPlan`, `applyPatch`/
`invertPatch`/`toRfc6902`, plus a back-compat `StructuredDiff` re-export) and `./aggregators`
(`StructuredDiff` and its types — the human-readable-diff formatting layer). If you add a new
public export, decide which entry it belongs on (`src/index.ts` vs. `src/aggregators/index.ts`)
and re-run `bun run build && bun run check-exports` — `check-exports` (attw) must stay green on
**all four** resolution modes (node10, node16-CJS, node16-ESM, bundler) for **both** subpaths.

## Spec-first rule for semantic changes

[`SPEC.md`](./SPEC.md) is the normative description of diff/apply/invert behavior — it exists so
independent implementations (e.g. a port to another language) produce byte-identical output.

**Any change that alters diff, apply, or invert semantics — new capability, changed default,
bug fix that changes emitted output, new array strategy, etc. — MUST update `SPEC.md` and its
conformance vectors (§10: diff/apply/invert vector formats and the pass/fail gate) in the
*same* PR as the behavior change.** A behavior change without a corresponding spec/vector update
will be asked to add one before merge. Pure refactors, performance work, and packaging/tooling
changes that provably do not change output (see `SPEC.md` §2.4, output-neutrality) don't need a
spec update, but say so explicitly in the PR description and show how you verified byte-identical
output (e.g. a snapshot diff or a byte-stability test).

## Releasing (changesets)

This repo uses [Changesets](https://github.com/changesets/changesets) for versioning and
changelog generation.

1. After making a user-facing change, run `bunx changeset` and describe the change (pick
   `patch`/`minor`/`major` per semver — this is a public npm package, so follow normal semver
   rules for the `.` and `./aggregators` exports). This writes a markdown file under
   `.changeset/`; commit it alongside your change.
2. Maintainers run `bun run release`, which runs the test suite, builds, bumps versions via
   `changeset version`, and publishes via `changeset publish`. `prepublishOnly` independently
   guards `npm publish`/`bun publish` with `bun test && bun run build && bun run check-exports`,
   so a stale or broken `dist/` can never be published even if `release` is skipped.

## Reporting issues

Open an issue at <https://github.com/flightcontrolhq/fast-json-schema-patch/issues>. For
behavior questions ("should this emit a `move` here?"), please cite the relevant `SPEC.md`
section if you can — it's the fastest way to tell a bug from a documented tradeoff.
