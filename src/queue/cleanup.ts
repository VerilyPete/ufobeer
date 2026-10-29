/**
 * Description Cleanup Queue Consumer
 *
 * Cleans beer descriptions deterministically: sanitizes them, then applies
 * every fix the cleanup guard permits. No model is called.
 *
 * Pipeline:
 * 1. Receive cleanup message with beer description
 * 2. Clean the description and extract its ABV
 * 3. If ABV found: Update DB with cleaned desc + ABV, done
 * 4. If ABV not found: Update DB with cleaned desc, queue for Perplexity
 *
 * @module queue/cleanup
 */

import type { Env, CleanupMessage, EnrichmentMessage } from '../types';
import { extractABV } from '../db/helpers';
import { shouldSkipEnrichment } from '../config';
import {
  ABV_CONFIDENCE_FROM_DESCRIPTION,
  CLEANUP_VERSION,
  MAX_DESCRIPTION_LENGTH,
  MAX_CLEANED_OUTPUT_LENGTH,
} from '../constants';
import { batchUpdateWithRetry } from './cleanupHelpers';
import { applyCleanupFixes, checkCleanup } from './cleanupGuard';
import { repairMojibake } from './mojibake';
import { log } from '../utils/log';

// ============================================================================
// Description sanitization
// ============================================================================

/** C0 control characters and DEL, excluding \t \n \r which are legitimate
 * in free-form beer descriptions. */
// Built from numeric char codes (rather than a regex literal with hex
// escapes) to keep this file's raw bytes unambiguous: C0 controls
// (0x00-0x1F) minus tab/newline/carriage-return (legitimate in
// free-form descriptions), plus DEL (0x7F).
const CONTROL_CHAR_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 127];
const CONTROL_CHAR_PATTERN = new RegExp('[' + CONTROL_CHAR_CODES.map((c) => String.fromCharCode(c)).join('') + ']');

/**
 * Sanitize raw description text: strip HTML tags and control characters,
 * and bound length. The cleaned description is served directly to clients
 * (`handlers/beers.ts`'s
 * `enrichment?.brew_description_cleaned ?? beer.brew_description`).
 */
