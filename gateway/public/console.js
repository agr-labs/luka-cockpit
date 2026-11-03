// Operator console for the Steadwell Robot Gateway.
//
// One rule shapes this file: the console knows nothing about robots. It reads
// the capability contract and renders whatever is there. A new capability, or a
// robot with fewer joints, needs no change here — only the adapter.

const $ = (id) => document.getElementById(id);

// iPads report a fine pointer when a trackpad is attached; touch capability is
// the reliable signal for size, not the pointer media query alone.
if (navigator.maxTouchPoints > 0) document.documentElement.classList.add('touch');

const app = {
  token: sessionStorage.getItem('gateway_token') || '',
  robots: [],
  robotId: null,
  detail: null,
  capabilities: [],
  state: null,
  joints: null,
  lease: null,
  auditSeq: 0,
  ws: null,
  wsRobot: null,
  wsStatus: 'idle',
  retry: null,
  jointSig: '',
  jointRows: new Map(),
  pollTimer: null,
  auditTimer: null,
  countdown: null,
  lastStop: null,
};

// Tablet/shortcut access: accept ?token=…, keep it for this tab, and drop it
// from the address bar so it does not linger in history.
{
  const q = new URLSearchParams(location.search).get('token');
  if (q) {
    app.token = q;
    sessionStorage.setItem('gateway_token', q);
    localStorage.setItem('gateway_token', q);
    history.replaceState({}, '', location.pathname);
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/* --------------------------------- api ---------------------------------- */

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (app.token) headers.Authorization = `Bearer ${app.token}`;
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    if (res.status === 401) revealAuth(true);
    throw new ApiError(res.status, json);
  }
  return json;
}

/* -------------------------------- boot ---------------------------------- */

init();

