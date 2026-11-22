import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { TwinModel } from '../src/model.js';
import {
  applySymmetricUpperBodyAxes,
  applyHandCurlsToPose,
  LukaMotionController,
  UPPER_BODY_JOINTS,
} from '../src/luka-motion.js';
import {
  agibotMaterialForLink,
  isLowerBodyLink,
  parseBinaryStlToYUp,
  buildPedestalMesh,
} from '../src/upper-renderer.js';
import {
  OneEuro,
  P,
  extractFingerCurls,
  retargetPoseToLuka,
  sampleDemoTrackedFrame,
  KameyokoVisionTracker,
} from '../src/kameyoko-tracker.js';
import {
  TrellisEngine,
  extractClaimsSync,
  cyrb128,
} from '../src/trellis-engine.js';
import {
  handleSimApi,
  parseEmbodiedDirective,
  localEmbodiedFallback,
} from '../src/sim-api.mjs';

const modelJson = JSON.parse(await readFile(new URL('../model/generated/luka.model.json', import.meta.url), 'utf8'));

test('symmetric upper-body kinematics produce mirrored left/right hand positions', () => {
  const m = new TwinModel(structuredClone(modelJson));
  applySymmetricUpperBodyAxes(m);
  const zero = m.zeroPose();

  m.forward({ ...zero, idx13_left_arm_joint1: 0.75, idx20_right_arm_joint1: 0.75 });
  const lAbd = m.position('left_hand');
  const rAbd = m.position('right_hand');
  assert.ok(Math.abs(lAbd[0] - rAbd[0]) < 1e-3, 'abduction X matches');
  assert.ok(Math.abs(lAbd[1] - rAbd[1]) < 1e-3, 'abduction Y matches');
  assert.ok(Math.abs(lAbd[2] + rAbd[2]) < 1e-3, 'abduction Z is mirrored');
  assert.ok(lAbd[2] < -0.5 && rAbd[2] > 0.5, 'arms lift outward on their respective sides');

  m.forward({ ...zero, idx14_left_arm_joint2: -0.9, idx21_right_arm_joint2: -0.9 });
  const lPit = m.position('left_hand');
  const rPit = m.position('right_hand');
  assert.ok(lPit[0] > 0.3 && rPit[0] > 0.3, 'negative pitch lifts both hands forward (+X)');
  assert.ok(Math.abs(lPit[0] - rPit[0]) < 1e-3 && Math.abs(lPit[1] - rPit[1]) < 1e-3);

  m.forward({ ...zero, idx16_left_arm_joint4: -1.2, idx23_right_arm_joint4: 1.2 });
  const lElb = m.position('left_hand');
  const rElb = m.position('right_hand');
  assert.ok(lElb[0] > 0.15 && rElb[0] > 0.15, 'both elbows flex forward');
  assert.ok(Math.abs(lElb[0] - rElb[0]) < 1e-3);
});

test('hand curls drive RH56 primary and mimic finger joints cleanly', () => {
  const m = new TwinModel(structuredClone(modelJson));
  const pose = m.zeroPose();
  applyHandCurlsToPose(m, pose, {
    left: { thumb: 0.1, index: 0.0, middle: 0.9, ring: 0.95, pinky: 1.0 },
    right: { thumb: 0.8, index: 0.85, middle: 0.85, ring: 0.9, pinky: 0.9 },
  });
  assert.ok(pose.lh_left_index_1_joint < 0.05, 'open left index stays near 0');
  assert.ok(pose.lh_left_little_1_joint > 1.2, 'closed left pinky curls near max');
  assert.ok(pose.lh_left_little_2_joint > 0.5, 'mimic distal joint follows proximal joint');
  assert.ok(pose.rh_right_index_1_joint > 1.0, 'closed right index curls');
});

