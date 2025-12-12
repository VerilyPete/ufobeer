/**
 * DLQ (Dead Letter Queue) Handlers
 *
 * Admin endpoints for managing failed enrichment messages stored in D1.
 * Includes:
 * - handleDlqList() - GET /admin/dlq - List DLQ messages with pagination
 * - handleDlqStats() - GET /admin/dlq/stats - Get DLQ statistics
 * - handleDlqReplay() - POST /admin/dlq/replay - Replay messages back to queue
 * - handleDlqAcknowledge() - POST /admin/dlq/acknowledge - Acknowledge messages
 * - cleanupOldDlqMessages() - Cleanup old acknowledged/replayed messages
 *
 * Extracted from index.ts as part of Phase 7 refactoring.
 */

import type {
  Env,
  RequestContext,
  DlqMessageRow,
  PaginationCursor,
  DlqReplayRequest,
  DlqAcknowledgeRequest,
  EnrichmentMessage,
} from '../types';
import { errorResponse } from '../context';

// ============================================================================
// DLQ List Handler
// ============================================================================

/**
 * GET /admin/dlq - List DLQ messages from D1 with cursor-based pagination
 */
export async function handleDlqList(
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext,
  params: URLSearchParams
): Promise<Response> {
  const status = params.get('status') || 'pending';
  const beerId = params.get('beer_id');
  const limit = Math.min(parseInt(params.get('limit') || '50', 10), 100);
  const cursorParam = params.get('cursor');
  const includeRaw = params.get('include_raw') === 'true';

  // Decode cursor if provided
  let cursor: PaginationCursor | null = null;
  if (cursorParam) {
    try {
      cursor = JSON.parse(atob(cursorParam));
    } catch {
      return errorResponse(
        'Invalid cursor format',
        'INVALID_CURSOR',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }
  }

  try {
    // Build query with cursor-based pagination
    let query = 'SELECT * FROM dlq_messages WHERE 1=1';
    const bindings: (string | number)[] = [];

    if (status && status !== 'all') {
      query += ' AND status = ?';
      bindings.push(status);
    }

    if (beerId) {
      query += ' AND beer_id = ?';
      bindings.push(beerId);
    }

    // Cursor-based pagination: get records after the cursor position
    if (cursor) {
      query += ' AND (failed_at < ? OR (failed_at = ? AND id < ?))';
      bindings.push(cursor.failed_at, cursor.failed_at, cursor.id);
    }

    // Order by failed_at DESC, id DESC for consistent pagination
    query += ' ORDER BY failed_at DESC, id DESC LIMIT ?';
    bindings.push(limit + 1); // Fetch one extra to check if there are more

    const { results } = await env.DB.prepare(query)
      .bind(...bindings)
      .all<DlqMessageRow>();

    // Check if there are more results
    const hasMore = results.length > limit;
    const pageResults = hasMore ? results.slice(0, limit) : results;

    // Generate next cursor from the last item
    let nextCursor: string | null = null;
    if (hasMore && pageResults.length > 0) {
      const lastItem = pageResults[pageResults.length - 1];
      const cursorData: PaginationCursor = {
        failed_at: lastItem.failed_at,
        id: lastItem.id,
      };
      nextCursor = btoa(JSON.stringify(cursorData));
    }

    // Get total count for the filtered status (for display purposes)
    let countQuery = 'SELECT COUNT(*) as count FROM dlq_messages WHERE 1=1';
    const countBindings: (string | number)[] = [];

    if (status && status !== 'all') {
      countQuery += ' AND status = ?';
      countBindings.push(status);
    }

    if (beerId) {
      countQuery += ' AND beer_id = ?';
      countBindings.push(beerId);
    }

    const countResult = await env.DB.prepare(countQuery)
      .bind(...countBindings)
      .first<{ count: number }>();

    const messages = pageResults.map(row => {
      const base = {
        id: row.id,
        message_id: row.message_id,
        beer_id: row.beer_id,
        beer_name: row.beer_name,
        brewer: row.brewer,
        failed_at: row.failed_at,
        failure_count: row.failure_count,
        failure_reason: row.failure_reason,
        source_queue: row.source_queue,
        status: row.status,
        replay_count: row.replay_count,
        replayed_at: row.replayed_at,
        acknowledged_at: row.acknowledged_at,
      };

      // Optionally include raw_message (can be large)
      if (includeRaw) {
        return { ...base, raw_message: row.raw_message };
      }
      return base;
    });

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        messages,
        total_count: countResult?.count || 0,
        limit,
        next_cursor: nextCursor,
        has_more: hasMore,
      },
    }, { headers });
  } catch (error) {
    console.error('Failed to list DLQ messages:', error);
    return errorResponse(
      'Failed to retrieve DLQ messages',
      'DB_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

// ============================================================================
// DLQ Stats Handler
// ============================================================================

/**
 * GET /admin/dlq/stats - Get DLQ statistics
 */
export async function handleDlqStats(
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    // Get counts by status
    const { results: statusCounts } = await env.DB.prepare(`
      SELECT status, COUNT(*) as count
      FROM dlq_messages
      GROUP BY status
    `).all<{ status: string; count: number }>();

    // Get oldest pending message
    const oldestPending = await env.DB.prepare(`
      SELECT failed_at
      FROM dlq_messages
      WHERE status = 'pending'
      ORDER BY failed_at ASC
      LIMIT 1
    `).first<{ failed_at: number }>();

    // Get failure breakdown (top brewers with failures)
    const { results: topFailures } = await env.DB.prepare(`
      SELECT brewer, COUNT(*) as count
      FROM dlq_messages
      WHERE status = 'pending' AND brewer IS NOT NULL
      GROUP BY brewer
      ORDER BY count DESC
      LIMIT 10
    `).all<{ brewer: string; count: number }>();

    // Get recent activity (last 24 hours)
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentActivity = await env.DB.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'replayed' AND replayed_at > ? THEN 1 END) as replayed_24h,
        COUNT(CASE WHEN status = 'acknowledged' AND acknowledged_at > ? THEN 1 END) as acknowledged_24h,
        COUNT(CASE WHEN failed_at > ? THEN 1 END) as new_failures_24h
      FROM dlq_messages
    `).bind(dayAgo, dayAgo, dayAgo).first<{
      replayed_24h: number;
      acknowledged_24h: number;
      new_failures_24h: number;
    }>();

    // Get messages with multiple replays (indicates persistent issues)
    const { results: repeatFailures } = await env.DB.prepare(`
      SELECT beer_id, beer_name, replay_count
      FROM dlq_messages
      WHERE status = 'pending' AND replay_count > 0
      ORDER BY replay_count DESC
      LIMIT 10
    `).all<{ beer_id: string; beer_name: string | null; replay_count: number }>();

    const stats: Record<string, number> = {};
    for (const row of statusCounts) {
      stats[row.status] = row.count;
    }

    const oldestAgeHours = oldestPending
      ? (Date.now() - oldestPending.failed_at) / (60 * 60 * 1000)
      : 0;

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        by_status: {
          pending: stats['pending'] || 0,
          replaying: stats['replaying'] || 0,
          replayed: stats['replayed'] || 0,
          acknowledged: stats['acknowledged'] || 0,
        },
        oldest_pending_age_hours: Math.round(oldestAgeHours * 10) / 10,
        top_failing_brewers: topFailures,
        repeat_failures: repeatFailures,
        last_24h: recentActivity || {
          replayed_24h: 0,
          acknowledged_24h: 0,
          new_failures_24h: 0,
        },
      },
    }, { headers });
  } catch (error) {
    console.error('Failed to get DLQ stats:', error);
    return errorResponse(
      'Failed to retrieve DLQ statistics',
      'DB_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

// ============================================================================
// DLQ Replay Handler
// ============================================================================

/**
 * POST /admin/dlq/replay - Replay messages back to the main enrichment queue
 *
 * Uses optimistic status update to prevent race conditions:
 * 1. Set status to 'replaying' before queue send
 * 2. Rollback to 'pending' on failure
 * 3. Set to 'replayed' and increment replay_count on success
 */
export async function handleDlqReplay(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const body = await request.json() as DlqReplayRequest;
    const { ids, delay_seconds = 0 } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return errorResponse(
        'ids array required',
        'INVALID_REQUEST',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }

    // Limit batch size
    const limitedIds = ids.slice(0, 50);
    const now = Date.now();

    // STEP 1: Optimistically update status to 'replaying' to prevent race conditions
    const placeholders = limitedIds.map(() => '?').join(',');
    const updateResult = await env.DB.prepare(
      `UPDATE dlq_messages
       SET status = 'replaying'
       WHERE id IN (${placeholders}) AND status = 'pending'`
    ).bind(...limitedIds).run();

    const claimedCount = updateResult.meta.changes;

    if (claimedCount === 0) {
      return Response.json({
        success: true,
        requestId: reqCtx.requestId,
        data: {
          requested_count: limitedIds.length,
          replayed_count: 0,
          message: 'No pending messages found to replay',
        },
      }, { headers });
    }

    // STEP 2: Fetch the messages we just claimed
    const { results } = await env.DB.prepare(
      `SELECT id, raw_message, replay_count FROM dlq_messages
       WHERE id IN (${placeholders}) AND status = 'replaying'`
    ).bind(...limitedIds).all<{ id: number; raw_message: string; replay_count: number }>();

    let replayedCount = 0;
    const replayedIds: number[] = [];
    const failedIds: number[] = [];

    // STEP 3: Send messages to queue
    for (const row of results) {
      try {
        const messageBody = JSON.parse(row.raw_message) as EnrichmentMessage;

        await env.ENRICHMENT_QUEUE.send(messageBody, {
          delaySeconds: delay_seconds > 0 ? delay_seconds : undefined,
        });

        replayedIds.push(row.id);
        replayedCount++;

        console.log(`DLQ message replayed: dlqId=${row.id}, beerId=${messageBody.beerId}, replayCount=${row.replay_count + 1}`);
      } catch (error) {
        console.error(`Failed to replay DLQ message: dlqId=${row.id}, error=${String(error)}`);
        failedIds.push(row.id);
      }
    }

    // STEP 4: Update successfully replayed messages
    if (replayedIds.length > 0) {
      const successPlaceholders = replayedIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE dlq_messages
         SET status = 'replayed', replayed_at = ?, replay_count = replay_count + 1
         WHERE id IN (${successPlaceholders})`
      ).bind(now, ...replayedIds).run();
    }

    // STEP 5: Rollback failed messages back to 'pending'
    if (failedIds.length > 0) {
      const failPlaceholders = failedIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE dlq_messages
         SET status = 'pending'
         WHERE id IN (${failPlaceholders})`
      ).bind(...failedIds).run();

      console.warn(`Rolled back failed replay attempts: failedIds=${JSON.stringify(failedIds)}`);
    }

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        requested_count: limitedIds.length,
        claimed_count: claimedCount,
        replayed_count: replayedCount,
        failed_count: failedIds.length,
        queued_to: 'beer-enrichment',
      },
    }, { headers });

  } catch (error) {
    console.error('Failed to replay DLQ messages:', error);
    return errorResponse(
      'Failed to replay messages',
      'REPLAY_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

// ============================================================================
// DLQ Acknowledge Handler
// ============================================================================

/**
 * POST /admin/dlq/acknowledge - Acknowledge (dismiss) messages without replaying
 */
export async function handleDlqAcknowledge(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const body = await request.json() as DlqAcknowledgeRequest;
    const { ids } = body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return errorResponse(
        'ids array required',
        'INVALID_REQUEST',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }

    // Limit batch size
    const limitedIds = ids.slice(0, 100);
    const now = Date.now();

    const placeholders = limitedIds.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `UPDATE dlq_messages
       SET status = 'acknowledged', acknowledged_at = ?
       WHERE id IN (${placeholders}) AND status = 'pending'`
    ).bind(now, ...limitedIds).run();

    console.log(`DLQ messages acknowledged: requestedCount=${limitedIds.length}, acknowledgedCount=${result.meta.changes}`);

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        acknowledged_count: result.meta.changes,
      },
    }, { headers });

  } catch (error) {
    console.error('Failed to acknowledge DLQ messages:', error);
    return errorResponse(
      'Failed to acknowledge messages',
      'DB_ERROR',
      { requestId: reqCtx.requestId, headers, status: 500 }
    );
  }
}

// ============================================================================
// DLQ Cleanup
// ============================================================================

/**
 * Clean up old acknowledged and replayed DLQ messages.
 * Should be called from scheduled() handler.
 */
export async function cleanupOldDlqMessages(
  db: D1Database,
  requestId: string
): Promise<void> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const batchLimit = 1000; // Limit deletions per iteration to avoid long-running queries

  // Delete acknowledged messages older than 30 days (in batches)
  let ackDeleted = 0;
  let ackResult;
  do {
    ackResult = await db.prepare(`
      DELETE FROM dlq_messages
      WHERE id IN (
        SELECT id FROM dlq_messages
        WHERE status = 'acknowledged'
          AND acknowledged_at < ?
        LIMIT ?
      )
    `).bind(thirtyDaysAgo, batchLimit).run();
    ackDeleted += ackResult.meta.changes;
  } while (ackResult.meta.changes === batchLimit);

  // Delete replayed messages older than 30 days (in batches)
  let replayDeleted = 0;
  let replayResult;
  do {
    replayResult = await db.prepare(`
      DELETE FROM dlq_messages
      WHERE id IN (
        SELECT id FROM dlq_messages
        WHERE status = 'replayed'
          AND replayed_at < ?
        LIMIT ?
      )
    `).bind(thirtyDaysAgo, batchLimit).run();
    replayDeleted += replayResult.meta.changes;
  } while (replayResult.meta.changes === batchLimit);

  if (ackDeleted > 0 || replayDeleted > 0) {
    console.log(`DLQ cleanup completed: acknowledged_deleted=${ackDeleted}, replayed_deleted=${replayDeleted}, requestId=${requestId}`);
  }
}
