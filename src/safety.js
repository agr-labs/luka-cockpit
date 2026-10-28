// Control-authority state machine and command gate.
//
// This is OUR guard rail, not an AGIBOT arbitration mechanism. It exists because
// the manufacturer documentation does not yet establish how the factory AimMaster
// controller and an SDK client interact. Treat every transition below as a
// local precondition, and treat the robot's own safety system as authoritative.

import { clamp } from './mathx.js';

export const STATE = {
  MANUAL: 'MANUAL',
  ARMED: 'ARMED',
  COMPUTER: 'COMPUTER',
  SAFE_HANDOFF: 'SAFE_HANDOFF',
  FAULT: 'FAULT',
};

export const LIMITS = {
  vx: { min: -0.35, max: 0.35, unit: 'm/s' },
  vy: { min: -0.25, max: 0.25, unit: 'm/s' },
  wz: { min: -0.60, max: 0.60, unit: 'rad/s' },
  commandTimeoutMs: 250,     // our watchdog; shorter than doc'd 500 ms mode-1 stop
  maxCommandHz: 30,
};

export class SafetyController extends EventTarget {
  constructor() {
    super();
    this.state = STATE.MANUAL;
    this.deadman = false;
    this.estop = false;
    this.linkFresh = false;
    // Suspended test profile: this build has no locomotion transport at all, and
    // this flag makes that structural fact an enforced one rather than a comment.
    this.locomotionLocked = true;
    this.lastCommandAt = 0;
    this.commandsSent = 0;
    this.rejections = 0;
    this.lastReject = null;
    this.lastRejectAt = 0;
    this.log = [];
    this.watchdogFired = false;
    this.vel = { vx: 0, vy: 0, wz: 0 };
  }

  note(text, level = 'info') {
    this.log.push({ t: Date.now(), text, level });
    if (this.log.length > 200) this.log.shift();
    this.dispatchEvent(new CustomEvent('log', { detail: this.log[this.log.length - 1] }));
    this.emit();
  }

  emit() {
    this.dispatchEvent(new CustomEvent('state', { detail: this.snapshot() }));
  }

  snapshot() {
    return {
      state: this.state,
      deadman: this.deadman,
      estop: this.estop,
      linkFresh: this.linkFresh,
      locomotionLocked: this.locomotionLocked,
      vel: { ...this.vel },
      commandsSent: this.commandsSent,
      rejections: this.rejections,
      lastReject: this.lastReject,
      watchdogFired: this.watchdogFired,
    };
  }

  setLinkFresh(fresh) {
    if (this.linkFresh === fresh) return;
    this.linkFresh = fresh;
    if (!fresh && (this.state === STATE.ARMED || this.state === STATE.COMPUTER)) {
      this.dropToManual('telemetry stale');
    }
    this.emit();
  }

  setDeadman(down) {
    if (this.deadman === down) return;
    this.deadman = down;
    if (!down && this.state === STATE.COMPUTER) this.dropToManual('deadman released');
    this.emit();
  }

  emergencyStop() {
    this.estop = true;
    this.zero();
    this.state = STATE.SAFE_HANDOFF;
    this.note('software stop engaged -> SAFE_HANDOFF (not a verified emergency stop)', 'critical');
  }

  clearEstop() {
    this.estop = false;
    this.state = STATE.MANUAL;
    this.note('software stop cleared, authority returned to factory controller', 'warn');
  }

  dropToManual(reason) {
    if (this.state === STATE.MANUAL) return;
    this.zero();
    this.state = STATE.MANUAL;
    this.note(`authority -> MANUAL (${reason})`, 'warn');
  }

  arm() {
    if (this.estop) return this.reject('cannot arm: software stop latched');
    if (!this.linkFresh) return this.reject('cannot arm: telemetry not fresh');
    if (!this.deadman) return this.reject('cannot arm: hold deadman first');
    this.state = STATE.ARMED;
    this.note('armed: operator holds authority, no commands issued yet');
  }

  engage() {
    if (this.state !== STATE.ARMED) return this.reject('cannot engage: not armed');
    if (!this.deadman) return this.reject('cannot engage: deadman not held');
    if (!this.linkFresh) return this.reject('cannot engage: telemetry not fresh');
    this.state = STATE.COMPUTER;
    this.note('computer control engaged (dry-run gate active)', 'warn');
  }

  handoff(reason = 'operator handoff') {
    this.zero();
    this.state = STATE.SAFE_HANDOFF;
    this.note(`handoff requested (${reason})`, 'warn');
    setTimeout(() => {
      if (this.state === STATE.SAFE_HANDOFF) {
        this.state = STATE.MANUAL;
        this.note('handoff verified -> MANUAL, factory controller authoritative');
      }
    }, 600);
  }

  zero() {
    this.vel = { vx: 0, vy: 0, wz: 0 };
  }

  reject(reason) {
    // Collapse identical rejections from the 30 Hz command loop into one event
    // per second, otherwise the log and counter are useless.
    const now = Date.now();
    if (reason === this.lastReject && now - this.lastRejectAt < 1000) return false;
    this.lastReject = reason;
    this.lastRejectAt = now;
    this.rejections++;
    this.note(`rejected: ${reason}`, 'error');
    return false;
  }

  /** Request a base velocity. Returns the accepted (clamped) command or null. */
  requestVelocity(vx, vy, wz, isConnected) {
    if (this.locomotionLocked) { this.reject('locomotion locked by test profile'); return null; }
    if (this.estop) { this.reject('software stop latched'); return null; }
    if (this.state !== STATE.COMPUTER) { this.reject('not in COMPUTER state'); return null; }
    if (!this.deadman) { this.reject('deadman not held'); return null; }
    if (!this.linkFresh) { this.reject('telemetry stale'); return null; }
    if (!isConnected) { this.reject('robot link down'); return null; }

    const now = performance.now();
    if (now - this.lastCommandAt < 1000 / LIMITS.maxCommandHz) return this.vel;

    const cmd = {
      vx: clamp(vx, LIMITS.vx.min, LIMITS.vx.max),
      vy: clamp(vy, LIMITS.vy.min, LIMITS.vy.max),
      wz: clamp(wz, LIMITS.wz.min, LIMITS.wz.max),
    };
    this.vel = cmd;
    this.lastCommandAt = now;
    this.commandsSent++;
    this.watchdogFired = false;
    return cmd;
  }

  /** Called every frame. If commands dry up while we hold authority, zero out. */
  tickWatchdog(nowMs) {
    if (this.state !== STATE.COMPUTER) return;
    if (this.lastCommandAt && nowMs - this.lastCommandAt > LIMITS.commandTimeoutMs) {
      if (!this.watchdogFired) {
        this.watchdogFired = true;
        this.zero();
        this.note('command watchdog expired -> zero velocity', 'critical');
      }
    }
  }
}
