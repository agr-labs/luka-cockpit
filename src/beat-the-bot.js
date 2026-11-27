// LUKA · Beat the Bot — Mission Earth & Beyond PWA Controller
// Combines:
//   - Live 3D LukaSim upper-body host simulation (WebGPU / WebGL2 + AgiBot A2 Ultra + OLED visor)
//   - Full-Duplex Interruptible & Multi-Speaker Voice Engine (Inworld Stream / Cartesia / ElevenLabs / Deepgram / Browser)
//   - Deterministic Beat-the-Bot quiz engine + inline offline SVG QR + live SSE / Cloudflare D1 multiplayer sync
//   - Ask Luka Anything (Ocean vs. Orbit) audience Q&A queue

import { loadModel } from './model.js';
import {
  createStudioRenderer,
  agibotMaterialForLink,
  isLowerBodyLink,
  parseBinaryStlToYUp,
  buildPedestalMesh,
} from './upper-renderer.js';
import { buildGrid } from './geometry.js';
import { LukaMotionController, applySymmetricUpperBodyAxes } from './luka-motion.js';
import { SCENARIO_PACKS, getScenarioPack } from './scenario-packs.js';
import {
  normalizeRoomCode,
  createRoomState,
  joinRoom,
  startIntro,
  startQuestion,
  submitAnswer,
  revealQuestion,
  showLeaderboard,
  openQaMode,
  finishMission,
  submitAudienceQuestion,
  markAudienceQuestionAnswered,
  resetRoom,
  buildPublicRoomView,
} from './beat-the-bot-engine.mjs';
import { renderQrSvg } from './qr-svg.js';
import { DuplexVoiceEngine } from './voice-duplex.js';
import { answerSteadwellQuestion } from './steadwell-knowledge.js';
import { createMetricsClient } from './metrics.js';
import { clamp, damp, m4 } from './mathx.js';

const $ = (id) => document.getElementById(id);
const isStaticBuild = document.querySelector('meta[name="luka-env"]')?.content === 'static';
const metrics = createMetricsClient('beat-the-bot');

const CAM_PRESETS = {
  host: { azim: 1.57, elev: 0.06, dist: 1.18, target: [0, 1.42, 0] },
  head: { azim: 1.57, elev: 0.05, dist: 0.84, target: [0, 1.49, 0] },
  upper: { azim: 1.48, elev: 0.07, dist: 1.56, target: [0, 1.34, 0] },
};

const RADIAL_CIRCUMFERENCE = 2 * Math.PI * 27; // ~169.65

const state = {
  role: 'stage', // 'stage' | 'player'
  transport: 'offline', // 'station-sse' | 'cloudflare-d1' | 'offline'
  lanIp: null,
  roomCode: null,
  packId: 'earth-space-trivia',
  soloMode: false,
  soloPlayerId: 'solo_commander',
  playerId: localStorage.getItem('luka.btb.playerId') || `p_${Math.random().toString(36).slice(2, 10)}`,
  playerName: localStorage.getItem('luka.btb.callsign') || '',

  // Local offline fallback room state
  offlineRoom: null,
  roomView: null,
  lastSpokenSeq: 0,
  sseSource: null,
  pollTimer: null,
  countdownTimer: null,
  autoRevealDoneForIdx: -1,

  // 3D LukaSim host state
  simBooted: false,
  model: null,
  renderer: null,
  motion: null,
  extraLinks: [],
  matrices: null,
  colors: null,
  materials: null,
  visibleMask: [],
  cam: { ...CAM_PRESETS.host, target: [...CAM_PRESETS.host.target] },
  camTarget: { ...CAM_PRESETS.host, target: [...CAM_PRESETS.host.target] },
  dragging: false,
  lastTs: 0,

  // Voice & dialogue state
  voice: null,
  muted: false,
  history: [],
  activeReasonAbort: null,
  sfxCtx: null,
  deferredPwaPrompt: null,
};

localStorage.setItem('luka.btb.playerId', state.playerId);

/* ------------------------------------------- Subtle J.A.R.V.I.S. SFX */

function playSfx(kind) {
  if (state.muted) return;
  try {
    if (!state.sfxCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.sfxCtx = new Ctx();
    }
    const ctx = state.sfxCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    const tone = (freq, dur, type = 'sine', gainVal = 0.06, delay = 0) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + delay);
      g.gain.setValueAtTime(0.0001, now + delay);
      g.gain.exponentialRampToValueAtTime(gainVal, now + delay + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, now + delay + dur);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(now + delay);
      osc.stop(now + delay + dur + 0.02);
    };
    if (kind === 'lock') {
      tone(660, 0.09, 'triangle', 0.055);
      tone(990, 0.11, 'sine', 0.045, 0.05);
    } else if (kind === 'correct') {
      tone(523.25, 0.14, 'triangle', 0.06, 0);
      tone(659.25, 0.14, 'triangle', 0.06, 0.08);
      tone(783.99, 0.24, 'sine', 0.065, 0.16);
    } else if (kind === 'wrong') {
      tone(290, 0.18, 'sawtooth', 0.035, 0);
      tone(220, 0.24, 'sawtooth', 0.035, 0.1);
    } else if (kind === 'tick') {
      tone(880, 0.05, 'sine', 0.03);
    } else if (kind === 'cut') {
      tone(420, 0.07, 'triangle', 0.05);
    } else if (kind === 'launch') {
      tone(440, 0.12, 'sine', 0.05, 0);
      tone(587.33, 0.18, 'sine', 0.055, 0.08);
    }
  } catch { /* audio optional */ }
}

/* ------------------------------------------- Live 3D LukaSim Stage */

function setBoot(pct, msg) {
  const fill = $('stageBootFill');
  const txt = $('stageBootMsg');
  if (fill) fill.style.width = `${clamp(pct, 0, 100)}%`;
  if (txt && msg) txt.textContent = msg;
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length') || 0);
  if (!res.body?.getReader) return res.arrayBuffer();
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

function resizeStageCanvas() {
  const canvas = $('lukaStageCanvas');
  if (!canvas || !state.renderer) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    state.renderer.resize(w, h);
  }
}

