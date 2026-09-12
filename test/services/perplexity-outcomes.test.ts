import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAbvFromPerplexity } from '../../src/services/perplexity';
import type { Env } from '../../src/types';

const env = { PERPLEXITY_API_KEY: 'secret-test-key' } as Env;
const lookup = () => fetchAbvFromPerplexity(env, 'Florida Seltzer Navel Orange Yuzu (CAN)', 'Untitled Art');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Perplexity outcome distinctions', () => {
  it.each([
    ['missing choices', {}],
    ['truncated numeric answer', { choices: [{ finish_reason: 'length', message: { content: '5' } }] }],
    ['empty choices', { choices: [] }],
    ['missing content', { choices: [{ message: {} }] }],
    ['empty content', { choices: [{ message: { content: ' ' } }] }],
    ['unparseable content', { choices: [{ message: { content: 'No reliable result available.' } }] }],
    ['out of range', { choices: [{ message: { content: '75' } }] }],
    ['ambiguous numbers', { choices: [{ message: { content: '2026 release, 5% ABV' } }] }],
    ['negative number', { choices: [{ message: { content: '-5' } }] }],
  ])('rejects %s instead of caching not_found', async (_, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(body)));
    await expect(lookup()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('reserves null for an explicit unknown answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: ' Unknown ' } }] })));
    await expect(lookup()).resolves.toBeNull();
  });

  it('treats a missing API key as configuration failure', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchAbvFromPerplexity({} as Env, 'Beer', null)).rejects.toMatchObject({ kind: 'configuration' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('logs safe structured HTTP diagnostics without echoing the provider body or key', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: {
      type: 'invalid_request', code: 400, param: 'max_tokens', message: 'secret-test-key sensitive prompt',
    } }, { status: 400, headers: { 'x-request-id': 'provider-request-123' } })));
    await expect(lookup()).rejects.toMatchObject({ kind: 'http', status: 400 });
    const logs = log.mock.calls.map(call => JSON.stringify(call)).join('\n');
    expect(logs).toContain('provider-request-123');
    expect(logs).toContain('invalid_request');
    expect(logs).toContain('max_tokens');
    expect(logs).not.toContain('secret-test-key');
    expect(logs).not.toContain('sensitive prompt');
  });

  it.each(['not json', 'x'.repeat(100_000)])('rejects malformed or oversized response bodies', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(lookup()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
