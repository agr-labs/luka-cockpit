// Studio PBR-inspired renderer for Luka's Upper-Body Sim:
//   - WebGPU (WGSL, 4x MSAA) with seamless WebGL2 (GLSL ES 3.0) fallback
//   - Live AgiBot A2 Ultra material skinning:
//       * Glossy obsidian-black head dome (head_link02) with animated OLED face visor
//       * Matte carbon-black neck / LiDAR collar (head_link01)
//       * Two-tone ceramic pearl-white & anodized gunmetal torso (base_link) + real chest logo.stl
//       * Alternating white arm shells, dark metallic actuators, machined silver wrist rods
//       * Brushed silver-white Inspire RH56 hands with matte black tactile grip pads
//   - 3-point studio lighting + clearcoat specular highlights + upper-body pedestal ring

import { m4 } from './mathx.js';

const FLOATS_PER_VERTEX = 6; // pos(3) + normal(3)

/** Parse a binary STL file into interleaved Y-up (pos3, normal3) Float32Array. */
export function parseBinaryStlToYUp(arrayBuffer, scale = 1) {
  const view = new DataView(arrayBuffer);
  if (arrayBuffer.byteLength < 84) throw new Error('STL too small');
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (arrayBuffer.byteLength !== expected) throw new Error(`STL length mismatch (${arrayBuffer.byteLength} vs ${expected})`);
  const out = new Float32Array(triCount * 18);
  let o = 0;
  for (let i = 0; i < triCount; i++) {
    const base = 84 + i * 50;
    const nx = view.getFloat32(base, true);
    const ny = view.getFloat32(base + 4, true);
    const nz = view.getFloat32(base + 8, true);
    // Z-up -> Y-up: (x, y, z) -> (x, z, -y)
    const rnx = nx, rny = nz, rnz = -ny;
    for (let v = 0; v < 3; v++) {
      const p = base + 12 + v * 12;
      const x = view.getFloat32(p, true) * scale;
      const y = view.getFloat32(p + 4, true) * scale;
      const z = view.getFloat32(p + 8, true) * scale;
      out[o++] = x;
      out[o++] = z;
      out[o++] = -y;
      out[o++] = rnx;
      out[o++] = rny;
      out[o++] = rnz;
    }
  }
  return { triCount, data: out, vertexCount: triCount * 3 };
}

/** Build a sleek circular studio pedestal / telemetry ring beneath Luka's upper body. */
export function buildPedestalMesh(y = 0.84, innerR = 0.24, outerR = 0.36, segs = 64) {
  const out = [];
  const pushTri = (a, b, c, n) => {
    out.push(a[0], a[1], a[2], n[0], n[1], n[2]);
    out.push(b[0], b[1], b[2], n[0], n[1], n[2]);
    out.push(c[0], c[1], c[2], n[0], n[1], n[2]);
  };
  const h = 0.022;
  // Center disc + outer bevel ring
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);

    // Inner dark cap
    pushTri([0, y, 0], [c1 * innerR, y, s1 * innerR], [c0 * innerR, y, s0 * innerR], [0, 1, 0]);
    // Outer flat rim
    const p0i = [c0 * innerR, y, s0 * innerR];
    const p1i = [c1 * innerR, y, s1 * innerR];
    const p0o = [c0 * outerR, y - 0.004, s0 * outerR];
    const p1o = [c1 * outerR, y - 0.004, s1 * outerR];
    pushTri(p0i, p1i, p1o, [0, 1, 0]);
    pushTri(p0i, p1o, p0o, [0, 1, 0]);
    // Side skirt
    const b0 = [c0 * outerR, y - h, s0 * outerR];
    const b1 = [c1 * outerR, y - h, s1 * outerR];
    const nx = (c0 + c1) * 0.5, nz = (s0 + s1) * 0.5;
    pushTri(p0o, p1o, b1, [nx, 0, nz]);
    pushTri(p0o, b1, b0, [nx, 0, nz]);
  }
  return new Float32Array(out);
}

/**
 * Live AgiBot A2 Ultra material palette per link name.
 * Returns { color: [r,g,b,a], material: [roughness, metalness, clearcoat, partKind] }
 *   partKind 0 = standard hardware
 *   partKind 1 = glossy obsidian black head dome + animated OLED visor (head_link02)
 *   partKind 2 = two-tone live AgiBot torso shell (base_link)
 *   partKind 3 = chest emblem (logo.stl)
 */
