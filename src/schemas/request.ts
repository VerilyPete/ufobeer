import { z } from 'zod';

export const BatchLookupRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

export const SyncBeerItemSchema = z.object({
  id: z.string().min(1).max(50),
  brew_name: z.string().min(1).max(200),
  brewer: z.string().optional(),
  brew_description: z.string().max(2000).optional(),
});

export const SyncBeersRequestSchema = z.object({
  beers: z.array(SyncBeerItemSchema),
});

export const SyncBeersRequestOuterSchema = z.object({
  beers: z.array(z.unknown()),
});

export const DlqReplayRequestSchema = z.object({
  ids: z.array(z.number().int()).min(1),
  delay_seconds: z.number().int().min(0).optional().default(0),
});

export const DlqAcknowledgeRequestSchema = z.object({
  ids: z.array(z.number().int()).min(1),
});

export const TriggerEnrichmentRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  exclude_failures: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(false),
});

export const CriteriaSchema = z.object({
  confidence_below: z.number({
    errorMap: () => ({ message: 'INVALID_CONFIDENCE: confidence_below must be a number' }),
  }).min(0, { message: 'INVALID_CONFIDENCE: confidence_below must be 0.0-1.0' })
    .max(1, { message: 'INVALID_CONFIDENCE: confidence_below must be 0.0-1.0' })
    .optional(),
  enrichment_older_than_days: z.number({
    errorMap: () => ({ message: 'INVALID_DAYS: enrichment_older_than_days must be a number' }),
  }).int({ message: 'INVALID_DAYS: enrichment_older_than_days must be a positive integer' })
    .min(1, { message: 'INVALID_DAYS: enrichment_older_than_days must be a positive integer' })
    .optional(),
  enrichment_source: z.enum(['perplexity', 'manual'], {
    errorMap: () => ({ message: "INVALID_SOURCE: enrichment_source must be 'perplexity' or 'manual'" }),
  }).optional(),
}, {
  errorMap: () => ({ message: 'INVALID_CRITERIA: criteria must be an object' }),
}).refine(obj => Object.keys(obj).length > 0, {
  message: 'INVALID_CRITERIA_EMPTY: criteria cannot be empty',
});

export const ForceEnrichmentRequestSchema = z.object({
  beer_ids: z.array(
    z.string({
      errorMap: () => ({ message: 'INVALID_BEER_IDS_FORMAT: all beer_ids must be non-empty strings' }),
    }).min(1, { message: 'INVALID_BEER_IDS_FORMAT: all beer_ids must be non-empty strings' }),
    { errorMap: () => ({ message: 'INVALID_BEER_IDS: beer_ids must be an array' }) },
  ).min(1, { message: 'INVALID_BEER_IDS_EMPTY: beer_ids cannot be empty' })
    .max(100, { message: 'INVALID_BEER_IDS_TOO_MANY: beer_ids max 100 items' })
    .optional(),
  criteria: CriteriaSchema.optional(),
  limit: z.number({
    errorMap: () => ({ message: 'INVALID_LIMIT: limit must be a number' }),
  }).int({ message: 'INVALID_LIMIT: limit must be 1-100' })
    .min(1, { message: 'INVALID_LIMIT: limit must be 1-100' })
    .max(100, { message: 'INVALID_LIMIT: limit must be 1-100' })
    .optional(),
  dry_run: z.boolean({
    errorMap: () => ({ message: 'INVALID_DRY_RUN: dry_run must be boolean' }),
  }).optional().default(false),
  admin_id: z.string({
    errorMap: () => ({ message: 'INVALID_ADMIN_ID: admin_id must be a non-empty string' }),
  }).min(1, { message: 'INVALID_ADMIN_ID: admin_id must be non-empty string' })
    .optional(),
}).refine(
  data => (data.beer_ids !== undefined) !== (data.criteria !== undefined),
  data => ({
    message: data.beer_ids !== undefined && data.criteria !== undefined
      ? 'INVALID_REQUEST_BOTH_SPECIFIED: cannot specify both beer_ids and criteria'
      : 'INVALID_REQUEST_NEITHER_SPECIFIED: must specify either beer_ids or criteria',
  }),
);

export const TriggerCleanupRequestSchema = z.object({
  mode: z.enum(['all', 'missing'], {
    errorMap: () => ({ message: 'INVALID_MODE: mode is required and must be "all" or "missing"' }),
  }),
  limit: z.number({
    errorMap: () => ({ message: 'INVALID_LIMIT: limit must be a number' }),
  }).int({ message: 'INVALID_LIMIT: limit must be a positive integer' })
    .min(1, { message: 'INVALID_LIMIT: limit must be a positive integer' })
    .optional(),
  dry_run: z.boolean({
    errorMap: () => ({ message: 'INVALID_DRY_RUN: dry_run must be a boolean' }),
  }).optional().default(false),
  confirm: z.boolean({
    errorMap: () => ({ message: 'INVALID_CONFIRM: confirm must be a boolean' }),
  }).optional(),
});

export type BatchLookupRequest = z.infer<typeof BatchLookupRequestSchema>;
export type SyncBeerItem = z.infer<typeof SyncBeerItemSchema>;
export type SyncBeersRequest = z.infer<typeof SyncBeersRequestSchema>;
export type DlqReplayRequest = z.infer<typeof DlqReplayRequestSchema>;
export type DlqAcknowledgeRequest = z.infer<typeof DlqAcknowledgeRequestSchema>;
export type TriggerEnrichmentRequest = z.infer<typeof TriggerEnrichmentRequestSchema>;
export type EnrichmentCriteria = z.infer<typeof CriteriaSchema>;
export type ForceEnrichmentRequest = z.infer<typeof ForceEnrichmentRequestSchema>;
export const EnrichmentMessageSchema = z.object({
  beerId: z.string(),
  beerName: z.string(),
  brewer: z.string(),
});

export type TriggerCleanupRequest = z.infer<typeof TriggerCleanupRequestSchema>;
export type EnrichmentMessage = z.infer<typeof EnrichmentMessageSchema>;
