// Hardware-Faithful Safety Envelope, Kinematics Limiter & Sim-to-Real Mapper
// for Luka (AgiBot A2 Ultra).
//
// Zero browser/Node-specific dependencies so the exact same safety math runs in:
//   - Browser upper-body sim (src/luka-motion.js, src/luka-sim.js)
//   - Node tests & future Orin dry-run / hardware bridges
//
// Authoritative hardware sources:
//   - gateway/lib/contract.mjs & config/arm-schema.json (AimDK A2 guide §7.1.5-6, §7.1.9)
//   - config/joint-calibration.json & docs/calibration.md (measured neutral offsets)
//   - docs/evidence/head-controls-2026-11-06.json (verified live neck pan/tilt signs)

import { clamp } from './mathx.js';

export const VENDOR_HEAD_LIMITS = Object.freeze({
  idx27_head_joint1: Object.freeze([-0.785, 0.785]), // ±45.0° pan / shake (AimDK §7.1.5-6)
  idx28_head_joint2: Object.freeze([-0.401, 0.401]), // ±23.0° tilt / nod  (AimDK §7.1.5-6)
});

export const VENDOR_ARM_HARD_LIMITS = Object.freeze({
  idx13_left_arm_joint1: Object.freeze([-2.91, 2.91]),
  idx14_left_arm_joint2: Object.freeze([-0.46, 1.60]),
  idx15_left_arm_joint3: Object.freeze([-2.91, 2.91]),
  idx16_left_arm_joint4: Object.freeze([-2.00, -0.03]),
  idx17_left_arm_joint5: Object.freeze([-2.94, 2.94]),
  idx18_left_arm_joint6: Object.freeze([-0.45, 0.45]),
  idx19_left_arm_joint7: Object.freeze([-0.35, 0.35]),
  idx20_right_arm_joint1: Object.freeze([-2.91, 2.91]),
  idx21_right_arm_joint2: Object.freeze([-1.60, 0.46]),
  idx22_right_arm_joint3: Object.freeze([-2.91, 2.94]),
  idx23_right_arm_joint4: Object.freeze([0.03, 2.00]),
  idx24_right_arm_joint5: Object.freeze([-2.94, 2.94]),
  idx25_right_arm_joint6: Object.freeze([-0.45, 0.45]),
  idx26_right_arm_joint7: Object.freeze([-0.35, 0.35]),
});

// Vendor "yellow region" for coupled parallel pushrod wrists (AimDK §7.1.9).
// Because the workspace is rhombic (not rectangular), we also enforce |j6|/max6 + |j7|/max7 <= 1.
export const VENDOR_WRIST_YELLOW_ENVELOPE = Object.freeze({
  idx18_left_arm_joint6: Object.freeze([-0.30, 0.30]),
  idx19_left_arm_joint7: Object.freeze([-0.20, 0.20]),
  idx25_right_arm_joint6: Object.freeze([-0.30, 0.30]),
  idx26_right_arm_joint7: Object.freeze([-0.20, 0.20]),
});

export const VENDOR_RATE_LIMITS = Object.freeze({
  recommendedHz: 100,
  maxIntervalSec: 0.03,
  maxSpeedRadPerSec: 3.0,
  maxAccelRadPerSec2: 6.28,
});