async function bootLuka3DStage() {
  if (state.simBooted || state.role !== 'stage') return;
  const canvas = $('lukaStageCanvas');
  if (!canvas) return;
  state.simBooted = true;

  try {
    setBoot(12, 'Starting WebGPU / WebGL2 renderer…');
    state.renderer = await createStudioRenderer(canvas);
    if ($('lukaRendererPill')) $('lukaRendererPill').textContent = state.renderer.kind.toUpperCase();

    setBoot(24, 'Loading AgiBot A2 Ultra kinematics…');
    state.model = await loadModel('./model/generated/luka.model.json');
    applySymmetricUpperBodyAxes(state.model);
    state.motion = new LukaMotionController(state.model);

    const [meshJson, meshBuf, logoBuf] = await Promise.all([
      fetch('./model/generated/luka.mesh.json').then((r) => r.json()),
      fetchWithProgress('./model/generated/luka.mesh.bin', (got, total) => {
        const mb = (got / 1e6).toFixed(1);
        setBoot(total ? 24 + (got / total) * 68 : 78, `Loading LukaSim host · ${mb} MB`);
      }),
      fetch('./model/meshes/logo.stl').then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null),
    ]);

    const baseVerts = new Float32Array(meshBuf);
    const ranges = [...meshJson.ranges];
    const extraChunks = [];
    let vertCursor = baseVerts.length / 6;

    if (logoBuf) {
      try {
        const parsed = parseBinaryStlToYUp(logoBuf, 1);
        extraChunks.push(parsed.data);
        ranges.push({ link: 'chest_logo', first: vertCursor, count: parsed.vertexCount, tris: parsed.triCount });
        state.extraLinks.push({ name: 'chest_logo', parentLink: 'base_link' });
        vertCursor += parsed.vertexCount;
      } catch { /* optional */ }
    }

    const pedestalVerts = buildPedestalMesh(0.84, 0.21, 0.34, 64);
    extraChunks.push(pedestalVerts);
    ranges.push({ link: 'studio_pedestal', first: vertCursor, count: pedestalVerts.length / 6, tris: pedestalVerts.length / 18 });
    state.extraLinks.push({ name: 'studio_pedestal', parentLink: null });
    vertCursor += pedestalVerts.length / 6;

    const combined = new Float32Array(vertCursor * 6);
    combined.set(baseVerts, 0);
    let writeOff = baseVerts.length;
    for (const ch of extraChunks) { combined.set(ch, writeOff); writeOff += ch.length; }

    state.matrices = new Float32Array(ranges.length * 16);
    state.colors = new Float32Array(ranges.length * 4);
    state.materials = new Float32Array(ranges.length * 4);
    for (let i = 0; i < ranges.length; i++) {
      const mat = agibotMaterialForLink(ranges[i].link);
      state.colors.set(mat.color, i * 4);
      state.materials.set(mat.material, i * 4);
    }

    state.renderer.setRobotMesh(combined, ranges);
    state.renderer.setGridMesh(buildGrid(10, 0.25, 0.818));
    state.visibleMask = ranges.map((r) => !isLowerBodyLink(r.link));
    state.renderer.setVisibleMask(state.visibleMask);

    resizeStageCanvas();
    window.addEventListener('resize', resizeStageCanvas);
    bindCanvasOrbit(canvas);

    setBoot(100, 'LukaSim 3D Host Online');
    const bootEl = $('stageBoot');
    if (bootEl) {
      bootEl.classList.add('done');
      setTimeout(() => { bootEl.hidden = true; }, 380);
    }

    setTimeout(() => state.motion?.playGesture('wave', { duration: 2.6 }), 450);
    requestAnimationFrame(tickStage3D);
  } catch (err) {
    console.error('[beat-the-bot] 3D boot error:', err);
    setBoot(100, `3D fallback active (${err.message})`);
  }
}

function bindCanvasOrbit(canvas) {
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    state.dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!state.dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    state.camTarget.azim -= dx * 0.006;
    state.camTarget.elev = clamp(state.camTarget.elev + dy * 0.005, -0.35, 0.55);
  });
  const endDrag = () => { state.dragging = false; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.camTarget.dist = clamp(state.camTarget.dist + e.deltaY * 0.001, 0.72, 2.2);
  }, { passive: false });
}

function tickStage3D(now) {
  if (!state.renderer || !state.model || !state.motion) return;
  const dt = clamp((now - (state.lastTs || now)) / 1000, 0.004, 0.05);
  state.lastTs = now;

  if (state.role === 'stage' && !document.hidden) {
    resizeStageCanvas();
    const rms = state.voice?.speaking ? state.voice.samplePlaybackRms() : 0;
    state.motion.setSpeechLevel(rms);
    updateCaptionWaveform(rms, now);

    const stepOut = state.motion.step(dt);
    state.model.forward(stepOut.pose, { x: 0, y: 0, z: 0, yaw: 0 });

    state.matrices.set(state.model.flat, 0);
    const baseCount = state.model.drawables.length;
    for (let i = 0; i < state.extraLinks.length; i++) {
      const ext = state.extraLinks[i];
      const mat = ext.parentLink ? state.model.matrices.get(ext.parentLink) : m4.identity();
      state.matrices.set(mat || m4.identity(), (baseCount + i) * 16);
    }

    state.cam.azim = damp(state.cam.azim, state.camTarget.azim, 8, dt);
    state.cam.elev = damp(state.cam.elev, state.camTarget.elev, 8, dt);
    state.cam.dist = damp(state.cam.dist, state.camTarget.dist, 8, dt);
    for (let k = 0; k < 3; k++) {
      state.cam.target[k] = damp(state.cam.target[k], state.camTarget.target[k], 8, dt);
    }

    state.renderer.updateCameraFromOrbit(state.cam.azim, state.cam.elev, state.cam.dist, state.cam.target);
    state.renderer.setVisorFx(stepOut.visorFx);
    state.renderer.draw(state.matrices, state.colors, state.materials);

    if ($('lukaGesturePill')) {
      $('lukaGesturePill').textContent = (stepOut.activeGestureName || state.motion.mode || 'IDLE').toUpperCase();
    }
  }

  requestAnimationFrame(tickStage3D);
}

function updateCaptionWaveform(rms, now) {
  const host = $('jarvisWaveBars');
  if (!host) return;
  const bars = host.children;
  const t = now * 0.013;
  for (let i = 0; i < bars.length; i++) {
    const center = 1 - Math.abs(i - 3) * 0.14;
    const wave = rms > 0.02
      ? clamp(0.24 + rms * center * (0.65 + 0.35 * Math.sin(t + i * 1.2)) * 1.35, 0.2, 1.3)
      : 0.18 + 0.06 * Math.sin(t * 0.3 + i);
    bars[i].style.transform = `scaleY(${wave.toFixed(2)})`;
  }
}

/* ------------------------------------ Voice & Live CoRa Stage Banter */

