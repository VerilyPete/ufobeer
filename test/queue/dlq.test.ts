import { describe, it, expect, vi } from 'vitest';
import type { Env, EnrichmentMessage, CleanupMessage } from '../../src/types';

vi.mock('../../src/analytics', () => ({
  trackDlqConsumer: vi.fn(),
}));

import { storeDlqMessage, handleDlqBatch, handleCleanupDlqBatch } from '../../src/queue/dlq';
import { trackDlqConsumer } from '../../src/analytics';

// ============================================================================
// Factories
// ============================================================================

const getMockMessage = (overrides?: Partial<{
  id: string;
  body: Partial<EnrichmentMessage>;
  attempts: number;
}>) => ({
  id: overrides?.id ?? 'msg-abc-123',
  body: {
    beerId: 'beer-001',
    beerName: 'Test IPA',
    brewer: 'Test Brewery',
    ...overrides?.body,
  },
  attempts: overrides?.attempts ?? 3,
  ack: vi.fn(),
  retry: vi.fn(),
});

const getMockCleanupMessage = (overrides?: Partial<{
  id: string;
  body: Partial<CleanupMessage>;
  attempts: number;
}>) => ({
  id: overrides?.id ?? 'msg-cleanup-123',
  body: {
    beerId: 'beer-001',
    beerName: 'Test IPA',
    brewer: 'Test Brewery',
    brewDescription: 'A hoppy IPA with citrus notes',
    ...overrides?.body,
  },
  attempts: overrides?.attempts ?? 3,
  ack: vi.fn(),
  retry: vi.fn(),
});

const getMockDb = (runResult = {}) => ({
  prepare: vi.fn().mockReturnValue({
    bind: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue(runResult),
    }),
  }),
});

const getMockBatch = <T>(messages: Array<{ id: string; body: T; attempts: number; ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> }>, queue = 'beer-enrichment-dlq') => ({
  messages,
  queue,
});

const getMockEnv = (dbOverrides?: Record<string, unknown>): Env => ({
  DB: getMockDb(dbOverrides) as unknown as D1Database,
  ANALYTICS: undefined,
} as unknown as Env);

// ============================================================================
// storeDlqMessage
// ============================================================================

describe('storeDlqMessage', () => {
  it('stores a failed message in the dead letter queue', async () => {
    const db = getMockDb();
    const message = getMockMessage();

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    expect(db.prepare).toHaveBeenCalledOnce();
    expect(db.prepare().bind).toHaveBeenCalledOnce();
    expect(db.prepare().bind().run).toHaveBeenCalledOnce();
  });

  it('persists the message ID', async () => {
    const db = getMockDb();
    const message = getMockMessage({ id: 'msg-unique-id' });

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain('msg-unique-id');
  });

  it('persists the beer ID of the failed message', async () => {
    const db = getMockDb();
    const message = getMockMessage({ body: { beerId: 'beer-xyz' } });

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain('beer-xyz');
  });

  it('persists the beer name of the failed message', async () => {
    const db = getMockDb();
    const message = getMockMessage({ body: { beerName: 'My Great IPA' } });

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain('My Great IPA');
  });

  it('persists the brewer of the failed message', async () => {
    const db = getMockDb();
    const message = getMockMessage({ body: { brewer: 'Awesome Brewing Co' } });

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain('Awesome Brewing Co');
  });

  it('persists the attempt count of the failed message', async () => {
    const db = getMockDb();
    const message = getMockMessage({ attempts: 5 });

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain(5);
  });

  it('persists the source queue name', async () => {
    const db = getMockDb();
    const message = getMockMessage();

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain('beer-enrichment-dlq');
  });

  it('persists the raw message body as JSON', async () => {
    const db = getMockDb();
    const message = getMockMessage();

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain(JSON.stringify(message.body));
  });

  it('uses null for beerName when body.beerName is not provided', async () => {
    const db = getMockDb();
    const message = getMockMessage({ body: { beerName: '' } });
    // beerName is falsy empty string -> body.beerName || null -> null

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain(null);
  });

  it('uses null for brewer when body.brewer is not provided', async () => {
    const db = getMockDb();
    const message = getMockMessage({ body: { brewer: '' } });
    // brewer is falsy empty string -> body.brewer || null -> null

    await storeDlqMessage(
      db as unknown as D1Database,
      message as unknown as Message<EnrichmentMessage>,
      'beer-enrichment-dlq'
    );

    const boundArgs = db.prepare().bind.mock.calls[0] as unknown[];
    expect(boundArgs).toContain(null);
  });
});

// ============================================================================
// handleDlqBatch
// ============================================================================

