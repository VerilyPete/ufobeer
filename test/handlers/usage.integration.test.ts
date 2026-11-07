/**
 * Full-route tests for POST /usage against real D1.
 *
 * Rate limiting and audit logging run on every route, so these tests assert
 * on the usage tables and on responses, never on "zero D1 writes".
 */

import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../../src/index';
import type { Env } from '../../src/types';
import { SMALL_JSON_BODY_MAX_BYTES, USAGE_RATE_LIMIT_RPM } from '../../src/constants';

// Daily growth budgets plans/usage-telemetry.md specifies, written out so the
// handler's wiring of the real caps is checked, not just the helper.
const POST_DAILY_CAP = 2_000;
const NEW_INSTALL_DAILY_CAP = 500;
import { getToday } from '../../src/utils/date';

const API_KEY = 'usage-test-key';
const INSTALL_ID = '3f2b8c1e-5d4a-4e7b-9c0f-1a2b3c4d5e6f';

type EnvOverrides = Partial<Pick<Env, 'USAGE_ENABLED' | 'RATE_LIMIT_RPM' | 'ANALYTICS'>>;

const buildEnv = (overrides: EnvOverrides = {}): Env => ({
  ...env,
  API_KEY,
  USAGE_ENABLED: 'true',
  ...overrides,
});

const batchId = (n: number): string => `11111111-1111-4111-8111-${n.toString().padStart(12, '0')}`;

const buildBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  install_id: INSTALL_ID,
  batch_id: batchId(1),
  app_version: '2.4.0',
  ai_status: 'apple_intelligence',
  os_major: 26,
  events: [{ name: 'suggestions_opened', count: 3 }],
  ...overrides,
});

type PostOptions = {
  body?: BodyInit;
  ip?: string;
  apiKey?: string | null;
  headers?: Record<string, string>;
  env?: Env;
};

const fetchWorker = async (request: Request, workerEnv: Env): Promise<Response> => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, workerEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
};

const postUsage = ({
  body = JSON.stringify(buildBody()),
  ip = '203.0.113.1',
  apiKey = API_KEY,
  headers = {},
  env: workerEnv = buildEnv(),
}: PostOptions = {}): Promise<Response> =>
  fetchWorker(new Request('https://api.ufobeer.app/usage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      ...(apiKey === null ? {} : { 'X-API-Key': apiKey }),
      ...headers,
    },
    body,
    duplex: 'half',
  } as RequestInit), workerEnv);

const postBatchLookup = (ip: string, workerEnv: Env): Promise<Response> =>
  fetchWorker(new Request('https://api.ufobeer.app/beers/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'X-API-Key': API_KEY },
    body: JSON.stringify({ ids: ['1'] }),
  }), workerEnv);

const usageCounts = async (): Promise<ReadonlyArray<{ event: string; count: number }>> =>
  (await env.DB.prepare('SELECT event, count FROM usage_daily ORDER BY event').all<{ event: string; count: number }>()).results;

const tableCount = async (table: string): Promise<number> =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

const streamOf = (bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> => {
  const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, i) =>
    bytes.slice(i * chunkSize, (i + 1) * chunkSize));
  return new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(next);
    },
  });
};

