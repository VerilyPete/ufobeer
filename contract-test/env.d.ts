import type { D1Migration } from 'cloudflare:test';
import type { Env as WorkerEnv } from '../src/types';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends WorkerEnv {
    TEST_MIGRATIONS: D1Migration[];
  }
}
