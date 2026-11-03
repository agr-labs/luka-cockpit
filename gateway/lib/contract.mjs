// The Steadwell Robot API contract.
//
// One vocabulary for every robot. An adapter reports which capabilities it can
// observe and which it can command; the gateway never invents the difference.
// Payload shapes and limits live here, in one file, so that a refusal and its
// documentation cannot drift apart.
//
// Units are SI: radians, metres, metres/second, seconds. Degrees appear only in
// the console's labels, never on the wire.

import { validate, summarizeErrors } from './validate.mjs';
import { PRESENCE_SCHEMA, PRESENCE_SOURCE } from './presence.mjs';

export const API_VERSION = 'v1';

export const CONTROL_MODES = ['observe', 'simulate', 'manual', 'assisted'];

export const ARM_JOINTS = [
  'idx13_left_arm_joint1', 'idx14_left_arm_joint2', 'idx15_left_arm_joint3',
  'idx16_left_arm_joint4', 'idx17_left_arm_joint5', 'idx18_left_arm_joint6',
  'idx19_left_arm_joint7',
  'idx20_right_arm_joint1', 'idx21_right_arm_joint2', 'idx22_right_arm_joint3',
  'idx23_right_arm_joint4', 'idx24_right_arm_joint5', 'idx25_right_arm_joint6',
  'idx26_right_arm_joint7',
];

