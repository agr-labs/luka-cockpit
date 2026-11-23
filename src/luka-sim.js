// Main interactive controller for Luka Upper-Body Embodied Sim:
//   - Live AgiBot A2 Ultra upper-body 3D render (WebGPU / WebGL2) + black OLED head + chest logo
//   - Local-first Speech pipeline (16 kHz WAV -> Whisper ASR -> Trellis+LLM -> Inworld/Say TTS -> WebAudio RMS)
//   - Kameyoko MediaPipe Pose + 21-pt Hand tracking (Full Mirror, Gaze Follow, Demo Skeleton)
//   - Sovereign Trellis unbounded memory engine + Emergent Skill Studio (Teach-by-Pose + composition discovery)

import { loadModel } from './model.js';
import {
  createStudioRenderer,
  agibotMaterialForLink,
  isLowerBodyLink,
  parseBinaryStlToYUp,
  buildPedestalMesh,
} from './upper-renderer.js';
import { buildGrid } from './geometry.js';
import {
  LukaMotionController,
  applySymmetricUpperBodyAxes,
  UPPER_BODY_JOINTS,
  JOINT_LABELS,
  GESTURE_NAMES,
} from './luka-motion.js';
import { KameyokoVisionTracker, DEFAULT_HAND_CALIBRATION } from './kameyoko-tracker.js';
import {
  simPoseToHardwarePacket,
  validateHardwareCommandPacket,
} from './hw-safety.js';
import { TrellisEngine } from './trellis-engine.js';
import { createMetricsClient } from './metrics.js';
import { clamp, damp, DEG, m4 } from './mathx.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stageCanvas');
const isStaticBuild = document.querySelector('meta[name="luka-env"]')?.content === 'static';
const metrics = createMetricsClient('luka-sim');
const bootStartedAt = performance.now();

const CAM_PRESETS = {
  front: { azim: 1.57, elev: 0.05, dist: 1.58, target: [0, 1.35, 0] },
  threeQuarterL: { azim: 1.05, elev: 0.09, dist: 1.64, target: [0, 1.35, 0] },
  threeQuarterR: { azim: 2.09, elev: 0.09, dist: 1.64, target: [0, 1.35, 0] },
  closeup: { azim: 1.57, elev: 0.06, dist: 1.02, target: [0, 1.44, 0] },
};

const state = {
  model: null,
  renderer: null,
  motion: null,
  tracker: null,
  trellis: new TrellisEngine(),

  upperBodyOnly: true,
  extraLinks: [], // [{ name, parentLink }]
  totalRanges: 0,
  matrices: null,
  colors: null,
  materials: null,
  visibleMask: [],

  // Camera orbit (smoothly damped)
  cam: { ...CAM_PRESETS.front, target: [...CAM_PRESETS.front.target] },
  camTarget: { ...CAM_PRESETS.front, target: [...CAM_PRESETS.front.target] },
  dragging: false,

  // Speech & conversation state
  health: null,
  phase: 'idle', // idle | listening | transcribing | thinking | speaking | error
  history: [],
  turns: 0,
  lastAudioBase64: null,
  lastReplyText: '',
  micHeldBy: null,
  micLatched: false,
  micPending: false,
  micGen: 0,
  micAutoStopTimer: null,
  micStartedAt: 0,
  micPressedAt: 0,
  recorder: { stream: null, ctx: null, source: null, proc: null, sink: null, chunks: [], level: 0, peak: 0, recording: false },
  playbackCtx: null,
  analyser: null,
  analyserBuf: null,
  activeSourceNode: null,
  synthSpeechWave: 0, // fallback RMS envelope if browser speechSynthesis is used

  // Tracking & observation debounce
  trackRetargetMode: 'mirror', // 'mirror' | 'gaze'
  lastObservedGesture: 'Neutral',
  lastObsAt: 0,
  cursorGaze: false,
  headPadDragging: false,

  // Frame loop stats
  lastTs: 0,
  frames: 0,
  fpsAcc: 0,
  fps: 0,
  uiSyncAcc: 0,
};

/* --------------------------------------------------------------- Boot UI */

function bootMsg(text) { const el = $('bootMsg'); if (el) el.textContent = text; }
function bootBar(pct) { const el = $('bootBar'); if (el) el.style.width = `${clamp(pct, 0, 100)}%`; }
function bootDone() {
  bootBar(100);
  const el = $('boot');
  if (el) { el.classList.add('done'); setTimeout(() => el.remove(), 420); }
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const total = Number(res.headers.get('Content-Length') || 0);
  if (!res.body || typeof res.body.getReader !== 'function') return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/* -------------------------------------------------------- 3D Model & Skin */

async function boot3D() {
  bootMsg('Starting WebGPU / WebGL2 studio renderer…');
  state.renderer = await createStudioRenderer(canvas);
  $('rendererChip').textContent = state.renderer.kind.toUpperCase();
  bootBar(12);

  bootMsg('Loading AgiBot A2 Ultra kinematics…');
  state.model = await loadModel('./model/generated/luka.model.json');
  applySymmetricUpperBodyAxes(state.model);
  state.motion = new LukaMotionController(state.model);
  bootBar(24);

  const [meshJson, meshBuf, logoBuf] = await Promise.all([
    fetch('./model/generated/luka.mesh.json').then((r) => r.json()),
    fetchWithProgress('./model/generated/luka.mesh.bin', (got, total) => {
      const mb = (got / 1e6).toFixed(1);
      bootMsg(total ? `Loading Luka meshes · ${mb} / ${(total / 1e6).toFixed(1)} MB` : `Loading Luka meshes · ${mb} MB`);
      bootBar(total ? 24 + (got / total) * 66 : 75);
    }),
    fetch('./model/meshes/logo.stl').then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
  ]);

  const baseVerts = new Float32Array(meshBuf);
  const ranges = [...meshJson.ranges];
  const extraChunks = [];
  let vertCursor = baseVerts.length / 6;

  // Append real AgiBot chest logo.stl attached to base_link
  if (logoBuf) {
    try {
      const parsed = parseBinaryStlToYUp(logoBuf, 1);
      extraChunks.push(parsed.data);
      ranges.push({ link: 'chest_logo', first: vertCursor, count: parsed.vertexCount, tris: parsed.triCount });
      state.extraLinks.push({ name: 'chest_logo', parentLink: 'base_link' });
      vertCursor += parsed.vertexCount;
    } catch (err) {
      console.warn('[luka-sim] logo.stl parse skipped:', err);
    }
  }

  // Append upper-body studio pedestal beneath base_link waist
  const pedestalVerts = buildPedestalMesh(0.84, 0.21, 0.34, 64);
  extraChunks.push(pedestalVerts);
  ranges.push({ link: 'studio_pedestal', first: vertCursor, count: pedestalVerts.length / 6, tris: pedestalVerts.length / 18 });
  state.extraLinks.push({ name: 'studio_pedestal', parentLink: null });
  vertCursor += pedestalVerts.length / 6;

  const combined = new Float32Array(vertCursor * 6);
  combined.set(baseVerts, 0);
  let writeOff = baseVerts.length;
  for (const ch of extraChunks) {
    combined.set(ch, writeOff);
    writeOff += ch.length;
  }

  state.totalRanges = ranges.length;
  state.matrices = new Float32Array(ranges.length * 16);
  state.colors = new Float32Array(ranges.length * 4);
  state.materials = new Float32Array(ranges.length * 4);

  for (let i = 0; i < ranges.length; i++) {
    const linkName = ranges[i].link;
    const mat = agibotMaterialForLink(linkName);
    state.colors.set(mat.color, i * 4);
    state.materials.set(mat.material, i * 4);
  }

  state.renderer.setRobotMesh(combined, ranges);
  state.renderer.setGridMesh(buildGrid(10, 0.25, 0.818));
  updateBodyVisibilityMask(ranges);

  // Subtle welcoming wave shortly after boot so Luka feels alive right away
  setTimeout(() => {
    if (state.phase === 'idle' && state.motion.trackingMode === 'off') {
      state.motion.playGesture('wave', { duration: 2.8 });
    }
  }, 700);
}

function updateBodyVisibilityMask(ranges = state.renderer.ranges) {
  state.visibleMask = ranges.map((r) => {
    if (r.link === 'studio_pedestal') return state.upperBodyOnly;
    if (state.upperBodyOnly && isLowerBodyLink(r.link)) return false;
    return true;
  });
  state.renderer.setVisibleMask(state.visibleMask);
  state.renderer.setGridMesh(buildGrid(10, 0.25, state.upperBodyOnly ? 0.818 : -0.001));
  const btn = $('toggleBodyBtn');
  if (btn) {
    btn.textContent = state.upperBodyOnly ? 'Upper Only' : 'Full Body';
    btn.classList.toggle('active', !state.upperBodyOnly);
  }
}

/* ----------------------------------------------------- Audio & Mic Capture */

function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const out = new Float32Array(Math.round((input.length * toRate) / fromRate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * fromRate) / toRate;
    const a = Math.floor(x);
    const t = x - a;
    out[i] = (input[a] || 0) * (1 - t) + (input[Math.min(a + 1, input.length - 1)] || 0) * t;
  }
  return out;
}

function encodeWav16k(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (off, s) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = clamp(samples[i], -1, 1);
    v.setInt16(44 + i * 2, s * (s < 0 ? 32768 : 32767), true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone requires localhost or HTTPS. You can still type below.');
  }
  const rec = state.recorder;
  rec.stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  try {
    // Open AudioContext at hardware native rate (forcing 16kHz can fail or emit silence on macOS 48kHz / Bluetooth mics)
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    rec.ctx = new AudioCtx();
    rec.source = rec.ctx.createMediaStreamSource(rec.stream);
    rec.sink = rec.ctx.createGain();
    rec.sink.gain.value = 0;
    rec.sink.connect(rec.ctx.destination);
    rec.proc = rec.ctx.createScriptProcessor(2048, 1, 1);
    rec.chunks = [];
    rec.level = 0;
    rec.peak = 0;
    rec.proc.onaudioprocess = (ev) => {
      if (!rec.recording) return;
      const ch = new Float32Array(ev.inputBuffer.getChannelData(0));
      rec.chunks.push(ch);
      let sq = 0;
      let pk = 0;
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > pk) pk = a;
        sq += ch[i] * ch[i];
      }
      rec.level = Math.sqrt(sq / ch.length);
      if (pk > rec.peak) rec.peak = pk;
    };
    rec.source.connect(rec.proc);
    rec.proc.connect(rec.sink);
    if (rec.ctx.state === 'suspended') await rec.ctx.resume();
    rec.recording = true;
    state.micStartedAt = performance.now();
  } catch (err) {
    await stopMic();
    throw err;
  }
}

