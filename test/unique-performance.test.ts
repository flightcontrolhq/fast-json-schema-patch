import { buildPlan, JsonSchemaPatcher } from '../src/index';
import { describe, test, expect } from "bun:test";

describe('Unique Array Performance', () => {
  test('should handle unique primitive arrays efficiently with minimal patches', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    };

    const plan = buildPlan({ schema } );
    const patcher = new JsonSchemaPatcher({ plan });

    const doc1 = {
      tags: ['javascript', 'typescript', 'react', 'node.js', 'mongodb']
    };

    const doc2 = {
      tags: ['javascript', 'python', 'react', 'postgresql', 'docker']
    };

    const patches = patcher.execute({original: doc1, modified: doc2});
    
    // Should generate minimal patches - prioritizing replace operations
    // Original: ['javascript', 'typescript', 'react', 'node.js', 'mongodb']
    // New:      ['javascript', 'python',     'react', 'postgresql', 'docker']
    // Expected: replace typescript->python, replace node.js->postgresql, replace mongodb->docker
    expect(patches).toHaveLength(3);
    
    // Check that we use replace operations instead of remove+add pairs
    expect(patches.filter(p => p.op === 'replace')).toHaveLength(3);
    expect(patches.filter(p => p.op === 'remove')).toHaveLength(0);
    expect(patches.filter(p => p.op === 'add')).toHaveLength(0);
  });

  test('should handle large unique arrays efficiently', () => {
    const schema = {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' }
        }
      }
    };

    const plan = buildPlan({ schema });
    const patcher = new JsonSchemaPatcher({ plan });

    // Generate large arrays with unique numbers - but with some overlap for replace optimization
    const arr1 = Array.from({ length: 1000 }, (_, i) => i);
    const arr2 = Array.from({ length: 1000 }, (_, i) => i < 500 ? i : i + 1000); // First 500 same, last 500 different

    const doc1 = { ids: arr1 };
    const doc2 = { ids: arr2 };

    const start = performance.now();
    const patches = patcher.execute({original: doc1, modified: doc2});
    const duration = performance.now() - start;

    // Should complete quickly - under 10ms for 1000 elements
    expect(duration).toBeLessThan(10);
    
    // With the modified test case: first 500 elements are same, last 500 are different
    // Should use 500 replace operations instead of 500 removes + 500 adds
    expect(patches.filter(p => p.op === 'replace').length).toBe(500);
    expect(patches.filter(p => p.op === 'add').length).toBe(0);
    expect(patches.filter(p => p.op === 'remove').length).toBe(0);
    expect(patches.length).toBe(500); // Should be exactly 500 replace operations
  });

  test('should demonstrate patch size optimization', () => {
    const schema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    };

    const plan = buildPlan({ schema });
    const patcher = new JsonSchemaPatcher({ plan });

    // Test case where replace is optimal
    const doc1 = { items: ['a', 'b', 'c', 'd'] };
    const doc2 = { items: ['x', 'y', 'z', 'w'] };

    const patches = patcher.execute({original: doc1, modified: doc2});
    
    // Should use 4 replace operations instead of 4 removes + 4 adds
    expect(patches).toHaveLength(4);
    expect(patches.every(p => p.op === 'replace')).toBe(true);
  });
}); 