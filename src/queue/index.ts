/**
 * Queue handlers for Cloudflare Queues.
 *
 * This module re-exports all queue consumer handlers:
 * - handleEnrichmentBatch: Processes beer enrichment requests
 * - handleDlqBatch: Stores failed messages for admin inspection
 *
 * @module queue
 */

export { handleEnrichmentBatch } from './enrichment';
export { handleDlqBatch } from './dlq';
export { queueBeersForEnrichment } from './helpers';
