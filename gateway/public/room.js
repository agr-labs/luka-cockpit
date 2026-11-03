// Room sensors: the measurement path the robot API does not offer.
//
// Microphone → dBFS, peak, VAD state, 20 s history.
// Camera     → mean luminance, frame-to-frame delta, 8 fps preview.
//
// Everything stays in this tab: no upload, no recording, no storage. The only
// network activity is the page itself.

const $ = (id) => document.getElementById(id);

// iPads report a fine pointer when a trackpad is attached; touch capability is
// the reliable signal for size, not the pointer media query alone.
if (navigator.maxTouchPoints > 0) document.documentElement.classList.add('touch');

const mic = {
  stream: null, ctx: null, analyser: null, buf: null, raf: null,
  db: -100, peak: -100, speaking: false, lastVoiceAt: 0, history: [],
  startedAt: 0, frames: 0, device: '',
};

const cam = {
  stream: null, timer: null, prev: null, lum: 0, motion: 0,
  startedAt: 0, frames: 0, device: '',
};

const pub = {
  robotId: null,
  token: new URLSearchParams(location.search).get('token') || localStorage.getItem('gateway_token') || '',
  paused: false,
  authNeeded: false,
  inFlight: false,
  ok: 0,
  fail: 0,
  lastAt: 0,
  lastError: null,
  lastBytes: 0,
  lastUi: 0,
};

const VAD_DBFS = -45;
const VAD_HANGOVER_MS = 400;
const HISTORY = 160;

init();

function init() {
  $('micBtn').addEventListener('click', startMic);
  $('micStop').addEventListener('click', stopMic);
  $('camBtn').addEventListener('click', startCam);
  $('camStop').addEventListener('click', stopCam);
  setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString(); }, 500);
  $('clock').textContent = new Date().toLocaleTimeString();

  $('pubToken').value = pub.token;
  $('pubApply').addEventListener('click', applyToken);
  $('pubToggle').addEventListener('click', togglePublishing);
  $('robotSelect').addEventListener('change', () => {
    pub.robotId = $('robotSelect').value;
    localStorage.setItem('gateway_robot', pub.robotId);
    updatePubStatus(true);
  });
  $('pubToggle').disabled = false;

  loadRobots();
  setInterval(publishTick, 200);
  setInterval(() => updatePubStatus(true), 1000);
}

/* ------------------------------- microphone ------------------------------ */

async function startMic() {
  if (mic.stream) return;
  setStatus('micStatus', 'requesting…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    await ctx.resume();

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.2;
    ctx.createMediaStreamSource(stream).connect(analyser);

    mic.stream = stream;
    mic.ctx = ctx;
    mic.analyser = analyser;
    mic.buf = new Float32Array(analyser.fftSize);
    mic.history = [];
    mic.startedAt = performance.now();
    mic.frames = 0;

    $('micBtn').disabled = true;
    $('micStop').disabled = false;
    setStatus('micStatus', 'live');
    $('roomDot').dataset.state = 'up';

    const track = stream.getAudioTracks()[0];
    mic.device = track?.label || 'default input';
    $('micInfo').innerHTML = '';
    addKv('micInfo', 'device', track?.label || 'default input');
    addKv('micInfo', 'sample rate', `${ctx.sampleRate} Hz`);
    addKv('micInfo', 'peak', '—');
    updatePubStatus(true);

    tickMic();
  } catch (err) {
    setStatus('micStatus', `failed: ${describeMediaError(err)}`);
    $('micBtn').disabled = false;
  }
}

function stopMic() {
  cancelAnimationFrame(mic.raf);
  if (mic.stream) for (const track of mic.stream.getTracks()) track.stop();
  if (mic.ctx && mic.ctx.state !== 'closed') mic.ctx.close();
  mic.stream = null;
  mic.ctx = null;
  mic.analyser = null;
  mic.raf = null;
  mic.history = [];
  mic.db = -100;
  mic.peak = -100;
  mic.speaking = false;
  $('micBtn').disabled = false;
  $('micStop').disabled = true;
  $('micDb').textContent = '—';
  $('micState').textContent = 'idle';
  $('micState').className = 'pill';
  setStatus('micStatus', 'stopped');
  refreshDot();
  updatePubStatus(true);
  drawMic();
}

