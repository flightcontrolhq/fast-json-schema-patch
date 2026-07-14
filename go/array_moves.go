package schemapatch

import (
	"sort"
	"strconv"
)

// The emitMoves capability (GEN §8, CONF §5.4). All three array strategies
// share one machinery: given a bijection between surviving original indices and
// their modified target indices, plus pure deletes/inserts, reproduce modified
// EXACTLY (order and duplicates) as a sequence of RFC 6902 ops in which every
// relocation of an unchanged element is a single move instead of a remove+add
// pair (F22/F23/F07). Default output (capability off) is unaffected.

// MatchedPair is a surviving original element and where it lands in modified
// (GEN §8.1). Changed is true iff original[Src] is NOT deep-equal to
// modified[Tgt] (a modification rather than a pure relocation).
type MatchedPair struct {
	Src     int
	Tgt     int
	Changed bool
}

// lisIndices returns the indices INTO seq that form a longest strictly-increasing
// subsequence (GEN §8.2). seq is always a permutation of 0..S-1 here (distinct
// values), so "strictly increasing" is unambiguous and lower_bound and
// upper_bound coincide. This is the pinned canonical patience-sort with a
// lower_bound binary search over tails plus predecessor-link reconstruction from
// the last-appended tail, fixing ONE specific LIS when several tie (the pinned
// tie-break) so a conforming reimplementation emits byte-identical moves.
func lisIndices(seq []int) []int {
	n := len(seq)
	if n == 0 {
		return nil
	}
	// tails[k] = index into seq of the smallest tail of an increasing
	// subsequence of length k+1; prev[i] = predecessor index of i in seq.
	tails := make([]int, 0, n)
	prev := make([]int, n)
	for i := range prev {
		prev[i] = -1
	}
	for i := 0; i < n; i++ {
		vi := seq[i]
		// lower_bound: first k with seq[tails[k]] >= vi.
		lo, hi := 0, len(tails)
		for lo < hi {
			mid := (lo + hi) >> 1
			if seq[tails[mid]] < vi {
				lo = mid + 1
			} else {
				hi = mid
			}
		}
		if lo > 0 {
			prev[i] = tails[lo-1]
		}
		if lo == len(tails) {
			tails = append(tails, i)
		} else {
			tails[lo] = i
		}
	}
	result := make([]int, 0, len(tails))
	k := tails[len(tails)-1]
	for k != -1 {
		result = append(result, k)
		k = prev[k]
	}
	// Reverse into forward order.
	for l, r := 0, len(result)-1; l < r; l, r = l+1, r-1 {
		result[l], result[r] = result[r], result[l]
	}
	return result
}

// moveOp is one relocation produced by computeMoves; both indices are in the
// length-S array's own coordinate space.
type moveOp struct {
	from int
	to   int
}

// computeMoves emits the move ops that reorder a length-S array — whose element
// at source position p must end at target rank seq[p] (a permutation of 0..S-1)
// — into target-rank order (GEN §8.3). Elements whose source positions form
// the LIS of seq (GEN §8.2) are the fixed skeleton and NEVER move; every other
// element is relocated by exactly one move, processed right-to-left (highest
// target rank first) so each is placed immediately before the already-final
// element to its right (insert-before semantics). No-op moves (from == to) are
// dropped.
func computeMoves(seq []int) []moveOp {
	S := len(seq)
	anchorSrc := make(map[int]bool, S)
	for _, idx := range lisIndices(seq) {
		anchorSrc[idx] = true
	}
	// working holds source positions in current array order; start = identity.
	working := make([]int, S)
	for p := 0; p < S; p++ {
		working[p] = p
	}
	// srcOfTarget[t] = the source position whose target rank is t.
	srcOfTarget := make([]int, S)
	for p := 0; p < S; p++ {
		srcOfTarget[seq[p]] = p
	}

	var moves []moveOp
	for t := S - 1; t >= 0; t-- {
		srcP := srcOfTarget[t]
		if anchorSrc[srcP] {
			continue // anchors are the fixed skeleton
		}
		from := indexOfInt(working, srcP)
		working = append(working[:from], working[from+1:]...)
		// Insert immediately before the element already placed to the right; at
		// the rightmost target rank, append to the end.
		to := len(working)
		if t != S-1 {
			to = indexOfInt(working, srcOfTarget[t+1])
		}
		working = append(working, 0)
		copy(working[to+1:], working[to:])
		working[to] = srcP
		if from != to {
			moves = append(moves, moveOp{from: from, to: to})
		}
	}
	return moves
}

