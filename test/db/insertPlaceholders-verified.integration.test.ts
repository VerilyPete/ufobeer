/**
 * Taplist sightings of a hand-verified row, against real D1: the sighting
 * still updates the description, but abv, confidence, enrichment_source and
 * enrichment_status change only through a human.
 */
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { insertPlaceholders } from '../../src/db/helpers';
import { hashDescription } from '../../src/utils/hash';

type Seed = {
  readonly brewName: string;
  readonly isVerified: number | null;
  readonly abv: number | null;
  readonly status: string;
  readonly description: string;
};

async function seed(row: Seed): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO enriched_beers (id, brew_name, brewer, abv, confidence, enrichment_source, enrichment_status, is_verified,
       brew_description_original, description_hash, brew_description_cleaned, description_cleaned_at)
     VALUES ('beer-1', ?, 'Valley Brewing', ?, 1, 'manual', ?, ?, ?, ?, ?, 1)`
  ).bind(row.brewName, row.abv, row.status, row.isVerified, row.description, await hashDescription(row.description), row.description).run();
}

async function stored() {
  return env.DB.prepare(
    `SELECT abv, confidence, enrichment_source, enrichment_status, brew_description_original, brew_description_cleaned
     FROM enriched_beers WHERE id = 'beer-1'`
  ).first();
}

const see = (beer: { readonly brew_name: string; readonly brew_description: string }) =>
  insertPlaceholders(env.DB, [{ id: 'beer-1', brewer: 'Valley Brewing', ...beer }], 'request-1');

describe('taplist sighting of a hand-verified row (real D1)', () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
    await env.DB.prepare('DELETE FROM enriched_beers').run();
  });

  it('applies a description change but keeps the protected fields', async () => {
    await seed({ brewName: 'Valley Lager', isVerified: 1, abv: 5.1, status: 'enriched', description: 'Old text' });

    await see({ brew_name: 'Valley Lager', brew_description: 'New text' });

    expect(await stored()).toEqual({
      abv: 5.1, confidence: 1, enrichment_source: 'manual', enrichment_status: 'enriched',
      brew_description_original: 'New text', brew_description_cleaned: null,
    });
  });

  it('still resets an unverified row to pending on a description change', async () => {
    await seed({ brewName: 'Valley Lager', isVerified: null, abv: 5.1, status: 'not_found', description: 'Old text' });

    await see({ brew_name: 'Valley Lager', brew_description: 'New text' });

    expect(await stored()).toMatchObject({ enrichment_status: 'pending', brew_description_original: 'New text' });
  });

  it('does not mark a verified pending row skipped when its name is blocklisted', async () => {
    await seed({ brewName: 'Texas Flight', isVerified: 1, abv: null, status: 'pending', description: 'Four tasters' });

    await see({ brew_name: 'Texas Flight', brew_description: 'Four tasters' });

    expect(await stored()).toMatchObject({ enrichment_status: 'pending' });
  });

  it('still marks an unverified blocklisted pending row skipped', async () => {
    await seed({ brewName: 'Texas Flight', isVerified: 0, abv: null, status: 'pending', description: 'Four tasters' });

    await see({ brew_name: 'Texas Flight', brew_description: 'Four tasters' });

    expect(await stored()).toMatchObject({ enrichment_status: 'skipped' });
  });
});