// Sim-space symmetric shoulder & arm envelopes aligned to AgiBot A2 Ultra actuator travel.
// Note: sim q=0 is arms hanging, whereas real Luka motor 0 is near a T-pose;
// simPoseToHardwarePacket() translates between sim space and real motor space.
export const SIM_HARDWARE_LIMITS = Object.freeze({
  idx27_head_joint1: Object.freeze([-0.785, 0.785]),
  idx28_head_joint2: Object.freeze([-0.401, 0.401]),
  idx13_left_arm_joint1: Object.freeze([-0.32, 1.60]),
  idx14_left_arm_joint2: Object.freeze([-1.60, 0.46]),
  idx15_left_arm_joint3: Object.freeze([-2.91, 2.91]),
  idx16_left_arm_joint4: Object.freeze([-2.00, -0.03]),
  idx17_left_arm_joint5: Object.freeze([-2.85, 2.85]),
  idx18_left_arm_joint6: Object.freeze([-0.30, 0.30]),
  idx19_left_arm_joint7: Object.freeze([-0.20, 0.20]),
  idx20_right_arm_joint1: Object.freeze([-0.32, 1.60]),
  idx21_right_arm_joint2: Object.freeze([-1.60, 0.46]),
  idx22_right_arm_joint3: Object.freeze([-2.91, 2.91]),
  idx23_right_arm_joint4: Object.freeze([0.03, 2.00]),
  idx24_right_arm_joint5: Object.freeze([-2.85, 2.85]),
  idx25_right_arm_joint6: Object.freeze([-0.30, 0.30]),
  idx26_right_arm_joint7: Object.freeze([-0.20, 0.20]),
});

export const SIM_STUDIO_LIMITS = Object.freeze({
  idx27_head_joint1: Object.freeze([-1.32, 1.32]),
  idx28_head_joint2: Object.freeze([-0.58, 0.62]),
  idx13_left_arm_joint1: Object.freeze([-0.35, 1.95]),
  idx14_left_arm_joint2: Object.freeze([-1.95, 0.65]),
  idx15_left_arm_joint3: Object.freeze([-2.91, 2.91]),
  idx16_left_arm_joint4: Object.freeze([-2.05, 0.00]),
  idx17_left_arm_joint5: Object.freeze([-2.88, 2.88]),
  idx18_left_arm_joint6: Object.freeze([-0.68, 0.68]),
  idx19_left_arm_joint7: Object.freeze([-0.46, 0.46]),
  idx20_right_arm_joint1: Object.freeze([-0.35, 1.95]),
  idx21_right_arm_joint2: Object.freeze([-1.95, 0.65]),
  idx22_right_arm_joint3: Object.freeze([-2.91, 2.91]),
  idx23_right_arm_joint4: Object.freeze([0.00, 2.05]),
  idx24_right_arm_joint5: Object.freeze([-2.88, 2.88]),
  idx25_right_arm_joint6: Object.freeze([-0.68, 0.68]),
  idx26_right_arm_joint7: Object.freeze([-0.46, 0.46]),
});

export const SAFETY_PROFILES = Object.freeze({
  bringup: Object.freeze({
    id: 'bringup',
    label: 'Bring-Up Safe',
    description: 'Conservative first-test envelope: <= 0.85 rad/s, <= 2.5 rad/s², tight rhombic wrist guard.',
    hardwareEnforced: true,
    limits: SIM_HARDWARE_LIMITS,
    maxArmSpeed: 0.85,
    maxArmAccel: 2.5,
    maxHeadSpeed: 0.90,
    maxHeadAccel: 2.8,
    wristMax6: 0.27, // 90% of vendor 0.30 yellow envelope
    wristMax7: 0.18, // 90% of vendor 0.20 yellow envelope
    elbowMinFlex: 0.05, // stay safely clear of 0.03 rad elbow stop
    elbowMaxFlex: 1.95,
    lowPassAlpha: 0.32,
  }),
  hardware: Object.freeze({
    id: 'hardware',
    label: 'HW Spec (A2 Ultra)',
    description: 'Documented AgiBot A2 Ultra envelope with 80% speed/accel margin & rhombic parallel wrist guard.',
    hardwareEnforced: true,
    limits: SIM_HARDWARE_LIMITS,
    maxArmSpeed: 2.40, // 80% of vendor 3.0 rad/s hard cap
    maxArmAccel: 5.00, // 80% of vendor 6.28 rad/s² hard cap
    maxHeadSpeed: 1.95,
    maxHeadAccel: 5.00,
    wristMax6: 0.30, // exact vendor yellow region
    wristMax7: 0.20, // exact vendor yellow region
    elbowMinFlex: 0.035,
    elbowMaxFlex: 1.99,
    lowPassAlpha: 0.48,
  }),
  studio: Object.freeze({
    id: 'studio',
    label: 'Studio Wide (Sim Only)',
    description: 'Expanded visual range for offline exploration. Exceeds real neck/wrist hardware limits.',
    hardwareEnforced: false,
    limits: SIM_STUDIO_LIMITS,
    maxArmSpeed: 6.5,
    maxArmAccel: 22.0,
    maxHeadSpeed: 5.2,
    maxHeadAccel: 18.0,
    wristMax6: 0.68,
    wristMax7: 0.46,
    elbowMinFlex: 0.0,
    elbowMaxFlex: 2.05,
    lowPassAlpha: 0.78,
  }),
});

