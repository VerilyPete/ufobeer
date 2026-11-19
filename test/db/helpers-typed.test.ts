/**
 * asTypedRows turns a missing D1 result set into an empty array. Rows that
 * are present are checked through the real-D1 callers (for example
 * test/db/enrichmentLookup.integration.test.ts).
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
  it('returns empty readonly array when results is undefined', () => {
    const rows = asTypedRows<TestRow>(undefined);
    expect(rows).toEqual([]);
  });

  it('returns empty readonly array when results is null', () => {
    const rows = asTypedRows<TestRow>(null);
    expect(rows).toEqual([]);
  });
});
