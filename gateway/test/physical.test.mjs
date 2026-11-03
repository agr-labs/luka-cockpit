// Physical-path tests.
//
// Two layers:
//   1. the real AimDK adapter against a fake AimMaster on localhost, to prove
//      read-only mapping and that nothing on that adapter can be commanded;
//   2. a simulator whose adapter is monkey-patched to claim a verified write
//      path, to prove the gates that stand between a verified path and motion.
//
// Layer 2 is synthetic on purpose: there is no verified physical path yet, and a
// test that needs one in order to run would never run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { boot, command, getJson, leaseFor, postJson } from './helpers.mjs';

const JOINTS = Array.from({ length: 26 }, (_, i) => ({
  name: `idx${String(i + 1).padStart(2, '0')}_joint`,
  position: 0.01 * (i + 1),
  velocity: 0,
  effort: 0,
}));

async function fakeAimMaster() {
  const server = http.createServer((req, res) => {
    const method = req.url.replace(/^\/rpc\//, '');
    const send = (body) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (method === 'aimdk.protocol.McActionService/GetAction') {
      return send({
        header: { code: '0' },
        info: {
          current_action: 'McAction_RL_JOINT_DEFAULT',
          ext_action: '',
          status: 'McActionStatus_RUNNING',
        },
      });
    }
    if (method === 'aimdk.protocol.McDataService/GetJointState') return send({ header: { code: '0' }, states: JOINTS });
    if (method === 'aimdk.protocol.McDataService/GetNeckState') {
      // Captured verbatim from Luka on 2026-11-01.
      return send({
        header: { code: '0' },
        data: {
          shake: { name: 'idx27_head_joint1', sequence: 0, position: 0.0046, velocity: 0, effort: 0 },
          nod: { name: 'idx28_head_joint2', sequence: 0, position: -0.0087, velocity: 0, effort: 0 },
        },
      });
    }
    if (method === 'aimdk.protocol.McDataService/GetHandState') {
      // Captured shape: data.<side>.agi_hand.finger.pos, with a sibling `toq`
      // object whose keys also look like fingers. Position must win.
      const hand = (thumb0, thumb1, index, middle, ring, pinky) => ({
        agi_hand: {
          finger: {
            pos: { thumb_pos_0: thumb0, thumb_pos_1: thumb1, index_pos: index, middle_pos: middle, ring_pos: ring, pinky_pos: pinky },
            toq: { thumb_toq_0: 0, thumb_toq_1: -228, index_toq: 273, middle_toq: -129, ring_toq: -143, pinky_toq: -266 },
          },
        },
      });
      return send({
        header: { code: '0' },
        data: {
          left: hand(478, 1023, 1029, 1023, 1026, 1028),
          right: hand(446, 1030, 1031, 1032, 1021, 1024),
        },
      });
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `no route ${method}` }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function waitFor(fn, { timeout = 4000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out in waitFor');
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function bootPhysical(t) {
  const upstream = await fakeAimMaster();
  t.after(() => new Promise((resolve) => upstream.server.close(resolve)));
  const ctx = await boot(t, {
    robots: [{
      id: 'luka',
      label: 'Luka (fake AimMaster)',
      adapter: 'aimdk',
      physical: true,
      configuration: 'suspended',
      options: { host: '127.0.0.1', port: upstream.port, actionHz: 20, jointsHz: 20, timeoutMs: 800 },
    }],
  });
  await waitFor(async () => (await getJson(ctx, '/robots/luka/state')).body.online === true);
  return { ctx, upstream };
}

/* ------------------------- real AimDK adapter -------------------------- */

test('aimdk: state maps to the contract and stays labelled measured', async (t) => {
  const { ctx } = await bootPhysical(t);
  const { status, body } = await getJson(ctx, '/robots/luka/state');
  assert.equal(status, 200);
  assert.equal(body.source, 'measured');
  assert.equal(body.online, true);
  assert.equal(body.health, 'ok');
  assert.equal(body.action, 'McAction_RL_JOINT_DEFAULT');
  assert.equal(body.actionLabel, 'RL_JOINT_DEFAULT');
  assert.equal(body.configuration, 'suspended');
  assert.equal(body.base, null, 'no odometry exists, so base must be null rather than invented');
});

test('aimdk: 26 joints, 2 neck joints and 10 finger channels map through', async (t) => {
  const { ctx } = await bootPhysical(t);
  const { body } = await getJson(ctx, '/robots/luka/joints');
  assert.equal(Object.keys(body.joints).length, 26);
  assert.equal(body.joints.idx01_joint, 0.01);
  assert.equal(body.neck.joint1, 0.0046);
  assert.equal(body.neck.joint2, -0.0087);
  assert.equal(body.hands.left.thumb, 1023);   // prefers thumb_pos_1 when present
  assert.equal(body.hands.right.thumb, 1030);
  assert.equal(body.hands.left.pinky, 1028);
  // The sibling `toq` block must not be mistaken for joint positions.
  assert.ok(body.hands.left.index >= 0 && body.hands.left.index <= 2000);
});

test('aimdk: everything observable, nothing commandable, with reasons', async (t) => {
  const { ctx } = await bootPhysical(t);
  const { body } = await getJson(ctx, '/robots/luka/capabilities');
  const byId = Object.fromEntries(body.capabilities.map((c) => [c.capability, c]));

  assert.equal(byId['arms.joints'].observable, true);
  assert.equal(byId['arms.joints'].commandable, false);
  assert.match(byId['arms.joints'].reason, /read-only|ROS 2/);

  assert.equal(byId['motion.state'].observable, true);
  assert.equal(byId['base.velocity'].supported, false);
  assert.match(byId['base.velocity'].reason, /odometry|velocity feedback/);
  assert.equal(byId['camera.stream'].supported, false);
  assert.deepEqual(byId['head.gaze'].modes, ['observe']);
});

test('aimdk: a physical lease is granted but warns there is nothing to command', async (t) => {
  const { ctx } = await bootPhysical(t);
  const res = await leaseFor(ctx, 'luka', { mode: 'manual' });
  assert.equal(res.status, 201);
  assert.equal(res.lease.mode, 'manual');
  assert.equal(res.body.warnings[0].code, 'no_verified_capabilities');
});

test('aimdk: arm commands are refused by the capability gate, not sent anywhere', async (t) => {
  const { ctx } = await bootPhysical(t);
  const { lease } = await leaseFor(ctx, 'luka', { mode: 'manual' });
  for (const [capability, payload] of [
    ['arms.joints', { joints: { idx13_left_arm_joint1: 0.1 } }],
    ['head.gaze', { yaw: 0.1, pitch: 0 }],
    ['legs.posture', { posture: 'stand' }],
    ['base.velocity', { vx: 0.1, vy: 0, wz: 0 }],
    ['voice.speak', { text: 'hello' }],
  ]) {
    const res = await postJson(ctx, '/robots/luka/commands', command({ leaseId: lease.leaseId, capability, payload }));
    assert.equal(res.status, 409, `${capability} should be refused`);
    assert.equal(res.body.error.code, 'capability_not_commandable');
  }
  const audit = await getJson(ctx, '/audit?limit=20');
  assert.equal(audit.body.entries.filter((e) => e.code === 'capability_not_commandable').length, 5);
});

test('aimdk: the software stop reports that it did not reach the hardware', async (t) => {
  const { ctx } = await bootPhysical(t);
  const res = await postJson(ctx, '/robots/luka/stop', { reason: 'test' });
  assert.equal(res.status, 200);
  assert.equal(res.body.latched, true);
  assert.equal(res.body.certified, false);
  assert.equal(res.body.adapter.supported, false);
  assert.equal(res.body.adapter.delivered, false);
  assert.match(res.body.adapter.note, /factory e-stop/);
});

test('aimdk: losing the link degrades honestly rather than freezing', async (t) => {
  const { ctx, upstream } = await bootPhysical(t);
  await new Promise((resolve) => upstream.server.close(resolve));
  const offline = await waitFor(async () => {
    const { body } = await getJson(ctx, '/robots/luka/state');
    return body.online === false ? body : null;
  });
  assert.equal(offline.health, 'unknown');
  assert.equal(offline.source, 'measured');
  assert.ok(offline.link.lastError);

  const caps = await getJson(ctx, '/robots/luka/capabilities');
  assert.ok(caps.body.capabilities.every((c) => c.supported === false), 'offline means nothing is supported');
  assert.match(caps.body.capabilities[0].reason, /unreachable|offline/i);
});

/* --------------------- gates that protect a real path ------------------- */

const CLAIMED = {
  'head.gaze': { observable: true, commandable: true, writeVerified: true, supervision: false },
  'legs.posture': { observable: true, commandable: true, writeVerified: true, supervision: false },
  'base.velocity': { observable: true, commandable: true, writeVerified: true, supervision: false },
  'arms.joints': { observable: true, commandable: true, writeVerified: true, supervision: false },
};

function claimWrites(gateway, overrides = {}) {
  const robot = gateway.registry.get('luka-sim');
  const original = robot.adapter.capabilities.bind(robot.adapter);
  const claimed = { ...CLAIMED };
  for (const [cap, patch] of Object.entries(overrides)) claimed[cap] = { ...claimed[cap], ...patch };
  robot.adapter.capabilities = () => ({ ...original(), ...claimed });
  robot.physical = true;
  robot.configuration = 'suspended';
  return robot;
}

test('physical writes stay closed when GATEWAY_ALLOW_PHYSICAL is unset', async (t) => {
  const ctx = await boot(t, { physicalEnabled: false });
  claimWrites(ctx.gateway);
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'manual' });
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'physical_path_unverified');
  assert.match(res.body.error.message, /GATEWAY_ALLOW_PHYSICAL/);
});

test('physical writes stay closed when the adapter has not verified the path', async (t) => {
  const ctx = await boot(t, { physicalEnabled: true });
  claimWrites(ctx.gateway, { 'head.gaze': { writeVerified: false } });
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'manual' });
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'physical_path_unverified');
  assert.match(res.body.error.message, /no verified write path/);
});

