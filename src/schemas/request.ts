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

// ============================================================================
// Usage Telemetry (POST /usage)
// ============================================================================
//
// Two layers, like SyncBeersRequestOuterSchema + SyncBeerItemSchema: a strict
// envelope that is the only source of a 400, and lenient event items that are
// dropped on failure. Unlike the other request schemas, neither layer is
// .strict(): the app may ship new fields or events before this worker knows
// them, and those must be ignored rather than rejected.

export const USAGE_EVENTS = [
  'session_started',
  'view_home',
  'view_all_beers',
  'view_beerfinder',
  'view_tasted',
  'view_rewards',
  'view_queue',
  'view_pending_operations',
  'view_missed_credit',
  'checkin_queued',
  'checkin_from_suggestion',
  'queue_entry_deleted',
  'operation_retried',
  'reward_queued',
  'rewards_refreshed_manual',
  'beer_rated',
  'missed_credit_resolved',
  'untappd_opened',
  'suggestions_opened',
  'apple_intelligence_used',
  'local_matching_used',
  'fallback_deadline_expired',
  'fallback_provider_failure',
  'fallback_invalid_output',
  'fallback_context_budget',
] as const;

export const USAGE_AI_STATUSES = [
  'apple_intelligence',
  'requires_newer_os',
  'device_not_eligible',
  'not_enabled',
  'model_not_ready',
  'unsupported_locale',
  'unavailable',
] as const;

/** Per event per post, after repeated names are summed. */
export const USAGE_MAX_COUNT_PER_EVENT = 500;

/** Every known event plus room for a few the worker does not know yet. */
export const USAGE_MAX_EVENT_ITEMS = 40;

export const USAGE_MIN_OS_MAJOR = 13;
export const USAGE_MAX_OS_MAJOR = 99;

const USAGE_APP_VERSION_PATTERN = /^\d{1,2}\.\d{1,3}\.\d{1,3}$/;

const knownAiStatuses: ReadonlySet<string> = new Set(USAGE_AI_STATUSES);

const isKnownAiStatus = (value: string): value is UsageAiStatus => knownAiStatuses.has(value);

export const UsageReportEnvelopeSchema = z.object({
  install_id: z.uuid().transform((id) => id.toLowerCase()),
  batch_id: z.uuid().transform((id) => id.toLowerCase()),
  app_version: z.string().regex(USAGE_APP_VERSION_PATTERN),
  ai_status: z.string().transform((status): UsageAiStatus | 'other' =>
    isKnownAiStatus(status) ? status : 'other'),
  os_major: z.number().int().min(USAGE_MIN_OS_MAJOR).max(USAGE_MAX_OS_MAJOR),
  events: z.array(z.unknown()).max(USAGE_MAX_EVENT_ITEMS),
});

/**
 * Branded so the write helper only accepts counts that came through this
 * schema: a plain number (fractional, zero, negative) does not type-check.
 */
export const UsageCountSchema = z.number().int().min(1).max(USAGE_MAX_COUNT_PER_EVENT).brand<'UsageCount'>();

export const UsageEventItemSchema = z.object({
  name: z.enum(USAGE_EVENTS),
  count: UsageCountSchema,
});

export type UsageEvent = (typeof USAGE_EVENTS)[number];
export type UsageAiStatus = (typeof USAGE_AI_STATUSES)[number];
export type UsageCount = z.infer<typeof UsageCountSchema>;
export type UsageEventCount = Readonly<z.infer<typeof UsageEventItemSchema>>;

export type UsageReport = Readonly<{
  installId: string;
  batchId: string;
  appVersion: string;
  aiStatus: UsageAiStatus | 'other';
  osMajor: number;
  events: readonly UsageEventCount[];
}>;

export type UsageReportParseResult =
  | Readonly<{ success: true; report: UsageReport; droppedCount: number }>
  | Readonly<{ success: false; error: z.ZodError }>;

const sumRepeatedEvents = (items: readonly UsageEventCount[]): readonly UsageEventCount[] =>
  [...new Set(items.map((item) => item.name))].map((name) => ({
    name,
    count: UsageCountSchema.parse(Math.min(
      items.filter((item) => item.name === name).reduce((total, item) => total + item.count, 0),
      USAGE_MAX_COUNT_PER_EVENT,
    )),
  }));

export function parseUsageReport(input: unknown): UsageReportParseResult {
  const envelope = UsageReportEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { success: false, error: envelope.error };
  }

  const validItems = envelope.data.events.flatMap((item) => {
    const parsed = UsageEventItemSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });

  return {
    success: true,
    report: {
      installId: envelope.data.install_id,
      batchId: envelope.data.batch_id,
      appVersion: envelope.data.app_version,
      aiStatus: envelope.data.ai_status,
      osMajor: envelope.data.os_major,
      events: sumRepeatedEvents(validItems),
    },
    droppedCount: envelope.data.events.length - validItems.length,
  };
}
