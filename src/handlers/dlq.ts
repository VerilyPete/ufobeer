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

import { NOT_VERIFIED_SQL } from '../db/verified';
import { z } from 'zod';
import type {
  Env,
  RequestContext,
  DlqMessageRow,
  PaginationCursor,
  CleanupMessage,
  EnrichmentMessage,
} from '../types';
import { errorResponse } from '../context';
import { readBoundedJson, boundedJsonErrorResponse } from '../utils/body';
import { DLQ_REPLAY_CLAIM_STALE_MS, SMALL_JSON_BODY_MAX_BYTES } from '../constants';
import {
  DlqReplayRequestSchema,
  DlqAcknowledgeRequestSchema,
  EnrichmentMessageSchema,
  CleanupMessageSchema,
} from '../schemas/request';

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
  const limit = Math.min(Math.max(parseInt(params.get('limit') || '50', 10) || 50, 1), 100);
  const cursorParam = params.get('cursor');
  const includeRaw = params.get('include_raw') === 'true';

  // Decode cursor if provided
  const CursorSchema = z.object({
    id: z.number(),
    failed_at: z.number(),
  });
  let cursor: PaginationCursor | null = null;
  if (cursorParam) {
    try {
      const cursorParse = CursorSchema.safeParse(JSON.parse(atob(cursorParam)));
      if (!cursorParse.success) {
        return errorResponse(
          'Invalid cursor format',
          'INVALID_CURSOR',
          { requestId: reqCtx.requestId, headers, status: 400 }
        );
      }
      cursor = cursorParse.data;
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
      if (lastItem) {
        const cursorData: PaginationCursor = {
          failed_at: lastItem.failed_at,
          id: lastItem.id,
        };
        nextCursor = btoa(JSON.stringify(cursorData));
      }
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

type ClaimedEntry = {
  readonly id: number;
  readonly raw_message: string;
  readonly replay_count: number;
  readonly source_queue: string;
};

type Lease = { readonly token: string };

/** The guard that this request still holds an entry's claim. */
const HOLDS_CLAIM_SQL = `EXISTS (SELECT 1 FROM dlq_messages
  WHERE dlq_messages.id = ? AND dlq_messages.status = 'replaying' AND dlq_messages.replay_claim = ?)`;

/** Beer states a replay may return to 'pending': no ABV yet, not skipped. */
const REPLAYABLE_BEER_SQL = `enriched_beers.abv IS NULL
  AND enriched_beers.enrichment_status IN ('pending', 'failed', 'not_found')`;

type RefusedReset = 'lost' | 'missing' | 'verified' | 'resolved' | 'race';

type ResetState = {
  readonly owned: number;
  readonly present: number;
  readonly is_verified: number | null;
  readonly replayable: number | null;
};

function classifyRefusedReset(state: ResetState): RefusedReset {
  if (state.owned !== 1) return 'lost';
  if (state.present !== 1) return 'missing';
  if (state.is_verified === 1) return 'verified';
  if (state.replayable !== 1) return 'resolved';
  return 'race';
}

/** Why a guarded reset changed nothing, read in one statement, lease first. */
async function refusedReset(db: D1Database, dlqId: number, beerId: string, lease: Lease): Promise<RefusedReset> {
  const state = await db.prepare(
    `SELECT ${HOLDS_CLAIM_SQL} AS owned,
            enriched_beers.id IS NOT NULL AS present,
            enriched_beers.is_verified AS is_verified,
            (${REPLAYABLE_BEER_SQL}) AS replayable
     FROM (SELECT 1) LEFT JOIN enriched_beers ON enriched_beers.id = ?`
  ).bind(dlqId, lease.token, beerId).first<ResetState>();
  return state === null ? 'lost' : classifyRefusedReset(state);
}

async function holdsClaim(db: D1Database, dlqId: number, lease: Lease): Promise<boolean> {
  const row = await db.prepare(`SELECT ${HOLDS_CLAIM_SQL} AS owned`)
    .bind(dlqId, lease.token).first<{ owned: number }>();
  return row?.owned === 1;
}

/**
 * Return DLQ entries whose replay claim is older than DLQ_REPLAY_CLAIM_STALE_MS
 * (or has no claim time: stranded before claims were timed) to 'pending'. A
 * claim that old belongs to a replay request that failed or died before
 * releasing it. Nothing is re-sent; the entry can simply be replayed again.
 * Runs on every cron tick.
 */
export async function releaseStaleReplayClaims(
  db: D1Database,
  { now }: { readonly now: number }
): Promise<number> {
  const result = await db.prepare(
    `UPDATE dlq_messages SET status = 'pending', replay_claim = NULL, replay_claimed_at = NULL
     WHERE status = 'replaying' AND (replay_claimed_at IS NULL OR replay_claimed_at <= ?)`
  ).bind(now - DLQ_REPLAY_CLAIM_STALE_MS).run();
  return result.meta.changes;
}

/**
 * POST /admin/dlq/replay - Replay messages back to the queue they failed on
 *
 * 1. Claim pending entries with a lease (a random token and the claim time),
 *    in the same transaction that lists entries refused for a verified beer.
 * 2. For each claimed entry, every write is guarded on the lease; an
 *    enrichment entry is sent only if its beer's guarded reset applied.
 * 3. Release unsent entries to 'pending', then mark sent ones 'replayed',
 *    both guarded on the lease. A claim never released is returned to
 *    'pending' by the cron (releaseStaleReplayClaims).
 */
export async function handleDlqReplay(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  try {
    const bodyResult = await readBoundedJson(request, SMALL_JSON_BODY_MAX_BYTES);
    if (!bodyResult.ok) {
      return boundedJsonErrorResponse(bodyResult, reqCtx.requestId, headers);
    }

    const parseResult = DlqReplayRequestSchema.safeParse(bodyResult.data);
    if (!parseResult.success) {
      return errorResponse(
        'ids array required',
        'INVALID_REQUEST',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }
    const { ids, delay_seconds } = parseResult.data;

    // DlqReplayRequestSchema already caps `ids` at DLQ_REPLAY_MAX_IDS (50)
    // and rejects an oversized array with a 400 above, instead of silently
    // truncating it after the fact.
    const limitedIds = ids;
    const now = Date.now();
    const lease: Lease = { token: crypto.randomUUID() };

    // STEP 1: Claim, in one transaction with the list of entries refused for
    // a hand-verified beer, so the two agree. Such an entry is never claimed:
    // it stays 'pending', is reported in skipped_verified, and can be replayed
    // once a human clears the flag.
    const placeholders = limitedIds.map(() => '?').join(',');
    const VERIFIED_ENRICHMENT_ENTRY = `source_queue != 'description-cleanup' AND EXISTS (
         SELECT 1 FROM enriched_beers WHERE enriched_beers.id = dlq_messages.beer_id AND enriched_beers.is_verified IS 1)`;
    const [verifiedAtClaim, claimed] = await env.DB.batch<ClaimedEntry>([
      env.DB.prepare(
        `SELECT id, raw_message, replay_count, source_queue FROM dlq_messages
         WHERE id IN (${placeholders}) AND status = 'pending' AND ${VERIFIED_ENRICHMENT_ENTRY}`
      ).bind(...limitedIds),
      env.DB.prepare(
        `UPDATE dlq_messages
         SET status = 'replaying', replay_claim = ?, replay_claimed_at = ?
         WHERE id IN (${placeholders}) AND status = 'pending' AND NOT (${VERIFIED_ENRICHMENT_ENTRY})
         RETURNING id, raw_message, replay_count, source_queue`
      ).bind(lease.token, now, ...limitedIds),
    ]);

    const results = claimed?.results ?? [];
    const claimedCount = results.length;
    const skippedVerifiedIds: number[] = (verifiedAtClaim?.results ?? []).map(row => row.id);
    const verifiedAfterClaimIds: number[] = [];
    const resolvedIds: number[] = [];

    if (claimedCount === 0) {
      return Response.json({
        success: true,
        requestId: reqCtx.requestId,
        data: {
          requested_count: limitedIds.length,
          replayed_count: 0,
          skipped_verified: skippedVerifiedIds,
          skipped_resolved: resolvedIds,
          message: 'No pending messages found to replay',
        },
      }, { headers });
    }

    let replayedCount = 0;
    let enrichmentSent = 0;
    let cleanupSent = 0;
    const replayedIds: number[] = [];
    const failedIds: number[] = [];

    // STEP 2: Send messages to the queue they originally failed on.
    // Rows arrive from BOTH DLQs (enrichment and cleanup share this table);
    // parsing everything with EnrichmentMessageSchema would silently strip
    // brewDescription from cleanup rows and misroute them to Perplexity.
    // Ownership fences the database writes, not the sends: if the lease is
    // lost after an entry's last check but before its send, the send still
    // goes out (queues are at-least-once; the consumers' guards apply).
    for (const row of results) {
      try {
        const raw: unknown = JSON.parse(row.raw_message);
        const isCleanupSource = row.source_queue === 'description-cleanup';

        if (isCleanupSource) {
          const parsed = CleanupMessageSchema.safeParse(raw);
          if (!parsed.success) {
            console.warn(`Skipping corrupt cleanup DLQ row: dlqId=${row.id}`);
            failedIds.push(row.id);
            continue;
          }
          if (!(await holdsClaim(env.DB, row.id, lease))) {
            console.warn(`DLQ replay lost its claim, not sending: dlqId=${row.id}`);
            continue;
          }
          // Built explicitly (rather than spreading parsed.data) so an
          // absent descriptionHash omits the key entirely instead of
          // assigning it `undefined` -- required under
          // exactOptionalPropertyTypes for CleanupMessage.descriptionHash.
          // This also preserves the original message's descriptionHash on
          // replay, rather than stripping it, so a replayed message stays
          // bound to the same description version it was originally built
          // from (stale-result binding).
          const cleanupMessage: CleanupMessage = {
            beerId: parsed.data.beerId,
            beerName: parsed.data.beerName,
            brewer: parsed.data.brewer,
            brewDescription: parsed.data.brewDescription,
            ...(parsed.data.descriptionHash !== undefined
              ? { descriptionHash: parsed.data.descriptionHash }
              : {}),
          };
          await env.CLEANUP_QUEUE.send(
            cleanupMessage,
            delay_seconds > 0 ? { delaySeconds: delay_seconds } : {}
          );
          cleanupSent++;
        } else {
          const parsed = EnrichmentMessageSchema.safeParse(raw);
          if (!parsed.success) {
            console.warn(`Skipping corrupt enrichment DLQ row: dlqId=${row.id}`);
            failedIds.push(row.id);
            continue;
          }
          // Reset the beer's status BEFORE the send. DLQ storage may have
          // marked it 'failed' (no longer auto-requeued); the consumer's
          // gate skips anything not 'pending', so a reset-after-send failure
          // would ack-and-drop the replayed message. If this reset succeeds
          // but the send below fails, the beer is left 'pending' and the
          // cron sweep requeues it — self-healing. The reset applies only
          // while this request holds the claim, and never re-opens a
          // hand-verified beer, one that already has an ABV, or a skipped one.
          const reset = await env.DB.prepare(
            `UPDATE enriched_beers SET enrichment_status = 'pending', updated_at = ?
             WHERE id = ? AND ${NOT_VERIFIED_SQL} AND ${REPLAYABLE_BEER_SQL} AND ${HOLDS_CLAIM_SQL}`
          ).bind(Date.now(), parsed.data.beerId, row.id, lease.token).run();
          if (reset.meta.changes === 0) {
            const refusal = await refusedReset(env.DB, row.id, parsed.data.beerId, lease);
            if (refusal === 'lost') {
              console.warn(`DLQ replay lost its claim, not sending: dlqId=${row.id}`);
              continue;
            }
            if (refusal === 'verified') {
              verifiedAfterClaimIds.push(row.id);
              continue;
            }
            if (refusal === 'resolved') {
              // The beer has an ABV or was skipped since this entry failed
              // (e.g. an earlier replay's send went out but its finalize
              // failed): re-sending would pay for the lookup again.
              resolvedIds.push(row.id);
              continue;
            }
            if (refusal === 'race') {
              // The row is replayable but the guarded reset did not apply
              // (it changed mid-replay): sending now could reach a
              // non-pending row and be dropped, so leave it for another replay.
              failedIds.push(row.id);
              continue;
            }
            // 'missing': the consumer's preflight acks a missing row before
            // reserving any quota.
          }

          // EnrichmentMessage.descriptionHash is required-but-nullable, so
          // a `?? null` fallback (not a conditional key-spread) normalizes
          // a genuinely absent key -- a DLQ row written before this field
          // existed -- into an explicit null. This also preserves the
          // original message's descriptionHash on replay, matching the
          // CleanupMessage branch above (stale-result binding parity,
          // Cloudflare security review Phase 1, item 2a/5).
          const enrichmentMessage: EnrichmentMessage = {
            beerId: parsed.data.beerId,
            beerName: parsed.data.beerName,
            brewer: parsed.data.brewer,
            descriptionHash: parsed.data.descriptionHash ?? null,
          };
          await env.ENRICHMENT_QUEUE.send(
            enrichmentMessage,
            delay_seconds > 0 ? { delaySeconds: delay_seconds } : {}
          );
          enrichmentSent++;
        }

        replayedIds.push(row.id);
        replayedCount++;

        console.log(`DLQ message replayed: dlqId=${row.id}, sourceQueue=${row.source_queue}, replayCount=${row.replay_count + 1}`);
      } catch (error) {
        console.error(`Failed to replay DLQ message: dlqId=${row.id}, error=${String(error)}`);
        failedIds.push(row.id);
      }
    }

    // STEP 3: Release unsent entries to 'pending' first, so a failure
    // finalizing the sent ones cannot strand them in 'replaying'. Both writes
    // touch only entries this request still holds.
    const unsentIds = [...failedIds, ...verifiedAfterClaimIds, ...resolvedIds];
    if (unsentIds.length > 0) {
      const unsentPlaceholders = unsentIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE dlq_messages
         SET status = 'pending', replay_claim = NULL, replay_claimed_at = NULL
         WHERE id IN (${unsentPlaceholders}) AND status = 'replaying' AND replay_claim = ?`
      ).bind(...unsentIds, lease.token).run();
    }
    if (failedIds.length > 0) {
      console.warn(`Rolled back failed replay attempts: failedIds=${JSON.stringify(failedIds)}`);
    }
    const allSkippedVerifiedIds = [...skippedVerifiedIds, ...verifiedAfterClaimIds];
    if (allSkippedVerifiedIds.length > 0) {
      console.warn(`Refused replay of hand-verified beers: dlqIds=${JSON.stringify(allSkippedVerifiedIds)}`);
    }
    if (resolvedIds.length > 0) {
      console.warn(`Refused replay of beers already resolved: dlqIds=${JSON.stringify(resolvedIds)}`);
    }

    // STEP 4: Mark successfully replayed messages
    if (replayedIds.length > 0) {
      const successPlaceholders = replayedIds.map(() => '?').join(',');
      await env.DB.prepare(
        `UPDATE dlq_messages
         SET status = 'replayed', replayed_at = ?, replay_count = replay_count + 1,
             replay_claim = NULL, replay_claimed_at = NULL
         WHERE id IN (${successPlaceholders}) AND status = 'replaying' AND replay_claim = ?`
      ).bind(now, ...replayedIds, lease.token).run();
    }

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        requested_count: limitedIds.length,
        claimed_count: claimedCount,
        replayed_count: replayedCount,
        failed_count: failedIds.length,
        skipped_verified: allSkippedVerifiedIds,
        skipped_resolved: resolvedIds,
        // queued_to is only meaningful when exactly one queue was targeted;
        // omitted for mixed batches and for zero-sent batches (see queued_counts)
        ...(enrichmentSent > 0 && cleanupSent === 0 && { queued_to: 'beer-enrichment' }),
        ...(enrichmentSent === 0 && cleanupSent > 0 && { queued_to: 'description-cleanup' }),
        queued_counts: {
          enrichment: enrichmentSent,
          cleanup: cleanupSent,
        },
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
    const bodyResult = await readBoundedJson(request, SMALL_JSON_BODY_MAX_BYTES);
    if (!bodyResult.ok) {
      return boundedJsonErrorResponse(bodyResult, reqCtx.requestId, headers);
    }

    const parseResult = DlqAcknowledgeRequestSchema.safeParse(bodyResult.data);
    if (!parseResult.success) {
      return errorResponse(
        'ids array required',
        'INVALID_REQUEST',
        { requestId: reqCtx.requestId, headers, status: 400 }
      );
    }
    const { ids } = parseResult.data;

    // DlqAcknowledgeRequestSchema already caps `ids` at
    // DLQ_ACKNOWLEDGE_MAX_IDS (100) and rejects an oversized array with a
    // 400 above, instead of silently truncating it after the fact.
    const limitedIds = ids;
    const now = Date.now();

    const placeholders = limitedIds.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `UPDATE dlq_messages
       SET status = 'acknowledged', acknowledged_at = ?
       WHERE id IN (${placeholders}) AND status = 'pending'`
    ).bind(now, ...limitedIds).run();

    const requestedCount = limitedIds.length;
    const acknowledgedCount = result.meta.changes;
    // Rows requested but not acknowledged: not found, or not in 'pending'
    // status (already acknowledged/replaying/replayed). Surfaced so the
    // caller -- and the admin audit row at the index.ts call site -- can
    // distinguish a full acknowledge from a partial one, the same way
    // dlq_replay already reports requested_count/failed_count.
    const failedCount = requestedCount - acknowledgedCount;

    console.log(`DLQ messages acknowledged: requestedCount=${requestedCount}, acknowledgedCount=${acknowledgedCount}`);

    return Response.json({
      success: true,
      requestId: reqCtx.requestId,
      data: {
        acknowledged_count: acknowledgedCount,
        requested_count: requestedCount,
        failed_count: failedCount,
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
