import type { Plan } from "./buildPlan";
import { unescapeJsonPointer } from "../utils/pathUtils";

/**
 * `ignorePaths` capability (SPEC §5.10). A node in the compiled **ignore trie**:
 * a set of object-member JSON Pointers whose subtrees the diff treats as EQUAL
 * in both directions (no ops at or beneath a matched location, in any strategy).
 *
 * The trie mirrors the plan trie (§5.4.5.1): a `*` segment is the `wildcard`
 * edge, any other segment is UNESCAPED and stored as an exact `children` edge.
 * `end` is set iff an ignore pointer terminates at this node ("ignored here").
 * It is threaded down the diff recursion in PARALLEL with the plan trie as an
 * independent node pointer; an ABSENT ignore set threads `undefined`, so every
 * `?.` access short-circuits and output stays byte-for-byte pre-capability.
 */
export interface IgnoreTrieNode {
  end?: boolean;
  children?: Map<string, IgnoreTrieNode>;
  wildcard?: IgnoreTrieNode;
}

/**
 * Canonical array-index test (SPEC §2.3.2): "0", or a non-zero decimal digit
 * followed by digits, whose value is in `0..2^32-2`. A segment matching this
 * (or `-`) is rejected at construction (§5.10.1) because ignore pointers address
 * object members only and an array level is matched solely by `*`. A segment
 * that merely looks numeric but is not canonical (e.g. "01", a leading zero) is
 * a legal object-member name (§F33) and is NOT an index.
 */
function isArrayIndexSegment(seg: string): boolean {
  if (seg === "0") return true;
  if (seg.length === 0) return false;
  const c0 = seg.charCodeAt(0);
  if (c0 < 0x31 || c0 > 0x39) return false; // first char must be 1..9
  for (let i = 1; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false; // 0..9
  }
  // Fits in a JS number exactly for these lengths; guard the 2^32-2 bound.
  return Number(seg) <= 4294967294;
}

/**
 * Compile a validated `ignorePaths` set into an ignore trie (SPEC §5.10.1/
 * §5.10.2). Returns `undefined` for an empty/absent set (threads no node).
 * Throws `TypeError` on the first invalid pointer (§5.10.1): a non-string, the
 * empty/root pointer `""`, a pointer without a leading `/`, or any segment that
 * is a canonical array index or `-`.
 */
export function compileIgnoreTrie(
  paths: readonly string[] | undefined
): IgnoreTrieNode | undefined {
  if (!paths || paths.length === 0) return undefined;
  const root: IgnoreTrieNode = {};
  for (const path of paths) {
    if (typeof path !== "string") {
      throw new TypeError(
        `ignorePaths entries must be JSON Pointer strings; got ${typeof path} (SPEC §5.10.1)`
      );
    }
    if (path === "") {
      throw new TypeError(
        'ignorePaths: the empty/root pointer "" is not an object-member location (SPEC §5.10.1)'
      );
    }
    if (path.charCodeAt(0) !== 0x2f /* "/" */) {
      throw new TypeError(
        `ignorePaths: pointer ${JSON.stringify(path)} must begin with "/" (SPEC §5.10.1)`
      );
    }
    const rawSegments = path.split("/").slice(1);
    let node = root;
    for (const rawSeg of rawSegments) {
      if (rawSeg === "*") {
        node.wildcard ??= {};
        node = node.wildcard;
        continue;
      }
      const seg = unescapeJsonPointer(rawSeg);
      if (seg === "-" || isArrayIndexSegment(seg)) {
        throw new TypeError(
          `ignorePaths: pointer ${JSON.stringify(path)} contains an array-index (or "-") segment ${JSON.stringify(
            seg
          )}; ignore pointers address object members only — use "*" for an array level (SPEC §5.10.1)`
        );
      }
      node.children ??= new Map();
      let child = node.children.get(seg);
      if (!child) {
        child = {};
        node.children.set(seg, child);
      }
      node = child;
    }
    node.end = true;
  }
  return root;
}

