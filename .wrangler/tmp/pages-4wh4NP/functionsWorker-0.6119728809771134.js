var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../src/metrics-agg.mjs
var ALLOWED_APPS = /* @__PURE__ */ new Set(["hub", "luka-sim", "cockpit", "analytics"]);
var ALLOWED_ENVS = /* @__PURE__ */ new Set(["pages", "local"]);
var ALLOWED_CATEGORIES = /* @__PURE__ */ new Set([
  "nav",
  "speech",
  "motion",
  "vision",
  "safety",
  "trellis",
  "media",
  "perf",
  "error"
]);
var ALLOWED_EVENTS = /* @__PURE__ */ new Set([
  "app_view",
  "app_launch",
  "sim_boot",
  "gesture_play",
  "speech_turn",
  "vision_session",
  "vision_guard",
  "safety_profile",
  "safety_hold",
  "safety_packet_inspect",
  "safety_snapshot",
  "trellis_event",
  "head_pad_use",
  "hand_preset",
  "hand_calibrate",
  "recording_play",
  "reel_interaction",
  "camera_preset",
  "telemetry_connect",
  "runtime_error"
]);
var FORBIDDEN_META_KEYS = /* @__PURE__ */ new Set([
  "transcript",
  "text",
  "prompt",
  "reply",
  "message",
  "audio",
  "email",
  "ip",
  "token",
  "authorization",
  "cookie",
  "password",
  "secret"
]);
var MAX_BATCH_EVENTS = 40;
var MAX_META_BYTES = 1024;
function cleanStr(val, maxLen = 80) {
  if (typeof val !== "string") return "";
  return val.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLen);
}
__name(cleanStr, "cleanStr");
function sanitizeMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  let keys = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (keys >= 16) break;
    const key = cleanStr(k, 36);
    if (!key || FORBIDDEN_META_KEYS.has(key.toLowerCase())) continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = Math.round(v * 1e3) / 1e3;
      keys += 1;
    } else if (typeof v === "boolean") {
      out[key] = v;
      keys += 1;
    } else if (typeof v === "string") {
      out[key] = cleanStr(v, 96);
      keys += 1;
    } else if (Array.isArray(v)) {
      out[key] = v.slice(0, 8).map((item) => typeof item === "string" ? cleanStr(item, 48) : typeof item === "number" && Number.isFinite(item) ? item : null).filter((x) => x !== null);
      keys += 1;
    }
  }
  const encoded = JSON.stringify(out);
  if (encoded.length > MAX_META_BYTES) {
    return { truncated: true };
  }
  return out;
}
__name(sanitizeMeta, "sanitizeMeta");
function sanitizeEventBatch(body, { defaultEnv = "pages", nowMs = Date.now() } = {}) {
  const rawList = Array.isArray(body?.events) ? body.events : body && typeof body === "object" && body.event ? [body] : [];
  if (!rawList.length) {
    return { ok: false, error: "events array is required", events: [], rejected: 0 };
  }
  if (rawList.length > MAX_BATCH_EVENTS) {
    return { ok: false, error: `batch exceeds max ${MAX_BATCH_EVENTS} events`, events: [], rejected: rawList.length };
  }
  const minTs = nowMs - 7 * 86400 * 1e3;
  const maxTs = nowMs + 5 * 60 * 1e3;
  const events = [];
  let rejected = 0;
  for (const raw of rawList) {
    if (!raw || typeof raw !== "object") {
      rejected += 1;
      continue;
    }
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
    const label = cleanStr(raw.label ?? "", 80);
    const rawVal = raw.value;
    const value = typeof rawVal === "number" && Number.isFinite(rawVal) ? Math.round(rawVal * 1e3) / 1e3 : null;
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
      meta_json: JSON.stringify(meta)
    });
  }
  return { ok: events.length > 0, events, rejected };
}
__name(sanitizeEventBatch, "sanitizeEventBatch");
function inc(map, key, by = 1) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}
__name(inc, "inc");
function topEntries(map, limit = 12) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, count]) => ({ name, count }));
}
__name(topEntries, "topEntries");
function safeParseMeta(row) {
  if (row.meta && typeof row.meta === "object") return row.meta;
  try {
    return row.meta_json ? JSON.parse(row.meta_json) : {};
  } catch {
    return {};
  }
}
__name(safeParseMeta, "safeParseMeta");
function aggregateMetrics(rows, { days = 7, nowMs = Date.now() } = {}) {
  const safeDays = Math.max(1, Math.min(90, Math.round(Number(days) || 7)));
  const sinceMs = nowMs - safeDays * 86400 * 1e3;
  const filtered = (rows || []).filter((r) => Number(r.ts) >= sinceMs);
  const sessions = /* @__PURE__ */ new Set();
  const byApp = /* @__PURE__ */ new Map();
  const appLaunches = /* @__PURE__ */ new Map();
  const gestures = /* @__PURE__ */ new Map();
  const gestureSources = /* @__PURE__ */ new Map();
  const speechModes = /* @__PURE__ */ new Map();
  const llmProviders = /* @__PURE__ */ new Map();
  const ttsProviders = /* @__PURE__ */ new Map();
  const visionModes = /* @__PURE__ */ new Map();
  const visionGuardReasons = /* @__PURE__ */ new Map();
  const safetyProfiles = /* @__PURE__ */ new Map();
  const safetyClamps = /* @__PURE__ */ new Map();
  const trellisActions = /* @__PURE__ */ new Map();
  const recordings = /* @__PURE__ */ new Map();
  const renderers = /* @__PURE__ */ new Map();
  const dailyMap = /* @__PURE__ */ new Map();
  for (let i = safeDays - 1; i >= 0; i--) {
    const dayKey = new Date(nowMs - i * 86400 * 1e3).toISOString().slice(0, 10);
    dailyMap.set(dayKey, { day: dayKey, events: 0, sessions: /* @__PURE__ */ new Set(), turns: 0, gestures: 0 });
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
      bucket = { day: dayKey, events: 0, sessions: /* @__PURE__ */ new Set(), turns: 0, gestures: 0 };
      dailyMap.set(dayKey, bucket);
    }
    bucket.events += 1;
    bucket.sessions.add(r.session_id);
    switch (r.event) {
      case "app_launch":
        inc(appLaunches, r.label || meta.target || "unknown");
        break;
      case "sim_boot":
        if (meta.renderer) inc(renderers, String(meta.renderer));
        if (typeof r.value === "number" && r.value > 0 && r.value < 6e4) {
          bootMsSum += r.value;
          bootMsCount += 1;
        }
        break;
      case "gesture_play":
        inc(gestures, r.label || "unknown");
        if (meta.source) inc(gestureSources, String(meta.source));
        bucket.gestures += 1;
        break;
      case "speech_turn":
        speechTurns += 1;
        bucket.turns += 1;
        inc(speechModes, r.label || meta.mode || "text");
        if (meta.llm) inc(llmProviders, String(meta.llm));
        if (meta.tts) inc(ttsProviders, String(meta.tts));
        if (meta.gesture) inc(gestures, String(meta.gesture));
        if (typeof meta.asrMs === "number" && meta.asrMs > 0) {
          asrMsSum += meta.asrMs;
          asrMsCount += 1;
        }
        if (typeof meta.llmMs === "number" && meta.llmMs > 0) {
          llmMsSum += meta.llmMs;
          llmMsCount += 1;
        }
        if (typeof meta.claims === "number" && meta.claims > 0) {
          totalClaimsExtracted += meta.claims;
        }
        break;
      case "vision_session":
        visionSessions += 1;
        inc(visionModes, r.label || meta.source || "camera");
        if (typeof r.value === "number" && r.value > 0) {
          visionDurationSec += r.value;
        }
        break;
      case "vision_guard":
        visionGuardEvents += 1;
        inc(visionGuardReasons, r.label || meta.reason || "unknown");
        break;
      case "safety_profile":
        inc(safetyProfiles, r.label || "hardware");
        break;
      case "safety_hold":
        if (meta.enabled !== false) softHoldCount += 1;
        break;
      case "safety_packet_inspect":
        dryRunInspectCount += 1;
        break;
      case "safety_snapshot":
        if (typeof meta.fps === "number" && meta.fps > 0 && meta.fps <= 240) {
          fpsSum += meta.fps;
          fpsCount += 1;
        }
        if (typeof meta.peakSpeed === "number") peakSpeedMax = Math.max(peakSpeedMax, meta.peakSpeed);
        if (typeof meta.peakAccel === "number") peakAccelMax = Math.max(peakAccelMax, meta.peakAccel);
        if (typeof meta.wristLoadMax === "number") peakWristLoadMax = Math.max(peakWristLoadMax, meta.wristLoadMax);
        if (Array.isArray(meta.clamps)) {
          for (const c of meta.clamps) inc(safetyClamps, String(c));
        }
        break;
      case "trellis_event":
        inc(trellisActions, r.label || "commit");
        break;
      case "recording_play":
        inc(recordings, r.label || "unknown");
        break;
      case "runtime_error":
        errorCount += 1;
        break;
      default:
        break;
    }
  }
  const timeline = [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day)).map((b) => ({
    day: b.day,
    events: b.events,
    sessions: b.sessions.size,
    turns: b.turns,
    gestures: b.gestures
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
      errorCount
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
      avgLlmMs: llmMsCount ? Math.round(llmMsSum / llmMsCount) : null
    },
    vision: {
      modes: topEntries(visionModes, 8),
      guardReasons: topEntries(visionGuardReasons, 10),
      sessions: visionSessions,
      totalDurationSec: Math.round(visionDurationSec),
      guardTriggers: visionGuardEvents
    },
    safety: {
      profiles: topEntries(safetyProfiles, 6),
      topClamps: topEntries(safetyClamps, 12),
      softHoldCount,
      dryRunInspectCount,
      peakSpeedRadS: Number(peakSpeedMax.toFixed(2)),
      peakAccelRadS2: Number(peakAccelMax.toFixed(2)),
      peakWristLoadPct: Math.round(peakWristLoadMax)
    },
    trellis: {
      actions: topEntries(trellisActions, 10),
      totalClaimsExtracted
    },
    perf: {
      renderers: topEntries(renderers, 4),
      avgFps: fpsCount ? Math.round(fpsSum / fpsCount) : null,
      avgBootMs: bootMsCount ? Math.round(bootMsSum / bootMsCount) : null,
      recordings: topEntries(recordings, 8)
    }
  };
}
__name(aggregateMetrics, "aggregateMetrics");
function csvCell(v) {
  const s = v === null || v === void 0 ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
__name(csvCell, "csvCell");
function eventsToCsv(rows) {
  const header = "ts,iso,session_id,env,app,event,category,label,value,meta_json";
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
      r.label || "",
      r.value ?? "",
      r.meta_json || "{}"
    ].map(csvCell).join(","));
  }
  return `${lines.join("\n")}
`;
}
__name(eventsToCsv, "eventsToCsv");
function eventsToJsonl(rows) {
  return (rows || []).map((r) => JSON.stringify(r)).join("\n") + ((rows || []).length ? "\n" : "");
}
__name(eventsToJsonl, "eventsToJsonl");