function initVoice() {
  state.voice = new DuplexVoiceEngine({
    isStaticBuild,
    onStateChange: (phase, info = {}) => {
      const vp = $('jarvisViewport');
      if (vp) vp.dataset.voiceState = phase;
      const lbl = $('lukaStateLabel');
      const labels = {
        idle: 'ONLINE · READY',
        duplex_ready: 'DUPLEX BARGE-IN ARMED',
        listening: info.wasInterrupted ? `INTERRUPTED · HEARING ${(info.speakerLabel || 'HOST').toUpperCase()}` : `LISTENING · ${(info.speakerLabel || 'HOST').toUpperCase()}`,
        transcribing: 'TRANSCRIBING AUDIO…',
        speaking: info.provider ? `SPEAKING · ${info.provider.toUpperCase()}` : 'LUKA SPEAKING',
        interrupted: 'CUT · INTERRUPTED',
      };
      if (lbl) lbl.textContent = labels[phase] || 'ONLINE';

      if (state.motion) {
        const modeMap = { listening: 'listening', transcribing: 'thinking', speaking: 'speaking', interrupted: 'listening' };
        state.motion.setMode(modeMap[phase] || 'idle');
      }
    },
    onInterrupt: ({ reason, speakerLabel }) => {
      if (state.activeReasonAbort) {
        try { state.activeReasonAbort.abort(); } catch { /* ignore */ }
        state.activeReasonAbort = null;
      }
      if (reason === 'barge_in' || reason === 'manual') {
        playSfx('cut');
        metrics.track('voice_interrupt', {
          category: 'speech',
          label: reason,
          meta: { speaker: speakerLabel || 'Host', phase: state.roomView?.phase || 'lobby' },
        });
      }
    },
    onMicLevel: (lvl) => {
      const fill = $('duplexMicFill');
      if (fill) fill.style.width = `${Math.round(lvl * 100)}%`;
    },
    onProviderInfo: (caps) => {
      const el = $('voiceProviderLabel');
      if (!el || !caps) return;
      const pMap = {
        cartesia: 'CARTESIA SONIC-3',
        elevenlabs: 'ELEVENLABS FLASH',
        'deepgram-aura': 'DEEPGRAM AURA-2',
        'inworld-stream': 'INWORLD STREAM',
        say: 'LOCAL SAY',
        browser: 'BROWSER VOICE',
      };
      const base = pMap[caps.preferredStreaming] || 'STREAMING VOICE';
      el.textContent = caps.asr?.diarizationReady ? `${base} · NOVA-3 DIARIZE` : base;
    },
    onUserUtterance: (utterance) => {
      void handleStageConversation({
        text: utterance.transcript,
        speakerLabel: utterance.speakerLabel,
        wasInterrupted: utterance.wasInterrupted,
      });
    },
  });
  void state.voice.loadCapabilities();
}

function buildGameContextForCoRa() {
  const rv = state.roomView;
  if (!rv) return 'Beat the Bot: Mission Earth & Beyond game show lobby.';
  const topHuman = rv.leaderboard?.find((p) => !p.isBot);
  const parts = [
    `Active scenario: ${rv.packName} (${rv.packSubtitle}).`,
    `Room ${rv.code}, Phase: ${rv.phase}, Round ${Math.max(0, rv.questionIndex + 1)} of ${rv.totalQuestions}.`,
    `Scoreboard: Humans leader ${topHuman ? `${topHuman.name} (${topHuman.score} pts)` : '0 pts'} vs Luka (${rv.lukaScore} pts). ${rv.humanCount} human players joined.`,
  ];
  if (rv.question) {
    parts.push(`Current question (${rv.question.category}): ${rv.question.prompt}`);
    if (rv.question.fact) parts.push(`Verified mission fact: ${rv.question.fact}`);
  }
  return parts.join(' ');
}

function staticStageFallbackReply(text, { speakerLabel = 'Guest', wasInterrupted = false } = {}) {
  const steadwell = answerSteadwellQuestion(text);
  if (steadwell) return { reply: steadwell.reply, gesture: steadwell.gesture || 'explain' };

  const low = String(text || '').toLowerCase();
  const prefix = wasInterrupted ? `Ooh, cutting right in, ${speakerLabel} — ` : '';
  if (/\b(ocean|sea|deep|water|mariana)\b/.test(low) && /\b(space|orbit|mars|moon)\b/.test(low)) {
    return {
      reply: `${prefix}Space has vacuum and radiation, yet saltwater swallows radar and light instantly. That is why we actually have sharper maps of Mars than our own deep ocean floor.`,
      gesture: 'explain',
    };
  }
  if (/\b(human|humans|robot|robots|first|better)\b/.test(low)) {
    return {
      reply: `${prefix}Robots should always scout first into crushing ocean trenches and lunar craters, while humans bring the curiosity and final judgment. Best team in the solar system.`,
      gesture: 'nod',
    };
  }
  if (/\b(roast|trash talk|smack|beat|win|competitive)\b/.test(low)) {
    return {
      reply: `${prefix}Your species built the James Webb Space Telescope, yet my leaderboard telemetry says silicon is still cruising in first place. Prove me wrong on the next round!`,
      gesture: 'celebrate',
    };
  }
  return {
    reply: `${prefix}Great question, ${speakerLabel}! Between deep-sea sonar and orbital robotics, bounded local intelligence on Steadwell hardware keeps the mission sharp even when venue Wi-Fi drops.`,
    gesture: 'explain',
  };
}

async function handleStageConversation({ text, speakerLabel = 'Host', wasInterrupted = false, qaId = null }) {
  const clean = String(text || '').trim();
  if (!clean) return;
  if (state.activeReasonAbort) {
    try { state.activeReasonAbort.abort(); } catch { /* ignore */ }
  }
  state.voice?.interrupt('new_turn');

  const tagEl = $('captionSpeakerTag');
  const capEl = $('lukaCaptionText');
  if (tagEl) tagEl.textContent = `${speakerLabel.toUpperCase()} → LUKA · THINKING`;
  if (capEl) capEl.textContent = `“${clean}”`;
  state.motion?.setMode('thinking');

  let reply = '';
  let gesture = 'explain';

  if (!isStaticBuild) {
    const ctrl = new AbortController();
    state.activeReasonAbort = ctrl;
    try {
      const res = await fetch('/sim-api/reason', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: clean,
          history: state.history.slice(-6),
          speakerLabel,
          wasInterrupted,
          gameContext: buildGameContextForCoRa(),
        }),
        signal: ctrl.signal,
      });
      const raw = await res.text();
      const data = raw ? JSON.parse(raw) : {};
      if (res.ok && data.ok && data.reply) {
        reply = data.reply;
        gesture = data.gesture || 'explain';
      }
    } catch (err) {
      if (err?.name === 'AbortError') return;
    } finally {
      if (state.activeReasonAbort === ctrl) state.activeReasonAbort = null;
    }
  }

  if (!reply) {
    const fb = staticStageFallbackReply(clean, { speakerLabel, wasInterrupted });
    reply = fb.reply;
    gesture = fb.gesture;
  }

  state.history.push({ role: 'user', content: `[${speakerLabel}]: ${clean}` }, { role: 'assistant', content: reply });
  state.history = state.history.slice(-12);

  if (qaId) {
    await dispatchRoomAction('answer_qa', { qaId, reply, gesture });
  } else {
    speakAsLukaStage(reply, gesture, `${speakerLabel.toUpperCase()} · ANSWERED BY LUKA`);
  }
}

function speakAsLukaStage(text, gesture = 'explain', tag = 'LUKA v. A2U · CoRa HOST') {
  if (!text) return;
  if ($('captionSpeakerTag')) $('captionSpeakerTag').textContent = tag;
  if ($('lukaCaptionText')) $('lukaCaptionText').textContent = text;
  if (state.motion && gesture) state.motion.playGesture(gesture);
  void state.voice?.speak(text);
}

/* ------------------------------------------- Multi-Transport Room Sync */

