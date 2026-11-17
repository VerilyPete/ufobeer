import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAbvFromPerplexity } from '../../src/services/perplexity';
import type { Env } from '../../src/types';

const env = { PERPLEXITY_API_KEY: 'secret-test-key' } as Env;
const lookup = () => fetchAbvFromPerplexity(env, 'Florida Seltzer Navel Orange Yuzu (CAN)', 'Untitled Art');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const answerOfBytes = (bytes: number): string => {
  const answer = { choices: [{ message: { content: '5' }, finish_reason: 'stop' }], padding: '' };
  const body = JSON.stringify({ ...answer, padding: 'x'.repeat(bytes - JSON.stringify(answer).length) });
  if (new TextEncoder().encode(body).length !== bytes) throw new Error(`fixture is not ${bytes} bytes`);
  return body;
};

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

  it('enriches the Yuzu lookup with the completion budget verified against production', async () => {
    // Captured live comparison: the same full prompt returned HTTP 400 at
    // 100 tokens, and 200 with "5.0" at both 256 and 512. This fixture
    // protects the request budget; it does not claim how Sonar uses it.
    const fetch = vi.fn().mockImplementation(async (_url, init) => {
      const request = JSON.parse(init.body);
      return request.max_tokens <= 100
        ? Response.json({ error: { message: 'invalid request', type: 'invalid_request', code: 400 } }, { status: 400 })
        : Response.json({ choices: [{ message: { content: '5.0' }, finish_reason: 'stop' }] });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(fetchAbvFromPerplexity(env,
      'Untitled Art Florida Seltzer Navel Orange Yuzu (CAN)', 'Untitled Art Brewing')).resolves.toBe(5);
    expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(fetch.mock.calls[0]![1].body).max_tokens).toBe(512);
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

  it('resolves a response body of exactly 32 KiB', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(answerOfBytes(32 * 1024))));
    await expect(lookup()).resolves.toBe(5);
  });

  it('rejects a response body one byte over 32 KiB', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(answerOfBytes(32 * 1024 + 1))));
    await expect(lookup()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('cuts the beer name in the prompt to 300 characters', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '5' } }] }));
    vi.stubGlobal('fetch', fetch);
    await fetchAbvFromPerplexity(env, `${'A'.repeat(300)}B`, null);
    const prompt: string = JSON.parse(fetch.mock.calls[0]![1].body).messages[1].content;
    expect(prompt.match(/beer "([^"]*)"/)?.[1]).toBe('A'.repeat(300));
  });

  it.each(['not json', 'x'.repeat(100_000)])('rejects malformed or oversized response bodies', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    await expect(lookup()).rejects.toMatchObject({ kind: 'invalid_response' });
  });
});
