#!/usr/bin/env node
// Generates the cockpit's twin model from the vendored AgiBot A2 representation.
//
// Inputs (do not edit): model/urdf/agibot_a2_dof12.urdf, model/meshes/*.stl
// Outputs (generated, safe to delete): model/generated/luka.model.json,
//          model/generated/luka.mesh.bin, model/generated/luka.mesh.json
//
// The URDF is Z-up; the cockpit renders Y-up, so every position, axis and mesh
// vertex is converted here once: (x, y, z) -> (x, z, -y).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODEL_DIR = join(ROOT, 'model');
const OUT_DIR = join(MODEL_DIR, 'generated');

/* ------------------------------------------------------------------ helpers */

const deg = (r) => (r * 180) / Math.PI;

function rpyMatrix(r, p, y) {
  // URDF: R = Rz(yaw) * Ry(pitch) * Rx(roll), column-major 4x4
  const cr = Math.cos(r), sr = Math.sin(r);
  const cp = Math.cos(p), sp = Math.sin(p);
  const cy = Math.cos(y), sy = Math.sin(y);
  const m00 = cy * cp, m01 = cy * sp * sr - sy * cr, m02 = cy * sp * cr + sy * sr;
  const m10 = sy * cp, m11 = sy * sp * sr + cy * cr, m12 = sy * sp * cr - cy * sr;
  const m20 = -sp, m21 = cp * sr, m22 = cp * cr;
  return [
    m00, m10, m20, 0,
    m01, m11, m21, 0,
    m02, m12, m22, 0,
    0, 0, 0, 1,
  ];
}

function translation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// Z-up -> Y-up: rotate -90 deg about X.
const zUpToYUp = (x, y, z) => [x, z, -y];

const attr = (tag, name) => {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : null;
};

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([a-zA-Z_:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const nums = (s, n) => (s || '').trim().split(/\s+/).slice(0, n).map(Number);

/* --------------------------------------------------------------- parse URDF */

function parseUrdf(rawXml) {
  // Two massless frames are self-closing (<link name="x"/>); normalise them.
  const xml = rawXml.replace(/<link\b([^>]*?)\/>/g, '<link$1></link>');
  const links = [];
  for (const m of xml.matchAll(/<link\b([^>]*)>([\s\S]*?)<\/link>/g)) {
    const name = attr(m[1], 'name');
    const body = m[2];
    if (!name) continue;
    const visualMatch = body.match(/<visual\b[^>]*>([\s\S]*?)<\/visual>/);
    const visual = visualMatch ? [null, visualMatch[1]] : null;
    let mesh = null, color = [0.6, 0.6, 0.6, 1], visualOrigin = [0, 0, 0, 0, 0, 0], scale = 1;
    if (visual) {
      const vm = attr(visual[1], 'filename');
      if (vm) mesh = basename(vm);
      const sm = visual[1].match(/<mesh\b([^>]*)>/);
      if (sm && attr(sm[1], 'scale')) {
        const sc = nums(attr(sm[1], 'scale'), 3);
        scale = sc[0] || 1;
      }
      const cm = visual[1].match(/<color\s+rgba\s*=\s*"([^"]+)"/);
      if (cm) color = nums(cm[1], 4);
      const om = visual[1].match(/<origin\b([^>]*)>/);
      if (om) visualOrigin = [...nums(attr(om[1], 'xyz'), 3), ...nums(attr(om[1], 'rpy'), 3)];
    }
    const massM = body.match(/<mass\s+value\s*=\s*"([^"]+)"/);
    const inertialM = body.match(/<inertial>([\s\S]*?)<\/inertial>/);
    let comXyz = [0, 0, 0];
    if (inertialM) {
      const cm = inertialM[1].match(/<origin\b([^>]*)>/);
      if (cm) comXyz = nums(attr(cm[1], 'xyz'), 3);
    }
    links.push({ name, mesh, color, mass: massM ? Number(massM[1]) : 0, visualOrigin, comXyz, scale, hand: false });
  }

  const joints = [];
  for (const m of xml.matchAll(/<joint\b([^>]*)>([\s\S]*?)<\/joint>/g)) {
    const name = attr(m[1], 'name');
    const type = attr(m[1], 'type');
    const body = m[2];
    if (!name || !type) continue;
    const parent = body.match(/<parent\b([^>]*)>/)?.[1];
    const child = body.match(/<child\b([^>]*)>/)?.[1];
    const originM = body.match(/<origin\b([^>]*)>/);
    const xyz = originM ? nums(attr(originM[1], 'xyz'), 3) : [0, 0, 0];
    const rpy = originM ? nums(attr(originM[1], 'rpy'), 3) : [0, 0, 0];
    const axisM = body.match(/<axis\b([^>]*)>/);
    const axis = axisM ? nums(attr(axisM[1], 'xyz'), 3) : null;
    const limitM = body.match(/<limit\b([^>]*)\/?>/);
    const lim = limitM ? parseAttrs(limitM[1]) : {};
    const mimicM = body.match(/<mimic\b([^>]*)\/?>/);
    const mimicA = mimicM ? parseAttrs(mimicM[1]) : null;
    joints.push({
      name, type, parent: parent ? attr(parent, 'link') : null, child: child ? attr(child, 'link') : null, xyz, rpy, axis,
      hand: false,
      mimic: mimicA ? { joint: mimicA.joint, multiplier: Number(mimicA.multiplier ?? 1), offset: Number(mimicA.offset ?? 0) } : null,
      lower: lim.lower !== undefined ? Number(lim.lower) : null,
      upper: lim.upper !== undefined ? Number(lim.upper) : null,
      velocity: lim.velocity !== undefined ? Number(lim.velocity) : null,
      effort: lim.effort !== undefined ? Number(lim.effort) : null,
    });
  }
  return { links, joints };
}

