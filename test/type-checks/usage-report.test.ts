import { describe, it, expect } from 'vitest';
import type { UsageEventCount, UsageReport } from '../../src/schemas/request';

describe('usage report types', () => {
  it('only accepts event counts that came from the parser', () => {
    // @ts-expect-error a plain number is not a validated usage count
    const fractional: UsageEventCount = { name: 'view_home', count: 1.5 };

    expect(fractional.count).toBe(1.5);
  });

  it('only accepts reports whose counts came from the parser', () => {
    const report: UsageReport = {
      installId: '3f2b8c1e-5d4a-4e7b-9c0f-1a2b3c4d5e6f',
      batchId: '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
      appVersion: '2.4.0',
      aiStatus: 'other',
      osMajor: 26,
      // @ts-expect-error a plain number is not a validated usage count
      events: [{ name: 'view_home', count: -1 }],
    };

    expect(report.events).toHaveLength(1);
  });
});
