// Small procedural geometry helpers (no dependencies).

/** 36 vertices (12 triangles) of an axis-aligned box, interleaved pos+normal. */
export function boxMesh(w, h, d, cx = 0, cy = 0, cz = 0) {
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
    for (const v of [p, q, r]) out.push(v[0] + cx, v[1] + cy, v[2] + cz, n[0], n[1], n[2]);
  };
  for (const f of faces) {
    const [a, b, c, d] = f.v;
    tri(a, b, c, f.n);
    tri(a, c, d, f.n);
  }
  return out;
}

/** Ground grid as thin boxes; returns Float32Array of interleaved vertices. */
export function buildGrid(half = 12, step = 0.25, y = -0.001) {
  const verts = [];
  const extent = half * step;
  for (let i = -half; i <= half; i++) {
    const p = i * step;
    const thick = i % 4 === 0 ? 0.012 : 0.006;
    verts.push(...boxMesh(extent * 2, 0.002, thick, 0, y, p));
    verts.push(...boxMesh(thick, 0.002, extent * 2, p, y, 0));
  }
  return new Float32Array(verts);
}