async function createHostedRoom(packId = state.packId) {
  stopRoomListeners();
  state.packId = packId;

  if (!isStaticBuild) {
    try {
      const res = await fetch('/sim-api/game/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ packId }),
      });
      const data = await res.json();
      if (res.ok && data.ok && data.state) {
        state.transport = 'station-sse';
        state.lanIp = data.lanIp || null;
        state.roomCode = data.state.code;
        applyRoomView(data.state);
        startSseStream(data.state.code, null);
        updateTransportBadge();
        return;
      }
    } catch { /* fall through */ }
  } else {
    try {
      const res = await fetch('/api/game', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'create', packId }),
      });
      const data = await res.json();
      if (res.ok && data.ok && data.state) {
        state.transport = 'cloudflare-d1';
        state.roomCode = data.state.code;
        applyRoomView(data.state);
        startD1Polling(data.state.code, null);
        updateTransportBadge();
        return;
      }
    } catch { /* fall through to offline local room */ }
  }

  // Always-available offline booth fallback
  state.transport = 'offline';
  state.offlineRoom = createRoomState({ packId });
  state.roomCode = state.offlineRoom.code;
  applyRoomView(buildPublicRoomView(state.offlineRoom, { playerId: state.soloMode ? state.soloPlayerId : null }));
  updateTransportBadge();
}

