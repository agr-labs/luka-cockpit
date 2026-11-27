import { CONTROLLER_ACTIONS, buttonDown, buttonLabel, defaultControllerProfile, headMappingReady, headVector, is8BitDo, loadControllerProfile, normalizeControllerProfile, pickMovedAxis, saveControllerProfile } from './lukachat-controller.mjs';

const $ = (id) => document.getElementById(id);
export class ControllerSetup {
  constructor({ onChange, onSetup }) {
    this.onChange = onChange; this.onSetup = onSetup;
    this.pad = null; this.profile = null; this.learning = null; this.lastPaintAt = 0;
    try { this.storage = window.localStorage; } catch { this.storage = null; }
    $('controllerAction').replaceChildren(...CONTROLLER_ACTIONS.map(([key, label]) => new Option(label, key)));
    $('controllerButtonsTab').onclick = () => this.tab(false);
    $('controllerStickTab').onclick = () => this.tab(true);
    $('controllerLearnButton').onclick = () => this.learning ? this.cancelLearning() : this.start('button');
    $('controllerCalibrate').onclick = () => this.learning ? this.cancelLearning() : this.start('stick');
    $('controllerAction').onchange = () => this.cancelLearning();
    $('controllerClearButton').onclick = () => { if (this.profile) { this.profile.buttons[$('controllerAction').value] = null; this.persist('Control cleared.'); } };
    $('controllerReset').onclick = () => { if (this.pad) { this.profile = defaultControllerProfile(this.pad); this.persist('Default profile restored.'); } };
    $('controllerHoldRequired').onchange = () => { if (this.profile) { this.profile.headHoldRequired = $('controllerHoldRequired').checked; this.persist('Head hold setting saved.'); } };
    $('controllerInvertX').onchange = () => { if (this.profile) { this.profile.axes.invertX = $('controllerInvertX').checked; this.persist('Pan direction saved.'); } };
    $('controllerInvertY').onchange = () => { if (this.profile) { this.profile.axes.invertY = $('controllerInvertY').checked; this.persist('Tilt direction saved.'); } };
    $('controllerDeadzone').oninput = () => { $('controllerDeadzoneValue').textContent = `${Math.round(Number($('controllerDeadzone').value) * 100)}%`; };
    $('controllerDeadzone').onchange = () => { if (this.profile) { this.profile.deadzone = Number($('controllerDeadzone').value); this.persist('Stick dead zone saved.'); } };
    this.render();
  }