async function init() {
  $('holderInput').value = localStorage.getItem('gateway_holder') || `operator-${Math.random().toString(36).slice(2, 6)}`;
  $('btnLease').addEventListener('click', acquireLease);
  $('btnRenew').addEventListener('click', renewLease);
  $('btnRelease').addEventListener('click', releaseLease);
  $('btnSend').addEventListener('click', sendCommand);
  $('btnStop').addEventListener('click', softwareStop);
  $('btnRearm').addEventListener('click', clearLatch);
  $('capSelect').addEventListener('change', () => renderCommandForm());
  $('btnAuth').addEventListener('click', () => revealAuth());
  $('btnTokenSave').addEventListener('click', saveToken);
  $('tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveToken(); });

  app.countdown = setInterval(tickLease, 250);

  // The twin is a separate server (serve.mjs on :8787): same host, another port.
  const twin = $('twinLink');
  if (twin) twin.href = `${location.protocol}//${location.hostname}:8787/`;

  try {
    await refreshHealth();
    await loadRobots();
    app.pollTimer = setInterval(pollState, 1500);
    app.auditTimer = setInterval(loadAudit, 3000);
  } catch (err) {
    if (err.status === 401) revealAuth(true);
    else fatal(err);
  }
}

function fatal(err) {
  const banner = $('stopBanner');
  banner.hidden = false;
  banner.className = 'banner stop';
  banner.textContent = `Gateway unavailable: ${err.message}`;
}

function revealAuth(strict = false) {
  $('authBar').hidden = false;
  $('btnAuth').hidden = false;
  $('tokenInput').value = app.token;
  if (strict) $('tokenInput').focus();
}

function saveToken() {
  app.token = $('tokenInput').value.trim();
  sessionStorage.setItem('gateway_token', app.token);
  $('authBar').hidden = true;
  location.reload();
}

/* ------------------------------ gateway -------------------------------- */

async function refreshHealth() {
  const res = await fetch('/api/v1/health');
  const health = await res.json();
  if (!res.ok) throw new ApiError(res.status, health);

  $('gwDot').dataset.state = health.ok ? 'up' : 'down';
  $('gwMeta').textContent = `${health.apiVersion} · up ${fmtDuration(health.uptimeMs)}`;
  $('gwInfo').innerHTML = '';
  for (const [k, v] of [
    ['physical writes', health.physicalEnabled ? 'enabled at gateway' : 'disabled'],
    ['auth', health.tokenRequired ? 'bearer required' : 'open (local)'],
    ['robots', String(health.robots)],
    ['audit events', String(health.auditSeq)],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    $('gwInfo').append(dt, dd);
  }
  if (health.tokenRequired && !app.token) revealAuth();
}

async function loadRobots() {
  const { robots } = await api('/robots');
  app.robots = robots;
  renderRobots();
  const keep = robots.some((r) => r.robotId === app.robotId);
  const next = keep ? app.robotId : robots[0]?.robotId ?? null;
  if (next) await selectRobot(next);
  else {
    $('robotTitle').textContent = 'No robots configured';
    $('telemetry').innerHTML = '<p class="empty">Add a robot to gateway/config/robots.json.</p>';
  }
}

function renderRobots() {
  $('robotCount').textContent = `${app.robots.length}`;
  const list = $('robotList');
  list.innerHTML = '';
  for (const robot of app.robots) {
    const btn = document.createElement('button');
    btn.className = 'robot';
    btn.type = 'button';
    btn.setAttribute('aria-current', String(robot.robotId === app.robotId));
    btn.addEventListener('click', () => selectRobot(robot.robotId).catch(fatal));

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.dataset.state = robot.online ? 'up' : 'down';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = robot.label;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${robot.robotId} · ${robot.adapter} · ${robot.configuration}`;
    name.append(sub);

    const pill = document.createElement('span');
    pill.className = `pill ${robot.physical ? 'warn' : ''}`;
    pill.textContent = robot.physical ? 'physical' : 'sim';

    btn.append(dot, name, pill);
    list.append(btn);
  }
}

async function selectRobot(robotId) {
  app.robotId = robotId;
  app.joints = null;
  app.jointSig = '';
  app.jointRows.clear();
  disconnectTelemetry();

  const detail = await api(`/robots/${robotId}`);
  const caps = await api(`/robots/${robotId}/capabilities`);
  app.detail = detail;
  app.state = detail.state;
  app.capabilities = caps.capabilities;
  app.lease = detail.state.lease;

  renderRobots();
  renderTitle();
  renderState();
  renderModeOptions();
  renderLease();
  renderCapabilityOptions();
  renderCommandForm();
  loadAudit();
  connectTelemetry();
}

function renderTitle() {
  const d = app.detail;
  $('robotTitle').textContent = d.label;
  const badges = $('robotBadges');
  badges.innerHTML = '';
  for (const [text, cls] of [
    [d.robotId, 'accent'],
    [d.adapter, ''],
    [d.physical ? 'physical' : 'simulator', d.physical ? 'warn' : ''],
    [d.configuration, d.configuration === 'grounded' ? 'ok' : 'warn'],
  ]) {
    const span = document.createElement('span');
    span.className = `pill ${cls}`;
    span.textContent = text;
    badges.append(span);
  }
}

/* -------------------------------- state -------------------------------- */

async function pollState() {
  if (!app.robotId) return;
  try {
    const state = await api(`/robots/${app.robotId}/state`);
    app.state = state;
    app.lease = state.lease;
    renderState();
    renderLease();
    if (!app.state.online) renderOffline();
  } catch (err) {
    if (err.status === 401) return;
    $('gwDot').dataset.state = 'down';
    $('gwMeta').textContent = `gateway error: ${err.message}`;
  }
}

function renderState() {
  const s = app.state;
  if (!s) return;
  const grid = $('stateGrid');
  grid.innerHTML = '';
  const cells = [
    ['online', s.online ? 'yes' : 'no', s.online ? 'good' : 'bad'],
    ['health', s.health, s.health === 'ok' ? 'good' : s.health === 'degraded' ? 'warn' : 'bad'],
    ['source', s.source, s.source === 'measured' ? 'good' : s.source === 'simulated' ? 'warn' : 'bad'],
    ['action', s.actionLabel || s.action || '—', ''],
    ['config', s.configuration, ''],
    ['lease', s.lease ? `${s.lease.holder} · ${s.lease.mode}` : 'none', s.lease ? '' : 'warn'],
    ['stop', s.stop?.latched ? 'LATCHED' : 'clear', s.stop?.latched ? 'bad' : 'good'],
    ['posture', s.posture || '—', ''],
  ];
  for (const [k, v, cls] of cells) {
    const cell = document.createElement('div');
    cell.className = 'state-cell';
    const kk = document.createElement('div');
    kk.className = 'k';
    kk.textContent = k;
    const vv = document.createElement('div');
    vv.className = `v ${cls}`;
    vv.textContent = String(v);
    cell.append(kk, vv);
    grid.append(cell);
  }

  renderProfile(s.profile);
  renderPresence(s.presence ?? null);

  const notes = $('stateNotes');
  notes.innerHTML = '';
  const bits = [];
  if (s.link?.detail) bits.push(s.link.detail);
  if (s.link?.lastError) bits.push(`last error: ${s.link.lastError}`);
  if (s.link?.jointsAgeMs != null) bits.push(`${s.link.jointCount} joints · ${Math.round(s.link.jointsAgeMs)} ms old`);
  if (s.base) bits.push(`base x ${s.base.x} y ${s.base.y} yaw ${s.base.yaw}`);
  if (s.speech?.text) bits.push(`speech: “${s.speech.text}”`);
  if (bits.length) notes.textContent = bits.join(' · ');

  renderStop();
}

function renderPresence(p) {
  const body = $('presenceBody');

  // No publisher and nothing to clear: state snapshots arrive at 10 Hz, so an
  // unconditional rebuild would churn the DOM for no reason.
  if (!p && !app.presence) return;

  // State messages arrive at 10 Hz and repeat the same sample. Rebuild only when
  // the sequence number changes; otherwise just refresh the age.
  if (p && app.presence && p.seq === app.presence.seq) {
    app.presence = p;
    app.presenceAgeBase = p.ageMs;
    app.presenceAgeAt = Date.now();
    updatePresenceAge();
    return;
  }

  app.presence = p ?? null;
  app.presenceAgeBase = p?.ageMs ?? 0;
  app.presenceAgeAt = Date.now();
  body.innerHTML = '';

  if (!p) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    const link = document.createElement('a');
    link.href = './room.html';
    link.textContent = 'room sensors';
    empty.append('No room sensors publishing. Open ', link, ' and start a device.');
    body.append(empty);
    $('presenceMeta').textContent = 'no stream';
    $('presenceMeta').style.color = '';
    return;
  }

  if (p.mic) {
    body.append(sensorRow({
      label: 'mic',
      value: `${p.mic.db.toFixed(1)} dBFS`,
      pct: ((p.mic.db + 100) / 100) * 100,
      hot: p.mic.speaking,
      title: p.mic.speaking ? 'voice activity' : 'quiet',
    }));
  }
  if (p.camera) {
    body.append(sensorRow({
      label: 'camera',
      value: `${Math.round(p.camera.luminance)} / 255`,
      pct: (p.camera.luminance / 255) * 100,
      hot: p.camera.motion > 1,
      title: `frame delta ${p.camera.motion.toFixed(2)}`,
    }));
  }

  const devices = [p.devices?.mic, p.devices?.camera].filter(Boolean).join(' · ');
  if (devices) {
    const d = document.createElement('div');
    d.className = 'notes';
    d.textContent = devices;
    body.append(d);
  }

  const provenance = document.createElement('div');
  provenance.className = 'notes';
  provenance.textContent = `${p.source} · seq ${p.seq} — measured here, not by the robot`;
  body.append(provenance);

  updatePresenceAge();
}

function sensorRow({ label, value, pct, hot, title }) {
  const row = document.createElement('div');
  row.className = 'sensor';
  if (title) row.title = title;

  const k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;

  const meter = document.createElement('div');
  meter.className = 'meter';
  const fill = document.createElement('i');
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (hot) fill.className = 'hot';
  meter.append(fill);

  const v = document.createElement('span');
  v.className = 'val';
  v.textContent = value;

  row.append(k, meter, v);
  return row;
}

function updatePresenceAge() {
  if (!app.presence) return;
  const age = app.presenceAgeBase + (Date.now() - app.presenceAgeAt);
  const stale = age > 2000;
  const el = $('presenceMeta');
  el.textContent = `${app.presence.source} · ${stale ? 'stale' : 'live'} · ${(age / 1000).toFixed(1)}s`;
  el.style.color = stale ? 'var(--warn)' : 'var(--ok)';
}

function renderProfile(profile) {
  const grid = $('profileGrid');
  grid.innerHTML = '';
  if (!profile || profile.name === 'default') return;

  const head = document.createElement('div');
  head.className = 'profile-head';
  head.textContent = `profile · ${profile.label}${profile.locks?.length ? ` · ${profile.locks.length} lock${profile.locks.length === 1 ? '' : 's'}` : ''}`;
  grid.append(head);

  const cells = [
    ['suspension', profile.suspension],
    ['feet', profile.feet],
    ['rig', profile.rig],
    ['locomotion', profile.locomotion, profile.locomotion === 'locked'],
    ['arm control', profile.armControl],
    ['motion schema', profile.motionSchema],
    ['controller', profile.controller],
  ];
  for (const [k, v, locked] of cells) {
    if (!v) continue;
    const cell = document.createElement('div');
    cell.className = 'profile-cell';
    const kk = document.createElement('div');
    kk.className = 'k';
    kk.textContent = k;
    const vv = document.createElement('div');
    vv.className = `v ${locked ? 'locked' : ''}`;
    vv.textContent = v;
    cell.append(kk, vv);
    grid.append(cell);
  }
}

function renderOffline() {
  if (app.joints) return;
  $('telemetry').innerHTML = `<p class="empty">${escapeHtml(app.state?.link?.detail || 'Robot offline — no telemetry.')}</p>`;
}

function renderStop() {
  const stop = app.state?.stop;
  const banner = $('stopBanner');
  if (stop?.latched) {
    banner.hidden = false;
    banner.className = 'banner stop';
    banner.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = 'SOFTWARE STOP LATCHED';
    const rest = document.createElement('div');
    rest.textContent = `${stop.reason} — ${stop.at} · commands are refused until the latch is cleared. This is not a certified e-stop.`;
    banner.append(strong, rest);
  } else {
    banner.hidden = true;
  }

  tickLease();

  if (app.lastStop) {
    const detail = $('stopDetail');
    const adapter = app.lastStop.adapter ?? {};
    detail.innerHTML = '';
    const lines = [
      `gateway latch: ${app.lastStop.latched ? 'set' : 'clear'}`,
      `adapter stop supported: ${adapter.supported ? 'yes' : 'no'}`,
      `delivered to hardware: ${adapter.delivered ? 'yes' : 'no'}`,
      adapter.note || '',
    ].filter(Boolean);
    const ul = document.createElement('ul');
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.append(li);
    }
    detail.append(ul);
  }
}

/* -------------------------------- lease -------------------------------- */

function renderModeOptions() {
  const select = $('modeSelect');
  const previous = select.value;
  select.innerHTML = '';
  const modes = app.detail?.physical ? ['observe', 'manual', 'assisted'] : ['observe', 'simulate'];
  for (const mode of modes) {
    const opt = document.createElement('option');
    opt.value = mode;
    opt.textContent = mode;
    select.append(opt);
  }
  select.value = modes.includes(previous) ? previous : app.detail?.physical ? 'observe' : 'simulate';
}

function renderLease() {
  const lease = app.lease;
  $('btnRenew').disabled = !lease;
  $('btnRelease').disabled = !lease;
  $('btnLease').textContent = lease ? 're-acquire' : 'acquire';
  tickLease();
  const detail = $('leaseDetail');
  if (!lease) {
    detail.innerHTML = 'No lease. A command without a lease is refused by design.';
    return;
  }
  detail.innerHTML = '';
  const ul = document.createElement('ul');
  for (const line of [
    `holder ${lease.holder} · mode ${lease.mode} · epoch ${lease.epoch}`,
    `scope ${lease.capabilities ? lease.capabilities.join(', ') : 'all capabilities'}`,
    `lease id ${lease.leaseId}`,
  ]) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.append(li);
  }
  detail.append(ul);
}

function tickLease() {
  updatePresenceAge();
  const lease = app.lease;
  if (!lease) {
    $('leaseState').textContent = 'none';
    return;
  }
  const remaining = new Date(lease.expiresAt).getTime() - Date.now();
  const commandable = Boolean(currentCapability()?.commandable);
  const stopped = Boolean(app.state?.stop?.latched);
  const locked = Boolean(currentCapability()?.locked);
  if (remaining <= 0) {
    $('leaseState').textContent = 'expired';
    $('btnRenew').disabled = false; // renewal will report the expiry precisely
    $('btnSend').disabled = !commandable || stopped || locked;
    return;
  }
  $('leaseState').textContent = `${lease.mode} · ${Math.ceil(remaining / 1000)}s left`;
  // The lease is not the only precondition; a non-commandable capability stays
  // disabled even while the lease is live.
  $('btnSend').disabled = !commandable || stopped || locked;
}

async function acquireLease() {
  const holder = $('holderInput').value.trim();
  localStorage.setItem('gateway_holder', holder);
  try {
    const res = await api(`/robots/${app.robotId}/leases`, {
      method: 'POST',
      body: {
        holder,
        mode: $('modeSelect').value,
        ttlMs: Number($('ttlSelect').value),
      },
    });
    app.lease = res.lease;
    renderLease();
    if (res.warnings?.length) showResult({ status: 201, body: { lease: res.lease, warnings: res.warnings } });
    else $('cmdResult').hidden = true;
    loadAudit();
  } catch (err) {
    showResult({ status: err.status ?? 0, body: err.body ?? { error: { message: err.message } } });
  }
}

async function renewLease() {
  if (!app.lease) return;
  try {
    const res = await api(`/robots/${app.robotId}/leases/${app.lease.leaseId}/renew`, {
      method: 'POST',
      body: { ttlMs: Number($('ttlSelect').value) },
    });
    app.lease = res.lease;
    renderLease();
  } catch (err) {
    showResult({ status: err.status ?? 0, body: err.body ?? { error: { message: err.message } } });
  }
}

async function releaseLease() {
  if (!app.lease) return;
  try {
    await api(`/robots/${app.robotId}/leases/${app.lease.leaseId}`, { method: 'DELETE' });
    app.lease = null;
    renderLease();
    loadAudit();
  } catch (err) {
    showResult({ status: err.status ?? 0, body: err.body ?? { error: { message: err.message } } });
  }
}

/* ------------------------------ capabilities ---------------------------- */

function renderCapabilityOptions() {
  const select = $('capSelect');
  const previous = select.value;
  select.innerHTML = '';
  for (const cap of app.capabilities) {
    const opt = document.createElement('option');
    opt.value = cap.capability;
    const flags = [];
    if (cap.locked) flags.push('locked');
    else if (!cap.supported) flags.push('unsupported');
    else if (!cap.commandable) flags.push('read-only');
    opt.textContent = `${cap.capability} — ${cap.label}${flags.length ? ` (${flags.join(', ')})` : ''}`;
    select.append(opt);
  }
  const current = app.capabilities.find((c) => c.capability === previous);
  const fallback = app.capabilities.find((c) => c.commandable) ?? app.capabilities[0];
  select.value = current ? current.capability : fallback?.capability ?? '';
}

function currentCapability() {
  return app.capabilities.find((c) => c.capability === $('capSelect').value) ?? null;
}

function renderCommandForm() {
  const cap = currentCapability();
  const meta = $('capMeta');
  meta.innerHTML = '';
  const form = $('cmdForm');
  form.innerHTML = '';

  if (!cap) return;

  const pillRow = document.createElement('div');
  pillRow.className = 'badges';
  for (const [text, cls] of [
    [cap.observable ? 'observable' : 'not observable', cap.observable ? 'ok' : 'bad'],
    [cap.commandable ? 'commandable' : 'not commandable', cap.commandable ? 'ok' : 'bad'],
    ...(cap.locked ? [['locked by profile', 'warn']] : []),
    [cap.physical ? 'physical effect' : 'no hardware effect', cap.physical ? 'warn' : ''],
    [`modes: ${cap.modes.join(', ') || 'none'}`, ''],
  ]) {
    const span = document.createElement('span');
    span.className = `pill ${cls}`;
    span.textContent = text;
    pillRow.append(span);
  }
  meta.append(pillRow);

  if (cap.reason) {
    const why = document.createElement('div');
    why.style.marginTop = '6px';
    why.textContent = cap.reason;
    meta.append(why);
  }
  if (cap.limits?.note) {
    const note = document.createElement('div');
    note.style.marginTop = '4px';
    note.textContent = cap.limits.note;
    meta.append(note);
  }

  if (!cap.commandable) {
    $('btnSend').disabled = true;
    const p = document.createElement('p');
    p.className = 'fine';
    p.textContent = 'This capability is not commandable on this robot. The refusal is enforced by the gateway, not by this form.';
    form.append(p);
    return;
  }
  if (!cap.schema) {
    $('btnSend').disabled = true;
    return;
  }

  const required = new Set(cap.schema.required ?? []);
  buildFields(form, cap.schema.properties ?? {}, required, '');
  $('btnSend').disabled = false;
  tickLease();
}

function buildFields(container, properties, required, prefix) {
  for (const [name, schema] of Object.entries(properties)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (schema.type === 'object' && schema.properties) {
      const fieldset = document.createElement('fieldset');
      if (name === 'joints') fieldset.className = 'joint-grid';
      const legend = document.createElement('legend');
      legend.textContent = name;
      fieldset.append(legend);
      buildFields(fieldset, schema.properties, new Set(schema.required ?? []), path);
      container.append(fieldset);
      continue;
    }
    const field = document.createElement('div');
    field.className = 'field';

    const inputId = `f_${path.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const label = document.createElement('label');
    label.htmlFor = inputId;
    label.textContent = name;
    if (required.has(name)) {
      const req = document.createElement('span');
      req.className = 'req';
      req.textContent = ' *';
      label.append(req);
    }
    field.append(label);

    let input;
    if (Array.isArray(schema.enum)) {
      input = document.createElement('select');
      if (!required.has(name)) input.append(new Option('—', ''));
      for (const value of schema.enum) input.append(new Option(value, value));
      if (required.has(name)) input.value = schema.enum[0];
    } else if (schema.type === 'boolean') {
      input = document.createElement('input');
      input.type = 'checkbox';
    } else if (schema.type === 'number' || schema.type === 'integer') {
      input = document.createElement('input');
      input.type = 'number';
      input.step = schema.type === 'integer' ? '1' : '0.01';
      if (schema.min !== undefined) input.min = schema.min;
      if (schema.max !== undefined) input.max = schema.max;
      input.placeholder = rangeHint(schema);
    } else if (name === 'text') {
      input = document.createElement('textarea');
      input.maxLength = schema.maxLength ?? 500;
      input.placeholder = 'spoken text';
    } else {
      input = document.createElement('input');
      input.type = 'text';
      if (schema.pattern) input.pattern = schema.pattern;
      if (schema.maxLength) input.maxLength = schema.maxLength;
    }

    input.id = inputId;
    input.dataset.path = path;
    input.dataset.kind = schema.type ?? 'string';
    if (required.has(name)) input.dataset.required = 'true';
    field.append(input);

    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = describeSchema(schema);
    field.append(hint);

    container.append(field);
  }
}

function rangeHint(schema) {
  if (schema.min !== undefined && schema.max !== undefined) return `${schema.min} … ${schema.max}`;
  if (schema.min !== undefined) return `>= ${schema.min}`;
  if (schema.max !== undefined) return `<= ${schema.max}`;
  return '';
}

function describeSchema(schema) {
  const bits = [];
  if (schema.unit) bits.push(schema.unit);
  if (schema.type === 'number' && schema.min !== undefined && schema.max !== undefined) {
    bits.push(`${schema.min} … ${schema.max}`);
  }
  return bits.join(' · ');
}

function collectPayload() {
  const payload = {};
  for (const input of $('cmdForm').querySelectorAll('[data-path]')) {
    const path = input.dataset.path;
    const kind = input.dataset.kind;
    let value;
    if (kind === 'boolean') value = input.checked;
    else {
      const raw = input.value.trim();
      if (raw === '') continue;
      value = kind === 'number' || kind === 'integer' ? Number(raw) : raw;
      if (kind === 'number' && !Number.isFinite(value)) continue;
    }
    assign(payload, path.split('.'), value);
  }
  return payload;
}

function assign(target, parts, value) {
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    node[parts[i]] = node[parts[i]] ?? {};
    node = node[parts[i]];
  }
  node[parts[parts.length - 1]] = value;
}

/* ------------------------------- commands ------------------------------- */

async function sendCommand() {
  const cap = currentCapability();
  if (!cap) return;
  if (!app.lease) {
    showResult({ status: 0, body: { error: { message: 'No lease. Acquire one first — the gateway refuses commands without it.' } } });
    return;
  }
  const payload = collectPayload();
  if (cap.capability === 'arms.joints' && (!payload.joints || !Object.keys(payload.joints).length)) {
    showResult({ status: 0, body: { error: { message: 'Set at least one arm joint (radians). Unset joints hold.' } } });
    return;
  }

  const body = {
    commandId: `web_${crypto.randomUUID().replace(/-/g, '')}`,
    robotId: app.robotId,
    capability: cap.capability,
    payload,
    leaseId: app.lease.leaseId,
    deadlineMs: Date.now() + 5_000,
  };

  try {
    const res = await api(`/robots/${app.robotId}/commands`, { method: 'POST', body });
    showResult({ status: 200, body: res }, 'good');
    pollState();
    loadAudit();
  } catch (err) {
    showResult({ status: err.status ?? 0, body: err.body ?? { error: { message: err.message } } }, 'bad');
    loadAudit();
  }
}

function showResult({ status, body }, cls = '') {
  const pre = $('cmdResult');
  pre.hidden = false;
  pre.className = `result ${cls}`;
  pre.textContent = formatResult(status, body);
}

function formatResult(status, body) {
  const lines = [];
  if (status) lines.push(`HTTP ${status}`);
  if (body?.error) {
    lines.push(`${body.error.code ?? 'error'}: ${body.error.message ?? ''}`);
    const errors = body.error.details?.errors;
    if (Array.isArray(errors)) {
      for (const e of errors.slice(0, 8)) lines.push(`  ${e.path}: ${e.message}`);
    }
    const other = body.error.details;
    if (other && !other.errors) lines.push(`  ${JSON.stringify(other)}`);
    return lines.join('\n');
  }
  if (body?.lease) {
    lines.push(`lease ${body.lease.leaseId} · ${body.lease.mode} · ${body.lease.holder}`);
    lines.push(`expires ${body.lease.expiresAt}`);
  }
  if (body?.commandId) {
    lines.push(`command ${body.commandId}`);
    lines.push(`accepted=${body.accepted} applied=${body.applied} mode=${body.mode} latency=${body.latencyMs}ms`);
    if (body.note) lines.push(body.note);
    for (const w of body.warnings ?? []) lines.push(`warning ${w.code}: ${w.message}`);
  }
  const rest = { ...body };
  delete rest.lease;
  delete rest.commandId;
  delete rest.accepted;
  delete rest.applied;
  delete rest.mode;
  delete rest.latencyMs;
  delete rest.note;
  delete rest.warnings;
  delete rest.error;
  if (Object.keys(rest).length) lines.push(JSON.stringify(rest, null, 2));
  return lines.join('\n');
}

/* --------------------------------- stop --------------------------------- */

async function softwareStop() {
  if (!app.robotId) return;
  try {
    const res = await api(`/robots/${app.robotId}/stop`, {
      method: 'POST',
      body: { reason: 'console software stop', scope: 'all' },
    });
    app.lastStop = res;
    app.lease = null;
    await pollState();
    renderLease();
    loadAudit();
  } catch (err) {
    showResult({ status: err.status ?? 0, body: err.body ?? { error: { message: err.message } } }, 'bad');
  }
}

async function clearLatch() {
  if (!app.robotId) return;
  const ok = window.confirm(
    'Clear the software stop latch?\n\n' +
    'This does NOT test, reset or acknowledge any hardware safety system. ' +
    'Confirm the robot is safe to command before continuing.',
  );
  if (!ok) return;
  try {
    const res = await api(`/robots/${app.robotId}/rearm`, {
      method: 'POST',
      body: { confirm: 'rearm', reason: 'console rearm' },
    });
    app.lastStop = null;
    $('stopDetail').innerHTML = '';
    await pollState();
    loadAudit();
    return res;
  } catch (err) {
    showResult({ status: err.status ?? 0, body: err.body ?? { error: { message: err.message } } }, 'bad');
  }
}

/* ------------------------------- telemetry ------------------------------ */

function connectTelemetry() {
  disconnectTelemetry();
  if (!app.robotId) return;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = app.token ? `?token=${encodeURIComponent(app.token)}` : '';
  const url = `${proto}//${location.host}/api/v1/robots/${app.robotId}/telemetry${query}`;
  const ws = new WebSocket(url);
  app.ws = ws;
  app.wsRobot = app.robotId;
  setWsState('connecting');

  ws.onopen = () => setWsState('live');
  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'state') {
      app.state = msg.state;
      app.lease = msg.state.lease;
      renderState();
      renderLease();
    } else if (msg.type === 'joints') {
      app.joints = msg.joints;
      renderTelemetry(msg.joints);
    } else if (msg.type === 'presence') {
      renderPresence(msg.presence);
    } else if (msg.type === 'event') {
      loadAudit();
    } else if (msg.type === 'error') {
      setWsState('error');
    }
  };
  ws.onclose = () => {
    setWsState('closed');
    if (app.wsRobot !== app.robotId) return;
    app.retry = setTimeout(connectTelemetry, 2000);
  };
  ws.onerror = () => setWsState('error');
}

