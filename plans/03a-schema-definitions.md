# Phase 3a: Schema Definitions

## Goal

Add Zod as a dependency and create all request/response schemas. This phase
creates the schema files; Phase 3b integrates them into handlers.

## Problem Inventory

### Unsafe `as` casts on `request.json()` (trust boundary violations)

| Location | Cast | Handler |
|----------|------|---------|
| `src/handlers/beers.ts:225` | `request.json() as { ids?: string[] }` | `handleBatchLookup` |
| `src/handlers/beers.ts:406` | `request.json() as SyncBeersRequest` | `handleBeerSync` |
| `src/handlers/dlq.ts:286` | `request.json() as DlqReplayRequest` | `handleDlqReplay` |
| `src/handlers/dlq.ts:410` | `request.json() as DlqAcknowledgeRequest` | `handleDlqAcknowledge` |
| `src/handlers/enrichment.ts:166` | `request.json().catch(() => ({})) as TriggerEnrichmentRequest` | `handleEnrichmentTrigger` |

### Unsafe `as` casts on external API responses

| Location | Cast | Context |
|----------|------|---------|
| `src/services/perplexity.ts:81` | `response.json() as { choices?: ... }` | Perplexity API response |
| `src/handlers/beers.ts:123` | `fsResp.json() as unknown[]` | Flying Saucer API response (already safe-ish) |

### Unsafe `as` casts inside manual validators

| Location | Cast | Context |
|----------|------|---------|
| `src/handlers/enrichment.ts:44` | `body as ForceEnrichmentRequest` | Inside `validateForceEnrichmentRequest` |
| `src/handlers/beers.ts:320` | `beer as Record<string, unknown>` | Inside `validateBeerInput` |
| `src/handlers/cleanupTrigger.ts:55` | `body as Record<string, unknown>` | Inside `validateCleanupTriggerRequest` |
| `src/handlers/cleanupTrigger.ts:58` | `req.mode as string` | Inside `validateCleanupTriggerRequest` |
| `src/handlers/cleanupTrigger.ts:337` | `body as TriggerCleanupRequest` | After manual validation |

### Type guard casts in `types.ts`

| Location | Cast | Context |
|----------|------|---------|
| `src/types.ts:323-326` | `(beer as FlyingSaucerBeer).id` (x3) | Inside `isValidBeer` |
| `src/types.ts:339` | `(item as { brewInStock?: unknown }).brewInStock` | Inside `hasBeerStock` |

### Manual validators to replace with Zod schemas

| Validator | Location | Lines |
|-----------|----------|-------|
| `validateBeerInput` | `src/handlers/beers.ts:315-343` | 28 lines |
| `validateForceEnrichmentRequest` | `src/handlers/enrichment.ts:34-135` | 101 lines |
| `validateCleanupTriggerRequest` | `src/handlers/cleanupTrigger.ts:45-96` | 51 lines |

Total: ~180 lines of manual validation code to be replaced by schemas.

---

## Zod Dependency

Add Zod as a production dependency:

```
npm install zod
```

Zod is well-suited for Cloudflare Workers: zero dependencies, tree-shakeable,
~13KB minified. It works with both `module` and `nodenext` module resolution.

---

## Step 1: Create `src/schemas/request.ts` - Request body schemas

### 1a. RED: Test BatchLookup schema rejects invalid payloads

Create `test/schemas/request.test.ts`. Write tests that verify:

- Missing `ids` field returns error
- `ids` as non-array returns error
- Empty `ids` array returns error
- `ids` containing non-strings returns error
- Valid `{ ids: ["abc", "def"] }` passes
- Extra fields are stripped (Zod `.strict()` or `.strip()`)

```typescript
// test/schemas/request.test.ts
import { describe, it, expect } from 'vitest';
import { BatchLookupRequestSchema } from '../../src/schemas/request';

describe('BatchLookupRequestSchema', () => {
  it('rejects missing ids', () => {
    const result = BatchLookupRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });
  // ...
});
```

### 1b. GREEN: Create schema file with BatchLookupRequestSchema

```typescript
// src/schemas/request.ts
import { z } from 'zod';

export const BatchLookupRequestSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});
```

### 1c. RED: Test SyncBeersRequest schema

Tests for:
- Missing `beers` field
- `beers` as non-array
- Empty `beers` array (allowed - handler returns early with 200)
- Beer missing `id` or `brew_name`
- Beer with `id` exceeding 50 chars (`SYNC_CONSTANTS.MAX_ID_LENGTH`)
- Beer with `brew_name` exceeding 200 chars
- Beer with `brew_description` exceeding 2000 chars
- Valid beer with only required fields passes
- Valid beer with optional `brewer` and `brew_description` passes

