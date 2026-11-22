// Kameyoko-inspired Head, Arm & 10-Finger Hand Tracking Engine for Luka Upper-Body Sim.
//
// Modeled on Kameyoko's real-time pose/hand tracking pipeline:
//   - MediaPipe PoseLandmarker (33 metric 3D world + 2D image landmarks)
//   - MediaPipe HandLandmarker (2x 21 3D hand landmarks, matched to nearest wrist)
//   - One Euro Filter smoothing (rock-solid stillness, zero-lag responsiveness)
//   - 3D torso-frame retargeting onto Luka's symmetric 16 upper-body DOF + 10 fingers
//   - Live skeleton & hand canvas overlay + gesture classifier + synthetic demo mode

import { clamp, lerp } from './mathx.js';

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

  filter(points, dt) {
    const { minCutoff, beta, dCutoff } = this.params;
    return points.map((p, i) => {
      const f = (this.filters[i] ??= [
        new OneEuro(minCutoff, beta, dCutoff),
        new OneEuro(minCutoff, beta, dCutoff),
        new OneEuro(minCutoff, beta, dCutoff),
      ]);
      return {
        x: f[0].filter(p.x, dt),
        y: f[1].filter(p.y, dt),
        z: f[2].filter(p.z, dt),
      };
    });
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

/**
 * Retarget MediaPipe 3D world pose + 2D image landmarks + optional 21-pt hand landmarks
 * onto Luka's calibrated orthogonal 16 upper-body DOF and 12 finger channels.
 *
 * `mirrorSides = true`: like looking in a mirror at Luka facing you (your right arm
 * drives the arm on the right side of the viewport — Luka's left arm).
 */
export function retargetPoseToLuka(poseFrame, hands = [], { mirrorSides = true, calibration = null } = {}) {
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
  const upAxis = norm(sub(shoulderMid, hipMid));
  // Ensure torso upAxis is sane even if hips are partially off-screen
  const torsoUp = len(upAxis) > 0.5 ? upAxis : { x: 0, y: -1, z: 0 };

  let sideRaw = sub(rs, ls);
  sideRaw = sub(sideRaw, scale(torsoUp, dot(sideRaw, torsoUp)));
  const rightAxis = len(sideRaw) > 1e-4 ? norm(sideRaw) : { x: 1, y: 0, z: 0 };
  // Forward out of the person's chest toward the camera (-Z in MediaPipe world)
  const fwdAxis = norm(cross(rightAxis, torsoUp));

  function solveArmJoints(shoulder, elbow, wrist, outAxis, isLukaLeft, isSrcRight, handFrame, baseline) {
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

    // Exact closed-form orthogonal shoulder angles for pure coronal j13/j20 * sagittal j14/j21:
    //   uFwd = -sin(beta), uUp = -cos(beta)*cos(alpha), uOut = cos(beta)*sin(alpha)
    const beta = clamp(-Math.asin(clamp(uVec.x, -0.995, 0.995)) - heightTrimRad, -1.92, 0.62);
    const rawAlpha = Math.atan2(uVec.z, -uVec.y);
    // Smooth anti-gimbal blend when arm points straight forward (|uFwd| -> 1)
    const horizMag = Math.hypot(uVec.y, uVec.z);
    const horizWeight = ramp(horizMag, 0.12, 0.36);
    const alpha = rawAlpha * horizWeight + REST_ABDUCT_RAD * (1 - horizWeight);
    const abduct = clamp(alpha - REST_ABDUCT_RAD, -0.35, 1.92);

    // Elbow flexion (0 straight -> 2.02 rad bent)
    const bend = clamp(Math.acos(clamp(dot(uVec, fVec), -1, 1)), 0, 2.02);

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
    let armRoll = 0;
    if (fpLen > 0.12 && bend > 0.18) {
      const fPerp = scale(fPerpRaw, 1 / fpLen);
      const rollWeight = ramp(bend, 0.18, 0.58);
      const rawRoll = Math.atan2(-dot(fPerp, eOut), dot(fPerp, eFwd));
      armRoll = clamp(rawRoll * rollWeight, -1.65, 1.65);
    }

    // Calibrated forearm roll (j17/j24), wrist flexion (j18/j25), wrist deviation (j19/j26), and 6-channel finger curls
    let forearmRoll = -0.18 + wristRollTrimRad;
    let wristFlex = 0;
    let wristDev = 0;
    let fingerCurls = { thumbOpp: 0.22, thumb: 0.20, index: 0.22, middle: 0.24, ring: 0.26, pinky: 0.28 };

    if (handFrame?.world?.length >= 21) {
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
      if (len(hrProj) > 0.15 && len(refRadial) > 0.5 && len(refInward) > 0.5) {
        const hrUnit = norm(hrProj);
        const rawForearmRoll = Math.atan2(dot(hrUnit, refInward), dot(hrUnit, refRadial));
        forearmRoll = clamp(rawForearmRoll + wristRollTrimRad, -2.25, 2.25);

        // Rotate neutral wrist frame by forearmRoll to measure pure wrist flexion & radial/ulnar deviation
        const cR = Math.cos(rawForearmRoll);
        const sR = Math.sin(rawForearmRoll);
        const curRadial = add(scale(refRadial, cR), scale(refInward, sR));
        const curPalm = sub(scale(refInward, cR), scale(refRadial, sR));

        const flexRad = Math.asin(clamp(dot(handDir, curPalm), -0.85, 0.85));
        const devRad = Math.asin(clamp(dot(handDir, curRadial), -0.75, 0.75));
        // Verified FK signs: left hand flexes inward with -j18 & tilts toward thumb with -j19; right is +j25 / +j26
        wristFlex = clamp((isLukaLeft ? -1 : 1) * flexRad * 0.85, -0.68, 0.68);
        wristDev = clamp((isLukaLeft ? -1 : 1) * devRad * 0.75, -0.46, 0.46);
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

  // Lateral yaw: +rightAxis / +im.x is screen RIGHT -> +idx27_head_joint1 turns Luka toward screen RIGHT
  const yaw3d = dot(noseRel, rightAxis) / earSpan;
  const yaw2d = (imNose.x - imEarMid.x) / imEarSpan;
  const yawFused = yaw3d * 0.55 + yaw2d * 0.45;
  const headYaw = clamp((mirrorSides ? 1 : -1) * yawFused * 2.25, -1.24, 1.24);

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
  const headPitch = clamp(pitchFused * 1.95, -0.56, 0.60);

  // Gaze target from screen-space nose position (0..1) so Luka keeps direct eye contact
  // imNose.x > 0.5 (screen right) => +gazeYaw (Luka turns toward screen right)
  const gazeYaw = clamp((imNose.x - 0.5) * 1.95, -1.18, 1.18);
  const gazePitch = clamp((0.42 - imNose.y) * 1.35, -0.54, 0.58);

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
    this.lastValidHand = [null, null]; // { hand, seenAtMs } for 450 ms dropout grace hold
    this.rawHandsLatest = [null, null]; // unfiltered latest world hands for one-click open-hand calibration

    this.calibration = { ...DEFAULT_HAND_CALIBRATION };
    this.lastTracked = null;
    this.lastFrame = null;
    this.setSmoothing(this.calibration.smoothing);
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
  }

  async _ensureModels() {
    if (this.poseLandmarker) return;
    this.onStatus('Loading Kameyoko MediaPipe runtime…');
    let visionMod;
    let wasmBase = '/mediapipe/wasm';
    try {
      visionMod = await import('/mediapipe/vision_bundle.mjs');
    } catch {
      wasmBase = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${REMOTE_CDN_VERSION}/wasm`;
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
      const isWrist = k.endsWith('joint5') || k.endsWith('joint6') || k.endsWith('joint7');
      const db = isWrist ? jointDeadband * 1.45 : jointDeadband;
      const target = (prev !== null && Math.abs(v - prev) < db) ? prev : v;
      joints[k] = f.filter(target, dtSec);
    }

    const hands = { left: {}, right: {} };
    for (const side of ['left', 'right']) {
      for (const [k, v] of Object.entries(raw.hands[side] || {})) {
        let f = this.curlFilters[side].get(k);
        if (!f) {
          f = new OneEuro(curlCutoff, curlBeta, 1.0);
          this.curlFilters[side].set(k, f);
        }
        const prev = f.x;
        const target = (prev !== null && Math.abs(v - prev) < curlDeadband) ? prev : v;
        hands[side][k] = Number(clamp(f.filter(target, dtSec), 0, 1).toFixed(3));
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

  _assignHandsToWrists(poseImage, rawHands, aspect, nowMs, dtSec) {
    const lw = poseImage[P.L_WRIST];
    const rw = poseImage[P.R_WRIST];
    const ls = poseImage[P.L_SHOULDER];
    const lh = poseImage[P.L_HIP];
    const scaleNorm = Math.max(Math.hypot((ls.x - lh.x) * aspect, ls.y - lh.y), 0.08);
    const matched = [null, null];

    if (rawHands.length) {
      const pairs = [];
      rawHands.forEach((h, hi) => {
        const hw = h.image[0];
        let d0 = Math.hypot((hw.x - lw.x) * aspect, hw.y - lw.y) / scaleNorm;
        let d1 = Math.hypot((hw.x - rw.x) * aspect, hw.y - rw.y) / scaleNorm;
        // Soft hysteresis bias using previous frame hand position + handedness to prevent L/R cross-swaps
        if (this.lastValidHand[0] && nowMs - this.lastValidHand[0].seenAtMs < 350) {
          const prev0 = this.lastValidHand[0].hand.image[0];
          d0 = d0 * 0.72 + (Math.hypot((hw.x - prev0.x) * aspect, hw.y - prev0.y) / scaleNorm) * 0.28;
        }
        if (this.lastValidHand[1] && nowMs - this.lastValidHand[1].seenAtMs < 350) {
          const prev1 = this.lastValidHand[1].hand.image[0];
          d1 = d1 * 0.72 + (Math.hypot((hw.x - prev1.x) * aspect, hw.y - prev1.y) / scaleNorm) * 0.28;
        }
        pairs.push({ hi, side: 0, d: d0 });
        pairs.push({ hi, side: 1, d: d1 });
      });
      pairs.sort((a, b) => a.d - b.d);
      const usedHands = new Set();
      for (const p of pairs) {
        if (p.d > 0.72 || usedHands.has(p.hi) || matched[p.side]) continue;
        usedHands.add(p.hi);
        const src = rawHands[p.hi];
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

    // 450 ms dropout grace hold so brief occlusion never snaps fingers/wrists back to neutral
    const out = [];
    for (let side = 0; side < 2; side++) {
      if (matched[side]) {
        out.push(matched[side]);
      } else if (this.lastValidHand[side] && nowMs - this.lastValidHand[side].seenAtMs < 450) {
        out.push(this.lastValidHand[side].hand);
      } else if (this.lastValidHand[side] && nowMs - this.lastValidHand[side].seenAtMs >= 900) {
        this.handImageFilters[side].reset();
        this.handWorldFilters[side].reset();
        this.lastValidHand[side] = null;
      }
    }
    return out;
  }

  /** Step tracker once per animation frame; returns retargeted Luka pose + draws Kameyoko skeleton overlay. */
  update(nowMs, dtSec) {
    if (!this.running) return null;

    let poseFrame = null;
    let hands = [];

    if (this.sourceMode === 'demo') {
      this.demoTime += dtSec;
      const sample = sampleDemoTrackedFrame(this.demoTime);
      poseFrame = {
        image: this.imageFilter.filter(sample.pose.image, dtSec),
        world: this.worldFilter.filter(sample.pose.world, dtSec),
        vis: sample.pose.vis,
      };
      hands = sample.hands.map((h) => {
        this.rawHandsLatest[h.side] = h;
        return {
          side: h.side,
          image: this.handImageFilters[h.side].filter(h.image, dtSec),
          world: this.handWorldFilters[h.side].filter(h.world, dtSec),
        };
      });
    } else if (this.sourceMode === 'camera' && this.video && this.video.readyState >= 2 && this.poseLandmarker) {
      if (this.video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = this.video.currentTime;
        const ts = Math.max(Math.round(nowMs), this.lastTs + 1);
        this.lastTs = ts;
        const pr = this.poseLandmarker.detectForVideo(this.video, ts);
        if (pr.landmarks?.length && pr.worldLandmarks?.[0]?.length) {
          const mirrorImg = (l) => ({ x: 1 - l.x, y: l.y, z: l.z });
          const mirrorWld = (l) => ({ x: -l.x, y: l.y, z: l.z });
          const rawImg = pr.landmarks[0].map(mirrorImg);
          const rawWld = pr.worldLandmarks[0].map(mirrorWld);
          const vis = pr.landmarks[0].map((l) => l.visibility ?? 1);
          poseFrame = {
            image: this.imageFilter.filter(rawImg, dtSec),
            world: this.worldFilter.filter(rawWld, dtSec),
            vis,
          };

          const rawHands = [];
          if (this.handLandmarker) {
            const hr = this.handLandmarker.detectForVideo(this.video, ts);
            (hr.landmarks || []).forEach((lm, idx) => {
              rawHands.push({
                image: lm.map(mirrorImg),
                world: (hr.worldLandmarks?.[idx] || []).map(mirrorWld),
              });
            });
          }
          const aspect = (this.video.videoWidth || 16) / Math.max(this.video.videoHeight || 9, 1);
          hands = this._assignHandsToWrists(poseFrame.image, rawHands, aspect, nowMs, dtSec);
          this.lastFrame = { pose: poseFrame, hands };
        }
      } else if (this.lastFrame) {
        poseFrame = this.lastFrame.pose;
        hands = this.lastFrame.hands;
      }
    }

    if (poseFrame) {
      const rawRetargeted = retargetPoseToLuka(poseFrame, hands, {
        mirrorSides: this.mirrorSides,
        calibration: this.calibration,
      });
      this.lastTracked = this._filterRetargeted(rawRetargeted, dtSec);
      this._drawOverlay(poseFrame, hands, this.lastTracked);
    } else if (this.ctx && this.canvas) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
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

    const pts = poseFrame.image.map((p) => ({ x: p.x * w, y: p.y * h }));
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#38d9f5';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    for (const [a, b] of UPPER_POSE_CONNECTIONS) {
      if ((poseFrame.vis[a] ?? 1) < 0.35 || (poseFrame.vis[b] ?? 1) < 0.35) continue;
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();

    // Key upper-body joints
    for (const idx of [0, 7, 8, 11, 12, 13, 14, 15, 16]) {
      if ((poseFrame.vis[idx] ?? 1) < 0.35) continue;
      ctx.fillStyle = idx === 0 ? '#fbbf24' : '#e2f1ff';
      ctx.beginPath();
      ctx.arc(pts[idx].x, pts[idx].y, idx === 0 ? 4.2 : 3.2, 0, Math.PI * 2);
      ctx.fill();
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

    if (tracked?.detectedGesture) {
      ctx.fillStyle = 'rgba(8, 12, 18, 0.72)';
      ctx.fillRect(8, h - 26, Math.min(w - 16, 175), 18);
      ctx.fillStyle = '#34d399';
      ctx.font = '600 10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`POSE: ${tracked.detectedGesture.toUpperCase()}`, 14, h - 13);
    }
  }
}
