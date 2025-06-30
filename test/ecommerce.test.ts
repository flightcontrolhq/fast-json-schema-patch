import { describe, it, expect, beforeEach } from 'bun:test';
import { SchemaJsonPatcher, buildPlan, deepEqual } from '../src/index';
import * as fastJsonPatch from 'fast-json-patch';
import ecommerceSchema from '../schema/e-commerce.json';
import { modifications } from '../comparison/ecommerceModifications';

describe('E-commerce schema patcher', () => {
  it('should correctly apply a failing set of e-commerce modifications', async () => {
    const doc1 = {
      store: {
        name: 'in consequat laborum sint velit',
        currency: 'WHY',
        locale: 'rw-IK',
        logoUrl: 'http://rSMPEthY.effqEljIn4RjlrTPpNsx4+2gq1mMH06vCktsBcljA0',
        supportEmail: '9dpOYK5I9XnFUU@ThHCqDQlGQ.ewg',
      },
      payments: {
        supportedMethods: ['credit_card'],
        stripe: {
          apiKey: 'ullamco non adipisicing nulla',
          webhookSecret: 'ipsum tempor',
        },
        paypal: {
          clientId: 'tempor occaecat non consequat',
          clientSecret: 'occaecat do',
        },
      },
      shipping: {
        rates: [
          {
            country: 'YZ',
            method: 'standard',
            cost: 52398678.20581745,
          },
          {
            country: 'QG',
            method: 'pickup',
            cost: 16907520.37746608,
            estimatedDays: 36428525,
          },
        ],
        freeOver: 37229643.79494879,
      },
      inventory: {
        thresholdAlert: 51856206,
      },
      features: {
        reviewsEnabled: false,
        relatedProducts: false,
      },
      analytics: {
        googleAnalyticsId: 'UA-803-35991238',
        trackUserBehavior: false,
      },
      categories: [
        {
          id: 'X3Hc3gVzhM',
          name: 'culpa dolore dolore amet laborum',
          slug: 'hlsz830zxrz',
          parentId: null,
        },
      ],
      products: [
        {
          id: '6c',
          name: 'mollit sunt',
          sku: 'anim aute adipisicing cupidatat est',
          description: 'labore adipisicing do',
          price: 77622278.22120932,
          categoryIds: [
            'Excepteur veniam sed',
            'cupidatat sit Ut tempor',
            'in sit esse magna pariatur',
            'enim magna',
          ],
          inventoryLevel: 42748741,
          attributes: {
            ty3loF55RD: 'in',
          },
        },
        {
          id: 'MUChgvSO0',
          name: 'eiusmod',
          sku: 'Ut nisi voluptate consectetur',
          description: 'adipisicing Lorem',
          price: 19684800.48128878,
          categoryIds: [
            'velit eu veniam',
            'Excepteur irure dolore',
            'dolore eiusmod dolor sit in',
            'dolor incididunt est proident',
          ],
          inventoryLevel: 13966937,
          attributes: {
            '9': 'deserunt enim mollit',
          },
        },
        {
          id: 'uWBLlYxKK',
          name: 'incididunt enim',
          sku: 'ipsum sit dolor culpa commodo',
          description: 'sunt dolor',
          price: 23915433.333707426,
          categoryIds: ['ex pariatur non cupidatat'],
          inventoryLevel: 15181821,
          attributes: {
            '7': 97507768.52203748,
          },
        },
      ],
      users: [
        {
          id: '2a12954e-0700-8fa3-c37f-c847e223aa1a',
          email: 'u4tET@gUJgLIEdtBJSG.pyz',
          roles: ['customer', 'guest'],
        },
        {
          id: 'a031848c-a276-d05e-98ac-1dc1ed622c8f',
          email: 'p5VMnmvQT8@kepxJcxlVgUQ.qgzj',
          roles: ['customer', 'guest', 'admin', 'manager'],
          metadata: {
            Excepteur_aae: 'aute dolor fugiat',
            mollit_86f: 32882802.684056893,
            est119: 42943215.384863496,
            officia_34: 'cillum sit officia nostrud pariatur',
          },
        },
      ],
    };

    const failingModificationNames = [
      'Reorder user roles',
      'Add a new category',
      'Change store currency',
      'Change shipping rate cost', // From "Change ship,"
      'Minor price tweak #86',
      'Minor price tweak #91',
      'Change shipping rate cost',
      'Minor price tweak #98',
    ];

    const doc2 = JSON.parse(JSON.stringify(doc1));

    const modsToApply = failingModificationNames.map(name => {
      const mod = modifications.find(m => m.name === name);
      if (!mod) {
        throw new Error(`Modification not found: ${name}`);
      }
      return mod;
    });

    for (const mod of modsToApply) {
      mod.modify(doc2);
    }

    const plan = buildPlan(ecommerceSchema as any);
    const patcher = new SchemaJsonPatcher({ plan });

    const patch = patcher.createPatch(doc1, doc2);

    let patchedDoc: any;
    try {
      const result = fastJsonPatch.applyPatch(
        JSON.parse(JSON.stringify(doc1)),
        patch as any,
        true,
        false
      );
      patchedDoc = result.newDocument;
    } catch (e) {
      console.log(`Test failed during patch application!`);
      console.log('Original document:', JSON.stringify(doc1, null, 2));
      console.log('Modified document:', JSON.stringify(doc2, null, 2));
      console.log('Patch:', JSON.stringify(patch, null, 2));
      console.error(e);
      // Fail the test explicitly
      expect(e).toBeUndefined();
      return;
    }

    // For debugging
    if (!deepEqual(patchedDoc, doc2)) {
      console.log(`Test failed!`);
      console.log('Original document:', JSON.stringify(doc1, null, 2));
      console.log('Modified document:', JSON.stringify(doc2, null, 2));
      console.log('Patched document:', JSON.stringify(patchedDoc, null, 2));
      console.log('Patch:', JSON.stringify(patch, null, 2));
      const { diff } = await import('jsondiffpatch');
      const delta = diff(patchedDoc, doc2);
      console.log(
        'Diff between patched and modified:',
        JSON.stringify(delta, null, 2)
      );
    }

    expect(deepEqual(patchedDoc, doc2)).toBe(true);
  });
}); 