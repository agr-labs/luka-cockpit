#!/usr/bin/env node
// Local Luka audio/transcript bridge.
//  - tails the robot agent log over SSH and turns ASR/TTS lines into SSE events
//  - serves the card-0 loopback as a best-effort live WAV stream
//
// The microphone itself is opened exclusively by Luka's agent, so the ASR text
// from its log is the supported "input" tap. The output audio is the card-0
// loopback that the agent listens to; it is silent when Luka is not speaking.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HeadController, SshHeadTransport, createHeadHandler } from '../gateway/lib/head-control.mjs';
import { createChatProxy } from '../gateway/lib/chat-proxy.mjs';
import { FaceFollowService, createFaceFollowHandler } from './luka-face-follow.mjs';
import { playPcm } from './luka-playback.mjs';

const PORT = Number(process.env.BRIDGE_PORT || 8790);
const HOST_BIND = process.env.BRIDGE_HOST || '0.0.0.0';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const VOICE_PROFILE_PATH = fileURLToPath(new URL('../config/luka-voice.json', import.meta.url));
const VOICE_PROFILE = JSON.parse(await readFile(VOICE_PROFILE_PATH, 'utf8'));
let connectionProfile = {};
try { connectionProfile = JSON.parse(await readFile(new URL('../config/luka-connection.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const JUMP = process.env.LUKA_JUMP || connectionProfile.jump || 'agi@192.168.4.152';
const TARGET = process.env.LUKA_TARGET || connectionProfile.target || 'agi@192.168.100.110';
const LOG = process.env.LUKA_AGENT_LOG || '/agibot/log/agent/agent.log';
const SSH_KEY = process.env.LUKA_SSH_KEY || connectionProfile.sshKey || `${process.env.HOME}/.ssh/lukakey`;
const SSH = ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-i', SSH_KEY, '-J', JUMP, TARGET];
const HEAD_SSH = [
  '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=3',
  '-o', 'ServerAliveCountMax=2', '-i', SSH_KEY, '-J', JUMP, TARGET,
];
const head = new HeadController({ transport: new SshHeadTransport({ sshArgs: HEAD_SSH }) });
const handleHead = createHeadHandler(head);
const handleChat = createChatProxy();
const faceFollow = new FaceFollowService({
  head,
  sshArgs: HEAD_SSH,
  toolsDir: HERE,
  modelPath: fileURLToPath(new URL('../models/face_detection_yunet_2023mar.onnx', import.meta.url)),
  pythonBin: process.env.LUKA_FACE_PYTHON || fileURLToPath(new URL('../.venv-face-follow/bin/python', import.meta.url)),
  ffmpegBin: process.env.LUKA_FFMPEG || 'ffmpeg',
});
const handleFaceFollow = createFaceFollowHandler(faceFollow);
let shuttingDown = false;
let tailChild = null;

const AUDIO_DIR = process.env.LUKA_AUDIO_DIR || '/agibot/data/var/hal_audio/file';
// Voice providers. Inworld reads its key server-side from the existing
// pose-lab .env.local unless INWORLD_API_KEY is already set. The key is never
// sent to the browser.
const INWORLD_ENV = process.env.LUKA_INWORLD_ENV
  || '/Users/toby/Documents/deepseek-harness/default-workspace/pose-lab/.env.local';
if (!process.env.INWORLD_API_KEY) {
  try { process.loadEnvFile(INWORLD_ENV); } catch { /* no key file; fall back to say */ }
}
const INWORLD_KEY = process.env.INWORLD_API_KEY || '';
const INWORLD_BASE = (process.env.INWORLD_BASE || 'https://api.inworld.ai').replace(/\/$/, '');
const INWORLD_TTS_URL = `${INWORLD_BASE}/tts/v1/voice`;
const INWORLD_VOICES_URL = `${INWORLD_BASE}/tts/v1/voices`;
const INWORLD_MODEL = process.env.INWORLD_TTS_MODEL || VOICE_PROFILE.model;
let INWORLD_VOICE = process.env.INWORLD_VOICE || VOICE_PROFILE.voice;
const INWORLD_RATE = Number(process.env.INWORLD_RATE || VOICE_PROFILE.rate);
const INWORLD_PITCH = Number(process.env.INWORLD_PITCH || VOICE_PROFILE.pitch);
const PCM_RATE = 24000; // hal_audio's media-player path runs at 24 kHz
const SAY_VOICE = process.env.LUKA_SAY_VOICE || 'Samantha';
const SAY_RATE = Number(process.env.LUKA_SAY_RATE || 165);
const SAY_MAX_BYTES = 240000; // preferred chunk size; leave margin below the ~256 KiB player limit
const SAY_MAX_FILE_BYTES = 256 * 1024;
const SAY_MIN_CHUNK_BYTES = 192000; // search for a quiet point before the preferred boundary
const PCM_BYTES_PER_SECOND = PCM_RATE * 2;
const execFileP = promisify(execFile);
let sayVoiceCache = null;
let inworldVoiceCache = null;
let sayChain = Promise.resolve();
const DEFAULT_PROVIDER = INWORLD_KEY ? 'inworld' : 'say';
const INWORLD_CURATED = ['Ashley','Brooke','Olivia','Serena','Sophie','Eleanor','Hazel','Lauren','Jessica','Hana','Mia','Tessa','Nadia','Sarah','Naomi','Cordelia','Penelope','Imogen','Beatrice','Winifred','Blake','Daniel','Winston','Rupert','Oliver','Vincent','Grayson','Marcus','Callum','Jarrah','Arthur','Jonah','Chloe'];

const history = { asr: [], tts: [] };
const clients = new Set();
let connected = false;
let connectionError = null;

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  if (Buffer.isBuffer(body)) res.end(body);
  else res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

async function listSayVoices() {
  if (sayVoiceCache) return sayVoiceCache;
  const { stdout } = await execFileP('say', ['-v', '?']);
  const out = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2 || !/^[a-z]{2}_[A-Z]{2}$/.test(parts[1])) continue;
    out.push({ name: parts[0], label: parts[0], locale: parts[1], description: (parts[2] || '').replace(/^#\s*/, '') });
  }
  sayVoiceCache = out;
  return out;
}

async function listInworldVoices() {
  if (inworldVoiceCache) return inworldVoiceCache;
  if (!INWORLD_KEY) throw new Error('INWORLD_API_KEY is not set');
  const res = await fetch(INWORLD_VOICES_URL, {
    headers: { authorization: `Basic ${INWORLD_KEY}` },
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Inworld voices ${res.status}`);
  const all = (data.voices || []).filter((v) => (v.languages || []).includes('en'));
  const byId = new Map(all.map((v) => [v.voiceId, v]));
  const chosen = INWORLD_CURATED.map((id) => byId.get(id)).filter(Boolean);
  const list = (chosen.length ? chosen : all).map((v) => ({
    name: v.voiceId,
    label: v.displayName || v.voiceId,
    locale: 'en',
    description: v.description || '',
  }));
  inworldVoiceCache = list;
  return list;
}

async function listVoices(provider = DEFAULT_PROVIDER) {
  const p = provider === 'say' ? 'say' : 'inworld';
  const voices = p === 'inworld' ? await listInworldVoices() : await listSayVoices();
  return { provider: p, voices };
}

async function saveInworldVoice(voice) {
  if (typeof voice !== 'string') throw new Error('Choose an available voice');
  const { voices } = await listVoices('inworld');
  const selected = voices.find((item) => item.name === voice);
  if (!selected) throw new Error('That Inworld voice is not available');
  const next = {
    ...VOICE_PROFILE,
    id: `luka-${voice.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-v1`,
    provider: 'inworld',
    voice: selected.name,
  };
  const temporaryPath = `${VOICE_PROFILE_PATH}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`);
    await rename(temporaryPath, VOICE_PROFILE_PATH);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  Object.assign(VOICE_PROFILE, next);
  INWORLD_VOICE = selected.name;
  return {
    ...VOICE_PROFILE,
    model: INWORLD_MODEL,
    rate: INWORLD_RATE,
    pitch: INWORLD_PITCH,
    pitchUnit: 'semitones',
  };
}

async function synthesizeSay(text, voice, rate) {
  if (!/^[A-Za-z][A-Za-z0-9 .'()_-]{0,60}$/.test(voice)) throw new Error('invalid voice name');
  const r = Math.max(100, Math.min(300, Number(rate) || SAY_RATE));
  const base = `/tmp/luka-say-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const aiff = `${base}.aiff`;
  const pcm = `${base}.pcm`;
  try {
    await execFileP('say', ['-v', voice, '-r', String(r), '-o', aiff, text]);
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-i', aiff, '-ar', String(PCM_RATE), '-ac', '1', '-f', 's16le', pcm]);
    return await readFile(pcm);
  } finally {
    await Promise.all([unlink(aiff).catch(() => {}), unlink(pcm).catch(() => {})]);
  }
}

async function synthesizeInworld(text, voice, rate, pitch) {
  if (!INWORLD_KEY) throw new Error('INWORLD_API_KEY is not set');
  if (!/^[A-Za-z][A-Za-z0-9 _-]{0,60}$/.test(voice)) throw new Error('invalid Inworld voice');
  const r = Math.max(0.5, Math.min(1.5, Number(rate) || INWORLD_RATE));
  const inputPitch = Number(pitch);
  const p = Math.max(-12, Math.min(12, Number.isFinite(inputPitch) ? inputPitch : INWORLD_PITCH));
  const res = await fetch(INWORLD_TTS_URL, {
    method: 'POST',
    headers: { authorization: `Basic ${INWORLD_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      text,
      voiceId: voice,
      modelId: INWORLD_MODEL,
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: PCM_RATE, speakingRate: r, pitch: p },
      deliveryMode: 'STABLE',
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Inworld TTS ${res.status}`);
  if (!data.audioContent) throw new Error('Inworld returned no audioContent');
  const wav = Buffer.from(data.audioContent, 'base64');
  const base = `/tmp/luka-inw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const wavPath = `${base}.wav`;
  const pcmPath = `${base}.pcm`;
  try {
    await writeFile(wavPath, wav);
    // Inworld applies pitch in the API request; resampling here would shift it twice.
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-i', wavPath, '-ar', String(PCM_RATE), '-ac', '1', '-f', 's16le', pcmPath]);
    return await readFile(pcmPath);
  } finally {
    await Promise.all([unlink(wavPath).catch(() => {}), unlink(pcmPath).catch(() => {})]);
  }
}

async function synthesize(text, opts = {}) {
  const provider = opts.provider === 'say' ? 'say' : 'inworld';
  if (provider === 'inworld') {
    const voice = opts.voice || INWORLD_VOICE;
    const rate = opts.rate == null ? INWORLD_RATE : Number(opts.rate);
    const inputPitch = Number(opts.pitch);
    const pitch = Number.isFinite(inputPitch) ? Math.max(-12, Math.min(12, inputPitch)) : INWORLD_PITCH;
    return {
      buf: await synthesizeInworld(text, voice, rate, pitch), provider, voice, rate, pitch,
      model: INWORLD_MODEL,
    };
  }
  const voice = opts.voice || SAY_VOICE;
  const rate = opts.rate ?? SAY_RATE;
  return { buf: await synthesizeSay(text, voice, rate), provider, voice, rate, pitch: 0 };
}

function sshPlayChunk(file, chunk, onPlaying) {
  return playPcm({ sshArgs: SSH, directory: AUDIO_DIR, file, pcm: chunk, sampleRate: PCM_RATE, onPlaying });
}

async function playLocal(pcm) {
  const path = `/tmp/luka-local-${process.pid}-${Date.now()}.wav`;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(PCM_RATE, 24); header.writeUInt32LE(PCM_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  await writeFile(path, Buffer.concat([header, pcm]));
  try { await execFileP('afplay', [path]); } finally { await unlink(path).catch(() => {}); }
}

async function speak(text, opts = {}) {
  text = String(text || '').trim();
  if (!text) throw new Error('text is required');
  if (text.length > 2000) throw new Error('text too long (2000 max)');
  const synth = await synthesize(text, opts);
  const buf = synth.buf;
  if (!buf.length) throw new Error('TTS produced no audio');
  if (opts.local) {
    await playLocal(buf);
    return { provider: synth.provider, voice: synth.voice, rate: synth.rate, pitch: synth.pitch, pitchUnit: 'semitones', model: synth.model, local: true, chunks: 1, bytes: buf.length, durationMs: Math.round(buf.length / PCM_BYTES_PER_SECOND * 1000), files: [] };
  }
  const chunks = [];
  for (let off = 0; off < buf.length;) {
    const remaining = buf.length - off;
    // Keep an utterance in one file when it still fits the media player's limit.
    if (remaining <= SAY_MAX_FILE_BYTES) {
      chunks.push(buf.subarray(off));
      break;
    }

    const latest = off + SAY_MAX_BYTES;
    const earliest = off + SAY_MIN_CHUNK_BYTES;
    // Find a low-energy PCM frame near the limit so long speech is less likely
    // to be cut in the middle of a word. Frames are 10 ms at 16 kHz mono.
    let end = latest;
    let quietestRms = Infinity;
    for (let candidate = earliest; candidate <= latest; candidate += 320) {
      let sumSquares = 0;
      let count = 0;
      for (let pos = candidate - 320; pos < candidate + 320; pos += 2) {
        const sample = buf.readInt16LE(pos);
        sumSquares += sample * sample;
        count++;
      }
      const rms = Math.sqrt(sumSquares / count);
      if (rms < quietestRms) {
        quietestRms = rms;
        end = candidate;
      }
    }
    end -= end % 2;
    if (end <= off || end - off > SAY_MAX_FILE_BYTES) end = latest;
    chunks.push(buf.subarray(off, end));
    off = end;
  }
  const stem = `say_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const files = [];
  for (let i = 0; i < chunks.length; i++) {
    const file = `${stem}_${i}.pcm`;
    await sshPlayChunk(file, chunks[i], i === 0 ? opts.onPlaying : undefined);
    files.push(file);
    // The worker waits for this clip's End status before accepting the next.

  }
  return { provider: synth.provider, voice: synth.voice, rate: synth.rate, pitch: synth.pitch, pitchUnit: 'semitones', model: synth.model, chunks: chunks.length, bytes: buf.length, durationMs: Math.round(buf.length / PCM_BYTES_PER_SECOND * 1000), files };
}

function enqueueSay(fn) {
  const run = sayChain.then(fn, fn);
  sayChain = run.catch(() => {});
  return run;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => {
      data += d;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of clients) { try { c.write(data); } catch { clients.delete(c); } }
}

function addTurn(kind, text) {
  text = text.replace(/\s+/g, ' ').trim().replace(/^["“]|["”]$/g, '');
  // Log lines append event metadata after the spoken text; strip it.
  text = text.replace(/,\s*(event_id|item_id|status|domain|priority|error_msg):.*$/i, '').trim();
  if (!text || text.length < 2 || text.length > 500) return;
  if (/^[,;]/.test(text) || /(event_id|item_id|domain):/i.test(text)) return;
  const key = text.toLowerCase();
  const last = history[kind].at(-1);
  const recent = last && Date.now() - Date.parse(last.at) < 8000;
  // ASR arrives as growing partials: replace the last turn instead of appending
  // "hi luca", "hi luca can you", "hi luca can you give me".
  if (recent && text.toLowerCase().startsWith(last.text.toLowerCase())) {
    last.text = text; last.at = new Date().toISOString();
    broadcast({ type: kind, replace: true, ...last });
    return;
  }
  if (recent && last.text.toLowerCase().startsWith(key)) return;
  if (history[kind].slice(-20).some((x) => x.text.toLowerCase() === key && Date.now() - Date.parse(x.at) < 30000)) return;
  const item = { at: new Date().toISOString(), text };
  history[kind].push(item);
  if (history[kind].length > 200) history[kind].shift();
  broadcast({ type: kind, ...item });
  console.log(`${kind}: ${text}`);
}

function parseLine(line) {
  if (line.includes('processed_text is same')) return;
  if (line.includes('AsrDataInstrumentation') || line.includes('ASR instrumentation')) return;
  // ASR: ContextManager::setAsrResult() ... text: We're home now
  let m = line.match(/setAsrResult\(\).*?text:\s*(.+)$/);
  if (!m) m = line.match(/HandleAsrResult text:\s*(.+)$/);
  if (m) { addTurn('asr', m[1]); return; }
  // PublishTtsStatus is the authoritative final TTS; onTtsStatus repeats it.
  m = line.match(/PublishTtsStatus.*?Text:\s*(.+)$/);
  if (m) addTurn('tts', m[1]);
}

function startTail() {
  const child = spawn('ssh', [...SSH, `tail -n 5000 -F ${LOG}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  tailChild = child;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    connected = true;
    connectionError = null;
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) parseLine(line);
  });
  child.stderr.on('data', (d) => {
    const error = d.toString().trim();
    if (error.includes('Permission denied')) connectionError = 'authorization_rejected';
    else if (!connectionError) connectionError = 'connection_failed';
    console.error('ssh:', error.slice(0, 200));
  });
  child.on('exit', (code) => { connected = false; broadcast({ type: 'status', connected: false }); console.error('tail exited', code); if (!shuttingDown) setTimeout(startTail, 3000); });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/head/')) {
    if (shuttingDown) return send(res, 503, { ok: false, error: { message: 'Bridge is shutting down' } });
    return handleHead(req, res, url);
  }
  if (url.pathname.startsWith('/face-follow/')) {
    if (shuttingDown) return send(res, 503, { ok: false, error: { message: 'Bridge is shutting down' } });
    return handleFaceFollow(req, res, url);
  }
  if (url.pathname.startsWith('/chat/')) return handleChat(req, res, url);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (url.pathname === '/voice-profile' && req.method === 'GET') {
    return send(res, 200, {
      ...VOICE_PROFILE, model: INWORLD_MODEL, voice: INWORLD_VOICE,
      rate: INWORLD_RATE, pitch: INWORLD_PITCH,
    });
  }

  if (url.pathname === '/voice-profile' && req.method === 'POST') {
    try {
      if (req.headers['sec-fetch-site'] === 'cross-site'
        || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
        return send(res, 403, { ok: false, error: 'Change the voice from LukaChat on this bridge.' });
      }
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return send(res, 415, { ok: false, error: 'Voice selection requires JSON.' });
      }
      const body = await readJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => key !== 'voice')) throw new Error('Send only the selected voice.');
      return send(res, 200, { ok: true, profile: await saveInworldVoice(body.voice) });
    } catch (error) {
      return send(res, 400, { ok: false, error: String(error.message || error) });
    }
  }

  if (url.pathname === '/voices' && req.method === 'GET') {
    try {
      const provider = url.searchParams.get('provider') || DEFAULT_PROVIDER;
      const out = await listVoices(provider);
      return send(res, 200, {
        provider: out.provider,
        providers: [
          { id: 'inworld', ready: Boolean(INWORLD_KEY), voice: INWORLD_VOICE },
          { id: 'say', ready: true, voice: SAY_VOICE },
        ],
        defaults: out.provider === 'inworld'
          ? { voice: INWORLD_VOICE, rate: INWORLD_RATE, pitch: INWORLD_PITCH, model: INWORLD_MODEL }
          : { voice: SAY_VOICE, rate: SAY_RATE, pitch: 0 },
        voices: out.voices,
      });
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  if (url.pathname === '/say' && req.method === 'POST') {
    try {
      const body = await readJson(req);
      const result = await enqueueSay(() => speak(body.text, {
        provider: body.provider,
        voice: body.voice,
        rate: body.rate,
        pitch: body.pitch,
        local: body.local === true,
        onPlaying: typeof body.requestId === 'string' && body.requestId.length < 100
          ? () => broadcast({ type: 'playback', requestId: body.requestId, phase: 'speaking' }) : undefined,
      }));
      return send(res, 200, { ok: true, ...result });
    } catch (e) {
      return send(res, 400, { ok: false, error: String(e.message || e) });
    }
  }

  if (url.pathname === '/health') return send(res, 200, { ok: true, connected, robotConnection: { jump: JUMP, target: TARGET, error: connectionError }, asr: history.asr.length, tts: history.tts.length, ttsProvider: DEFAULT_PROVIDER, ttsModel: INWORLD_MODEL, inworld: Boolean(INWORLD_KEY) });
  if (url.pathname === '/transcript') return send(res, 200, { connected, ...history });

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
      Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', connected, ...history })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/test-tone') {
    const sr = 16000, n = sr; // 1 s
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 8000), 44 + i * 2);
    return send(res, 200, buf, 'audio/wav');
  }

  if (url.pathname === '/audio') {
    // Card-0 loopback: what hal_audio/agent route through the speaker path.
    const child = spawn('ssh', [...SSH, 'arecord -D plughw:0,1 -f S16_LE -r 16000 -c 1 -t raw'], { stdio: ['ignore', 'pipe', 'pipe'] });
    res.writeHead(200, {
      'Content-Type': 'audio/wav', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', Connection: 'close',
    });
    // WAV header with unknown/streaming sizes.
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(0xffffffff, 4); h.write('WAVE', 8);
    h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
    h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
    h.write('data', 36); h.writeUInt32LE(0xffffffff, 40);
    res.write(h);
    child.stdout.pipe(res);
    child.stderr.on('data', (d) => console.error('arecord:', d.toString().trim().slice(0, 160)));
    const kill = () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } };
    req.on('close', kill);
    child.on('exit', () => { try { res.end(); } catch { /* ignore */ } });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/luka-audio.html') {
    return readFile(`${HERE}luka-audio.html`).then((b) => send(res, 200, b.toString('utf8'), 'text/html')).catch(() => send(res, 500, 'page missing'));
  }
  if (url.pathname === '/console.css') {
    return readFile(`${HERE}../gateway/public/console.css`).then((b) => send(res, 200, b.toString('utf8'), 'text/css')).catch(() => send(res, 404, 'css missing'));
  }
  if (url.pathname === '/head-controls.js') {
    return readFile(`${HERE}luka-head-controls.js`).then((b) => send(res, 200, b.toString('utf8'), 'text/javascript')).catch(() => send(res, 404, 'head controls missing'));
  }
  if (url.pathname === '/head-panel.html' || url.pathname === '/head-controls.css') {
    const file = url.pathname.endsWith('.css') ? 'luka-head-controls.css' : 'luka-head-panel.html';
    return readFile(`${HERE}${file}`).then((b) => send(res, 200, b.toString('utf8'), file.endsWith('.css') ? 'text/css' : 'text/html')).catch(() => send(res, 404, 'head asset missing'));
  }
  if (url.pathname === '/chat' || url.pathname === '/chat.html') {
    return readFile(`${HERE}lukachat.html`).then((b) => send(res, 200, b.toString('utf8'), 'text/html')).catch(() => send(res, 404, 'chat page missing'));
  }
  if (['/lukachat.js', '/lukachat.css', '/lukachat-controller.mjs', '/lukachat-controller-ui.mjs'].includes(url.pathname)) {
    return readFile(`${HERE}${url.pathname.slice(1)}`).then((b) => send(res, 200, b.toString('utf8'), url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript')).catch(() => send(res, 404, 'chat asset missing'));
  }
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST_BIND, () => {
  console.log(`luka bridge on http://${HOST_BIND}:${PORT} (ssh ${TARGET} via ${JUMP})`);
  startTail();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await faceFollow.close();
    await head.close();
    tailChild?.kill('SIGTERM');
    for (const client of clients) client.end();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
