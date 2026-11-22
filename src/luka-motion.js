// Natural Upper-Body Kinematics & Conversational Motion Choreography for Luka (AgiBot A2 Ultra).
//
// Combines:
//   - Verified symmetric upper-body shoulder/elbow/wrist/neck axes (16 primary upper DOF + 24 hand joints)
//   - Organic breathing, blinking, and natural relaxed posture
//   - Conversational state choreography (idle, listening, thinking, audio-reactive speaking)
//   - Multi-phase semantic gestures (wave, explain, nod, think, inspect, point, welcome, guard, celebrate)
//   - Live Kameyoko tracking blend (gaze-lock or full upper-body + 10-finger mirror)
//   - Taught / Emergent pose playback and manual slider overrides

import { clamp, damp, lerp } from './mathx.js';

export const UPPER_BODY_JOINTS = [
  'idx27_head_joint1',
  'idx28_head_joint2',
  'idx13_left_arm_joint1',
  'idx14_left_arm_joint2',
  'idx15_left_arm_joint3',
  'idx16_left_arm_joint4',
  'idx17_left_arm_joint5',
  'idx18_left_arm_joint6',
  'idx19_left_arm_joint7',
  'idx20_right_arm_joint1',
  'idx21_right_arm_joint2',
  'idx22_right_arm_joint3',
  'idx23_right_arm_joint4',
  'idx24_right_arm_joint5',
  'idx25_right_arm_joint6',
  'idx26_right_arm_joint7',
];

export const JOINT_LABELS = {
  idx27_head_joint1: 'Head Yaw',
  idx28_head_joint2: 'Head Pitch',
  idx13_left_arm_joint1: 'L Shoulder Abduct',
  idx14_left_arm_joint2: 'L Shoulder Pitch',
  idx15_left_arm_joint3: 'L Upper Arm Roll',
  idx16_left_arm_joint4: 'L Elbow Flex',
  idx17_left_arm_joint5: 'L Forearm Roll',
  idx18_left_arm_joint6: 'L Wrist Pitch',
  idx19_left_arm_joint7: 'L Wrist Yaw',
  idx20_right_arm_joint1: 'R Shoulder Abduct',
  idx21_right_arm_joint2: 'R Shoulder Pitch',
  idx22_right_arm_joint3: 'R Upper Arm Roll',
  idx23_right_arm_joint4: 'R Elbow Flex',
  idx24_right_arm_joint5: 'R Forearm Roll',
  idx25_right_arm_joint6: 'R Wrist Pitch',
  idx26_right_arm_joint7: 'R Wrist Yaw',
};

/**
 * Configure symmetric 3-DOF shoulders and comfortable simulation limits on a
 * TwinModel instance without mutating the generated model files on disk.
 */
export function applySymmetricUpperBodyAxes(model) {
  const byName = new Map(model.joints.map((j) => [j.name, j]));
  const j13 = byName.get('idx13_left_arm_joint1');
  const j14 = byName.get('idx14_left_arm_joint2');
  const j20 = byName.get('idx20_right_arm_joint1');
  const j21 = byName.get('idx21_right_arm_joint2');
  const j27 = byName.get('idx27_head_joint1');
  const j28 = byName.get('idx28_head_joint2');

  if (j13) {
    // Pure coronal lateral abduction (world +X axis in left_arm_link01 frame -> zero forward drift)
    j13.axis = [0, 0, -1];
    j13.lower = -0.35;
    j13.upper = 1.95;
  }
  if (j14) {
    j14.axis = [-1, 0, 0];
    j14.lower = -1.95;
    j14.upper = 0.65;
  }
  if (j20) {
    // Pure coronal lateral abduction mirrored for right arm
    j20.axis = [0, 0, 1];
    j20.lower = -0.35;
    j20.upper = 1.95;
  }
  if (j21) {
    j21.axis = [1, 0, 0];
    j21.lower = -1.95;
    j21.upper = 0.65;
  }
  if (j27) {
    j27.lower = -1.32;
    j27.upper = 1.32;
  }
  if (j28) {
    j28.lower = -0.58;
    j28.upper = 0.62;
  }
}

export const FINGER_KEYS = ['thumbOpp', 'thumb', 'index', 'middle', 'ring', 'pinky'];

export const HAND_PRESETS = {
  open: { thumbOpp: 0.08, thumb: 0.04, index: 0.02, middle: 0.02, ring: 0.03, pinky: 0.04 },
  relaxed: { thumbOpp: 0.25, thumb: 0.20, index: 0.22, middle: 0.26, ring: 0.30, pinky: 0.34 },
  peace: { thumbOpp: 0.78, thumb: 0.62, index: 0.02, middle: 0.02, ring: 0.94, pinky: 0.96 },
  point: { thumbOpp: 0.72, thumb: 0.58, index: 0.02, middle: 0.92, ring: 0.95, pinky: 0.96 },
  pinch: { thumbOpp: 0.86, thumb: 0.54, index: 0.68, middle: 0.14, ring: 0.18, pinky: 0.22 },
  thumbs_up: { thumbOpp: 0.10, thumb: 0.04, index: 0.95, middle: 0.96, ring: 0.97, pinky: 0.98 },
  fist: { thumbOpp: 0.88, thumb: 0.84, index: 0.96, middle: 0.98, ring: 0.98, pinky: 0.98 },
};

