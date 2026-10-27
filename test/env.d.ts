import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/types';

declare global {
	namespace Cloudflare {
		interface Env extends WorkerEnv {
			/** Full ./migrations chain, available in the non-golden workers-pool run */
			REAL_MIGRATIONS: D1Migration[];
		}
	}
}