// Documented hard limits, vendor guide §7.1.9. `idx26` is printed as
// "0.35 ~ 0.35"; treated as the mirrored ±0.35 of idx19 and flagged in docs.
export const ARM_LIMITS = {
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

// Vendor "yellow region" for the coupled parallel wrists. Not a hard limit:
// commands inside ARM_LIMITS but outside this envelope are accepted with a
// warning, because the reachable set is rhombic and the corners are suspect.
export const WRIST_ENVELOPE = {
  idx18_left_arm_joint6: [-0.30, 0.30],
  idx19_left_arm_joint7: [-0.20, 0.20],
  idx25_right_arm_joint6: [-0.30, 0.30],
  idx26_right_arm_joint7: [-0.20, 0.20],
};

// Model limits for head joints (URDF), used when no adapter is more specific.
export const HEAD_LIMITS = {
  joint1: [-2.20, 2.20], // pan / shake
  joint2: [-0.50, 0.50], // tilt / nod
};

export const LIMIT_SOURCES = {
  arm: 'vendor guide §7.1.9 hard limit',
  wrist: 'vendor recommended wrist envelope',
  head: 'URDF model limit',
  base: 'cockpit velocity clamp (vx 0.35, vy 0.25, wz 0.60)',
};

const num = (min, max, extra = {}) => ({ type: 'number', min, max, ...extra });

const armProperties = Object.fromEntries(
  ARM_JOINTS.map((name) => [name, num(ARM_LIMITS[name][0], ARM_LIMITS[name][1])]),
);

/**
 * Capability descriptors.
 *
 *   observable  – telemetry exists for it
 *   commandable – an adapter can accept a command for it
 *   physical    – a command can move/emit on real hardware
 *   requires    – preconditions beyond a lease ('grounded')
 *
 * Both observable and commandable are *adapter* facts. These entries are the
 * gateway's ceiling; the adapter reports its own support beneath it.
 */
export const CAPABILITIES = {
  'head.gaze': {
    id: 'head.gaze',
    group: 'head',
    label: 'Head gaze',
    summary: 'Aim the head with a yaw/tilt pair, no joint-level reasoning.',
    observable: true,
    commandable: true,
    physical: true,
    requires: [],
    schema: {
      type: 'object',
      required: ['yaw', 'pitch'],
      additionalProperties: false,
      properties: {
        yaw: num(HEAD_LIMITS.joint1[0], HEAD_LIMITS.joint1[1], { unit: 'rad' }),
        pitch: num(HEAD_LIMITS.joint2[0], HEAD_LIMITS.joint2[1], { unit: 'rad' }),
        durationMs: num(50, 3000, { unit: 'ms' }),
      },
    },
    limits: { head: HEAD_LIMITS, source: LIMIT_SOURCES.head },
  },

  'head.joints': {
    id: 'head.joints',
    group: 'head',
    label: 'Head joints',
    summary: 'Direct control of the two neck joints.',
    observable: true,
    commandable: true,
    physical: true,
    requires: [],
    schema: {
      type: 'object',
      required: ['joint1', 'joint2'],
      additionalProperties: false,
      properties: {
        joint1: num(HEAD_LIMITS.joint1[0], HEAD_LIMITS.joint1[1], { unit: 'rad' }),
        joint2: num(HEAD_LIMITS.joint2[0], HEAD_LIMITS.joint2[1], { unit: 'rad' }),
        durationMs: num(50, 3000, { unit: 'ms' }),
      },
    },
    limits: { head: HEAD_LIMITS, source: LIMIT_SOURCES.head },
  },

  'arms.joints': {
    id: 'arms.joints',
    group: 'arms',
    label: 'Arm joints',
    summary: 'Joint-space arm goals. Any subset of the 14 arm joints; unset joints hold.',
    observable: true,
    commandable: true,
    physical: true,
    requires: [],
    schema: {
      type: 'object',
      required: ['joints'],
      additionalProperties: false,
      properties: {
        joints: {
          type: 'object',
          minProperties: 1,
          maxProperties: ARM_JOINTS.length,
          additionalProperties: false,
          properties: armProperties,
        },
        durationMs: num(100, 5000, { unit: 'ms' }),
      },
    },
    limits: { hard: ARM_LIMITS, recommended: WRIST_ENVELOPE, source: 'vendor guide §7.1.9' },
  },

  'arms.cartesian': {
    id: 'arms.cartesian',
    group: 'arms',
    label: 'Arm cartesian goal',
    summary: 'End-effector position in the torso frame, plus optional orientation.',
    observable: false,
    commandable: true,
    physical: true,
    requires: [],
    schema: {
      type: 'object',
      required: ['side', 'position'],
      additionalProperties: false,
      properties: {
        side: { type: 'string', enum: ['left', 'right'] },
        position: {
          type: 'object',
          required: ['x', 'y', 'z'],
          additionalProperties: false,
          properties: {
            x: num(-0.80, 0.80, { unit: 'm' }),
            y: num(0.05, 1.00, { unit: 'm' }),
            z: num(-0.90, 0.90, { unit: 'm' }),
          },
        },
        orientation: {
          type: 'object',
          required: ['x', 'y', 'z', 'w'],
          additionalProperties: false,
          properties: { x: num(-1, 1), y: num(-1, 1), z: num(-1, 1), w: num(-1, 1) },
        },
        durationMs: num(100, 5000, { unit: 'ms' }),
      },
    },
    limits: {
      note: 'A coarse bounding box, not a reachability model. The simulator enforces the box; no IK exists yet.',
    },
  },

  'hands.grasp': {
    id: 'hands.grasp',
    group: 'arms',
    label: 'Hands',
    summary: 'Grasp presets or a raw finger channel value.',
    observable: true,
    commandable: true,
    physical: true,
    requires: [],
    schema: {
      type: 'object',
      required: ['side', 'action'],
      additionalProperties: false,
      properties: {
        side: { type: 'string', enum: ['left', 'right', 'both'] },
        action: { type: 'string', enum: ['open', 'close', 'pinch', 'set'] },
        value: num(0, 2000, { unit: 'sensor counts' }),
        finger: { type: 'string', enum: ['thumb', 'index', 'middle', 'ring', 'pinky'] },
      },
    },
    // `set` needs a value and a finger; the presets must not carry one, so a
    // caller cannot believe a preset honoured an arbitrary number.
    custom(value) {
      const errors = [];
      if (value.action === 'set') {
        if (typeof value.value !== 'number') {
          errors.push({ path: '$.value', keyword: 'required', message: 'is required when action is "set"' });
        }
        if (!value.finger) {
          errors.push({ path: '$.finger', keyword: 'required', message: 'is required when action is "set"' });
        }
      } else if ('value' in value || 'finger' in value) {
        errors.push({
          path: '$.value',
          keyword: 'notApplicable',
          message: `"${value.action}" is a preset; use action "set" to send a raw value`,
        });
      }
      return errors;
    },
    limits: { channel: [0, 2000], note: '6 channels per hand; 2000 is fully closed as reported by GetHandState' },
  },

  'legs.posture': {
    id: 'legs.posture',
    group: 'legs',
    label: 'Posture',
    summary: 'Transition between standing, sitting and crouched stances.',
    observable: true,
    commandable: true,
    physical: true,
    requires: ['grounded'],
    schema: {
      type: 'object',
      required: ['posture'],
      additionalProperties: false,
      properties: {
        posture: { type: 'string', enum: ['stand', 'sit', 'crouch', 'relax'] },
        rampMs: num(500, 10000, { unit: 'ms' }),
      },
    },
    limits: {
      note: 'Requires a grounded configuration. The feet-contact procedure is unverified for Luka.',
    },
  },

  'base.velocity': {
    id: 'base.velocity',
    group: 'legs',
    label: 'Base velocity',
    summary: 'Body-frame walking velocity with a deadman expiry.',
    observable: true,
    commandable: true,
    physical: true,
    requires: ['grounded'],
    schema: {
      type: 'object',
      required: ['vx', 'vy', 'wz'],
      additionalProperties: false,
      properties: {
        vx: num(-0.35, 0.35, { unit: 'm/s' }),
        vy: num(-0.25, 0.25, { unit: 'm/s' }),
        wz: num(-0.60, 0.60, { unit: 'rad/s' }),
        durationMs: num(100, 2000, { unit: 'ms' }),
      },
    },
    limits: { clamp: { vx: 0.35, vy: 0.25, wz: 0.60 }, deadmanMs: 600, source: LIMIT_SOURCES.base },
  },

  'voice.speak': {
    id: 'voice.speak',
    group: 'voice',
    label: 'Speech',
    summary: 'Synthesise speech on the robot audio output.',
    observable: false,
    commandable: true,
    physical: true,
    requires: [],
    schema: {
      type: 'object',
      required: ['text'],
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 500 },
        voice: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,32}$' },
        volume: num(0, 1),
        interrupt: { type: 'boolean' },
      },
    },
    limits: { maxCharacters: 500, note: 'Browser speech is developed in the cockpit; the robot audio adapter is not built.' },
  },

  'voice.listen': {
    id: 'voice.listen',
    group: 'voice',
    label: 'Listen',
    summary: 'Start or stop microphone capture and transcription.',
    observable: true,
    commandable: true,
    physical: false,
    requires: [],
    schema: {
      type: 'object',
      required: ['action'],
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['start', 'stop'] },
        language: { type: 'string', pattern: '^[a-z]{2}(-[A-Z]{2})?$' },
      },
    },
    limits: { note: 'Microphone capture on the robot is unverified; only the browser-side path exists.' },
  },

  'camera.stream': {
    id: 'camera.stream',
    group: 'perception',
    label: 'Cameras',
    summary: 'Enumerate and select video streams.',
    observable: true,
    commandable: true,
    physical: false,
    requires: [],
    schema: {
      type: 'object',
      required: ['camera', 'action'],
      additionalProperties: false,
      properties: {
        camera: { type: 'string', pattern: '^[a-z0-9_.-]{1,32}$' },
        action: { type: 'string', enum: ['start', 'stop'] },
      },
    },
    limits: { note: 'No camera endpoint has been verified on Luka. The simulator lists synthetic cameras.' },
  },

  'motion.state': {
    id: 'motion.state',
    group: 'perception',
    label: 'Motion state',
    summary: 'The robot-reported action, status and controller owner.',
    observable: true,
    commandable: false,
    readOnly: true,
    physical: false,
    requires: [],
    schema: null,
    limits: { note: 'Read-only. Setting motion state is a different decision, recorded in decisions.md.' },
  },
};

