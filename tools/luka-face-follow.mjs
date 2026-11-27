import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { GatewayError, badRequest, unavailable } from '../gateway/lib/errors.mjs';

const FRAME_MAX = 8 * 1024 * 1024;
const JPEG_MAX = 4 * 1024 * 1024;
const FRESH_FACE_MS = 2600;
const FRESH_CAMERA_MS = 4500;
const NO_FACE_RELEASE_MS = 2800;
const HEARTBEAT_MS = 2000;
const CLIENT_TTL_MS = 6500;
const MOVE_INTERVAL_MS = 900;
const DEAD_BAND_RAD = 4 * Math.PI / 180;
const CAMERA = Object.freeze({ width: 1920, height: 1536, fx: 1188.4492107412, fy: 1188.1944927793, cx: 959.3370155049, cy: 768.5420821699 });

const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
const safeMessage = (error) => String(error?.message || error || 'Face follow failed').slice(0, 240);

export class FaceFollowService {
  constructor({ head, sshArgs, toolsDir, modelPath, pythonBin, ffmpegBin = 'ffmpeg', now = Date.now }) {
    this.head = head;
    this.sshArgs = sshArgs;
    this.toolsDir = toolsDir;
    this.modelPath = modelPath;
    this.pythonBin = pythonBin;
    this.ffmpegBin = ffmpegBin;
    this.now = now;
    this.enabled = false;
    this.status = 'off';
    this.message = 'Face follow is off.';
    this.sessionId = null;
    this.holder = null;
    this.children = [];
    this.cameraChild = null;
    this.ffmpegChild = null;
    this.detectorChild = null;
    this.cameraBuffer = Buffer.alloc(0);
    this.jpegBuffer = Buffer.alloc(0);
    this.detectorBuffer = '';
    this.detectionQueue = [];
    this.processingDetections = false;
    this.lastCameraAt = 0;
    this.lastDetectionAt = 0;
    this.lastFaceAt = 0;
    this.lastClientAt = 0;
    this.lastHeartbeatAt = 0;
    this.lastMoveAt = 0;
    this.startAt = 0;
    this.stableFrames = 0;
    this.face = null;
    this.leaseId = null;
    this.inFlight = null;
    this.blockedDirections = new Set();
    this.timer = null;
    this.stopping = false;
    this.lastStderr = '';
    this.cameraLost = false;
  }

  state() {
    const now = this.now();
    const faceFresh = this.face && now - this.lastDetectionAt < FRESH_FACE_MS;
    return {
      enabled: this.enabled,
      status: this.status,
      message: this.message,
      camera: {
        connected: Boolean(this.lastCameraAt && now - this.lastCameraAt < FRESH_CAMERA_MS),
        ageMs: this.lastCameraAt ? Math.max(0, now - this.lastCameraAt) : null,
        source: 'interactive',
        nominalHz: 1,
      },
      face: faceFresh ? { ...this.face, ageMs: Math.max(0, now - this.lastDetectionAt) } : null,
      headLease: Boolean(this.leaseId),
    };
  }

  async start() {
    if (this.enabled) return { sessionId: this.sessionId, state: this.state() };
    if (this.stopping) throw new GatewayError(409, 'face_follow_busy', 'Face follow is still releasing head control');
    try { await access(this.modelPath); }
    catch { throw unavailable('Face model is missing. Run npm run face-follow:setup first.'); }

    this.enabled = true;
    this.status = 'starting';
    this.message = 'Starting local face detection…';
    this.sessionId = randomUUID();
    this.holder = `lukachat-face-${this.sessionId.slice(0, 12)}`;
    this.startAt = this.lastClientAt = this.now();
    this.lastCameraAt = this.lastDetectionAt = this.lastFaceAt = 0;
    this.lastHeartbeatAt = this.lastMoveAt = 0;
    this.stableFrames = 0;
    this.face = null;
    this.cameraLost = false;
    this.blockedDirections.clear();
    try {
      await this.startPipeline();
      this.status = 'searching';
      this.message = 'Looking for a face in the forward camera…';
      this.timer = setInterval(() => { void this.tick(); }, 500);
      return { sessionId: this.sessionId, state: this.state() };
    } catch (error) {
      await this.shutdown('error', safeMessage(error));
      throw unavailable(safeMessage(error));
    }
  }

  heartbeat(sessionId) {
    this.requireSession(sessionId);
    this.lastClientAt = this.now();
    return this.state();
  }

  async stop(sessionId) {
    this.requireSession(sessionId);
    await this.shutdown('off', 'Face follow is off.');
    return this.state();
  }