describe('handleDlqBatch', () => {
  it('calls message.ack() on each message after successful storage', async () => {
    const msg1 = getMockMessage({ id: 'msg-1' });
    const msg2 = getMockMessage({ id: 'msg-2' });
    const batch = getMockBatch([msg1, msg2]);
    const env = getMockEnv();

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(msg1.ack).toHaveBeenCalledOnce();
    expect(msg2.ack).toHaveBeenCalledOnce();
  });

  it('does NOT call message.retry() on successful storage', async () => {
    const msg = getMockMessage();
    const batch = getMockBatch([msg]);
    const env = getMockEnv();

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('reports successful storage to analytics', async () => {
    const msg = getMockMessage({ body: { beerId: 'beer-tracked' } });
    const batch = getMockBatch([msg]);
    const env = getMockEnv();
    vi.mocked(trackDlqConsumer).mockClear();

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(trackDlqConsumer).toHaveBeenCalledWith(
      env.ANALYTICS,
      expect.objectContaining({
        beerId: 'beer-tracked',
        success: true,
        sourceQueue: 'beer-enrichment',
      })
    );
  });

  it('calls message.retry() when storeDlqMessage throws', async () => {
    const msg = getMockMessage();
    const batch = getMockBatch([msg]);
    const db = getMockDb();
    db.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('DB write error')),
      }),
    });
    const env = { ...getMockEnv(), DB: db as unknown as D1Database } as Env;

    vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('does NOT call message.ack() when storeDlqMessage throws', async () => {
    const msg = getMockMessage();
    const batch = getMockBatch([msg]);
    const db = getMockDb();
    db.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('DB write error')),
      }),
    });
    const env = { ...getMockEnv(), DB: db as unknown as D1Database } as Env;

    vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(msg.ack).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('reports failed storage to analytics', async () => {
    const msg = getMockMessage();
    const batch = getMockBatch([msg]);
    const db = getMockDb();
    db.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('DB write error')),
      }),
    });
    const env = { ...getMockEnv(), DB: db as unknown as D1Database } as Env;
    vi.mocked(trackDlqConsumer).mockClear();

    vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(trackDlqConsumer).toHaveBeenCalledWith(
      env.ANALYTICS,
      expect.objectContaining({
        success: false,
        errorType: 'db_write_error',
      })
    );

    vi.restoreAllMocks();
  });

  it('processes all messages in the batch even if one fails', async () => {
    const msg1 = getMockMessage({ id: 'msg-1' });
    const msg2 = getMockMessage({ id: 'msg-2' });
    const msg3 = getMockMessage({ id: 'msg-3' });
    const batch = getMockBatch([msg1, msg2, msg3]);

    let callCount = 0;
    const db = {
      prepare: vi.fn().mockImplementation(() => ({
        bind: vi.fn().mockImplementation(() => ({
          run: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 2) {
              return Promise.reject(new Error('Second message fails'));
            }
            return Promise.resolve({});
          }),
        })),
      })),
    };
    const env = { ...getMockEnv(), DB: db as unknown as D1Database } as Env;

    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(msg1.ack).toHaveBeenCalledOnce();
    expect(msg2.retry).toHaveBeenCalledOnce();
    expect(msg3.ack).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });

  it('strips the -dlq suffix when reporting the source queue to analytics', async () => {
    const msg = getMockMessage();
    const batch = getMockBatch([msg], 'beer-enrichment-dlq');
    const env = getMockEnv();
    vi.mocked(trackDlqConsumer).mockClear();

    await handleDlqBatch(
      batch as unknown as MessageBatch<EnrichmentMessage>,
      env,
      'req-123'
    );

    expect(trackDlqConsumer).toHaveBeenCalledWith(
      env.ANALYTICS,
      expect.objectContaining({
        sourceQueue: 'beer-enrichment',
      })
    );
  });
});

// ============================================================================
// handleCleanupDlqBatch
// ============================================================================

describe('handleCleanupDlqBatch', () => {
  it('calls message.ack() on success', async () => {
    const msg = getMockCleanupMessage();
    const batch = getMockBatch([msg], 'description-cleanup-dlq');
    const env = getMockEnv();

    await handleCleanupDlqBatch(
      batch as unknown as MessageBatch<CleanupMessage>,
      env,
      'req-456'
    );

    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('calls message.retry() on failure', async () => {
    const msg = getMockCleanupMessage();
    const batch = getMockBatch([msg], 'description-cleanup-dlq');
    const db = getMockDb();
    db.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('DB write error')),
      }),
    });
    const env = { ...getMockEnv(), DB: db as unknown as D1Database } as Env;

    vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleCleanupDlqBatch(
      batch as unknown as MessageBatch<CleanupMessage>,
      env,
      'req-456'
    );

    expect(msg.retry).toHaveBeenCalledOnce();
    expect(msg.ack).not.toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it('reports successful storage to analytics with the correct source queue', async () => {
    const msg = getMockCleanupMessage();
    const batch = getMockBatch([msg], 'description-cleanup-dlq');
    const env = getMockEnv();
    vi.mocked(trackDlqConsumer).mockClear();

    await handleCleanupDlqBatch(
      batch as unknown as MessageBatch<CleanupMessage>,
      env,
      'req-456'
    );

    expect(trackDlqConsumer).toHaveBeenCalledWith(
      env.ANALYTICS,
      expect.objectContaining({
        sourceQueue: 'description-cleanup',
        success: true,
      })
    );
  });

  it('reports failed storage to analytics', async () => {
    const msg = getMockCleanupMessage();
    const batch = getMockBatch([msg], 'description-cleanup-dlq');
    const db = getMockDb();
    db.prepare.mockReturnValue({
      bind: vi.fn().mockReturnValue({
        run: vi.fn().mockRejectedValue(new Error('DB write error')),
      }),
    });
    const env = { ...getMockEnv(), DB: db as unknown as D1Database } as Env;
    vi.mocked(trackDlqConsumer).mockClear();

    vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleCleanupDlqBatch(
      batch as unknown as MessageBatch<CleanupMessage>,
      env,
      'req-456'
    );

    expect(trackDlqConsumer).toHaveBeenCalledWith(
      env.ANALYTICS,
      expect.objectContaining({
        success: false,
      })
    );

    vi.restoreAllMocks();
  });
});
