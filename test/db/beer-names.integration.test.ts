import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insertPlaceholders } from '../../src/db/helpers';
import { handleBeerSync } from '../../src/handlers/beers';
import { hashDescription } from '../../src/utils/hash';
import type { Env, RequestContext } from '../../src/types';

const ESCAPED = { brew_name: "Dragon\\'s Milk ", brewer: "Brasserie D\\'achouffe" };
const REPAIRED = { brew_name: "Dragon's Milk", brewer: "Brasserie D'achouffe" };
const DESCRIPTION = 'A rich stout';

type ExistingRow = {
  readonly abv: number | null;
  readonly enrichmentStatus: string | null;
  readonly brewName?: string;
};

async function seedEscaped({ abv, enrichmentStatus, brewName = ESCAPED.brew_name }: ExistingRow): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO enriched_beers (id, brew_name, brewer, abv, enrichment_status, brew_description_original, description_hash)
    VALUES ('beer-1', ?, ?, ?, ?, ?, ?)
  `).bind(brewName, ESCAPED.brewer, abv, enrichmentStatus, DESCRIPTION, await hashDescription(DESCRIPTION)).run();
}

async function storedNames() {
  return env.DB.prepare('SELECT brew_name, brewer FROM enriched_beers WHERE id = ?').bind('beer-1').first();
}

const context: RequestContext = {
  requestId: 'request-1',
  startTime: 0,
  clientIdentifier: 'client',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

async function sync(beer: Record<string, unknown>) {
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  const worker = { ...env, CLEANUP_QUEUE: { sendBatch } } as unknown as Env;
  const request = new Request('https://api.example.com/beers/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ beers: [beer] }),
  });
  const response = await handleBeerSync(request, worker, {}, context);
  return { response, sendBatch };
}

describe('stored beer names (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
  });

  it.each([
    ['already enriched', { abv: 8.5, enrichmentStatus: 'enriched' }],
    ['awaiting enrichment', { abv: null, enrichmentStatus: 'pending' }],
    ['enrichment already attempted', { abv: null, enrichmentStatus: 'not_found' }],
  ])('repairs the stored names of a beer seen again with an unchanged description, %s', async (_case, existing) => {
    await seedEscaped(existing);

    await insertPlaceholders(env.DB, [{ id: 'beer-1', ...ESCAPED, brew_description: DESCRIPTION }], 'request-1');

    expect(await storedNames()).toEqual(REPAIRED);
  });

  it('repairs the stored names of a blocklisted beer seen again', async () => {
    await seedEscaped({ abv: null, enrichmentStatus: 'pending', brewName: "Dealer\\'s Choice Flight" });

    await insertPlaceholders(env.DB, [{ id: 'beer-1', brew_name: "Dealer\\'s Choice Flight", brewer: ESCAPED.brewer, brew_description: DESCRIPTION }], 'request-1');

    expect(await storedNames()).toEqual({ brew_name: "Dealer's Choice Flight", brewer: REPAIRED.brewer });
  });

  it('stores repaired names for a new beer and queues them for enrichment', async () => {
    const result = await insertPlaceholders(env.DB, [{ id: 'beer-1', ...ESCAPED }], 'request-1');

    expect(await storedNames()).toEqual(REPAIRED);
    expect(result.needsEnrichment).toEqual([expect.objectContaining(REPAIRED)]);
  });

  it('queues repaired names for cleanup when the description changes', async () => {
    await seedEscaped({ abv: null, enrichmentStatus: 'pending' });

    const result = await insertPlaceholders(env.DB, [{ id: 'beer-1', ...ESCAPED, brew_description: 'A richer stout' }], 'request-1');

    expect(await storedNames()).toEqual(REPAIRED);
    expect(result.needsCleanup).toEqual([expect.objectContaining(REPAIRED)]);
  });

  it('repairs names written by /beers/sync and the cleanup messages it sends', async () => {
    await seedEscaped({ abv: 8.5, enrichmentStatus: 'enriched' });

    const { response, sendBatch } = await sync({ id: 'beer-1', ...ESCAPED, brew_description: DESCRIPTION });

    expect(response.status).toBe(200);
    expect(await storedNames()).toEqual(REPAIRED);
    expect(sendBatch).toHaveBeenCalledWith([
      expect.objectContaining({ body: expect.objectContaining({ beerName: REPAIRED.brew_name, brewer: REPAIRED.brewer }) }),
    ]);
  });

  it('keeps the stored brewer when /beers/sync omits it', async () => {
    await seedEscaped({ abv: 8.5, enrichmentStatus: 'enriched' });

    await sync({ id: 'beer-1', brew_name: ESCAPED.brew_name });

    expect(await storedNames()).toEqual({ brew_name: REPAIRED.brew_name, brewer: ESCAPED.brewer });
  });
});
