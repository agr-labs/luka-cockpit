// Server-side API for Luka Upper-Body Sim:
//   - Local Whisper ASR (/sim-api/transcribe)
//   - Embodied Reasoning with Trellis compiled context (/sim-api/reason)
//   - Inworld + macOS Say TTS returning WAV for browser WebAudio playback (/sim-api/tts)
//   - Voice listing + profile persistence (/sim-api/voices, /sim-api/voice-profile)
//   - Durable Trellis TRP-1 store persistence (/sim-api/trellis/state, /sim-api/trellis/sync)
//   - Local MediaPipe Vision WASM + bundle serving (/mediapipe/*)
//
// Physical robot write paths remain 100% closed in serve.mjs; nothing here
// sends motion commands to hardware.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, appendFile, mkdir, rename, unlink, stat, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { sanitizeEventBatch, aggregateMetrics, eventsToCsv, eventsToJsonl } from './metrics-agg.mjs';

const execFileP = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VOICE_PROFILE_PATH = join(ROOT, 'config', 'luka-voice.json');
const TRELLIS_DISK_PATH = join(ROOT, '.luka-trellis-store.json');
const METRICS_DIR = join(ROOT, 'data', 'metrics');
const METRICS_FILE = join(METRICS_DIR, 'events.jsonl');

const MEDIAPIPE_ROOTS = [
  process.env.MEDIAPIPE_ROOT,
  join(os.homedir(), 'kameyoko', 'node_modules', '@mediapipe', 'tasks-vision'),
  join(ROOT, 'vendor', 'mediapipe'),
].filter(Boolean);

const POSELAB_ENV_CANDIDATES = [
  process.env.LUKA_ENV_FILE,
  join(ROOT, '.env.local'),
  join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'pose-lab', '.env.local'),
].filter(Boolean);

// Load local credentials server-side only (real env vars win).
async function loadEnvFiles() {
  for (const envPath of POSELAB_ENV_CANDIDATES) {
    try {
      const raw = await readFile(envPath, 'utf8');
      for (const lineRaw of raw.split('\n')) {
        const line = lineRaw.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const eq = line.indexOf('=');
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (key && !(key in process.env)) process.env[key] = val;
      }
    } catch {
      /* ignore missing optional env file */
    }
  }
}

await loadEnvFiles();

const ASR_CACHE_DIR = process.env.POSELAB_VOICE_CACHE || join(os.homedir(), '.cache', 'poselab-voice');
const ASR_MODEL_NAME = process.env.POSELAB_ASR_MODEL || 'ggml-base.en.bin';
const ASR_MODEL_PATH = join(ASR_CACHE_DIR, ASR_MODEL_NAME);

const PRISM_KEY = (process.env.PRISM_API_KEY || '').trim();
const PRISM_BASE = (process.env.PRISM_BASE || 'https://api.prisminference.com/v1').replace(/\/$/, '');
const PRISM_MODEL = (process.env.PRISM_MODEL || 'deepseek-v4.1-flash').trim();

const INWORLD_KEY = (process.env.INWORLD_API_KEY || '').trim();
const INWORLD_BASE = (process.env.INWORLD_BASE || 'https://api.inworld.ai').replace(/\/$/, '');
const INWORLD_LLM_URL = `${INWORLD_BASE}/v1`;
const INWORLD_LLM_MODEL = (process.env.INWORLD_LLM_MODEL || 'inworld/models/deepseek-v4.1-flash-1017').trim();
const INWORLD_TTS_URL = `${INWORLD_BASE}/tts/v1/voice`;
const INWORLD_VOICES_URL = `${INWORLD_BASE}/tts/v1/voices`;

