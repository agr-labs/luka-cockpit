// Simulator adapter — the reference implementation of the full-body contract.
//
// It is a kinematic stand-in, not physics: joints slew toward targets at bounded
// rates, the base integrates velocities, and posture is a set of rough keyframes.
// The keyframes are plausible shapes, not measurements of Luka. Everything it
// reports is labelled `simulated` so no UI can mistake it for telemetry.
//
// What it is for: proving the API contract, the lease model and the console
// before a single physical capability is enabled.

import { ARM_JOINTS } from '../lib/contract.mjs';

export const ADAPTER = 'simulator';
export const KIND = 'simulator';

const BODY_JOINTS = [
  'idx01_left_hip_roll', 'idx02_left_hip_yaw', 'idx03_left_hip_pitch',
  'idx04_left_tarsus', 'idx05_left_toe_pitch', 'idx06_left_toe_roll',
  'idx07_right_hip_roll', 'idx08_right_hip_yaw', 'idx09_right_hip_pitch',
  'idx10_right_tarsus', 'idx11_right_toe_pitch', 'idx12_right_toe_roll',
  ...ARM_JOINTS,
];

const LEG_JOINTS = BODY_JOINTS.slice(0, 12);
const FINGERS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

// Rough stance keyframes. Deliberately conservative and deliberately labelled
// unvalidated: they exist so posture transitions are observable, not so anyone
// can infer Luka's real standing pose.
const POSTURES = {
  relax: { hip_pitch: 0, tarsus: 0, toe_pitch: 0, hip_roll: 0 },
  stand: { hip_pitch: -0.12, tarsus: 0.24, toe_pitch: -0.12, hip_roll: 0 },
  crouch: { hip_pitch: -0.55, tarsus: 0.95, toe_pitch: -0.35, hip_roll: 0 },
  sit: { hip_pitch: -1.15, tarsus: 1.75, toe_pitch: -0.55, hip_roll: 0 },
};

