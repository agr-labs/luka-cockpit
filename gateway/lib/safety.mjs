// Safety layer.
//
// Two jobs:
//   1. remember whether the operator has latched the software stop, and
//   2. decide, in one place, whether a command may reach an adapter at all.
//
// The decision order is deliberate: stop, capability, link, authority, physical
// reality, configuration, payload. A refusal always names the gate that closed,
// so the console can say why rather than "failed".
//
// Nothing here is a certified safety function. The factory e-stop is.

import { conflict, methodNotAllowed, notFound, unavailable, unprocessable } from './errors.mjs';
import { summarizeErrors } from './validate.mjs';

export class StopLatch {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.byRobot = new Map();
  }

  state(robotId) {
    const s = this.byRobot.get(robotId);
    return s
      ? { latched: true, ...s }
      : { latched: false, reason: null, at: null, scope: null, actor: null };
  }

  latch(robotId, { reason = 'operator software stop', scope = 'all', actor = 'anonymous' } = {}) {
    const state = { reason, scope, actor, at: new Date(this.now()).toISOString() };
    this.byRobot.set(robotId, state);
    return { latched: true, ...state };
  }

  /** Clearing a latch is a separate, auditable act — never implicit in a command. */
  clear(robotId, { confirm, reason, actor = 'anonymous' } = {}) {
    if (confirm !== 'rearm') {
      throw conflict('rearm_confirmation_required', 'POST /rearm requires {"confirm":"rearm"}', {
        expected: { confirm: 'rearm' },
      });
    }
    const was = this.state(robotId);
    this.byRobot.delete(robotId);
    return {
      latched: false,
      was,
      clearedAt: new Date(this.now()).toISOString(),
      clearedBy: actor,
      reason: reason ?? null,
      note: 'Software latch cleared. This did not test, reset or acknowledge any hardware safety system.',
    };
  }
}

/**
 * Gate chain for one command.
 *
 * @param {object} args
 * @param {object} args.robot           registry entry: { id, physical, configuration, adapter }
 * @param {object} args.capability      contract descriptor
 * @param {object|null} args.adapterCap adapter's own declaration for this capability
 * @param {object} args.lease           active lease (already validated)
 * @param {string} args.mode            lease.mode
 * @param {boolean} args.physicalEnabled gateway-wide physical write permission
 * @param {object} args.validation      result of validatePayload()
 * @param {number} args.deadlineMs      absolute epoch ms
 * @param {number} args.now
 */
export function assertCommandAllowed({
  robot, capability, adapterCap, lease, mode, physicalEnabled, validation, deadlineMs, now,
}) {
  if (!capability) throw notFound('unknown capability');
  if (capability.readOnly) {
    throw methodNotAllowed(`${capability.id} is read-only; read it from /state or /joints`);
  }

  // A profile lock is a statement of intent about this robot, not a capability
  // gap. It is checked before the adapter so the answer stays the same whether
  // the robot is online, offline, or has no write path at all: we do not ask.
  const lock = (robot.profile?.locks ?? []).find((l) => l.capability === capability.id);
  if (lock) {
    throw conflict('profile_lock', `${capability.id} is locked by profile "${robot.profile.name}"`, {
      profile: robot.profile.name,
      reason: lock.reason,
      lockedBy: 'profile',
      note: 'Locks are configuration, verified by tests, and reported in GET /state. Removing one is a reviewed change, not an API call.',
    });
  }

  if (!adapterCap) {
    throw notFound(`adapter "${robot.adapterName}" does not implement ${capability.id}`);
  }
  if (!adapterCap.commandable) {
    throw conflict('capability_not_commandable', adapterCap.reason ?? `${capability.id} is observable but not commandable on this adapter`, {
      capability: capability.id,
      adapter: robot.adapterName,
      observable: Boolean(adapterCap.observable),
    });
  }
  if (!robot.online) {
    throw unavailable(`robot "${robot.id}" is offline`);
  }
  if (mode === 'observe') {
    throw conflict('mode_read_only', 'lease mode "observe" cannot send commands', { mode });
  }

  const physicalPath = capability.physical && robot.physical;
  if (physicalPath) {
    if (mode === 'simulate') {
      throw conflict('physical_in_simulate_mode', 'simulate mode never writes to hardware; request a manual lease to command a physical robot', {
        capability: capability.id,
        robotPhysical: true,
      });
    }
    if (!physicalEnabled) {
      throw conflict('physical_path_unverified', 'physical writes are disabled at the gateway (GATEWAY_ALLOW_PHYSICAL is not 1)', {
        capability: capability.id,
      });
    }
    if (!adapterCap.writeVerified) {
      throw conflict('physical_path_unverified', `no verified write path for ${capability.id} on this adapter`, {
        capability: capability.id,
        adapter: robot.adapterName,
        note: 'The capability stays observable and simulator-commandable until its firmware interface, limits, feedback and stop behaviour are established.',
      });
    }
    if (mode === 'assisted' && !adapterCap.supervision) {
      throw conflict('supervision_unavailable', 'assisted mode requires an adapter with verified motion supervision');
    }
  }

  if (capability.requires.includes('grounded') && robot.configuration !== 'grounded') {
    throw conflict('configuration_mismatch', `${capability.id} requires a grounded configuration; this robot is configured "${robot.configuration}"`, {
      configuration: robot.configuration,
      required: 'grounded',
      note: 'The feet-contact startup procedure is unverified for Luka. Do not relax leg actuators or enable locomotion on the strength of a third-party guide.',
    });
  }

  if (lease.capabilities && !lease.capabilities.includes(capability.id)) {
    throw conflict('lease_scope', `lease does not include ${capability.id}`, { scope: lease.capabilities });
  }

  if (!validation.ok) {
    throw unprocessable(`payload rejected: ${validation.summary ?? summarizeErrors(validation.errors)}`, {
      errors: validation.errors,
    });
  }

  if (!Number.isFinite(deadlineMs)) {
    throw conflict('deadline_required', 'deadlineMs must be an absolute epoch millisecond timestamp');
  }
  if (deadlineMs <= now) {
    throw conflict('deadline_expired', 'command arrived after its deadline', {
      deadlineMs,
      now,
      lateByMs: now - deadlineMs,
    });
  }

  return { warnings: validation.warnings ?? [] };
}

/** How a capability may be used, given the robot and the adapter's honesty. */
export function modesFor({ robot, capability, adapterCap, physicalEnabled }) {
  const modes = [];
  if (capability.observable && adapterCap?.observable) modes.push('observe');
  if ((robot.profile?.locks ?? []).some((l) => l.capability === capability.id)) return modes;
  if (!capability.commandable || !adapterCap?.commandable) return modes;
  if (!robot.physical) {
    modes.push('simulate');
    return modes;
  }
  if (physicalEnabled && adapterCap.writeVerified) {
    modes.push('manual');
    if (adapterCap.supervision) modes.push('assisted');
  }
  return modes;
}
