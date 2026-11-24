// Kameyoko-inspired Head, Arm & 10-Finger Hand Tracking Engine for Luka Upper-Body Sim.
//
// Modeled on Kameyoko's real-time pose/hand tracking pipeline:
//   - MediaPipe PoseLandmarker (33 metric 3D world + 2D image landmarks)
//   - MediaPipe HandLandmarker (2x 21 3D hand landmarks, matched to nearest wrist)
//   - One Euro Filter smoothing (rock-solid stillness, zero-lag responsiveness)
//   - 3D torso-frame retargeting onto Luka's symmetric 16 upper-body DOF + 10 fingers
//   - Live skeleton & hand canvas overlay + gesture classifier + synthetic demo mode

import { clamp, lerp } from './mathx.js';
import { clampRhombicWrist } from './hw-safety.js';

export const P = {
  NOSE: 0,
  L_EYE: 2,
  R_EYE: 5,
  L_EAR: 7,
  R_EAR: 8,
  MOUTH_L: 9,
  MOUTH_R: 10,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_PINKY: 17,
  R_PINKY: 18,
  L_INDEX: 19,
  R_INDEX: 20,
  L_THUMB: 21,
  R_THUMB: 22,
  L_HIP: 23,
  R_HIP: 24,
};

export const UPPER_POSE_CONNECTIONS = [
  [7, 0], [8, 0],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [17, 19], [16, 18], [16, 20], [18, 20],
  [11, 23], [12, 24], [23, 24],
];

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];

const FINGER_CHAINS = {
  index: [5, 6, 7, 8],
  middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16],
  pinky: [17, 18, 19, 20],
};

export const DEFAULT_HAND_CALIBRATION = {
  smoothing: 0.68,      // 0 (snappy) .. 1 (ultra-smooth anti-jitter)
  reachScale: 1.12,     // compensates slight MediaPipe Z-depth compression
  heightTrimDeg: 0,     // vertical shoulder pitch trim in degrees (-20..+20)
  wristRollTrimDeg: 0,  // forearm pronation/supination trim in degrees (-45..+45)
  openBaseline: null,   // optional personal neutral open-hand curl baseline { left, right }
};

/* --------------------------------------------------------- One Euro Filter */

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  constructor(minCutoff = 1.6, beta = 0.45, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }

  setParams(minCutoff, beta, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(v, dt) {
    if (!Number.isFinite(v)) return this.x ?? 0;
    if (this.x === null) {
      this.x = v;
      return v;
    }
    const safeDt = clamp(dt, 1 / 240, 0.2);
    const rawDx = (v - this.x) / safeDt;
    this.dx += alpha(this.dCutoff, safeDt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, safeDt) * (v - this.x);
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}

export class PointsFilter {
  constructor(params = { minCutoff: 1.6, beta: 0.45, dCutoff: 1.0 }) {
    this.params = { ...params };
    this.filters = [];
  }

  setParams(params) {
    this.params = { ...this.params, ...params };
    for (const triple of this.filters) {
      for (const f of triple) f.setParams(this.params.minCutoff, this.params.beta, this.params.dCutoff);
    }
  }

  filter(points, dt, freezeMask = null) {
    const { minCutoff, beta, dCutoff } = this.params;
    return points.map((p, i) => {
      const f = (this.filters[i] ??= [
        new OneEuro(minCutoff, beta, dCutoff),
        new OneEuro(minCutoff, beta, dCutoff),
        new OneEuro(minCutoff, beta, dCutoff),
      ]);
      // Freeze low-confidence / off-screen landmarks so garbage never poisons OneEuro derivative `dx`
      if (freezeMask && freezeMask.has(i) && f[0].x !== null) {
        return { x: f[0].x, y: f[1].x, z: f[2].x };
      }
      return {
        x: f[0].filter(p.x, dt),
        y: f[1].filter(p.y, dt),
        z: f[2].filter(p.z, dt),
      };
    });
  }

  resetIndices(indices) {
    for (const i of indices) {
      const triple = this.filters[i];
      if (triple) {
        for (const f of triple) f.reset();
      }
    }
  }

  reset() {
    this.filters = [];
  }
}

/* --------------------------------------------------------------- 3D vector */

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const mid = (a, b) => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const len = (a) => Math.hypot(a.x, a.y, a.z);
const dist3 = (a, b) => len(sub(a, b));
const norm = (a) => {
  const l = len(a);
  return l > 1e-5 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 };
};
const ramp = (v, lo, hi) => clamp((v - lo) / (hi - lo), 0, 1);

/* ------------------------------------------------------ Finger Curl Solver */

const angleBetween = (a, b) => Math.acos(clamp(dot(norm(a), norm(b)), -1, 1));

/**
 * Scale-invariant 3D joint-angle + phalanx-length finger curl solver (0 = straight open, 1 = curled fist).
 * Solves independent thumb opposition (`thumbOpp`) + thumb flexion (`thumb`) for the 6-DOF Inspire RH56.
 */
export function extractFingerCurls(handWorld, openBaseline = null) {
  if (!handWorld || handWorld.length < 21) {
    return { thumbOpp: 0.22, thumb: 0.20, index: 0.22, middle: 0.24, ring: 0.26, pinky: 0.28 };
  }
  const wrist = handWorld[0];
  const raw = {};

  for (const [name, [mcp, pip, dip, tip]] of Object.entries(FINGER_CHAINS)) {
    const pMcp = handWorld[mcp];
    const pPip = handWorld[pip];
    const pDip = handWorld[dip];
    const pTip = handWorld[tip];

    const v0 = sub(pMcp, wrist);
    const v1 = sub(pPip, pMcp);
    const v2 = sub(pDip, pPip);
    const v3 = sub(pTip, pDip);

    const angMcp = angleBetween(v0, v1);
    const angPip = angleBetween(v1, v2);
    const angDip = angleBetween(v2, v3);
    // Weighted 3-joint anatomical bend (0.25 rad straight -> 3.35 rad tight fist)
    const bendSum = angMcp * 0.85 + angPip * 1.18 + angDip * 0.72;
    const curlAngle = ramp(bendSum, 0.30, 3.20);

    // Per-finger scale-invariant straightness (works identically for short pinky & long middle finger)
    const fullLen = Math.max(len(v1) + len(v2) + len(v3), 1e-4);
    const straightness = dist3(pMcp, pTip) / fullLen;
    const curlStraight = 1 - ramp(straightness, 0.42, 0.94);

    raw[name] = clamp(curlAngle * 0.72 + curlStraight * 0.28, 0, 1);
  }

  // Thumb flexion (`thumb` -> RH56 thumb_pos_1) from CMC->MCP->IP->TIP angles
  const t0 = sub(handWorld[2], handWorld[1]);
  const t1 = sub(handWorld[3], handWorld[2]);
  const t2 = sub(handWorld[4], handWorld[3]);
  const thumbBend = angleBetween(t0, t1) * 0.95 + angleBetween(t1, t2) * 1.15;
  raw.thumb = clamp(ramp(thumbBend, 0.22, 1.55), 0, 1);

  // Thumb opposition (`thumbOpp` -> RH56 thumb_pos_0) from thumb tip spread vs palm width
  const palmW = Math.max(dist3(handWorld[5], handWorld[17]), 1e-4);
  const spreadPinky = dist3(handWorld[4], handWorld[17]) / palmW;
  const spreadRing = dist3(handWorld[4], handWorld[13]) / palmW;
  const spread = spreadPinky * 0.55 + spreadRing * 0.45;
  raw.thumbOpp = clamp(1 - ramp(spread, 0.58, 1.42), 0, 1);

  // Apply optional personal open-hand baseline calibration (zeroes residual natural curl when open)
  const out = {};
  for (const key of ['thumbOpp', 'thumb', 'index', 'middle', 'ring', 'pinky']) {
    let v = raw[key];
    if (openBaseline && typeof openBaseline[key] === 'number') {
      const base = clamp(openBaseline[key], 0, 0.45);
      v = clamp((v - base) / Math.max(1 - base, 0.45), 0, 1);
    }
    out[key] = Number(v.toFixed(3));
  }
  return out;
}

/* ------------------------------------------ 3D World -> Luka Retargeting */

const REST_ABDUCT_RAD = 0.2618; // 15.0 deg built-in URDF shoulder flare at q = 0
const DEG_TO_RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

// Calm natural resting upper-body pose used when relaxing smoothly after sustained tracking loss
export const SAFE_NEUTRAL_JOINTS = Object.freeze({
  idx27_head_joint1: 0,
  idx28_head_joint2: 0,
  idx13_left_arm_joint1: 0.04,
  idx14_left_arm_joint2: -0.06,
  idx15_left_arm_joint3: 0,
  idx16_left_arm_joint4: -0.34,
  idx17_left_arm_joint5: -0.10,
  idx18_left_arm_joint6: 0,
  idx19_left_arm_joint7: 0,
  idx20_right_arm_joint1: 0.04,
  idx21_right_arm_joint2: -0.06,
  idx22_right_arm_joint3: 0,
  idx23_right_arm_joint4: 0.34,
  idx24_right_arm_joint5: -0.10,
  idx25_right_arm_joint6: 0,
  idx26_right_arm_joint7: 0,
});

export const SAFE_NEUTRAL_HAND = Object.freeze({
  thumbOpp: 0.22,
  thumb: 0.20,
  index: 0.22,
  middle: 0.24,
  ring: 0.26,
  pinky: 0.28,
});

const LUKA_LEFT_ARM_JOINTS = [
  'idx13_left_arm_joint1',
  'idx14_left_arm_joint2',
  'idx15_left_arm_joint3',
  'idx16_left_arm_joint4',
  'idx17_left_arm_joint5',
  'idx18_left_arm_joint6',
  'idx19_left_arm_joint7',
];

const LUKA_RIGHT_ARM_JOINTS = [
  'idx20_right_arm_joint1',
  'idx21_right_arm_joint2',
  'idx22_right_arm_joint3',
  'idx23_right_arm_joint4',
  'idx24_right_arm_joint5',
  'idx25_right_arm_joint6',
  'idx26_right_arm_joint7',
];

