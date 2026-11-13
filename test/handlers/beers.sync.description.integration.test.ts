/**
 * POST /beers/sync applies a description change in full (plan slice 3),
 * against real D1 through src/index.ts.
 *
 * A changed description replaces the original text and its hash together,
 * clears the cleanup fields and re-queues cleanup; an unchanged or omitted
 * description never touches either. The change is guarded on the original
 * text and hash the request read, so a stale request is refused.
 */
import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import { handleBeerSync } from '../../src/handlers/beers';
import { handleCleanupBatch } from '../../src/queue/cleanup';
import { hashDescription } from '../../src/utils/hash';
import type { CleanupMessage, Env, RequestContext } from '../../src/types';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const API_KEY = 'sync-description-test-key';
const ORIGIN = 'https://flying-saucer.golden-taproom.test';
const STORE_ID = '13879';
const BEER = { id: 'beer-1', brew_name: 'Valley Lager', brewer: 'Valley Brewing' } as const;
const TEXT_A = 'A crisp lager';
const TEXT_B = 'A hazy pale ale';
const TEXT_C = 'A dark porter';

const context: RequestContext = {
  requestId: 'request-1', startTime: 0, clientIdentifier: 'client', apiKeyHash: 'hash', clientIp: '127.0.0.1', userAgent: 'test',
};

type Seed = { readonly original: string; readonly hash: string; readonly cleaned: string | null };

async function seedRow({ original, hash, cleaned }: Seed): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, abv, enrichment_status, brew_description_original, description_hash,
       brew_description_cleaned, description_cleaned_at, cleanup_source, cleanup_version)
     VALUES (?, ?, ?, 5.2, 'enriched', ?, ?, ?, ?, ?, ?)`
  ).bind(BEER.id, BEER.brew_name, BEER.brewer, original, hash, cleaned,
    cleaned === null ? null : 1, cleaned === null ? null : 'deterministic', cleaned === null ? null : 1).run();
}

async function stored() {
  return env.DB.prepare(
    `SELECT brew_description_original, description_hash, brew_description_cleaned, description_cleaned_at, cleanup_source,
       cleanup_version, enrichment_status FROM enriched_beers WHERE id = ?`
  ).bind(BEER.id).first();
}

function queues() {
  const cleanup: CleanupMessage[] = [];
  const cleanupQueue = {
    sendBatch: vi.fn(async (messages: readonly { readonly body: CleanupMessage }[]) => {
      cleanup.push(...messages.map(message => message.body));
    }),
  };
  const enrichmentQueue = { sendBatch: vi.fn().mockResolvedValue(undefined) };
  return { cleanup, cleanupQueue, enrichmentQueue };
}

async function consume(messages: readonly CleanupMessage[]): Promise<void> {
  const consumerEnv = { ...env, ENRICHMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) } } as unknown as Env;
  const batch = { messages: messages.map(body => ({ body, ack: vi.fn(), retry: vi.fn() })) } as unknown as MessageBatch<CleanupMessage>;
  await handleCleanupBatch(batch, consumerEnv);
}

/** Real D1, except that `hook` runs once, right after the sync's read of existing rows. */
function afterExistingRead(hook: () => Promise<void>): D1Database {
  const realDb = env.DB;
  let fired = false;
  return {
    prepare: (sql: string) => realDb.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const result = await realDb.batch(statements);
      if (!fired) {
        fired = true;
        await hook();
      }
      return result;
    },
  } as unknown as D1Database;
}

async function sync(items: readonly object[], options: { readonly db?: D1Database } = {}) {
  const { cleanup, cleanupQueue } = queues();
  const syncEnv = { ...env, DB: options.db ?? env.DB, CLEANUP_QUEUE: cleanupQueue } as unknown as Env;
  const request = new Request('https://api.example.com/beers/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ beers: items }),
  });
  const response = await handleBeerSync(request, syncEnv, {}, context);
  return { json: await response.json() as Record<string, unknown>, cleanup };
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  await env.DB.prepare('DROP TRIGGER IF EXISTS abort_write').run();
  for (const table of ['enriched_beers', 'store_taplist_cache', 'rate_limits', 'audit_log']) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a description change through POST /beers/sync, end to end', () => {
  const { cleanup, cleanupQueue, enrichmentQueue } = queues();
  const testEnv = {
    ...env, API_KEY, FLYING_SAUCER_API_BASE: ORIGIN, CLEANUP_QUEUE: cleanupQueue, ENRICHMENT_QUEUE: enrichmentQueue,
  } as unknown as Env;

  async function invoke(request: Request): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  async function liveBeers(description: string, headers: Record<string, string> = {}): Promise<Response> {
    await env.DB.prepare('UPDATE store_taplist_cache SET cached_at = 0 WHERE store_id = ?').bind(STORE_ID).run();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json([{ store_info: 'x' }, { brewInStock: [{ ...BEER, brew_description: description }] }]));
    const response = await invoke(new IncomingRequest(`https://api.ufobeer.test/beers?sid=${STORE_ID}`, {
      headers: { 'X-API-Key': API_KEY, ...headers },
    }));
    vi.mocked(globalThis.fetch).mockRestore();
    return response;
  }

  async function batchDescription(): Promise<unknown> {
    const response = await invoke(new IncomingRequest('https://api.ufobeer.test/beers/batch', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [BEER.id] }),
    }));
    const body = await response.json<{ enrichments: Record<string, { brew_description: unknown }> }>();
    return body.enrichments[BEER.id]?.brew_description;
  }

  async function syncViaApi(description: string): Promise<void> {
    const response = await invoke(new IncomingRequest('https://api.ufobeer.test/beers/sync', {
      method: 'POST',
      headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ ...BEER, brew_description: description }] }),
    }));
    expect(response.status).toBe(200);
  }

  it('serves the new raw text at once, the new cleaned text after cleanup, and a stable new ETag', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: 'A crisp lager, cleaned.' });
    const before = await liveBeers(TEXT_A);
    const etagBefore = before.headers.get('ETag');
    cleanup.length = 0;

    await syncViaApi(TEXT_B);

    expect(await batchDescription()).toBe(TEXT_B);
    expect(cleanup).toEqual([expect.objectContaining({ beerId: BEER.id, brewDescription: TEXT_B, descriptionHash: await hashDescription(TEXT_B) })]);

    await consume(cleanup);
    expect(await batchDescription()).toBe('A hazy pale ale.');

    const after = await liveBeers(TEXT_B);
    const body = await after.clone().json<{ beers: { brew_description: unknown }[] }>();
    expect(body.beers[0]?.brew_description).toBe('A hazy pale ale.');
    const etagAfter = after.headers.get('ETag');
    expect(etagAfter).not.toBe(etagBefore);
    expect((await liveBeers(TEXT_B, { 'If-None-Match': etagAfter ?? '' })).status).toBe(304);
  });
});

