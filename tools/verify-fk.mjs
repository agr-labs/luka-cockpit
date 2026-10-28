#!/usr/bin/env node
// Compares the cockpit's forward kinematics against MuJoCo's reference
// evaluation of the same model, at zero pose and at a perturbed pose.
//
//   /tmp/mjvenv/bin/python tools/mj_reference.py     (writes /tmp/mj_pose_*.json)
//   node tools/verify-fk.mjs

import { readFile } from 'node:fs/promises';
import { TwinModel } from '../src/model.js';

const json = JSON.parse(await readFile(new URL('../model/generated/luka.model.json', import.meta.url), 'utf8'));
const twin = new TwinModel(json);

// MuJoCo is Z-up; the cockpit is Y-up via (x, y, z) -> (x, z, -y).
const toYUp = (p) => [p[0], p[2], -p[1]];

async function compare(label, poseFile) {
  const ref = JSON.parse(await readFile(poseFile, 'utf8'));
  const pose = {};
  for (const [name, q] of Object.entries(ref.joints)) pose[name] = q;
  twin.forward(twin.clampPose(pose), { x: 0, y: 0, z: 0, yaw: 0 });

  let maxErr = 0, worst = null, compared = 0;
  for (const [body, xpos] of Object.entries(ref.bodies)) {
    const ours = twin.position(body);
    if (!ours) continue;
    const want = toYUp(xpos);
    const err = Math.hypot(ours[0] - want[0], ours[1] - want[1], ours[2] - want[2]);
    compared++;
    if (err > maxErr) { maxErr = err; worst = { body, ours, want }; }
  }
  console.log(`${label}: compared ${compared} bodies, max positional error ${maxErr.toExponential(2)} m`);
  if (worst) {
    console.log(`  worst ${worst.body}: ours [${worst.ours.map((v) => v.toFixed(5))}] vs mujoco [${worst.want.map((v) => v.toFixed(5))}]`);
  }
  return maxErr;
}

const a = await compare('zero pose   ', '/tmp/mj_pose_zero.json');
const b = await compare('perturbed   ', '/tmp/mj_pose_perturbed.json');

const LIMIT = 1e-6;
if (a > LIMIT || b > LIMIT) {
  console.error(`\nFAIL: FK deviates from MuJoCo by more than ${LIMIT} m`);
  process.exit(1);
}
console.log('\nPASS: cockpit FK matches MuJoCo for every shared body');
