import { describe, it, expect } from 'vitest';
import {
  parseUsageReport,
  USAGE_EVENTS,
  USAGE_MAX_COUNT_PER_EVENT,
  USAGE_MAX_EVENT_ITEMS,
} from '../../src/schemas/request';

const INSTALL_ID = '3f2b8c1e-5d4a-4e7b-9c0f-1a2b3c4d5e6f';
const BATCH_ID = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

const buildBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  install_id: INSTALL_ID,
  batch_id: BATCH_ID,
  app_version: '2.4.0',
  ai_status: 'apple_intelligence',
  os_major: 26,
  events: [{ name: 'suggestions_opened', count: 3 }],
  ...overrides,
});

const parseOk = (body: unknown) => {
  const result = parseUsageReport(body);
  if (!result.success) {
    throw new Error(`expected success, got: ${result.error}`);
  }
  return result;
};

const expectEnvelopeError = (body: unknown): void => {
  expect(parseUsageReport(body).success).toBe(false);
};

describe('parseUsageReport envelope', () => {
  it('parses a valid report into the domain shape', () => {
    const result = parseOk(buildBody({
      events: [
        { name: 'suggestions_opened', count: 3 },
        { name: 'fallback_deadline_expired', count: 1 },
      ],
    }));

    expect(result.report).toEqual({
      installId: INSTALL_ID,
      batchId: BATCH_ID,
      appVersion: '2.4.0',
      aiStatus: 'apple_intelligence',
      osMajor: 26,
      events: [
        { name: 'suggestions_opened', count: 3 },
        { name: 'fallback_deadline_expired', count: 1 },
      ],
    });
    expect(result.droppedCount).toBe(0);
  });

  it('rejects non-object bodies', () => {
    expectEnvelopeError(null);
    expectEnvelopeError('report');
    expectEnvelopeError([buildBody()]);
  });

  it.each(['install_id', 'batch_id'])('rejects a missing %s', (field) => {
    const { [field]: _omitted, ...body } = buildBody();
    expectEnvelopeError(body);
  });

  it.each(['install_id', 'batch_id'])('rejects a %s that is not a UUID', (field) => {
    expectEnvelopeError(buildBody({ [field]: 'not-a-uuid' }));
    expectEnvelopeError(buildBody({ [field]: 42 }));
    expectEnvelopeError(buildBody({ [field]: `${INSTALL_ID}0` }));
  });

  it('lower-cases install_id and batch_id', () => {
    const result = parseOk(buildBody({
      install_id: INSTALL_ID.toUpperCase(),
      batch_id: BATCH_ID.toUpperCase(),
    }));

    expect(result.report.installId).toBe(INSTALL_ID);
    expect(result.report.batchId).toBe(BATCH_ID);
  });

  it.each(['0.0.0', '2.4.0', '99.999.999'])('accepts app_version %s', (appVersion) => {
    expect(parseOk(buildBody({ app_version: appVersion })).report.appVersion).toBe(appVersion);
  });

  it.each(['2.4', '2.4.0.1', '100.0.0', '1.1000.0', '1.0.1000', 'v2.4.0', '2.4.0-beta', '', ' 2.4.0'])(
    'rejects app_version %j',
    (appVersion) => {
      expectEnvelopeError(buildBody({ app_version: appVersion }));
    },
  );

  it('rejects a non-string app_version', () => {
    expectEnvelopeError(buildBody({ app_version: 2.4 }));
  });

  it.each([
    'apple_intelligence',
    'requires_newer_os',
    'device_not_eligible',
    'not_enabled',
    'model_not_ready',
    'unsupported_locale',
    'unavailable',
  ])('stores known ai_status %s as-is', (aiStatus) => {
    expect(parseOk(buildBody({ ai_status: aiStatus })).report.aiStatus).toBe(aiStatus);
  });

  it.each(['brand_new_case', '', 'APPLE_INTELLIGENCE', 'x'.repeat(5000)])(
    'stores unknown ai_status %j as other',
    (aiStatus) => {
      expect(parseOk(buildBody({ ai_status: aiStatus })).report.aiStatus).toBe('other');
    },
  );

  it.each([null, 1, true, {}])('rejects non-string ai_status %j', (aiStatus) => {
    expectEnvelopeError(buildBody({ ai_status: aiStatus }));
  });

  it('rejects a missing ai_status', () => {
    const { ai_status: _omitted, ...body } = buildBody();
    expectEnvelopeError(body);
  });

  it.each([13, 26, 99])('accepts os_major %d', (osMajor) => {
    expect(parseOk(buildBody({ os_major: osMajor })).report.osMajor).toBe(osMajor);
  });

  it.each([12, 100, 26.5, '26', null])('rejects os_major %j', (osMajor) => {
    expectEnvelopeError(buildBody({ os_major: osMajor }));
  });

  it('rejects a missing or non-array events field', () => {
    const { events: _omitted, ...body } = buildBody();
    expectEnvelopeError(body);
    expectEnvelopeError(buildBody({ events: { name: 'view_home', count: 1 } }));
  });

  it('accepts exactly the maximum number of event items', () => {
    const events = Array.from({ length: USAGE_MAX_EVENT_ITEMS }, () => ({ name: 'view_home', count: 1 }));
    expect(parseOk(buildBody({ events })).report.events).toEqual([
      { name: 'view_home', count: USAGE_MAX_EVENT_ITEMS },
    ]);
  });

  it('rejects one event item over the maximum', () => {
    const events = Array.from({ length: USAGE_MAX_EVENT_ITEMS + 1 }, () => ({ name: 'view_home', count: 1 }));
    expectEnvelopeError(buildBody({ events }));
  });

  it('ignores unknown top-level fields', () => {
    const result = parseOk(buildBody({ device_model: 'iPhone17,1', timestamp: 123 }));
    expect(result.report).not.toHaveProperty('device_model');
    expect(result.report).not.toHaveProperty('timestamp');
  });
});

