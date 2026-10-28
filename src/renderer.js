// Mesh renderer for the Luka twin: WebGPU (preferred) with a WebGL2 fallback.
//
// One pipeline, one draw per link. Vertex layout is interleaved
// (position xyz, normal xyz) and each link is a contiguous vertex range of the
// merged mesh buffer produced by tools/build-model.mjs.

import { m4 } from './mathx.js';

const FLOATS_PER_VERTEX = 6;

/* ------------------------------------------------------------------ shared */

export class BaseRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ranges = [];
    this.grid = null;
    this.camera = { eye: [2.6, 1.6, 3.2], target: [0, 1.0, 0], fov: 42 };
    this.clear = [0.016, 0.020, 0.026, 1];
  }

  setRobotMesh(interleaved, ranges) {
    this.vertexData = interleaved;
    this.ranges = ranges;
  }

  setGridMesh(interleaved) {
    this.grid = { data: interleaved };
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
    const proj = m4.perspective((this.camera.fov * Math.PI) / 180, w / h, 0.05, 100);
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
out vec3 vNormal; out vec3 vWorld;
void main() {
  vec4 wp = uModel * vec4(aPos, 1.0);
  mat3 nm = mat3(uModel[0].xyz, uModel[1].xyz, uModel[2].xyz);
  vNormal = normalize(nm * aNormal);
  vWorld = wp.xyz;
  gl_Position = uViewProj * wp;
}`;

const GLSL_FS = `#version 300 es
precision highp float;
in vec3 vNormal; in vec3 vWorld;
uniform vec3 uEye; uniform vec3 uLight; uniform vec4 uColor;
out vec4 outColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 L = normalize(uLight);
  float diff = max(dot(n, L), 0.0);
  vec3 V = normalize(uEye - vWorld);
  float rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  vec3 hemi = mix(vec3(0.06,0.08,0.11), vec3(0.30,0.36,0.44), 0.5 + 0.5 * n.y);
  vec3 c = uColor.rgb * (hemi + diff * vec3(0.95));
  c += vec3(0.25,0.72,0.85) * rim * 0.45;
  outColor = vec4(c, uColor.a);
}`;

export class WebGL2Renderer extends BaseRenderer {
  kind = 'webgl2';

  async init() {
    const gl = this.canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, GLSL_VS));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, GLSL_FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    for (const u of ['uViewProj', 'uModel', 'uEye', 'uLight', 'uColor']) this[u] = gl.getUniformLocation(prog, u);

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
    if (this.gl) this._upload(this.gridVao, this.gridBuf, interleaved);
  }

  draw(matrices, colors, alphaMul = 1) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clearColor(this.clear[0], this.clear[1], this.clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uViewProj, false, this.viewProj(w, h));
    gl.uniform3fv(this.uEye, this.camera.eye);
    gl.uniform3fv(this.uLight, [0.42, 0.80, 0.38]);

    if (this.grid) {
      gl.depthMask(false);
      gl.uniformMatrix4fv(this.uModel, false, m4.identity());
      gl.uniform4fv(this.uColor, [0.22, 0.30, 0.38, 0.40]);
      gl.bindVertexArray(this.gridVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.grid.data.length / FLOATS_PER_VERTEX);
      gl.depthMask(true);
    }

    gl.bindVertexArray(this.vao);
    for (let i = 0; i < this.ranges.length; i++) {
      const r = this.ranges[i];
      gl.uniformMatrix4fv(this.uModel, false, matrices.subarray(i * 16, i * 16 + 16));
      const c = colors.subarray(i * 4, i * 4 + 4);
      gl.uniform4fv(this.uColor, [c[0], c[1], c[2], c[3] * alphaMul]);
      gl.drawArrays(gl.TRIANGLES, r.first, r.count);
    }
    gl.bindVertexArray(null);
  }
}

/* ------------------------------------------------------------------ WebGPU */

const WGSL = `
struct Frame { viewProj : mat4x4<f32>, eye : vec4<f32>, light : vec4<f32> };
struct Link  { model : mat4x4<f32>, color : vec4<f32> };

@group(0) @binding(0) var<uniform> frame : Frame;
@group(1) @binding(0) var<uniform> link : Link;

struct VSOut {
  @builtin(position) pos : vec4<f32>,
  @location(0) n : vec3<f32>,
  @location(1) w : vec3<f32>,
};

@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) normal : vec3<f32>) -> VSOut {
  let wp = link.model * vec4<f32>(pos, 1.0);
  let nm = mat3x3<f32>(link.model[0].xyz, link.model[1].xyz, link.model[2].xyz);
  var o : VSOut;
  o.pos = frame.viewProj * wp;
  o.n = normalize(nm * normal);
  o.w = wp.xyz;
  return o;
}