  attach(pad) {
    this.pad = pad; this.profile = loadControllerProfile(pad, this.storage); this.learning = null;
    this.render();
    this.status(pad.mapping === 'standard' ? 'Profile loaded. Check the controls here before enabling head movement.' : 'Custom Bluetooth layout: assign Talk and Head hold, then calibrate the right stick.');
  }
  detach() { this.pad = null; this.profile = null; this.learning = null; this.render(); }
  status(text) { $('controllerSetupStatus').textContent = text; }
  tab(stick) {
    this.cancelLearning();
    $('controllerButtonsView').hidden = stick; $('controllerStickView').hidden = !stick;
    $('controllerButtonsTab').setAttribute('aria-pressed', !stick);
    $('controllerStickTab').setAttribute('aria-pressed', stick);
  }
  cancelLearning() { this.learning = null; this.render(); this.status('Controller commands pause while this panel is open.'); }
  persist(message) {
    if (!this.pad || !this.profile) return;
    this.profile = normalizeControllerProfile(this.profile, this.pad);
    try { this.profile = saveControllerProfile(this.pad, this.profile, this.storage); }
    catch { message += ' Browser storage is unavailable; this change lasts for this page only.'; }
    this.learning = null; this.render(); this.status(message); this.onChange();
  }
  render() {
    const pad = this.pad, profile = this.profile, learning = Boolean(this.learning);
    $('controllerTitle').textContent = pad && is8BitDo(pad) ? '8BitDo controls' : 'Controller setup';
    $('controllerIdentity').textContent = pad ? `${pad.id} · ${pad.mapping === 'standard' ? 'standard layout' : 'custom layout'} · ${pad.buttons.length} buttons / ${pad.axes.length} axes` : 'Click the page and press a controller button to connect it.';
    const rows = [];
    for (const [action, label] of CONTROLLER_ACTIONS) {
      const dt = document.createElement('dt'), dd = document.createElement('dd');
      dt.textContent = label; dd.textContent = pad ? buttonLabel(pad, profile.buttons[action]) : '—'; rows.push(dt, dd);
    }
    $('controllerBindings').replaceChildren(...rows);
    for (const id of ['controllerAction', 'controllerClearButton', 'controllerReset', 'controllerHoldRequired', 'controllerInvertX', 'controllerInvertY', 'controllerDeadzone']) $(id).disabled = !pad || learning;
    $('controllerLearnButton').disabled = !pad || (learning && this.learning.kind !== 'button');
    $('controllerCalibrate').disabled = !pad || (learning && this.learning.kind !== 'stick');
    $('controllerLearnButton').textContent = this.learning?.kind === 'button' ? 'Cancel assignment' : 'Assign button';
    $('controllerCalibrate').textContent = this.learning?.kind === 'stick' ? 'Cancel calibration' : 'Calibrate right stick';
    if (profile) {
      $('controllerHoldRequired').checked = profile.headHoldRequired;
      $('controllerInvertX').checked = profile.axes.invertX; $('controllerInvertY').checked = profile.axes.invertY;
      $('controllerDeadzone').value = profile.deadzone;
      $('controllerDeadzoneValue').textContent = `${Math.round(profile.deadzone * 100)}%`;
    }
  }
  start(kind) {
    if (!this.pad) return;
    this.onSetup();
    this.learning = { kind, action: $('controllerAction').value, stage: 'neutral', startedAt: performance.now(), neutralAt: null, lastAxes: [...this.pad.axes], candidate: null, candidateFrames: 0 };
    this.render();
    this.status(kind === 'button' ? 'Release all buttons, then press the button you want to assign.' : 'Center both sticks and release every button. Controller movement is paused during calibration.');
  }
  update(pad, now) {
    this.pad = pad;
    const consumed = Boolean(this.learning);
    if (this.learning && (!document.hasFocus() || document.hidden)) this.cancelLearning();
    if (this.learning) this.learn(pad, now);
    if (!$('controllerPanel').hidden && now - this.lastPaintAt > 100) {
      this.lastPaintAt = now;
      const buttons = pad.buttons.map((_, index) => buttonDown(pad, index) ? index : null).filter((index) => index !== null);
      $('controllerLive').textContent = `Pressed: ${buttons.length ? buttons.map((index) => buttonLabel(pad, index)).join(', ') : 'none'} · Axes: ${pad.axes.map((value, index) => `${index}:${Number(value).toFixed(2)}`).join(' ')}`;
      const vector = headVector(pad, this.profile);
      $('controllerAxes').textContent = headMappingReady(pad, this.profile) ? `Pan ${vector.x.toFixed(2)} · Tilt ${vector.y.toFixed(2)} · axes ${this.profile.axes.x}/${this.profile.axes.y}` : 'Assign a head hold button if required, then calibrate the right stick.';
    }
    return consumed;
  }
  learn(pad, now) {
    const learning = this.learning;
    if (now - learning.startedAt > 60_000) { this.cancelLearning(); this.status('Setup timed out. Start again when ready.'); return; }
    const released = pad.buttons.every((_, index) => !buttonDown(pad, index, true));
    if (learning.stage === 'neutral') {
      const steady = pad.axes.every((value, index) => Math.abs(value - learning.lastAxes[index]) < 0.04);
      learning.lastAxes = [...pad.axes];
      if (released && (learning.kind === 'button' || steady)) learning.neutralAt ??= now;
      else learning.neutralAt = null;
      if (learning.neutralAt !== null && now - learning.neutralAt > 300) {
        learning.baseline = [...pad.axes]; learning.stage = learning.kind === 'button' ? 'press' : 'right';
        this.status(learning.kind === 'button' ? 'Press one button to assign it.' : 'Push the right stick to the RIGHT and hold briefly.');
      }
      return;
    }
    if (learning.kind === 'button') {
      const pressed = pad.buttons.map((_, index) => buttonDown(pad, index) ? index : null).filter((index) => index !== null);
      if (pressed.length !== 1) return;
      const index = pressed[0], conflict = CONTROLLER_ACTIONS.find(([action]) => action !== learning.action && this.profile.buttons[action] === index);
      if (conflict) {
        learning.stage = 'neutral'; learning.neutralAt = null;
        this.status(`${buttonLabel(pad, index)} already controls ${conflict[1]}. Clear that assignment first or choose another button.`);
        return;
      }
      this.profile.buttons[learning.action] = index;
      this.persist(`${CONTROLLER_ACTIONS.find(([key]) => key === learning.action)[1]} assigned to ${buttonLabel(pad, index)}.`);
      return;
    }
    if (!released) return;
    if (learning.stage === 'right' || learning.stage === 'up') {
      const axis = pickMovedAxis(pad, learning.baseline, learning.stage === 'up' ? [learning.x.index] : []);
      if (!axis) { learning.candidate = null; learning.candidateFrames = 0; return; }
      if (learning.candidate?.index === axis.index && learning.candidate.sign === axis.sign) learning.candidateFrames++;
      else { learning.candidate = axis; learning.candidateFrames = 1; }
      if (learning.candidateFrames < 3) return;
      if (learning.stage === 'right') { learning.x = axis; learning.stage = 'returnRight'; this.status('Right detected. Let the stick return to center.'); }
      else { learning.y = axis; learning.stage = 'returnUp'; this.status('Up detected. Let the stick return to center to save.'); }
      learning.neutralAt = null; learning.candidate = null; learning.candidateFrames = 0;
      return;
    }
    const centered = [learning.x, learning.y].filter(Boolean).every((axis) => Math.abs(pad.axes[axis.index] - axis.center) < 0.15);
    if (centered) learning.neutralAt ??= now; else learning.neutralAt = null;
    if (learning.neutralAt === null || now - learning.neutralAt < 200) return;
    if (learning.stage === 'returnRight') { learning.stage = 'up'; this.status('Now push the right stick UP and hold briefly.'); return; }
    this.profile.axes = { x: learning.x.index, y: learning.y.index, centerX: learning.x.center, centerY: learning.y.center, signX: learning.x.sign, signY: -learning.y.sign, invertX: false, invertY: false };
    this.persist('Right stick saved. Close setup, then enable head movement from the menu when ready.');
  }
}
