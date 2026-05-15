// Mobile-specific helpers for the bottom tool bar:
//
//   1. visualViewport offset.
//      iOS Safari's bottom URL/tab bar lives at the layout viewport
//      bottom and overlaps `position: fixed; bottom: 0` content. The
//      layout viewport (window.innerHeight) doesn't shrink when the
//      chrome appears; the visual viewport does. We measure the gap
//      and expose it as `--vv-bottom-offset` so the bar (and the
//      collapse handle) sit above the chrome.
//
//   2. Collapse toggle.
//      `#mobile-toolbar-toggle` slides the bar off-screen via a
//      `mobile-tools-collapsed` class on <body>. State persists in
//      localStorage so a reload doesn't surprise the user.
//
//   3. Long-press tooltips.
//      Hover-based [data-tip] tooltips don't fire on touch. We add a
//      ~500ms long-press detector on toolbar buttons; while held it
//      flips the same CSS tooltip on via `.is-tip-active`, and we
//      swallow the synthesized click so the press doesn't also
//      switch tools.

// Bumped to v2 because the original key was set by users on a build
// where the toggle wired up the body class but the bar didn't actually
// move (a CSS :has() issue, fixed since). Those stale '1' values would
// hide the bar on first load under the corrected CSS — surfacing as
// "the bar isn't there on my phone". v2 starts everyone expanded; the
// old key is cleaned up below.
const COLLAPSE_KEY = 'cleavry-mobile-tools-collapsed-v2';
const LEGACY_COLLAPSE_KEYS = ['cleavry-mobile-tools-collapsed'];
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOL = 10;
const TIP_AUTODISMISS_MS = 2500;

export function initMobileDock(): void {
  detectIOSPlatform();
  tagToolDock();
  syncViewportOffset();
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', syncViewportOffset);
    vv.addEventListener('scroll', syncViewportOffset);
  }
  window.addEventListener('resize', syncViewportOffset);
  window.addEventListener('orientationchange', syncViewportOffset);

  setupCollapseToggle();
  setupLongPressTooltips();
}

let isIOSPlatform = false;
const IOS_MIN_CHROME_PX = 80;

// Tag <html> so iOS-specific rules can force a minimum bottom clearance
// even when neither visualViewport nor `100dvh` reports any chrome.
// iOS Safari with the bottom URL bar can leave both reporting zero
// while still overlaying ~60-90px of content with translucent chrome.
function detectIOSPlatform(): void {
  const ua = navigator.userAgent;
  // Match iPhone / iPod / iPad. Also catches iPadOS 13+ which masquerades
  // as Mac but exposes touch.
  isIOSPlatform = /iPad|iPhone|iPod/.test(ua)
              || (/Macintosh/.test(ua) && 'ontouchend' in document);
  if (isIOSPlatform) document.documentElement.classList.add('ios');
  console.log('[mobileDock] iOS detected:', isIOSPlatform, 'UA:', ua.slice(0, 80));
}

// Tag the .group that wraps the .tool-btns container so the mobile
// CSS can target it via a plain class rather than `:has(> .tool-btns)`.
// Field reports indicate `:has()` styling occasionally fails to update
// when a body-class state changes on certain iOS Safari builds; a
// plain class selector is rock-solid.
function tagToolDock(): void {
  const toolBtns = document.querySelector<HTMLElement>('#toolbar .tool-btns');
  console.log('[mobileDock] tool-btns found:', !!toolBtns);
  const group = toolBtns?.parentElement;
  console.log('[mobileDock] parent:', group?.tagName, '/', group?.className);
  if (group) {
    group.classList.add('mobile-tool-dock');
    console.log('[mobileDock] tagged. classes now:', group.className);
    // Measure after the next layout so we get the real applied geometry.
    requestAnimationFrame(() => {
      const rect = group.getBoundingClientRect();
      const cs = getComputedStyle(group);
      console.log('[mobileDock] geometry:', JSON.stringify({
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        innerH: window.innerHeight,
        vvH: window.visualViewport?.height,
        vvOff: window.visualViewport?.offsetTop,
        position: cs.position,
        bg: cs.backgroundColor,
        cssBottom: cs.bottom,
        transform: cs.transform,
        zIndex: cs.zIndex,
        display: cs.display,
        visibility: cs.visibility,
        collapsed: document.body.classList.contains('mobile-tools-collapsed'),
      }));
    });
  }
}

