/**
 * DLQ (Dead Letter Queue) consumer for failed enrichment messages.
 *
 * This module handles messages that failed processing in the main enrichment queue
 * and stores them in D1 for admin inspection and replay.
 *
 * @module queue/dlq
 */

import type { Env, EnrichmentMessage, CleanupMessage } from '../types';
import { trackDlqConsumer } from '../analytics';

/**
 * Truncate a value for logging to avoid bloating log output.
 * @param value - Value to truncate (will be stringified if not a string)
 * @param maxLength - Maximum length before truncation (default 500)
 */
function truncateForLog(value: unknown, maxLength = 500): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + '... [truncated]';
}

/**
 * Handle a batch of messages from the beer-enrichment-dlq queue.
 *
 * Each message represents a failed enrichment attempt that exhausted retries
 * in the main enrichment queue. Messages are stored to D1 for admin inspection.
 *
 * @param batch - The batch of messages from the DLQ
 * @param env - Cloudflare Worker environment bindings
 * @param requestId - Request ID for logging correlation
 */
export async function handleDlqBatch(
  batch: MessageBatch<EnrichmentMessage>,
  env: Env,
  requestId: string
): Promise<void> {
  for (const message of batch.messages) {
    const storeStartTime = Date.now();

    try {
      await storeDlqMessage(env.DB, message, batch.queue);
      message.ack();

      // Analytics tracking for DLQ storage
      trackDlqConsumer(env.ANALYTICS, {
        beerId: message.body?.beerId || 'unknown',
        attempts: message.attempts,
        sourceQueue: 'beer-enrichment', // The source queue that sent to DLQ
        success: true,
        durationMs: Date.now() - storeStartTime,
      });

      console.log(JSON.stringify({
        level: 'info',
        event: 'dlq.message.stored',
        messageId: message.id,
        beerId: message.body?.beerId,
        attempts: message.attempts,
        requestId,
        body: truncateForLog(message.body),
        timestamp: Date.now(),
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'dlq.message.store.failed',
        messageId: message.id,
        beerId: message.body?.beerId,
        error: error instanceof Error ? error.message : String(error),
        requestId,
        timestamp: Date.now(),
      }));

      // Track failed storage attempt
      trackDlqConsumer(env.ANALYTICS, {
        beerId: message.body?.beerId || 'unknown',
        attempts: message.attempts,
        sourceQueue: 'beer-enrichment',
        success: false,
        durationMs: Date.now() - storeStartTime,
        errorType: 'db_write_error',
      });

      // With max_retries: 3, retry() will requeue the message
      // After 3 failures, the message will be dropped
      message.retry();
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'dlq.batch.processed',
    processedCount: batch.messages.length,
    requestId,
    timestamp: Date.now(),
  }));
}

/**
 * Store a DLQ message to D1 for admin inspection.
 *
 * Uses UPSERT to handle duplicate message IDs (in case of redelivery).
 *
 * @param db - D1 database binding
 * @param message - The queue message to store
 * @param sourceQueue - The queue name the message came from
 */
export async function storeDlqMessage(
  db: D1Database,
  message: Message<EnrichmentMessage>,
  sourceQueue: string
): Promise<void> {
  const body = message.body;
  const now = Date.now();

  // Note: failure_count comes from message.attempts
  // This is the number of delivery attempts Cloudflare made before sending to DLQ
  await db.prepare(`
    INSERT INTO dlq_messages (
      message_id, beer_id, beer_name, brewer,
      failed_at, failure_count, source_queue, raw_message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(message_id) DO UPDATE SET
      failed_at = excluded.failed_at,
      failure_count = excluded.failure_count,
      raw_message = excluded.raw_message,
      status = 'pending'
  `).bind(
    message.id,
    body.beerId,
    body.beerName || null,
    body.brewer || null,
    now,
    message.attempts,
    sourceQueue,
    JSON.stringify(body)
  ).run();
}

/**
 * Handle a batch of messages from the description-cleanup-dlq queue.
 *
 * Each message represents a failed cleanup attempt that exhausted retries.
 * Messages are stored to D1 for admin inspection using the same dlq_messages table.
 *
 * @param batch - The batch of messages from the cleanup DLQ
 * @param env - Cloudflare Worker environment bindings
 * @param requestId - Request ID for logging correlation
 */
export async function handleCleanupDlqBatch(
  batch: MessageBatch<CleanupMessage>,
  env: Env,
  requestId: string
): Promise<void> {
  for (const message of batch.messages) {
    const storeStartTime = Date.now();

    try {
      await storeCleanupDlqMessage(env.DB, message);
      message.ack();

      // Analytics tracking for DLQ storage
      trackDlqConsumer(env.ANALYTICS, {
        beerId: message.body?.beerId || 'unknown',
        attempts: message.attempts,
        sourceQueue: 'description-cleanup',
        success: true,
        durationMs: Date.now() - storeStartTime,
      });

      console.log(JSON.stringify({
        level: 'info',
        event: 'cleanup.dlq.message.stored',
        messageId: message.id,
        beerId: message.body?.beerId,
        attempts: message.attempts,
        requestId,
        body: truncateForLog(message.body),
        timestamp: Date.now(),
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'cleanup.dlq.message.store.failed',
        messageId: message.id,
        beerId: message.body?.beerId,
        error: error instanceof Error ? error.message : String(error),
        requestId,
        timestamp: Date.now(),
      }));

      trackDlqConsumer(env.ANALYTICS, {
        beerId: message.body?.beerId || 'unknown',
        attempts: message.attempts,
        sourceQueue: 'description-cleanup',
        success: false,
        durationMs: Date.now() - storeStartTime,
        errorType: 'db_write_error',
      });

      message.retry();
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'cleanup.dlq.batch.processed',
    processedCount: batch.messages.length,
    requestId,
    timestamp: Date.now(),
  }));
}

/**
 * Store a cleanup DLQ message to D1 for admin inspection.
 */
async function storeCleanupDlqMessage(
  db: D1Database,
  message: Message<CleanupMessage>
): Promise<void> {
  const body = message.body;
  const now = Date.now();

  await db.prepare(`
    INSERT INTO dlq_messages (
      message_id, beer_id, beer_name, brewer,
      failed_at, failure_count, source_queue, raw_message, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(message_id) DO UPDATE SET
      failed_at = excluded.failed_at,
      failure_count = excluded.failure_count,
      raw_message = excluded.raw_message,
      status = 'pending'
  `).bind(
    message.id,
    body.beerId,
    body.beerName || null,
    body.brewer || null,
    now,
    message.attempts,
    'description-cleanup',
    JSON.stringify(body)
  ).run();
}
