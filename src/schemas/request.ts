import { z } from 'zod';
import { SYNC_CONSTANTS } from '../types';

// ============================================================================
// Batch Lookup (POST /beers/batch)
// ============================================================================

/** Max IDs accepted per batch request. Matches the handler's existing 100-ID
 * processing cap -- now enforced by rejecting excess input instead of
 * silently truncating it, consistent with every other body-bearing route. */
export const BATCH_MAX_IDS = 100;

/** Max length of a single batch-lookup ID. Reuses the same bound as beer
 * `id` elsewhere (SYNC_CONSTANTS.MAX_ID_LENGTH) since these are the same
 * kind of value (a Flying Saucer beer ID). */
export const BATCH_ID_MAX_LENGTH = SYNC_CONSTANTS.MAX_ID_LENGTH;

export const BatchLookupRequestSchema = z.object({
  ids: z.array(z.string().min(1).max(BATCH_ID_MAX_LENGTH)).min(1).max(BATCH_MAX_IDS),
}).strict();

// ============================================================================
// Beer Sync (POST /beers/sync)
// ============================================================================

export const SyncBeerItemSchema = z.object({
  id: z.string().min(1).max(SYNC_CONSTANTS.MAX_ID_LENGTH),
  brew_name: z.string().min(1).max(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH),
  // Bounded to the same length as brew_name: both are short display fields
  // sourced from the same taplist record.
  brewer: z.string().max(SYNC_CONSTANTS.MAX_BREW_NAME_LENGTH).optional(),
  brew_description: z.string().max(SYNC_CONSTANTS.MAX_DESC_LENGTH).optional(),
}).strict();

export const SyncBeersRequestSchema = z.object({
  beers: z.array(SyncBeerItemSchema),
}).strict();

/**
 * Outer envelope for POST /beers/sync. Caps `beers` at the same
 * SYNC_CONSTANTS.MAX_BATCH_SIZE (50) the handler previously enforced with a
 * post-parse `.slice()` -- now a 400 at the schema boundary instead of a
 * silent truncation after the full array was materialized and parsed.
 * Item shape is intentionally left as z.unknown() here: handleBeerSync
 * validates each item individually via SyncBeerItemSchema so it can report
 * per-item errors and preserve partial success.
 */
export const SyncBeersRequestOuterSchema = z.object({
  beers: z.array(z.unknown()).max(SYNC_CONSTANTS.MAX_BATCH_SIZE),
}).strict();

// ============================================================================
// DLQ Replay / Acknowledge (POST /admin/dlq/replay, /admin/dlq/acknowledge)
// ============================================================================

/** Matches the handler's previous `ids.slice(0, 50)` cap for replay. */
export const DLQ_REPLAY_MAX_IDS = 50;

/** Matches the handler's previous `ids.slice(0, 100)` cap for acknowledge. */
export const DLQ_ACKNOWLEDGE_MAX_IDS = 100;

/**
 * Cloudflare Queues' maximum message delay is 12 hours (43,200 seconds).
 * https://developers.cloudflare.com/queues/platform/limits/
 */
export const MAX_DELAY_SECONDS = 12 * 60 * 60;

export const DlqReplayRequestSchema = z.object({
  ids: z.array(z.number().int()).min(1).max(DLQ_REPLAY_MAX_IDS),
  delay_seconds: z.number().int().min(0).max(MAX_DELAY_SECONDS).optional().default(0),
}).strict();

export const DlqAcknowledgeRequestSchema = z.object({
  ids: z.array(z.number().int()).min(1).max(DLQ_ACKNOWLEDGE_MAX_IDS),
}).strict();

// ============================================================================
// Admin Triggers (POST /admin/enrich/trigger, /admin/cleanup/trigger)
// ============================================================================

export const TriggerEnrichmentRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  exclude_failures: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(false),
}).strict();

export const TriggerCleanupRequestSchema = z.object({
  mode: z.enum(['all', 'missing'], {
    error: 'INVALID_MODE: mode is required and must be "all" or "missing"',
  }),
  limit: z.number({
    error: 'INVALID_LIMIT: limit must be a number',
  }).int({ error: 'INVALID_LIMIT: limit must be a positive integer' })
    .min(1, { error: 'INVALID_LIMIT: limit must be a positive integer' })
    .optional(),
  dry_run: z.boolean({
    error: 'INVALID_DRY_RUN: dry_run must be a boolean',
  }).optional().default(false),
  confirm: z.boolean({
    error: 'INVALID_CONFIRM: confirm must be a boolean',
  }).optional(),
}).strict();

export type BatchLookupRequest = z.infer<typeof BatchLookupRequestSchema>;
export type SyncBeerItem = z.infer<typeof SyncBeerItemSchema>;
export type SyncBeersRequest = z.infer<typeof SyncBeersRequestSchema>;
export type DlqReplayRequest = z.infer<typeof DlqReplayRequestSchema>;
export type DlqAcknowledgeRequest = z.infer<typeof DlqAcknowledgeRequestSchema>;
export type TriggerEnrichmentRequest = z.infer<typeof TriggerEnrichmentRequestSchema>;

// ============================================================================
// Internal Queue Message Shapes (DLQ storage/replay validation)
// ============================================================================
//
// These validate the `raw_message` column of dlq_messages -- JSON our own
// producers wrote, not a client-authored HTTP body -- so they are
// intentionally NOT .strict(): tolerating unknown/forward-compatible fields
// here is correct, not a security boundary weakening. (Contrast with the
// request schemas above, which reject unknown properties because they
// validate untrusted client input.)

export const EnrichmentMessageSchema = z.object({
  beerId: z.string(),
  beerName: z.string(),
  brewer: z.string(),
  /**
   * `.nullable().optional()`: EnrichmentMessage.descriptionHash in ../types
   * is a required-but-nullable field (null is a legitimate "no description"
   * value, unlike CleanupMessageSchema below), but this schema still
   * accepts a genuinely missing key so a DLQ row written before this field
   * existed still parses -- the replay call site normalizes that with
   * `?? null`. Preserving the value here (rather than stripping it) lets a
   * DLQ replay forward the same hash the original message carried instead
   * of silently downgrading a hash-bound message into a hash-less one.
   */
  descriptionHash: z.string().nullable().optional(),
});

export const CleanupMessageSchema = z.object({
  beerId: z.string(),
  beerName: z.string(),
  brewer: z.string(),
  brewDescription: z.string(),
  /**
   * Optional so that a DLQ row written before this field existed still
   * parses; matches CleanupMessage.descriptionHash in ../types. Preserving
   * it here (rather than stripping it) lets a DLQ replay forward the same
   * hash the original message carried instead of silently downgrading a
   * hash-bound message into a hash-less (always-treated-as-stale) one.
   */
  descriptionHash: z.string().optional(),
});

export type TriggerCleanupRequest = z.infer<typeof TriggerCleanupRequestSchema>;
export type EnrichmentMessage = z.infer<typeof EnrichmentMessageSchema>;
export type CleanupMessageBody = z.infer<typeof CleanupMessageSchema>;
