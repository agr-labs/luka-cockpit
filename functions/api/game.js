// Cloudflare Pages Function: /api/game
// Synchronizes Beat the Bot multiplayer rooms across Host screens and QR-joined guest phones
// on public https://luka.steadwell.cc/beat-the-bot using the bound Cloudflare D1 database.

import {
  normalizeRoomCode,
  createRoomState,
  joinRoom,
  startIntro,
  startQuestion,
  submitAnswer,
  revealQuestion,
  showLeaderboard,
  openQaMode,
  finishMission,
  submitAudienceQuestion,
  markAudienceQuestionAnswered,
  resetRoom,
  buildPublicRoomView,
} from '../../src/beat-the-bot-engine.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Cache-Control': 'no-store',
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

async function ensureTable(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS game_rooms (
      code TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      state_json TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  ).run();
}

async function loadRoom(db, code) {
  const row = await db.prepare('SELECT state_json FROM game_rooms WHERE code = ?1').bind(code).first();
  if (!row?.state_json) return null;
  try {
    return JSON.parse(row.state_json);
  } catch {
    return null;
  }
}

async function saveRoom(db, room) {
  await db.prepare(
    `INSERT INTO game_rooms (code, pack_id, phase, state_json, version, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(code) DO UPDATE SET
       pack_id = excluded.pack_id,
       phase = excluded.phase,
       state_json = excluded.state_json,
       version = excluded.version,
       updated_at = excluded.updated_at`,
  ).bind(
    room.code,
    room.packId,
    room.phase,
    JSON.stringify(room),
    room.version,
    room.createdAt,
    room.updatedAt,
  ).run();
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ request, env }) {
  const db = env?.LUKA_METRICS_DB;
  if (!db) return json({ ok: false, error: 'D1 binding unavailable' }, 503);
  await ensureTable(db);

  const url = new URL(request.url);
  const code = normalizeRoomCode(url.searchParams.get('code'));
  const playerId = url.searchParams.get('playerId') || null;
  if (!code) return json({ ok: false, error: 'code is required' }, 400);

  const room = await loadRoom(db, code);
  if (!room) return json({ ok: false, error: `Room ${code} not found` }, 404);
  return json({ ok: true, transport: 'cloudflare-d1', state: buildPublicRoomView(room, { playerId }) });
}

export async function onRequestPost({ request, env }) {
  const db = env?.LUKA_METRICS_DB;
  if (!db) return json({ ok: false, error: 'D1 binding unavailable' }, 503);
  await ensureTable(db);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const op = String(body.op || '').trim();

  if (op === 'create') {
    const room = createRoomState({
      code: body.code,
      packId: body.packId || 'earth-space-trivia',
      hostName: body.hostName || 'Mission Control',
    });
    await saveRoom(db, room);
    return json({ ok: true, transport: 'cloudflare-d1', state: buildPublicRoomView(room) });
  }

  const code = normalizeRoomCode(body.code);
  if (!code) return json({ ok: false, error: 'code is required' }, 400);
  const room = await loadRoom(db, code);
  if (!room) return json({ ok: false, error: `Room ${code} not found` }, 404);

  if (op === 'join') {
    const { player } = joinRoom(room, { playerId: body.playerId, name: body.name, avatar: body.avatar });
    await saveRoom(db, room);
    return json({ ok: true, player, state: buildPublicRoomView(room, { playerId: player.id }) });
  }

  if (op === 'answer') {
    const resAns = submitAnswer(room, { playerId: body.playerId, optionIndex: body.optionIndex });
    if (resAns.accepted) await saveRoom(db, room);
    return json({ ok: resAns.accepted, reason: resAns.reason || null, state: buildPublicRoomView(room, { playerId: body.playerId }) });
  }

  if (op === 'ask') {
    const item = submitAudienceQuestion(room, { author: body.author, text: body.text });
    if (!item) return json({ ok: false, error: 'Question text is required' }, 400);
    await saveRoom(db, room);
    return json({ ok: true, item, state: buildPublicRoomView(room) });
  }

  if (op === 'action') {
    switch (body.action) {
      case 'intro': startIntro(room); break;
      case 'next': startQuestion(room, body.index ?? null); break;
      case 'reveal': revealQuestion(room, { customReply: body.customReply || null, customGesture: body.customGesture || null }); break;
      case 'leaderboard': showLeaderboard(room); break;
      case 'qa': openQaMode(room); break;
      case 'finale': finishMission(room); break;
      case 'reset': resetRoom(room, { packId: body.packId || null }); break;
      case 'answer_qa': markAudienceQuestionAnswered(room, body.qaId, body.reply, body.gesture || 'explain'); break;
      default: return json({ ok: false, error: `Unknown action: ${body.action}` }, 400);
    }
    await saveRoom(db, room);
    return json({ ok: true, state: buildPublicRoomView(room) });
  }

  return json({ ok: false, error: `Unknown op: ${op}` }, 400);
}
