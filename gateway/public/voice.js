const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const apiBase = './api/v1';

const state = { robots: [], robot: null, lease: null, listening: false, rec: null, stream: null, audio: null, analyser: null, turns: [] };
const TURNS_KEY = 'luka.voice.turns.v1';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `${res.status} ${res.statusText}`);
  return json;
}

function log(title, detail) {
  const el = document.createElement('div');
  el.className = 'item';
  el.innerHTML = `<b>${title}</b> <span class="muted">${detail}</span>`;
  $('log').prepend(el);
  while ($('log').children.length > 40) $('log').lastChild.remove();
}

function loadTurns() {
  try { state.turns = JSON.parse(localStorage.getItem(TURNS_KEY) || '[]').slice(-100); } catch { state.turns = []; }
  renderTurns();
}

function saveTurns() {
  try { localStorage.setItem(TURNS_KEY, JSON.stringify(state.turns.slice(-100))); } catch { /* ignore */ }
}

function logTurn(role, text) {
  state.turns.push({ at: new Date().toISOString(), role, text, robot: state.robot?.robotId || null });
  saveTurns();
  renderTurns();
}

function renderTurns() {
  const host = $('convo');
  if (!host) return;
  host.innerHTML = state.turns.map((t) => {
    const who = t.role === 'you' ? 'You' : (t.robot ? `Luka (${t.robot})` : 'Luka');
    const time = new Date(t.at).toLocaleTimeString();
    return `<div class="item"><b>${who}</b> <span class="muted">${time}</span> ${t.text}</div>`;
  }).join('') || '<div class="muted">no turns yet — speak or type a command</div>';
  host.scrollTop = host.scrollHeight;
}

function transcriptText() {
  return state.turns.map((t) => {
    const who = t.role === 'you' ? 'You' : `Luka${t.robot ? ` (${t.robot})` : ''}`;
    return `[${new Date(t.at).toLocaleTimeString()}] ${who}: ${t.text}`;
  }).join('\n');
}

function speak(text) {
  if (!('speechSynthesis' in window)) { $('ttsState').textContent = 'speechSynthesis unavailable'; return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.02;
  u.pitch = 1;
  u.onstart = () => { $('ttsState').textContent = 'speaking…'; };
  u.onend = () => { $('ttsState').textContent = 'audio idle'; };
  u.onerror = (e) => { $('ttsState').textContent = `audio error: ${e.error || 'unknown'}`; };
  $('ttsState').textContent = 'queued…';
  speechSynthesis.speak(u);
}

async function startMeter() {
  if (state.stream) return;
  if (!navigator.mediaDevices?.getUserMedia) { $('micState').textContent = 'no getUserMedia'; return; }
  try {
    $('micState').textContent = 'requesting…';
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.stream = stream;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    state.audio = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    state.analyser = analyser;
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / data.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const pct = Math.max(0, Math.min(100, (db + 80) / 80 * 100));
      const bar = $('micBar');
      bar.style.width = `${pct}%`;
      bar.classList.toggle('hot', db > -18);
      $('micState').textContent = `${db.toFixed(0)} dBFS`;
      if (state.stream) requestAnimationFrame(tick);
    };
    tick();
  } catch (err) {
    $('micState').textContent = `denied: ${err.name || err.message}`;
  }
}

async function refreshAudit() {
  try {
    const data = await api('/audit?limit=20');
    const rows = (data.entries || []).slice(0, 12);
    $('auditList').innerHTML = rows.map((e) => {
      const cap = e.detail?.capability || e.capability || e.kind || '';
      const at = e.at ? new Date(e.at).toLocaleTimeString() : '';
      return `<div class="item"><b>${e.outcome || ''}</b> <span class="muted">${at} · ${e.actor || ''}</span> ${cap} ${e.message ? `<span class="muted">— ${e.message}</span>` : ''}</div>`;
    }).join('') || '<div class="muted">no audit events yet</div>';
  } catch { /* transient */ }
}

