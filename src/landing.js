// Steadwell · Luka A2 Ultra Application Hub Interactions
// Implements MengTo craft patterns:
//   - Accessible staggered-word-reveal (once-only IntersectionObserver)
//   - Pointer-eased OLED visor eye tracking + natural blinking (paused offscreen/hidden)
//   - Pointer-following radial glass card spotlight (--mx / --my)
//   - Passive live service health check for Gateway (:8788) & Bridge (:8791) with static-deploy guard
//   - Keyboard quick-launch shortcuts (1..8)

import { createMetricsClient } from './metrics.js';

document.documentElement.classList.add('js');

const metrics = createMetricsClient('hub');
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
const isStaticBuild = document.querySelector('meta[name="luka-env"]')?.content === 'static';

/* ------------------------------------------- 1. Staggered Word Reveal */

function initWordReveals() {
  const nodes = document.querySelectorAll('[data-word-reveal]');
  if (!nodes.length) return;

  const splitNode = (el) => {
    const fullText = (el.textContent || '').trim().replace(/\s+/g, ' ');
    if (!fullText) return;
    el.setAttribute('aria-label', fullText);

    // Preserve child spans (e.g. .muted-line) while splitting text nodes into words
    let wordIndex = 0;
    const walk = (parent) => {
      const children = Array.from(parent.childNodes);
      for (const node of children) {
        if (node.nodeType === Node.TEXT_NODE) {
          const parts = node.textContent.split(/(\s+)/);
          const frag = document.createDocumentFragment();
          for (const part of parts) {
            if (!part) continue;
            if (/^\s+$/.test(part)) {
              frag.appendChild(document.createTextNode(part));
            } else {
              const span = document.createElement('span');
              span.className = 'word-reveal__word';
              span.setAttribute('aria-hidden', 'true');
              span.style.setProperty('--word-index', String(wordIndex++));
              span.textContent = part;
              frag.appendChild(span);
            }
          }
          parent.replaceChild(frag, node);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          walk(node);
        }
      }
    };
    walk(el);
    el.classList.add('is-ready');
  };

  nodes.forEach(splitNode);

  if (prefersReducedMotion || typeof IntersectionObserver === 'undefined') {
    nodes.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.15 },
  );
  nodes.forEach((el) => io.observe(el));
}

/* ------------------------------------------- 2. Scroll Card Entrances */

function initCardReveals() {
  const cards = document.querySelectorAll('.reveal-card');
  if (!cards.length) return;

  if (prefersReducedMotion || typeof IntersectionObserver === 'undefined') {
    cards.forEach((c) => c.classList.add('is-shown'));
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-shown');
          io.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.08, rootMargin: '0px 0px -24px 0px' },
  );
  cards.forEach((c) => io.observe(c));
}

/* ------------------------------ 3. Card Pointer Spotlight (--mx / --my) */

function initCardSpotlights() {
  const cards = document.querySelectorAll('.app-card');
  cards.forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${(e.clientX - rect.left).toFixed(1)}px`);
      card.style.setProperty('--my', `${(e.clientY - rect.top).toFixed(1)}px`);
    });
  });
}

/* -------- 4. Interactive Obsidian OLED Visor (Offscreen & Hidden Safe) */

function initVisorAnimation() {
  const hero = document.getElementById('heroSection');
  const eyes = document.getElementById('oledEyes');
  if (!hero || !eyes) return;

  // Pause CSS animations on hero whenever scrolled offscreen (MengTo optimize-web-animations)
  let heroVisible = true;
  let rafId = 0;
  let blinkTimer = 0;

  let targetX = 0;
  let targetY = 0;
  let curX = 0;
  let curY = 0;

  const stopLoop = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    hero.dataset.animationActive = 'false';
  };

  const step = () => {
    if (!heroVisible || document.hidden || prefersReducedMotion) {
      stopLoop();
      return;
    }
    curX += (targetX - curX) * 0.1;
    curY += (targetY - curY) * 0.1;
    eyes.style.setProperty('--gaze-x', `${curX.toFixed(2)}px`);
    eyes.style.setProperty('--gaze-y', `${curY.toFixed(2)}px`);
    if (Math.abs(targetX - curX) > 0.04 || Math.abs(targetY - curY) > 0.04) {
      rafId = requestAnimationFrame(step);
    } else {
      rafId = 0;
    }
  };

  const kickLoop = () => {
    if (!rafId && heroVisible && !document.hidden && !prefersReducedMotion) {
      hero.dataset.animationActive = 'true';
      rafId = requestAnimationFrame(step);
    }
  };

  const onPointerMove = (e) => {
    if (!heroVisible || prefersReducedMotion) return;
    const rect = hero.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const ny = ((e.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1;
    targetX = Math.max(-1, Math.min(1, nx)) * 9;
    targetY = Math.max(-1, Math.min(1, ny)) * 5;
    kickLoop();
  };

  const onPointerLeave = () => {
    targetX = 0;
    targetY = 0;
    kickLoop();
  };

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', onPointerLeave, { passive: true });

  const scheduleBlink = () => {
    if (prefersReducedMotion) return;
    clearTimeout(blinkTimer);
    blinkTimer = window.setTimeout(() => {
      if (heroVisible && !document.hidden) {
        eyes.style.setProperty('--blink-scale', '0.12');
        window.setTimeout(() => {
          eyes.style.setProperty('--blink-scale', '1');
        }, 115);
      }
      scheduleBlink();
    }, 3200 + Math.random() * 2600);
  };
  scheduleBlink();

  if (typeof IntersectionObserver !== 'undefined') {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          heroVisible = entry.isIntersecting;
          hero.classList.toggle('is-offscreen', !heroVisible);
          hero.dataset.animationActive = heroVisible && !prefersReducedMotion ? 'true' : 'false';
          if (!heroVisible) stopLoop();
        }
      },
      { threshold: 0.05 },
    );
    io.observe(hero);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hero.classList.add('is-offscreen');
      stopLoop();
    } else if (heroVisible) {
      hero.classList.remove('is-offscreen');
      hero.dataset.animationActive = prefersReducedMotion ? 'false' : 'true';
    }
  });
}

/* --------------------- 5. Dynamic Service URLs & Passive Live Status */

function resolveServiceUrls() {
  const proto = location.protocol === 'https:' ? 'https:' : 'http:';
  const host = location.hostname || '127.0.0.1';
  const origins = {
    gateway: `${proto}//${host}:8788`,
    bridge: `${proto}//${host}:8791`,
  };

  document.querySelectorAll('a[data-service]').forEach((link) => {
    const svc = link.dataset.service;
    const path = link.dataset.path || '/';
    if (svc && origins[svc]) {
      link.href = `${origins[svc]}${path}`;
      const endpointEl = link.querySelector('[data-endpoint]');
      if (endpointEl) {
        const port = svc === 'gateway' ? ':8788' : ':8791';
        endpointEl.textContent = `${port}${path}`;
      }
    }
  });

  return origins;
}

