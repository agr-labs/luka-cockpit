// Small, scoped neck controller used by the local voice dashboard. It shares
// the gateway's leases and head payload contract; no other capability is opened.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { LeaseManager } from './lease.mjs';
import { validatePayload } from './contract.mjs';
import { GatewayError, badRequest, conflict, unprocessable, unavailable } from './errors.mjs';

const TTL_MS = 10_000;
const STEP = 2 * Math.PI / 180;
const JOGS = { left: ['yaw', STEP], right: ['yaw', -STEP], up: ['pitch', -STEP], down: ['pitch', STEP] };
const shellQuote = (value) => `'${value.replace(/'/g, "'\\''")}'`;

export class SshHeadTransport {
  constructor({ sshArgs, workerPath = new URL('../../tools/luka-head-worker.py', import.meta.url) }) {
    this.sshArgs = sshArgs;
    this.workerPath = workerPath;
    this.child = null;
    this.starting = null;
    this.pending = new Map();
    this.closed = false;
    this.robotClockOffset = null;
  }

  async start() {
    if (this.closed) throw unavailable('Head connection is shutting down');
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const source = await readFile(this.workerPath, 'utf8');
      const child = spawn('ssh', [...this.sshArgs, `python3 -u -c ${shellQuote(source)}`], { stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let buffer = '', stderr = '';
      const fail = (error) => {
        if (this.child === child) this.child = null;
        for (const [id, item] of this.pending) {
          if (item.child !== child) continue;
          clearTimeout(item.timer); item.reject(error); this.pending.delete(id);
        }
      };
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let newline;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let packet;
          try { packet = JSON.parse(line); } catch { continue; }
          const item = this.pending.get(packet.id);
          if (!item) continue;
          this.pending.delete(packet.id); clearTimeout(item.timer);
          if (packet.ok) {
            if (Number.isFinite(packet.result?.clockMs)) this.robotClockOffset = packet.result.clockMs - (item.sentAt + Date.now()) / 2;
            item.resolve(packet.result);
          }
          else {
            const code = packet.error?.code || 'head_unavailable';
            const status = ['head_limit', 'test_limit', 'invalid_target', 'stale_target'].includes(code) ? 422 : 409;
            item.reject(new GatewayError(code === 'head_unavailable' ? 503 : status, code, packet.error?.message || 'Head request failed'));
          }
        }
        if (buffer.length > 64 * 1024) { child.kill(); fail(unavailable('Invalid head worker response')); }
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-400); });
      child.stdin.on('error', () => {});
      child.on('error', (error) => fail(unavailable(error.message)));
      child.on('close', () => fail(unavailable(stderr.trim() || 'Head connection closed; ownership timeout is active on Luka')));
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  async request(operation, args = {}) {
    await this.start();
    if (this.pending.size >= 8) throw conflict('head_busy', 'Head connection is busy');
    const child = this.child;
    const id = randomUUID();
    if (operation === 'move' || operation === 'home') {
      if (!Number.isFinite(this.robotClockOffset)) throw unavailable('Read fresh head feedback before moving');
      args = { ...args, deadlineMs: args.deadlineMs + this.robotClockOffset };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        child.kill('SIGTERM');
        reject(unavailable('Head request timed out; enable controls again after reconnection'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer, child, sentAt: Date.now() });
      child.stdin.write(`${JSON.stringify({ id, operation, args })}\n`, (error) => {
        if (!error || !this.pending.has(id)) return;
        clearTimeout(timer); this.pending.delete(id); reject(unavailable('Head connection could not send the request'));
      });
    });
  }

  async close() {
    this.closed = true;
    if (this.starting) await this.starting.catch(() => {});
    const child = this.child;
    if (!child) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 6000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end(); // Worker finally restores ownership before exiting.
    });
  }
}

export class HeadController {
  constructor({ transport, now = Date.now }) {
    this.transport = transport;
    this.now = now;
    this.leases = new LeaseManager({ now, defaultTtlMs: TTL_MS, maxTtlMs: TTL_MS });
    this.snapshot = null;
    this.refreshing = null;
    this.chain = Promise.resolve();
    this.mutations = 0;
    this.ownedToken = null;
    this.commands = new Map();
    this.cancelVersion = 0;
  }

  view() {
    const lease = this.leases.get('luka-head');
    return { ...this.snapshot, busy: this.mutations > 0,
      lease: lease ? { holder: lease.holder, expiresAt: lease.expiresAt, ttlMs: lease.ttlMs } : null,
      serverNow: this.now(), stepDeg: 2, envelopeDeg: { yaw: 10, pitch: 5 } };
  }

  remember(state) {
    this.snapshot = { ...state, sampledAt: this.now() };
    return this.view();
  }

