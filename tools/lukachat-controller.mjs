export const CONTROLLER_ACTIONS = [
  ['talk', 'Hold to talk'], ['headHold', 'Hold to steer head'], ['menu', 'Open menu'],
  ['back', 'Back / cancel'], ['replay', 'Speak again'], ['previous', 'Previous page'], ['next', 'Next page'],
];
const BUTTON_NAMES = ['A / south', 'B / east', 'X / west', 'Y / north', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'Left stick click', 'Right stick click', 'D-pad up', 'D-pad down', 'D-pad left', 'D-pad right', 'Home'];
const validIndex = (value, count) => Number.isInteger(value) && value >= 0 && value < count;
const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const is8BitDo = (pad) => /8bitdo|2dc8/i.test(pad?.id || '');
export const controllerKey = (pad) => JSON.stringify([pad.id, pad.mapping, pad.buttons.length, pad.axes.length]);

export function defaultControllerProfile(pad) {
  const standard = pad.mapping === 'standard', eightBitDo = is8BitDo(pad);
  return {
    version: 1,
    buttons: {
      talk: standard ? (eightBitDo ? 6 : 0) : null,
      headHold: standard && eightBitDo ? 5 : null,
      menu: standard ? 9 : null, back: standard ? 1 : null, replay: standard ? 3 : null,
      previous: standard ? 14 : null, next: standard ? 15 : null,
    },
    axes: { x: standard && pad.axes.length >= 4 ? 2 : null, y: standard && pad.axes.length >= 4 ? 3 : null, centerX: 0, centerY: 0, signX: 1, signY: 1, invertX: false, invertY: false },
    headHoldRequired: eightBitDo,
    deadzone: 0.32,
  };
}

export function normalizeControllerProfile(value, pad) {
  const profile = defaultControllerProfile(pad);
  if (!value || value.version !== 1) return profile;
  const used = new Set();
  for (const [action] of CONTROLLER_ACTIONS) {
    const candidate = value.buttons?.[action];
    profile.buttons[action] = validIndex(candidate, pad.buttons.length) && !used.has(candidate) ? candidate : null;
    if (profile.buttons[action] !== null) used.add(candidate);
  }
  const axes = value.axes || {};
  profile.axes.x = validIndex(axes.x, pad.axes.length) ? axes.x : null;
  profile.axes.y = validIndex(axes.y, pad.axes.length) && axes.y !== profile.axes.x ? axes.y : null;
  for (const name of ['X', 'Y']) {
    profile.axes[`center${name}`] = clamp(finite(axes[`center${name}`]), -0.25, 0.25);
    profile.axes[`sign${name}`] = axes[`sign${name}`] === -1 ? -1 : 1;
    profile.axes[`invert${name}`] = axes[`invert${name}`] === true;
  }
  profile.headHoldRequired = typeof value.headHoldRequired === 'boolean' ? value.headHoldRequired : profile.headHoldRequired;
  profile.deadzone = clamp(finite(value.deadzone, 0.32), 0.18, 0.6);
  return profile;
}

export function loadControllerProfile(pad, storage) {
  try { return normalizeControllerProfile(JSON.parse(storage.getItem(`lukachat.controller.${controllerKey(pad)}`)), pad); }
  catch { return defaultControllerProfile(pad); }
}

export function saveControllerProfile(pad, profile, storage) {
  const clean = normalizeControllerProfile(profile, pad);
  storage.setItem(`lukachat.controller.${controllerKey(pad)}`, JSON.stringify(clean));
  return clean;
}

export function buttonLabel(pad, index) {
  if (!validIndex(index, pad?.buttons.length || 0)) return 'Unassigned';
  return pad.mapping === 'standard' ? BUTTON_NAMES[index] || `Button ${index}` : `Button ${index}`;
}

export function buttonDown(pad, index, wasDown = false) {
  if (!validIndex(index, pad?.buttons.length || 0)) return false;
  const button = pad.buttons[index];
  const value = Number.isFinite(button?.value) ? button.value : button?.pressed ? 1 : 0;
  return value >= (wasDown ? 0.35 : 0.65);
}

export function headMappingReady(pad, profile) {
  return Boolean(profile && validIndex(profile.axes.x, pad.axes.length) && validIndex(profile.axes.y, pad.axes.length)
    && profile.axes.x !== profile.axes.y
    && (!profile.headHoldRequired || validIndex(profile.buttons.headHold, pad.buttons.length)));
}

export function headVector(pad, profile) {
  if (!headMappingReady(pad, profile)) return { x: 0, y: 0, held: false };
  const { axes } = profile;
  return {
    x: clamp((finite(pad.axes[axes.x]) - axes.centerX) * axes.signX * (axes.invertX ? -1 : 1), -1, 1),
    y: clamp((finite(pad.axes[axes.y]) - axes.centerY) * axes.signY * (axes.invertY ? -1 : 1), -1, 1),
    held: !profile.headHoldRequired || buttonDown(pad, profile.buttons.headHold),
  };
}

// Every new connection, focus change, or setup change requires released buttons
// before an edge can trigger speech or a shortcut. Analog triggers use hysteresis.
export class ControllerEdges {
  constructor() { this.reset(); }
  reset() { this.armed = false; this.previous = {}; }
  sample(pad, profile, active = true) {
    const down = Object.fromEntries(CONTROLLER_ACTIONS.map(([action]) => [action, buttonDown(pad, profile.buttons[action], this.previous[action])]));
    const result = { down, pressed: {}, released: {}, armed: this.armed };
    if (!active) { this.reset(); return { ...result, armed: false }; }
    if (!this.armed) {
      this.armed = Object.values(down).every((value) => !value);
      this.previous = down;
      return { ...result, armed: this.armed };
    }
    for (const [action] of CONTROLLER_ACTIONS) {
      result.pressed[action] = down[action] && !this.previous[action];
      result.released[action] = !down[action] && Boolean(this.previous[action]);
    }
    this.previous = down;
    return result;
  }
}

// A stick must start near its center. Trigger and hat-switch axes are excluded.
export function pickMovedAxis(pad, baseline, excluded = []) {
  const candidates = pad.axes.map((value, index) => ({ index, value, center: baseline[index], delta: value - baseline[index] }))
    .filter((axis) => !excluded.includes(axis.index) && Number.isFinite(axis.value) && Number.isFinite(axis.center)
      && Math.abs(axis.center) <= 0.25 && Math.abs(axis.value) <= 1.1 && Math.abs(axis.delta) >= 0.55)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  if (!candidates.length || (candidates[1] && Math.abs(candidates[0].delta) < Math.abs(candidates[1].delta) * 1.5)) return null;
  const axis = candidates[0];
  return { index: axis.index, center: axis.center, sign: Math.sign(axis.delta) };
}
