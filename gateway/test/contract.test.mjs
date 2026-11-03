// Contract tests. Two jobs: prove the validator refuses the right things, and
// prove the limits here still match the vendor schema file the cockpit ships.
// The second is drift detection — the day someone edits one, this fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ARM_JOINTS, ARM_LIMITS, CAPABILITIES, HEAD_LIMITS, WRIST_ENVELOPE,
  contractDocument, validatePayload,
} from '../lib/contract.mjs';

const ROOT = new URL('../../', import.meta.url);

test('every capability has an id that matches its key', () => {
  for (const [key, cap] of Object.entries(CAPABILITIES)) {
    assert.equal(cap.id, key);
    assert.ok(typeof cap.label === 'string' && cap.label.length > 0);
    assert.ok(Array.isArray(cap.requires));
  }
});

test('arm limits are identical to config/arm-schema.json', async () => {
  const schema = JSON.parse(await readFile(new URL('config/arm-schema.json', ROOT), 'utf8'));
  assert.deepEqual(Object.keys(ARM_LIMITS), schema.command.jointOrder);
  for (const joint of schema.command.jointOrder) {
    assert.deepEqual(ARM_LIMITS[joint], schema.limits.hard[joint], `drift on ${joint}`);
  }
});

test('wrist envelope matches the vendor recommendation', async () => {
  const schema = JSON.parse(await readFile(new URL('config/arm-schema.json', ROOT), 'utf8'));
  for (const [joint, range] of Object.entries(WRIST_ENVELOPE)) {
    assert.deepEqual(range, schema.limits.recommendedEnvelope[joint], `drift on ${joint}`);
  }
  assert.equal(Object.keys(WRIST_ENVELOPE).length, Object.keys(schema.limits.recommendedEnvelope).length - 1);
});

test('head limits match the URDF when the model payload is present', async (t) => {
  let model;
  try {
    model = JSON.parse(await readFile(new URL('model/generated/luka.model.json', ROOT), 'utf8'));
  } catch {
    t.diagnostic('model/generated/luka.model.json absent — run tools/fetch-model.sh');
    return;
  }
  const byName = Object.fromEntries(model.joints.map((j) => [j.name, j]));
  assert.deepEqual([byName.idx27_head_joint1.lower, byName.idx27_head_joint1.upper], HEAD_LIMITS.joint1);
  assert.deepEqual([byName.idx28_head_joint2.lower, byName.idx28_head_joint2.upper], HEAD_LIMITS.joint2);
});

test('the arm schema stays disabled in the cockpit', async () => {
  const schema = JSON.parse(await readFile(new URL('config/arm-schema.json', ROOT), 'utf8'));
  assert.equal(schema.enabled, false, 'arm transport must stay disabled until robot-side review');
});

test('valid head gaze passes', () => {
  const r = validatePayload('head.gaze', { yaw: 0.4, pitch: -0.2 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('out-of-range values are refused with the binding limit, not clamped', () => {
  const r = validatePayload('head.gaze', { yaw: 9, pitch: 0 });
  assert.equal(r.ok, false);
  const limit = r.errors.find((e) => e.path === '$.yaw');
  assert.equal(limit.keyword, 'maximum');
  assert.equal(limit.bound, HEAD_LIMITS.joint1[1]);
});

test('NaN and infinities never pass as numbers', () => {
  const r = validatePayload('head.gaze', { yaw: Number.NaN, pitch: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].keyword, 'type');
});

test('unknown fields are refused rather than ignored', () => {
  const r = validatePayload('head.gaze', { yaw: 0, pitch: 0, speed: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].keyword, 'additionalProperties');
});

test('arm joints: unknown joint names are refused', () => {
  const r = validatePayload('arms.joints', { joints: { idx99_made_up: 0 } });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].keyword, 'additionalProperties');
});

test('arm joints: empty goal set is refused', () => {
  const r = validatePayload('arms.joints', { joints: {} });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].keyword, 'minProperties');
});

test('arm joints: inside the wrist envelope produces no warning', () => {
  const r = validatePayload('arms.joints', { joints: { idx18_left_arm_joint6: 0.2, idx19_left_arm_joint7: 0.1 } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, []);
});

test('arm joints: inside the hard limit but outside the envelope warns', () => {
  const r = validatePayload('arms.joints', { joints: { idx18_left_arm_joint6: 0.40 } });
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'recommended_envelope');
  assert.equal(r.warnings[0].joint, 'idx18_left_arm_joint6');
});

test('hands: presets may not carry a raw value', () => {
  const r = validatePayload('hands.grasp', { side: 'left', action: 'close', value: 100 });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /preset/);
});

test('hands: "set" requires a finger and a value', () => {
  const missing = validatePayload('hands.grasp', { side: 'left', action: 'set' });
  assert.equal(missing.ok, false);
  assert.equal(missing.errors.length, 2);
  const complete = validatePayload('hands.grasp', { side: 'left', action: 'set', finger: 'thumb', value: 1200 });
  assert.equal(complete.ok, true);
});

test('base velocity stays inside the cockpit clamp', () => {
  assert.equal(validatePayload('base.velocity', { vx: 0.35, vy: -0.25, wz: 0.6 }).ok, true);
  const fast = validatePayload('base.velocity', { vx: 0.36, vy: 0, wz: 0 });
  assert.equal(fast.ok, false);
  assert.equal(fast.errors[0].bound, 0.35);
});

test('speech text length is bounded', () => {
  assert.equal(validatePayload('voice.speak', { text: 'hello' }).ok, true);
  assert.equal(validatePayload('voice.speak', { text: '' }).ok, false);
  assert.equal(validatePayload('voice.speak', { text: 'x'.repeat(501) }).ok, false);
});

test('cartesian goals are bounded and require a side', () => {
  assert.equal(validatePayload('arms.cartesian', { side: 'left', position: { x: 0.2, y: 0.5, z: -0.3 } }).ok, true);
  assert.equal(validatePayload('arms.cartesian', { side: 'middle', position: { x: 0, y: 0.5, z: 0 } }).ok, false);
  assert.equal(validatePayload('arms.cartesian', { side: 'left', position: { x: 2, y: 0.5, z: 0 } }).ok, false);
});

test('contract document advertises the same capability set', () => {
  const doc = contractDocument();
  assert.equal(doc.apiVersion, 'v1');
  assert.deepEqual(doc.capabilities.map((c) => c.capability).sort(), Object.keys(CAPABILITIES).sort());
  assert.ok(doc.capabilities.every((c) => c.label && c.summary));
  assert.equal(doc.capabilities.find((c) => c.capability === 'motion.state').readOnly, true);
});
