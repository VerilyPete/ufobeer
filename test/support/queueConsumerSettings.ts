/** One queue consumer's retry settings, as wrangler.jsonc declares them */
export type QueueConsumerSettings = {
	readonly queue: string;
	readonly max_retries: number | undefined;
	readonly dead_letter_queue: string | undefined;
};
