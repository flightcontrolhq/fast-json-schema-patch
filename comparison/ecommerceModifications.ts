import { faker } from "@faker-js/faker";
import jsf from "json-schema-faker";
import ecommerceSchema from "../schema/e-commerce.json";
import type {
  Category,
  EcommerceConfig,
  Product,
  ShippingRate,
  User,
} from "../src/types/ecommerce";

// Make faker available to json-schema-faker for better random values
// @ts-ignore – the old 0.x json-schema-faker typings don't expose extend()
jsf.extend("faker", () => faker);

export interface EcommerceModificationDescriptor {
  name: string;
  complexity: number;
  modify: (doc: EcommerceConfig) => void;
}

/**
 * Generate a completely random e-commerce configuration that satisfies the JSON-Schema in
 * `schema/e-commerce.json`.
 */
export function generateRandomECommerceConfig(): EcommerceConfig {
  // Deep copy schema to avoid modifying the original import
  const localSchema = JSON.parse(JSON.stringify(ecommerceSchema));

  // Randomize the number of items in major arrays to stress test
  const numProducts = faker.number.int({ min: 10, max: 500 });
  if (localSchema.properties?.products) {
    localSchema.properties.products.minItems = numProducts;
    localSchema.properties.products.maxItems = numProducts;
  }

  const numCategories = faker.number.int({ min: 5, max: 50 });
  if (localSchema.properties?.categories) {
    localSchema.properties.categories.minItems = numCategories;
    localSchema.properties.categories.maxItems = numCategories;
  }

  const numUsers = faker.number.int({ min: 20, max: 1000 });
  if (localSchema.properties?.users) {
    localSchema.properties.users.minItems = numUsers;
    localSchema.properties.users.maxItems = numUsers;
  }

  // json-schema-faker will create an object that adheres to the schema. The output is *very*
  // detailed, but for the benchmark that is exactly what we want.
  const config = jsf.generate(localSchema) as EcommerceConfig;

  // Post-process to ensure unique IDs, as json-schema-faker may generate duplicates.
  if (config.products) {
    const ids = new Set<string>();
    config.products.forEach((p) => {
      while (ids.has(p.id)) {
        p.id = faker.string.alphanumeric(10);
      }
      ids.add(p.id);
    });
  }
  if (config.categories) {
    const ids = new Set<string>();
    config.categories.forEach((c) => {
      while (ids.has(c.id)) {
        c.id = faker.string.alphanumeric(10);
      }
      ids.add(c.id);
    });
  }
  if (config.users) {
    const ids = new Set<string>();
    config.users.forEach((u) => {
      while (ids.has(u.id)) {
        u.id = faker.string.uuid();
      }
      ids.add(u.id);
    });
  }

  return config;
}

/*********************************************************************************************
 * 100 E-commerce-specific modifications with monotonically increasing complexity            *
 *********************************************************************************************/
export const modifications: EcommerceModificationDescriptor[] = [];

// Helper utilities
function pickRandom<T>(arr: T[]): T {
  return faker.helpers.arrayElement(arr);
}

function generateUniqueId(existingIds: Set<string>): string {
  let newId = faker.string.alphanumeric(8);
  while (existingIds.has(newId)) {
    newId = faker.string.alphanumeric(8);
  }
  return newId;
}

function generateUniqueUUID(existingIds: Set<string>): string {
  let newId = faker.string.uuid();
  while (existingIds.has(newId)) {
    newId = faker.string.uuid();
  }
  return newId;
}

function getRandomProduct(doc: EcommerceConfig): Product | undefined {
  return Array.isArray(doc.products) && doc.products.length > 0
    ? pickRandom(doc.products)
    : undefined;
}
function getRandomCategory(doc: EcommerceConfig): Category | undefined {
  return Array.isArray(doc.categories) && doc.categories.length > 0
    ? pickRandom(doc.categories)
    : undefined;
}
function getRandomUser(doc: EcommerceConfig): User | undefined {
  return Array.isArray(doc.users) && doc.users.length > 0
    ? pickRandom(doc.users)
    : undefined;
}

