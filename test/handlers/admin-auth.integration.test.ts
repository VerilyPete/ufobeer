/**
 * Full-route tests for the /admin/* gate against real D1 and the real
 * authorizeAdmin: without the right X-Admin-Secret, an admin request is
 * refused with 403 and changes nothing.
 */

import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/index';
import type { Env } from '../../src/types';
import { dlqEntry, ENRICHMENT_BODY, seedDlqEntry } from './dlq-replay-harness';

const API_KEY = 'admin-auth-test-key';
const ADMIN_SECRET = 'admin-auth-test-secret';

const buildEnv = (overrides: Partial<Pick<Env, 'ADMIN_SECRET'>> = {}): Env => ({
  ...env,
  API_KEY,
  ADMIN_SECRET,
  ...overrides,
});

const acknowledge = async (id: number, headers: Record<string, string>, workerEnv: Env = buildEnv()): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request('https://api.ufobeer.app/admin/dlq/acknowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.20', 'X-API-Key': API_KEY, ...headers },
    body: JSON.stringify({ ids: [id] }),
  }), workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const spies = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((spy) => spy.mockImplementation(() => {}));
  try {
    return await run();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
};

describe('admin route gate (real D1, real authorizeAdmin)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM dlq_messages').run();
    await env.DB.prepare('DELETE FROM rate_limits').run();
  });

  it.each([
    ['no admin secret', {}, buildEnv()],
    ['a wrong admin secret', { 'X-Admin-Secret': 'not-the-secret' }, buildEnv()],
    ['the API key as the admin secret', { 'X-Admin-Secret': API_KEY }, buildEnv()],
    ['an admin secret when none is configured', { 'X-Admin-Secret': ADMIN_SECRET }, buildEnv({ ADMIN_SECRET: '' })],
  ])('refuses a request with %s and changes nothing', async (_label, headers, workerEnv) => {
    const id = await seedDlqEntry('msg-1', 'beer-enrichment', ENRICHMENT_BODY);

    const response = await quietly(() => acknowledge(id, headers, workerEnv));

    expect(response.status).toBe(403);
    expect(await dlqEntry(id)).toMatchObject({ status: 'pending' });
  });

  it('runs the admin action with the right admin secret', async () => {
    const id = await seedDlqEntry('msg-1', 'beer-enrichment', ENRICHMENT_BODY);

    const response = await acknowledge(id, { 'X-Admin-Secret': ADMIN_SECRET });

    expect(response.status).toBe(200);
    expect(await dlqEntry(id)).toMatchObject({ status: 'acknowledged' });
  });
});