function disconnectTelemetry() {
  clearTimeout(app.retry);
  if (app.ws) {
    app.ws.onclose = null;
    app.ws.close();
  }
  app.ws = null;
  app.wsRobot = null;
  setWsState('idle');
}

function setWsState(status) {
  const labels = { idle: 'idle', connecting: 'connecting', live: 'live', closed: 'reconnecting', error: 'error' };
  const el = $('wsState');
  el.textContent = labels[status] ?? status;
  el.style.color = status === 'live' ? 'var(--ok)' : status === 'error' ? 'var(--bad)' : '';
}

function renderTelemetry(j) {
  const container = $('telemetry');
  const names = Object.keys(j.joints ?? {}).sort();
  const sig = [
    names.join(','),
    Object.keys(j.neck ?? {}).join(','),
    Object.keys(j.hands?.left ?? {}).join(','),
    Object.keys(j.hands?.right ?? {}).join(','),
  ].join('|');

  if (sig !== app.jointSig) {
    container.innerHTML = '';
    app.jointRows.clear();
    app.jointSig = sig;
    appendSection(container, 'body joints', names.map((name) => [name, name]));
    appendSection(container, 'head', Object.keys(j.neck ?? {}).map((k) => [k, k]));
    appendSection(container, 'left hand', Object.keys(j.hands?.left ?? {}).map((k) => [`L ${k}`, `left.${k}`]));
    appendSection(container, 'right hand', Object.keys(j.hands?.right ?? {}).map((k) => [`R ${k}`, `right.${k}`]));
    if (!names.length) {
      container.innerHTML = '<p class="empty">No joint payload in this stream.</p>';
    }
  }

  for (const row of app.jointRows.values()) {
    const value = readJoint(j, row.key);
    if (typeof value === 'number') updateJointRow(row, row.key, value);
    else row.v.textContent = '—';
  }
}

