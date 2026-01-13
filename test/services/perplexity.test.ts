/**
 * Unit tests for Perplexity API service.
 *
 * Tests fetchAbvFromPerplexity function for ABV lookup functionality,
 * response parsing, validation, and error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchAbvFromPerplexity } from '../../src/services/perplexity';
import type { Env } from '../../src/types';

// Store original fetch to restore after tests
const originalFetch = globalThis.fetch;

/**
 * Creates a mock Env object with optional Perplexity API key.
 */
function createMockEnv(perplexityApiKey: string | undefined = 'test-api-key'): Env {
  return {
    DB: {} as D1Database,
    ENRICHMENT_QUEUE: {} as Queue<unknown>,
    CLEANUP_QUEUE: {} as Queue<unknown>,
    AI: {} as Ai,
    API_KEY: 'test-api-key',
    FLYING_SAUCER_API_BASE: 'https://example.com',
    PERPLEXITY_API_KEY: perplexityApiKey,
    ALLOWED_ORIGIN: '*',
    RATE_LIMIT_RPM: '60',
  } as Env;
}

/**
 * Creates a mock Perplexity API response.
 */
function createMockResponse(content: string): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      choices: [{ message: { content } }],
    }),
    text: vi.fn().mockResolvedValue(''),
  } as unknown as Response;
}

/**
 * Creates a mock error response.
 */
