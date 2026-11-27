// Recording and WAV encoding follow Pose Lab's Speak tests, with an explicit
// press/release latch so a delayed permission prompt cannot start a stray turn.
import { ControllerEdges, buttonLabel, controllerKey, headMappingReady, headVector, is8BitDo } from './lukachat-controller.mjs';
import { ControllerSetup } from './lukachat-controller-ui.mjs';
const $ = (id) => document.getElementById(id);
const MIN_MS = 300, MAX_MS = 20000;
const working = new Set(['transcribing', 'thinking', 'preparing', 'speaking']);
let phase = 'idle', ready = false, micPending = false, held = null, generation = 0;
let autoStop, request, speechId = null, healthData = null, history = [], turns = 0;
let question = '', reply = '', readQuestion = false, pages = [], pageIndex = 0;
let currentVoiceProfile = null, voiceChoices = [], voicePending = false;
const recorder = { chunks: [], recording: false, level: 0 };
const controllerEdges = new ControllerEdges();
const controllerSetup = new ControllerSetup({
  onChange() { controllerEdges.reset(); rockerNeedsNeutral = true; void setHeadRocker(false, 'Controller mapping changed · enable head control again when ready.'); updateControllerHints(); },
  onSetup() { controllerEdges.reset(); if (held === 'gamepad') void endTalk('gamepad', false); void setHeadRocker(false, 'Head control switched off during controller setup.'); },
});

function setPhase(next, text) {
  phase = next;
  $('status').textContent = text;
  $('stateDot').dataset.state = next;
  $('talk').dataset.state = next;
  $('talk').disabled = !ready || working.has(next) || (micPending && !held);
  $('talkLabel').textContent = ({ arming: 'Opening microphone…', listening: 'Release to send', transcribing: 'Hearing you…', thinking: 'Thinking…', preparing: 'Preparing Luka’s voice…', speaking: 'Luka is speaking…' })[next] || controllerTalkPrompt();
  $('cancel').disabled = !['arming', 'listening', 'transcribing', 'thinking'].includes(next);
  $('cancel').hidden = $('cancel').disabled;
  $('speakAgain').hidden = !reply;
  $('speakAgain').disabled = working.has(next) || next === 'listening' || next === 'arming';
  $('sendText').disabled = working.has(next) || next === 'listening' || next === 'arming';
  updateVoiceButtons();
  paginate();
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok || data.ok === false || data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || `Request failed (${response.status})`);
  return data;
}
const post = (path, body, signal) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

function updateVoiceButtons() {
  const selected = $('voiceChoice').value;
  const unavailable = voicePending || !voiceChoices.some((voice) => voice.name === selected);
  $('voiceChoice').disabled = voicePending || !voiceChoices.length;
  $('voiceApply').disabled = unavailable || selected === currentVoiceProfile?.voice;
  $('voicePreview').disabled = unavailable || working.has(phase) || Boolean(held) || micPending;
  $('voiceDescription').textContent = voiceChoices.find((voice) => voice.name === selected)?.description || '';
}

function updateVoiceProfile(profile) {
  const previous = currentVoiceProfile?.voice;
  currentVoiceProfile = profile;
  $('voiceProfile').textContent = `${profile.voice} · ${profile.rate}× · ${profile.pitch} semitones`;
  if (voiceChoices.length && (!previous || $('voiceChoice').value === previous)) $('voiceChoice').value = profile.voice;
  updateVoiceButtons();
}

async function loadVoiceChoices() {
  try {
    const [data, profile] = await Promise.all([api('/voices?provider=inworld'), api('/voice-profile')]);
    voiceChoices = data.voices || [];
    const male = voiceChoices.filter((voice) => /\bmale\b/i.test(voice.description));
    const other = voiceChoices.filter((voice) => !male.includes(voice));
    const groups = [['Male voices', male], ['More voices', other]].filter(([, voices]) => voices.length).map(([label, voices]) => {
      const group = document.createElement('optgroup'); group.label = label;
      group.append(...voices.map((voice) => new Option(voice.label || voice.name, voice.name)));
      return group;
    });
    $('voiceChoice').replaceChildren(...groups);
    $('voiceChoice').value = profile.voice;
    updateVoiceProfile(profile);
    $('voiceStatus').textContent = 'Preview a voice on Luka, then use it for future replies.';
  } catch (error) {
    $('voiceStatus').textContent = `Voices unavailable · ${error.message}`;
  } finally { updateVoiceButtons(); }
}

