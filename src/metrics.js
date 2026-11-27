// Privacy-first batched analytics SDK for Steadwell · Luka v. A2U.
// - Ephemeral per-tab session_id (no cookies, no user PII, never records raw speech text)
// - Auto-routes to /api/metrics on Cloudflare Pages (D1) or /sim-api/metrics locally (JSONL)
// - Batched flush + sendBeacon on pagehide/visibilitychange, zero UI blocking

const OPTOUT_KEY = 'luka_metrics_optout';
const SESSION_KEY = 'luka_metrics_sid';

export function isMetricsOptedOut() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(OPTOUT_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMetricsOptOut(optedOut) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (optedOut) localStorage.setItem(OPTOUT_KEY, '1');
    else localStorage.removeItem(OPTOUT_KEY);
  } catch {
    /* ignore storage limits */
  }
}

export function getMetricsEndpoints() {
  const isStatic =
    typeof document !== 'undefined' &&
    document.querySelector('meta[name="luka-env"]')?.content === 'static';
  const base = isStatic ? '/api/metrics' : '/sim-api/metrics';
  return {
    env: isStatic ? 'pages' : 'local',
    ingest: base,
    summary: `${base}/summary`,
    exportUrl: `${base}/export`,
  };
}

function getOrCreateSessionId() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      let sid = sessionStorage.getItem(SESSION_KEY);
      if (!sid) {
        const bytes = new Uint8Array(8);
        crypto.getRandomValues(bytes);
        sid = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem(SESSION_KEY, sid);
      }
      return sid;
    }
  } catch {
    /* private mode fallback */
  }
  return `s_${Math.random().toString(16).slice(2, 14)}`;
}

export function createMetricsClient(appName) {
  const endpoints = getMetricsEndpoints();
  const sessionId = getOrCreateSessionId();
  const queue = [];
  let flushTimer = null;
  let flushing = false;

  const scheduleFlush = () => {
    if (flushTimer || !queue.length) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush(false);
    }, 8000);
  };

  async function flush(useBeacon = false) {
    if (isMetricsOptedOut() || !queue.length || flushing) return;
    const batch = queue.splice(0, 35);
    const payload = JSON.stringify({ events: batch });

    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        const blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon(endpoints.ingest, blob)) return;
      } catch {
        /* fall through to keepalive fetch */
      }
    }

    flushing = true;
    try {
      await fetch(endpoints.ingest, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: useBeacon,
      });
    } catch {
      /* never disrupt the sim or spam console */
    } finally {
      flushing = false;
      if (queue.length) scheduleFlush();
    }
  }

  function track(event, { category = 'nav', label = '', value = null, meta = {} } = {}) {
    if (isMetricsOptedOut()) return;
    queue.push({
      ts: Date.now(),
      session_id: sessionId,
      env: endpoints.env,
      app: appName,
      event,
      category,
      label: String(label || ''),
      value: typeof value === 'number' && Number.isFinite(value) ? value : null,
      meta,
    });
    if (queue.length >= 12) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      void flush(false);
    } else {
      scheduleFlush();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { void flush(true); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flush(true);
    });
    window.addEventListener('error', (ev) => {
      track('runtime_error', {
        category: 'error',
        label: String(ev?.message || 'window_error').slice(0, 72),
      });
    });
  }

  // Record initial view automatically
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const viewport = vw >= 1280 ? 'desktop' : vw >= 768 ? 'tablet' : 'mobile';
  let refHost = '';
  try {
    if (typeof document !== 'undefined' && document.referrer) {
      refHost = new URL(document.referrer).hostname;
    }
  } catch { /* ignore */ }
  track('app_view', { category: 'nav', label: viewport, meta: { viewport, refHost } });

  return { track, flush, sessionId, endpoints };
}