export const CAPABILITY_IDS = Object.keys(CAPABILITIES);

export function getCapability(id) {
  return CAPABILITIES[id] ?? null;
}

/**
 * Validate a capability payload. Returns { ok, errors, warnings, value }.
 * Warnings are advisory (wrist envelope), never blocking.
 */
export function validatePayload(capabilityId, payload) {
  const cap = CAPABILITIES[capabilityId];
  if (!cap) {
    return { ok: false, errors: [{ path: '$', keyword: 'unknownCapability', message: `unknown capability "${capabilityId}"` }], warnings: [] };
  }
  const errors = validate(cap.schema, payload);
  if (cap.custom && errors.length === 0) errors.push(...cap.custom(payload));
  const warnings = errors.length === 0 ? advisory(capabilityId, payload) : [];
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: errors.length ? summarizeErrors(errors) : null,
  };
}

function advisory(capabilityId, payload) {
  const warnings = [];
  if (capabilityId === 'arms.joints') {
    for (const [joint, value] of Object.entries(payload.joints)) {
      const env = WRIST_ENVELOPE[joint];
      if (env && (value < env[0] || value > env[1])) {
        warnings.push({
          code: 'recommended_envelope',
          message: `${joint} is inside the hard limit but outside the vendor wrist envelope`,
          joint,
          value,
          envelope: env,
          source: LIMIT_SOURCES.wrist,
        });
      }
    }
  }
  return warnings;
}

