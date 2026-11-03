// AimDK adapter — read-only, and honest about it.
//
// It speaks the vendor's HTTP gateway (AimMaster, port 56322): GetAction,
// GetJointState, GetNeckState, GetHandState. Those are the four calls verified
// against Luka. It implements no writes, so every command capability is
// declared `commandable: false` and the gateway refuses before this code runs.
//
// The point of the adapter is to prove that a physical robot can appear in the
// same contract as the simulator with strictly less authority — not to sneak a
// ROS 2 publisher in through the HTTP door.

import { conflict } from '../lib/errors.mjs';

export const ADAPTER = 'aimdk';
export const KIND = 'physical';

const READ_CALLS = {
  action: 'aimdk.protocol.McActionService/GetAction',
  joints: 'aimdk.protocol.McDataService/GetJointState',
  neck: 'aimdk.protocol.McDataService/GetNeckState',
  hands: 'aimdk.protocol.McDataService/GetHandState',
};

export function create({ config, emit = () => {} } = {}) {
  const id = config.id;
  const opts = config.options ?? {};
  const host = opts.host ?? process.env.A2_HOST ?? '192.168.4.136';
  const port = Number(opts.port ?? process.env.A2_PORT ?? 56322);
  const timeoutMs = Number(opts.timeoutMs ?? 3000);
  const actionHz = Number(opts.actionHz ?? 0.2);   // vendor guidance: <= 0.2 Hz
  const jointsHz = Number(opts.jointsHz ?? 5);     // documented exception, D9
  const now = config.now ?? Date.now;

  const cache = {
    action: null, actionAt: 0,
    joints: null, jointsAt: 0,
    neck: null, neckAt: 0,
    hands: null, handsAt: 0,
  };

  let online = false;
  let lastError = null;
  let lastSuccessAt = 0;
  const timers = [];
  let closed = false;

  async function rpc(method) {
    const res = await fetch(`http://${host}:${port}/rpc/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function markOnline() {
    if (!online) emit('event', { kind: 'link_up', host, port });
    online = true;
    lastError = null;
    lastSuccessAt = now();
  }

  function markOffline(err) {
    const message = String(err?.message ?? err);
    if (online) emit('event', { kind: 'link_down', host, port, message });
    online = false;
    lastError = message;
  }

  async function pollAction() {
    try {
      const json = await rpc(READ_CALLS.action);
      cache.action = json;
      cache.actionAt = now();
      markOnline();
    } catch (err) {
      markOffline(err);
    }
  }

  async function pollJoints() {
    try {
      const json = await rpc(READ_CALLS.joints);
      const states = findJointStates(json);
      if (!states.length) throw new Error('GetJointState returned no joints');
      const joints = {};
      const velocities = {};
      for (const s of states) {
        if (typeof s.position === 'number') joints[s.name] = s.position;
        if (typeof s.velocity === 'number') velocities[s.name] = s.velocity;
      }
      cache.joints = { joints, velocities, count: states.length };
      cache.jointsAt = now();
      markOnline();
    } catch (err) {
      markOffline(err);
    }
  }

  async function pollNeck() {
    try {
      const json = await rpc(READ_CALLS.neck);
      cache.neck = { ...extractNeck(json), at: now() };
      cache.neckAt = now();
    } catch { /* neck is a bonus; joints carry the health decision */ }
  }

  async function pollHands() {
    try {
      const json = await rpc(READ_CALLS.hands);
      cache.hands = { ...extractHands(json), at: now() };
      cache.handsAt = now();
    } catch { /* same */ }
  }

  function schedule(fn, hz) {
    if (!(hz > 0)) return;
    const period = Math.max(200, 1000 / hz);
    fn();
    const t = setInterval(fn, period);
    t.unref?.();
    timers.push(t);
  }

  function state() {
    const t = now();
    const action = cache.action?.info?.current_action ?? null;
    const status = cache.action?.info?.status ?? null;
    const jointsAge = cache.jointsAt ? t - cache.jointsAt : Infinity;
    const health = !online ? 'unknown' : jointsAge > 3000 ? 'degraded' : 'ok';
    return {
      robotId: id,
      timestamp: new Date(t).toISOString(),
      source: 'measured',
      online,
      health,
      action,
      actionLabel: action ? action.replace(/^McAction_/, '') : null,
      status,
      extAction: cache.action?.info?.ext_action ?? null,
      controllerOwner: online ? 'AimMaster' : null,
      configuration: config.configuration ?? 'suspended',
      posture: null,
      base: null,
      speech: null,
      listening: false,
      lastCommand: null,
      link: {
        host, port,
        actionAt: cache.actionAt ? new Date(cache.actionAt).toISOString() : null,
        jointsAt: cache.jointsAt ? new Date(cache.jointsAt).toISOString() : null,
        jointsAgeMs: Number.isFinite(jointsAge) ? jointsAge : null,
        jointCount: cache.joints?.count ?? 0,
        lastError,
        lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
      },
      cameras: [],
    };
  }

  function joints() {
    return {
      robotId: id,
      timestamp: new Date(now()).toISOString(),
      source: 'measured',
      joints: cache.joints?.joints ?? {},
      velocities: cache.joints?.velocities ?? {},
      neck: cache.neck ? { joint1: cache.neck.joint1, joint2: cache.neck.joint2 } : {},
      hands: cache.hands
        ? { left: cache.hands.left ?? {}, right: cache.hands.right ?? {} }
        : { left: {}, right: {} },
    };
  }

  function capabilities() {
    // Observable: exactly what the four verified calls return.
    // Commandable: nothing. Not "not yet wired" — deliberately none.
    const observable = {
      'motion.state': true,
      'head.gaze': true,
      'head.joints': true,
      'arms.joints': true,
      'hands.grasp': true,
      'legs.posture': false,
      'base.velocity': false,
      'voice.speak': false,
      'voice.listen': false,
      'camera.stream': false,
      'arms.cartesian': false,
    };
    const reasons = {
      'legs.posture': 'no posture telemetry exists; the action service reports a mode, not a stance',
      'base.velocity': 'no odometry or velocity feedback exists, and no verified locomotion write path',
      'voice.speak': 'no audio endpoint has been identified on the robot',
      'voice.listen': 'microphone capture on the robot is unverified',
      'camera.stream': 'no camera endpoint has been identified on the robot',
      'arms.cartesian': 'no IK runs on this adapter and no cartesian interface is verified',
    };
    const out = {};
    for (const [cap, obs] of Object.entries(observable)) {
      out[cap] = {
        observable: obs,
        commandable: false,
        writeVerified: false,
        reason: reasons[cap] ?? (obs ? 'read-only adapter: commands would require a robot-side ROS 2 process' : 'not supported'),
      };
    }
    return out;
  }

  function refuse(capability) {
    throw conflict('capability_not_commandable', `the AimDK adapter cannot command ${capability}; it is a read-only telemetry adapter`, {
      capability,
      adapter: ADAPTER,
      path: 'McActionService / McDataService read calls only',
    });
  }

  return {
    id,
    kind: KIND,
    adapterName: ADAPTER,
    configuration: config.configuration ?? 'suspended',
    physical: true,
    started: false,
    start() {
      if (this.started) return;
      this.started = true;
      schedule(() => { if (!closed) pollAction(); }, actionHz);
      schedule(() => { if (!closed) pollJoints(); }, jointsHz);
      schedule(() => { if (!closed) pollNeck(); }, Math.min(jointsHz, 2));
      schedule(() => { if (!closed) pollHands(); }, Math.min(jointsHz, 2));
    },
    stop() {
      closed = true;
      for (const t of timers) clearInterval(t);
      timers.length = 0;
      this.started = false;
    },
    status() {
      return {
        online,
        health: state().health,
        detail: online ? `${host}:${port} · ${cache.joints?.count ?? 0} joints` : `unreachable: ${lastError ?? 'no poll yet'}`,
      };
    },
    state,
    joints,
    snapshot() {
      return { state: state(), joints: joints() };
    },
    capabilities,
    cameras: () => [],
    execute(capability) {
      return refuse(capability);
    },
    stopHardware() {
      return {
        supported: false,
        delivered: false,
        note: 'No verified software stop exists on this path. Use the factory e-stop. The gateway latch only stops gateway commands.',
      };
    },
  };
}

/* ------------------------------- parsing -------------------------------- */

function findJointStates(json) {
  if (Array.isArray(json?.states)) return json.states;
  const found = findFirstArray(json);
  return found.filter((v) => v && typeof v === 'object' && typeof v.name === 'string');
}

function findFirstArray(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return [];
  if (Array.isArray(node)) return node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value) && value.length) return value;
    if (value && typeof value === 'object') {
      const inner = findFirstArray(value, depth + 1);
      if (inner.length) return inner;
    }
  }
  return [];
}

function extractNeck(json) {
  const out = { joint1: null, joint2: null, raw: null };

  // Verified shape on Luka (2026-11-01):
  //   {"data":{"shake":{"name":"idx27_head_joint1","position":…},
  //            "nod":{"name":"idx28_head_joint2","position":…}}}
  // Checked before the generic walkers because the generic path treats the
  // inner `position` keys as anonymous numbers and loses the joint identity.
  const d = json?.data;
  if (d && typeof d === 'object') {
    if (d.shake && typeof d.shake.position === 'number') out.joint1 = d.shake.position;
    if (d.nod && typeof d.nod.position === 'number') out.joint2 = d.nod.position;
    if (out.joint1 !== null || out.joint2 !== null) {
      out.raw = d;
      return out;
    }
  }

  const states = findJointStates(json);
  if (states.length) {
    out.raw = {};
    for (const s of states) {
      if (typeof s.position !== 'number') continue;
      out.raw[s.name] = s.position;
      const name = String(s.name);
      if (/joint1\b|idx27/i.test(name)) out.joint1 = s.position;
      if (/joint2\b|idx28/i.test(name)) out.joint2 = s.position;
    }
    return out;
  }
  // Flat object shape, e.g. {head_joint1: 0.004, head_joint2: -0.008}
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 5) return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'number' && /joint1|yaw|shake/i.test(k) && out.joint1 === null) out.joint1 = v;
      else if (typeof v === 'number' && /joint2|pitch|nod/i.test(k) && out.joint2 === null) out.joint2 = v;
      else if (v && typeof v === 'object') visit(v, depth + 1);
      else if (typeof v === 'number') { out.raw = out.raw ?? {}; out.raw[k] = v; }
    }
  };
  visit(json);
  return out;
}

const FINGER_MATCH = [
  ['thumb', /thumb/i],
  ['index', /index/i],
  ['middle', /middle/i],
  ['ring', /ring/i],
  ['pinky', /pinky|little/i],
];

function extractHands(json) {
  const out = { left: null, right: null, raw: json ?? null };
  const visit = (node, path, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    const keys = Object.keys(node);
    const fingerKeys = keys.filter((k) => FINGER_MATCH.some(([, re]) => re.test(k)));
    if (fingerKeys.length >= 3) {
      const hay = `${path}.${keys.join('.')}`;
      const side = /left/i.test(hay) ? 'left' : /right/i.test(hay) ? 'right' : null;
      const values = normalizeFingers(node);
      if (side && !out[side]) out[side] = values;
      else if (!side && !out.left) out.left = values;
      else if (!side && !out.right) out.right = values;
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') visit(v, `${path}.${k}`, depth + 1);
    }
  };
  visit(json, '', 0);
  return out;
}

function normalizeFingers(obj) {
  const values = {};
  for (const [finger, re] of FINGER_MATCH) {
    const candidates = Object.entries(obj)
      .filter(([k, v]) => re.test(k) && typeof v === 'number')
      .sort(([a], [b]) => Number(/_1$/.test(b)) - Number(/_1$/.test(a)));
    if (candidates.length) {
      const [, raw] = candidates[0];
      values[finger] = Math.max(0, Math.min(2000, Math.round(raw)));
    }
  }
  return values;
}