async function probeEndpoint(url, timeoutMs = 1400) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function syncServiceHealth(origins) {
  const pillText = document.getElementById('suiteStatusText');
  const pillDot = document.getElementById('suiteStatusDot');
  const onlineCountEl = document.getElementById('metricOnline');

  if (isStaticBuild) {
    if (pillText) pillText.textContent = '2 SIM APPS READY';
    if (pillDot) pillDot.dataset.state = 'sim';
    if (onlineCountEl) onlineCountEl.textContent = '2 / 8';
    document.querySelectorAll('[data-service-badge]').forEach((el) => {
      el.dataset.status = 'standby';
      el.querySelector('span').textContent = 'LOCAL ONLY';
    });
    return;
  }

  const [gwUp, brUp] = await Promise.all([
    probeEndpoint(`${origins.gateway}/api/v1/health`),
    probeEndpoint(`${origins.bridge}/health`),
  ]);

  const statusMap = { gateway: gwUp, bridge: brUp };
  let onlineApps = 2; // Upper-Body Sim & Full-Body Cockpit on same origin are always ready

  document.querySelectorAll('[data-service-badge]').forEach((badge) => {
    const svc = badge.dataset.serviceBadge;
    const up = Boolean(statusMap[svc]);
    if (up) onlineApps += 1;
    badge.dataset.status = up ? 'online' : 'standby';
    const lbl = badge.querySelector('span');
    if (lbl) lbl.textContent = up ? 'ONLINE' : 'STANDBY';
  });

  if (pillText) pillText.textContent = `${onlineApps} / 8 APPS ONLINE`;
  if (pillDot) pillDot.dataset.state = gwUp || brUp ? 'online' : 'sim';
  if (onlineCountEl) onlineCountEl.textContent = `${onlineApps} / 8`;
}

/* ------------------------------------ 6. Quick Keyboard Launch (1..8) */

function initKeyboardShortcuts() {
  document.querySelectorAll('a.app-card').forEach((card) => {
    card.addEventListener('click', () => {
      const name = card.querySelector('h3')?.textContent?.trim() || card.dataset.appIndex || 'app';
      metrics.track('app_launch', {
        category: 'nav',
        label: name,
        meta: { method: 'click', index: Number(card.dataset.appIndex || 0) },
      });
      void metrics.flush(true);
    });
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 8) {
      const card = document.querySelector(`a.app-card[data-app-index="${n}"]`);
      if (card?.href) {
        const name = card.querySelector('h3')?.textContent?.trim() || `app_${n}`;
        metrics.track('app_launch', { category: 'nav', label: name, meta: { method: 'keyboard', index: n } });
        void metrics.flush(true);
        if (card.target === '_blank') window.open(card.href, '_blank', 'noopener');
        else window.location.href = card.href;
      }
    }
  });
}

/* -------------------------------------------------------------- Boot */

initWordReveals();
initCardReveals();
initCardSpotlights();
initVisorAnimation();
const origins = resolveServiceUrls();
void syncServiceHealth(origins);
initKeyboardShortcuts();
