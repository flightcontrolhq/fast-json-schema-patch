package schemapatch

import (
	"sort"
	"strconv"
)

// modCallback recurses a matched element pair back through the differ, threading
// the element's plan-trie node (SPEC §5.4.5.2). skipEqualityCheck mirrors the
// reference onModification contract: every real call site passes true (the pair
// is already known to differ), so the differ recurses unconditionally.
type modCallback func(oldVal, newVal Value, path string, patches *[]Operation, skipEqualityCheck bool)

// primaryKeyID returns a type-tagged identity string for a primaryKey value and
// whether v is an admissible key (SPEC §5.4.1.5). Keys are compared by JSON type
// AND value with no coercion: a numeric key and a string key never collide
// (the "s:"/"n:" tag keeps 1 distinct from "1"), while numeric keys compare at
// f64 (§2.4.3) so 1 and 1.0 are the same key. Only strings and numbers are
// admissible; null/bool/array/object return ok=false.
func primaryKeyID(v Value) (string, bool) {
	switch x := v.(type) {
	case string:
		return "s:" + x, true
	case Number:
		f, err := x.Float64()
		if err != nil {
			return "", false
		}
		return "n:" + jsNumberString(f), true
	case float64:
		return "n:" + jsNumberString(x), true
	default:
		return "", false
	}
}

// checkPrimaryKeyApplicable is the primaryKey applicability gate (SPEC §5.4.3).
// In one O(n+m) pass it verifies (a) every element of both arrays is an object
// whose value at primaryKey is a string or number (present, non-null), and (b)
// there are no duplicate key values within either array. If either check fails,
// the caller MUST fall back to LCS (§5.5) for this diff. A primaryKeyMap override
// selects the strategy but does NOT bypass this gate.
func checkPrimaryKeyApplicable(arr1, arr2 []Value, primaryKey string) bool {
	check := func(arr []Value) bool {
		seen := make(map[string]bool, len(arr))
		for _, item := range arr {
			obj, ok := item.(*Object)
			if !ok {
				return false // primitive, array, or null: not an object
			}
			kv, has := obj.Get(primaryKey)
			if !has {
				return false
			}
			id, ok := primaryKeyID(kv)
			if !ok {
				return false // null or non-string/number key
			}
			if seen[id] {
				return false // duplicate key
			}
			seen[id] = true
		}
		return true
	}
	return check(arr1) && check(arr2)
}

// diffArrayByPrimaryKey emits the normative three-phase primaryKey diff (SPEC
// §5.4.1): field-level modifications at ORIGINAL indices (in modified scan
// order), then removals in descending original index, then "/-" appends in
// modified appearance order. The caller guarantees the §5.4.3 gate passed. The
// hashFields prefilter (§5.4.6) is non-normative and output-neutral, so this
// implementation takes the simple exact deep-equal path.
func (p *Patcher) diffArrayByPrimaryKey(arr1, arr2 []Value, primaryKey, path string, patches *[]Operation, onMod modCallback) {
	prefix := path + "/"

	// Phase 1: index the original by key.
	keyToIndex := make(map[string]int, len(arr1))
	for i, item := range arr1 {
		obj, ok := item.(*Object)
		if !ok {
			continue
		}
		kv, has := obj.Get(primaryKey)
		if !has {
			continue
		}
		id, ok := primaryKeyID(kv)
		if !ok {
			continue
		}
		keyToIndex[id] = i
	}

	var mods, adds []Operation

	// Phase 2: scan the modified.
	for _, newItem := range arr2 {
		obj, ok := newItem.(*Object)
		if !ok {
			continue
		}
		kv, has := obj.Get(primaryKey)
		if !has {
			continue
		}
		id, ok := primaryKeyID(kv)
		if !ok {
			continue
		}
		oldIndex, found := keyToIndex[id]
		if found {
			delete(keyToIndex, id)
			oldItem := arr1[oldIndex]
			if !DeepEqual(oldItem, newItem) {
				onMod(oldItem, newItem, prefix+strconv.Itoa(oldIndex), &mods, true)
			}
		} else {
			adds = append(adds, p.addOp(prefix+"-", newItem))
		}
	}

	// Phase 3: removals of unmatched originals, descending original index.
	removalIdx := make([]int, 0, len(keyToIndex))
	for _, idx := range keyToIndex {
		removalIdx = append(removalIdx, idx)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(removalIdx)))
	var removals []Operation
	for _, idx := range removalIdx {
		removals = append(removals, p.removeOp(prefix+strconv.Itoa(idx), arr1[idx]))
	}

	// Concatenation order (§5.4.1.4): modifications ++ removals ++ additions.
	*patches = append(*patches, mods...)
	*patches = append(*patches, removals...)
	*patches = append(*patches, adds...)
}