export function agibotMaterialForLink(name) {
  // Glossy obsidian black head dome (real-life Luka black head + interactive OLED face)
  if (name === 'head_link02') {
    return { color: [0.032, 0.036, 0.044, 1], material: [0.11, 0.30, 0.98, 1.0] };
  }
  // Matte carbon-black neck + Mid-360 LiDAR collar
  if (name === 'head_link01') {
    return { color: [0.075, 0.084, 0.102, 1], material: [0.42, 0.55, 0.25, 0.0] };
  }
  // Sculpted two-tone AgiBot chest/torso shell
  if (name === 'base_link') {
    return { color: [0.91, 0.93, 0.96, 1], material: [0.26, 0.12, 0.55, 2.0] };
  }
  // Chest AgiBot emblem
  if (name === 'chest_logo') {
    return { color: [0.12, 0.15, 0.20, 1], material: [0.18, 0.85, 0.70, 3.0] };
  }
  // Upper-body studio pedestal
  if (name === 'studio_pedestal') {
    return { color: [0.11, 0.14, 0.18, 1], material: [0.35, 0.65, 0.35, 0.0] };
  }
  // Shoulder inner housing + elbow actuators + wrist gimbal (anodized dark charcoal/black)
  if (
    /arm_link01$/.test(name) ||
    /arm_link04$/.test(name) ||
    /arm_link06$/.test(name) ||
    /arm_link07$/.test(name) ||
    /wrist_motor_/.test(name)
  ) {
    return { color: [0.11, 0.125, 0.152, 1], material: [0.36, 0.68, 0.30, 0.0] };
  }
  // Outer shoulder deltoid cap, upper arm shell, forearm shell (ceramic AgiBot pearl white)
  if (/arm_link02$/.test(name) || /arm_link03$/.test(name) || /arm_link05$/.test(name)) {
    return { color: [0.90, 0.925, 0.955, 1], material: [0.25, 0.10, 0.55, 0.0] };
  }
  // Exposed wrist actuator pushrods (machined steel/titanium)
  if (/wrist_rod_/.test(name)) {
    return { color: [0.74, 0.78, 0.84, 1], material: [0.18, 0.90, 0.40, 0.0] };
  }
  // Inspire RH56 dexterous hands: black tactile grip pads & palms vs brushed silver-white alloy fingers
  if (name.startsWith('lh_') || name.startsWith('rh_')) {
    if (/(palm|pad|rubber|tip)/.test(name)) {
      return { color: [0.09, 0.10, 0.12, 1], material: [0.68, 0.08, 0.08, 0.0] };
    }
    return { color: [0.80, 0.83, 0.87, 1], material: [0.28, 0.48, 0.38, 0.0] };
  }
  // Legs (shown only if full-body toggle is enabled): AgiBot silver-white thigh/shin shells + dark hip/ankle joints
  if (/(hip_pitch|tarsus)$/.test(name)) {
    return { color: [0.88, 0.90, 0.94, 1], material: [0.28, 0.12, 0.45, 0.0] };
  }
  return { color: [0.14, 0.16, 0.19, 1], material: [0.42, 0.60, 0.20, 0.0] };
}

export function isLowerBodyLink(name) {
  return /^(left|right)_(hip_|tarsus|toe_)/.test(name);
}

/* ------------------------------------------------------------------ shared */

class BaseStudioRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ranges = [];
    this.visible = [];
    this.grid = null;
    this.camera = { eye: [1.42, 1.38, 0.18], target: [0, 1.31, 0], fov: 38 };
    this.clear = [0.022, 0.028, 0.038, 1];
    this.fx = { time: 0, speechLevel: 0, stateMode: 0, blink: 0, eyeX: 0, eyeY: 0 };
  }

  setRobotMesh(interleaved, ranges) {
    this.vertexData = interleaved;
    this.ranges = ranges;
    this.visible = ranges.map(() => true);
  }

  setVisibleMask(mask) {
    this.visible = mask;
  }

  setGridMesh(interleaved) {
    this.grid = { data: interleaved };
  }

  setVisorFx({ time = 0, speechLevel = 0, stateMode = 0, blink = 0, eyeX = 0, eyeY = 0 }) {
    this.fx.time = time;
    this.fx.speechLevel = speechLevel;
    this.fx.stateMode = stateMode;
    this.fx.blink = blink;
    this.fx.eyeX = eyeX;
    this.fx.eyeY = eyeY;
  }

  updateCameraFromOrbit(azim, elev, dist, target) {
    const ce = Math.cos(elev);
    this.camera.eye = [
      target[0] + dist * ce * Math.sin(azim),
      target[1] + dist * Math.sin(elev),
      target[2] + dist * ce * Math.cos(azim),
    ];
    this.camera.target = target;
  }

  viewProj(w, h) {
    const proj = m4.perspective((this.camera.fov * Math.PI) / 180, w / Math.max(h, 1), 0.04, 80);
    const view = m4.lookAt(this.camera.eye, this.camera.target, [0, 1, 0]);
    return m4.multiply(proj, view);
  }
}

/* ------------------------------------------------------------------ WebGL2 */

