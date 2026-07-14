/**
 * test/conformance.test.ts — runs every vector under spec/vectors/{diff,apply,plan,invert}/*.json
 * against the TypeScript reference implementation, gated exactly as SPEC.md §10 defines.
 *
 * This suite is the executable counterpart to spec/vectors/README.md: a Go (or any other
 * language) implementer should be able to read SPEC.md §10 + spec/vectors/README.md and
 * reproduce every assertion made here without reading this file. Conversely, if this file
 * asserts something spec/vectors/README.md does not document, that is a spec gap to fix, not
 * a private test detail.
 *
 * Gates implemented (SPEC.md references):
 *   diff   §10.1/§10.3   buildPlan + JsonSchemaPatcher.execute -> structural op equality (a)
 *                         AND the strategy's round-trip contract (b)
 *   apply  §10.2/§10.2.1 applyPatch -> expected value, or JsonPatchError{code, operationIndex}
 *   plan   §10.6/§10.6.1 buildPlan -> path-set + per-path {primaryKey,strategy,requiredFields,
 *                         hashFields} match (field arrays order-insensitive)
 *   invert §10.7/§10.7.2 invertPatch -> structural equality (a) AND double-apply identity (b)
 *
 * Round-trip contract selection (§10.3.1) is NOT carried in the vector wire format (see
 * spec/vectors/README.md "Vector record formats" — a diff record has no `roundtrip` field;
 * spec/vectors/generate.ts's internal `DiffSpec.roundtrip` is a generation-time self-check
 * that is deliberately not persisted). This suite re-derives which contract applies the same
 * way §10.3.1 defines it: exact reconstruction is tried first (it satisfies BOTH the exact and
 * the multiset contract, since exact implies multiset), and the weaker multiset contract is
 * accepted ONLY as a fallback, and only when justified — i.e. only when the vector's own plan
 * (built from its `schema`/`options`) contains a `primaryKey`-strategy path and `emitMoves` is
 * not enabled (§10.4.4 upgrades primaryKey to an exact contract under `emitMoves`). See
 * `checkRoundTrip` below.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Plan } from "../src/core/buildPlan";
import type { PatchErrorCode } from "../src/index";
import {
	applyPatch,
	buildPlan,
	invertPatch,
	JsonPatchError,
	JsonSchemaPatcher,
} from "../src/index";
import type { JsonValue, Operation } from "../src/types";

// ---------------------------------------------------------------------------
// JSON-value equality helpers (§2.4.1), and the §10.3.1 multiset canonicalizer.
// Deliberately independent of the reference's memoised deepEqual (that's part
// of what's under test) — mirrors spec/vectors/generate.ts exactly so this
// suite and the generator's own self-checks agree on what "equal" means.
// ---------------------------------------------------------------------------
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;
	const aArr = Array.isArray(a);
	const bArr = Array.isArray(b);
	if (aArr !== bArr) return false;
	if (aArr && bArr) {
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
		return true;
	}
	if (typeof a === "object" && typeof b === "object") {
		const ao = a as Record<string, unknown>;
		const bo = b as Record<string, unknown>;
		const ak = Object.keys(ao);
		const bk = Object.keys(bo);
		if (ak.length !== bk.length) return false;
		for (const k of ak) {
			if (!Object.hasOwn(bo, k)) return false;
			if (!deepEqual(ao[k], bo[k])) return false;
		}
		return true;
	}
	return false;
}

/** Recursively sort arrays (by canonical JSON) and object keys — the §10.3.1
 *  "multiset-equal with canonical survivor+append order" comparator, used only
 *  as the fallback contract for primaryKey (non-move) diffs. */
function canonSort(v: JsonValue): JsonValue {
	if (Array.isArray(v)) {
		const arr = v.map(canonSort);
		arr.sort((x, y) => {
			const sx = JSON.stringify(x);
			const sy = JSON.stringify(y);
			return sx < sy ? -1 : sx > sy ? 1 : 0;
		});
		return arr;
	}
	if (v && typeof v === "object") {
		const o: Record<string, JsonValue> = {};
		for (const k of Object.keys(v).sort())
			o[k] = canonSort((v as Record<string, JsonValue>)[k] as JsonValue);
		return o;
	}
	return v;
}

function hasPrimaryKeyStrategy(plan: Plan): boolean {
	for (const ap of plan.values()) if (ap.strategy === "primaryKey") return true;
	return false;
}

/**
 * §10.3.1 round-trip gate. `applied` is the result of applying the ops under
 * test (already asserted structurally equal to `expectedPatch`) to `original`.
 * Exact reconstruction is checked first and, if it holds, always satisfies the
 * gate (exact => multiset). Only if exact fails do we fall back to the
 * multiset contract, and only when the vector's plan justifies it (a
 * primaryKey-strategy path exists and `emitMoves` is not enabled, per
 * §10.4.4) — otherwise this is a genuine round-trip failure.
 */