export const HAND_CHANNEL_COUNT_MAX = 2000;

/**
 * Verified live hardware direction & calibration defaults (2026-11-06).
 *
 * CRITICAL: Only joints explicitly verified on physical Luka carry `verified: true`.
 * - Neck pan (`idx27`): verified live 2026-11-06 (+ = Luka's left / viewer's right)
 * - Neck tilt (`idx28`): verified live 2026-11-06 (- = Look UP, + = Look DOWN -> opposite of sim +UP!)
 * - Arm joints (`idx13..idx26`): offsets captured at hanging neutral 2026-11-03, but per-joint
 *   command directions against `/motion/control/arm_joint_command` still require supervised
 *   1-joint-at-a-time verification (`verified: false` until proven live).
 */
export const REAL_LUKA_JOINT_MAP = Object.freeze({
  idx27_head_joint1: Object.freeze({ offset: 0.005467, simToHwSign: 1, gain: 1, verified: true }),
  idx28_head_joint2: Object.freeze({ offset: 0.009979, simToHwSign: -1, gain: 1, verified: true }),
  idx13_left_arm_joint1: Object.freeze({ offset: -0.092356, simToHwSign: 1, gain: 1, verified: false }),
  idx14_left_arm_joint2: Object.freeze({ offset: 1.239315, simToHwSign: 1, gain: 1, verified: false }),
  idx15_left_arm_joint3: Object.freeze({ offset: 0.077752, simToHwSign: 1, gain: 1, verified: false }),
  idx16_left_arm_joint4: Object.freeze({ offset: -0.139542, simToHwSign: 1, gain: 1, verified: false }),
  idx17_left_arm_joint5: Object.freeze({ offset: 1.653803, simToHwSign: 1, gain: 1, verified: false }),
  idx18_left_arm_joint6: Object.freeze({ offset: 0.051697, simToHwSign: 1, gain: 1, verified: false }),
  idx19_left_arm_joint7: Object.freeze({ offset: -0.021685, simToHwSign: 1, gain: 1, verified: false }),
  idx20_right_arm_joint1: Object.freeze({ offset: 0.09, simToHwSign: 1, gain: 1, verified: false }),
  idx21_right_arm_joint2: Object.freeze({ offset: -1.292, simToHwSign: 1, gain: 1, verified: false }),
  idx22_right_arm_joint3: Object.freeze({ offset: -0.103, simToHwSign: 1, gain: 1, verified: false }),
  idx23_right_arm_joint4: Object.freeze({ offset: 0.1, simToHwSign: 1, gain: 1, verified: false }),
  idx24_right_arm_joint5: Object.freeze({ offset: 1.529, simToHwSign: 1, gain: 1, verified: false }),
  idx25_right_arm_joint6: Object.freeze({ offset: -0.005, simToHwSign: 1, gain: 1, verified: false }),
  idx26_right_arm_joint7: Object.freeze({ offset: -0.033, simToHwSign: 1, gain: 1, verified: false }),
});

const UPPER_JOINT_NAMES = Object.keys(SIM_HARDWARE_LIMITS);
const HEAD_JOINTS = new Set(['idx27_head_joint1', 'idx28_head_joint2']);

