/**
 * Exa search client for the Untappd ABV fallback.
 *
 * Searches Exa's index of untappd.com (with live crawling, so a page newer
 * than Perplexity's index is still found) and reads the ABV only from a
 * result that strictly matches the beer. We never fetch Untappd ourselves.
 *
 * Returns the ABV, null when no result is the same beer, or throws ExaError
 * (and transport errors) so the consumer can tell a miss from a failure.
 * Never logs page text or the key.
 *
 * @module services/exa
 */

import type { Env } from '../types';
import { EXA_TIMEOUT_MS, MAX_EXA_RESPONSE_BYTES, MAX_PROMPT_FIELD_LENGTH } from '../constants';
import { ExaSearchResponseSchema } from '../schemas/external';
import { readBoundedText, ResponseTooLargeError } from '../utils/bounded-response';
import { abvFromPage, isUntappdBeerUrl, matchesBeer, parseUntappdTitle } from './untappdMatch';

export class ExaError extends Error {
  constructor(
    readonly kind: 'configuration' | 'http' | 'invalid_response',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ExaError';
  }
}

const LEADING_TAG = /^\s*\([^)]*\)\s*/;
const CONTAINER_TAG = /\s*\((?:CAN|BTL|NITRO|DRAFT|CROWLER|CAN\/BTL)\)\s*$/i;

function queryField(text: string): string {
  const printable = Array.from(text)
    .map(ch => {
      const code = ch.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? ' ' : ch;
    })
    .join('');
  return printable.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_FIELD_LENGTH);
}

function buildQuery(beerName: string, brewer: string | null): string {
  const name = queryField(beerName.replace(LEADING_TAG, '').replace(CONTAINER_TAG, ''));
  const brewerPart = brewer ? queryField(brewer) : '';
  return brewerPart === '' ? name : `${brewerPart} ${name}`;
}

function logOutcome(outcome: string, candidates: number, status?: number): void {
  console.log(JSON.stringify({ event: 'exa.untappd_lookup', outcome, candidates, status }));
}

async function readResults(response: Response) {
  let bodyText: string;
  try {
    bodyText = await readBoundedText(response, MAX_EXA_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof ResponseTooLargeError) {
      throw new ExaError('invalid_response', 'Exa response exceeded byte cap');
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    throw new ExaError('invalid_response', 'Exa response was not valid JSON');
  }
  const parsed = ExaSearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExaError('invalid_response', 'Exa response did not match the expected shape');
  }
  return parsed.data.results;
}

export async function fetchAbvFromUntappd(
  env: Env,
  beerName: string,
  brewer: string | null
): Promise<number | null> {
  if (!env.EXA_API_KEY) {
    throw new ExaError('configuration', 'EXA_API_KEY not configured');
  }

  try {
    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
      headers: { 'x-api-key': env.EXA_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: buildQuery(beerName, brewer),
        type: 'auto',
        numResults: 8,
        includeDomains: ['untappd.com'],
        contents: { text: { maxCharacters: 1500 }, livecrawl: 'preferred' },
      }),
    });
    if (!response.ok) {
      throw new ExaError('http', `Exa API returned ${response.status}`, response.status);
    }

    const results = await readResults(response);
    const ours = { ourName: beerName, ourBrewer: brewer ?? '' };
    const abv = results.reduce<number | null>((found, result) => {
      if (found !== null || result.text === undefined || !isUntappdBeerUrl(result.url)) return found;
      const title = parseUntappdTitle(result.title ?? '');
      if (title === null || !matchesBeer(ours, title)) return null;
      return abvFromPage(result.text, title);
    }, null);

    logOutcome(abv === null ? 'no_match' : 'found', results.length);
    return abv;
  } catch (error) {
    logOutcome(
      error instanceof ExaError ? error.kind : 'transport',
      0,
      error instanceof ExaError ? error.status : undefined,
    );
    throw error;
  }
}
