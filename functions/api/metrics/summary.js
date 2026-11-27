// Cloudflare Pages Function: GET /api/metrics/summary?days=7
// Aggregates D1 robotics, speech, vision, safety, and UX telemetry into dashboard stats.

import { aggregateMetrics } from '../../../src/metrics-agg.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const db = context.env?.LUKA_METRICS_DB;
  if (!db) {
    return json({ ok: false, error: 'metrics_db_unbound' }, 503);
  }

  const url = new URL(context.request.url);
  const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days')) || 7)));
  const nowMs = Date.now();
  const sinceMs = nowMs - days * 86400 * 1000;

  const { results } = await db
    .prepare(
      'SELECT ts, session_id, env, app, event, category, label, value, meta_json FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 25000',
    )
    .bind(sinceMs)
    .all();

  const summary = aggregateMetrics(results || [], { days, nowMs });
  return json({ ok: true, storage: 'cloudflare-d1', ...summary });
}