/* ----------------------------------------------------------------- parse STL */

async function readStl(path, scale = 1, raw = false) {
  const buf = await readFile(path);
  if (buf.length < 84) throw new Error(`${path}: too small for binary STL`);
  const n = buf.readUInt32LE(80);
  const expected = 84 + n * 50;
  if (buf.length !== expected) throw new Error(`${path}: ${n} tris needs ${expected} bytes, file is ${buf.length}`);
  const out = new Float32Array(n * 18); // 3 verts * (pos3 + normal3)
  let o = 0;
  for (let i = 0; i < n; i++) {
    const base = 84 + i * 50;
    const nx = buf.readFloatLE(base), ny = buf.readFloatLE(base + 4), nz = buf.readFloatLE(base + 8);
    const nrm = raw ? [nx, ny, nz] : zUpToYUp(nx, ny, nz);
    for (let v = 0; v < 3; v++) {
      const p = base + 12 + v * 12;
      const p0 = [buf.readFloatLE(p) * scale, buf.readFloatLE(p + 4) * scale, buf.readFloatLE(p + 8) * scale];
      const pos = raw ? p0 : zUpToYUp(p0[0], p0[1], p0[2]);
      out[o++] = pos[0]; out[o++] = pos[1]; out[o++] = pos[2];
      out[o++] = nrm[0]; out[o++] = nrm[1]; out[o++] = nrm[2];
    }
  }
  return { triCount: n, data: out };
}

/* --------------------------------------------------------------------- main */

const xml = await readFile(join(MODEL_DIR, 'urdf', 'agibot_a2_dof12.urdf'), 'utf8');
const mjcf = await readFile(join(MODEL_DIR, 'mjcf', 'agibot_a2_dof12.mjcf'), 'utf8').catch(() => '');
const { links, joints } = parseUrdf(xml);

// Guard against silent parser regressions (the vendor file mixes `name="x"`
// and `name = "x"` spacing).
const rawLinks = (xml.match(/<link\b/g) || []).length;
const rawJoints = (xml.match(/<joint\b/g) || []).length;
if (links.length !== rawLinks || joints.length !== rawJoints) {
  throw new Error(`parse mismatch: links ${links.length}/${rawLinks}, joints ${joints.length}/${rawJoints}`);
}
// Which joints the vendor MJCF actually actuates.
const actuated = new Set([...mjcf.matchAll(/<motor\b([^>]*)\/?>/g)].map((m) => attr(m[1], 'joint')).filter(Boolean));
if (actuated.size !== 12) throw new Error(`expected 12 actuators in the vendor MJCF, parsed ${actuated.size}`);