/**
 * Rhombic parallel wrist coupling guard:
 * Projects (j6, j7) cleanly onto |j6|/max6 + |j7|/max7 <= 1.0 so parallel pushrods
 * never enter a mechanically binding rectangular corner.
 */
export function clampRhombicWrist(j6, j7, max6 = 0.30, max7 = 0.20) {
  const raw6 = Number.isFinite(j6) ? j6 : 0;
  const raw7 = Number.isFinite(j7) ? j7 : 0;
  const m6 = Math.max(max6, 1e-4);
  const m7 = Math.max(max7, 1e-4);
  const load = Math.abs(raw6) / m6 + Math.abs(raw7) / m7;
  if (load <= 1.0) {
    return { j6: raw6, j7: raw7, load, clamped: false };
  }
  return {
    j6: raw6 / load,
    j7: raw7 / load,
    load,
    clamped: true,
  };
}

/**
 * Exact discrete-time maximum stopping speed for Euler step x_{n+1} = x_n + v_{n+1} * dt
 * under acceleration limit `maxAcc`. Guarantees zero overshoot and |dv/dt| <= maxAcc on every step.
 */
function discreteBrakeSpeed(dist, maxAcc, dt) {
  if (dist <= 0 || maxAcc <= 0 || dt <= 0) return 0;
  const dv = maxAcc * dt;
  const u = dist / (dv * dt);
  const m = Math.floor((-1 + Math.sqrt(1 + 8 * u)) * 0.5);
  const vNorm = u / (m + 1) + m * 0.5;
  return vNorm * dv;
}

/**
 * Real-time per-joint actuator limiter enforcing position limits, rhombic parallel wrist
 * diamond bounds, braking-safe velocity/acceleration limits, and vendor first-order low-pass.
 */
export class ActuatorSafetyLimiter {
  constructor(profileId = 'hardware') {
    this.profile = SAFETY_PROFILES[profileId] || SAFETY_PROFILES.hardware;
    this.softHold = false;
    this.pos = {};
    this.vel = {};
    this.initialized = false;
    this.lastTelemetry = {
      profileId: this.profile.id,
      profileLabel: this.profile.label,
      hardwareEnforced: this.profile.hardwareEnforced,
      status: 'NOMINAL',
      softHold: false,
      peakSpeedRadS: 0,
      peakAccelRadS2: 0,
      peakSpeedPct: 0,
      peakAccelPct: 0,
      wristLoadL: 0,
      wristLoadR: 0,
      activeClamps: [],
    };
  }

  _jointBounds(k, p = this.profile) {
    const lim = p.limits[k];
    let lo = lim[0];
    let hi = lim[1];
    if (k === 'idx16_left_arm_joint4') {
      lo = Math.max(lo, -p.elbowMaxFlex);
      hi = Math.min(hi, -p.elbowMinFlex);
    } else if (k === 'idx23_right_arm_joint4') {
      lo = Math.max(lo, p.elbowMinFlex);
      hi = Math.min(hi, p.elbowMaxFlex);
    }
    return [lo, hi];
  }

  setProfile(profileId) {
    const next = SAFETY_PROFILES[profileId];
    if (!next) return false;
    this.profile = next;
    return true;
  }

  setSoftHold(enabled) {
    this.softHold = Boolean(enabled);
    if (this.softHold) {
      for (const k of UPPER_JOINT_NAMES) this.vel[k] = 0;
    }
  }

  reset(initialPose = {}) {
    this.pos = {};
    this.vel = {};
    const p = this.profile;
    for (const k of UPPER_JOINT_NAMES) {
      const raw = Number.isFinite(initialPose[k]) ? initialPose[k] : 0;
      const [lo, hi] = this._jointBounds(k, p);
      this.pos[k] = p.hardwareEnforced ? clamp(raw, lo, hi) : raw;
      this.vel[k] = 0;
    }
    if (p.hardwareEnforced) {
      const wL = clampRhombicWrist(this.pos.idx18_left_arm_joint6, this.pos.idx19_left_arm_joint7, p.wristMax6, p.wristMax7);
      this.pos.idx18_left_arm_joint6 = wL.j6;
      this.pos.idx19_left_arm_joint7 = wL.j7;
      const wR = clampRhombicWrist(this.pos.idx25_right_arm_joint6, this.pos.idx26_right_arm_joint7, p.wristMax6, p.wristMax7);
      this.pos.idx25_right_arm_joint6 = wR.j6;
      this.pos.idx26_right_arm_joint7 = wR.j7;
    }
    this.initialized = true;
  }