/*********************************************************************************************
 * 🟢  SIMPLE MODIFICATIONS  (complexity 1-10) – mostly single-field tweaks                   *
 *********************************************************************************************/
modifications.push(
  {
    name: "Change store name",
    complexity: 2,
    modify: (doc) => {
      if (doc.store) doc.store.name = faker.company.name();
    },
  },
  {
    name: "Change store currency",
    complexity: 2,
    modify: (doc) => {
      if (doc.store)
        doc.store.currency = pickRandom(["USD", "EUR", "GBP", "INR"]);
    },
  },
  {
    name: "Change store locale",
    complexity: 3,
    modify: (doc) => {
      if (doc.store)
        doc.store.locale = pickRandom(["en-US", "en-GB", "fr-FR", "de-DE"]);
    },
  },
  {
    name: "Update store logo URL",
    complexity: 3,
    modify: (doc) => {
      if (doc.store) doc.store.logoUrl = faker.image.url();
    },
  },
  {
    name: "Update support email",
    complexity: 3,
    modify: (doc) => {
      if (doc.store) doc.store.supportEmail = faker.internet.email();
    },
  },
  {
    name: "Toggle guest checkout feature",
    complexity: 3,
    modify: (doc) => {
      if (!doc.features) doc.features = {};
      doc.features.guestCheckout = !doc.features.guestCheckout;
    },
  },
  {
    name: "Toggle reviews feature",
    complexity: 3,
    modify: (doc) => {
      if (!doc.features) doc.features = {};
      doc.features.reviewsEnabled = !doc.features.reviewsEnabled;
    },
  },
  {
    name: "Toggle related products feature",
    complexity: 3,
    modify: (doc) => {
      if (!doc.features) doc.features = {};
      doc.features.relatedProducts = !doc.features.relatedProducts;
    },
  },
  {
    name: "Switch Google Analytics tracking flag",
    complexity: 3,
    modify: (doc) => {
      if (!doc.analytics)
        doc.analytics = { googleAnalyticsId: "UA-12345-1" };
      doc.analytics.trackUserBehavior = !doc.analytics.trackUserBehavior;
    },
  },
  {
    name: "Change Google Analytics ID",
    complexity: 4,
    modify: (doc) => {
      if (!doc.analytics) doc.analytics = {};
      doc.analytics.googleAnalyticsId = `UA-${faker.string.numeric(
        6
      )}-${faker.string.numeric(1)}`;
    },
  },
  {
    name: "Add a payment method",
    complexity: 4,
    modify: (doc) => {
      if (!doc.payments?.supportedMethods) return;
      const all = ["credit_card", "paypal", "stripe", "upi"];
      const availableMethods = all.filter(
        (m) => !doc.payments.supportedMethods.includes(m)
      );
      if (availableMethods.length > 0) {
        const toAdd = pickRandom(availableMethods);
        doc.payments.supportedMethods.push(toAdd);
      }
    },
  },
  {
    name: "Remove a payment method",
    complexity: 4,
    modify: (doc) => {
      if (doc.payments?.supportedMethods?.length > 1) {
        const index = faker.number.int({
          min: 0,
          max: doc.payments.supportedMethods.length - 1,
        });
        doc.payments.supportedMethods.splice(index, 1);
      }
    },
  },
  {
    name: "Change inventory threshold alert",
    complexity: 4,
    modify: (doc) => {
      if (!doc.inventory) doc.inventory = { thresholdAlert: 10 };
      doc.inventory.thresholdAlert = faker.number.int({ min: 1, max: 100 });
    },
  },
  {
    name: "Toggle auto-restock",
    complexity: 4,
    modify: (doc) => {
      if (!doc.inventory) doc.inventory = { thresholdAlert: 10 };
      doc.inventory.autoRestock = !doc.inventory.autoRestock;
    },
  },
  {
    name: "Change product price",
    complexity: 5,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod) {
        prod.price = faker.number.float({
          min: 1,
          max: 999,
        });
      }
    },
  },
  {
    name: "Change product SKU",
    complexity: 5,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod) {
        prod.sku = faker.string.alphanumeric(12);
      }
    },
  },
  {
    name: "Update product description",
    complexity: 6,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod) {
        prod.description = faker.commerce.productDescription();
      }
    },
  },
  {
    name: "Update inventory level for a product",
    complexity: 5,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod) {
        prod.inventoryLevel = faker.number.int({ min: 0, max: 500 });
      }
    },
  },
  {
    name: "Rename category",
    complexity: 7,
    modify: (doc) => {
      const cat = getRandomCategory(doc);
      if (cat) {
        const newName = faker.commerce.department();
        cat.name = newName;
        cat.slug = faker.helpers.slugify(newName.toLowerCase());
      }
    },
  },
  {
    name: "Update user name",
    complexity: 6,
    modify: (doc) => {
      const user = getRandomUser(doc);
      if (user) {
        user.name = faker.person.fullName();
      }
    },
  },
  {
    name: "Change shipping rate cost",
    complexity: 7,
    modify: (doc) => {
      if (doc.shipping?.rates?.length) {
        const rate = pickRandom(doc.shipping.rates);
        rate.cost = faker.number.float({
          min: 0,
          max: 30,
        });
      }
    },
  },
  {
    name: "Change shipping rate estimated days",
    complexity: 7,
    modify: (doc) => {
      if (doc.shipping?.rates?.length) {
        const rate = pickRandom(doc.shipping.rates);
        rate.estimatedDays = faker.number.int({ min: 1, max: 14 });
      }
    },
  },
  {
    name: "Add metadata to a user",
    complexity: 8,
    modify: (doc) => {
      const user = getRandomUser(doc);
      if (user) {
        if (!user.metadata) user.metadata = {};
        user.metadata[faker.lorem.word()] = faker.lorem.sentence();
      }
    },
  },
  {
    name: "Add attribute to a product",
    complexity: 8,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod) {
        if (!prod.attributes) prod.attributes = {};
        const key = faker.lorem.slug();
        prod.attributes[key] = pickRandom([
          faker.color.human(),
          faker.number.float({ min: 0, max: 100 }),
          faker.datatype.boolean(),
        ]);
      }
    },
  },
  {
    name: "Remove an attribute from a product",
    complexity: 8,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod?.attributes) {
        const keys = Object.keys(prod.attributes);
        if (keys.length > 0) {
          delete prod.attributes[pickRandom(keys)];
        }
      }
    },
  }
);
/*********************************************************************************************
 * 🟡  MEDIUM MODIFICATIONS  (complexity 11-40) – structural tweaks on single arrays         *
 *********************************************************************************************/
