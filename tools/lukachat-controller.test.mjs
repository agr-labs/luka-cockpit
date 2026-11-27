import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerEdges, controllerKey, defaultControllerProfile, headMappingReady, headVector, loadControllerProfile, normalizeControllerProfile, pickMovedAxis, saveControllerProfile } from './lukachat-controller.mjs';

const makePad = (overrides = {}) => ({ id: '8BitDo Ultimate 2C Wireless', mapping: 'standard', index: 0, connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ value: 0, pressed: false })), ...overrides });
const press = (pad, index, value) => { pad.buttons[index] = { value, pressed: value > 0.5 }; };
const storage = () => { const data = new Map(); return { getItem: (key) => data.get(key) || null, setItem: (key, value) => data.set(key, value) }; };

test('8BitDo uses a talk trigger and separate head hold; Kishi retains its talk button', () => {
  const pad = makePad(), profile = defaultControllerProfile(pad);
  assert.equal(profile.buttons.talk, 6);
  assert.equal(profile.buttons.headHold, 5);
  assert.equal(profile.headHoldRequired, true);
  assert.equal(defaultControllerProfile(makePad({ id: 'Kishi V3 Pro' })).buttons.talk, 0);
});

test('raw Bluetooth layouts never inherit unverified button or stick indices', () => {
  const pad = makePad({ mapping: '' }), profile = defaultControllerProfile(pad);
  assert.equal(profile.buttons.talk, null);
  assert.equal(headMappingReady(pad, profile), false);
  profile.axes.x = 2; profile.axes.y = 3;
  assert.equal(headMappingReady(pad, profile), false);
  profile.buttons.headHold = 5;
  assert.equal(headMappingReady(pad, profile), true);
});

test('a held trigger on connection or focus return cannot start a new recording', () => {
  const pad = makePad(), profile = defaultControllerProfile(pad), edges = new ControllerEdges();
  press(pad, 6, 1);
  assert.equal(Boolean(edges.sample(pad, profile).pressed.talk), false);
  assert.equal(edges.armed, false);
  press(pad, 6, 0); edges.sample(pad, profile);
  press(pad, 6, 1); assert.equal(edges.sample(pad, profile).pressed.talk, true);
  edges.sample(pad, profile, false);
  assert.equal(Boolean(edges.sample(pad, profile).pressed.talk), false);
  press(pad, 6, 0); edges.sample(pad, profile);
  press(pad, 6, 1); assert.equal(edges.sample(pad, profile).pressed.talk, true);
});

test('analog trigger jitter does not split a single hold into repeated messages', () => {
  const pad = makePad(), profile = defaultControllerProfile(pad), edges = new ControllerEdges();
  edges.sample(pad, profile);
  press(pad, 6, 0.8); assert.equal(edges.sample(pad, profile).pressed.talk, true);
  press(pad, 6, 0.5); const middle = edges.sample(pad, profile);
  assert.equal(middle.down.talk, true); assert.equal(middle.released.talk, false);
  press(pad, 6, 0.2); assert.equal(edges.sample(pad, profile).released.talk, true);
  press(pad, 6, 0.5); assert.equal(edges.sample(pad, profile).pressed.talk, false);
});

test('a talk trigger or stick deflection cannot substitute for the head hold button', () => {
  const pad = makePad(), profile = defaultControllerProfile(pad);
  pad.axes[2] = 1;
  assert.equal(headVector(pad, profile).held, false);
  press(pad, 6, 1); assert.equal(headVector(pad, profile).held, false);
  press(pad, 5, 1); assert.equal(headVector(pad, profile).held, true);
  press(pad, 5, 0); assert.equal(headVector(pad, profile).held, false);
});

test('saved profiles are isolated by device, connection mapping and input dimensions', () => {
  const pad = makePad(), saved = storage(), profile = defaultControllerProfile(pad);
  profile.buttons.talk = 7;
  saveControllerProfile(pad, profile, saved);
  assert.equal(loadControllerProfile(pad, saved).buttons.talk, 7);
  assert.equal(loadControllerProfile(makePad({ mapping: '' }), saved).buttons.talk, null);
  assert.notEqual(controllerKey(pad), controllerKey(makePad({ axes: [0, 0, 0, 0, 0, 0] })));
  saved.setItem(`lukachat.controller.${controllerKey(pad)}`, 'broken JSON');
  assert.equal(loadControllerProfile(pad, saved).buttons.talk, 6);
});

test('invalid saved indices, duplicate buttons and duplicate axes cannot drive two actions', () => {
  const pad = makePad(), profile = defaultControllerProfile(pad);
  profile.buttons.back = profile.buttons.talk;
  profile.buttons.menu = 99; profile.axes.y = profile.axes.x;
  const clean = normalizeControllerProfile(profile, pad);
  assert.equal(clean.buttons.back, null);
  assert.equal(clean.buttons.menu, null);
  assert.equal(headMappingReady(pad, clean), false);
});

test('stick calibration rejects trigger/hat axes and ambiguous diagonal movement', () => {
  const baseline = [0, 0, 0, 0, -1, 3.28];
  const pad = makePad({ axes: [0, 0, 0.9, 0.1, 1, -1] });
  assert.deepEqual(pickMovedAxis(pad, baseline), { index: 2, center: 0, sign: 1 });
  pad.axes[3] = 0.9;
  assert.equal(pickMovedAxis(pad, baseline), null);
  assert.deepEqual(pickMovedAxis(pad, baseline, [2]), { index: 3, center: 0, sign: 1 });
});

test('calibrated centers and directions preserve right/up and explicit inversion', () => {
  const pad = makePad({ axes: [-0.8, 0, 0, 0.9] }), profile = defaultControllerProfile(pad);
  profile.axes = { x: 0, y: 3, centerX: 0.05, centerY: 0.05, signX: -1, signY: -1, invertX: false, invertY: false };
  press(pad, 5, 1);
  const vector = headVector(pad, profile);
  assert.ok(vector.x > 0.8 && vector.y < -0.8 && vector.held);
  profile.axes.invertY = true;
  assert.ok(headVector(pad, profile).y > 0.8);
});