$('voiceChoice').onchange = updateVoiceButtons;
$('voiceApply').onclick = async () => {
  if (voicePending || !voiceChoices.length) return;
  const voice = $('voiceChoice').value;
  voicePending = true; updateVoiceButtons();
  $('voiceStatus').textContent = `Saving ${voice}…`;
  try {
    const data = await post('/voice-profile', { voice });
    updateVoiceProfile(data.profile);
    $('voiceStatus').textContent = `${data.profile.voice} is now Luka’s saved voice.`;
  } catch (error) { $('voiceStatus').textContent = `Could not save voice · ${error.message}`; }
  finally { voicePending = false; updateVoiceButtons(); }
};
$('voicePreview').onclick = async () => {
  if (voicePending || working.has(phase) || held || micPending || !currentVoiceProfile) return;
  const voice = $('voiceChoice').value, version = ++generation;
  voicePending = true;
  speechId = `voice-preview-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  $('voiceStatus').textContent = `Preparing ${voice} on Luka…`;
  setPhase('preparing', 'Preparing a voice preview…');
  try {
    await post('/say', { text: 'Hi. I’m Luka. I’m here with you, and ready to talk.', voice, provider: 'inworld', rate: currentVoiceProfile.rate, pitch: currentVoiceProfile.pitch, requestId: speechId });
    $('voiceStatus').textContent = `${voice} preview finished. Use this voice to save it.`;
    if (version === generation) { speechId = null; setPhase('idle', 'Voice preview finished. Hold to talk.'); }
  } catch (error) {
    $('voiceStatus').textContent = `Preview failed · ${error.message}`;
    if (version === generation) { speechId = null; setPhase('error', `Luka couldn’t play the preview: ${error.message}`); }
  } finally { voicePending = false; updateVoiceButtons(); }
};

function resample(input, from, to) {
  const output = new Float32Array(Math.round(input.length * to / from));
  for (let i = 0; i < output.length; i++) {
    const x = i * from / to, a = Math.floor(x), t = x - a;
    output[i] = (input[a] || 0) * (1 - t) + (input[Math.min(a + 1, input.length - 1)] || 0) * t;
  }
  return output;
}
function wav(samples) {
  const data = new ArrayBuffer(44 + samples.length * 2), v = new DataView(data);
  const text = (at, value) => [...value].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x * (x < 0 ? 32768 : 32767), true); }
  return new Blob([data], { type: 'audio/wav' });
}
async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('The microphone needs HTTPS or localhost. You can use Type while we set up tablet access.');
  recorder.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  try {
    recorder.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    recorder.source = recorder.ctx.createMediaStreamSource(recorder.stream);
    recorder.sink = recorder.ctx.createGain(); recorder.sink.gain.value = 0; recorder.sink.connect(recorder.ctx.destination);
    recorder.proc = recorder.ctx.createScriptProcessor(2048, 1, 1);
    recorder.chunks = [];
    recorder.proc.onaudioprocess = (event) => {
      if (!recorder.recording) return;
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      recorder.chunks.push(chunk);
      recorder.level = Math.sqrt(chunk.reduce((sum, x) => sum + x * x, 0) / chunk.length);
    };
    recorder.source.connect(recorder.proc); recorder.proc.connect(recorder.sink);
    await recorder.ctx.resume();
    recorder.recording = true; recorder.started = performance.now();
  } catch (error) { await stopMic(); throw error; }
}
async function stopMic() {
  const recording = recorder.recording;
  recorder.recording = false;
  const elapsed = recording ? performance.now() - recorder.started : 0;
  for (const key of ['proc', 'source', 'sink']) { try { recorder[key]?.disconnect(); } catch {} }
  recorder.stream?.getTracks().forEach((track) => track.stop());
  const rate = recorder.ctx?.sampleRate || 16000;
  await recorder.ctx?.close().catch(() => {});
  const total = recorder.chunks.reduce((sum, chunk) => sum + chunk.length, 0), merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of recorder.chunks) { merged.set(chunk, offset); offset += chunk.length; }
  recorder.chunks = []; recorder.level = 0; recorder.stream = recorder.ctx = null;
  return { elapsed, blob: recording && elapsed >= MIN_MS && total ? wav(rate === 16000 ? merged : resample(merged, rate, 16000)) : null };
}

async function beginTalk(source) {
  if (held || micPending || !ready || !['idle', 'error'].includes(phase) || document.hidden) return;
  held = source; micPending = true;
  const version = ++generation;
  setPhase('arming', 'Allow microphone access, then keep holding to talk.');
  try {
    await openMic();
    if (version !== generation || held !== source || document.hidden) { await stopMic(); return; }
    micPending = false;
    setPhase('listening', 'Listening to your microphone. Release to send.');
    autoStop = setTimeout(() => endTalk(source, true), MAX_MS);
  } catch (error) {
    if (version === generation) { held = null; setPhase('error', `Microphone: ${error.message}`); }
  } finally {
    micPending = false;
    if (phase === 'arming' || (version !== generation && !working.has(phase))) setPhase('idle', 'Microphone released. Hold again when you’re ready.');
    else $('talk').disabled = !ready || working.has(phase);
  }
}
async function endTalk(source, send = true) {
  if (held !== source) return;
  held = null; clearTimeout(autoStop);
  if (micPending) { generation++; setPhase('idle', 'Microphone released. Hold again once permission is ready.'); return; }
  if (phase !== 'listening') return;
  const result = await stopMic();
  if (!send || !result.blob) { setPhase('idle', send ? 'Hold a little longer to send a message.' : 'Recording cancelled.'); return; }
  await runTurn({ audio: result.blob });
}

async function speakReply(version = generation) {
  speechId = `chat-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
  setPhase('preparing', 'Preparing Luka’s voice…');
  await post('/say', { text: reply, requestId: speechId });
  if (version === generation) { speechId = null; setPhase('idle', 'Luka has finished. Hold to continue.'); }
}
async function runTurn({ text, audio }) {
  if (working.has(phase)) return;
  const version = ++generation, started = performance.now();
  request = new AbortController();
  reply = ''; readQuestion = false; pageIndex = 0; $('modelUsed').textContent = ''; $('timing').textContent = '';
  if (audio) $('questionCard').hidden = true;
  try {
    if (audio) {
      setPhase('transcribing', 'Transcribing your message…');
      const data = await api('/chat/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal: request.signal });
      text = data.transcript?.trim();
      if (!text) throw new Error('I didn’t catch any speech. Hold and try again.');
    }
    if (version !== generation) return;
    question = text; $('questionText').textContent = question; $('questionCard').hidden = false;
    setPhase('thinking', 'Thinking about your message…');
    const data = await post('/chat/reason', { text, llm: $('model').value, history: history.slice(-6) }, request.signal);
    if (version !== generation) return;
    if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('The model returned no reply. Try again.');
    reply = data.reply.trim();
    const provider = healthData?.llms?.find((model) => model.name === data.llm);
    $('modelUsed').textContent = provider?.label || data.llm || '';
    history.push({ role: 'user', content: question }, { role: 'assistant', content: reply }); history = history.slice(-12);
    $('turnCount').textContent = `Turn ${++turns}`;
    $('timing').textContent = `${((performance.now() - started) / 1000).toFixed(1)} s to reply`;
    paginate();
    await speakReply(version);
  } catch (error) {
    if (version !== generation || error.name === 'AbortError') return;
    setPhase('error', reply ? `Reply ready; Luka couldn’t speak: ${error.message}` : error.message);
  }
}

function cancel() {
  if (held) { endTalk(held, false); return; }
  if (!['transcribing', 'thinking'].includes(phase)) return;
  generation++; request?.abort(); setPhase('idle', 'Turn cancelled. Hold to start again.');
}

function readerText() {
  return (readQuestion ? question : reply) || ({ transcribing: 'I’m listening back to your message…', thinking: 'Let me think about that…' })[phase] || 'I’m here. Hold the button below and tell me what’s on your mind.';
}
function paginate() {
  const el = $('replyText'), full = readerText();
  if (el.clientHeight < 20) return;
  pages = [];
  let remaining = full;
  while (remaining) {
    let low = 1, high = remaining.length, fit = 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2); el.textContent = remaining.slice(0, mid);
      if (el.scrollHeight <= el.clientHeight + 1) { fit = mid; low = mid + 1; } else high = mid - 1;
    }
    if (fit < remaining.length) { const space = remaining.lastIndexOf(' ', fit); if (space > fit * .7) fit = space; }
    pages.push(remaining.slice(0, fit)); remaining = remaining.slice(fit).trimStart();
  }
  pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1)); renderPage();
}
function renderPage() {
  $('replyText').textContent = pages[pageIndex] || '';
  $('readerLabel').textContent = readQuestion ? 'YOU' : 'LUKA';
  $('previousPage').disabled = pageIndex === 0;
  $('nextPage').disabled = pageIndex >= pages.length - 1;
  $('pageCount').textContent = pages.length > 1 ? `${pageIndex + 1} / ${pages.length}` : '';
  $('showReply').hidden = !readQuestion;
}
$('previousPage').onclick = () => { if (pageIndex > 0) { pageIndex--; renderPage(); } };
$('nextPage').onclick = () => { if (pageIndex < pages.length - 1) { pageIndex++; renderPage(); } };
$('questionText').onclick = () => { readQuestion = true; pageIndex = 0; paginate(); };
$('showReply').onclick = () => { readQuestion = false; pageIndex = 0; paginate(); };
new ResizeObserver(() => requestAnimationFrame(paginate)).observe($('replyText'));

