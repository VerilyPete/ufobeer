/**
 * Admin cleanup trigger: prepare, send, mark (plan D8), against real D1.
 *
 * Prepare writes the hash only while the description is still the one the
 * trigger read; only prepared rows are sent; the mark is guarded on the hash
 * and on the row still being uncleaned, and is written only for sent rows.
 * Whatever fails, a row that still needs cleaning stays findable by the same
 * mode: a never-cleaned row by the next 'missing' run, an outdated cleaned row
 * by the next 'all' run.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCleanupTrigger } from '../../src/handlers/cleanupTrigger';
import { handleCleanupBatch } from '../../src/queue/cleanup';
import { insertPlaceholders } from '../../src/db/helpers';
import { hashDescription } from '../../src/utils/hash';
import type { CleanupMessage, Env, RequestContext } from '../../src/types';

const context: RequestContext = {
  requestId: 'request-1',
  startTime: 0,
  clientIdentifier: 'admin',
  apiKeyHash: 'hash',
  clientIp: '127.0.0.1',
  userAgent: 'test',
};

const TEXT_A = 'A crisp lager';
const TEXT_B = 'A hazy pale ale';

type Seed = { readonly id: string; readonly hash?: string | null; readonly cleanupVersion?: number | null };

function insert({ id, hash, cleanupVersion }: Seed, storedHash: string | null): D1PreparedStatement {
  const cleaned = cleanupVersion === undefined ? null : 'Old served text';
  return env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, brew_description_original, description_hash, brew_description_cleaned, description_cleaned_at, cleanup_version)
     VALUES (?, 'Valley Lager', 'Valley Brewing', ?, ?, ?, ?, ?)`
  ).bind(id, TEXT_A, hash === undefined ? storedHash : hash, cleaned, cleaned === null ? null : 1, cleanupVersion ?? null);
}

async function seed(...rows: readonly Seed[]): Promise<void> {
  const hashA = await hashDescription(TEXT_A);
  await env.DB.batch(rows.map(row => insert(row, hashA)));
}

function manyIds(count: number): readonly string[] {
  return Array.from({ length: count }, (_, i) => `b${String(i).padStart(3, '0')}`);
}

/** Real D1 with hooks: after the eligibility SELECT, and on each mark batch. */
type Hooks = {
  readonly afterSelect?: () => Promise<void>;
  readonly onMarkBatch?: (index: number) => void;
};

function hookedDb(hooks: Hooks): D1Database {
  const realDb = env.DB;
  const sqlOf = new WeakMap<object, string>();
  let markBatches = 0;
  return {
    prepare: (sql: string) => {
      const statement = realDb.prepare(sql);
      return {
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          sqlOf.set(bound, sql);
          if (!/SELECT id, brew_name/.test(sql)) return bound;
          return {
            all: async () => {
              const result = await bound.all();
              await hooks.afterSelect?.();
              return result;
            },
          };
        },
      };
    },
    batch: async (statements: D1PreparedStatement[]) => {
      const first = statements[0];
      if (first !== undefined && /queued_for_cleanup_at = MAX/.test(sqlOf.get(first) ?? '')) {
        hooks.onMarkBatch?.(markBatches++);
      }
      return realDb.batch(statements);
    },
  } as unknown as D1Database;
}

type SendBehaviour = (call: number, messages: readonly { readonly body: CleanupMessage }[]) => Promise<void>;

async function trigger(options: { readonly body?: object; readonly db?: D1Database; readonly send?: SendBehaviour } = {}) {
  await env.DB.prepare('DELETE FROM system_state').run();
  const sent: CleanupMessage[] = [];
  let calls = 0;
  const sendBatch = vi.fn(async (messages: readonly { readonly body: CleanupMessage }[]) => {
    await options.send?.(calls++, messages);
    sent.push(...messages.map(message => message.body));
  });
  const worker = { ...env, DB: options.db ?? env.DB, CLEANUP_QUEUE: { sendBatch } } as unknown as Env;
  const request = new Request('https://api.example.com/admin/cleanup/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options.body ?? { mode: 'missing' }),
  });
  const response = await handleCleanupTrigger(request, worker, {}, context);
  return { status: response.status, json: await response.json() as { data?: Record<string, unknown> }, sent };
}