@fragment
fn fs(i : VSOut) -> @location(0) vec4<f32> {
  let n = normalize(i.n);
  let L = normalize(frame.light.xyz);
  let diff = max(dot(n, L), 0.0);
  let V = normalize(frame.eye.xyz - i.w);
  let rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
  let hemi = mix(vec3<f32>(0.06, 0.08, 0.11), vec3<f32>(0.30, 0.36, 0.44), 0.5 + 0.5 * n.y);
  var c = link.color.rgb * (hemi + diff * vec3<f32>(0.95, 0.95, 0.95));
  c = c + vec3<f32>(0.25, 0.72, 0.85) * rim * 0.45;
  return vec4<f32>(c, link.color.a);
}
`;

export class WebGPURenderer extends BaseRenderer {
  kind = 'webgpu';

  async init() {
    if (!navigator.gpu) throw new Error('navigator.gpu unavailable');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    this.adapterInfo = adapter.info || {};
    const device = await adapter.requestDevice();
    this.device = device;
    this.gpuErrors = [];
    device.addEventListener('uncapturederror', (ev) => {
      const msg = ev.error?.message || String(ev.error);
      this.gpuErrors.push(msg);
      console.error('[webgpu] uncaptured error:', msg);
    });
    device.lost.then((info) => { this.lost = info; });

    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw new Error('webgpu canvas context unavailable');
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
      entries: [{ binding: 0, resource: { buffer: this.frameBuf, size: 96 } }],
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
        entries: [{ binding: 0, resource: { buffer: this.linkBuf, offset: i * this.linkStride, size: 80 } }],
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
    const u = new Float32Array(20);
    u.set(m4.identity(), 0);
    u.set([0.22, 0.30, 0.38, 0.40], 16);
    this.device.queue.writeBuffer(this.gridUniformBuf, 0, u);
    this.gridGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(1),
      entries: [{ binding: 0, resource: { buffer: this.gridUniformBuf, size: 80 } }],
    });
  }

  resize(w, h) {
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w; this.lastH = h;
    this.depthTex?.destroy(); this.msaaTex?.destroy();
    this.depthTex = this.device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.msaaTex = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  draw(matrices, colors, alphaMul = 1) {
    const w = this.canvas.width, h = this.canvas.height;
    this.resize(w, h);
    this._ensureLinks(this.ranges.length);

    const frame = new Float32Array(24);
    frame.set(this.viewProj(w, h), 0);
    frame.set([this.camera.eye[0], this.camera.eye[1], this.camera.eye[2], 1], 16);
    frame.set([0.42, 0.80, 0.38, 1], 20);
    this.device.queue.writeBuffer(this.frameBuf, 0, frame);

    if (this.ranges.length) {
      // Each link's uniform lives in its own 256-byte slot (the minimum
      // uniform-buffer offset alignment), so the CPU layout must match that
      // stride rather than packing links back to back.
      const stride = this.linkStride / 4;
      const slots = new Float32Array(this.ranges.length * stride);
      for (let i = 0; i < this.ranges.length; i++) {
        const base = i * stride;
        slots.set(matrices.subarray(i * 16, i * 16 + 16), base);
        const c = colors.subarray(i * 4, i * 4 + 4);
        slots[base + 16] = c[0];
        slots[base + 17] = c[1];
        slots[base + 18] = c[2];
        slots[base + 19] = c[3] * alphaMul;
      }
      this.device.queue.writeBuffer(this.linkBuf, 0, slots);
    }

    const enc = this.device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: this.msaaTex.createView(),
        resolveTarget: this.context.getCurrentTexture().createView(),
        clearValue: { r: this.clear[0], g: this.clear[1], b: this.clear[2], a: 1 },
        loadOp: 'clear', storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTex.createView(),
        depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store',
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
        const r = this.ranges[i];
        pass.setBindGroup(1, this.linkGroups[i]);
        pass.draw(r.count, 1, r.first);
      }
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }
}

export async function createRenderer(canvas, preference = 'auto') {
  const wanted = new URLSearchParams(location.search).get('renderer') || preference;
  let gpuError = null;
  if (wanted !== 'webgl' && wanted !== 'webgl2') {
    try {
      const r = new WebGPURenderer(canvas);
      await r.init();
      return r;
    } catch (err) {
      gpuError = err.message;
      console.warn('[renderer] WebGPU unavailable, using WebGL2:', err.message);
    }
  }
  const r = new WebGL2Renderer(canvas);
  await r.init();
  r.gpuError = gpuError;
  return r;
}
