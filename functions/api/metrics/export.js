// Cloudflare Pages Function: GET /api/metrics/export?days=30&format=jsonl|csv
// Exports raw sanitized telemetry events from D1 for offline Python / notebook analysis.

import { eventsToCsv, eventsToJsonl } from '../../../src/metrics-agg.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const db = context.env?.LUKA_METRICS_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: 'metrics_db_unbound' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const url = new URL(context.request.url);
  const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days')) || 30)));
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'jsonl';
  const sinceMs = Date.now() - days * 86400 * 1000;

  const { results } = await db
    .prepare(
      'SELECT ts, session_id, env, app, event, category, label, value, meta_json FROM events WHERE ts >= ? ORDER BY ts ASC LIMIT 50000',
    )
    .bind(sinceMs)
    .all();

  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'csv') {
    return new Response(eventsToCsv(results || []), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="luka-metrics-${stamp}.csv"`,
        ...CORS,
      },
    });
  }

  return new Response(eventsToJsonl(results || []), {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Content-Disposition': `attachment; filename="luka-metrics-${stamp}.jsonl"`,
      ...CORS,
    },
  });
}