async function consume(messages: readonly CleanupMessage[]): Promise<void> {
  const worker = { ...env, ENRICHMENT_QUEUE: { sendBatch: vi.fn().mockResolvedValue(undefined) } } as unknown as Env;
  const batch = { messages: messages.map(body => ({ body, ack: vi.fn(), retry: vi.fn() })) } as unknown as MessageBatch<CleanupMessage>;
  await handleCleanupBatch(batch, worker);
}

async function row(id: string) {
  return env.DB.prepare(
    'SELECT brew_description_original, description_hash, brew_description_cleaned, queued_for_cleanup_at FROM enriched_beers WHERE id = ?'
  ).bind(id).first<{ brew_description_original: string; description_hash: string | null; brew_description_cleaned: string | null; queued_for_cleanup_at: number | null }>();
}

const ids = (messages: readonly CleanupMessage[]) => messages.map(message => message.beerId).sort();

const sendFails: SendBehaviour = async () => { throw new Error('queue unavailable'); };

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  await env.DB.prepare('DELETE FROM enriched_beers').run();
  await env.DB.prepare('DROP TRIGGER IF EXISTS abort_mark').run();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('prepare: the description changed after the trigger read it', () => {
  it.each([
    ['missing', { mode: 'missing' }, {}],
    ['all', { mode: 'all', confirm: true }, { cleanupVersion: null }],
  ])("mode '%s' sends nothing for the changed row and keeps the newer hash", async (_mode, body, seedExtra) => {
    await seed({ id: 'changed', ...seedExtra }, { id: 'steady', ...seedExtra });
    const hashB = await hashDescription(TEXT_B);
    const db = hookedDb({
      afterSelect: async () => {
        await env.DB.prepare('UPDATE enriched_beers SET brew_description_original = ?, description_hash = ? WHERE id = ?')
          .bind(TEXT_B, hashB, 'changed').run();
      },
    });

    const { json, sent } = await trigger({ body, db });

    expect(ids(sent)).toEqual(['steady']);
    expect(json.data).toMatchObject({ beers_queued: 1 });
    expect(await row('changed')).toMatchObject({ brew_description_original: TEXT_B, description_hash: hashB });
  });
});

describe('send failures', () => {
  it('leaves a prepared but unsent row unmarked, and the next run sends it', async () => {
    await seed({ id: 'legacy', hash: null });

    const failed = await trigger({ send: sendFails });

    expect(failed.json.data).toMatchObject({ beers_queued: 0 });
    expect(await row('legacy')).toMatchObject({ description_hash: await hashDescription(TEXT_A), queued_for_cleanup_at: null });

    const retried = await trigger();
    expect(ids(retried.sent)).toEqual(['legacy']);
  });

  it('marks only the chunk that was sent when another chunk fails', async () => {
    const all = manyIds(150);
    await seed(...all.map(id => ({ id })));

    const partial = await trigger({ send: async (call) => { if (call === 1) throw new Error('queue unavailable'); } });

    expect(partial.json.data).toMatchObject({ beers_queued: 100 });
    const unmarked = await env.DB.prepare('SELECT COUNT(*) AS n FROM enriched_beers WHERE queued_for_cleanup_at IS NULL').first('n');
    expect(unmarked).toBe(50);

    const retried = await trigger();
    expect(retried.sent).toHaveLength(50);
    expect(ids(retried.sent)).toEqual(all.filter(id => !ids(partial.sent).includes(id)));
  });
});