const GLSL_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vNormal;
out vec3 vWorld;
out vec3 vLocal;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  mat3 nm = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz);
  vNormal = normalize(nm * aNormal);
  vWorld = wp.xyz;
  vLocal = aPos;
  gl_Position = uViewProj * wp;
}`;

const GLSL_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec3 vLocal;
uniform vec3 uEye;
uniform vec4 uColor;
uniform vec4 uMaterial; // roughness, metalness, clearcoat, partKind
uniform vec4 uFx;       // time, speechLevel, stateMode, blink
uniform vec4 uGaze;     // eyeX (+right), eyeY (+up), 0, 0
out vec4 outColor;

vec3 stateAccent(float mode) {
  if (mode > 3.5) return vec3(0.20, 0.90, 0.62); // mirror tracking emerald
  if (mode > 2.5) return vec3(0.18, 0.88, 0.98); // speaking cyan
  if (mode > 1.5) return vec3(0.54, 0.56, 1.00); // thinking / Trellis violet
  if (mode > 0.5) return vec3(1.00, 0.74, 0.22); // listening amber
  return vec3(0.26, 0.84, 0.96);                 // idle ice-cyan
}

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uEye - vWorld);
  float ndotv = max(dot(N, V), 0.001);

  vec3 albedo = uColor.rgb;
  float rough = clamp(uMaterial.x, 0.06, 0.95);
  float metal = clamp(uMaterial.y, 0.0, 1.0);
  float coat = clamp(uMaterial.z, 0.0, 1.0);
  float kind = uMaterial.w;
  vec3 emissive = vec3(0.0);
  vec3 accent = stateAccent(uFx.z);

  // Live AgiBot two-tone torso skinning (base_link / body.stl)
  if (kind > 1.5 && kind < 2.5) {
    bool isWaist = vLocal.y < 0.055;
    bool isCollar = vLocal.y > 0.402;
    bool isSideSocket = (abs(vLocal.z) > 0.122 && vLocal.y > 0.23 && vLocal.y < 0.41);
    bool isFrontSensorBay = (vLocal.x > 0.042 && vLocal.y > 0.205 && vLocal.y < 0.262 && abs(vLocal.z) < 0.058);
    bool isBackSpine = (vLocal.x < -0.155 && abs(vLocal.z) < 0.062 && vLocal.y > 0.08 && vLocal.y < 0.36);

    if (isWaist || isCollar || isSideSocket || isFrontSensorBay || isBackSpine) {
      albedo = vec3(0.075, 0.085, 0.105);
      rough = 0.34;
      metal = 0.58;
      coat = 0.25;
    }
    // Subtle chest telemetry status line beneath sensor bay
    if (vLocal.x > 0.052 && abs(vLocal.y - 0.205) < 0.0035 && abs(vLocal.z) < 0.046) {
      float pulse = 0.55 + 0.45 * sin(uFx.x * 2.4) + uFx.y * 0.6;
      emissive += accent * pulse * 0.85;
    }
  }

  // Chest logo metallic highlight (logo.stl)
  if (kind > 2.5) {
    emissive += accent * (0.14 + uFx.y * 0.28);
  }

  // Glossy black head + animated OLED face visor (head_link02)
  if (kind > 0.5 && kind < 1.5) {
    bool inVisor = (vLocal.x > 0.078 && abs(vLocal.y) < 0.064 && vLocal.z > -0.072 && vLocal.z < 0.042);
    if (inVisor) {
      albedo = vec3(0.014, 0.018, 0.024);
      rough = 0.07;
      metal = 0.18;
      coat = 1.0;

      // Visor 2D coordinates: u = left/right (vLocal.y), v = up/down (-vLocal.z so +v is up)
      vec2 uv = vec2(vLocal.y, -vLocal.z);

      // Subtle visor bezel rim
      float bezel = abs(sdRoundBox(uv - vec2(0.0, 0.015), vec2(0.056, 0.044), 0.020));
      if (bezel < 0.0018) {
        emissive += accent * 0.18;
      }

      // Expressive blinking OLED eyes with subtle lateral/vertical gaze lead
      float blinkScale = max(0.12, 1.0 - uFx.w * 0.88);
      float eyeH = 0.0115 * blinkScale * (1.0 + uFx.y * 0.22);
      float eyeW = 0.0092;
      vec2 eyeShift = vec2(-clamp(uGaze.x, -1.0, 1.0) * 0.0095, clamp(uGaze.y, -1.0, 1.0) * 0.0075);
      vec2 leftEye = uv - (vec2(-0.024, 0.024) + eyeShift);
      vec2 rightEye = uv - (vec2(0.024, 0.024) + eyeShift);
      float dL = sdRoundBox(leftEye, vec2(eyeW, eyeH), min(eyeW, eyeH) * 0.85);
      float dR = sdRoundBox(rightEye, vec2(eyeW, eyeH), min(eyeW, eyeH) * 0.85);
      float eyeCore = smoothstep(0.0022, -0.0005, min(dL, dR));
      float eyeHalo = exp(-max(min(dL, dR), 0.0) * 140.0) * 0.42;
      emissive += accent * (eyeCore * 1.45 + eyeHalo);

      // Voice waveform / listening indicator bar below eyes
      float waveX = uv.x;
      float waveMask = step(abs(waveX), 0.032);
      float freq = sin(waveX * 190.0 + uFx.x * 11.0) * cos(waveX * 95.0 - uFx.x * 7.0);
      float amp = 0.0014 + uFx.y * 0.0095 * (0.45 + 0.55 * abs(freq)) + (uFx.z > 0.5 && uFx.z < 2.5 ? 0.0018 * abs(sin(waveX * 120.0 - uFx.x * 5.0)) : 0.0);
      float dWave = abs(uv.y - (-0.009)) - amp;
      float waveGlow = smoothstep(0.0024, -0.0004, dWave) * waveMask * smoothstep(0.034, 0.022, abs(waveX));
      float speechBright = 0.28 + uFx.y * 1.35 + (uFx.z > 0.5 ? 0.28 : 0.0);
      emissive += accent * waveGlow * speechBright;
    }
  }

  // 3-point studio lighting + studio softbox clearcoat reflections
  vec3 Lkey  = normalize(vec3(0.52, 0.86, 0.44));
  vec3 Lfill = normalize(vec3(-0.68, 0.36, -0.46));
  vec3 Lrim  = normalize(vec3(-0.28, 0.48, 0.85));

  float diffKey  = max(dot(N, Lkey), 0.0);
  float diffFill = max(dot(N, Lfill), 0.0);
  float diffRim  = max(dot(N, Lrim), 0.0);

  // Studio hemisphere environment bounce
  vec3 hemi = mix(vec3(0.08, 0.10, 0.13), vec3(0.38, 0.43, 0.50), 0.5 + 0.5 * N.y);

  // Specular highlights (Blinn-Phong approximating GGX roughness)
  float shininess = mix(140.0, 12.0, rough);
  float specKey  = pow(max(dot(N, normalize(Lkey + V)), 0.0), shininess);
  float specFill = pow(max(dot(N, normalize(Lfill + V)), 0.0), shininess * 0.6);

  // Clearcoat overhead softbox sheen (makes the black head read as real glossy polycarbonate!)
  vec3 R = reflect(-V, N);
  float softbox = smoothstep(0.52, 0.92, R.y) * 0.42 + pow(max(dot(N, normalize(Lkey + V)), 0.0), 180.0) * 1.15;
  float fresnel = pow(1.0 - ndotv, 4.0);

  vec3 specTint = mix(vec3(1.0), albedo, metal);
  vec3 diffuse = albedo * (1.0 - metal * 0.65) * (hemi + diffKey * vec3(1.05, 1.02, 0.98) + diffFill * vec3(0.32, 0.42, 0.56));
  vec3 specular = specTint * (specKey * 0.68 + specFill * 0.20) * (1.15 - rough * 0.7);
  vec3 clearcoatTerm = vec3(0.92, 0.96, 1.0) * (softbox * 0.45 + fresnel * 0.52) * coat;
  vec3 rimLight = mix(vec3(0.30, 0.62, 0.82), accent, 0.35) * pow(1.0 - ndotv, 3.2) * (0.28 + diffRim * 0.35);

  vec3 color = diffuse + specular + clearcoatTerm + rimLight + emissive;
  // Soft ACES-like filmic rolloff
  color = color / (color + vec3(0.85));
  color = pow(max(color, vec3(0.0)), vec3(0.92));

  outColor = vec4(color, uColor.a);
}`;

