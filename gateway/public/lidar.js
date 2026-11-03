// LiDAR viewer: WebGL2 point cloud over a binary WebSocket.
//
// Two display modes:
//   live      — only the newest frame, which is what the sensor actually saw.
//   accumulate— a ring buffer of recent points, so a static room builds up.
//
// "voxel 0.1 m" snaps positions to a lattice in the vertex shader. It is a
// visual occupancy aid, not a reconstructed surface: no normals, no meshing, no
// claim that the space has been modelled beyond points.
//
// Nothing here interprets the scene.

const $ = (id) => document.getElementById(id);

if (navigator.maxTouchPoints > 0) document.documentElement.classList.add('touch');

const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem('gateway_token') || '';
const robotId = params.get('robot') || 'luka-sim';
const CAP = 400_000;              // accumulated points (ring)
const MAX_FRAME = 30_000;         // points per frame we will draw

const state = {
  ws: null,
  wsRobot: robotId,
  retry: null,
  connected: false,
  lastAt: 0,
  lastSeq: 0,
  source: '—',
  frameCount: 0,
  rateWindow: [],
  total: 0,
  head: 0,
  framePoints: 0,
  accumulate: false,
  voxel: 0,
  colour: 'height',
  pointSize: 2.4,
};

const cam = { yaw: 0.72, pitch: 0.42, dist: 9.5, target: [0, 1.15, 0] };

const glState = {
  gl: null,
  prog: null,
  gridProg: null,
  live: null,
  accum: null,
  grid: null,
  u: {},
};

function init() {
  $('robotId').textContent = robotId;
  $('hudClock').textContent = new Date().toLocaleTimeString();
  setInterval(() => { $('hudClock').textContent = new Date().toLocaleTimeString(); }, 500);
  setInterval(updateHud, 250);

  $('modeLive').addEventListener('click', () => setMode(false));
  $('modeAccum').addEventListener('click', () => setMode(true));
  $('colour').addEventListener('change', (e) => { state.colour = e.target.value; draw(); });
  $('pointSize').addEventListener('input', (e) => { state.pointSize = Number(e.target.value); draw(); });
  $('voxel').addEventListener('change', (e) => { state.voxel = e.target.checked ? 0.1 : 0; draw(); });
  $('reset').addEventListener('click', () => { cam.yaw = 0.72; cam.pitch = 0.42; cam.dist = 9.5; draw(); });
  $('clear').addEventListener('click', clearAccumulation);

  glState.gl = $('view').getContext('webgl2', { antialias: true, alpha: false });
  if (!glState.gl) {
    $('empty').hidden = false;
    $('emptyText').textContent = 'WebGL2 is not available in this browser.';
    return;
  }
  try {
    setupGl();
    bindPointer();
  } catch (err) {
    state.fatal = err.message;
    $('empty').hidden = false;
    $('emptyText').textContent = `WebGL setup failed: ${err.message}`;
    $('sourceTag').textContent = 'renderer error';
    return;
  }
  connect();
  requestAnimationFrame(loop);

  // Debug seam: lets an operator (or a test) force a draw and read the buffer.
  window.__lidar = { draw, glState, state, cam };
}

/* -------------------------------- websocket ------------------------------ */

function connect() {
  disconnect();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const ws = new WebSocket(`${proto}//${location.host}/api/v1/robots/${robotId}/lidar${q}`);
  ws.binaryType = 'arraybuffer';
  state.ws = ws;

  ws.onopen = () => {
    state.connected = true;
    $('linkDot').dataset.state = 'up';
    $('note').textContent = '';
  };
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'hello') {
          state.source = msg.lidar?.source ?? 'waiting';
          if (msg.lidar) $('sourceTag').textContent = 'stale snapshot';
        }
      } catch { /* non-fatal */ }
      return;
    }
    handleFrame(event.data);
  };
  ws.onclose = () => {
    state.connected = false;
    $('linkDot').dataset.state = 'down';
    if (state.wsRobot !== robotId) return;
    state.retry = setTimeout(connect, 1800);
  };
  ws.onerror = () => { $('linkDot').dataset.state = 'down'; };
}

function disconnect() {
  clearTimeout(state.retry);
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
  state.ws = null;
}

function handleFrame(buffer) {
  const view = new DataView(buffer);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, headerLen)));
  // Copy: the ArrayBuffer must be 4-byte aligned, and the socket may reuse it.
  const start = 4 + headerLen;
  const bytes = new Uint8Array(buffer, start);
  const points = new Float32Array(bytes.slice().buffer);

  state.lastAt = performance.now();
  state.lastSeq = header.seq;
  state.source = header.source;
  state.framePoints = header.count;
  state.frameCount++;
  state.rateWindow.push(state.lastAt);
  if (state.rateWindow.length > 40) state.rateWindow.shift();

  $('sourceTag').textContent = header.source.includes('simulated') ? 'simulated source' : header.source;
  $('empty').hidden = true;

  uploadFrame(points);
  if (state.accumulate) addAccumulation(points);
  draw();
}