func indexOfInt(s []int, v int) int {
	for i := range s {
		if s[i] == v {
			return i
		}
	}
	return -1
}

// emitArrayMovesPatch is the staged move-emitter shared by all three emitMoves
// strategies (GEN §8.1, GEN §8.4). Given a bijection matched between a subset
// of original indices and a subset of modified indices, the leftover pureDeletes
// (original indices with no match) and pureInserts (modified indices with no
// match), emit ops that transform original into modified EXACTLY, in four pinned
// stages: (1) removes descending, (2) moves reordering survivors into modified
// order, (3) inserts ascending as INDEXED adds, (4) replaces ascending by target
// index (same-kind pairs recurse for granular descent). move ops never carry
// value/oldValue; remove/replace honor includeOldValue.
func (p *Patcher) emitArrayMovesPatch(arr1, arr2 []Value, path string, patches *[]Operation, matched []MatchedPair, pureDeletes, pureInserts []int, onMod modCallback) {
	prefix := "/"
	if path != "" {
		prefix = path + "/"
	}

	// Stage 1: removals, descending.
	deletes := append([]int(nil), pureDeletes...)
	sort.Sort(sort.Reverse(sort.IntSlice(deletes)))
	for _, s := range deletes {
		*patches = append(*patches, p.removeOp(prefix+strconv.Itoa(s), arr1[s]))
	}

	// Stage 2: reorder survivors into modified order via moves.
	if len(matched) > 1 {
		bySrc := append([]MatchedPair(nil), matched...)
		sort.Slice(bySrc, func(i, j int) bool { return bySrc[i].Src < bySrc[j].Src })
		byTgt := append([]MatchedPair(nil), matched...)
		sort.Slice(byTgt, func(i, j int) bool { return byTgt[i].Tgt < byTgt[j].Tgt })
		// rankOfSrc[src] = position of this survivor in modified order (0..S-1).
		rankOfSrc := make(map[int]int, len(byTgt))
		for i, mp := range byTgt {
			rankOfSrc[mp.Src] = i
		}
		seq := make([]int, len(bySrc))
		for i, mp := range bySrc {
			seq[i] = rankOfSrc[mp.Src]
		}
		for _, mv := range computeMoves(seq) {
			*patches = append(*patches, Operation{
				Op:      OpMove,
				From:    prefix + strconv.Itoa(mv.from),
				HasFrom: true,
				Path:    prefix + strconv.Itoa(mv.to),
			})
		}
	}

	// Stage 3: insertions at final target indices, ascending.
	inserts := append([]int(nil), pureInserts...)
	sort.Ints(inserts)
	for _, t := range inserts {
		*patches = append(*patches, p.addOp(prefix+strconv.Itoa(t), arr2[t]))
	}

	// Stage 4: modifications at final target indices, ascending. Same-kind pairs
	// recurse (granular descent, GEN §5.4.2); otherwise whole-item replace.
	var changed []MatchedPair
	for _, mp := range matched {
		if mp.Changed {
			changed = append(changed, mp)
		}
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].Tgt < changed[j].Tgt })
	for _, mp := range changed {
		v1 := arr1[mp.Src]
		v2 := arr2[mp.Tgt]
		if sameContainerKind(v1, v2) {
			onMod(v1, v2, prefix+strconv.Itoa(mp.Tgt), patches, true)
		} else {
			*patches = append(*patches, p.replaceOp(prefix+strconv.Itoa(mp.Tgt), v1, v2))
		}
	}
}