function createMockErrorResponse(status: number, body: string = 'Error'): Response {
  return {
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('fetchAbvFromPerplexity', () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let mockConsoleWarn: ReturnType<typeof vi.spyOn>;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
    mockConsoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('successful responses', () => {
    it('should parse numeric ABV from response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('6.5'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test IPA',
        'Test Brewery'
      );

      expect(result).toBe(6.5);
    });

    it('should parse integer ABV from response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Lager',
        'Test Brewery'
      );

      expect(result).toBe(5);
    });

    it('should parse decimal ABV with % sign', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.5%'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Lager',
        'Test Brewery'
      );

      expect(result).toBe(5.5);
    });

    it('should return null for "unknown" response (lowercase)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('unknown'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Rare Beer',
        'Unknown Brewery'
      );

      expect(result).toBeNull();
    });

    it('should return null for "Unknown" response (capitalized)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('Unknown'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Rare Beer',
        'Unknown Brewery'
      );

      expect(result).toBeNull();
    });

    it('should return null for "UNKNOWN" response (uppercase)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('UNKNOWN'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Rare Beer',
        'Unknown Brewery'
      );

      expect(result).toBeNull();
    });

    it('should handle ABV with surrounding text', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse('The ABV is approximately 7.2%')
      );

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test IPA',
        'Test Brewery'
      );

      expect(result).toBe(7.2);
    });

    it('should extract first number from response with multiple numbers', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse('The beer has 5.5% ABV. Some versions are 6.0%.')
      );

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test IPA',
        'Test Brewery'
      );

      // Should extract the first number (5.5)
      expect(result).toBe(5.5);
    });

    it('should handle response with whitespace padding', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('  6.5  '));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBe(6.5);
    });

    it('should return null for empty response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(''));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });

    it('should return null for response with no numbers', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse('This beer has a moderate alcohol content.')
      );

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
      expect(mockConsoleWarn).toHaveBeenCalled();
    });
  });

  describe('ABV validation', () => {
    it('should accept ABV of 0', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('0'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Non-Alcoholic Beer',
        'Test Brewery'
      );

      expect(result).toBe(0);
    });

    it('should accept ABV at boundary (70)', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('70'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Strong Beer',
        'Test Brewery'
      );

      expect(result).toBe(70);
    });

    it('should reject ABV > 70 as invalid', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('75'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });

    it('should reject ABV of 100 as invalid', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('100'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });

    it('should extract positive number from negative input', async () => {
      // The regex /(\d+\.?\d*)/ won't match the minus sign, so -5 extracts "5"
      mockFetch.mockResolvedValueOnce(createMockResponse('-5'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      // The regex extracts "5" from "-5", which is valid
      expect(result).toBe(5);
    });

    it('should handle typical craft beer ABV range', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('6.8'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Craft IPA',
        'Local Brewery'
      );

      expect(result).toBe(6.8);
    });

    it('should handle high ABV imperial stouts', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('12.5'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Imperial Stout',
        'Test Brewery'
      );

      expect(result).toBe(12.5);
    });

    it('should handle barleywine ABV', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('14.2'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'English Barleywine',
        'Test Brewery'
      );

      expect(result).toBe(14.2);
    });
  });

  describe('error handling', () => {
    it('should throw on 429 rate limit error', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockErrorResponse(429, 'Rate limit exceeded')
      );

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow('Perplexity API returned 429');
    });

    it('should throw on 500 server error', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockErrorResponse(500, 'Internal Server Error')
      );

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow('Perplexity API returned 500');
    });

    it('should throw on 401 unauthorized error', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockErrorResponse(401, 'Unauthorized')
      );

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow('Perplexity API returned 401');
    });

    it('should throw on 403 forbidden error', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockErrorResponse(403, 'Forbidden')
      );

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow('Perplexity API returned 403');
    });

    it('should throw on network timeout', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Timeout'));

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow('Timeout');
    });

    it('should throw on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow('Network error');
    });

    it('should throw on fetch rejection', async () => {
      mockFetch.mockRejectedValueOnce(new Error('DNS resolution failed'));

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow('DNS resolution failed');
    });

    it('should return null when API key not configured (undefined)', async () => {
      // Create env without the PERPLEXITY_API_KEY property
      const envWithoutKey = {
        DB: {} as D1Database,
        ENRICHMENT_QUEUE: {} as Queue<unknown>,
        CLEANUP_QUEUE: {} as Queue<unknown>,
        AI: {} as Ai,
        API_KEY: 'test-api-key',
        FLYING_SAUCER_API_BASE: 'https://example.com',
        ALLOWED_ORIGIN: '*',
        RATE_LIMIT_RPM: '60',
      } as Env;

      const result = await fetchAbvFromPerplexity(
        envWithoutKey,
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockConsoleWarn).toHaveBeenCalledWith(
        'PERPLEXITY_API_KEY not configured'
      );
    });

    it('should return null when API key is empty string', async () => {
      // The implementation checks !env.PERPLEXITY_API_KEY which treats
      // empty string as falsy, so it should return null
      const result = await fetchAbvFromPerplexity(
        createMockEnv(''),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should log error on API failure', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockErrorResponse(500, 'Server error')
      );

      await expect(
        fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery')
      ).rejects.toThrow();

      expect(mockConsoleError).toHaveBeenCalled();
    });
  });

  describe('response structure handling', () => {
    it('should handle missing choices array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({}),
      });

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });

    it('should handle empty choices array', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ choices: [] }),
      });

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });

    it('should handle missing message in choice', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{}],
        }),
      });

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });

    it('should handle missing content in message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: {} }],
        }),
      });

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });

    it('should handle null content in message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          choices: [{ message: { content: null } }],
        }),
      });

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBeNull();
    });
  });

  describe('prompt construction', () => {
    it('should include brewer when provided', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test IPA', 'Famous Brewery');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.perplexity.ai/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Famous Brewery'),
        })
      );
    });

    it('should include beer name in prompt', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Sierra Nevada Pale Ale', 'Sierra Nevada');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining('Sierra Nevada Pale Ale'),
        })
      );
    });

    it('should handle null brewer gracefully', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test IPA', null);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const userContent = callBody.messages[1].content;

      // Should not contain "by null" pattern
      expect(userContent).not.toContain('by null');
      // Should contain the beer name
      expect(userContent).toContain('Test IPA');
    });

    it('should send correct request headers', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: {
            'Authorization': 'Bearer test-api-key',
            'Content-Type': 'application/json',
          },
        })
      );
    });

    it('should use sonar model', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.model).toBe('sonar');
    });

    it('should include system message for beer expertise', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.messages[0].role).toBe('system');
      expect(callBody.messages[0].content).toContain('beer expert');
    });

    it('should enable web search in request', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.web_search_options).toBeDefined();
      expect(callBody.web_search_options.search_context_size).toBe('medium');
    });

    it('should set low temperature for consistent responses', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.temperature).toBe(0.1);
    });

    it('should set max_tokens to limit response', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.max_tokens).toBe(100);
    });
  });

  describe('API endpoint', () => {
    it('should call correct Perplexity API endpoint', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.perplexity.ai/chat/completions',
        expect.any(Object)
      );
    });

    it('should use POST method', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.0'));

      await fetchAbvFromPerplexity(createMockEnv(), 'Test Beer', 'Test Brewery');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
        })
      );
    });
  });

  describe('edge cases', () => {
    it('should handle beer name with special characters', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.5'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        "O'Hara's Irish Red",
        'Carlow Brewing'
      );

      expect(result).toBe(5.5);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.stringContaining("O'Hara's Irish Red"),
        })
      );
    });

    it('should handle beer name with unicode characters', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('4.9'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Hofbrau Munchner Weisse',
        'Hofbrauhaus'
      );

      expect(result).toBe(4.9);
    });

    it('should handle very long beer name', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('8.0'));
      const longBeerName =
        'This Is A Really Long Beer Name That Goes On And On And On For Testing Purposes';

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        longBeerName,
        'Test Brewery'
      );

      expect(result).toBe(8.0);
    });

    it('should handle decimal ABV with many decimal places', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('5.123456'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBe(5.123456);
    });

    it('should handle ABV response with newlines', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse('\n6.5\n'));

      const result = await fetchAbvFromPerplexity(
        createMockEnv(),
        'Test Beer',
        'Test Brewery'
      );

      expect(result).toBe(6.5);
    });
  });
});