  /**
   * Constrain a candidate upper-body pose over timestep `dt` (seconds).
   * Pass `{ preFiltered: true }` when the caller already applies spring/damping smoothing
   * so the limiter enforces hard bounds, rhombic wrists, speed & accel caps without double-lag.
   * Returns `{ pose, telemetry }` where `pose` is safe for actuators under `this.profile`.
   */
  step(desiredPose, dt, opts = {}) {
    const p = this.profile;
    const safeDt = clamp(Number.isFinite(dt) ? dt : 1 / 60, 0.002, 0.05);
    const preFiltered = Boolean(opts.preFiltered);

    if (!this.initialized) {
      this.reset(desiredPose);
    }

    const activeClamps = new Set();

    // 1. Apply position hard limits, elbow non-zero safety margin, and rhombic wrist diamond
    const target = {};
    for (const k of UPPER_JOINT_NAMES) {
      const raw = this.softHold
        ? (this.pos[k] ?? 0)
        : (Number.isFinite(desiredPose[k]) ? desiredPose[k] : 0);
      const [lo, hi] = this._jointBounds(k, p);
      const c = clamp(raw, lo, hi);
      if (Math.abs(c - raw) > 1e-4) activeClamps.add(k);
      target[k] = c;
    }

    // Coupled parallel wrist rhombic diamond guard (left & right)
    const wL = clampRhombicWrist(target.idx18_left_arm_joint6, target.idx19_left_arm_joint7, p.wristMax6, p.wristMax7);
    target.idx18_left_arm_joint6 = wL.j6;
    target.idx19_left_arm_joint7 = wL.j7;
    if (wL.clamped) activeClamps.add('left_wrist_rhombic');

    const wR = clampRhombicWrist(target.idx25_right_arm_joint6, target.idx26_right_arm_joint7, p.wristMax6, p.wristMax7);
    target.idx25_right_arm_joint6 = wR.j6;
    target.idx26_right_arm_joint7 = wR.j7;
    if (wR.clamped) activeClamps.add('right_wrist_rhombic');

    // 2. Exact discrete-time braking velocity & acceleration limiter + vendor first-order smoothing
    let peakSpeed = 0;
    let peakAccel = 0;
    const outPose = { ...desiredPose };

    for (const k of UPPER_JOINT_NAMES) {
      const prevPos = this.pos[k] ?? target[k];
      const prevVel = this.vel[k] ?? 0;

      if (this.softHold) {
        this.vel[k] = 0;
        outPose[k] = prevPos;
        continue;
      }

      const [lo, hi] = this._jointBounds(k, p);
      const isHead = HEAD_JOINTS.has(k);
      const maxSpd = isHead ? p.maxHeadSpeed : p.maxArmSpeed;
      const maxAcc = isHead ? p.maxHeadAccel : p.maxArmAccel;
      const brakeAcc = maxAcc * 0.98; // tiny margin absorbs browser frame-time jitter without wall snaps

      // Vendor first-order low-pass pre-smoothing blended cleanly with dt (skipped if caller pre-filtered)
      const alpha = preFiltered
        ? 1.0
        : clamp(1 - Math.pow(1 - p.lowPassAlpha, safeDt * 60), 0.05, 1.0);
      const filteredTarget = prevPos + (target[k] - prevPos) * alpha;
      const fullErr = target[k] - prevPos;
      const filtErr = filteredTarget - prevPos;

      let vDes = filtErr / safeDt;
      if (Math.abs(vDes) > maxSpd + 1e-3) activeClamps.add(`${k}:speed`);

      // When caller passes a raw goal target (preFiltered=false), brake smoothly to target[k].
      // When caller passes an already-integrated 1-step kinematic pose (preFiltered=true),
      // vDes is the frame's desired velocity, so only cap by maxSpd and wall braking bounds below.
      if (!preFiltered) {
        const vStopTarget = discreteBrakeSpeed(Math.abs(fullErr), brakeAcc, safeDt);
        if (fullErr >= 0) {
          vDes = clamp(vDes, -maxSpd, Math.min(maxSpd, vStopTarget));
        } else {
          vDes = clamp(vDes, -Math.min(maxSpd, vStopTarget), maxSpd);
        }
      } else {
        vDes = clamp(vDes, -maxSpd, maxSpd);
      }

      // Also respect exact braking walls [lo, hi] when currently inside bounds
      if (prevPos >= lo && prevPos <= hi) {
        const vWallHi = discreteBrakeSpeed(hi - prevPos, brakeAcc, safeDt);
        const vWallLo = -discreteBrakeSpeed(prevPos - lo, brakeAcc, safeDt);
        vDes = clamp(vDes, vWallLo, vWallHi);
      }

      // Acceleration clamp
      const dvMax = maxAcc * safeDt;
      const nextVel = clamp(vDes, prevVel - dvMax, prevVel + dvMax);
      let nextPos = prevPos + nextVel * safeDt;

      // Monotonic safety guard: never overshoot bounds once inside, and never teleport if returning after profile switch
      const guardLo = Math.min(lo, prevPos);
      const guardHi = Math.max(hi, prevPos);
      nextPos = clamp(nextPos, guardLo, guardHi);

      const actualVel = (nextPos - prevPos) / safeDt;
      const actualAcc = Math.abs(actualVel - prevVel) / safeDt;
      if (Math.abs(actualVel) > peakSpeed) peakSpeed = Math.abs(actualVel);
      if (actualAcc > peakAccel) peakAccel = actualAcc;

      this.pos[k] = nextPos;
      this.vel[k] = actualVel;
      outPose[k] = nextPos;
    }

    // Enforce transient coupled rhombic diamond on output wrist pairs without abrupt snaps
    const enforceWristOutput = (k6, k7, side) => {
      const w = clampRhombicWrist(outPose[k6], outPose[k7], p.wristMax6, p.wristMax7);
      if (w.clamped) {
        outPose[k6] = w.j6;
        outPose[k7] = w.j7;
        this.pos[k6] = w.j6;
        this.pos[k7] = w.j7;
        activeClamps.add(`${side}_wrist_rhombic`);
      }
    };
    if (p.hardwareEnforced && !this.softHold) {
      enforceWristOutput('idx18_left_arm_joint6', 'idx19_left_arm_joint7', 'left');
      enforceWristOutput('idx25_right_arm_joint6', 'idx26_right_arm_joint7', 'right');
    }

    // Re-evaluate final output wrist load against vendor yellow envelope (0.30 / 0.20)
    const outWL = clampRhombicWrist(outPose.idx18_left_arm_joint6, outPose.idx19_left_arm_joint7, 0.30, 0.20);
    const outWR = clampRhombicWrist(outPose.idx25_right_arm_joint6, outPose.idx26_right_arm_joint7, 0.30, 0.20);

    const clampsList = Array.from(activeClamps);
    const status = this.softHold
      ? 'HOLD'
      : (!p.hardwareEnforced ? 'UNRESTRICTED' : (clampsList.length ? 'CLAMPING' : 'NOMINAL'));

    this.lastTelemetry = {
      profileId: p.id,
      profileLabel: p.label,
      hardwareEnforced: p.hardwareEnforced,
      status,
      softHold: this.softHold,
      peakSpeedRadS: Number(peakSpeed.toFixed(2)),
      peakAccelRadS2: Number(peakAccel.toFixed(2)),
      peakSpeedPct: Math.round(clamp((peakSpeed / VENDOR_RATE_LIMITS.maxSpeedRadPerSec) * 100, 0, 150)),
      peakAccelPct: Math.round(clamp((peakAccel / VENDOR_RATE_LIMITS.maxAccelRadPerSec2) * 100, 0, 150)),
      wristLoadL: Math.round(outWL.load * 100),
      wristLoadR: Math.round(outWR.load * 100),
      activeClamps: clampsList,
    };

    return { pose: outPose, telemetry: this.lastTelemetry };
  }
}

