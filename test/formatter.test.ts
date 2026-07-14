import { describe, test, expect } from "bun:test";
import { buildPlan, JsonSchemaPatcher } from "../src/index";
import { DiffFormatter } from "../src/formatting/DiffFormatter";
import type { FormattedDiffLines } from "../src/types";
import { faker } from "@faker-js/faker";

const userSchema = {
  type: "object",
  properties: {
    userId: { type: "string" },
    username: { type: "string" },
    email: { type: "string" },
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          postId: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["postId", "title", "content"],
      },
    },
    metadata: {
      type: "object",
      additionalProperties: true,
    },
  },
  required: ["userId", "username", "email"],
};

function createRandomUser() {
  return {
    userId: faker.string.uuid(),
    username: faker.internet.username(),
    email: faker.internet.email(),
    posts: Array.from(
      { length: faker.number.int({ min: 2, max: 3 }) },
      () => ({
        postId: faker.string.uuid(),
        title: faker.lorem.sentence(),
        content: faker.lorem.paragraphs(),
        tags: Array.from(
          { length: faker.number.int({ min: 1, max: 3 }) },
          () => faker.lorem.word()
        ),
      })
    ),
    metadata: {
      createdAt: new Date("2025-01-01").toISOString(),
      updatedAt: new Date("2025-01-01").toISOString(),
      source: "faker",
    },
  };
}

describe("DiffFormatter E2E Integration", () => {
  test("should generate correct side-by-side and unified diffs for a set of changes", () => {
    faker.seed(123); // for reproducible tests
    const doc1 = createRandomUser();
    const doc2 = JSON.parse(JSON.stringify(doc1));

    doc2.username = "new-test-user";
    doc2.metadata.newProp = 12345;

    delete doc2.email;

    doc2.posts.splice(1, 1);

    doc2.posts[0].title = "A Completely New Title";

    doc2.posts.push({
      postId: "new-post-id",
      title: "A Fresh Post",
      content: "This is a brand new post added to the list.",
      tags: ["new", "exciting"],
    });

    const plan = buildPlan({ schema: userSchema, primaryKeyMap: { "/posts": "postId" } });
    const patcher = new JsonSchemaPatcher({ plan });
    const patch = patcher.execute({original: doc1, modified: doc2});

    const formatter = new DiffFormatter(doc1, doc2);
    const sideBySideDiff = formatter.format(patch);

    expect(sideBySideDiff).toMatchSnapshot("side-by-side-diff");
  });
});

// F31: DiffFormatter memoizes format() results in a module-level cache keyed
// by (content hash, patches hash, plan fingerprint), evicting the oldest half
// of entries once size exceeds 1000 (DiffFormatter.ts `format()`). That
// eviction boundary had no direct coverage. The cache is module-private (not
// exported), so this drives it black-box: reuse a single DiffFormatter (fixed
// original/modified, so the content-hash portion of the key is constant) and
// vary only the patch path per call so every call is a distinct cache key.
// Pushing well past 1000 distinct keys forces at least one eviction pass;
// correctness is checked by confirming every call - whether served from
// cache or recomputed after being evicted - still returns a result that
// reflects its own distinct patch and not a neighboring cache entry's.
describe("DiffFormatter cache eviction boundary (F31)", () => {
  test("results stay correct across the >1000-entry eviction boundary", () => {
    const fieldCount = 1010;
    const original: Record<string, number> = {};
    const modified: Record<string, number> = {};
    for (let i = 0; i < fieldCount; i++) {
      original[`f${i}`] = i;
      modified[`f${i}`] = i + 1;
    }

    const formatter = new DiffFormatter(original, modified);

    const results = [];
    for (let i = 0; i < fieldCount; i++) {
      results.push(
        formatter.format([
          { op: "replace", path: `/f${i}`, value: i + 1, oldValue: i },
        ])
      );
    }

    // Spot-check early (likely evicted), middle, and late (likely still
    // cached) entries: each must reflect only its own field's change.
    for (const i of [0, 1, 499, 500, 501, 999, 1000, 1009]) {
      const result = results[i];
      const changedOriginal = result?.originalLines.filter(
        (l) => l.type === "removed"
      );
      const changedNew = result?.newLines.filter((l) => l.type === "added");

      expect(
        changedOriginal?.every((l) => l.content.includes(`"f${i}":`))
      ).toBe(true);
      expect(
        changedNew?.every((l) => l.content.includes(`"f${i}":`))
      ).toBe(true);
    }

    // Re-running the very first call's patch (near-guaranteed to have been
    // evicted by now) must recompute rather than return another entry's
    // stale/corrupted result.
    const recomputed = formatter.format([
      { op: "replace", path: "/f0", value: 1, oldValue: 0 },
    ]);
    expect(recomputed).toEqual(results[0] as FormattedDiffLines);
  });
});
