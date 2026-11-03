// End-to-end API tests against the simulator robot.
//
// These are the acceptance tests for the contract: every refusal must arrive
// with the right status and the right machine-readable code, because the
// console and any future application branch on those codes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, command, getJson, leaseFor, openSocket, postJson } from './helpers.mjs';

test('health is open and reports the gateway posture', async (t) => {
  const ctx = await boot(t);
  const res = await fetch(`${ctx.url}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.apiVersion, 'v1');
  assert.equal(body.physicalEnabled, false);
  assert.equal(body.robots, 1);
});

test('the contract is machine-readable', async (t) => {
  const ctx = await boot(t);
  const { status, body } = await getJson(ctx, '/contract');
  assert.equal(status, 200);
  assert.equal(body.capabilities.length, 11);
  assert.ok(body.statusCodes['423']);
});

test('robots are discoverable with capability counts', async (t) => {
  const ctx = await boot(t);
  const { status, body } = await getJson(ctx, '/robots');
  assert.equal(status, 200);
  assert.equal(body.robots.length, 1);
  const robot = body.robots[0];
  assert.equal(robot.robotId, 'luka-sim');
  assert.equal(robot.adapter, 'simulator');
  assert.equal(robot.online, true);
  assert.equal(robot.physical, false);
  assert.equal(robot.capabilities.observable, 9);
  assert.equal(robot.capabilities.commandable, 10);
});

test('capabilities expose modes per capability, not one global mode', async (t) => {
  const ctx = await boot(t);
  const { status, body } = await getJson(ctx, '/robots/luka-sim/capabilities');
  assert.equal(status, 200);
  const gaze = body.capabilities.find((c) => c.capability === 'head.gaze');
  assert.deepEqual(gaze.modes, ['observe', 'simulate']);
  const motion = body.capabilities.find((c) => c.capability === 'motion.state');
  assert.equal(motion.readOnly, true);
  assert.deepEqual(motion.modes, ['observe']);
  const speech = body.capabilities.find((c) => c.capability === 'voice.speak');
  assert.equal(speech.commandable, true);
});

test('state is reported without needing a lease', async (t) => {
  const ctx = await boot(t);
  const { status, body } = await getJson(ctx, '/robots/luka-sim/state');
  assert.equal(status, 200);
  assert.equal(body.source, 'simulated');
  assert.equal(body.lease, null);
  assert.equal(body.stop.latched, false);
  assert.equal(body.gateway.physicalEnabled, false);
});

test('a command without a lease is refused at the authority gate', async (t) => {
  const ctx = await boot(t);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command());
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'lease_required');
});

test('one lease per robot: a second holder is refused, with the holder named', async (t) => {
  const ctx = await boot(t);
  const first = await leaseFor(ctx, 'luka-sim', { holder: 'alice' });
  assert.equal(first.status, 201);
  assert.equal(first.lease.mode, 'simulate');
  assert.equal(first.lease.epoch, 1);

  const second = await leaseFor(ctx, 'luka-sim', { holder: 'bob' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'lease_held');
  assert.equal(second.body.error.details.holder, 'alice');
});

test('simulate mode drives the simulator and reports applied', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'head.gaze',
    payload: { yaw: 0.5, pitch: 0.2 },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(res.body.applied, true);
  assert.equal(res.body.mode, 'simulate');

  // The simulator slews at ~1.4 rad/s; advance it deterministically.
  ctx.gateway.registry.get('luka-sim').adapter.tick(800);
  const joints = await getJson(ctx, '/robots/luka-sim/joints');
  assert.ok(Math.abs(joints.body.neck.joint1 - 0.5) < 0.02);
  assert.ok(Math.abs(joints.body.neck.joint2 - 0.2) < 0.02);
});

test('an expired deadline is refused before it is applied', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    deadlineMs: Date.now() - 1,
  }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'deadline_expired');
  assert.ok(res.body.error.details.lateByMs >= 1);
});

test('a missing deadline is refused', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    deadlineMs: undefined,
  }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'deadline_required');
});

test('an invalid payload is 422 with per-field errors', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    payload: { yaw: 12, pitch: 0 },
  }));
  assert.equal(res.status, 422);
  assert.equal(res.body.error.code, 'invalid_payload');
  const field = res.body.error.details.errors.find((e) => e.path === '$.yaw');
  assert.equal(field.keyword, 'maximum');
  assert.equal(field.bound, 2.2);
});

test('a read-only capability is 405', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'motion.state',
    payload: {},
  }));
  assert.equal(res.status, 405);
});

test('an unknown capability is 404 and lists the known ones', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'legs.wiggle',
    payload: {},
  }));
  assert.equal(res.status, 404);
  assert.ok(res.body.error.details.known.includes('legs.posture'));
});

test('observe mode refuses commands with mode_read_only', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'observe' });
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'mode_read_only');
});

test('manual mode is not applicable to a simulator', async (t) => {
  const ctx = await boot(t);
  const res = await leaseFor(ctx, 'luka-sim', { mode: 'manual' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'mode_not_applicable');
});

test('lease scoping limits which capabilities can be commanded', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx, 'luka-sim', { capabilities: ['head.gaze'] });
  const ok = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(ok.status, 200);

  const outOfScope = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'hands.grasp',
    payload: { side: 'left', action: 'close' },
  }));
  assert.equal(outOfScope.status, 409);
  assert.equal(outOfScope.body.error.code, 'lease_scope');
});

test('arm goals are applied and wrist-envelope warnings are returned', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'arms.joints',
    payload: { joints: { idx18_left_arm_joint6: 0.4, idx20_right_arm_joint1: 0.3 } },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.warnings.length, 1);
  assert.equal(res.body.warnings[0].code, 'recommended_envelope');

  ctx.gateway.registry.get('luka-sim').adapter.tick(2000);
  const joints = await getJson(ctx, '/robots/luka-sim/joints');
  assert.ok(Math.abs(joints.body.joints.idx18_left_arm_joint6 - 0.4) < 0.02);
  assert.ok(Math.abs(joints.body.joints.idx20_right_arm_joint1 - 0.3) < 0.02);
});

test('speech is a command path, not a side door', async (t) => {
  const ctx = await boot(t);
  const noLease = await postJson(ctx, '/robots/luka-sim/speech', { text: 'hello' });
  assert.equal(noLease.status, 409);

  const { lease } = await leaseFor(ctx);
  const res = await postJson(ctx, '/robots/luka-sim/speech', {
    commandId: 'cmd_speech_1',
    text: 'gateway online',
    leaseId: lease.leaseId,
    deadlineMs: Date.now() + 5000,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.capability, 'voice.speak');
  const state = await getJson(ctx, '/robots/luka-sim/state');
  assert.equal(state.body.speech.text, 'gateway online');
});

test('idempotency: replay is free, reuse with a new payload is a conflict', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const body = command({ commandId: 'cmd_idem_1', leaseId: lease.leaseId });

  const first = await postJson(ctx, '/robots/luka-sim/commands', body);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-idempotent-replay'), null);

  const replay = await postJson(ctx, '/robots/luka-sim/commands', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('x-idempotent-replay'), 'true');
  assert.equal(replay.body.commandId, body.commandId);

  const conflicting = await postJson(ctx, '/robots/luka-sim/commands', {
    ...body,
    payload: { yaw: -0.5, pitch: 0.1 },
  });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.body.error.code, 'command_id_conflict');
});

test('software stop latches, revokes the lease and blocks commands until rearm', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  const stop = await postJson(ctx, '/robots/luka-sim/stop', { reason: 'test stop' });
  assert.equal(stop.status, 200);
  assert.equal(stop.body.latched, true);
  assert.equal(stop.body.certified, false);
  assert.equal(stop.body.leaseRevoked, true);
  assert.match(stop.body.note, /factory e-stop/);

  const blocked = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(blocked.status, 423);
  assert.equal(blocked.body.error.code, 'stop_latched');

  // Even a fresh lease cannot punch through the latch.
  const fresh = await leaseFor(ctx);
  const stillBlocked = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: fresh.lease.leaseId }));
  assert.equal(stillBlocked.status, 423);

  const badRearm = await postJson(ctx, '/robots/luka-sim/rearm', {});
  assert.equal(badRearm.status, 409);
  assert.equal(badRearm.body.error.code, 'rearm_confirmation_required');

  const rearm = await postJson(ctx, '/robots/luka-sim/rearm', { confirm: 'rearm', reason: 'test' });
  assert.equal(rearm.status, 200);
  assert.equal(rearm.body.latched, false);
  assert.match(rearm.body.note, /did not test/);

  const after = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: fresh.lease.leaseId }));
  assert.equal(after.status, 200);
});

test('every command and refusal lands in the audit log, newest first', async (t) => {
  const ctx = await boot(t);
  const { lease } = await leaseFor(ctx);
  await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId, payload: { yaw: 9, pitch: 0 } }));
  await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  await postJson(ctx, '/robots/luka-sim/stop', { reason: 'audit test' });

  const { status, body } = await getJson(ctx, '/audit?limit=20');
  assert.equal(status, 200);
  assert.ok(body.entries.length >= 4);
  const kinds = body.entries.map((e) => `${e.kind}:${e.outcome}:${e.code}`);
  assert.ok(kinds.includes('command:rejected:invalid_payload'));
  assert.ok(kinds.includes('command:accepted:command_accepted'));
  assert.ok(kinds.includes('stop:applied:software_stop'));
  assert.ok(body.seq >= 4);
});

test('command rate limiting is per robot and explicit', async (t) => {
  const ctx = await boot(t, { commandRate: 1, commandBurst: 2 });
  const { lease } = await leaseFor(ctx);
  const one = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(one.status, 200);
  const two = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(two.status, 200);
  const three = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(three.status, 429);
  assert.equal(three.body.error.code, 'rate_limited');
});

test('cameras and adapters are enumerable', async (t) => {
  const ctx = await boot(t);
  const cameras = await getJson(ctx, '/robots/luka-sim/cameras');
  assert.equal(cameras.status, 200);
  assert.ok(cameras.body.cameras.length >= 1);

  const adapters = await getJson(ctx, '/adapters');
  assert.equal(adapters.status, 200);
  const names = adapters.body.adapters.map((a) => a.name).sort();
  assert.deepEqual(names, ['aimdk', 'ros2', 'simulator']);
  assert.equal(adapters.body.adapters.find((a) => a.name === 'simulator').loaded, true);
});

test('unknown robots and routes are 404 with a usable message', async (t) => {
  const ctx = await boot(t);
  const robot = await getJson(ctx, '/robots/nope/state');
  assert.equal(robot.status, 404);
  assert.deepEqual(robot.body.error.details.known, ['luka-sim']);

  const route = await getJson(ctx, '/robots/luka-sim/nonsense');
  assert.equal(route.status, 404);
});

test('bearer auth protects the API but not health', async (t) => {
  const ctx = await boot(t, { token: 'test-token' });
  const open = await fetch(`${ctx.url}/api/v1/robots`);
  assert.equal(open.status, 401);

  const wrong = await fetch(`${ctx.url}/api/v1/robots`, { headers: { Authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);

  const good = await fetch(`${ctx.url}/api/v1/robots`, { headers: { Authorization: 'Bearer test-token' } });
  assert.equal(good.status, 200);

  const health = await fetch(`${ctx.url}/api/v1/health`);
  assert.equal(health.status, 200);
});

test('websocket telemetry streams hello, state and joints', async (t) => {
  const ctx = await boot(t);
  const ws = await openSocket(`${ctx.url.replace('http', 'ws')}/api/v1/robots/luka-sim/telemetry`);
  t.after(() => ws.close());

  const hello = await ws.waitFor((m) => m?.type === 'hello');
  assert.equal(hello.robotId, 'luka-sim');

  const state = await ws.waitFor((m) => m?.type === 'state');
  assert.equal(state.state.source, 'simulated');

  const joints = await ws.waitFor((m) => m?.type === 'joints');
  assert.ok(Object.keys(joints.joints.joints).length === 26);

  ws.send({ type: 'ping' });
  const pong = await ws.waitFor((m) => m?.type === 'pong');
  assert.ok(pong.at);
});

test('server-sent events carry the same telemetry', async (t) => {
  const ctx = await boot(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(ctx.api('/robots/luka-sim/telemetry'), {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !text.includes('event: state')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /event: hello/);
  assert.match(text, /event: state/);
  controller.abort();
});
