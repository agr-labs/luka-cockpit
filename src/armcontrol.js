// Arm command layer.
//
// Nothing here invents a protocol. The transport is bound by config/arm-schema.json;
// until that file names a real RPC and a payload shape, the only transport that can
// be constructed is DryRun, which logs the bytes it *would* send.
//
// Everything upstream of the transport is real and matters: per-joint limits from the
// model, slew limiting, deadman/authority gating, and a hard cap on how far a single
// command may move a joint.

import { clamp } from './mathx.js';

export const ARM_JOINTS = {
  left: [
    'idx13_left_arm_joint1', 'idx14_left_arm_joint2', 'idx15_left_arm_joint3',
    'idx16_left_arm_joint4', 'idx17_left_arm_joint5', 'idx18_left_arm_joint6',
    'idx19_left_arm_joint7',
  ],
  right: [
    'idx20_right_arm_joint1', 'idx21_right_arm_joint2', 'idx22_right_arm_joint3',
    'idx23_right_arm_joint4', 'idx24_right_arm_joint5', 'idx25_right_arm_joint6',
    'idx26_right_arm_joint7',
  ],
};

// Manufacturer limits, read from the A2 Ultra interface guide (7.1.9) on
// 2026-10-28. These are authoritative for the arm command topic and are
// intersected with the model's URDF limits: whichever is stricter wins.
export const DOC_LIMITS = {
  idx13_left_arm_joint1: [-2.91, 2.91],
  idx14_left_arm_joint2: [-0.46, 1.60],
  idx15_left_arm_joint3: [-2.91, 2.91],
  idx16_left_arm_joint4: [-2.00, -0.03],
  idx17_left_arm_joint5: [-2.94, 2.94],
  idx18_left_arm_joint6: [-0.45, 0.45],
  idx19_left_arm_joint7: [-0.35, 0.35],
  idx20_right_arm_joint1: [-2.91, 2.91],
  idx21_right_arm_joint2: [-1.60, 0.46],
  idx22_right_arm_joint3: [-2.91, 2.94],
  idx23_right_arm_joint4: [0.03, 2.00],
  idx24_right_arm_joint5: [-2.94, 2.94],
  idx25_right_arm_joint6: [-0.45, 0.45],
  idx26_right_arm_joint7: [-0.35, 0.35],
};

// Vendor "yellow region" for the coupled wrist: narrower than the hard limit
// because the parallel mechanism's reachable set is rhombic, not rectangular.
export const ENVELOPE = {
  idx18_left_arm_joint6: [-0.3, 0.3],
  idx19_left_arm_joint7: [-0.2, 0.2],
  idx25_right_arm_joint6: [-0.3, 0.3],
  idx26_right_arm_joint7: [-0.2, 0.2],
};

// Only these motion actions permit /motion/control/arm_joint_command.
export const PERMITTED_ACTIONS = [
  'PASSIVE_UPPER_BODY_JOINT_SERVO',
  'RL_LOCOMOTION_ARM_EXT_JOINT_SERVO',
  'RL_WHOLE_BODY_EXT_JOINT_SERVO',
];

/** Stricter of the model limit and the documented limit, then the envelope. */
export function effectiveLimits(model, name) {
  const m = model.limits(name) || {};
  const d = DOC_LIMITS[name];
  let lo = Math.max(m.lower ?? -Math.PI, d ? d[0] : -Math.PI);
  let hi = Math.min(m.upper ?? Math.PI, d ? d[1] : Math.PI);
  const env = ENVELOPE[name];
  if (env) { lo = Math.max(lo, env[0]); hi = Math.min(hi, env[1]); }
  return { lower: lo, upper: hi, source: d ? (env ? 'doc+envelope' : 'doc+model') : 'model' };
}

export const RATE_LIMITS = {
  maxRateDegPerSec: 8,      // conservative first-contact slew rate
  maxJogDeg: 5,             // a single jog may never exceed this
  commandHz: 10,            // transport rate
};

/** Transport that refuses to exist without a verified schema. */
export class UnconfiguredTransport {
  constructor(reason) { this.reason = reason; this.mode = 'unconfigured'; }
  async send() { throw new Error(`arm transport not configured: ${this.reason}`); }
}

/** Dry run: records exactly what a real transport would receive. */
export class DryRunTransport {
  constructor() { this.mode = 'dry-run'; this.sent = []; }
  async send(payload, meta) {
    const record = { at: Date.now(), payload, meta };
    this.sent.push(record);
    if (this.sent.length > 50) this.sent.shift();
    return record;
  }
}

/**
 * HTTP transport. Constructed only when the schema says which method to call and
 * how to wrap joint values. Refuses to send anything without an explicit `enabled`.
 */
export class HttpTransport {
  constructor(schema, base = '') {
    if (!schema?.enabled) throw new Error('schema.enabled is false');
    if (!schema.method) throw new Error('schema.method is empty');
    this.schema = schema;
    this.base = base;
    this.mode = 'http';
    this.sent = [];
  }

