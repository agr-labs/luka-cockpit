// Presence channel: scalar observations of the robot's physical output.
//
// The robot does not expose its face state or audio level on a reachable port,
// so this channel carries measurements taken by the room-sensor page: dBFS,
// VAD, display luminance and frame motion. Numbers only — no audio, no frames,
// no device identifiers beyond a human-readable label.
//
// Provenance is part of the record. `source` is self-declared and the dashboard
// shows it; this is an observation channel, never authority, and it is never
// treated as robot telemetry.

import { unprocessable, tooManyRequests } from './errors.mjs';
import { validate } from './validate.mjs';

export const PRESENCE_SOURCE = 'room-sensors';

const num = (min, max) => ({ type: 'number', min, max });

export const PRESENCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    mic: {
      type: 'object',
      required: ['db', 'speaking'],
      additionalProperties: false,
      properties: {
        db: num(-100, 0),
        peak: num(-100, 0),
        speaking: { type: 'boolean' },
      },
    },
    camera: {
      type: 'object',
      required: ['luminance', 'motion'],
      additionalProperties: false,
      properties: {
        luminance: num(0, 255),
        motion: num(0, 1000),
      },
    },
    devices: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mic: { type: 'string', maxLength: 120 },
        camera: { type: 'string', maxLength: 120 },
      },
    },
  },
};

export function validatePresence(body) {
  const errors = validate(PRESENCE_SCHEMA, body);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, errors };
  }
  if (!body.mic && !body.camera) {
    errors.push({ path: '$', keyword: 'required', message: 'at least one of mic or camera is required' });
  }
  return { ok: errors.length === 0, errors };
}

export class PresenceRegistry {
  constructor({ now = Date.now, staleMs = 2000, ttlMs = 30_000, minIntervalMs = 100 } = {}) {
    this.now = now;
    this.staleMs = staleMs;
    this.ttlMs = ttlMs;
    this.minIntervalMs = minIntervalMs;
    this.byRobot = new Map();
  }

  ingest(robotId, body, { source = PRESENCE_SOURCE } = {}) {
    const check = validatePresence(body);
    if (!check.ok) {
      throw unprocessable('presence sample rejected', { errors: check.errors });
    }

    const t = this.now();
    const last = this.byRobot.get(robotId);
    if (last && t - last.receivedAt < this.minIntervalMs) {
      throw tooManyRequests('presence samples arrive faster than 10 Hz', {
        minIntervalMs: this.minIntervalMs,
      });
    }

    const record = {
      robotId,
      source,
      seq: (last?.seq ?? 0) + 1,
      at: new Date(t).toISOString(),
      receivedAt: t,
      mic: body.mic ?? null,
      camera: body.camera ?? null,
      devices: body.devices ?? null,
    };
    this.byRobot.set(robotId, record);
    return this.view(record);
  }

  get(robotId) {
    const record = this.byRobot.get(robotId);
    if (!record) return null;
    if (this.now() - record.receivedAt > this.ttlMs) return null;
    return this.view(record);
  }

  view(record) {
    const ageMs = Math.max(0, this.now() - record.receivedAt);
    return {
      robotId: record.robotId,
      source: record.source,
      seq: record.seq,
      at: record.at,
      ageMs,
      stale: ageMs > this.staleMs,
      mic: record.mic,
      camera: record.camera,
      devices: record.devices,
    };
  }
}
