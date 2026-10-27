import { describe, it, expect, vi } from 'vitest';
import { processAIConcurrently } from '../../src/queue/cleanup';
import { createCircuitBreaker } from '../../src/queue/circuitBreaker';
import type { CleanupMessage } from '../../src/types';

const original = "West Coast Pilsner this one is a meeting of the minds between clean crisp lager and dank bitter west coast IPA.  Pours a bright, clear golden yellow.  Nose is pineapple and Citrus zest.  Dank & sticky upfront with grapefruit and preserved pineapple bitterness.Medium body, a bit bigger than you'd expect from a Pilsner.  Finish is medium dry with very slight hint of piney bitterness.";

describe('cleanup response presentation wrappers', () => {
  it.each(['> Here is the cleaned text:', '**Here is the cleaned text:**', '> **Here is the cleaned text:**'])('removes %s before accepting model text', async prefix => {
    const ai = { run: vi.fn().mockResolvedValue({ response: `${prefix} ${original}` }) } as unknown as Ai;
    const message = { body: { beerId:'21720679', beerName:'Great Heights Leo Carillo', brewer:'Great Heights', brewDescription:original }, ack:vi.fn(), retry:vi.fn() } as unknown as Message<CleanupMessage>;
    const [result] = await processAIConcurrently([message],ai,1,{breaker:createCircuitBreaker()});
    expect(result?.success).toBe(true);
    if (result?.success) {
      expect(result.cleaned).toBe(original.replace(/\s+/g, ' '));
      expect(result.usedOriginal).toBe(false);
      expect(result.extractedABV).toBeNull();
    }
  });
});

// Do not try to enumerate every way a model can introduce itself. Cleanup
// may normalize formatting; it may not add or rewrite source content.
describe('cleanup rejects model-authored content', () => {
  it.each([
    '> Here is the cleared text: ', 'Certainly! ', 'Output follows: ',
    'The formatted result is: ', 'Voilà: ', '📝 ',
  ])('falls back for unrecognized commentary %s', async prefix => {
    const ai = { run: vi.fn().mockResolvedValue({response:prefix + original}) } as unknown as Ai;
    const message = {body:{beerId:'21720679',beerName:'Great Heights Leo Carillo',brewer:'Great Heights',brewDescription:original},ack:vi.fn(),retry:vi.fn()} as unknown as Message<CleanupMessage>;
    const [result] = await processAIConcurrently([message],ai,1,{breaker:createCircuitBreaker()});
    expect(result).toMatchObject({success:true,cleaned:original.replace(/\s+/g,' '),usedOriginal:true,extractedABV:null});
  });
  it.each([original + ' Enjoy!', original + ' 5.8% ABV', original.replace('Pilsner','IPA')])('rejects additions or rewriting', async response => {
    const ai = { run: vi.fn().mockResolvedValue({response}) } as unknown as Ai;
    const message = {body:{beerId:'21720679',beerName:'Leo',brewer:'Great Heights',brewDescription:original},ack:vi.fn(),retry:vi.fn()} as unknown as Message<CleanupMessage>;
    const [result] = await processAIConcurrently([message],ai,1,{breaker:createCircuitBreaker()});
    expect(result).toMatchObject({success:true,cleaned:original.replace(/\s+/g,' '),usedOriginal:true,extractedABV:null});
  });
});
