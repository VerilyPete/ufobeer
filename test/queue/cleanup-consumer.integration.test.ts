import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCleanupBatch } from '../../src/queue/cleanup';
import type { CleanupMessage, Env } from '../../src/types';
import { CLEANUP_VERSION } from '../../src/constants';

type Beer = { readonly beerName?: string; readonly brewer?: string };

async function seedBeer(id: string, description: string, beer: Beer = {}): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, beer.beerName ?? 'Valley Lager', beer.brewer ?? 'Valley Brewing', description, `hash-${id}`).run();
}

function createBatch(id: string, description: string, beer: Beer = {}) {
  const message = {
    body: {
      beerId: id,
      beerName: beer.beerName ?? 'Valley Lager',
      brewer: beer.brewer ?? 'Valley Brewing',
      brewDescription: description,
      descriptionHash: `hash-${id}`,
    },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return { message, batch: { messages: [message] } as unknown as MessageBatch<CleanupMessage> };
}

function createWorker() {
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  return { sendBatch, worker: { ...env, ENRICHMENT_QUEUE: { sendBatch } } as unknown as Env };
}

async function cleanedRow(id: string) {
  return env.DB.prepare('SELECT brew_description_cleaned, cleanup_source, abv FROM enriched_beers WHERE id = ?')
    .bind(id).first();
}

async function clean(description: string, beer: Beer = {}) {
  await seedBeer('beer-1', description, beer);
  const { message, batch } = createBatch('beer-1', description, beer);
  const { worker, sendBatch } = createWorker();
  await handleCleanupBatch(batch, worker);
  return { row: await cleanedRow('beer-1'), message, sendBatch };
}

describe('description cleanup consumer (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
  });

  it('applies every permitted fix, records the ABV and acks the message', async () => {
    const { row, message, sendBatch } = await clean('<p>A pleasent ale with Citra,Mosaic hops at 9.2%ABV</p>');
    expect(row).toEqual({
      brew_description_cleaned: 'A pleasant ale with Citra, Mosaic hops at 9.2% ABV.',
      cleanup_source: 'deterministic',
      abv: 9.2,
    });
    expect(message.ack).toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('queues a beer whose description has no ABV for Perplexity', async () => {
    const { row, sendBatch } = await clean('A crisp, clean pour');
    expect(row).toEqual({ brew_description_cleaned: 'A crisp, clean pour.', cleanup_source: 'deterministic', abv: null });
    expect(sendBatch).toHaveBeenCalledWith([{
      body: { beerId: 'beer-1', beerName: 'Valley Lager', brewer: 'Valley Brewing', descriptionHash: 'hash-beer-1' },
    }]);
  });

  it('never queues a blocklisted beer for Perplexity', async () => {
    const { row, sendBatch } = await clean('Four tasters of our lagers', { beerName: 'Texas Flight' });
    expect(row).toMatchObject({ cleanup_source: 'deterministic' });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('logs every applied fix with the beer ID and never the description', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    await clean('A pleasent ale with Citra,Mosaic hops');
    const entries = info.mock.calls
      .map(([line]) => (typeof line === 'string' && line.startsWith('{') ? JSON.parse(line) : null))
      .filter(Boolean);
    expect(entries).toContainEqual(expect.objectContaining({
      event: 'cleanup.fixes.applied',
      beerId: 'beer-1',
      edits: [
        { from: 'pleasent', to: 'pleasant' },
        { from: 'Citra,Mosaic', to: 'Citra, Mosaic' },
        { from: 'hops', to: 'hops.' },
      ],
    }));
    expect(JSON.stringify(info.mock.calls)).not.toContain('A pleasent ale');
    info.mockRestore();
  });

  it('never alters the beer name or brewer', async () => {
    const { row } = await clean('Brewed by Pleasent Valley.', { brewer: 'Pleasent Valley Brewing' });
    expect(row).toMatchObject({ brew_description_cleaned: 'Brewed by Pleasent Valley.' });
  });

  it.each([
    ['with an ABV', 'A crisp lager. 4.9% ABV'],
    ['without an ABV', 'A crisp lager'],
  ])('records the cleanup version that produced the text, %s', async (_case, description) => {
    await clean(description);
    const row = await env.DB.prepare('SELECT cleanup_version FROM enriched_beers WHERE id = ?').bind('beer-1').first();
    expect(row).toEqual({ cleanup_version: CLEANUP_VERSION });
  });

  it('stores the sanitized source unchanged when nothing needs fixing', async () => {
    const { row } = await clean('A crisp &amp; dry finish!');
    expect(row).toMatchObject({ brew_description_cleaned: 'A crisp & dry finish!' });
  });
});
