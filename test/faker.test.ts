import { describe, test, expect } from "bun:test";
import { faker } from "@faker-js/faker";
import { applyPatch, type Operation as FastJsonPatchOperation } from "fast-json-patch";
import { buildPlan, SchemaPatcher } from "../src";

const userSchema = {
  type: "object",
  properties: {
    userId: { type: "string" },
    username: { type: "string" },
    email: { type: "string" },
    avatar: { type: "string" },
    password: { type: "string" },
    birthdate: { type: "string", format: "date-time" },
    registeredAt: { type: "string", format: "date-time" },
    address: {
      type: "object",
      properties: {
        street: { type: "string" },
        city: { type: "string" },
        zipCode: { type: "string" },
      },
      required: ["street", "city", "zipCode"],
    },
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          postId: { type: "string" },
          title: { type: "string" },
          content: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
          likes: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["postId", "title", "content", "timestamp", "likes"],
      },
    },
  },
  required: ["userId", "username", "email", "registeredAt"],
};

function createRandomUser() {
  return {
    userId: faker.string.uuid(),
    username: faker.internet.username(),
    email: faker.internet.email(),
    avatar: faker.image.avatar(),
    birthdate: faker.date.past().toISOString(),
    registeredAt: faker.date.past().toISOString(),
    address: {
      street: faker.location.streetAddress(),
      city: faker.location.city(),
      zipCode: faker.location.zipCode(),
    },
    posts: Array.from({ length: faker.number.int({ min: 2, max: 5 }) }, () => ({
      postId: faker.string.uuid(),
      title: faker.lorem.sentence(),
      content: faker.lorem.paragraphs(),
      timestamp: faker.date.recent().toISOString(),
      likes: faker.number.int({ min: 0, max: 1000 }),
      tags: Array.from(
        { length: faker.number.int({ min: 1, max: 5 }) },
        () => faker.lorem.word()
      ),
    })),
  };
}

describe("Faker-based tests", () => {
  test("should correctly patch complex objects with various changes", () => {
    const doc1 = createRandomUser();
    // A deep copy is needed to avoid modifying the original object
    const doc2 = JSON.parse(JSON.stringify(doc1));

    // 1. Change a simple property
    doc2.username = faker.internet.username();

    // 2. Add a new property
    doc2.lastLogin = faker.date.recent().toISOString();

    // 3. Remove a property
    delete doc2.address;

    // 4. Modify an array: remove, add, and change an item
    if (doc2.posts.length > 0) {
      // remove
      doc2.posts.splice(0, 1);
      // change
      if (doc2.posts.length > 0) {
        doc2.posts[0].title = "A new title";
        doc2.posts[0].likes += 10;
        // remove a tag
        if (doc2.posts[0].tags.length > 0) {
          doc2.posts[0].tags.pop();
        }
      }
    }
    // add a new post
    doc2.posts.push({
      postId: faker.string.uuid(),
      title: "Newly Added Post",
      content: faker.lorem.paragraphs(),
      timestamp: faker.date.recent().toISOString(),
      likes: 0,
      tags: ["new", "post"],
    });

    const plan = buildPlan(userSchema, { primaryKeyMap: { "/posts": "postId" } });
    const patcher = new SchemaPatcher({ plan });

    const patch = patcher.createPatch(doc1, doc2);

    const { newDocument } = applyPatch(doc1, patch as FastJsonPatchOperation[]);

    expect(newDocument).toEqual(doc2);
  });
}); 