modifications.push(
  {
    name: "Add a shipping rate",
    complexity: 15,
    modify: (doc) => {
      if (!doc.shipping?.rates) return;
      doc.shipping.rates.push({
        country: pickRandom(["US", "GB", "DE", "FR", "IN"]),
        method: pickRandom(["standard", "express", "pickup"]),
        cost: faker.number.float({ min: 0, max: 30 }),
        estimatedDays: faker.number.int({ min: 1, max: 14 }),
      });
    },
  },
  {
    name: "Remove a random shipping rate",
    complexity: 12,
    modify: (doc) => {
      if (doc.shipping?.rates?.length > 1) {
        const idx = faker.number.int({
          min: 0,
          max: doc.shipping.rates.length - 1,
        });
        doc.shipping.rates.splice(idx, 1);
      }
    },
  },
  {
    name: "Add a new category",
    complexity: 18,
    modify: (doc) => {
      if (!doc.categories) doc.categories = [];
      const existingIds = new Set(doc.categories.map((c) => c.id));
      const newId = generateUniqueId(existingIds);
      doc.categories.push({
        id: newId,
        name: faker.commerce.department(),
        slug: faker.helpers.slugify(faker.commerce.department().toLowerCase()),
        parentId: null,
      });
    },
  },
  {
    name: "Remove a category",
    complexity: 25,
    modify: (doc) => {
      const cat = getRandomCategory(doc);
      if (cat && doc.categories.length > 1) {
        doc.categories = doc.categories.filter((c) => c.id !== cat.id);
        // also remove this categoryId from any products
        if (doc.products) {
          doc.products.forEach((p) => {
            if (p.categoryIds) {
              p.categoryIds = p.categoryIds.filter((cid) => cid !== cat.id);
            }
          });
        }
      }
    },
  },
  {
    name: "Add a role to a user",
    complexity: 14,
    modify: (doc) => {
      const user = getRandomUser(doc);
      if (user && user.roles) {
        const allRoles = ["admin", "manager", "customer", "guest"];
        const availableRoles = allRoles.filter((r) => !user.roles.includes(r));
        if (availableRoles.length > 0) {
          const toAdd = pickRandom(availableRoles);
          if (toAdd) user.roles.push(toAdd);
        }
      }
    },
  },
  {
    name: "Remove a role from a user",
    complexity: 14,
    modify: (doc) => {
      const user = getRandomUser(doc);
      if (user && user.roles?.length > 1) {
        const idx = faker.number.int({ min: 0, max: user.roles.length - 1 });
        user.roles.splice(idx, 1);
      }
    },
  },
  {
    name: "Add a product to a category",
    complexity: 16,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      const cat = getRandomCategory(doc);
      if (prod && cat && !prod.categoryIds.includes(cat.id)) {
        prod.categoryIds.push(cat.id);
      }
    },
  },
  {
    name: "Remove a product from a category",
    complexity: 16,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod && prod.categoryIds?.length > 1) {
        const idx = faker.number.int({ min: 0, max: prod.categoryIds.length - 1 });
        prod.categoryIds.splice(idx, 1);
      }
    },
  },
  {
    name: "Add free shipping threshold",
    complexity: 15,
    modify: (doc) => {
      if (!doc.shipping) doc.shipping = { rates: [] };
      doc.shipping.freeOver = faker.number.float({
        min: 50,
        max: 500,
      });
    },
  },
  {
    name: "Remove free shipping threshold",
    complexity: 12,
    modify: (doc) => {
      if (doc.shipping) delete doc.shipping.freeOver;
    },
  },
  {
    name: "Add inventory restock level",
    complexity: 14,
    modify: (doc) => {
      if (!doc.inventory) doc.inventory = { thresholdAlert: 10 };
      doc.inventory.restockLevel = faker.number.int({ min: 10, max: 500 });
    },
  },
  {
    name: "Remove inventory restock level",
    complexity: 11,
    modify: (doc) => {
      if (doc.inventory) delete doc.inventory.restockLevel;
    },
  },
  {
    name: "Add Stripe credentials",
    complexity: 20,
    modify: (doc) => {
      if (!doc.payments) doc.payments = { supportedMethods: [] };
      doc.payments.stripe = {
        apiKey: faker.string.alphanumeric(32),
        webhookSecret: faker.string.alphanumeric(32),
      };
    },
  },
  {
    name: "Remove Stripe credentials",
    complexity: 18,
    modify: (doc) => {
      if (doc.payments) delete doc.payments.stripe;
    },
  },
  {
    name: "Add PayPal credentials",
    complexity: 20,
    modify: (doc) => {
      if (!doc.payments) doc.payments = { supportedMethods: [] };
      doc.payments.paypal = {
        clientId: faker.string.alphanumeric(16),
        clientSecret: faker.string.alphanumeric(32),
      };
    },
  },
  {
    name: "Reorder shipping rates",
    complexity: 22,
    modify: (doc) => {
      if (doc.shipping?.rates?.length > 1) {
        doc.shipping.rates = faker.helpers.shuffle(doc.shipping.rates);
      }
    },
  },
  {
    name: "Reorder product categories",
    complexity: 25,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod && prod.categoryIds?.length > 1) {
        prod.categoryIds = faker.helpers.shuffle(prod.categoryIds);
      }
    },
  },
  {
    name: "Reorder user roles",
    complexity: 20,
    modify: (doc) => {
      const user = getRandomUser(doc);
      if (user && user.roles?.length > 1) {
        user.roles = faker.helpers.shuffle(user.roles);
      }
    },
  },
  {
    name: "Clear all user metadata",
    complexity: 28,
    modify: (doc) => {
      const user = getRandomUser(doc);
      if (user) user.metadata = {};
    },
  },
  {
    name: "Clear all product attributes",
    complexity: 30,
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod) prod.attributes = {};
    },
  },
  {
    name: "Make a category a root category",
    complexity: 15,
    modify: (doc) => {
      const cat = getRandomCategory(doc);
      if (cat) cat.parentId = null;
    },
  },
  {
    name: "Update a user's email",
    complexity: 12,
    modify: (doc) => {
      const user = getRandomUser(doc);
      if (user) user.email = faker.internet.email();
    },
  },
  {
    name: "Shuffle the order of products",
    complexity: 35,
    modify: (doc) => {
      if (doc.products?.length > 1) {
        doc.products = faker.helpers.shuffle(doc.products);
      }
    },
  },
  {
    name: "Shuffle the order of categories",
    complexity: 32,
    modify: (doc) => {
      if (doc.categories?.length > 1) {
        doc.categories = faker.helpers.shuffle(doc.categories);
      }
    },
  },
  {
    name: "Shuffle the order of users",
    complexity: 30,
    modify: (doc) => {
      if (doc.users?.length > 1) {
        doc.users = faker.helpers.shuffle(doc.users);
      }
    },
  },
);
/*********************************************************************************************
 * 🟠  HIGH MODIFICATIONS  (complexity 41-70) – multi-record or nested structure changes     *
 *********************************************************************************************/
