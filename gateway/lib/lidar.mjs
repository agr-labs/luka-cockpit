// LiDAR frames: ingest, fan-out, and staleness.
//
// The real sensor is a Livox Mid-360 on the neck, published as
// `/aima/hal/lidar/neck/pointcloud` (sensor_msgs/PointCloud2, 10 Hz) over ROS 2.
// Nothing on the Wi-Fi interface speaks ROS 2, so today frames come from the
// simulator or from a future robot-side bridge that POSTs them here.
//
// Wire format is deliberately dumb: Float32 xyz triples, little-endian.
// No PCL, no PointCloud2 fields, no compression. A bridge that reads
// PointCloud2 can pack xyz and POST the bytes.

import { payloadTooLarge, tooManyRequests, unprocessable } from './errors.mjs';

export const MAX_POINTS = 262_144;             // 3 MiB of Float32 xyz
export const MAX_BYTES = MAX_POINTS * 12;
export const DEFAULT_POINTS = 2200;

const FLOATS_PER_POINT = 3;
const BYTES_PER_POINT = FLOATS_PER_POINT * 4;

export class LidarHub {
  constructor({ now = Date.now, staleMs = 1200, ttlMs = 10_000, minIntervalMs = 40 } = {}) {
    this.now = now;
    this.staleMs = staleMs;
    this.ttlMs = ttlMs;
    this.minIntervalMs = minIntervalMs;
    this.frames = new Map();       // robotId -> frame
    this.subscribers = new Set();  // { robotId, send(buffer) }
  }

  validate(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw unprocessable('frame body must be binary Float32 xyz');
    }
    if (buffer.length % BYTES_PER_POINT !== 0) {
      throw unprocessable(`frame length ${buffer.length} is not a multiple of ${BYTES_PER_POINT} bytes (3 × float32)`, {
        points: buffer.length / BYTES_PER_POINT,
      });
    }
    const count = buffer.length / BYTES_PER_POINT;
    if (count > MAX_POINTS) {
      throw payloadTooLarge(`frame has ${count} points; limit is ${MAX_POINTS}`);
    }
    return count;
  }

  publish(robotId, buffer, { source = 'unknown' } = {}) {
    const count = this.validate(buffer);
    const t = this.now();
    const last = this.frames.get(robotId);
    if (last && t - last.receivedAt < this.minIntervalMs) {
      throw tooManyRequests('lidar frames arrive faster than 25 Hz', { minIntervalMs: this.minIntervalMs });
    }

    const frame = {
      robotId,
      seq: (last?.seq ?? 0) + 1,
      at: new Date(t).toISOString(),
      receivedAt: t,
      count,
      source,
      points: buffer,
    };
    this.frames.set(robotId, frame);

    const payload = encodeFrame(frame);
    for (const sub of this.subscribers) {
      if (sub.robotId === robotId) sub.send(payload);
    }
    return this.meta(frame);
  }

  get(robotId) {
    const frame = this.frames.get(robotId);
    if (!frame) return null;
    if (this.now() - frame.receivedAt > this.ttlMs) return null;
    return frame;
  }

  /** Metadata only: safe for HTTP, and small enough to log. */
  meta(frame) {
    if (!frame) return null;
    const ageMs = Math.max(0, this.now() - frame.receivedAt);
    return {
      robotId: frame.robotId,
      seq: frame.seq,
      at: frame.at,
      count: frame.count,
      source: frame.source,
      ageMs,
      stale: ageMs > this.staleMs,
      bytes: frame.count * BYTES_PER_POINT,
    };
  }

  latest(robotId) {
    return this.meta(this.get(robotId));
  }

  subscribe(robotId, send) {
    const sub = { robotId, send };
    this.subscribers.add(sub);
    const frame = this.get(robotId);
    if (frame) send(encodeFrame(frame));
    return () => this.subscribers.delete(sub);
  }
}

/** [u32 headerLen][json header][float32 xyz...] — one WS binary message. */
export function encodeFrame(frame) {
  const header = Buffer.from(JSON.stringify({
    type: 'lidar',
    robotId: frame.robotId,
    seq: frame.seq,
    at: frame.at,
    count: frame.count,
    source: frame.source,
  }), 'utf8');
  const out = Buffer.allocUnsafe(4 + header.length + frame.points.length);
  out.writeUInt32LE(header.length, 0);
  header.copy(out, 4);
  frame.points.copy(out, 4 + header.length);
  return out;
}

export function decodeFrame(buffer) {
  const headerLen = buffer.readUInt32LE(0);
  const start = 4 + headerLen;
  const header = JSON.parse(buffer.subarray(4, start).toString('utf8'));
  // The payload starts at an arbitrary byte offset (the JSON header length), so
  // it is not guaranteed to be 4-byte aligned. Copy into a fresh buffer rather
  // than aliasing a misaligned view.
  const bytes = Uint8Array.prototype.slice.call(buffer, start);
  return { header, points: new Float32Array(bytes.buffer, 0, bytes.byteLength / 4) };
}

export { BYTES_PER_POINT };
