// Synthetic finger geometry.
//
// The vendor A2 model has NO finger joints or finger meshes: each hand is a single
// STL. So the twin cannot show real finger articulation from the model. These boxes
// are an approximation, positioned from the hand link's bounding box, driven by the
// hand-state telemetry (six channels per hand, 0–2000).
//
// They are labelled synthetic everywhere they appear, and they never feed anything
// but the renderer — no finger value is ever sent to the robot.

const FINGER_FLOATS = 6; // position xyz + normal xyz

/** Box centred at origin, 36 vertices (12 triangles), pos+normal interleaved. */
function box(w, h, d) {
  const hx = w / 2, hy = h / 2, hz = d / 2;
  const faces = [
    { n: [0, 0, 1], v: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], v: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
    { n: [1, 0, 0], v: [[hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz]] },
    { n: [-1, 0, 0], v: [[-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz]] },
    { n: [0, 1, 0], v: [[-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz]] },
    { n: [0, -1, 0], v: [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz]] },
  ];
  const out = [];
  const tri = (p, q, r, n) => {
    for (const v of [p, q, r]) out.push(v[0], v[1], v[2], n[0], n[1], n[2]);
  };
  for (const f of faces) {
    const [a, b, c, d2] = f.v;
    tri(a, b, c, f.n);
    tri(a, c, d2, f.n);
  }
  return out;
}

/**
 * Finger layout in the hand link frame.
 * The hand AABB is x −0.119…0.044, y −0.010…0.200, z −0.026…0.029, so fingers
 * extend along +Y from a knuckle line near y≈0.15. Values are approximate by
 * construction; they are not from the vendor model.
 */
const LAYOUT = [
  { key: 'thumb',  x:  0.020, y: 0.055, w: 0.020, h: 0.018, len: 0.050, splay: 0.55 },
  { key: 'index',  x: -0.078, y: 0.150, w: 0.016, h: 0.015, len: 0.058, splay: 0.06 },
  { key: 'middle', x: -0.046, y: 0.158, w: 0.016, h: 0.015, len: 0.062, splay: 0.02 },
  { key: 'ring',   x: -0.014, y: 0.152, w: 0.015, h: 0.014, len: 0.056, splay: -0.02 },
  { key: 'pinky',  x:  0.014, y: 0.140, w: 0.014, h: 0.013, len: 0.046, splay: -0.07 },
];

export const FINGER_KEYS = ['thumb_pos_0', 'thumb_pos_1', 'index_pos', 'middle_pos', 'ring_pos', 'pinky_pos'];

/**
 * Build finger boxes for both hands.
 * Returns interleaved vertices plus per-finger drawable definitions. Each finger is
 * drawn as its own drawable so it can carry its own matrix.
 */
export function buildFingers() {
  const defs = [];
  const chunks = [];
  let vertexOffset = 0;

  for (const side of ['left', 'right']) {
    for (const f of LAYOUT) {
      const verts = box(f.w, f.len, f.h);
      // shift so the box extends from the knuckle forward (+Y) instead of centring
      for (let i = 0; i < verts.length; i += FINGER_FLOATS) {
        verts[i + 1] += f.len / 2;
      }
      const mirror = side === 'right' ? -1 : 1;
      chunks.push({
        link: `${side}_finger_${f.key}`,
        first: vertexOffset,
        count: verts.length / FINGER_FLOATS,
        data: verts,
        def: {
          side,
          key: f.key,
          link: `${side}_finger_${f.key}`,
          // offset in the hand frame; mirrored across X for the right hand
          offset: [f.x * mirror, f.y, 0],
          splay: f.splay * mirror,
          length: f.len,
        },
      });
      vertexOffset += verts.length / FINGER_FLOATS;
    }
  }

  const merged = new Float32Array(vertexOffset * FINGER_FLOATS);
  let cursor = 0;
  for (const c of chunks) {
    merged.set(c.data, cursor);
    cursor += c.data.length;
    defs.push(c.def);
  }
  const ranges = chunks.map((c) => ({ link: c.link, first: c.first, count: c.count }));
  return { verts: merged, ranges, defs };
}

/**
 * Telemetry 0–2000 → curl in radians.
 *
 * `reference` is the value captured at the reference pose: with a reference the
 * finger renders straight there and curls only as the hand closes. Without one,
 * the raw 0–2000 range is used, which is honest but arbitrary — the sensor's
 * mid-scale is not "open".
 */
export function curlFromHandValue(value, reference = null, maxRad = 1.5) {
  if (typeof value !== 'number' || !isFinite(value)) return 0;
  const base = typeof reference === 'number' ? reference : 0;
  const t = (value - base) / 2000;
  return Math.max(0, Math.min(1, t)) * maxRad;
}

/** Which telemetry channel drives which finger. Thumb takes the mean of its two. */
export function handValueForKey(handPos, key) {
  if (!handPos) return null;
  if (key === 'thumb') {
    const a = handPos.thumb_pos_0, b = handPos.thumb_pos_1;
    const vals = [a, b].filter((v) => typeof v === 'number');
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  }
  const v = handPos[`${key}_pos`];
  return typeof v === 'number' ? v : null;
}