modifications.push(
  {
    name: "Add new product",
    complexity: 45,
    modify: (doc) => {
      if (!doc.products) doc.products = [];
      const existingIds = new Set(doc.products.map((p) => p.id));
      const newId = generateUniqueId(existingIds);
      doc.products.push({
        id: newId,
        name: faker.commerce.productName(),
        sku: faker.string.alphanumeric(12),
        description: faker.commerce.productDescription(),
        price: faker.number.float({ min: 5, max: 500 }),
        categoryIds: doc.categories?.length
          ? [pickRandom(doc.categories).id]
          : [],
        inventoryLevel: faker.number.int({ min: 0, max: 500 }),
      });
    },
  },
  {
    name: "Remove a random product",
    complexity: 45,
    modify: (doc) => {
      if (Array.isArray(doc.products) && doc.products.length > 1) {
        const idx = faker.number.int({ min: 0, max: doc.products.length - 1 });
        doc.products.splice(idx, 1);
      }
    },
  },
  {
    name: "Add a new user",
    complexity: 42,
    modify: (doc) => {
      if (!doc.users) doc.users = [];
      const existingIds = new Set(doc.users.map((u) => u.id));
      const newId = generateUniqueUUID(existingIds);
      doc.users.push({
        id: newId,
        email: faker.internet.email(),
        name: faker.person.fullName(),
        roles: [pickRandom(["customer", "manager", "admin"])],
        metadata: {},
      });
    },
  },
  {
    name: "Remove a random user",
    complexity: 42,
    modify: (doc) => {
      if (Array.isArray(doc.users) && doc.users.length > 1) {
        const idx = faker.number.int({ min: 0, max: doc.users.length - 1 });
        doc.users.splice(idx, 1);
      }
    },
  },
  {
    name: "Bulk update 10 product prices",
    complexity: 60,
    modify: (doc) => {
      if (Array.isArray(doc.products)) {
        faker.helpers
          .shuffle(doc.products)
          .slice(0, 10)
          .forEach((p: any) => {
            p.price = faker.number.float({
              min: 1,
              max: 999,
            });
          });
      }
    },
  },
  {
    name: "Move a category under another parent",
    complexity: 55,
    modify: (doc) => {
      if (doc.categories?.length >= 2) {
        const child = pickRandom(doc.categories);
        const parent = pickRandom(
          doc.categories.filter((c) => c.id !== child.id)
        );
        child.parentId = parent.id;
      }
    },
  },
  {
    name: "Add estimated delivery days to all shipping rates",
    complexity: 55,
    modify: (doc) => {
      if (doc.shipping?.rates?.length) {
        doc.shipping.rates.forEach((r: any) => {
          r.estimatedDays = faker.number.int({ min: 1, max: 14 });
        });
      }
    },
  },
  {
    name: "Assign all products to a random category",
    complexity: 65,
    modify: (doc) => {
      const cat = getRandomCategory(doc);
      if (cat && doc.products?.length) {
        doc.products.forEach((p) => {
          p.categoryIds = [cat.id];
        });
      }
    },
  },
  {
    name: "Give all users a new role",
    complexity: 62,
    modify: (doc) => {
      if (doc.users?.length) {
        const newRole = pickRandom(["guest", "customer", "manager"]);
        doc.users.forEach((u: any) => {
          if (!u.roles.includes(newRole)) u.roles.push(newRole);
        });
      }
    },
  },
  {
    name: "Bulk update inventory level for 20 products",
    complexity: 68,
    modify: (doc) => {
      if (doc.products?.length) {
        faker.helpers.shuffle(doc.products).slice(0, 20).forEach((p: any) => {
          p.inventoryLevel = faker.number.int({ min: 0, max: 100 });
        });
      }
    },
  },
  {
    name: "Remove all shipping rates for a country",
    complexity: 48,
    modify: (doc) => {
      if (doc.shipping?.rates?.length) {
        const country = pickRandom(doc.shipping.rates).country;
        doc.shipping.rates = doc.shipping.rates.filter((r: any) => r.country !== country);
      }
    },
  },
  {
    name: "Add a new attribute to all products",
    complexity: 70,
    modify: (doc) => {
      if (doc.products?.length) {
        const key = faker.lorem.slug();
        const value = faker.color.human();
        doc.products.forEach((p: any) => {
          if (!p.attributes) p.attributes = {};
          p.attributes[key] = value;
        });
      }
    },
  },
  {
    name: "Make all categories children of a new root category",
    complexity: 65,
    modify: (doc) => {
      if (doc.categories?.length) {
        const existingIds = new Set(doc.categories.map((c) => c.id));
        let newRootId = "new-root";
        while (existingIds.has(newRootId)) {
          newRootId = `new-root-${faker.string.alphanumeric(4)}`;
        }
        const newRoot: Category = {
          id: newRootId,
          name: "All Products",
          slug: "all-products",
          parentId: null
        };
        doc.categories.forEach((c) => {
          c.parentId = newRoot.id;
        });
        doc.categories.push(newRoot);
      }
    },
  },
  {
    name: "Standardize all product SKUs to a new format",
    complexity: 58,
    modify: (doc) => {
      if (doc.products?.length) {
        doc.products.forEach((p: any, i: number) => {
          p.sku = `PROD-${(i + 1).toString().padStart(4, '0')}-${faker.string.alphanumeric(4)}`;
        });
      }
    },
  },
  {
    name: "Clear all payment methods and add just one",
    complexity: 41,
    modify: (doc) => {
      if (doc.payments) {
        doc.payments.supportedMethods = ['credit_card'];
        delete doc.payments.paypal;
        delete doc.payments.stripe;
      }
    },
  },
  {
    name: "Flash-sale: 20% discount on all products",
    complexity: 80,
    modify: (doc) => {
      if (Array.isArray(doc.products)) {
        doc.products.forEach((p: any) => {
          p.price = Number((p.price * 0.8).toFixed(2));
        });
      }
    },
  },
  {
    name: "Add 25 new products",
    complexity: 95,
    modify: (doc) => {
      if (!doc.products) doc.products = [];
      const existingIds = new Set(doc.products.map((p) => p.id));
      for (let i = 0; i < 25; i++) {
        const newId = generateUniqueId(existingIds);
        existingIds.add(newId);
        doc.products.push({
          id: newId,
          name: faker.commerce.productName(),
          sku: faker.string.alphanumeric(12),
          description: faker.commerce.productDescription(),
          price: faker.number.float({ min: 1, max: 999 }),
          categoryIds: doc.categories?.length
            ? [pickRandom(doc.categories).id]
            : [],
          inventoryLevel: faker.number.int({ min: 0, max: 500 }),
        });
      }
    },
  },
  {
    name: "Bulk category slug update",
    complexity: 72,
    modify: (doc) => {
      if (Array.isArray(doc.categories)) {
        doc.categories.forEach((c: any) => {
          c.slug = faker.helpers.slugify(
            c.name.toLowerCase() + "-" + faker.number.int({ min: 1, max: 99 })
          );
        });
      }
    },
  },
  {
    name: "Add 10 new shipping rates",
    complexity: 75,
    modify: (doc) => {
      if (!doc.shipping) doc.shipping = { rates: [] };
      if (!doc.shipping.rates) doc.shipping.rates = [];
      for (let i = 0; i < 10; i++) {
        doc.shipping.rates.push({
          country: pickRandom(["US", "GB", "DE", "FR", "IN", "NL", "BR", "JP"]),
          method: pickRandom(["standard", "express", "pickup"]),
          cost: faker.number.float({ min: 0, max: 50 }),
          estimatedDays: faker.number.int({ min: 1, max: 21 }),
        });
      }
    },
  },
  {
    name: "Purge all users except admins",
    complexity: 78,
    modify: (doc) => {
      if (Array.isArray(doc.users)) {
        doc.users = doc.users.filter((u: any) => u.roles?.includes("admin"));
      }
    },
  },
  {
    name: "Merge duplicate categories (by name)",
    complexity: 90,
    modify: (doc) => {
      if (!Array.isArray(doc.categories)) {
        return;
      }
      const seen = new Map<string, Category>();
      const toKeep: Category[] = [];
      doc.categories.forEach((c) => {
        if (seen.has(c.name)) {
          // Map products that referenced old id to the seen one
          const targetId = seen.get(c.name)!.id;
          if (Array.isArray(doc.products)) {
            doc.products.forEach((p) => {
              if (p.categoryIds) {
                const idx = p.categoryIds.indexOf(c.id);
                if (idx > -1) {
                  p.categoryIds[idx] = targetId;
                  // remove duplicates if any
                  p.categoryIds = [...new Set(p.categoryIds)];
                }
              }
            });
          }
        } else {
          seen.set(c.name, c);
          toKeep.push(c);
        }
      });
      doc.categories = toKeep;
    },
  },
  {
    name: "Reset all inventory to zero",
    complexity: 82,
    modify: (doc) => {
      if (doc.products) {
        doc.products.forEach((p) => {
          p.inventoryLevel = 0;
        });
      }
    },
  },
  {
    name: "Replace all products with 5 new ones",
    complexity: 110,
    modify: (doc) => {
      const newProducts: Product[] = [];
      const newIds = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const newId = generateUniqueId(newIds);
        newIds.add(newId);
        newProducts.push({
          id: newId,
          name: faker.commerce.productName(),
          sku: faker.string.alphanumeric(12),
          description: faker.commerce.productDescription(),
          price: faker.number.float({ min: 1, max: 999 }),
          categoryIds: doc.categories?.length
            ? [pickRandom(doc.categories).id]
            : [],
          inventoryLevel: faker.number.int({ min: 0, max: 500 }),
        });
      }
      doc.products = newProducts;
    },
  },
  {
    name: "Replace all categories with 3 new ones and remap products",
    complexity: 120,
    modify: (doc) => {
      const newCategories: Category[] = [];
      const newIds = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const newId = generateUniqueId(newIds);
        newIds.add(newId);
        const name = faker.commerce.department();
        newCategories.push({
          id: newId,
          name,
          slug: faker.helpers.slugify(name.toLowerCase()),
          parentId: null,
        });
      }
      doc.categories = newCategories;
      if (doc.products) {
        doc.products.forEach((p) => {
          p.categoryIds = [pickRandom(newCategories).id];
        });
      }
    },
  },
  {
    name: "Inflate all prices by 50%",
    complexity: 78,
    modify: (doc) => {
      if (doc.products) {
        doc.products.forEach((p: any) => {
          p.price = Number((p.price * 1.5).toFixed(2));
        });
      }
    },
  },
  {
    name: "Delete all shipping rates and features",
    complexity: 85,
    modify: (doc) => {
      if (doc.shipping) doc.shipping.rates = [];
      if (doc.features) doc.features = {};
    },
  },
  {
    name: "Add 50 new users",
    complexity: 100,
    modify: (doc) => {
      if (!doc.users) doc.users = [];
      const existingIds = new Set(doc.users.map((u) => u.id));
      for (let i = 0; i < 50; i++) {
        const newId = generateUniqueUUID(existingIds);
        existingIds.add(newId);
        doc.users.push({
          id: newId,
          email: faker.internet.email(),
          name: faker.person.fullName(),
          roles: ["customer"],
        });
      }
    },
  },
);