test('a suspended configuration refuses locomotion and posture, but allows the head', async (t) => {
  const ctx = await boot(t, { physicalEnabled: true });
  claimWrites(ctx.gateway);
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'manual' });

  const head = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(head.status, 200, 'head commands do not need a floor');

  for (const [capability, payload] of [
    ['legs.posture', { posture: 'stand' }],
    ['base.velocity', { vx: 0.1, vy: 0, wz: 0 }],
  ]) {
    const res = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId, capability, payload }));
    assert.equal(res.status, 409, capability);
    assert.equal(res.body.error.code, 'configuration_mismatch');
    assert.equal(res.body.error.details.configuration, 'suspended');
    assert.match(res.body.error.details.note, /feet-contact/);
  }
});

test('the same locomotion becomes available only after the configuration is grounded', async (t) => {
  const ctx = await boot(t, { physicalEnabled: true });
  const robot = claimWrites(ctx.gateway);
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'manual' });

  const blocked = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'legs.posture',
    payload: { posture: 'stand' },
  }));
  assert.equal(blocked.status, 409);

  robot.configuration = 'grounded';
  const allowed = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'legs.posture',
    payload: { posture: 'stand' },
  }));
  assert.equal(allowed.status, 200);
});

test('simulate mode can never be used to drive a physical robot', async (t) => {
  const ctx = await boot(t, { physicalEnabled: true });
  claimWrites(ctx.gateway);
  const res = await leaseFor(ctx, 'luka-sim', { mode: 'simulate' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'mode_not_applicable');
});

test('assisted mode needs a supervision claim that no adapter makes', async (t) => {
  const ctx = await boot(t, { physicalEnabled: true });
  claimWrites(ctx.gateway);
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'assisted' });
  assert.equal(lease.mode, 'assisted');
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({ leaseId: lease.leaseId }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'supervision_unavailable');
});

test('a physical robot cannot be leased in simulate mode', async (t) => {
  const { ctx } = await bootPhysical(t);
  const res = await leaseFor(ctx, 'luka', { mode: 'simulate' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'mode_not_applicable');
  assert.match(res.body.error.message, /simulator robots/);
});
