/**
 * Full-route tests for GET /reports/usage against real D1: the Grafana
 * read path (plans/usage-dashboards.md, slice 3). Auth needs the shared
 * X-API-Key plus a bearer USAGE_REPORT_TOKEN that works nowhere else, and
 * reads use their own rate-limit bucket, never the shared per-key one.
 */

import { applyD1Migrations, createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import worker from '../../src/index';
import type { Env } from '../../src/types';
import { parseUsageReportQuery } from '../../src/handlers/reports';

// Per-minute limit for report reads, plans/usage-dashboards.md (Read endpoint).
const REPORT_RATE_LIMIT_RPM = 60;
const VIEWS = ['daily', 'events', 'adoption', 'breakdown'] as const;

const API_KEY = 'reports-test-key';
const REPORT_TOKEN = 'reports-test-token';
const ADMIN_SECRET = 'reports-test-admin-secret';

type EnvOverrides = Partial<Pick<Env, 'RATE_LIMIT_RPM' | 'PRE_AUTH_RPM' | 'USAGE_REPORT_TOKEN'>>;

const buildEnv = (overrides: EnvOverrides = {}): Env => ({
  ...env,
  API_KEY,
  ADMIN_SECRET,
  USAGE_REPORT_TOKEN: REPORT_TOKEN,
  ...overrides,
});

type GetOptions = {
  path?: string;
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

const getReport = ({
  path = '/reports/usage?view=daily',
  ip = '203.0.113.10',
  apiKey = API_KEY,
  headers = { Authorization: `Bearer ${REPORT_TOKEN}` },
  env: workerEnv = buildEnv(),
}: GetOptions = {}): Promise<Response> =>
  fetchWorker(new Request(`https://api.ufobeer.app${path}`, {
    headers: {
      'CF-Connecting-IP': ip,
      ...(apiKey === null ? {} : { 'X-API-Key': apiKey }),
      ...headers,
    },
  }), workerEnv);

const postBatchLookup = (ip: string, workerEnv: Env): Promise<Response> =>
  fetchWorker(new Request('https://api.ufobeer.app/beers/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'X-API-Key': API_KEY },
    body: JSON.stringify({ ids: ['1'] }),
  }), workerEnv);

const auditRows = async () =>
  (await env.DB.prepare('SELECT path, status_code FROM audit_log ORDER BY timestamp').all<{ path: string; status_code: number }>()).results;

const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
  const spies = [vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')].map((spy) => spy.mockImplementation(() => {}));
  try {
    return await run();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
};

describe('GET /reports/usage', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.batch(['rate_limits', 'audit_log'].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  });

  describe('authorized reads', () => {
    it.each(VIEWS)('returns an empty JSON array for the %s view, never cached', async (view) => {
      const response = await getReport({ path: `/reports/usage?view=${view}` });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual([]);
    });

    it('records each read in the audit log', async () => {
      await getReport();

      expect(await auditRows()).toEqual([{ path: '/reports/usage', status_code: 200 }]);
    });
  });

  describe('authentication', () => {
    it('rejects a request with no report token', async () => {
      const response = await quietly(() => getReport({ headers: {} }));

      expect(response.status).toBe(401);
      expect(await auditRows()).toEqual([{ path: '/reports/usage', status_code: 401 }]);
    });

    it.each([
      ['a wrong token', `Bearer ${REPORT_TOKEN}x`],
      ['the token without the Bearer scheme', REPORT_TOKEN],
      ['the admin secret as the bearer token', `Bearer ${ADMIN_SECRET}`],
    ])('rejects %s', async (_label, authorization) => {
      const response = await quietly(() => getReport({ headers: { Authorization: authorization } }));

      expect(response.status).toBe(401);
    });

    it('does not accept the admin secret header in place of the report token', async () => {
      const response = await quietly(() => getReport({ headers: { 'X-Admin-Secret': ADMIN_SECRET } }));

      expect(response.status).toBe(401);
    });

    it('rejects every token and logs an error when USAGE_REPORT_TOKEN is not configured', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

      const response = await getReport({
        env: buildEnv({ USAGE_REPORT_TOKEN: undefined }),
        headers: { Authorization: 'Bearer undefined' },
      });

      expect(response.status).toBe(401);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('USAGE_REPORT_TOKEN not configured'));
      errors.mockRestore();
    });

    it('rejects a valid report token without the API key', async () => {
      const response = await quietly(() => getReport({ apiKey: null }));

      expect(response.status).toBe(401);
    });

    it.each([
      ['as the admin secret header', { 'X-Admin-Secret': REPORT_TOKEN }],
      ['as a bearer token', { Authorization: `Bearer ${REPORT_TOKEN}` }],
    ])('does not accept the report token on /admin/* %s', async (_label, headers) => {
      const response = await quietly(() => fetchWorker(new Request('https://api.ufobeer.app/admin/dlq/stats', {
        headers: { 'CF-Connecting-IP': '203.0.113.20', 'X-API-Key': API_KEY, ...headers },
      }), buildEnv()));

      expect(response.status).toBe(403);
    });
  });

  describe('query validation', () => {
    it.each([
      ['no view', '/reports/usage'],
      ['an unknown view', '/reports/usage?view=installs'],
      ['a malformed from', '/reports/usage?view=daily&from=2026-1-01'],
      ['an impossible date', '/reports/usage?view=daily&from=2026-02-30'],
      ['to in the future', '/reports/usage?view=daily&to=2999-01-01'],
      ['from before the retention window', '/reports/usage?view=daily&from=2000-01-01'],
    ])('returns 400 for %s', async (_label, path) => {
      const response = await getReport({ path });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'Invalid report query' });
    });
  });

  describe('rate limiting', () => {
    it(`allows ${REPORT_RATE_LIMIT_RPM} reads a minute across IPs, then returns 429`, async () => {
      const statuses = await Array.from({ length: REPORT_RATE_LIMIT_RPM + 1 }, (_, i) => i).reduce(
        async (previous, i) => [...(await previous), (await getReport({ ip: `198.51.100.${i + 1}` })).status],
        Promise.resolve<readonly number[]>([]),
      );

      expect(statuses).toEqual([...Array(REPORT_RATE_LIMIT_RPM).fill(200), 429]);
    });

    it('does not spend the report bucket on requests with a wrong token', async () => {
      await quietly(() => Array.from({ length: REPORT_RATE_LIMIT_RPM }, (_, i) => i).reduce(async (previous, i) => {
        await previous;
        await getReport({ ip: `198.51.100.${i + 1}`, headers: { Authorization: 'Bearer guess' } });
      }, Promise.resolve()));

      expect((await getReport({ ip: '192.0.2.200' })).status).toBe(200);
    });

    it('does not consume the shared per-key bucket that /beers routes use', async () => {
      const workerEnv = buildEnv({ RATE_LIMIT_RPM: '2' });
      await Array.from({ length: 5 }, (_, i) => i).reduce(async (previous, i) => {
        await previous;
        await getReport({ env: workerEnv, ip: `192.0.2.${i + 1}` });
      }, Promise.resolve());

      expect((await postBatchLookup('192.0.2.100', workerEnv)).status).toBe(200);
    });
  });
});