// diffArrayByPrimaryKeyMoves is the primaryKey emitMoves path (SPEC §5.8.7). The
// caller guarantees the §5.4.3 gate passed. Instead of the order-insensitive
// three-phase emission it builds the key bijection and hands it to the shared
// staged emitter, so survivors are REORDERED into modified order via moves and
// new keys are INDEXED adds — making apply(original, patch) equal modified
// byte-exactly (§7.4).
func (p *Patcher) diffArrayByPrimaryKeyMoves(arr1, arr2 []Value, primaryKey, path string, patches *[]Operation, onMod modCallback) {
	keyToIndex := make(map[string]int, len(arr1))
	for i, item := range arr1 {
		// The gate guarantees each item is an object with a string|number key.
		obj := item.(*Object)
		kv, _ := obj.Get(primaryKey)
		id, _ := primaryKeyID(kv)
		keyToIndex[id] = i
	}

	var matched []MatchedPair
	var pureInserts []int
	for j, item := range arr2 {
		obj := item.(*Object)
		kv, _ := obj.Get(primaryKey)
		id, _ := primaryKeyID(kv)
		if src, found := keyToIndex[id]; found {
			delete(keyToIndex, id)
			matched = append(matched, MatchedPair{
				Src:     src,
				Tgt:     j,
				Changed: !DeepEqual(arr1[src], arr2[j]),
			})
		} else {
			pureInserts = append(pureInserts, j)
		}
	}

	// Keys left in the index are original items with no match -> pure deletes.
	pureDeletes := make([]int, 0, len(keyToIndex))
	for _, idx := range keyToIndex {
		pureDeletes = append(pureDeletes, idx)
	}

	p.emitArrayMovesPatch(arr1, arr2, path, patches, matched, pureDeletes, pureInserts, onMod)
}

// diffArrayUnique is the unique strategy (SPEC §5.6): equal-length positional
// replaces, nothing else. The caller's gate (§5.4.4) guarantees equal lengths,
// so no adds or removes are emitted.
func (p *Patcher) diffArrayUnique(arr1, arr2 []Value, path string, patches *[]Operation) {
	prefix := path + "/"
	for i := range arr1 { // len(arr1) == len(arr2) under the equal-length gate
		if !DeepEqual(arr1[i], arr2[i]) {
			*patches = append(*patches, p.replaceOp(prefix+strconv.Itoa(i), arr1[i], arr2[i]))
		}
	}
}

// diffArrayUniqueMoves is the unique emitMoves path (SPEC §5.8.6). The caller
// guarantees the §5.4.4 gate passed. If the two arrays are multiset-equal (a
// pure permutation) it emits the reorder as moves via the shared staged emitter
// and returns true; otherwise it emits nothing and returns false so the caller
// keeps the §5.6 positional-replace emission.
func (p *Patcher) diffArrayUniqueMoves(arr1, arr2 []Value, path string, patches *[]Operation, onMod modCallback) bool {
	idxOf := make(map[string]int, len(arr2))
	for i, v := range arr2 {
		idxOf[stableStringify(v)] = i
	}
	matched := make([]MatchedPair, len(arr1))
	for i, v := range arr1 {
		tgt, ok := idxOf[stableStringify(v)]
		if !ok {
			return false // a missing value means the sets differ
		}
		matched[i] = MatchedPair{Src: i, Tgt: tgt, Changed: false}
	}
	p.emitArrayMovesPatch(arr1, arr2, path, patches, matched, nil, nil, onMod)
	return true
}