### 1d. GREEN: Add SyncBeersRequestSchema

```typescript
export const SyncBeerItemSchema = z.object({
  id: z.string().min(1).max(50),
  brew_name: z.string().min(1).max(200),
  brewer: z.string().optional(),
  brew_description: z.string().max(2000).optional(),
});

export const SyncBeersRequestSchema = z.object({
  beers: z.array(SyncBeerItemSchema),
});
```

This replaces `validateBeerInput` (`src/handlers/beers.ts:315-343`).

### 1e. RED: Test DlqReplayRequest schema

Tests for:
- Missing `ids` field
- Empty `ids` array
- `ids` with non-numbers
- `delay_seconds` as negative number
- `delay_seconds` as non-integer
- Valid `{ ids: [1, 2], delay_seconds: 30 }` passes
- Valid `{ ids: [1] }` passes (delay_seconds optional)

### 1f. GREEN: Add DlqReplayRequestSchema

```typescript
export const DlqReplayRequestSchema = z.object({
  ids: z.array(z.number().int()).min(1),
  delay_seconds: z.number().int().min(0).optional().default(0),
});
```

### 1g. RED: Test DlqAcknowledgeRequest schema

Tests for:
- Missing `ids`
- Empty `ids` array
- `ids` with non-numbers
- Valid `{ ids: [1, 2, 3] }` passes

### 1h. GREEN: Add DlqAcknowledgeRequestSchema

```typescript
export const DlqAcknowledgeRequestSchema = z.object({
  ids: z.array(z.number().int()).min(1),
});
```

### 1i. RED: Test TriggerEnrichmentRequest schema

Tests for:
- Empty body `{}` is valid (all fields optional with defaults)
- `limit` outside 1-100 rejected
- `limit` as non-integer rejected
- `exclude_failures` as non-boolean rejected
- `dry_run` as non-boolean rejected
- Valid `{ limit: 50, exclude_failures: true }` passes

### 1j. GREEN: Add TriggerEnrichmentRequestSchema

```typescript
export const TriggerEnrichmentRequestSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  exclude_failures: z.boolean().optional().default(false),
  dry_run: z.boolean().optional().default(false),
});
```

### 1k. RED: Test ForceEnrichmentRequest schema (discriminated union)

This is the most complex schema. Tests for:
- Empty body rejected (neither `beer_ids` nor `criteria`)
- Both `beer_ids` and `criteria` present rejected
- `beer_ids` empty array rejected
- `beer_ids` with >100 items rejected
- `beer_ids` with non-string items rejected
- `criteria` empty object rejected
- `criteria.confidence_below` outside 0-1 rejected
- `criteria.enrichment_older_than_days` non-positive-integer rejected
- `criteria.enrichment_source` invalid value rejected
- `limit` outside 1-100 rejected
- `dry_run` non-boolean rejected
- `admin_id` empty string rejected
- Valid beer_ids-based request passes
- Valid criteria-based request passes

Additionally, verify that `safeParse` failures produce issues with the correct
`CODE:` prefix so that `mapZodIssueToErrorCode` (Phase 3b) can extract them:

```typescript
describe('ForceEnrichmentRequestSchema error codes', () => {
  it('rejects empty beer_ids with INVALID_BEER_IDS_EMPTY code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_BEER_IDS_EMPTY:/);
    }
  });

  it('rejects >100 beer_ids with INVALID_BEER_IDS_TOO_MANY code', () => {
    const ids = Array.from({ length: 101 }, (_, i) => `beer-${i}`);
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: ids });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_BEER_IDS_TOO_MANY:/);
    }
  });

  it('rejects non-string beer_ids items with INVALID_BEER_IDS_FORMAT code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({ beer_ids: [123] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_BEER_IDS_FORMAT:/);
    }
  });

  it('rejects both beer_ids and criteria with INVALID_REQUEST_BOTH_SPECIFIED code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      beer_ids: ['abc'],
      criteria: { confidence_below: 0.5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_REQUEST_BOTH_SPECIFIED:/);
    }
  });

  it('rejects neither beer_ids nor criteria with INVALID_REQUEST_NEITHER_SPECIFIED code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_REQUEST_NEITHER_SPECIFIED:/);
    }
  });

  it('rejects invalid confidence_below with INVALID_CONFIDENCE code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: { confidence_below: 1.5 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const confidenceIssue = result.error.issues.find(i => i.message.startsWith('INVALID_CONFIDENCE:'));
      expect(confidenceIssue).toBeDefined();
    }
  });

  it('rejects invalid enrichment_source with INVALID_SOURCE code', () => {
    const result = ForceEnrichmentRequestSchema.safeParse({
      criteria: { enrichment_source: 'openai' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const sourceIssue = result.error.issues.find(i => i.message.startsWith('INVALID_SOURCE:'));
      expect(sourceIssue).toBeDefined();
    }
  });
});
```

