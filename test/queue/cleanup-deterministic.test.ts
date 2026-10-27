import { describe, it, expect, vi } from 'vitest';
import { processAIConcurrently } from '../../src/queue/cleanup';
import { createCircuitBreaker } from '../../src/queue/circuitBreaker';
import type { CleanupMessage } from '../../src/types';

const createMessage = (brewDescription: string, overrides: { beerName?: string; brewer?: string } = {}) => ({
  body: {
    beerId: 'beer-1',
    beerName: overrides.beerName ?? 'Valley Lager',
    brewer: overrides.brewer ?? 'Valley Brewing',
    brewDescription,
  },
  ack: vi.fn(),
  retry: vi.fn(),
}) as unknown as Message<CleanupMessage>;

const createAI = () => ({ run: vi.fn().mockResolvedValue({ response: 'Invented model text.' }) });

const clean = async (description: string, overrides: { beerName?: string; brewer?: string } = {}) => {
  const ai = createAI();
  const [result] = await processAIConcurrently([createMessage(description, overrides)], ai as unknown as Ai, 1, {
    breaker: createCircuitBreaker(),
  });
  return { result, ai };
};

describe('deterministic description cleanup', () => {
  it('applies every permitted fix without calling the model', async () => {
    const { result, ai } = await clean('<p>A pleasent ale with Citra,Mosaic hops at 9.2%ABV</p>');
    expect(ai.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      cleaned: 'A pleasant ale with Citra, Mosaic hops at 9.2% ABV.',
      usedOriginal: false,
      extractedABV: 9.2,
    });
  });

  it('logs every applied fix with the beer ID and never the description', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    await clean('A pleasent ale with Citra,Mosaic hops');
    const entries = info.mock.calls
      .map(([line]) => (typeof line === 'string' && line.startsWith('{') ? JSON.parse(line) : null))
      .filter(Boolean);
    expect(entries).toContainEqual(expect.objectContaining({
      event: 'cleanup.fixes.applied',
      beerId: 'beer-1',
      edits: [
        { from: 'pleasent', to: 'pleasant' },
        { from: 'Citra,Mosaic', to: 'Citra, Mosaic' },
        { from: 'hops', to: 'hops.' },
      ],
    }));
    expect(JSON.stringify(entries)).not.toContain('A pleasent ale');
    info.mockRestore();
  });

  it('never alters the beer name or brewer', async () => {
    const { result } = await clean('Brewed by Pleasent Valley.', { brewer: 'Pleasent Valley Brewing' });
    expect(result).toMatchObject({ success: true, cleaned: 'Brewed by Pleasent Valley.', usedOriginal: false });
  });

  it('returns the sanitized source unchanged when nothing needs fixing', async () => {
    const { result } = await clean('A crisp &amp; dry finish!');
    expect(result).toMatchObject({ success: true, cleaned: 'A crisp & dry finish!', usedOriginal: false });
  });
});