/**
 * Write normalized 0..1 finger curls (0 = open palm, 1 = closed fist) into
 * the Inspire RH56 articulated hand joints + clamped URDF mimic couplings.
 */
export function applyHandCurlsToPose(model, pose, hands) {
  const map = model?.hand;
  if (!map || !hands) return;
  const channelFor = {
    thumb_pos_0: (h) => clamp(h.thumbOpp ?? ((h.thumb ?? 0.25) * 0.82), 0, 1),
    thumb_pos_1: (h) => clamp(h.thumb ?? 0.25, 0, 1),
    index_pos: (h) => clamp(h.index ?? 0.25, 0, 1),
    middle_pos: (h) => clamp(h.middle ?? 0.28, 0, 1),
    ring_pos: (h) => clamp(h.ring ?? 0.30, 0, 1),
    pinky_pos: (h) => clamp(h.pinky ?? 0.32, 0, 1),
  };

  for (const [channel, sides] of Object.entries(map.channels)) {
    const fn = channelFor[channel];
    if (!fn) continue;
    for (const side of ['left', 'right']) {
      const def = sides[side];
      const h = hands[side];
      if (!def || !h) continue;
      const t = fn(h);
      pose[def.joint] = def.min + t * (def.max - def.min);
    }
  }
  for (const [name, m] of Object.entries(map.mimic || {})) {
    const base = pose[m.joint];
    if (typeof base !== 'number') continue;
    const lim = typeof model.limits === 'function' ? model.limits(name) : null;
    const lo = lim?.lower ?? 0;
    const hi = lim?.upper ?? 1.65;
    pose[name] = clamp(m.multiplier * base + m.offset, lo, hi);
  }
}

function defaultHands(curl = 0.24) {
  const mk = () => ({
    thumbOpp: clamp(curl * 0.85, 0, 1),
    thumb: clamp(curl * 0.8, 0, 1),
    index: clamp(curl, 0, 1),
    middle: clamp(curl * 1.05, 0, 1),
    ring: clamp(curl * 1.12, 0, 1),
    pinky: clamp(curl * 1.18, 0, 1),
  });
  return { left: mk(), right: mk() };
}

/** Smooth rise-hold-settle envelope in [0, 1]. */
function gestureEnvelope(elapsed, duration, attack = 0.45, release = 0.65) {
  if (elapsed <= 0 || elapsed >= duration) return 0;
  if (elapsed < attack) {
    const u = elapsed / attack;
    return u * u * (3 - 2 * u);
  }
  if (elapsed > duration - release) {
    const u = (duration - elapsed) / release;
    return u * u * (3 - 2 * u);
  }
  return 1;
}