test('LukaMotionController blends idle, speaking RMS, gestures, and taught pose snapshots', () => {
  const m = new TwinModel(structuredClone(modelJson));
  applySymmetricUpperBodyAxes(m);
  const ctrl = new LukaMotionController(m);

  ctrl.setMode('speaking');
  ctrl.setSpeechLevel(0.8);
  let out;
  for (let i = 0; i < 30; i++) out = ctrl.step(0.033);
  assert.equal(out.visorFx.stateMode, 3);
  assert.ok(out.pose.idx23_right_arm_joint4 > 0.5, 'speaking engages natural elbow posture');

  assert.equal(ctrl.playGesture('wave'), true);
  for (let i = 0; i < 35; i++) out = ctrl.step(0.033);
  assert.equal(out.activeGestureName, 'wave');
  assert.ok(out.pose.idx20_right_arm_joint1 > 0.35, 'wave raises right arm');

  const snap = ctrl.captureSnapshot();
  assert.equal(Object.keys(snap.joints).length, UPPER_BODY_JOINTS.length);
  assert.equal(ctrl.playCustomSkillPose('high_five', snap, 2.0), true);
  out = ctrl.step(0.05);
  assert.equal(out.activeGestureName, 'high_five');
});

test('AgiBot live skinning assigns black glossy head, white chest, and separates lower-body links', async () => {
  const head = agibotMaterialForLink('head_link02');
  assert.ok(head.color[0] < 0.06 && head.color[1] < 0.06 && head.color[2] < 0.06, 'head is glossy obsidian black');
  assert.equal(head.material[3], 1.0, 'head_link02 uses black OLED visor shader kind');
  assert.ok(head.material[2] > 0.9, 'head dome has high clearcoat');

  const torso = agibotMaterialForLink('base_link');
  assert.ok(torso.color[0] > 0.85 && torso.color[1] > 0.85 && torso.color[2] > 0.85, 'torso shell is ceramic AgiBot white');
  assert.equal(torso.material[3], 2.0, 'torso uses two-tone live AgiBot shader kind');

  const armShell = agibotMaterialForLink('right_arm_link03');
  const elbowAct = agibotMaterialForLink('right_arm_link04');
  assert.ok(armShell.color[0] > 0.85, 'upper arm shell is white');
  assert.ok(elbowAct.color[0] < 0.2, 'elbow actuator is dark metallic gunmetal');

  assert.equal(isLowerBodyLink('left_hip_pitch'), true);
  assert.equal(isLowerBodyLink('right_tarsus'), true);
  assert.equal(isLowerBodyLink('base_link'), false);
  assert.equal(isLowerBodyLink('head_link02'), false);
  assert.equal(isLowerBodyLink('left_arm_link05'), false);

  const logoBytes = await readFile(new URL('../model/meshes/logo.stl', import.meta.url));
  const parsedLogo = parseBinaryStlToYUp(logoBytes.buffer.slice(logoBytes.byteOffset, logoBytes.byteOffset + logoBytes.byteLength));
  assert.ok(parsedLogo.triCount > 1000, 'logo.stl parses cleanly');
  assert.ok(buildPedestalMesh().length > 0, 'studio pedestal generates vertices');
});

test('Kameyoko tracker OneEuro filter, finger curl solver, and 3D retargeting work cleanly', () => {
  const f = new OneEuro();
  const s1 = f.filter(0.5, 0.033);
  const s2 = f.filter(0.6, 0.033);
  assert.ok(Number.isFinite(s1) && s2 > 0.5 && s2 <= 0.6);

  // Sample all 4 synthetic phases (wave, open explain, hands together, celebrate)
  for (const t of [1.0, 5.5, 9.5, 13.5]) {
    const frame = sampleDemoTrackedFrame(t);
    const retargeted = retargetPoseToLuka(frame.pose, frame.hands, { mirrorSides: true });
    assert.ok(retargeted, `retargeted frame valid at t=${t}`);
    for (const jn of UPPER_BODY_JOINTS) {
      assert.ok(Number.isFinite(retargeted.joints[jn]), `${jn} finite at t=${t}`);
    }
    assert.equal(retargeted.handCount, 2);
  }

  // Open vs curled finger detection
  const openFrame = sampleDemoTrackedFrame(1.0); // right hand open waving
  const fistFrame = sampleDemoTrackedFrame(13.5); // fists raised
  const openCurls = extractFingerCurls(openFrame.hands[1].world);
  const fistCurls = extractFingerCurls(fistFrame.hands[1].world);
  assert.ok(openCurls.index < fistCurls.index, 'open hand has lower curl than closed fist');
});