const HEAD_JOINTS = ['idx27_head_joint1', 'idx28_head_joint2'];
const SRC_LEFT_ARM_LANDMARKS = [P.L_ELBOW, P.L_WRIST, P.L_PINKY, P.L_INDEX, P.L_THUMB];
const SRC_RIGHT_ARM_LANDMARKS = [P.R_ELBOW, P.R_WRIST, P.R_PINKY, P.R_INDEX, P.R_THUMB];
const FINGER_KEYS = ['thumbOpp', 'thumb', 'index', 'middle', 'ring', 'pinky'];

/** Choose the ±2π-equivalent angle closest to `prev` to prevent atan2 branch-cut whips. */
function unwrapAngleNear(angle, prev, lo, hi) {
  let out = angle;
  if (Number.isFinite(prev)) {
    while (out - prev > Math.PI) out -= TWO_PI;
    while (out - prev < -Math.PI) out += TWO_PI;
  }
  return clamp(out, lo, hi);
}

function pointFinite(pt) {
  return Boolean(pt && Number.isFinite(pt.x) && Number.isFinite(pt.y) && Number.isFinite(pt.z));
}

function inFrame(pt, margin = 0) {
  return Boolean(pt && pt.x >= -margin && pt.x <= 1 + margin && pt.y >= -margin && pt.y <= 1 + margin);
}

/** Validate a 21-point hand detection for anatomical plausibility and in-frame presence. */
export function isHandPlausible(hand) {
  if (!hand?.image || hand.image.length < 21 || !hand?.world || hand.world.length < 21) return false;
  if (typeof hand.score === 'number' && hand.score < 0.50) return false;
  const wi = hand.image[0];
  const hw = hand.world;
  if (!pointFinite(wi) || !inFrame(wi, 0.03)) return false;
  if (!pointFinite(hw[0]) || !pointFinite(hw[5]) || !pointFinite(hw[9]) || !pointFinite(hw[17])) return false;
  const palmW = dist3(hw[5], hw[17]);
  const palmL = dist3(hw[0], hw[9]);
  // Reject collapsed or hallucinated macro-hands (real human palm ~0.05..0.12 m)
  if (palmW < 0.025 || palmW > 0.17 || palmL < 0.03 || palmL > 0.19) return false;
  return true;
}

/**
 * Assess per-arm, head, and torso landmark quality on raw MediaPipe frames BEFORE filtering.
 * Uses hysteresis (`wasLocked`), in-frame bounds, anatomical bone-length checks, and
 * single-frame teleport rejection so occlusion or off-screen limbs never drive berserk jumps.
 */
export function assessPoseTrackingQuality(poseFrame, prevState = null, dtSec = 1 / 30) {
  const w = poseFrame?.world;
  const im = poseFrame?.image;
  const vis = poseFrame?.vis || [];
  const invalid = {
    torsoValid: false,
    headValid: false,
    arms: [
      { valid: false, reason: 'no_pose', relEl: null, relWr: null },
      { valid: false, reason: 'no_pose', relEl: null, relWr: null },
    ],
  };
  if (!w || w.length < 25 || !im || im.length < 25) return invalid;

  const ls = w[P.L_SHOULDER];
  const rs = w[P.R_SHOULDER];
  if (!pointFinite(ls) || !pointFinite(rs) || !pointFinite(im[P.L_SHOULDER]) || !pointFinite(im[P.R_SHOULDER])) {
    return invalid;
  }

  const shMinVis = Math.min(vis[P.L_SHOULDER] ?? 1, vis[P.R_SHOULDER] ?? 1);
  const shoulderSpan = dist3(ls, rs);
  const torsoValid =
    shMinVis >= 0.42 &&
    inFrame(im[P.L_SHOULDER], 0.08) &&
    inFrame(im[P.R_SHOULDER], 0.08) &&
    shoulderSpan >= 0.14 &&
    shoulderSpan <= 0.72;

  if (!torsoValid) return invalid;

  const noseVis = vis[P.NOSE] ?? 1;
  const headValid =
    pointFinite(w[P.NOSE]) &&
    pointFinite(im[P.NOSE]) &&
    noseVis >= 0.40 &&
    inFrame(im[P.NOSE], 0.06);

  const safeDt = clamp(Number.isFinite(dtSec) ? dtSec : 1 / 30, 1 / 120, 0.25);
  const maxElJump = Math.max(0.20, 3.6 * safeDt);
  const maxWrJump = Math.max(0.25, 4.4 * safeDt);

  const evalArm = (sideIdx, shIdx, elIdx, wrIdx) => {
    const prevArm = prevState?.arms?.[sideIdx] || null;
    const wasLocked = Boolean(prevArm?.locked);

    const shV = vis[shIdx] ?? 1;
    const elV = vis[elIdx] ?? 1;
    const wrV = vis[wrIdx] ?? 1;
    // Hysteresis: stricter to acquire, slightly forgiving to hold while tracking smoothly
    const minShV = wasLocked ? 0.45 : 0.60;
    const minElV = wasLocked ? 0.46 : 0.60;
    const minWrV = wasLocked ? 0.42 : 0.56;

    if (shV < minShV || elV < minElV || wrV < minWrV) {
      return { valid: false, reason: 'low_vis', relEl: null, relWr: null };
    }

    const imEl = im[elIdx];
    const imWr = im[wrIdx];
    const frameMargin = wasLocked ? 0.02 : -0.02;
    if (!inFrame(imEl, frameMargin) || !inFrame(imWr, frameMargin)) {
      return { valid: false, reason: 'out_of_frame', relEl: null, relWr: null };
    }

    const shW = w[shIdx];
    const elW = w[elIdx];
    const wrW = w[wrIdx];
    if (!pointFinite(shW) || !pointFinite(elW) || !pointFinite(wrW)) {
      return { valid: false, reason: 'non_finite', relEl: null, relWr: null };
    }

    const relEl = sub(elW, shW);
    const relWr = sub(wrW, elW);
    const upperLen = len(relEl);
    const foreLen = len(relWr);
    // Anatomical upper-arm & forearm bone-length sanity bounds (prevents collapsed/exploded hallucinations)
    const minUpper = Math.max(0.11, shoulderSpan * 0.34);
    const maxUpper = Math.min(0.54, shoulderSpan * 1.75);
    const minFore = Math.max(0.09, shoulderSpan * 0.28);
    const maxFore = Math.min(0.50, shoulderSpan * 1.65);
    if (upperLen < minUpper || upperLen > maxUpper || foreLen < minFore || foreLen > maxFore) {
      return { valid: false, reason: 'bad_bone_len', relEl: null, relWr: null };
    }

    // Single-frame teleport / velocity glitch rejection against recent valid arm vectors
    if (wasLocked && prevArm?.relEl && prevArm?.relWr && prevArm.ageMs < 260) {
      if (dist3(relEl, prevArm.relEl) > maxElJump || dist3(relWr, prevArm.relWr) > maxWrJump) {
        return { valid: false, reason: 'teleport_glitch', relEl: null, relWr: null };
      }
    }

    return { valid: true, reason: 'ok', relEl, relWr };
  };

  return {
    torsoValid,
    headValid,
    arms: [
      evalArm(0, P.L_SHOULDER, P.L_ELBOW, P.L_WRIST),
      evalArm(1, P.R_SHOULDER, P.R_ELBOW, P.R_WRIST),
    ],
  };
}

/**
 * Retarget MediaPipe 3D world pose + 2D image landmarks + optional 21-pt hand landmarks
 * onto Luka's calibrated orthogonal 16 upper-body DOF and 12 finger channels.
 *
 * `mirrorSides = true`: like looking in a mirror at Luka facing you (your right arm
 * drives the arm on the right side of the viewport — Luka's left arm).
 */