function stopRoomListeners() {
  if (state.sseSource) {
    try { state.sseSource.close(); } catch { /* ignore */ }
    state.sseSource = null;
  }
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startSseStream(code, playerId) {
  stopRoomListeners();
  const qs = new URLSearchParams({ code });
  if (playerId) qs.set('playerId', playerId);
  const es = new EventSource(`/sim-api/game/stream?${qs.toString()}`);
  es.addEventListener('state', (ev) => {
    try {
      const view = JSON.parse(ev.data);
      applyRoomView(view);
    } catch { /* ignore */ }
  });
  state.sseSource = es;
}

function startD1Polling(code, playerId) {
  stopRoomListeners();
  const poll = async () => {
    if (document.hidden) return;
    try {
      const qs = new URLSearchParams({ code });
      if (playerId) qs.set('playerId', playerId);
      const res = await fetch(`/api/game?${qs.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (res.ok && data.ok && data.state) applyRoomView(data.state);
    } catch { /* retry next tick */ }
  };
  state.pollTimer = setInterval(poll, 1250);
}

async function dispatchRoomAction(action, extra = {}) {
  const code = state.roomCode;
  if (!code) return;

  if (state.transport === 'station-sse') {
    const res = await fetch('/sim-api/game/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, action, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.state) applyRoomView(data.state);
    return;
  }

  if (state.transport === 'cloudflare-d1') {
    const res = await fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'action', code, action, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.state) applyRoomView(data.state);
    return;
  }

  if (state.offlineRoom) {
    const r = state.offlineRoom;
    if (action === 'intro') startIntro(r);
    else if (action === 'next') startQuestion(r, extra.index ?? null);
    else if (action === 'reveal') revealQuestion(r, extra);
    else if (action === 'leaderboard') showLeaderboard(r);
    else if (action === 'qa') openQaMode(r);
    else if (action === 'finale') finishMission(r);
    else if (action === 'reset') resetRoom(r, { packId: extra.packId || null });
    else if (action === 'answer_qa') markAudienceQuestionAnswered(r, extra.qaId, extra.reply, extra.gesture || 'explain');
    applyRoomView(buildPublicRoomView(r, { playerId: state.soloMode ? state.soloPlayerId : null }));
  }
}

async function joinAsPlayer({ code, name, playerId = state.playerId, isSolo = false }) {
  const cleanCode = normalizeRoomCode(code);
  if (!cleanCode) throw new Error('Enter a valid 4-letter Room Code.');

  if (state.transport === 'offline' && state.offlineRoom && state.offlineRoom.code === cleanCode) {
    const { player } = joinRoom(state.offlineRoom, { playerId, name });
    const view = buildPublicRoomView(state.offlineRoom, { playerId: player.id });
    applyRoomView(view);
    return { player, view };
  }

  if (!isStaticBuild) {
    const res = await fetch('/sim-api/game/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: cleanCode, playerId, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Room ${cleanCode} not found.`);
    state.transport = 'station-sse';
    state.roomCode = cleanCode;
    if (!isSolo) startSseStream(cleanCode, data.player.id);
    applyRoomView(data.state);
    updateTransportBadge();
    return { player: data.player, view: data.state };
  }

  const res = await fetch('/api/game', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'join', code: cleanCode, playerId, name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Room ${cleanCode} not found.`);
  state.transport = 'cloudflare-d1';
  state.roomCode = cleanCode;
  if (!isSolo) startD1Polling(cleanCode, data.player.id);
  applyRoomView(data.state);
  updateTransportBadge();
  return { player: data.player, view: data.state };
}

async function submitPlayerChoice(optionIndex, playerIdOverride = null) {
  const pid = playerIdOverride || (state.soloMode ? state.soloPlayerId : state.playerId);
  const code = state.roomCode;
  if (!code) return false;
  playSfx('lock');
  if (navigator.vibrate) navigator.vibrate(18);

  if (state.transport === 'station-sse') {
    const res = await fetch('/sim-api/game/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, playerId: pid, optionIndex }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.state) applyRoomView(data.state);
    return Boolean(data.ok);
  }

  if (state.transport === 'cloudflare-d1') {
    const res = await fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'answer', code, playerId: pid, optionIndex }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.state) applyRoomView(data.state);
    return Boolean(data.ok);
  }

  if (state.offlineRoom) {
    const res = submitAnswer(state.offlineRoom, { playerId: pid, optionIndex });
    applyRoomView(buildPublicRoomView(state.offlineRoom, { playerId: pid }));
    return res.accepted;
  }
  return false;
}

async function submitAudienceQaFromPhone(text) {
  const code = state.roomCode;
  if (!code || !text.trim()) return false;
  const author = state.playerName || 'Audience';

  if (state.transport === 'station-sse') {
    const res = await fetch('/sim-api/game/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, author, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.state) applyRoomView(data.state);
    return Boolean(res.ok && data.ok);
  }

  if (state.transport === 'cloudflare-d1') {
    const res = await fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'ask', code, author, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.state) applyRoomView(data.state);
    return Boolean(res.ok && data.ok);
  }

  if (state.offlineRoom) {
    submitAudienceQuestion(state.offlineRoom, { author, text });
    applyRoomView(buildPublicRoomView(state.offlineRoom));
    return true;
  }
  return false;
}

/* ------------------------------------------- Room State Rendering */

function computeJoinUrl(code) {
  const isLocalHost = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const host = isLocalHost && state.lanIp ? `${state.lanIp}${location.port ? `:${location.port}` : ''}` : location.host;
  return `${location.protocol}//${host}${location.pathname}?join=${encodeURIComponent(code)}`;
}

function updateTransportBadge() {
  const lbl = $('transportLabel');
  const dot = $('transportDot');
  if (!lbl || !dot) return;
  if (state.transport === 'station-sse') {
    lbl.textContent = 'STATION SSE LIVE';
    dot.className = 'mc-dot';
  } else if (state.transport === 'cloudflare-d1') {
    lbl.textContent = 'CLOUD LIVE SYNC';
    dot.className = 'mc-dot cyan';
  } else {
    lbl.textContent = 'LOCAL BOOTH MODE';
    dot.className = 'mc-dot warn';
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function applyRoomView(view) {
  if (!view) return;
  const prevPhase = state.roomView?.phase;
  state.roomView = view;
  document.body.dataset.phase = view.phase;

  if ($('topRoomCode')) $('topRoomCode').textContent = view.code;
  if ($('lobbyRoomCode')) $('lobbyRoomCode').textContent = view.code;
  if ($('arenaPackBadge')) $('arenaPackBadge').textContent = view.packBadge || view.packName;

  // Scores header
  const topHuman = view.leaderboard?.find((p) => !p.isBot);
  if ($('topHumanScore')) $('topHumanScore').textContent = String(topHuman?.score ?? 0);
  if ($('topLukaScore')) $('topLukaScore').textContent = String(view.lukaScore ?? 0);
  if ($('arenaRoundChip')) {
    $('arenaRoundChip').textContent = view.questionIndex >= 0
      ? `ROUND ${view.questionIndex + 1} / ${view.totalQuestions}`
      : view.phase.toUpperCase();
  }

  // Trigger Luka's spoken commentary whenever a new speech seq arrives in stage mode
  if (state.role === 'stage' && view.lukaSpeech && view.lukaSpeech.seq !== state.lastSpokenSeq) {
    state.lastSpokenSeq = view.lukaSpeech.seq;
    // Skip auto-speaking in lobby boot so browser autoplay stays polite until user clicks Start
    if (view.phase !== 'lobby') {
      speakAsLukaStage(view.lukaSpeech.text, view.lukaSpeech.gesture || 'explain');
    } else if ($('lukaCaptionText')) {
      $('lukaCaptionText').textContent = view.lukaSpeech.text;
    }
  }

  // Play reveal chime cleanly on phase transition
  if (prevPhase === 'question' && view.phase === 'reveal') {
    if (state.soloMode && view.myAnswer) {
      playSfx(view.myAnswer.correct ? 'correct' : 'wrong');
    } else {
      playSfx('correct');
    }
  }

  if (state.role === 'stage') renderStageView(view);
  else renderPlayerView(view);
}

function renderStageView(view) {
  const show = (id, visible) => { const el = $(id); if (el) el.hidden = !visible; };
  show('viewLobby', view.phase === 'lobby');
  show('viewIntro', view.phase === 'intro');
  show('viewQuestion', view.phase === 'question' || view.phase === 'reveal');
  show('viewLeaderboard', view.phase === 'leaderboard' || view.phase === 'finale');
  show('viewQa', view.phase === 'qa');

  // Lobby QR & Roster
  if (view.phase === 'lobby') {
    const joinUrl = computeJoinUrl(view.code);
    if ($('lobbyTitle')) $('lobbyTitle').textContent = view.packName;
    if ($('lobbyJoinUrl')) $('lobbyJoinUrl').textContent = joinUrl;
    const qrHost = $('qrSvgHost');
    if (qrHost && qrHost.dataset.url !== joinUrl) {
      qrHost.dataset.url = joinUrl;
      qrHost.innerHTML = renderQrSvg(joinUrl);
    }
    if ($('lobbyPlayerCount')) $('lobbyPlayerCount').textContent = String(view.humanCount);
    const roster = $('lobbyRosterList');
    if (roster) {
      const chips = (view.leaderboard || []).map((p) =>
        `<span class="roster-chip ${p.isBot ? 'bot' : ''}">${p.isBot ? '🤖 ' : '🧑‍🚀 '}${escapeHtml(p.name)}</span>`,
      );
      roster.innerHTML = chips.join('');
    }
    renderPackSelector(view.packId);
  }

  // Intro
  if (view.phase === 'intro') {
    if ($('introQuote')) $('introQuote').textContent = `“${view.lukaSpeech?.text || ''}”`;
    if ($('introQCount')) $('introQCount').textContent = String(view.totalQuestions);
    if ($('introCrewCount')) $('introCrewCount').textContent = String(Math.max(1, view.humanCount));
  }

  // Question / Reveal
  if ((view.phase === 'question' || view.phase === 'reveal') && view.question) {
    const q = view.question;
    const isReveal = view.phase === 'reveal';
    if ($('qCategoryPill')) $('qCategoryPill').textContent = q.category;
    if ($('qProgressText')) $('qProgressText').textContent = `ROUND ${q.index + 1} OF ${q.total}`;
    if ($('qPromptText')) $('qPromptText').textContent = q.prompt;
    if ($('qAnsweredCount')) $('qAnsweredCount').textContent = `${view.answeredCount} / ${Math.max(1, view.humanCount)}`;

    const lukaPill = $('qLukaLockPill');
    if (lukaPill) {
      lukaPill.textContent = isReveal
        ? (q.lukaCorrect ? 'LUKA: NAILED IT' : 'LUKA: MISSED!')
        : (view.lukaLockedIn ? 'LUKA: LOCKED IN' : 'LUKA: CALCULATING…');
      lukaPill.classList.toggle('locked', isReveal || view.lukaLockedIn);
    }

    const totalVotes = (q.voteCounts || []).reduce((a, b) => a + b, 0);
    q.options.forEach((opt, i) => {
      const tile = document.querySelector(`#stageAnswerGrid .k-tile[data-opt="${i}"]`);
      if (!tile) return;
      $(`optLabel${i}`).textContent = opt.label;

      const picked = view.myAnswer?.optionIndex === i;
      const isCorrect = isReveal && q.correctIndex === i;
      const isLukaPick = isReveal && q.lukaChoiceIndex === i;

      tile.disabled = isReveal || (state.soloMode && Boolean(view.myAnswer));
      tile.classList.toggle('is-picked', picked);
      tile.classList.toggle('is-correct', isCorrect);
      tile.classList.toggle('is-dimmed', isReveal && !isCorrect);

      const fill = $(`optFill${i}`);
      const votes = $(`optVotes${i}`);
      const lukaTag = $(`optLuka${i}`);
      if (isReveal && q.voteCounts) {
        const count = q.voteCounts[i] || 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        if (fill) fill.style.width = `${pct}%`;
        if (votes) { votes.hidden = false; votes.textContent = `${count}`; }
      } else {
        if (fill) fill.style.width = '0%';
        if (votes) votes.hidden = true;
      }
      if (lukaTag) lukaTag.hidden = !isLukaPick;
    });

    const factCard = $('revealFactCard');
    if (factCard) {
      factCard.hidden = !isReveal;
      if (isReveal) {
        $('revealFactText').textContent = q.fact || '';
        const verdictEl = $('revealVerdictBadge');
        const ptsEl = $('revealPointsDelta');
        if (state.soloMode && view.myAnswer) {
          verdictEl.textContent = view.myAnswer.correct ? 'CORRECT · TARGET LOCKED' : 'MISSED · LUKA TAKES NOTES';
          ptsEl.textContent = view.myAnswer.correct ? `+${view.myAnswer.points} PTS` : '+0 PTS';
        } else {
          verdictEl.textContent = 'VERIFIED MISSION FACT';
          ptsEl.textContent = q.lukaCorrect ? 'LUKA CORRECT' : 'LUKA MISSED!';
        }
      }
    }

    $('btnRevealAnswer').hidden = isReveal;
    $('btnShowLeaderboard').hidden = !isReveal;
    $('btnNextQuestion').hidden = !isReveal;
    $('btnNextQuestion').textContent = q.index + 1 >= q.total ? 'Final Results →' : 'Next Round →';
  }

  // Leaderboard / Finale
  if (view.phase === 'leaderboard' || view.phase === 'finale') {
    const isFinale = view.phase === 'finale';
    const board = view.leaderboard || [];
    const maxScore = Math.max(1000, ...board.map((p) => p.score));
    const topHuman = board.find((p) => !p.isBot);
    const humansAhead = Boolean(topHuman && topHuman.score >= view.lukaScore && topHuman.score > 0);

    $('lbKicker').textContent = isFinale ? 'MISSION COMPLETE · FINAL STANDINGS' : 'LIVE TELEMETRY STANDINGS';
    $('lbHeadline').textContent = isFinale
      ? (humansAhead ? 'Humans Beat the Bot!' : 'Luka Holds the Orbit!')
      : 'Humans vs. Luka';
    $('lbVerdictPill').textContent = humansAhead ? 'HUMANS LEADING' : 'LUKA LEADING';
    $('btnLbNext').hidden = isFinale;
    $('btnLbNext').textContent = view.questionIndex + 1 >= view.totalQuestions ? 'Final Results →' : `Launch Round ${view.questionIndex + 2} →`;

    $('stageLeaderboardList').innerHTML = board.slice(0, 8).map((p, idx) => {
      const pct = Math.round((p.score / maxScore) * 100);
      return `
        <div class="lb-row ${p.isBot ? 'is-bot' : ''} ${idx === 0 ? 'is-leader' : ''}">
          <span class="lb-bar" style="width:${pct}%"></span>
          <span class="lb-rank">#${idx + 1}</span>
          <span class="lb-name">${p.isBot ? '🤖 ' : '🧑‍🚀 '}${escapeHtml(p.name)}</span>
          <span class="lb-streak">${p.streak >= 2 ? `🔥 ${p.streak}×` : ''}</span>
          <span class="lb-score">${p.score.toLocaleString()}</span>
        </div>
      `;
    }).join('');
  }

  // Ask Luka Q&A Panel
  if (view.phase === 'qa') {
    const starters = $('qaStarterChips');
    if (starters && view.qaPrompts) {
      starters.innerHTML = view.qaPrompts.map((p) =>
        `<button type="button" class="qa-chip" data-qa-starter="${escapeHtml(p)}">${escapeHtml(p)}</button>`,
      ).join('');
      starters.querySelectorAll('[data-qa-starter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          void handleStageConversation({ text: btn.dataset.qaStarter, speakerLabel: 'Moderator' });
        });
      });
    }

    const qList = $('qaQueueList');
    const items = view.askQueue || [];
    if ($('qaQueueCount')) $('qaQueueCount').textContent = String(items.length);
    if (qList) {
      if (!items.length) {
        qList.innerHTML = '<div class="qa-empty">Guests can beam questions from their phones in the “Ask Luka” tab — or tap a prompt above!</div>';
      } else {
        qList.innerHTML = items.map((item) => `
          <div class="qa-item ${item.status === 'answered' ? 'answered' : ''}">
            <div class="qa-item-copy">
              <strong>${escapeHtml(item.author)} · ${item.status === 'answered' ? 'ANSWERED' : 'LIVE QUEUE'}</strong>
              <p>${escapeHtml(item.text)}</p>
            </div>
            <button type="button" class="mc-cta cyan sm" data-answer-qa="${escapeHtml(item.id)}">
              ${item.status === 'answered' ? 'Replay' : 'Ask On Stage'}
            </button>
          </div>
        `).join('');
        qList.querySelectorAll('[data-answer-qa]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const target = items.find((x) => x.id === btn.dataset.answerQa);
            if (target) {
              void handleStageConversation({ text: target.text, speakerLabel: target.author, qaId: target.id });
            }
          });
        });
      }
    }
  }
}

