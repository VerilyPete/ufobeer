/**
 * POST /usage: unverified per-install daily feature counts from BeerSelector.
 *
 * Every accepted case answers 204, including a duplicate batch, the kill
 * switch, an all-dropped report and an exhausted growth budget, because a
 * 204 tells the client to delete its pending batch and anything else makes
 * it resend. Only a bad envelope is a 400.
 *
 * See plans/usage-telemetry.md.
 */

import type { Env, RequestContext } from '../types';
import { parseUsageReport } from '../schemas/request';
import { recordUsageReport } from '../db/usage';
import { readBoundedJson, boundedJsonErrorResponse } from '../utils/body';
import { getToday } from '../utils/date';
import { trackUsageIngest } from '../analytics';
import { SMALL_JSON_BODY_MAX_BYTES, USAGE_NEW_INSTALL_DAILY_CAP, USAGE_POST_DAILY_CAP } from '../constants';

const noContent = (headers: Record<string, string>): Response => new Response(null, { status: 204, headers });

export async function handleUsageReport(
  request: Request,
  env: Env,
  headers: Record<string, string>,
  reqCtx: RequestContext
): Promise<Response> {
  if (env.USAGE_ENABLED !== 'true') {
    return noContent(headers);
  }

  const bodyResult = await readBoundedJson(request, SMALL_JSON_BODY_MAX_BYTES);
  if (!bodyResult.ok) {
    return boundedJsonErrorResponse(bodyResult, reqCtx.requestId, headers);
  }

  const parsed = parseUsageReport(bodyResult.data);
  if (!parsed.success) {
    return Response.json(
      { error: 'Invalid usage report', requestId: reqCtx.requestId },
      { status: 400, headers }
    );
  }

  const { report, droppedCount } = parsed;
  if (droppedCount > 0) {
    console.log(JSON.stringify({ event: 'usage_events_dropped', droppedCount, requestId: reqCtx.requestId }));
  }
  if (report.events.length === 0) {
    return noContent(headers);
  }

  const now = Date.now();
  const outcome = await recordUsageReport(env.DB, {
    report,
    day: getToday(new Date(now)),
    requestId: reqCtx.requestId,
    now,
    installCap: USAGE_NEW_INSTALL_DAILY_CAP,
    postCap: USAGE_POST_DAILY_CAP,
  });

  if (outcome !== 'admitted') {
    console.log(JSON.stringify({ event: 'usage_post_not_counted', outcome, requestId: reqCtx.requestId }));
  }
  trackUsageIngest(env.ANALYTICS, {
    outcome,
    eventsAccepted: outcome === 'admitted' ? report.events.length : 0,
    eventsDropped: droppedCount,
  });

  return noContent(headers);
}