  async close() {
    if (this.enabled) await this.shutdown('off', 'Face follow stopped while the bridge shut down.');
  }

  requireSession(sessionId) {
    if (!this.enabled || typeof sessionId !== 'string' || sessionId !== this.sessionId) {
      throw new GatewayError(409, 'face_follow_session', 'Face follow session is no longer active');
    }
  }

  async startPipeline() {
    const workerPath = `${this.toolsDir}/luka-camera-mqtt-worker.py`;
    const detectorPath = `${this.toolsDir}/luka-face-detector.py`;
    const cameraSource = await readFile(workerPath, 'utf8');
    this.detectorChild = spawn(this.pythonBin, ['-u', detectorPath, this.modelPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ffmpegChild = spawn(this.ffmpegBin, [
      '-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0',
      '-f', 'h264', '-i', 'pipe:0', '-vf', 'scale=640:512:flags=fast_bilinear',
      '-q:v', '5', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.cameraChild = spawn('ssh', [...this.sshArgs, `python3 -u -c ${shellQuote(cameraSource)}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.children = [this.cameraChild, this.ffmpegChild, this.detectorChild];

    this.cameraChild.stdout.on('data', (chunk) => this.onCameraData(chunk));
    this.ffmpegChild.stdout.on('data', (chunk) => this.onJpegData(chunk));
    this.detectorChild.stdout.on('data', (chunk) => this.onDetectorData(chunk));
    for (const stream of [this.ffmpegChild.stdin, this.detectorChild.stdin].filter(Boolean)) {
      stream.on('error', (error) => { if (!this.stopping && this.enabled) void this.fail(error); });
    }
    for (const child of this.children) {
      child.stderr.on('data', (chunk) => { this.lastStderr = (this.lastStderr + chunk.toString('utf8')).slice(-600); });
      child.on('error', (error) => { void this.fail(error); });
      child.on('exit', (code, signal) => {
        if (!this.stopping && this.enabled) void this.fail(new Error(`Face pipeline stopped (${code ?? signal ?? 'unknown'}). ${this.lastStderr.trim()}`));
      });
    }
  }

  onCameraData(chunk) {
    this.cameraBuffer = Buffer.concat([this.cameraBuffer, chunk]);
    while (this.cameraBuffer.length >= 4) {
      const size = this.cameraBuffer.readUInt32BE(0);
      if (!size || size > FRAME_MAX) { void this.fail(new Error('Invalid camera frame from Luka')); return; }
      if (this.cameraBuffer.length < size + 4) return;
      const frame = this.cameraBuffer.subarray(4, size + 4);
      this.cameraBuffer = this.cameraBuffer.subarray(size + 4);
      this.lastCameraAt = this.now();
      this.cameraLost = false;
      if (this.ffmpegChild && !this.ffmpegChild.stdin.destroyed) this.ffmpegChild.stdin.write(frame);
    }
  }

  onJpegData(chunk) {
    this.jpegBuffer = Buffer.concat([this.jpegBuffer, chunk]);
    const startMarker = Buffer.from([0xff, 0xd8]);
    const endMarker = Buffer.from([0xff, 0xd9]);
    while (true) {
      const start = this.jpegBuffer.indexOf(startMarker);
      if (start < 0) {
        if (this.jpegBuffer.length > JPEG_MAX) this.jpegBuffer = this.jpegBuffer.subarray(-1);
        return;
      }
      if (start > 0) this.jpegBuffer = this.jpegBuffer.subarray(start);
      const end = this.jpegBuffer.indexOf(endMarker, 2);
      if (end < 0) {
        if (this.jpegBuffer.length > JPEG_MAX) { void this.fail(new Error('Decoded camera image exceeded its size limit')); }
        return;
      }
      const jpeg = this.jpegBuffer.subarray(0, end + 2);
      this.jpegBuffer = this.jpegBuffer.subarray(end + 2);
      const prefix = Buffer.allocUnsafe(4);
      prefix.writeUInt32BE(jpeg.length);
      if (this.detectorChild && !this.detectorChild.stdin.destroyed) this.detectorChild.stdin.write(Buffer.concat([prefix, jpeg]));
    }
  }

  onDetectorData(chunk) {
    this.detectorBuffer += chunk.toString('utf8');
    if (this.detectorBuffer.length > 64 * 1024) { void this.fail(new Error('Face detector output exceeded its limit')); return; }
    const lines = this.detectorBuffer.split('\n');
    this.detectorBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      let detection;
      try { detection = JSON.parse(line); } catch { continue; }
      this.detectionQueue.push(detection);
    }
    void this.drainDetections();
  }

  async drainDetections() {
    if (this.processingDetections) return;
    this.processingDetections = true;
    try {
      while (this.detectionQueue.length && this.enabled) {
        this.inFlight = this.onDetection(this.detectionQueue.shift());
        await this.inFlight;
      }
    } catch (error) { await this.fail(error); }
    finally { this.inFlight = null; this.processingDetections = false; }
  }

  async onDetection(detection) {
    if (!this.enabled) return;
    const now = this.now();
    this.lastDetectionAt = now;
    if (detection?.present === true && Number.isFinite(detection.x) && Number.isFinite(detection.y)
      && Number.isFinite(detection.confidence) && detection.confidence >= 0.78) {
      this.face = {
        x: Math.max(0, Math.min(1, detection.x)),
        y: Math.max(0, Math.min(1, detection.y)),
        confidence: detection.confidence,
      };
      this.lastFaceAt = now;
      this.stableFrames++;
      this.cameraLost = false;
      const target = this.targetFor(this.face, this.blockedDirections);
      if (!target) {
        this.status = 'face_centered';
        this.message = 'Face centered in the forward camera.';
        return;
      }
      if (target.limited) {
        this.status = 'range_limit';
        this.message = 'Face is beyond the small follow range; head movement is bounded.';
        return;
      }
      if (this.stableFrames < 2 || now - this.lastMoveAt < MOVE_INTERVAL_MS) {
        this.status = 'face_seen';
        this.message = 'Face seen; steadying before a small head adjustment…';
        return;
      }
      if (!this.leaseId) {
        try {
          const acquired = await this.head.acquire(this.holder);
          this.leaseId = acquired.leaseId;
          this.lastHeartbeatAt = this.now();
        } catch (error) {
          if (error?.code === 'lease_held') {
            this.status = 'manual_priority';
            this.message = 'Manual head controls have priority. Release them to allow face follow.';
            this.lastMoveAt = now;
            return;
          }
          throw error;
        }
      }
      this.lastMoveAt = this.now();
      this.status = 'tracking';
      this.message = `Looking ${target.direction} toward the face…`;
      try {
        await this.head.jog({
          leaseId: this.leaseId,
          direction: target.direction,
          deadlineMs: this.now() + 2500,
          commandId: `face-${randomUUID()}`,
        });
      } catch (error) {
        if (['test_limit', 'head_limit'].includes(error?.code)) {
          this.blockedDirections.add(target.direction);
          this.status = 'range_limit';
          this.message = 'Face is beyond the small follow range; head movement is bounded.';
          return;
        }
        if (['head_busy', 'command_cancelled'].includes(error?.code)) {
          this.status = 'face_seen';
          this.message = 'Waiting for the previous head movement to settle…';
          return;
        }
        throw error;
      }
      return;
    }
    this.face = null;
    this.stableFrames = 0;
    this.blockedDirections.clear();
    if (this.leaseId) {
      this.status = 'face_lost';
      this.message = 'Face left view; holding briefly before restoring the starting pose.';
    } else {
      this.status = 'searching';
      this.message = 'Looking for a face in the forward camera…';
    }
  }

  targetFor(face, blockedDirections = new Set()) {
    const x = face.x * CAMERA.width;
    const y = face.y * CAMERA.height;
    const yawError = Math.atan((x - CAMERA.cx) / CAMERA.fx);
    const pitchError = Math.atan((y - CAMERA.cy) / CAMERA.fy);
    const candidates = [];
    if (Math.abs(yawError) > DEAD_BAND_RAD) candidates.push({ direction: yawError > 0 ? 'right' : 'left', magnitude: Math.abs(yawError) });
    if (Math.abs(pitchError) > DEAD_BAND_RAD) candidates.push({ direction: pitchError > 0 ? 'down' : 'up', magnitude: Math.abs(pitchError) });
    candidates.sort((a, b) => b.magnitude - a.magnitude);
    if (!candidates.length) return null;
    return candidates.find((candidate) => !blockedDirections.has(candidate.direction)) || { limited: true };
  }

  async tick() {
    if (!this.enabled || this.stopping) return;
    const now = this.now();
    if (now - this.lastClientAt > CLIENT_TTL_MS) {
      await this.shutdown('off', 'Face follow stopped because LukaChat was disconnected.');
      return;
    }
    if (!this.lastCameraAt && now - this.startAt > 10_000) {
      await this.fail(new Error('No forward camera frames arrived from Luka.'));
      return;
    }
    if (this.lastCameraAt && now - this.lastCameraAt > FRESH_CAMERA_MS) {
      if (!this.cameraLost) {
        this.cameraLost = true;
        this.face = null;
        this.status = 'camera_lost';
        this.message = 'Forward camera feed is stale; releasing head control.';
        await this.homeAndRelease();
      }
      return;
    }
    if (this.leaseId && this.lastFaceAt && now - this.lastFaceAt > NO_FACE_RELEASE_MS) {
      this.message = 'No face in view; restoring the starting pose.';
      await this.homeAndRelease();
      this.status = 'searching';
      this.message = 'Looking for a face in the forward camera…';
      return;
    }
    if (this.leaseId && now - this.lastHeartbeatAt >= HEARTBEAT_MS) {
      try {
        await this.head.heartbeat(this.leaseId);
        this.lastHeartbeatAt = now;
      } catch {
        this.leaseId = null;
        this.status = 'manual_priority';
        this.message = 'Head control ended; face follow is waiting for available head controls.';
      }
    }
    if (this.cameraLost && this.lastCameraAt && now - this.lastCameraAt <= FRESH_CAMERA_MS) {
      this.cameraLost = false;
      this.status = 'searching';
      this.message = 'Forward camera restored; looking for a face…';
    }
  }

  async homeAndRelease() {
    const token = this.leaseId;
    if (!token) return;
    if (this.inFlight) await this.inFlight.catch(() => {});
    try {
      await this.head.jog({ leaseId: token, deadlineMs: this.now() + 2500, commandId: `face-home-${randomUUID()}`, home: true });
    } catch { /* The worker restores factory ownership on release or lease timeout. */ }
    try { await this.head.release(token); } catch { /* Its Orin watchdog still owns the handback. */ }
    if (this.leaseId === token) this.leaseId = null;
    this.lastHeartbeatAt = 0;
    this.lastMoveAt = 0;
  }

  async fail(error) {
    if (this.stopping || !this.enabled) return;
    await this.shutdown('error', safeMessage(error));
  }

  async shutdown(finalStatus, message) {
    if (this.stopping) return;
    this.stopping = true;
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.homeAndRelease();
    for (const child of this.children) {
      try {
        if (child === this.cameraChild) child.kill('SIGTERM');
        else child.stdin?.end();
      } catch { /* already closed */ }
    }
    this.children = [];
    this.cameraChild = this.ffmpegChild = this.detectorChild = null;
    this.cameraBuffer = Buffer.alloc(0);
    this.jpegBuffer = Buffer.alloc(0);
    this.detectorBuffer = '';
    this.detectionQueue = [];
    this.sessionId = null;
    this.holder = null;
    this.face = null;
    this.stableFrames = 0;
    this.status = finalStatus;
    this.message = message;
    this.stopping = false;
  }
}

export function createFaceFollowHandler(service) {
  const send = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  return async (req, res, url) => {
    try {
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); }
        catch { throw new GatewayError(403, 'origin_refused', 'Face follow requires the LukaChat origin'); }
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
          throw new GatewayError(403, 'origin_refused', 'Face follow must be controlled from LukaChat');
        }
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new GatewayError(403, 'origin_refused', 'Face follow requires the LukaChat origin');
      if (req.method === 'GET' && url.pathname === '/face-follow/state') return send(res, 200, { ok: true, state: service.state() });
      const routes = {
        '/face-follow/start': [],
        '/face-follow/heartbeat': ['sessionId'],
        '/face-follow/stop': ['sessionId'],
      };
      if (req.method !== 'POST' || !Object.hasOwn(routes, url.pathname)) throw new GatewayError(404, 'not_found', 'Face follow route not found');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new GatewayError(415, 'json_required', 'Face follow requires JSON');
      let text = '';
      for await (const chunk of req) {
        text += chunk.toString('utf8');
        if (text.length > 1024) throw badRequest('Face follow request too large');
      }
      let body;
      try { body = JSON.parse(text || '{}'); } catch { throw badRequest('Invalid face follow JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Face follow request must be an object');
      if (Object.keys(body).some((key) => !routes[url.pathname].includes(key))) throw badRequest('Unknown face follow request field');
      if (url.pathname === '/face-follow/start') return send(res, 200, { ok: true, ...(await service.start()) });
      if (url.pathname === '/face-follow/heartbeat') return send(res, 200, { ok: true, state: service.heartbeat(body.sessionId) });
      return send(res, 200, { ok: true, state: await service.stop(body.sessionId) });
    } catch (error) {
      return send(res, error.status || 503, { ok: false, error: { code: error.code || 'face_follow_unavailable', message: safeMessage(error) } });
    }
  };
}
