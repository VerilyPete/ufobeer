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
export const EnrichmentMessageSchema = z.object({
  beerId: z.string(),
  beerName: z.string(),
  brewer: z.string(),
});

export type TriggerCleanupRequest = z.infer<typeof TriggerCleanupRequestSchema>;
export type EnrichmentMessage = z.infer<typeof EnrichmentMessageSchema>;
