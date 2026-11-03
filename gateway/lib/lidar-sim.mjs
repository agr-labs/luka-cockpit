// Simulated Livox Mid-360 scan of a small room.
//
// A Mid-360 is a non-repetitive 360° lidar at 10 Hz; this generator casts rays
// from neck height against a closed box with a few obstacles, adds millimetre
// noise, and returns Float32 xyz. It exists so the streaming, framing, column
// order and renderer can be built and tested before any robot-side bridge
// exists — not to claim fidelity to the sensor's real scan pattern.
//
// Deterministic when given a seed, which is what the tests use.

import { DEFAULT_POINTS } from './lidar.mjs';

export const ROOM = {
  min: [-4, 0, -3],
  max: [4, 2.8, 3],
  sensor: [0, 1.35, 0],
  maxRange: 12,
  obstacles: [
    { min: [1.4, 0, -2.2], max: [2.4, 1.0, -1.2] },   // crate
    { min: [-2.8, 0, 0.6], max: [-2.4, 2.2, 1.0] },   // pillar
    { min: [0.2, 0, 2.0], max: [1.8, 0.45, 2.6] },    // low table
  ],
};

const DEG = Math.PI / 180;

export function generateScan({ points = DEFAULT_POINTS, room = ROOM, frame = 0, seed = null } = {}) {
  const rnd = seed === null ? Math.random : mulberry32(seed + frame * 7919);
  const [ox, oy, oz] = room.sensor;
  const out = new Float32Array(points * 3);

  // Mid-360 vertical field is roughly -7° … +52°. Spread samples across it with
  // a slight bias toward the horizon, where walls are best represented.
  const elMin = -7 * DEG;
  const elMax = 52 * DEG;

  for (let i = 0; i < points; i++) {
    const azimuth = (i / points) * Math.PI * 2 + frame * 0.137 + (rnd() - 0.5) * 0.004;
    const u = (i * 0.61803398875 + frame * 0.3141592653) % 1; // golden-ratio stratification
    const elevation = elMin + (elMax - elMin) * Math.pow(u, 1.35) + (rnd() - 0.5) * 0.004;

    const dx = Math.cos(elevation) * Math.cos(azimuth);
    const dy = Math.sin(elevation);
    const dz = Math.cos(elevation) * Math.sin(azimuth);

    let t = rayRoom(ox, oy, oz, dx, dy, dz, room);
    if (!Number.isFinite(t) || t > room.maxRange) t = room.maxRange;

    // Millimetre-scale range noise, so the renderer sees realistic jitter.
    t += (rnd() - 0.5) * 0.02;

    out[i * 3] = ox + dx * t;
    out[i * 3 + 1] = oy + dy * t;
    out[i * 3 + 2] = oz + dz * t;
  }
  return out;
}

function rayRoom(ox, oy, oz, dx, dy, dz, room) {
  let best = Infinity;
  const [x0, y0, z0] = room.min;
  const [x1, y1, z1] = room.max;

  // Axis-aligned planes.
  if (dy < 0) best = Math.min(best, (y0 - oy) / dy);
  if (dy > 0) best = Math.min(best, (y1 - oy) / dy);
  if (dx > 0) best = Math.min(best, (x1 - ox) / dx);
  if (dx < 0) best = Math.min(best, (x0 - ox) / dx);
  if (dz > 0) best = Math.min(best, (z1 - oz) / dz);
  if (dz < 0) best = Math.min(best, (z0 - oz) / dz);

  for (const box of room.obstacles) {
    const hit = rayBox(ox, oy, oz, dx, dy, dz, box.min, box.max);
    if (hit < best) best = hit;
  }
  return best;
}

function rayBox(ox, oy, oz, dx, dy, dz, min, max) {
  let tmin = 0;
  let tmax = Infinity;
  const axes = [
    [ox, dx, min[0], max[0]],
    [oy, dy, min[1], max[1]],
    [oz, dz, min[2], max[2]],
  ];
  for (const [o, d, lo, hi] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return Infinity;
      continue;
    }
    let t1 = (lo - o) / d;
    let t2 = (hi - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }
  return tmin > 0 ? tmin : Infinity;
}

function mulberry32(a) {
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