/** Machine-readable description of the contract, served at /api/v1/contract. */
export function contractDocument() {
  return {
    apiVersion: API_VERSION,
    units: { angle: 'rad', distance: 'm', velocity: 'm/s', time: 's', finger: 'sensor counts 0-2000' },
    controlModes: CONTROL_MODES,
    capabilities: Object.values(CAPABILITIES).map((c) => ({
      capability: c.id,
      group: c.group,
      label: c.label,
      summary: c.summary,
      observable: c.observable,
      commandable: c.commandable,
      physical: c.physical,
      readOnly: Boolean(c.readOnly),
      requires: c.requires,
      schema: c.schema,
      limits: c.limits ?? null,
    })),
    channels: {
      lidar: {
        path: '/api/v1/robots/:id/lidar',
        websocket: '/api/v1/robots/:id/lidar',
        ingest: 'POST application/octet-stream — Float32 xyz triples, little-endian',
        fanout: 'WebSocket binary: u32 LE header length, JSON header, Float32 xyz',
        limits: { maxPoints: 262_144, maxHz: 25 },
        source: 'simulator (lidar.simulate) or a robot-side bridge',
        note: 'Not PointCloud2 and not compressed. The real sensor topic is ROS 2-only; the bridge packs xyz.',
      },
      presence: {
        path: '/api/v1/robots/:id/presence',
        transport: 'HTTP POST for ingest, WebSocket fan-out to dashboard clients',
        source: PRESENCE_SOURCE,
        notRobotTelemetry: true,
        note: 'Scalars measured by a browser sensor page: mic dBFS/VAD and display luminance/motion. No audio, no frames. Self-declared source; never authority.',
        schema: PRESENCE_SCHEMA,
      },
    },
    statusCodes: {
      400: 'malformed request',
      401: 'missing or wrong bearer token (only when the gateway is token-protected)',
      404: 'unknown robot, capability or route',
      405: 'capability is read-only',
      409: 'state conflict — lease, mode, configuration, deadline or unverified path',
      413: 'body over 64 KiB',
      422: 'payload failed validation; errors[] names the field and limit',
      423: 'software stop is latched; POST /rearm clears it',
      429: 'command rate limit',
      503: 'robot adapter offline',
    },
  };
}
