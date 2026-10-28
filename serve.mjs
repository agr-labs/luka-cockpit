#!/usr/bin/env node
// Steadwell A2 cockpit — static server + read-only AimDK proxy.
//
// Why a proxy: the AimDK HTTP gateway sends no CORS headers, so the browser
// cannot call http://<robot>:56322 directly. This also gives one place to
// enforce the polling budget and to keep the write surface closed.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ROBOT_HOST = process.env.A2_HOST || '192.168.4.136';
const ROBOT_PORT = Number(process.env.A2_PORT || 56322);

// Only these methods may cross the proxy. GetAction is a read-only query.
// SetAction / locomotion commands are deliberately absent.
const READ_ONLY_RPCS = new Set([
  'aimdk.protocol.McActionService/GetAction',
  'aimdk.protocol.McDataService/GetJointState',
]);

// Joint telemetry is streamed for the live twin, so it gets its own budget.
// 5 Hz is a deliberate exception to the 0.2 Hz status-polling guidance: it is a
// small read-only payload read for visual mirroring, not state polling. Set
// JOINT_HZ=0 to disable.
const JOINT_HZ = Number(process.env.JOINT_HZ ?? 5);
const JOINT_MIN_MS = JOINT_HZ > 0 ? 1000 / JOINT_HZ : 0;
const JOINT_CACHE_MS = 2000;
let jointAt = 0;
let jointPayload = null;
let jointInFlight = false;

const MIN_INTERVAL_MS = 1000 / 0.25; // vendor guidance: continuous RPC polling <= 0.2 Hz
const CACHE_TTL_MS = 15000;          // serve a cached answer for at most this long
let lastProbe = 0;
let lastResult = null;
let cachedPayload = null;            // last successful GetAction body
let cachedAt = 0;
let inFlight = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.bin': 'application/octet-stream',
  '.a2rec': 'application/octet-stream',
  '.stl': 'model/stl',
  '.md': 'text/markdown; charset=utf-8',
};

// No caching: the generated model is rebuilt by tools/build-model.mjs and a
// stale 22 MB mesh in the browser cache is hard to notice and easy to blame.
const CACHEABLE = /$^/;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

async function robotRpc(method, body) {
  const url = `http://${ROBOT_HOST}:${ROBOT_PORT}/rpc/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(4000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, robot: `${ROBOT_HOST}:${ROBOT_PORT}`, lastProbe, lastResult }));
    return;
  }

  if (url.pathname === '/api/robot/getJointState' && req.method === 'POST') {
    const now = Date.now();
    if (JOINT_HZ <= 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ __proxyError: true, message: 'joint stream disabled (JOINT_HZ=0)' }));
      return;
    }
    if (now - jointAt < JOINT_MIN_MS || jointInFlight) {
      if (jointPayload && now - jointAt < JOINT_CACHE_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-A2-Cache': 'hit', 'X-A2-Age-Ms': String(now - jointAt) });
        res.end(JSON.stringify(jointPayload));
        return;
      }
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ __proxyError: true, message: 'joint poll budget' }));
      return;
    }
    jointInFlight = true;
    jointAt = now;
    try {
      const { status, json } = await robotRpc('aimdk.protocol.McDataService/GetJointState', {});
      if (status === 200) jointPayload = json;
      res.writeHead(status === 200 ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    } catch (err) {
      if (jointPayload && Date.now() - jointAt < JOINT_CACHE_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-A2-Cache': 'stale' });
        res.end(JSON.stringify(jointPayload));
      } else {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ __proxyError: true, message: String(err.message || err) }));
      }
    } finally {
      jointInFlight = false;
    }
    return;
  }

  if (url.pathname === '/api/robot/getAction' && req.method === 'POST') {
    const now = Date.now();

    // Coalesce rather than reject: several cockpit tabs must not starve each
    // other, and the vendor's 0.2 Hz budget applies to the robot, not to us.
    if (now - lastProbe < MIN_INTERVAL_MS) {
      if (cachedPayload && now - cachedAt < CACHE_TTL_MS) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'X-A2-Cache': 'hit',
          'X-A2-Age-Ms': String(now - cachedAt),
        });
        res.end(JSON.stringify(cachedPayload));
        return;
      }
      if (inFlight) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ __proxyError: true, message: 'probe in flight, no cached state yet' }));
        return;
      }
    }

    inFlight = true;
    lastProbe = now;
    try {
      const { status, json } = await robotRpc('aimdk.protocol.McActionService/GetAction', {});
      lastResult = { status, at: now, code: json?.header?.code };
      if (status === 200) { cachedPayload = json; cachedAt = Date.now(); }
      res.writeHead(status === 200 ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    } catch (err) {
      lastResult = { error: String(err.message || err), at: now };
      const age = Date.now() - cachedAt;
      if (cachedPayload && age < CACHE_TTL_MS) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-A2-Cache': 'stale' });
        res.end(JSON.stringify(cachedPayload));
      } else {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ __proxyError: true, message: String(err.message || err) }));
      }
    } finally {
      inFlight = false;
    }
    return;
  }

  // Explicit, auditable refusal for anything else under /rpc or /api.
  if (url.pathname.startsWith('/rpc/') || url.pathname.startsWith('/api/')) {
    const method = url.pathname.replace(/^\/rpc\//, '');
    const allowed = READ_ONLY_RPCS.has(method);
    res.writeHead(allowed ? 200 : 403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      __proxyError: true,
      message: allowed ? 'wrong verb: POST required' : `blocked by cockpit proxy: ${url.pathname} is not on the read-only allowlist`,
    }));
    return;
  }

  // Static files
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = normalize(join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': CACHEABLE.test(filePath) ? 'private, max-age=3600' : 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Steadwell cockpit  →  http://${HOST}:${PORT}/`);
  console.log(`  robot proxy        →  http://${ROBOT_HOST}:${ROBOT_PORT} (read-only: GetAction, GetJointState)`);
  console.log(`  joint telemetry    →  ${JOINT_HZ > 0 ? JOINT_HZ + ' Hz' : 'disabled'}`);
  console.log(`  add ?renderer=webgl to force the WebGL2 path\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