test('head lateral yaw, up/down pitch, spring-damper neck, OLED gaze lead, and Kameyoko sign alignment', () => {
  const m = new TwinModel(structuredClone(modelJson));
  applySymmetricUpperBodyAxes(m);
  const yawLim = m.limits('idx27_head_joint1');
  const pitchLim = m.limits('idx28_head_joint2');
  assert.ok(yawLim.upper >= 1.25 && yawLim.lower <= -1.25, 'wide natural lateral yaw range');
  assert.ok(pitchLim.upper >= 0.58 && pitchLim.lower <= -0.55, 'wide natural up/down pitch range');

  // Verify FK signs: +yaw faces viewer right (-Z), +pitch looks up (+Y)
  const zero = m.zeroPose();
  m.forward({ ...zero, idx27_head_joint1: 0.6 });
  const mRight = m.matrices.get('head_link02');
  assert.ok(mRight[2] < -0.4, '+yaw turns visor forward vector toward viewer right (-Z)');

  m.forward({ ...zero, idx28_head_joint2: 0.45 });
  const mUp = m.matrices.get('head_link02');
  assert.ok(mUp[1] > 0.35, '+pitch tilts visor forward vector upward (+Y)');

  // Verify spring-damper convergence & OLED eye gaze lead via setHeadGazeOverride
  const ctrl = new LukaMotionController(m);
  ctrl.setHeadGazeOverride(0.95, 0.48);
  let early = null;
  let settled = null;
  for (let i = 0; i < 90; i++) {
    const out = ctrl.step(1 / 60);
    if (i === 4) early = out;
    settled = out;
  }
  assert.ok(early.visorFx.eyeX > 0.25 && early.visorFx.eyeY > 0.2, 'OLED eyes lead head turn early');
  assert.ok(Math.abs(settled.pose.idx27_head_joint1 - 0.95) < 0.04, 'spring-damper converges smoothly to lateral target');
  assert.ok(Math.abs(settled.pose.idx28_head_joint2 - 0.48) < 0.04, 'spring-damper converges smoothly to pitch target');

  // Verify shake_no and look_around head gestures produce full lateral + vertical travel
  ctrl.clearHeadGazeOverride();
  assert.equal(ctrl.playGesture('shake_no'), true);
  let minYaw = 0;
  let maxYaw = 0;
  for (let i = 0; i < 120; i++) {
    const out = ctrl.step(1 / 60);
    minYaw = Math.min(minYaw, out.pose.idx27_head_joint1);
    maxYaw = Math.max(maxYaw, out.pose.idx27_head_joint1);
  }
  assert.ok(maxYaw > 0.35 && minYaw < -0.35, 'shake_no sweeps cleanly left and right');

  assert.equal(ctrl.playGesture('look_around'), true);
  let scanMinY = 0;
  let scanMaxY = 0;
  let scanMinP = 0;
  let scanMaxP = 0;
  for (let i = 0; i < 240; i++) {
    const out = ctrl.step(1 / 60);
    scanMinY = Math.min(scanMinY, out.pose.idx27_head_joint1);
    scanMaxY = Math.max(scanMaxY, out.pose.idx27_head_joint1);
    scanMinP = Math.min(scanMinP, out.pose.idx28_head_joint2);
    scanMaxP = Math.max(scanMaxP, out.pose.idx28_head_joint2);
  }
  assert.ok(scanMaxY > 0.55 && scanMinY < -0.55, 'look_around performs wide lateral sweep');
  assert.ok(scanMaxP > 0.18 && scanMinP < -0.15, 'look_around performs clear up/down vertical sweep');

  // Verify Kameyoko head tracking horizontal & vertical signs match screen space
  const base = sampleDemoTrackedFrame(1.0);
  const makeHeadFrame = (dx, dy, imgDx = 0, imgDy = 0) => {
    const f = structuredClone(base);
    f.pose.world[0] = { x: dx, y: -0.66 - dy, z: -0.09 };
    f.pose.image[0] = { x: 0.5 + dx * 0.78 + imgDx, y: 0.30 - dy * 0.88 + imgDy, z: -0.09 };
    f.pose.image[7] = { x: 0.5 - 0.075 * 0.78 + imgDx, y: 0.30 + imgDy, z: 0.01 };
    f.pose.image[8] = { x: 0.5 + 0.075 * 0.78 + imgDx, y: 0.30 + imgDy, z: 0.01 };
    f.pose.image[2] = { x: 0.5 + (dx - 0.03) * 0.78 + imgDx, y: 0.27 - dy * 0.6 + imgDy, z: -0.07 };
    f.pose.image[5] = { x: 0.5 + (dx + 0.03) * 0.78 + imgDx, y: 0.27 - dy * 0.6 + imgDy, z: -0.07 };
    f.pose.image[9] = { x: 0.5 + (dx - 0.02) * 0.78 + imgDx, y: 0.33 - dy * 0.6 + imgDy, z: -0.07 };
    f.pose.image[10] = { x: 0.5 + (dx + 0.02) * 0.78 + imgDx, y: 0.33 - dy * 0.6 + imgDy, z: -0.07 };
    return retargetPoseToLuka(f.pose, f.hands, { mirrorSides: true });
  };

  const lookRight = makeHeadFrame(0.06, 0, 0.2, 0);
  const lookLeft = makeHeadFrame(-0.06, 0, -0.2, 0);
  const lookUp = makeHeadFrame(0, 0.045, 0, -0.15);
  const lookDown = makeHeadFrame(0, -0.045, 0, 0.15);

  assert.ok(lookRight.joints.idx27_head_joint1 > 0.5, 'turning right produces positive mirror yaw');
  assert.ok(lookLeft.joints.idx27_head_joint1 < -0.5, 'turning left produces negative mirror yaw');
  assert.ok(lookRight.headTarget.yaw > 0.3 && lookLeft.headTarget.yaw < -0.3, 'gaze follow tracks right/left without inversion');
  assert.ok(lookUp.joints.idx28_head_joint2 > 0.35, 'tilting up produces strong positive pitch');
  assert.ok(lookDown.joints.idx28_head_joint2 < -0.35, 'tilting down produces strong negative pitch');
  assert.ok(lookUp.headTarget.pitch > lookDown.headTarget.pitch + 0.3, 'gaze follow tracks vertical height cleanly');
});

