// The Suspended Test profile.
//
// The profile is policy: it can lock capabilities before the adapter, the lease
// or the physical-write gate are consulted. These tests prove the lock is
// explicit, reasoned, visible in state, and not bypassable by a stronger lease
// or a verified write path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { boot, command, getJson, leaseFor, postJson } from './helpers.mjs';

const ROOT = new URL('../../', import.meta.url);

const SUSPENDED = {
  id: 'luka-sim',
  label: 'Suspended rig',
  adapter: 'simulator',
  physical: false,
  // Deliberately grounded: if the refusal were merely the ground-contact gate,
  // this test would pass for the wrong reason.
  configuration: 'grounded',
  profile: {
    name: 'suspended-test',
    label: 'Suspended test profile',
    suspension: 'full weight',
    feet: 'clear of floor',
    rig: 'rated for full weight',
    locomotion: 'locked',
    armControl: 'simulation only',
    motionSchema: 'unverified',
    controller: 'AimMaster (preserved)',
    locks: [
      { capability: 'base.velocity', reason: 'locomotion is locked by the suspended test profile' },
      { capability: 'legs.posture', reason: 'leg posture changes are locked while suspended' },
    ],
  },
};

test('the shipped Luka config carries the suspended profile and its locks', async () => {
  const config = JSON.parse(await readFile(new URL('gateway/config/robots.json', ROOT), 'utf8'));
  const luka = config.robots.find((r) => r.id === 'luka');
  assert.equal(luka.configuration, 'suspended');
  assert.equal(luka.profile.name, 'suspended-test');
  assert.equal(luka.profile.feet, 'clear of floor');
  assert.equal(luka.profile.suspension, 'full weight');
  assert.equal(luka.profile.armControl, 'simulation only');
  assert.equal(luka.profile.motionSchema, 'unverified');

  const locked = luka.profile.locks.map((l) => l.capability).sort();
  assert.deepEqual(locked, ['base.velocity', 'legs.posture']);
  for (const lock of luka.profile.locks) assert.ok(lock.reason.length > 20, 'every lock needs a real reason');
});

test('a profile lock refuses locomotion with profile_lock, before any other gate', async (t) => {
  const ctx = await boot(t, { robots: [SUSPENDED] });
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'simulate' });
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'base.velocity',
    payload: { vx: 0.1, vy: 0, wz: 0 },
  }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'profile_lock');
  assert.equal(res.body.error.details.profile, 'suspended-test');
  assert.match(res.body.error.details.reason, /locomotion is locked/);
});

test('a profile lock is not bypassed by mode or a stronger lease', async (t) => {
  const ctx = await boot(t, { robots: [SUSPENDED] });
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'simulate', capabilities: ['base.velocity'] });
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'base.velocity',
    payload: { vx: 0, vy: 0, wz: 0 },
  }));
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'profile_lock');
});

test('head control remains available under the suspended profile', async (t) => {
  const ctx = await boot(t, { robots: [SUSPENDED] });
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'simulate' });
  const res = await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'head.gaze',
    payload: { yaw: 0.3, pitch: 0.1 },
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true);
});

test('locked capabilities report observe-only modes and the lock reason', async (t) => {
  const ctx = await boot(t, { robots: [SUSPENDED] });
  const { body } = await getJson(ctx, '/robots/luka-sim/capabilities');
  const byId = Object.fromEntries(body.capabilities.map((c) => [c.capability, c]));

  assert.equal(byId['base.velocity'].locked, true);
  assert.equal(byId['base.velocity'].commandable, false);
  assert.deepEqual(byId['base.velocity'].modes, ['observe']);
  assert.match(byId['base.velocity'].reason, /locked by the suspended test profile/);

  assert.equal(byId['head.gaze'].locked, false);
  assert.ok(byId['head.gaze'].modes.includes('simulate'));
  assert.equal(body.profile.name, 'suspended-test');
});

test('state advertises the full profile so a UI cannot invent one', async (t) => {
  const ctx = await boot(t, { robots: [SUSPENDED] });
  const { body } = await getJson(ctx, '/robots/luka-sim/state');
  assert.equal(body.profile.name, 'suspended-test');
  assert.equal(body.profile.rig, 'rated for full weight');
  assert.deepEqual(body.profile.locks.map((l) => l.capability).sort(), ['base.velocity', 'legs.posture']);
});

test('profile locks are audited with their reason', async (t) => {
  const ctx = await boot(t, { robots: [SUSPENDED] });
  const { lease } = await leaseFor(ctx, 'luka-sim', { mode: 'simulate' });
  await postJson(ctx, '/robots/luka-sim/commands', command({
    leaseId: lease.leaseId,
    capability: 'legs.posture',
    payload: { posture: 'stand' },
  }));
  const { body } = await getJson(ctx, '/audit?limit=10');
  const entry = body.entries.find((e) => e.code === 'profile_lock');
  assert.ok(entry);
  assert.equal(entry.capability, 'legs.posture');
  assert.match(entry.message, /locked by profile/);
});

test('the lock survives a config with no profile (defaults are explicit)', async (t) => {
  const ctx = await boot(t);
  const { body } = await getJson(ctx, '/robots/luka-sim/state');
  assert.equal(body.profile.name, 'default');
  assert.deepEqual(body.profile.locks, []);
  assert.equal(body.profile.locomotion, null);
});
