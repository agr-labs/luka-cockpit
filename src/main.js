import { loadModel } from './model.js';
import { createRenderer } from './renderer.js';
import { buildGrid } from './geometry.js';
import { RobotLink } from './link.js';
import { SafetyController, STATE } from './safety.js';
import { Playback, RECORDINGS, loadRecording } from './a2rec.js';
import { detectEnvironment, describeEnvironment, MODES } from './env.js';
import { buildFingers, curlFromHandValue, handValueForKey } from './fingers.js';
import { ArmController, ARM_JOINTS, RATE_LIMITS, makeTransport } from './armcontrol.js';
import { clamp, damp, DEG, m4 } from './mathx.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const safety = new SafetyController();
const link = new RobotLink('');

const state = {
  model: null,
  colors: null,
  pose: {},
  target: {},
  playback: null,
  playbackIndex: -1,
  env: null,
  profile: { attested: false, feet: 'unknown', excursionDeg: 10, at: null },
  poseSource: 'operator',
  convention: localStorage.getItem('luka.convention') || 'raw',
  reference: JSON.parse(localStorage.getItem('luka.reference') || '{}'),
  referenceHands: JSON.parse(localStorage.getItem('luka.referenceHands') || '{}'),
  referenceAt: Number(localStorage.getItem('luka.referenceAt') || 0),
  poseMismatch: false,
  arm: null,
  armTransport: null,
  armSide: 'left',
  armPumping: false,
  fingers: [],
  fingerBase: 0,
  armLastRefusal: null,
  lastFrameTs: 0,
  azim: 0.62,
  elev: 0.10,
  dist: 3.1,
  drag: false,
  fps: 0,
  acc: 0,
  frames: 0,
};

let renderer = null;

const CHAIN = {
  body: [0.18, 0.82, 0.72, 1],
  head: [0.60, 0.93, 0.88, 1],
  armL: [0.32, 0.62, 1.00, 1],
  armR: [1.00, 0.62, 0.30, 1],
  hand: [1.00, 0.84, 0.42, 1],
  legL: [0.34, 0.90, 0.62, 1],
  legR: [0.64, 0.86, 0.36, 1],
  aux: [0.55, 0.60, 0.68, 1],
};

function chainOf(n) {
  if (n === 'base_link') return 'body';
  if (n.startsWith('head_')) return 'head';
  if (n.startsWith('left_hand') || n.startsWith('right_hand')) return 'hand';
  if (n.startsWith('left_wrist_') || n.startsWith('right_wrist_')) return n.includes('rod') ? 'aux' : 'hand';
  if (n.startsWith('left_arm')) return 'armL';
  if (n.startsWith('right_arm')) return 'armR';
  if (n.startsWith('left_')) return 'legL';
  if (n.startsWith('right_')) return 'legR';
  return 'aux';
}

/* ------------------------------------------------------------------- boot */