export function retargetPoseToLuka(
  poseFrame,
  hands = [],
  { mirrorSides = true, calibration = null, prevJoints = null } = {},
) {
  const w = poseFrame?.world;
  const im = poseFrame?.image;
  const vis = poseFrame?.vis || [];
  if (!w || w.length < 25 || !im || im.length < 25) return null;

  const cal = { ...DEFAULT_HAND_CALIBRATION, ...(calibration || {}) };
  const reachScale = clamp(cal.reachScale ?? 1.12, 0.7, 1.5);
  const heightTrimRad = clamp((cal.heightTrimDeg ?? 0) * DEG_TO_RAD, -0.45, 0.45);
  const wristRollTrimRad = clamp((cal.wristRollTrimDeg ?? 0) * DEG_TO_RAD, -1.0, 1.0);

  const ls = w[P.L_SHOULDER];
  const rs = w[P.R_SHOULDER];
  const lh = w[P.L_HIP];
  const rh = w[P.R_HIP];

  const shoulderMid = mid(ls, rs);
  const hipMid = mid(lh, rh);
  // Only trust MediaPipe hips when BOTH hips are visible & near/inside the camera frame;
  // seated desk webcams frequently crop hips and hallucinate wild torso tilts otherwise!
  const hipsVisible =
    (vis[P.L_HIP] ?? 1) >= 0.58 &&
    (vis[P.R_HIP] ?? 1) >= 0.58 &&
    pointFinite(im[P.L_HIP]) &&
    pointFinite(im[P.R_HIP]) &&
    im[P.L_HIP].y <= 1.06 &&
    im[P.R_HIP].y <= 1.06;

  let torsoUp = { x: 0, y: -1, z: 0 };
  if (hipsVisible) {
    const upRaw = norm(sub(shoulderMid, hipMid));
    if (len(upRaw) > 0.5 && upRaw.y < -0.75) {
      // Clamp extreme torso tilt noise so hip depth jitter never rocks both arms wildly
      torsoUp = norm({
        x: clamp(upRaw.x, -0.34, 0.34),
        y: Math.min(upRaw.y, -0.88),
        z: clamp(upRaw.z, -0.34, 0.34),
      });
    }
  }

  let sideRaw = sub(rs, ls);
  sideRaw = sub(sideRaw, scale(torsoUp, dot(sideRaw, torsoUp)));
  const rightAxis = len(sideRaw) > 1e-4 ? norm(sideRaw) : { x: 1, y: 0, z: 0 };
  // Forward out of the person's chest toward the camera (-Z in MediaPipe world)
  const fwdAxis = norm(cross(rightAxis, torsoUp));

  function solveArmJoints(shoulder, elbow, wrist, outAxis, isLukaLeft, isSrcRight, handFrame, baseline) {
    const j1Key = isLukaLeft ? 'idx13_left_arm_joint1' : 'idx20_right_arm_joint1';
    const j3Key = isLukaLeft ? 'idx15_left_arm_joint3' : 'idx22_right_arm_joint3';
    const j5Key = isLukaLeft ? 'idx17_left_arm_joint5' : 'idx24_right_arm_joint5';
    const prevAbduct = prevJoints?.[j1Key];
    const prevArmRoll = prevJoints?.[j3Key];
    const prevForearmRoll = prevJoints?.[j5Key];

    // Express upper arm u and forearm f in torso [fwd, up, out] coordinates with Z-reach calibration
    const uRaw = sub(elbow, shoulder);
    const fRaw = sub(wrist, elbow);

    const uVec = norm({
      x: dot(uRaw, fwdAxis) * reachScale,
      y: dot(uRaw, torsoUp),
      z: dot(uRaw, outAxis),
    });
    const fVec = norm({
      x: dot(fRaw, fwdAxis) * reachScale,
      y: dot(fRaw, torsoUp),
      z: dot(fRaw, outAxis),
    });

    // Exact closed-form orthogonal shoulder angles aligned to AgiBot A2 Ultra travel
    //   uFwd = -sin(beta), uUp = -cos(beta)*cos(alpha), uOut = cos(beta)*sin(alpha)
    const beta = clamp(-Math.asin(clamp(uVec.x, -0.995, 0.995)) - heightTrimRad, -1.60, 0.46);
    const rawAlpha = Math.atan2(uVec.z, -uVec.y);
    // Smooth anti-gimbal blend when arm points straight forward (|uFwd| -> 1)
    const horizMag = Math.hypot(uVec.y, uVec.z);
    const horizWeight = ramp(horizMag, 0.14, 0.38);
    const fallbackAlpha = Number.isFinite(prevAbduct) ? prevAbduct + REST_ABDUCT_RAD : REST_ABDUCT_RAD;
    const alpha = rawAlpha * horizWeight + fallbackAlpha * (1 - horizWeight);
    const abduct = clamp(alpha - REST_ABDUCT_RAD, -0.32, 1.60);

    // Elbow flexion inside AimDK §7.1.9 hard limits (0.04 rad floor avoids 0.03 rad straight-arm stop)
    const bend = clamp(Math.acos(clamp(dot(uVec, fVec), -1, 1)), 0.04, 1.98);

    // Exact analytic humeral roll (j15/j22) in the rotated shoulder frame R_abduct(alpha) * R_pitch(beta):
    //   eFwd = forearm bend direction at armRoll = 0
    //   eOut = outward perpendicular; +armRoll rolls inward (-eOut), -armRoll rolls outward/upward (+eOut)
    const eFwd = {
      x: Math.cos(beta),
      y: -Math.sin(beta) * Math.cos(alpha),
      z: Math.sin(beta) * Math.sin(alpha),
    };
    const eOut = { x: 0, y: Math.sin(alpha), z: Math.cos(alpha) };
    const uf = dot(uVec, fVec);
    const fPerpRaw = sub(fVec, scale(uVec, uf));
    const fpLen = len(fPerpRaw);
    let armRoll = Number.isFinite(prevArmRoll) ? prevArmRoll * 0.92 : 0;
    if (fpLen > 0.14 && bend > 0.20) {
      const fPerp = scale(fPerpRaw, 1 / fpLen);
      const rollWeight = ramp(bend, 0.20, 0.62);
      const rawRoll = Math.atan2(-dot(fPerp, eOut), dot(fPerp, eFwd));
      const unwrapped = unwrapAngleNear(rawRoll, prevArmRoll, -1.65, 1.65);
      const fallbackRoll = Number.isFinite(prevArmRoll) ? prevArmRoll * 0.9 : 0;
      armRoll = clamp(unwrapped * rollWeight + fallbackRoll * (1 - rollWeight), -1.65, 1.65);
    }

    // Calibrated forearm roll (j17/j24), wrist flexion (j18/j25), wrist deviation (j19/j26), and 6-channel finger curls
    let forearmRoll = -0.18 + wristRollTrimRad;
    let wristFlex = 0;
    let wristDev = 0;
    let fingerCurls = { ...SAFE_NEUTRAL_HAND };
    let hasHand = false;

    if (handFrame?.world?.length >= 21) {
      hasHand = true;
      fingerCurls = extractFingerCurls(handFrame.world, baseline);
      const hw = handFrame.world;

      // Work in world space so MediaPipe HandLandmarker orientation aligns directly with Pose forearm `fW`
      const uW = norm(uRaw);
      const fW = norm(fRaw);
      const handDir = norm(sub(hw[9], hw[0]));        // wrist -> middle MCP
      const handRadial = norm(sub(hw[5], hw[17]));    // pinky MCP -> index MCP (thumb side)

      // Neutral radial-up axis at j5 = 0: points back along -u perpendicular to forearm fW (blended with torsoUp if straight)
      const negUProj = sub(scale(uW, -1), scale(fW, -dot(uW, fW)));
      const upProj = sub(torsoUp, scale(fW, dot(torsoUp, fW)));
      const elbowRefW = ramp(bend, 0.22, 0.65);
      const refRadialRaw = add(
        scale(len(negUProj) > 1e-4 ? norm(negUProj) : torsoUp, elbowRefW),
        scale(len(upProj) > 1e-4 ? norm(upProj) : torsoUp, 1 - elbowRefW),
      );
      const refRadial = norm(sub(refRadialRaw, scale(fW, dot(refRadialRaw, fW))));
      // Neutral inward palm-normal at j5 = 0 (points inward toward body midline)
      const refInward = isSrcRight ? norm(cross(fW, refRadial)) : norm(cross(refRadial, fW));

      // Project actual human knuckle span perpendicular to forearm to read exact pronation(+)/supination(-)
      const hrProj = sub(handRadial, scale(fW, dot(handRadial, fW)));
      if (len(hrProj) > 0.16 && len(refRadial) > 0.5 && len(refInward) > 0.5) {
        const hrUnit = norm(hrProj);
        const rawForearmRoll = Math.atan2(dot(hrUnit, refInward), dot(hrUnit, refRadial));
        forearmRoll = unwrapAngleNear(rawForearmRoll + wristRollTrimRad, prevForearmRoll, -2.25, 2.25);

        // Rotate neutral wrist frame by forearmRoll to measure pure wrist flexion & radial/ulnar deviation
        const cR = Math.cos(rawForearmRoll);
        const sR = Math.sin(rawForearmRoll);
        const curRadial = add(scale(refRadial, cR), scale(refInward, sR));
        const curPalm = sub(scale(refInward, cR), scale(refRadial, sR));

        const flexRad = Math.asin(clamp(dot(handDir, curPalm), -0.85, 0.85));
        const devRad = Math.asin(clamp(dot(handDir, curRadial), -0.75, 0.75));
        // Verified FK signs clamped inside AimDK §7.1.9 rhombic yellow parallel-wrist envelope (±0.30 / ±0.20 rad)
        const rawFlex = clamp((isLukaLeft ? -1 : 1) * flexRad * 0.72, -0.30, 0.30);
        const rawDev = clamp((isLukaLeft ? -1 : 1) * devRad * 0.60, -0.20, 0.20);
        const wSafe = clampRhombicWrist(rawFlex, rawDev, 0.30, 0.20);
        wristFlex = wSafe.j6;
        wristDev = wSafe.j7;
      } else if (Number.isFinite(prevForearmRoll)) {
        forearmRoll = prevForearmRoll;
      }
    }

    if (isLukaLeft) {
      return {
        joints: {
          idx13_left_arm_joint1: abduct,
          idx14_left_arm_joint2: beta,
          idx15_left_arm_joint3: armRoll,
          idx16_left_arm_joint4: -bend,
          idx17_left_arm_joint5: forearmRoll,
          idx18_left_arm_joint6: wristFlex,
          idx19_left_arm_joint7: wristDev,
        },
        fingers: fingerCurls,
        hasHand,
      };
    }
    return {
      joints: {
        idx20_right_arm_joint1: abduct,
        idx21_right_arm_joint2: beta,
        idx22_right_arm_joint3: armRoll,
        idx23_right_arm_joint4: bend,
        idx24_right_arm_joint5: forearmRoll,
        idx25_right_arm_joint6: wristFlex,
        idx26_right_arm_joint7: wristDev,
      },
      fingers: fingerCurls,
      hasHand,
    };
  }

  // Head lateral yaw & up/down pitch: fuse 3D world + 2D image landmarks for crisp, full-range tracking
  const nose = w[P.NOSE];
  const lEar = w[P.L_EAR];
  const rEar = w[P.R_EAR];
  const earMid = mid(lEar, rEar);
  const earSpan = Math.max(dist3(lEar, rEar), 0.11);
  const noseRel = sub(nose, earMid);

  const imNose = im[P.NOSE];
  const imLEar = im[P.L_EAR];
  const imREar = im[P.R_EAR];
  const imEarMid = mid(imLEar, imREar);
  const imEarSpan = Math.max(Math.hypot(imREar.x - imLEar.x, imREar.y - imLEar.y), 0.04);

  // Lateral yaw: clamped to AimDK §7.1.5-6 documented neck range (±0.785 rad / ±45°)
  const yaw3d = dot(noseRel, rightAxis) / earSpan;
  const yaw2d = (imNose.x - imEarMid.x) / imEarSpan;
  const yawFused = yaw3d * 0.55 + yaw2d * 0.45;
  const headYaw = clamp((mirrorSides ? 1 : -1) * yawFused * 2.15, -0.785, 0.785);

  // Up/down pitch: +torsoUp / -im.y is UP -> +idx28_head_joint2 pitches Luka UP
  const pitch3d = dot(noseRel, torsoUp) / earSpan;
  const pitch2d = (imEarMid.y - imNose.y) / imEarSpan;

  // Optional eye-to-mouth perspective ratio (adds sharp pitch response on live webcams)
  let faceTilt = 0;
  const imLEye = im[P.L_EYE];
  const imREye = im[P.R_EYE];
  const imML = im[P.MOUTH_L];
  const imMR = im[P.MOUTH_R];
  const hasFaceDetail =
    imLEye && imREye && imML && imMR &&
    (vis[P.L_EYE] ?? 1) > 0.4 && (vis[P.R_EYE] ?? 1) > 0.4 &&
    (vis[P.MOUTH_L] ?? 1) > 0.4 && (vis[P.MOUTH_R] ?? 1) > 0.4;
  if (hasFaceDetail) {
    const eyeMidY = 0.5 * (imLEye.y + imREye.y);
    const mouthMidY = 0.5 * (imML.y + imMR.y);
    const faceH = mouthMidY - eyeMidY;
    if (faceH > 0.015) {
      // Neutral nose sits ~52% down from eyes toward mouth; tilting UP moves nose closer to eyes
      const noseFrac = (imNose.y - eyeMidY) / faceH;
      faceTilt = clamp((0.52 - noseFrac) * 1.4, -0.45, 0.45);
    }
  }

  const pitchFused = pitch3d * 0.48 + pitch2d * 0.52 + faceTilt * 0.35;
  const headPitch = clamp(pitchFused * 1.85, -0.401, 0.401);

  // Gaze target from screen-space nose position (0..1) inside AimDK §7.1.5-6 neck limits
  const gazeYaw = clamp((imNose.x - 0.5) * 1.65, -0.785, 0.785);
  const gazePitch = clamp((0.42 - imNose.y) * 1.15, -0.401, 0.401);

  const handLeftSrc = hands.find((h) => h.side === 0) || null;
  const handRightSrc = hands.find((h) => h.side === 1) || null;

  const leftOutAxis = scale(rightAxis, -1);
  const rightOutAxis = rightAxis;

  // Map human sides to Luka's left/right arms
  const srcForLukaLeft = mirrorSides
    ? { sh: rs, el: w[P.R_ELBOW], wr: w[P.R_WRIST], out: rightOutAxis, isSrcRight: true, hand: handRightSrc, base: cal.openBaseline?.left }
    : { sh: ls, el: w[P.L_ELBOW], wr: w[P.L_WRIST], out: leftOutAxis, isSrcRight: false, hand: handLeftSrc, base: cal.openBaseline?.left };

  const srcForLukaRight = mirrorSides
    ? { sh: ls, el: w[P.L_ELBOW], wr: w[P.L_WRIST], out: leftOutAxis, isSrcRight: false, hand: handLeftSrc, base: cal.openBaseline?.right }
    : { sh: rs, el: w[P.R_ELBOW], wr: w[P.R_WRIST], out: rightOutAxis, isSrcRight: true, hand: handRightSrc, base: cal.openBaseline?.right };

  const lukaL = solveArmJoints(srcForLukaLeft.sh, srcForLukaLeft.el, srcForLukaLeft.wr, srcForLukaLeft.out, true, srcForLukaLeft.isSrcRight, srcForLukaLeft.hand, srcForLukaLeft.base);
  const lukaR = solveArmJoints(srcForLukaRight.sh, srcForLukaRight.el, srcForLukaRight.wr, srcForLukaRight.out, false, srcForLukaRight.isSrcRight, srcForLukaRight.hand, srcForLukaRight.base);

  const joints = {
    idx27_head_joint1: headYaw,
    idx28_head_joint2: headPitch,
    ...lukaL.joints,
    ...lukaR.joints,
  };

  // Classify high-level human gesture (Kameyoko-style cues)
  const shoulderW = Math.max(dist3(ls, rs), 0.18);
  const wristGap = dist3(w[P.L_WRIST], w[P.R_WRIST]) / shoulderW;
  const lHandHigh = w[P.L_WRIST].y < ls.y + 0.04;
  const rHandHigh = w[P.R_WRIST].y < rs.y + 0.04;
  const avgOpenL = 1 - (lukaL.fingers.index + lukaL.fingers.middle + lukaL.fingers.ring + lukaL.fingers.pinky) / 4;
  const avgOpenR = 1 - (lukaR.fingers.index + lukaR.fingers.middle + lukaR.fingers.ring + lukaR.fingers.pinky) / 4;

  let detectedGesture = 'Neutral';
  if (lHandHigh && rHandHigh) detectedGesture = 'Both Hands Raised';
  else if (wristGap < 0.52 && (lukaL.joints.idx14_left_arm_joint2 < -0.5 || lukaR.joints.idx21_right_arm_joint2 < -0.5)) detectedGesture = 'Hands Together';
  else if ((lHandHigh && avgOpenL > 0.55) || (rHandHigh && avgOpenR > 0.55)) detectedGesture = 'Wave / Greeting';
  else if (lukaL.fingers.index < 0.25 && lukaL.fingers.middle > 0.65) detectedGesture = 'Pointing (L)';
  else if (lukaR.fingers.index < 0.25 && lukaR.fingers.middle > 0.65) detectedGesture = 'Pointing (R)';
  else if (avgOpenL < 0.3 && avgOpenR < 0.3 && Math.abs(lukaL.joints.idx16_left_arm_joint4) > 0.9) detectedGesture = 'Guard / Fists';
  else if (avgOpenL > 0.72 && avgOpenR > 0.72 && (lukaL.joints.idx14_left_arm_joint2 < -0.35 || lukaR.joints.idx21_right_arm_joint2 < -0.35)) detectedGesture = 'Open Palms';

  return {
    joints,
    hands: { left: lukaL.fingers, right: lukaR.fingers },
    hasHand: { left: lukaL.hasHand, right: lukaR.hasHand },
    headTarget: { yaw: gazeYaw, pitch: gazePitch },
    detectedGesture,
    handCount: hands.length,
    openness: { left: Number(avgOpenL.toFixed(2)), right: Number(avgOpenR.toFixed(2)) },
    visibility: Math.min(vis[P.L_SHOULDER] ?? 1, vis[P.R_SHOULDER] ?? 1),
  };
}

