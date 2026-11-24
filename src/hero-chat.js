// Steadwell · Hero Interactive Tap-and-Hold Luka Voice Chat & Visor Animator
// Turns the obsidian hero medallion into a live push-to-talk companion:
//   - Press & hold Luka's head (or Hold to Talk pill) to speak; quick tap toggles hands-free.
//   - Local dev (!isStaticBuild): Whisper ASR -> LLM /sim-api/reason -> Luka TTS + real-time WebAudio RMS bars.
//   - Public static web (isStaticBuild): Browser SpeechRecognition -> Luka Hero Brain -> Web Speech TTS + animated visor.
//   - Drives expressive OLED eye states (happy crescents, curious glance, nod, shake, scan, audio-reactive bars).

import { answerSteadwellQuestion } from './steadwell-knowledge.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const FALLBACK_BANTER = [
  {
    reply: "Loud and clear! I'm Luka, your AgiBot A2 Ultra companion — open Talk & Mirror Studio anytime to test my arms, hands, and webcam mirroring.",
    gesture: 'explain',
    mood: 'happy',
  },
  {
    reply: "I caught that! Right here on the homepage you can chat with me, watch my live floor reel below, or jump straight into the 3D studio.",
    gesture: 'nod',
    mood: 'curious',
  },
  {
    reply: "Good question — when I'm paired with a Steadwell VITA Edge companion, all of my voice, vision, and Trellis memory run locally with zero cloud lag.",
    gesture: 'explain',
    mood: 'happy',
  },
  {
    reply: "Always ready! Try holding my head again to ask about my glowing visor, VaultBots availability, or tell me to do a quick celebration.",
    gesture: 'wave',
    mood: 'happy',
  },
];

let banterCursor = 0;

export function gestureToMood(gesture = '') {
  switch (String(gesture).toLowerCase()) {
    case 'wave':
    case 'happy':
      return 'happy';
    case 'celebrate':
      return 'celebrate';
    case 'nod':
      return 'nod';
    case 'shake_no':
    case 'shake':
      return 'shake';
    case 'look_around':
    case 'scan':
      return 'scan';
    case 'think':
    case 'inspect':
      return 'curious';
    default:
      return 'happy';
  }
}