function renderPlayerView(view) {
  if (!state.roomCode) return;
  $('playerJoinCard').hidden = true;
  $('playerController').hidden = false;

  const me = view.leaderboard?.find((p) => p.id === state.playerId);
  $('playerCallsignDisplay').textContent = me?.name || state.playerName || 'Explorer';
  $('playerRoomDisplay').textContent = `ROOM ${view.code} · ${view.packBadge || ''}`;
  $('playerScoreDisplay').textContent = String(me?.score ?? 0);
  $('playerRankDisplay').textContent = view.myRank > 0 ? `RANK #${view.myRank}` : 'READY';

  const kicker = $('playerPhaseKicker');
  const title = $('playerPhaseTitle');
  const sub = $('playerPhaseSub');
  const grid = $('playerAnswerGrid');

  if (view.phase === 'lobby' || view.phase === 'intro') {
    grid.hidden = true;
    kicker.textContent = 'CREW LOCKED IN';
    title.textContent = view.phase === 'intro' ? 'Luka is briefing the room!' : 'Waiting for Mission Control to start…';
    sub.textContent = `${view.humanCount} human challengers ready vs. Luka v. A2U.`;
  } else if (view.phase === 'question' && view.question) {
    const q = view.question;
    kicker.textContent = `${q.category} · ROUND ${q.index + 1}/${q.total}`;
    title.textContent = view.myAnswer ? 'Answer Locked In!' : q.prompt;
    sub.textContent = view.myAnswer ? 'Eyes on the big screen for Luka’s reveal…' : 'Tap your tile fast for speed bonus!';
    grid.hidden = false;
    q.options.forEach((opt, i) => {
      const btn = document.querySelector(`#playerAnswerGrid .k-tile[data-p-opt="${i}"]`);
      if (!btn) return;
      $(`pOpt${i}`).textContent = opt.label;
      btn.disabled = Boolean(view.myAnswer);
      btn.classList.toggle('is-picked', view.myAnswer?.optionIndex === i);
      btn.classList.remove('is-correct', 'is-dimmed');
    });
  } else if (view.phase === 'reveal' && view.question) {
    grid.hidden = true;
    if (view.myAnswer) {
      kicker.textContent = view.myAnswer.correct ? 'DIRECT HIT!' : 'NOT THIS ROUND';
      title.textContent = view.myAnswer.correct ? `+${view.myAnswer.points} points!` : 'Luka takes a shot at you…';
    } else {
      kicker.textContent = 'TIME EXPIRED';
      title.textContent = 'Too slow on that orbit!';
    }
    sub.textContent = view.question.fact || '';
  } else if (view.phase === 'leaderboard' || view.phase === 'finale') {
    grid.hidden = true;
    kicker.textContent = view.phase === 'finale' ? 'MISSION COMPLETE' : 'SCOREBOARD UPDATE';
    title.textContent = `Rank #${view.myRank || '-'} · ${(me?.score ?? 0).toLocaleString()} pts`;
    sub.textContent = (me?.score ?? 0) >= view.lukaScore ? 'You are beating Luka right now!' : `Luka has ${view.lukaScore.toLocaleString()} pts — catch him next round!`;
  } else if (view.phase === 'qa') {
    grid.hidden = true;
    kicker.textContent = 'ASK LUKA ANYTHING LIVE';
    title.textContent = 'Switch to the “Ask Luka” tab to beam a question to the stage!';
    sub.textContent = '';
  }
}