/* ------------------------------------------- Synthetic Demo Tracker Source */

function buildSyntheticHand(wristImg, wristWorld, curl = 0.1, side = 1) {
  const image = [];
  const world = [];
  const palmLen = 0.075;
  const seg1 = 0.032;
  const seg2 = 0.022;
  const seg3 = 0.018;
  // side === 1 is screen-right hand (thumb on left/-x side facing inward); side === 0 mirrors thumb on +x
  const sgn = side === 1 ? -1 : 1;

  // Index 0: wrist
  world.push({ ...wristWorld });
  image.push({ ...wristImg });

  for (let f = 0; f < 5; f++) {
    const isThumb = f === 0;
    if (isThumb) {
      const mcp = { x: wristWorld.x + sgn * 0.024, y: wristWorld.y - 0.024, z: wristWorld.z - 0.008 };
      const j2 = {
        x: mcp.x + sgn * lerp(0.024, -0.004, curl),
        y: mcp.y - lerp(0.022, 0.026, curl),
        z: mcp.z - lerp(0.006, 0.016, curl),
      };
      const j3 = {
        x: j2.x + sgn * lerp(0.018, -0.016, curl),
        y: j2.y - lerp(0.018, 0.016, curl),
        z: j2.z - lerp(0.004, 0.014, curl),
      };
      const j4 = {
        x: j3.x + sgn * lerp(0.014, -0.018, curl),
        y: j3.y - lerp(0.014, 0.006, curl),
        z: j3.z - lerp(0.002, 0.002, curl),
      };
      for (const pt of [mcp, j2, j3, j4]) {
        world.push(pt);
        image.push({ x: wristImg.x + (pt.x - wristWorld.x) * 0.72, y: wristImg.y + (pt.y - wristWorld.y) * 0.82, z: 0 });
      }
      continue;
    }

    // Index=1 (thumb side) .. Pinky=4 (outer side)
    const fingerOffset = (f - 2.5) * -sgn * 0.017;
    const j1 = { x: wristWorld.x + fingerOffset, y: wristWorld.y - palmLen, z: wristWorld.z };
    // True articulated phalanx flexion angles around knuckle axis (0 rad straight -> 1.45 rad curled per joint)
    const a1 = curl * 1.25;
    const a2 = a1 + curl * 1.45;
    const a3 = a2 + curl * 0.95;
    const j2 = { x: j1.x, y: j1.y - Math.cos(a1) * seg1, z: j1.z - Math.sin(a1) * seg1 };
    const j3 = { x: j2.x, y: j2.y - Math.cos(a2) * seg2, z: j2.z - Math.sin(a2) * seg2 };
    const j4 = { x: j3.x, y: j3.y - Math.cos(a3) * seg3, z: j3.z - Math.sin(a3) * seg3 };
    for (const pt of [j1, j2, j3, j4]) {
      world.push(pt);
      image.push({ x: wristImg.x + (pt.x - wristWorld.x) * 0.72, y: wristImg.y + (pt.y - wristWorld.y) * 0.82, z: 0 });
    }
  }
  return { image, world };
}

