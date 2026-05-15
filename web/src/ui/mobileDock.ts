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
const COLLAPSE_KEY = 'cleavry-mobile-tools-collapsed-v3';
const LEGACY_COLLAPSE_KEYS = ['cleavry-mobile-tools-collapsed', 'cleavry-mobile-tools-collapsed-v2'];
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOL = 10;
const TIP_AUTODISMISS_MS = 2500;

export function initMobileDock(): void {
  detectIOSPlatform();
  tagToolDock();
  // setupCollapseToggle has to land BEFORE syncViewportOffset so the
  // initial body-class state (read from localStorage) is in place when
  // we compute the toggle's bottom offset. Otherwise the toggle stays
  // pinned to the "expanded" position forever and the user sees the
  // chevron drift out of sync with the dock state.
  setupCollapseToggle();
  syncViewportOffset();
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener('resize', syncViewportOffset);
    vv.addEventListener('scroll', syncViewportOffset);
  }
  window.addEventListener('resize', syncViewportOffset);
  window.addEventListener('orientationchange', syncViewportOffset);

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
}

// Tag the .group that wraps the .tool-btns container so the mobile
// CSS can target it via a plain class rather than `:has(> .tool-btns)`.
// Field reports indicate `:has()` styling occasionally fails to update
// when a body-class state changes on certain iOS Safari builds; a
// plain class selector is rock-solid.
function tagToolDock(): void {
  const toolBtns = document.querySelector<HTMLElement>('#toolbar .tool-btns');
  const group = toolBtns?.parentElement;
  if (group) {
    group.classList.add('mobile-tool-dock');
    // Re-parent to <body> so iOS Safari's containing-block bug for
    // position:fixed inside `overflow: auto` ancestors (here, #toolbar)
    // can't drag the dock back into the toolbar's coordinate system.
    // Tool buttons keep their click handlers (event listeners follow
    // the element across moves) so no other wiring needs to change.
    document.body.appendChild(group);
  }
}

function syncViewportOffset(): void {
  const vv = window.visualViewport;
  let gap = 0;
  if (vv) {
    gap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
  }
  if (isIOSPlatform) {
    // visualViewport reports the entire chrome footprint (the URL bar
    // pill plus all the empty padding around and above it). Anchoring
    // the dock to that number leaves the dock floating well above the
    // pill itself. Cap at 80px — the URL bar pill plus a small buffer
    // — so the dock sits flush with the pill top across iPhone
    // models, whether vv reports 80 or 163. Floor of 50 covers the
    // iOS WebKit case where vv returns zero.
    if (gap === 0) gap = 50;
    gap = Math.min(gap, 80);
  }
  document.documentElement.style.setProperty('--vv-bottom-offset', `${gap}px`);

  // Belt-and-suspenders: CSS-cascade evidence on real iPhones shows the
  // dock staying at bottom:0 even when the CSS rule should resolve to a
  // larger value (likely var() not propagating into a max() in some
  // iOS WebKit builds). Apply the bottom directly as inline style so
  // it can't be overridden by anything short of !important.
  const dock = document.querySelector<HTMLElement>('.mobile-tool-dock');
  const collapsed = document.body.classList.contains('mobile-tools-collapsed');
  if (dock) {
    dock.style.bottom = `${gap}px`;
    // Compute the collapse transform here so it accounts for the
    // chrome offset (`gap`) and the dock's actual rendered height.
    // The CSS rule `translateY(calc(100% + safe + 12px))` only
    // covered the dock's own height, leaving it `gap` pixels
    // shy of fully hiding when the dock was lifted above iOS
    // Safari's URL bar — which is exactly the case on phones.
    if (collapsed) {
      const dockH = dock.getBoundingClientRect().height;
      dock.style.transform = `translateY(${dockH + gap + 16}px)`;
    } else {
      dock.style.transform = 'translateY(0)';
    }
  }
  const toggle = document.getElementById('mobile-toolbar-toggle');
  if (toggle) {
    const safe = getSafeAreaInsetBottomPx();
    if (collapsed) {
      // Sit just above whatever browser chrome / home indicator
      // is at the viewport bottom.
      toggle.style.bottom = `${gap + safe}px`;
    } else {
      // Anchor the toggle's bottom edge to the dock's top edge.
      const dockH = dock ? dock.getBoundingClientRect().height : 64;
      toggle.style.bottom = `${gap + dockH}px`;
    }
  }
}

// Read env(safe-area-inset-bottom) by computing it on a hidden probe
// element. Falls back to 0 if not available.
let safeAreaProbe: HTMLElement | null = null;
function getSafeAreaInsetBottomPx(): number {
  if (!safeAreaProbe) {
    safeAreaProbe = document.createElement('div');
    safeAreaProbe.style.cssText = 'position:fixed;top:-1px;left:-1px;width:0;height:env(safe-area-inset-bottom,0px);visibility:hidden;pointer-events:none';
    document.body.appendChild(safeAreaProbe);
  }
  return safeAreaProbe.getBoundingClientRect().height || 0;
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
    // Sync once immediately so the position updates are dispatched in
    // the same frame, then again on the next frame so any layout that
    // changed because of the body-class toggle is fully resolved
    // before we measure the dock height (otherwise getBoundingClientRect
    // can return a stale value on the very click that toggles state).
    syncViewportOffset();
    requestAnimationFrame(syncViewportOffset);
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
    // Dock buttons are also targets since the dock is re-parented out
    // of #toolbar into <body> on mobile.
    const target = (e.target as HTMLElement | null)?.closest<HTMLElement>('#toolbar [data-tip], .mobile-tool-dock [data-tip]');
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
