// Telemetry link. Talks to the cockpit's local server (/api/robot/*), never
// directly to the robot: the AimDK gateway sends no CORS headers, and a local
// proxy also gives us one place to enforce the polling budget.

export const POLL_HZ = 0.2;          // AGIBOT guidance: keep RPC polling <= 0.2 Hz
// A 5 s poll period means a 2 s staleness window would mark healthy telemetry
// stale for most of every cycle and block the command path. Allow one full
// missed cycle plus margin.
export const STALE_MS = 7000;
export const JOINT_STALE_MS = 1200;   // joint stream at 5 Hz; 1.2 s means it stopped
export const JOINT_HZ = 5;

export class RobotLink extends EventTarget {
  constructor(base = '') {
    super();
    this.base = base;
    this.mode = 'offline';           // 'live' | 'mock' | 'offline'
    this.last = null;                // last successful payload
    this.lastOkAt = 0;
    this.failures = 0;
    this.latencyMs = null;
    this.timer = null;
    this.polling = false;
    this.jointTimer = null;
    this.jointPolling = false;
    this.jointRunning = false;
    this.gatewayTimer = null;
    this.gatewayBase = '';
    this.liveRunId = 0;
    this.jointRunId = 0;
    this.joints = {};        // name -> radians
    this.neck = {};          // idx27/idx28 -> radians
    this.hands = {};         // side -> { fingerKey: 0..2000 }
    this.neckAt = 0;
    this.handsAt = 0;
    this.jointAt = 0;
    this.jointCount = 0;
    this.jointErrors = 0;
  }

  get fresh() { return performance.now() - this.lastOkAt < STALE_MS; }
  get jointsFresh() { return this.jointAt > 0 && performance.now() - this.jointAt < JOINT_STALE_MS; }
  get neckFresh() { return this.neckAt > 0 && performance.now() - this.neckAt < JOINT_STALE_MS; }
  get handsFresh() { return this.handsAt > 0 && performance.now() - this.handsAt < JOINT_STALE_MS; }
  get ageMs() { return this.lastOkAt ? performance.now() - this.lastOkAt : Infinity; }

  startLive() {
    this.stop();
    this.mode = 'live';
    this.failures = 0;
    this.startJoints();
    const runId = ++this.liveRunId;
    const tick = async () => {
      if (runId !== this.liveRunId) return;
      if (!this.polling) await this.poll();
      if (runId === this.liveRunId && this.mode === 'live') this.timer = setTimeout(tick, 1000 / POLL_HZ);
    };
    tick();
  }

  startGateway(robotId, base = '') {
    this.stop();
    this.mode = 'gateway';
    this.robotId = robotId;
    this.gatewayBase = base || `${location.protocol}//${location.hostname}:8788`;
    const tick = async () => {
      if (this.mode !== 'gateway') return;
      try {
        const [jr, sr] = await Promise.all([
          fetch(`${this.gatewayBase}/api/v1/robots/${robotId}/joints`, { signal: AbortSignal.timeout(3000) }),
          fetch(`${this.gatewayBase}/api/v1/robots/${robotId}/state`, { signal: AbortSignal.timeout(3000) }),
        ]);
        const j = await jr.json();
        const s = await sr.json();
        if (j?.joints) {
          this.joints = j.joints;
          this.jointAt = performance.now();
          this.jointCount = Object.keys(j.joints).length;
          this.dispatchEvent(new CustomEvent('joints', { detail: { joints: this.joints, count: this.jointCount } }));
        }
        this.last = { info: { current_action: s.action, status: s.health } };
        this.lastOkAt = performance.now();
        this.failures = 0;
        this.dispatchEvent(new CustomEvent('update', { detail: this.snapshot() }));
      } catch (err) {
        this.failures++;
        this.lastError = String(err.message || err);
        if (this.failures >= 3) {
        this.mode = 'offline';
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
      }
      }
      if (this.mode === 'gateway') this.gatewayTimer = setTimeout(tick, 200);
    };
    tick();
  }

  startMock() {
    this.stop();
    this.mode = 'mock';
    const tick = () => {
      this.last = {
        header: { code: '0', msg: 'mock link' },
        info: {
          current_action: 'McAction_RL_LOCOMOTION_ARM_EXT_JOINT_SERVO',
          ext_action: '',
          status: 'McActionStatus_RUNNING',
        },
        __mock: true,
        __at: Date.now(),
      };
      this.lastOkAt = performance.now();
      this.latencyMs = 12 + Math.random() * 6;
      this.dispatchEvent(new CustomEvent('update', { detail: this.snapshot() }));
      this.timer = setTimeout(tick, 1000 / POLL_HZ);
    };
    tick();
  }