class WebGL2StudioRenderer extends BaseStudioRenderer {
  kind = 'webgl2';

  async init() {
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, GLSL_VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, GLSL_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    for (const u of ['uViewProj', 'uModel', 'uEye', 'uColor', 'uMaterial', 'uFx', 'uGaze']) {
      this[u] = gl.getUniformLocation(prog, u);
    }

    this.vao = gl.createVertexArray();
    this.vbo = gl.createBuffer();
    this.gridVao = gl.createVertexArray();
    this.gridBuf = gl.createBuffer();

    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return this;
  }

  _upload(vao, buffer, data) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, FLOATS_PER_VERTEX * 4, 12);
    gl.bindVertexArray(null);
  }

  setRobotMesh(interleaved, ranges) {
    super.setRobotMesh(interleaved, ranges);
    if (this.gl && interleaved) this._upload(this.vao, this.vbo, interleaved);
  }

  setGridMesh(interleaved) {
    super.setGridMesh(interleaved);
    if (this.gl && interleaved) this._upload(this.gridVao, this.gridBuf, interleaved);
  }

  draw(matrices, colors, materials) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(this.clear[0], this.clear[1], this.clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj(w, h));
    gl.uniform3fv(this.uEye, this.camera.eye);
    gl.uniform4f(this.uFx, this.fx.time, this.fx.speechLevel, this.fx.stateMode, this.fx.blink);
    gl.uniform4f(this.uGaze, this.fx.eyeX, this.fx.eyeY, 0, 0);

    if (this.grid) {
      gl.depthMask(false);
      gl.uniformMatrix4fv(this.uModel, false, m4.identity());
      gl.uniform4f(this.uColor, 0.14, 0.22, 0.30, 0.30);
      gl.uniform4f(this.uMaterial, 0.85, 0.1, 0.0, 0.0);
      gl.bindVertexArray(this.gridVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.grid.data.length / FLOATS_PER_VERTEX);
      gl.depthMask(true);
    }

    gl.bindVertexArray(this.vao);
    for (let i = 0; i < this.ranges.length; i++) {
      if (this.visible[i] === false) continue;
      const r = this.ranges[i];
      gl.uniformMatrix4fv(this.uModel, false, matrices.subarray(i * 16, i * 16 + 16));
      gl.uniform4fv(this.uColor, colors.subarray(i * 4, i * 4 + 4));
      gl.uniform4fv(this.uMaterial, materials.subarray(i * 4, i * 4 + 4));
      gl.drawArrays(gl.TRIANGLES, r.first, r.count);
    }
    gl.bindVertexArray(null);
  }
}

/* ------------------------------------------------------------------ WebGPU */

