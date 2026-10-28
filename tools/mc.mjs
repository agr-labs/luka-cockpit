#!/usr/bin/env node
// Rate-limited AimDK RPC client.
//
// The vendor's guidance is <= 0.2 Hz for continuous polling. Earlier ad-hoc
// diagnostics in this project hit 10 Hz, which is ~50x that. Rather than rely on
// memory, every call through this tool is gated to one per 5 s (0.2 Hz) by a
// stamp file, including read-only GetAction.
//
//   node tools/mc.mjs action
//   node tools/mc.mjs set-action RL_LOCOMOTION_ARM_EXT_JOINT_SERVO --confirm
//
// Writes additionally require --confirm and are printed before they are sent.

import { readFile, writeFile } from 'node:fs/promises';

const STAMP = '/tmp/.luka-mc-last-call';
const MIN_INTERVAL_MS = 5000; // 0.2 Hz
const HOST = process.env.LUKA_HOST || '192.168.4.136';
const BASE = `http://${HOST}:56322/rpc/aimdk.protocol.McActionService/`;

async function gate() {
  let last = 0;
  try { last = Number(await readFile(STAMP, 'utf8')) || 0; } catch { /* first call */ }
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) {
    console.error(`refused: 0.2 Hz budget — wait ${(wait / 1000).toFixed(1)}s (${STAMP})`);
    process.exit(2);
  }
  await writeFile(STAMP, String(Date.now()));
}

async function call(method, body = {}) {
  await gate();
  const res = await fetch(BASE + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const json = await res.json();
  return { status: res.status, json };
}

const [, , cmd, target] = process.argv;

if (cmd === 'action') {
  const { json } = await call('GetAction');
  console.log(JSON.stringify(json.info ?? json, null, 1));
} else if (cmd === 'set-action') {
  if (!target) { console.error('usage: node tools/mc.mjs set-action <ACTION> --confirm'); process.exit(1); }
  if (!process.argv.includes('--confirm')) {
    console.error('refusing without --confirm (this changes the motion action)');
    process.exit(1);
  }
  const now = Date.now();
  const body = {
    header: {
      timestamp: {
        seconds: Math.floor(now / 1000),
        nanos: (now % 1000) * 1e6,
        ms_since_epoch: now,
      },
      control_source: 'ControlSource_SAFE',
    },
    command: { action: 'McAction_USE_EXT_CMD', ext_action: target },
  };
  const { status, json } = await call('SetAction', body);
  console.log('sent:', JSON.stringify(body));
  console.log('http', status, JSON.stringify(json));
} else {
  console.error('usage: node tools/mc.mjs action | set-action <ACTION> --confirm');
  process.exit(1);
}