function togglePanel(id, open) {
  if (!$('controllerPanel').hidden && (id !== 'controllerPanel' || !open)) controllerSetup.cancelLearning();
  if (open && held === 'gamepad') void endTalk('gamepad', false);
  controllerEdges.reset(); rockerNeedsNeutral = true; rockerDirection = null;
  for (const panel of ['settingsPanel', 'textPanel', 'voicePanel', 'controllerPanel']) $(panel).hidden = panel !== id || !open;
  $('settingsToggle').setAttribute('aria-expanded', !$('settingsPanel').hidden);
  $('typeToggle').setAttribute('aria-expanded', !$('textPanel').hidden);
  $('voiceToggle').setAttribute('aria-expanded', !$('voicePanel').hidden);
  $('controllerToggle').setAttribute('aria-expanded', !$('controllerPanel').hidden);
}
$('settingsToggle').onclick = () => { const open = $('settingsPanel').hidden; if (!$('headPanel').hidden) toggleHead(false); togglePanel('settingsPanel', open); };
$('typeToggle').onclick = () => { togglePanel('textPanel', $('textPanel').hidden); if (!$('textPanel').hidden) $('textInput').focus(); };
$('voiceToggle').onclick = () => { togglePanel('voicePanel', true); if (!voiceChoices.length) void loadVoiceChoices(); };
$('controllerToggle').onclick = () => { void setHeadRocker(false, 'Head control switched off during controller setup.'); togglePanel('controllerPanel', true); };
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => togglePanel(button.dataset.close, false);
function toggleHead(open) {
  togglePanel('', false);
  $('headPanel').hidden = !open;
  $('headToggle').setAttribute('aria-expanded', open);
  if (!open && !rockerEnabled && !$('headRelease')?.disabled) $('headRelease')?.click();
}
$('headToggle').onclick = () => toggleHead(true);
$('headClose').onclick = () => toggleHead(false);
$('textForm').onsubmit = (event) => { event.preventDefault(); const text = $('textInput').value.trim(); if (!text || working.has(phase) || held) return; togglePanel('textPanel', false); $('textInput').blur(); $('textInput').value = ''; runTurn({ text }); };
$('cancel').onclick = cancel;
$('speakAgain').onclick = async () => {
  if (!reply || working.has(phase) || held || micPending) return;
  const version = ++generation;
  try { await speakReply(version); }
  catch (error) { if (version === generation) setPhase('error', `Luka couldn’t speak: ${error.message}`); }
};
$('talk').addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); $('talk').setPointerCapture(event.pointerId); beginTalk('pointer'); });
$('talk').addEventListener('pointerup', () => endTalk('pointer', true));
$('talk').addEventListener('pointercancel', () => endTalk('pointer', false));
$('talk').addEventListener('lostpointercapture', () => endTalk('pointer', false));
$('talk').addEventListener('contextmenu', (event) => event.preventDefault());
window.addEventListener('keydown', (event) => {
  if (event.code === 'Escape') { cancel(); togglePanel('', false); if (!$('headPanel').hidden) toggleHead(false); return; }
  if (event.code !== 'Space' || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.isContentEditable) return;
  if (event.target.closest?.('button') && event.target.id !== 'talk') return;
  event.preventDefault(); if (!event.repeat) beginTalk('keyboard');
});
window.addEventListener('keyup', (event) => { if (event.code === 'Space') { if (held === 'keyboard') event.preventDefault(); endTalk('keyboard', true); } });
function resetControllerInput() {
  controllerEdges.reset(); rockerNeedsNeutral = true; rockerDirection = null;
  if (controllerSetup.learning) controllerSetup.cancelLearning();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) { resetControllerInput(); cancel(); void setHeadRocker(false, 'Head rocker switched off while LukaChat was hidden.'); void setFaceFollow(false, 'Face follow switched off while LukaChat was hidden.'); } });
