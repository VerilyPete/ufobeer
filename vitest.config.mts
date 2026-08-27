import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import { configDefaults } from 'vitest/config';

const isGoldenContract = process.env.GOLDEN_CONTRACT === '1';
const migrations = isGoldenContract
	? await readD1Migrations('./contract-test/migrations')
	: undefined;

export default defineWorkersConfig({
	test: {
		testTimeout: 30000,
		clearMocks: true,
		include: isGoldenContract
			? ['contract-test/**/*.contract.test.ts']
			: undefined,
		exclude: isGoldenContract
			? undefined
			: [...configDefaults.exclude, 'contract-test/**'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				...(isGoldenContract && migrations
					? { miniflare: { bindings: { TEST_MIGRATIONS: migrations } } }
					: {}),
			},
		},
	},
});