test('calibrated 3D hand positioning, joint-angle finger curls, mimic clamps, and anti-jitter filtering', () => {
  const m = new TwinModel(structuredClone(modelJson));
  applySymmetricUpperBodyAxes(m);
  const zero = m.zeroPose();

  // 1. Mimic joints must never hyperextend below 0 on a straight open palm
  const openPose = { ...zero };
  applyHandCurlsToPose(m, openPose, {
    left: { thumbOpp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
    right: { thumbOpp: 0, thumb: 0, index: 0, middle: 0, ring: 0, pinky: 0 },
  });
  assert.ok(openPose.lh_left_index_2_joint >= 0, 'left index mimic joint clamped >= 0');
  assert.ok(openPose.rh_right_middle_2_joint >= 0, 'right middle mimic joint clamped >= 0');

  // 2. Calibrated 3D hand positioning across canonical poses (< 0.08 normalized error)
  m.forward(zero);
  const sh0 = m.position('left_arm_link02');
  const el0 = m.position('left_arm_link04');
  const wr0 = m.position('left_hand');
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const armLen = d3(sh0, el0) + d3(el0, wr0);

  const cases = [
    ['Hang', [0.23, -0.20, -0.02], [0.25, 0.06, -0.04]],
    ['T-pose', [0.47, -0.48, 0.0], [0.73, -0.48, 0.0]],
    ['Forward', [0.19, -0.46, -0.28], [0.19, -0.46, -0.54]],
    ['Present', [0.25, -0.24, -0.10], [0.21, -0.34, -0.34]],
    ['Wave', [0.40, -0.42, -0.10], [0.42, -0.68, -0.16]],
    ['Cross', [0.24, -0.32, -0.16], [0.04, -0.36, -0.36]],
  ];
  for (const [label, rEl, rWr] of cases) {
    const base = sampleDemoTrackedFrame(1.0);
    base.pose.world[P.R_SHOULDER] = { x: 0.19, y: -0.48, z: 0 };
    base.pose.world[P.R_ELBOW] = { x: rEl[0], y: rEl[1], z: rEl[2] };
    base.pose.world[P.R_WRIST] = { x: rWr[0], y: rWr[1], z: rWr[2] };
    const ret = retargetPoseToLuka(base.pose, [], { mirrorSides: true, calibration: { reachScale: 1.0 } });
    m.forward({ ...zero, ...ret.joints });
    const lHand = m.position('left_hand');
    const lSh = m.position('left_arm_link02');
    const hLen = Math.hypot(rEl[0] - 0.19, rEl[1] + 0.48, rEl[2]) + Math.hypot(rWr[0] - rEl[0], rWr[1] - rEl[1], rWr[2] - rEl[2]);
    const hRel = [-rWr[2] / hLen, -(rWr[1] + 0.48) / hLen, (rWr[0] - 0.19) / hLen];
    const lRel = [(lHand[0] - lSh[0]) / armLen, (lHand[1] - lSh[1]) / armLen, -(lHand[2] - lSh[2]) / armLen];
    const err = d3(hRel, lRel);
    assert.ok(err < 0.08, `${label} 3D hand position error (${err.toFixed(3)}) < 0.08`);
  }

  // 3. Scale-invariant 3D joint-angle finger curl solver + open-hand baseline calibration
  const openF = sampleDemoTrackedFrame(1.0).hands[1].world;
  const fistF = sampleDemoTrackedFrame(13.5).hands[1].world;
  const openC = extractFingerCurls(openF);
  const fistC = extractFingerCurls(fistF);
  for (const k of ['thumbOpp', 'thumb', 'index', 'middle', 'ring', 'pinky']) {
    assert.ok(openC[k] < 0.20, `open ${k} curl (${openC[k]}) is low`);
    assert.ok(fistC[k] > 0.70, `fist ${k} curl (${fistC[k]}) is high`);
  }
  const zeroed = extractFingerCurls(openF, openC);
  assert.equal(zeroed.index, 0, 'open-hand baseline calibration zeroes residual open curl');

  // 4. Anti-jitter filtering dramatically attenuates frame-to-frame hand noise
  const tracker = new KameyokoVisionTracker({ videoEl: null, overlayCanvas: null });
  tracker.setSmoothing(0.75);
  const baseRet = retargetPoseToLuka(sampleDemoTrackedFrame(1.0).pose, sampleDemoTrackedFrame(1.0).hands);
  const rawVals = [];
  const filtVals = [];
  for (let i = 0; i < 60; i++) {
    const jitter = (i % 2 === 0 ? 1 : -1) * 0.14;
    const noisy = structuredClone(baseRet);
    noisy.joints.idx17_left_arm_joint5 += jitter;
    noisy.hands.left.index = Math.max(0, Math.min(1, 0.35 + jitter));
    const filtered = tracker._filterRetargeted(noisy, 1 / 60);
    if (i >= 15) {
      rawVals.push(noisy.hands.left.index);
      filtVals.push(filtered.hands.left.index);
    }
  }
  const span = (arr) => Math.max(...arr) - Math.min(...arr);
  assert.ok(span(filtVals) < span(rawVals) * 0.35, `anti-jitter filter cuts finger jitter > 65% (raw=${span(rawVals).toFixed(3)}, filt=${span(filtVals).toFixed(3)})`);

  // 5. Hand shape presets drive independent fingers + thumb opposition
  const ctrl = new LukaMotionController(m);
  ctrl.setHandPreset('peace');
  let out = null;
  for (let i = 0; i < 45; i++) out = ctrl.step(1 / 60);
  assert.ok(out.hands.right.index < 0.1 && out.hands.right.middle < 0.1, 'peace keeps index & middle straight');
  assert.ok(out.hands.right.ring > 0.85 && out.hands.right.pinky > 0.85 && out.hands.right.thumbOpp > 0.65, 'peace curls ring, pinky & thumb');
});

test('Trellis unbounded context guarantees token budget at scale and discovers emergent skills', () => {
  const trellis = new TrellisEngine();

  // Claim extraction with span grounding & edge labels
  const claims = extractClaimsSync('Maya works at Steadwell and lives in Austin. I promised to send the A2-T3D1 calibration sheet.', trellis.entities);
  assert.ok(claims.some((c) => c.kind === 'person' && c.value === 'Maya'));
  assert.ok(claims.some((c) => c.kind === 'organization' && c.value === 'Steadwell'));
  assert.ok(claims.some((c) => c.kind === 'location' && c.value === 'Austin'));
  assert.ok(claims.some((c) => c.kind === 'project' && c.value === 'A2-T3D1'));
  assert.ok(claims.some((c) => c.kind === 'commitment'));

  trellis.ingestTurn('Maya works at Steadwell and lives in Austin.', 'Anchored Maya in Trellis.', { gesture: 'nod' });
  const maya = trellis.entities.find((e) => e.name === 'Maya');
  assert.ok(maya && maya.location === 'Austin');
  assert.equal(maya.edgeLabels.Steadwell, 'works at');

  // Unbounded growth stress test: add 140 extra entities & 200 WAL commits, verify strict budget fit
  for (let i = 0; i < 140; i++) {
    trellis.upsertEntity(`Contact_${i}`, 'person', {
      roleOrField: `Robotics Engineer #${i}`,
      location: `City_${i % 12}`,
      note: `Detailed engineering note about actuator telemetry and vision calibration #${i}`,
    });
  }
  for (let i = 0; i < 160; i++) {
    trellis.recordCommit({
      operation: 'EPISODE_COMMIT',
      targetNodes: [`Contact_${i % 140}`],
      message: `Session episode #${i} discussing arm trajectory tuning`,
    });
  }

  const pkg = trellis.compileContextPackage({
    currentPrompt: 'What do you remember about Maya in Austin?',
    recentMessages: [{ role: 'user', content: 'Tell me about Maya' }],
    tokenBudget: 1200,
  });
  assert.equal(pkg.isGuaranteedFit, true, 'TVP-1 viewport strictly fits token budget under unbounded growth');
  assert.ok(pkg.estimatedTokensUsed <= pkg.usableBudget);
  assert.ok(pkg.assembledContextText.includes('Maya'), 'relevant entity Maya retrieved from 140+ node graph');
  assert.ok(pkg.temperatureSummary.cold >= 160);
  assert.ok(pkg.fingerprint.startsWith('cyrb128:'));

  // Emergent composition discovery & approval
  trellis.recordCapabilitySequence('Remember Maya and wave', ['trellis_anchor_memory', 'wave_greeting']);
  assert.ok(trellis.candidates.length >= 1, 'multi-step sequence generates emergent candidate');
  const promoted = trellis.approveCandidate(trellis.candidates[0].id);
  assert.ok(promoted && promoted.source === 'emergent');

  // Teach-by-Pose emergent skill registration
  const taught = trellis.registerTaughtSkill({
    name: 'Robot Salute',
    description: 'Right hand salute to visor',
    triggerPhrases: ['salute', 'attention'],
    poseSnapshot: { joints: { idx20_right_arm_joint1: 0.7 }, hands: { left: {}, right: {} } },
  });
  assert.equal(taught.name, 'robot_salute');
  assert.equal(trellis.findMatchingSkill('Hey Luka give me a salute!')?.name, 'robot_salute');
  assert.equal(cyrb128('abc'), cyrb128('abc'));
});

test('sim-api directive parser and HTTP routes behave cleanly without touching physical robot paths', async () => {
  const parsed = parseEmbodiedDirective('[GESTURE:wave] Hey there, great to see you!');
  assert.equal(parsed.gesture, 'wave');
  assert.equal(parsed.reply, 'Hey there, great to see you!');

  const skillParsed = parseEmbodiedDirective('[SKILL:robot_salute] Standing at attention!');
  assert.equal(skillParsed.invokedSkill, 'robot_salute');
  assert.equal(skillParsed.reply, 'Standing at attention!');

  const fb = localEmbodiedFallback('Hey Luka, wave hello!');
  assert.equal(fb.gesture, 'wave');

  // Spin up ephemeral HTTP server around handleSimApi
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const handled = await handleSimApi(req, res, url);
    if (!handled) { res.writeHead(404).end('not handled'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    const hRes = await fetch(`http://127.0.0.1:${port}/sim-api/health`);
    assert.equal(hRes.status, 200);
    const hJson = await hRes.json();
    assert.equal(hJson.ok, true);
    assert.ok('asr' in hJson && 'tts' in hJson && 'llms' in hJson);

    const mpRes = await fetch(`http://127.0.0.1:${port}/mediapipe/vision_bundle.mjs`);
    assert.equal(mpRes.status, 200);
    assert.ok((mpRes.headers.get('content-type') || '').includes('javascript'));

    const unRes = await fetch(`http://127.0.0.1:${port}/api/robot/setAction`, { method: 'POST' });
    assert.equal(unRes.status, 404, 'handleSimApi never intercepts physical robot routes');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