// api/metrics/export.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store"
};
async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}
__name(onRequestOptions, "onRequestOptions");
async function onRequestGet(context) {
  const db = context.env?.LUKA_METRICS_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: "metrics_db_unbound" }), {
      status: 503,
      headers: { "Content-Type": "application/json", ...CORS }
    });
  }
  const url = new URL(context.request.url);
  const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get("days")) || 30)));
  const format = url.searchParams.get("format") === "csv" ? "csv" : "jsonl";
  const sinceMs = Date.now() - days * 86400 * 1e3;
  const { results } = await db.prepare(
    "SELECT ts, session_id, env, app, event, category, label, value, meta_json FROM events WHERE ts >= ? ORDER BY ts ASC LIMIT 50000"
  ).bind(sinceMs).all();
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  if (format === "csv") {
    return new Response(eventsToCsv(results || []), {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="luka-metrics-${stamp}.csv"`,
        ...CORS
      }
    });
  }
  return new Response(eventsToJsonl(results || []), {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="luka-metrics-${stamp}.jsonl"`,
      ...CORS
    }
  });
}
__name(onRequestGet, "onRequestGet");

// api/metrics/summary.js
var CORS2 = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS2 }
  });
}
__name(json, "json");
async function onRequestOptions2() {
  return new Response(null, { status: 204, headers: CORS2 });
}
__name(onRequestOptions2, "onRequestOptions");
async function onRequestGet2(context) {
  const db = context.env?.LUKA_METRICS_DB;
  if (!db) {
    return json({ ok: false, error: "metrics_db_unbound" }, 503);
  }
  const url = new URL(context.request.url);
  const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get("days")) || 7)));
  const nowMs = Date.now();
  const sinceMs = nowMs - days * 86400 * 1e3;
  const { results } = await db.prepare(
    "SELECT ts, session_id, env, app, event, category, label, value, meta_json FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 25000"
  ).bind(sinceMs).all();
  const summary = aggregateMetrics(results || [], { days, nowMs });
  return json({ ok: true, storage: "cloudflare-d1", ...summary });
}
__name(onRequestGet2, "onRequestGet");