const GESTURE_DEFS = {
  wave: {
    duration: 3.4,
    sample(t) {
      const waveOsc = Math.sin(t * 7.2);
      return {
        joints: {
          idx27_head_joint1: -0.10 + 0.04 * Math.sin(t * 2.5),
          idx28_head_joint2: 0.06,
          idx20_right_arm_joint1: 0.94 + 0.05 * waveOsc,
          idx21_right_arm_joint2: -0.34,
          idx22_right_arm_joint3: -0.82 + 0.22 * waveOsc,
          idx23_right_arm_joint4: 1.50 + 0.12 * waveOsc,
          idx24_right_arm_joint5: 0.82 + 0.16 * waveOsc,
          idx25_right_arm_joint6: 0.10 * waveOsc,
          idx13_left_arm_joint1: 0.02,
          idx14_left_arm_joint2: -0.14,
          idx16_left_arm_joint4: -0.38,
        },
        hands: {
          left: { thumbOpp: 0.24, thumb: 0.22, index: 0.24, middle: 0.28, ring: 0.30, pinky: 0.34 },
          right: { thumbOpp: 0.08, thumb: 0.04, index: 0.02, middle: 0.02, ring: 0.03, pinky: 0.04 },
        },
      };
    },
  },

  explain: {
    duration: 3.8,
    sample(t) {
      const s1 = Math.sin(t * 3.1);
      const s2 = Math.cos(t * 2.3);
      return {
        joints: {
          idx27_head_joint1: 0.28 * Math.sin(t * 1.5),
          idx28_head_joint2: 0.04 + 0.14 * Math.sin(t * 3.2),
          idx13_left_arm_joint1: 0.16 + 0.08 * s1,
          idx14_left_arm_joint2: -0.44 - 0.10 * s2,
          idx15_left_arm_joint3: 0.24 - 0.12 * s1,
          idx16_left_arm_joint4: -1.18 - 0.15 * s1,
          idx17_left_arm_joint5: -0.78,
          idx20_right_arm_joint1: 0.18 - 0.08 * s1,
          idx21_right_arm_joint2: -0.48 + 0.10 * s2,
          idx22_right_arm_joint3: 0.26 + 0.12 * s1,
          idx23_right_arm_joint4: 1.22 - 0.15 * s2,
          idx24_right_arm_joint5: -0.78,
        },
        hands: {
          left: { thumbOpp: 0.12, thumb: 0.08, index: 0.10, middle: 0.12, ring: 0.16, pinky: 0.20 },
          right: { thumbOpp: 0.12, thumb: 0.08, index: 0.10, middle: 0.12, ring: 0.16, pinky: 0.20 },
        },
      };
    },
  },

  nod: {
    duration: 2.3,
    sample(t) {
      // Crisp 2-beat affirmative up/down nod (-22° to +15°)
      const nodWave = Math.sin(t * 6.2 - 0.4);
      return {
        joints: {
          idx27_head_joint1: 0.05 * Math.sin(t * 1.8),
          idx28_head_joint2: -0.08 + 0.30 * nodWave,
          idx13_left_arm_joint1: 0.12,
          idx14_left_arm_joint2: -0.25,
          idx16_left_arm_joint4: -0.78,
          idx20_right_arm_joint1: 0.12,
          idx21_right_arm_joint2: -0.25,
          idx23_right_arm_joint4: 0.78,
        },
        hands: defaultHands(0.18),
      };
    },
  },

  shake_no: {
    duration: 2.4,
    sample(t) {
      // Natural lateral head shake left/right (±32°)
      const shake = Math.sin(t * 7.4);
      return {
        joints: {
          idx27_head_joint1: 0.56 * shake,
          idx28_head_joint2: -0.05 + 0.04 * Math.cos(t * 3.7),
          idx13_left_arm_joint1: 0.14,
          idx14_left_arm_joint2: -0.22,
          idx16_left_arm_joint4: -0.68,
          idx20_right_arm_joint1: 0.14,
          idx21_right_arm_joint2: -0.22,
          idx23_right_arm_joint4: 0.68,
        },
        hands: defaultHands(0.22),
      };
    },
  },

  look_around: {
    duration: 4.4,
    sample(t) {
      // Expressive full-range lateral & vertical scan: left+up -> right+down -> up-center -> center
      const u = clamp(t / 4.4, 0, 1);
      let yaw = 0;
      let pitch = 0;
      if (u < 0.28) {
        const k = u / 0.28;
        yaw = lerp(0, 0.88, k);
        pitch = lerp(0, 0.28, k);
      } else if (u < 0.64) {
        const k = (u - 0.28) / 0.36;
        yaw = lerp(0.88, -0.88, k);
        pitch = lerp(0.28, -0.24, Math.sin(k * Math.PI));
      } else if (u < 0.84) {
        const k = (u - 0.64) / 0.20;
        yaw = lerp(-0.88, 0.12, k);
        pitch = lerp(-0.14, 0.32, Math.sin(k * Math.PI));
      } else {
        const k = (u - 0.84) / 0.16;
        yaw = lerp(0.12, 0, k);
        pitch = lerp(0.06, 0, k);
      }
      return {
        joints: {
          idx27_head_joint1: yaw,
          idx28_head_joint2: pitch,
          idx13_left_arm_joint1: 0.10,
          idx14_left_arm_joint2: -0.14,
          idx16_left_arm_joint4: -0.42,
          idx20_right_arm_joint1: 0.10,
          idx21_right_arm_joint2: -0.14,
          idx23_right_arm_joint4: 0.42,
        },
        hands: defaultHands(0.20),
      };
    },
  },

  think: {
    duration: 3.6,
    sample(t) {
      return {
        joints: {
          idx27_head_joint1: 0.38 + 0.08 * Math.sin(t * 1.4),
          idx28_head_joint2: 0.26 + 0.05 * Math.cos(t * 1.8),
          idx20_right_arm_joint1: 0.18,
          idx21_right_arm_joint2: -0.74,
          idx22_right_arm_joint3: 0.62,
          idx23_right_arm_joint4: 1.88,
          idx24_right_arm_joint5: 0.55,
          idx13_left_arm_joint1: 0.10,
          idx14_left_arm_joint2: -0.28,
          idx15_left_arm_joint3: 0.45,
          idx16_left_arm_joint4: -1.15,
        },
        hands: {
          left: { thumb: 0.35, index: 0.35, middle: 0.40, ring: 0.45, pinky: 0.48 },
          right: { thumb: 0.25, index: 0.18, middle: 0.58, ring: 0.68, pinky: 0.72 },
        },
      };
    },
  },

  point_left: {
    duration: 3.0,
    sample(t) {
      return {
        joints: {
          idx27_head_joint1: 0.74,
          idx28_head_joint2: 0.08,
          idx13_left_arm_joint1: 0.62,
          idx14_left_arm_joint2: -0.82,
          idx15_left_arm_joint3: -0.18,
          idx16_left_arm_joint4: -0.22 + 0.05 * Math.sin(t * 3),
          idx17_left_arm_joint5: 0.55,
          idx20_right_arm_joint1: 0.02,
          idx21_right_arm_joint2: -0.15,
          idx23_right_arm_joint4: 0.42,
        },
        hands: {
          left: { thumbOpp: 0.74, thumb: 0.62, index: 0.02, middle: 0.92, ring: 0.95, pinky: 0.96 },
          right: defaultHands(0.28).right,
        },
      };
    },
  },

  point_right: {
    duration: 3.0,
    sample(t) {
      return {
        joints: {
          idx27_head_joint1: -0.74,
          idx28_head_joint2: 0.08,
          idx20_right_arm_joint1: 0.62,
          idx21_right_arm_joint2: -0.82,
          idx22_right_arm_joint3: -0.18,
          idx23_right_arm_joint4: 0.22 + 0.05 * Math.sin(t * 3),
          idx24_right_arm_joint5: 0.55,
          idx13_left_arm_joint1: 0.02,
          idx14_left_arm_joint2: -0.15,
          idx16_left_arm_joint4: -0.42,
        },
        hands: {
          left: defaultHands(0.28).left,
          right: { thumbOpp: 0.74, thumb: 0.62, index: 0.02, middle: 0.92, ring: 0.95, pinky: 0.96 },
        },
      };
    },
  },

  inspect: {
    duration: 4.0,
    sample(t) {
      const ripple = (offset) => 0.45 + 0.42 * Math.sin(t * 4.5 + offset);
      return {
        joints: {
          idx27_head_joint1: 0.24 * Math.sin(t * 1.4),
          idx28_head_joint2: -0.38,
          idx13_left_arm_joint1: 0.08,
          idx14_left_arm_joint2: -0.68,
          idx15_left_arm_joint3: 0.42,
          idx16_left_arm_joint4: -1.42,
          idx17_left_arm_joint5: -1.05 + 0.45 * Math.sin(t * 2.2),
          idx20_right_arm_joint1: 0.08,
          idx21_right_arm_joint2: -0.68,
          idx22_right_arm_joint3: 0.42,
          idx23_right_arm_joint4: 1.42,
          idx24_right_arm_joint5: -1.05 + 0.45 * Math.sin(t * 2.2),
        },
        hands: {
          left: { thumbOpp: ripple(0) * 0.8, thumb: ripple(0), index: ripple(0.6), middle: ripple(1.2), ring: ripple(1.8), pinky: ripple(2.4) },
          right: { thumbOpp: ripple(0.3) * 0.8, thumb: ripple(0.3), index: ripple(0.9), middle: ripple(1.5), ring: ripple(2.1), pinky: ripple(2.7) },
        },
      };
    },
  },

  welcome: {
    duration: 3.4,
    sample(t) {
      const sway = Math.sin(t * 2.4);
      return {
        joints: {
          idx27_head_joint1: 0.08 * sway,
          idx28_head_joint2: 0.08,
          idx13_left_arm_joint1: 0.48 + 0.06 * sway,
          idx14_left_arm_joint2: -0.58,
          idx15_left_arm_joint3: -0.25,
          idx16_left_arm_joint4: -0.78,
          idx17_left_arm_joint5: -0.95,
          idx20_right_arm_joint1: 0.48 - 0.06 * sway,
          idx21_right_arm_joint2: -0.58,
          idx22_right_arm_joint3: -0.25,
          idx23_right_arm_joint4: 0.78,
          idx24_right_arm_joint5: -0.95,
        },
        hands: defaultHands(0.04),
      };
    },
  },

  open_hands: {
    duration: 3.2,
    sample(t) {
      return GESTURE_DEFS.welcome.sample(t);
    },
  },

  guard: {
    duration: 3.5,
    sample(t) {
      const breath = Math.sin(t * 3.0) * 0.04;
      return {
        joints: {
          idx27_head_joint1: -0.10,
          idx28_head_joint2: -0.05,
          idx13_left_arm_joint1: 0.28,
          idx14_left_arm_joint2: -0.72 + breath,
          idx15_left_arm_joint3: 0.52,
          idx16_left_arm_joint4: -1.52,
          idx20_right_arm_joint1: 0.24,
          idx21_right_arm_joint2: -0.82 - breath,
          idx22_right_arm_joint3: 0.48,
          idx23_right_arm_joint4: 1.62,
        },
        hands: defaultHands(0.92),
      };
    },
  },

  celebrate: {
    duration: 3.4,
    sample(t) {
      const pump = Math.sin(t * 6.0);
      return {
        joints: {
          idx27_head_joint1: 0.08 * Math.sin(t * 3.0),
          idx28_head_joint2: 0.16 + 0.04 * pump,
          idx13_left_arm_joint1: 1.04 + 0.08 * pump,
          idx14_left_arm_joint2: -0.44 - 0.10 * pump,
          idx15_left_arm_joint3: -0.92,
          idx16_left_arm_joint4: -1.16 - 0.16 * pump,
          idx20_right_arm_joint1: 1.04 + 0.08 * pump,
          idx21_right_arm_joint2: -0.44 - 0.10 * pump,
          idx22_right_arm_joint3: -0.92,
          idx23_right_arm_joint4: 1.16 + 0.16 * pump,
        },
        hands: defaultHands(0.82),
      };
    },
  },

  listen: {
    duration: 2.5,
    sample(t) {
      return {
        joints: {
          idx27_head_joint1: 0.06 * Math.sin(t * 1.4),
          idx28_head_joint2: -0.06,
          idx13_left_arm_joint1: 0.12,
          idx14_left_arm_joint2: -0.22,
          idx16_left_arm_joint4: -0.58,
          idx20_right_arm_joint1: 0.12,
          idx21_right_arm_joint2: -0.22,
          idx23_right_arm_joint4: 0.58,
        },
        hands: defaultHands(0.22),
      };
    },
  },

  rest: {
    duration: 1.4,
    sample() {
      return {
        joints: {
          idx27_head_joint1: 0,
          idx28_head_joint2: 0,
          idx13_left_arm_joint1: 0.06,
          idx14_left_arm_joint2: -0.06,
          idx16_left_arm_joint4: -0.25,
          idx20_right_arm_joint1: 0.06,
          idx21_right_arm_joint2: -0.06,
          idx23_right_arm_joint4: 0.25,
        },
        hands: defaultHands(0.26),
      };
    },
  },
};