async function refreshRobots() {
  const data = await api('/robots');
  state.robots = data.robots || [];
  $('robotSel').innerHTML = state.robots
    .map((r) => {
      const cmd = r.capabilities?.commandable ?? 0;
      return `<option value="${r.robotId}">${r.label} · ${r.online ? 'online' : 'offline'} · ${cmd} cmd</option>`;
    })
    .join('');
  const sim = state.robots.find((r) => !r.physical) || state.robots[0];
  if (sim) $('robotSel').value = sim.robotId;
  await selectRobot();
}

async function selectRobot() {
  const id = $('robotSel').value;
  state.robot = state.robots.find((r) => r.robotId === id) || null;
  state.lease = null;
  $('leaseState').textContent = 'no lease';
  if (!state.robot) return;
  const st = await api(`/robots/${id}/state`);
  if (st.lease) {
    state.lease = st.lease;
    $('leaseState').textContent = `${st.lease.mode} · ${st.lease.leaseId.slice(0, 12)}…`;
  }
  const cmd = state.robot.capabilities?.commandable ?? 0;
  $('voiceState').textContent = cmd === 0
    ? `${state.robot.label} · online · observe-only — commands will be refused; select the simulator to execute`
    : `${state.robot.label} · ${state.robot.online ? 'online' : 'offline'} · ${state.robot.physical ? 'physical' : 'simulator'} · ${cmd} commandable`;
}

async function takeLease() {
  if (!state.robot) return;
  if (state.lease) {
    // reuse an existing lease if it is still valid
    try {
      const st = await api(`/robots/${state.robot.robotId}/state`);
      if (st.lease) { state.lease = st.lease; $('leaseState').textContent = `${st.lease.mode} · ${st.lease.leaseId.slice(0, 12)}…`; return; }
    } catch { /* fall through */ }
  }
  const mode = state.robot.physical ? 'observe' : 'simulate';
  const body = { mode, holder: 'voice-console', ttlMs: 300000 };
  const out = await api(`/robots/${state.robot.robotId}/leases`, { method: 'POST', body });
  state.lease = out.lease;
  $('leaseState').textContent = `${out.lease.mode} · ${out.lease.leaseId.slice(0, 12)}…`;
  log('lease', `${out.lease.mode} ${out.lease.leaseId}`);
}