function appendSection(container, title, rows) {
  if (!rows.length) return;
  const h = document.createElement('h3');
  h.textContent = title;
  container.append(h);
  for (const [label, key] of rows) {
    const wrap = document.createElement('div');
    wrap.className = 'joint';
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = label;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = '—';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    bar.append(fill);
    wrap.append(n, v, bar);
    container.append(wrap);
    app.jointRows.set(`${title}::${key}`, { v, fill, key });
  }
}

function readJoint(j, key) {
  if (key.includes('.')) {
    const [side, finger] = key.split('.');
    return j.hands?.[side]?.[finger];
  }
  if (key === 'joint1' || key === 'joint2') return j.neck?.[key];
  if (key.startsWith('idx27') || key.startsWith('idx28')) return j.neck?.[key];
  return j.joints?.[key];
}

function updateJointRow(nodes, key, value) {
  nodes.v.textContent = value.toFixed(3);
  const range = jointRange(key);
  const pct = Math.max(0, Math.min(100, ((value - range[0]) / (range[1] - range[0])) * 100));
  nodes.fill.style.width = `${pct}%`;
  nodes.fill.style.background = pct > 88 || pct < 12 ? 'var(--warn)' : 'var(--accent)';
}

function jointRange(key) {
  if (key.includes('.')) return [0, 2000];
  const arm = app.capabilities.find((c) => c.capability === 'arms.joints')?.limits?.hard?.[key];
  if (arm) return arm;
  if (key === 'joint1' || key.startsWith('idx27')) return [-2.2, 2.2];
  if (key === 'joint2' || key.startsWith('idx28')) return [-0.5, 0.5];
  return [-1.92, 2.44];
}

/* -------------------------------- audit --------------------------------- */

async function loadAudit() {
  try {
    const res = await api(`/audit?limit=30${app.robotId ? `&robotId=${encodeURIComponent(app.robotId)}` : ''}`);
    app.auditSeq = res.seq;
    $('auditSeq').textContent = `${res.seq} events`;
    const list = $('audit');
    list.innerHTML = '';
    for (const entry of res.entries) {
      const li = document.createElement('li');
      const time = document.createElement('span');
      time.className = 't';
      time.textContent = entry.at.slice(11, 19);
      const msg = document.createElement('span');
      msg.className = 'm';
      msg.textContent = [entry.kind, entry.capability, entry.code ?? '', entry.message ?? '']
        .filter(Boolean).join(' · ');
      msg.title = JSON.stringify(entry, null, 2);
      const outcome = document.createElement('span');
      outcome.className = `o ${entry.outcome}`;
      outcome.textContent = entry.outcome;
      li.append(time, msg, outcome);
      list.append(li);
    }
    if (!res.entries.length) list.innerHTML = '<li><span class="empty">No events yet.</span></li>';
  } catch {
    /* the audit pane is not worth a fatal error */
  }
}

/* ------------------------------- utilities ------------------------------- */

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}