/**
 * Advance the ignore trie for an OBJECT member `key` (SPEC §5.10.3): the exact
 * child edge if present, else the wildcard edge, else none. Exact edges take
 * precedence over the wildcard at every level (a decimal-digit member key is an
 * ordinary exact/wildcard descent, never an array index — §F33).
 */
export function ignoreMember(
  node: IgnoreTrieNode | undefined,
  key: string
): IgnoreTrieNode | undefined {
  if (!node) return undefined;
  return node.children?.get(key) ?? node.wildcard;
}

/**
 * True iff the subtree rooted at `node` contains ANY ignore terminal (SPEC
 * §5.10.6). Used to DISABLE `wholesaleReplaceFallback` for an array with an
 * ignore path beneath it, so ignored content never leaks through a whole-array
 * replace of an ancestor.
 */
export function ignoreSubtreeHasTerminal(
  node: IgnoreTrieNode | undefined
): boolean {
  if (!node) return false;
  if (node.end) return true;
  if (ignoreSubtreeHasTerminal(node.wildcard)) return true;
  if (node.children) {
    for (const child of node.children.values()) {
      if (ignoreSubtreeHasTerminal(child)) return true;
    }
  }
  return false;
}

/**
 * SPEC §5.10.7: a plan's `primaryKey` field MUST NOT be ignorable. Throws
 * `TypeError` when any array plan's key-field location (`P` `/` `*` `/` `key`)
 * is at or beneath an ignore terminal — the field itself, the whole item
 * (`P/*`), or the whole array (`P`). Walking `P`: a literal segment follows
 * exact-child-else-wildcard; a `*` segment in `P` (additionalProperties /
 * nested-array level) explores both exact children and the wildcard, since
 * either may match at diff time.
 */
export function validatePrimaryKeysNotIgnored(
  plan: Plan,
  ignoreRoot: IgnoreTrieNode
): void {
  for (const [planKey, ap] of plan) {
    const key = ap.primaryKey;
    if (!key) continue;
    const segs = planKey.length === 0 ? [] : planKey.split("/").slice(1);
    if (ignoreCoversKeyField(ignoreRoot, segs, 0, key)) {
      throw new TypeError(
        `ignorePaths: an ignore entry covers the primaryKey field ${JSON.stringify(
          key
        )} of the array plan at ${JSON.stringify(
          planKey || "/"
        )} — a primaryKey field must not be ignorable (SPEC §5.10.7)`
      );
    }
  }
}

function ignoreCoversKeyField(
  node: IgnoreTrieNode | undefined,
  segs: string[],
  i: number,
  key: string
): boolean {
  if (!node) return false;
  if (node.end) return true; // an ancestor terminal covers everything below
  if (i < segs.length) {
    const seg = segs[i];
    if (seg === "*") {
      // A schema wildcard level matches any member at diff time: explore the
      // ignore wildcard AND every exact child.
      if (ignoreCoversKeyField(node.wildcard, segs, i + 1, key)) return true;
      if (node.children) {
        for (const child of node.children.values()) {
          if (ignoreCoversKeyField(child, segs, i + 1, key)) return true;
        }
      }
      return false;
    }
    const raw = unescapeJsonPointer(seg as string);
    const exact = node.children?.get(raw);
    if (exact) return ignoreCoversKeyField(exact, segs, i + 1, key);
    return ignoreCoversKeyField(node.wildcard, segs, i + 1, key);
  }
  // i === segs.length: `node` is the array's node. Consume the array-element
  // wildcard (§5.10.3), then match the key member (exact-else-wildcard).
  const itemNode = node.wildcard;
  if (!itemNode) return false;
  if (itemNode.end) return true; // the whole item is ignored -> covers the key
  const keyNode = itemNode.children?.get(key) ?? itemNode.wildcard;
  return keyNode?.end === true;
}
