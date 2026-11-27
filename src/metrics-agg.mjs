// Shared privacy-first analytics schema, validation, aggregation, and export helpers.
// Zero Node/DOM dependencies so the exact same code runs in:
//   - Cloudflare Pages Functions (functions/api/metrics*.js)
//   - Local Node server (src/sim-api.mjs)
//   - Unit tests (tools/test-luka-sim.mjs)

export const ALLOWED_APPS = new Set(['hub', 'luka-sim', 'cockpit', 'analytics', 'beat-the-bot']);
export const ALLOWED_ENVS = new Set(['pages', 'local']);
export const ALLOWED_CATEGORIES = new Set([
  'nav',
  'speech',
  'motion',
  'vision',
  'safety',
  'trellis',
  'media',
  'game',
  'perf',
  'error',
]);

export const ALLOWED_EVENTS = new Set([
  'app_view',
  'app_launch',
  'sim_boot',
  'gesture_play',
  'speech_turn',
  'voice_interrupt',
  'vision_session',
  'vision_guard',
  'safety_profile',
  'safety_hold',
  'safety_packet_inspect',
  'safety_snapshot',
  'trellis_event',
  'head_pad_use',
  'hand_preset',
  'hand_calibrate',
  'recording_play',
  'reel_interaction',
  'game_event',
  'camera_preset',
  'telemetry_connect',
  'runtime_error',
]);

// Keys strictly forbidden inside metadata so raw speech/user text never leaks into analytics
const FORBIDDEN_META_KEYS = new Set([
  'transcript',
  'text',
  'prompt',
  'reply',
  'message',
  'audio',
  'email',
  'ip',
  'token',
  'authorization',
  'cookie',
  'password',
  'secret',
]);

export const MAX_BATCH_EVENTS = 40;
export const MAX_META_BYTES = 1024;

function cleanStr(val, maxLen = 80) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLen);
}

function sanitizeMeta(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  let keys = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (keys >= 16) break;
    const key = cleanStr(k, 36);
    if (!key || FORBIDDEN_META_KEYS.has(key.toLowerCase())) continue;
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = Math.round(v * 1000) / 1000;
      keys += 1;
    } else if (typeof v === 'boolean') {
      out[key] = v;
      keys += 1;
    } else if (typeof v === 'string') {
      out[key] = cleanStr(v, 96);
      keys += 1;
    } else if (Array.isArray(v)) {
      out[key] = v
        .slice(0, 8)
        .map((item) => (typeof item === 'string' ? cleanStr(item, 48) : (typeof item === 'number' && Number.isFinite(item) ? item : null)))
        .filter((x) => x !== null);
      keys += 1;
    }
  }
  const encoded = JSON.stringify(out);
  if (encoded.length > MAX_META_BYTES) {
    return { truncated: true };
  }
  return out;
}

/**
 * Validate and normalize an incoming batch payload `{ events: [...] }` (or single event).
 * Returns `{ ok, events, rejected }` with privacy-sanitized rows ready for D1 or JSONL storage.
 */
export function sanitizeEventBatch(body, { defaultEnv = 'pages', nowMs = Date.now() } = {}) {
  const rawList = Array.isArray(body?.events) ? body.events : (body && typeof body === 'object' && body.event ? [body] : []);
  if (!rawList.length) {
    return { ok: false, error: 'events array is required', events: [], rejected: 0 };
  }
  if (rawList.length > MAX_BATCH_EVENTS) {
    return { ok: false, error: `batch exceeds max ${MAX_BATCH_EVENTS} events`, events: [], rejected: rawList.length };
  }

  const minTs = nowMs - 7 * 86400 * 1000;
  const maxTs = nowMs + 5 * 60 * 1000;
  const events = [];
  let rejected = 0;

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') { rejected += 1; continue; }
    const app = cleanStr(raw.app, 24);
    const event = cleanStr(raw.event, 40);
    const category = cleanStr(raw.category, 24);
    const env = ALLOWED_ENVS.has(raw.env) ? raw.env : defaultEnv;
    const sessionId = cleanStr(raw.session_id || raw.sessionId, 48);

    if (!ALLOWED_APPS.has(app) || !ALLOWED_EVENTS.has(event) || !ALLOWED_CATEGORIES.has(category) || !sessionId) {
      rejected += 1;
      continue;
    }

    const rawTs = Number(raw.ts);
    const ts = Number.isFinite(rawTs) && rawTs >= minTs && rawTs <= maxTs ? Math.round(rawTs) : nowMs;
    const label = cleanStr(raw.label ?? '', 80);
    const rawVal = raw.value;
    const value = typeof rawVal === 'number' && Number.isFinite(rawVal) ? Math.round(rawVal * 1000) / 1000 : null;
    const meta = sanitizeMeta(raw.meta);

    events.push({
      ts,
      session_id: sessionId,
      env,
      app,
      event,
      category,
      label,
      value,
      meta_json: JSON.stringify(meta),
    });
  }

  return { ok: events.length > 0, events, rejected };
}