async function stopMic() {
  const rec = state.recorder;
  const wasRec = rec.recording;
  const peak = rec.peak || 0;
  rec.recording = false;
  const elapsed = wasRec ? performance.now() - state.micStartedAt : 0;
  for (const k of ['proc', 'source', 'sink']) {
    try { rec[k]?.disconnect(); } catch { /* ignore */ }
  }
  rec.stream?.getTracks().forEach((t) => t.stop());
  const sr = rec.ctx?.sampleRate || 48000;
  await rec.ctx?.close().catch(() => {});
  const total = rec.chunks.reduce((s, c) => s + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of rec.chunks) { merged.set(c, off); off += c.length; }
  rec.chunks = [];
  rec.level = 0;
  rec.peak = 0;
  rec.stream = rec.ctx = rec.source = rec.proc = rec.sink = null;
  if (!wasRec || elapsed < 220 || !total) return { blob: null, reason: 'too_short', elapsed, peak };
  if (peak < 0.0012) return { blob: null, reason: 'silent', elapsed, peak };

  // Gently normalize quiet microphone captures so Whisper hears distant laptop mics clearly
  const resampled = resampleLinear(merged, sr, 16000);
  if (peak > 0.0012 && peak < 0.25) {
    const gain = Math.min(0.65 / peak, 10);
    for (let i = 0; i < resampled.length; i++) resampled[i] = clamp(resampled[i] * gain, -1, 1);
  }
  return { blob: encodeWav16k(resampled), reason: 'ok', elapsed, peak };
}

function stopCurrentPlayback() {
  if (state.activeSourceNode) {
    try { state.activeSourceNode.stop(); } catch { /* ignore */ }
    state.activeSourceNode = null;
  }
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  state.synthSpeechWave = 0;
}

async function playWavBase64(base64) {
  stopCurrentPlayback();
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  if (!state.playbackCtx) {
    state.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.analyser = state.playbackCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.analyserBuf = new Float32Array(state.analyser.fftSize);
    state.analyser.connect(state.playbackCtx.destination);
  }
  if (state.playbackCtx.state === 'suspended') await state.playbackCtx.resume();

  const decoded = await state.playbackCtx.decodeAudioData(bytes.buffer.slice(0));
  return new Promise((resolve) => {
    const src = state.playbackCtx.createBufferSource();
    src.buffer = decoded;
    src.connect(state.analyser);
    state.activeSourceNode = src;
    src.onended = () => {
      if (state.activeSourceNode === src) state.activeSourceNode = null;
      resolve();
    };
    src.start(0);
  });
}

function speakBrowserFallback(text) {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') { resolve(); return; }
    stopCurrentPlayback();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = 0.9;
    let iv = null;
    u.onstart = () => {
      iv = setInterval(() => { state.synthSpeechWave = 0.25 + Math.random() * 0.55; }, 75);
    };
    const finish = () => {
      clearInterval(iv);
      state.synthSpeechWave = 0;
      resolve();
    };
    u.onend = finish;
    u.onerror = finish;
    speechSynthesis.speak(u);
  });
}

function samplePlaybackRms() {
  if (state.activeSourceNode && state.analyser && state.analyserBuf) {
    state.analyser.getFloatTimeDomainData(state.analyserBuf);
    let sq = 0;
    for (let i = 0; i < state.analyserBuf.length; i++) sq += state.analyserBuf[i] * state.analyserBuf[i];
    return clamp(Math.sqrt(sq / state.analyserBuf.length) * 4.2, 0, 1);
  }
  if (state.synthSpeechWave > 0) return state.synthSpeechWave;
  return 0;
}

/* -------------------------------------------- Conversation & Trellis Loop */

function setPhase(next, subtitle = null) {
  state.phase = next;
  const badge = $('phaseBadge');
  badge.textContent = next.toUpperCase();
  badge.dataset.phase = next;

  const btn = $('talkBtn');
  btn.dataset.phase = next;
  const labels = {
    idle: 'Hold to Talk',
    arming: 'Opening Microphone…',
    listening: state.micLatched ? 'Listening… Click or Press Space to Send' : 'Listening… Release to Send',
    transcribing: 'Transcribing with Whisper…',
    thinking: 'Trellis Compiling & Thinking…',
    speaking: 'Luka is Speaking…',
    error: 'Hold to Retry',
  };
  $('talkLabel').textContent = labels[next] || 'Hold to Talk';
  $('hudModeTag').textContent = next.toUpperCase();

  if (state.motion) {
    const motionMode = next === 'transcribing' ? 'thinking' : (next === 'arming' ? 'listening' : (next === 'error' ? 'idle' : next));
    state.motion.setMode(motionMode);
  }

  const subBox = $('subtitleBox');
  if (subtitle) {
    $('subtitleText').textContent = subtitle;
    subBox.hidden = false;
  } else if (next === 'idle') {
    subBox.hidden = true;
  }
}

function appendMessage(role, text, tags = []) {
  const list = $('transcriptList');
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  const body = document.createElement('div');
  body.textContent = text;
  div.append(body);
  if (tags.length) {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    for (const t of tags) {
      const span = document.createElement('span');
      span.className = `msg-tag ${t.cls || ''}`;
      span.textContent = t.text;
      meta.append(span);
    }
    div.append(meta);
  }
  list.append(div);
  list.scrollTop = list.scrollHeight;
}

function currentTrackingSummary() {
  const tr = state.tracker?.lastTracked;
  if (!state.tracker?.running || !tr) return 'Camera vision tracker is currently off.';
  return `Kameyoko vision active (${state.trackRetargetMode} mode). Detected operator pose: ${tr.detectedGesture}. Hands visible: ${tr.handCount}. Left openness ${Math.round(tr.openness.left * 100)}%, Right openness ${Math.round(tr.openness.right * 100)}%.`;
}