const SLEW = {
  head: 1.4,   // rad/s
  arm: 1.0,
  leg: 0.6,
  finger: 900, // counts/s
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const step = (from, to, maxDelta) => {
  const d = to - from;
  return Math.abs(d) <= maxDelta ? to : from + Math.sign(d) * maxDelta;
};

export function create({ config, emit = () => {} } = {}) {
  const id = config.id;
  const now = config.now ?? Date.now;
  const configuration = config.configuration ?? 'grounded';

  const joints = Object.fromEntries(BODY_JOINTS.map((n) => [n, 0]));
  let targets = { ...joints };
  const neck = { joint1: 0, joint2: 0 };
  const neckTargets = { joint1: 0, joint2: 0 };
  const hands = {
    left: Object.fromEntries(FINGERS.map((f) => [f, 900])),
    right: Object.fromEntries(FINGERS.map((f) => [f, 900])),
  };
  const handTargets = JSON.parse(JSON.stringify(hands));

  let posture = 'relax';
  let postureTarget = 'relax';
  let drive = { vx: 0, vy: 0, wz: 0, until: 0 };
  let pose = { x: 0, y: 0, yaw: 0 };
  let speech = { text: null, at: null, until: 0 };
  let listening = false;
  let lastCommand = null;
  let online = true;
  let timer = null;

  const cameras = [
    { id: 'head_rgb', label: 'Head RGB', status: 'idle', synthetic: true },
    { id: 'head_depth', label: 'Head depth', status: 'idle', synthetic: true },
  ];

  function applyPostureTarget(name) {
    const p = POSTURES[name];
    if (!p) return;
    for (const leg of LEG_JOINTS) {
      if (leg.endsWith('hip_roll')) targets[leg] = p.hip_roll;
      else if (leg.endsWith('hip_yaw') || leg.endsWith('toe_roll')) targets[leg] = 0;
      else if (leg.endsWith('hip_pitch')) targets[leg] = p.hip_pitch;
      else if (leg.endsWith('tarsus')) targets[leg] = p.tarsus;
      else if (leg.endsWith('toe_pitch')) targets[leg] = p.toe_pitch;
    }
    postureTarget = name;
  }

  function tick(dtMs) {
    const dt = dtMs / 1000;
    const t = now();

    for (const name of BODY_JOINTS) {
      const rate = LEG_JOINTS.includes(name) ? SLEW.leg : SLEW.arm;
      joints[name] = step(joints[name], targets[name], rate * dt);
    }
    neck.joint1 = step(neck.joint1, neckTargets.joint1, SLEW.head * dt);
    neck.joint2 = step(neck.joint2, neckTargets.joint2, SLEW.head * dt);

    for (const side of ['left', 'right']) {
      for (const f of FINGERS) {
        hands[side][f] = step(hands[side][f], handTargets[side][f], SLEW.finger * dt);
      }
    }

    if (drive.until > t) {
      pose.x += drive.vx * dt;
      pose.y += drive.vy * dt;
      pose.yaw += drive.wz * dt;
    } else if (drive.vx || drive.vy || drive.wz) {
      drive = { vx: 0, vy: 0, wz: 0, until: 0 };
      emit('event', { kind: 'deadman_expired', message: 'base velocity zeroed: no command inside the 600 ms window' });
    }

    if (posture !== postureTarget) {
      const settled = LEG_JOINTS.every((j) => Math.abs(joints[j] - targets[j]) < 0.02);
      if (settled) {
        posture = postureTarget;
        emit('event', { kind: 'posture_reached', posture });
      }
    }
  }

  function state() {
    const t = now();
    return {
      robotId: id,
      timestamp: new Date(t).toISOString(),
      source: 'simulated',
      online,
      health: online ? 'ok' : 'unknown',
      action: posture === 'relax' ? 'SIM_RELAX' : `SIM_${posture.toUpperCase()}`,
      controllerOwner: 'gateway:simulator',
      configuration,
      posture,
      base: {
        x: round(pose.x), y: round(pose.y), yaw: round(pose.yaw),
        vx: drive.until > t ? drive.vx : 0,
        vy: drive.until > t ? drive.vy : 0,
        wz: drive.until > t ? drive.wz : 0,
      },
      speech: { text: speech.text, at: speech.at, speaking: speech.until > t },
      listening,
      lastCommand,
      cameras,
    };
  }

  function jointSnapshot() {
    return {
      robotId: id,
      timestamp: new Date(now()).toISOString(),
      source: 'simulated',
      joints: { ...joints },
      neck: { ...neck },
      hands: JSON.parse(JSON.stringify(hands)),
    };
  }

  function capabilities() {
    const observable = {
      'head.gaze': true, 'head.joints': true, 'arms.joints': true, 'hands.grasp': true,
      'legs.posture': true, 'base.velocity': true, 'voice.listen': true,
      'camera.stream': true, 'motion.state': true,
    };
    const commandable = {
      'head.gaze': true, 'head.joints': true, 'arms.joints': true, 'arms.cartesian': true,
      'hands.grasp': true, 'legs.posture': true, 'base.velocity': true,
      'voice.speak': true, 'voice.listen': true, 'camera.stream': true,
    };
    const out = {};
    for (const cap of new Set([...Object.keys(observable), ...Object.keys(commandable)])) {
      out[cap] = {
        observable: Boolean(observable[cap]),
        commandable: Boolean(commandable[cap]),
        writeVerified: false,
        simulated: true,
        reason: commandable[cap] ? null : 'read-only',
      };
    }
    return out;
  }

  function execute(capability, payload) {
    lastCommand = { capability, at: new Date(now()).toISOString() };
    switch (capability) {
      case 'head.gaze':
        neckTargets.joint1 = payload.yaw;
        neckTargets.joint2 = payload.pitch;
        return applied('head slewing to gaze target');

      case 'head.joints':
        neckTargets.joint1 = payload.joint1;
        neckTargets.joint2 = payload.joint2;
        return applied('head slewing to joint target');

      case 'arms.joints':
        for (const [joint, value] of Object.entries(payload.joints)) targets[joint] = value;
        return applied(`${Object.keys(payload.joints).length} arm joint(s) slewing`);

      case 'arms.cartesian': {
        // A crude, deliberately labelled mapping. No IK exists; this makes the
        // endpoint exercisable end-to-end without pretending to be kinematics.
        const side = payload.side;
        const base = side === 'left' ? ARM_JOINTS.slice(0, 7) : ARM_JOINTS.slice(7);
        const { x, y, z } = payload.position;
        targets[base[0]] = clamp(Math.atan2(z, Math.max(y, 0.05)) * 1.4, -1.6, 1.6);
        targets[base[1]] = clamp(0.9 - (y - 0.3) * 1.2, -0.4, 1.5);
        targets[base[2]] = clamp(-0.5 + x * 1.1, -2.0, 2.0);
        targets[base[4]] = clamp(0.35 - (y - 0.3) * 0.6, -1.4, 1.4);
        return applied('approximate cartesian mapping (no IK on this adapter)');
      }

      case 'hands.grasp': {
        const sides = payload.side === 'both' ? ['left', 'right'] : [payload.side];
        const presets = { open: 150, close: 1900, pinch: 1450 };
        for (const side of sides) {
          if (payload.action === 'set' && payload.finger) {
            handTargets[side][payload.finger] = payload.value;
          } else if (payload.action === 'set') {
            for (const f of FINGERS) handTargets[side][f] = payload.value;
          } else {
            const v = presets[payload.action];
            for (const f of FINGERS) handTargets[side][f] = f === 'thumb' && payload.action === 'pinch' ? 1600 : v;
          }
        }
        return applied(`hand ${payload.action}`);
      }

      case 'legs.posture':
        applyPostureTarget(payload.posture);
        return applied(`posture ramp to ${payload.posture}`);

      case 'base.velocity': {
        const durationMs = payload.durationMs ?? 500;
        drive = { vx: payload.vx, vy: payload.vy, wz: payload.wz, until: now() + durationMs };
        return applied(`base velocity for ${durationMs} ms, deadman-bound`);
      }

      case 'voice.speak':
        speech = {
          text: payload.text,
          at: new Date(now()).toISOString(),
          until: now() + Math.max(900, payload.text.length * 55),
        };
        emit('event', { kind: 'speech', text: payload.text, simulated: true });
        return applied('speech synthesised in simulator');

      case 'voice.listen':
        listening = payload.action === 'start';
        return applied(`listening ${listening ? 'on' : 'off'}`);

      case 'camera.stream': {
        const cam = cameras.find((c) => c.id === payload.camera);
        if (!cam) {
          return { accepted: false, applied: false, code: 'unknown_camera', note: `no camera "${payload.camera}"`, cameras: cameras.map((c) => c.id) };
        }
        cam.status = payload.action === 'start' ? 'streaming' : 'idle';
        return applied(`camera ${payload.camera} ${cam.status}`);
      }

      default:
        return { accepted: false, applied: false, code: 'unsupported', note: `simulator does not implement ${capability}` };
    }
  }

  function applied(note) {
    return { accepted: true, applied: true, note };
  }

  function snapshot() {
    return { state: state(), joints: jointSnapshot() };
  }

  return {
    id,
    kind: KIND,
    adapterName: ADAPTER,
    configuration,
    physical: false,
    started: false,
    start() {
      if (timer) return;
      timer = setInterval(() => tick(20), 20);
      timer.unref?.();
      this.started = true;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      this.started = false;
    },
    /** Test seam: advance physics without waiting on wall-clock timers. */
    tick,
    status() {
      return { online, health: online ? 'ok' : 'unknown', detail: 'kinematic simulator' };
    },
    state,
    joints: jointSnapshot,
    snapshot,
    capabilities,
    cameras: () => cameras,
    execute,
    stopHardware(reason) {
      drive = { vx: 0, vy: 0, wz: 0, until: 0 };
      targets = { ...joints };
      neckTargets.joint1 = neck.joint1;
      neckTargets.joint2 = neck.joint2;
      postureTarget = posture;
      return {
        supported: true,
        delivered: true,
        note: `simulator stop applied (${reason}); nothing physical was touched`,
      };
    },
  };
}

function round(n) {
  return Math.round(n * 1e4) / 1e4;
}

export { BODY_JOINTS, FINGERS };