### 1l. GREEN: Add ForceEnrichmentRequestSchema

Use a single object schema with `.refine()` for the XOR constraint instead of
`z.union()`. A union of two object schemas produces confusing error messages
("Expected undefined, received array") because Zod tries both branches and
merges the failures. A single schema with a refine gives clean, actionable
errors like "Must specify either beer_ids or criteria".

**Error code convention:** Every constraint carries a `.message('CODE:human text')`
override so that `mapZodIssueToErrorCode` (Phase 3b) can extract the error code
from the message prefix. For structural type mismatches (where Zod produces
`invalid_type` issues before any `.min()` / `.max()` / `.refine()` runs), we
use Zod's `{ errorMap }` constructor option on the outer `z.object()` to catch
the `invalid_type` code and produce the correct `CODE:` prefix. This is
necessary because `.message()` on `z.array()` only fires for type-level errors,
not for downstream refinement errors -- each constraint needs its own message.

```typescript
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
```

> **Note on `INVALID_BEER_IDS` vs `INVALID_CRITERIA` structural codes:** When
> the caller passes `beer_ids: "not-an-array"` (wrong type), Zod fires the
> `errorMap` on `z.array(...)`, which produces `INVALID_BEER_IDS:`. Similarly,
> when `criteria` is a non-object, Zod's structural validation on the nested
> `z.object()` inside `CriteriaSchema` fires first, producing an `invalid_type`
> issue. Since `CriteriaSchema` is defined as a `z.object()`, passing a
> non-object (e.g. `criteria: "bad"`) naturally triggers the `invalid_type`
> error. To produce `INVALID_CRITERIA:` for that case, add an `errorMap` to the
> `CriteriaSchema`'s `z.object()`:
>
> ```typescript
> const CriteriaSchema = z.object({
>   // ... fields ...
> }, {
>   errorMap: () => ({ message: 'INVALID_CRITERIA: criteria must be an object' }),
> }).refine(/* ... */);
> ```
>
> The `INVALID_BODY` code (null/undefined/non-object body) is handled at the
> integration layer in Phase 3b, not in the schema itself, because
> `z.object().safeParse(null)` produces a generic `invalid_type` issue that
> predates any field-level validation.

This replaces `validateForceEnrichmentRequest` (`src/handlers/enrichment.ts:34-135`).

### 1m. RED: Test TriggerCleanupRequest schema

Tests for:
- Missing `mode` rejected
- Invalid `mode` value rejected
- `limit` non-positive-integer rejected
- `dry_run` non-boolean rejected
- `confirm` non-boolean rejected
- Valid `{ mode: 'missing' }` passes
- Valid `{ mode: 'all', confirm: true }` passes

Additionally, verify that `safeParse` failures produce issues with the correct
`CODE:` prefix:

```typescript
describe('TriggerCleanupRequestSchema error codes', () => {
  it('rejects missing mode with INVALID_MODE code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_MODE:/);
    }
  });

  it('rejects invalid mode value with INVALID_MODE code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'invalid' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_MODE:/);
    }
  });

  it('rejects non-integer limit with INVALID_LIMIT code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', limit: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_LIMIT:/);
    }
  });

  it('rejects non-boolean dry_run with INVALID_DRY_RUN code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', dry_run: 'yes' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_DRY_RUN:/);
    }
  });

  it('rejects non-boolean confirm with INVALID_CONFIRM code', () => {
    const result = TriggerCleanupRequestSchema.safeParse({ mode: 'all', confirm: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/^INVALID_CONFIRM:/);
    }
  });
});
```

### 1n. GREEN: Add TriggerCleanupRequestSchema

Every constraint carries a `.message('CODE:human text')` override matching the
error codes from `validateCleanupTriggerRequest`.

```typescript
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
```

> **Note:** `INVALID_BODY` (null/undefined/non-object body) is handled at the
> integration layer in Phase 3b, not in the schema itself, for the same reason
> as `ForceEnrichmentRequestSchema` -- `z.object().safeParse(null)` produces a
> generic `invalid_type` issue that predates any field-level validation.

This replaces `validateCleanupTriggerRequest` (`src/handlers/cleanupTrigger.ts:45-96`).

### 1o. REFACTOR: Derive TypeScript types from schemas

```typescript
export type BatchLookupRequest = z.infer<typeof BatchLookupRequestSchema>;
export type SyncBeersRequest = z.infer<typeof SyncBeersRequestSchema>;
export type EnrichmentCriteria = z.infer<typeof CriteriaSchema>;
// ... etc
```

