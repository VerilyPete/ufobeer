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

  const prompt = brewer
    ? `What is the ABV (alcohol by volume) percentage of "${beerName}" by ${brewer}? Reply with ONLY the numeric ABV value (e.g., "5.5" or "8.0"). If you cannot find reliable information, reply with "unknown".`
    : `What is the ABV (alcohol by volume) percentage of "${beerName}"? Reply with ONLY the numeric ABV value (e.g., "5.5" or "8.0"). If you cannot find reliable information, reply with "unknown".`;

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
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
        max_tokens: 50,
        temperature: 0.1,
        // Explicitly enable web search - "low" is most cost-effective for simple ABV lookups
        // Pricing: $5 per 1K requests (low), $8 (medium), $12 (high)
        web_search_options: {
          search_context_size: 'low',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Perplexity API error (${response.status}):`, errorText);
      throw new Error(`Perplexity API returned ${response.status}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content || content.toLowerCase() === 'unknown') {
      return null;
    }

    // Parse the ABV value
    const abvMatch = content.match(/(\d+\.?\d*)/);
    if (abvMatch) {
      const abv = parseFloat(abvMatch[1]);
      // Sanity check: ABV should be between 0 and 70
      if (abv >= 0 && abv <= 70) {
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
