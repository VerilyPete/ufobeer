import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { configDefaults, defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// BeerSelector's golden /usage request fixtures (contract-test/
// usageReport.contract.test.ts). USAGE_CONTRACT_FIXTURES_DIR overrides the
// sibling checkout, e.g. to try fixtures before they land in BeerSelector.
const usageContractFixtures = process.env.USAGE_CONTRACT_FIXTURES_DIR
	?? fileURLToPath(new URL('../BeerSelector/native-ios/Tests/Fixtures', import.meta.url));

const isGoldenContract = process.env.GOLDEN_CONTRACT === '1';
const migrations = isGoldenContract
	? await readD1Migrations('./contract-test/migrations')
	: undefined;
// Real migration chain for integration tests that need a fresh D1 built from
// migrations/ (the golden run keeps its own fixture schema binding).
const realMigrations = isGoldenContract
	? undefined
	: await readD1Migrations('./migrations');

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			// Tests mock AI and never touch Cloudflare: no remote proxy session,
			// which would also need an API token CI does not have.
			remoteBindings: false,
			...(isGoldenContract && migrations
				? { miniflare: { bindings: { TEST_MIGRATIONS: migrations } } }
				: {}),
			...(!isGoldenContract && realMigrations
				? { miniflare: { bindings: { REAL_MIGRATIONS: realMigrations } } }
				: {}),
		}),
	],
	resolve: {
		alias: { '@usage-contract-fixtures': usageContractFixtures },
	},
	test: {
		testTimeout: 30000,
		clearMocks: true,
		...(isGoldenContract
			? { include: ['contract-test/**/*.contract.test.ts'] }
			: { exclude: [...configDefaults.exclude, 'contract-test/**'] }),
	},
});
