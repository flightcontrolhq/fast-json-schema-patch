/**
 * comparison/bench-v2/libs.ts — the library adapter registry shared by the
 * in-process wall-time/correctness runner (run.ts) and the subprocess
 * peak-memory harness (mem-probe.ts).
 *
 * Every competitor is wrapped in a uniform adapter so the runner can, per case:
 *   - `diff(case)`  produce the library's native patch/delta object,
 *   - measure `JSON.stringify(patch).length` (patch size in bytes),
 *   - `verify(case, patch)` apply that patch with a COMPLIANT applier and decide
 *     a round-trip verdict (PASS / CORRUPT / CRASH / NO-APPLIER),
 *   - optionally `apply(case, patch)` for the apply-wall-time measurement.
 *
 * The engines under test:
 *   ours          — THIS branch's engine (default capabilities)
 *   ours-moves    — THIS branch's engine with emitMoves (schema-aware cases only)
 *   fjsp-v040     — the OLD published engine (npm alias) to prove audit fixes
 *   fast-json-patch, rfc6902, jsondiffpatch, json-diff-kit — generic competitors
 */
import {
  applyPatch as oursApply,
  buildPlan,
  JsonSchemaPatcher,
  type Operation,
} from "../../src/index";
import * as fjspOld from "fjsp-v040";
import * as fastJsonPatch from "fast-json-patch";
import * as rfc6902 from "rfc6902";
import * as jsondiffpatch from "jsondiffpatch";
import { Differ } from "json-diff-kit";

export type CorpusCase = {
  name: string;
  category: string;
  description: string;
  schema: object | null;
  options?: {
    primaryKeyMap?: Record<string, string>;
    basePath?: string;
    primaryKeyCandidates?: string[];
    ignorePaths?: string[];
  };
  roundtrip: "exact" | "multiset";
  measureMemory: boolean;
  tags: string[];
  staleness?: { steps: string[]; note: string };
  original: unknown;
  modified: unknown;
};

export type Verdict = "PASS" | "CORRUPT" | "CRASH" | "NO-APPLIER" | "SKIPPED";

