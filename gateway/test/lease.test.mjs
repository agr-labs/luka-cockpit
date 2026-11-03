// Lease semantics, with a fake clock. These are the rules the HTTP layer relies
// on, so they are tested directly rather than through requests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LeaseManager } from '../lib/lease.mjs';

function clock(start = 1_700_000_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

test('an acquired lease is exclusive to its holder', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  const lease = leases.acquire('luka', { holder: 'alice', mode: 'simulate' });
  assert.equal(lease.holder, 'alice');
  assert.equal(lease.mode, 'simulate');
  assert.equal(lease.epoch, 1);

  assert.throws(
    () => leases.acquire('luka', { holder: 'bob', mode: 'simulate' }),
    (err) => err.status === 409 && err.code === 'lease_held',
  );
});

test('the same holder re-acquiring replaces the lease and bumps the epoch', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  const first = leases.acquire('luka', { holder: 'alice', mode: 'observe' });
  const second = leases.acquire('luka', { holder: 'alice', mode: 'simulate' });
  assert.notEqual(first.leaseId, second.leaseId);
  assert.equal(second.epoch, 2);
  assert.equal(leases.get('luka').leaseId, second.leaseId);
});

test('leases expire on the clock, not on a timer', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  leases.acquire('luka', { holder: 'alice', mode: 'simulate', ttlMs: 1000 });
  now.advance(999);
  assert.ok(leases.get('luka'));
  now.advance(2);
  assert.equal(leases.get('luka'), null);
  assert.throws(() => leases.require('luka', 'anything'), (e) => e.code === 'lease_required');
});

test('renewal extends and re-epochs; a stranger cannot renew', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  const lease = leases.acquire('luka', { holder: 'alice', mode: 'simulate', ttlMs: 10_000 });
  now.advance(5_000);
  const renewed = leases.renew('luka', lease.leaseId, { ttlMs: 20_000 });
  assert.equal(renewed.expiresAt, now() + 20_000);
  assert.equal(renewed.epoch, lease.epoch + 1);

  assert.throws(
    () => leases.renew('luka', 'lease_someoneelse'),
    (e) => e.status === 409 && e.code === 'lease_mismatch',
  );
});

test('scopes are enforced against the lease, not globally', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  leases.acquire('luka', { holder: 'alice', mode: 'simulate', capabilities: ['head.gaze'] });
  assert.equal(leases.require('luka', leases.get('luka').leaseId).capabilities[0], 'head.gaze');
});

test('ttl bounds are enforced', () => {
  const leases = new LeaseManager({ now: clock() });
  assert.throws(() => leases.acquire('luka', { holder: 'a', ttlMs: 10 }), (e) => e.code === 'lease_invalid_ttl');
  assert.throws(() => leases.acquire('luka', { holder: 'a', ttlMs: 999_999 }), (e) => e.code === 'lease_invalid_ttl');
});

test('invalid holders and modes are refused', () => {
  const leases = new LeaseManager({ now: clock() });
  assert.throws(() => leases.acquire('luka', { holder: '   ' }), (e) => e.code === 'lease_invalid_holder');
  assert.throws(() => leases.acquire('luka', { holder: 'a', mode: 'telepathy' }), (e) => e.code === 'lease_invalid_mode');
});

test('a mismatch between leaseId and the active lease is explicit', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  leases.acquire('luka', { holder: 'alice', mode: 'simulate' });
  assert.throws(() => leases.require('luka', 'lease_wrong'), (e) => e.code === 'lease_mismatch');
  assert.throws(() => leases.require('luka', undefined), (e) => e.status === 409 && e.code === 'lease_required');
});

test('revocation reports what it removed', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  leases.acquire('luka', { holder: 'alice', mode: 'simulate' });
  const revoked = leases.revoke('luka', 'operator stop');
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.holder, 'alice');
  assert.deepEqual(leases.revoke('luka', 'again'), { revoked: false, reason: 'again' });
});

test('release by a foreign leaseId is refused', () => {
  const now = clock();
  const leases = new LeaseManager({ now });
  const lease = leases.acquire('luka', { holder: 'alice' });
  assert.throws(() => leases.release('luka', 'lease_other'), (e) => e.status === 409 && e.code === 'lease_mismatch');
  assert.deepEqual(leases.release('luka', lease.leaseId), { released: true, leaseId: lease.leaseId });
  assert.equal(leases.get('luka'), null);
});
