if (!document.getElementById('head-controls')) {
  const response = await fetch('/head-panel.html', { cache: 'no-store' });
  if (!response.ok) throw new Error('Head controls could not load');
  document.getElementById('headMount').innerHTML = await response.text();
  if (location.hash === '#head-controls') document.getElementById('head-controls').scrollIntoView();
}
const $ = (id) => document.getElementById(id);
const jogButtons = [...document.querySelectorAll('[data-head-jog]')];
const holder = `dashboard-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`;
let leaseId = null, snapshot = null, receivedAt = 0, busy = false, polling = false, renewing = false, generation = 0, failed = false;

const degrees = (value) => Number.isFinite(value) ? `${(value * 180 / Math.PI).toFixed(1)}°` : '—';
const age = () => snapshot ? Math.max(0, (snapshot.serverNow - snapshot.sampledAt) + performance.now() - receivedAt) : Infinity;
const fresh = () => snapshot?.connected && !failed && age() < 4000;
const mine = () => leaseId && snapshot?.sessionActive && snapshot?.lease?.holder === holder;

function render() {
  $('headYaw').textContent = degrees(snapshot?.measured?.yaw);
  $('headPitch').textContent = degrees(snapshot?.measured?.pitch);
  $('headTargetYaw').textContent = degrees(snapshot?.target?.yaw);
  $('headTargetPitch').textContent = degrees(snapshot?.target?.pitch);
  const connected = fresh();
  const owned = mine();
  $('headOwner').textContent = !connected ? 'feedback unavailable' : owned ? 'dashboard control' : snapshot.sessionActive ? 'controls in use' : snapshot.factoryNeckEnabled ? 'factory control' : 'head available';
  $('headOwner').dataset.state = !connected ? 'down' : owned ? 'active' : '';
  $('headEnable').disabled = !connected || busy || Boolean(leaseId || snapshot?.sessionActive || snapshot?.lease);
  $('headRelease').disabled = !leaseId;
  for (const button of [...jogButtons, $('headHome')]) button.disabled = !connected || !owned || busy || snapshot?.busy;
  $('headFreshness').textContent = Number.isFinite(age()) ? `Measured feedback · ${(age() / 1000).toFixed(1)} s ago` : 'waiting for angles';
}

function apply(state) {
  snapshot = state;
  receivedAt = performance.now();
  failed = false;
  render();
}

function message(text, error = '') {
  $('headMessage').textContent = text;
  $('headError').hidden = !error;
  $('headError').textContent = error;
}

async function api(path, body) {
  const response = await fetch(`/head/${path}`, {
    method: body ? 'POST' : 'GET', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.error?.message || 'Head connection failed');
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

function beaconRelease(token) {
  if (!token) return;
  const body = JSON.stringify({ leaseId: token });
  const sent = navigator.sendBeacon?.('/head/release', new Blob([body], { type: 'application/json' }));
  if (!sent) fetch('/head/release', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

function dropControls(reason, error = '') {
  const token = leaseId;
  leaseId = null; generation++;
  beaconRelease(token);
  message(reason, error);
  render();
}

async function poll() {
  if (polling || document.hidden) return;
  polling = true;
  try {
    const data = await api('state');
    const recovered = failed;
    apply(data.state);
    if (leaseId && !data.state.sessionActive) dropControls('Head session ended. Enable controls again to continue.');
    else if (!leaseId && !busy && (recovered || $('headError').hidden)) message(data.state.sessionActive ? 'Another dashboard is controlling the head.' : 'Enable controls to capture a starting pose and make small head movements.');
  } catch (error) {
    failed = true;
    if (leaseId) dropControls('Head feedback lost; releasing controls.', error.message);
    else message('Head feedback is unavailable.', error.message);
    render();
  } finally { polling = false; }
}

async function enableControls() {
  if (mine()) return true;
  if (busy || !fresh() || leaseId || snapshot?.sessionActive || snapshot?.lease) return false;
  busy = true;
  const version = ++generation;
  message('Taking neck control and capturing the starting pose…'); render();
  try {
    const data = await api('acquire', { holder });
    if (version !== generation || document.hidden) { beaconRelease(data.leaseId); return false; }
    leaseId = data.leaseId;
    apply(data.state);
    message('Head controls enabled. Tap an arrow for a 2° move.');
    return true;
  } catch (error) { if (version === generation) message('Head controls could not be enabled.', error.message); return false; }
  finally { busy = false; render(); }
}
$('headEnable').addEventListener('click', enableControls);

async function move(direction, home = false) {
  if (busy || !mine() || !fresh()) return;
  busy = true;
  const token = leaseId, version = generation;
  const commandId = `${holder}-${performance.now()}-${Math.random().toString(36).slice(2)}`;
  const deadlineMs = Math.round(snapshot.serverNow + performance.now() - receivedAt + 2500);
  message(home ? 'Returning to the captured starting pose…' : `Looking ${direction}…`); render();
  try {
    const data = await api(home ? 'home' : 'jog', { leaseId: token, commandId, deadlineMs, ...(home ? {} : { direction }) });
    if (version === generation) { apply(data.state); message(data.state.note || 'Head target reached.'); }
  } catch (error) {
    if (version !== generation) return;
    if (['test_limit', 'head_limit', 'invalid_payload', 'command_expired', 'head_busy', 'stale_target'].includes(error.code)) message('That jog was not sent. Choose another direction or return to start.', error.message);
    else dropControls('Head test stopped; releasing controls.', error.message);
  } finally { busy = false; render(); }
}

for (const button of jogButtons) button.addEventListener('click', () => move(button.dataset.headJog));
$('headHome').addEventListener('click', () => move(null, true));
for (const button of [...jogButtons, $('headHome')]) button.addEventListener('keydown', (event) => { if (event.repeat) event.preventDefault(); });

async function releaseControls() {
  const token = leaseId;
  if (!token) return true;
  leaseId = null; generation++;
  message('Releasing neck control…'); render();
  try { const data = await api('release', { leaseId: token }); apply(data.state); message('Head controls released.'); return true; }
  catch (error) { beaconRelease(token); message('Waiting for the ownership timeout on Luka.', error.message); return false; }
  finally { render(); }
}
$('headRelease').addEventListener('click', releaseControls);

window.lukaHeadControls = Object.freeze({
  acquire: enableControls,
  release: releaseControls,
  jog: (direction) => move(direction),
  refresh: poll,
  ready: () => mine() && fresh(),
  canAcquire: () => fresh() && !busy && (mine() || (!snapshot?.sessionActive && !snapshot?.lease)),
  busy: () => busy,
});

setInterval(async () => {
  if (!leaseId || renewing || document.hidden) return;
  renewing = true;
  const token = leaseId, version = generation;
  try { await api('heartbeat', { leaseId: token }); }
  catch (error) { if (version === generation) dropControls('Head connection lost; releasing controls.', error.message); }
  finally { renewing = false; }
}, 2000);

document.addEventListener('visibilitychange', () => {
  if (document.hidden) dropControls('Controls released while the dashboard is hidden.');
  else poll();
});
window.addEventListener('pagehide', () => dropControls('Dashboard closed.'));
document.addEventListener('freeze', () => dropControls('Dashboard paused.'));
setInterval(poll, 1000);
setInterval(render, 250);
poll();
