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
    await env.DB.batch(['rate_limits', 'audit_log', 'usage_daily', 'usage_installs', 'usage_ingest_daily']
      .map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  });

  describe('authorized reads', () => {
    it.each(VIEWS)('returns a JSON array for the %s view, never cached', async (view) => {
      const response = await getReport({ path: `/reports/usage?view=${view}` });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(Array.isArray(await response.json())).toBe(true);
    });

    it('serves the daily view for the default range: the last 90 days, one row each, ending today', async () => {
      const response = await getReport({ path: '/reports/usage?view=daily' });
      const rows: ReadonlyArray<{ day: string }> = await response.json();

      expect(rows).toHaveLength(90);
      expect(rows.at(-1)?.day).toBe(new Date().toISOString().slice(0, 10));
    });

    it('returns the seeded usage for the range asked, without install IDs', async () => {
      const installId = 'dddddddd-0000-4000-8000-000000000004';
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await env.DB.prepare(
        "INSERT INTO usage_daily (day, install_id, event, app_version, ai_status, os_major, count) VALUES (?, ?, 'view_home', '2.5.0', 'other', 26, 3)",
      ).bind(yesterday, installId).run();

      const response = await getReport({ path: `/reports/usage?view=events&from=${yesterday}&to=${yesterday}` });
      const text = await response.text();

      expect(JSON.parse(text)).toEqual([{ day: yesterday, event: 'view_home', count: 3, installs: 1 }]);
      expect(text).not.toContain(installId);
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

  describe('epoch milliseconds, as Grafana sends ${__from} and ${__to}', () => {
    it('turns each instant into its UTC day, whatever the caller\'s timezone', () => {
      const lateEveningInChicago = Date.UTC(2026, 10, 11, 3, 30, 0);
      const weekEarlier = lateEveningInChicago - 7 * 24 * 60 * 60 * 1000;

      expect(query(`view=daily&from=${weekEarlier}&to=${lateEveningInChicago}`)).toEqual({
        ok: true, view: 'daily', from: '2026-11-04', to: '2026-11-11',
      });
    });

    it('applies the same limits after conversion', () => {
      const tomorrow = NOW + 24 * 60 * 60 * 1000;
      const beforeCutoff = Date.UTC(2024, 10, 10, 23, 59, 59);

      expect(query(`view=daily&to=${tomorrow}`)).toMatchObject({ ok: false });
      expect(query(`view=daily&from=${beforeCutoff}`)).toMatchObject({ ok: false });
    });

    it.each(['99999999999999999999', '-1000', '1.5e12', '12ab'])('rejects %s', (value) => {
      expect(query(`view=daily&from=${value}`)).toMatchObject({ ok: false });
    });
  });

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

  describe('with the clock moved past 730 days', () => {
    const later = Date.UTC(2028, 10, 20, 0, 0, 0);

    it('moves the retention cutoff, counting the leap day', () => {
      expect(query('view=daily&from=2026-11-21', later)).toMatchObject({ ok: true });
      expect(query('view=daily&from=2026-11-20', later)).toMatchObject({ ok: false });
    });

    it('rejects a range reaching past the new today', () => {
      expect(query('view=daily&from=2028-11-01&to=2028-11-20', later)).toMatchObject({ ok: true });
      expect(query('view=daily&from=2028-11-01&to=2028-11-21', later)).toMatchObject({ ok: false });
    });

    it('rejects from after to', () => {
      expect(query('view=daily&from=2028-11-02&to=2028-11-01', later)).toMatchObject({ ok: false });
    });

    it('rejects a range that was valid two years earlier', () => {
      expect(query('view=daily&from=2026-11-11&to=2026-11-12', later)).toMatchObject({ ok: false });
    });
  });
});