export const GESTURE_NAMES = Object.keys(GESTURE_DEFS);

function stepSpring(pos, vel, target, omega, zeta, maxVel, dt) {
  const h = dt * 0.5;
  let p = pos;
  let v = vel;
  for (let i = 0; i < 2; i++) {
    const acc = omega * omega * (target - p) - 2 * zeta * omega * v;
    v = clamp(v + acc * h, -maxVel, maxVel);
    p += v * h;
  }
  return [p, v];
}

export class LukaMotionController {
  constructor(model) {
    this.model = model;
    this.pose = model.zeroPose();
    this.target = model.zeroPose();
    this.hands = defaultHands(0.26);
    this.targetHands = defaultHands(0.26);

    this.time = 0;
    this.mode = 'idle'; // 'idle' | 'listening' | 'thinking' | 'speaking'
    this.speechLevel = 0; // 0..1 smoothed audio RMS
    this.trackingMode = 'off'; // 'off' | 'gaze' | 'mirror'
    this.trackedPose = null; // { joints, hands, headTarget }
    this.headGazeOverride = null; // { yaw, pitch } from 2D head pad or cursor follow
    this.handPresetOverride = null; // { left, right } optional manual hand shape test
    this.smoothing = 0.68; // 0 (snappy) .. 1 (ultra-smooth anti-jitter)
    this.manualOverrides = new Map(); // jointName -> rad

    // Second-order spring-damper neck velocity + OLED eye gaze lead
    this.headYawVel = 0;
    this.headPitchVel = 0;
    this.eyeX = 0;
    this.eyeY = 0;

    // Natural saccadic ambient gaze targets in idle
    this.ambientYaw = 0;
    this.ambientPitch = 0.02;
    this.nextAmbientAt = 2.6;
    this._ambientSeed = 1;

    this.activeGesture = null; // { name, elapsed, duration, sampleFn }
    this.nextBlinkAt = 2.4;
    this.blinkValue = 0;
    this.blinkPhase = 0;
  }

