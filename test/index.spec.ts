import { env, createExecutionContext, waitOnExecutionContext, SELF, applyD1Migrations } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Env } from '../src/types';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Beer Enrichment Worker', () => {
	// The auth chain now runs the D1-backed pre-auth rate limiter before any
	// routing, so these tests need real tables (rate_limits, audit_log).
	beforeEach(async () => {
		await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
	});

	it('returns Unauthorized without API key (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env as unknown as Env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
		expect(await response.text()).toMatchInlineSnapshot(`"{"error":"Unauthorized"}"`);
	});

	it('returns Unauthorized without API key (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(response.status).toBe(401);
		expect(await response.text()).toMatchInlineSnapshot(`"{"error":"Unauthorized"}"`);
	});

	it('throttles unauthenticated requests after the pre-auth limit (integration style)', async () => {
		// Default PRE_AUTH_RPM is 30; hammer until the pre-auth bucket trips.
		let last: Response | undefined;
		for (let i = 0; i < 40; i++) {
			last = await SELF.fetch('https://example.com');
			if (last.status === 429) break;
		}
		expect(last?.status).toBe(429);
		const body = (await last?.json()) as Record<string, unknown> | undefined;
		expect(body?.['error']).toBe('Rate limit exceeded');
	});
});