/* --------------------------------- webgl --------------------------------- */

function setupGl() {
  const gl = glState.gl;

  glState.prog = program(gl, VERT, FRAG);
  glState.gridProg = program(gl, GRID_VERT, GRID_FRAG);

  glState.u = {
    viewProj: gl.getUniformLocation(glState.prog, 'uViewProj'),
    pointSize: gl.getUniformLocation(glState.prog, 'uPointSize'),
    voxel: gl.getUniformLocation(glState.prog, 'uVoxel'),
    colour: gl.getUniformLocation(glState.prog, 'uColour'),
    eye: gl.getUniformLocation(glState.prog, 'uEye'),
    gridViewProj: gl.getUniformLocation(glState.gridProg, 'uViewProj'),
  };

  glState.live = makeBuffer(gl, MAX_FRAME * 3 * 4, true);
  glState.accum = makeBuffer(gl, CAP * 3 * 4, true);
  const grid = gridVertices();
  glState.gridCount = grid.length / 3;
  glState.grid = makeBuffer(gl, 0, false);
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.grid);
  gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.clearColor(0.035, 0.045, 0.055, 1);
}

function program(gl, vsSource, fsSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || 'program link failed');
  }
  return p;
}

function compile(gl, type, source) {
  const s = gl.createShader(type);
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
  }
  return s;
}

function makeBuffer(gl, byteLength, dynamic) {
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, byteLength, dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
  return b;
}

function uploadFrame(points) {
  const gl = glState.gl;
  if (!gl) return;
  const count = Math.min(points.length / 3, MAX_FRAME);
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.live);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, points.subarray(0, count * 3));
  state.framePoints = count;
}

function addAccumulation(points) {
  const gl = glState.gl;
  if (!gl) return;
  const n = Math.min(points.length / 3, CAP);
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.accum);

  const head = state.head;
  if (head + n > CAP) {
    const first = CAP - head;
    gl.bufferSubData(gl.ARRAY_BUFFER, head * 12, points.subarray(0, first * 3));
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, points.subarray(first * 3, n * 3));
    state.head = n - first;
  } else {
    gl.bufferSubData(gl.ARRAY_BUFFER, head * 12, points.subarray(0, n * 3));
    state.head = (head + n) % CAP;
  }
  state.total = Math.min(CAP, state.total + n);
}

function clearAccumulation() {
  const gl = glState.gl;
  if (!gl) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.accum);
  gl.bufferData(gl.ARRAY_BUFFER, CAP * 12, gl.DYNAMIC_DRAW);
  state.total = 0;
  state.head = 0;
  draw();
}

function draw() {
  const gl = glState.gl;
  if (!gl) return;

  resizeCanvas();
  const width = gl.canvas.width;
  const height = gl.canvas.height;
  gl.viewport(0, 0, width, height);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const eye = eyePosition();
  const viewProj = multiply(perspective(Math.PI / 4, width / height, 0.05, 120), lookAt(eye, cam.target, [0, 1, 0]));

  // Grid first, dim, behind everything.
  gl.useProgram(glState.gridProg);
  gl.uniformMatrix4fv(glState.u.gridViewProj, false, viewProj);
  gl.bindBuffer(gl.ARRAY_BUFFER, glState.grid);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.LINES, 0, glState.gridCount);

  // Points.
  gl.useProgram(glState.prog);
  gl.uniformMatrix4fv(glState.u.viewProj, false, viewProj);
  gl.uniform1f(glState.u.pointSize, state.pointSize * (window.devicePixelRatio > 1 ? 1.4 : 1));
  gl.uniform1f(glState.u.voxel, state.voxel);
  gl.uniform3f(glState.u.eye, eye[0], eye[1], eye[2]);
  gl.uniform1i(glState.u.colour, state.colour === 'height' ? 0 : state.colour === 'distance' ? 1 : 2);

  gl.disable(gl.DEPTH_TEST);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

  const buffer = state.accumulate ? glState.accum : glState.live;
  const count = state.accumulate ? state.total : state.framePoints;
  if (count > 0) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.POINTS, 0, count);
  }
  gl.enable(gl.DEPTH_TEST);
}

function loop() {
  requestAnimationFrame(loop);
  if (state.accumulate) draw();
}

/* --------------------------------- camera -------------------------------- */

function eyePosition() {
  const cp = Math.cos(cam.pitch);
  return [
    cam.target[0] + cam.dist * cp * Math.sin(cam.yaw),
    cam.target[1] + cam.dist * Math.sin(cam.pitch),
    cam.target[2] + cam.dist * cp * Math.cos(cam.yaw),
  ];
}

function bindPointer() {
  const canvas = $('view');
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    cam.yaw -= (e.clientX - lastX) * 0.006;
    cam.pitch = Math.max(-0.15, Math.min(1.45, cam.pitch + (e.clientY - lastY) * 0.005));
    lastX = e.clientX;
    lastY = e.clientY;
    draw();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.dist = Math.max(2.5, Math.min(30, cam.dist * (1 + e.deltaY * 0.001)));
    draw();
  }, { passive: false });
}

