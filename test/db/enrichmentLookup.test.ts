/**
 * getEnrichmentForBeerIds' edge branches, against a fake database: an empty
 * ID list never reaches D1, and a failed batch degrades to an empty result
 * with a logged error instead of failing the request.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnrichmentForBeerIds } from '../../src/db/helpers';

const notUsed = () => Promise.reject(new Error('not used by the enrichment lookup'));

const fakeStatement = (): D1PreparedStatement => {
  const statement: D1PreparedStatement = {
    bind: () => statement,
    first: notUsed,
    run: notUsed,
    all: notUsed,
    raw: notUsed,
  };
  return statement;
};

const fakeDb = (batch: D1Database['batch']): D1Database => ({
  prepare: fakeStatement,
  batch,
  exec: notUsed,
  withSession: () => { throw new Error('not used by the enrichment lookup'); },
  dump: notUsed,
});

describe('getEnrichmentForBeerIds edge branches', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty result without sending a batch when no IDs are requested', async () => {
    const batch = vi.fn(notUsed);

    const result = await getEnrichmentForBeerIds(fakeDb(batch), [], 'lookup-request-41');

    expect(result).toEqual(new Map());
    expect(batch).not.toHaveBeenCalled();
  });

  it('returns an empty result and logs the failure when the batch fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await getEnrichmentForBeerIds(
      fakeDb(() => Promise.reject(new Error('D1 batch exploded'))),
      ['lookup-beer-a', 'lookup-beer-b'],
      'lookup-request-43'
    );

    expect(result).toEqual(new Map());
    expect(errors.mock.calls).toEqual([[JSON.stringify({
      event: 'enrichment_fetch_error',
      error: 'Error: D1 batch exploded',
      requestId: 'lookup-request-43',
    })]]);
  });
});
