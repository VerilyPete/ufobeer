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

describe('cleanup applies only guard-approved model fixes', () => {
  const source = 'Brewed by Pleasent Valley. A pleasent ale with Citra,Mosaic hops';
  const run = async (response: string, overrides: { beerName?: string; brewer?: string } = {}) => {
    const ai = { run: vi.fn().mockResolvedValue({ response }) } as unknown as Ai;
    const message = {
      body: { beerId: 'beer-1', beerName: overrides.beerName ?? 'Valley Lager', brewer: overrides.brewer ?? 'Valley Brewing', brewDescription: source },
      ack: vi.fn(),
      retry: vi.fn(),
    } as unknown as Message<CleanupMessage>;
    const [result] = await processAIConcurrently([message], ai, 1, { breaker: createCircuitBreaker() });
    return result;
  };
  const entries = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.map(([line]) => (typeof line === 'string' && line.startsWith('{') ? JSON.parse(line) : null)).filter(Boolean);

  it('persists reviewed spelling, comma-space and final full stop fixes and logs each edit', async () => {
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fixed = 'Brewed by Pleasant Valley. A pleasant ale with Citra, Mosaic hops.';
    expect(await run(fixed)).toMatchObject({ success: true, cleaned: fixed, usedOriginal: false });
    expect(entries(info)).toContainEqual(expect.objectContaining({
      event: 'cleanup.guard.accepted',
      beerId: 'beer-1',
      edits: [
        { from: 'Pleasent', to: 'Pleasant' },
        { from: 'pleasent', to: 'pleasant' },
        { from: 'Citra,Mosaic', to: 'Citra, Mosaic' },
        { from: 'hops', to: 'hops.' },
      ],
    }));
    info.mockRestore();
  });

  it.each([
    ['an added comma', 'Brewed by Pleasent Valley. A pleasent, ale with Citra,Mosaic hops', 'R3'],
    ['a changed word', 'Brewed by Pleasent Valley. A delightful ale with Citra,Mosaic hops', 'R2'],
    ['an added word', 'Brewed by Pleasent Valley. A pleasent ale with juicy Citra,Mosaic hops', 'R1'],
    ['a capitalization change', 'Brewed by Pleasent Valley. A pleasent Ale with Citra,Mosaic hops', 'R4'],
  ])('falls back to deterministic cleanup for %s and logs the rule', async (_case, response, rule) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await run(response)).toMatchObject({ success: true, cleaned: source, usedOriginal: true });
    expect(entries(warn)).toContainEqual(expect.objectContaining({ event: 'cleanup.guard.rejected', beerId: 'beer-1', rule }));
    warn.mockRestore();
  });

  it('never corrects a word in the beer name or brewer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response = 'Brewed by Pleasant Valley. A pleasent ale with Citra,Mosaic hops';
    expect(await run(response, { brewer: 'Pleasent Valley Brewing' })).toMatchObject({ cleaned: source, usedOriginal: true });
    expect(await run(response)).toMatchObject({ cleaned: response, usedOriginal: false });
    vi.restoreAllMocks();
  });
});