/**
 * Translate a sim pose & 0..1 hand curls into a dry-run real-Luka hardware command packet.
 * Applies verified neck pitch sign inversion (`-sim = real UP`), calibration offsets,
 * and `0..2000` Inspire hand counts, while explicitly flagging unverified joints.
 */
export function simPoseToHardwarePacket(simPose, simHands = null, jointMap = REAL_LUKA_JOINT_MAP) {
  const neck = {};
  const arms = {};
  const unverifiedJoints = [];

  for (const [jn, cfg] of Object.entries(jointMap)) {
    const simVal = Number.isFinite(simPose?.[jn]) ? simPose[jn] : 0;
    const hwVal = Number((cfg.offset + cfg.simToHwSign * (simVal / (cfg.gain || 1))).toFixed(5));
    if (HEAD_JOINTS.has(jn)) {
      neck[jn === 'idx27_head_joint1' ? 'yaw' : 'pitch'] = hwVal;
    } else {
      arms[jn] = hwVal;
    }
    if (!cfg.verified) unverifiedJoints.push(jn);
  }

  const mapHand = (h) => ({
    thumb_pos_0: Math.round(clamp(h?.thumbOpp ?? ((h?.thumb ?? 0.25) * 0.82), 0, 1) * HAND_CHANNEL_COUNT_MAX),
    thumb_pos_1: Math.round(clamp(h?.thumb ?? 0.25, 0, 1) * HAND_CHANNEL_COUNT_MAX),
    index_pos: Math.round(clamp(h?.index ?? 0.25, 0, 1) * HAND_CHANNEL_COUNT_MAX),
    middle_pos: Math.round(clamp(h?.middle ?? 0.28, 0, 1) * HAND_CHANNEL_COUNT_MAX),
    ring_pos: Math.round(clamp(h?.ring ?? 0.30, 0, 1) * HAND_CHANNEL_COUNT_MAX),
    pinky_pos: Math.round(clamp(h?.pinky ?? 0.32, 0, 1) * HAND_CHANNEL_COUNT_MAX),
  });

  return {
    protocol: 'aimdk-dry-run-v1',
    neck: {
      rpc: 'aimdk.protocol.McMotionService/SetNeckCommand',
      verifiedPath: true,
      shake: neck.yaw,
      nod: neck.pitch,
    },
    arms: {
      topic: '/motion/control/arm_joint_command',
      verifiedPath: false,
      positions: arms,
      unverifiedJoints,
    },
    hands: {
      verifiedPath: false,
      left: mapHand(simHands?.left),
      right: mapHand(simHands?.right),
    },
  };
}