function tickMic() {
  mic.raf = requestAnimationFrame(tickMic);
  if (!mic.analyser) return;

  mic.analyser.getFloatTimeDomainData(mic.buf);
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < mic.buf.length; i++) {
    const v = mic.buf[i];
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / mic.buf.length);
  const db = rms > 1e-7 ? 20 * Math.log10(rms) : -100;
  const peakDb = peak > 1e-7 ? 20 * Math.log10(peak) : -100;

  mic.db = Math.max(-100, Math.min(0, db));
  mic.peak = Math.max(-100, Math.min(0, peakDb));

  const now = performance.now();
  if (mic.db > VAD_DBFS) mic.lastVoiceAt = now;
  mic.speaking = now - mic.lastVoiceAt < VAD_HANGOVER_MS;

  mic.history.push(mic.db);
  if (mic.history.length > HISTORY) mic.history.shift();

  mic.frames++;
  if (mic.frames % 3 === 0) {
    $('micDb').textContent = mic.db.toFixed(1);
    $('micState').textContent = mic.speaking ? 'speech / sound' : 'quiet';
    $('micState').className = `pill ${mic.speaking ? 'ok' : ''}`;
  }
  if (mic.frames % 6 === 0) {
    const peakEl = $('micInfo').querySelector('[data-peak]');
    if (peakEl) peakEl.textContent = `${mic.peak.toFixed(1)} dBFS`;
    drawMic();
  }
}

function drawMic() {
  const canvas = $('micCanvas');
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(139,150,165,0.18)';
  ctx.lineWidth = 1;
  for (const db of [-60, -45, -30, -15]) {
    const y = h - 4 - ((db + 100) / 100) * (h - 8);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }

  if (!mic.history.length) return;
  const bar = w / HISTORY;
  mic.history.forEach((db, i) => {
    const norm = (db + 100) / 100;
    const barH = Math.max(1, norm * (h - 8));
    const x = i * bar;
    ctx.fillStyle = db > VAD_DBFS ? '#46c46b' : '#3b7fa6';
    ctx.fillRect(x, h - 4 - barH, Math.max(1, bar - 1), barH);
  });
}

/* -------------------------------- camera -------------------------------- */

async function startCam() {
  if (cam.stream) return;
  setStatus('camStatus', 'requesting…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'environment' },
    });
    const video = $('video');
    video.srcObject = stream;
    await video.play();

    cam.stream = stream;
    cam.prev = null;
    cam.startedAt = performance.now();
    cam.frames = 0;

    $('camBtn').disabled = true;
    $('camStop').disabled = false;
    setStatus('camStatus', 'live');
    $('roomDot').dataset.state = 'up';

    const track = stream.getVideoTracks()[0];
    cam.device = track?.label || 'default camera';
    $('camInfo').innerHTML = '';
    addKv('camInfo', 'device', track?.label || 'default camera');
    const settings = track?.getSettings?.() ?? {};
    addKv('camInfo', 'resolution', `${settings.width ?? '?'} × ${settings.height ?? '?'}`);

    cam.timer = setInterval(sampleCam, 125);
    sampleCam();
    updatePubStatus(true);
  } catch (err) {
    setStatus('camStatus', `failed: ${describeMediaError(err)}`);
    $('camBtn').disabled = false;
  }
}

function stopCam() {
  clearInterval(cam.timer);
  cam.timer = null;
  if (cam.stream) for (const track of cam.stream.getTracks()) track.stop();
  cam.stream = null;
  cam.prev = null;
  $('video').srcObject = null;
  $('camBtn').disabled = false;
  $('camStop').disabled = true;
  $('lum').textContent = '—';
  $('motion').textContent = '—';
  setStatus('camStatus', 'stopped');
  refreshDot();
  updatePubStatus(true);
}

function sampleCam() {
  const video = $('video');
  if (!video.videoWidth) return;
  const canvas = $('camCanvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let diff = 0;
  const prev = cam.prev;
  const pixels = canvas.width * canvas.height;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    sum += y;
    if (prev) diff += Math.abs(y - prev[p]);
  }

  cam.lum = sum / pixels;
  cam.motion = prev ? diff / pixels : 0;
  cam.prev = new Float32Array(pixels);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    cam.prev[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }

  cam.frames++;
  if (cam.frames % 2 === 0) {
    $('lum').textContent = cam.lum.toFixed(0);
    $('motion').textContent = cam.motion.toFixed(2);
  }
}

/* ------------------------- dashboard publishing -------------------------- */

