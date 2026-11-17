/**
 * getEnrichmentForBeerIds against real D1: a long ID list is split into
 * statements of at most D1_MAX_PARAMS_PER_STATEMENT bound parameters, sent in
 * one batch, and only beers that exist come back.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { getEnrichmentForBeerIds } from '../../src/db/helpers';
import type { BeerEnrichmentData } from '../../src/db/helpers';

type SeededBeer = {
  readonly id: string;
  readonly abv: number;
  readonly confidence: number;
  readonly source: string;
  readonly cleaned: string;
};

const seededBeer = (index: number): SeededBeer => ({
  id: `lookup-beer-${index}`,
  abv: 3.25 + index * 0.05,
  confidence: 0.35 + (index % 7) * 0.05,
  source: index % 2 === 0 ? 'perplexity' : 'description',
  cleaned: `Cleaned description number ${index}`,
});

const REQUESTED = Array.from({ length: 181 }, (_, index) => seededBeer(index));
const NOT_REQUESTED = seededBeer(500);
const UNKNOWN_IDS = ['lookup-unknown-a', 'lookup-unknown-b'];

const seed = async (beers: readonly SeededBeer[]): Promise<void> => {
  await env.DB.batch(beers.map((beer) => env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, abv, confidence, enrichment_source, brew_description_cleaned)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(beer.id, `Brew ${beer.id}`, beer.abv, beer.confidence, beer.source, beer.cleaned)));
};

const recordingBatchParams = (db: D1Database) => {
  const paramCounts = new WeakMap<D1PreparedStatement, number>();
  const batches: number[][] = [];
  const counting = (prepared: D1PreparedStatement): D1PreparedStatement => new Proxy(prepared, {
    get(statement, prop) {
      if (prop === 'bind') {
        return (...values: unknown[]) => {
          const bound = statement.bind(...values);
          paramCounts.set(bound, values.length);
          return bound;
        };
      }
      const value: unknown = Reflect.get(statement, prop, statement);
      return typeof value === 'function' ? value.bind(statement) : value;
    },
  });
  const recording = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (query: string) => counting(target.prepare(query));
      }
      if (prop === 'batch') {
        return (statements: D1PreparedStatement[]) => {
          batches.push(statements.map((statement) => paramCounts.get(statement) ?? 0));
          return target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: recording, batches };
};

const expectedEnrichment = (beer: SeededBeer): BeerEnrichmentData => ({
  abv: beer.abv,
  confidence: beer.confidence,
  source: beer.source,
  brew_description_cleaned: beer.cleaned,
});

describe('getEnrichmentForBeerIds (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
    await seed([...REQUESTED, NOT_REQUESTED]);
  });

  it('sends 183 IDs as one batch of 90, 90 and 3 parameters and returns only the requested beers that exist', async () => {
    const { db, batches } = recordingBatchParams(env.DB);

    const result = await getEnrichmentForBeerIds(
      db,
      [...REQUESTED.map((beer) => beer.id), ...UNKNOWN_IDS],
      'lookup-request-37'
    );

    expect(batches).toEqual([[90, 90, 3]]);
    expect(result).toEqual(new Map(REQUESTED.map((beer) => [beer.id, expectedEnrichment(beer)])));
  });
});