// We currently have fewer than 100 explicit modifications. Fill the remainder with
// automatically-generated product-price tweaks (unique names) so that we hit exactly 100.
while (modifications.length < 100) {
  const idx = modifications.length + 1;
  modifications.push({
    name: `Minor price tweak #${idx}`,
    complexity: faker.number.int({ min: 5, max: 25 }),
    modify: (doc) => {
      const prod = getRandomProduct(doc);
      if (prod) {
        const factor = faker.number.float({
          min: 0.95,
          max: 1.05,
        });
        prod.price = Number((prod.price * factor).toFixed(2));
      }
    },
  });
}

/*********************************************************************************************
 * Intelligent selection & application helpers – copied from cloud-config logic              *
 *********************************************************************************************/
export function selectECommerceModificationsForComplexity(
  targetComplexity: number,
  complexityRange: { label: string; min: number; max: number }
): EcommerceModificationDescriptor[] {
  // Sort modifications by complexity for deterministic selection
  const sortedMods = [...modifications].sort((a, b) => a.complexity - b.complexity);

  const low = sortedMods.filter((m) => m.complexity <= 10);
  const medium = sortedMods.filter((m) => m.complexity > 10 && m.complexity <= 35);
  const high = sortedMods.filter((m) => m.complexity > 35);

  const selected: EcommerceModificationDescriptor[] = [];
  let currentComplexity = 0;
  const fakerInt = (min: number, max: number) => faker.number.int({ min, max });

  const pushRandom = (pool: EcommerceModificationDescriptor[]) => {
    const mod = pickRandom(pool);
    selected.push(mod);
    currentComplexity += mod.complexity;
  };

  if (complexityRange.label === "Low") {
    const num = fakerInt(2, 6);
    while (selected.length < num && currentComplexity < targetComplexity) pushRandom(low);
  } else if (complexityRange.label === "Medium") {
    const numMed = fakerInt(1, 3);
    const numLow = fakerInt(2, 6);
    while (selected.filter((m) => medium.includes(m)).length < numMed && currentComplexity < targetComplexity - 15) pushRandom(medium);
    while (selected.length < numMed + numLow && currentComplexity < targetComplexity) pushRandom(low);
  } else if (complexityRange.label === "High") {
    const numHigh = fakerInt(1, 2);
    const numMed = fakerInt(2, 4);
    const numLow = fakerInt(3, 6);
    while (selected.filter((m) => high.includes(m)).length < numHigh && currentComplexity < targetComplexity - 80) pushRandom(high);
    while (selected.filter((m) => medium.includes(m)).length < numMed && currentComplexity < targetComplexity - 40) pushRandom(medium);
    while (selected.length < numHigh + numMed + numLow && currentComplexity < targetComplexity) pushRandom(low);
  } else {
    // Very-High
    const numHigh = fakerInt(3, 6);
    const numMed = fakerInt(4, 8);
    const numLow = fakerInt(4, 10);
    while (selected.filter((m) => high.includes(m)).length < numHigh && currentComplexity < targetComplexity - 150) pushRandom(high);
    while (selected.filter((m) => medium.includes(m)).length < numMed && currentComplexity < targetComplexity - 70) pushRandom(medium);
    while (selected.length < numHigh + numMed + numLow && currentComplexity < targetComplexity) pushRandom(low);
  }

  return selected;
}

export function applyECommerceModificationsForTargetComplexity(
  doc: any,
  targetComplexity: number,
  complexityRange: { label: string; min: number; max: number }
): { appliedModifications: string[]; actualComplexity: number } {
  const selectedMods = selectECommerceModificationsForComplexity(targetComplexity, complexityRange);
  let total = 0;
  const names: string[] = [];
  for (const mod of selectedMods) {
    mod.modify(doc);
    total += mod.complexity;
    names.push(mod.name);
  }
  return { appliedModifications: names, actualComplexity: total };
} 