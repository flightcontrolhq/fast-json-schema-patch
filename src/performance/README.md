# Performance-Optimized Deep Equality Functions

This document outlines the different deep equality functions available in this module, their time complexities, and when to use them. These functions are designed to provide significant performance improvements over naive deep equality checks, especially in the context of comparing complex, schema-driven objects.

## Functions

### `deepEqual`

- **Purpose**: A standard, recursive deep equality check for JSON-like objects and arrays.
- **Time Complexity**: O(N), where N is the total number of properties and elements in the objects being compared.
- **When to use**: Use this function for simple, one-off comparisons where performance is not critical, or when no additional information (like a schema or frequently changing fields) is available. It serves as the baseline for other optimized functions.
- **Complexity Note**: Although the function is recursive, it traverses each property and element of the input objects only once. Therefore, its time complexity is linear with respect to the total number of properties and elements (N), not polynomial.

### `deepEqualMemo`

- **Purpose**: A memoized version of `deepEqual`. It caches the results of comparisons, so subsequent comparisons of the same two objects are nearly instantaneous.
- **Time Complexity**:
  - **First call**: O(K + N), where K is the number of `hotFields` and N is the total number of properties. The `fastHash` on `hotFields` is O(K).
  - **Subsequent calls (cache hit)**: O(1) on average.
  - **Early exit on hash mismatch**: O(K).
- **When to use**: Use `deepEqualMemo` when you expect to compare the same pair of objects multiple times. The initial comparison is slightly more expensive than `deepEqual` (if using `hotFields`), but subsequent calls are extremely fast. The `hotFields` option is useful for a quick check on fields that are highly likely to be different, providing a fast path to inequality.

### `deepEqualSchemaAware`

- **Purpose**: The most advanced and performant equality function, designed to work with schema information (`ArrayPlan`). It uses a multi-layered approach to find inequalities as quickly as possible.
- **Time Complexity**: Highly variable, designed for fast exits.
  - **Best case (cache hit or hash mismatch)**: O(1) to O(E), where E is the number of fields used for hashing.
  - **Common case (difference in required fields or primary key)**: Faster than a full comparison. It checks a small subset of fields first.
  - **Worst case (objects are deeply equal or differ in a non-prioritized field)**: O(E + N), where it performs hashing and then a full deep equal.
- **When to use**: This is the recommended function when you have schema information. It intelligently uses `primaryKey`, `requiredFields`, and `hashFields` from your plan to optimize comparisons. It prioritizes checking the most significant fields first, leading to very fast inequality detection in many real-world scenarios. Its memoization is also plan-aware, making it safe to use when the comparison logic itself might change.

### `getPlanFingerprint`

- **Purpose**: A helper function that generates a unique string identifier for a given `ArrayPlan`.
- **Time Complexity**: O(H), where H is the number of `hashFields` in the plan.
- **When to use**: This function is used internally by `deepEqualSchemaAware` to manage its plan-aware cache. You typically won't need to call it directly.

## Hashing

### `fastHash`

- **Purpose**: `fastHash` provides a fast, non-cryptographic hash of an object based on a specified subset of its fields. It uses a FNV-1a hashing algorithm.
- **Time Complexity**: O(K), where K is the number of fields being hashed.
- **When to use**: It's used internally by `deepEqualMemo` and `deepEqualSchemaAware` to get a quick "fingerprint" of an object. If the fingerprints of two objects don't match, they cannot be equal, allowing for a very fast exit without a full deep comparison.

## Caching Utilities

This module (`cache.ts`) provides several memoization utilities that use `WeakMap` to cache results without causing memory leaks.

### `cachedJsonStringify`

- **Purpose**: A cached version of `JSON.stringify(obj, null, 2)`.
- **Cache Key**: Object identity.
- **When to use**: Internally, to avoid re-serializing the same object multiple times.

### `cachedBuildPathMap`

- **Purpose**: Caches the generation of a JSON Pointer map for a given object. This map is used to resolve paths within the object.
- **Cache Key**: Object identity.
- **When to use**: Internally, to avoid re-parsing an object to build its path map.

### `getCachedFormatter`

- **Purpose**: A generic caching utility for any function or object that is derived from a pair of input objects (e.g., a diff formatter instance for an `original` and `new` object).
- **Cache Key**: A nested `WeakMap` using the identities of both input objects.
- **When to use**: Internally, to reuse complex objects that are expensive to create. 