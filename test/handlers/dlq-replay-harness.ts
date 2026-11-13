/**
 * Real-D1 helpers for admin DLQ replay tests: seeding, a replay call, stub
 * queues, and a database wrapper that runs hooks around each database call
 * (one statement run or one whole batch) so tests can interleave writes.
 */
import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import { handleDlqReplay } from '../../src/handlers/dlq';
import type { EnrichmentMessage, Env, RequestContext } from '../../src/types';

export const ENRICHMENT_BODY: EnrichmentMessage = { beerId: 'beer-1', beerName: 'Valley Lager', brewer: 'Valley Brewing', descriptionHash: 'hash-1' };
export const CLEANUP_BODY = { beerId: 'beer-2', beerName: 'Hill Ale', brewer: 'Hill Brewing', brewDescription: 'A pale ale', descriptionHash: 'hash-2' };

const context: RequestContext = {
  requestId: 'dlq-replay',
  startTime: 0,
  clientIdentifier: 'admin',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

export type BeerSeed = {
  readonly isVerified?: number | null;
  readonly status?: string;
  readonly abv?: number | null;
};

export async function seedBeer(id: string, { isVerified = 0, status = 'failed', abv = null }: BeerSeed = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, enrichment_status, abv, is_verified, description_hash)
     VALUES (?, 'Valley Lager', 'Valley Brewing', ?, ?, ?, ?)`
  ).bind(id, status, abv, isVerified, `hash-${id.slice(-1)}`).run();
}

export async function seedDlqEntry(messageId: string, sourceQueue: string, body: { readonly beerId: string }): Promise<number> {
  const id = await env.DB.prepare(
    `INSERT INTO dlq_messages (message_id, beer_id, failed_at, source_queue, raw_message, status)
     VALUES (?, ?, 0, ?, ?, 'pending') RETURNING id`
  ).bind(messageId, body.beerId, sourceQueue, JSON.stringify(body)).first<number>('id');
  if (id === null) throw new Error('DLQ seed failed');
  return id;
}

export type DlqEntryState = {
  readonly status: string;
  readonly replay_count: number;
  readonly replay_claim: string | null;
  readonly replay_claimed_at: number | null;
};

export async function dlqEntry(id: number): Promise<DlqEntryState | null> {
  return env.DB.prepare('SELECT status, replay_count, replay_claim, replay_claimed_at FROM dlq_messages WHERE id = ?')
    .bind(id).first<DlqEntryState>();
}

export async function beerStatus(id: string): Promise<unknown> {
  return env.DB.prepare('SELECT enrichment_status FROM enriched_beers WHERE id = ?').bind(id).first('enrichment_status');
}

export type StubQueues = {
  readonly enrichment: ReturnType<typeof vi.fn>;
  readonly cleanup: ReturnType<typeof vi.fn>;
  readonly worker: Env;
};

export function queues(onSend: () => Promise<void> = async () => {}): StubQueues {
  const enrichment = vi.fn().mockImplementation(onSend);
  const cleanup = vi.fn().mockImplementation(onSend);
  const worker = { ...env, ENRICHMENT_QUEUE: { send: enrichment }, CLEANUP_QUEUE: { send: cleanup } } as unknown as Env;
  return { enrichment, cleanup, worker };
}

export type ReplayData = Record<string, unknown> & {
  readonly replayed_count?: number;
  readonly failed_count?: number;
  readonly skipped_verified?: readonly number[];
  readonly skipped_resolved?: readonly number[];
};

export async function replayResponse(worker: Env, ids: readonly number[]): Promise<Response> {
  const request = new Request('https://api.example.com/admin/dlq/replay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  return handleDlqReplay(request, worker, {}, context);
}

export async function replay(worker: Env, ids: readonly number[]): Promise<ReplayData> {
  const response = await replayResponse(worker, ids);
  return (await response.json() as { data: ReplayData }).data;
}

export type DbCall = {
  readonly kind: 'statement' | 'batch';
  readonly sql: string;
  readonly index: number;
};

export type DbHooks = {
  readonly before?: (call: DbCall) => Promise<void>;
  readonly after?: (call: DbCall) => Promise<void>;
};

/**
 * Wraps a real D1 database. Each statement execution (run/all/first/raw) and
 * each batch is one numbered call; hooks run immediately before and after it.
 */
export function hookedDb(real: D1Database, hooks: DbHooks): D1Database {
  const counter = { next: 0 };
  const realOf = new WeakMap<object, D1PreparedStatement>();
  const sqlOf = new WeakMap<object, string>();

  const around = async <T>(kind: DbCall['kind'], sql: string, execute: () => Promise<T>): Promise<T> => {
    const call: DbCall = { kind, sql, index: counter.next++ };
    await hooks.before?.(call);
    const result = await execute();
    await hooks.after?.(call);
    return result;
  };

  const wrap = (sql: string, statement: D1PreparedStatement): object => {
    const wrapped = {
      bind: (...args: unknown[]) => wrap(sql, statement.bind(...args)),
      run: () => around('statement', sql, () => statement.run()),
      all: () => around('statement', sql, () => statement.all()),
      raw: () => around('statement', sql, () => statement.raw()),
      first: (column?: string) => around('statement', sql, () => (column === undefined ? statement.first() : statement.first(column))),
    };
    realOf.set(wrapped, statement);
    sqlOf.set(wrapped, sql);
    return wrapped;
  };

  return {
    prepare: (sql: string) => wrap(sql, real.prepare(sql)),
    batch: (statements: readonly object[]) => around(
      'batch',
      statements.map((statement) => sqlOf.get(statement) ?? '').join(';\n'),
      () => real.batch(statements.map((statement) => {
        const unwrapped = realOf.get(statement);
        if (unwrapped === undefined) throw new Error('hookedDb: batch got a statement it did not prepare');
        return unwrapped;
      })),
    ),
    exec: (sql: string) => real.exec(sql),
  } as unknown as D1Database;
}