  setMode(mode) {
    this.mode = mode;
  }

  setSpeechLevel(rms) {
    this.speechLevel = clamp(rms, 0, 1);
  }

  setTrackingMode(mode) {
    this.trackingMode = mode;
    if (mode === 'off') this.trackedPose = null;
  }

  setTrackedPose(tracked) {
    this.trackedPose = tracked;
  }

  setHeadGazeOverride(yawRad, pitchRad) {
    this.headGazeOverride = {
      yaw: clamp(yawRad, -1.32, 1.32),
      pitch: clamp(pitchRad, -0.58, 0.62),
    };
  }

  clearHeadGazeOverride() {
    this.headGazeOverride = null;
  }

  setSmoothing(level01) {
    this.smoothing = clamp(Number(level01) || 0, 0, 1);
  }

  setHandPreset(presetName) {
    const p = HAND_PRESETS[presetName];
    if (!p) {
      this.handPresetOverride = null;
      return false;
    }
    this.handPresetOverride = { left: { ...p }, right: { ...p } };
    return true;
  }

  clearHandPreset() {
    this.handPresetOverride = null;
  }

  setManualJoint(name, valueRad) {
    this.manualOverrides.set(name, valueRad);
  }

  clearManualOverrides() {
    this.manualOverrides.clear();
    this.headGazeOverride = null;
    this.handPresetOverride = null;
  }

  playGesture(name, opts = {}) {
    const def = GESTURE_DEFS[name];
    if (!def) return false;
    this.activeGesture = {
      name,
      elapsed: 0,
      duration: opts.duration || def.duration,
      sampleFn: (t) => def.sample(t),
    };
    return true;
  }