async function runConversationTurn({ text = null, wavBlob = null, inputMode = null }) {
  if (['transcribing', 'thinking'].includes(state.phase)) return;
  stopCurrentPlayback();
  const timings = {};

  try {
    let spokenText = text;
    if (wavBlob) {
      if (isStaticBuild) {
        setPhase('idle');
        appendMessage('system', 'Whisper server transcription is local-only — browser speech recognition handles Hold to Talk on static deploys.');
        return;
      }
      setPhase('transcribing');
      const res = await fetch('/sim-api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBlob,
      });
      const rawBody = await res.text();
      let data = {};
      try { data = rawBody ? JSON.parse(rawBody) : {}; } catch { data = {}; }
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Transcription unavailable (HTTP ${res.status})`);
      }
      spokenText = (data.transcript || '').trim();
      timings.asr = data.asr_ms;
      if (!spokenText) {
        setPhase('idle');
        appendMessage('system', 'No speech detected in clip — hold a little longer and speak clearly.');
        return;
      }
    }

    spokenText = String(spokenText || '').trim();
    if (!spokenText) return;
    appendMessage('user', spokenText, timings.asr ? [{ text: `ASR ${timings.asr}ms` }] : []);

    // 1. Check for direct tracking voice commands or taught skills
    const lower = spokenText.toLowerCase();
    const invokedCaps = [];
    if (/\b(mirror me|copy my moves|mirror my hands)\b/.test(lower) && state.tracker) {
      setTrackRetargetMode('mirror');
      if (!state.tracker.running) state.tracker.startDemo();
      invokedCaps.push('kameyoko_mirror_body');
    } else if (/\b(stop mirror|stop tracking)\b/.test(lower) && state.tracker?.running) {
      stopTracking();
    }

    const matchedSkill = state.trellis.findMatchingSkill(spokenText);

    // 2. Compile unbounded Trellis context package (TVP-1)
    setPhase('thinking');
    const compiled = state.trellis.compileContextPackage({
      currentPrompt: spokenText,
      recentMessages: state.history.slice(-8),
      tokenBudget: 1600,
    });

    // 3. Call embodied reasoning API (or client-side fallback on static Cloudflare Pages)
    let rData = null;
    if (!isStaticBuild) {
      try {
        const reasonRes = await fetch('/sim-api/reason', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: spokenText,
            history: state.history.slice(-6),
            llm: $('llmSelect').value || undefined,
            trellisContext: compiled.assembledContextText,
            trellisSummary: compiled.summary,
            activeSkills: state.trellis.skills.map((s) => ({
              name: s.name,
              description: s.description,
              source: s.source,
              gesture: s.gesture,
              triggerPhrases: s.triggerPhrases,
            })),
            trackingSummary: currentTrackingSummary(),
          }),
        });
        const parsed = await reasonRes.json();
        if (reasonRes.ok && parsed.ok) rData = parsed;
      } catch {
        rData = null;
      }
    }
    if (!rData) {
      const low = spokenText.toLowerCase();
      let g = matchedSkill?.gesture || 'explain';
      let replyText = 'Got it — running right here in browser sim mode with hardware safety limits active.';
      if (matchedSkill) {
        replyText = `Running ${matchedSkill.name.replace(/_/g, ' ')} now.`;
      } else if (/\b(hi|hello|hey|wave|greet)\b/.test(low)) {
        g = 'wave';
        replyText = 'Hey! Great to see you — waving right now within my A2U actuator limits.';
      } else if (/\b(nod|yes|agree|yep|sure)\b/.test(low)) {
        g = 'nod';
        replyText = 'Absolutely, nodding along with you.';
      } else if (/\b(no|nope|shake|disagree)\b/.test(low)) {
        g = 'shake_no';
        replyText = 'Understood, shaking my head no.';
      } else if (/\b(look|scan|around|room)\b/.test(low)) {
        g = 'look_around';
        replyText = 'Scanning the room within my ±45 degree pan and ±23 degree tilt neck envelope.';
      } else if (/\b(point|left)\b/.test(low)) {
        g = 'point_left';
        replyText = 'Pointing to the left now.';
      } else if (/\b(right)\b/.test(low)) {
        g = 'point_right';
        replyText = 'Pointing to the right now.';
      } else if (/\b(hand|finger|inspect)\b/.test(low)) {
        g = 'inspect';
        replyText = 'Inspecting my RH56 fingers and parallel wrist bounds.';
      } else if (/\b(think|wonder|hmm|remember)\b/.test(low)) {
        g = 'think';
        replyText = 'Anchored in Trellis memory — thinking it through.';
      } else if (/\b(celebrate|yay|awesome|win)\b/.test(low)) {
        g = 'celebrate';
        replyText = 'Let’s go! Celebrating safely inside hardware limits.';
      }
      rData = { ok: true, reply: replyText, gesture: g, invokedSkill: matchedSkill?.name || null, llm: 'browser-sim', timings: { llm_ms: 1 } };
    }
    timings.llm = rData.timings?.llm_ms;

    const reply = rData.reply;
    const chosenSkillName = rData.invokedSkill || (matchedSkill?.source === 'emergent' ? matchedSkill.name : null);
    const chosenSkill = chosenSkillName ? state.trellis.getSkillByName(chosenSkillName) : null;
    const gesture = rData.gesture || chosenSkill?.gesture || 'explain';

    // 4. Ingest turn & claims into Trellis TRP-1 WAL + record emergent capability experience
    const { claims } = state.trellis.ingestTurn(spokenText, reply, { gesture, skill: chosenSkillName });
    if (claims.length > 0) invokedCaps.push('trellis_anchor_memory');
    if (chosenSkill) invokedCaps.push(chosenSkill.name);
    else if (gesture === 'wave') invokedCaps.push('wave_greeting');
    else if (gesture === 'inspect') invokedCaps.push('inspect_hands');
    else invokedCaps.push('explain_open_hands');
    state.trellis.recordCapabilitySequence(spokenText, invokedCaps);

    // Recompile viewport so Trellis panel reflects the newly anchored claims immediately
    state.trellis.compileContextPackage({
      currentPrompt: spokenText,
      recentMessages: [...state.history.slice(-6), { role: 'user', content: spokenText }, { role: 'assistant', content: reply }],
      tokenBudget: 1600,
    });

    state.history.push({ role: 'user', content: spokenText }, { role: 'assistant', content: reply });
    state.history = state.history.slice(-24);
    state.turns += 1;
    state.lastReplyText = reply;
    $('turnCounter').textContent = `${state.turns} turn${state.turns === 1 ? '' : 's'}`;

    // 5. Trigger Luka's embodied upper-body gesture / emergent taught pose!
    if (chosenSkill?.poseSnapshot) {
      state.motion.playCustomSkillPose(chosenSkill.name, chosenSkill.poseSnapshot, 3.8);
    } else if (gesture) {
      state.motion.playGesture(gesture);
    }

    const msgTags = [];
    if (chosenSkill) msgTags.push({ text: `SKILL: ${chosenSkill.name}`, cls: 'skill' });
    else if (gesture) msgTags.push({ text: `GESTURE: ${gesture}` });
    if (claims.length) msgTags.push({ text: `+${claims.length} Trellis claim${claims.length > 1 ? 's' : ''}`, cls: 'claim' });
    if (timings.llm) msgTags.push({ text: `${rData.llm} ${timings.llm}ms` });

    appendMessage('luka', reply, msgTags);
    setPhase('speaking', reply);

    const selVoiceForMetrics = $('voiceSelect')?.value || '';
    const ttsProvMetric = isStaticBuild ? 'browser' : (selVoiceForMetrics.split(':')[0] || 'inworld');
    metrics.track('speech_turn', {
      category: 'speech',
      label: inputMode || (wavBlob ? 'voice' : 'text'),
      value: timings.llm ?? null,
      meta: {
        llm: rData.llm || 'unknown',
        tts: $('audioOutCheck')?.checked ? ttsProvMetric : 'muted',
        gesture: gesture || '',
        skill: chosenSkill?.name || '',
        asrMs: timings.asr ?? null,
        llmMs: timings.llm ?? null,
        claims: claims.length,
        turns: state.turns,
      },
    });

    // 6. Synthesize & play Luka's voice with WebAudio RMS driving visor + gestures
    if ($('audioOutCheck').checked) {
      if (isStaticBuild) {
        await speakBrowserFallback(reply);
      } else {
        const selVoice = $('voiceSelect').value || '';
        const [vProvider, vName] = selVoice.includes(':') ? selVoice.split(':') : [undefined, selVoice];
        try {
          const ttsRes = await fetch('/sim-api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: reply, provider: vProvider, voice: vName }),
          });
          const tData = await ttsRes.json();
          if (ttsRes.ok && tData.ok && tData.audioBase64) {
            state.lastAudioBase64 = tData.audioBase64;
            $('replayBtn').disabled = false;
            await playWavBase64(tData.audioBase64);
          } else {
            await speakBrowserFallback(reply);
          }
        } catch {
          await speakBrowserFallback(reply);
        }
      }
    } else {
      // Visual-only speaking duration if muted
      await new Promise((r) => setTimeout(r, clamp(reply.length * 42, 1600, 4200)));
    }

    setPhase('idle');
  } catch (err) {
    console.error('[luka-sim] turn error:', err);
    appendMessage('system', `Error: ${err.message}`);
    setPhase('error');
    setTimeout(() => { if (state.phase === 'error') setPhase('idle'); }, 2500);
  }
}

/* ----------------------------------------------------- Kameyoko Tracking */

function setTrackRetargetMode(mode) {
  state.trackRetargetMode = mode;
  document.querySelectorAll('[data-track-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.trackMode === mode);
  });
  if (state.tracker?.running && state.motion) {
    state.motion.setTrackingMode(mode);
    updateVisionBadges();
  }
}

function updateVisionBadges() {
  const active = Boolean(state.tracker?.running);
  const src = state.tracker?.sourceMode || 'off';
  const modeLabel = !active ? 'OFF' : src === 'demo' ? `DEMO · ${state.trackRetargetMode.toUpperCase()}` : state.trackRetargetMode.toUpperCase();
  $('visionPill').textContent = `VISION ${modeLabel}`;
  $('visionDot').className = `dot ${active ? 'on' : ''}`;
  $('trackerBadge').textContent = active ? 'LIVE' : 'OFF';
  $('trackerBadge').classList.toggle('live', active);
  $('visionPip').hidden = !active;
  document.querySelector('.viewport')?.classList.toggle('pip-open', active);
  $('camVideo').hidden = src !== 'camera';
  $('pipTitle').textContent = src === 'demo' ? 'KAMEYOKO DEMO' : 'KAMEYOKO LIVE';
  $('hudTrackTag').hidden = !active;
  $('hudTrackTag').textContent = `KAMEYOKO ${state.trackRetargetMode.toUpperCase()}`;
}

function stopTracking() {
  if (state.tracker?.running && state.visionStartedAt) {
    const durSec = Math.round((performance.now() - state.visionStartedAt) / 1000);
    metrics.track('vision_session', {
      category: 'vision',
      label: state.tracker.sourceMode || 'camera',
      value: durSec,
      meta: { retarget: state.trackRetargetMode, action: 'stop' },
    });
    state.visionStartedAt = 0;
  }
  state.tracker?.stop();
  state.motion?.setTrackingMode('off');
  updateVisionBadges();
}

/* ------------------------------------------------------ Trellis UI Render */

function renderTrellisPanels() {
  const snap = state.trellis.getSnapshot();
  const compiled = snap.lastCompiled || state.trellis.compileContextPackage({ currentPrompt: '', recentMessages: [] });

  $('trellisPill').textContent = `TRELLIS ${snap.commits.length}`;
  const pct = clamp((compiled.estimatedTokensUsed / Math.max(1, compiled.usableBudget)) * 100, 2, 100);
  $('trellisBudgetFill').style.width = `${pct}%`;
  $('trellisBudgetLabel').textContent = `${compiled.estimatedTokensUsed} / ${compiled.usableBudget} tok`;
  $('tierHot').textContent = String(compiled.temperatureSummary.hot);
  $('tierWarm').textContent = String(compiled.temperatureSummary.warm);
  $('tierCool').textContent = String(compiled.temperatureSummary.cool);
  $('tierCold').textContent = String(compiled.temperatureSummary.cold);
  $('kvHitRate').textContent = `${Math.round(compiled.kvCacheMatch.hitRate * 100)}%`;
  $('kvSavedMs').textContent = `${compiled.kvCacheMatch.prefillSavedMs} ms`;
  $('ticFingerprint').textContent = `TIC-1 ${compiled.fingerprint.slice(8, 18)}`;

  // Entities
  $('entityCount').textContent = `${snap.entities.length} nodes`;
  const entHost = $('entityList');
  entHost.innerHTML = '';
  for (const ent of [...snap.entities].reverse()) {
    const el = document.createElement('div');
    el.className = 'entity-item';
    const edges = Object.entries(ent.edgeLabels || {});
    el.innerHTML = `
      <div class="entity-head">
        <span class="entity-name">${escapeHtml(ent.name)}</span>
        <span class="type-pill">${escapeHtml(ent.type)}</span>
      </div>
      ${ent.roleOrField || ent.location ? `<div class="entity-note">${escapeHtml([ent.roleOrField, ent.location].filter(Boolean).join(' · '))}</div>` : ''}
      ${edges.length ? `<div class="entity-edges">${edges.map(([t, r]) => `<span class="edge-chip">${escapeHtml(r)} → ${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      ${ent.openLoops?.length ? `<div class="entity-note" style="color:var(--amber)">⏳ ${escapeHtml(ent.openLoops.join(' · '))}</div>` : ''}
    `;
    entHost.append(el);
  }

  // TRP-1 WAL
  $('commitCount').textContent = `${snap.commits.length} commits`;
  const walHost = $('walList');
  walHost.innerHTML = '';
  for (const c of snap.commits.slice(0, 35)) {
    const el = document.createElement('div');
    el.className = 'wal-item';
    el.innerHTML = `
      <div class="wal-top">
        <span class="wal-op">${escapeHtml(c.operation)}${c.isCheckpoint ? ' ★' : ''}</span>
        <span class="wal-hash">${escapeHtml(c.commitHash.slice(8, 16))}</span>
      </div>
      <div class="wal-msg">${escapeHtml(c.message)}</div>
    `;
    walHost.append(el);
  }

  // Emergent Candidates
  const candCard = $('candidatesCard');
  const candHost = $('candidatesList');
  candCard.hidden = snap.candidates.length === 0;
  candHost.innerHTML = '';
  for (const cand of snap.candidates) {
    const el = document.createElement('div');
    el.className = 'skill-item';
    el.innerHTML = `
      <div class="skill-head">
        <span class="entity-name">${escapeHtml(cand.label)}</span>
        <span class="type-pill emergent">${cand.occurrences}× seen</span>
      </div>
      <div class="entity-note">${escapeHtml(cand.description)}</div>
      <div class="skill-actions">
        <button type="button" class="btn primary xs" data-approve="${escapeHtml(cand.id)}">Promote to Main</button>
        <button type="button" class="btn ghost xs" data-dismiss="${escapeHtml(cand.id)}">Dismiss</button>
      </div>
    `;
    el.querySelector('[data-approve]').onclick = () => {
      const sk = state.trellis.approveCandidate(cand.id);
      if (sk) appendMessage('system', `Promoted emergent skill "${sk.name}" into Trellis TRP-1 main branch.`);
    };
    el.querySelector('[data-dismiss]').onclick = () => state.trellis.dismissCandidate(cand.id);
    candHost.append(el);
  }

  // Active Skills
  $('skillCount').textContent = `${snap.skills.length} skills`;
  const skHost = $('skillsList');
  skHost.innerHTML = '';
  for (const sk of snap.skills) {
    const el = document.createElement('div');
    el.className = 'skill-item';
    el.innerHTML = `
      <div class="skill-head">
        <span class="entity-name mono">${escapeHtml(sk.name)}</span>
        <span class="type-pill ${sk.source === 'emergent' ? 'emergent' : ''}">${escapeHtml(sk.source)} · ${Math.round((sk.confidenceScore || 0.9) * 100)}%</span>
      </div>
      <div class="entity-note">${escapeHtml(sk.description)}</div>
      <div class="skill-actions">
        <button type="button" class="btn xs" data-run-skill="${escapeHtml(sk.name)}">Run Skill</button>
        <span class="tiny muted" style="align-self:center">say: "${escapeHtml((sk.triggerPhrases || [])[0] || sk.name)}"</span>
      </div>
    `;
    el.querySelector('[data-run-skill]').onclick = () => {
      if (sk.poseSnapshot) state.motion.playCustomSkillPose(sk.name, sk.poseSnapshot, 3.6);
      else if (sk.gesture) state.motion.playGesture(sk.gesture);
      state.trellis.recordCapabilitySequence(`Manual run ${sk.name}`, [sk.name]);
    };
    skHost.append(el);
  }
}

/* ----------------------------------------------------- Health & Voice UI */

async function loadHealthAndVoices() {
  if (isStaticBuild) {
    const llmSel = $('llmSelect');
    if (llmSel) {
      llmSel.innerHTML = '';
      llmSel.add(new Option('Browser Embodied Sim', 'browser-sim'));
    }
    const sel = $('voiceSelect');
    if (sel) {
      sel.innerHTML = '';
      sel.add(new Option('Browser Speech Synthesis', 'browser:default'));
    }
    const hasWebSpeech = typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    $('speechPill').textContent = hasWebSpeech ? 'SPEECH BROWSER VOICE' : 'SPEECH TEXT + TTS';
    $('speechDot').className = 'dot on-cyan';
    return;
  }
  try {
    const [hRes, vRes] = await Promise.all([
      fetch('/sim-api/health', { cache: 'no-store' }),
      fetch('/sim-api/voices', { cache: 'no-store' }),
    ]);
    if (hRes.ok) {
      state.health = await hRes.json();
      const llmSel = $('llmSelect');
      llmSel.innerHTML = '';
      for (const l of state.health.llms || []) {
        const opt = new Option(`${l.label}${l.ready ? '' : ' (offline)'}`, l.name);
        opt.disabled = !l.ready;
        llmSel.add(opt);
      }
      llmSel.add(new Option('Embodied Local Router', 'local-fallback'));
      llmSel.value = state.health.defaultLlm || 'local-fallback';

      const asrOk = state.health.asr?.ready;
      const ttsLabel = state.health.tts?.inworldReady ? 'INWORLD' : (state.health.tts?.sayReady ? 'MAC SAY' : 'BROWSER');
      $('speechPill').textContent = `SPEECH ${asrOk ? 'WHISPER' : 'TEXT'} · ${ttsLabel}`;
      $('speechDot').className = `dot ${asrOk ? 'on' : 'warn'}`;
    }
    if (vRes.ok) {
      const vData = await vRes.json();
      const sel = $('voiceSelect');
      sel.innerHTML = '';
      if (vData.voices?.inworld?.length) {
        const g = document.createElement('optgroup');
        g.label = 'Inworld TTS-2 (Luka)';
        for (const v of vData.voices.inworld) {
          g.append(new Option(v.label || v.name, `inworld:${v.name}`));
        }
        sel.append(g);
      }
      if (vData.voices?.say?.length) {
        const g = document.createElement('optgroup');
        g.label = 'macOS Local Voices';
        for (const v of vData.voices.say.slice(0, 16)) {
          g.append(new Option(v.label, `say:${v.name}`));
        }
        sel.append(g);
      }
      const defProv = vData.inworldReady ? 'inworld' : 'say';
      const defVoice = vData.profile?.voice || (defProv === 'inworld' ? 'Grayson' : 'Daniel');
      const wanted = `${defProv}:${defVoice}`;
      if ([...sel.options].some((o) => o.value === wanted)) sel.value = wanted;
    }
  } catch (err) {
    $('speechPill').textContent = 'SPEECH STATIC';
    console.warn('[luka-sim] sim-api health unavailable:', err);
  }
}

/* ----------------------------------------------------- Controls & Events */

function buildGestureAndJointControls() {
  // Gesture buttons
  const gHost = $('gestureButtons');
  gHost.innerHTML = '';
  for (const name of GESTURE_NAMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'g-btn';
    btn.textContent = name.replace(/_/g, ' ');
    btn.dataset.gesture = name;
    btn.onclick = () => {
      state.motion.clearManualOverrides();
      state.motion.playGesture(name);
      metrics.track('gesture_play', { category: 'motion', label: name, meta: { source: 'button' } });
    };
    gHost.append(btn);
  }

  // 16 Upper-Body Joint Sliders
  const sHost = $('jointSliders');
  sHost.innerHTML = '';
  for (const jName of UPPER_BODY_JOINTS) {
    const lim = state.model.limits(jName);
    if (!lim) continue;
    const lo = Math.round((lim.lower ?? -1.5) / DEG);
    const hi = Math.round((lim.upper ?? 1.5) / DEG);
    const row = document.createElement('label');
    row.className = 'slider-row';
    row.innerHTML = `
      <span title="${jName}">${JOINT_LABELS[jName] || jName}</span>
      <input type="range" min="${lo}" max="${hi}" step="1" value="0" data-joint="${jName}" />
      <output>0°</output>
    `;
    const input = row.querySelector('input');
    const out = row.querySelector('output');
    input.addEventListener('input', () => {
      const deg = Number(input.value);
      out.textContent = `${deg}°`;
      state.motion.setManualJoint(jName, deg * DEG);
    });
    sHost.append(row);
  }
}

function wireUI() {
  // Right rail tabs
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === target));
    });
  });

  // Camera presets
  document.querySelectorAll('[data-cam]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = CAM_PRESETS[btn.dataset.cam];
      if (!p) return;
      state.camTarget = { azim: p.azim, elev: p.elev, dist: p.dist, target: [...p.target] };
      document.querySelectorAll('[data-cam]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  $('toggleBodyBtn').addEventListener('click', () => {
    state.upperBodyOnly = !state.upperBodyOnly;
    updateBodyVisibilityMask();
    if (!state.upperBodyOnly) {
      state.camTarget = { azim: 1.57, elev: 0.08, dist: 2.75, target: [0, 0.94, 0] };
    } else {
      state.camTarget = { ...CAM_PRESETS.front, target: [...CAM_PRESETS.front.target] };
    }
  });

  // Hold-to-talk + Click-to-toggle (pointer + keyboard Space) with race-safe arming
  // Uses local Whisper ASR on serve.mjs, or native Web Speech SpeechRecognition on static Cloudflare Pages!
  const SpeechRecCtor = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

  const clearMicAutoStop = () => {
    if (state.micAutoStopTimer) {
      clearTimeout(state.micAutoStopTimer);
      state.micAutoStopTimer = null;
    }
  };

  function startBrowserSpeechRec() {
    return new Promise((resolve, reject) => {
      if (!SpeechRecCtor) {
        reject(new Error('Browser voice recognition requires Chrome, Edge, or Safari (or run locally with Whisper ASR).'));
        return;
      }
      const rec = new SpeechRecCtor();
      rec.lang = 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;

      const session = {
        rec,
        finalText: '',
        interimText: '',
        ended: false,
        endResolvers: [],
        error: null,
      };
      let started = false;

      rec.onstart = () => {
        started = true;
        resolve(session);
      };
      rec.onresult = (ev) => {
        let fin = '';
        let interim = '';
        for (let i = 0; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) fin += `${r[0].transcript} `;
          else interim += r[0].transcript;
        }
        session.finalText = fin.trim();
        session.interimText = interim.trim();
        const preview = `${session.finalText} ${session.interimText}`.trim();
        if (preview && $('talkSub')) {
          $('talkSub').textContent = `“${preview.slice(-46)}”`;
        }
      };
      rec.onerror = (ev) => {
        session.error = ev.error || 'speech_error';
        if (!started) {
          const err = new Error(ev.error === 'not-allowed' ? 'Microphone permission was denied.' : `Voice recognition error: ${ev.error}`);
          if (ev.error === 'not-allowed') err.name = 'NotAllowedError';
          reject(err);
        }
      };
      rec.onend = () => {
        session.ended = true;
        for (const fn of session.endResolvers) fn();
        session.endResolvers = [];
      };

      try {
        rec.start();
      } catch (err) {
        reject(err);
      }
    });
  }

  async function stopBrowserSpeechRec(send = true) {
    const session = state.speechRec;
    state.speechRec = null;
    if (!session) return '';
    if (!session.ended) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, send ? 800 : 120);
        session.endResolvers.push(() => { clearTimeout(timer); resolve(); });
        try {
          if (send) session.rec.stop();
          else session.rec.abort();
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    }
    return `${session.finalText} ${session.interimText}`.trim();
  }

  async function finishRecordingAndSend(send = true) {
    clearMicAutoStop();
    state.micHeldBy = null;
    state.micLatched = false;
    state.micGen += 1;

    if (isStaticBuild) {
      const [transcript] = await Promise.all([
        stopBrowserSpeechRec(send),
        stopMic().catch(() => null),
      ]);
      if (!send) {
        setPhase('idle');
        return;
      }
      if (!transcript) {
        setPhase('idle');
        appendMessage('system', 'No speech detected — hold a little longer and speak clearly (or click once to toggle, then click again to send).');
        return;
      }
      await runConversationTurn({ text: transcript, inputMode: 'voice' });
      return;
    }

    const result = await stopMic();
    if (!send) {
      setPhase('idle');
      return;
    }
    if (!result?.blob) {
      setPhase('idle');
      if (result?.reason === 'silent') {
        appendMessage('system', 'Microphone captured silence — check your Mac/browser input device or unmute your mic.');
      } else if (result?.reason === 'too_short') {
        appendMessage('system', 'Clip was too short — hold a little longer (or click once to toggle recording, then click again to send).');
      }
      return;
    }
    await runConversationTurn({ wavBlob: result.blob, inputMode: 'voice' });
  }

  async function startHold(source) {
    // If already in latched click-to-toggle recording, pressing again stops & sends!
    if (state.micLatched && state.phase === 'listening') {
      await finishRecordingAndSend(true);
      return;
    }
    if (state.micHeldBy || state.micPending || ['transcribing', 'thinking'].includes(state.phase)) return;
    stopCurrentPlayback();
    state.micHeldBy = source;
    state.micLatched = false;
    state.micPending = true;
    state.micPressedAt = performance.now();
    const gen = ++state.micGen;
    setPhase('arming');
    try {
      if (isStaticBuild) {
        state.speechRec = await startBrowserSpeechRec();
        // Best-effort mic level meter alongside browser SpeechRecognition
        openMic().catch(() => {});
      } else {
        await openMic();
      }
      state.micPending = false;
      // If user released quickly while getUserMedia was arming (or clicked once to toggle),
      // keep recording in latched toggle mode unless explicitly cancelled!
      if (gen !== state.micGen) {
        if (isStaticBuild) await stopBrowserSpeechRec(false);
        await stopMic().catch(() => {});
        return;
      }
      setPhase('listening');
      clearMicAutoStop();
      state.micAutoStopTimer = setTimeout(() => {
        if (state.phase === 'listening') void finishRecordingAndSend(true);
      }, 25_000);
    } catch (err) {
      state.micPending = false;
      state.micHeldBy = null;
      state.micLatched = false;
      if (isStaticBuild) await stopBrowserSpeechRec(false);
      await stopMic().catch(() => {});
      if (gen === state.micGen) {
        setPhase('error');
        const msg = err?.name === 'NotAllowedError'
          ? 'Microphone permission was denied — allow microphone access in your browser bar (or use the text box below).'
          : `Microphone error: ${err?.message || err}`;
        appendMessage('system', msg);
        setTimeout(() => { if (state.phase === 'error') setPhase('idle'); }, 3000);
      }
    }
  }

  async function endHold(source, send = true) {
    if (state.micHeldBy !== source) return;
    const heldMs = performance.now() - state.micPressedAt;

    if (!send) {
      state.micHeldBy = null;
      state.micLatched = false;
      state.micPending = false;
      state.micGen += 1;
      clearMicAutoStop();
      if (isStaticBuild) await stopBrowserSpeechRec(false);
      await stopMic().catch(() => {});
      setPhase('idle');
      return;
    }

    // Quick click (< 320 ms) or release while mic permission is still arming -> latch into hands-free toggle mode!
    if (source === 'pointer' && (state.micPending || heldMs < 320)) {
      state.micHeldBy = null;
      state.micLatched = true;
      if (state.phase === 'listening') setPhase('listening');
      return;
    }

    if (state.micPending) {
      // Keyboard Space released before mic finished opening -> cancel cleanly
      state.micHeldBy = null;
      state.micGen += 1;
      setPhase('idle');
      return;
    }

    await finishRecordingAndSend(true);
  }

  const talkBtn = $('talkBtn');
  talkBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { talkBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    void startHold('pointer');
  });
  talkBtn.addEventListener('pointerup', () => void endHold('pointer', true));
  talkBtn.addEventListener('pointercancel', () => void endHold('pointer', false));
  talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'Escape' && (state.micHeldBy || state.micLatched || state.micPending)) {
      e.preventDefault();
      void finishRecordingAndSend(false);
      return;
    }
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault();
      void startHold('keyboard');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && state.micHeldBy === 'keyboard') {
      e.preventDefault();
      void endHold('keyboard', true);
    }
  });

  // Text input & quick prompts
  $('textForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = $('textInput').value.trim();
    if (!val) return;
    $('textInput').value = '';
    void runConversationTurn({ text: val });
  });

  document.querySelectorAll('[data-prompt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void runConversationTurn({ text: btn.dataset.prompt });
    });
  });

  $('replayBtn').addEventListener('click', async () => {
    if (!state.lastAudioBase64) return;
    setPhase('speaking', state.lastReplyText);
    await playWavBase64(state.lastAudioBase64);
    setPhase('idle');
  });

  $('voiceSelect').addEventListener('change', () => {
    const val = $('voiceSelect').value;
    if (isStaticBuild || !val.includes(':')) return;
    const [provider, voice] = val.split(':');
    fetch('/sim-api/voice-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, voice }),
    }).catch(() => {});
  });

  // Kameyoko Vision controls
  state.tracker = new KameyokoVisionTracker({
    videoEl: $('camVideo'),
    overlayCanvas: $('camOverlay'),
    onStatus: (msg) => { $('trackerStatus').textContent = msg; },
  });

  // Hand Smoothing & Calibration controls (persisted in localStorage)
  const CAL_STORAGE_KEY = 'luka.handCalibration.v1';
  const loadSavedCalibration = () => {
    try {
      const raw = localStorage.getItem(CAL_STORAGE_KEY);
      return raw ? { ...DEFAULT_HAND_CALIBRATION, ...JSON.parse(raw) } : { ...DEFAULT_HAND_CALIBRATION };
    } catch {
      return { ...DEFAULT_HAND_CALIBRATION };
    }
  };
  const saveCalibration = (cal) => {
    try { localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(cal)); } catch { /* ignore */ }
  };
  const syncCalUI = (cal) => {
    const smPct = Math.round((cal.smoothing ?? 0.68) * 100);
    if ($('calSmooth')) { $('calSmooth').value = String(smPct); $('calSmoothOut').textContent = `${smPct}%`; }
    const rInt = Math.round((cal.reachScale ?? 1.12) * 100);
    if ($('calReach')) { $('calReach').value = String(rInt); $('calReachOut').textContent = `${(rInt / 100).toFixed(2)}×`; }
    const hDeg = Math.round(cal.heightTrimDeg ?? 0);
    if ($('calHeight')) { $('calHeight').value = String(hDeg); $('calHeightOut').textContent = `${hDeg > 0 ? '+' : ''}${hDeg}°`; }
    const wDeg = Math.round(cal.wristRollTrimDeg ?? 0);
    if ($('calWrist')) { $('calWrist').value = String(wDeg); $('calWristOut').textContent = `${wDeg > 0 ? '+' : ''}${wDeg}°`; }
    if ($('calStatusBadge')) {
      $('calStatusBadge').textContent = cal.openBaseline ? 'CUSTOM OPEN' : 'CALIBRATED';
    }
  };
  const applyCalibration = (partial) => {
    state.tracker.setCalibration(partial);
    state.motion.setSmoothing(state.tracker.calibration.smoothing);
    saveCalibration(state.tracker.calibration);
    syncCalUI(state.tracker.calibration);
  };
  applyCalibration(loadSavedCalibration());

  $('calSmooth')?.addEventListener('input', (e) => applyCalibration({ smoothing: Number(e.target.value) / 100 }));
  $('calReach')?.addEventListener('input', (e) => applyCalibration({ reachScale: Number(e.target.value) / 100 }));
  $('calHeight')?.addEventListener('input', (e) => applyCalibration({ heightTrimDeg: Number(e.target.value) }));
  $('calWrist')?.addEventListener('input', (e) => applyCalibration({ wristRollTrimDeg: Number(e.target.value) }));

  $('btnCalOpenHands')?.addEventListener('click', () => {
    const base = state.tracker.calibrateOpenHands();
    if (!base) {
      $('trackerStatus').textContent = 'Show open hands to camera (or Demo) first, then click Calibrate Open Hands.';
      return;
    }
    saveCalibration(state.tracker.calibration);
    syncCalUI(state.tracker.calibration);
    metrics.track('hand_calibrate', { category: 'vision', label: 'open_hands' });
    $('trackerStatus').textContent = 'Captured open-hand baseline! Residual finger curl zeroed.';
    appendMessage('system', 'Calibrated Luka RH56 open-hand baseline from live Kameyoko tracking.');
  });

  $('btnCalReset')?.addEventListener('click', () => {
    const cal = state.tracker.resetCalibration();
    state.motion.setSmoothing(cal.smoothing);
    saveCalibration(cal);
    syncCalUI(cal);
    $('trackerStatus').textContent = 'Hand smoothing & calibration reset to calibrated defaults.';
  });

  document.querySelectorAll('[data-hand-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.handPreset;
      state.motion.setHandPreset(preset);
      metrics.track('hand_preset', { category: 'motion', label: preset });
      document.querySelectorAll('[data-hand-preset]').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  $('btnHandAuto')?.addEventListener('click', () => {
    state.motion.clearHandPreset();
    document.querySelectorAll('[data-hand-preset]').forEach((b) => b.classList.remove('active'));
  });

  $('btnCamStart').addEventListener('click', async () => {
    try {
      await state.tracker.startCamera();
      state.visionStartedAt = performance.now();
      metrics.track('vision_session', { category: 'vision', label: 'camera', meta: { retarget: state.trackRetargetMode, action: 'start' } });
      state.motion.setTrackingMode(state.trackRetargetMode);
      updateVisionBadges();
    } catch (err) {
      $('trackerStatus').textContent = `Camera error: ${err.message}`;
      updateVisionBadges();
    }
  });

  $('btnDemoStart').addEventListener('click', () => {
    state.tracker.startDemo();
    state.visionStartedAt = performance.now();
    metrics.track('vision_session', { category: 'vision', label: 'demo', meta: { retarget: state.trackRetargetMode, action: 'start' } });
    state.motion.setTrackingMode(state.trackRetargetMode);
    updateVisionBadges();
  });

  $('btnTrackStop').addEventListener('click', stopTracking);

  document.querySelectorAll('[data-track-mode]').forEach((btn) => {
    btn.addEventListener('click', () => setTrackRetargetMode(btn.dataset.trackMode));
  });

  $('mirrorSidesCheck').addEventListener('change', (e) => {
    state.tracker.mirrorSides = e.target.checked;
  });

  $('btnLogObs').addEventListener('click', () => {
    const g = state.tracker?.lastTracked?.detectedGesture || 'Manual Upper-Body Pose';
    state.trellis.recordObservation(g, {
      mode: state.trackRetargetMode,
      snapshot: state.motion.captureSnapshot(),
    });
    appendMessage('system', `Logged Kameyoko observation "${g}" into Trellis TRP-1 WAL.`);
  });

  $('btnQuickTeach').addEventListener('click', () => {
    document.querySelector('.tab[data-tab="skills"]').click();
    $('skillNameInput').focus();
  });

  // Trellis manual anchor form
  $('addMemoryForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const val = $('memoryInput').value.trim();
    if (!val) return;
    $('memoryInput').value = '';
    const { claims } = state.trellis.ingestTurn(val, 'Anchored directly to Trellis graph.');
    state.trellis.compileContextPackage({ currentPrompt: val, recentMessages: state.history.slice(-6) });
    appendMessage('system', claims.length
      ? `Trellis anchored ${claims.length} claim(s): ${claims.map((c) => `${c.kind}:${c.value}`).join(', ')}`
      : `Recorded note in Trellis TRP-1 WAL: "${val}"`);
  });

  // Teach Emergent Skill form
  $('teachSkillForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('skillNameInput').value.trim();
    if (!name) return;
    const triggers = $('skillTriggerInput').value.trim() || name.replace(/_/g, ' ');
    const desc = $('skillDescInput').value.trim();
    const snapshot = state.motion.captureSnapshot();
    const skill = state.trellis.registerTaughtSkill({
      name,
      description: desc,
      triggerPhrases: triggers,
      poseSnapshot: snapshot,
    });
    metrics.track('trellis_event', { category: 'trellis', label: 'teach_skill', meta: { skill: skill.name } });
    $('skillNameInput').value = '';
    $('skillTriggerInput').value = '';
    $('skillDescInput').value = '';
    appendMessage('system', `Emergent embodied skill "${skill.name}" v${skill.version} saved to Trellis! Say "${skill.triggerPhrases[0]}" to trigger it.`);
  });

  $('btnReleaseManual').addEventListener('click', () => {
    state.cursorGaze = false;
    $('cursorGazeBtn')?.classList.remove('active');
    $('headPad')?.classList.remove('active');
    state.motion.clearManualOverrides();
  });

  // Actuator Hardware Safety Profile switcher + Soft Hold + Dry-Run Packet Inspector
  const syncSafetyProfileUI = () => {
    const prof = state.motion.getSafetyProfile();
    document.querySelectorAll('[data-safety-profile]').forEach((b) => {
      b.classList.toggle('active', b.dataset.safetyProfile === prof.id);
    });
    const yawLim = state.model.limits('idx27_head_joint1');
    const pitchLim = state.model.limits('idx28_head_joint2');
    const yawDeg = Math.round((yawLim?.upper ?? 0.785) / DEG);
    const pUpDeg = Math.round((pitchLim?.upper ?? 0.401) / DEG);
    const pDnDeg = Math.round(Math.abs(pitchLim?.lower ?? -0.401) / DEG);
    if ($('hpTop')) $('hpTop').textContent = `UP +${pUpDeg}°`;
    if ($('hpBot')) $('hpBot').textContent = `DOWN -${pDnDeg}°`;
    if ($('hpLeft')) $('hpLeft').textContent = `← -${yawDeg}°`;
    if ($('hpRight')) $('hpRight').textContent = `+${yawDeg}° →`;

    // Sync slider min/max bounds to match active hardware safety profile
    document.querySelectorAll('#jointSliders input[data-joint]').forEach((el) => {
      const lim = state.model.limits(el.dataset.joint);
      if (!lim) return;
      el.min = String(Math.round((lim.lower ?? -1.5) / DEG));
      el.max = String(Math.round((lim.upper ?? 1.5) / DEG));
    });
  };

  const toggleSoftHold = (forceVal = null) => {
    const next = forceVal === null ? !state.motion.isSoftHold() : Boolean(forceVal);
    state.motion.setSoftHold(next);
    metrics.track('safety_hold', { category: 'safety', label: next ? 'engage' : 'release', meta: { enabled: next } });
    $('softHoldBtn')?.classList.toggle('active', next);
    if ($('softHoldBtn')) $('softHoldBtn').textContent = next ? 'HELD (RESUME)' : 'SOFT HOLD';
    if ($('btnSoftHoldCard')) $('btnSoftHoldCard').textContent = next ? 'Resume Motion (H)' : 'Soft Hold (H)';
    if (next) appendMessage('system', 'SOFT HOLD latched — all upper-body targets frozen in place (sim only; physical e-stop remains primary on hardware).');
  };

  document.querySelectorAll('[data-safety-profile]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.motion.setSafetyProfile(btn.dataset.safetyProfile);
      syncSafetyProfileUI();
      const prof = state.motion.getSafetyProfile();
      metrics.track('safety_profile', { category: 'safety', label: prof.id });
      appendMessage('system', `Safety envelope switched to ${prof.label}: ${prof.description}`);
    });
  });

  $('safetyPillBtn')?.addEventListener('click', () => {
    document.querySelector('.tab[data-tab="skills"]')?.click();
  });

  $('softHoldBtn')?.addEventListener('click', () => toggleSoftHold());
  $('btnSoftHoldCard')?.addEventListener('click', () => toggleSoftHold());

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    if (e.code === 'KeyH' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
      toggleSoftHold();
    }
  });

  $('btnDryRunPacket')?.addEventListener('click', () => {
    const box = $('dryRunBox');
    if (!box) return;
    const pkt = simPoseToHardwarePacket(state.motion.pose, state.motion.hands);
    const neckCheck = validateHardwareCommandPacket(pkt, { allowArms: false });
    const armCheck = validateHardwareCommandPacket(pkt, { allowArms: true });
    metrics.track('safety_packet_inspect', {
      category: 'safety',
      label: neckCheck.ok ? 'neck_pass' : 'neck_refused',
      meta: { profile: state.motion.getSafetyProfile().id, armGated: armCheck.errors.length },
    });
    box.hidden = false;
    box.textContent = [
      `DRY-RUN WIRE PREVIEW (physical writes CLOSED)`,
      `neck [VERIFIED]: shake=${pkt.neck.shake.toFixed(4)} rad  nod=${pkt.neck.nod.toFixed(4)} rad (-UP flipped)  valid=${neckCheck.ok ? 'PASS' : 'REFUSED'}`,
      `arms [BLOCKED]:  ${pkt.arms.unverifiedJoints.length}/14 joints unverified (${armCheck.errors.length} gated)`,
      `  L: j13=${pkt.arms.positions.idx13_left_arm_joint1.toFixed(2)} j14=${pkt.arms.positions.idx14_left_arm_joint2.toFixed(2)} j16=${pkt.arms.positions.idx16_left_arm_joint4.toFixed(2)} j18=${pkt.arms.positions.idx18_left_arm_joint6.toFixed(2)} j19=${pkt.arms.positions.idx19_left_arm_joint7.toFixed(2)}`,
      `  R: j20=${pkt.arms.positions.idx20_right_arm_joint1.toFixed(2)} j21=${pkt.arms.positions.idx21_right_arm_joint2.toFixed(2)} j23=${pkt.arms.positions.idx23_right_arm_joint4.toFixed(2)} j25=${pkt.arms.positions.idx25_right_arm_joint6.toFixed(2)} j26=${pkt.arms.positions.idx26_right_arm_joint7.toFixed(2)}`,
      `hands [0..2000]: L=[${Object.values(pkt.hands.left).join(',')}]`,
      `                 R=[${Object.values(pkt.hands.right).join(',')}]`,
    ].join('\n');
  });

  syncSafetyProfileUI();

  // Look at Cursor toggle in viewport camera bar
  $('cursorGazeBtn')?.addEventListener('click', () => {
    state.cursorGaze = !state.cursorGaze;
    $('cursorGazeBtn').classList.toggle('active', state.cursorGaze);
    if (!state.cursorGaze) {
      state.motion.clearHeadGazeOverride();
      $('headPad')?.classList.remove('active');
    }
  });

  // 2D Interactive Head Pan & Tilt Gimbal Pad (adapts dynamically to active safety profile limits)
  const headPad = $('headPad');
  function applyHeadPadEvent(e) {
    if (!headPad || !state.motion) return;
    const rect = headPad.getBoundingClientRect();
    const nx = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    const ny = clamp((e.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
    const yawLim = state.model.limits('idx27_head_joint1');
    const pitchLim = state.model.limits('idx28_head_joint2');
    const yawLo = yawLim?.lower ?? -0.785;
    const yawHi = yawLim?.upper ?? 0.785;
    const pLo = pitchLim?.lower ?? -0.401;
    const pHi = pitchLim?.upper ?? 0.401;
    const yaw = yawLo + nx * (yawHi - yawLo);
    const pitch = pLo + (1 - ny) * (pHi - pLo);
    state.cursorGaze = false;
    $('cursorGazeBtn')?.classList.remove('active');
    headPad.classList.add('active');
    state.motion.manualOverrides.delete('idx27_head_joint1');
    state.motion.manualOverrides.delete('idx28_head_joint2');
    state.motion.setHeadGazeOverride(yaw, pitch);
  }
  headPad?.addEventListener('pointerdown', (e) => {
    state.headPadDragging = true;
    headPad.setPointerCapture(e.pointerId);
    applyHeadPadEvent(e);
  });
  headPad?.addEventListener('pointermove', (e) => {
    if (!state.headPadDragging) return;
    applyHeadPadEvent(e);
  });
  headPad?.addEventListener('pointerup', (e) => {
    state.headPadDragging = false;
    try { headPad.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  headPad?.addEventListener('pointercancel', () => { state.headPadDragging = false; });

  document.querySelectorAll('[data-head-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const [yawDeg, pitchDeg] = btn.dataset.headPreset.split(',').map(Number);
      state.cursorGaze = false;
      $('cursorGazeBtn')?.classList.remove('active');
      headPad?.classList.add('active');
      state.motion.manualOverrides.delete('idx27_head_joint1');
      state.motion.manualOverrides.delete('idx28_head_joint2');
      state.motion.setHeadGazeOverride(yawDeg * DEG, pitchDeg * DEG);
    });
  });

  document.querySelectorAll('[data-head-gesture]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.cursorGaze = false;
      $('cursorGazeBtn')?.classList.remove('active');
      headPad?.classList.remove('active');
      state.motion.clearHeadGazeOverride();
      state.motion.manualOverrides.delete('idx27_head_joint1');
      state.motion.manualOverrides.delete('idx28_head_joint2');
      state.motion.playGesture(btn.dataset.headGesture);
    });
  });

  $('btnHeadAuto')?.addEventListener('click', () => {
    state.cursorGaze = false;
    $('cursorGazeBtn')?.classList.remove('active');
    headPad?.classList.remove('active');
    state.motion.clearHeadGazeOverride();
    state.motion.manualOverrides.delete('idx27_head_joint1');
    state.motion.manualOverrides.delete('idx28_head_joint2');
  });

  // Orbit & Zoom + optional Look-at-Cursor on 3D Canvas
  canvas.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    state.dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (state.dragging) {
      state.camTarget.azim -= e.movementX * 0.006;
      state.camTarget.elev = clamp(state.camTarget.elev + e.movementY * 0.0045, -0.45, 0.95);
      return;
    }
    if (state.cursorGaze && state.motion) {
      const rect = canvas.getBoundingClientRect();
      const nx = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
      const ny = clamp((e.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
      const yawLim = state.model.limits('idx27_head_joint1');
      const pitchLim = state.model.limits('idx28_head_joint2');
      const yaw = (nx * 2 - 1) * (yawLim?.upper ?? 0.785);
      const pitch = clamp((0.46 - ny) * 1.15, pitchLim?.lower ?? -0.401, pitchLim?.upper ?? 0.401);
      state.motion.setHeadGazeOverride(yaw, pitch);
    }
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.camTarget.dist = clamp(state.camTarget.dist * (1 + Math.sign(e.deltaY) * 0.08), 0.72, 4.2);
  }, { passive: false });
}

/* ---------------------------------------------------------- Render Loop */

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
}

function updateTrackingReadout(tracked) {
  if (!tracked) return;
  $('pipGesture').textContent = tracked.detectedGesture.toUpperCase();
  $('detectedGestureChip').textContent = tracked.detectedGesture;
  const openL = Math.round((tracked.openness?.left ?? 0) * 100);
  const openR = Math.round((tracked.openness?.right ?? 0) * 100);
  $('openBarL').style.width = `${openL}%`;
  $('openValL').textContent = `${openL}%`;
  $('openBarR').style.width = `${openR}%`;
  $('openValR').textContent = `${openR}%`;
  $('handsBar').style.width = `${(tracked.handCount / 2) * 100}%`;
  $('handsVal').textContent = `${tracked.handCount} / 2`;

  const j = tracked.joints;
  const ts = tracked.trackingState;
  const deg = (v) => `${Math.round((v || 0) / DEG)}°`;
  const armTag = (s) => (s === 'LOCKED' ? 'LOCK' : (s || 'LOCK'));
  $('trackTelemetry').innerHTML = [
    ['Head Yaw', deg(j.idx27_head_joint1)],
    ['Head Pitch', deg(j.idx28_head_joint2)],
    ['L Arm', ts ? `${armTag(ts.leftArm)} · ${deg(j.idx14_left_arm_joint2)}` : deg(j.idx14_left_arm_joint2)],
    ['R Arm', ts ? `${armTag(ts.rightArm)} · ${deg(j.idx21_right_arm_joint2)}` : deg(j.idx21_right_arm_joint2)],
    ['L Elbow', deg(j.idx16_left_arm_joint4)],
    ['R Elbow', deg(j.idx23_right_arm_joint4)],
  ].map(([k, v]) => `<div class="kv-box"><span>${k}</span><b>${v}</b></div>`).join('');

  // Auto-react in Gaze Follow mode when user waves at Luka
  const now = performance.now();
  if (
    state.trackRetargetMode === 'gaze' &&
    tracked.detectedGesture !== 'Neutral' &&
    tracked.detectedGesture !== state.lastObservedGesture &&
    now - state.lastObsAt > 5000
  ) {
    state.lastObservedGesture = tracked.detectedGesture;
    state.lastObsAt = now;
    state.trellis.recordObservation(tracked.detectedGesture, { source: state.tracker.sourceMode });
    if (tracked.detectedGesture === 'Wave / Greeting' && state.phase === 'idle') {
      state.motion.playGesture('wave', { duration: 2.6 });
    }
  }
}

function tick(now) {
  const dt = clamp((now - (state.lastTs || now)) / 1000, 0.004, 0.05);
  state.lastTs = now;

  // 1. Step Kameyoko Vision Tracker
  let tracked = null;
  if (state.tracker?.running) {
    tracked = state.tracker.update(now, dt);
    if (tracked) state.motion.setTrackedPose(tracked);
  }

  // 2. Sample live speech audio RMS or mic level
  const speechRms = state.phase === 'speaking' ? samplePlaybackRms() : 0;
  state.motion.setSpeechLevel(speechRms);
  const micPct = state.recorder.recording
    ? clamp(state.recorder.level * 550, 0, 100)
    : speechRms * 100;
  $('micLevelFill').style.width = `${micPct.toFixed(0)}%`;
  $('holdTimer').textContent = state.recorder.recording
    ? `${((now - state.micStartedAt) / 1000).toFixed(1)}s`
    : '';

  // 3. Step Luka natural upper-body choreography & FK
  const stepOut = state.motion.step(dt);
  state.model.forward(stepOut.pose, { x: 0, y: 0, z: 0, yaw: 0 });

  // Copy URDF drawable matrices + extra links (logo.stl attached to base_link, studio_pedestal at origin)
  state.matrices.set(state.model.flat, 0);
  const baseCount = state.model.drawables.length;
  for (let i = 0; i < state.extraLinks.length; i++) {
    const ext = state.extraLinks[i];
    const mat = ext.parentLink ? state.model.matrices.get(ext.parentLink) : m4.identity();
    state.matrices.set(mat || m4.identity(), (baseCount + i) * 16);
  }

  // 4. Smoothly damp camera & render studio frame
  state.cam.azim = damp(state.cam.azim, state.camTarget.azim, 9, dt);
  state.cam.elev = damp(state.cam.elev, state.camTarget.elev, 9, dt);
  state.cam.dist = damp(state.cam.dist, state.camTarget.dist, 9, dt);
  for (let k = 0; k < 3; k++) {
    state.cam.target[k] = damp(state.cam.target[k], state.camTarget.target[k], 9, dt);
  }
  state.renderer.updateCameraFromOrbit(state.cam.azim, state.cam.elev, state.cam.dist, state.cam.target);
  state.renderer.setVisorFx(stepOut.visorFx);
  state.renderer.draw(state.matrices, state.colors, state.materials);

  // Smooth 60Hz update for 2D Head Pan & Tilt gimbal pad reticle (scaled to active profile bounds)
  const liveDot = $('headLiveDot');
  if (liveDot) {
    const yawLim = state.model.limits('idx27_head_joint1');
    const pitchLim = state.model.limits('idx28_head_joint2');
    const yawLo = yawLim?.lower ?? -0.785;
    const yawHi = yawLim?.upper ?? 0.785;
    const pLo = pitchLim?.lower ?? -0.401;
    const pHi = pitchLim?.upper ?? 0.401;
    const yaw = stepOut.pose.idx27_head_joint1 || 0;
    const pitch = stepOut.pose.idx28_head_joint2 || 0;
    const lx = clamp((yaw - yawLo) / Math.max(yawHi - yawLo, 1e-4), 0.04, 0.96) * 100;
    const ly = clamp(1 - (pitch - pLo) / Math.max(pHi - pLo, 1e-4), 0.06, 0.94) * 100;
    liveDot.style.left = `${lx.toFixed(1)}%`;
    liveDot.style.top = `${ly.toFixed(1)}%`;

    const tgtDot = $('headTargetDot');
    if (tgtDot) {
      const ov = state.motion.headGazeOverride;
      tgtDot.hidden = !ov;
      if (ov) {
        const tx = clamp((ov.yaw - yawLo) / Math.max(yawHi - yawLo, 1e-4), 0.04, 0.96) * 100;
        const ty = clamp(1 - (ov.pitch - pLo) / Math.max(pHi - pLo, 1e-4), 0.06, 0.94) * 100;
        tgtDot.style.left = `${tx.toFixed(1)}%`;
        tgtDot.style.top = `${ty.toFixed(1)}%`;
      }
    }
  }

  // 5. Periodic HUD + slider readouts (10 Hz)
  state.uiSyncAcc += dt;
  if (state.uiSyncAcc >= 0.1) {
    state.uiSyncAcc = 0;
    const p = stepOut.pose;
    const yawDeg = Math.round((p.idx27_head_joint1 || 0) / DEG);
    const pitchDeg = Math.round((p.idx28_head_joint2 || 0) / DEG);
    $('readHeadYaw').textContent = `${yawDeg}°`;
    $('readHeadPitch').textContent = `${pitchDeg}°`;
    if ($('headPadReadout')) $('headPadReadout').textContent = `${yawDeg}° · ${pitchDeg}°`;
    $('readLElbow').textContent = `${Math.round(Math.abs(p.idx16_left_arm_joint4 || 0) / DEG)}°`;
    $('readRElbow').textContent = `${Math.round(Math.abs(p.idx23_right_arm_joint4 || 0) / DEG)}°`;
    $('readRms').textContent = `${Math.round(speechRms * 100)}%`;

    const gLabel = stepOut.activeGestureName
      ? stepOut.activeGestureName.replace(/_/g, ' ').toUpperCase()
      : (state.motion.trackingMode === 'mirror' ? 'MIRRORING' : 'BREATHING');
    $('hudGestureTag').textContent = gLabel;
    $('gestureNow').textContent = stepOut.activeGestureName || 'autonomous';

    // Sync non-overridden sliders lightly so user sees Luka's live joint travel
    document.querySelectorAll('#jointSliders input[data-joint]').forEach((el) => {
      const jn = el.dataset.joint;
      if (state.motion.manualOverrides.has(jn)) return;
      const degVal = Math.round((p[jn] || 0) / DEG);
      el.value = String(degVal);
      el.nextElementSibling.textContent = `${degVal}°`;
    });

    // Update live 10-finger RH56 curl visualizer bars (bar height = openness: tall = open, low = curled fist)
    if (stepOut.hands) {
      document.querySelectorAll('#fingerBars i[data-finger]').forEach((bar) => {
        const [side, fname] = bar.dataset.finger.split(':');
        const curl = clamp(stepOut.hands[side]?.[fname] ?? 0.24, 0, 1);
        const openPct = Math.round((1 - curl) * 100);
        bar.style.height = `${Math.max(8, openPct)}%`;
      });
    }

    // Update live Hardware Safety Envelope HUD
    if (stepOut.safety) {
      const sf = stepOut.safety;
      const shortName = sf.softHold ? 'HOLD' : (sf.profileId === 'bringup' ? 'BRING-UP' : sf.profileId === 'hardware' ? 'HW SPEC' : 'STUDIO');
      if ($('safetyPill')) $('safetyPill').textContent = shortName;
      if ($('safetyDot')) {
        $('safetyDot').className = `dot ${sf.softHold ? 'danger' : (!sf.hardwareEnforced || sf.status === 'CLAMPING' ? 'warn' : 'on')}`;
      }
      if ($('safetyStatusBadge')) {
        $('safetyStatusBadge').textContent = sf.status;
        $('safetyStatusBadge').className = `badge ${sf.softHold ? 'hold' : (sf.status === 'CLAMPING' || !sf.hardwareEnforced ? 'warn' : 'live')}`;
      }
      if ($('safeSpdBar')) {
        $('safeSpdBar').style.width = `${clamp(sf.peakSpeedPct, 0, 100)}%`;
        $('safeSpdBar').classList.toggle('warn', sf.peakSpeedPct >= 80);
        $('safeSpdVal').textContent = `${sf.peakSpeedRadS.toFixed(2)} r/s`;
      }
      if ($('safeAccBar')) {
        $('safeAccBar').style.width = `${clamp(sf.peakAccelPct, 0, 100)}%`;
        $('safeAccBar').classList.toggle('warn', sf.peakAccelPct >= 80);
        $('safeAccVal').textContent = `${sf.peakAccelRadS2.toFixed(1)} r/s²`;
      }
      if ($('safeWristLBar')) {
        $('safeWristLBar').style.width = `${clamp(sf.wristLoadL, 0, 100)}%`;
        $('safeWristLBar').classList.toggle('warn', sf.wristLoadL >= 90);
        $('safeWristLVal').textContent = `${sf.wristLoadL}%`;
      }
      if ($('safeWristRBar')) {
        $('safeWristRBar').style.width = `${clamp(sf.wristLoadR, 0, 100)}%`;
        $('safeWristRBar').classList.toggle('warn', sf.wristLoadR >= 90);
        $('safeWristRVal').textContent = `${sf.wristLoadR}%`;
      }
      if ($('safetyClampsNote')) {
        if (sf.softHold) {
          $('safetyClampsNote').textContent = 'SOFT HOLD ACTIVE · targets frozen at current pose';
        } else if (!sf.hardwareEnforced) {
          $('safetyClampsNote').textContent = 'STUDIO WIDE (SIM ONLY) · exceeds real neck/wrist hardware limits';
        } else if (sf.activeClamps.length) {
          $('safetyClampsNote').textContent = `Envelope limiting: ${sf.activeClamps.slice(0, 3).join(', ')}`;
        } else {
          $('safetyClampsNote').textContent = `All joints inside AimDK §7.1.5–9 (${sf.profileLabel}) · physical writes closed`;
        }
      }
    }

    if (tracked) {
      updateTrackingReadout(tracked);
      // Track Kameyoko failsafe transitions (LOCKED -> HOLD) so we learn real-world occlusion causes
      const ts = tracked.trackingState;
      if (ts) {
        for (const [side, stKey, rKey] of [['left', 'leftArm', 'leftReason'], ['right', 'rightArm', 'rightReason']]) {
          const prev = state.prevArmTrackState?.[side];
          const cur = ts[stKey];
          if (prev === 'LOCKED' && cur === 'HOLD') {
            metrics.track('vision_guard', {
              category: 'vision',
              label: ts[rKey] || 'hold',
              meta: { side, source: state.tracker?.sourceMode || 'camera' },
            });
          }
        }
        state.prevArmTrackState = { left: ts.leftArm, right: ts.rightArm };
      }
    }

    // Periodic 30s actuator envelope & FPS learning snapshot
    if (stepOut.safety) {
      const sf = stepOut.safety;
      state.metricSnap = state.metricSnap || { elapsed: 0, peakSpeed: 0, peakAccel: 0, wristLoadMax: 0, clamps: new Set() };
      state.metricSnap.elapsed += 0.1;
      state.metricSnap.peakSpeed = Math.max(state.metricSnap.peakSpeed, sf.peakSpeedRadS || 0);
      state.metricSnap.peakAccel = Math.max(state.metricSnap.peakAccel, sf.peakAccelRadS2 || 0);
      state.metricSnap.wristLoadMax = Math.max(state.metricSnap.wristLoadMax, sf.wristLoadL || 0, sf.wristLoadR || 0);
      for (const c of sf.activeClamps || []) state.metricSnap.clamps.add(c);
      if (state.metricSnap.elapsed >= 30) {
        metrics.track('safety_snapshot', {
          category: 'safety',
          label: sf.profileId,
          value: state.fps || null,
          meta: {
            fps: state.fps || 0,
            peakSpeed: state.metricSnap.peakSpeed,
            peakAccel: state.metricSnap.peakAccel,
            wristLoadMax: state.metricSnap.wristLoadMax,
            clamps: [...state.metricSnap.clamps].slice(0, 6),
          },
        });
        state.metricSnap = { elapsed: 0, peakSpeed: 0, peakAccel: 0, wristLoadMax: 0, clamps: new Set() };
      }
    }
  }

  // FPS counter
  state.frames += 1;
  state.fpsAcc += dt;
  if (state.fpsAcc >= 0.45) {
    state.fps = Math.round(state.frames / state.fpsAcc);
    $('fpsChip').textContent = `${state.fps} fps`;
    state.frames = 0;
    state.fpsAcc = 0;
  }

  requestAnimationFrame(tick);
}

const escapeHtml = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* --------------------------------------------------------------- Startup */

async function boot() {
  try {
    await boot3D();
    buildGestureAndJointControls();
    wireUI();
    state.trellis.subscribe(renderTrellisPanels);
    await state.trellis.hydrateFromDisk();
    renderTrellisPanels();
    void loadHealthAndVoices();

    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    window.__lukaSim = state;
    metrics.track('sim_boot', {
      category: 'perf',
      label: state.renderer?.kind || 'unknown',
      value: Math.round(performance.now() - bootStartedAt),
      meta: { renderer: state.renderer?.kind || 'unknown', dpr: Number((window.devicePixelRatio || 1).toFixed(2)) },
    });
    bootDone();
    requestAnimationFrame(tick);
  } catch (err) {
    console.error('[luka-sim] boot failed:', err);
    bootMsg(`Boot error: ${err.message}`);
  }
}

boot();