const WGSL = `
struct Frame {
  viewProj : mat4x4<f32>,
  eye : vec4<f32>,
  fx : vec4<f32>,
  gaze : vec4<f32>,
};
struct Link {
  model : mat4x4<f32>,
  color : vec4<f32>,
  material : vec4<f32>,
};

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<uniform> link : Link;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) n : vec3<f32>,
  @location(1) w : vec3<f32>,
  @location(2) l : vec3<f32>,
};

@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) normal : vec3<f32>) -> VSOut {
  let wp = link.model * vec4<f32>(pos, 1.0);
  let nm = mat3x3<f32>(link.model[0].xyz, link.model[1].xyz, link.model[2].xyz);
  var o : VSOut;
  o.pos = frame.viewProj * wp;
  o.n = normalize(nm * normal);
  o.w = wp.xyz;
  o.l = pos;
  return o;
}

fn stateAccent(mode : f32) -> vec3<f32> {
  if (mode > 3.5) { return vec3<f32>(0.20, 0.90, 0.62); }
  if (mode > 2.5) { return vec3<f32>(0.18, 0.88, 0.98); }
  if (mode > 1.5) { return vec3<f32>(0.54, 0.56, 1.00); }
  if (mode > 0.5) { return vec3<f32>(1.00, 0.74, 0.22); }
  return vec3<f32>(0.26, 0.84, 0.96);
}

fn sdRoundBox(p : vec2<f32>, b : vec2<f32>, r : f32) -> f32 {
  let q = abs(p) - b + vec2<f32>(r, r);
  return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

@fragment
fn fs(i : VSOut) -> @location(0) vec4<f32> {
  let N = normalize(i.n);
  let V = normalize(frame.eye.xyz - i.w);
  let ndotv = max(dot(N, V), 0.001);

  var albedo = link.color.rgb;
  var rough = clamp(link.material.x, 0.06, 0.95);
  var metal = clamp(link.material.y, 0.0, 1.0);
  var coat = clamp(link.material.z, 0.0, 1.0);
  let kind = link.material.w;
  var emissive = vec3<f32>(0.0, 0.0, 0.0);
  let accent = stateAccent(frame.fx.z);

  // Live AgiBot two-tone torso skinning (base_link / body.stl)
  if (kind > 1.5 && kind < 2.5) {
    let isWaist = i.l.y < 0.055;
    let isCollar = i.l.y > 0.402;
    let isSideSocket = (abs(i.l.z) > 0.122 && i.l.y > 0.23 && i.l.y < 0.41);
    let isFrontSensorBay = (i.l.x > 0.042 && i.l.y > 0.205 && i.l.y < 0.262 && abs(i.l.z) < 0.058);
    let isBackSpine = (i.l.x < -0.155 && abs(i.l.z) < 0.062 && i.l.y > 0.08 && i.l.y < 0.36);

    if (isWaist || isCollar || isSideSocket || isFrontSensorBay || isBackSpine) {
      albedo = vec3<f32>(0.075, 0.085, 0.105);
      rough = 0.34;
      metal = 0.58;
      coat = 0.25;
    }
    if (i.l.x > 0.052 && abs(i.l.y - 0.205) < 0.0035 && abs(i.l.z) < 0.046) {
      let pulse = 0.55 + 0.45 * sin(frame.fx.x * 2.4) + frame.fx.y * 0.6;
      emissive = emissive + accent * pulse * 0.85;
    }
  }

  // Chest logo metallic accent
  if (kind > 2.5) {
    emissive = emissive + accent * (0.14 + frame.fx.y * 0.28);
  }

  // Glossy obsidian black head + animated OLED face visor (head_link02)
  if (kind > 0.5 && kind < 1.5) {
    let inVisor = (i.l.x > 0.078 && abs(i.l.y) < 0.064 && i.l.z > -0.072 && i.l.z < 0.042);
    if (inVisor) {
      albedo = vec3<f32>(0.014, 0.018, 0.024);
      rough = 0.07;
      metal = 0.18;
      coat = 1.0;

      let uv = vec2<f32>(i.l.y, -i.l.z);
      let bezel = abs(sdRoundBox(uv - vec2<f32>(0.0, 0.015), vec2<f32>(0.056, 0.044), 0.020));
      if (bezel < 0.0018) {
        emissive = emissive + accent * 0.18;
      }

      let blinkScale = max(0.12, 1.0 - frame.fx.w * 0.88);
      let eyeH = 0.0115 * blinkScale * (1.0 + frame.fx.y * 0.22);
      let eyeW = 0.0092;
      let eyeShift = vec2<f32>(-clamp(frame.gaze.x, -1.0, 1.0) * 0.0095, clamp(frame.gaze.y, -1.0, 1.0) * 0.0075);
      let dL = sdRoundBox(uv - (vec2<f32>(-0.024, 0.024) + eyeShift), vec2<f32>(eyeW, eyeH), min(eyeW, eyeH) * 0.85);
      let dR = sdRoundBox(uv - (vec2<f32>(0.024, 0.024) + eyeShift), vec2<f32>(eyeW, eyeH), min(eyeW, eyeH) * 0.85);
      let dEye = min(dL, dR);
      let eyeCore = smoothstep(0.0022, -0.0005, dEye);
      let eyeHalo = exp(-max(dEye, 0.0) * 140.0) * 0.42;
      emissive = emissive + accent * (eyeCore * 1.45 + eyeHalo);

      let waveX = uv.x;
      let waveMask = step(abs(waveX), 0.032);
      let freq = sin(waveX * 190.0 + frame.fx.x * 11.0) * cos(waveX * 95.0 - frame.fx.x * 7.0);
      let activeIdle = select(0.0, 0.0018 * abs(sin(waveX * 120.0 - frame.fx.x * 5.0)), frame.fx.z > 0.5 && frame.fx.z < 2.5);
      let amp = 0.0014 + frame.fx.y * 0.0095 * (0.45 + 0.55 * abs(freq)) + activeIdle;
      let dWave = abs(uv.y - (-0.009)) - amp;
      let waveGlow = smoothstep(0.0024, -0.0004, dWave) * waveMask * smoothstep(0.034, 0.022, abs(waveX));
      let speechBright = 0.28 + frame.fx.y * 1.35 + select(0.0, 0.28, frame.fx.z > 0.5);
      emissive = emissive + accent * waveGlow * speechBright;
    }
  }

  let Lkey  = normalize(vec3<f32>(0.52, 0.86, 0.44));
  let Lfill = normalize(vec3<f32>(-0.68, 0.36, -0.46));
  let Lrim  = normalize(vec3<f32>(-0.28, 0.48, 0.85));

  let diffKey  = max(dot(N, Lkey), 0.0);
  let diffFill = max(dot(N, Lfill), 0.0);
  let diffRim  = max(dot(N, Lrim), 0.0);

  let hemi = mix(vec3<f32>(0.08, 0.10, 0.13), vec3<f32>(0.38, 0.43, 0.50), 0.5 + 0.5 * N.y);

  let shininess = mix(140.0, 12.0, rough);
  let specKey  = pow(max(dot(N, normalize(Lkey + V)), 0.0), shininess);
  let specFill = pow(max(dot(N, normalize(Lfill + V)), 0.0), shininess * 0.6);

  let R = reflect(-V, N);
  let softbox = smoothstep(0.52, 0.92, R.y) * 0.42 + pow(max(dot(N, normalize(Lkey + V)), 0.0), 180.0) * 1.15;
  let fresnel = pow(1.0 - ndotv, 4.0);

  let specTint = mix(vec3<f32>(1.0, 1.0, 1.0), albedo, metal);
  let diffuse = albedo * (1.0 - metal * 0.65) * (hemi + diffKey * vec3<f32>(1.05, 1.02, 0.98) + diffFill * vec3<f32>(0.32, 0.42, 0.56));
  let specular = specTint * (specKey * 0.68 + specFill * 0.20) * (1.15 - rough * 0.7);
  let clearcoatTerm = vec3<f32>(0.92, 0.96, 1.0) * (softbox * 0.45 + fresnel * 0.52) * coat;
  let rimLight = mix(vec3<f32>(0.30, 0.62, 0.82), accent, 0.35) * pow(1.0 - ndotv, 3.2) * (0.28 + diffRim * 0.35);

  var c = diffuse + specular + clearcoatTerm + rimLight + emissive;
  c = c / (c + vec3<f32>(0.85, 0.85, 0.85));
  c = pow(max(c, vec3<f32>(0.0, 0.0, 0.0)), vec3<f32>(0.92, 0.92, 0.92));

  return vec4<f32>(c, link.color.a);
}
`;

