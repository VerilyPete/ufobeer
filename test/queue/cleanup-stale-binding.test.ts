/**
 * Acceptance tests for consumer-side stale-result binding (Cloudflare
 * security review Phase 1, item 2a: "Bind every cleanup/enrichment queue
 * message and result UPDATE to an authoritative description hash; a
 * mismatch acks without writing").
 *
 * Every terminal UPDATE this consumer issues is bound with
 * `WHERE id = ? AND description_hash = ?`. This file proves that binding
 * end-to-end through `handleCleanupBatch` against an in-memory fake D1
 * that actually applies (or rejects) writes based on hash equality, rather
 * than a mock that always reports success regardless of arguments.
 *
 * @module test/queue/cleanup-stale-binding.test
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCleanupBatch } from '../../src/queue/cleanup';
import { queueBeersForCleanup } from '../../src/queue/helpers';
import { hashDescription } from '../../src/utils/hash';
import type { Env, CleanupMessage } from '../../src/types';

// ============================================================================
// Fake D1: an in-memory enriched_beers store that actually
// applies the `WHERE id = ? AND description_hash = ?` gate, so a hash
// mismatch genuinely reports 0 changes instead of a mock that always
// succeeds regardless of arguments.
// ============================================================================

type FakeBeerRow = {
  description_hash: string | null;
  brew_description_cleaned: string | null;
  abv: number | null;
  cleanup_source: string | null;
};

type PreparedCall = { readonly sql: string; readonly args: unknown[] };

function createFakeD1(initialRows: Record<string, FakeBeerRow>) {
  const rows = new Map<string, FakeBeerRow>(Object.entries(initialRows));

  function bindArgsFor(sql: string) {
    return (...args: unknown[]): PreparedCall => ({ sql, args });
  }

  function runOne(call: PreparedCall): { success: true; meta: { changes: number } } {
    const { sql, args } = call;

    if (sql.includes('UPDATE enriched_beers')) {
      // Every UPDATE this module issues binds (..., beerId, descriptionHash)
      // as the final two params, against `WHERE id = ? AND description_hash = ?`.
      const beerId = args[args.length - 2] as string;
      const expectedHash = args[args.length - 1] as string | null;
      const row = rows.get(beerId);
      if (!row || row.description_hash !== expectedHash) {
        return { success: true, meta: { changes: 0 } };
      }

      // Apply the write. Only the columns these tests care about are
      // modeled; SET clause order matches the source (cleaned, timestamp[,
      // abv]), and cleanup_source is a literal in the SQL.
      const source = /cleanup_source = '([^']+)'/.exec(sql)?.[1] ?? null;
      if (sql.includes('abv = ?')) {
        const [cleaned, , abv] = args as [string, number, number];
        rows.set(beerId, { ...row, brew_description_cleaned: cleaned, cleanup_source: source, abv });
      } else {
        const [cleaned] = args as [string];
        rows.set(beerId, { ...row, brew_description_cleaned: cleaned, cleanup_source: source });
      }
      return { success: true, meta: { changes: 1 } };
    }

    return { success: true, meta: { changes: 0 } };
  }

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      return { bind: vi.fn().mockImplementation(bindArgsFor(sql)) };
    }),
    batch: vi.fn().mockImplementation(async (statements: PreparedCall[]) => statements.map(runOne)),
  };

  return { db: db as unknown as D1Database, rows };
}

function createMessage(body: CleanupMessage): Message<CleanupMessage> {
  return {
    id: `msg-${body.beerId}`,
    timestamp: new Date(),
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<CleanupMessage>;
}

function createBatch(messages: Message<CleanupMessage>[]): MessageBatch<CleanupMessage> {
  return {
    messages,
    queue: 'description-cleanup',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<CleanupMessage>;
}

function createEnv(db: D1Database): Env {
  return {
    DB: db,
    ENRICHMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
    CLEANUP_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Env;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('consumer-side stale-result binding', () => {
  it('acks without writing when the message descriptionHash does not match the current row', async () => {
    const description = 'A hoppy IPA from Testville with citrus notes';
    const { db, rows } = createFakeD1({
      'beer-1': { description_hash: 'hash-CURRENT', brew_description_cleaned: null, abv: null, cleanup_source: null },
    });
    const env = createEnv(db);

    // This message was produced from an older description version --
    // its hash does not match the row's current (post-change) hash.
    const message = createMessage({
      beerId: 'beer-1',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      brewDescription: description,
      descriptionHash: 'hash-STALE',
    });

    await handleCleanupBatch(createBatch([message]), env);

    expect(rows.get('beer-1')!.brew_description_cleaned).toBeNull();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('writes exactly once (idempotently) across a duplicate delivery of the same message', async () => {
    const description = 'A hoppy IPA from Testville with citrus notes';
    const { db, rows } = createFakeD1({
      'beer-2': { description_hash: 'hash-match', brew_description_cleaned: null, abv: null, cleanup_source: null },
    });
    const env = createEnv(db);

    const buildMessage = () => createMessage({
      beerId: 'beer-2',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      brewDescription: description,
      descriptionHash: 'hash-match',
    });

    // First delivery.
    const first = buildMessage();
    await handleCleanupBatch(createBatch([first]), env);
    expect(rows.get('beer-2')!.brew_description_cleaned).toBe(`${description}.`);
    expect(first.ack).toHaveBeenCalledOnce();

    const afterFirstDelivery = { ...rows.get('beer-2')! };

    // Cloudflare Queues is at-least-once: the same logical message can be
    // redelivered. Content (and thus the hash) is unchanged, so the write
    // is safely idempotent -- the persisted state after the duplicate
    // delivery is identical to the state after exactly one delivery.
    const duplicate = buildMessage();
    await handleCleanupBatch(createBatch([duplicate]), env);

    expect(rows.get('beer-2')!).toEqual(afterFirstDelivery);
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(duplicate.retry).not.toHaveBeenCalled();
  });

  it('acks without writing when a DLQ-replayed message is older than the current row', async () => {
    const staleDescription = 'A hoppy IPA (original, pre-edit description)';
    const currentDescription = 'A hoppy IPA (already cleaned by a newer run)';
    const { db, rows } = createFakeD1({
      // The row already reflects a newer, successfully-cleaned run.
      'beer-4': {
        description_hash: 'hash-v2',
        brew_description_cleaned: currentDescription,
        abv: null,
        cleanup_source: 'workers-ai',
      },
    });
    const env = createEnv(db);

    // Simulates handlers/dlq.ts replaying a dlq_messages.raw_message that
    // was captured (and failed) back when the row was still at hash-v1.
    const replayedMessage = createMessage({
      beerId: 'beer-4',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      brewDescription: staleDescription,
      descriptionHash: 'hash-v1',
    });

    await handleCleanupBatch(createBatch([replayedMessage]), env);

    // The newer, already-persisted value must survive the stale replay.
    expect(rows.get('beer-4')!.brew_description_cleaned).toBe(currentDescription);
    expect(replayedMessage.ack).toHaveBeenCalledOnce();
    expect(replayedMessage.retry).not.toHaveBeenCalled();
  });

  it('acks without writing, and without an in-flight drop mislabeling it, when the message has no descriptionHash at all', async () => {
    // Only possible for messages already queued before the deploy that
    // introduced CleanupMessage.descriptionHash -- treated as stale rather
    // than processed with a vacuous hash check.
    const description = 'A hoppy IPA from Testville with citrus notes';
    const { db, rows } = createFakeD1({
      'beer-5': { description_hash: 'hash-CURRENT', brew_description_cleaned: null, abv: null, cleanup_source: null },
    });
    const env = createEnv(db);

    const message = createMessage({
      beerId: 'beer-5',
      beerName: 'Test IPA',
      brewer: 'Test Brewery',
      brewDescription: description,
      // descriptionHash intentionally omitted.
    } as CleanupMessage);

    await handleCleanupBatch(createBatch([message]), env);

    expect(rows.get('beer-5')!.brew_description_cleaned).toBeNull();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});

describe('Perplexity forwarding after a stale write', () => {
  it('does not enqueue Perplexity work for a beer whose write was stale', async () => {
    const { db, rows } = createFakeD1({
      'beer-6': { description_hash: 'hash-CURRENT', brew_description_cleaned: null, abv: null, cleanup_source: null },
    });
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env = {
      DB: db,
      ENRICHMENT_QUEUE: { sendBatch },
    } as unknown as Env;

    const message = createMessage({
      beerId: 'beer-6',
      beerName: 'Unrated Beer With No ABV',
      brewer: 'Test Brewery',
      brewDescription: 'No ABV mentioned here at all',
      descriptionHash: 'hash-STALE',
    });

    await handleCleanupBatch(createBatch([message]), env);

    expect(rows.get('beer-6')!.brew_description_cleaned).toBeNull();
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Producer -> consumer seam: queueBeersForCleanup -> CLEANUP_QUEUE ->
// handleCleanupBatch. Unit-testing either side in isolation (as the tests
// above do) would not have caught a producer that silently dropped
// descriptionHash before it ever reached the queue -- this exercises the
// actual message shape queueBeersForCleanup produces, end to end.
// ============================================================================

describe('producer -> consumer seam (queueBeersForCleanup -> handleCleanupBatch)', () => {
  it('a message produced by queueBeersForCleanup is written by the consumer when its hash matches the current row', async () => {
    const description = 'A hoppy IPA from Testville with citrus notes';
    const currentHash = await hashDescription(description);
    const { db, rows } = createFakeD1({
      'beer-7': { description_hash: currentHash, brew_description_cleaned: null, abv: null, cleanup_source: null },
    });

    // The producer side (src/handlers/beers.ts, src/db/helpers.ts -- not
    // owned by this test) calls queueBeersForCleanup with the same
    // brew_description it just hashed for the enriched_beers.description_hash
    // column. queueBeersForCleanup itself computes a matching hash when the
    // caller doesn't supply one (see its doc comment) -- this test does not
    // pass descriptionHash explicitly, to prove that self-computed path
    // produces a message the consumer actually accepts.
    let capturedMessages: Array<{ body: CleanupMessage }> = [];
    const producerEnv = {
      CLEANUP_QUEUE: {
        sendBatch: vi.fn().mockImplementation((messages: Array<{ body: CleanupMessage }>) => {
          capturedMessages = messages;
          return Promise.resolve(undefined);
        }),
      },
    } as unknown as Env;

    const queueResult = await queueBeersForCleanup(
      producerEnv,
      [{ id: 'beer-7', brew_name: 'Test IPA', brewer: 'Test Brewery', brew_description: description }],
      'req-seam'
    );

    expect(queueResult.queued).toBe(1);
    expect(capturedMessages).toHaveLength(1);
    // The seam itself: the producer's output message actually carries a hash.
    expect(capturedMessages[0]!.body.descriptionHash).toBe(currentHash);

    // Feed the exact message the producer sent onto the queue into the
    // consumer, as Cloudflare Queues would deliver it.
    const deliveredMessage = createMessage(capturedMessages[0]!.body);
    const consumerEnv = createEnv(db);

    await handleCleanupBatch(createBatch([deliveredMessage]), consumerEnv);

    expect(rows.get('beer-7')!.brew_description_cleaned).toBe(`${description}.`);
    expect(deliveredMessage.ack).toHaveBeenCalledOnce();
    expect(deliveredMessage.retry).not.toHaveBeenCalled();
  });

  it('the "hash-less message is stale" path does not fire for a normally-produced message', async () => {
    // Regression guard for the defect flagged in review: if
    // queueBeersForCleanup ever again dropped descriptionHash before
    // sending, every message it produces would hit handleCleanupBatch's
    // Phase 0 filter and be acked without ever being cleaned.
    const description = 'A hoppy IPA from Testville with citrus notes';
    const currentHash = await hashDescription(description);
    const { db, rows } = createFakeD1({
      'beer-8': { description_hash: currentHash, brew_description_cleaned: null, abv: null, cleanup_source: null },
    });

    let capturedMessages: Array<{ body: CleanupMessage }> = [];
    const producerEnv = {
      CLEANUP_QUEUE: {
        sendBatch: vi.fn().mockImplementation((messages: Array<{ body: CleanupMessage }>) => {
          capturedMessages = messages;
          return Promise.resolve(undefined);
        }),
      },
    } as unknown as Env;

    await queueBeersForCleanup(
      producerEnv,
      [{ id: 'beer-8', brew_name: 'Test IPA', brewer: 'Test Brewery', brew_description: description }],
      'req-seam-2'
    );

    expect(capturedMessages[0]!.body.descriptionHash).toBeDefined();

    const deliveredMessage = createMessage(capturedMessages[0]!.body);
    await handleCleanupBatch(createBatch([deliveredMessage]), createEnv(db));

    // If the in-flight-drop path had fired, the row would stay unwritten.
    expect(rows.get('beer-8')!.brew_description_cleaned).toBe(`${description}.`);
  });
});

describe('deterministic cleanup', () => {
  const raw = "Refreshing Seltzer from Untitled Art\\'s Florida Seltzers with navel oranged and Yuzu\\r\\n";
  const sanitized = "Refreshing Seltzer from Untitled Art's Florida Seltzers with navel oranged and Yuzu";

  it('cleans escaped source text', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const hash = await hashDescription(raw);
    const { db, rows } = createFakeD1({
      '19995947': { description_hash: hash, brew_description_cleaned: null, abv: null, cleanup_source: null },
    });
    const msg = createMessage({ beerId: '19995947', beerName: 'Florida Seltzer', brewer: 'Untitled Art', brewDescription: raw, descriptionHash: hash });
    await handleCleanupBatch(createBatch([msg]), createEnv(db));
    expect(rows.get('19995947')).toMatchObject({ brew_description_cleaned: `${sanitized}.`, abv: null, cleanup_source: 'deterministic' });
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('decodes entities and separates HTML blocks without changing source ABV', async () => {
    const raw = '<p>Brewer&#39;s &amp; citrus</p><p>5.5% ABV&nbsp;&lt;b&gt;bright&lt;/b&gt;</p>\\r\\n';
    const hash = await hashDescription(raw);
    const { db, rows } = createFakeD1({
      beer: { description_hash: hash, brew_description_cleaned: null, abv: null, cleanup_source: null },
    });
    const msg = createMessage({ beerId: 'beer', beerName: 'Beer', brewer: 'Brewer', brewDescription: raw, descriptionHash: hash });
    await handleCleanupBatch(createBatch([msg]), createEnv(db));
    expect(rows.get('beer')?.brew_description_cleaned).toBe("Brewer's & citrus 5.5% ABV bright.");
    expect(rows.get('beer')?.abv).toBe(5.5);
  });

  it('repairs mojibake, including a mangled non-breaking space, before collapsing whitespace', async () => {
    const raw = 'The aroma boastsÂ huge floral notes over a MÃ¤rzen base â€“ 6.5% ABV';
    const hash = await hashDescription(raw);
    const { db, rows } = createFakeD1({
      beer: { description_hash: hash, brew_description_cleaned: null, abv: null, cleanup_source: null },
    });
    const msg = createMessage({ beerId: 'beer', beerName: 'Beer', brewer: 'Brewer', brewDescription: raw, descriptionHash: hash });
    await handleCleanupBatch(createBatch([msg]), createEnv(db));
    expect(rows.get('beer')?.brew_description_cleaned).toBe('The aroma boasts huge floral notes over a Märzen base – 6.5% ABV.');
  });
});