/* ----------------------------------------------------------------- hand merge */
// Inspire RH56DFX (MIT) from model/hand, mounted at the A2 hand links.
// Hand parts keep their native frame; the mount matrix is expressed in the
// Y-up model frame and is NOT run through the Z-up conversion.
const HAND_ENABLED = process.env.HAND !== '0';
const HAND_SCALE = 1.32;
// 180° about the finger axis: palms face inward, fingers still point down.
// (The first mount left the palm normal pointing away from the body.)
const HAND_MOUNT = { rpy: [0, -Math.PI / 2, 0], xyz: [0, 0.065, 0] };
let handMeta = null;
const handXml = await readFile(join(MODEL_DIR, 'hand', 'rh56_hand.urdf'), 'utf8').catch(() => null);
if (HAND_ENABLED && handXml) {
  const hand = parseUrdf(handXml);
  for (const l of links) if (l.name === 'left_hand' || l.name === 'right_hand') l.mesh = null;

  const channelSpec = [
    ['thumb_pos_0', 'thumb_1'], ['thumb_pos_1', 'thumb_2'],
    ['index_pos', 'index_1'], ['middle_pos', 'middle_1'],
    ['ring_pos', 'ring_1'], ['pinky_pos', 'little_1'],
  ];
  const channels = {};
  const mimic = {};

  for (const side of ['left', 'right']) {
    const prefix = side === 'left' ? 'lh_' : 'rh_';
    const re = new RegExp(`^${side}_`);

    for (const l of hand.links) {
      if (!re.test(l.name) || !l.mesh) continue;
      links.push({ ...l, name: prefix + l.name, mesh: `hand/meshes/${l.mesh}`, scale: HAND_SCALE, hand: true });
    }
    for (const j of hand.joints) {
      if (!re.test(j.name)) continue;
      const nj = {
        ...j,
        name: prefix + j.name,
        parent: prefix + j.parent,
        child: prefix + j.child,
        xyz: j.xyz.map((v) => v * HAND_SCALE),
        hand: true,
      };
      joints.push(nj);
      if (j.mimic) {
        mimic[nj.name] = {
          joint: prefix + j.mimic.joint,
          multiplier: j.mimic.multiplier,
          offset: j.mimic.offset,
        };
      }
    }
    joints.push({
      name: `${prefix}mount`,
      type: 'fixed',
      parent: `${side}_hand`,
      child: `${prefix}${side}_hand_base`,
      xyz: HAND_MOUNT.xyz,
      rpy: HAND_MOUNT.rpy,
      axis: null, lower: null, upper: null, velocity: null, effort: null,
      hand: false, mount: true, mimic: null,
    });

    for (const [channel, suffix] of channelSpec) {
      const j = hand.joints.find((x) => x.name === `${side}_${suffix}_joint`);
      if (!j) continue;
      channels[channel] = channels[channel] || {};
      channels[channel][side] = {
        joint: `${prefix}${side}_${suffix}_joint`,
        min: j.lower ?? 0,
        max: j.upper ?? 1,
      };
    }
  }
  handMeta = { source: 'Inspire RH56DFX (MIT)', scale: HAND_SCALE, channels, mimic };
}

// A joint is movable in our twin if it is revolute, or fixed-but-limited
// (the 16 arm/head joints the vendor models without actuation).
for (const j of joints) {
  j.movable = j.type === 'revolute' || (j.type === 'fixed' && j.lower !== null && j.upper !== null);
  j.actuated = actuated.has(j.name);
  j.addedBeyondVendor = j.type === 'fixed' && j.movable;
}