  /** Poll measured joint angles. Separate cadence from the mode poll. */
  startJoints() {
    if (this.jointTimer) clearTimeout(this.jointTimer);
    this.jointRunning = true;
    this.jointErrors = 0;
    const runId = ++this.jointRunId;
    const tick = async () => {
      if (runId !== this.jointRunId || !this.jointRunning) return;
      if (!this.jointPolling) await this.pollJoints();
      if (runId === this.jointRunId && this.jointRunning) this.jointTimer = setTimeout(tick, 1000 / JOINT_HZ);
    };
    tick();
  }

  stopJoints() {
    this.jointRunning = false;
    this.jointRunId++;
    if (this.jointTimer) clearTimeout(this.jointTimer);
    this.jointTimer = null;
    this.joints = {};
    this.jointAt = 0;
    this.neck = {};
    this.neckAt = 0;
    this.hands = {};
    this.handsAt = 0;
  }

  async pollJoints() {
    this.jointPolling = true;
    try {
      const res = await fetch(`${this.base}/api/robot/getJointState`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(2000),
      });
      const json = await res.json();
      if (json && json.__proxyError) throw new Error(json.message || 'proxy error');
      const states = json?.states;
      if (!Array.isArray(states) || !states.length) throw new Error('no joint states');
      const next = {};
      for (const s of states) {
        if (typeof s.position === 'number') next[s.name] = s.position;
      }
      this.joints = next;
      this.jointAt = performance.now();
      // Neck and hands on the same cadence; failures are non-fatal.
      this.pollNeck();
      this.pollHands();
      this.jointCount = states.length;
      this.jointErrors = 0;
      this.dispatchEvent(new CustomEvent('joints', { detail: { joints: next, count: states.length } }));
    } catch (err) {
      this.jointErrors++;
      if (this.jointErrors >= 3) {
        this.jointAt = 0;
        this.stopJoints(); // stop hammering a dead proxy; 'connect live' restarts it
      }
    } finally {
      this.jointPolling = false;
    }
  }

  async pollNeck() {
    try {
      const res = await fetch(`${this.base}/api/robot/getNeckState`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(3000),
      });
      const json = await res.json();
      const d = json?.data;
      if (!d) return;
      const next = {};
      for (const axis of ['shake', 'nod']) {
        const j = d[axis];
        if (j && typeof j.position === 'number') next[j.name] = j.position;
      }
      if (Object.keys(next).length) { this.neck = next; this.neckAt = performance.now(); }
    } catch { /* neck is optional telemetry */ }
  }

  async pollHands() {
    try {
      const res = await fetch(`${this.base}/api/robot/getHandState`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(3000),
      });
      const json = await res.json();
      const d = json?.data;
      if (!d) return;
      const next = {};
      for (const side of ['left', 'right']) {
        const pos = d[side]?.agi_hand?.finger?.pos;
        if (pos) next[side] = pos;
      }
      if (Object.keys(next).length) { this.hands = next; this.handsAt = performance.now(); }
    } catch { /* hands are optional telemetry */ }
  }

  stop() {
    this.liveRunId++;
    this.stopJoints();
    if (this.timer) clearTimeout(this.timer);
    if (this.gatewayTimer) clearTimeout(this.gatewayTimer);
    this.timer = null;
    this.gatewayTimer = null;
    this.mode = 'offline';
    this.dispatchEvent(new CustomEvent('update', { detail: this.snapshot() }));
  }

  async poll() {
    this.polling = true;
    const t0 = performance.now();
    try {
      const res = await fetch(`${this.base}/api/robot/getAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(4000),
      });
      const json = await res.json();
      this.latencyMs = performance.now() - t0;
      if (json && json.__proxyError) throw new Error(json.message || 'proxy error');
      this.last = json;
      this.lastOkAt = performance.now();
      this.failures = 0;
    } catch (err) {
      this.failures++;
      this.lastError = String(err.message || err);
      if (this.failures >= 3) this.mode = 'offline';
    } finally {
      this.polling = false;
      this.dispatchEvent(new CustomEvent('update', { detail: this.snapshot() }));
    }
  }

  snapshot() {
    const info = this.last?.info || {};
    return {
      mode: this.mode,
      fresh: this.fresh,
      ageMs: this.ageMs,
      latencyMs: this.latencyMs,
      failures: this.failures,
      error: this.lastError,
      action: info.current_action || null,
      extAction: info.ext_action || null,
      status: info.status || null,
      code: this.last?.header?.code ?? null,
      msg: this.last?.header?.msg ?? null,
      at: this.last?.__at || null,
      jointsFresh: this.jointsFresh,
      neckFresh: this.neckFresh,
      handsFresh: this.handsFresh,
      jointCount: this.jointCount,
      jointErrors: this.jointErrors,
    };
  }
}
