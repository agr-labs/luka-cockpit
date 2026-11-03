// LiDAR pipeline: framing, validation, rate limit, staleness, simulator, and the
// binary WebSocket path the viewer depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LidarHub, MAX_BYTES, decodeFrame, encodeFrame } from '../lib/lidar.mjs';
import { ROOM, generateScan } from '../lib/lidar-sim.mjs';
import { boot, getJson, openSocket, postJson } from './helpers.mjs';

function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function frameOf(n, value = 1) {
  const f = new Float32Array(n * 3);
  f.fill(value);
  return Buffer.from(f.buffer);
}

test('a frame is Float32 xyz triples and nothing else', () => {
  const hub = new LidarHub();
  const meta = hub.publish('luka', frameOf(3), { source: 'test' });
  assert.equal(meta.count, 3);
  assert.equal(meta.seq, 1);
  assert.equal(meta.source, 'test');
  assert.equal(meta.bytes, 36);

  assert.throws(() => hub.publish('luka', Buffer.alloc(10)), (e) => e.status === 422);
  assert.throws(() => hub.publish('luka', Buffer.alloc(0)), (e) => e.status === 422);
});

test('oversized frames are refused before allocation', () => {
  const hub = new LidarHub({ minIntervalMs: 0 });
  const tooMany = Buffer.alloc(MAX_BYTES + 12);
  assert.throws(() => hub.publish('luka', tooMany), (e) => e.status === 413);
});

test('ingest is capped, and frames go stale then expire', () => {
  const now = clock();
  const hub = new LidarHub({ now, minIntervalMs: 40, staleMs: 1200, ttlMs: 5000 });
  hub.publish('luka', frameOf(10));
  now.advance(20);
  assert.throws(() => hub.publish('luka', frameOf(10)), (e) => e.status === 429);

  now.advance(30);
  hub.publish('luka', frameOf(10));
  now.advance(1300);
  assert.equal(hub.latest('luka').stale, true);

  now.advance(5000);
  assert.equal(hub.latest('luka'), null);
});

test('the wire frame round-trips header and points', () => {
  const hub = new LidarHub();
  const points = generateScan({ points: 64, seed: 1 });
  const frame = { robotId: 'luka', seq: 7, at: new Date().toISOString(), count: 64, source: 'sim', points: Buffer.from(points.buffer) };
  const { header, points: decoded } = decodeFrame(encodeFrame(frame));
  assert.equal(header.type, 'lidar');
  assert.equal(header.seq, 7);
  assert.equal(header.count, 64);
  assert.equal(decoded.length, 192);
  assert.ok(Math.abs(decoded[0] - points[0]) < 1e-6);
});

test('the simulator produces finite points inside the room', () => {
  const scan = generateScan({ points: 500, frame: 3, seed: 42 });
  assert.equal(scan.length, 500 * 3);
  const [x0, y0, z0] = ROOM.min;
  const [x1, y1, z1] = ROOM.max;
  for (let i = 0; i < scan.length; i += 3) {
    const [x, y, z] = [scan[i], scan[i + 1], scan[i + 2]];
    assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z));
    assert.ok(x >= x0 - 0.5 && x <= x1 + 0.5, `x ${x}`);
    assert.ok(y >= y0 - 0.1 && y <= y1 + 0.1, `y ${y}`);
    assert.ok(z >= z0 - 0.5 && z <= z1 + 0.5, `z ${z}`);
  }
});

test('the generator is deterministic for a seed and varies by frame', () => {
  const a = generateScan({ points: 32, frame: 1, seed: 99 });
  const b = generateScan({ points: 32, frame: 1, seed: 99 });
  const c = generateScan({ points: 32, frame: 2, seed: 99 });
  assert.deepEqual(Array.from(a), Array.from(b));
  assert.notDeepEqual(Array.from(a), Array.from(c));
});

test('HTTP ingest returns metadata and a GET reads it back', async (t) => {
  const ctx = await boot(t);
  const points = generateScan({ points: 32, seed: 5 });
  const res = await fetch(ctx.api('/robots/luka-sim/lidar?source=testbridge'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(points.buffer),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.lidar.count, 32);
  assert.equal(body.lidar.source, 'testbridge');

  const got = await getJson(ctx, '/robots/luka-sim/lidar');
  assert.equal(got.status, 200);
  assert.equal(got.body.lidar.count, 32);
  assert.equal(got.body.lidar.stale, false);
});

test('HTTP ingest refuses a body that is not xyz triples', async (t) => {
  const ctx = await boot(t);
  const res = await fetch(ctx.api('/robots/luka-sim/lidar'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.alloc(10),
  });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.error.code, 'invalid_payload');
});

test('the lidar websocket delivers binary frames', async (t) => {
  const ctx = await boot(t, {
    robots: [{
      id: 'luka-sim', label: 'sim', adapter: 'simulator', physical: false,
      configuration: 'grounded', lidar: { simulate: true, hz: 20, points: 500 },
    }],
  });
  const ws = await openSocket(`${ctx.url.replace('http', 'ws')}/api/v1/robots/luka-sim/lidar`);
  t.after(() => ws.close());
  const hello = await ws.waitFor((m) => m?.type === 'hello');
  assert.equal(hello.channel, 'lidar');

  const buffer = await ws.waitForBinary();
  const { header, points } = decodeFrame(buffer);
  assert.equal(header.type, 'lidar');
  assert.equal(header.robotId, 'luka-sim');
  assert.equal(header.count, 500);
  assert.equal(points.length, 1500);
  assert.match(header.source, /simulated/);
});

test('an ingest frame reaches a subscribed viewer', async (t) => {
  const ctx = await boot(t);
  const ws = await openSocket(`${ctx.url.replace('http', 'ws')}/api/v1/robots/luka-sim/lidar`);
  t.after(() => ws.close());
  await ws.waitFor((m) => m?.type === 'hello');

  const points = generateScan({ points: 12, seed: 8 });
  await fetch(ctx.api('/robots/luka-sim/lidar?source=bridge'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from(points.buffer),
  });

  const buffer = await ws.waitForBinary();
  const { header } = decodeFrame(buffer);
  assert.equal(header.count, 12);
  assert.equal(header.source, 'bridge');
});

test('state carries lidar metadata but not points', async (t) => {
  const ctx = await boot(t, {
    robots: [{
      id: 'luka-sim', label: 'sim', adapter: 'simulator', physical: false,
      configuration: 'grounded', lidar: { simulate: true, hz: 10, points: 300 },
    }],
  });
  await new Promise((r) => setTimeout(r, 400));
  const state = await getJson(ctx, '/robots/luka-sim/state');
  assert.equal(state.body.lidar.count, 300);
  assert.ok(!('points' in state.body.lidar));
  assert.equal(state.body.lidar.source, 'simulated-mid360');
});
