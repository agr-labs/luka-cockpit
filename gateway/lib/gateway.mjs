// Steadwell Robot Gateway.
//
// One HTTP/WebSocket contract in front of robot adapters. The gateway owns three
// things and delegates everything else:
//
//   1. authority — leases, modes, the software-stop latch;
//   2. restraint — capability gates, payload validation, rate limits;
//   3. memory   — an append-only audit trail of every command and refusal.
//
// It never speaks a vendor protocol. That is the adapter's job, and the adapter
// is the only component that knows whether a write path exists at all.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  badRequest, conflict, GatewayError, locked, notFound, payloadTooLarge,
  tooManyRequests, unauthorized,
} from './errors.mjs';
import {
  API_VERSION, CAPABILITIES, contractDocument, validatePayload,
} from './contract.mjs';
import { LeaseManager } from './lease.mjs';
import { AuditLog } from './audit.mjs';
import { StopLatch, assertCommandAllowed } from './safety.mjs';
import { PresenceRegistry } from './presence.mjs';
import { LidarHub, MAX_BYTES as LIDAR_MAX_BYTES } from './lidar.mjs';
import { generateScan } from './lidar-sim.mjs';
import { ADAPTERS, Registry, loadConfig } from './registry.mjs';
import { attachWebSocket, closeAllWebSockets } from './ws.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const MAX_BODY = 64 * 1024;
const IDEMPOTENCY_TTL_MS = 10 * 60_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function createGateway(options = {}) {
  const config = options.config ?? await loadConfig();
  const now = options.now ?? Date.now;
  const physicalEnabled = options.physicalEnabled ?? process.env.GATEWAY_ALLOW_PHYSICAL === '1';
  const token = options.token ?? process.env.GATEWAY_TOKEN ?? null;
  const telemetryHz = options.telemetryHz ?? Number(config.gateway?.telemetryHz ?? 10);
  const commandRate = options.commandRate ?? 60;   // sustained commands/second per robot
  const commandBurst = options.commandBurst ?? 120;

  const audit = new AuditLog({ now });
  const leases = new LeaseManager({ now });
  const latch = new StopLatch({ now });
  const presence = new PresenceRegistry({ now });
  const lidar = new LidarHub({ now });
  const idempotency = new Map();  // commandId -> { hash, status, body, at }
  const buckets = new Map();      // robotId -> { tokens, at }
  const subscribers = new Set();  // { robotId, send, close }
  const startedAt = now();

  const registry = new Registry(config, {
    physicalEnabled,
    emit: (robotId, kind, payload) => {
      if (kind === 'event') broadcast({ type: 'event', robotId, event: payload, at: new Date(now()).toISOString() });
    },
  });
  if (options.startAdapters !== false) registry.start();

  // Simulated lidar for robots configured with lidar.simulate. The real robot's
  // topic is ROS 2-only; this is the same pipeline with a synthetic source, so
  // swapping in a bridge changes the producer and nothing else.
  const lidarTimers = [];
  for (const robot of registry.list()) {
    const cfg = robot.lidar;
    if (!cfg?.simulate) continue;
    const hz = Math.min(30, Math.max(1, Number(cfg.hz ?? 10)));
    const points = Math.max(200, Math.min(20_000, Number(cfg.points ?? 2200)));
    let frame = 0;
    const timer = setInterval(() => {
      try {
        const scan = generateScan({ points, frame: frame++ });
        lidar.publish(robot.id, Buffer.from(scan.buffer), { source: 'simulated-mid360' });
      } catch {
        /* a dropped simulated frame is not an incident */
      }
    }, 1000 / hz);
    timer.unref?.();
    lidarTimers.push(timer);
  }

  /* ------------------------------ transport ------------------------------ */

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof GatewayError ? err.status : 500;
      if (status === 500) console.error('[gateway]', err);
      if (!res.headersSent) sendJson(res, status, err instanceof GatewayError ? err.toJSON() : { error: { code: 'internal', message: 'internal error' } });
      else res.end();
    });
  });

  function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }

  function sendJson(res, status, body, headers = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(text);
  }

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw payloadTooLarge(`body exceeds ${MAX_BODY} bytes`);
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw badRequest('body must be valid JSON');
    }
  }

  async function readBinary(req, maxBytes) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw payloadTooLarge(`body exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
    if (!size) throw badRequest('empty frame body');
    return Buffer.concat(chunks);
  }

  /** Bearer auth is optional; when a token is configured it is mandatory. */
  function authenticate(req, url) {
    if (!token) return 'anonymous';
    const header = req.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token');
    if (!supplied) throw unauthorized('bearer token required');
    const a = createHash('sha256').update(String(supplied)).digest();
    const b = createHash('sha256').update(token).digest();
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw unauthorized('invalid token');
    return 'bearer';
  }

  function bucket(robotId) {
    let b = buckets.get(robotId);
    if (!b) { b = { tokens: commandBurst, at: now() }; buckets.set(robotId, b); }
    const elapsed = Math.max(0, now() - b.at) / 1000;
    b.tokens = Math.min(commandBurst, b.tokens + elapsed * commandRate);
    b.at = now();
    return b;
  }

  function spend(robotId) {
    const b = bucket(robotId);
    if (b.tokens < 1) throw tooManyRequests('command rate limit exceeded', { rate: commandRate, burst: commandBurst });
    b.tokens -= 1;
  }

  /* ------------------------------- routing ------------------------------- */

  attachWebSocket(server, (conn, req, url) => {
    let actor;
    try {
      actor = authenticate(req, url);
    } catch (err) {
      conn.send({ type: 'error', error: err.toJSON?.().error ?? { code: 'unauthorized' } });
      return conn.close(4401, 'unauthorized');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const isAll = parts.length === 3 && parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'telemetry';
    const isRobot = parts.length === 5 && parts[0] === 'api' && parts[1] === 'v1'
      && parts[2] === 'robots' && parts[4] === 'telemetry';
    const isLidar = parts.length === 5 && parts[0] === 'api' && parts[1] === 'v1'
      && parts[2] === 'robots' && parts[4] === 'lidar';
    if (!isAll && !isRobot && !isLidar) return conn.close(4404, 'not found');
    const robotId = isAll ? null : parts[3];
    if (robotId !== null && !registry.has(robotId)) {
      conn.send({ type: 'error', error: { code: 'not_found', message: `unknown robot "${robotId}"` } });
      return conn.close(4404, 'unknown robot');
    }

    // The lidar channel is binary and separate from state/joints: a viewer asks
    // for point clouds, and a dashboard tab should not receive 3 MiB/s of them.
    if (isLidar) {
      conn.send({
        type: 'hello',
        channel: 'lidar',
        apiVersion: API_VERSION,
        robotId,
        actor,
        serverTime: new Date(now()).toISOString(),
        lidar: lidar.latest(robotId),
      });
      const unsubscribe = lidar.subscribe(robotId, (buffer) => conn.sendBinary(buffer));
      conn.onMessage((text) => {
        let msg;
        try { msg = JSON.parse(text); } catch { return conn.send({ type: 'error', error: { code: 'bad_json' } }); }
        if (msg?.type === 'ping') conn.send({ type: 'pong', at: new Date(now()).toISOString() });
        if (msg?.type === 'refresh') conn.send({ type: 'meta', robotId, lidar: lidar.latest(robotId) });
      });
      conn.onClose(() => unsubscribe());
      return;
    }

    conn.send({
      type: 'hello',
      apiVersion: API_VERSION,
      robotId,
      actor,
      serverTime: new Date(now()).toISOString(),
      robots: registry.list().map((r) => ({ robotId: r.id, online: registry.status(r).online })),
    });

    const subscriber = {
      robotId,
      send: (payload) => conn.send(payload),
      close: () => conn.close(1000, 'server shutdown'),
    };
    subscribers.add(subscriber);
    if (robotId) subscriber.send({ type: 'state', robotId, at: new Date(now()).toISOString(), state: composeState(registry.get(robotId)) });
    conn.onMessage((text) => {
      let msg;
      try { msg = JSON.parse(text); } catch { return conn.send({ type: 'error', error: { code: 'bad_json' } }); }
      if (msg?.type === 'ping') conn.send({ type: 'pong', at: new Date(now()).toISOString() });
      if (msg?.type === 'refresh' && robotId) {
        const s = registry.get(robotId).adapter.snapshot();
        conn.send({ type: 'state', robotId, at: new Date(now()).toISOString(), state: composeState(registry.get(robotId)) });
        conn.send({ type: 'joints', robotId, at: new Date(now()).toISOString(), joints: s.joints });
      }
    });
    conn.onClose(() => subscribers.delete(subscriber));
  });

  function broadcast(payload) {
    for (const sub of subscribers) {
      if (sub.robotId && payload.robotId && sub.robotId !== payload.robotId) continue;
      sub.send(payload);
    }
  }

  /* -------------------------- state composition -------------------------- */

  function composeState(robot) {
    const status = registry.status(robot);
    const base = robot.adapter.state();
    const lease = leases.get(robot.id);
    return {
      ...base,
      robotId: robot.id,
      label: robot.label,
      adapter: robot.adapterName,
      physical: robot.physical,
      configuration: robot.configuration,
      profile: robot.profile,
      online: status.online,
      health: status.health,
      stop: latch.state(robot.id),
      lease: lease ? publicLease(lease) : null,
      presence: presence.get(robot.id),
      lidar: lidar.latest(robot.id),
      gateway: {
        apiVersion: API_VERSION,
        physicalEnabled,
        servedAt: new Date(now()).toISOString(),
        uptimeMs: now() - startedAt,
      },
    };
  }

  async function handle(req, res) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean);

    // Static console. No auth: it is a shell that calls the authenticated API.
    if (!url.pathname.startsWith('/api/')) {
      await serveStatic(url.pathname, res);
      return;
    }

    // GET /api/v1/health — unauthenticated liveness is useful for supervisors,
    // but it leaks no robot state.
    if (url.pathname === '/api/v1/health') {
      sendJson(res, 200, {
        ok: true,
        apiVersion: API_VERSION,
        uptimeMs: now() - startedAt,
        robots: registry.list().length,
        physicalEnabled,
        tokenRequired: Boolean(token),
        auditSeq: audit.seq,
      });
      return;
    }

    const actor = authenticate(req, url);

    if (parts[1] !== 'v1') throw notFound(`unknown API version: ${url.pathname}`);

    if (url.pathname === '/api/v1/contract' && req.method === 'GET') {
      sendJson(res, 200, contractDocument());
      return;
    }

    if (url.pathname === '/api/v1/adapters' && req.method === 'GET') {
      const inUse = new Map();
      for (const robot of registry.list()) {
        if (!inUse.has(robot.adapterName)) inUse.set(robot.adapterName, []);
        inUse.get(robot.adapterName).push(robot.id);
      }
      sendJson(res, 200, {
        adapters: Object.keys(ADAPTERS).map((name) => ({
          name,
          robots: inUse.get(name) ?? [],
          loaded: inUse.has(name),
        })),
        startupErrors: registry.startupErrors,
      });
      return;
    }

    if (url.pathname === '/api/v1/audit' && req.method === 'GET') {
      const limit = clampInt(url.searchParams.get('limit'), 1, 500, 100);
      sendJson(res, 200, {
        runId: audit.runId,
        seq: audit.seq,
        entries: audit.tail({ limit, robotId: url.searchParams.get('robotId'), kind: url.searchParams.get('kind') }),
      });
      return;
    }

    if (url.pathname === '/api/v1/robots' && req.method === 'GET') {
      sendJson(res, 200, {
        robots: registry.list().map((robot) => {
          const state = robot.adapter.state();
          return {
            ...registry.describe(robot),
            action: state.action,
            actionLabel: state.actionLabel ?? null,
            source: state.source,
            stop: latch.state(robot.id),
            lease: publicLease(leases.get(robot.id)),
          };
        }),
      });
      return;
    }

    // /api/v1/robots/:id[/...]
    if (parts[1] === 'v1' && parts[2] === 'robots' && parts[3]) {
      const robot = registry.get(parts[3]);
      const tail = parts.slice(4);
      const route = tail[0] ?? '';
      const method = req.method;

      if (!route) {
        if (method !== 'GET') throw notFound('use GET for a robot');
        sendJson(res, 200, { ...registry.describe(robot), state: composeState(robot) });
        return;
      }

      if (route === 'capabilities' && method === 'GET') {
        sendJson(res, 200, {
          robotId: robot.id,
          apiVersion: API_VERSION,
          adapter: robot.adapterName,
          physical: robot.physical,
          configuration: robot.configuration,
          profile: robot.profile,
          physicalEnabled,
          capabilities: registry.capabilityList(robot),
        });
        return;
      }

      if (route === 'state' && method === 'GET') {
        sendJson(res, 200, composeState(robot));
        return;
      }

      if (route === 'joints' && method === 'GET') {
        const joints = robot.adapter.joints();
        sendJson(res, 200, { ...joints, robotId: robot.id, adapter: robot.adapterName });
        return;
      }

      if (route === 'cameras' && method === 'GET') {
        sendJson(res, 200, { robotId: robot.id, cameras: robot.adapter.cameras?.() ?? [] });
        return;
      }

      // LiDAR frames: binary ingest for a future robot-side bridge, plus a
      // metadata view. The viewer uses the WebSocket channel, not this route.
      if (route === 'lidar') {
        if (method === 'GET') {
          sendJson(res, 200, {
            robotId: robot.id,
            configured: robot.lidar ?? null,
            lidar: lidar.latest(robot.id),
          });
          return;
        }
        if (method === 'POST') {
          const body = await readBinary(req, LIDAR_MAX_BYTES);
          const source = sanitizeSource(url.searchParams.get('source'));
          const meta = lidar.publish(robot.id, body, { source });
          sendJson(res, 202, { accepted: true, lidar: meta });
          return;
        }
        throw notFound('lidar supports GET and POST');
      }

      // Ambient observation, not robot telemetry: scalars measured by the room
      // sensor page. No lease, because it grants nothing and commands nothing.
      if (route === 'presence') {
        if (method === 'GET') {
          sendJson(res, 200, { robotId: robot.id, presence: presence.get(robot.id) });
          return;
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const view = presence.ingest(robot.id, body);
          broadcast({ type: 'presence', robotId: robot.id, at: new Date(now()).toISOString(), presence: view });
          sendJson(res, 202, { accepted: true, presence: view });
          return;
        }
        throw notFound('presence supports GET and POST');
      }

      if (route === 'telemetry' && method === 'GET') {
        await streamSse(req, res, robot);
        return;
      }

      if (route === 'leases') {
        if (tail.length === 1 && method === 'POST') { await createLease(robot, req, res, actor); return; }
        if (tail.length === 3 && tail[2] === 'renew' && method === 'POST') { await renewLease(robot, tail[1], req, res, actor); return; }
        if (tail.length === 2 && method === 'DELETE') { releaseLease(robot, tail[1], res, actor); return; }
        throw notFound('lease routes: POST /leases, POST /leases/:id/renew, DELETE /leases/:id');
      }

      if (route === 'commands' && method === 'POST') { await runCommand(robot, req, res, actor); return; }
      if (route === 'stop' && method === 'POST') { await stopRobot(robot, req, res, actor); return; }
      if (route === 'rearm' && method === 'POST') { await rearmRobot(robot, req, res, actor); return; }
      if (route === 'speech' && method === 'POST') { await speech(robot, req, res, actor); return; }

      throw notFound(`no route ${method} /api/v1/robots/${robot.id}/${tail.join('/')}`);
    }

    throw notFound(`no route ${req.method} ${url.pathname}`);
  }

  /* ------------------------------- leases -------------------------------- */

  function publicLease(lease) {
    if (!lease) return null;
    return {
      leaseId: lease.leaseId,
      holder: lease.holder,
      mode: lease.mode,
      capabilities: lease.capabilities,
      epoch: lease.epoch,
      issuedAt: new Date(lease.issuedAt).toISOString(),
      expiresAt: new Date(lease.expiresAt).toISOString(),
      ttlMs: lease.ttlMs,
      remainingMs: Math.max(0, lease.expiresAt - now()),
    };
  }

  async function createLease(robot, req, res, actor) {
    const body = await readJson(req);
    const mode = body.mode ?? (robot.physical ? 'observe' : 'simulate');
    if (!robot.physical && (mode === 'manual' || mode === 'assisted')) {
      throw conflict('mode_not_applicable', `mode "${mode}" is for physical robots; use "simulate" for ${robot.id}`, { hint: 'a simulator has no hardware to hold authority over' });
    }
    if (robot.physical && mode === 'simulate') {
      throw conflict('mode_not_applicable', 'simulate mode is for simulator robots; a physical robot exposes observe, manual or assisted', { hint: 'run the simulator robot to rehearse a command' });
    }
    const caps = Array.isArray(body.capabilities) ? body.capabilities : null;
    if (caps) {
      const unknown = caps.filter((c) => !CAPABILITIES[c]);
      if (unknown.length) throw badRequest('lease names unknown capabilities', { unknown });
    }
    const lease = leases.acquire(robot.id, {
      holder: body.holder,
      mode,
      ttlMs: body.ttlMs,
      capabilities: caps,
    });
    audit.record({
      actor, robotId: robot.id, kind: 'lease', outcome: 'accepted', code: 'lease_granted',
      message: `${lease.mode} lease to ${lease.holder} until ${new Date(lease.expiresAt).toISOString()}`,
      detail: { leaseId: lease.leaseId, mode: lease.mode, scope: lease.capabilities },
    });

    const warnings = [];
    if (mode === 'manual' || mode === 'assisted') {
      const commandable = registry.capabilityList(robot).filter((c) => c.commandable);
      if (!commandable.length) {
        warnings.push({
          code: 'no_verified_capabilities',
          message: 'this robot has no verified command path; commands will be refused at the capability gate',
        });
      }
    }
    sendJson(res, 201, { lease: publicLease(lease), warnings });
  }

  async function renewLease(robot, leaseId, req, res, actor) {
    const body = await readJson(req);
    const lease = leases.renew(robot.id, leaseId, { ttlMs: body.ttlMs });
    audit.record({
      actor, robotId: robot.id, kind: 'lease', outcome: 'accepted', code: 'lease_renewed',
      message: `lease renewed to ${new Date(lease.expiresAt).toISOString()}`,
      detail: { leaseId: lease.leaseId, epoch: lease.epoch },
    });
    sendJson(res, 200, { lease: publicLease(lease) });
  }

  function releaseLease(robot, leaseId, res, actor) {
    const result = leases.release(robot.id, leaseId);
    audit.record({
      actor, robotId: robot.id, kind: 'lease', outcome: 'accepted', code: result.released ? 'lease_released' : 'lease_absent',
      message: result.released ? 'lease released' : 'release requested with no active lease',
      detail: result,
    });
    sendJson(res, 200, result);
  }

  /* ------------------------------ commands -------------------------------- */

  async function runCommand(robot, req, res, actor) {
    const body = await readJson(req);
    const commandId = body.commandId;
    if (typeof commandId !== 'string' || commandId.length < 6 || commandId.length > 64) {
      throw badRequest('commandId must be a string of 6-64 characters (idempotency key)');
    }
    if (body.robotId && body.robotId !== robot.id) {
      throw badRequest(`robotId in body (${body.robotId}) does not match the URL (${robot.id})`);
    }
    const hash = hashPayload(body);
    const prior = idempotency.get(commandId);
    if (prior && now() - prior.at < IDEMPOTENCY_TTL_MS) {
      if (prior.hash !== hash) {
        throw conflict('command_id_conflict', 'commandId was already used with a different payload', { commandId });
      }
      audit.record({
        actor, robotId: robot.id, kind: 'command', outcome: 'accepted', code: 'idempotent_replay',
        message: 'duplicate commandId replayed without re-execution', commandId,
      });
      sendJson(res, prior.status, prior.body, { 'X-Idempotent-Replay': 'true' });
      return;
    }

    const started = now();
    const capabilityId = body.capability;
    let recorded = false;

    // Every refusal is audited before it is returned. A gate that closes without
    // a log entry is indistinguishable from a gate that never ran.
    try {
      const capability = CAPABILITIES[capabilityId];
      if (!capability) throw notFound(`unknown capability "${capabilityId}"`, { known: Object.keys(CAPABILITIES) });

      // A latched stop outranks everything: even a client with a stale lease and
      // a malformed payload should be told the robot is stopped, not debug
      // validation.
      const stop = latch.state(robot.id);
      if (stop.latched) {
        throw locked(`software stop is latched (${stop.reason}); POST /rearm first`, stop);
      }

      const lease = leases.require(robot.id, body.leaseId);
      const adapterCap = robot.adapter.capabilities?.()[capabilityId] ?? null;
      const validation = validatePayload(capabilityId, body.payload);
      const deadlineMs = body.deadlineMs;

      const gate = assertCommandAllowed({
        robot: { ...robot, online: registry.status(robot).online },
        capability,
        adapterCap,
        lease,
        mode: lease.mode,
        physicalEnabled,
        validation,
        deadlineMs,
        now: now(),
      });

      spend(robot.id);

      let result;
      try {
        result = robot.adapter.execute(capabilityId, body.payload);
      } catch (err) {
        const gerr = err instanceof GatewayError
          ? err
          : new GatewayError(500, 'adapter_error', String(err?.message ?? err));
        gerr.commandId = commandId;
        throw gerr;
      }

      const accepted = result?.accepted !== false;
      const response = {
        commandId,
        robotId: robot.id,
        capability: capabilityId,
        mode: lease.mode,
        leaseId: lease.leaseId,
        accepted,
        applied: Boolean(result?.applied),
        note: result?.note ?? null,
        warnings: [...gate.warnings, ...(result?.warnings ?? [])],
        deadlineMs,
        receivedAt: new Date(started).toISOString(),
        latencyMs: now() - started,
      };

      audit.record({
        actor, robotId: robot.id, kind: 'command',
        outcome: accepted ? 'accepted' : 'rejected',
        code: accepted ? 'command_accepted' : (result?.code ?? 'command_refused'),
        capability: capabilityId, commandId,
        message: result?.note ?? null,
        detail: { mode: lease.mode, applied: Boolean(result?.applied), warnings: response.warnings.length },
      });
      recorded = true;

      if (!accepted) {
        idempotency.set(commandId, { hash, status: 409, body: response, at: now() });
        sendJson(res, 409, {
          ...response,
          error: { code: result?.code ?? 'command_refused', message: result?.note ?? 'adapter refused the command' },
        });
        return;
      }

      idempotency.set(commandId, { hash, status: 200, body: response, at: now() });
      pruneIdempotency();
      sendJson(res, 200, response);
    } catch (err) {
      if (!recorded) {
        audit.record({
          actor, robotId: robot.id, kind: 'command',
          outcome: err instanceof GatewayError && err.status < 500 ? 'rejected' : 'failed',
          code: err instanceof GatewayError ? err.code : 'internal',
          capability: capabilityId ?? null,
          commandId,
          message: err?.message ?? String(err),
          detail: err instanceof GatewayError && err.details ? { details: err.details } : null,
        });
      }
      throw err;
    }
  }

  function pruneIdempotency() {
    if (idempotency.size < 500) return;
    const cutoff = now() - IDEMPOTENCY_TTL_MS;
    for (const [key, value] of idempotency) if (value.at < cutoff) idempotency.delete(key);
  }

  async function stopRobot(robot, req, res, actor) {
    const body = await readJson(req);
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim().slice(0, 200)
      : 'operator software stop';
    const scope = body.scope === 'gateway' ? 'gateway' : 'all';
    const latched = latch.latch(robot.id, { reason, scope, actor });
    const revoked = leases.revoke(robot.id, 'software stop latched');

    let adapterResult;
    try {
      adapterResult = robot.adapter.stopHardware(reason);
    } catch (err) {
      adapterResult = { supported: false, delivered: false, note: `adapter stop threw: ${String(err?.message ?? err)}` };
    }

    audit.record({
      actor, robotId: robot.id, kind: 'stop', outcome: 'applied', code: 'software_stop',
      message: reason,
      detail: { scope, revoked, adapter: adapterResult },
    });

    sendJson(res, 200, {
      latched: true,
      scope,
      reason,
      at: latched.at,
      leaseRevoked: revoked.revoked,
      adapter: adapterResult,
      certified: false,
      note: 'Software stop only. It blocks gateway commands and asks the adapter to stop. It is not a certified emergency stop; use the factory e-stop.',
    });
  }

  async function rearmRobot(robot, req, res, actor) {
    const body = await readJson(req);
    const cleared = latch.clear(robot.id, { confirm: body.confirm, reason: body.reason, actor });
    audit.record({
      actor, robotId: robot.id, kind: 'rearm', outcome: 'accepted', code: 'stop_cleared',
      message: body.reason ?? 'software stop cleared',
      detail: { wasLatchedAt: cleared.was.at },
    });
    sendJson(res, 200, cleared);
  }

  async function speech(robot, req, res, actor) {
    const body = await readJson(req);
    const command = {
      commandId: body.commandId ?? `spc_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      capability: 'voice.speak',
      payload: {
        text: body.text,
        ...(body.voice ? { voice: body.voice } : {}),
        ...(body.volume !== undefined ? { volume: body.volume } : {}),
        ...(body.interrupt !== undefined ? { interrupt: body.interrupt } : {}),
      },
      leaseId: body.leaseId,
      deadlineMs: body.deadlineMs,
    };
    // Reuse the command path by synthesising a request body.
    const synthetic = new RequestLike(JSON.stringify(command));
    await runCommand(robot, synthetic, res, actor, req.headers);
  }

  /* ------------------------------ telemetry ------------------------------- */

  async function streamSse(req, res, robot) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ type: 'hello', apiVersion: API_VERSION, robotId: robot.id })}\n\n`);
    res.write(`event: state\ndata: ${JSON.stringify({ type: 'state', robotId: robot.id, state: composeState(robot) })}\n\n`);
    const sub = {
      robotId: robot.id,
      send: (payload) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`),
      close: () => res.end(),
    };
    subscribers.add(sub);
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 20_000);
    keepAlive.unref?.();
    req.on('close', () => { clearInterval(keepAlive); subscribers.delete(sub); });
  }

  const telemetryTimer = setInterval(() => {
    if (!subscribers.size) return;
    const stamp = new Date(now()).toISOString();
    for (const robot of registry.list()) {
      const relevant = [...subscribers].some((s) => !s.robotId || s.robotId === robot.id);
      if (!relevant) continue;
      let snap;
      try {
        snap = robot.adapter.snapshot();
      } catch {
        continue;
      }
      broadcast({ type: 'state', robotId: robot.id, at: stamp, state: composeState(robot) });
      broadcast({ type: 'joints', robotId: robot.id, at: stamp, joints: snap.joints });
    }
  }, Math.max(50, 1000 / Math.max(1, telemetryHz)));
  telemetryTimer.unref?.();

  /* -------------------------------- static -------------------------------- */

  async function serveStatic(pathname, res) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = normalize(join(PUBLIC_DIR, decodeURIComponent(rel)));
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const st = await stat(filePath);
      if (!st.isFile()) throw new Error('not a file');
      const data = await readFile(filePath);
      res.writeHead(200, {
        'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  }

  /* -------------------------------- lifecycle ----------------------------- */

  const api = {
    server,
    registry,
    leases,
    latch,
    audit,
    config,
    physicalEnabled,
    token,
    composeState,
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          const address = server.address();
          resolve({ port: address.port, host: address.address, url: `http://${host}:${address.port}` });
        });
      });
    },
    async close() {
      clearInterval(telemetryTimer);
      for (const timer of lidarTimers) clearInterval(timer);
      for (const sub of subscribers) sub.close();
      subscribers.clear();
      registry.stop();
      const closed = new Promise((resolve) => server.close(resolve));
      // A viewer that never says goodbye must not hold the process open.
      closeAllWebSockets();
      server.closeAllConnections?.();
      await closed;
    },
  };
  return api;
}

/* ------------------------------- utilities -------------------------------- */

function sanitizeSource(value) {
  if (typeof value !== 'string') return 'bridge';
  const clean = value.toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return clean.slice(0, 32) || 'bridge';
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function hashPayload(body) {
  const canonical = JSON.stringify([body.capability, body.payload ?? null, body.leaseId ?? null, body.deadlineMs ?? null]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * Minimal stand-in for an IncomingMessage so /speech can reuse the command path
 * without duplicating the gate chain. Only the async iterator and headers are
 * used by readJson/authenticate.
 */
class RequestLike {
  constructor(text, headers = {}) {
    this.text = text;
    this.headers = headers;
  }
  async *[Symbol.asyncIterator]() {
    yield Buffer.from(this.text, 'utf8');
  }
}
