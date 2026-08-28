import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

const isGoldenContract = process.env.GOLDEN_CONTRACT === '1';
const migrations = isGoldenContract
	? await readD1Migrations('./contract-test/migrations')
	: undefined;
// Real migration chain for integration tests that need a fresh D1 built from
// migrations/ (the golden run keeps its own fixture schema binding).
const realMigrations = isGoldenContract
	? undefined
	: await readD1Migrations('./migrations');

export default defineWorkersConfig({
	test: {
		testTimeout: 30000,
		clearMocks: true,
		...(isGoldenContract
			? { include: ['contract-test/**/*.contract.test.ts'] }
			: { exclude: [...configDefaults.exclude, 'contract-test/**'] }),
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				...(isGoldenContract && migrations
					? { miniflare: { bindings: { TEST_MIGRATIONS: migrations } } }
					: {}),
				...(!isGoldenContract && realMigrations
					? { miniflare: { bindings: { REAL_MIGRATIONS: realMigrations } } }
					: {}),
			},
		},
	},
});