function checkRoundTrip(
	vectorName: string,
	applied: JsonValue,
	modified: JsonValue,
	plan: Plan,
	emitMovesEnabled: boolean,
): void {
	if (deepEqual(applied, modified)) return;
	const multisetJustified = hasPrimaryKeyStrategy(plan) && !emitMovesEnabled;
	if (!multisetJustified) {
		throw new Error(
			`${vectorName}: round-trip failed exact reconstruction (§7) and the vector's plan shows ` +
				`no primaryKey (non-emitMoves) strategy to justify falling back to the multiset contract ` +
				`(§10.3.1). applied=${JSON.stringify(applied)}\nmodified=${JSON.stringify(modified)}`,
		);
	}
	expect(canonSort(applied)).toEqual(canonSort(modified));
}

// ---------------------------------------------------------------------------
// Vector record shapes (spec/vectors/README.md). Loosely typed — the vectors
// are the oracle, not compile-time types.
// ---------------------------------------------------------------------------
interface CapsBlock {
	includeOldValue?: boolean;
	emitMoves?: boolean;
	wholesaleReplaceFallback?: boolean;
}
interface DiffOptionsBlock {
	primaryKeyMap?: Record<string, string>;
	basePath?: string;
	primaryKeyCandidates?: string[];
	capabilities?: CapsBlock;
}
interface DiffVector {
	name: string;
	comment?: string;
	schema?: object | null;
	options?: DiffOptionsBlock;
	original: JsonValue;
	modified: JsonValue;
	expectedPatch: Operation[];
}

interface ApplyOptionsBlock {
	validateOldValues?: boolean;
	cloneValues?: boolean;
	cloneResult?: boolean;
}
interface ApplyVector {
	name: string;
	comment?: string;
	doc: JsonValue;
	patch: Operation[];
	options?: ApplyOptionsBlock;
	expected?: JsonValue;
	error?: { code: PatchErrorCode; index: number };
}

interface PlanOptionsBlock {
	primaryKeyMap?: Record<string, string>;
	basePath?: string;
	primaryKeyCandidates?: string[];
}
interface PlanExpectedEntry {
	path: string;
	primaryKey: string | null;
	strategy: "primaryKey" | "unique" | "lcs";
	requiredFields: string[];
	hashFields: string[];
}
interface PlanVector {
	name: string;
	comment?: string;
	schema: object;
	options?: PlanOptionsBlock;
	expectedPlan: PlanExpectedEntry[];
}

interface InvertVector {
	name: string;
	comment?: string;
	document: JsonValue;
	patch: Operation[];
	expectedInverse: Operation[];
}

// ---------------------------------------------------------------------------
// Vector loading. Each *.json under spec/vectors/<category>/ is a flat array
// of records for that category (spec/vectors/README.md "Layout").
// ---------------------------------------------------------------------------
function loadCategory<T>(
	category: "diff" | "apply" | "plan" | "invert",
): Array<{ file: string; vector: T }> {
	const glob = new Bun.Glob(`spec/vectors/${category}/*.json`);
	const out: Array<{ file: string; vector: T }> = [];
	const files = [...glob.scanSync(".")].sort();
	for (const file of files) {
		const records = JSON.parse(readFileSync(file, "utf8")) as T[];
		for (const vector of records) out.push({ file, vector });
	}
	return out;
}

const diffVectors = loadCategory<DiffVector>("diff");
const applyVectors = loadCategory<ApplyVector>("apply");
const planVectors = loadCategory<PlanVector>("plan");
const invertVectors = loadCategory<InvertVector>("invert");

// Sanity: every name unique across its category (README: "unique across the
// whole suite"), and we actually found vectors (catches a bad glob silently
// yielding zero files rather than a green-but-empty suite).
function assertUniqueNames(
	entries: Array<{ file: string; vector: { name: string } }>,
	category: string,
) {
	const seen = new Map<string, string>();
	for (const { file, vector } of entries) {
		const prior = seen.get(vector.name);
		if (prior) {
			throw new Error(
				`duplicate ${category} vector name "${vector.name}" in ${file} (first seen in ${prior})`,
			);
		}
		seen.set(vector.name, file);
	}
}
assertUniqueNames(diffVectors, "diff");
assertUniqueNames(applyVectors, "apply");
assertUniqueNames(planVectors, "plan");
assertUniqueNames(invertVectors, "invert");

// ---------------------------------------------------------------------------
// diff vectors (§10.1, §10.3)
// ---------------------------------------------------------------------------
describe("conformance: diff vectors (SPEC §10.1/§10.3)", () => {
	test("vector suite is non-empty", () => {
		expect(diffVectors.length).toBeGreaterThan(0);
	});

	for (const { vector } of diffVectors) {
		test(vector.name, () => {
			const planOpts = vector.options ?? {};
			const plan: Plan = vector.schema
				? buildPlan({
						schema: vector.schema as never,
						primaryKeyMap: planOpts.primaryKeyMap,
						basePath: planOpts.basePath,
						primaryKeyCandidates: planOpts.primaryKeyCandidates,
					})
				: new Map();
			const caps = planOpts.capabilities ?? {};
			const patcher = new JsonSchemaPatcher({
				plan,
				includeOldValue: caps.includeOldValue,
				emitMoves: caps.emitMoves,
				wholesaleReplaceFallback: caps.wholesaleReplaceFallback,
			});

			const actualPatch = patcher.execute({
				original: vector.original,
				modified: vector.modified,
			});

			// (b) §10.3.2 structural op equality: same length, same ORDERED op
			// sequence, each op equal by op/path/value/oldValue/from under deep
			// JSON equality. bun's toEqual is exactly this: recursive structural
			// equality that is key-order-insensitive on objects (matches §10.3.3,
			// "object key order within values is insignificant") and index-order-
			// sensitive on arrays (matches "op ordering in the sequence IS
			// significant").
			expect(actualPatch).toEqual(
				vector.expectedPatch as unknown as typeof actualPatch,
			);

			// (a) §10.3.1 round-trip, per the strategy's contract (§7).
			const applied = applyPatch(vector.original, actualPatch);
			checkRoundTrip(
				vector.name,
				applied,
				vector.modified,
				plan,
				caps.emitMoves === true,
			);
		});
	}
});