function renderPackSelector(activeId) {
  const host = $('packSelector');
  if (!host) return;
  host.innerHTML = SCENARIO_PACKS.map((p) => `
    <button type="button" class="pack-card-btn ${p.id === activeId ? 'is-active' : ''}" data-pack-id="${escapeHtml(p.id)}">
      <strong>${escapeHtml(p.name.replace(/^Beat the Bot:\s*/, ''))}</strong>
      <small>${escapeHtml(p.durationLabel)}</small>
    </button>
  `).join('');
  host.querySelectorAll('[data-pack-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pid = btn.dataset.packId;
      if (pid && pid !== state.packId) {
        state.packId = pid;
        void dispatchRoomAction('reset', { packId: pid });
      }
    });
  });
}

/* ------------------------------------------- Countdown Ticker Loop */

function startCountdownLoop() {
  if (state.countdownTimer) clearInterval(state.countdownTimer);
  let lastWholeSec = -1;
  state.countdownTimer = setInterval(() => {
    const rv = state.roomView;
    if (!rv || rv.phase !== 'question' || !rv.questionEndsAt) return;
    const now = Date.now();
    const totalMs = Math.max(1000, rv.questionEndsAt - rv.questionStartedAt);
    const remMs = Math.max(0, rv.questionEndsAt - now);
    const sec = Math.ceil(remMs / 1000);
    const frac = clamp(remMs / totalMs, 0, 1);

    if ($('timerSecondsText')) $('timerSecondsText').textContent = String(sec);
    const arc = $('radialTimerArc');
    if (arc) arc.style.strokeDashoffset = (RADIAL_CIRCUMFERENCE * (1 - frac)).toFixed(2);
    $('radialTimer')?.classList.toggle('urgent', sec <= 4);

    if (sec !== lastWholeSec && sec > 0 && sec <= 4 && state.role === 'stage') {
      playSfx('tick');
    }
    lastWholeSec = sec;

    // Update Luka's simulated lock-in indicator dynamically
    if (rv.question && !rv.lukaLockedIn && now - rv.questionStartedAt > 2400) {
      const pill = $('qLukaLockPill');
      if (pill && !pill.classList.contains('locked')) {
        pill.textContent = 'LUKA: LOCKED IN';
        pill.classList.add('locked');
      }
    }

    // Auto-reveal when countdown hits 0 on Stage Host
    if (remMs <= 0 && state.role === 'stage' && state.autoRevealDoneForIdx !== rv.questionIndex) {
      state.autoRevealDoneForIdx = rv.questionIndex;
      void dispatchRoomAction('reveal');
    }
  }, 120);
}

/* ------------------------------------------- Mode & UI Wiring */

function switchRole(nextRole) {
  state.role = nextRole;
  document.body.dataset.role = nextRole;
  const isStage = nextRole === 'stage';
  $('stageLayout').hidden = !isStage;
  $('playerLayout').hidden = isStage;
  $('tabStageMode').classList.toggle('is-active', isStage);
  $('tabPlayerMode').classList.toggle('is-active', !isStage);
  $('tabStageMode').setAttribute('aria-selected', String(isStage));
  $('tabPlayerMode').setAttribute('aria-selected', String(!isStage));

  if (isStage) {
    void bootLuka3DStage();
    if (!state.roomCode) void createHostedRoom(state.packId);
    else if (state.roomView) renderStageView(state.roomView);
  } else {
    state.voice?.interrupt('role_switch');
    if (state.roomView && !$('playerController').hidden) renderPlayerView(state.roomView);
  }
}