class WebGPUStudioRenderer extends BaseStudioRenderer {
  kind = 'webgpu';

  async init() {
    if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
    this.device = device;
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw new Error('webgpu context unavailable');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: 'opaque' });

    this.frameBuf = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.linkStride = 256;
    this.linkCapacity = 0;

    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: FLOATS_PER_VERTEX * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: 4 },
    });

    this.frameGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.frameBuf, size: 112 } }],
    });
    return this;
  }

  _ensureLinks(n) {
    if (n <= this.linkCapacity) return;
    this.linkCapacity = n;
    this.linkBuf?.destroy();
    this.linkBuf = this.device.createBuffer({
      size: n * this.linkStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const layout = this.pipeline.getBindGroupLayout(1);
    this.linkGroups = Array.from({ length: n }, (_, i) =>
      this.device.createBindGroup({
        layout,
        entries: [{ binding: 0, resource: { buffer: this.linkBuf, offset: i * this.linkStride, size: 96 } }],
      }));
  }

  setRobotMesh(interleaved, ranges) {
    super.setRobotMesh(interleaved, ranges);
    this.vertexBuf?.destroy();
    this.vertexBuf = this.device.createBuffer({
      size: interleaved.byteLength + 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuf, 0, interleaved);
    this._ensureLinks(ranges.length);
  }

  setGridMesh(interleaved) {
    super.setGridMesh(interleaved);
    this.gridBuf?.destroy();
    this.gridBuf = this.device.createBuffer({
      size: interleaved.byteLength + 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.gridBuf, 0, interleaved);

    this.gridUniformBuf?.destroy();
    this.gridUniformBuf = this.device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const u = new Float32Array(24);
    u.set(m4.identity(), 0);
    u.set([0.14, 0.22, 0.30, 0.30], 16);
    u.set([0.85, 0.1, 0.0, 0.0], 20);
    this.device.queue.writeBuffer(this.gridUniformBuf, 0, u);
    this.gridGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.gridUniformBuf, size: 96 } }],
    });
  }

  resize(w, h) {
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    this.depthTex?.destroy();
    this.msaaTex?.destroy();
    this.depthTex = this.device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.msaaTex = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  draw(matrices, colors, materials) {
    const w = this.canvas.width, h = this.canvas.height;
    this.resize(w, h);
    this._ensureLinks(this.ranges.length);

    const frame = new Float32Array(28);
    frame.set(this.viewProj(w, h), 0);
    frame.set([this.camera.eye[0], this.camera.eye[1], this.camera.eye[2], 1], 16);
    frame.set([this.fx.time, this.fx.speechLevel, this.fx.stateMode, this.fx.blink], 20);
    frame.set([this.fx.eyeX, this.fx.eyeY, 0, 0], 24);
    this.device.queue.writeBuffer(this.frameBuf, 0, frame);

    if (this.ranges.length) {
      const stride = this.linkStride / 4;
      const slots = new Float32Array(this.ranges.length * stride);
      for (let i = 0; i < this.ranges.length; i++) {
        const base = i * stride;
        slots.set(matrices.subarray(i * 16, i * 16 + 16), base);
        slots.set(colors.subarray(i * 4, i * 4 + 4), base + 16);
        slots.set(materials.subarray(i * 4, i * 4 + 4), base + 20);
      }
      this.device.queue.writeBuffer(this.linkBuf, 0, slots);
    }

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.msaaTex.createView(),
        resolveTarget: this.context.getCurrentTexture().createView(),
        clearValue: { r: this.clear[0], g: this.clear[1], b: this.clear[2], a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.frameGroup);

    if (this.grid && this.gridGroup) {
      pass.setBindGroup(1, this.gridGroup);
      pass.setVertexBuffer(0, this.gridBuf);
      pass.draw(this.grid.data.length / FLOATS_PER_VERTEX);
    }
    if (this.ranges.length) {
      pass.setVertexBuffer(0, this.vertexBuf);
      for (let i = 0; i < this.ranges.length; i++) {
        if (this.visible[i] === false) continue;
        const r = this.ranges[i];
        pass.setBindGroup(1, this.linkGroups[i]);
        pass.draw(r.count, 1, r.first);
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}

export async function createStudioRenderer(canvas, preference = 'auto') {
  const wanted = new URLSearchParams(location.search).get('renderer') || preference;
  if (wanted !== 'webgl' && wanted !== 'webgl2') {
    try {
      const r = new WebGPUStudioRenderer(canvas);
      await r.init();
      return r;
    } catch (err) {
      console.warn('[upper-renderer] WebGPU unavailable, falling back to WebGL2:', err.message);
    }
  }
  const r = new WebGL2StudioRenderer(canvas);
  await r.init();
  return r;
}