function inc(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

function topEntries(map, limit = 12) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function safeParseMeta(row) {
  if (row.meta && typeof row.meta === 'object') return row.meta;
  try {
    return row.meta_json ? JSON.parse(row.meta_json) : {};
  } catch {
    return {};
  }
}

/**
 * Aggregate an array of sanitized event rows into actionable robotics, voice, vision,
 * safety-envelope, and UX learning insights.
 */
export function aggregateMetrics(rows, { days = 7, nowMs = Date.now() } = {}) {
  const safeDays = Math.max(1, Math.min(90, Math.round(Number(days) || 7)));
  const sinceMs = nowMs - safeDays * 86400 * 1000;
  const filtered = (rows || []).filter((r) => Number(r.ts) >= sinceMs);

  const sessions = new Set();
  const byApp = new Map();
  const appLaunches = new Map();
  const gestures = new Map();
  const gestureSources = new Map();
  const speechModes = new Map();
  const llmProviders = new Map();
  const ttsProviders = new Map();
  const visionModes = new Map();
  const visionGuardReasons = new Map();
  const safetyProfiles = new Map();
  const safetyClamps = new Map();
  const trellisActions = new Map();
  const recordings = new Map();
  const renderers = new Map();
  const dailyMap = new Map();

  // Pre-seed daily buckets so timeline charts have continuous days
  for (let i = safeDays - 1; i >= 0; i--) {
    const dayKey = new Date(nowMs - i * 86400 * 1000).toISOString().slice(0, 10);
    dailyMap.set(dayKey, { day: dayKey, events: 0, sessions: new Set(), turns: 0, gestures: 0 });
  }

  let speechTurns = 0;
  let asrMsSum = 0;
  let asrMsCount = 0;
  let llmMsSum = 0;
  let llmMsCount = 0;
  let totalClaimsExtracted = 0;

  let fpsSum = 0;
  let fpsCount = 0;
  let bootMsSum = 0;
  let bootMsCount = 0;

  let softHoldCount = 0;
  let dryRunInspectCount = 0;
  let peakSpeedMax = 0;
  let peakAccelMax = 0;
  let peakWristLoadMax = 0;

  let visionSessions = 0;
  let visionDurationSec = 0;
  let visionGuardEvents = 0;
  let errorCount = 0;

  for (const r of filtered) {
    const meta = safeParseMeta(r);
    sessions.add(r.session_id);
    inc(byApp, r.app);

    const dayKey = new Date(Number(r.ts)).toISOString().slice(0, 10);
    let bucket = dailyMap.get(dayKey);
    if (!bucket) {
      bucket = { day: dayKey, events: 0, sessions: new Set(), turns: 0, gestures: 0 };
      dailyMap.set(dayKey, bucket);
    }
    bucket.events += 1;
    bucket.sessions.add(r.session_id);

    switch (r.event) {
      case 'app_launch':
        inc(appLaunches, r.label || meta.target || 'unknown');
        break;
      case 'sim_boot':
        if (meta.renderer) inc(renderers, String(meta.renderer));
        if (typeof r.value === 'number' && r.value > 0 && r.value < 60000) {
          bootMsSum += r.value;
          bootMsCount += 1;
        }
        break;
      case 'gesture_play':
        inc(gestures, r.label || 'unknown');
        if (meta.source) inc(gestureSources, String(meta.source));
        bucket.gestures += 1;
        break;
      case 'speech_turn':
        speechTurns += 1;
        bucket.turns += 1;
        inc(speechModes, r.label || meta.mode || 'text');
        if (meta.llm) inc(llmProviders, String(meta.llm));
        if (meta.tts) inc(ttsProviders, String(meta.tts));
        if (meta.gesture) inc(gestures, String(meta.gesture));
        if (typeof meta.asrMs === 'number' && meta.asrMs > 0) {
          asrMsSum += meta.asrMs;
          asrMsCount += 1;
        }
        if (typeof meta.llmMs === 'number' && meta.llmMs > 0) {
          llmMsSum += meta.llmMs;
          llmMsCount += 1;
        }
        if (typeof meta.claims === 'number' && meta.claims > 0) {
          totalClaimsExtracted += meta.claims;
        }
        break;
      case 'vision_session':
        visionSessions += 1;
        inc(visionModes, r.label || meta.source || 'camera');
        if (typeof r.value === 'number' && r.value > 0) {
          visionDurationSec += r.value;
        }
        break;
      case 'vision_guard':
        visionGuardEvents += 1;
        inc(visionGuardReasons, r.label || meta.reason || 'unknown');
        break;
      case 'safety_profile':
        inc(safetyProfiles, r.label || 'hardware');
        break;
      case 'safety_hold':
        if (meta.enabled !== false) softHoldCount += 1;
        break;
      case 'safety_packet_inspect':
        dryRunInspectCount += 1;
        break;
      case 'safety_snapshot':
        if (typeof meta.fps === 'number' && meta.fps > 0 && meta.fps <= 240) {
          fpsSum += meta.fps;
          fpsCount += 1;
        }
        if (typeof meta.peakSpeed === 'number') peakSpeedMax = Math.max(peakSpeedMax, meta.peakSpeed);
        if (typeof meta.peakAccel === 'number') peakAccelMax = Math.max(peakAccelMax, meta.peakAccel);
        if (typeof meta.wristLoadMax === 'number') peakWristLoadMax = Math.max(peakWristLoadMax, meta.wristLoadMax);
        if (Array.isArray(meta.clamps)) {
          for (const c of meta.clamps) inc(safetyClamps, String(c));
        }
        break;
      case 'trellis_event':
        inc(trellisActions, r.label || 'commit');
        break;
      case 'recording_play':
        inc(recordings, r.label || 'unknown');
        break;
      case 'runtime_error':
        errorCount += 1;
        break;
      default:
        break;
    }
  }

  const timeline = [...dailyMap.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((b) => ({
      day: b.day,
      events: b.events,
      sessions: b.sessions.size,
      turns: b.turns,
      gestures: b.gestures,
    }));

  const totalGestures = [...gestures.values()].reduce((acc, n) => acc + n, 0);

  return {
    windowDays: safeDays,
    sinceIso: new Date(sinceMs).toISOString(),
    generatedAt: new Date(nowMs).toISOString(),
    overview: {
      totalEvents: filtered.length,
      uniqueSessions: sessions.size,
      speechTurns,
      gesturesPlayed: totalGestures,
      visionSessions,
      visionDurationSec: Math.round(visionDurationSec),
      visionGuardEvents,
      softHoldCount,
      dryRunInspectCount,
      totalClaimsExtracted,
      avgFps: fpsCount ? Math.round(fpsSum / fpsCount) : null,
      avgBootMs: bootMsCount ? Math.round(bootMsSum / bootMsCount) : null,
      avgAsrMs: asrMsCount ? Math.round(asrMsSum / asrMsCount) : null,
      avgLlmMs: llmMsCount ? Math.round(llmMsSum / llmMsCount) : null,
      errorCount,
    },
    timeline,
    apps: topEntries(byApp, 10),
    appLaunches: topEntries(appLaunches, 10),
    gestures: topEntries(gestures, 15),
    gestureSources: topEntries(gestureSources, 6),
    speech: {
      modes: topEntries(speechModes, 8),
      llmProviders: topEntries(llmProviders, 8),
      ttsProviders: topEntries(ttsProviders, 8),
      avgAsrMs: asrMsCount ? Math.round(asrMsSum / asrMsCount) : null,
      avgLlmMs: llmMsCount ? Math.round(llmMsSum / llmMsCount) : null,
    },
    vision: {
      modes: topEntries(visionModes, 8),
      guardReasons: topEntries(visionGuardReasons, 10),
      sessions: visionSessions,
      totalDurationSec: Math.round(visionDurationSec),
      guardTriggers: visionGuardEvents,
    },
    safety: {
      profiles: topEntries(safetyProfiles, 6),
      topClamps: topEntries(safetyClamps, 12),
      softHoldCount,
      dryRunInspectCount,
      peakSpeedRadS: Number(peakSpeedMax.toFixed(2)),
      peakAccelRadS2: Number(peakAccelMax.toFixed(2)),
      peakWristLoadPct: Math.round(peakWristLoadMax),
    },
    trellis: {
      actions: topEntries(trellisActions, 10),
      totalClaimsExtracted,
    },
    perf: {
      renderers: topEntries(renderers, 4),
      avgFps: fpsCount ? Math.round(fpsSum / fpsCount) : null,
      avgBootMs: bootMsCount ? Math.round(bootMsSum / bootMsCount) : null,
      recordings: topEntries(recordings, 8),
    },
  };
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function eventsToCsv(rows) {
  const header = 'ts,iso,session_id,env,app,event,category,label,value,meta_json';
  const lines = [header];
  for (const r of rows || []) {
    lines.push([
      r.ts,
      new Date(Number(r.ts)).toISOString(),
      r.session_id,
      r.env,
      r.app,
      r.event,
      r.category,
      r.label || '',
      r.value ?? '',
      r.meta_json || '{}',
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export function eventsToJsonl(rows) {
  return (rows || []).map((r) => JSON.stringify(r)).join('\n') + ((rows || []).length ? '\n' : '');
}