describe('mark failures', () => {
  it('leaves a sent row findable when the mark batch rolls back, and needs no retry once consumed', async () => {
    await seed({ id: 'beer' });
    const db = hookedDb({ onMarkBatch: () => { throw new Error('D1 unavailable'); } });

    const first = await trigger({ db });

    expect(first.status).toBe(503);
    expect(await row('beer')).toMatchObject({ queued_for_cleanup_at: null });

    const resend = await trigger();
    expect(ids(resend.sent)).toEqual(['beer']);

    await consume(first.sent);
    expect(await row('beer')).toMatchObject({ brew_description_cleaned: 'A crisp lager' });
    expect((await trigger()).sent).toEqual([]);
  });

  it('rolls back a whole mark batch that fails part-way, keeping earlier batches marked', async () => {
    await seed(...manyIds(150).map(id => ({ id })));
    await env.DB.prepare(
      "CREATE TRIGGER abort_mark BEFORE UPDATE OF queued_for_cleanup_at ON enriched_beers WHEN NEW.id = 'b120' BEGIN SELECT RAISE(ABORT, 'test abort'); END"
    ).run();

    const first = await trigger();
    await env.DB.prepare('DROP TRIGGER abort_mark').run();

    expect(first.status).toBe(503);
    expect(first.sent).toHaveLength(150);
    const marked = await env.DB.prepare('SELECT id FROM enriched_beers WHERE queued_for_cleanup_at IS NOT NULL ORDER BY id').all<{ id: string }>();
    expect(marked.results.map(row => row.id)).toEqual(manyIds(100));
    expect(ids((await trigger()).sent)).toEqual(manyIds(150).slice(100));
  });

  it("leaves an outdated cleaned row for the next mode 'all' run when its send fails", async () => {
    await seed({ id: 'old', cleanupVersion: null });
    const body = { mode: 'all', confirm: true };

    await trigger({ body, send: sendFails });

    expect(await row('old')).toMatchObject({ brew_description_cleaned: 'Old served text' });
    expect(ids((await trigger({ body })).sent)).toEqual(['old']);
  });
});

describe('consumer and mark ordering', () => {
  it('accepts a consumer that runs before the mark, and the row needs no retry', async () => {
    await seed({ id: 'legacy', hash: 'wrong-hash' });

    const { json } = await trigger({ send: async (_call, messages) => { await consume(messages.map(message => message.body)); } });

    expect(json.data).toMatchObject({ beers_queued: 1 });
    expect(await row('legacy')).toMatchObject({ brew_description_cleaned: 'A crisp lager', description_hash: await hashDescription(TEXT_A) });
    expect((await trigger()).sent).toEqual([]);
  });

  it('marks a sent, unconsumed row so the next run skips it', async () => {
    await seed({ id: 'beer' });

    const first = await trigger();

    expect(ids(first.sent)).toEqual(['beer']);
    expect((await row('beer'))?.queued_for_cleanup_at).not.toBeNull();
    expect((await trigger()).sent).toEqual([]);
  });
  it('does not mark a row whose description changed while its message was being sent', async () => {
    await seed({ id: 'beer' });
    const hashB = await hashDescription(TEXT_B);

    await trigger({
      send: async () => {
        await env.DB.prepare('UPDATE enriched_beers SET brew_description_original = ?, description_hash = ? WHERE id = ?')
          .bind(TEXT_B, hashB, 'beer').run();
      },
    });

    expect(await row('beer')).toMatchObject({ queued_for_cleanup_at: null });
    const next = await trigger();
    expect(next.sent).toEqual([expect.objectContaining({ beerId: 'beer', brewDescription: TEXT_B, descriptionHash: hashB })]);
  });

  it('does not mark a row the consumer cleaned first, so a later description change is found', async () => {
    await seed({ id: 'beer' });

    await trigger({ send: async (_call, messages) => { await consume(messages.map(message => message.body)); } });
    await insertPlaceholders(env.DB, [{ id: 'beer', brew_name: 'Valley Lager', brewer: 'Valley Brewing', brew_description: TEXT_B }], 'request-2');

    expect(ids((await trigger()).sent)).toEqual(['beer']);
  });
});
