import { describe, test, expect } from "bun:test";
import { buildPlan, JsonSchemaPatcher } from "../src/index";
import { DiffFormatter } from "../src/formatting/DiffFormatter";
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

    const plan = buildPlan(userSchema, { primaryKeyMap: { "/posts": "postId" } });
    const patcher = new JsonSchemaPatcher({ plan });
    const patch = patcher.execute({original: doc1, modified: doc2});

    const formatter = new DiffFormatter(doc1, doc2);
    const sideBySideDiff = formatter.format(patch);

    expect(sideBySideDiff).toMatchSnapshot("side-by-side-diff");
  });
});
