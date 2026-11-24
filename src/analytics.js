import { getMetricsEndpoints, isMetricsOptedOut, setMetricsOptOut } from './metrics.js';

const $ = (id) => document.getElementById(id);
const endpoints = getMetricsEndpoints();
let currentDays = 7;

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderBarList(el, items, { cls = '', empty = 'No events recorded in this window yet.' } = {}) {
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = `<div class="empty-note">${esc(empty)}</div>`;
    return;
  }
  const max = Math.max(...items.map((x) => x.count), 1);
  el.innerHTML = items
    .map((item) => {
      const pct = Math.max(4, Math.round((item.count / max) * 100));
      return `<div class="bar-row">
        <span class="bar-name" title="${esc(item.name)}">${esc(item.name)}</span>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
        <span class="bar-val">${item.count}</span>
      </div>`;
    })
    .join('');
}

function renderTimeline(el, timeline) {
  if (!el) return;
  if (!timeline || !timeline.length) {
    el.innerHTML = '<div class="empty-note">No daily data yet.</div>';
    return;
  }
  const max = Math.max(...timeline.map((d) => d.events), 1);
  el.innerHTML = timeline
    .map((d) => {
      const h = Math.max(3, Math.round((d.events / max) * 92));
      const shortDay = d.day.slice(5);
      return `<div class="t-col" title="${esc(d.day)}: ${d.events} events · ${d.sessions} sessions · ${d.turns} turns">
        <div class="t-bar" style="height:${h}px"></div>
        <span class="t-lbl">${esc(shortDay)}</span>
      </div>`;
    })
    .join('');
}

function renderSummary(data) {
  const ov = data.overview || {};
  $('kpiSessions').textContent = String(ov.uniqueSessions ?? 0);
  $('kpiEvents').textContent = `${ov.totalEvents ?? 0} total events`;
  $('kpiTurns').textContent = String(ov.speechTurns ?? 0);
  $('kpiLlmMs').textContent = ov.avgLlmMs ? `Avg LLM ${ov.avgLlmMs} ms` : 'Avg LLM —';
  $('kpiGestures').textContent = String(ov.gesturesPlayed ?? 0);
  $('kpiClaims').textContent = `${ov.totalClaimsExtracted ?? 0} Trellis claims`;
  $('kpiVision').textContent = String(ov.visionSessions ?? 0);
  $('kpiGuard').textContent = `${ov.visionGuardEvents ?? 0} failsafe holds`;
  $('kpiFps').textContent = ov.avgFps ? `${ov.avgFps}` : '—';
  const topRenderer = data.perf?.renderers?.[0]?.name || '—';
  $('kpiRenderer').textContent = `Primary: ${topRenderer}`;
  $('kpiHolds').textContent = String((ov.softHoldCount ?? 0) + (data.safety?.topClamps?.reduce((a, b) => a + b.count, 0) ?? 0));
  $('kpiPeakWrist').textContent = `Peak wrist ${data.safety?.peakWristLoadPct ?? 0}%`;

  $('timelineMeta').textContent = `Last ${data.windowDays}d · ${ov.totalEvents ?? 0} events across ${ov.uniqueSessions ?? 0} sessions`;
  renderTimeline($('timelineBars'), data.timeline);

  renderBarList($('gesturesList'), data.gestures, { empty: 'Play gestures or talk to Luka to populate gesture stats.' });
  const appItems = (data.appLaunches?.length ? data.appLaunches : data.apps) || [];
  renderBarList($('launchesList'), appItems, { cls: 'emerald', empty: 'Launch apps from the Hub to track usage.' });

  $('visionChips').innerHTML = [
    ['Sessions', data.vision?.sessions ?? 0],
    ['Tracked Time', `${data.vision?.totalDurationSec ?? 0}s`],
    ['Guard Holds', data.vision?.guardTriggers ?? 0],
  ].map(([k, v]) => `<span class="stat-chip">${esc(k)}<b>${esc(v)}</b></span>`).join('');
  renderBarList($('visionGuardList'), data.vision?.guardReasons, {
    cls: 'amber',
    empty: 'No Kameyoko tracking-loss failsafe triggers recorded yet.',
  });

  $('safetyChips').innerHTML = [
    ['Peak Speed', `${data.safety?.peakSpeedRadS ?? 0} rad/s`],
    ['Peak Accel', `${data.safety?.peakAccelRadS2 ?? 0} rad/s²`],
    ['Soft Holds', data.safety?.softHoldCount ?? 0],
    ['Dry-Run Inspects', data.safety?.dryRunInspectCount ?? 0],
  ].map(([k, v]) => `<span class="stat-chip">${esc(k)}<b>${esc(v)}</b></span>`).join('');
  renderBarList($('safetyClampsList'), data.safety?.topClamps?.length ? data.safety.topClamps : data.safety?.profiles, {
    cls: 'amber',
    empty: 'All actuator commands stayed cleanly inside envelope bounds.',
  });

  $('speechChips').innerHTML = [
    ['Avg ASR', data.speech?.avgAsrMs ? `${data.speech.avgAsrMs} ms` : '—'],
    ['Avg LLM', data.speech?.avgLlmMs ? `${data.speech.avgLlmMs} ms` : '—'],
    ['Top LLM', data.speech?.llmProviders?.[0]?.name || '—'],
    ['Top TTS', data.speech?.ttsProviders?.[0]?.name || '—'],
  ].map(([k, v]) => `<span class="stat-chip">${esc(k)}<b>${esc(v)}</b></span>`).join('');
  renderBarList($('speechModesList'), data.speech?.modes, {
    cls: 'emerald',
    empty: 'No voice or text turns recorded yet.',
  });

  const combinedPerf = [
    ...(data.perf?.renderers || []).map((r) => ({ name: `renderer:${r.name}`, count: r.count })),
    ...(data.trellis?.actions || []).map((r) => ({ name: `trellis:${r.name}`, count: r.count })),
    ...(data.perf?.recordings || []).map((r) => ({ name: `rec:${r.name}`, count: r.count })),
  ];
  renderBarList($('trellisPerfList'), combinedPerf, {
    empty: 'Boot a 3D twin or anchor Trellis memories to collect performance stats.',
  });

  $('storageBadge').textContent = (data.storage || endpoints.env).toUpperCase();
  $('storageDot').dataset.state = 'online';
  $('generatedAt').textContent = `UPDATED ${new Date(data.generatedAt || Date.now()).toLocaleTimeString()}`;
}

async function loadSummary() {
  $('btnExportJsonl').href = `${endpoints.exportUrl}?days=${currentDays}&format=jsonl`;
  $('btnExportCsv').href = `${endpoints.exportUrl}?days=${currentDays}&format=csv`;
  try {
    const res = await fetch(`${endpoints.summary}?days=${currentDays}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderSummary(data);
  } catch (err) {
    $('storageBadge').textContent = 'UNAVAILABLE';
    $('storageDot').dataset.state = 'sim';
    $('generatedAt').textContent = `ERROR: ${err.message}`;
  }
}

document.querySelectorAll('.seg-btn[data-days]').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentDays = Number(btn.dataset.days) || 7;
    document.querySelectorAll('.seg-btn[data-days]').forEach((b) => {
      b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
    });
    void loadSummary();
  });
});

$('btnRefresh')?.addEventListener('click', () => { void loadSummary(); });

const optOut = $('optOutCheck');
if (optOut) {
  optOut.checked = isMetricsOptedOut();
  optOut.addEventListener('change', () => setMetricsOptOut(optOut.checked));
}

void loadSummary();