export type Adapter = {
  id: string;
  label: string;
  /** schema-aware engines consume case.schema/options; generic ones ignore them. */
  kind: "schema-aware" | "generic";
  /** true when this adapter has a real applier we can time (apply wall-time). */
  hasApplier: boolean;
  /** Produce the library's native patch/delta; may throw (-> CRASH). */
  diff(c: CorpusCase): unknown;
  /** Apply `patch` with a compliant applier and return the reconstructed doc. */
  apply(c: CorpusCase, patch: unknown): unknown;
  /**
   * Only cases whose largest array is <= this may be diffed by this adapter;
   * larger cases are pre-SKIPPED to avoid super-linear hangs. undefined = no cap.
   */
  maxArrayLen?: number;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// --- jsondiffpatch / json-diff-kit shared configuration (id-aware) ---
const jdpInstance = jsondiffpatch.create({
  objectHash: (o: any) => o?.id ?? o?.postId ?? o?.name ?? JSON.stringify(o),
  arrays: { detectMove: true },
});
const jdkInstance = new Differ({
  detectCircular: true,
  maxDepth: Infinity,
  showModifications: true,
  arrayDiffMethod: "lcs",
});

// --- schema-aware plan builders ---
function oursPlan(c: CorpusCase) {
  return c.schema ? buildPlan({ schema: c.schema as never, ...(c.options ?? {}) }) : new Map();
}
function oldPlan(c: CorpusCase) {
  if (!c.schema) return new Map();
  // The old buildPlan only knows { schema, primaryKeyMap, basePath }.
  const opts: any = { schema: c.schema };
  if (c.options?.primaryKeyMap) opts.primaryKeyMap = c.options.primaryKeyMap;
  if (c.options?.basePath !== undefined) opts.basePath = c.options.basePath;
  return (fjspOld as any).buildPlan(opts);
}

/**
 * Compare reconstructed vs modified honouring the case's round-trip contract.
 *
 * ignorePaths cases (CORE §7.6): apply(original, patch) equals modified
 * EVERYWHERE except at or beneath a matched ignore location, where it retains
 * original's value. We therefore compare MODULO the ignored subtrees — strip the
 * ignored members from both sides before comparing — so a schema-aware engine
 * that (correctly) emitted no op for a volatile field is not judged CORRUPT, and
 * a generic engine that DID rewrite it still passes (both agree off the ignored
 * projection). Our corpus keeps every ignore pointer terminal a literal object-
 * member name (only intermediate segments use the `*` array/member wildcard), so
 * stripping is a straightforward member delete.
 */
export function reconstructs(c: CorpusCase, applied: unknown): boolean {
  const ignore = c.options?.ignorePaths;
  let a = applied;
  let b: unknown = c.modified;
  if (ignore && ignore.length) {
    a = stripIgnored(clone(a), ignore);
    b = stripIgnored(clone(b), ignore);
  }
  if (c.roundtrip === "exact") return JSON.stringify(a) === JSON.stringify(b);
  return JSON.stringify(canonSort(a)) === JSON.stringify(canonSort(b));
}

/**
 * Delete the subtrees addressed by `pointers` from `value` (mutating it).
 * Segment rules mirror GEN §10.3: a `*` segment matches every array element or
 * every object member at that level; any other segment is an exact object-member
 * key (unescaped per RFC 6901). Every corpus ignore pointer terminates on a
 * literal member name, so the terminal is always an object-member delete.
 */
function stripIgnored(value: unknown, pointers: string[]): unknown {
  for (const ptr of pointers) {
    const segs = ptr.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    del(value, segs);
  }
  return value;
}
function del(node: unknown, segs: string[]): void {
  if (segs.length === 0) return;
  const [seg, ...rest] = segs as [string, ...string[]];
  if (rest.length === 0) {
    if (node && typeof node === "object" && !Array.isArray(node)) delete (node as Record<string, unknown>)[seg];
    return;
  }
  if (seg === "*") {
    if (Array.isArray(node)) for (const el of node) del(el, rest);
    else if (node && typeof node === "object") for (const v of Object.values(node)) del(v, rest);
    return;
  }
  if (node && typeof node === "object" && !Array.isArray(node)) del((node as Record<string, unknown>)[seg], rest);
}
function canonSort(v: any): any {
  if (Array.isArray(v))
    return v
      .map(canonSort)
      .sort((a, b) => {
        const x = JSON.stringify(a);
        const y = JSON.stringify(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
  if (v && typeof v === "object") {
    const o: any = {};
    for (const k of Object.keys(v).sort()) o[k] = canonSort(v[k]);
    return o;
  }
  return v;
}

export const ADAPTERS: Adapter[] = [
  {
    id: "ours",
    label: "ours (this branch)",
    kind: "schema-aware",
    hasApplier: true,
    diff(c) {
      const plan = oursPlan(c);
      return new JsonSchemaPatcher({ plan, ignorePaths: c.options?.ignorePaths }).execute({
        original: c.original as never,
        modified: c.modified as never,
      });
    },
    apply(c, patch) {
      return oursApply(clone(c.original) as never, patch as Operation[]);
    },
  },
  {
    id: "ours-moves",
    label: "ours + emitMoves",
    kind: "schema-aware",
    hasApplier: true,
    diff(c) {
      const plan = oursPlan(c);
      return new JsonSchemaPatcher({ plan, emitMoves: true, ignorePaths: c.options?.ignorePaths }).execute({
        original: c.original as never,
        modified: c.modified as never,
      });
    },
    apply(c, patch) {
      return oursApply(clone(c.original) as never, patch as Operation[]);
    },
  },
  {
    id: "fjsp-v040",
    label: "fjsp v0.4.0 (old published)",
    kind: "schema-aware",
    hasApplier: false, // v0.4.0 shipped no applier; verified with OUR compliant applier
    diff(c) {
      const plan = oldPlan(c);
      return new (fjspOld as any).JsonSchemaPatcher({ plan }).execute({
        original: c.original,
        modified: c.modified,
      });
    },
    apply(c, patch) {
      // Verify the OLD engine's patch with THIS branch's compliant applier.
      return oursApply(clone(c.original) as never, patch as Operation[]);
    },
  },
  {
    id: "fast-json-patch",
    label: "fast-json-patch",
    kind: "generic",
    hasApplier: true,
    diff(c) {
      return fastJsonPatch.compare(c.original as any, c.modified as any);
    },
    apply(c, patch) {
      // mutateDocument=false -> returns a fresh newDocument.
      return fastJsonPatch.applyPatch(clone(c.original) as any, patch as any, false, false)
        .newDocument;
    },
  },
  {
    id: "rfc6902",
    label: "rfc6902",
    kind: "generic",
    hasApplier: true,
    // rfc6902's array diff builds a full O(n*m) dynamic-programming matrix of
    // operation lists; on large arrays it either stack-overflows (single-edit)
    // or exhausts the heap and is SIGKILL'd uncatchably (disjoint 4k -> a
    // 4000x4000 matrix). Pre-skip large arrays so the runner never dies; the
    // moderate cap still covers all realistic/keyed/structural/edge cases.
    maxArrayLen: 2000,
    diff(c) {
      return rfc6902.createPatch(c.original as any, c.modified as any);
    },
    apply(c, patch) {
      const doc = clone(c.original);
      rfc6902.applyPatch(doc as any, patch as any); // mutates doc in place
      return doc;
    },
  },
  {
    id: "jsondiffpatch",
    label: "jsondiffpatch",
    kind: "generic",
    hasApplier: true,
    diff(c) {
      return jdpInstance.diff(c.original as any, c.modified as any);
    },
    apply(c, patch) {
      if (patch === undefined) return clone(c.original); // undefined delta => no change
      return jdpInstance.patch(clone(c.original) as any, patch as any);
    },
  },
  {
    id: "json-diff-kit",
    label: "json-diff-kit",
    kind: "generic",
    hasApplier: false, // display-only diff; no round-trip applier exists
    // O(n^2) LCS — pre-skip on very large arrays so the runner never hangs.
    maxArrayLen: 15000,
    diff(c) {
      return jdkInstance.diff(c.original as any, c.modified as any);
    },
    apply() {
      throw new Error("json-diff-kit has no applier");
    },
  },
];

/** Largest array length anywhere in a value (drives the maxArrayLen skip). */
export function maxArrayLength(v: unknown): number {
  let max = 0;
  const stack: unknown[] = [v];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      if (node.length > max) max = node.length;
      for (const el of node) if (el && typeof el === "object") stack.push(el);
    } else if (node && typeof node === "object") {
      for (const val of Object.values(node)) if (val && typeof val === "object") stack.push(val);
    }
  }
  return max;
}

/**
 * Compute the round-trip verdict for one adapter on one case. `diff` is run
 * fresh here so a diff-time throw is caught as CRASH.
 */
export function verdictFor(a: Adapter, c: CorpusCase): { verdict: Verdict; detail: string } {
  let patch: unknown;
  try {
    patch = a.diff(c);
  } catch (e) {
    return { verdict: "CRASH", detail: `diff threw: ${(e as Error).message}` };
  }
  // A display-only diff can be produced but not round-tripped.
  if (a.id === "json-diff-kit") return { verdict: "NO-APPLIER", detail: "display-only diff" };
  try {
    const applied = a.apply(c, patch);
    if (reconstructs(c, applied)) return { verdict: "PASS", detail: "" };
    return { verdict: "CORRUPT", detail: "applied patch does not reconstruct modified" };
  } catch (e) {
    return { verdict: "CORRUPT", detail: `patch unappliable: ${(e as Error).message}` };
  }
}