function bootMsg(text) { const el = $('bootMsg'); if (el) el.textContent = text; }
function bootBar(pct) { const el = $('bootBar'); if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`; }
function bootDone() {
  bootBar(100);
  const el = $('boot');
  if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 400); }
}

/** Fetch with byte progress, so a 21 MB mesh over a cold CDN is not a blank screen. */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const total = Number(res.headers.get('Content-Length') || 0);
  if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out.buffer;
}

function applyEnv(env) {
  document.body.dataset.env = env.mode;
  const badge = $('envBadge');
  if (badge) {
    badge.textContent = env.mode === MODES.LOCAL ? 'LOCAL' : 'SIM';
    badge.dataset.env = env.mode;
    badge.title = describeEnvironment(env);
  }
  if (env.mode === MODES.SIM) {
    const btn = $('btnLink');
    btn.disabled = true;
    btn.textContent = 'no gateway';
    btn.title = 'Live telemetry needs serve.mjs on this origin; a static build has no /api';
  }
}

async function boot() {
  state.env = await detectEnvironment();
  applyEnv(state.env);

  bootMsg('starting renderer…');
  try {
    renderer = await createRenderer(canvas);
  } catch (err) {
    fail(`Renderer failed: ${err.message}`);
    return;
  }
  $('rendererKind').textContent = renderer.kind.toUpperCase();

  bootMsg('loading model…');
  bootBar(8);
  state.model = await loadModel();
  const model = state.model;

  bootBar(20);
  const [meshJson, meshBuf] = await Promise.all([
    fetch('./model/generated/luka.mesh.json').then((r) => r.json()),
    fetchWithProgress('./model/generated/luka.mesh.bin', (got, total) => {
      const mb = (got / 1e6).toFixed(1);
      bootMsg(total ? `loading mesh · ${mb} / ${(total / 1e6).toFixed(1)} MB` : `loading mesh · ${mb} MB`);
      bootBar(total ? 20 + (got / total) * 72 : 70);
    }),
  ]);
  // The vendor model has no finger geometry, so synthetic boxes are appended to the
  // mesh buffer. They are driven by hand telemetry and never sent anywhere.
  const fingers = buildFingers();
  const statics = new Float32Array(meshBuf);
  const combined = new Float32Array(statics.length + fingers.verts.length);
  combined.set(statics, 0);
  combined.set(fingers.verts, statics.length);
  state.fingers = fingers.defs;
  state.fingerBase = meshJson.ranges.length;
  // model.flat only covers the URDF drawables; fingers live beyond it.
  state.flatAll = new Float32Array((state.fingerBase + fingers.defs.length) * 16);
  renderer.setRobotMesh(combined, [...meshJson.ranges, ...fingers.ranges]);
  renderer.setGridMesh(buildGrid(12, 0.25));
  bootBar(95);

  const byIndex = new Map(model.drawables.map((l) => [l.drawableIndex, l]));
  const total = model.drawables.length + state.fingers.length;
  state.colors = new Float32Array(total * 4);
  for (let i = 0; i < model.drawables.length; i++) {
    state.colors.set(CHAIN[chainOf(byIndex.get(i).name)], i * 4);
  }
  for (let i = 0; i < state.fingers.length; i++) {
    state.colors.set(CHAIN.hand, (model.drawables.length + i) * 4);
  }

  for (const j of model.movable) { state.pose[j.name] = 0; state.target[j.name] = 0; }

  state.armTransport = await makeTransport();
  state.arm = new ArmController(model, safety, state.armTransport, {
    excursionDeg: state.profile.excursionDeg,
  });
  $('armMode').textContent = state.armTransport.mode === 'unconfigured' ? 'NO SCHEMA' : state.armTransport.mode.toUpperCase();
  $('armMode').dataset.mode = state.armTransport.mode === 'http' ? 'live' : 'mock';

  buildJointUI();
  buildArmUI();
  renderProfile();
  buildPlaybackUI();
  wireUI();
  wireInput();
  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(frame);
  window.__cockpit = { safety, link, state, renderer, model, STATE, Playback, arm: state.arm, transport: state.armTransport, env: state.env };
  showMeta();
  bootDone();
}

function fail(msg) {
  const b = $('banner');
  b.textContent = msg;
  b.classList.add('show');
  $('rendererKind').textContent = 'FAILED';
  bootMsg(msg);
  bootBar(100);
}

function showMeta() {
  const m = state.model.meta;
  const primary = state.model.joints.filter((j) => j.movable && /^idx\d\d_[a-z]/.test(j.name)).length;
  const linkage = m.counts.movableJoints - primary;
  $('dofRead').textContent = `${primary} dof + ${linkage} linkage`;
  $('actRead').textContent = `${m.counts.actuatedJoints} actuated`;
  $('massRead').textContent = `${m.modelMassKg.toFixed(2)} kg`;
  $('heightRead').textContent = `${m.zeroPose.height.toFixed(3)} m`;
  $('triRead').textContent = `${m.counts.triangles.toLocaleString()} tris`;
  $('provenance').textContent = m.provenance.status;
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

/* ------------------------------------------------------------------ frame */

/** Apply the selected joint-convention mapping to measured telemetry. */
function applyConvention(name, value, conv = state.convention) {
  const c = conv;
  const isL2 = name === 'idx14_left_arm_joint2';
  const isR2 = name === 'idx21_right_arm_joint2';
  const isL5 = name === 'idx17_left_arm_joint5';
  const isR5 = name === 'idx24_right_arm_joint5';
  if (c === 'flip2' || c === 'flip2_5') {
    if (isL2 || isR2) return -value;
  }
  if (c === 'flip2_5') {
    if (isL5 || isR5) return -value;
  }
  if (c === 'offset2') {
    if (isL2) return value - Math.PI / 2;
    if (isR2) return value + Math.PI / 2;
  }
  return value;
}

function frame(now) {
  const dt = Math.min(0.05, (now - state.lastFrameTs) / 1000) || 0.016;
  state.lastFrameTs = now;
  safety.tickWatchdog(performance.now());

  const model = state.model;
  if (model) {
    // Priority: measured joint telemetry > recording playback > operator input.
    const live = link.jointsFresh && link.mode === 'live' ? link.joints : null;
    if (live) {
      const neck = link.neckFresh && link.mode === 'live' ? link.neck : null;
      if (neck) {
        for (const name in neck) {
          if (!(name in state.target)) continue;
          const ref = state.reference[name];
          const rel = typeof ref === 'number' ? neck[name] - ref : neck[name];
          state.target[name] = clamp(rel, -2.2, 0.5);
        }
      }
      for (const name in live) {
        if (!(name in state.target)) continue;
        const ref = state.reference[name];
        const rel = typeof ref === 'number' ? live[name] - ref : live[name];
        state.target[name] = applyConvention(name, rel);
      }
      state.poseSource = 'live';
    } else if (state.playback?.playing) {
      state.poseSource = 'playback';
    } else {
      state.poseSource = 'operator';
    }

    if (state.playback?.playing && !live) {
      state.playback.update(dt * 1000);
      const sampled = model.clampPose(state.playback.sample());
      Object.assign(state.target, sampled);
      syncSliders(sampled);
      updatePlaybackHud();
    }
    for (const j of model.movable) {
      state.pose[j.name] = damp(state.pose[j.name], state.target[j.name], 16, dt);
    }
    if (!state.armPumping) {
      state.armPumping = true;
      state.arm.step(dt)
        .then((r) => { if (r?.refused) state.armLastRefusal = r.reason; })
        .catch((err) => { state.armLastRefusal = String(err.message || err); })
        .finally(() => { state.armPumping = false; });
    }
    model.forward(state.pose, { x: 0, y: 0, z: 0, yaw: 0 });

    // Plausibility guard: the left hand belongs on the left (negative z), the
    // right on the right. If they swap, the convention is wrong — say so loudly
    // rather than rendering arms through the torso.
    if (state.poseSource === 'live') {
      const L = model.position('left_hand');
      const R = model.position('right_hand');
      const crossed = L[2] > -0.05 || R[2] < 0.05;

      // First-run geometric check: if the reported convention puts both hands on
      // the wrong side, try the alternatives and adopt the first that does not.
      // This is a geometry heuristic, not a physical calibration — it is logged
      // as such and the selector stays available.
      if (crossed && state.convention === 'raw' && !state.autoTried) {
        state.autoTried = true;
        for (const cand of ['flip2', 'flip2_5', 'offset2']) {
          const probe = { ...state.pose };
          for (const n2 in live) if (n2 in probe) probe[n2] = applyConvention(n2, live[n2], cand);
          model.forward(probe, { x: 0, y: 0, z: 0, yaw: 0 });
          const pl = model.position('left_hand'), pr = model.position('right_hand');
          if (pl[2] < -0.05 && pr[2] > 0.05) {
            state.convention = cand;
            localStorage.setItem('luka.convention', cand);
            const sel = $('convention');
            if (sel) sel.value = cand;
            safety.note(`auto-selected joint convention "${cand}" — geometric heuristic from one pose, not a calibration`, 'warn');
            break;
          }
        }
        model.forward(state.pose, { x: 0, y: 0, z: 0, yaw: 0 });
      }

      state.poseMismatch = crossed && state.convention === 'raw';
      if (crossed !== state.poseMismatchShown) {
        state.poseMismatchShown = crossed;
        if (crossed) safety.note('telemetry/model joint convention mismatch — arms cross the torso', 'critical');
      }
    } else {
      state.poseMismatch = false;
    }
    state.flatAll.set(model.flat, 0);

    // Synthetic fingers: hand matrix × knuckle offset × curl about local X.
    if (state.fingers.length && state.colors) {
      const hands = link.handsFresh && link.mode === 'live' ? link.hands : null;
      for (let i = 0; i < state.fingers.length; i++) {
        const f = state.fingers[i];
        const handMat = model.matrices.get(`${f.side}_hand`);
        if (!handMat) continue;
        const raw = hands ? handValueForKey(hands[f.side], f.key) : null;
        const refHand = state.referenceHands[f.side];
        const ref = refHand ? handValueForKey(refHand, f.key) : null;
        const curl = raw === null ? 0 : curlFromHandValue(raw, ref);
        const local = m4.multiply(
          m4.multiply(m4.translation(f.offset[0], f.offset[1], f.offset[2]), m4.rotZ(f.splay)),
          m4.rotX(curl),
        );
        const world = m4.multiply(handMat, local);
        state.flatAll.set(world, (state.fingerBase + i) * 16);
      }
    }

    renderer.updateCameraFromOrbit(state.azim, state.elev, state.dist, [0, 0.95, 0]);
    renderer.draw(state.flatAll, state.colors);
  }

  const src = $('poseSource');
  if (src) {
    const n = Object.keys(link.joints || {}).length;
    src.textContent = state.poseSource === 'live'
      ? (state.poseMismatch
          ? `pose source: LIVE · convention mismatch — arms cross the torso (${state.convention})`
          : `pose source: LIVE joint feedback · ${n} joints @ ${link.jointErrors ? 'degraded' : '5 Hz'}`)
      : state.poseSource === 'playback'
        ? 'pose source: recording playback — no live joint feedback'
        : 'pose source: operator / presets — no live joint feedback';
    src.classList.toggle('posesrc', state.poseSource !== 'live');
  }

  state.frames++; state.acc += dt;
  if (state.acc > 0.4) {
    state.fps = Math.round(state.frames / state.acc);
    state.frames = 0; state.acc = 0;
    $('fps').textContent = `${state.fps} fps`;
    if (model) $('tris').textContent = `${(model.meta.counts.triangles / 1000).toFixed(0)}k tris`;
  }
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------------- UI */

// idxNN_name = a primary DOF; idxNN_0X_name = linkage (toe motors) and must not
// double-count into a leg group.
const PRIMARY = /^idx\d\d_[a-z]/;
const GROUP_TESTS = [
  { key: 'legL', label: 'left leg', test: /^idx0[1-6]_/ },
  { key: 'legR', label: 'right leg', test: /^idx(0[7-9]|1[0-2])_/ },
  { key: 'armL', label: 'left arm', test: /^idx1[3-9]_/ },
  { key: 'armR', label: 'right arm', test: /^idx2[0-6]_/ },
  { key: 'head', label: 'head', test: /^idx2[7-8]_/ },
];

function primaryGroups(model) {
  const out = [];
  for (const g of GROUP_TESTS) {
    const joints = model.joints.filter((j) => j.movable && PRIMARY.test(j.name) && g.test.test(j.name));
    if (joints.length) out.push({ ...g, joints });
  }
  const aux = model.movable.filter((j) => !PRIMARY.test(j.name));
  if (aux.length) out.push({ key: 'aux', label: 'linkage', joints: aux });
  return out;
}

function buildJointUI() {
  const host = $('joints');
  host.innerHTML = '';
  for (const group of primaryGroups(state.model)) {
    const details = document.createElement('details');
    details.className = 'jgroup';
    details.open = group.key === 'armR' || group.key === 'head';
    const summary = document.createElement('summary');
    const color = CHAIN[group.key] || CHAIN.aux;
    const sw = `rgb(${color.slice(0, 3).map((v) => Math.round(v * 255)).join(',')})`;
    summary.innerHTML = `<i class="sw" style="background:${sw}"></i>${group.label} <span class="muted">${group.joints.length} dof</span>`;
    details.appendChild(summary);

    for (const j of group.joints) {
      const row = document.createElement('label');
      row.className = 'jrow';
      const lo = j.lower === null ? -180 : j.lower / DEG;
      const hi = j.upper === null ? 180 : j.upper / DEG;
      const badge = j.movable && !j.actuated
        ? '<i class="badge" title="vendor model carries limits but no actuator for this joint">unverified</i>' : '';
      row.innerHTML = `<span class="jname" title="${j.name}">${shortName(j.name)}${badge}</span>
        <input type="range" min="${lo.toFixed(1)}" max="${hi.toFixed(1)}" step="0.5" value="0" data-joint="${j.name}">
        <output>0°</output>`;
      const slider = row.querySelector('input');
      const outRow = row.querySelector('output');
      slider.addEventListener('input', () => {
        state.target[j.name] = Number(slider.value) * DEG;
        outRow.textContent = `${Number(slider.value).toFixed(0)}°`;
        if (state.playback?.playing) { state.playback.playing = false; updatePlayPause(); }
      });
      details.appendChild(row);
    }
    host.appendChild(details);
  }
}

const shortName = (n) => n.replace(/^idx\d\d_/, '').replace(/_/g, ' ');

function syncSliders(patch) {
  for (const [name, val] of Object.entries(patch)) {
    const el = document.querySelector(`input[data-joint="${name}"]`);
    if (!el) continue;
    const deg = val / DEG;
    el.value = String(deg);
    el.parentElement.querySelector('output').textContent = `${deg.toFixed(0)}°`;
  }
}

function buildPlaybackUI() {
  $('recSelect').innerHTML = RECORDINGS.map((r) => `<option value="${r.id}">${r.label}</option>`).join('');
  $('scrub').value = '0';
  $('timeRead').textContent = '—';
  $('recMeta').textContent = 'press play to load';
  updatePlayPause();
}

function updatePlayPause() {
  const playing = !!state.playback?.playing;
  $('btnPlay').textContent = playing ? 'pause' : 'play';
  $('btnPlay').classList.toggle('active', playing);
}

function updatePlaybackHud() {
  const p = state.playback;
  if (!p) return;
  $('scrub').value = String(p.duration ? p.time / p.duration : 0);
  $('timeRead').textContent = `${p.time.toFixed(1)} / ${p.duration.toFixed(1)} s · frame ${p.frameIndex + 1}/${p.rec.frames.length}`;
}

async function ensureRecording(id) {
  const meta = RECORDINGS.find((r) => r.id === id) || RECORDINGS[0];
  const idx = RECORDINGS.indexOf(meta);
  if (state.playback && state.playbackIndex === idx) return state.playback;
  $('timeRead').textContent = 'loading…';
  const rec = await loadRecording(meta.file);
  state.playback = new Playback(rec);
  state.playbackIndex = idx;
  // Only primary DOF matter here; the linkage joints are rigid by design.
  const missing = state.model.joints
    .filter((j) => j.movable && /^idx\d\d_[a-z]/.test(j.name) && !rec.jointNames.includes(j.name))
    .map((j) => shortName(j.name));
  $('recMeta').textContent = `${rec.frames.length} frames · ${rec.jointNames.length} joints · ${rec.duration.toFixed(1)} s` +
    (missing.length ? ` · absent: ${missing.join(', ')}` : '');
  updatePlaybackHud();
  return state.playback;
}

function wireUI() {
  $('btnArm').addEventListener('click', () => safety.arm());
  $('btnEngage').addEventListener('click', () => safety.engage());
  $('btnHandoff').addEventListener('click', () => safety.handoff());
  $('btnEstop').addEventListener('click', () => safety.emergencyStop());
  $('btnClear').addEventListener('click', () => safety.clearEstop());
  $('deadman').addEventListener('pointerdown', () => safety.setDeadman(true));
  $('deadman').addEventListener('pointerup', () => safety.setDeadman(false));
  $('deadman').addEventListener('pointerleave', () => safety.setDeadman(false));

  $('btnReference').addEventListener('click', () => {
    const live = link.joints;
    if (!live || !Object.keys(live).length) {
      safety.note('capture reference failed: no measured joints yet — connect live first', 'error');
      return;
    }
    state.reference = { ...live, ...(link.neck || {}) };
    state.referenceHands = JSON.parse(JSON.stringify(link.hands || {}));
    localStorage.setItem('luka.referenceHands', JSON.stringify(state.referenceHands));
    state.referenceAt = Date.now();
    localStorage.setItem('luka.reference', JSON.stringify(state.reference));
    localStorage.setItem('luka.referenceAt', String(state.referenceAt));
    // The captured pose becomes the twin's neutral, so it should look like him.
    for (const name in state.reference) if (name in state.target) { state.target[name] = 0; state.pose[name] = 0; }
    state.autoTried = true; // offsets supersede the convention heuristic
    // Start from the principled mapping: offset only, no sign change. If motion
    // then runs backwards, the selector is one click away.
    state.convention = 'raw';
    localStorage.setItem('luka.convention', 'raw');
    const sel = $('convention'); if (sel) sel.value = 'raw';
    safety.note(`reference pose captured · ${Object.keys(state.reference).length} joints · twin now mirrors relative to it`, 'warn');
    renderReference();
  });

  $('btnClearRef').addEventListener('click', () => {
    state.reference = {};
    state.referenceAt = 0;
    state.referenceHands = {};
    localStorage.removeItem('luka.referenceHands');
    localStorage.removeItem('luka.reference');
    localStorage.removeItem('luka.referenceAt');
    safety.note('reference cleared — twin falls back to the model zero', 'warn');
    renderReference();
  });

  $('convention').addEventListener('change', (e) => {
    state.convention = e.target.value;
    localStorage.setItem('luka.convention', state.convention);
    state.poseMismatchShown = null;
    safety.note(`joint convention → ${state.convention}`, 'info');
  });
  $('convention').value = state.convention;

  $('attestRig').addEventListener('change', (e) => {
    state.profile.attested = e.target.checked;
    state.profile.at = e.target.checked ? Date.now() : null;
    safety.note(
      e.target.checked
        ? `test profile ATTESTED · rig load-rated, workspace clear, e-stop in hand · feet ${state.profile.feet}`
        : 'test profile attestation withdrawn',
      e.target.checked ? 'warn' : 'critical',
    );
    renderProfile();
    renderArmGate();
  });
  $('feetState').addEventListener('change', (e) => {
    state.profile.feet = e.target.value;
    safety.note(`feet state recorded: ${e.target.value}`, 'info');
    renderProfile();
  });
  $('excursion').addEventListener('change', (e) => {
    state.profile.excursionDeg = Number(e.target.value);
    state.arm.setExcursionDeg(state.profile.excursionDeg);
    safety.note(`excursion cap set to ±${state.profile.excursionDeg}°`, 'info');
    renderProfile();
  });

  $('btnLink').addEventListener('click', () => {
    if (state.env && state.env.mode === MODES.SIM) return; // static build: nothing to connect to
    if (link.mode === 'live') link.stop();
    else { link.startLive(); $('banner').classList.remove('show'); }
  });
  $('btnMock').addEventListener('click', () => link.startMock());

  $('btnPlay').addEventListener('click', async () => {
    const p = await ensureRecording($('recSelect').value);
    p.playing = !p.playing;
    if (p.playing && safety.state !== STATE.COMPUTER) {
      safety.note('playback running at MANUAL — twin only, no commands issued', 'warn');
    }
    updatePlayPause();
  });
  $('recSelect').addEventListener('change', async () => {
    state.playback = null;
    state.playbackIndex = -1;
    await ensureRecording($('recSelect').value);
    updatePlayPause();
  });
  $('scrub').addEventListener('input', async (e) => {
    const p = await ensureRecording($('recSelect').value);
    p.playing = false;
    updatePlayPause();
    p.seek(Number(e.target.value));
    const sampled = state.model.clampPose(p.sample());
    Object.assign(state.target, sampled);
    syncSliders(sampled);
    updatePlaybackHud();
  });
  $('speedSelect').addEventListener('change', async (e) => {
    const p = await ensureRecording($('recSelect').value);
    p.speed = Number(e.target.value);
  });

  for (const btn of document.querySelectorAll('[data-preset]')) {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  }

  safety.addEventListener('state', renderSafety);
  safety.addEventListener('log', renderLog);
  link.addEventListener('update', renderLink);
  renderSafety();
  renderLink();
  renderReference();
}

function renderReference() {
  const el = $('referenceNote');
  if (!el) return;
  const n = Object.keys(state.reference || {}).length;
  el.textContent = n
    ? `Reference: ${n} joints captured ${new Date(state.referenceAt).toLocaleTimeString()} · mirroring is relative to that pose`
    : 'With his arms hanging, capture a reference. The twin then mirrors movement relative to that pose instead of assuming the model\'s zero.';
  el.classList.toggle('simnote', n > 0);
}

function applyPreset(name) {
  const model = state.model;
  const t = {};
  for (const j of model.movable) t[j.name] = 0;
  const set = (k, v) => { if (k in t) t[k] = v * DEG; };
  if (name === 'guard') {
    set('idx14_left_arm_joint2', 60); set('idx16_left_arm_joint4', -70);
    set('idx21_right_arm_joint2', 60); set('idx23_right_arm_joint4', 70);
    set('idx03_left_hip_pitch', 25); set('idx04_left_tarsus', 45);
    set('idx09_right_hip_pitch', 25); set('idx10_right_tarsus', 45);
    set('idx27_head_joint1', -20);
  }
  if (name === 'reach') {
    set('idx13_left_arm_joint1', -60);
    set('idx14_left_arm_joint2', 80); set('idx16_left_arm_joint4', -20);
    set('idx27_head_joint1', 25); set('idx28_head_joint2', 15);
  }
  if (name === 'inspect') {
    set('idx14_left_arm_joint2', 95); set('idx16_left_arm_joint4', -85);
    set('idx21_right_arm_joint2', 95); set('idx23_right_arm_joint4', 85);
    set('idx18_left_arm_joint6', 30); set('idx25_right_arm_joint6', -30);
    set('idx03_left_hip_pitch', 15); set('idx09_right_hip_pitch', 15);
  }
  const clamped = model.clampPose(t);
  Object.assign(state.target, clamped);
  syncSliders(clamped);
  if (state.playback) { state.playback.playing = false; updatePlayPause(); }
  safety.note(`preset ${name} applied to twin`, 'info');
}

function buildArmUI() {
  renderArmList();
  for (const btn of document.querySelectorAll('[data-side]')) {
    btn.addEventListener('click', () => {
      state.armSide = btn.dataset.side;
      document.querySelectorAll('[data-side]').forEach((b) => b.classList.toggle('active', b === btn));
      renderArmList();
    });
  }
  $('armZero').addEventListener('click', () => {
    for (const name of ARM_JOINTS[state.armSide]) state.arm.setTarget(name, 0);
    renderArmList();
    safety.note(`arm targets zeroed (${state.armSide})`, 'info');
  });
  state.arm.addEventListener('command', (ev) => {
    const { joints, mode } = ev.detail;
    const names = Object.keys(joints);
    const sample = names.slice(0, 2).map((n) => `${shortName(n)}=${(joints[n] / DEG).toFixed(1)}°`).join(' ');
    $('armPayload').textContent = `${mode} · ${names.length} joint(s) · ${sample}`;
    renderArmList();
  });
}

function renderArmList() {
  const host = $('armList');
  if (!host || !state.arm) return;
  host.innerHTML = '';
  for (const name of ARM_JOINTS[state.armSide]) {
    const lim = state.arm.limits(name);
    const cur = (state.arm.current[name] ?? 0) / DEG;
    const row = document.createElement('div');
    row.className = 'armrow';
    row.innerHTML = `<span class="aname" title="${name} · limits ${(lim.lower / DEG).toFixed(0)}…${(lim.upper / DEG).toFixed(0)}°">${shortName(name)}</span>
      <button data-jog="-1">−</button><button data-jog="1">+</button>
      <output>${cur.toFixed(1)}°</output>`;
    row.querySelectorAll('[data-jog]').forEach((b) => b.addEventListener('click', () => {
      if (!state.profile.attested) {
        safety.note('jog refused: attest the test profile first', 'error');
        return;
      }
      state.arm.jog(name, Number(b.dataset.jog));
      renderArmList();
    }));
    host.appendChild(row);
  }
  renderArmGate();
}

function renderProfile() {
  const el = $('profileState');
  if (!el) return;
  const p = state.profile;
  el.textContent = p.attested ? 'ATTESTED' : 'UNATTESTED';
  const loco = $('locoState');
  if (loco) loco.textContent = safety.locomotionLocked ? 'locked · no transport' : 'unlocked';
  el.dataset.mode = p.attested ? 'live' : 'warn';
  const note = $('profileNote');
  if (note) {
    const when = p.at ? new Date(p.at).toLocaleTimeString() : '—';
    note.textContent = p.attested
      ? `Operator-attested ${when} (not system-verified) · feet ${p.feet} · corridor ±${p.excursionDeg}° around the measured start pose · locomotion locked`
      : 'Arm commands stay refused until this is attested. Locomotion commands do not exist in this build.';
    note.classList.toggle('simnote', p.attested);
  }
}

function renderArmGate() {
  const gate = $('armGate');
  if (!gate || !state.armTransport) return;
  const t = state.armTransport;
  const report = link.snapshot();
  const actionGate = state.arm.actionGate(report.action);
  let text; let cls;
  if (state.env && state.env.mode === MODES.SIM) {
    text = 'sim build · no robot transport'; cls = 'blocked';
  } else if (!state.profile.attested) {
    text = 'test profile not attested'; cls = 'blocked';
  } else if (t.mode === 'unconfigured') {
    text = `schema known · no transport (bridge not connected) · robot ${report.action || 'unlinked'}`; cls = 'blocked';
  } else if (!actionGate.ok && report.action) {
    text = `${actionGate.reason} — switch action first`; cls = 'blocked';
  }
  else if (safety.estop) { text = 'software stop latched'; cls = 'blocked'; }
  else if (!actionGate.ok) { text = `${actionGate.reason} — switch action first`; cls = 'blocked'; }
  else if (safety.state !== STATE.COMPUTER) { text = `authority ${safety.state} — commands refused`; cls = 'blocked'; }
  else if (!safety.deadman) { text = 'deadman not held'; cls = 'blocked'; }
  else if (!safety.linkFresh) { text = 'telemetry stale'; cls = 'blocked'; }
  else if (!state.arm.anchor) {
    text = `attested · awaiting measured joint feedback before any command`; cls = 'blocked';
  } else { text = `permitted · ${t.mode} · ${RATE_LIMITS.maxRateDegPerSec}°/s · ±${state.profile.excursionDeg}° corridor`; cls = 'ok'; }
  gate.textContent = text;
  gate.className = `armgate ${cls}`;
}

function renderSafety() {
  const s = safety.snapshot();
  $('modeState').textContent = s.state;
  $('modeState').dataset.state = s.state;
  document.body.dataset.mode = s.state;
  $('deadmanDot').classList.toggle('on', s.deadman);
  $('linkDot').classList.toggle('on', s.linkFresh);
  $('estopDot').classList.toggle('on', s.estop);
  $('watchdog').textContent = s.watchdogFired ? 'WATCHDOG TRIPPED' : 'watchdog idle';
  $('watchdog').classList.toggle('bad', s.watchdogFired);
  $('cmdCount').textContent = String(s.commandsSent);
  $('rejCount').textContent = String(s.rejections);
  $('lastReject').textContent = s.lastReject ? `last reject: ${s.lastReject}` : '';
  $('btnArm').disabled = s.state !== STATE.MANUAL || s.estop;
  $('btnEngage').disabled = s.state !== STATE.ARMED;
  $('btnHandoff').disabled = !(s.state === STATE.COMPUTER || s.state === STATE.ARMED);
  $('btnClear').disabled = !s.estop;
  renderArmGate();
  const banner = $('banner');
  if (s.estop) {
    banner.textContent = 'SOFTWARE STOP LATCHED — unverified stop; use the factory e-stop';
    banner.classList.add('show', 'crit');
  } else if (s.watchdogFired) {
    banner.textContent = 'COMMAND WATCHDOG TRIPPED — zero velocity issued';
    banner.classList.add('show', 'warn');
  } else {
    banner.classList.remove('show');
  }
}

function renderLink() {
  if (state.env && state.env.mode === MODES.SIM) {
    $('linkMode').textContent = 'STATIC';
    $('linkMode').dataset.mode = 'offline';
    $('linkBody').innerHTML = [
      ['origin', location.host || 'file://'],
      ['gateway', 'not present on this origin'],
      ['telemetry', 'unavailable in a static build'],
      ['how to enable', 'run node serve.mjs locally'],
    ].map(([k, v]) => `<div class="kv"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`).join('');
    const note = $('linkNote');
    if (note) { note.textContent = describeEnvironment(state.env); note.classList.add('simnote'); }
    return;
  }
  const l = link.snapshot();
  $('linkMode').textContent = l.mode.toUpperCase();
  $('linkMode').dataset.mode = l.mode;
  $('btnLink').textContent = l.mode === 'live' ? 'disconnect' : 'connect live';
  const rows = [
    ['endpoint', l.mode === 'mock' ? 'mock generator' : '192.168.4.136:56322'],
    ['age', l.fresh ? 'fresh' : l.ageMs === Infinity ? 'no data' : `${Math.round(l.ageMs)} ms`],
    ['rtt', l.latencyMs ? `${l.latencyMs.toFixed(1)} ms` : '—'],
    ['current_action', l.action || '—'],
    ['joint angles', l.jointsFresh ? `${l.jointCount} joints · live` : 'no recent samples'],
  ];
  $('linkBody').innerHTML = rows
    .map(([k, v]) => `<div class="kv"><span>${k}</span><b>${escapeHtml(String(v))}</b></div>`)
    .join('');
  if (l.error) $('linkBody').innerHTML += `<div class="kv err"><span>error</span><b>${escapeHtml(l.error)}</b></div>`;
  safety.setLinkFresh(l.fresh && (l.mode === 'live' || l.mode === 'mock'));
}

function renderLog(ev) {
  const list = $('logList');
  const item = document.createElement('div');
  item.className = `logitem ${ev.detail.level}`;
  item.textContent = `${new Date(ev.detail.t).toLocaleTimeString()} · ${ev.detail.text}`;
  list.prepend(item);
  while (list.children.length > 40) list.lastChild.remove();
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ input */

function wireInput() {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Space') { e.preventDefault(); safety.setDeadman(true); }
    if (e.code === 'Escape') { e.preventDefault(); safety.emergencyStop(); }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') safety.setDeadman(false); });
  window.addEventListener('blur', () => safety.setDeadman(false));

  canvas.addEventListener('pointerdown', (e) => { state.drag = true; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointerup', (e) => {
    state.drag = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.drag) return;
    state.azim -= e.movementX * 0.005;
    state.elev = clamp(state.elev + e.movementY * 0.004, -0.5, 1.2);
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.dist = clamp(state.dist * (1 + Math.sign(e.deltaY) * 0.08), 1.4, 8);
  }, { passive: false });
}

boot();
