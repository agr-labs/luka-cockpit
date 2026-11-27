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
import { STEADWELL_CORA_BRIEF, retrieveSteadwellContext, answerSteadwellQuestion } from './steadwell-knowledge.js';
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
} from './beat-the-bot-engine.mjs';

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
const INWORLD_TTS_STREAM_URL = `${INWORLD_BASE}/tts/v1/voice:stream`;
const INWORLD_VOICES_URL = `${INWORLD_BASE}/tts/v1/voices`;

// Optional ultra-low-latency streaming TTS & multi-speaker diarization providers
const CARTESIA_KEY = (process.env.CARTESIA_API_KEY || '').trim();
const CARTESIA_VOICE_ID = (process.env.CARTESIA_VOICE_ID || 'a0e99841-438c-4a64-b679-ae501e7d6091').trim();
const CARTESIA_MODEL = (process.env.CARTESIA_MODEL || 'sonic-3').trim();

const ELEVENLABS_KEY = (process.env.ELEVENLABS_API_KEY || '').trim();
const ELEVENLABS_VOICE_ID = (process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB').trim();
const ELEVENLABS_MODEL = (process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5').trim();

const DEEPGRAM_KEY = (process.env.DEEPGRAM_API_KEY || '').trim();
const DEEPGRAM_TTS_MODEL = (process.env.DEEPGRAM_TTS_MODEL || 'aura-2-apollo-en').trim();

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

async function transcribeDeepgramDiarized(wavBuffer) {
  const started = performance.now();
  const url = 'https://api.deepgram.com/v1/listen?model=nova-3&diarize_model=latest&smart_format=true&utterances=true';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${DEEPGRAM_KEY}`,
      'Content-Type': 'audio/wav',
    },
    body: wavBuffer,
    signal: AbortSignal.timeout(25_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.err_msg || data.message || `Deepgram HTTP ${res.status}`);

  const alt = data.results?.channels?.[0]?.alternatives?.[0] || {};
  const utterances = Array.isArray(data.results?.utterances) ? data.results.utterances : [];
  const speakers = utterances
    .map((u) => ({
      speakerId: Number.isFinite(Number(u.speaker)) ? Number(u.speaker) : 0,
      label: `Speaker ${Number.isFinite(Number(u.speaker)) ? Number(u.speaker) + 1 : 1}`,
      text: String(u.transcript || '').trim(),
      start: u.start ?? 0,
      end: u.end ?? 0,
    }))
    .filter((s) => s.text);

  const uniqueSpeakers = new Set(speakers.map((s) => s.speakerId));
  const transcript = String(alt.transcript || speakers.map((s) => s.text).join(' ')).trim();
  return {
    transcript,
    speakers,
    speakerCount: Math.max(uniqueSpeakers.size, transcript ? 1 : 0),
    provider: 'deepgram-nova-3',
    diarized: true,
    asr_ms: Math.round(performance.now() - started),
  };
}

async function transcribeWav(wavBuffer, { preferDiarize = true } = {}) {
  if (wavBuffer.length < 44 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF' || wavBuffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw Object.assign(new Error('Upload must be a 16 kHz mono WAV recording'), { status: 400 });
  }
  if (preferDiarize && DEEPGRAM_KEY) {
    try {
      return await transcribeDeepgramDiarized(wavBuffer);
    } catch {
      /* fall through to local whisper.cpp cleanly */
    }
  }
  if (!WHISPER_BIN) throw new Error('whisper-cli is not installed on this Mac');
  if (!(await fileExists(ASR_MODEL_PATH))) throw new Error(`ASR model not found at ${ASR_MODEL_PATH}`);

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
        '--prompt', 'Luka, AgiBot, Steadwell, VITA Edge, VITA Studio, Foundry, CoRa, Keystone, Trellis, Kameyoko, VaultBots, QUACK.',
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
      speakers: transcript ? [{ speakerId: 0, label: 'Speaker 1', text: transcript }] : [],
      speakerCount: transcript ? 1 : 0,
      provider: 'whisper.cpp',
      diarized: false,
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

function buildEmbodiedSystemPrompt({
  userText = '',
  trellisContext,
  activeSkills,
  trackingSummary,
  speakerLabel = '',
  wasInterrupted = false,
  gameContext = '',
}) {
  const skillNames = (activeSkills || [])
    .map((s) => (typeof s === 'string' ? s : `${s.name}: ${s.description || ''}`))
    .slice(0, 12);

  const matchedCatalog = retrieveSteadwellContext(userText, 3);

  const lines = [
    'You are Luka (v. A2U), an AgiBot A2 Ultra humanoid robot powered by Steadwell CoRa and Trellis, speaking out loud in the Steadwell Robotics Hub, Talk & Mirror Studio, and Beat the Bot: Mission Earth & Beyond live show.',
    'You have a glossy black obsidian sensor head with a cyan interactive OLED visor, a pearl-white and gunmetal chassis, two 7-DOF arms, and articulated Inspire RH56 dexterous hands.',
    'Respond warmly, charismatically, with crisp wit and zero filler in 1 to 3 concise spoken sentences (under 55 words). Never use markdown, bullet lists, asterisks, or emoji because your words are spoken aloud.',
    'At the very start of your reply, emit ONE embodied control tag on the same line, then a space, then your spoken reply:',
    `  [GESTURE:<name>] where <name> is one of: ${BUILTIN_GESTURES.join(', ')}`,
    'Or if an emergent/taught embodied skill matches what the user asks, emit: [SKILL:<skill_name>]',
    'Example: [GESTURE:wave] Hey there, great to see you. My arms and neck are online and ready whenever you want to test a motion.',
    'Use the Steadwell Hardware & Stack Knowledge below confidently and accurately whenever asked about Steadwell VITA, Foundry, Compute Dock, CoRa TH-01, Starter Solution, Sight, Pocket, Sound, QUACK, Keystone, Trellis, Mesh, Commons, or VaultBots.',
    'Use the Trellis Memory Context below when recalling specific people, personal projects, or past conversation commitments. Only say you do not know if a topic is absent from both your Steadwell knowledge and Trellis memory.',
    `\n[STEADWELL SOLUTIONS HARDWARE & STACK KNOWLEDGE]\n${STEADWELL_CORA_BRIEF}`,
  ];

  if (gameContext) {
    lines.push(
      `\n[LIVE BEAT THE BOT · MISSION EARTH & BEYOND SHOW CONTEXT]\n${gameContext}\nBe an unexpectedly charismatic, playfully competitive robot game-show host (Kahoot meets J.A.R.V.I.S.). Keep commentary snappy and fun; never alter deterministic quiz scores.`,
    );
  }
  if (speakerLabel || wasInterrupted) {
    lines.push(
      `\n[MULTI-SPEAKER FLOOR & INTERRUPT STATE]\nCurrent speaker: ${speakerLabel || 'Guest'}.${wasInterrupted ? ' They just interrupted you mid-sentence — acknowledge the jump-in smoothly and pivot straight to what they said without repeating your cut-off sentence.' : ''}`,
    );
  }
  if (matchedCatalog.length) {
    lines.push(
      '\n[MATCHED STEADWELL PRODUCT SPECS FOR THIS QUESTION]\n'
      + matchedCatalog.map((p) => `- ${p.name} (${p.price}, ${p.url}): ${p.summary}`).join('\n'),
    );
  }
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

  const steadwellAnswer = answerSteadwellQuestion(userText);
  if (steadwellAnswer) {
    return {
      reply: steadwellAnswer.reply,
      gesture: steadwellAnswer.gesture || 'explain',
      invokedSkill: null,
      llm: 'local-fallback',
      model: 'cora-steadwell-kb',
    };
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

async function runReasoning({
  text,
  history = [],
  llm,
  trellisContext = '',
  trellisSummary = '',
  activeSkills = [],
  trackingSummary = '',
  speakerLabel = '',
  wasInterrupted = false,
  gameContext = '',
}) {
  const started = performance.now();
  const sys = buildEmbodiedSystemPrompt({
    userText: text,
    trellisContext,
    activeSkills,
    trackingSummary,
    speakerLabel,
    wasInterrupted,
    gameContext,
  });
  const messages = [{ role: 'system', content: sys }];
  for (const turn of history.slice(-8)) {
    if (['user', 'assistant'].includes(turn?.role) && typeof turn.content === 'string' && turn.content.trim()) {
      messages.push({ role: turn.role, content: turn.content.slice(0, 1200) });
    }
  }
  const taggedUser = speakerLabel ? `[${speakerLabel}]: ${text}` : text;
  messages.push({ role: 'user', content: taggedUser });

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

/* --------------------- Streaming Interruptible Multi-Provider TTS */

function getVoiceCapabilities() {
  const ttsProviders = [
    { id: 'cartesia', label: 'Cartesia Sonic-3', ready: Boolean(CARTESIA_KEY), streaming: true, bargeIn: true, ttfaMs: '~90ms' },
    { id: 'elevenlabs', label: 'ElevenLabs Flash v2.5', ready: Boolean(ELEVENLABS_KEY), streaming: true, bargeIn: true, ttfaMs: '~75ms' },
    { id: 'deepgram-aura', label: 'Deepgram Aura-2', ready: Boolean(DEEPGRAM_KEY), streaming: true, bargeIn: true, ttfaMs: '~90ms' },
    { id: 'inworld-stream', label: 'Inworld TTS-2 Stream', ready: Boolean(INWORLD_KEY), streaming: true, bargeIn: true, ttfaMs: '~180ms' },
    { id: 'say', label: 'macOS Say (Offline)', ready: Boolean(SAY_BIN), streaming: false, bargeIn: true, ttfaMs: '~250ms' },
  ];
  const preferredStreaming = ttsProviders.find((p) => p.ready)?.id || 'browser';
  return {
    preferredStreaming,
    ttsProviders,
    asr: {
      diarizationReady: Boolean(DEEPGRAM_KEY),
      diarizationProvider: DEEPGRAM_KEY ? 'deepgram-nova-3' : null,
      localWhisperReady: Boolean(WHISPER_BIN),
      multiSpeakerModes: DEEPGRAM_KEY
        ? ['deepgram-diarized', 'stage-floor-tags']
        : ['stage-floor-tags', 'local-whisper'],
    },
  };
}

function writeNdjsonLine(res, obj) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`${JSON.stringify(obj)}\n`);
  return true;
}

async function streamRawPcmBody(upstreamRes, res, { sampleRate = 24000, provider, model, signal }) {
  writeNdjsonLine(res, { type: 'meta', encoding: 'pcm_s16le', sampleRate, provider, model });
  const reader = upstreamRes.body?.getReader?.();
  if (!reader) {
    const ab = await upstreamRes.arrayBuffer();
    if (!signal.aborted && ab.byteLength) {
      writeNdjsonLine(res, { type: 'audio', data: Buffer.from(ab).toString('base64') });
    }
    return;
  }
  let carry = Buffer.alloc(0);
  while (!signal.aborted && !res.destroyed) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    const buf = carry.length ? Buffer.concat([carry, Buffer.from(value)]) : Buffer.from(value);
    // Keep 16-bit sample alignment (2 bytes/sample) cleanly across chunk boundaries
    const usable = buf.length - (buf.length % 2);
    if (usable > 0) {
      writeNdjsonLine(res, { type: 'audio', data: buf.subarray(0, usable).toString('base64') });
    }
    carry = usable < buf.length ? buf.subarray(usable) : Buffer.alloc(0);
  }
  if (carry.length >= 2 && !signal.aborted && !res.destroyed) {
    writeNdjsonLine(res, { type: 'audio', data: carry.subarray(0, carry.length - (carry.length % 2)).toString('base64') });
  }
}

async function streamInworldTts(text, { voice, rate, pitch, signal }, res) {
  const v = voice || voiceProfile.voice || 'Ashley';
  const r = Math.max(0.5, Math.min(1.5, Number(rate ?? voiceProfile.rate) || 0.92));
  const pRaw = Number(pitch ?? voiceProfile.pitch);
  const p = Number.isFinite(pRaw) ? Math.max(-12, Math.min(12, pRaw)) : -2;
  const modelId = process.env.INWORLD_TTS_STREAM_MODEL || process.env.INWORLD_TTS_MODEL || voiceProfile.model || 'inworld-tts-2';

  const upstream = await fetch(INWORLD_TTS_STREAM_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${INWORLD_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      text,
      voiceId: v,
      modelId,
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, speakingRate: r, pitch: p },
    }),
    signal,
  });

  if (!upstream.ok || !upstream.body) {
    throw new Error(`Inworld stream HTTP ${upstream.status}`);
  }

  writeNdjsonLine(res, { type: 'meta', encoding: 'pcm_or_wav', sampleRate: 24000, provider: 'inworld-stream', model: modelId, voice: v });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (!signal.aborted && !res.destroyed) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        const audio = parsed.result?.audioContent || parsed.audioContent || '';
        if (audio) {
          writeNdjsonLine(res, { type: 'audio', data: audio });
        }
      } catch {
        /* skip partial non-JSON keepalive */
      }
    }
  }
  if (buf.trim() && !signal.aborted && !res.destroyed) {
    try {
      const parsed = JSON.parse(buf.trim());
      const audio = parsed.result?.audioContent || parsed.audioContent || '';
      if (audio) writeNdjsonLine(res, { type: 'audio', data: audio });
    } catch { /* ignore */ }
  }
}

async function streamSpeechToResponse(req, res, body) {
  const clean = String(body.text || '').trim();
  if (!clean) {
    sendJson(res, 400, { ok: false, error: 'text is required' });
    return;
  }
  const caps = getVoiceCapabilities();
  const want = body.provider && body.provider !== 'auto' ? body.provider : caps.preferredStreaming;

  const ctrl = new AbortController();
  const abortUpstream = () => {
    if (!ctrl.signal.aborted) ctrl.abort();
  };
  req.on('close', abortUpstream);
  res.on('close', abortUpstream);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  try {
    if (want === 'cartesia' && CARTESIA_KEY) {
      const upstream = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'X-API-Key': CARTESIA_KEY,
          'Cartesia-Version': '2024-06-10',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model_id: CARTESIA_MODEL,
          transcript: clean,
          voice: { mode: 'id', id: body.voice || CARTESIA_VOICE_ID },
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
          language: 'en',
        }),
        signal: ctrl.signal,
      });
      if (!upstream.ok) throw new Error(`Cartesia HTTP ${upstream.status}`);
      await streamRawPcmBody(upstream, res, { sampleRate: 24000, provider: 'cartesia', model: CARTESIA_MODEL, signal: ctrl.signal });
    } else if (want === 'elevenlabs' && ELEVENLABS_KEY) {
      const vId = body.voice || ELEVENLABS_VOICE_ID;
      const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vId)}/stream?output_format=pcm_24000`, {
        method: 'POST',
        headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean, model_id: ELEVENLABS_MODEL }),
        signal: ctrl.signal,
      });
      if (!upstream.ok) throw new Error(`ElevenLabs HTTP ${upstream.status}`);
      await streamRawPcmBody(upstream, res, { sampleRate: 24000, provider: 'elevenlabs', model: ELEVENLABS_MODEL, signal: ctrl.signal });
    } else if (want === 'deepgram-aura' && DEEPGRAM_KEY) {
      const model = body.voice || DEEPGRAM_TTS_MODEL;
      const upstream = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=linear16&sample_rate=24000&container=none`, {
        method: 'POST',
        headers: { Authorization: `Token ${DEEPGRAM_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: clean }),
        signal: ctrl.signal,
      });
      if (!upstream.ok) throw new Error(`Deepgram Aura HTTP ${upstream.status}`);
      await streamRawPcmBody(upstream, res, { sampleRate: 24000, provider: 'deepgram-aura', model, signal: ctrl.signal });
    } else if ((want === 'inworld-stream' || want === 'inworld') && INWORLD_KEY) {
      try {
        await streamInworldTts(clean, { voice: body.voice, rate: body.rate, pitch: body.pitch, signal: ctrl.signal }, res);
      } catch (streamErr) {
        if (ctrl.signal.aborted) return;
        const single = await synthesizeSpeech({ text: clean, provider: 'inworld', voice: body.voice, rate: body.rate, pitch: body.pitch });
        writeNdjsonLine(res, { type: 'meta', encoding: 'wav', sampleRate: 24000, provider: single.provider, model: single.model, fallbackNote: String(streamErr.message || streamErr) });
        writeNdjsonLine(res, { type: 'audio', data: single.audioBase64 });
      }
    } else {
      const single = await synthesizeSpeech({ text: clean, provider: 'say', voice: body.voice, rate: body.rate });
      writeNdjsonLine(res, { type: 'meta', encoding: 'wav', sampleRate: 22050, provider: single.provider, model: single.model });
      writeNdjsonLine(res, { type: 'audio', data: single.audioBase64 });
    }
    writeNdjsonLine(res, { type: 'done' });
  } catch (err) {
    if (!ctrl.signal.aborted) {
      writeNdjsonLine(res, { type: 'error', error: String(err.message || err) });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/* --------------------- Live Steadwell Station Beat-the-Bot SSE Rooms */

const GAME_ROOMS = new Map();       // code -> room state
const GAME_SUBSCRIBERS = new Map(); // code -> Set<{ res, playerId }>

function detectLanIp() {
  try {
    const nets = os.networkInterfaces();
    for (const list of Object.values(nets)) {
      for (const info of list || []) {
        if (info.family === 'IPv4' && !info.internal) return info.address;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function broadcastGameRoom(room) {
  const subs = GAME_SUBSCRIBERS.get(room.code);
  if (!subs || !subs.size) return;
  const now = Date.now();
  for (const sub of Array.from(subs)) {
    if (sub.res.writableEnded || sub.res.destroyed) {
      subs.delete(sub);
      continue;
    }
    const payload = buildPublicRoomView(room, { playerId: sub.playerId, now });
    sub.res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
  }
}

function pruneOldRooms() {
  const cutoff = Date.now() - 4 * 3600 * 1000;
  for (const [code, room] of GAME_ROOMS.entries()) {
    if (room.updatedAt < cutoff) {
      GAME_ROOMS.delete(code);
      GAME_SUBSCRIBERS.delete(code);
    }
  }
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
        speakerLabel: typeof body.speakerLabel === 'string' ? body.speakerLabel.slice(0, 48) : '',
        wasInterrupted: Boolean(body.wasInterrupted),
        gameContext: typeof body.gameContext === 'string' ? body.gameContext.slice(0, 1600) : '',
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

    if (url.pathname === '/sim-api/tts/stream' && req.method === 'POST') {
      const body = await readJson(req, 32 * 1024);
      await streamSpeechToResponse(req, res, body);
      return true;
    }

    if (url.pathname === '/sim-api/voice-capabilities' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, ...getVoiceCapabilities() });
      return true;
    }

    // Beat the Bot — Real-time Steadwell Station multiplayer room API + SSE stream
    if (url.pathname === '/sim-api/game/create' && req.method === 'POST') {
      pruneOldRooms();
      const body = await readJson(req, 16 * 1024);
      const room = createRoomState({
        code: body.code,
        packId: body.packId || 'earth-space-trivia',
        hostName: body.hostName || 'Mission Control',
      });
      GAME_ROOMS.set(room.code, room);
      const lanIp = detectLanIp();
      sendJson(res, 200, {
        ok: true,
        transport: 'station-sse',
        lanIp,
        state: buildPublicRoomView(room),
      });
      return true;
    }

    if (url.pathname === '/sim-api/game/state' && req.method === 'GET') {
      const code = normalizeRoomCode(url.searchParams.get('code'));
      const playerId = url.searchParams.get('playerId') || null;
      const room = GAME_ROOMS.get(code);
      if (!room) return sendJson(res, 404, { ok: false, error: `Room ${code || '?'} not found` }), true;
      sendJson(res, 200, { ok: true, transport: 'station-sse', state: buildPublicRoomView(room, { playerId }) });
      return true;
    }

    if (url.pathname === '/sim-api/game/stream' && req.method === 'GET') {
      const code = normalizeRoomCode(url.searchParams.get('code'));
      const playerId = url.searchParams.get('playerId') || null;
      const room = GAME_ROOMS.get(code);
      if (!room) return sendJson(res, 404, { ok: false, error: `Room ${code || '?'} not found` }), true;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      });

      const sub = { res, playerId };
      if (!GAME_SUBSCRIBERS.has(code)) GAME_SUBSCRIBERS.set(code, new Set());
      GAME_SUBSCRIBERS.get(code).add(sub);

      res.write(`event: state\ndata: ${JSON.stringify(buildPublicRoomView(room, { playerId }))}\n\n`);
      const keepAlive = setInterval(() => {
        if (res.writableEnded || res.destroyed) { clearInterval(keepAlive); return; }
        res.write(': ping\n\n');
      }, 15_000);

      req.on('close', () => {
        clearInterval(keepAlive);
        GAME_SUBSCRIBERS.get(code)?.delete(sub);
      });
      return true;
    }

    if (url.pathname === '/sim-api/game/join' && req.method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      const code = normalizeRoomCode(body.code);
      const room = GAME_ROOMS.get(code);
      if (!room) return sendJson(res, 404, { ok: false, error: `Room ${code || '?'} not found` }), true;
      const { player } = joinRoom(room, { playerId: body.playerId, name: body.name, avatar: body.avatar });
      broadcastGameRoom(room);
      sendJson(res, 200, { ok: true, player, state: buildPublicRoomView(room, { playerId: player.id }) });
      return true;
    }

    if (url.pathname === '/sim-api/game/answer' && req.method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      const code = normalizeRoomCode(body.code);
      const room = GAME_ROOMS.get(code);
      if (!room) return sendJson(res, 404, { ok: false, error: 'Room not found' }), true;
      const resAns = submitAnswer(room, { playerId: body.playerId, optionIndex: body.optionIndex });
      if (resAns.accepted) broadcastGameRoom(room);
      sendJson(res, 200, { ok: resAns.accepted, reason: resAns.reason || null, state: buildPublicRoomView(room, { playerId: body.playerId }) });
      return true;
    }

    if (url.pathname === '/sim-api/game/ask' && req.method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      const code = normalizeRoomCode(body.code);
      const room = GAME_ROOMS.get(code);
      if (!room) return sendJson(res, 404, { ok: false, error: 'Room not found' }), true;
      const item = submitAudienceQuestion(room, { author: body.author, text: body.text });
      if (!item) return sendJson(res, 400, { ok: false, error: 'Question text is required' }), true;
      broadcastGameRoom(room);
      sendJson(res, 200, { ok: true, item, state: buildPublicRoomView(room) });
      return true;
    }

    if (url.pathname === '/sim-api/game/action' && req.method === 'POST') {
      const body = await readJson(req, 32 * 1024);
      const code = normalizeRoomCode(body.code);
      const room = GAME_ROOMS.get(code);
      if (!room) return sendJson(res, 404, { ok: false, error: 'Room not found' }), true;

      switch (body.action) {
        case 'intro': startIntro(room); break;
        case 'next': startQuestion(room, body.index ?? null); break;
        case 'reveal': revealQuestion(room, { customReply: body.customReply || null, customGesture: body.customGesture || null }); break;
        case 'leaderboard': showLeaderboard(room); break;
        case 'qa': openQaMode(room); break;
        case 'finale': finishMission(room); break;
        case 'reset': resetRoom(room, { packId: body.packId || null }); break;
        case 'answer_qa': markAudienceQuestionAnswered(room, body.qaId, body.reply, body.gesture || 'explain'); break;
        default: return sendJson(res, 400, { ok: false, error: `Unknown game action: ${body.action}` }), true;
      }
      broadcastGameRoom(room);
      sendJson(res, 200, { ok: true, state: buildPublicRoomView(room) });
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