// Convert joint origins to Y-up and precompute the origin matrix.
for (const j of joints) {
  if (j.hand || j.mount) {
    // Hand coordinates and the mount stay in the frames they were authored in.
    j.originMatrix = multiply(translation(j.xyz[0], j.xyz[1], j.xyz[2]), rpyMatrix(j.rpy[0], j.rpy[1], j.rpy[2]));
    j.axisYUp = j.axis;
    j.xyzYUp = j.xyz;
    continue;
  }
  const [x, y, z] = j.xyz;
  const p = zUpToYUp(x, y, z);
  const R = rpyMatrix(j.rpy[0], j.rpy[1], j.rpy[2]);
  // Rotate the origin matrix into Y-up space: C * T * R * C^-1
  const C = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]; // (x,y,z)->(x,z,-y)
  const Ct = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
  // Translation is already in Y-up; only the rotation must be conjugated,
  // otherwise the Z-up->Y-up rotation is applied to the offset twice.
  const rYUp = multiply(multiply(C, R), Ct);
  j.originMatrix = multiply(translation(p[0], p[1], p[2]), rYUp);
  j.axisYUp = j.axis ? zUpToYUp(j.axis[0], j.axis[1], j.axis[2]) : null;
  // Measured correction: the left shoulder's second joint is the abduction
  // axis, not the assumed pitch. `direction_upper left` drove the hand 30 cm
  // behind; local -X moves it out and up instead.
  if (j.name === 'idx20_right_arm_joint1') {
    // Right joint 1 is the shoulder abduction, not an arm roll. With the rest
    // offsets corrected it drives +1.41 rad in direction_upper right.
    // Slight forward cant: direction_upper right lifts out and in front, not
    // purely in the frontal plane.
    j.axisYUp = [-0.3, 0, 0.954];
  }
  if (j.name === 'idx21_right_arm_joint2') {
    // Right joint frames are mirrored: its positive direction is abduction, so
    // the vendor's negative-heavy range must be swapped to allow the lift.
    j.lower = -0.523598767;
    j.upper = 1.658062761;
  }
  if (j.name === 'idx14_left_arm_joint2') {
    j.axisYUp = [-1, 0, 0];
    // Negating the axis negates the angle: mirror the limits too, otherwise the
    // model clamps at the old -0.524 rad and can never lift to the robot's pose.
    const lo = j.lower, hi = j.upper;
    j.lower = -hi; j.upper = -lo;
  }
  j.xyzYUp = p;
}

// Load meshes and merge into one buffer: position xyz + normal xyz, 6 floats.
// Per-link draw ranges carry the link identity, so no per-vertex index is needed.
const linkByName = new Map(links.map((l) => [l.name, l]));
const drawables = links.filter((l) => l.mesh);
const ranges = [];
const chunks = [];
let vertexOffset = 0;
let totalTris = 0;

for (const link of drawables) {
  const path = link.mesh.startsWith('hand/')
    ? join(MODEL_DIR, link.mesh)
    : join(MODEL_DIR, 'meshes', link.mesh);
  const { triCount, data } = await readStl(path, link.scale || 1, Boolean(link.hand));
  totalTris += triCount;
  chunks.push(data);
  ranges.push({ link: link.name, first: vertexOffset, count: data.length / 6, tris: triCount });
  vertexOffset += data.length / 6;
}

const linkIndex = new Map(drawables.map((l, i) => [l.name, i]));
const merged = new Float32Array(vertexOffset * 6);
let cursor = 0;
for (const c of chunks) { merged.set(c, cursor); cursor += c.length; }

// Per-link AABB (Y-up), for the box fallback and for sanity checks.
for (const r of ranges) {
  const link = linkByName.get(r.link);
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < r.count; v++) {
    const o = (r.first + v) * 6;
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], merged[o + k]);
      mx[k] = Math.max(mx[k], merged[o + k]);
    }
  }
  link.aabb = { min: mn, max: mx };
  link.vertexRange = { first: r.first, count: r.count };
}

// Topological joint order (parents before children).
const byChild = new Map(joints.map((j) => [j.child, j]));
const ordered = [];
const seen = new Set();
const visit = (linkName) => {
  const j = byChild.get(linkName);
  if (!j || seen.has(j.name)) return;
  seen.add(j.name);
  visit(j.parent);
  ordered.push(j);
};
for (const j of joints) visit(j.child);

/* --------------------------------------------------------- FK verification */

const zeroPose = {};
const fk = (pose, baseY) => {
  const mats = new Map([['base_link', translation(0, baseY, 0)]]);
  const radius = (axis, q) => {
    const [x, y, z] = axis;
    const c = Math.cos(q), s = Math.sin(q), t = 1 - c;
    return [
      t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
      t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
      t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
      0, 0, 0, 1,
    ];
  };
  for (const j of ordered) {
    const parent = mats.get(j.parent);
    if (!parent) continue;
    let m = multiply(parent, j.originMatrix);
    if (j.movable) m = multiply(m, radius(j.axisYUp, pose[j.name] ?? 0));
    mats.set(j.child, m);
  }
  return mats;
};

