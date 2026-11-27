#!/usr/bin/env node
// Minimal MCP stdio server for Luka's custom voice bridge.
// Tools: voice.speak_custom (text -> macOS TTS -> PCM -> PlayMediaFile),
//        voice.list (available macOS voices).
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. Logs go to stderr.

import readline from 'node:readline';

const SAY_URL = process.env.LUKA_SAY_URL || 'http://127.0.0.1:8791/say';
const VOICES_URL = process.env.LUKA_VOICES_URL || 'http://127.0.0.1:8791/voices';
const PROFILE_URL = process.env.LUKA_VOICE_PROFILE_URL || new URL('/voice-profile', SAY_URL).href;
const PROTOCOL = '2024-11-05';
const NATURAL = new Set(['Samantha','Karen','Moira','Tessa','Daniel','Serena','Kate','Fiona','Allison','Ava','Susan','Victoria','Alex','Isha','Rishi']);

const TOOLS = [
  {
    name: 'voice.speak_custom',
    description: "Speak through Luka's head speaker using the saved voice or a selected Inworld/macOS voice. The bridge plays 24 kHz mono PCM via AimDK PlayMediaFile.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 2000, description: 'What Luka should say.' },
        voice: { type: 'string', description: 'Voice name. Inworld voices such as Ashley, Brooke, Grayson; or a macOS voice when provider is say.' },
        provider: { type: 'string', enum: ['inworld', 'say'], description: 'Speech provider. Defaults to the bridge profile (Inworld).' },
        rate: { type: 'number', description: 'Inworld speaking rate 0.5–1.5 (default 0.75); macOS words per minute when provider is say.' },
        pitch: { type: 'number', minimum: -12, maximum: 6, description: 'Inworld pitch shift in semitones (default -2).' },
        local: { type: 'boolean', description: 'Play on this Mac instead of Luka (useful when the robot jump host is unavailable).' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'voice.list',
    description: 'List the voices available to the Luka voice bridge, with descriptions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'voice.set_default',
    description: 'Save an available Inworld voice as Luka’s default for future replies. Keeps the saved speaking rate and pitch.',
    inputSchema: {
      type: 'object',
      properties: { voice: { type: 'string', minLength: 1, description: 'Voice identifier from voice.list, such as Grayson, Marcus, or Rupert.' } },
      required: ['voice'],
      additionalProperties: false,
    },
  },
];

const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const log = (...args) => console.error('[luka-mcp]', ...args);

async function callTool(name, args) {
  if (name === 'voice.list') {
    const res = await fetch(VOICES_URL, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `bridge ${res.status}`);
    const all = data.voices || [];
    const natural = data.provider === 'say' ? all.filter((v) => NATURAL.has(v.name)) : all;
    const voices = (natural.length ? natural : all).map((v) => `${v.name}: ${v.description || v.locale}`).join('\n');
    return { content: [{ type: 'text', text: voices || 'no voices reported' }], isError: false };
  }

  if (name === 'voice.set_default') {
    const voice = typeof args?.voice === 'string' ? args.voice.trim() : '';
    if (!voice) return { content: [{ type: 'text', text: 'voice is required' }], isError: true };
    const res = await fetch(PROFILE_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice }), signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `bridge ${res.status}`);
    return { content: [{ type: 'text', text: `Luka’s saved voice is now ${data.profile.voice} (${data.profile.rate}×, ${data.profile.pitch} semitones).` }], isError: false };
  }

  if (name === 'voice.speak_custom') {
    const text = typeof args?.text === 'string' ? args.text.trim() : '';
    if (!text) return { content: [{ type: 'text', text: 'text is required' }], isError: true };
    const body = { text };
    if (typeof args.voice === 'string' && args.voice.trim()) body.voice = args.voice.trim();
    if (typeof args.provider === 'string') body.provider = args.provider;
    if (typeof args.rate === 'number') body.rate = args.rate;
    if (typeof args.pitch === 'number') body.pitch = args.pitch;
    if (args.local === true) body.local = true;
    const res = await fetch(SAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      return { content: [{ type: 'text', text: `speak failed: ${data.error || `bridge ${res.status}`}` }], isError: true };
    }
    return {
      content: [{
        type: 'text',
        text: `Spoke ${data.chunks} chunk(s) (${data.voice}, ~${(data.durationMs / 1000).toFixed(1)} s${data.local ? ', local' : ' through Luka'}).`,
      }],
      isError: false,
    };
  }

  return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (method === 'initialize') {
    reply({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'luka-voice', version: '0.1.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') { reply({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') {
    reply({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments || {});
      reply({ jsonrpc: '2.0', id, result });
    } catch (e) {
      reply({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } });
    }
    return;
  }
  if (id !== undefined) {
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return; }
  handle(msg).catch((e) => {
    log('handler error', e);
    if (msg.id !== undefined) reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } });
  });
});
log('ready', { SAY_URL });
