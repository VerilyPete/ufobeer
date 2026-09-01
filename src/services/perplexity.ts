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
  MAX_LOGGED_ERROR_BODY_LENGTH,
} from '../constants';
import { PerplexityResponseSchema } from '../schemas/external';
import { readBoundedText, ResponseTooLargeError } from '../utils/bounded-response';

// MAX_PROMPT_FIELD_LENGTH, MAX_PERPLEXITY_RESPONSE_BYTES, and
// MAX_LOGGED_ERROR_BODY_LENGTH now live in src/constants.ts (imported
// above) as part of the constants consolidation.

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


function truncateForLog(text: string, maxLength = MAX_LOGGED_ERROR_BODY_LENGTH): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}... [truncated]` : text;
}

/**
 * Fetch ABV from Perplexity API for a given beer.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param beerName - Name of the beer to look up
 * @param brewer - Brewer/brewery name (can be null)
 * @returns The ABV as a number (e.g., 5.5), or null if not found
 * @throws Error if the API request fails (to trigger retry in queue consumer)
 *
 * @example
 * ```typescript
 * const abv = await fetchAbvFromPerplexity(env, 'Sierra Nevada Pale Ale', 'Sierra Nevada');
 * // Returns: 5.6 (or null if not found)
 * ```
 */
export async function fetchAbvFromPerplexity(
  env: Env,
  beerName: string,
  brewer: string | null
): Promise<number | null> {
  if (!env.PERPLEXITY_API_KEY) {
    console.warn('PERPLEXITY_API_KEY not configured');
    return null;
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
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
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
      // Truncate independently of the success-path parser cap below -- this
      // bounds log volume from a misbehaving upstream, not memory, so it
      // still uses response.text() directly rather than the bounded reader.
      const errorText = await response.text().catch(() => '[unreadable error body]');
      console.error(`Perplexity API error (${response.status}):`, truncateForLog(errorText));
      throw new Error(`Perplexity API returned ${response.status}`);
    }

    let bodyText: string;
    try {
      bodyText = await readBoundedText(response, MAX_PERPLEXITY_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        console.error(`Perplexity response exceeded ${MAX_PERPLEXITY_RESPONSE_BYTES} byte cap, discarding`);
        return null;
      }
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      console.warn('Perplexity response was not valid JSON');
      return null;
    }

    // Distrust the response the same way as any other externally-controlled
    // input: schema-validate before use, and never treat unparsed content as
    // trustworthy just because the HTTP call itself succeeded.
    const parsed = PerplexityResponseSchema.safeParse(raw);
    const content = parsed.success
      ? parsed.data.choices[0]?.message?.content?.trim()
      : undefined;
    if (!content || content.toLowerCase() === 'unknown') {
      return null;
    }

    // Parse the ABV value
    const abvMatch = content.match(/(\d+\.?\d*)/);
    const matched = abvMatch?.[1];
    if (matched) {
      const abv = parseFloat(matched);
      // Sanity check: ABV should be within plausible range
      if (abv >= MIN_BEER_ABV && abv <= MAX_BEER_ABV) {
        return abv;
      }
    }

    console.warn(`Could not parse ABV from Perplexity response: "${content}"`);
    return null;
  } catch (error) {
    console.error('Perplexity API request failed:', error);
    throw error; // Re-throw to trigger retry
  }
}
