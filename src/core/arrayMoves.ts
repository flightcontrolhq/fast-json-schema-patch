import type { JsonArray, JsonValue, Operation } from "../types";
import type { ModificationCallback } from "./arrayDiffAlgorithms";

/**
 * The `emitMoves` capability (SPEC §10.4.4). All three strategies share one
 * machinery: given a bijection between surviving `original` indices and their
 * `modified` target indices, plus pure deletes/inserts, reproduce `modified`
 * EXACTLY (order and duplicates) as a sequence of RFC 6902 ops in which every
 * *relocation* of an unchanged element is a single `move` instead of a
 * remove+add pair (F22/F23/F07). Default output (capability off) is unaffected.
 */

/**
 * Longest strictly-increasing subsequence of `seq`, returned as the set of
 * indices INTO `seq` that participate (SPEC §5.8.2). `seq` is always a
 * permutation of `0..S-1` here (distinct values), so "strictly increasing"
 * is unambiguous and `lower_bound` and `upper_bound` coincide.
 *
 * Deterministic and Go-reproducible: canonical patience-sorting with a
 * `lower_bound` binary search over the `tails` array plus predecessor-link
 * reconstruction from the last-appended tail. This fixes ONE specific LIS when
 * several have equal length — the pinned tie-break of §5.8.2 — so a conforming
 * reimplementation emits byte-identical moves.
 */
export function lisIndices(seq: ArrayLike<number>): number[] {
  const n = seq.length;
  if (n === 0) return [];
  // tails[k] = index into seq of the smallest tail of an increasing
  // subsequence of length k+1; prev[i] = predecessor index of i in seq.
  const tails: number[] = [];
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const vi = seq[i] as number;
    // lower_bound: first k with seq[tails[k]] >= vi
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((seq[tails[mid] as number] as number) < vi) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const result: number[] = [];
  let k = tails[tails.length - 1] as number;
  while (k !== -1) {
    result.push(k);
    k = prev[k] as number;
  }
  result.reverse();
  return result;
}

/**
 * Emit the `move` ops that reorder a length-`S` array — whose element at source
 * position `p` must end at target rank `seq[p]` (a permutation of `0..S-1`) —
 * into target-rank order (SPEC §5.8.3). Elements whose source positions form the
 * LIS of `seq` (§5.8.2) are the fixed skeleton and NEVER move; every other
 * element is relocated by exactly one `move`, processed **right-to-left**
 * (highest target rank first) so each is placed immediately before the
 * already-final element to its right (insert-before semantics). No-op moves
 * (`from === to`) are dropped.
 *
 * Returns `{from, to}` pairs in emission order, both indices in the length-`S`
 * array's own coordinate space (the array as it exists at the moment the moves
 * apply, i.e. after any deletes and before any inserts).
 */
export function computeMoves(seq: ArrayLike<number>): Array<{
  from: number;
  to: number;
}> {
  const S = seq.length;
  const anchorSrc = new Set(lisIndices(seq));
  // working holds source positions in current array order; start = identity.
  const working: number[] = new Array(S);
  for (let p = 0; p < S; p++) working[p] = p;
  // srcOfTarget[t] = the source position whose target rank is t.
  const srcOfTarget = new Array<number>(S);
  for (let p = 0; p < S; p++) srcOfTarget[seq[p] as number] = p;

  const moves: Array<{ from: number; to: number }> = [];
  for (let t = S - 1; t >= 0; t--) {
    const srcP = srcOfTarget[t] as number;
    if (anchorSrc.has(srcP)) continue; // anchors are the fixed skeleton
    const from = working.indexOf(srcP);
    working.splice(from, 1);
    // Insert immediately before the element already placed to the right; at the
    // rightmost target rank, append to the end.
    const to =
      t === S - 1
        ? working.length
        : working.indexOf(srcOfTarget[t + 1] as number);
    working.splice(to, 0, srcP);
    if (from !== to) moves.push({ from, to });
  }
  return moves;
}

/** A surviving original element and where it lands in `modified`. */
export interface MatchedPair {
  /** Index in `original`. */
  src: number;
  /** Index in `modified`. */
  tgt: number;
  /** `original[src]` is NOT deep-equal to `modified[tgt]` (a modification). */
  changed: boolean;
}

