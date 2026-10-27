import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

async function findTable(name: string) {
  await applyD1Migrations(env.DB, env.REAL_MIGRATIONS);
  return env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .bind(name).first();
}

describe('D1 schema after the migration chain', () => {
  it('has no cleanup_limits table now that cleanup has no quota', async () => {
    expect(await findTable('cleanup_limits')).toBeNull();
  });

  it('keeps the enrichment quota table', async () => {
    expect(await findTable('enrichment_limits')).toEqual({ name: 'enrichment_limits' });
  });
});
