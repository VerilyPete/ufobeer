/**
 * Tests for asTypedRows helper and typed D1 query results.
 *
 * Verifies that the asTypedRows helper correctly handles D1 batch results
 * and eliminates unsafe `as` casts.
 *
 * @module test/db/helpers-typed.test
 */

import { describe, it, expect } from 'vitest';
import { asTypedRows } from '../../src/db/helpers';

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
