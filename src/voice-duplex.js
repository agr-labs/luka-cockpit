// Steadwell Full-Duplex Interruptible & Multi-Speaker Voice Controller (J.A.R.V.I.S. Grade)
// Features:
//   - Real-time NDJSON streaming TTS playback (Cartesia Sonic-3 / ElevenLabs Flash v2.5 / Deepgram Aura-2 / Inworld TTS-2 Stream / macOS Say / Browser TTS)
//   - Sub-25ms hard barge-in interrupt: aborts in-flight LLM & TTS HTTP streams and flushes all WebAudio buffer nodes
//   - Continuous echo-cancelled acoustic VAD with 250ms pre-roll ring buffer so interrupting mid-sentence never clips the first syllable
//   - Multi-speaker floor tags (Host / Scientist / Audience) + Deepgram Nova-3 automatic speaker diarization metadata
//   - Live WebAudio AnalyserNode RMS output to drive LukaSim's 3D OLED mouth wave & speaking gestures

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function isWavHeader(bytes) {
  return bytes.length > 44
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45;
}

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

function pickNaturalVoice() {
  if (typeof speechSynthesis === 'undefined') return null;
  const voices = speechSynthesis.getVoices?.() || [];
  if (!voices.length) return null;
  const tests = [
    (v) => /en[-_](US|GB)/i.test(v.lang) && /(samantha|daniel|aaron|alex|google us english|aria|guy|ava)/i.test(v.name),
    (v) => /en[-_]US/i.test(v.lang) && !/compact/i.test(v.name),
    (v) => /^en/i.test(v.lang),
  ];
  for (const fn of tests) {
    const hit = voices.find(fn);
    if (hit) return hit;
  }
  return null;
}