window.addEventListener('pagehide', () => { resetControllerInput(); cancel(); void setHeadRocker(false, 'Head rocker switched off while LukaChat was closing.'); stopFaceFollowOnExit('Face follow switched off while LukaChat was closing.'); });
window.addEventListener('blur', () => { resetControllerInput(); cancel(); void setHeadRocker(false, 'Head rocker switched off when LukaChat lost focus.'); void setFaceFollow(false, 'Face follow switched off when LukaChat lost focus.'); });

async function refreshHealth() {
  try {
    const [data, bridge, profile] = await Promise.all([api('/chat/status'), api('/health'), api('/voice-profile')]);
    healthData = data;
    const selected = $('model').value || data.defaultLlm;
    $('model').replaceChildren(...(data.llms || []).map((model) => { const option = new Option(`${model.label}${model.ready ? '' : ' · unavailable'}`, model.name); option.disabled = !model.ready; return option; }));
    $('model').value = data.llms?.some((model) => model.name === selected && model.ready) ? selected : data.defaultLlm;
    ready = Boolean(data.asr?.ready && data.llms?.some((model) => model.name === $('model').value && model.ready));
    $('connection').textContent = bridge.robotConnection?.error === 'authorization_rejected' ? 'Luka · SSH access needed' : ready ? bridge.connected ? 'Luka connected' : 'Reasoning ready · Luka offline' : 'Conversation unavailable';
    $('modelDetail').textContent = data.llms?.find((model) => model.name === $('model').value)?.model || '';
    updateVoiceProfile(profile);
    if (phase === 'idle' && turns === 0) setPhase(phase, ready ? 'Hold to talk. Release to send your message to Luka.' : 'Check the reasoning bridge in Settings.');
    else $('talk').disabled = !ready || working.has(phase) || (micPending && !held);
  } catch (error) { ready = false; $('connection').textContent = 'Conversation bridge offline'; if (!working.has(phase) && !held) setPhase('error', error.message); }
}
$('model').onchange = () => { $('modelDetail').textContent = healthData?.llms?.find((model) => model.name === $('model').value)?.model || ''; };
const events = new EventSource('/events');
events.onmessage = (event) => { try { const data = JSON.parse(event.data); if (data.type === 'playback' && data.requestId === speechId && phase === 'preparing') setPhase('speaking', 'Luka is speaking through his own speaker…'); } catch {} };
let gamepadId = null;
let rockerEnabled = false, rockerPending = false, rockerGeneration = 0, rockerNeedsNeutral = true, rockerLastMoveAt = 0, rockerDirection = null;
let faceFollowEnabled = false, faceFollowPending = false, faceFollowSession = null, faceFollowGeneration = 0;

