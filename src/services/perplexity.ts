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

  // Include style hint for better search results on obscure beers
  // e.g., "Entropic IPA" -> search includes "IPA" which helps find typical ABV ranges
  const prompt = brewer
    ? `What is the ABV (alcohol by volume) percentage of the beer "${beerName}" by ${brewer}? Search Untappd, BeerAdvocate, or the brewery's website. Reply with ONLY a single number (e.g., 5.5). If multiple versions exist, use the most recent. If unknown, reply "unknown". Do not explain.`
    : `What is the ABV (alcohol by volume) percentage of the beer "${beerName}"? Search Untappd, BeerAdvocate, or the brewery's website. Reply with ONLY a single number (e.g., 5.5). If multiple versions exist, use the most recent. If unknown, reply "unknown". Do not explain.`;

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
