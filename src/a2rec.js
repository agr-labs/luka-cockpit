// A2REC1 reader + playback clock.
//
// Format (little-endian):
//   "A2REC1\n"
//   repeat: uint32 length, then length bytes of
//           double wallClock, double monotonic, uint16 topicLen, topic,
//           uint32 payloadLen, payload(JSON)
//
// The payload is {"t": <seconds>, "j": {joint: value, ...}, "src": <label>}.
// Only the a2remote/joints topic is present in the published files.

const MAGIC = 'A2REC1\n';

export function parseA2REC(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new Error(`not an A2REC1 file (got "${magic}")`);

  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  let offset = MAGIC.length;
  const frames = [];
  const topics = new Map();
  let src = null;

  while (offset + 4 <= bytes.length) {
    const len = view.getUint32(offset, true);
    offset += 4;
    if (offset + len > bytes.length) throw new Error(`truncated record at ${offset}`);
    const dt = view.getFloat64(offset, true);
    const topicLen = view.getUint16(offset + 16, true);
    const topic = decoder.decode(bytes.subarray(offset + 18, offset + 18 + topicLen));
    const payloadLen = view.getUint32(offset + 18 + topicLen, true);
    const payloadStart = offset + 22 + topicLen;
    const payload = decoder.decode(bytes.subarray(payloadStart, payloadStart + payloadLen));
    offset += len;

    topics.set(topic, (topics.get(topic) || 0) + 1);
    if (topic !== 'a2remote/joints') continue;
    let msg;
    try { msg = JSON.parse(payload); } catch { continue; }
    if (!msg || typeof msg.t !== 'number' || !msg.j) continue;
    src = msg.src ?? src;
    frames.push({ t: msg.t, j: msg.j, dt });
  }

  if (!frames.length) throw new Error('no a2remote/joints frames');
  frames.sort((a, b) => a.t - b.t);
  const t0 = frames[0].t;
  for (const f of frames) f.t -= t0;

  const names = new Set();
  for (const f of frames) for (const k of Object.keys(f.j)) names.add(k);

  return {
    frames,
    jointNames: [...names],
    duration: frames[frames.length - 1].t,
    sources: src ? [src] : [],
    topics: Object.fromEntries(topics),
  };
}

/** Playback clock: converts wall time into a frame index and interpolated pose. */
export class Playback {
  constructor(recording) {
    this.rec = recording;
    this.time = 0;
    this.speed = 1;
    this.playing = false;
    this.loop = true;
  }

  get duration() { return this.rec.duration; }
  get frameIndex() {
    // binary search for the last frame with t <= time
    const f = this.rec.frames;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= this.time) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Interpolated joint values at the current time. */
  sample() {
    const f = this.rec.frames;
    const i = this.frameIndex;
    const a = f[i];
    const b = f[Math.min(i + 1, f.length - 1)];
    const span = b.t - a.t;
    const u = span > 1e-6 ? Math.max(0, Math.min(1, (this.time - a.t) / span)) : 0;
    const out = {};
    for (const k of this.rec.jointNames) {
      const av = a.j[k], bv = b.j[k];
      out[k] = av === undefined ? 0 : bv === undefined ? av : av + (bv - av) * u;
    }
    return out;
  }

  update(dtMs) {
    if (!this.playing) return;
    this.time += (dtMs / 1000) * this.speed;
    if (this.time > this.duration) {
      if (this.loop) this.time = 0;
      else { this.time = this.duration; this.playing = false; }
    }
  }

  seek(fraction) {
    this.time = Math.max(0, Math.min(1, fraction)) * this.duration;
  }
}

export const RECORDINGS = [
  { id: 'legs', label: 'legs · 19 Oct', file: 'luka-20261019-115249-legs.a2rec' },
  { id: 'arm', label: 'arm · 22 Oct', file: 'luka-20261022-125322-arm.a2rec' },
  { id: 'mixed', label: 'mixed · 22 Oct', file: 'luka-20261022-191420.a2rec' },
];

export async function loadRecording(file, dir = './model/recordings/') {
  const res = await fetch(dir + file);
  if (!res.ok) throw new Error(`recording fetch failed: ${res.status} ${file}`);
  return parseA2REC(await res.arrayBuffer());
}
