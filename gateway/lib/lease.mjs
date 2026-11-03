// Control leases.
//
// A lease is the gateway's answer to "who is allowed to move this robot right
// now". It is deliberately boring: one holder, one mode, an expiry, and a
// monotonic epoch so a stale client cannot present yesterday's authority.
//
// The robot's own controller arbitration remains authoritative. A lease is a
// statement about *our* API surface, not about the hardware.

import { randomUUID } from 'node:crypto';
import { conflict, notFound } from './errors.mjs';
import { CONTROL_MODES } from './contract.mjs';

export const DEFAULT_TTL_MS = 30_000;
export const MAX_TTL_MS = 5 * 60_000;

export class LeaseManager {
  constructor({ now = Date.now, defaultTtlMs = DEFAULT_TTL_MS, maxTtlMs = MAX_TTL_MS } = {}) {
    this.now = now;
    this.defaultTtlMs = defaultTtlMs;
    this.maxTtlMs = maxTtlMs;
    this.byRobot = new Map(); // robotId -> lease
    this.epoch = new Map();   // robotId -> last issued epoch
  }

  _prune(robotId) {
    const lease = this.byRobot.get(robotId);
    if (lease && lease.expiresAt <= this.now()) {
      this.byRobot.delete(robotId);
      return null;
    }
    return lease ?? null;
  }

  get(robotId) {
    return this._prune(robotId);
  }

  acquire(robotId, { holder, mode = 'observe', ttlMs, capabilities } = {}) {
    if (typeof holder !== 'string' || holder.trim().length === 0) {
      throw conflict('lease_invalid_holder', 'holder must be a non-empty string');
    }
    if (!CONTROL_MODES.includes(mode)) {
      throw conflict('lease_invalid_mode', `mode must be one of ${CONTROL_MODES.join(', ')}`);
    }
    const ttl = ttlMs ?? this.defaultTtlMs;
    if (!Number.isFinite(ttl) || ttl < 1000 || ttl > this.maxTtlMs) {
      throw conflict('lease_invalid_ttl', `ttlMs must be between 1000 and ${this.maxTtlMs}`);
    }
    if (capabilities !== undefined && capabilities !== null) {
      if (!Array.isArray(capabilities) || capabilities.some((c) => typeof c !== 'string')) {
        throw conflict('lease_invalid_scope', 'capabilities must be an array of capability ids');
      }
    }

    const existing = this._prune(robotId);
    if (existing && existing.holder !== holder) {
      throw conflict('lease_held', `robot is under lease by "${existing.holder}"`, {
        holder: existing.holder,
        expiresAt: existing.expiresAt,
        mode: existing.mode,
      });
    }

    const epoch = (this.epoch.get(robotId) ?? 0) + 1;
    this.epoch.set(robotId, epoch);
    const lease = {
      leaseId: `lease_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      robotId,
      holder,
      mode,
      capabilities: capabilities ?? null,
      epoch,
      issuedAt: this.now(),
      ttlMs: ttl,
      expiresAt: this.now() + ttl,
    };
    this.byRobot.set(robotId, lease);
    return lease;
  }

  /** Extend an existing lease. Only its holder may renew it. */
  renew(robotId, leaseId, { ttlMs } = {}) {
    const lease = this._prune(robotId);
    if (!lease) throw notFound('no active lease to renew');
    if (lease.leaseId !== leaseId) {
      throw conflict('lease_mismatch', 'leaseId does not match the active lease', {
        activeHolder: lease.holder,
      });
    }
    const ttl = ttlMs ?? lease.ttlMs;
    if (!Number.isFinite(ttl) || ttl < 1000 || ttl > this.maxTtlMs) {
      throw conflict('lease_invalid_ttl', `ttlMs must be between 1000 and ${this.maxTtlMs}`);
    }
    const epoch = (this.epoch.get(robotId) ?? lease.epoch) + 1;
    this.epoch.set(robotId, epoch);
    const renewed = { ...lease, ttlMs: ttl, expiresAt: this.now() + ttl, epoch };
    this.byRobot.set(robotId, renewed);
    return renewed;
  }

  release(robotId, leaseId) {
    const lease = this._prune(robotId);
    if (!lease) return { released: false, reason: 'no active lease' };
    if (lease.leaseId !== leaseId) {
      throw conflict('lease_mismatch', 'leaseId does not match the active lease', { holder: lease.holder });
    }
    this.byRobot.delete(robotId);
    return { released: true, leaseId };
  }

  revoke(robotId, reason) {
    const lease = this._prune(robotId);
    this.byRobot.delete(robotId);
    return lease ? { revoked: true, leaseId: lease.leaseId, holder: lease.holder, reason } : { revoked: false, reason };
  }

  /** Returns the active lease or throws the precise reason a command may not run. */
  require(robotId, leaseId) {
    if (typeof leaseId !== 'string' || !leaseId) {
      throw conflict('lease_required', 'leaseId is required for a command; POST /leases first');
    }
    const lease = this._prune(robotId);
    if (!lease) throw conflict('lease_required', 'no active lease; POST /leases first');
    if (lease.leaseId !== leaseId) {
      throw conflict('lease_mismatch', 'leaseId does not match the active lease', {
        holder: lease.holder,
        expiresAt: lease.expiresAt,
      });
    }
    return lease;
  }
}
