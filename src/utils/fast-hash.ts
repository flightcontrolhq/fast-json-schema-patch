/*
 * A simple, non-cryptographic FNV-1a hash function.
 *
 * @param {string} str The string to hash.
 * @returns {string} A 32-bit hash as a hex string.
 */
export function fastHash(str: string): string {
  let hash = 0x811c9dc5; // FNV_offset_basis

  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }

  // Return as a hex string
  return (hash >>> 0).toString(16);
} 