// ---------------------------------------------------------------------------
// apply vectors (§10.2, §10.2.1)
// ---------------------------------------------------------------------------
describe("conformance: apply vectors (SPEC §10.2/§10.2.1)", () => {
	test("vector suite is non-empty", () => {
		expect(applyVectors.length).toBeGreaterThan(0);
	});

	for (const { vector } of applyVectors) {
		test(vector.name, () => {
			const hasExpected = vector.expected !== undefined;
			const hasError = vector.error !== undefined;
			if (hasExpected === hasError) {
				throw new Error(
					`${vector.name}: apply vector must have exactly one of expected/error`,
				);
			}

			if (vector.error) {
				let thrown: unknown;
				try {
					applyPatch(vector.doc, vector.patch, vector.options ?? {});
				} catch (e) {
					thrown = e;
				}
				if (!(thrown instanceof JsonPatchError)) {
					throw new Error(
						`${vector.name}: expected applyPatch to throw JsonPatchError{code:${vector.error.code}}, ` +
							`but it ${thrown === undefined ? "did not throw" : `threw ${String(thrown)}`}`,
					);
				}
				expect(thrown.code).toBe(vector.error.code);
				expect(thrown.operationIndex).toBe(vector.error.index);
			} else {
				const result = applyPatch(
					vector.doc,
					vector.patch,
					vector.options ?? {},
				);
				expect(result).toEqual(vector.expected as JsonValue);
			}
		});
	}
});

// ---------------------------------------------------------------------------
// plan-snapshot vectors (§10.6, §10.6.1)
// ---------------------------------------------------------------------------
function sortFields(fields: string[]): string[] {
	return [...fields].sort();
}
function normalizePlanEntries(
	entries: PlanExpectedEntry[],
): PlanExpectedEntry[] {
	return entries
		.map((e) => ({
			...e,
			requiredFields: sortFields(e.requiredFields),
			hashFields: sortFields(e.hashFields),
		}))
		.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe("conformance: plan-snapshot vectors (SPEC §10.6/§10.6.1)", () => {
	test("vector suite is non-empty", () => {
		expect(planVectors.length).toBeGreaterThan(0);
	});

	for (const { vector } of planVectors) {
		test(vector.name, () => {
			const planOpts = vector.options ?? {};
			const plan = buildPlan({
				schema: vector.schema as never,
				primaryKeyMap: planOpts.primaryKeyMap,
				basePath: planOpts.basePath,
				primaryKeyCandidates: planOpts.primaryKeyCandidates,
			});
			const actual: PlanExpectedEntry[] = [...plan.entries()].map(
				([path, ap]) => ({
					path,
					primaryKey: ap.primaryKey ?? null,
					strategy: ap.strategy ?? "lcs",
					requiredFields: ap.requiredFields ? [...ap.requiredFields] : [],
					hashFields: ap.hashFields ? [...ap.hashFields] : [],
				}),
			);

			// §10.6.1: path set matches, and per path primaryKey/strategy/
			// requiredFields/hashFields match; both the entry list and the two
			// field arrays are order-insensitive (sort before compare).
			expect(normalizePlanEntries(actual)).toEqual(
				normalizePlanEntries(vector.expectedPlan),
			);
		});
	}
});

// ---------------------------------------------------------------------------
// invert vectors (§10.7, §10.7.2)
// ---------------------------------------------------------------------------
describe("conformance: invert vectors (SPEC §10.7/§10.7.2)", () => {
	test("vector suite is non-empty", () => {
		expect(invertVectors.length).toBeGreaterThan(0);
	});

	for (const { vector } of invertVectors) {
		test(vector.name, () => {
			const actualInverse = invertPatch(vector.document, vector.patch);

			// (a) §10.7.2(a): structural inverse equality, same relation as §10.3.2.
			expect(actualInverse).toEqual(
				vector.expectedInverse as unknown as typeof actualInverse,
			);

			// (b) §10.7.2(b): double-apply identity, using expectedInverse exactly
			// as the spec text states (applyPatch(applyPatch(document, patch), expectedInverse)).
			const forward = applyPatch(vector.document, vector.patch);
			const back = applyPatch(forward, vector.expectedInverse);
			expect(back).toEqual(vector.document);
		});
	}
});