describe('the two conflict arms', () => {
  it('replaces original and hash together, clears cleanup fields and resets status on a changed description', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: 'Cleaned A' });

    const { json, cleanup } = await sync([{ ...BEER, brew_description: TEXT_B }]);

    expect(await stored()).toEqual({
      brew_description_original: TEXT_B, description_hash: await hashDescription(TEXT_B),
      brew_description_cleaned: null, description_cleaned_at: null, cleanup_source: null, cleanup_version: null,
      enrichment_status: 'pending',
    });
    expect(json).toMatchObject({ synced: 1, queued_for_cleanup: 1 });
    expect(cleanup.map(message => message.brewDescription)).toEqual([TEXT_B]);
  });

  it('repairs a damaged row whose hash already matches the synced text', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_B), cleaned: TEXT_A });

    const { cleanup } = await sync([{ ...BEER, brew_description: TEXT_B }]);

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_B, description_hash: await hashDescription(TEXT_B), brew_description_cleaned: null });
    expect(cleanup.map(message => message.brewDescription)).toEqual([TEXT_B]);
  });

  it('refuses a stale repair that read the damaged row before another repair and its cleanup', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_B), cleaned: TEXT_A });
    const db = afterExistingRead(async () => {
      const first = await sync([{ ...BEER, brew_description: TEXT_B }]);
      await consume(first.cleanup);
    });

    const stale = await sync([{ ...BEER, brew_description: TEXT_B }], { db });

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_B, brew_description_cleaned: 'A hazy pale ale.' });
    expect(stale.cleanup).toEqual([]);
  });

  it('never splits original and hash when an unchanged sync loses a race to a newer description', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: 'Cleaned A' });
    const hashB = await hashDescription(TEXT_B);
    const db = afterExistingRead(async () => {
      await env.DB.prepare('UPDATE enriched_beers SET brew_description_original = ?, description_hash = ? WHERE id = ?')
        .bind(TEXT_B, hashB, BEER.id).run();
    });

    await sync([{ ...BEER, brew_description: TEXT_A }], { db });

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_B, description_hash: hashB });
  });

  it('keeps the stored text and hash when the description is omitted', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: 'Cleaned A' });

    await sync([{ ...BEER, brew_name: 'Valley Lager Renamed' }]);

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_A, description_hash: await hashDescription(TEXT_A), brew_description_cleaned: 'Cleaned A' });
  });
});