export function replyAsLukaHero(inputText) {
  const low = String(inputText || '').trim().toLowerCase();

  // Check authoritative Steadwell hardware & stack knowledge first for specific product/stack queries
  const steadwellHit = answerSteadwellQuestion(inputText);
  if (steadwellHit) {
    return {
      reply: steadwellHit.reply,
      gesture: steadwellHit.gesture,
      mood: steadwellHit.mood || gestureToMood(steadwellHit.gesture),
    };
  }

  if (/\b(hi|hello|hey|yo|howdy|good morning|good afternoon|good evening|what'?s up|sup)\b/.test(low)) {
    return {
      reply: "Hey! Great to meet you — I'm Luka. Hold my visor anytime to chat, or scroll down to watch me live on the floor.",
      gesture: 'wave',
      mood: 'happy',
    };
  }
  if (/\b(who are you|your name|what are you|about you|introduce|agibot|a2u|a2 ultra)\b/.test(low)) {
    return {
      reply: "I'm Luka, version A2U — a full-size AgiBot A2 Ultra humanoid built for live conversation, expressive hands, and offline-first edge robotics.",
      gesture: 'nod',
      mood: 'happy',
    };
  }
  if (/\b(vita|edge|studio|hardware|offline|local|fast|latency|trellis|memory|companion)\b/.test(low)) {
    return {
      reply: "Pairing me with Steadwell VITA Edge or VITA Studio changes everything — frontier local voice, vision, and Trellis memory right beside me with zero cloud delay.",
      gesture: 'nod',
      mood: 'happy',
    };
  }
  if (/\b(buy|purchase|price|cost|order|own|vaultbots|how much|available)\b/.test(low)) {
    return {
      reply: "You can own me or explore our upcoming robot fleet directly through VaultBots — hit the Buy Luka link right in the top bar!",
      gesture: 'celebrate',
      mood: 'celebrate',
    };
  }
  if (/\b(what can you do|capabilities|features|help|mirror|webcam|hands|fingers|kameyoko)\b/.test(low)) {
    return {
      reply: "I can talk with you live, mirror your arms and fingers over webcam in Talk & Mirror Studio, remember preferences with Trellis, and greet crowds in real hardware.",
      gesture: 'explain',
      mood: 'curious',
    };
  }
  if (/\b(video|reel|watch|carpet|showroom|cars|mercedes|event|real)\b/.test(low)) {
    return {
      reply: "Scroll just below me to catch my live hardware reel — classic showroom entrance, crowd handshakes, and a glowing red-carpet walk.",
      gesture: 'look_around',
      mood: 'scan',
    };
  }
  if (/\b(joke|funny|laugh|humor)\b/.test(low)) {
    return {
      reply: "Why did I pass my safety audit so fast? Because I always keep my joints within spec and never lose my head!",
      gesture: 'celebrate',
      mood: 'celebrate',
    };
  }
  if (/\b(no|nope|nah|shake|disagree|stop)\b/.test(low)) {
    return {
      reply: "Fair enough — shaking my head no and standing right by whenever you're ready.",
      gesture: 'shake_no',
      mood: 'shake',
    };
  }
  if (/\b(yes|yeah|yep|nod|agree|sure|awesome|cool|amazing|love|nice|great)\b/.test(low)) {
    return {
      reply: "Right there with you! Glad you like the setup — let's build something unforgettable together.",
      gesture: 'nod',
      mood: 'celebrate',
    };
  }
  if (/\b(look|scan|around|eyes|visor|see)\b/.test(low)) {
    return {
      reply: "Scanning the room now — my cyan OLED visor tracks your movement and lights up every time we talk.",
      gesture: 'look_around',
      mood: 'scan',
    };
  }
  if (/\b(celebrate|yay|party|woohoo|cheers|dance|win)\b/.test(low)) {
    return {
      reply: "Let's go! Full cyan glow and celebrating safely inside hardware bounds!",
      gesture: 'celebrate',
      mood: 'celebrate',
    };
  }

  const pick = FALLBACK_BANTER[banterCursor % FALLBACK_BANTER.length];
  banterCursor += 1;
  return { ...pick };
}

/* ------------------------------------------- Audio Utilities (Local WAV) */

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

function pickBestSpeechVoice() {
  if (typeof speechSynthesis === 'undefined') return null;
  const voices = speechSynthesis.getVoices?.() || [];
  if (!voices.length) return null;
  const preferred = [
    (v) => /en[-_](US|GB)/i.test(v.lang) && /(samantha|aaron|daniel|alex|google us english|aria|guy|ava)/i.test(v.name),
    (v) => /en[-_]US/i.test(v.lang) && !/compact/i.test(v.name),
    (v) => /^en/i.test(v.lang),
  ];
  for (const test of preferred) {
    const hit = voices.find(test);
    if (hit) return hit;
  }
  return null;
}

/* ----------------------------------------------------- Main Initializer */

export function initHeroChat({ metrics = null, isStaticBuild = false, onPhaseChange = null } = {}) {
  const stage = document.getElementById('visorStage');
  const headTrigger = document.getElementById('lukaHeadTrigger');
  const talkBtn = document.getElementById('heroTalkBtn');
  const talkBtnLabel = document.getElementById('heroTalkLabel');
  const statusBadge = document.getElementById('heroChatStatus');
  const bubbleText = document.getElementById('heroBubbleText');
  const bubbleUser = document.getElementById('heroBubbleUser');
  const waveEl = document.getElementById('oledWave');
  const muteBtn = document.getElementById('heroMuteBtn');

  if (!stage || !headTrigger || !talkBtn || !bubbleText) return null;

  const waveBars = Array.from(waveEl?.querySelectorAll('i') || []);
  const SpeechRec = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

  const state = {
    phase: 'idle',
    mood: 'neutral',
    muted: false,
    history: [],
    heldBy: null,
    latched: false,
    pending: false,
    pressedAt: 0,
    gen: 0,
    autoStopTimer: null,
    resetMoodTimer: null,
    speechRec: null,
    useBrowserRec: isStaticBuild,
    recorder: { stream: null, ctx: null, source: null, proc: null, sink: null, chunks: [], recording: false, level: 0, peak: 0, startedAt: 0 },
    playbackCtx: null,
    analyser: null,
    analyserBuf: null,
    activeSourceNode: null,
    synthWave: 0,
    animRaf: 0,
  };

  // Warm browser voice list early on Chrome/Safari
  if (typeof speechSynthesis !== 'undefined') {
    speechSynthesis.getVoices?.();
    speechSynthesis.addEventListener?.('voiceschanged', () => { speechSynthesis.getVoices?.(); });
  }

  function setMood(mood) {
    state.mood = mood;
    stage.dataset.mood = mood;
  }

  function setPhase(next, { statusText = null, replyText = null, userText = null, mood = null } = {}) {
    state.phase = next;
    stage.dataset.chatPhase = next;
    if (mood) setMood(mood);
    else if (next === 'listening' || next === 'arming') setMood('listening');
    else if (next === 'thinking' || next === 'transcribing') setMood('thinking');
    else if (next === 'idle') setMood('neutral');

    const defaultStatus = {
      idle: 'HOLD HEAD TO CHAT',
      arming: 'OPENING MIC…',
      listening: state.latched ? 'LISTENING · TAP TO SEND' : 'LISTENING · RELEASE',
      transcribing: 'HEARING YOU…',
      thinking: 'THINKING…',
      speaking: 'LUKA SPEAKING',
      error: 'TRY AGAIN',
    };
    if (statusBadge) statusBadge.textContent = statusText || defaultStatus[next] || 'READY';

    const btnLabels = {
      idle: 'Hold to Talk',
      arming: 'Opening Mic…',
      listening: state.latched ? 'Tap to Send' : 'Release to Send',
      transcribing: 'Listening…',
      thinking: 'Thinking…',
      speaking: 'Speaking…',
      error: 'Hold to Talk',
    };
    if (talkBtnLabel) talkBtnLabel.textContent = btnLabels[next] || 'Hold to Talk';
    talkBtn.dataset.phase = next;
    headTrigger.setAttribute('aria-pressed', next === 'listening' || next === 'arming' ? 'true' : 'false');

    if (userText !== null && bubbleUser) {
      bubbleUser.textContent = userText ? `You: “${userText}”` : '';
      bubbleUser.hidden = !userText;
    }
    if (replyText !== null) {
      bubbleText.textContent = replyText;
    }

    onPhaseChange?.(next, state.mood);

    if (['listening', 'speaking'].includes(next)) startWaveLoop();
    else stopWaveLoop();
  }

  function sampleActiveLevel() {
    if (state.phase === 'listening') {
      const mic = state.recorder.recording ? clamp(state.recorder.level * 5.2, 0.08, 1) : 0.25;
      return mic;
    }
    if (state.phase === 'speaking') {
      if (state.activeSourceNode && state.analyser && state.analyserBuf) {
        state.analyser.getFloatTimeDomainData(state.analyserBuf);
        let sq = 0;
        for (let i = 0; i < state.analyserBuf.length; i++) sq += state.analyserBuf[i] * state.analyserBuf[i];
        return clamp(Math.sqrt(sq / state.analyserBuf.length) * 4.6, 0.08, 1);
      }
      if (state.synthWave > 0) return state.synthWave;
      return 0.3;
    }
    return 0;
  }

  function stepWave(now) {
    if (!['listening', 'speaking'].includes(state.phase) || document.hidden) {
      stopWaveLoop();
      return;
    }
    const level = sampleActiveLevel();
    stage.style.setProperty('--mic-level', level.toFixed(3));
    const t = now * 0.012;
    for (let i = 0; i < waveBars.length; i++) {
      const centerWeight = 1 - Math.abs(i - 2) * 0.16;
      const harmonic = 0.55 + 0.45 * Math.sin(t + i * 1.35);
      const scaleY = clamp(0.35 + level * centerWeight * harmonic * 2.4, 0.32, 2.35);
      waveBars[i].style.transform = `scaleY(${scaleY.toFixed(2)})`;
    }
    state.animRaf = requestAnimationFrame(stepWave);
  }

  function startWaveLoop() {
    if (!state.animRaf) state.animRaf = requestAnimationFrame(stepWave);
  }

  function stopWaveLoop() {
    if (state.animRaf) {
      cancelAnimationFrame(state.animRaf);
      state.animRaf = 0;
    }
    stage.style.setProperty('--mic-level', '0');
    for (const bar of waveBars) bar.style.transform = '';
  }

  function clearAutoStop() {
    if (state.autoStopTimer) {
      clearTimeout(state.autoStopTimer);
      state.autoStopTimer = null;
    }
  }

  function stopPlayback() {
    if (state.activeSourceNode) {
      try { state.activeSourceNode.stop(); } catch { /* ignore */ }
      state.activeSourceNode = null;
    }
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    state.synthWave = 0;
  }

  async function openMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone requires HTTPS or localhost.');
    }
    const rec = state.recorder;
    rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    try {
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
      rec.startedAt = performance.now();
    } catch (err) {
      await stopMic();
      throw err;
    }
  }

  async function stopMic() {
    const rec = state.recorder;
    const wasRec = rec.recording;
    const peak = rec.peak || 0;
    const elapsed = wasRec ? performance.now() - rec.startedAt : 0;
    rec.recording = false;
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
    if (!wasRec || elapsed < 220 || !total) return { blob: null, reason: 'too_short' };
    if (peak < 0.0012) return { blob: null, reason: 'silent' };

    const resampled = resampleLinear(merged, sr, 16000);
    if (peak > 0.0012 && peak < 0.25) {
      const gain = Math.min(0.65 / peak, 10);
      for (let i = 0; i < resampled.length; i++) resampled[i] = clamp(resampled[i] * gain, -1, 1);
    }
    return { blob: encodeWav16k(resampled), reason: 'ok' };
  }

  function startBrowserSpeechRec() {
    return new Promise((resolve, reject) => {
      if (!SpeechRec) {
        reject(new Error('Voice capture is unavailable in this browser — tap one of the quick prompts below!'));
        return;
      }
      const rec = new SpeechRec();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      rec.maxAlternatives = 1;

      const session = { rec, finalText: '', interimText: '', ended: false, endResolvers: [] };
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
        if (preview) {
          bubbleText.textContent = `“${preview.slice(-76)}”`;
        }
      };
      rec.onerror = (ev) => {
        if (!started) {
          const err = new Error(
            ev.error === 'not-allowed'
              ? 'Allow microphone access to talk, or tap any prompt chip below.'
              : `Voice capture error (${ev.error}). Tap any prompt below to chat!`,
          );
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

  async function playWavBase64(base64) {
    stopPlayback();
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    if (!state.playbackCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.playbackCtx = new AudioCtx();
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

  function speakBrowser(text) {
    return new Promise((resolve) => {
      if (typeof speechSynthesis === 'undefined') {
        setTimeout(resolve, clamp(text.length * 42, 1600, 3800));
        return;
      }
      stopPlayback();
      const u = new SpeechSynthesisUtterance(text);
      const voice = pickBestSpeechVoice();
      if (voice) u.voice = voice;
      u.rate = 1.05;
      u.pitch = 0.90;
      let iv = null;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearInterval(iv);
        clearTimeout(guard);
        state.synthWave = 0;
        resolve();
      };
      u.onstart = () => {
        iv = setInterval(() => {
          state.synthWave = 0.25 + Math.random() * 0.65;
        }, 70);
      };
      u.onend = done;
      u.onerror = done;
      // Safety timer in case Safari/Chrome fails to fire onend
      const guard = setTimeout(done, clamp(text.length * 95 + 1500, 3200, 12000));
      // Kick synthWave right away so animation starts instantaneously
      state.synthWave = 0.42;
      speechSynthesis.speak(u);
    });
  }

  async function runTurn({ text = null, wavBlob = null, inputMode = 'voice' }) {
    if (['transcribing', 'thinking'].includes(state.phase)) return;
    clearTimeout(state.resetMoodTimer);
    stopPlayback();

    try {
      let spokenText = text;

      if (wavBlob && !isStaticBuild) {
        setPhase('transcribing', { replyText: 'Listening closely…' });
        const res = await fetch('/sim-api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: wavBlob,
        });
        const raw = await res.text();
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
        if (!res.ok || !data.ok) {
          throw new Error(data.error || 'Voice transcription unavailable right now.');
        }
        spokenText = String(data.transcript || '').trim();
        if (!spokenText) {
          setPhase('idle', { replyText: 'Didn’t catch any words — hold a touch longer and speak clearly.' });
          return;
        }
      }

      spokenText = String(spokenText || '').trim();
      if (!spokenText) {
        setPhase('idle', { replyText: 'Hold my visor and say hi — or tap a prompt below!' });
        return;
      }

      setPhase('thinking', { userText: spokenText, replyText: 'Thinking…' });

      // Attempt local /sim-api/reason first when running locally, fallback cleanly to Luka Hero Brain
      let result = null;
      if (!isStaticBuild) {
        try {
          const r = await fetch('/sim-api/reason', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text: spokenText,
              history: state.history.slice(-6),
            }),
          });
          const raw = await r.text();
          const parsed = raw ? JSON.parse(raw) : {};
          if (r.ok && parsed.ok && parsed.reply) {
            result = {
              reply: parsed.reply,
              gesture: parsed.gesture || 'explain',
              mood: gestureToMood(parsed.gesture),
              llm: parsed.llm || 'local',
            };
          }
        } catch {
          result = null;
        }
      }

      if (!result) {
        // Brief natural thinking beat so Luka's curious eye-glance reads playfully
        await new Promise((r) => setTimeout(r, 260));
        result = { ...replyAsLukaHero(spokenText), llm: 'hero-brain' };
      }

      state.history.push({ role: 'user', content: spokenText }, { role: 'assistant', content: result.reply });
      state.history = state.history.slice(-12);

      setPhase('speaking', {
        userText: spokenText,
        replyText: result.reply,
        mood: result.mood,
      });

      metrics?.track('speech_turn', {
        category: 'speech',
        label: `hero_${inputMode}`,
        meta: {
          llm: result.llm,
          tts: state.muted ? 'muted' : (isStaticBuild ? 'browser' : 'server'),
          gesture: result.gesture || '',
          surface: 'hero_visor',
        },
      });

      if (!state.muted) {
        let playedServerAudio = false;
        if (!isStaticBuild) {
          try {
            const ttsRes = await fetch('/sim-api/tts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: result.reply }),
            });
            const raw = await ttsRes.text();
            const tData = raw ? JSON.parse(raw) : {};
            if (ttsRes.ok && tData.ok && tData.audioBase64) {
              playedServerAudio = true;
              await playWavBase64(tData.audioBase64);
            }
          } catch {
            playedServerAudio = false;
          }
        }
        if (!playedServerAudio) {
          await speakBrowser(result.reply);
        }
      } else {
        // Visual-only animated speaking duration when muted
        state.synthWave = 0.45;
        const iv = setInterval(() => { state.synthWave = 0.25 + Math.random() * 0.55; }, 85);
        await new Promise((r) => setTimeout(r, clamp(result.reply.length * 42, 1700, 4000)));
        clearInterval(iv);
        state.synthWave = 0;
      }

      // Linger in happy mood briefly before returning to neutral idle
      setPhase('idle', { replyText: result.reply, userText: spokenText, mood: result.mood });
      state.resetMoodTimer = setTimeout(() => {
        if (state.phase === 'idle') setMood('neutral');
      }, 1400);
    } catch (err) {
      setPhase('error', { replyText: err?.message || 'Couldn’t hear that — try again or tap a quick prompt.' });
      setTimeout(() => {
        if (state.phase === 'error') setPhase('idle');
      }, 2800);
    }
  }

  async function finishListening(send = true) {
    clearAutoStop();
    state.heldBy = null;
    state.latched = false;
    state.gen += 1;

    if (state.useBrowserRec) {
      const [transcript] = await Promise.all([
        stopBrowserSpeechRec(send),
        stopMic().catch(() => null),
      ]);
      if (!send) {
        setPhase('idle');
        return;
      }
      if (!transcript) {
        setPhase('idle', { replyText: 'Didn’t catch any speech — hold a bit longer (or tap a quick prompt below).' });
        return;
      }
      await runTurn({ text: transcript, inputMode: 'voice' });
      return;
    }

    const res = await stopMic();
    if (!send) {
      setPhase('idle');
      return;
    }
    if (!res?.blob) {
      setPhase('idle', {
        replyText: res?.reason === 'silent'
          ? 'Your mic sounded silent — check input permissions or tap a quick prompt below.'
          : 'Hold a little longer while speaking — or tap once to toggle hands-free.',
      });
      return;
    }
    await runTurn({ wavBlob: res.blob, inputMode: 'voice' });
  }

  async function startHold(source) {
    if (state.latched && state.phase === 'listening') {
      await finishListening(true);
      return;
    }
    if (state.heldBy || state.pending || ['transcribing', 'thinking'].includes(state.phase)) return;
    stopPlayback();
    clearTimeout(state.resetMoodTimer);

    state.heldBy = source;
    state.latched = false;
    state.pending = true;
    state.pressedAt = performance.now();
    const gen = ++state.gen;
    state.useBrowserRec = isStaticBuild;

    setPhase('arming', { userText: '', replyText: 'Opening microphone…' });

    try {
      if (state.useBrowserRec) {
        state.speechRec = await startBrowserSpeechRec();
        openMic().catch(() => {});
      } else {
        await openMic();
      }
      state.pending = false;
      if (gen !== state.gen) {
        if (state.useBrowserRec) await stopBrowserSpeechRec(false);
        await stopMic().catch(() => {});
        return;
      }
      setPhase('listening', {
        replyText: state.latched ? 'I’m listening… tap again when finished.' : 'I’m listening… release when finished.',
      });
      clearAutoStop();
      state.autoStopTimer = setTimeout(() => {
        if (state.phase === 'listening') void finishListening(true);
      }, 20_000);
    } catch (err) {
      state.pending = false;
      state.heldBy = null;
      state.latched = false;
      if (state.useBrowserRec) await stopBrowserSpeechRec(false);
      await stopMic().catch(() => {});
      if (gen === state.gen) {
        const msg = err?.name === 'NotAllowedError'
          ? 'Allow microphone access to talk, or tap any prompt chip below!'
          : (err?.message || 'Mic unavailable — tap any prompt chip below!');
        setPhase('error', { replyText: msg });
        setTimeout(() => { if (state.phase === 'error') setPhase('idle'); }, 3400);
      }
    }
  }

  async function endHold(source, send = true) {
    if (state.heldBy !== source) return;
    const heldMs = performance.now() - state.pressedAt;

    if (!send) {
      state.heldBy = null;
      state.latched = false;
      state.pending = false;
      state.gen += 1;
      clearAutoStop();
      if (state.useBrowserRec) await stopBrowserSpeechRec(false);
      await stopMic().catch(() => {});
      setPhase('idle');
      return;
    }

    // Quick tap (< 320 ms) latches hands-free mode so single taps feel effortless!
    if (source === 'pointer' && (state.pending || heldMs < 320)) {
      state.heldBy = null;
      state.latched = true;
      if (state.phase === 'listening') {
        setPhase('listening', { replyText: 'I’m listening… tap again to send.' });
      }
      return;
    }

    if (state.pending) {
      state.heldBy = null;
      state.gen += 1;
      setPhase('idle');
      return;
    }

    await finishListening(true);
  }

  const bindHoldTrigger = (el) => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      void startHold('pointer');
    });
    el.addEventListener('pointerup', () => void endHold('pointer', true));
    el.addEventListener('pointercancel', () => void endHold('pointer', false));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('keydown', (e) => {
      if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) {
        e.preventDefault();
        void startHold('key');
      }
    });
    el.addEventListener('keyup', (e) => {
      if ((e.code === 'Space' || e.code === 'Enter') && state.heldBy === 'key') {
        e.preventDefault();
        void endHold('key', true);
      }
    });
  };

  bindHoldTrigger(headTrigger);
  bindHoldTrigger(talkBtn);

  // Quick prompt chips for instant zero-mic tryout
  stage.querySelectorAll('[data-hero-prompt]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.dataset.heroPrompt;
      if (prompt) void runTurn({ text: prompt, inputMode: 'chip' });
    });
  });

  // Audio mute/unmute toggle
  muteBtn?.addEventListener('click', () => {
    state.muted = !state.muted;
    muteBtn.setAttribute('aria-pressed', String(state.muted));
    muteBtn.title = state.muted ? 'Unmute Luka voice' : 'Mute Luka voice';
    muteBtn.dataset.muted = String(state.muted);
    if (state.muted) stopPlayback();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (state.heldBy || state.latched || state.pending)) {
      e.preventDefault();
      void finishListening(false);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopPlayback();
      stopWaveLoop();
    }
  });

  return {
    getPhase: () => state.phase,
    isGazeSuspended: () => ['thinking', 'transcribing', 'speaking'].includes(state.phase),
    triggerPrompt: (text) => runTurn({ text, inputMode: 'api' }),
  };
}
