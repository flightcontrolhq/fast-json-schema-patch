/**
 * Cache generation ("epoch") counter.
 *
 * Identity-keyed memoization caches (see `deepEqual.ts`, `cache.ts`) key on
 * object identity and therefore cannot detect an in-place mutation of a
 * previously-cached object. Per SPEC §2.4.4 caches MUST be output-neutral: a
 * cache MUST NOT return a stale verdict after an input is mutated between diffs.
 *
 * To satisfy that contract while keeping the intra-call memoization benefit (the
 * LCS pass relies on memo hits within a single diff), every cache entry records
 * the epoch it was written in. A public entry point (`JsonSchemaPatcher.execute`,
 * `StructuredDiff.execute`) bumps the epoch on entry; any cache entry whose epoch
 * differs from the current one is treated as a miss and recomputed. This scopes
 * identity-keyed memoization to a single execute() call so a mutate-then-rediff
 * loop always recomputes.
 */

let currentEpoch = 0

/** Bump and return the new cache epoch. Called at each public diff entry point. */
export function bumpEpoch(): number {
  return ++currentEpoch
}

/** The current cache epoch. Cache entries written under a different epoch are stale. */
export function getEpoch(): number {
  return currentEpoch
}
