/**
 * Perplexity API client for ABV lookups.
 *
 * This service calls the Perplexity AI API to fetch ABV (alcohol by volume)
 * information for beers. It uses the Sonar model with web search enabled
 * to find accurate ABV data.
 *
 * @module services/perplexity
 */

import type { Env } from '../types';
import {
  MIN_BEER_ABV,
  MAX_BEER_ABV,
  PERPLEXITY_TIMEOUT_MS,
  MAX_PROMPT_FIELD_LENGTH,
  MAX_PERPLEXITY_RESPONSE_BYTES,
} from '../constants';
import { PerplexityResponseSchema } from '../schemas/external';
import { readBoundedText, ResponseTooLargeError } from '../utils/bounded-response';

// Prompt and response bounds are shared constants.

/**
 * Neutralize characters that could be used to break out of the quoted
 * beer-name/brewer context in the Perplexity prompt or simulate new
 * instruction lines, then bound length. Perplexity's prompt has no
 * `<TEXT>`-style delimiter to escape (see cleanup.ts for that), but
 * beerName/brewer are still attacker-influenceable text landing directly
 * in a prompt string, so the same "never trust the input" posture applies.
 *
 * Deliberately does NOT strip ordinary punctuation like apostrophes —
 * that would mangle real beer/brewery names (e.g. "O'Hara's Irish Red").
 */
function sanitizeForPrompt(text: string): string {
  // Strip C0/DEL control characters without embedding literal control
  // bytes or hex escapes in this source file.
  const stripped = Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return !(code <= 0x1f || code === 0x7f);
    })
    .join('');
  return stripped
    .replace(/\s+/g, ' ')
    .replace(/"/g, "'")
    .slice(0, MAX_PROMPT_FIELD_LENGTH)
    .trim();
}


export class PerplexityError extends Error {
  constructor(
    readonly kind: 'configuration' | 'http' | 'invalid_response',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PerplexityError';
  }
}

/** Provider identifiers only: never log prompt text, keys, or response content. */
function diagnosticIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
}

async function logHttpFailure(response: Response): Promise<void> {
  let detail: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(await readBoundedText(response, MAX_PERPLEXITY_RESPONSE_BYTES));
    if (raw?.error && typeof raw.error === 'object') detail = raw.error;
  } catch { /* Missing, oversized or malformed error bodies still retain HTTP status. */ }
  console.error(JSON.stringify({
    event: 'perplexity.http_error',
    status: response.status,
    model: 'sonar',
    requestId: diagnosticIdentifier(response.headers?.get('x-request-id')),
    providerType: diagnosticIdentifier(detail.type),
    providerCode: typeof detail.code === 'number' ? detail.code : diagnosticIdentifier(detail.code),
    parameter: diagnosticIdentifier(detail.param),
  }));
}

/**
 * Fetch ABV from Perplexity API for a given beer.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param beerName - Name of the beer to look up
 * @param brewer - Brewer/brewery name (can be null)
 * @returns The ABV as a number (e.g., 5.5), or null only for an explicit unknown response
 * @throws Error if the API request fails (to trigger retry in queue consumer)
 *
 * @example
 * ```typescript
 * const abv = await fetchAbvFromPerplexity(env, 'Sierra Nevada Pale Ale', 'Sierra Nevada');
 * // Returns: 5.6 (or null only for an explicit unknown response)
 * ```
 */
export async function fetchAbvFromPerplexity(
  env: Env,
  beerName: string,
  brewer: string | null
): Promise<number | null> {
  if (!env.PERPLEXITY_API_KEY) {
    throw new PerplexityError('configuration', 'PERPLEXITY_API_KEY not configured');
  }

  // beerName/brewer can originate from /beers/sync, which lets a caller
  // with the extractable app key overwrite them on an existing beer ID —
  // treat them as hostile input regardless of provenance, the same as the
  // Workers AI cleanup prompt (see src/queue/cleanup.ts).
  const safeBeerName = sanitizeForPrompt(beerName);
  const safeBrewer = brewer ? sanitizeForPrompt(brewer) : null;

  // Include style hint for better search results on obscure beers
  // e.g., "Entropic IPA" -> search includes "IPA" which helps find typical ABV ranges
  const prompt = safeBrewer
    ? `What is the ABV (alcohol by volume) percentage of the beer "${safeBeerName}" by ${safeBrewer}? Search Untappd, BeerAdvocate, or the brewery's website. Reply with ONLY a single number (e.g., 5.5). If multiple versions exist, use the most recent. If unknown, reply "unknown". Do not explain.`
    : `What is the ABV (alcohol by volume) percentage of the beer "${safeBeerName}"? Search Untappd, BeerAdvocate, or the brewery's website. Reply with ONLY a single number (e.g., 5.5). If multiple versions exist, use the most recent. If unknown, reply "unknown". Do not explain.`;

  try {
    const response = await fetch('https://api.perplexity.ai/v1/sonar', {
      method: 'POST',
      signal: AbortSignal.timeout(PERPLEXITY_TIMEOUT_MS),
      headers: {
        'Authorization': `Bearer ${env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: 'You are a beer expert assistant. Provide only the requested information, nothing more. Be concise.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 100,
        temperature: 0.1,
        // Enable web search with medium context for better results on obscure beers
        // Pricing: $5 per 1K requests (low), $8 (medium), $12 (high)
        // Using medium because low often fails for small craft breweries
        web_search_options: {
          search_context_size: 'medium',
        },
      }),
    });

    if (!response.ok) {
      await logHttpFailure(response);
      throw new PerplexityError('http', `Perplexity API returned ${response.status}`, response.status);
    }

    let bodyText: string;
    try {
      bodyText = await readBoundedText(response, MAX_PERPLEXITY_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        console.error(`Perplexity response exceeded ${MAX_PERPLEXITY_RESPONSE_BYTES} byte cap, discarding`);
        throw new PerplexityError('invalid_response', 'Perplexity response exceeded byte cap');
      }
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      throw new PerplexityError('invalid_response', 'Perplexity response was not valid JSON');
    }

    // Distrust the response the same way as any other externally-controlled
    // input: schema-validate before use, and never treat unparsed content as
    // trustworthy just because the HTTP call itself succeeded.
    const parsed = PerplexityResponseSchema.safeParse(raw);
    const content = parsed.success
      ? parsed.data.choices[0]?.message?.content?.trim()
      : undefined;
    if (parsed.success && parsed.data.choices[0]?.finish_reason === 'length') {
      throw new PerplexityError('invalid_response', 'Perplexity response was truncated');
    }
    if (!content) {
      throw new PerplexityError('invalid_response', 'Perplexity response missing content');
    }
    if (content.toLowerCase() === 'unknown') {
      return null;
    }

    // Parse the ABV value
    const abvMatch = content.match(/^(\d+(?:\.\d+)?)\s*%?$/);
    const matched = abvMatch?.[1];
    if (matched) {
      const abv = parseFloat(matched);
      // Sanity check: ABV should be within plausible range
      if (abv >= MIN_BEER_ABV && abv <= MAX_BEER_ABV) {
        return abv;
      }
    }

    throw new PerplexityError('invalid_response', 'Perplexity response did not contain a single valid ABV');
  } catch (error) {
    console.error(JSON.stringify({
      event: 'perplexity.failure',
      kind: error instanceof PerplexityError ? error.kind : 'transport',
      status: error instanceof PerplexityError ? error.status : undefined,
    }));
    throw error; // Re-throw to trigger retry
  }
}
