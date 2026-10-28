// Minimal column-major 4x4 math. No dependencies.

export const m4 = {
  identity() {
    const o = new Float32Array(16);
    o[0] = o[5] = o[10] = o[15] = 1;
    return o;
  },
  multiply(a, b, out = new Float32Array(16)) {
    // out = a * b
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4 + 0] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  },
  translation(x, y, z) {
    const o = m4.identity();
    o[12] = x; o[13] = y; o[14] = z;
    return o;
  },
  scale(x, y, z) {
    const o = m4.identity();
    o[0] = x; o[5] = y; o[10] = z;
    return o;
  },
  rotX(a) {
    const o = m4.identity(), c = Math.cos(a), s = Math.sin(a);
    o[5] = c; o[6] = s; o[9] = -s; o[10] = c;
    return o;
  },
  rotY(a) {
    const o = m4.identity(), c = Math.cos(a), s = Math.sin(a);
    o[0] = c; o[2] = -s; o[8] = s; o[10] = c;
    return o;
  },
  rotZ(a) {
    const o = m4.identity(), c = Math.cos(a), s = Math.sin(a);
    o[0] = c; o[1] = s; o[4] = -s; o[5] = c;
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    const o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f;
    o[10] = (far + near) * nf; o[11] = -1;
    o[14] = 2 * far * near * nf;
    return o;
  },
  lookAt(eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const o = m4.identity();
    o[0] = xx; o[1] = yx; o[2] = zx;
    o[4] = xy; o[5] = yy; o[6] = zy;
    o[8] = xz; o[9] = yz; o[10] = zz;
    o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    return o;
  },
  // Compose translation * rotY * rotX * rotZ * scale, writing directly into out at offset.
  composeInto(out, off, px, py, pz, rx, ry, rz, sx, sy, sz) {
    const cx = Math.cos(rx), sxx = Math.sin(rx);
    const cy = Math.cos(ry), syy = Math.sin(ry);
    const cz = Math.cos(rz), szz = Math.sin(rz);
    // R = Ry * Rx * Rz
    const r00 = cy * cz + syy * sxx * szz;
    const r01 = -cy * szz + syy * sxx * cz;
    const r02 = syy * cx;
    const r10 = cx * szz;
    const r11 = cx * cz;
    const r12 = -sxx;
    const r20 = -syy * cz + cy * sxx * szz;
    const r21 = syy * szz + cy * sxx * cz;
    const r22 = cy * cx;
    out[off + 0] = r00 * sx; out[off + 1] = r10 * sx; out[off + 2] = r20 * sx; out[off + 3] = 0;
    out[off + 4] = r01 * sy; out[off + 5] = r11 * sy; out[off + 6] = r21 * sy; out[off + 7] = 0;
    out[off + 8] = r02 * sz; out[off + 9] = r12 * sz; out[off + 10] = r22 * sz; out[off + 11] = 0;
    out[off + 12] = px; out[off + 13] = py; out[off + 14] = pz; out[off + 15] = 1;
    return out;
  },
};

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const DEG = Math.PI / 180;