function sanitizeDescription(text: string): string {
  // Decode source formatting before stripping tags so encoded markup cannot
  // bypass sanitization. Unknown entities/escapes remain literal.
  const entities: Record<string, string> = {
    amp: '&', nbsp: '\u00a0', quot: '"', apos: "'", lt: '<', gt: '>',
    rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  };
  const decoded = text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (!name.startsWith('#')) return entities[name.toLowerCase()] ?? entity;
    const hex = name[1]?.toLowerCase() === 'x';
    const point = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
      ? String.fromCodePoint(point) : entity;
  });
  // Repair mojibake after entities are decoded, since entities can hide it
  // ("M&#195;&#164;rzen"), and before the whitespace collapse, which would
  // turn a mangled non-breaking space ("Â" + U+00A0) into "Â ". Repair only
  // ever yields non-ASCII, so it cannot reintroduce markup.
  return repairMojibake(decoded)
    .replace(/\\r\\n|\\[rnt]/g, ' ')
    .replace(/\\(['"])/g, '$1')
    .replace(/<\/?(?:p|div|br)\b[^>]*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .replace(new RegExp(CONTROL_CHAR_PATTERN, 'g'), '')
    .trim()
    .slice(0, MAX_CLEANED_OUTPUT_LENGTH);
}

// ============================================================================
// Types
// ============================================================================

type CleanedDescription = {
  readonly cleaned: string;
  readonly abv: number | null;
};

/**
 * A single UPDATE statement paired with the beer ID it targets, so a
 * stale-write result (0 rows changed -- see findStaleBeerIds) can be
 * traced back to the message it came from after db.batch() resolves.
 */
type DbOperation = {
  readonly statement: D1PreparedStatement;
  readonly beerId: string;
};

type BatchOperations = {
  readonly dbOperations: readonly DbOperation[];
  readonly perplexityMessages: readonly EnrichmentMessage[];
  readonly abvExtractedCount: number;
};

/**
 * Determine which beer IDs' UPDATE did not actually change a row, from the
 * D1Result[] db.batch() resolves with and the beerId each statement
 * targeted (same order). This is the stale-result signal: every write in
 * this module is bound with `WHERE id = ? AND description_hash = ?`, so a
 * mismatch (the row's authoritative description changed after this
 * message was produced) reports 0 changes instead of throwing.
 *
 * A result with no reported `meta.changes` (e.g. a simplified test double
 * that resolves `db.batch()` with `[]`) is treated as a successful write,
 * not stale -- real D1 always reports per-statement changes, so this only
 * affects test doubles that don't model per-statement results.
 */
function findStaleBeerIds(
  operations: readonly DbOperation[],
  results: readonly D1Result[]
): ReadonlySet<string> {
  const stale = new Set<string>();
  operations.forEach((op, i) => {
    if (results[i]?.meta?.changes === 0) {
      stale.add(op.beerId);
    }
  });
  return stale;
}

/** Log a stale-write warning in a consistent shape across call sites. */
function logStaleWrite(beerId: string, reason: string): void {
  console.warn(JSON.stringify({
    event: 'cleanup.stale_result',
    beerId,
    reason,
  }));
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clean a description deterministically: sanitize it, then apply every fix
 * the cleanup guard permits (applyCleanupFixes: reviewed spelling pairs, a
 * missing space after a comma or between a percentage and ABV, a missing
 * final full stop). The beer name and brewer are never altered.
 */
function cleanDescription(message: CleanupMessage): CleanedDescription {
  const { beerId, beerName, brewer, brewDescription } = message;
  const protectedTerms = [beerName, brewer];
  // Bounded regardless of source: request-schema bounds on brew_description
  // are a client-facing concern and do not constrain descriptions that
  // originate from Flying Saucer.
  const source = sanitizeDescription(brewDescription.slice(0, MAX_DESCRIPTION_LENGTH));
  const cleaned = applyCleanupFixes({ source, protectedTerms });
  const verdict = checkCleanup({
    source,
    output: cleaned,
    protectedTerms,
    maxEdits: Number.POSITIVE_INFINITY,
  });
  if (verdict.ok && verdict.edits.length > 0) {
    log('cleanup.fixes.applied', { beerId, edits: verdict.edits });
  }
  return { cleaned, abv: extractABV(source) };
}

/**
 * Build the D1 updates and Perplexity messages for a batch: a description
 * with an ABV records it; one without is queued for Perplexity unless the
 * beer is blocklisted.
 */
function buildBatchOperations(
  messages: readonly Message<CleanupMessage>[],
  env: Env
): BatchOperations {
  const now = Date.now();
  const dbOperations: DbOperation[] = [];
  const perplexityMessages: EnrichmentMessage[] = [];
  let abvExtractedCount = 0;

  for (const message of messages) {
    const { beerId, beerName, brewer, descriptionHash } = message.body;
    const { cleaned, abv } = cleanDescription(message.body);

    if (abv !== null) {
      abvExtractedCount++;
      dbOperations.push({
        beerId,
        statement: env.DB.prepare(`
          UPDATE enriched_beers SET
            brew_description_cleaned = ?,
            description_cleaned_at = ?,
            cleanup_source = 'deterministic',
            cleanup_version = ${CLEANUP_VERSION},
            abv = ?,
            confidence = ${ABV_CONFIDENCE_FROM_DESCRIPTION},
            enrichment_source = 'description',
            enrichment_status = 'enriched'
          WHERE id = ? AND description_hash = ?
        `).bind(cleaned, now, abv, beerId, descriptionHash ?? null),
      });
      continue;
    }

    dbOperations.push({
      beerId,
      statement: env.DB.prepare(`
        UPDATE enriched_beers SET
          brew_description_cleaned = ?,
          description_cleaned_at = ?,
          cleanup_source = 'deterministic',
          cleanup_version = ${CLEANUP_VERSION}
        WHERE id = ? AND description_hash = ?
      `).bind(cleaned, now, beerId, descriptionHash ?? null),
    });
    if (!shouldSkipEnrichment(beerName)) {
      // The row's description_hash column is untouched by this UPDATE
      // (only cleanup fields are set above), so the CleanupMessage's
      // own descriptionHash -- which just matched the row for this
      // write to have succeeded -- is still the row's current hash.
      // Forwarding it gives the downstream Perplexity write the same
      // stale-result binding as cleanup.ts (Cloudflare security review
      // Phase 1, item 2a/5 parity).
      perplexityMessages.push({ beerId, beerName, brewer, descriptionHash: descriptionHash ?? null });
    }
  }

  return { dbOperations, perplexityMessages, abvExtractedCount };
}

// ============================================================================
// Batch Phases
// ============================================================================

/** Result of the D1 batch execution phase. */
type DatabaseBatchResult =
  | { readonly success: true; readonly staleBeerIds: ReadonlySet<string> }
  | { readonly success: false };

/**
 * Execute D1 batch update with retry logic.
 *
 * Wraps batchUpdateWithRetry, handles failure by retrying all messages, and
 * -- on success -- reports which beer IDs had a stale write (0 rows
 * changed, from the `WHERE id = ? AND description_hash = ?` optimistic
 * concurrency check on every UPDATE this module issues) so the caller can
 * skip deriving further work (e.g. Perplexity enqueue) from data that was
 * never actually persisted.
 *
 * @param db - D1 database instance
 * @param operations - Prepared D1 statements paired with their beer IDs
 * @param messages - Original messages (for retry on total batch failure)
 */
async function executeDatabaseBatch(
  db: D1Database,
  operations: readonly DbOperation[],
  messages: readonly Message<CleanupMessage>[]
): Promise<DatabaseBatchResult> {
  if (operations.length === 0) return { success: true, staleBeerIds: new Set() };

  try {
    const results = await batchUpdateWithRetry(db, operations.map(op => op.statement));
    const staleBeerIds = findStaleBeerIds(operations, results);
    for (const beerId of staleBeerIds) {
      logStaleWrite(beerId, 'main batch: description_hash mismatch or missing');
    }
    return { success: true, staleBeerIds };
  } catch (dbError) {
    console.error('[cleanup] Batch D1 update failed after retries:', dbError);
    // Retry ALL messages if DB fails after retries
    for (const msg of messages) {
      msg.retry();
    }
    return { success: false };
  }
}

/**
 * Queue messages to Perplexity enrichment queue.
 *
 * Sends messages for beers without ABV to the Perplexity enrichment queue.
 * Logs errors but does not fail - cron job will pick up unenriched beers later.
 *
 * @param queue - Enrichment queue binding
 * @param perplexityMessages - Messages to queue for Perplexity
 */
async function queueForPerplexityEnrichment(
  queue: Queue<EnrichmentMessage>,
  perplexityMessages: readonly EnrichmentMessage[]
): Promise<void> {
  if (perplexityMessages.length === 0) return;

  try {
    await queue.sendBatch(
      perplexityMessages.map(msg => ({ body: msg }))
    );
    console.log(`[cleanup] Queued ${perplexityMessages.length} messages for Perplexity enrichment`);
  } catch (queueError) {
    // Log but don't fail - cron job will pick up unenriched beers later
    console.error('[cleanup] Failed to queue Perplexity messages:', queueError);
  }
}

// ============================================================================
// Main Consumer Handler
// ============================================================================

/**
 * Handle a batch of cleanup queue messages.
 *
 * 1. Drop messages with no descriptionHash
 * 2. Clean each description and build the batch operations
 * 3. Execute the D1 batch update with retry
 * 4. Queue beers without an ABV for Perplexity enrichment
 * 5. Acknowledge the messages
 *
 * @param batch - Queue message batch from Cloudflare
 * @param env - Worker environment bindings
 */
export async function handleCleanupBatch(
  batch: MessageBatch<CleanupMessage>,
  env: Env
): Promise<void> {
  console.log('[cleanup] Processing batch', { batch_size: batch.messages.length });

  // ============================================================
  // Phase 0: Drop messages with no descriptionHash
  // ============================================================
  // Only possible for messages already in flight (enqueued before the
  // deploy that added CleanupMessage.descriptionHash) -- every UPDATE this
  // consumer issues binds `AND description_hash = ?`, and a message with
  // no hash to bind can never be distinguished from a genuinely stale one,
  // so it is treated the same way: acknowledged without writing. This is a
  // one-time drop of whatever was queued at deploy time, not an ongoing
  // condition.
  const messagesWithHash: Message<CleanupMessage>[] = [];
  for (const msg of batch.messages) {
    if (msg.body.descriptionHash) {
      messagesWithHash.push(msg);
    } else {
      logStaleWrite(msg.body.beerId, 'no descriptionHash on message (pre-deploy in-flight message)');
      msg.ack();
    }
  }
  if (messagesWithHash.length === 0) {
    console.log('[cleanup] All messages in batch had no descriptionHash; acked without processing');
    return;
  }

  const operations = buildBatchOperations(messagesWithHash, env);
  console.log('[cleanup] Batch metrics:', JSON.stringify({
    total: messagesWithHash.length,
    abv_extracted: operations.abvExtractedCount,
    abv_rate: Math.round((operations.abvExtractedCount / messagesWithHash.length) * 100),
  }));

  const dbResult = await executeDatabaseBatch(env.DB, operations.dbOperations, messagesWithHash);
  if (!dbResult.success) {
    return; // Messages already retried in executeDatabaseBatch
  }

  // Exclude beers whose write was stale (0 rows changed) -- enqueuing
  // Perplexity work derived from data that was never persisted would
  // reintroduce the same stale-result problem one step downstream.
  const perplexityMessages = operations.perplexityMessages.filter(
    msg => !dbResult.staleBeerIds.has(msg.beerId)
  );
  await queueForPerplexityEnrichment(env.ENRICHMENT_QUEUE, perplexityMessages);

  for (const msg of messagesWithHash) {
    msg.ack();
  }
  console.log('[cleanup] Batch complete', { acked: messagesWithHash.length });
}