describe('parseUsageReportQuery', () => {
  const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
  const query = (params: string, now: number = NOW) => parseUsageReportQuery(new URLSearchParams(params), now);

  it('defaults to the last 90 UTC days, today included', () => {
    expect(query('view=events')).toEqual({ ok: true, view: 'events', from: '2026-08-14', to: '2026-11-11' });
  });

  it('accepts an explicit inclusive range of one day', () => {
    expect(query('view=daily&from=2026-11-01&to=2026-11-01')).toEqual({
      ok: true, view: 'daily', from: '2026-11-01', to: '2026-11-01',
    });
  });

  it('accepts from on the retention cutoff (today minus 730 days) and rejects the day before', () => {
    expect(query('view=daily&from=2024-11-11')).toMatchObject({ ok: true, from: '2024-11-11' });
    expect(query('view=daily&from=2024-11-10')).toMatchObject({ ok: false });
  });

  it('accepts to on today and rejects tomorrow', () => {
    expect(query('view=daily&from=2026-11-01&to=2026-11-11')).toMatchObject({ ok: true });
    expect(query('view=daily&from=2026-11-01&to=2026-11-12')).toMatchObject({ ok: false });
  });

  it('rejects from after to', () => {
    expect(query('view=daily&from=2026-11-02&to=2026-11-01')).toMatchObject({ ok: false });
  });

  it('rejects a default range whose from would fall after an explicit to', () => {
    expect(query('view=daily&to=2026-01-01')).toMatchObject({ ok: false });
  });

  it('moves the retention cutoff with the clock, counting the leap day', () => {
    const later = Date.UTC(2028, 10, 20, 0, 0, 0);

    expect(query('view=daily&from=2026-11-21', later)).toMatchObject({ ok: true });
    expect(query('view=daily&from=2026-11-20', later)).toMatchObject({ ok: false });
  });
});
