/**
 * Queue handlers for Cloudflare Queues.
 *
 * This module re-exports all queue consumer handlers:
 * - handleEnrichmentBatch: Processes beer enrichment requests (Perplexity)
 * - handleCleanupBatch: Processes description cleanup requests (Workers AI)
 * - handleDlqBatch: Stores failed messages for admin inspection
 *
 * And helper functions:
 * - queueBeersForEnrichment: Queue beers for Perplexity lookup
 * - queueBeersForCleanup: Queue beers for LLM description cleanup
 *
 * @module queue
 */

export { handleEnrichmentBatch } from './enrichment';
export { handleCleanupBatch } from './cleanup';
export { handleDlqBatch, handleCleanupDlqBatch } from './dlq';
export { queueBeersForEnrichment, queueBeersForCleanup } from './helpers';