/** Procedural Kameyoko-style upper-body person so tracking can be demoed without a webcam. */
export function sampleDemoTrackedFrame(t) {
  const phase = (t % 16) / 4; // 4 phases of 4 seconds each
  const w = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  w[P.L_HIP] = { x: -0.11, y: 0, z: 0 };
  w[P.R_HIP] = { x: 0.11, y: 0, z: 0 };
  w[P.L_SHOULDER] = { x: -0.19, y: -0.48, z: 0 };
  w[P.R_SHOULDER] = { x: 0.19, y: -0.48, z: 0 };

  let headYaw = Math.sin(t * 0.95) * 0.055;
  let headPitch = Math.sin(t * 1.4) * 0.025;
  let lElbow = { x: -0.26, y: -0.24, z: -0.04 };
  let lWrist = { x: -0.28, y: -0.02, z: -0.08 };
  let rElbow = { x: 0.26, y: -0.24, z: -0.04 };
  let rWrist = { x: 0.28, y: -0.02, z: -0.08 };
  let lCurl = 0.22;
  let rCurl = 0.22;

  if (phase < 1) {
    // Phase 0: Friendly Wave with right hand — glance toward waving side & slightly up
    const osc = Math.sin(t * 6.5);
    rElbow = { x: 0.36, y: -0.44, z: -0.16 };
    rWrist = { x: 0.38 + osc * 0.09, y: -0.70, z: -0.22 };
    rCurl = 0.04;
    headYaw = 0.045 + Math.sin(t * 1.6) * 0.015;
    headPitch = 0.015;
  } else if (phase < 2) {
    // Phase 1: Expressive Two-Hand Open Explanation — sweep head left/right & nod
    const s = Math.sin(t * 3.0);
    lElbow = { x: -0.28, y: -0.26, z: -0.14 };
    lWrist = { x: -0.24 - s * 0.06, y: -0.34 + s * 0.04, z: -0.34 };
    rElbow = { x: 0.28, y: -0.26, z: -0.14 };
    rWrist = { x: 0.24 + s * 0.06, y: -0.34 - s * 0.04, z: -0.34 };
    lCurl = 0.08;
    rCurl = 0.08;
    headYaw = Math.sin((phase - 1) * Math.PI * 2) * 0.06;
    headPitch = Math.sin((phase - 1) * Math.PI * 3) * 0.024;
  } else if (phase < 3) {
    // Phase 2: Kameyoko Power / Hands Together — focused dip down then look forward
    const p = Math.sin((phase - 2) * Math.PI);
    lElbow = { x: -0.24, y: -0.38, z: -0.20 - p * 0.12 };
    lWrist = { x: -0.05, y: -0.40, z: -0.42 - p * 0.16 };
    rElbow = { x: 0.24, y: -0.38, z: -0.20 - p * 0.12 };
    rWrist = { x: 0.05, y: -0.40, z: -0.42 - p * 0.16 };
    lCurl = 0.06;
    rCurl = 0.06;
    headYaw = Math.sin((phase - 2) * Math.PI) * -0.025;
    headPitch = -0.028 * p;
  } else {
    // Phase 3: Celebrate / Arms Wide & High — tilt head up triumphantly
    const s = Math.sin(t * 5.0);
    lElbow = { x: -0.40, y: -0.58, z: -0.12 };
    lWrist = { x: -0.46, y: -0.82 + s * 0.05, z: -0.16 };
    rElbow = { x: 0.40, y: -0.58, z: -0.12 };
    rWrist = { x: 0.46, y: -0.82 + s * 0.05, z: -0.16 };
    lCurl = 0.85;
    rCurl = 0.85;
    headYaw = Math.sin(t * 2.2) * 0.03;
    headPitch = 0.036;
  }

  w[P.L_EAR] = { x: -0.075, y: -0.66, z: 0.01 };
  w[P.R_EAR] = { x: 0.075, y: -0.66, z: 0.01 };
  w[P.NOSE] = { x: headYaw, y: -0.66 - headPitch, z: -0.09 };
  w[P.L_EYE] = { x: headYaw - 0.032, y: -0.695 - headPitch * 0.72, z: -0.075 };
  w[P.R_EYE] = { x: headYaw + 0.032, y: -0.695 - headPitch * 0.72, z: -0.075 };
  w[P.MOUTH_L] = { x: headYaw - 0.024, y: -0.625 - headPitch * 0.72, z: -0.078 };
  w[P.MOUTH_R] = { x: headYaw + 0.024, y: -0.625 - headPitch * 0.72, z: -0.078 };
  w[P.L_ELBOW] = lElbow;
  w[P.L_WRIST] = lWrist;
  w[P.R_ELBOW] = rElbow;
  w[P.R_WRIST] = rWrist;
  w[P.L_INDEX] = add(lWrist, { x: 0, y: -0.06, z: -0.02 });
  w[P.L_PINKY] = add(lWrist, { x: -0.03, y: -0.05, z: -0.01 });
  w[P.L_THUMB] = add(lWrist, { x: 0.03, y: -0.04, z: -0.02 });
  w[P.R_INDEX] = add(rWrist, { x: 0, y: -0.06, z: -0.02 });
  w[P.R_PINKY] = add(rWrist, { x: 0.03, y: -0.05, z: -0.01 });
  w[P.R_THUMB] = add(rWrist, { x: -0.03, y: -0.04, z: -0.02 });

  const toImg = (pt) => ({ x: 0.5 + pt.x * 0.78, y: 0.88 + pt.y * 0.88, z: pt.z });
  const image = w.map(toImg);
  const vis = w.map(() => 0.99);
  const hands = [
    { ...buildSyntheticHand(image[P.L_WRIST], lWrist, lCurl, 0), side: 0 },
    { ...buildSyntheticHand(image[P.R_WRIST], rWrist, rCurl, 1), side: 1 },
  ];
  return { pose: { image, world: w, vis }, hands };
}

/* ------------------------------------------- Live MediaPipe Vision Engine */

const REMOTE_CDN_VERSION = '0.10.22-rc.20250304';
const REMOTE_MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models';
const POSE_MODEL_URL = `${REMOTE_MODEL_BASE}/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`;
const HAND_MODEL_URL = `${REMOTE_MODEL_BASE}/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task`;

export class KameyokoVisionTracker {
  constructor({ videoEl, overlayCanvas, onStatus = () => {} }) {
    this.video = videoEl;
    this.canvas = overlayCanvas;
    this.ctx = overlayCanvas?.getContext('2d') || null;
    this.onStatus = onStatus;

    this.running = false;
    this.sourceMode = 'off'; // 'off' | 'camera' | 'demo'
    this.mirrorSides = true;
    this.stream = null;
    this.poseLandmarker = null;
    this.handLandmarker = null;
    this.delegate = 'GPU';
    this.lastVideoTime = -1;
    this.lastTs = -1;
    this.demoTime = 0;

    this.imageFilter = new PointsFilter({ minCutoff: 1.4, beta: 0.38, dCutoff: 1.0 });
    this.worldFilter = new PointsFilter({ minCutoff: 1.2, beta: 0.34, dCutoff: 1.0 });
    // Dedicated per-side 21-point One Euro Filters for hands (eliminates raw landmark jitter!)
    this.handImageFilters = [
      new PointsFilter({ minCutoff: 1.25, beta: 0.32, dCutoff: 1.0 }),
      new PointsFilter({ minCutoff: 1.25, beta: 0.32, dCutoff: 1.0 }),
    ];
    this.handWorldFilters = [
      new PointsFilter({ minCutoff: 1.05, beta: 0.28, dCutoff: 1.0 }),
      new PointsFilter({ minCutoff: 1.05, beta: 0.28, dCutoff: 1.0 }),
    ];
    // Post-retarget joint & finger One Euro filters + velocity-aware deadband
    this.jointFilters = new Map();
    this.curlFilters = { left: new Map(), right: new Map() };
    this.lastValidHand = [null, null]; // { hand, seenAtMs } for dropout grace hold
    this.rawHandsLatest = [null, null]; // unfiltered latest world hands for one-click open-hand calibration
    this.guard = this._makeGuardState();

    this.calibration = { ...DEFAULT_HAND_CALIBRATION };
    this.lastTracked = null;
    this.lastFrame = null;
    this.setSmoothing(this.calibration.smoothing);
  }

  _makeGuardState() {
    return {
      outputJoints: { ...SAFE_NEUTRAL_JOINTS },
      outputHands: { left: { ...SAFE_NEUTRAL_HAND }, right: { ...SAFE_NEUTRAL_HAND } },
      headTarget: { yaw: 0, pitch: 0 },
      head: { state: 'RELAX', locked: false, lostMs: 1000, streak: 0, blend: 0, everLocked: false },
      arms: {
        left: { state: 'RELAX', locked: false, lostMs: 1000, streak: 0, blend: 0, everLocked: false, reason: 'init', handLostMs: 1000, handState: 'RELAX' },
        right: { state: 'RELAX', locked: false, lostMs: 1000, streak: 0, blend: 0, everLocked: false, reason: 'init', handLostMs: 1000, handState: 'RELAX' },
      },
      rawSrcArms: [
        { locked: false, relEl: null, relWr: null, seenAtMs: -1e9, candRelEl: null, candRelWr: null },
        { locked: false, relEl: null, relWr: null, seenAtMs: -1e9, candRelEl: null, candRelWr: null },
      ],
      lastFrameMs: -1,
      lastRawPose: null,
    };
  }

  /** Adjust anti-jitter smoothing live (0 = snappy, 1 = ultra-smooth). */
  setSmoothing(level01) {
    const s = clamp(Number(level01) || 0, 0, 1);
    this.calibration.smoothing = s;
    const poseCutoff = lerp(2.4, 0.65, s);
    const poseBeta = lerp(0.75, 0.16, s);
    const handCutoff = lerp(2.2, 0.52, s);
    const handBeta = lerp(0.62, 0.14, s);
    this.imageFilter.setParams({ minCutoff: poseCutoff * 1.15, beta: poseBeta * 1.15, dCutoff: 1.0 });
    this.worldFilter.setParams({ minCutoff: poseCutoff, beta: poseBeta, dCutoff: 1.0 });
    for (let side = 0; side < 2; side++) {
      this.handImageFilters[side].setParams({ minCutoff: handCutoff * 1.15, beta: handBeta * 1.1, dCutoff: 1.0 });
      this.handWorldFilters[side].setParams({ minCutoff: handCutoff, beta: handBeta, dCutoff: 1.0 });
    }
    const jointCutoff = lerp(3.0, 0.85, s);
    const jointBeta = lerp(0.95, 0.22, s);
    for (const f of this.jointFilters.values()) f.setParams(jointCutoff, jointBeta, 1.0);
    const curlCutoff = lerp(2.8, 0.72, s);
    const curlBeta = lerp(0.85, 0.18, s);
    for (const side of ['left', 'right']) {
      for (const f of this.curlFilters[side].values()) f.setParams(curlCutoff, curlBeta, 1.0);
    }
  }

