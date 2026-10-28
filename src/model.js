// Twin model: forward kinematics over the generated AgiBot A2 joint tree.
//
// The tree comes from model/generated/luka.model.json, produced by
// tools/build-model.mjs from the vendored URDF. Coordinates are Y-up here;
// the URDF is Z-up and converted at build time.

const identity = () => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};

function mul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

/** Rodrigues rotation about a unit axis, written into out (column-major). */
function axisAngle(out, axis, q) {
  const [x, y, z] = axis;
  const c = Math.cos(q), s = Math.sin(q), t = 1 - c;
  out[0] = t * x * x + c;      out[1] = t * x * y + s * z;  out[2] = t * x * z - s * y;  out[3] = 0;
  out[4] = t * x * y - s * z;  out[5] = t * y * y + c;      out[6] = t * y * z + s * x;  out[7] = 0;
  out[8] = t * x * z + s * y;  out[9] = t * y * z - s * x;  out[10] = t * z * z + c;     out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}

export class TwinModel {
  constructor(json) {
    this.meta = json.meta;
    this.links = json.links;
    this.joints = json.joints;
    this.baseY = json.meta.baseY;
    this.children = new Map();       // link -> joint
    for (const j of this.joints) this.children.set(j.child, j);
    this.drawables = this.links.filter((l) => l.drawableIndex !== null);
    this.drawableIndex = new Map(this.drawables.map((l) => [l.name, l.drawableIndex]));
    this.movable = this.joints.filter((j) => j.movable);
    this.movableNames = this.movable.map((j) => j.name);

    // Scratch matrices, one per link, reused every frame.
    this._tmpA = identity();
    this._tmpB = identity();
    this._rot = identity();
    this.matrices = new Map();
    for (const l of this.links) this.matrices.set(l.name, identity());
    this.flat = new Float32Array(this.drawables.length * 16);
    this.jointOrder = this._orderedJoints();
  }

  _orderedJoints() {
    // Joints already arrive parent-first from the generator; verify anyway.
    const ordered = [];
    const done = new Set(['base_link']);
    let remaining = [...this.joints];
    while (remaining.length) {
      const next = remaining.filter((j) => done.has(j.parent));
      if (!next.length) throw new Error(`orphaned joints: ${remaining.map((j) => j.name).join(', ')}`);
      for (const j of next) { ordered.push(j); done.add(j.child); }
      remaining = remaining.filter((j) => !done.has(j.child));
    }
    return ordered;
  }

  limits(name) {
    const j = this.joints.find((x) => x.name === name);
    if (!j) return null;
    return { lower: j.lower, upper: j.upper, velocity: j.velocity, actuated: j.actuated, movable: j.movable };
  }

  /** Zero pose: every movable joint at 0 (the vendor model's zero pose). */
  zeroPose() {
    const p = {};
    for (const j of this.movable) p[j.name] = 0;
    return p;
  }

  clampPose(pose) {
    const out = {};
    for (const j of this.movable) {
      let v = pose[j.name] ?? 0;
      if (j.lower !== null) v = Math.max(v, j.lower);
      if (j.upper !== null) v = Math.min(v, j.upper);
      out[j.name] = v;
    }
    return out;
  }

  /**
   * Forward kinematics. Returns this.matrices (link -> Float32Array 16) and fills
   * this.flat with the drawable links' matrices in drawable-index order.
   */
  forward(pose, root = { x: 0, y: 0, z: 0, yaw: 0 }) {
    const base = this.matrices.get('base_link');
    const cy = Math.cos(root.yaw), sy = Math.sin(root.yaw);
    base[0] = cy; base[1] = 0; base[2] = -sy; base[3] = 0;
    base[4] = 0; base[5] = 1; base[6] = 0; base[7] = 0;
    base[8] = sy; base[9] = 0; base[10] = cy; base[11] = 0;
    base[12] = root.x; base[13] = this.baseY + root.y; base[14] = root.z; base[15] = 1;

    for (const j of this.jointOrder) {
      const parent = this.matrices.get(j.parent);
      const out = this.matrices.get(j.child);
      mul(out, parent, j.origin);
      if (j.movable) {
        const q = pose[j.name] ?? 0;
        if (q !== 0) {
          axisAngle(this._rot, j.axis, q);
          // out is aliased with the first operand, so accumulate into a scratch
          // matrix before writing back.
          mul(this._tmpA, out, this._rot);
          out.set(this._tmpA);
        }
      }
    }

    for (const l of this.drawables) {
      const m = this.matrices.get(l.name);
      this.flat.set(m, l.drawableIndex * 16);
    }
    return { matrices: this.matrices, flat: this.flat };
  }

  /** World position of a link frame. */
  position(name) {
    const m = this.matrices.get(name);
    return m ? [m[12], m[13], m[14]] : null;
  }
}

let cached = null;

export async function loadModel(url = './model/generated/luka.model.json') {
  if (cached) return cached;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model fetch failed: ${res.status} ${url}`);
  const json = await res.json();
  cached = new TwinModel(json);
  return cached;
}
