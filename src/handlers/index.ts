/**
 * Handlers Module Re-exports
 *
 * Provides a clean interface for importing handler functions.
 * All HTTP endpoint handlers are exported from this module.
 */

// Enrichment handlers
export { handleEnrichmentTrigger } from './enrichment';

// DLQ handlers
export {
  handleDlqList,
  handleDlqStats,
  handleDlqReplay,
  handleDlqAcknowledge,
  cleanupOldDlqMessages,
} from './dlq';

// Beer handlers
export { handleBeerList, handleBatchLookup } from './beers';

// Health handler
export { handleHealthCheck } from './health';

// Scheduled handler
export { handleScheduledEnrichment } from './scheduled';
