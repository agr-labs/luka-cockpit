import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HeadController, createHeadHandler } from '../lib/head-control.mjs';

function fixture() {
  let now = 1_000_000;
  const calls = [];
  const raw = { connected: true, measured: { yaw: .02, pitch: -.03 }, start: null, target: null, factoryNeckEnabled: true, sessionActive: false };
  const transport = {
    pause: null,
    async request(operation, args) {
      calls.push({ operation, args });
      if (operation === 'state' && this.pause) await this.pause;
      if (operation === 'acquire') { raw.start = { ...raw.measured }; raw.target = { ...raw.measured }; raw.factoryNeckEnabled = false; raw.sessionActive = true; }
      if (operation === 'move') raw.measured = raw.target = { ...args.target };
      if (operation === 'home') raw.measured = raw.target = { ...raw.start };
      if (operation === 'release') { raw.factoryNeckEnabled = true; raw.sessionActive = false; raw.start = raw.target = null; }
      return structuredClone(raw);
    },
    async close() {},
  };
  const controller = new HeadController({ transport, now: () => now });
  return { controller, transport, raw, calls, advance: (ms) => { now += ms; },
    command: (leaseId, extra = {}) => ({ leaseId, direction: 'left', deadlineMs: now + 2000, commandId: `test-${Math.random()}`, ...extra }) };
}

test('head inspection is read-only and does not disclose the lease token', async () => {
  const f = fixture();
  await f.controller.inspect();
  assert.deepEqual(f.calls.map((x) => x.operation), ['state']);
  const acquired = await f.controller.acquire('one dashboard');
  assert.ok(acquired.leaseId);
  const state = await f.controller.inspect();
  assert.equal(state.lease.holder, 'one dashboard');
  assert.equal(state.lease.leaseId, undefined);
  assert.equal(JSON.stringify(state).includes(acquired.leaseId), false);
});

test('a lease is required and a second dashboard cannot acquire the neck', async () => {
  const f = fixture();
  await assert.rejects(f.controller.jog(f.command('unknown')), { code: 'lease_required' });
  const { leaseId } = await f.controller.acquire('one');
  await assert.rejects(f.controller.acquire('two'), { code: 'lease_held' });
  await assert.rejects(f.controller.release('foreign'), { code: 'lease_mismatch' });
  await f.controller.release(leaseId);
  assert.equal(f.raw.factoryNeckEnabled, true);
});

test('one jog changes only the requested axis and duplicate IDs never repeat movement', async () => {
  const f = fixture();
  const { leaseId } = await f.controller.acquire('one');
  const command = f.command(leaseId);
  await f.controller.jog(command);
  await f.controller.jog(command);
  assert.equal(f.calls.filter((x) => x.operation === 'move').length, 1);
  assert.equal(f.raw.measured.pitch, -.03);
  assert.ok(Math.abs(f.raw.measured.yaw - (.02 + 2 * Math.PI / 180)) < 1e-10);
  await f.controller.jog(f.command(leaseId, { home: true }));
  assert.deepEqual(f.raw.measured, { yaw: .02, pitch: -.03 });
});

test('invalid directions, expired commands and wider model angles never reach movement', async () => {
  const f = fixture();
  const { leaseId } = await f.controller.acquire('one');
  await assert.rejects(f.controller.jog(f.command(leaseId, { direction: 'forward' })), { code: 'bad_request' });
  await assert.rejects(f.controller.jog(f.command(leaseId, { deadlineMs: 999999 })), { code: 'command_expired' });
  f.raw.measured.yaw = .78;
  await assert.rejects(f.controller.jog(f.command(leaseId)), { code: 'invalid_payload' });
  assert.equal(f.calls.some((x) => x.operation === 'move'), false);
});

test('release cancels a pending jog before dispatch and commands cannot accumulate', async () => {
  const f = fixture();
  const { leaseId } = await f.controller.acquire('one');
  let resume;
  f.transport.pause = new Promise((resolve) => { resume = resolve; });
  const jog = f.controller.jog(f.command(leaseId));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.controller.jog(f.command(leaseId)), { code: 'head_busy' });
  const release = f.controller.release(leaseId);
  resume();
  await assert.rejects(jog, { code: 'command_cancelled' });
  await release;
  assert.equal(f.calls.some((x) => x.operation === 'move'), false);
  assert.equal(f.raw.factoryNeckEnabled, true);
});

test('a command that expires while feedback is read cannot be sent', async () => {
  const f = fixture();
  const { leaseId } = await f.controller.acquire('one');
  let resume;
  f.transport.pause = new Promise((resolve) => { resume = resolve; });
  const jog = f.controller.jog(f.command(leaseId));
  await new Promise((resolve) => setImmediate(resolve));
  f.advance(2500); resume();
  await assert.rejects(jog, { code: 'command_expired' });
  assert.equal(f.calls.some((x) => x.operation === 'move'), false);
});

test('heartbeat renews the scoped lease and expiry blocks further commands', async () => {
  const f = fixture();
  const { leaseId } = await f.controller.acquire('one');
  f.advance(5000);
  await f.controller.heartbeat(leaseId);
  f.advance(6000);
  assert.ok(f.controller.view().lease);
  f.advance(5000);
  await assert.rejects(f.controller.jog(f.command(leaseId)), { code: 'lease_required' });
  await f.controller.close();
  assert.equal(f.raw.factoryNeckEnabled, true);
});

test('head HTTP routes refuse foreign origins and non-JSON writes', async (t) => {
  const f = fixture();
  const handle = createHeadHandler(f.controller);
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let result = await fetch(`${base}/head/acquire`, { method: 'POST', headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ holder: 'foreign' }) });
  assert.equal(result.status, 403);
  assert.equal(result.headers.get('access-control-allow-origin'), null);
  assert.equal(f.calls.length, 0);
  result = await fetch(`${base}/head/acquire`, { method: 'POST', body: '{}' });
  assert.equal(result.status, 415);
  result = await fetch(`${base}/head/acquire`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ holder: 'test tab' }) });
  assert.equal(result.status, 200);
  const { leaseId } = await result.json();
  result = await fetch(`${base}/head/jog`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f.command(leaseId, { target: { yaw: 2 } })) });
  assert.equal(result.status, 400);
  assert.equal(f.calls.some((x) => x.operation === 'move'), false);
  await f.controller.close();
});