export class DuplexVoiceEngine {
  constructor({
    isStaticBuild = false,
    onStateChange = null,
    onInterrupt = null,
    onUserUtterance = null,
    onMicLevel = null,
    onProviderInfo = null,
  } = {}) {
    this.isStaticBuild = isStaticBuild;
    this.onStateChange = onStateChange;
    this.onInterrupt = onInterrupt;
    this.onUserUtterance = onUserUtterance;
    this.onMicLevel = onMicLevel;
    this.onProviderInfo = onProviderInfo;

    this.muted = false;
    this.preferredProvider = 'auto';
    this.activeSpeakerLabel = 'Host';
    this.capabilities = null;

    // Playback state
    this.audioCtx = null;
    this.analyser = null;
    this.analyserBuf = null;
    this.activeNodes = new Set();
    this.nextStartTime = 0;
    this.speakGen = 0;
    this.activeTtsAbort = null;
    this.speaking = false;
    this.currentText = '';
    this.synthWave = 0;
    this.synthWaveTimer = null;

    // Duplex VAD / Mic Capture state
    this.duplexEnabled = false;
    this.micStream = null;
    this.micCtx = null;
    this.micSource = null;
    this.micProc = null;
    this.micSink = null;
    this.noiseFloor = 0.012;
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.capturingTurn = false;
    this.capturedWasInterrupt = false;
    this.preRoll = [];
    this.turnChunks = [];
    this.turnPeak = 0;
    this.manualHoldActive = false;

    // Static browser SpeechRecognition fallback
    this.speechRec = null;

    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.getVoices?.();
      speechSynthesis.addEventListener?.('voiceschanged', () => { speechSynthesis.getVoices?.(); });
    }
  }

  async loadCapabilities() {
    if (this.isStaticBuild) {
      this.capabilities = {
        preferredStreaming: 'browser',
        ttsProviders: [{ id: 'browser', label: 'Browser Speech + Instant Cut', ready: true, streaming: false, bargeIn: true }],
        asr: { diarizationReady: false, multiSpeakerModes: ['stage-floor-tags', 'browser-speech'] },
      };
      this.onProviderInfo?.(this.capabilities);
      return this.capabilities;
    }
    try {
      const res = await fetch('/sim-api/voice-capabilities', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        this.capabilities = data;
        this.onProviderInfo?.(data);
        return data;
      }
    } catch { /* ignore */ }
    return null;
  }

  ensurePlaybackContext() {
    if (!this.audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new Ctx();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyserBuf = new Float32Array(this.analyser.fftSize);
      this.analyser.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') {
      void this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  samplePlaybackRms() {
    if (this.activeNodes.size > 0 && this.analyser && this.analyserBuf) {
      this.analyser.getFloatTimeDomainData(this.analyserBuf);
      let sq = 0;
      for (let i = 0; i < this.analyserBuf.length; i++) sq += this.analyserBuf[i] * this.analyserBuf[i];
      return clamp(Math.sqrt(sq / this.analyserBuf.length) * 4.5, 0, 1);
    }
    return this.synthWave;
  }

  setMuted(muted) {
    this.muted = Boolean(muted);
    if (this.muted) this.interrupt('muted');
  }

  setActiveSpeaker(label) {
    this.activeSpeakerLabel = String(label || 'Host').trim().slice(0, 32) || 'Host';
  }

  setPreferredProvider(provider) {
    this.preferredProvider = provider || 'auto';
  }

  /**
   * Immediate (<25ms) hard audio + stream cut for barge-in or phase transitions.
   */
  interrupt(reason = 'manual') {
    const wasSpeaking = this.speaking || this.activeNodes.size > 0;
    const cutText = this.currentText;
    this.speakGen += 1;
    if (this.activeTtsAbort) {
      try { this.activeTtsAbort.abort(); } catch { /* ignore */ }
      this.activeTtsAbort = null;
    }
    for (const node of Array.from(this.activeNodes)) {
      try { node.onended = null; node.stop(); } catch { /* ignore */ }
      this.activeNodes.delete(node);
    }
    this.nextStartTime = 0;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    clearInterval(this.synthWaveTimer);
    this.synthWave = 0;
    this.speaking = false;
    this.currentText = '';

    if (wasSpeaking) {
      this.onInterrupt?.({ reason, cutText, speakerLabel: this.activeSpeakerLabel });
      this.onStateChange?.('interrupted', { reason, speakerLabel: this.activeSpeakerLabel });
    }
    return wasSpeaking;
  }

  async speak(text, { provider = null, rate = null, voice = null } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return;
    this.interrupt('replaced');
    const gen = ++this.speakGen;
    this.speaking = true;
    this.currentText = clean;
    this.onStateChange?.('speaking', { text: clean });

    if (this.muted) {
      this.synthWave = 0.42;
      this.synthWaveTimer = setInterval(() => {
        if (gen !== this.speakGen) return;
        this.synthWave = 0.22 + Math.random() * 0.56;
      }, 75);
      await new Promise((r) => setTimeout(r, clamp(clean.length * 40, 1400, 4200)));
      if (gen === this.speakGen) {
        clearInterval(this.synthWaveTimer);
        this.synthWave = 0;
        this.speaking = false;
        this.onStateChange?.('idle');
      }
      return;
    }

    if (!this.isStaticBuild) {
      try {
        await this._speakStreamingEndpoint(clean, gen, {
          provider: provider || this.preferredProvider,
          rate,
          voice,
        });
        if (gen === this.speakGen) {
          this.speaking = false;
          this.onStateChange?.('idle');
        }
        return;
      } catch (err) {
        if (gen !== this.speakGen || err?.name === 'AbortError') return;
        // Graceful fallback to browser speech synthesis if server TTS unavailable
      }
    }

    await this._speakBrowser(clean, gen);
    if (gen === this.speakGen) {
      this.speaking = false;
      this.onStateChange?.('idle');
    }
  }

  async _speakStreamingEndpoint(text, gen, { provider, rate, voice }) {
    const ctx = this.ensurePlaybackContext();
    const ctrl = new AbortController();
    this.activeTtsAbort = ctrl;

    const res = await fetch('/sim-api/tts/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, provider, rate, voice }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Stream TTS HTTP ${res.status}`);

    let sampleRate = 24000;
    let lastEndPromise = Promise.resolve();
    this.nextStartTime = ctx.currentTime + 0.03;

    const scheduleAudioChunk = async (bytes) => {
      if (gen !== this.speakGen || !bytes.length) return;
      let audioBuffer;
      if (isWavHeader(bytes)) {
        audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      } else {
        const samples = Math.floor(bytes.byteLength / 2);
        if (!samples) return;
        audioBuffer = ctx.createBuffer(1, samples, sampleRate);
        const ch = audioBuffer.getChannelData(0);
        const dv = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
        for (let i = 0; i < samples; i++) {
          ch[i] = dv.getInt16(i * 2, true) / 32768;
        }
      }
      if (gen !== this.speakGen) return;

      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      src.connect(this.analyser);
      const startAt = Math.max(ctx.currentTime + 0.015, this.nextStartTime);
      this.nextStartTime = startAt + audioBuffer.duration;
      this.activeNodes.add(src);
      lastEndPromise = new Promise((resolve) => {
        src.onended = () => {
          this.activeNodes.delete(src);
          resolve();
        };
      });
      src.start(startAt);
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuf = '';
    let gotAudio = false;

    while (gen === this.speakGen) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const raw = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!raw) continue;
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.type === 'meta') {
          if (Number(msg.sampleRate) >= 8000) sampleRate = Number(msg.sampleRate);
          this.onStateChange?.('speaking', { text, provider: msg.provider, model: msg.model });
        } else if (msg.type === 'audio' && msg.data) {
          gotAudio = true;
          await scheduleAudioChunk(base64ToBytes(msg.data));
        } else if (msg.type === 'error') {
          throw new Error(msg.error || 'TTS stream error');
        }
      }
    }

    if (this.activeTtsAbort === ctrl) this.activeTtsAbort = null;
    if (!gotAudio && gen === this.speakGen) throw new Error('Empty audio stream');
    await lastEndPromise;
  }

  _speakBrowser(text, gen) {
    return new Promise((resolve) => {
      if (typeof speechSynthesis === 'undefined') {
        setTimeout(resolve, clamp(text.length * 42, 1500, 3800));
        return;
      }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickNaturalVoice();
      if (v) u.voice = v;
      u.rate = 1.06;
      u.pitch = 0.90;
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearInterval(this.synthWaveTimer);
        clearTimeout(guard);
        this.synthWave = 0;
        resolve();
      };
      u.onstart = () => {
        if (gen !== this.speakGen) { speechSynthesis.cancel(); done(); return; }
        this.synthWaveTimer = setInterval(() => {
          this.synthWave = 0.25 + Math.random() * 0.6;
        }, 70);
      };
      u.onend = done;
      u.onerror = done;
      const guard = setTimeout(done, clamp(text.length * 92 + 1500, 3000, 12000));
      this.synthWave = 0.4;
      speechSynthesis.speak(u);
    });
  }

  /* ---------------------------------- Full-Duplex Barge-In Acoustic VAD */

  async setDuplexMonitoring(enabled) {
    if (enabled === this.duplexEnabled) return this.duplexEnabled;
    if (!enabled) {
      this._stopMicStream();
      this.duplexEnabled = false;
      this.onStateChange?.('idle');
      return false;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone requires localhost or HTTPS.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    const proc = ctx.createScriptProcessor(2048, 1, 1);

    this.micStream = stream;
    this.micCtx = ctx;
    this.micSource = source;
    this.micSink = sink;
    this.micProc = proc;
    this.duplexEnabled = true;
    this.noiseFloor = 0.014;
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;
    this.preRoll = [];
    this.turnChunks = [];
    this.capturingTurn = false;

    const framesPerSec = (ctx.sampleRate || 48000) / 2048; // ~23.4 frames/sec
    const speechConfirmFrames = Math.max(3, Math.round(framesPerSec * 0.17));
    const silenceEndFrames = Math.max(14, Math.round(framesPerSec * 0.95));

    proc.onaudioprocess = (ev) => {
      if (!this.duplexEnabled) return;
      const ch = new Float32Array(ev.inputBuffer.getChannelData(0));
      let sq = 0;
      let pk = 0;
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > pk) pk = a;
        sq += ch[i] * ch[i];
      }
      const rms = Math.sqrt(sq / ch.length);
      this.onMicLevel?.(clamp(rms * 6, 0, 1));

      // Keep 250ms pre-roll ring so barge-in never drops the opening syllable
      this.preRoll.push(ch);
      if (this.preRoll.length > 6) this.preRoll.shift();

      // When Luka is speaking, require slightly higher barge-in threshold to avoid speaker bleed
      const speechThresh = this.speaking
        ? Math.max(0.055, this.noiseFloor * 3.8)
        : Math.max(0.028, this.noiseFloor * 2.8);

      const isVoice = this.manualHoldActive || rms > speechThresh;
      if (!isVoice && !this.capturingTurn) {
        this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03;
      }

      if (this.capturingTurn) {
        this.turnChunks.push(ch);
        if (pk > this.turnPeak) this.turnPeak = pk;
        if (isVoice) {
          this.vadSilenceFrames = 0;
        } else {
          this.vadSilenceFrames += 1;
          if (!this.manualHoldActive && this.vadSilenceFrames >= silenceEndFrames) {
            void this._flushCapturedTurn();
          }
        }
        // Safety cap: max 14 seconds per barge-in turn
        if (this.turnChunks.length > Math.round(framesPerSec * 14)) {
          void this._flushCapturedTurn();
        }
      } else if (isVoice) {
        this.vadSpeechFrames += 1;
        if (this.manualHoldActive || this.vadSpeechFrames >= speechConfirmFrames) {
          const cutLuka = this.speaking;
          if (cutLuka) this.interrupt('barge_in');
          this.capturingTurn = true;
          this.capturedWasInterrupt = cutLuka;
          this.vadSilenceFrames = 0;
          this.turnChunks = [...this.preRoll];
          this.turnPeak = pk;
          this.onStateChange?.('listening', {
            wasInterrupted: cutLuka,
            speakerLabel: this.activeSpeakerLabel,
          });
        }
      } else {
        this.vadSpeechFrames = 0;
      }
    };

    source.connect(proc);
    proc.connect(sink);
    if (ctx.state === 'suspended') await ctx.resume();
    this.onStateChange?.('duplex_ready');
    return true;
  }

  async startManualTurn() {
    this.interrupt('manual_ptt');
    if (this.isStaticBuild) {
      await this._startStaticSpeechRec();
      return;
    }
    if (!this.duplexEnabled) {
      await this.setDuplexMonitoring(true);
    }
    this.manualHoldActive = true;
    this.capturingTurn = true;
    this.capturedWasInterrupt = false;
    this.vadSilenceFrames = 0;
    this.turnChunks = [];
    this.turnPeak = 0;
    this.onStateChange?.('listening', { speakerLabel: this.activeSpeakerLabel });
  }

  async endManualTurn(send = true) {
    if (this.isStaticBuild) {
      await this._stopStaticSpeechRec(send);
      return;
    }
    this.manualHoldActive = false;
    if (!send) {
      this.capturingTurn = false;
      this.turnChunks = [];
      this.onStateChange?.('idle');
      return;
    }
    if (this.capturingTurn) {
      await this._flushCapturedTurn();
    }
  }

  async _flushCapturedTurn() {
    const chunks = this.turnChunks;
    const peak = this.turnPeak;
    const wasInterrupted = this.capturedWasInterrupt;
    const sr = this.micCtx?.sampleRate || 48000;
    this.capturingTurn = false;
    this.turnChunks = [];
    this.turnPeak = 0;
    this.vadSpeechFrames = 0;
    this.vadSilenceFrames = 0;

    const total = chunks.reduce((s, c) => s + c.length, 0);
    if (!total || peak < 0.004) {
      this.onStateChange?.('idle');
      return;
    }

    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    const resampled = resampleLinear(merged, sr, 16000);
    if (peak < 0.25) {
      const gain = Math.min(0.65 / peak, 10);
      for (let i = 0; i < resampled.length; i++) resampled[i] = clamp(resampled[i] * gain, -1, 1);
    }

    const wav = encodeWav16k(resampled);
    this.onStateChange?.('transcribing', { wasInterrupted, speakerLabel: this.activeSpeakerLabel });

    if (this.isStaticBuild) {
      this.onStateChange?.('idle');
      return;
    }

    try {
      const res = await fetch('/sim-api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
      });
      const raw = await res.text();
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      const transcript = String(data.transcript || '').trim();
      if (!res.ok || !data.ok || !transcript) {
        this.onStateChange?.('idle');
        return;
      }

      // Use Deepgram Nova-3 diarized speaker label if multiple speakers detected, else active floor role
      const speakers = Array.isArray(data.speakers) ? data.speakers : [];
      const effectiveLabel = data.diarized && speakers.length
        ? `${this.activeSpeakerLabel} (${speakers[speakers.length - 1].label})`
        : this.activeSpeakerLabel;

      this.onUserUtterance?.({
        transcript,
        speakers,
        speakerCount: data.speakerCount || 1,
        speakerLabel: effectiveLabel,
        provider: data.provider || 'whisper.cpp',
        diarized: Boolean(data.diarized),
        wasInterrupted,
        asrMs: data.asr_ms || 0,
      });
    } catch {
      this.onStateChange?.('idle');
    }
  }

  _startStaticSpeechRec() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return Promise.reject(new Error('Browser speech recognition unavailable.'));
    return new Promise((resolve, reject) => {
      const rec = new SpeechRec();
      rec.lang = 'en-US';
      rec.interimResults = true;
      rec.continuous = true;
      const session = { rec, finalText: '', interimText: '', ended: false, resolvers: [] };
      let started = false;
      rec.onstart = () => {
        started = true;
        this.speechRec = session;
        this.onStateChange?.('listening', { speakerLabel: this.activeSpeakerLabel });
        resolve(session);
      };
      rec.onresult = (ev) => {
        let fin = '';
        let inter = '';
        for (let i = 0; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) fin += `${ev.results[i][0].transcript} `;
          else inter += ev.results[i][0].transcript;
        }
        session.finalText = fin.trim();
        session.interimText = inter.trim();
      };
      rec.onerror = (ev) => {
        if (!started) reject(new Error(ev.error || 'speech_error'));
      };
      rec.onend = () => {
        session.ended = true;
        for (const fn of session.resolvers) fn();
      };
      rec.start();
    });
  }

  async _stopStaticSpeechRec(send = true) {
    const session = this.speechRec;
    this.speechRec = null;
    if (!session) return;
    if (!session.ended) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, send ? 750 : 120);
        session.resolvers.push(() => { clearTimeout(t); resolve(); });
        try { if (send) session.rec.stop(); else session.rec.abort(); } catch { clearTimeout(t); resolve(); }
      });
    }
    const transcript = `${session.finalText} ${session.interimText}`.trim();
    if (send && transcript) {
      this.onUserUtterance?.({
        transcript,
        speakers: [{ speakerId: 0, label: this.activeSpeakerLabel, text: transcript }],
        speakerCount: 1,
        speakerLabel: this.activeSpeakerLabel,
        provider: 'browser-speech',
        diarized: false,
        wasInterrupted: false,
      });
    } else {
      this.onStateChange?.('idle');
    }
  }

  _stopMicStream() {
    for (const k of ['micProc', 'micSource', 'micSink']) {
      try { this[k]?.disconnect(); } catch { /* ignore */ }
      this[k] = null;
    }
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    void this.micCtx?.close().catch(() => {});
    this.micCtx = null;
    this.capturingTurn = false;
    this.turnChunks = [];
  }

  dispose() {
    this.interrupt('dispose');
    this._stopMicStream();
    void this.audioCtx?.close().catch(() => {});
  }
}