/**
 * Staged move-emitter shared by all three `emitMoves` strategies (SPEC §5.8.1).
 * Given a bijection `matched` between a subset of `original` indices and a
 * subset of `modified` indices, the leftover `pureDeletes` (original indices
 * with no match) and `pureInserts` (modified indices with no match), emit ops
 * that transform `original` into `modified` EXACTLY, in four pinned stages:
 *
 *   1. **removes** — `pureDeletes` in DESCENDING index order (lower indices stay
 *      valid as higher ones are spliced out). After this the array holds the
 *      survivors in original relative order.
 *   2. **moves** — reorder the survivors into `modified` order via
 *      `computeMoves` (§5.8.3); indices are in the survivors-only coordinate
 *      space of this moment.
 *   3. **inserts** — `pureInserts` in ASCENDING target index, each an INDEXED
 *      `add` (never `/-`) at its final `modified` position; ascending order
 *      keeps every earlier position already final.
 *   4. **replaces** — modified survivors (`changed === true`) in ASCENDING
 *      target index; same-kind pairs recurse for granular descent (§5.5.4.2),
 *      otherwise a whole-item `replace`. The array is at full `modified` length
 *      here, so each target index is final.
 *
 * `move` ops never carry `value`/`oldValue`. `remove`/`replace` honor
 * `includeOldValue` (§6.4.2).
 */
export function emitArrayMovesPatch(
  arr1: JsonArray,
  arr2: JsonArray,
  path: string,
  patches: Operation[],
  matched: MatchedPair[],
  pureDeletes: number[],
  pureInserts: number[],
  onModification: ModificationCallback,
  includeOldValue: boolean
): void {
  const prefix = path === "" ? "/" : path + "/";

  // Stage 1: removals, descending.
  const deletes = pureDeletes.slice().sort((a, b) => b - a);
  for (let i = 0; i < deletes.length; i++) {
    const s = deletes[i] as number;
    const op: Operation = { op: "remove", path: prefix + s };
    if (includeOldValue) op.oldValue = arr1[s] as JsonValue;
    patches.push(op);
  }

  // Stage 2: reorder survivors into modified order via moves.
  if (matched.length > 1) {
    const bySrc = matched.slice().sort((a, b) => a.src - b.src);
    const byTgt = matched.slice().sort((a, b) => a.tgt - b.tgt);
    // rank[src] = position of this survivor in modified order (0..S-1).
    const rankOfSrc = new Map<number, number>();
    for (let i = 0; i < byTgt.length; i++) {
      rankOfSrc.set((byTgt[i] as MatchedPair).src, i);
    }
    const seq = new Int32Array(bySrc.length);
    for (let i = 0; i < bySrc.length; i++) {
      seq[i] = rankOfSrc.get((bySrc[i] as MatchedPair).src) as number;
    }
    const moves = computeMoves(seq);
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i] as { from: number; to: number };
      patches.push({
        op: "move",
        from: prefix + mv.from,
        path: prefix + mv.to,
      });
    }
  }

  // Stage 3: insertions at final target indices, ascending.
  const inserts = pureInserts.slice().sort((a, b) => a - b);
  for (let i = 0; i < inserts.length; i++) {
    const t = inserts[i] as number;
    patches.push({ op: "add", path: prefix + t, value: arr2[t] as JsonValue });
  }

  // Stage 4: modifications at final target indices, ascending. Same-kind pairs
  // recurse (granular descent, §5.5.4.2); otherwise whole-item replace.
  const changed = matched
    .filter((mm) => mm.changed)
    .sort((a, b) => a.tgt - b.tgt);
  for (let i = 0; i < changed.length; i++) {
    const mm = changed[i] as MatchedPair;
    const v1 = arr1[mm.src] as JsonValue;
    const v2 = arr2[mm.tgt] as JsonValue;
    const bothContainers =
      v1 !== null &&
      v2 !== null &&
      typeof v1 === "object" &&
      typeof v2 === "object" &&
      Array.isArray(v1) === Array.isArray(v2);
    if (bothContainers) {
      onModification(v1, v2, prefix + mm.tgt, patches, true);
    } else {
      const op: Operation = { op: "replace", path: prefix + mm.tgt, value: v2 };
      if (includeOldValue) op.oldValue = v1;
      patches.push(op);
    }
  }
}