// checkArraysUnique is the gate for the unique strategy (SPEC §5.4.4): true iff
// the arrays have equal length and neither contains two deep-equal elements.
func checkArraysUnique(arr1, arr2 []Value) bool {
	if len(arr1) != len(arr2) {
		return false
	}
	seen1 := make(map[string]bool, len(arr1))
	seen2 := make(map[string]bool, len(arr2))
	for i := range arr1 {
		k1 := stableStringify(arr1[i])
		k2 := stableStringify(arr2[i])
		if seen1[k1] || seen2[k2] {
			return false
		}
		seen1[k1] = true
		seen2[k2] = true
	}
	return true
}

// scriptKind tags an entry of the Myers edit script.
type scriptKind int

const (
	kindCommon scriptKind = iota
	kindRemove
	kindAdd
	kindReplace
)

// scriptEntry is one edit-script step in window coordinates. ai indexes the
// original window, bi the modified window (unused fields are ignored per kind).
type scriptEntry struct {
	kind scriptKind
	ai   int
	bi   int
}

// diffArrayLCS is the LCS strategy (SPEC §5.5): normative prefix/suffix trimming
// (§5.5.0), banded Myers with the pinned tie-breaks and V-init (§5.5.2),
// backtrack (§5.5.3), adjacent remove+add collapse and granular descent
// (§5.5.4), then index-correct emission (§5.5.5). With emitMoves on it builds the
// bijection and defers to the shared staged emitter (§5.8.5).
func (p *Patcher) diffArrayLCS(arr1, arr2 []Value, path string, patches *[]Operation, onMod modCallback, itemIgnore *ignoreNode) {
	n := len(arr1)
	m := len(arr2)

	prefixPath := "/"
	if path != "" {
		prefixPath = path + "/"
	}

	// Empty-array fast paths (§5.5.1).
	if n == 0 {
		for i := 0; i < m; i++ {
			*patches = append(*patches, p.addOp(prefixPath+strconv.Itoa(i), arr2[i]))
		}
		return
	}
	if m == 0 {
		for i := n - 1; i >= 0; i-- {
			*patches = append(*patches, p.removeOp(prefixPath+strconv.Itoa(i), arr1[i]))
		}
		return
	}

	// §5.5.0 Trim step 0: maximal common prefix first, then the maximal common
	// suffix of the remainder, using the same deep-equal predicate as the snake.
	lo := 0
	for lo < n && lo < m && DeepEqual(arr1[lo], arr2[lo]) {
		lo++
	}
	hi := 0
	for hi < n-lo && hi < m-lo && DeepEqual(arr1[n-1-hi], arr2[m-1-hi]) {
		hi++
	}

	wn := n - lo - hi // original window length
	wm := m - lo - hi // modified window length

	// Windowed fast paths (§5.5.0.3).
	if wn == 0 && wm == 0 {
		return // arrays are deep-equal
	}
	if wn == 0 {
		for j := 0; j < wm; j++ {
			*patches = append(*patches, p.addOp(prefixPath+strconv.Itoa(lo+j), arr2[lo+j]))
		}
		return
	}
	if wm == 0 {
		for j := wn - 1; j >= 0; j-- {
			*patches = append(*patches, p.removeOp(prefixPath+strconv.Itoa(lo+j), arr1[lo+j]))
		}
		return
	}

	// Intern the window elements to integer ids via a canonical, key-sorted
	// fingerprint shared across BOTH arrays (§5.5.2). Equal fingerprint <=>
	// deep-equal for JSON inputs, so the Myers snake compares ids in O(1). All
	// state is call-local.
	fpToID := make(map[string]int)
	intern := func(v Value) int {
		// ignorePaths (SPEC §5.10.5): the fingerprint is ignore-filtered so items
		// differing only in ignored fields intern equal. itemIgnore==nil delegates
		// to stableStringify (byte-identical to the pre-capability path).
		fp := ignoreFingerprint(v, itemIgnore)
		id, ok := fpToID[fp]
		if !ok {
			id = len(fpToID)
			fpToID[fp] = id
		}
		return id
	}
	idsA := make([]int, wn)
	idsB := make([]int, wm)
	for i := 0; i < wn; i++ {
		idsA[i] = intern(arr1[lo+i])
	}
	for i := 0; i < wm; i++ {
		idsB[i] = intern(arr2[lo+i])
	}

	// Myers O(ND) forward pass over the trimmed window (§5.5.2). Window
	// coordinates x in [0,wn], y in [0,wm] map to array indices (lo+x, lo+y).
	max := wn + wm
	offset := max
	bufSize := 2*max + 1

	vPrev := make([]int, bufSize)
	vCurr := make([]int, bufSize)
	for i := range vPrev {
		vPrev[i] = -1
		vCurr[i] = -1
	}
	vPrev[offset+1] = 0 // seed

	trace := make([][]int, 0, max+2)
	endD := -1

outer:
	for d := 0; d <= max; d++ {
		traceCopy := make([]int, bufSize)
		copy(traceCopy, vPrev)
		trace = append(trace, traceCopy)

		for k := -d; k <= d; k += 2 {
			kOffset := k + offset

			vLeft := -1
			if kOffset > 0 {
				vLeft = vPrev[kOffset-1]
			}
			vRight := -1
			if kOffset < bufSize-1 {
				vRight = vPrev[kOffset+1]
			}

			down := k == -d || (k != d && vLeft < vRight)
			var x int
			if down {
				x = vRight
			} else {
				x = vLeft + 1
			}
			y := x - k

			// Snake: interned-id equality is exact deep-equal for the window.
			for x < wn && y < wm && idsA[x] == idsB[y] {
				x++
				y++
			}

			vCurr[kOffset] = x

			if x >= wn && y >= wm {
				finalCopy := make([]int, bufSize)
				copy(finalCopy, vCurr)
				trace = append(trace, finalCopy)
				endD = d
				break outer
			}
		}

		vPrev, vCurr = vCurr, vPrev
		for i := range vCurr {
			vCurr[i] = -1
		}
	}

	if endD == -1 {
		return
	}

	// Backtracking to build the edit script in window coordinates (§5.5.3).
	var script []scriptEntry
	x := wn
	y := wm
	for d := endD; d > 0; d-- {
		vRow := trace[d]
		k := x - y
		kOffset := k + offset

		vLeft := -1
		if kOffset > 0 {
			vLeft = vRow[kOffset-1]
		}
		vRight := -1
		if kOffset < bufSize-1 {
			vRight = vRow[kOffset+1]
		}

		down := k == -d || (k != d && vLeft < vRight)
		var prevK int
		if down {
			prevK = k + 1
		} else {
			prevK = k - 1
		}
		prevX := vRow[prevK+offset]
		prevY := prevX - prevK

		for x > prevX && y > prevY {
			x--
			y--
			script = append(script, scriptEntry{kind: kindCommon, ai: x, bi: y})
		}

		if down {
			y--
			script = append(script, scriptEntry{kind: kindAdd, bi: y})
		} else {
			x--
			script = append(script, scriptEntry{kind: kindRemove, ai: x})
		}
	}
	for x > 0 && y > 0 {
		x--
		y--
		script = append(script, scriptEntry{kind: kindCommon, ai: x, bi: y})
	}
	// Reverse to forward order.
	for l, r := 0, len(script)-1; l < r; l, r = l+1, r-1 {
		script[l], script[r] = script[r], script[l]
	}

	// Collapse adjacent remove+add into replace (§5.5.4.1).
	opt := make([]scriptEntry, 0, len(script))
	for i := 0; i < len(script); i++ {
		cur := script[i]
		if cur.kind == kindRemove && i+1 < len(script) && script[i+1].kind == kindAdd {
			opt = append(opt, scriptEntry{kind: kindReplace, ai: cur.ai, bi: script[i+1].bi})
			i++ // skip the paired add
		} else {
			opt = append(opt, cur)
		}
	}

	// emitMoves capability (§5.8.5): reconstruct the full bijection from the
	// collapsed script plus the trimmed prefix/suffix, pair leftover removes with
	// equal-id leftover adds into relocations, and defer to the staged emitter.
	if p.emitMoves {
		var matched []MatchedPair
		type leftover struct {
			idx int
			id  int
		}
		var leftoverRemoves, leftoverAdds []leftover
		// Trimmed common prefix: unchanged, in place.
		for i := 0; i < lo; i++ {
			matched = append(matched, MatchedPair{Src: i, Tgt: i, Changed: false})
		}
		// Window (collapsed script), offset by lo into absolute coordinates.
		for _, e := range opt {
			switch e.kind {
			case kindCommon:
				matched = append(matched, MatchedPair{Src: lo + e.ai, Tgt: lo + e.bi, Changed: false})
			case kindReplace:
				matched = append(matched, MatchedPair{Src: lo + e.ai, Tgt: lo + e.bi, Changed: true})
			case kindRemove:
				leftoverRemoves = append(leftoverRemoves, leftover{idx: lo + e.ai, id: idsA[e.ai]})
			case kindAdd:
				leftoverAdds = append(leftoverAdds, leftover{idx: lo + e.bi, id: idsB[e.bi]})
			}
		}
		// Trimmed common suffix: unchanged, in place.
		for j := 0; j < hi; j++ {
			matched = append(matched, MatchedPair{Src: n - 1 - j, Tgt: m - 1 - j, Changed: false})
		}
		// Pair leftover removes with equal-id leftover adds -> relocations. For
		// each id, adds are queued in ascending target order; each remove (in
		// script order) claims the earliest unused add of the same id.
		addsByID := make(map[int][]int)
		for a, la := range leftoverAdds {
			addsByID[la.id] = append(addsByID[la.id], a)
		}
		addUsed := make([]bool, len(leftoverAdds))
		var pureDeletes []int
		for _, rm := range leftoverRemoves {
			q := addsByID[rm.id]
			if len(q) > 0 {
				a := q[0]
				addsByID[rm.id] = q[1:]
				addUsed[a] = true
				matched = append(matched, MatchedPair{Src: rm.idx, Tgt: leftoverAdds[a].idx, Changed: false})
			} else {
				pureDeletes = append(pureDeletes, rm.idx)
			}
		}
		var pureInserts []int
		for a, la := range leftoverAdds {
			if !addUsed[a] {
				pureInserts = append(pureInserts, la.idx)
			}
		}
		p.emitArrayMovesPatch(arr1, arr2, path, patches, matched, pureDeletes, pureInserts, onMod)
		return
	}

	// Emission from the script (§5.5.5). currentIndex starts at lo: the trimmed
	// common prefix occupies output indices 0..lo-1 unchanged.
	currentIndex := lo
	for _, e := range opt {
		switch e.kind {
		case kindCommon:
			currentIndex++
		case kindReplace:
			v1 := arr1[lo+e.ai]
			v2 := arr2[lo+e.bi]
			// §5.5.4.2 granular descent: same-kind pairs recurse; primitives and
			// mismatched-kind pairs stay a whole-item replace.
			if sameContainerKind(v1, v2) {
				onMod(v1, v2, prefixPath+strconv.Itoa(currentIndex), patches, true)
			} else {
				*patches = append(*patches, p.replaceOp(prefixPath+strconv.Itoa(currentIndex), v1, v2))
			}
			currentIndex++
		case kindRemove:
			*patches = append(*patches, p.removeOp(prefixPath+strconv.Itoa(currentIndex), arr1[lo+e.ai]))
			// currentIndex is NOT incremented for removes.
		case kindAdd:
			*patches = append(*patches, p.addOp(prefixPath+strconv.Itoa(currentIndex), arr2[lo+e.bi]))
			currentIndex++
		}
	}
}
