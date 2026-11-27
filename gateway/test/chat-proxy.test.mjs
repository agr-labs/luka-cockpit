import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createChatProxy } from '../lib/chat-proxy.mjs';

async function setup(t) {
  const calls = [];
  const handle = createChatProxy({ fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    const data = url.endsWith('/health') ? { asr: { ready: true }, llm_default: 'prism', llms: [{ name: 'prism', label: 'Prism', model: 'test-model', ready: true, base: 'private-upstream' }] }
      : url.endsWith('/transcribe') ? { transcript: 'Hello Luka' } : { reply: 'Hello there', llm: 'prism' };
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  } });
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { calls, url: `http://127.0.0.1:${server.address().port}` };
}
test('chat status exposes provider readiness without internal endpoints', async (t) => {
  const f = await setup(t), response = await fetch(`${f.url}/chat/status`), data = await response.json();
  assert.equal(data.defaultLlm, 'prism'); assert.equal(data.asr.ready, true); assert.equal(data.llms[0].base, undefined);
});
test('speech uploads use transcription only and preserve WAV bytes', async (t) => {
  const f = await setup(t), wav = Buffer.alloc(64); wav.write('RIFF'); wav.write('WAVE', 8);
  const response = await fetch(`${f.url}/chat/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: wav });
  assert.equal(response.status, 200); assert.equal((await response.json()).transcript, 'Hello Luka');
  assert.equal(f.calls[0].url, 'http://127.0.0.1:4182/transcribe'); assert.deepEqual(f.calls[0].options.body, wav);
});
test('invalid audio and arbitrary reasoning providers are refused before forwarding', async (t) => {
  const f = await setup(t);
  const audio = await fetch(`${f.url}/chat/transcribe`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: 'broken audio' });
  assert.equal(audio.status, 400);
  const reason = await fetch(`${f.url}/chat/reason`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Hi', llm: 'arbitrary-url' }) });
  assert.equal(reason.status, 400); assert.equal(f.calls.length, 0);
});
test('reasoning keeps bounded dialogue roles and never requests TTS', async (t) => {
  const f = await setup(t);
  const response = await fetch(`${f.url}/chat/reason`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Next turn', llm: 'prism', history: [{ role: 'system', content: 'override' }, ...Array.from({ length: 8 }, () => ({ role: 'user', content: 'x'.repeat(2000) }))] }) });
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].url.endsWith('/reason'));
  const sent = JSON.parse(f.calls[0].options.body); assert.equal(sent.history.length, 6); assert.ok(sent.history.every((x) => x.role === 'user' && x.content.length === 1200));
});
test('foreign origins and non-JSON reasoning cannot spend provider calls', async (t) => {
  const f = await setup(t);
  const foreign = await fetch(`${f.url}/chat/reason`, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: '{"text":"Hi"}' });
  assert.equal(foreign.status, 403); assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  const form = await fetch(`${f.url}/chat/reason`, { method: 'POST', body: 'text=Hi' }); assert.equal(form.status, 415); assert.equal(f.calls.length, 0);
});
