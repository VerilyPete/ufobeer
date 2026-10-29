import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCleanupTrigger } from '../../src/handlers/cleanupTrigger';
import { CLEANUP_VERSION } from '../../src/constants';
import type { CleanupMessage, Env, RequestContext } from '../../src/types';

type SeededBeer = {
  readonly id: string;
  readonly cleanupVersion: number | null;
};

async function seedBeer({ id, cleanupVersion }: SeededBeer): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, brew_description_cleaned, cleanup_source, cleanup_version)
    VALUES (?, 'Valley Lager', 'Valley Brewing', 'A crisp lager', ?, ?, ?)
  `).bind(id, `Served text for ${id}`, cleanupVersion === null ? 'workers-ai' : 'deterministic', cleanupVersion).run();
}

const context: RequestContext = {
  requestId: 'request-1',
  startTime: 0,
  clientIdentifier: 'admin',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

async function trigger(body: object) {
  const sendBatch = vi.fn<(messages: readonly { readonly body: CleanupMessage }[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  const worker = { ...env, CLEANUP_QUEUE: { sendBatch } } as unknown as Env;
  const request = new Request('https://api.example.com/admin/cleanup/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const response = await handleCleanupTrigger(request, worker, {}, context);
  const queuedIds = sendBatch.mock.calls
    .flatMap(([messages]) => messages.map(({ body: message }) => message.beerId));
  return { response, json: await response.json() as Record<string, unknown>, queuedIds };
}

async function servedText(id: string) {
  return env.DB.prepare('SELECT brew_description_cleaned FROM enriched_beers WHERE id = ?').bind(id).first();
}

describe("cleanup trigger mode 'all' (real D1)", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
    await env.DB.prepare('DELETE FROM system_state').run();
  });

  it('re-cleans only descriptions from an older cleanup version', async () => {
    await seedBeer({ id: 'legacy', cleanupVersion: null });
    await seedBeer({ id: 'older', cleanupVersion: CLEANUP_VERSION - 1 });
    await seedBeer({ id: 'current', cleanupVersion: CLEANUP_VERSION });

    const { queuedIds, json } = await trigger({ mode: 'all', confirm: true });

    expect(queuedIds.sort()).toEqual(['legacy', 'older']);
    expect(json).toMatchObject({ data: { beers_queued: 2, beers_remaining: 0 } });
  });

  it('keeps serving the existing cleaned text until the re-clean rewrites it', async () => {
    await seedBeer({ id: 'legacy', cleanupVersion: null });

    await trigger({ mode: 'all', confirm: true });

    expect(await servedText('legacy')).toEqual({ brew_description_cleaned: 'Served text for legacy' });
  });

  it('skips current descriptions when the limit is smaller than the table', async () => {
    await seedBeer({ id: 'current', cleanupVersion: CLEANUP_VERSION });
    await seedBeer({ id: 'legacy', cleanupVersion: null });

    const { queuedIds } = await trigger({ mode: 'all', confirm: true, limit: 1 });

    expect(queuedIds).toEqual(['legacy']);
  });

  it('previews only the descriptions that would be re-cleaned', async () => {
    await seedBeer({ id: 'legacy', cleanupVersion: null });
    await seedBeer({ id: 'current', cleanupVersion: CLEANUP_VERSION });

    const { json } = await trigger({ mode: 'all' });

    expect(json).toMatchObject({ preview: { beers_would_reset: 1 } });
  });
});