/**
 * Translate real Luka measured telemetry (`GetNeckState` / `GetJointState` / `GetHandState`)
 * back into sim coordinates for Step 3 read-only live mirroring comparison.
 */
export function hardwareTelemetryToSimPose(measured, jointMap = REAL_LUKA_JOINT_MAP) {
  const simPose = {};
  for (const [jn, cfg] of Object.entries(jointMap)) {
    const raw = measured?.[jn];
    if (!Number.isFinite(raw)) continue;
    simPose[jn] = (raw - cfg.offset) * cfg.simToHwSign * (cfg.gain || 1);
  }
  return simPose;
}

/**
 * Strict pre-flight hardware validator (NEVER clamps — refuses with exact reasons).
 * Used before any live packet could ever leave the bridge.
 */
export function validateHardwareCommandPacket(packet, {
  startNeck = null,
  neckEnvelopeRad = { yaw: 10 * Math.PI / 180, pitch: 5 * Math.PI / 180 },
  allowArms = false,
  allowedArmJoints = null,
} = {}) {
  const errors = [];
  const warnings = [];

  // 1. Validate neck against AimDK §7.1.5-6 hard limits + optional test envelope around measured start
  const yaw = packet?.neck?.shake;
  const pitch = packet?.neck?.nod;
  if (!Number.isFinite(yaw) || yaw < VENDOR_HEAD_LIMITS.idx27_head_joint1[0] || yaw > VENDOR_HEAD_LIMITS.idx27_head_joint1[1]) {
    errors.push({ joint: 'idx27_head_joint1', code: 'head_hard_limit', value: yaw, limit: VENDOR_HEAD_LIMITS.idx27_head_joint1 });
  }
  if (!Number.isFinite(pitch) || pitch < VENDOR_HEAD_LIMITS.idx28_head_joint2[0] || pitch > VENDOR_HEAD_LIMITS.idx28_head_joint2[1]) {
    errors.push({ joint: 'idx28_head_joint2', code: 'head_hard_limit', value: pitch, limit: VENDOR_HEAD_LIMITS.idx28_head_joint2 });
  }
  if (startNeck) {
    if (Number.isFinite(startNeck.yaw) && Math.abs(yaw - startNeck.yaw) > neckEnvelopeRad.yaw + 1e-6) {
      errors.push({ joint: 'idx27_head_joint1', code: 'neck_test_envelope', delta: yaw - startNeck.yaw, maxDelta: neckEnvelopeRad.yaw });
    }
    if (Number.isFinite(startNeck.pitch) && Math.abs(pitch - startNeck.pitch) > neckEnvelopeRad.pitch + 1e-6) {
      errors.push({ joint: 'idx28_head_joint2', code: 'neck_test_envelope', delta: pitch - startNeck.pitch, maxDelta: neckEnvelopeRad.pitch });
    }
  }

  // 2. Validate arms ONLY when explicitly enabled (otherwise report blocked status cleanly)
  if (allowArms) {
    const pos = packet?.arms?.positions || {};
    const allowSet = allowedArmJoints ? new Set(allowedArmJoints) : null;
    for (const [jn, hard] of Object.entries(VENDOR_ARM_HARD_LIMITS)) {
      if (allowSet && !allowSet.has(jn)) continue;
      const cfg = REAL_LUKA_JOINT_MAP[jn];
      if (!cfg?.verified && !allowSet?.has(jn)) {
        errors.push({ joint: jn, code: 'joint_unverified', message: `${jn} sign/offset not yet verified on physical hardware` });
        continue;
      }
      const val = pos[jn];
      if (!Number.isFinite(val) || val < hard[0] || val > hard[1]) {
        errors.push({ joint: jn, code: 'arm_hard_limit', value: val, limit: hard });
      }
      const env = VENDOR_WRIST_YELLOW_ENVELOPE[jn];
      if (env && Number.isFinite(val) && (val < env[0] || val > env[1])) {
        warnings.push({ joint: jn, code: 'wrist_yellow_envelope', value: val, envelope: env });
      }
    }
    // Check rhombic coupling warning/block on both wrists
    const wl = clampRhombicWrist(pos.idx18_left_arm_joint6, pos.idx19_left_arm_joint7, 0.30, 0.20);
    if (wl.clamped) warnings.push({ joint: 'left_wrist', code: 'wrist_rhombic_yellow', load: Number(wl.load.toFixed(2)) });
    const wr = clampRhombicWrist(pos.idx25_right_arm_joint6, pos.idx26_right_arm_joint7, 0.30, 0.20);
    if (wr.clamped) warnings.push({ joint: 'right_wrist', code: 'wrist_rhombic_yellow', load: Number(wr.load.toFixed(2)) });
  }

  return { ok: errors.length === 0, errors, warnings };
}
