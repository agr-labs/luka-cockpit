// Cloudflare Pages Function: POST /api/metrics
// Ingests batched, privacy-sanitized telemetry events into D1 (LUKA_METRICS_DB).

import { sanitizeEventBatch } from '../../src/metrics-agg.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

export async function onRequestPost(context) {
  const db = context.env?.LUKA_METRICS_DB;
  if (!db) {
    return json({ ok: false, error: 'metrics_db_unbound' }, 503);
  }

  const rawText = await context.request.text();
  if (rawText.length > 32768) {
    return json({ ok: false, error: 'payload_too_large' }, 413);
  }

  let body;
  try {
    body = JSON.parse(rawText || '{}');
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  const parsed = sanitizeEventBatch(body, { defaultEnv: 'pages', nowMs: Date.now() });
  if (!parsed.ok) {
    return json({ ok: false, error: parsed.error || 'no_valid_events', rejected: parsed.rejected }, 400);
  }

  const stmt = db.prepare(
    'INSERT INTO events (ts, session_id, env, app, event, category, label, value, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const stmts = parsed.events.map((e) =>
    stmt.bind(e.ts, e.session_id, e.env, e.app, e.event, e.category, e.label, e.value, e.meta_json),
  );
  await db.batch(stmts);

  return json({ ok: true, accepted: parsed.events.length, rejected: parsed.rejected }, 202);
}