async function command(capability, payload) {
  if (!state.lease) throw new Error('no lease — press take lease first');
  const body = {
    commandId: `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    capability,
    payload,
    leaseId: state.lease.leaseId,
    deadlineMs: Date.now() + 15000,
  };
  const out = await api(`/robots/${state.robot.robotId}/commands`, { method: 'POST', body });
  log(capability, JSON.stringify(payload));
  return out;
}

const intents = [
  { re: /\b(stop|freeze|halt)\b/, run: async () => { await api(`/robots/${state.robot.robotId}/stop`, { method: 'POST', body: { reason: 'voice stop', scope: 'all' } }); return 'stop latched'; } },
  { re: /\b(look|turn)\s+(left)\b/, run: async () => { await command('head.gaze', { yaw: 0.5, pitch: 0 }); return 'looking left'; } },
  { re: /\b(look|turn)\s+(right)\b/, run: async () => { await command('head.gaze', { yaw: -0.5, pitch: 0 }); return 'looking right'; } },
  { re: /\b(look|turn)\s+(up)\b/, run: async () => { await command('head.gaze', { yaw: 0, pitch: 0.3 }); return 'looking up'; } },
  { re: /\b(look|turn)\s+(down)\b/, run: async () => { await command('head.gaze', { yaw: 0, pitch: -0.3 }); return 'looking down'; } },
  { re: /\b(look\s+)?(centre|center|forward)\b/, run: async () => { await command('head.gaze', { yaw: 0, pitch: 0 }); return 'looking forward'; } },
  { re: /\b(open)\s+(the\s+)?hands?\b/, run: async () => { await command('hands.grasp', { side: 'both', action: 'open' }); return 'hands opening'; } },
  { re: /\b(close|grab|grasp)\s+(the\s+)?hands?\b/, run: async () => { await command('hands.grasp', { side: 'both', action: 'close' }); return 'hands closing'; } },
  { re: /\b(listen|microphone)\s+(on|start)\b/, run: async () => { await command('voice.listen', { action: 'start' }); return 'listening on'; } },
  { re: /\b(listen|microphone)\s+(off|stop)\b/, run: async () => { await command('voice.listen', { action: 'stop' }); return 'listening off'; } },
  { re: /\bstatus\b/, run: async () => { const s = await api(`/robots/${state.robot.robotId}/state`); return `${state.robot.label}: ${s.online ? 'online' : 'offline'}, ${s.action || 'idle'}`; } },
  { re: /\b(say|speak)\s+(.+)/, run: async (m) => { const text = m[2].trim(); await command('voice.speak', { text }); return `saying “${text}”`; } },
];

async function handle(text) {
  const t = text.toLowerCase().trim();
  $('transcript').textContent = `“${text}”`;
  $('intent').textContent = '';
  logTurn('you', text);
  for (const it of intents) {
    const m = t.match(it.re);
    if (!m) continue;
    try {
      const reply = await it.run(m);
      $('intent').textContent = reply;
      logTurn('luka', reply);
      speak(reply);
    } catch (err) {
      $('intent').textContent = `refused: ${err.message}`;
      logTurn('luka', `refused: ${err.message}`);
      speak(`I could not do that. ${err.message}`);
      log('refused', err.message);
    }
    return;
  }
  $('intent').textContent = 'no matching intent';
  logTurn('luka', 'I did not understand that.');
  speak('I did not understand that.');
}

function startRecognition() {
  startMeter();
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('intent').textContent = 'speech recognition unavailable — use the text field'; return; }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onstart = () => { state.listening = true; $('micBtn').dataset.listening = 'true'; $('micBtn').innerHTML = 'listening'; };
  rec.onresult = (event) => {
    let text = '';
    for (const r of event.results) text += r[0].transcript;
    $('transcript').textContent = text;
    if (event.results[event.results.length - 1].isFinal) handle(text);
  };
  rec.onerror = (event) => { $('intent').textContent = `mic error: ${event.error}`; };
  rec.onend = () => { state.listening = false; $('micBtn').dataset.listening = 'false'; $('micBtn').innerHTML = 'tap<br>to talk'; };
  rec.start();
  state.rec = rec;
}

$('robotSel').addEventListener('change', selectRobot);
$('btnLease').addEventListener('click', () => takeLease().catch((e) => { $('intent').textContent = e.message; }));
$('btnSend').addEventListener('click', () => { const v = $('textCmd').value.trim(); if (v) { $('textCmd').value = ''; handle(v); } });
$('textCmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnSend').click(); });
$('micBtn').addEventListener('click', () => { if (state.listening) state.rec?.stop(); else startRecognition(); });
$('btnTestVoice').addEventListener('click', () => speak('Voice output test. One, two, three.'));
$('btnCopyConvo').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(transcriptText()); $('intent').textContent = 'transcript copied'; }
  catch { $('intent').textContent = 'clipboard blocked — download instead'; }
});
$('btnDownloadConvo').addEventListener('click', () => {
  const blob = new Blob([transcriptText()], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `luka-voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('btnClearConvo').addEventListener('click', () => { state.turns = []; saveTurns(); renderTurns(); });
loadTurns();

refreshRobots().then(() => { $('gwDot').dataset.state = 'up'; takeLease().catch(() => {}); refreshAudit(); }).catch((e) => {
  $('gwDot').dataset.state = 'down';
  $('voiceState').textContent = e.message;
});
setInterval(refreshAudit, 2500);
window.addEventListener('beforeunload', () => {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.audio?.close?.();
});


