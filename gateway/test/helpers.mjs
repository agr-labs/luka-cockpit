// Test helpers: boot a gateway on an ephemeral port and provide the few
// primitives every HTTP test needs. No test framework beyond node:test.

import { createGateway } from '../lib/gateway.mjs';

export function simConfig(overrides = {}) {
  return {
    gateway: { telemetryHz: 50 },
    robots: [
      {
        id: 'luka-sim',
        label: 'Luka simulator',
        adapter: 'simulator',
        physical: false,
        configuration: 'grounded',
      },
    ],
    ...overrides,
  };
}

export async function boot(t, { robots, physicalEnabled = false, token = null, telemetryHz = 50, now, ...rest } = {}) {
  const gateway = await createGateway({
    config: simConfig({ robots: robots ?? simConfig().robots }),
    physicalEnabled,
    token,
    telemetryHz,
    ...(now ? { now } : {}),
    ...rest,
  });
  const { url } = await gateway.listen(0, '127.0.0.1');
  t.after(async () => { await gateway.close(); });
  return {
    gateway,
    url,
    api: (path = '') => `${url}/api/v1${path}`,
    headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
  };
}

export async function getJson(ctx, path) {
  const res = await fetch(ctx.api(path), { headers: ctx.headers });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export async function postJson(ctx, path, body) {
  const res = await fetch(ctx.api(path), {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

export async function leaseFor(ctx, robotId = 'luka-sim', { holder = 'test-runner', mode = 'simulate', ttlMs = 30_000, capabilities } = {}) {
  const res = await postJson(ctx, `/robots/${robotId}/leases`, { holder, mode, ttlMs, capabilities });
  return { ...res, lease: res.body.lease };
}

let seq = 0;
export function command(overrides = {}) {
  return {
    commandId: `cmd_${Date.now()}_${++seq}`,
    capability: 'head.gaze',
    payload: { yaw: 0.2, pitch: -0.1 },
    leaseId: null,
    deadlineMs: Date.now() + 5_000,
    ...overrides,
  };
}

/** Minimal WebSocket client: handshake, then collect text messages. */
export async function openSocket(url, { headers = {} } = {}) {
  const { connect } = await import('node:net');
  const { createHash, randomBytes } = await import('node:crypto');
  const u = new URL(url);
  const key = randomBytes(16).toString('base64');
  const socket = connect({ host: u.hostname, port: Number(u.port) });

  const messages = [];
  const waiters = [];
  const binaryMessages = [];
  const binaryWaiters = [];
  let buffer = Buffer.alloc(0);
  let upgraded = false;

  const pushBinary = (buffer) => {
    binaryMessages.push(buffer);
    for (const w of [...binaryWaiters]) {
      if (w.predicate(buffer)) { binaryWaiters.splice(binaryWaiters.indexOf(w), 1); w.resolve(buffer); }
    }
  };

  const push = (text) => {
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw */ }
    messages.push(json ?? text);
    for (const w of [...waiters]) {
      if (w.predicate(json ?? text)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(json ?? text); }
    }
  };

  await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
        (Object.keys(headers).length ? '\r\n' : '') +
        '\r\n',
      );
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString();
        if (!/^HTTP\/1\.1 101/.test(head)) return reject(new Error(`handshake failed: ${head.split('\r\n')[0]}`));
        const accept = /sec-websocket-accept: (.*)/i.exec(head)?.[1];
        const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (accept !== expected) return reject(new Error('bad accept key'));
        upgraded = true;
        buffer = buffer.subarray(end + 4);
        resolve();
      }
      while (buffer.length >= 2) {
        const b0 = buffer[0];
        const b1 = buffer[1];
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); offset = 4; }
        else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + len) return;
        const payload = buffer.subarray(offset, offset + len);
        buffer = buffer.subarray(offset + len);
        const opcode = b0 & 0x0f;
        if (opcode === 0x1) push(payload.toString('utf8'));
        if (opcode === 0x2) pushBinary(Buffer.from(payload));
        if (opcode === 0x8) socket.end();
      }
    });
  });

  return {
    messages,
    send(obj) {
      const payload = Buffer.from(JSON.stringify(obj), 'utf8');
      const mask = randomBytes(4);
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      const header = payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
      socket.write(Buffer.concat([header, mask, masked]));
    },
    waitFor(predicate, timeoutMs = 3000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for websocket message')), timeoutMs);
        waiters.push({ predicate, resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    binary: binaryMessages,
    waitForBinary(predicate = () => true, timeoutMs = 3000) {
      const existing = binaryMessages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for binary frame')), timeoutMs);
        binaryWaiters.push({ predicate, resolve: (v) => { clearTimeout(timer); resolve(v); } });
      });
    },
    close() { socket.destroy(); },
  };
}