const BASE_Y = 1.0228; // vendor MJCF scene placement
const zeroMats = fk(zeroPose, BASE_Y);
const worldOf = (name) => zeroMats.get(name) ?? null;
let loY = Infinity, hiY = -Infinity, loX = Infinity, hiX = -Infinity;
for (const r of ranges) {
  const m = zeroMats.get(r.link);
  if (!m) continue;
  const link = linkByName.get(r.link);
  for (const cx of [link.aabb.min[0], link.aabb.max[0]]) {
    for (const cy of [link.aabb.min[1], link.aabb.max[1]]) {
      for (const cz of [link.aabb.min[2], link.aabb.max[2]]) {
        const wx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
        const wy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
        loY = Math.min(loY, wy); hiY = Math.max(hiY, wy);
        loX = Math.min(loX, wx); hiX = Math.max(hiX, wx);
      }
    }
  }
}

const totalMass = links.reduce((s, l) => s + l.mass, 0);
const movable = joints.filter((j) => j.movable);

const model = {
  meta: {
    name: 'luka-a2-estimated-twin',
    generatedBy: 'tools/build-model.mjs',
    generatedAt: new Date().toISOString(),
    provenance: {
      repo: 'https://github.com/MDeanH/luka-a2-ultra-model',
      vendor: 'Link-U-OS/rl_training @ 8bf8fd8bbcc38d09731d1b15f894ce7388b08c3d',
      vendorModel: 'agibot_a2_dof12 (A2 T2D0 candidate)',
      license: 'Mulan PSL v2',
      status: 'ESTIMATED — not measured on Luka, not validated against his motion',
      hand: handMeta ? 'Inspire RH56DFX (MIT) mounted as an approximation' : null,
    },
    counts: {
      links: links.length,
      joints: joints.length,
      movableJoints: movable.length,
      actuatedJoints: joints.filter((j) => j.actuated).length,
      addedBeyondVendor: joints.filter((j) => j.addedBeyondVendor).length,
      triangles: totalTris,
      vertices: vertexOffset,
    },
    baseY: BASE_Y,
    zeroPose: { minY: loY, maxY: hiY, height: hiY - loY, widthX: hiX - loX },
    vendorReference: { height: 1.6913, shoulderWidth: 0.382, thigh: 0.34, shin: 0.377, weightKg: 69.344 },
    modelMassKg: totalMass,
  },
  links: links.map((l) => ({
    name: l.name,
    mesh: l.mesh,
    color: l.color,
    mass: l.mass,
    aabb: l.aabb ?? null,
    drawableIndex: linkIndex.has(l.name) ? linkIndex.get(l.name) : null,
    vertexRange: l.vertexRange ?? null,
  })),
  joints: ordered.map((j) => ({
    name: j.name,
    type: j.type,
    parent: j.parent,
    child: j.child,
    axis: j.axisYUp,
    origin: j.originMatrix,
    xyz: j.xyzYUp,
    xyzUrdf: j.xyz,
    rpy: j.rpy,
    lower: j.lower,
    upper: j.upper,
    velocity: j.velocity,
    effort: j.effort,
    movable: j.movable,
    actuated: j.actuated,
    addedBeyondVendor: j.addedBeyondVendor,
    ...(j.mimic ? { mimic: j.mimic } : {}),
  })),
  ...(handMeta ? { hand: handMeta } : {}),
};

await mkdir(OUT_DIR, { recursive: true });
await writeFile(join(OUT_DIR, 'luka.model.json'), JSON.stringify(model, null, 1));
await writeFile(join(OUT_DIR, 'luka.mesh.bin'), Buffer.from(merged.buffer));
await writeFile(
  join(OUT_DIR, 'luka.mesh.json'),
  JSON.stringify({ vertexStride: 6, vertexCount: vertexOffset, linkCount: drawables.length, ranges }, null, 1),
);

console.log('model →', join(OUT_DIR, 'luka.model.json'));
console.log(`  links ${links.length}  joints ${joints.length}  movable ${movable.length}  actuated ${joints.filter((j) => j.actuated).length}`);
console.log(`  triangles ${totalTris.toLocaleString()}  vertices ${vertexOffset.toLocaleString()}  mesh ${(merged.byteLength / 1e6).toFixed(1)} MB`);
console.log(`  total mass ${totalMass.toFixed(3)} kg   baseY ${BASE_Y}`);
console.log(`  zero pose: height ${(hiY - loY).toFixed(4)} m  (vendor ${1.6913})   minY ${loY.toFixed(4)}  maxY ${hiY.toFixed(4)}  widthX ${(hiX - loX).toFixed(4)}`);