function updateModeIndicator() {
  const active = faceFollowEnabled ? 'face on' : rockerEnabled ? 'head on' : '';
  $('settingsToggle').textContent = active ? `Menu · ${active}` : 'Menu';
  $('settingsToggle').title = faceFollowEnabled ? 'Face following is on' : rockerEnabled ? 'Controller head control is on' : '';
  $('headToggle').textContent = rockerEnabled ? 'Head movement · rocker on' : 'Head movement';
}

async function setHeadRocker(enabled, reason = '') {
  const toggle = $('headRockerEnabled');
  if (!enabled) {
    if (!rockerEnabled && !rockerPending && !toggle.checked) return;
    rockerGeneration++;
    const release = rockerEnabled || rockerPending || toggle.checked;
    rockerEnabled = false; rockerPending = false; rockerNeedsNeutral = true; rockerDirection = null;
    toggle.checked = false; toggle.disabled = false;
    $('headRockerStatus').textContent = reason || 'Off · toggle on to map the right stick to pan and tilt.';
    updateModeIndicator();
    if (release) await window.lukaHeadControls?.release();
    return;
  }
  if (rockerEnabled || rockerPending) return;
  const pad = getControllerPad();
  if (!pad || !headMappingReady(pad, controllerSetup.profile)) {
    toggle.checked = false;
    $('headRockerStatus').textContent = 'Open Controller setup and calibrate the head controls first.';
    return;
  }
  const version = ++rockerGeneration, padId = gamepadId;
  rockerPending = true; toggle.disabled = true;
  if (faceFollowEnabled || faceFollowPending) await setFaceFollow(false, 'Face follow switched off for manual head control.');
  if (version !== rockerGeneration) return;
  const controls = window.lukaHeadControls;
  for (let attempt = 0; controls && !controls.canAcquire() && attempt < 10; attempt++) {
    await controls.refresh();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!padId || !document.hasFocus() || document.hidden || !controls?.canAcquire()) {
    rockerPending = false; toggle.disabled = !getControllerPad() || !controls?.canAcquire();
    toggle.checked = false;
    $('headRockerStatus').textContent = 'Unavailable · check the controller mapping and Luka’s head feedback.';
    return;
  }
  $('headRockerStatus').textContent = 'Enabling the head lease…';
  const acquired = await controls.acquire();
  rockerPending = false;
  if (version !== rockerGeneration || gamepadId !== padId || document.hidden || !document.hasFocus()) {
    rockerPending = false;
    toggle.checked = false;
    toggle.disabled = !getControllerPad() || !controls.canAcquire();
    if (acquired) await controls.release();
    return;
  }
  if (!acquired) {
    rockerPending = false;
    toggle.checked = false;
    toggle.disabled = !getControllerPad() || !controls.canAcquire();
    $('headRockerStatus').textContent = 'Could not enable · check the head-control status in Head movement.';
    return;
  }
  toggle.disabled = false;
  rockerPending = false;
  rockerEnabled = true; rockerNeedsNeutral = true; rockerDirection = null; rockerLastMoveAt = performance.now();
  $('headRockerStatus').textContent = 'On · release the head hold button and center the stick once to arm movement.';
  updateModeIndicator();
  togglePanel('', false);
}
$('headRockerEnabled').addEventListener('change', () => { void setHeadRocker($('headRockerEnabled').checked); });