function syncViewportOffset(): void {
  const vv = window.visualViewport;
  let gap = 0;
  if (vv) {
    // window.innerHeight is the layout viewport height (constant across
    // chrome show/hide on iOS). vv.height + vv.offsetTop is where the
    // visible region ends in layout coords. Their difference is exactly
    // the browser chrome covering the bottom — when iOS bothers to
    // report it; sometimes it stays at 0 even with chrome visible.
    gap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
  }
  // iOS Safari floor: even when both visualViewport and 100dvh report
  // zero, the bottom URL bar still overlays content. Force a minimum
  // clearance so the dock is always above chrome.
  if (isIOSPlatform) gap = Math.max(gap, IOS_MIN_CHROME_PX);
  document.documentElement.style.setProperty('--vv-bottom-offset', `${gap}px`);
  console.log('[mobileDock] offset set to', gap, 'px; vv:', vv?.height, '/', window.innerHeight);
}

function setupCollapseToggle(): void {
  const toggle = document.getElementById('mobile-toolbar-toggle');
  if (!toggle) return;

  // Clear any pre-v2 keys so old stale state can't keep the bar hidden.
  try {
    for (const k of LEGACY_COLLAPSE_KEYS) localStorage.removeItem(k);
  } catch (_) { /* private mode */ }

  let initialCollapsed = false;
  try {
    initialCollapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch (_) { /* private mode */ }
  if (initialCollapsed) {
    document.body.classList.add('mobile-tools-collapsed');
    toggle.setAttribute('aria-expanded', 'false');
  }

  toggle.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('mobile-tools-collapsed');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (_) {}
  });
}

function setupLongPressTooltips(): void {
  // Only meaningful on devices without hover. The CSS media query
  // already gates the visual styling; we additionally bail on
  // non-touch pointer types so a mouse on a small window doesn't
  // trigger long-press by accident.
  let timer: number | null = null;
  let startX = 0;
  let startY = 0;
  let activeEl: HTMLElement | null = null;
  let suppressNextClick = false;

  function dismissTip(): void {
    if (activeEl) {
      activeEl.classList.remove('is-tip-active');
      activeEl = null;
    }
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('#toolbar [data-tip]');
    if (!target) return;
    dismissTip();
    startX = e.clientX;
    startY = e.clientY;
    timer = window.setTimeout(() => {
      timer = null;
      target.classList.add('is-tip-active');
      activeEl = target;
      suppressNextClick = true;
      // Auto-dismiss the tip after a beat so it doesn't linger forever
      // if the user keeps holding.
      window.setTimeout(() => {
        if (activeEl === target) dismissTip();
      }, TIP_AUTODISMISS_MS);
    }, LONG_PRESS_MS);
  }, { passive: true });

  document.addEventListener('pointermove', (e) => {
    if (timer === null) return;
    if (Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_TOL
        || Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_TOL) {
      cancelTimer();
    }
  }, { passive: true });

  document.addEventListener('pointerup', () => {
    cancelTimer();
  }, { passive: true });

  document.addEventListener('pointercancel', () => {
    cancelTimer();
    dismissTip();
  }, { passive: true });

  // Tapping elsewhere or scrolling dismisses any visible long-press tip.
  document.addEventListener('pointerdown', (e) => {
    if (!activeEl) return;
    if (!(e.target as HTMLElement | null)?.closest('.is-tip-active')) {
      dismissTip();
    }
  }, true);

  // Block the synthesized click that follows a successful long-press
  // so it doesn't also trigger the tool switch / button action.
  document.addEventListener('click', (e) => {
    if (!suppressNextClick) return;
    suppressNextClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}