/* ---------------------------------- hud ---------------------------------- */

function updateHud() {
  const now = performance.now();
  const age = state.lastAt ? now - state.lastAt : Infinity;
  const stale = age > 1500;

  $('source').textContent = state.source;
  $('framePts').textContent = state.framePoints ? state.framePoints.toLocaleString() : '—';
  $('totalPts').textContent = state.accumulate ? state.total.toLocaleString() : `${Math.round(state.framePoints).toLocaleString()} (live)`;
  $('age').textContent = Number.isFinite(age) ? `${Math.round(age)} ms${stale ? ' · stale' : ''}` : '—';
  $('age').style.color = stale ? 'var(--warn)' : '';

  const w = state.rateWindow;
  if (w.length >= 2) {
    const hz = (w.length - 1) / ((w[w.length - 1] - w[0]) / 1000);
    $('rate').textContent = `${hz.toFixed(1)} Hz`;
  } else {
    $('rate').textContent = '—';
  }

  if (state.fatal) {
    $('empty').hidden = false;
    $('emptyText').textContent = `WebGL setup failed: ${state.fatal}`;
    return;
  }
  if (!state.lastAt) {
    $('empty').hidden = false;
    $('emptyText').textContent = `Waiting for frames from "${robotId}".`;
  } else {
    $('empty').hidden = true;
    if (stale) $('sourceTag').textContent = 'stale';
  }
}

function setMode(accumulate) {
  state.accumulate = accumulate;
  $('modeLive').setAttribute('aria-pressed', String(!accumulate));
  $('modeAccum').setAttribute('aria-pressed', String(accumulate));
  $('totalPts').textContent = accumulate ? state.total.toLocaleString() : '—';
  draw();
}

/* ---------------------------------- math --------------------------------- */

function resizeCanvas() {
  const gl = glState.gl;
  const canvas = gl.canvas;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, center, up) {
  let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
  let len = Math.hypot(z0, z1, z2) || 1;
  z0 /= len; z1 /= len; z2 /= len;

  let x0 = up[1] * z2 - up[2] * z1;
  let x1 = up[2] * z0 - up[0] * z2;
  let x2 = up[0] * z1 - up[1] * z0;
  len = Math.hypot(x0, x1, x2) || 1;
  x0 /= len; x1 /= len; x2 /= len;

  const y0 = z1 * x2 - z2 * x1;
  const y1 = z2 * x0 - z0 * x2;
  const y2 = z0 * x1 - z1 * x0;

  return new Float32Array([
    x0, y0, z0, 0,
    x1, y1, z1, 0,
    x2, y2, z2, 0,
    -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]),
    -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]),
    -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]),
    1,
  ]);
}

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[i * 4 + j] =
        a[0 * 4 + j] * b[i * 4 + 0] +
        a[1 * 4 + j] * b[i * 4 + 1] +
        a[2 * 4 + j] * b[i * 4 + 2] +
        a[3 * 4 + j] * b[i * 4 + 3];
    }
  }
  return out;
}

function gridVertices() {
  const verts = [];
  const half = 6;
  for (let i = -half; i <= half; i++) {
    const major = i === 0;
    if (!major) {
      verts.push(-half, 0, i, half, 0, i);
      verts.push(i, 0, -half, i, 0, half);
    }
  }
  // Axes, slightly above the grid to avoid z-fighting.
  verts.push(-half, 0.002, 0, half, 0.002, 0);
  verts.push(0, 0.002, -half, 0, 0.002, half);
  return new Float32Array(verts);
}

/* -------------------------------- shaders -------------------------------- */

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
uniform float uPointSize;
uniform float uVoxel;
uniform int uColour;
uniform vec3 uEye;
out vec3 vColor;

void main() {
  vec3 p = aPos;
  if (uVoxel > 0.0) p = floor(p / uVoxel + 0.5) * uVoxel;
  gl_Position = uViewProj * vec4(p, 1.0);
  float h = clamp(p.y / 3.0, 0.0, 1.0);
  float dist = clamp(length(p - uEye) / 14.0, 0.0, 1.0);
  vec3 byHeight = mix(vec3(0.16, 0.45, 0.95), vec3(1.0, 0.82, 0.36), pow(h, 0.7));
  vec3 byDist = mix(vec3(0.3, 0.95, 0.85), vec3(0.25, 0.35, 0.95), dist);
  vec3 plain = vec3(0.62, 0.86, 1.0);
  vColor = uColour == 0 ? byHeight : (uColour == 1 ? byDist : plain);
  gl_PointSize = uPointSize * (uVoxel > 0.0 ? 1.7 : 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = dot(c, c);
  if (d > 0.25) discard;
  outColor = vec4(vColor, 0.9 - d * 1.4);
}`;

const GRID_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 uViewProj;
void main() { gl_Position = uViewProj * vec4(aPos, 1.0); }`;

const GRID_FRAG = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(0.32, 0.38, 0.46, 0.35); }`;

init();
