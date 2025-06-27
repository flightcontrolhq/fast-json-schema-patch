import type { JsonObject } from "../types";

/**
 * A simple, non-cryptographic FNV-1a hash function.
 * 
 * @param {string} str The string to hash.
 * @returns {string} A 32-bit hash as a hex string.
 */
function fnv1aHash(str: string): string {
    let hash = 0x811c9dc5; // FNV_offset_basis
  
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
  
    // Return as a hex string
    return (hash >>> 0).toString(16);
  }
  
  export function fastHash(obj: JsonObject, fields: string[]): string {
    if (fields.length === 0) return '';
    
    let combined = '';
    for (let i = 0; i < fields.length; i++) {
      const key = fields[i];
      if (!key) continue;
      const value = obj[key];
      if (value !== undefined) {
        // Create a string representation with field position to avoid collision from reordering
        const str = typeof value === 'string' ? value : JSON.stringify(value);
        combined += `${i}:${key}=${str}|`;
      }
    }
    
    return combined ? fnv1aHash(combined) : '';
  }