describe('parseUsageReport event items', () => {
  const eventsOf = (events: readonly unknown[]) => parseOk(buildBody({ events }));

  it('accepts every known event name', () => {
    const result = eventsOf(USAGE_EVENTS.map((name) => ({ name, count: 1 })));
    expect(result.report.events.map((e) => e.name)).toEqual([...USAGE_EVENTS]);
    expect(result.droppedCount).toBe(0);
  });

  it('drops unknown event names without failing the report', () => {
    const result = eventsOf([
      { name: 'view_home', count: 2 },
      { name: 'brand_new_feature', count: 1 },
    ]);
    expect(result.report.events).toEqual([{ name: 'view_home', count: 2 }]);
    expect(result.droppedCount).toBe(1);
  });

  it.each([
    ['fractional', 1.5],
    ['string', '3'],
    ['null', null],
    ['zero', 0],
    ['negative', -1],
    ['over the limit', USAGE_MAX_COUNT_PER_EVENT + 1],
  ])('drops a %s count', (_label, count) => {
    const result = eventsOf([{ name: 'view_home', count }, { name: 'view_tasted', count: 1 }]);
    expect(result.report.events).toEqual([{ name: 'view_tasted', count: 1 }]);
    expect(result.droppedCount).toBe(1);
  });

  it('drops an item with a missing count', () => {
    const result = eventsOf([{ name: 'view_home' }]);
    expect(result.report.events).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it.each([null, 'view_home', 3, ['view_home', 1]])('drops non-object item %j', (item) => {
    const result = eventsOf([item]);
    expect(result.report.events).toEqual([]);
    expect(result.droppedCount).toBe(1);
  });

  it('accepts a count at the per-item limit', () => {
    expect(eventsOf([{ name: 'view_home', count: USAGE_MAX_COUNT_PER_EVENT }]).report.events).toEqual([
      { name: 'view_home', count: USAGE_MAX_COUNT_PER_EVENT },
    ]);
  });

  it('strips unknown fields on an item instead of dropping it', () => {
    const result = eventsOf([{ name: 'view_home', count: 2, screen: 'home' }]);
    expect(result.report.events).toEqual([{ name: 'view_home', count: 2 }]);
    expect(result.droppedCount).toBe(0);
  });

  it('sums repeated names', () => {
    const result = eventsOf([
      { name: 'view_home', count: 2 },
      { name: 'view_tasted', count: 1 },
      { name: 'view_home', count: 5 },
    ]);
    expect(result.report.events).toEqual([
      { name: 'view_home', count: 7 },
      { name: 'view_tasted', count: 1 },
    ]);
  });

  it('clamps a summed count to the per-event limit', () => {
    const result = eventsOf([
      { name: 'view_home', count: USAGE_MAX_COUNT_PER_EVENT },
      { name: 'view_home', count: 1 },
    ]);
    expect(result.report.events).toEqual([{ name: 'view_home', count: USAGE_MAX_COUNT_PER_EVENT }]);
  });

  it('gives an empty event list when every item is dropped', () => {
    const result = eventsOf([{ name: 'nope', count: 1 }, { name: 'view_home', count: 0 }]);
    expect(result.report.events).toEqual([]);
    expect(result.droppedCount).toBe(2);
  });

  it('accepts an empty events array', () => {
    const result = eventsOf([]);
    expect(result.report.events).toEqual([]);
    expect(result.droppedCount).toBe(0);
  });
});