  setCalibration(partial) {
    if (!partial || typeof partial !== 'object') return;
    this.calibration = { ...this.calibration, ...partial };
    if (typeof partial.smoothing === 'number') this.setSmoothing(partial.smoothing);
  }

  /** Capture currently tracked open hands as the personal zero-curl baseline. */
  calibrateOpenHands() {
    const leftSrc = this.mirrorSides ? this.rawHandsLatest[1] : this.rawHandsLatest[0];
    const rightSrc = this.mirrorSides ? this.rawHandsLatest[0] : this.rawHandsLatest[1];
    const left = leftSrc?.world?.length >= 21 ? extractFingerCurls(leftSrc.world, null) : null;
    const right = rightSrc?.world?.length >= 21 ? extractFingerCurls(rightSrc.world, null) : null;
    if (!left && !right) return null;
    this.calibration.openBaseline = {
      left: left || this.calibration.openBaseline?.left || null,
      right: right || this.calibration.openBaseline?.right || null,
    };
    return this.calibration.openBaseline;
  }

  resetCalibration() {
    this.calibration = { ...DEFAULT_HAND_CALIBRATION };
    this.setSmoothing(this.calibration.smoothing);
    return this.calibration;
  }

  _resetAllFilters() {
    this.imageFilter.reset();
    this.worldFilter.reset();
    this.handImageFilters.forEach((f) => f.reset());
    this.handWorldFilters.forEach((f) => f.reset());
    this.jointFilters.clear();
    this.curlFilters.left.clear();
    this.curlFilters.right.clear();
    this.lastValidHand = [null, null];
    this.rawHandsLatest = [null, null];
    this.guard = this._makeGuardState();
  }