function wireUI() {
  $('tabStageMode').addEventListener('click', () => switchRole('stage'));
  $('tabPlayerMode').addEventListener('click', () => switchRole('player'));

  // Mute / unmute audio
  $('btnAudioMute').addEventListener('click', () => {
    state.muted = !state.muted;
    state.voice?.setMuted(state.muted);
    $('btnAudioMute').setAttribute('aria-pressed', String(state.muted));
    $('audioMuteIcon').textContent = state.muted ? '🔇' : '🔊';
    $('audioMuteLabel').textContent = state.muted ? 'Muted' : 'Voice On';
  });

  // Camera presets
  document.querySelectorAll('.j-cam-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = CAM_PRESETS[btn.dataset.cam];
      if (!preset) return;
      document.querySelectorAll('.j-cam-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      state.camTarget = { ...preset, target: [...preset.target] };
    });
  });

  // Duplex Barge-In Mic toggle
  $('btnDuplexMic').addEventListener('click', async () => {
    const btn = $('btnDuplexMic');
    const next = btn.getAttribute('aria-pressed') !== 'true';
    try {
      const on = await state.voice.setDuplexMonitoring(next);
      btn.setAttribute('aria-pressed', String(on));
      $('duplexMicLabel').textContent = on ? 'Barge-In Mic: Live' : 'Barge-In Mic: Off';
    } catch (err) {
      $('lukaCaptionText').textContent = `Mic note: ${err.message}`;
    }
  });

  // Hold to Speak (immediately interrupts Luka!)
  const ptt = $('btnStagePtt');
  ptt.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { ptt.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    ptt.classList.add('is-active');
    void state.voice.startManualTurn().catch((err) => {
      ptt.classList.remove('is-active');
      $('lukaCaptionText').textContent = err.message;
    });
  });
  const endPtt = (send) => {
    if (!ptt.classList.contains('is-active')) return;
    ptt.classList.remove('is-active');
    void state.voice.endManualTurn(send);
  };
  ptt.addEventListener('pointerup', () => endPtt(true));
  ptt.addEventListener('pointercancel', () => endPtt(false));

  // Instant Cut / Interrupt button + Escape shortcut
  $('btnInterruptLuka').addEventListener('click', () => {
    state.voice?.interrupt('manual');
    if ($('lukaCaptionText')) $('lukaCaptionText').textContent = 'Cut — standing by. Go ahead!';
  });

  // Multi-speaker floor switcher
  document.querySelectorAll('#speakerFloorPills .sp-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('#speakerFloorPills .sp-pill').forEach((p) => p.classList.toggle('is-active', p === pill));
      state.voice?.setActiveSpeaker(pill.dataset.speaker || 'Host');
    });
  });

  // Stage text banter / interrupt form
  $('stageBanterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const inp = $('stageBanterInput');
    const val = inp.value.trim();
    if (!val) return;
    const wasSpeaking = Boolean(state.voice?.speaking);
    inp.value = '';
    void handleStageConversation({
      text: val,
      speakerLabel: state.voice?.activeSpeakerLabel || 'Host',
      wasInterrupted: wasSpeaking,
    });
  });

  // Copy QR join link
  $('btnCopyJoinLink').addEventListener('click', async () => {
    if (!state.roomCode) return;
    const url = computeJoinUrl(state.roomCode);
    try {
      await navigator.clipboard.writeText(url);
      $('btnCopyJoinLink').textContent = 'Copied!';
      setTimeout(() => { $('btnCopyJoinLink').textContent = 'Copy Link'; }, 1600);
    } catch { /* ignore */ }
  });

  // Lobby launch actions
  $('btnStartSolo').addEventListener('click', async () => {
    state.soloMode = true;
    playSfx('launch');
    try {
      await joinAsPlayer({ code: state.roomCode, name: 'Commander', playerId: state.soloPlayerId, isSolo: true });
    } catch { /* offline handled */ }
    metrics.track('game_event', { category: 'game', label: 'start_solo', meta: { pack: state.packId } });
    state.autoRevealDoneForIdx = -1;
    await dispatchRoomAction('next', { index: 0 });
  });

  $('btnStartHosted').addEventListener('click', async () => {
    state.soloMode = false;
    playSfx('launch');
    metrics.track('game_event', { category: 'game', label: 'start_hosted', meta: { pack: state.packId, players: state.roomView?.humanCount || 0 } });
    await dispatchRoomAction('intro');
  });

  $('btnOpenQaFromLobby').addEventListener('click', () => void dispatchRoomAction('qa'));
  $('btnLaunchQ1').addEventListener('click', () => {
    state.autoRevealDoneForIdx = -1;
    void dispatchRoomAction('next', { index: 0 });
  });
  $('btnIntroBackLobby').addEventListener('click', () => void dispatchRoomAction('reset'));

  // Stage Kahoot tiles (clickable in Solo / Booth mode!)
  document.querySelectorAll('#stageAnswerGrid .k-tile').forEach((tile) => {
    tile.addEventListener('click', async () => {
      if (state.roomView?.phase !== 'question') return;
      const opt = Number(tile.dataset.opt);
      if (!state.soloMode) {
        // Clicking a tile on stage automatically enables instant solo/booth interaction
        state.soloMode = true;
        try {
          await joinAsPlayer({ code: state.roomCode, name: 'Booth Challenger', playerId: state.soloPlayerId, isSolo: true });
        } catch { /* ignore */ }
      }
      const ok = await submitPlayerChoice(opt, state.soloPlayerId);
      if (ok && state.soloMode) {
        // Brief dramatic pause then reveal!
        setTimeout(() => {
          if (state.roomView?.phase === 'question') {
            state.autoRevealDoneForIdx = state.roomView.questionIndex;
            void dispatchRoomAction('reveal');
          }
        }, 480);
      }
    });
  });

  $('btnRevealAnswer').addEventListener('click', () => {
    state.autoRevealDoneForIdx = state.roomView?.questionIndex ?? -1;
    void dispatchRoomAction('reveal');
  });
  $('btnShowLeaderboard').addEventListener('click', () => void dispatchRoomAction('leaderboard'));
  $('btnNextQuestion').addEventListener('click', () => {
    state.autoRevealDoneForIdx = -1;
    void dispatchRoomAction('next');
  });
  $('btnPivotToQa').addEventListener('click', () => void dispatchRoomAction('qa'));

  $('btnLbNext').addEventListener('click', () => {
    state.autoRevealDoneForIdx = -1;
    void dispatchRoomAction('next');
  });
  $('btnLbQa').addEventListener('click', () => void dispatchRoomAction('qa'));
  $('btnLbReset').addEventListener('click', () => {
    state.soloMode = false;
    void dispatchRoomAction('reset');
  });
  $('btnReturnToGame').addEventListener('click', () => {
    const idx = state.roomView?.questionIndex ?? -1;
    if (idx < 0) void dispatchRoomAction('reset');
    else void dispatchRoomAction('leaderboard');
  });

  // Phone Player Controller Join & Buzzer
  $('playerJoinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('joinCodeInput').value.trim();
    const name = $('joinNameInput').value.trim();
    $('joinErrorText').hidden = true;
    try {
      state.playerName = name;
      localStorage.setItem('luka.btb.callsign', name);
      await joinAsPlayer({ code, name, playerId: state.playerId, isSolo: false });
      metrics.track('game_event', { category: 'game', label: 'player_join', meta: { transport: state.transport } });
    } catch (err) {
      $('joinErrorText').textContent = err.message || 'Could not join room.';
      $('joinErrorText').hidden = false;
    }
  });

  document.querySelectorAll('#playerAnswerGrid .k-tile').forEach((btn) => {
    btn.addEventListener('click', () => {
      const opt = Number(btn.dataset.pOpt);
      void submitPlayerChoice(opt, state.playerId);
    });
  });

  $('pTabBuzzer').addEventListener('click', () => {
    $('pTabBuzzer').classList.add('is-active');
    $('pTabAsk').classList.remove('is-active');
    $('playerBuzzerPane').hidden = false;
    $('playerAskPane').hidden = true;
  });
  $('pTabAsk').addEventListener('click', () => {
    $('pTabAsk').classList.add('is-active');
    $('pTabBuzzer').classList.remove('is-active');
    $('playerBuzzerPane').hidden = true;
    $('playerAskPane').hidden = false;
  });

  $('playerAskForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('playerAskInput');
    const txt = inp.value.trim();
    if (!txt) return;
    const ok = await submitAudienceQaFromPhone(txt);
    if (ok) {
      inp.value = '';
      $('playerAskConfirm').hidden = false;
      setTimeout(() => { $('playerAskConfirm').hidden = true; }, 2600);
    }
  });

  // Keyboard shortcuts (1..4 answer in Solo/Stage question, Esc interrupts Luka!)
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') {
      state.voice?.interrupt('manual');
      return;
    }
    if (state.role === 'stage' && state.roomView?.phase === 'question' && ['1', '2', '3', '4'].includes(e.key)) {
      const idx = Number(e.key) - 1;
      document.querySelector(`#stageAnswerGrid .k-tile[data-opt="${idx}"]`)?.click();
    }
  });

  // PWA install prompt & Service Worker registration
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPwaPrompt = e;
    $('btnInstallPwa').hidden = false;
  });
  $('btnInstallPwa').addEventListener('click', async () => {
    if (!state.deferredPwaPrompt) return;
    state.deferredPwaPrompt.prompt();
    await state.deferredPwaPrompt.userChoice.catch(() => {});
    state.deferredPwaPrompt = null;
    $('btnInstallPwa').hidden = true;
  });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

/* -------------------------------------------------------------- Boot */

async function boot() {
  initVoice();
  wireUI();
  startCountdownLoop();

  const params = new URLSearchParams(location.search);
  const joinCode = normalizeRoomCode(params.get('join') || params.get('code'));
  if (state.playerName && $('joinNameInput')) $('joinNameInput').value = state.playerName;

  if (joinCode) {
    if ($('joinCodeInput')) $('joinCodeInput').value = joinCode;
    switchRole('player');
  } else {
    switchRole('stage');
  }

  window.__beatTheBot = state;
}

void boot();