  buildBody(joints) {
    // The template carries placeholder strings; "$joints" becomes an array of
    // {name, position} pairs and "$map" becomes {name: position}. Anything else
    // is passed through untouched, so the schema stays a plain JSON document.
    const values = Object.entries(joints).map(([name, rad]) => ({ name, position: rad }));
    const map = Object.fromEntries(Object.entries(joints));
    const fill = (node) => {
      if (node === '$joints') return values;
      if (node === '$map') return map;
      if (Array.isArray(node)) return node.map(fill);
      if (node && typeof node === 'object') {
        return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v)]));
      }
      return node;
    };
    return fill(this.schema.template);
  }

  async send(joints) {
    const body = this.buildBody(joints);
    const res = await fetch(`${this.base}/api/arm/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: this.schema.method, body }),
      signal: AbortSignal.timeout(3000),
    });
    const json = await res.json().catch(() => ({}));
    this.sent.push({ at: Date.now(), joints, body, status: res.status, response: json });
    if (this.sent.length > 50) this.sent.shift();
    return { status: res.status, json };
  }
}

export async function makeTransport() {
  let schema = null;
  try {
    const res = await fetch('./config/arm-schema.json');
    if (res.ok) schema = await res.json();
  } catch { /* treated as absent */ }
  if (!schema) return new UnconfiguredTransport('config/arm-schema.json missing');
  if (!schema.enabled) return new UnconfiguredTransport(`schema disabled: ${schema.note || 'no note'}`);
  return new HttpTransport(schema);
}

export class ArmController extends EventTarget {
  constructor(model, safety, transport, options = {}) {
    super();
    this.model = model;
    this.safety = safety;
    this.transport = transport;
    this.excursionRad = ((options.excursionDeg ?? 10) * Math.PI) / 180;
    this.anchor = null;   // measured start pose; null until feedback exists
    this.target = {};       // joint -> radians (desired)
    this.current = {};      // joint -> radians (last commanded)
    this.lastSendAt = -1e9; // never rate-limit the first command
    this.commands = 0;
    this.lastPayload = null;
    for (const side of ['left', 'right']) {
      for (const name of ARM_JOINTS[side]) {
        this.target[name] = 0;
        this.current[name] = 0;
      }
    }
  }

  limits(name) { return effectiveLimits(this.model, name); }

  /**
   * Anchor the operating corridor to a *measured* pose. Until this is called the
   * excursion cap cannot be enforced, which is why no command may be sent first.
   */
  setAnchor(pose) {
    this.anchor = { ...pose };
    return Object.keys(this.anchor).length;
  }

  clearAnchor() { this.anchor = null; }

  setExcursionDeg(deg) { this.excursionRad = (deg * Math.PI) / 180; }

  /** Which motion action the robot reports, and whether it permits arm commands. */
  actionGate(reportedAction) {
    if (!reportedAction) return { ok: false, reason: 'robot action unknown' };
    const short = String(reportedAction).replace(/^McAction_/, '');
    if (PERMITTED_ACTIONS.includes(short)) return { ok: true, action: short };
    return { ok: false, action: short, reason: `${short} does not permit arm commands` };
  }

  setTarget(name, radians) {
    const lim = this.limits(name);
    if (!lim) return false;
    const lo = lim.lower ?? -Math.PI, hi = lim.upper ?? Math.PI;
    let v = clamp(radians, lo, hi);
    if (this.anchor && this.anchor[name] !== undefined) {
      const a = this.anchor[name];
      v = clamp(v, a - this.excursionRad, a + this.excursionRad);
    }
    this.target[name] = v;
    return true;
  }

  jog(name, deltaDeg) {
    const step = clamp(deltaDeg, -RATE_LIMITS.maxJogDeg, RATE_LIMITS.maxJogDeg) * (Math.PI / 180);
    return this.setTarget(name, (this.target[name] ?? 0) + step);
  }

  /** True when the authority chain permits any command at all. */
  canCommand() {
    return safetyAllows(this.safety, this.transport);
  }

  pending() {
    let max = 0;
    for (const k of Object.keys(this.target)) max = Math.max(max, Math.abs(this.target[k] - this.current[k]));
    return max;
  }

  /**
   * Advance toward the targets at the configured slew rate and emit at most one
   * command per tick. Returns the joints that were commanded this tick, or null.
   */
  async step(dt) {
    const maxStep = (RATE_LIMITS.maxRateDegPerSec * Math.PI / 180) * dt;

    // 1. Propose the next increment without committing it.
    const proposed = {};
    for (const k of Object.keys(this.target)) {
      const delta = this.target[k] - this.current[k];
      if (Math.abs(delta) < 1e-5) continue;
      proposed[k] = this.current[k] + clamp(delta, -maxStep, maxStep);
    }
    if (!Object.keys(proposed).length) return null;

    // 2. Rate-limit the transport.
    const now = performance.now();
    if (now - this.lastSendAt < 1000 / RATE_LIMITS.commandHz) return null;

    // 3. Gate before committing, so a refusal never advances the internal state.
    if (!this.canCommand()) return { refused: true, reason: this.refusalReason() };

    // 4. Commit and send.
    this.lastSendAt = now;
    for (const [k, v] of Object.entries(proposed)) this.current[k] = v;

    const result = await this.transport.send(proposed);
    this.commands++;
    this.lastPayload = { joints: proposed, result, mode: this.transport.mode };
    if (typeof CustomEvent !== 'undefined') {
      this.dispatchEvent(new CustomEvent('command', { detail: this.lastPayload }));
    }
    return { batch: proposed, result };
  }

  refusalReason() {
    const s = this.safety;
    if (this.transport.mode === 'unconfigured') return `arm schema not configured (${this.transport.reason})`;
    if (s.estop) return 'E-STOP latched';
    if (s.state !== 'COMPUTER') return `authority is ${s.state}`;
    if (!s.deadman) return 'deadman not held';
    if (!s.linkFresh) return 'telemetry stale';
    return 'unknown';
  }
}

function safetyAllows(safety, transport) {
  if (transport.mode === 'unconfigured') return false;
  if (safety.estop) return false;
  if (safety.state !== 'COMPUTER') return false;
  if (!safety.deadman) return false;
  if (!safety.linkFresh) return false;
  return true;
}