  async _ensureModels() {
    if (this.poseLandmarker) return;
    this.onStatus('Loading Kameyoko MediaPipe runtime…');
    const isStatic = typeof document !== 'undefined' && document.querySelector?.('meta[name="luka-env"]')?.content === 'static';
    let visionMod;
    let wasmBase = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${REMOTE_CDN_VERSION}/wasm`;
    if (!isStatic) {
      try {
        visionMod = await import('/mediapipe/vision_bundle.mjs');
        wasmBase = '/mediapipe/wasm';
      } catch {
        visionMod = null;
      }
    }
    if (!visionMod) {
      visionMod = await import(`https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${REMOTE_CDN_VERSION}/vision_bundle.mjs`);
    }

    const { FilesetResolver, PoseLandmarker, HandLandmarker } = visionMod;
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);

    const makePose = (delegate) => PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    const makeHand = (delegate) => HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    this.onStatus('Loading MediaPipe 3D pose model…');
    try {
      this.poseLandmarker = await makePose('GPU');
      this.delegate = 'GPU';
    } catch {
      this.poseLandmarker = await makePose('CPU');
      this.delegate = 'CPU';
    }

    this.onStatus('Loading MediaPipe 21-pt hand model…');
    try {
      this.handLandmarker = await makeHand(this.delegate);
    } catch (err) {
      console.warn('[kameyoko] hand landmarker unavailable, continuing with pose only:', err);
      this.handLandmarker = null;
    }
  }

  async startCamera() {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access requires localhost or HTTPS.');
    }
    this.onStatus('Requesting camera permission…');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' },
      audio: false,
    });
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.playsInline = true;
    this.video.muted = true;
    await this.video.play();

    await this._ensureModels();
    this._resetAllFilters();
    this.sourceMode = 'camera';
    this.running = true;
    this.onStatus(`Camera live (${this.delegate}${this.handLandmarker ? ' · Pose+Hands' : ' · Pose'})`);
  }

  startDemo() {
    this.stop();
    this._resetAllFilters();
    this.demoTime = 0;
    this.sourceMode = 'demo';
    this.running = true;
    this.onStatus('Kameyoko synthetic demo active');
  }

  stop() {
    this.running = false;
    this.sourceMode = 'off';
    this.lastTracked = null;
    this.lastFrame = null;
    this._resetAllFilters();
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) this.video.srcObject = null;
    if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.onStatus('Tracker idle');
  }

  _filterRetargeted(raw, dtSec) {
    if (!raw) return null;
    const safeDt = clamp(Number.isFinite(dtSec) ? dtSec : 1 / 60, 1 / 240, 0.2);
    const s = this.calibration.smoothing;
    const jointCutoff = lerp(3.0, 0.85, s);
    const jointBeta = lerp(0.95, 0.22, s);
    const curlCutoff = lerp(2.8, 0.72, s);
    const curlBeta = lerp(0.85, 0.18, s);
    const jointDeadband = lerp(0.003, 0.018, s);
    const curlDeadband = lerp(0.004, 0.022, s);

    const joints = {};
    for (const [k, v] of Object.entries(raw.joints)) {
      let f = this.jointFilters.get(k);
      if (!f) {
        f = new OneEuro(jointCutoff, jointBeta, 1.0);
        this.jointFilters.set(k, f);
      }
      const prev = f.x;
      const isHead = k.startsWith('idx27_') || k.startsWith('idx28_');
      const isWrist = k.endsWith('joint5') || k.endsWith('joint6') || k.endsWith('joint7');
      const isRelaxing =
        (isHead && raw.trackingState?.head === 'RELAX') ||
        (k.includes('_left_arm_') && raw.trackingState?.leftArm === 'RELAX') ||
        (k.includes('_right_arm_') && raw.trackingState?.rightArm === 'RELAX');
      const db = isRelaxing ? 0 : (isWrist ? jointDeadband * 1.45 : jointDeadband);
      let target = (prev !== null && db > 0 && Math.abs(v - prev) < db) ? prev : v;
      // Slew-rate guard prevents any residual single-frame glitch from whipping a limb
      if (prev !== null) {
        const maxRate = isHead ? 2.2 : (isWrist ? 2.1 : 2.5);
        const maxStep = maxRate * safeDt;
        target = clamp(target, prev - maxStep, prev + maxStep);
      }
      joints[k] = f.filter(target, safeDt);
    }

    // Re-enforce coupled rhombic wrist diamond after filtering
    const wL = clampRhombicWrist(joints.idx18_left_arm_joint6, joints.idx19_left_arm_joint7, 0.30, 0.20);
    joints.idx18_left_arm_joint6 = wL.j6;
    joints.idx19_left_arm_joint7 = wL.j7;
    const wR = clampRhombicWrist(joints.idx25_right_arm_joint6, joints.idx26_right_arm_joint7, 0.30, 0.20);
    joints.idx25_right_arm_joint6 = wR.j6;
    joints.idx26_right_arm_joint7 = wR.j7;

    const hands = { left: {}, right: {} };
    for (const side of ['left', 'right']) {
      for (const [k, v] of Object.entries(raw.hands[side] || {})) {
        let f = this.curlFilters[side].get(k);
        if (!f) {
          f = new OneEuro(curlCutoff, curlBeta, 1.0);
          this.curlFilters[side].set(k, f);
        }
        const prev = f.x;
        let target = (prev !== null && Math.abs(v - prev) < curlDeadband) ? prev : v;
        if (prev !== null) {
          const maxCurlStep = 3.2 * safeDt;
          target = clamp(target, prev - maxCurlStep, prev + maxCurlStep);
        }
        hands[side][k] = Number(clamp(f.filter(target, safeDt), 0, 1).toFixed(3));
      }
    }

    const avgOpenL = 1 - (hands.left.index + hands.left.middle + hands.left.ring + hands.left.pinky) / 4;
    const avgOpenR = 1 - (hands.right.index + hands.right.middle + hands.right.ring + hands.right.pinky) / 4;

    return {
      ...raw,
      joints,
      hands,
      openness: { left: Number(clamp(avgOpenL, 0, 1).toFixed(2)), right: Number(clamp(avgOpenR, 0, 1).toFixed(2)) },
    };
  }

  _assignHandsToWrists(poseImage, rawHands, aspect, nowMs, dtSec, armValidMask = [true, true]) {
    const lw = poseImage[P.L_WRIST];
    const rw = poseImage[P.R_WRIST];
    const ls = poseImage[P.L_SHOULDER];
    const rs = poseImage[P.R_SHOULDER];
    // Use shoulder width (always in-frame) rather than hips (often cropped on desk webcams)
    const shoulderNorm = Math.hypot((ls.x - rs.x) * aspect, ls.y - rs.y) * 1.35;
    const scaleNorm = Math.max(shoulderNorm, 0.12);
    const matched = [null, null];

    const validRawHands = (rawHands || []).filter(isHandPlausible);
    if (validRawHands.length) {
      const pairs = [];
      validRawHands.forEach((h, hi) => {
        const hw = h.image[0];
        for (const side of [0, 1]) {
          // NEVER attach a detected hand to an invisible / out-of-frame arm (prevents cross-arm steals!)
          if (!armValidMask[side]) continue;
          const wristPt = side === 0 ? lw : rw;
          let d = Math.hypot((hw.x - wristPt.x) * aspect, hw.y - wristPt.y) / scaleNorm;
          if (this.lastValidHand[side] && nowMs - this.lastValidHand[side].seenAtMs < 350) {
            const prevPt = this.lastValidHand[side].hand.image[0];
            const jump2d = Math.hypot((hw.x - prevPt.x) * aspect, hw.y - prevPt.y);
            if (jump2d > 0.42) continue; // reject sudden cross-frame hand teleports
            d = d * 0.72 + (jump2d / scaleNorm) * 0.28;
          }
          pairs.push({ hi, side, d });
        }
      });
      pairs.sort((a, b) => a.d - b.d);
      const usedHands = new Set();
      for (const p of pairs) {
        if (p.d > 0.62 || usedHands.has(p.hi) || matched[p.side]) continue;
        usedHands.add(p.hi);
        const src = validRawHands[p.hi];
        this.rawHandsLatest[p.side] = src;
        const filtHand = {
          side: p.side,
          image: this.handImageFilters[p.side].filter(src.image, dtSec),
          world: src.world?.length >= 21 ? this.handWorldFilters[p.side].filter(src.world, dtSec) : [],
        };
        matched[p.side] = filtHand;
        this.lastValidHand[p.side] = { hand: filtHand, seenAtMs: nowMs };
      }
    }

    // 550 ms dropout grace hold (only while that arm is still valid); beyond that let failsafe smoothly relax
    const out = [];
    for (let side = 0; side < 2; side++) {
      if (matched[side]) {
        out.push(matched[side]);
      } else if (armValidMask[side] && this.lastValidHand[side] && nowMs - this.lastValidHand[side].seenAtMs < 550) {
        out.push(this.lastValidHand[side].hand);
      } else if (!armValidMask[side] || (this.lastValidHand[side] && nowMs - this.lastValidHand[side].seenAtMs >= 900)) {
        this.handImageFilters[side].reset();
        this.handWorldFilters[side].reset();
        this.lastValidHand[side] = null;
      }
    }
    return out;
  }

  /**
   * Process a raw (unfiltered) pose + hand detection frame through the full anti-spaz failsafe:
   *   1. Visibility / presence / in-frame / bone-length / anti-teleport gating per arm
   *   2. Selective landmark freezing so lost arms never poison OneEuro filters
   *   3. Per-arm 3-state failsafe: LOCKED -> HOLD (0..900ms freeze) -> RELAX (gentle drift to neutral)
   *   4. 3-frame reacquire debounce + smooth 0.38s blend-in on return
   *   5. Continuous atan2 angle unwrapping + per-joint slew-rate cap + rhombic wrist guard
   */
  processRawFrame(rawPose, rawHands, nowMs, dtSec, aspect = 16 / 9) {
    const safeDt = clamp(Number.isFinite(dtSec) ? dtSec : 1 / 30, 1 / 240, 0.2);
    const dtMs = safeDt * 1000;
    const g = this.guard;
    const isDemo = this.sourceMode === 'demo';
    const reacquireRequired = isDemo ? 1 : 3;
    const holdGraceMs = 900;
    const handHoldGraceMs = 550;

    // 1. Evaluate raw pose quality BEFORE filtering
    const prevQualState = {
      arms: g.rawSrcArms.map((a) => ({
        locked: a.locked,
        relEl: a.relEl,
        relWr: a.relWr,
        ageMs: nowMs - a.seenAtMs,
      })),
    };
    const quality = rawPose ? assessPoseTrackingQuality(rawPose, prevQualState, safeDt) : assessPoseTrackingQuality(null);

    // 2. Build freezeMask so lost/glitched arm landmarks NEVER pollute OneEuro filters
    const freezeMask = new Set();
    const srcArmValid = [false, false];
    for (const srcSide of [0, 1]) {
      const qa = quality.arms[srcSide];
      const rs = g.rawSrcArms[srcSide];
      if (quality.torsoValid && qa.valid) {
        srcArmValid[srcSide] = true;
        // Track clean consecutive candidate consistency when re-acquiring
        if (!rs.locked) {
          const consistent =
            !rs.candRelEl ||
            (dist3(qa.relEl, rs.candRelEl) < 0.18 && dist3(qa.relWr, rs.candRelWr) < 0.22);
          rs.candRelEl = qa.relEl;
          rs.candRelWr = qa.relWr;
          if (!consistent) srcArmValid[srcSide] = false;
        } else {
          rs.relEl = qa.relEl;
          rs.relWr = qa.relWr;
          rs.seenAtMs = nowMs;
        }
      } else {
        rs.candRelEl = null;
        rs.candRelWr = null;
      }

      if (!srcArmValid[srcSide]) {
        const indices = srcSide === 0 ? SRC_LEFT_ARM_LANDMARKS : SRC_RIGHT_ARM_LANDMARKS;
        for (const idx of indices) freezeMask.add(idx);
      } else if (!rs.locked) {
        const lukaSide = (srcSide === 1) === this.mirrorSides ? 'left' : 'right';
        if (g.arms[lukaSide].streak === 0) {
          // Fresh clean arm candidate after dropout: seed OneEuro filters cleanly without stale drag
          const indices = srcSide === 0 ? SRC_LEFT_ARM_LANDMARKS : SRC_RIGHT_ARM_LANDMARKS;
          this.imageFilter.resetIndices(indices);
          this.worldFilter.resetIndices(indices);
        }
      }
    }

    // 3. Filter pose landmarks (selectively freezing lost limbs) and match plausible hands
    let poseFrame = null;
    let matchedHands = [];
    let rawRetargeted = null;
    if (quality.torsoValid && rawPose) {
      // If an arm just became valid after being lost, re-seed its landmark filters cleanly on lock transition below
      poseFrame = {
        image: this.imageFilter.filter(rawPose.image, safeDt, freezeMask),
        world: this.worldFilter.filter(rawPose.world, safeDt, freezeMask),
        vis: rawPose.vis,
      };
      matchedHands = isDemo
        ? (rawHands || []).map((h) => {
            this.rawHandsLatest[h.side] = h;
            return {
              side: h.side,
              image: this.handImageFilters[h.side].filter(h.image, safeDt),
              world: this.handWorldFilters[h.side].filter(h.world, safeDt),
            };
          })
        : this._assignHandsToWrists(poseFrame.image, rawHands || [], aspect, nowMs, safeDt, srcArmValid);

      rawRetargeted = retargetPoseToLuka(poseFrame, matchedHands, {
        mirrorSides: this.mirrorSides,
        calibration: this.calibration,
        prevJoints: g.outputJoints,
      });
    }

    // 4. Advance head failsafe state machine
    const relaxAlpha = 1 - Math.exp(-safeDt / 0.95);
    const handRelaxAlpha = 1 - Math.exp(-safeDt / 0.70);
    const headSt = g.head;
    if (quality.torsoValid && quality.headValid && rawRetargeted) {
      headSt.streak += 1;
      const needed = headSt.everLocked ? 2 : 1;
      if (headSt.locked || headSt.streak >= needed) {
        if (!headSt.locked) headSt.blend = headSt.everLocked ? 0 : 1;
        headSt.locked = true;
        headSt.everLocked = true;
        headSt.state = 'LOCKED';
        headSt.lostMs = 0;
        headSt.blend = Math.min(1, headSt.blend + safeDt / 0.30);
        for (const k of HEAD_JOINTS) {
          g.outputJoints[k] = lerp(g.outputJoints[k], rawRetargeted.joints[k], headSt.blend);
        }
        g.headTarget = {
          yaw: lerp(g.headTarget.yaw, rawRetargeted.headTarget.yaw, headSt.blend),
          pitch: lerp(g.headTarget.pitch, rawRetargeted.headTarget.pitch, headSt.blend),
        };
      }
    } else {
      headSt.streak = 0;
      headSt.locked = false;
      headSt.lostMs += dtMs;
      if (headSt.everLocked && headSt.lostMs < holdGraceMs) {
        headSt.state = 'HOLD';
      } else {
        headSt.state = 'RELAX';
        headSt.blend = 0;
        for (const k of HEAD_JOINTS) {
          g.outputJoints[k] = lerp(g.outputJoints[k], SAFE_NEUTRAL_JOINTS[k], relaxAlpha);
        }
        g.headTarget = {
          yaw: lerp(g.headTarget.yaw, 0, relaxAlpha),
          pitch: lerp(g.headTarget.pitch, 0, relaxAlpha),
        };
      }
    }

    // 5. Advance independent per-arm + per-hand failsafe state machine (Luka left & right)
    const armMap = [
      { lukaSide: 'left', srcSide: this.mirrorSides ? 1 : 0, jointKeys: LUKA_LEFT_ARM_JOINTS },
      { lukaSide: 'right', srcSide: this.mirrorSides ? 0 : 1, jointKeys: LUKA_RIGHT_ARM_JOINTS },
    ];
    const wristTrimRad = clamp((this.calibration.wristRollTrimDeg ?? 0) * DEG_TO_RAD, -1.0, 1.0);

    for (const { lukaSide, srcSide, jointKeys } of armMap) {
      const armSt = g.arms[lukaSide];
      const rs = g.rawSrcArms[srcSide];
      const qa = quality.arms[srcSide];
      const isValidNow = srcArmValid[srcSide] && Boolean(rawRetargeted);

      if (isValidNow) {
        armSt.streak += 1;
        armSt.reason = 'ok';
        const needed = (isDemo && !armSt.everLocked) ? 1 : reacquireRequired;
        if (armSt.locked || armSt.streak >= needed) {
          if (!armSt.locked) {
            armSt.blend = (isDemo && !armSt.everLocked) ? 1 : 0;
          }
          armSt.locked = true;
          armSt.everLocked = true;
          armSt.state = 'LOCKED';
          armSt.lostMs = 0;
          rs.locked = true;
          rs.relEl = qa.relEl;
          rs.relWr = qa.relWr;
          rs.seenAtMs = nowMs;
          armSt.blend = Math.min(1, armSt.blend + safeDt / 0.38);

          // Blend shoulder + humeral roll + elbow smoothly (first 4 joints)
          for (let ji = 0; ji < 4; ji++) {
            const k = jointKeys[ji];
            g.outputJoints[k] = lerp(g.outputJoints[k], rawRetargeted.joints[k], armSt.blend);
          }

          // Handle forearm roll, wrist flexion/deviation & fingers with smooth hand-dropout protection
          const j5 = jointKeys[4];
          const j6 = jointKeys[5];
          const j7 = jointKeys[6];
          const hasHandNow = Boolean(rawRetargeted.hasHand?.[lukaSide]);
          if (hasHandNow) {
            armSt.handLostMs = 0;
            armSt.handState = 'LOCKED';
            g.outputJoints[j5] = lerp(g.outputJoints[j5], rawRetargeted.joints[j5], armSt.blend);
            g.outputJoints[j6] = lerp(g.outputJoints[j6], rawRetargeted.joints[j6], armSt.blend);
            g.outputJoints[j7] = lerp(g.outputJoints[j7], rawRetargeted.joints[j7], armSt.blend);
            for (const fk of FINGER_KEYS) {
              g.outputHands[lukaSide][fk] = lerp(g.outputHands[lukaSide][fk], rawRetargeted.hands[lukaSide][fk], armSt.blend);
            }
          } else {
            armSt.handLostMs += dtMs;
            if (armSt.handLostMs < handHoldGraceMs) {
              armSt.handState = 'HOLD';
              // Freeze wrist & fingers cleanly during brief hand occlusion — ZERO snap!
            } else {
              armSt.handState = 'RELAX';
              // Gently ease wrist & fingers back to neutral instead of snapping
              g.outputJoints[j5] = lerp(g.outputJoints[j5], SAFE_NEUTRAL_JOINTS[j5] + wristTrimRad, handRelaxAlpha);
              g.outputJoints[j6] = lerp(g.outputJoints[j6], 0, handRelaxAlpha);
              g.outputJoints[j7] = lerp(g.outputJoints[j7], 0, handRelaxAlpha);
              for (const fk of FINGER_KEYS) {
                g.outputHands[lukaSide][fk] = lerp(g.outputHands[lukaSide][fk], SAFE_NEUTRAL_HAND[fk], handRelaxAlpha);
              }
            }
          }
        }
      } else {
        armSt.streak = 0;
        armSt.locked = false;
        rs.locked = false;
        armSt.reason = quality.torsoValid ? qa.reason : 'no_pose';
        armSt.lostMs += dtMs;
        armSt.handLostMs += dtMs;
        if (armSt.everLocked && armSt.lostMs < holdGraceMs) {
          armSt.state = 'HOLD';
          armSt.handState = 'HOLD';
          // Freeze all 7 arm joints & 6 fingers right where they were — ZERO spaz!
        } else {
          armSt.state = 'RELAX';
          armSt.handState = 'RELAX';
          armSt.blend = 0;
          for (const k of jointKeys) {
            g.outputJoints[k] = lerp(g.outputJoints[k], SAFE_NEUTRAL_JOINTS[k], relaxAlpha);
          }
          for (const fk of FINGER_KEYS) {
            g.outputHands[lukaSide][fk] = lerp(g.outputHands[lukaSide][fk], SAFE_NEUTRAL_HAND[fk], handRelaxAlpha);
          }
        }
      }
    }

    // 6. Compose safeguarded tracked output & run final anti-jitter OneEuro + slew cap + rhombic wrist guard
    const anyArmLocked = g.arms.left.state === 'LOCKED' || g.arms.right.state === 'LOCKED';
    const detectedGesture = anyArmLocked && rawRetargeted
      ? rawRetargeted.detectedGesture
      : (g.arms.left.state === 'HOLD' || g.arms.right.state === 'HOLD' ? 'Holding Safe Pose' : 'Neutral (Arms Relaxed)');

    const safePacket = {
      joints: { ...g.outputJoints },
      hands: {
        left: { ...g.outputHands.left },
        right: { ...g.outputHands.right },
      },
      headTarget: { ...g.headTarget },
      detectedGesture,
      handCount: matchedHands.length,
      visibility: rawRetargeted?.visibility ?? 0,
      trackingState: {
        pose: quality.torsoValid ? 'LOCKED' : (g.head.state === 'HOLD' ? 'HOLD' : 'RELAX'),
        head: g.head.state,
        leftArm: g.arms.left.state,
        rightArm: g.arms.right.state,
        leftHand: g.arms.left.handState,
        rightHand: g.arms.right.handState,
        leftReason: g.arms.left.reason,
        rightReason: g.arms.right.reason,
      },
    };

    const filtered = this._filterRetargeted(safePacket, safeDt);
    this.lastTracked = filtered;
    this.lastFrame = poseFrame ? { pose: poseFrame, hands: matchedHands } : null;
    return filtered;
  }

  /** Step tracker once per animation frame; returns retargeted Luka pose + draws Kameyoko skeleton overlay. */
  update(nowMs, dtSec) {
    if (!this.running) return null;
    const safeDt = clamp(Number.isFinite(dtSec) ? dtSec : 1 / 60, 1 / 240, 0.2);

    if (this.sourceMode === 'demo') {
      this.demoTime += safeDt;
      const sample = sampleDemoTrackedFrame(this.demoTime);
      const tracked = this.processRawFrame(sample.pose, sample.hands, nowMs, safeDt, 16 / 9);
      if (this.lastFrame) this._drawOverlay(this.lastFrame.pose, this.lastFrame.hands, tracked);
      return tracked;
    }

    if (this.sourceMode === 'camera' && this.video && this.video.readyState >= 2 && this.poseLandmarker) {
      if (this.video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = this.video.currentTime;
        const ts = Math.max(Math.round(nowMs), this.lastTs + 1);
        const camDt = this.guard.lastFrameMs > 0
          ? clamp((nowMs - this.guard.lastFrameMs) / 1000, 1 / 120, 0.25)
          : safeDt;
        this.guard.lastFrameMs = nowMs;
        this.lastTs = ts;

        const pr = this.poseLandmarker.detectForVideo(this.video, ts);
        let rawPose = null;
        const rawHands = [];
        if (pr.landmarks?.length && pr.worldLandmarks?.[0]?.length) {
          const mirrorImg = (l) => ({ x: 1 - l.x, y: l.y, z: l.z });
          const mirrorWld = (l) => ({ x: -l.x, y: l.y, z: l.z });
          rawPose = {
            image: pr.landmarks[0].map(mirrorImg),
            world: pr.worldLandmarks[0].map(mirrorWld),
            // Combine MediaPipe visibility & presence so occluded or off-screen joints are caught immediately
            vis: pr.landmarks[0].map((l) => Math.min(l.visibility ?? 1, l.presence ?? 1)),
          };
          if (this.handLandmarker) {
            const hr = this.handLandmarker.detectForVideo(this.video, ts);
            const scores = hr.handednesses || hr.handedness || [];
            (hr.landmarks || []).forEach((lm, idx) => {
              const score = scores[idx]?.[0]?.score;
              rawHands.push({
                image: lm.map(mirrorImg),
                world: (hr.worldLandmarks?.[idx] || []).map(mirrorWld),
                score: typeof score === 'number' ? score : 1,
              });
            });
          }
        }
        const aspect = (this.video.videoWidth || 16) / Math.max(this.video.videoHeight || 9, 1);
        const tracked = this.processRawFrame(rawPose, rawHands, nowMs, camDt, aspect);
        if (this.lastFrame) {
          this._drawOverlay(this.lastFrame.pose, this.lastFrame.hands, tracked);
        } else if (this.ctx && this.canvas) {
          this._drawOverlay(null, [], tracked);
        }
        return tracked;
      }

      // Between 30 fps webcam frames, keep relaxation/hold smooth at 60 fps if pose was lost
      if (this.lastFrame) {
        this._drawOverlay(this.lastFrame.pose, this.lastFrame.hands, this.lastTracked);
      } else if (this.guard.lastFrameMs > 0 && nowMs - this.guard.lastFrameMs > 120) {
        const tracked = this.processRawFrame(null, [], nowMs, safeDt, 16 / 9);
        this._drawOverlay(null, [], tracked);
        return tracked;
      }
    }

    return this.lastTracked;
  }

  _drawOverlay(poseFrame, hands, tracked) {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 180;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (this.sourceMode === 'demo') {
      ctx.fillStyle = '#070b12';
      ctx.fillRect(0, 0, w, h);
      // Subtle grid
      ctx.strokeStyle = 'rgba(56, 217, 245, 0.08)';
      ctx.lineWidth = 1;
      for (let gx = 0; gx < w; gx += 28) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
      for (let gy = 0; gy < h; gy += 28) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
    }

    const ts = tracked?.trackingState;
    if (poseFrame?.image?.length) {
      const pts = poseFrame.image.map((p) => ({ x: p.x * w, y: p.y * h }));
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#38d9f5';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      for (const [a, b] of UPPER_POSE_CONNECTIONS) {
        if ((poseFrame.vis[a] ?? 1) < 0.45 || (poseFrame.vis[b] ?? 1) < 0.45) continue;
        if (!inFrame(poseFrame.image[a], 0.02) || !inFrame(poseFrame.image[b], 0.02)) continue;
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();

      // Key upper-body joints
      for (const idx of [0, 7, 8, 11, 12, 13, 14, 15, 16]) {
        if ((poseFrame.vis[idx] ?? 1) < 0.45 || !inFrame(poseFrame.image[idx], 0.02)) continue;
        ctx.fillStyle = idx === 0 ? '#fbbf24' : '#e2f1ff';
        ctx.beginPath();
        ctx.arc(pts[idx].x, pts[idx].y, idx === 0 ? 4.2 : 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 21-point Kameyoko hand skeletons
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 1.4;
    for (const hand of hands) {
      const hp = hand.image.map((p) => ({ x: p.x * w, y: p.y * h }));
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(hp[a].x, hp[a].y);
        ctx.lineTo(hp[b].x, hp[b].y);
      }
      ctx.stroke();
      ctx.fillStyle = '#a7f3d0';
      for (const tip of [4, 8, 12, 16, 20]) {
        ctx.beginPath();
        ctx.arc(hp[tip].x, hp[tip].y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (ts && (ts.leftArm !== 'LOCKED' || ts.rightArm !== 'LOCKED')) {
      const guardText = `GUARD · L:${ts.leftArm} · R:${ts.rightArm}`;
      ctx.fillStyle = 'rgba(15, 18, 28, 0.80)';
      ctx.fillRect(8, 8, Math.min(w - 16, 198), 18);
      ctx.fillStyle = ts.leftArm === 'HOLD' || ts.rightArm === 'HOLD' ? '#fbbf24' : '#94a3b8';
      ctx.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(guardText, 14, 20);
    }

    if (tracked?.detectedGesture) {
      ctx.fillStyle = 'rgba(8, 12, 18, 0.72)';
      ctx.fillRect(8, h - 26, Math.min(w - 16, 190), 18);
      ctx.fillStyle = '#34d399';
      ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`POSE: ${tracked.detectedGesture.toUpperCase()}`, 14, h - 13);
    }
  }
}