describe('what a sync leaves alone', () => {
  it('keeps the cleaned text and queues nothing when the description is unchanged', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: 'Cleaned A' });

    const { cleanup } = await sync([{ ...BEER, brew_description: TEXT_A }]);

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_A, brew_description_cleaned: 'Cleaned A' });
    expect(cleanup).toEqual([]);
  });

  it('treats an empty description as omitted', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: 'Cleaned A' });

    await sync([{ ...BEER, brew_description: '' }]);

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_A, description_hash: await hashDescription(TEXT_A), brew_description_cleaned: 'Cleaned A' });
  });

  it('refuses a description change when only the hash moved after the read', async () => {
    await seedRow({ original: TEXT_A, hash: 'legacy-hash', cleaned: null });
    const hashA = await hashDescription(TEXT_A);
    const db = afterExistingRead(async () => {
      await env.DB.prepare('UPDATE enriched_beers SET description_hash = ? WHERE id = ?').bind(hashA, BEER.id).run();
    });

    const { cleanup } = await sync([{ ...BEER, brew_description: TEXT_B }], { db });

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_A, description_hash: hashA });
    expect(cleanup).toEqual([]);
  });
});

describe('cleanup retry after a description change', () => {
  it('resets the queued marker, so a failed send is retried by the next sync', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: null });
    await env.DB.prepare('UPDATE enriched_beers SET queued_for_cleanup_at = ? WHERE id = ?').bind(Date.now(), BEER.id).run();
    const failingQueue = { sendBatch: vi.fn().mockRejectedValue(new Error('queue unavailable')) };
    const request = new Request('https://api.example.com/beers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [{ ...BEER, brew_description: TEXT_B }] }),
    });
    await handleBeerSync(request, { ...env, CLEANUP_QUEUE: failingQueue } as unknown as Env, {}, context);

    const retry = await sync([{ ...BEER, brew_description: TEXT_B }]);

    expect(retry.cleanup.map(message => message.brewDescription)).toEqual([TEXT_B]);
  });

  it('queues nothing and reports the failure when the write batch fails', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: null });
    await env.DB.prepare(
      "CREATE TRIGGER abort_write BEFORE UPDATE ON enriched_beers BEGIN SELECT RAISE(ABORT, 'test abort'); END"
    ).run();

    const { json, cleanup } = await sync([{ ...BEER, brew_description: TEXT_A }]);

    await env.DB.prepare('DROP TRIGGER abort_write').run();
    expect(cleanup).toEqual([]);
    expect(json).toMatchObject({ synced: 0, queued_for_cleanup: 0, errors: ['Database write failed for batch'] });
  });
});

describe('cleanup mark and repeat syncs', () => {
  it('returns 500 when the mark fails after a send, leaving the row for the next sync', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: null });
    await env.DB.prepare(
      "CREATE TRIGGER abort_write BEFORE UPDATE OF queued_for_cleanup_at ON enriched_beers BEGIN SELECT RAISE(ABORT, 'test abort'); END"
    ).run();

    const { cleanupQueue } = queues();
    const request = new Request('https://api.example.com/beers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beers: [BEER] }),
    });
    const response = await handleBeerSync(request, { ...env, CLEANUP_QUEUE: cleanupQueue } as unknown as Env, {}, context);
    await env.DB.prepare('DROP TRIGGER abort_write').run();

    expect(response.status).toBe(500);
    expect(cleanupQueue.sendBatch).toHaveBeenCalledOnce();
    expect(await stored()).toMatchObject({ brew_description_original: TEXT_A });
    expect((await sync([BEER])).cleanup.map(message => message.brewDescription)).toEqual([TEXT_A]);
  });

  it('answers a repeated unchanged sync with the same counts and queues cleanup only once', async () => {
    await seedRow({ original: TEXT_A, hash: await hashDescription(TEXT_A), cleaned: null });

    const first = await sync([{ ...BEER, brew_description: TEXT_A }]);
    const second = await sync([{ ...BEER, brew_description: TEXT_A }]);

    expect(first.json).toMatchObject({ synced: 1, queued_for_cleanup: 1 });
    expect(second.json).toMatchObject({ synced: 1, queued_for_cleanup: 0 });
    expect(second.json.errors).toBeUndefined();
  });
});

describe('duplicate ids in one request', () => {
  it('stores and queues only the last valid version, with its own hash, and counts both items', async () => {
    await seedRow({ original: TEXT_C, hash: await hashDescription(TEXT_C), cleaned: 'Cleaned C' });

    const { json, cleanup } = await sync([
      { ...BEER, brew_description: TEXT_B },
      { ...BEER, brew_description: TEXT_A },
    ]);

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_A, description_hash: await hashDescription(TEXT_A) });
    expect(cleanup).toEqual([expect.objectContaining({ brewDescription: TEXT_A, descriptionHash: await hashDescription(TEXT_A) })]);
    expect(json).toMatchObject({ synced: 2, queued_for_cleanup: 1 });
  });

  it('ignores an invalid later duplicate', async () => {
    const { json } = await sync([
      { ...BEER, brew_description: TEXT_B },
      { id: BEER.id },
    ]);

    expect(await stored()).toMatchObject({ brew_description_original: TEXT_B });
    expect(json).toMatchObject({ synced: 1 });
    expect(json.errors).toHaveLength(1);
  });
});