async function facePost(path, body, keepalive = false) {
  return api(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), ...(keepalive ? { keepalive: true } : {}),
  });
}

async function setFaceFollow(enabled, reason = '') {
  const toggle = $('faceFollowEnabled');
  if (!enabled) {
    if (!faceFollowEnabled && !faceFollowPending && !toggle.checked) return;
    const generation = ++faceFollowGeneration, sessionId = faceFollowSession;
    faceFollowEnabled = false; faceFollowPending = true; faceFollowSession = null;
    toggle.checked = false;
    $('faceFollowStatus').textContent = reason || 'Off · local face detection only; no identity or image storage. Camera alignment still needs calibration.';
    updateModeIndicator();
    try { if (sessionId) await facePost('/face-follow/stop', { sessionId }); }
    catch { if (generation === faceFollowGeneration) $('faceFollowStatus').textContent = 'Off · waiting for the camera and head-control session to time out.'; }
    finally { if (generation === faceFollowGeneration) { faceFollowPending = false; toggle.disabled = false; } }
    return;
  }
  if (faceFollowEnabled || faceFollowPending) return;
  const generation = ++faceFollowGeneration;
  faceFollowPending = true; toggle.disabled = true;
  $('faceFollowStatus').textContent = 'Starting the local camera detector…';
  if (rockerEnabled || rockerPending || $('headRockerEnabled').checked) await setHeadRocker(false, 'Manual rocker switched off for face follow.');
  try {
    const data = await facePost('/face-follow/start', {});
    const sessionId = data.sessionId;
    if (generation !== faceFollowGeneration || document.hidden || !document.hasFocus()) {
      if (sessionId) await facePost('/face-follow/stop', { sessionId }, true).catch(() => {});
      return;
    }
    faceFollowEnabled = true; faceFollowSession = sessionId;
    toggle.checked = true; toggle.disabled = false;
    $('faceFollowStatus').textContent = data.state?.message || 'Looking for a face in the forward camera…';
    updateModeIndicator();
    togglePanel('', false);
  } catch (error) {
    if (generation === faceFollowGeneration) {
      toggle.checked = false;
      toggle.disabled = false;
      $('faceFollowStatus').textContent = `Unavailable · ${error.message}`;
    }
  } finally {
    if (generation === faceFollowGeneration) faceFollowPending = false;
  }
}
$('faceFollowEnabled').addEventListener('change', () => { void setFaceFollow($('faceFollowEnabled').checked); });

