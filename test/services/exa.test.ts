import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExaError, fetchAbvFromUntappd } from '../../src/services/exa';
import type { Env } from '../../src/types';
import anniversary from '../fixtures/exa/18th-anniversary.json';
import pecanPorter from '../fixtures/exa/512-wba-pecan-porter.json';

const env = { EXA_API_KEY: 'test-exa-key' } as Env;

function stubExa(response: () => Response | Promise<Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchAbvFromUntappd request', () => {
  it('searches untappd.com with live crawling for "<brewer> <name>", the name stripped of its leading tag and container', async () => {
    const fetchSpy = stubExa(() => Response.json(anniversary));
    await fetchAbvFromUntappd(env, '(512) 18th Anniversary (CAN)', '(512) Brewing Co.');

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://api.exa.ai/search');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('test-exa-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      query: '(512) Brewing Co. 18th Anniversary',
      type: 'auto',
      numResults: 8,
      includeDomains: ['untappd.com'],
      contents: { text: { maxCharacters: 1500 }, livecrawl: 'preferred' },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('searches the name alone when there is no brewer, and strips control characters', async () => {
    const fetchSpy = stubExa(() => Response.json({ results: [] }));
    await fetchAbvFromUntappd(env, 'Lone\u0000  Pint\nIPA', '');
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)).query).toBe('Lone Pint IPA');
  });

  it('throws a configuration error without a key, before any request', async () => {
    const fetchSpy = stubExa(() => Response.json(anniversary));
    await expect(fetchAbvFromUntappd({} as Env, 'IPA', 'Acme')).rejects.toMatchObject({ kind: 'configuration' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('fetchAbvFromUntappd result', () => {
  it('returns the ABV of the first strictly matching Untappd beer page', async () => {
    stubExa(() => Response.json(anniversary));
    expect(await fetchAbvFromUntappd(env, '(512) 18th Anniversary', '(512) Brewing Co.')).toBe(8);
  });

  it('returns null when no result is the same beer', async () => {
    stubExa(() => Response.json(pecanPorter));
    expect(await fetchAbvFromUntappd(env, '(512) Whiskey Barrel Aged Pecan Porter', '(512) Brewing Co.')).toBeNull();
  });

  it.each([
    'https://untappd.com/512Brewing',
    'https://awards.untappd.com/beers/7661138/',
    'https://untappd.com/shop/items/1-18th-anniversary',
  ])('never reads a non-beer page %j, even with a matching title and stats', async (url) => {
    stubExa(() => Response.json({ results: [{ ...anniversary.results[1], url }] }));
    expect(await fetchAbvFromUntappd(env, '(512) 18th Anniversary', '(512) Brewing Co.')).toBeNull();
  });

  it('skips results without text and results that are not beer pages', async () => {
    stubExa(() => Response.json({
      results: [
        { url: 'https://untappd.com/512Brewing', title: '18th Anniversary - (512) Brewing Company', text: anniversary.results[1]!.text },
        { url: 'https://untappd.com/b/x/1', title: '18th Anniversary - (512) Brewing Company' },
        anniversary.results[1],
      ],
    }));
    expect(await fetchAbvFromUntappd(env, '(512) 18th Anniversary', '(512) Brewing Co.')).toBe(8);
  });
});

describe('fetchAbvFromUntappd failures', () => {
  it.each([429, 500, 503])('throws an http error for status %i', async (status) => {
    stubExa(() => Response.json({ error: 'nope' }, { status }));
    await expect(fetchAbvFromUntappd(env, 'IPA', 'Acme')).rejects.toMatchObject({ kind: 'http', status });
  });

  it('throws an invalid_response error for a body that is not JSON', async () => {
    stubExa(() => new Response('<html>', { status: 200 }));
    await expect(fetchAbvFromUntappd(env, 'IPA', 'Acme')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('throws an invalid_response error for JSON of the wrong shape', async () => {
    stubExa(() => Response.json({ results: 'many' }));
    await expect(fetchAbvFromUntappd(env, 'IPA', 'Acme')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('throws an invalid_response error for more results than the eight requested', async () => {
    stubExa(() => Response.json({ results: Array.from({ length: 9 }, (_, i) => ({ url: `https://untappd.com/b/x/${i}`, title: 'x' })) }));
    await expect(fetchAbvFromUntappd(env, 'IPA', 'Acme')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('throws an invalid_response error for an oversized body', async () => {
    stubExa(() => new Response('x'.repeat(300 * 1024)));
    await expect(fetchAbvFromUntappd(env, 'IPA', 'Acme')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rethrows a transport failure such as a timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(fetchAbvFromUntappd(env, 'IPA', 'Acme')).rejects.toThrow('timed out');
  });

  it('is an ExaError for every provider failure', async () => {
    stubExa(() => Response.json({}, { status: 500 }));
    await expect(fetchAbvFromUntappd(env, 'IPA', 'Acme')).rejects.toBeInstanceOf(ExaError);
  });
});

describe('fetchAbvFromUntappd logging', () => {
  it('logs the outcome and candidate count, never page text or the key', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(capture);
    vi.spyOn(console, 'warn').mockImplementation(capture);
    vi.spyOn(console, 'error').mockImplementation(capture);
    stubExa(() => Response.json(anniversary));

    await fetchAbvFromUntappd(env, '(512) 18th Anniversary', '(512) Brewing Co.');

    const logged = lines.join('\n');
    expect(logged).toContain('"outcome":"found"');
    expect(logged).toContain('"candidates":8');
    expect(anniversary.results[1]!.text).toContain('New England / Hazy');
    expect(logged).not.toContain('New England / Hazy');
    expect(logged).not.toContain('test-exa-key');
  });
});
