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

      console.log(`DLQ message stored: messageId=${message.id}, beerId=${message.body?.beerId}, attempts=${message.attempts}, requestId=${requestId}`);
    } catch (error) {
      console.error(`Failed to store DLQ message: messageId=${message.id}, error=${String(error)}, requestId=${requestId}`);

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

  console.log(`DLQ batch processed: processedCount=${batch.messages.length}, requestId=${requestId}`);
}

/**
 * Store a DLQ message to D1 for admin inspection.
 *
 * Uses UPSERT to handle duplicate message IDs (in case of redelivery).
 *
 * @param db - D1 database binding
 * @param message - The queue message to store
 * @param sourceQueue - The queue name the message came from (unused, we hardcode 'beer-enrichment')
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
    'beer-enrichment', // Original source queue, not the DLQ
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

      console.log(`Cleanup DLQ message stored: messageId=${message.id}, beerId=${message.body?.beerId}, attempts=${message.attempts}, requestId=${requestId}`);
    } catch (error) {
      console.error(`Failed to store cleanup DLQ message: messageId=${message.id}, error=${String(error)}, requestId=${requestId}`);

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

  console.log(`Cleanup DLQ batch processed: processedCount=${batch.messages.length}, requestId=${requestId}`);
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