describe('POST /usage', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.batch([
      'rate_limits', 'audit_log', 'usage_daily', 'usage_installs', 'usage_batches', 'usage_ingest_daily',
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  });

  describe('accepted reports', () => {
    it('records the report and returns 204 with no body', async () => {
      const response = await postUsage();

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(await usageCounts()).toEqual([{ event: 'suggestions_opened', count: 3 }]);
    });

    it('returns 204 for a duplicate batch without counting it twice', async () => {
      await postUsage();
      const response = await postUsage();

      expect(response.status).toBe(204);
      expect(await usageCounts()).toEqual([{ event: 'suggestions_opened', count: 3 }]);
    });

    it('returns 204 without writing usage when every event is dropped', async () => {
      const response = await postUsage({ body: JSON.stringify(buildBody({ events: [{ name: 'nope', count: 1 }] })) });

      expect(response.status).toBe(204);
      expect(await tableCount('usage_batches')).toBe(0);
      expect(await tableCount('usage_installs')).toBe(0);
      expect(await tableCount('usage_ingest_daily')).toBe(0);
    });

    it('returns 204 and records nothing when the daily post budget is spent', async () => {
      await env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, ?)')
        .bind(getToday(), POST_DAILY_CAP).run();

      const response = await postUsage();

      expect(response.status).toBe(204);
      expect(await usageCounts()).toEqual([]);
    });

    it('sends the drop reason to analytics when a post is not admitted', async () => {
      await env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, ?)')
        .bind(getToday(), POST_DAILY_CAP).run();
      const writeDataPoint = vi.fn();

      await postUsage({ env: buildEnv({ ANALYTICS: { writeDataPoint } }) });

      const usagePoints = writeDataPoint.mock.calls
        .map(([point]) => point)
        .filter((point) => point?.blobs?.includes('usage_ingest'));
      expect(usagePoints).toHaveLength(1);
      expect(usagePoints[0]?.blobs).toContain('daily_post_cap');
    });
  });

  describe('growth budgets', () => {
    const otherInstall = (n: number): string => `33333333-3333-4333-8333-${n.toString().padStart(12, '0')}`;

    const seedInstallsFirstSeenToday = (count: number) =>
      Array.from({ length: Math.ceil(count / 100) }, (_, chunk) => chunk).reduce(async (previous, chunk) => {
        await previous;
        await env.DB.batch(Array.from({ length: Math.min(100, count - chunk * 100) }, (_, i) =>
          env.DB.prepare('INSERT INTO usage_installs (install_id, first_seen_day, last_seen_day) VALUES (?, ?, ?)')
            .bind(otherInstall(chunk * 100 + i), getToday(), getToday())));
      }, Promise.resolve());

    it('admits the post that brings the day to the post budget', async () => {
      await env.DB.prepare('INSERT INTO usage_ingest_daily (day, posts) VALUES (?, ?)')
        .bind(getToday(), POST_DAILY_CAP - 1).run();

      expect((await postUsage()).status).toBe(204);
      expect(await usageCounts()).toEqual([{ event: 'suggestions_opened', count: 3 }]);
    });

    it('admits new installs up to the daily install budget and drops the next one', async () => {
      await seedInstallsFirstSeenToday(NEW_INSTALL_DAILY_CAP - 1);
      const writeDataPoint = vi.fn();
      const workerEnv = buildEnv({ ANALYTICS: { writeDataPoint } });

      expect((await postUsage({ env: workerEnv })).status).toBe(204);
      expect(await usageCounts()).toEqual([{ event: 'suggestions_opened', count: 3 }]);

      const blocked = await postUsage({
        env: workerEnv,
        ip: '203.0.113.9',
        body: JSON.stringify(buildBody({ install_id: '44444444-4444-4444-8444-000000000001', batch_id: batchId(2) })),
      });

      expect(blocked.status).toBe(204);
      expect(await usageCounts()).toEqual([{ event: 'suggestions_opened', count: 3 }]);
      const outcomes = writeDataPoint.mock.calls
        .map(([point]) => point)
        .filter((point) => point?.blobs?.includes('usage_ingest'))
        .map((point) => point?.blobs?.[4]);
      expect(outcomes).toEqual(['admitted', 'new_install_cap']);
    });

    it('keeps counting a known install after the install budget is spent', async () => {
      await postUsage();
      await seedInstallsFirstSeenToday(NEW_INSTALL_DAILY_CAP);

      expect((await postUsage({ body: JSON.stringify(buildBody({ batch_id: batchId(2) })) })).status).toBe(204);
      expect(await usageCounts()).toEqual([{ event: 'suggestions_opened', count: 6 }]);
    });
  });

  describe('kill switch', () => {
    it.each([undefined, 'false', 'TRUE', ''])('returns 204 without writing usage when USAGE_ENABLED is %j', async (flag) => {
      const response = await postUsage({ env: buildEnv({ USAGE_ENABLED: flag }) });

      expect(response.status).toBe(204);
      expect(await tableCount('usage_batches')).toBe(0);
      expect(await usageCounts()).toEqual([]);
    });
  });

  describe('rejected requests', () => {
    it('rejects a request without a valid API key', async () => {
      expect((await postUsage({ apiKey: null })).status).toBe(401);
      expect((await postUsage({ apiKey: 'wrong' })).status).toBe(401);
      expect(await usageCounts()).toEqual([]);
    });

    it('returns 400 for an invalid envelope', async () => {
      const response = await postUsage({ body: JSON.stringify(buildBody({ install_id: 'not-a-uuid' })) });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ requestId: expect.any(String) });
      expect(await usageCounts()).toEqual([]);
    });

    it('returns 400 for malformed JSON', async () => {
      expect((await postUsage({ body: '{"install_id":' })).status).toBe(400);
    });

    it('returns 415 for a non-JSON content type', async () => {
      expect((await postUsage({ headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    });

    it('rejects an oversized body streamed with no Content-Length', async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(buildBody({ padding: 'x'.repeat(SMALL_JSON_BODY_MAX_BYTES) })));

      const response = await postUsage({ body: streamOf(bytes, 4096) });

      expect(response.status).toBe(413);
      expect(await usageCounts()).toEqual([]);
    });

    it('rejects an oversized body behind a falsely small Content-Length', async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(buildBody({ padding: 'x'.repeat(SMALL_JSON_BODY_MAX_BYTES) })));

      const response = await postUsage({ body: streamOf(bytes, 4096), headers: { 'Content-Length': '10' } });

      expect(response.status).toBe(413);
    });

    it('returns 500 and records nothing when the write fails, so the client resends later', async () => {
      await env.DB.prepare(
        "CREATE TRIGGER fail_usage_write BEFORE INSERT ON usage_daily BEGIN SELECT RAISE(ABORT, 'write failed'); END",
      ).run();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await postUsage();

      await env.DB.prepare('DROP TRIGGER fail_usage_write').run();
      consoleSpy.mockRestore();
      expect(response.status).toBe(500);
      expect(await tableCount('usage_batches')).toBe(0);
    });
  });

  describe('rate limiting', () => {
    it('does not throttle installs that share the API key but post from different IPs', async () => {
      const responses = await Array.from({ length: USAGE_RATE_LIMIT_RPM * 2 }, (_, i) => i).reduce(
        async (previous, i) => [
          ...(await previous),
          await postUsage({ ip: `198.51.100.${i + 1}`, body: JSON.stringify(buildBody({ batch_id: batchId(i + 1) })) }),
        ],
        Promise.resolve<readonly Response[]>([]),
      );

      expect(responses.map((response) => response.status)).toEqual(Array(USAGE_RATE_LIMIT_RPM * 2).fill(204));
    });

    it('returns 429 once one IP exceeds the /usage limit, however many installs it claims', async () => {
      const inventedInstall = (n: number): string => `22222222-2222-4222-8222-${n.toString().padStart(12, '0')}`;
      const statuses = await Array.from({ length: USAGE_RATE_LIMIT_RPM + 1 }, (_, i) => i).reduce(
        async (previous, i) => [
          ...(await previous),
          (await postUsage({
            body: JSON.stringify(buildBody({ install_id: inventedInstall(i + 1), batch_id: batchId(i + 1) })),
          })).status,
        ],
        Promise.resolve<readonly number[]>([]),
      );

      expect(statuses).toEqual([...Array(USAGE_RATE_LIMIT_RPM).fill(204), 429]);
    });

    it('does not consume the shared per-key bucket that /beers routes use', async () => {
      const workerEnv = buildEnv({ RATE_LIMIT_RPM: '2' });
      await Array.from({ length: 5 }, (_, i) => i).reduce(async (previous, i) => {
        await previous;
        await postUsage({ env: workerEnv, ip: `192.0.2.${i + 1}`, body: JSON.stringify(buildBody({ batch_id: batchId(i + 1) })) });
      }, Promise.resolve());

      expect((await postBatchLookup('192.0.2.100', workerEnv)).status).toBe(200);
    });

    it('shares the pre-auth per-IP bucket with every route, so a /usage flood throttles that IP', async () => {
      await Array.from({ length: 30 }, (_, i) => i).reduce(async (previous, i) => {
        await previous;
        await postUsage({ body: JSON.stringify(buildBody({ batch_id: batchId(i + 1) })) });
      }, Promise.resolve());

      expect((await postBatchLookup('203.0.113.1', buildEnv())).status).toBe(429);
      expect((await postBatchLookup('203.0.113.2', buildEnv())).status).toBe(200);
    });
  });
});