  playCustomSkillPose(name, snapshot, duration = 3.2) {
    if (!snapshot || !snapshot.joints) return false;
    const savedJoints = { ...snapshot.joints };
    const savedHands = snapshot.hands ? JSON.parse(JSON.stringify(snapshot.hands)) : defaultHands(0.18);
    this.activeGesture = {
      name,
      elapsed: 0,
      duration,
      sampleFn: (t) => {
        const subtle = Math.sin(t * 2.8) * 0.035;
        const j = { ...savedJoints };
        if ('idx28_head_joint2' in j) j.idx28_head_joint2 += subtle * 0.5;
        return { joints: j, hands: savedHands };
      },
    };
    return true;
  }

  /** Capture a clean snapshot of Luka's current upper-body joints + hand curls (for Teach Emergent Skill). */
  captureSnapshot() {
    const joints = {};
    for (const name of UPPER_BODY_JOINTS) {
      joints[name] = Number((this.pose[name] ?? 0).toFixed(4));
    }
    return {
      joints,
      hands: JSON.parse(JSON.stringify(this.hands)),
    };
  }

  /** Advance natural motion, blending, blinking, and FK-ready joint state. */
  step(dt) {
    this.time += dt;
    const t = this.time;

    // 1. Natural blink timer for the black-head OLED visor
    if (this.blinkPhase > 0) {
      this.blinkPhase += dt * 7.5;
      if (this.blinkPhase >= Math.PI) {
        this.blinkPhase = 0;
        this.blinkValue = 0;
        this.nextBlinkAt = t + 2.4 + Math.random() * 3.4;
      } else {
        this.blinkValue = Math.sin(this.blinkPhase);
      }
    } else if (t >= this.nextBlinkAt) {
      this.blinkPhase = 0.01;
    }

    // 2. Base natural relaxed upper-body posture with subtle organic breathing & saccadic gaze
    const breath = Math.sin(t * 1.45);
    if (this.mode === 'idle' && !this.activeGesture && this.trackingMode === 'off' && !this.headGazeOverride && t >= this.nextAmbientAt) {
      // Deterministic-feeling organic focal shifts (eye contact + curious lateral/vertical glances)
      this._ambientSeed = (this._ambientSeed * 1664525 + 1013904223) >>> 0;
      const r1 = (this._ambientSeed & 0xffff) / 0xffff;
      this._ambientSeed = (this._ambientSeed * 1664525 + 1013904223) >>> 0;
      const r2 = (this._ambientSeed & 0xffff) / 0xffff;
      this._ambientSeed = (this._ambientSeed * 1664525 + 1013904223) >>> 0;
      const r3 = (this._ambientSeed & 0xffff) / 0xffff;

      const prevYaw = this.ambientYaw;
      if (r1 < 0.38) {
        // Return toward direct eye contact
        this.ambientYaw = (r2 - 0.5) * 0.18;
        this.ambientPitch = 0.02 + (r3 - 0.5) * 0.10;
      } else {
        // Expressive lateral & vertical ambient glance
        this.ambientYaw = (r2 - 0.5) * 1.06; // ~ ±30°
        this.ambientPitch = -0.18 + r3 * 0.42; // ~ -10°..+14°
      }
      // Natural human blink when shifting gaze laterally by > 16°
      if (Math.abs(this.ambientYaw - prevYaw) > 0.28 && this.blinkPhase === 0) {
        this.blinkPhase = 0.01;
      }
      this.nextAmbientAt = t + 2.0 + r1 * 2.2;
    }

    const microLookX = Math.sin(t * 0.55) * 0.055 + Math.sin(t * 0.23) * 0.035;
    const microLookY = Math.cos(t * 0.45) * 0.04;

    const desired = {};
    for (const j of this.model.movable) desired[j.name] = 0;

    // Natural relaxed idle stance (compensates for 15° built-in URDF shoulder flare)
    desired.idx27_head_joint1 = this.ambientYaw + microLookX;
    desired.idx28_head_joint2 = this.ambientPitch + microLookY + breath * 0.018;
    desired.idx13_left_arm_joint1 = -0.04 + breath * 0.018;
    desired.idx14_left_arm_joint2 = -0.09 - breath * 0.015;
    desired.idx15_left_arm_joint3 = 0.08;
    desired.idx16_left_arm_joint4 = -0.34 - breath * 0.025;
    desired.idx17_left_arm_joint5 = -0.15;
    desired.idx20_right_arm_joint1 = -0.04 + breath * 0.018;
    desired.idx21_right_arm_joint2 = -0.09 - breath * 0.015;
    desired.idx22_right_arm_joint3 = 0.08;
    desired.idx23_right_arm_joint4 = 0.34 + breath * 0.025;
    desired.idx24_right_arm_joint5 = -0.15;

    let desiredHands = defaultHands(0.24 + breath * 0.03);

    // 3. Conversational state layer
    if (this.mode === 'listening') {
      desired.idx27_head_joint1 = Math.sin(t * 0.85) * 0.16;
      desired.idx28_head_joint2 = -0.04 + Math.sin(t * 2.5) * 0.085;
      desired.idx13_left_arm_joint1 = 0.12;
      desired.idx14_left_arm_joint2 = -0.22;
      desired.idx16_left_arm_joint4 = -0.62;
      desired.idx20_right_arm_joint1 = 0.12;
      desired.idx21_right_arm_joint2 = -0.22;
      desired.idx23_right_arm_joint4 = 0.62;
      desiredHands = defaultHands(0.18);
    } else if (this.mode === 'thinking') {
      desired.idx27_head_joint1 = 0.36 + Math.sin(t * 1.1) * 0.10;
      desired.idx28_head_joint2 = 0.24 + Math.cos(t * 1.4) * 0.06;
      desired.idx20_right_arm_joint1 = 0.16;
      desired.idx21_right_arm_joint2 = -0.56;
      desired.idx22_right_arm_joint3 = 0.50;
      desired.idx23_right_arm_joint4 = 1.55;
      desired.idx14_left_arm_joint2 = -0.20;
      desired.idx16_left_arm_joint4 = -0.78;
      desiredHands = defaultHands(0.30);
    } else if (this.mode === 'speaking') {
      const energy = clamp(0.30 + this.speechLevel * 1.7, 0.28, 1.0);
      const beatA = Math.sin(t * 3.8);
      const beatB = Math.cos(t * 2.6 + 0.7);
      const accentNod = Math.sin(t * 5.0) * energy;

      // Phrase-level lateral gaze sweeps + RMS-driven up/down emphasis nods
      desired.idx27_head_joint1 = (Math.sin(t * 1.25) * 0.28 + Math.sin(t * 0.52) * 0.14) * energy;
      desired.idx28_head_joint2 = 0.02 + accentNod * 0.20 + Math.cos(t * 2.1) * 0.06;

      // Expressive conversational co-speech arm phrasing (both palms angled cleanly upward/inward)
      desired.idx13_left_arm_joint1 = 0.12 + 0.10 * energy + 0.05 * beatA;
      desired.idx14_left_arm_joint2 = -0.34 - 0.18 * energy - 0.09 * beatB;
      desired.idx15_left_arm_joint3 = 0.22 - 0.14 * beatA * energy;
      desired.idx16_left_arm_joint4 = -0.96 - 0.24 * energy - 0.14 * beatA;
      desired.idx17_left_arm_joint5 = -0.64 + 0.20 * beatB * energy;
      desired.idx18_left_arm_joint6 = -0.12 * beatA * energy;

      desired.idx20_right_arm_joint1 = 0.14 + 0.12 * energy - 0.05 * beatB;
      desired.idx21_right_arm_joint2 = -0.38 - 0.20 * energy + 0.10 * beatA;
      desired.idx22_right_arm_joint3 = 0.24 + 0.16 * beatB * energy;
      desired.idx23_right_arm_joint4 = 1.02 + 0.24 * energy + 0.14 * beatB;
      desired.idx24_right_arm_joint5 = -0.64 - 0.20 * beatA * energy;
      desired.idx25_right_arm_joint6 = 0.12 * beatB * energy;

      const openCurl = clamp(0.24 - energy * 0.16 + 0.05 * beatA, 0.04, 0.35);
      desiredHands = defaultHands(openCurl);
    }

    // 4. Active semantic / emergent gesture overlay
    if (this.activeGesture) {
      this.activeGesture.elapsed += dt;
      const w = gestureEnvelope(this.activeGesture.elapsed, this.activeGesture.duration);
      if (this.activeGesture.elapsed >= this.activeGesture.duration) {
        this.activeGesture = null;
      } else if (w > 0) {
        const sample = this.activeGesture.sampleFn(this.activeGesture.elapsed);
        if (sample?.joints) {
          for (const [k, v] of Object.entries(sample.joints)) {
            if (k in desired) desired[k] = lerp(desired[k], v, w);
          }
        }
        if (sample?.hands) {
          for (const side of ['left', 'right']) {
            if (!sample.hands[side]) continue;
            for (const f of FINGER_KEYS) {
              if (typeof sample.hands[side][f] === 'number') {
                desiredHands[side][f] = lerp(desiredHands[side][f], sample.hands[side][f], w);
              }
            }
          }
        }
      }
    }

    // 5. Kameyoko Vision Tracking layer
    if (this.trackingMode === 'gaze' && this.trackedPose?.headTarget) {
      desired.idx27_head_joint1 = clamp(this.trackedPose.headTarget.yaw, -1.25, 1.25);
      desired.idx28_head_joint2 = clamp(this.trackedPose.headTarget.pitch, -0.56, 0.60);
    } else if (this.trackingMode === 'mirror' && this.trackedPose) {
      if (this.trackedPose.joints) {
        for (const [k, v] of Object.entries(this.trackedPose.joints)) {
          if (k in desired && Number.isFinite(v)) desired[k] = v;
        }
      }
      if (this.trackedPose.hands) {
        for (const side of ['left', 'right']) {
          if (!this.trackedPose.hands[side]) continue;
          for (const f of FINGER_KEYS) {
            const val = this.trackedPose.hands[side][f];
            if (typeof val === 'number' && Number.isFinite(val)) desiredHands[side][f] = clamp(val, 0, 1);
          }
        }
      }
    }

    // 5b. Direct 2D head pad / viewport cursor gaze override (leaves arms free)
    if (this.headGazeOverride) {
      desired.idx27_head_joint1 = this.headGazeOverride.yaw;
      desired.idx28_head_joint2 = this.headGazeOverride.pitch;
    }

    // 5c. Direct manual hand-shape test override (Open, Peace, Point, Pinch, Thumbs Up, Fist)
    if (this.handPresetOverride) {
      for (const side of ['left', 'right']) {
        for (const f of FINGER_KEYS) {
          desiredHands[side][f] = this.handPresetOverride[side][f];
        }
      }
    }

    // 6. Manual slider overrides
    for (const [name, val] of this.manualOverrides) {
      if (name in desired) desired[name] = val;
    }

    // 7. Clamp to model limits & integrate arms (adaptive smooth) + neck (second-order spring-damper)
    const clamped = this.model.clampPose(desired);
    this.target = clamped;
    this.targetHands = desiredHands;

    const directHead = this.trackingMode !== 'off' || Boolean(this.headGazeOverride) || this.manualOverrides.has('idx27_head_joint1') || this.manualOverrides.has('idx28_head_joint2');
    const neckOmega = directHead ? 15.0 : (this.activeGesture ? 12.5 : 9.2);
    const neckZeta = directHead ? 0.92 : 0.80;

    const [nextYaw, nextYawVel] = stepSpring(
      this.pose.idx27_head_joint1 ?? 0,
      this.headYawVel,
      this.target.idx27_head_joint1 ?? 0,
      neckOmega,
      neckZeta,
      5.2,
      dt,
    );
    const [nextPitch, nextPitchVel] = stepSpring(
      this.pose.idx28_head_joint2 ?? 0,
      this.headPitchVel,
      this.target.idx28_head_joint2 ?? 0,
      neckOmega * 1.08,
      neckZeta,
      3.8,
      dt,
    );
    const yawLim = this.model.limits('idx27_head_joint1');
    const pitchLim = this.model.limits('idx28_head_joint2');
    this.pose.idx27_head_joint1 = clamp(nextYaw, yawLim?.lower ?? -1.32, yawLim?.upper ?? 1.32);
    this.pose.idx28_head_joint2 = clamp(nextPitch, pitchLim?.lower ?? -0.58, pitchLim?.upper ?? 0.62);
    this.headYawVel = nextYawVel;
    this.headPitchVel = nextPitchVel;

    // Expressive OLED eye gaze lead: eyes dart slightly ahead of head turns and hold subtle directional focus
    const targetEyeX = clamp(
      (this.target.idx27_head_joint1 - this.pose.idx27_head_joint1) * 1.55 + this.pose.idx27_head_joint1 * 0.36,
      -1,
      1,
    );
    const targetEyeY = clamp(
      (this.target.idx28_head_joint2 - this.pose.idx28_head_joint2) * 2.2 + this.pose.idx28_head_joint2 * 0.55,
      -1,
      1,
    );
    this.eyeX = damp(this.eyeX, targetEyeX, 22, dt);
    this.eyeY = damp(this.eyeY, targetEyeY, 22, dt);

    // Smooth anti-jitter stiffness tuned by user smoothing slider (0=snappy, 1=ultra-smooth)
    const armStiffness = this.trackingMode === 'mirror'
      ? lerp(20, 8.2, this.smoothing)
      : 10.5;
    const wristStiffness = this.trackingMode === 'mirror'
      ? lerp(17, 6.8, this.smoothing)
      : 10.5;
    const fingerStiffness = this.trackingMode === 'mirror'
      ? lerp(19, 7.2, this.smoothing)
      : 13.5;

    for (const j of this.model.movable) {
      if (j.name === 'idx27_head_joint1' || j.name === 'idx28_head_joint2') continue;
      if (j.name.startsWith('lh_') || j.name.startsWith('rh_')) continue;
      const isWrist = j.name.endsWith('joint5') || j.name.endsWith('joint6') || j.name.endsWith('joint7');
      this.pose[j.name] = damp(this.pose[j.name] ?? 0, this.target[j.name] ?? 0, isWrist ? wristStiffness : armStiffness, dt);
    }

    for (const side of ['left', 'right']) {
      for (const f of FINGER_KEYS) {
        this.hands[side][f] = damp(this.hands[side][f] ?? 0.24, this.targetHands[side][f] ?? 0.24, fingerStiffness, dt);
      }
    }
    applyHandCurlsToPose(this.model, this.pose, this.hands);

    const stateMode = this.trackingMode === 'mirror'
      ? 4
      : this.mode === 'speaking'
        ? 3
        : this.mode === 'thinking'
          ? 2
          : this.mode === 'listening'
            ? 1
            : 0;

    return {
      pose: this.pose,
      hands: this.hands,
      visorFx: {
        time: this.time,
        speechLevel: this.speechLevel,
        stateMode,
        blink: this.blinkValue,
        eyeX: this.eyeX,
        eyeY: this.eyeY,
      },
      activeGestureName: this.activeGesture?.name || null,
    };
  }
}
