/**
 * Tests for asTypedRows helper and typed D1 query results.
 *
 * Verifies that the asTypedRows helper correctly handles D1 batch results
 * and eliminates unsafe `as` casts.
 *
 * @module test/db/helpers-typed.test
 */

import { describe, it, expect, vi } from 'vitest';
import { asTypedRows, insertPlaceholders } from '../../src/db/helpers';
import { hashDescription } from '../../src/utils/hash';

type TestRow = {
  readonly id: string;
  readonly value: number;
};

describe('asTypedRows', () => {
  it('returns typed array from valid results', () => {
    const raw: unknown = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ];
    const rows = asTypedRows<TestRow>(raw);
    expect(rows).toEqual([
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
    ]);
  });

  it('returns empty readonly array when results is undefined', () => {
    const rows = asTypedRows<TestRow>(undefined);
    expect(rows).toEqual([]);
  });

  it('returns empty readonly array when results is null', () => {
    const rows = asTypedRows<TestRow>(null);
    expect(rows).toEqual([]);
  });

  it('returns the result as a readonly array', () => {
    const raw: unknown = [{ id: 'a', value: 1 }];
    const rows = asTypedRows<TestRow>(raw);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
  });
});

// ============================================================================
// insertPlaceholders — needsCleanup descriptionHash (stale-result binding
// producer, "any other cleanup-message producer" case)
// ============================================================================

describe('insertPlaceholders needsCleanup descriptionHash', () => {
  function createDb(existingRows: readonly unknown[] = []): D1Database {
    let call = 0;
    const statement = {
      bind: vi.fn().mockReturnThis(),
    };
    return {
      prepare: vi.fn().mockReturnValue(statement),
      batch: vi.fn().mockImplementation(async (statements: unknown[]) => {
        call++;
        if (call === 1) {
          // Step 2: SELECT existing records.
          return statements.map(() => ({ results: existingRows }));
        }
        // Step 4: write statements.
        return statements.map(() => ({ success: true, results: [], meta: {} }));
      }),
    } as unknown as D1Database;
  }

  it('attaches a descriptionHash matching hashDescription(brew_description) for a brand-new beer with a description and no extractable ABV', async () => {
    const description = 'A brand-new beer description with no percentage listed';
    const beers = [
      { id: 'new-beer-1', brew_name: 'New Beer', brewer: 'Brewer', brew_description: description },
    ];

    const result = await insertPlaceholders(createDb(), beers, 'test-request');

    expect(result.needsCleanup).toHaveLength(1);
    const expectedHash = await hashDescription(description);
    expect(result.needsCleanup[0]?.descriptionHash).toBe(expectedHash);
  });

  it('attaches a descriptionHash matching hashDescription(brew_description) when an existing description changed', async () => {
    const newDescription = 'The updated description text, no ABV here';
    const beers = [
      { id: 'existing-beer-1', brew_name: 'Existing Beer', brewer: 'Brewer', brew_description: newDescription },
    ];
    const existingRows = [
      { id: 'existing-beer-1', description_hash: 'a-completely-different-old-hash', abv: null, enrichment_status: 'enriched' },
    ];

    const result = await insertPlaceholders(createDb(existingRows), beers, 'test-request');

    expect(result.needsCleanup).toHaveLength(1);
    const expectedHash = await hashDescription(newDescription);
    expect(result.needsCleanup[0]?.descriptionHash).toBe(expectedHash);
  });
});
