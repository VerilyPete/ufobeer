import { fileURLToPath } from 'node:url';
import { unstable_readConfig } from 'wrangler';
import type { QueueConsumerSettings } from './queueConsumerSettings.ts';

const wranglerConfigPath = fileURLToPath(new URL('../../wrangler.jsonc', import.meta.url));

/**
 * The retry and dead-letter settings of every queue consumer, read from
 * wrangler.jsonc by wrangler itself. Runs on the Node side of Vitest and
 * reaches tests through `provide`, so the same test runs in both runners.
 */
export function readQueueConsumers(): QueueConsumerSettings[] {
	const config = unstable_readConfig({ config: wranglerConfigPath }, { hideWarnings: true });
	return (config.queues.consumers ?? []).map(({ queue, max_retries, dead_letter_queue }) => ({
		queue,
		max_retries,
		dead_letter_queue,
	}));
}
