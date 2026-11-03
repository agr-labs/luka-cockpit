// Presence channel: validation, staleness, rate limiting, and the HTTP/WS path.
//
// The point of these tests is not that numbers arrive. It is that the channel
// cannot be mistaken for robot telemetry: it is labelled, bounded, expiring, and
// carries no media.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PresenceRegistry, validatePresence } from '../lib/presence.mjs';
import { boot, getJson, postJson, openSocket } from './helpers.mjs';

function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

const SAMPLE = { mic: { db: -15.3, peak: -12.1, speaking: true }, camera: { luminance: 110, motion: 2.69 } };

test('a sample needs mic or camera, and stays inside physical ranges', () => {
  assert.equal(validatePresence(SAMPLE).ok, true);
  assert.equal(validatePresence({ mic: { db: -40, speaking: false } }).ok, true);
  assert.equal(validatePresence({ camera: { luminance: 10, motion: 0 } }).ok, true);

  assert.equal(validatePresence({}).ok, false);
  assert.equal(validatePresence({ mic: { db: 6, speaking: true } }).ok, false, 'dBFS above 0 is impossible');
  assert.equal(validatePresence({ camera: { luminance: 300, motion: 0 } }).ok, false);
  assert.equal(validatePresence({ camera: { luminance: 10 } }).ok, false, 'motion is required with luminance');
  assert.equal(validatePresence({ mic: { db: -10, speaking: true }, extra: 1 }).ok, false);
});

test('ingest stamps sequence, source and server time', () => {
  const now = clock();
  const reg = new PresenceRegistry({ now });
  const first = reg.ingest('luka', SAMPLE);
  assert.equal(first.seq, 1);
  assert.equal(first.source, 'room-sensors');
  assert.equal(first.robotId, 'luka');
  assert.equal(first.mic.db, -15.3);
  assert.equal(first.stale, false);

  now.advance(1000);
  const second = reg.ingest('luka', SAMPLE);
  assert.equal(second.seq, 2);
});

test('samples go stale, then expire', () => {
  const now = clock();
  const reg = new PresenceRegistry({ now, staleMs: 2000, ttlMs: 30_000 });
  reg.ingest('luka', SAMPLE);

  now.advance(1500);
  assert.equal(reg.get('luka').stale, false);

  now.advance(1000);
  const stale = reg.get('luka');
  assert.equal(stale.stale, true);
  assert.ok(stale.ageMs >= 2500);

  now.advance(30_000);
  assert.equal(reg.get('luka'), null, 'a dead publisher does not leave a frozen value forever');
});

test('ingest is capped at 10 Hz', () => {
  const now = clock();
  const reg = new PresenceRegistry({ now, minIntervalMs: 100 });
  reg.ingest('luka', SAMPLE);
  now.advance(50);
  assert.throws(() => reg.ingest('luka', SAMPLE), (e) => e.status === 429);
  now.advance(60);
  assert.equal(reg.ingest('luka', SAMPLE).seq, 2);
});

test('POST → GET → state carries the presence record', async (t) => {
  const ctx = await boot(t);
  const post = await postJson(ctx, '/robots/luka-sim/presence', SAMPLE);
  assert.equal(post.status, 202);
  assert.equal(post.body.accepted, true);
  assert.equal(post.body.presence.seq, 1);

  const got = await getJson(ctx, '/robots/luka-sim/presence');
  assert.equal(got.status, 200);
  assert.equal(got.body.presence.camera.luminance, 110);

  const state = await getJson(ctx, '/robots/luka-sim/state');
  assert.equal(state.body.presence.source, 'room-sensors');
  assert.equal(state.body.presence.mic.speaking, true);
});

test('an invalid sample is 422 and does not replace the last good one', async (t) => {
  const ctx = await boot(t);
  await postJson(ctx, '/robots/luka-sim/presence', SAMPLE);

  const bad = await postJson(ctx, '/robots/luka-sim/presence', { mic: { db: 20, speaking: true } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'invalid_payload');

  const got = await getJson(ctx, '/robots/luka-sim/presence');
  assert.equal(got.body.presence.mic.db, -15.3);
});

test('samples faster than the channel allows get 429', async (t) => {
  const ctx = await boot(t);
  const first = await postJson(ctx, '/robots/luka-sim/presence', SAMPLE);
  assert.equal(first.status, 202);
  const second = await postJson(ctx, '/robots/luka-sim/presence', SAMPLE);
  assert.equal(second.status, 429);
});

test('presence is broadcast to websocket subscribers', async (t) => {
  const ctx = await boot(t);
  const ws = await openSocket(`${ctx.url.replace('http', 'ws')}/api/v1/robots/luka-sim/telemetry`);
  t.after(() => ws.close());
  await ws.waitFor((m) => m?.type === 'hello');

  await postJson(ctx, '/robots/luka-sim/presence', SAMPLE);
  const msg = await ws.waitFor((m) => m?.type === 'presence');
  assert.equal(msg.robotId, 'luka-sim');
  assert.equal(msg.presence.camera.motion, 2.69);
  assert.equal(msg.presence.source, 'room-sensors');
});

test('the contract advertises the channel as not robot telemetry', async (t) => {
  const ctx = await boot(t);
  const { body } = await getJson(ctx, '/contract');
  assert.equal(body.channels.presence.notRobotTelemetry, true);
  assert.equal(body.channels.presence.source, 'room-sensors');
  assert.ok(body.channels.presence.schema.properties.mic);
});

test('an unauthenticated sample is refused when a token is configured', async (t) => {
  const ctx = await boot(t, { token: 'secret-token' });
  const res = await fetch(`${ctx.api('/robots/luka-sim/presence')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SAMPLE),
  });
  assert.equal(res.status, 401);

  const ok = await fetch(`${ctx.api('/robots/luka-sim/presence')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret-token' },
    body: JSON.stringify(SAMPLE),
  });
  assert.equal(ok.status, 202);
});