// api/metrics.js
var CORS3 = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};
function json2(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS3 }
  });
}
__name(json2, "json");
async function onRequestOptions3() {
  return new Response(null, { status: 204, headers: CORS3 });
}
__name(onRequestOptions3, "onRequestOptions");
async function onRequestPost(context) {
  const db = context.env?.LUKA_METRICS_DB;
  if (!db) {
    return json2({ ok: false, error: "metrics_db_unbound" }, 503);
  }
  const rawText = await context.request.text();
  if (rawText.length > 32768) {
    return json2({ ok: false, error: "payload_too_large" }, 413);
  }
  let body;
  try {
    body = JSON.parse(rawText || "{}");
  } catch {
    return json2({ ok: false, error: "invalid_json" }, 400);
  }
  const parsed = sanitizeEventBatch(body, { defaultEnv: "pages", nowMs: Date.now() });
  if (!parsed.ok) {
    return json2({ ok: false, error: parsed.error || "no_valid_events", rejected: parsed.rejected }, 400);
  }
  const stmt = db.prepare(
    "INSERT INTO events (ts, session_id, env, app, event, category, label, value, meta_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const stmts = parsed.events.map(
    (e) => stmt.bind(e.ts, e.session_id, e.env, e.app, e.event, e.category, e.label, e.value, e.meta_json)
  );
  await db.batch(stmts);
  return json2({ ok: true, accepted: parsed.events.length, rejected: parsed.rejected }, 202);
}
__name(onRequestPost, "onRequestPost");

// ../.wrangler/tmp/pages-4wh4NP/functionsRoutes-0.08386911073915426.mjs
var routes = [
  {
    routePath: "/api/metrics/export",
    mountPath: "/api/metrics",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/api/metrics/export",
    mountPath: "/api/metrics",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions]
  },
  {
    routePath: "/api/metrics/summary",
    mountPath: "/api/metrics",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/api/metrics/summary",
    mountPath: "/api/metrics",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions2]
  },
  {
    routePath: "/api/metrics",
    mountPath: "/api",
    method: "OPTIONS",
    middlewares: [],
    modules: [onRequestOptions3]
  },
  {
    routePath: "/api/metrics",
    mountPath: "/api",
    method: "POST",
    middlewares: [],
    modules: [onRequestPost]
  }
];

// ../../.npm/_npx/c943b712072b77c4/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../.npm/_npx/c943b712072b77c4/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
