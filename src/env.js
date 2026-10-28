// Runtime environment detection.
//
// The same build runs in two places, and only one of them can reach a robot:
//
//   sim    static hosting (Cloudflare Pages, a file:// snapshot, a plain server).
//          No gateway exists on this origin. Live telemetry is unavailable by
//          design, and the UI must say so rather than showing a failed poll.
//   local  served by serve.mjs, which proxies a read-only GetAction to Luka.
//
// Detection is a single cheap probe of ./api/health. It never throws, and a
// missing endpoint is a normal outcome, not an error worth logging.

export const MODES = { SIM: 'sim', LOCAL: 'local' };

export async function detectEnvironment({ timeoutMs = 1500 } = {}) {
  const forced = new URLSearchParams(location.search).get('mode');

  if (forced === MODES.SIM) {
    return { mode: MODES.SIM, gateway: false, reason: 'forced by ?mode=sim' };
  }

  // A static build stamps itself, so it never fires a probe that would 404.
  const marker = document.querySelector('meta[name="luka-env"]')?.content;
  if (marker === 'static') {
    return { mode: MODES.SIM, gateway: false, reason: 'static build marker' };
  }

  // file:// has no HTTP origin to probe.
  if (location.protocol === 'file:') {
    return { mode: MODES.SIM, gateway: false, reason: 'file:// origin' };
  }

  const probe = await probeGateway(timeoutMs);
  if (probe.gateway) return probe;
  if (forced === MODES.LOCAL) {
    return { ...probe, reason: '?mode=local but no gateway answered' };
  }
  return probe;
}

async function probeGateway(timeoutMs) {
  try {
    const res = await fetch('./api/health', {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return { mode: MODES.SIM, gateway: false, reason: `health ${res.status}` };
    const json = await res.json();
    if (!json || json.ok !== true) {
      return { mode: MODES.SIM, gateway: false, reason: 'health payload not recognised' };
    }
    return { mode: MODES.LOCAL, gateway: true, robot: json.robot, health: json };
  } catch (err) {
    return {
      mode: MODES.SIM,
      gateway: false,
      reason: err.name === 'TimeoutError' ? 'gateway probe timed out' : 'no gateway on this origin',
    };
  }
}

/** Human-readable explanation shown in the link panel. */
export function describeEnvironment(env) {
  if (env.mode === MODES.LOCAL) {
    return `Local gateway present · proxying ${env.robot || 'robot'}`;
  }
  return 'Static build · no gateway on this origin';
}