const LOCAL_LLM_URL = (process.env.POSELAB_LLM_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
const LOCAL_LLM_MODEL = (process.env.POSELAB_LLM_MODEL || 'qwen2.5:1.5b').trim();

const INWORLD_CURATED = [
  'Grayson', 'Blake', 'Ashley', 'Daniel', 'Oliver', 'Marcus', 'Arthur', 'Jonah',
  'Vincent', 'Callum', 'Serena', 'Chloe', 'Eleanor', 'Hazel', 'Mia', 'Nadia', 'Sarah',
];

let voiceProfile = {
  id: 'luka-grayson-v1',
  provider: 'inworld',
  model: 'inworld-tts-2',
  voice: 'Grayson',
  rate: 0.92,
  pitch: -2,
  pitchUnit: 'semitones',
};

try {
  const loaded = JSON.parse(await readFile(VOICE_PROFILE_PATH, 'utf8'));
  voiceProfile = { ...voiceProfile, ...loaded };
} catch {
  /* use defaults */
}

let inworldVoiceCache = null;
let sayVoiceCache = null;

async function fileExists(p) {
  try {
    await access(p, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichBin(names) {
  for (const name of names) {
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']) {
      const full = join(dir, name);
      if (await fileExists(full)) return full;
    }
    try {
      const { stdout } = await execFileP('which', [name]);
      const p = stdout.trim();
      if (p) return p;
    } catch {
      /* continue */
    }
  }
  return null;
}

const WHISPER_BIN = await whichBin(['whisper-cli', 'whisper-cpp']);
const SAY_BIN = await whichBin(['say']);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req, maxBytes = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, maxBytes = 512 * 1024) {
  const buf = await readBody(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

/* --------------------------------------------------------------------- ASR */

async function transcribeWav(wavBuffer) {
  if (!WHISPER_BIN) throw new Error('whisper-cli is not installed on this Mac');
  if (!(await fileExists(ASR_MODEL_PATH))) throw new Error(`ASR model not found at ${ASR_MODEL_PATH}`);
  if (wavBuffer.length < 44 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw Object.assign(new Error('Upload must be a 16 kHz mono WAV recording'), { status: 400 });
  }

  const stem = join(os.tmpdir(), `luka-sim-asr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  const wavPath = `${stem}.wav`;
  const jsonPath = `${stem}.json`;
  const started = performance.now();
  try {
    await writeFile(wavPath, wavBuffer);
    const { stdout } = await execFileP(
      WHISPER_BIN,
      [
        '-m', ASR_MODEL_PATH,
        '-f', wavPath,
        '-of', stem,
        '-oj', '-np', '-nt',
        '-l', 'en',
        '--prompt', 'Luka, AgiBot, Steadwell, Kameyoko, Trellis.',
        '-t', String(Math.min(8, os.cpus().length || 4)),
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    let transcript = '';
    try {
      const parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
      transcript = (parsed.transcription || []).map((s) => String(s.text || '')).join(' ').trim();
    } catch {
      transcript = String(stdout || '').trim();
    }
    if (!transcript && stdout) {
      transcript = String(stdout).trim();
    }
    transcript = transcript
      .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE|APPLAUSE|LAUGHTER)\]/gi, '')
      .replace(/\((?:silence|music|noise|inaudible|applause|laughter|sighs?|beeps?)\)/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      transcript,
      asr_ms: Math.round(performance.now() - started),
    };
  } finally {
    await Promise.all([
      unlink(wavPath).catch(() => {}),
      unlink(jsonPath).catch(() => {}),
      unlink(`${wavPath}.json`).catch(() => {}),
    ]);
  }
}

/* --------------------------------------------------------------------- LLM */

const BUILTIN_GESTURES = [
  'wave', 'explain', 'nod', 'shake_no', 'look_around', 'think', 'point_left', 'point_right',
  'inspect', 'welcome', 'guard', 'celebrate', 'open_hands', 'listen', 'rest',
];

function buildEmbodiedSystemPrompt({ trellisContext, activeSkills, trackingSummary }) {
  const skillNames = (activeSkills || [])
    .map((s) => (typeof s === 'string' ? s : `${s.name}: ${s.description || ''}`))
    .slice(0, 12);

  const lines = [
    'You are Luka, an AgiBot A2 Ultra humanoid robot speaking out loud in your interactive upper-body digital twin studio at Steadwell / AGR Labs.',
    'You have a glossy black sensor head with an interactive OLED visor, a pearl-white and gunmetal upper torso, two 7-DOF arms, and articulated Inspire RH56 dexterous hands.',
    'Respond warmly, clearly, and naturally in 1 to 3 concise spoken sentences (under 55 words). Never use markdown, bullet lists, asterisks, or emoji because your words are spoken aloud.',
    'At the very start of your reply, emit ONE embodied control tag on the same line, then a space, then your spoken reply:',
    `  [GESTURE:<name>] where <name> is one of: ${BUILTIN_GESTURES.join(', ')}`,
    'Or if an emergent/taught embodied skill matches what the user asks, emit: [SKILL:<skill_name>]',
    'Example: [GESTURE:wave] Hey there, great to see you. My arms and neck are online and ready whenever you want to test a motion.',
    'Ground your answers in the Trellis Memory Context below when recalling people, projects, commitments, or past observations. If something is not in memory, say so honestly instead of inventing it.',
  ];

  if (skillNames.length) {
    lines.push('\n[ACTIVE EMBODIED & EMERGENT SKILLS]\n' + skillNames.map((s) => `- ${s}`).join('\n'));
  }
  if (trackingSummary) {
    lines.push(`\n[LIVE KAMEYOKO VISION & POSE STATE]\n${trackingSummary}`);
  }
  if (trellisContext) {
    lines.push(`\n[TRELLIS COMPILED MEMORY CONTEXT]\n${trellisContext}`);
  }
  return lines.join('\n');
}

function parseEmbodiedDirective(rawReply, activeSkills = []) {
  let text = String(rawReply || '').trim();
  let gesture = null;
  let invokedSkill = null;

  const skillMatch = text.match(/^\s*\[SKILL:([a-zA-Z0-9_.-]+)\]\s*/i);
  if (skillMatch) {
    invokedSkill = skillMatch[1].toLowerCase();
    text = text.slice(skillMatch[0].length).trim();
  }

  const gestMatch = text.match(/^\s*\[GESTURE:([a-zA-Z0-9_-]+)\]\s*/i);
  if (gestMatch) {
    const candidate = gestMatch[1].toLowerCase();
    if (BUILTIN_GESTURES.includes(candidate)) gesture = candidate;
    text = text.slice(gestMatch[0].length).trim();
  }

  // Strip any stray bracketed stage directions the model might emit.
  text = text.replace(/\[(GESTURE|SKILL):[^\]]+\]/gi, '').replace(/\s+/g, ' ').trim();

  // Heuristic gesture inference if model didn't emit a directive.
  if (!gesture && !invokedSkill) {
    const lower = text.toLowerCase();
    if (/\b(hello|hi|hey|welcome|great to see|good morning|good afternoon|goodbye|bye)\b/.test(lower)) gesture = 'wave';
    else if (/\b(no\b|nope|don't|cannot|can't|disagree|not yet|unfortunately)\b/.test(lower)) gesture = 'shake_no';
    else if (/\b(scan|look around|room|surroundings|checking left and right)\b/.test(lower)) gesture = 'look_around';
    else if (/\b(yes|sure|got it|understood|agreed|absolutely|remembered|saved|anchored)\b/.test(lower)) gesture = 'nod';
    else if (/\b(let me think|interesting|consider|analyzing|compiling|checking)\b/.test(lower)) gesture = 'think';
    else if (/\b(look|check|hands|fingers|dexterous|grip)\b/.test(lower)) gesture = 'inspect';
    else if (/\b(awesome|amazing|celebrate|power|ready to cook|let's go)\b/.test(lower)) gesture = 'celebrate';
    else if (/\b(left|over here)\b/.test(lower)) gesture = 'point_left';
    else if (/\b(right|over there)\b/.test(lower)) gesture = 'point_right';
    else if (/\b(guard|defense|brace|careful|safe)\b/.test(lower)) gesture = 'guard';
    else gesture = 'explain';
  }

  // Check if the reply mentions an emergent custom skill by name.
  if (!invokedSkill && Array.isArray(activeSkills)) {
    const lower = text.toLowerCase();
    for (const s of activeSkills) {
      if (s?.source === 'emergent' && s.name && lower.includes(s.name.replace(/_/g, ' '))) {
        invokedSkill = s.name;
        break;
      }
    }
  }

  return { reply: text, gesture, invokedSkill };
}

function localEmbodiedFallback(userText, { activeSkills = [], trellisSummary = '' } = {}) {
  const lower = userText.toLowerCase();

  for (const s of activeSkills) {
    if (!s?.name) continue;
    const triggerWords = [s.name.replace(/_/g, ' '), ...(s.triggerPhrases || [])].map((t) => String(t).toLowerCase());
    if (triggerWords.some((t) => t && lower.includes(t))) {
      return {
        reply: `Running my ${s.name.replace(/_/g, ' ')} skill right now.`,
        gesture: s.gesture || 'explain',
        invokedSkill: s.name,
        llm: 'local-fallback',
        model: 'embodied-router',
      };
    }
  }

  if (/\b(hello|hi|hey|what'?s up|good morning|good afternoon)\b/.test(lower)) {
    return {
      reply: 'Hey! I am Luka. My upper body, arms, hands, and Trellis memory are all online. What should we work on together?',
      gesture: 'wave',
      invokedSkill: null,
      llm: 'local-fallback',
      model: 'embodied-router',
    };
  }
  if (/\b(wave|say hi|greet)\b/.test(lower)) {
    return {
      reply: 'Waving hello! My right shoulder, elbow, and wrist are moving smoothly.',
      gesture: 'wave',
      invokedSkill: null,
      llm: 'local-fallback',
      model: 'embodied-router',
    };
  }
  if (/\b(inspect|show.*hand|finger)\b/.test(lower)) {
    return {
      reply: 'Bringing both Inspire hands up so you can inspect the finger articulation.',
      gesture: 'inspect',
      invokedSkill: null,
      llm: 'local-fallback',
      model: 'embodied-router',
    };
  }
  if (/\b(guard|ready|stance)\b/.test(lower)) {
    return {
      reply: 'Moving into a balanced upper-body ready guard posture.',
      gesture: 'guard',
      invokedSkill: null,
      llm: 'local-fallback',
      model: 'embodied-router',
    };
  }
  if (/\b(power|kamehameha|celebrate|cook)\b/.test(lower)) {
    return {
      reply: 'Powering up! Arms locked and ready to cook in the digital twin.',
      gesture: 'celebrate',
      invokedSkill: null,
      llm: 'local-fallback',
      model: 'embodied-router',
    };
  }
  if (/\b(remember|who|what do you know|memory|trellis|context)\b/.test(lower) && trellisSummary) {
    return {
      reply: `Checking my Trellis memory graph now. ${trellisSummary}`,
      gesture: 'think',
      invokedSkill: 'trellis_recall',
      llm: 'local-fallback',
      model: 'embodied-router',
    };
  }
  return {
    reply: `I heard you say "${userText.slice(0, 80)}". I anchored that into my Trellis working memory and I am ready for your next command.`,
    gesture: 'explain',
    invokedSkill: null,
    llm: 'local-fallback',
    model: 'embodied-router',
  };
}

const LLM_CONFIGS = {
  prism: {
    name: 'prism',
    label: 'Prism',
    base: PRISM_BASE,
    model: PRISM_MODEL,
    authHeader: () => (PRISM_KEY ? `Bearer ${PRISM_KEY}` : null),
    configured: () => Boolean(PRISM_KEY),
  },
  inworld: {
    name: 'inworld',
    label: 'Inworld',
    base: INWORLD_LLM_URL,
    model: INWORLD_LLM_MODEL,
    authHeader: () => (INWORLD_KEY ? `Basic ${INWORLD_KEY}` : null),
    configured: () => Boolean(INWORLD_KEY),
  },
  local: {
    name: 'local',
    label: 'Local Ollama',
    base: LOCAL_LLM_URL,
    model: LOCAL_LLM_MODEL,
    authHeader: () => null,
    configured: () => true,
  },
};

const LLM_PRIORITY = ['prism', 'inworld', 'local'];

async function callOpenAiCompatible(cfg, messages) {
  const headers = { 'content-type': 'application/json' };
  const auth = cfg.authHeader();
  if (auth) headers.authorization = auth;

  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: 0.65,
      max_tokens: 700,
      stream: false,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error?.message || body.message || `${cfg.label} HTTP ${res.status}`);
  const msg = body.choices?.[0]?.message || {};
  const content = msg.content != null ? String(msg.content).trim() : '';
  if (!content) throw new Error(`${cfg.label} returned empty content`);
  return content;
}

async function runReasoning({ text, history = [], llm, trellisContext = '', trellisSummary = '', activeSkills = [], trackingSummary = '' }) {
  const started = performance.now();
  const sys = buildEmbodiedSystemPrompt({ trellisContext, activeSkills, trackingSummary });
  const messages = [{ role: 'system', content: sys }];
  for (const turn of history.slice(-8)) {
    if (['user', 'assistant'].includes(turn?.role) && typeof turn.content === 'string' && turn.content.trim()) {
      messages.push({ role: turn.role, content: turn.content.slice(0, 1200) });
    }
  }
  messages.push({ role: 'user', content: text });

  const order = [];
  if (llm && LLM_CONFIGS[llm] && LLM_CONFIGS[llm].configured()) order.push(llm);
  for (const name of LLM_PRIORITY) {
    if (!order.includes(name) && LLM_CONFIGS[name].configured()) order.push(name);
  }

  let lastError = null;
  for (const name of order) {
    const cfg = LLM_CONFIGS[name];
    try {
      const raw = await callOpenAiCompatible(cfg, messages);
      const parsed = parseEmbodiedDirective(raw, activeSkills);
      return {
        ok: true,
        reply: parsed.reply || 'I am here and listening.',
        gesture: parsed.gesture,
        invokedSkill: parsed.invokedSkill,
        llm: name,
        model: cfg.model,
        timings: { llm_ms: Math.round(performance.now() - started) },
      };
    } catch (err) {
      lastError = err;
    }
  }

  const fb = localEmbodiedFallback(text, { activeSkills, trellisSummary });
  return {
    ok: true,
    ...fb,
    fallbackNote: lastError ? String(lastError.message || lastError) : 'No live LLM reachable',
    timings: { llm_ms: Math.round(performance.now() - started) },
  };
}

/* --------------------------------------------------------------------- TTS */

async function listInworldVoices() {
  if (inworldVoiceCache) return inworldVoiceCache;
  if (!INWORLD_KEY) return [];
  const res = await fetch(INWORLD_VOICES_URL, {
    headers: { authorization: `Basic ${INWORLD_KEY}` },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Inworld voices ${res.status}`);
  const en = (data.voices || []).filter((v) => (v.languages || []).includes('en'));
  const byId = new Map(en.map((v) => [v.voiceId, v]));
  const curated = INWORLD_CURATED.map((id) => byId.get(id)).filter(Boolean);
  const list = (curated.length ? curated : en).map((v) => ({
    name: v.voiceId,
    label: v.displayName || v.voiceId,
    provider: 'inworld',
    description: v.description || '',
  }));
  inworldVoiceCache = list;
  return list;
}

async function listSayVoices() {
  if (sayVoiceCache) return sayVoiceCache;
  if (!SAY_BIN) return [];
  const { stdout } = await execFileP(SAY_BIN, ['-v', '?']);
  const out = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2 || !/^[a-z]{2}_[A-Z]{2}$/.test(parts[1])) continue;
    if (!parts[1].startsWith('en_')) continue;
    out.push({ name: parts[0], label: `${parts[0]} (${parts[1]})`, provider: 'say', description: (parts[2] || '').replace(/^#\s*/, '') });
  }
  sayVoiceCache = out;
  return out;
}

async function synthesizeInworldWav(text, voice, rate, pitch) {
  if (!INWORLD_KEY) throw new Error('INWORLD_API_KEY is not configured');
  const v = voice || voiceProfile.voice || 'Grayson';
  const r = Math.max(0.5, Math.min(1.5, Number(rate ?? voiceProfile.rate) || 0.92));
  const pRaw = Number(pitch ?? voiceProfile.pitch);
  const p = Number.isFinite(pRaw) ? Math.max(-12, Math.min(12, pRaw)) : -2;
  const modelId = process.env.INWORLD_TTS_MODEL || voiceProfile.model || 'inworld-tts-2';

  const res = await fetch(INWORLD_TTS_URL, {
    method: 'POST',
    headers: { authorization: `Basic ${INWORLD_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      voiceId: v,
      modelId,
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: r, pitch: p },
      deliveryMode: 'STABLE',
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Inworld TTS HTTP ${res.status}`);
  if (!data.audioContent) throw new Error('Inworld returned empty audioContent');
  return {
    audioBase64: data.audioContent,
    provider: 'inworld',
    voice: v,
    model: modelId,
    rate: r,
    pitch: p,
  };
}

async function synthesizeSayWav(text, voice, rate) {
  if (!SAY_BIN) throw new Error('macOS say binary unavailable');
  const v = voice && /^[A-Za-z][A-Za-z0-9 .'()_-]{0,50}$/.test(voice) ? voice : 'Daniel';
  const r = Math.max(100, Math.min(300, Math.round((Number(rate) || 1) * 190)));
  const wavPath = join(os.tmpdir(), `luka-sim-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
  try {
    await execFileP(SAY_BIN, ['-v', v, '-r', String(r), '-o', wavPath, '--data-format=LEI16@22050', text], { timeout: 45_000 });
    const wav = await readFile(wavPath);
    return {
      audioBase64: wav.toString('base64'),
      provider: 'say',
      voice: v,
      model: 'macos-say',
      rate: Number(rate) || 1,
      pitch: 0,
    };
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}

async function synthesizeSpeech({ text, provider, voice, rate, pitch }) {
  const started = performance.now();
  const clean = String(text || '').trim();
  if (!clean) throw Object.assign(new Error('text is required'), { status: 400 });
  if (clean.length > 2000) throw Object.assign(new Error('text too long'), { status: 400 });

  const want = provider || (INWORLD_KEY ? 'inworld' : 'say');
  let result;
  if (want === 'inworld' && INWORLD_KEY) {
    try {
      result = await synthesizeInworldWav(clean, voice, rate, pitch);
    } catch (err) {
      if (SAY_BIN) {
        result = await synthesizeSayWav(clean, 'Daniel', 1);
        result.fallbackFrom = `inworld (${err.message})`;
      } else {
        throw err;
      }
    }
  } else {
    result = await synthesizeSayWav(clean, want === 'say' ? voice : 'Daniel', rate || 1);
  }

  return {
    ok: true,
    mime: 'audio/wav',
    ...result,
    timings: { tts_ms: Math.round(performance.now() - started) },
  };
}

/* ------------------------------------------------------- Durable Trellis */

async function readTrellisDisk() {
  try {
    const raw = await readFile(TRELLIS_DISK_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeTrellisDisk(payload) {
  const tmp = `${TRELLIS_DISK_PATH}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2));
  await rename(tmp, TRELLIS_DISK_PATH);
}

/* ----------------------------------------------------- Local Metrics Log */

async function appendMetricsLocal(events) {
  await mkdir(METRICS_DIR, { recursive: true });
  const lines = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
  await appendFile(METRICS_FILE, lines, 'utf8');
}

async function readMetricsLocal(sinceMs = 0) {
  try {
    const raw = await readFile(METRICS_FILE, 'utf8');
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (Number(row.ts) >= sinceMs) out.push(row);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/* ----------------------------------------------------- Health + MediaPipe */

async function checkOllamaReady() {
  try {
    const res = await fetch(`${LOCAL_LLM_URL}/models`, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return { ready: false, note: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.data || []).map((m) => m.id);
    return { ready: models.includes(LOCAL_LLM_MODEL), models, note: models.includes(LOCAL_LLM_MODEL) ? null : `${LOCAL_LLM_MODEL} not pulled` };
  } catch {
    return { ready: false, note: 'Ollama not running' };
  }
}

async function resolveMediapipePath(relPath) {
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  for (const root of MEDIAPIPE_ROOTS) {
    const full = join(root, clean);
    if (full.startsWith(root) && (await fileExists(full))) return full;
  }
  return null;
}

const MP_MIME = {
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
};

export async function handleSimApi(req, res, url) {
  // Serve local MediaPipe tasks-vision bundle and WASM runtime so Kameyoko-style
  // pose + hand tracking works locally with zero build step.
  if (url.pathname.startsWith('/mediapipe/')) {
    const rel = url.pathname.slice('/mediapipe/'.length);
    const full = await resolveMediapipePath(rel);
    if (!full) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('mediapipe asset not found');
      return true;
    }
    try {
      const st = await stat(full);
      const data = await readFile(full);
      res.writeHead(200, {
        'Content-Type': MP_MIME[extname(full)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    } catch {
      res.writeHead(500).end('mediapipe read error');
    }
    return true;
  }

  if (!url.pathname.startsWith('/sim-api/')) return false;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return true;
  }

  try {
    if (url.pathname === '/sim-api/health' && req.method === 'GET') {
      const [asrModelOk, ollama, mpBundleOk, trellisDisk] = await Promise.all([
        fileExists(ASR_MODEL_PATH),
        checkOllamaReady(),
        resolveMediapipePath('vision_bundle.mjs').then(Boolean),
        readTrellisDisk(),
      ]);
      const llms = [
        { name: 'prism', label: 'Prism', model: PRISM_MODEL, ready: Boolean(PRISM_KEY) },
        { name: 'inworld', label: 'Inworld', model: INWORLD_LLM_MODEL, ready: Boolean(INWORLD_KEY) },
        { name: 'local', label: 'Local Ollama', model: LOCAL_LLM_MODEL, ready: ollama.ready, note: ollama.note },
      ];
      const defaultLlm = llms.find((l) => l.ready)?.name || 'local-fallback';
      sendJson(res, 200, {
        ok: true,
        asr: {
          ready: Boolean(WHISPER_BIN && asrModelOk),
          provider: 'whisper.cpp',
          model: asrModelOk ? ASR_MODEL_NAME : null,
        },
        llms,
        defaultLlm,
        tts: {
          defaultProvider: INWORLD_KEY ? 'inworld' : (SAY_BIN ? 'say' : 'browser'),
          inworldReady: Boolean(INWORLD_KEY),
          sayReady: Boolean(SAY_BIN),
          profile: voiceProfile,
        },
        mediapipeLocal: mpBundleOk,
        trellisDisk: {
          persisted: Boolean(trellisDisk),
          commits: trellisDisk?.commits?.length || 0,
          entities: trellisDisk?.entities?.length || 0,
        },
      });
      return true;
    }

    if (url.pathname === '/sim-api/transcribe' && req.method === 'POST') {
      const wav = await readBody(req, 3_500_000);
      const out = await transcribeWav(wav);
      sendJson(res, 200, { ok: true, ...out });
      return true;
    }

    if (url.pathname === '/sim-api/reason' && req.method === 'POST') {
      const body = await readJson(req, 256 * 1024);
      const text = String(body.text || '').trim();
      if (!text || text.length > 4000) return sendJson(res, 400, { ok: false, error: 'text is required (1..4000 chars)' }), true;
      const out = await runReasoning({
        text,
        history: Array.isArray(body.history) ? body.history : [],
        llm: body.llm,
        trellisContext: typeof body.trellisContext === 'string' ? body.trellisContext.slice(0, 16000) : '',
        trellisSummary: typeof body.trellisSummary === 'string' ? body.trellisSummary.slice(0, 600) : '',
        activeSkills: Array.isArray(body.activeSkills) ? body.activeSkills : [],
        trackingSummary: typeof body.trackingSummary === 'string' ? body.trackingSummary.slice(0, 600) : '',
      });
      sendJson(res, 200, out);
      return true;
    }

    if (url.pathname === '/sim-api/tts' && req.method === 'POST') {
      const body = await readJson(req, 32 * 1024);
      const out = await synthesizeSpeech(body);
      sendJson(res, 200, out);
      return true;
    }

    if (url.pathname === '/sim-api/voices' && req.method === 'GET') {
      const [inworld, say] = await Promise.all([
        listInworldVoices().catch(() => []),
        listSayVoices().catch(() => []),
      ]);
      sendJson(res, 200, {
        ok: true,
        profile: voiceProfile,
        inworldReady: Boolean(INWORLD_KEY),
        sayReady: Boolean(SAY_BIN),
        voices: { inworld, say },
      });
      return true;
    }

    if (url.pathname === '/sim-api/voice-profile' && req.method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      const next = { ...voiceProfile };
      if (typeof body.voice === 'string' && body.voice.trim()) next.voice = body.voice.trim();
      if (typeof body.provider === 'string' && ['inworld', 'say', 'browser'].includes(body.provider)) next.provider = body.provider;
      if (Number.isFinite(Number(body.rate))) next.rate = Math.max(0.5, Math.min(1.5, Number(body.rate)));
      if (Number.isFinite(Number(body.pitch))) next.pitch = Math.max(-12, Math.min(12, Number(body.pitch)));
      voiceProfile = next;
      if (next.provider === 'inworld') {
        try {
          const tmp = `${VOICE_PROFILE_PATH}.${randomUUID()}.tmp`;
          await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
          await rename(tmp, VOICE_PROFILE_PATH);
        } catch {
          /* non-fatal if read-only */
        }
      }
      sendJson(res, 200, { ok: true, profile: voiceProfile });
      return true;
    }

    if (url.pathname === '/sim-api/trellis/state' && req.method === 'GET') {
      const data = await readTrellisDisk();
      sendJson(res, 200, { ok: true, data });
      return true;
    }

    if (url.pathname === '/sim-api/trellis/sync' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024);
      if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'Invalid Trellis snapshot' }), true;
      await writeTrellisDisk({ ...body, syncedAt: Date.now() });
      sendJson(res, 200, {
        ok: true,
        commits: body.commits?.length || 0,
        entities: body.entities?.length || 0,
      });
      return true;
    }

    if (url.pathname === '/sim-api/metrics' && req.method === 'POST') {
      const body = await readJson(req, 32 * 1024);
      const parsed = sanitizeEventBatch(body, { defaultEnv: 'local', nowMs: Date.now() });
      if (!parsed.ok) return sendJson(res, 400, { ok: false, error: parsed.error || 'no_valid_events', rejected: parsed.rejected }), true;
      await appendMetricsLocal(parsed.events);
      sendJson(res, 202, { ok: true, accepted: parsed.events.length, rejected: parsed.rejected });
      return true;
    }

    if (url.pathname === '/sim-api/metrics/summary' && req.method === 'GET') {
      const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days')) || 7)));
      const nowMs = Date.now();
      const rows = await readMetricsLocal(nowMs - days * 86400 * 1000);
      const summary = aggregateMetrics(rows, { days, nowMs });
      sendJson(res, 200, { ok: true, storage: 'local-jsonl', ...summary });
      return true;
    }

    if (url.pathname === '/sim-api/metrics/export' && req.method === 'GET') {
      const days = Math.max(1, Math.min(90, Math.round(Number(url.searchParams.get('days')) || 30)));
      const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'jsonl';
      const rows = await readMetricsLocal(Date.now() - days * 86400 * 1000);
      const stamp = new Date().toISOString().slice(0, 10);
      const body = format === 'csv' ? eventsToCsv(rows) : eventsToJsonl(rows);
      res.writeHead(200, {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="luka-metrics-${stamp}.${format}"`,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return true;
    }

    sendJson(res, 404, { ok: false, error: `Unknown sim-api route: ${url.pathname}` });
    return true;
  } catch (err) {
    sendJson(res, err.status || 500, { ok: false, error: String(err.message || err) });
    return true;
  }
}

export { parseEmbodiedDirective, buildEmbodiedSystemPrompt, localEmbodiedFallback };