  async inspect() {
    if (this.snapshot && (this.mutations || this.now() - this.snapshot.sampledAt < 250)) return this.view();
    if (!this.refreshing) {
      this.refreshing = this.transport.request('state').then((state) => this.remember(state)).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  mutate(fn, queue = false) {
    if (this.mutations && !queue) throw conflict('head_busy', 'Wait for the current head movement to finish');
    this.mutations++;
    const run = this.chain.then(fn, fn).finally(() => { this.mutations--; });
    this.chain = run.catch(() => {});
    return run;
  }

  async acquire(holder) {
    if (typeof holder !== 'string' || !holder.trim() || holder.length > 100) throw badRequest('A dashboard holder ID is required');
    return this.mutate(async () => {
      if (this.leases.get('luka-head')) throw conflict('lease_held', 'Another dashboard already holds the head controls');
      const lease = this.leases.acquire('luka-head', { holder, mode: 'manual', capabilities: ['head.gaze'] });
      this.ownedToken = lease.leaseId;
      try {
        const state = await this.transport.request('acquire', { leaseId: lease.leaseId, ttlMs: TTL_MS });
        this.commands.clear();
        this.remember(state);
        return { leaseId: lease.leaseId };
      } catch (error) {
        this.leases.revoke('luka-head', 'acquire failed');
        throw error;
      }
    }).then((result) => ({ ...result, state: this.view() }));
  }

  async heartbeat(leaseId) {
    this.leases.require('luka-head', leaseId);
    await this.transport.request('heartbeat', { leaseId, ttlMs: TTL_MS });
    this.leases.renew('luka-head', leaseId);
    return { state: this.view() };
  }

  checkDeadline(deadlineMs) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= this.now() || deadlineMs > this.now() + 3000) {
      throw conflict('command_expired', 'Head command expired; tap again using fresh feedback');
    }
  }

  async jog({ leaseId, direction, deadlineMs, commandId, home = false }) {
    this.leases.require('luka-head', leaseId);
    if (!home && !Object.hasOwn(JOGS, direction)) throw badRequest('Choose left, right, up, or down');
    if (typeof commandId !== 'string' || !commandId || commandId.length > 100) throw badRequest('A command ID is required');
    if (this.commands.has(commandId)) return this.commands.get(commandId);
    this.checkDeadline(deadlineMs);
    const version = this.cancelVersion;
    const run = this.mutate(async () => {
      this.leases.require('luka-head', leaseId);
      this.checkDeadline(deadlineMs);
      const state = await this.transport.request('state');
      this.remember(state);
      const target = { ...(home ? state.start : state.measured) };
      if (!home) { const [axis, delta] = JOGS[direction]; target[axis] += delta; }
      const valid = validatePayload('head.gaze', target);
      if (!valid.ok) throw unprocessable('This head target exceeds the documented range', valid.errors);
      this.checkDeadline(deadlineMs);
      this.leases.require('luka-head', leaseId);
      if (version !== this.cancelVersion) throw conflict('command_cancelled', 'Head movement cancelled by release');
      this.remember(await this.transport.request(home ? 'home' : 'move', { leaseId, target, deadlineMs }));
    }).then(() => ({ state: this.view() }));
    this.commands.set(commandId, run);
    if (this.commands.size > 64) this.commands.delete(this.commands.keys().next().value);
    return run;
  }

  async release(leaseId) {
    if (!leaseId || leaseId !== this.ownedToken) throw conflict('lease_mismatch', 'This dashboard does not hold the head lease');
    this.cancelVersion++;
    return this.mutate(async () => {
      this.remember(await this.transport.request('release', { leaseId }));
      this.leases.revoke('luka-head', 'released');
      this.ownedToken = null;
      this.commands.clear();
    }, true).then(() => ({ state: this.view() }));
  }

  async close() {
    if (this.ownedToken) await this.release(this.ownedToken).catch(() => {});
    await this.transport.close();
  }
}

// The head routes deliberately do not inherit the speech bridge's permissive
// CORS headers. A browser must send same-origin JSON and hold the head lease.
export function createHeadHandler(controller) {
  return async (req, res, url) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.origin) {
        let origin;
        try { origin = new URL(req.headers.origin); }
        catch { throw new GatewayError(403, 'origin_refused', 'Head controls require the dashboard origin'); }
        if (origin.host !== req.headers.host || !['http:', 'https:'].includes(origin.protocol)) {
          throw new GatewayError(403, 'origin_refused', 'Head controls must be used from this dashboard');
        }
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new GatewayError(403, 'origin_refused', 'Head controls require the dashboard origin');
      if (req.method === 'GET' && url.pathname === '/head/state') return send(200, { ok: true, state: await controller.inspect() });
      const routes = {
        '/head/acquire': ['holder'], '/head/heartbeat': ['leaseId'], '/head/release': ['leaseId'],
        '/head/jog': ['leaseId', 'direction', 'deadlineMs', 'commandId'], '/head/home': ['leaseId', 'deadlineMs', 'commandId'],
      };
      if (req.method !== 'POST' || !Object.hasOwn(routes, url.pathname)) throw new GatewayError(404, 'not_found', 'Head route not found');
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new GatewayError(415, 'json_required', 'Head controls require JSON');
      let text = '';
      for await (const chunk of req) {
        text += chunk.toString('utf8');
        if (text.length > 4096) throw badRequest('Head request too large');
      }
      let body;
      try { body = JSON.parse(text); } catch { throw badRequest('Invalid head JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Head request must be an object');
      if (Object.keys(body).some((key) => !routes[url.pathname].includes(key))) throw badRequest('Unknown head request field');
      let result;
      if (url.pathname === '/head/acquire') result = await controller.acquire(body.holder);
      if (url.pathname === '/head/heartbeat') result = await controller.heartbeat(body.leaseId);
      if (url.pathname === '/head/release') result = await controller.release(body.leaseId);
      if (url.pathname === '/head/jog' || url.pathname === '/head/home') result = await controller.jog({ ...body, home: url.pathname === '/head/home' });
      return send(200, { ok: true, ...result });
    } catch (error) {
      return send(error.status || 503, { ok: false, error: { code: error.code || 'head_unavailable', message: error.message } });
    }
  };
}