function stopFaceFollowOnExit(reason) {
  const sessionId = faceFollowSession;
  faceFollowGeneration++;
  faceFollowEnabled = false; faceFollowPending = false; faceFollowSession = null;
  $('faceFollowEnabled').checked = false;
  $('faceFollowStatus').textContent = reason;
  updateModeIndicator();
  if (sessionId) {
    const body = JSON.stringify({ sessionId });
    const sent = navigator.sendBeacon?.('/face-follow/stop', new Blob([body], { type: 'application/json' }));
    if (!sent) fetch('/face-follow/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
}

async function refreshFaceFollow() {
  try {
    const { state } = await api('/face-follow/state');
    if (faceFollowEnabled && !state.enabled) {
      faceFollowEnabled = false; faceFollowSession = null;
      $('faceFollowEnabled').checked = false;
      updateModeIndicator();
    }
    if (!faceFollowPending) $('faceFollowStatus').textContent = faceFollowEnabled
      ? state.message
      : state.enabled ? 'Active in another LukaChat session.'
        : state.status === 'error' ? `Unavailable · ${state.message}` : 'Off · local face detection only; no identity or image storage. Camera alignment still needs calibration.';
  } catch (error) {
    if (!faceFollowEnabled && !faceFollowPending) $('faceFollowStatus').textContent = `Unavailable · ${error.message}`;
  }
}
setInterval(async () => {
  if (!faceFollowEnabled || !faceFollowSession || faceFollowPending) return;
  try { await facePost('/face-follow/heartbeat', { sessionId: faceFollowSession }); }
  catch { void setFaceFollow(false, 'Face-follow connection lost; Luka will release head control.'); }
}, 2000);
setInterval(refreshFaceFollow, 1000);
void refreshFaceFollow();

function getControllerPad() {
  try {
    const pads = [...(navigator.getGamepads?.() || [])].filter((pad) => pad?.connected);
    return pads.find(is8BitDo) || pads.find((pad) => `${controllerKey(pad)}:${pad.index}` === gamepadId) || pads.find((pad) => pad.mapping === 'standard') || pads[0] || null;
  } catch { return null; }
}

function controllerTalkPrompt() {
  const { pad, profile } = controllerSetup;
  return pad && profile?.buttons.talk !== null ? `Hold ${buttonLabel(pad, profile.buttons.talk)} to talk` : 'Hold to talk';
}

function controllerPanelsOpen() {
  return ['settingsPanel', 'textPanel', 'voicePanel', 'controllerPanel', 'headPanel'].some((id) => !$(id).hidden);
}

function updateControllerHints() {
  const { pad, profile } = controllerSetup;
  if (!pad) {
    $('shortcut').textContent = 'Hold Space, or press and hold';
  } else {
    const talk = profile.buttons.talk === null ? 'Assign a talk button in Controller setup' : `${controllerTalkPrompt()} · Space also works`;
    $('shortcut').textContent = talk;
    $('headRockerLabel').textContent = is8BitDo(pad) ? '8BitDo right stick · Luka’s head' : 'Controller stick · Luka’s head';
    if (!rockerEnabled && !rockerPending) $('headRockerStatus').textContent = headMappingReady(pad, profile) ? 'Off · enable when ready; check your head hold button in Controller setup.' : 'Off · assign the head hold button and calibrate the right stick in Controller setup.';
  }
  if (['idle', 'error'].includes(phase)) $('talkLabel').textContent = controllerTalkPrompt();
}

function rockerJog(pad, now) {
  if (!rockerEnabled || !document.hasFocus() || document.hidden) return;
  if (controllerPanelsOpen() || controllerSetup.learning || !controllerEdges.armed) {
    rockerNeedsNeutral = true; rockerDirection = null;
    return;
  }
  const profile = controllerSetup.profile;
  if (!headMappingReady(pad, profile)) { void setHeadRocker(false, 'Controller mapping unavailable · head control switched off.'); return; }
  const controls = window.lukaHeadControls;
  if (!controls?.ready()) {
    if (!controls?.busy()) void setHeadRocker(false, 'Head feedback lost · rocker switched off.');
    return;
  }
  const { x, y, held: headHeld } = headVector(pad, profile);
  const ax = Math.abs(x), ay = Math.abs(y);
  const neutralLimit = Math.min(0.18, profile.deadzone * 0.6);
  if (rockerNeedsNeutral) {
    if (ax < neutralLimit && ay < neutralLimit && (!profile.headHoldRequired || !headHeld)) {
      rockerNeedsNeutral = false;
      $('headRockerStatus').textContent = profile.headHoldRequired ? `On · hold ${buttonLabel(pad, profile.buttons.headHold)} and move the right stick.` : 'On · right stick ready (pan and tilt).';
    }
    return;
  }
  if (!headHeld) { rockerNeedsNeutral = ax >= neutralLimit || ay >= neutralLimit; rockerDirection = null; return; }
  const strength = Math.max(ax, ay), deadzone = profile.deadzone;
  if (strength <= deadzone) {
    if (rockerDirection) $('headRockerStatus').textContent = 'On · head stick ready.';
    rockerDirection = null;
    return;
  }
  const direction = ax >= ay ? (x > 0 ? 'right' : 'left') : (y > 0 ? 'down' : 'up');
  if (direction !== rockerDirection) {
    rockerDirection = direction;
    $('headRockerStatus').textContent = `On · looking ${direction}.`;
  }
  const intensity = Math.max(0, Math.min(1, (strength - deadzone) / (1 - deadzone)));
  const repeatMs = 650 - intensity * 300;
  if (now - rockerLastMoveAt >= repeatMs && !controls.busy()) {
    rockerLastMoveAt = now;
    void controls.jog(direction);
  }
}

function gamepadLoop() {
  const pad = getControllerPad(), now = performance.now();
  if (!pad) {
    if (held === 'gamepad') void endTalk('gamepad', false);
    if (gamepadId) {
      void setHeadRocker(false, 'Controller disconnected · rocker switched off.');
      controllerSetup.detach(); controllerEdges.reset(); updateControllerHints();
    }
    gamepadId = null; delete document.body.dataset.controller;
    $('headRockerEnabled').disabled = true;
  }
  else {
    const identity = `${controllerKey(pad)}:${pad.index}`;
    if (gamepadId !== identity) {
      if (held === 'gamepad') void endTalk('gamepad', false);
      if (gamepadId) void setHeadRocker(false, 'Controller changed · rocker switched off.');
      gamepadId = identity; controllerSetup.attach(pad); controllerEdges.reset(); updateControllerHints();
    }
    document.body.dataset.controller = 'connected';
    const learning = controllerSetup.update(pad, now);
    const active = document.hasFocus() && !document.hidden && !learning;
    const actions = controllerEdges.sample(pad, controllerSetup.profile, active);
    if (!active && held === 'gamepad') void endTalk('gamepad', false);
    if (!rockerEnabled && !rockerPending) {
      const faceMode = faceFollowEnabled || faceFollowPending;
      $('headRockerEnabled').disabled = !active || !headMappingReady(pad, controllerSetup.profile) || (!faceMode && !window.lukaHeadControls?.canAcquire());
    }
    if (actions.pressed.menu) {
      if (!$('headPanel').hidden) toggleHead(false);
      togglePanel('settingsPanel', $('settingsPanel').hidden);
    } else if (actions.pressed.back) {
      if (held || micPending || ['arming', 'listening', 'transcribing', 'thinking'].includes(phase)) cancel();
      if (!$('headPanel').hidden) toggleHead(false);
      togglePanel('', false);
    } else if (!controllerPanelsOpen()) {
      if (actions.pressed.talk) void beginTalk('gamepad');
      if (actions.released.talk && held === 'gamepad') void endTalk('gamepad', true);
      if (actions.pressed.replay) $('speakAgain').click();
      if (actions.pressed.previous) $('previousPage').click();
      if (actions.pressed.next) $('nextPage').click();
    } else if (held === 'gamepad') void endTalk('gamepad', false);
    if (!learning) rockerJog(pad, now);
  }
  $('micLevel').firstElementChild.style.width = `${Math.min(100, recorder.level * 700)}%`;
  $('holdTime').textContent = phase === 'listening' ? `${((performance.now() - recorder.started) / 1000).toFixed(1)}s` : '';
  requestAnimationFrame(gamepadLoop);
}
gamepadLoop(); refreshHealth(); setInterval(refreshHealth, 30000);