async function loadRobots() {
  pub.authNeeded = false;
  try {
    const res = await fetch('/api/v1/robots', { headers: authHeaders() });
    if (res.status === 401) {
      pub.authNeeded = true;
      updatePubStatus(true);
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { robots } = await res.json();
    const select = $('robotSelect');
    select.innerHTML = '';
    for (const robot of robots) {
      const option = document.createElement('option');
      option.value = robot.robotId;
      option.textContent = `${robot.robotId} · ${robot.online ? 'online' : 'offline'}`;
      select.append(option);
    }
    const saved = localStorage.getItem('gateway_robot');
    const preferred = robots.some((r) => r.robotId === saved)
      ? saved
      : robots.find((r) => r.robotId === 'luka')?.robotId ?? robots[0]?.robotId ?? null;
    pub.robotId = preferred;
    if (preferred) select.value = preferred;
    pub.lastError = null;
  } catch (err) {
    pub.lastError = err.message;
  }
  updatePubStatus(true);
}

function applyToken() {
  pub.token = $('pubToken').value.trim();
  if (pub.token) localStorage.setItem('gateway_token', pub.token);
  else localStorage.removeItem('gateway_token');
  pub.authNeeded = false;
  loadRobots();
}

function togglePublishing() {
  pub.paused = !pub.paused;
  updatePubStatus(true);
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (pub.token) headers.Authorization = `Bearer ${pub.token}`;
  return headers;
}

function buildSample() {
  const sample = {};
  if (mic.stream) {
    sample.mic = {
      db: round1(mic.db),
      peak: round1(mic.peak),
      speaking: mic.speaking,
    };
  }
  if (cam.stream) {
    sample.camera = {
      luminance: round1(cam.lum),
      motion: round1(cam.motion),
    };
  }
  if (!sample.mic && !sample.camera) return null;

  const devices = {};
  if (mic.stream && mic.device) devices.mic = mic.device.slice(0, 120);
  if (cam.stream && cam.device) devices.camera = cam.device.slice(0, 120);
  if (Object.keys(devices).length) sample.devices = devices;
  return sample;
}

async function publishTick() {
  if (pub.paused || pub.authNeeded || pub.inFlight || document.hidden) return;
  if (!pub.robotId || (!mic.stream && !cam.stream)) return;
  if (Date.now() - pub.lastAt < 180) return; // 5 Hz; the server allows 10 Hz

  const sample = buildSample();
  if (!sample) return;

  pub.inFlight = true;
  try {
    const res = await fetch(`/api/v1/robots/${encodeURIComponent(pub.robotId)}/presence`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(sample),
    });
    if (res.status === 401) {
      pub.authNeeded = true;
      updatePubStatus(true);
      return;
    }
    if (res.status === 429) return; // our own rate guard, not an error
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    pub.ok++;
    pub.fail = 0;
    pub.lastAt = Date.now();
    pub.lastError = null;
    pub.lastBytes = JSON.stringify(sample).length;
    updatePubStatus();
  } catch (err) {
    pub.fail++;
    pub.lastError = err.message;
    updatePubStatus();
  } finally {
    pub.inFlight = false;
  }
}

function updatePubStatus(force = false) {
  const now = performance.now();
  if (!force && now - pub.lastUi < 500) return;
  pub.lastUi = now;

  const el = $('pubStatus');
  const active = Boolean(mic.stream || cam.stream);
  let text;
  let color = '';

  if (pub.authNeeded) {
    text = 'token required';
    color = 'var(--warn)';
  } else if (pub.paused) {
    text = 'paused';
    color = 'var(--muted)';
  } else if (!active) {
    text = 'idle — start a sensor';
  } else if (!pub.robotId) {
    text = 'no robot selected';
    color = 'var(--warn)';
  } else if (pub.lastError) {
    text = `error: ${pub.lastError}`;
    color = 'var(--bad)';
  } else {
    text = `streaming → ${pub.robotId} · ${pub.ok} samples`;
    color = 'var(--ok)';
  }

  el.textContent = text;
  el.style.color = color;
  $('pubToggle').textContent = pub.paused ? 'resume' : 'pause';

  const info = $('pubInfo');
  info.innerHTML = '';
  addKv('pubInfo', 'target', pub.robotId ?? '—');
  addKv('pubInfo', 'rate', active && !pub.paused ? '5 Hz' : 'idle');
  addKv('pubInfo', 'payload', pub.lastBytes ? `${pub.lastBytes} bytes` : '—');
  addKv('pubInfo', 'sent / failed', `${pub.ok} / ${pub.fail}`);
  if (pub.lastError) addKv('pubInfo', 'last error', pub.lastError);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/* ------------------------------- utilities ------------------------------- */

function setStatus(id, text) {
  $(id).textContent = text;
}

function refreshDot() {
  $('roomDot').dataset.state = mic.stream || cam.stream ? 'up' : 'down';
}

function addKv(dlId, key, value) {
  const dl = $(dlId);
  const dt = document.createElement('dt');
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (key === 'peak') dd.dataset.peak = '1';
  dl.append(dt, dd);
}

function describeMediaError(err) {
  switch (err?.name) {
    case 'NotAllowedError': return 'permission denied';
    case 'NotFoundError': return 'no device';
    case 'NotReadableError': return 'device busy';
    case 'OverconstrainedError': return 'no matching device';
    default: return err?.message ?? String(err);
  }
}

window.addEventListener('beforeunload', () => {
  stopMic();
  stopCam();
});