Remove the corresponding manual interfaces from `src/types.ts` (lines 143-146,
148-154, 164-171, 206-216, 351-358, 410-419) and re-export the Zod-derived
types from `src/schemas/request.ts`.

---

## Step 2: Create `src/schemas/external.ts` - External API response schemas

### 2a. RED: Test PerplexityResponse schema

Tests for:
- Missing `choices` returns success with empty choices
- Nested `message.content` extraction works
- Malformed response (no choices array) handled gracefully

### 2b. GREEN: Add PerplexityResponseSchema

```typescript
// src/schemas/external.ts
import { z } from 'zod';

export const PerplexityResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.string().optional(),
      }).optional(),
    })
  ).optional().default([]),
});
```

### 2c. RED: Test FlyingSaucerBeer schema

Tests for:
- Beer missing `id` rejected
- Beer with empty `id` rejected
- Beer missing `brew_name` rejected
- Valid beer with extra fields passes (passthrough)

### 2d. GREEN: Add FlyingSaucerBeerSchema

Note: `brewer` is optional here even though the `FlyingSaucerBeer` interface in
`types.ts` declares it as required. The `isValidBeer` type guard
(`src/types.ts:323-326`) only checks `id` and `brew_name` — it never validates
`brewer`. Making `brewer` required in the schema would silently drop beers from
the Flying Saucer API if their data happens to lack a `brewer` field. Keeping
it optional matches the actual runtime behavior.

```typescript
export const FlyingSaucerBeerSchema = z.object({
  id: z.string().min(1),
  brew_name: z.string(),
  brewer: z.string().optional(),
  brew_description: z.string().optional(),
  container_type: z.string().optional(),
}).passthrough();

export const FlyingSaucerResponseSchema = z.array(z.unknown());
```

> **Why `.passthrough()`**: Even though Phase 4b removes the `[key: string]:
> unknown` index signature from the `FlyingSaucerBeer` type, `.passthrough()` is
> still needed here. This schema is used by `isValidBeer` via
> `FlyingSaucerBeerSchema.safeParse()` (Phase 3b Step 5b). Without
> `.passthrough()`, Zod's `.safeParse()` would strip unknown fields from the
> returned `.data`, silently dropping fields like `brewInStock` that downstream
> code (e.g. `hasBeerStock`) needs to inspect on the original object. With
> `.passthrough()`, the validated data retains all original fields, so the object
> flows through unchanged after passing the type guard.

---

## Type Migration Strategy

When schemas replace interfaces in `types.ts`, the migration path is:

1. Create the Zod schema in `src/schemas/request.ts`
2. Export the inferred type: `export type SyncBeersRequest = z.infer<typeof SyncBeersRequestSchema>`
3. Update `src/types.ts` to re-export from schemas: `export type { SyncBeersRequest } from './schemas/request'`
4. All existing imports (`import type { SyncBeersRequest } from '../types'`) continue to work unchanged

This avoids a big-bang migration of all import paths.

---

## New Files Created

- `src/schemas/request.ts` -- All request body schemas (7 schemas)
- `src/schemas/external.ts` -- External API response schemas (2 schemas)
- `test/schemas/request.test.ts` -- Schema unit tests

## Next

Continue to **Phase 3b** to integrate these schemas into the handler files.

---

## Implementation Notes (post-implementation drift)

The implementation added two schemas beyond the 7 planned:

1. **`EnrichmentMessageSchema`** (`src/schemas/request.ts:114`): Added for Phase 3b
   Step 3h-ii (DLQ `raw_message` parsing). The 3b plan noted this schema should be
   added "if not already present" — it was added directly to `request.ts` rather than
   as a separate file. Exports `EnrichmentMessage` type (overlaps with the type in
   `src/types.ts`; the schema version is the canonical one for DLQ re-parsing).

2. **`SyncBeersRequestOuterSchema`** (`src/schemas/request.ts:18`): A two-stage
   schema for `handleBeerSync`. The outer schema validates `{ beers: unknown[] }` (top-level
   shape only), and `SyncBeerItemSchema` validates each beer individually (preserving
   per-beer partial success behavior). The plan described this two-stage approach at
   Step 1d but did not name the outer schema explicitly.

Additionally, **`src/schemas/errors.ts`** was created as planned with
`mapZodIssueToErrorCode` — but it also exports `extractZodErrorMessage` (a
companion helper not mentioned in the plan). This function extracts the human-readable
portion after the `CODE:` prefix with `.trim()`, implementing the fix from Review
Finding #25 (leading space issue).

The final `src/schemas/request.ts` exports 9 schemas (not 7) plus `EnrichmentMessage`
as a type derived from `EnrichmentMessageSchema`.
