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
  injectDebugStrip();
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
  console.log('[mobileDock] iOS detected:', isIOSPlatform, 'UA:', ua.slice(0, 80));
}

// Tag the .group that wraps the .tool-btns container so the mobile
// CSS can target it via a plain class rather than `:has(> .tool-btns)`.
// Field reports indicate `:has()` styling occasionally fails to update
// when a body-class state changes on certain iOS Safari builds; a
// plain class selector is rock-solid.
// ★ DEBUG: Inserts an unconditional bright red strip at the same
// position the dock should occupy. If the user sees the red strip
// but not the dock, the issue is the dock element's styling. If
// the user doesn't see the red strip either, then `position:fixed;
// bottom:80px` itself isn't working in this context — meaning the
// containing block isn't the viewport (some ancestor with transform
// or filter), or the element is being clipped, or layout is broken.
function injectDebugStrip(): void {
  const strip = document.createElement('div');
  strip.id = 'mobile-dock-debug-strip';
  strip.style.cssText = [
    'position: fixed',
    'bottom: 80px',
    'left: 0',
    'right: 0',
    'height: 24px',
    'background: #ff0000',
    'z-index: 9999',
    'pointer-events: none',
    'border-top: 4px solid #ffff00',
    'border-bottom: 4px solid #ffff00',
  ].join(';');
  strip.textContent = 'DEBUG STRIP @ bottom:80px';
  strip.style.color = '#ffffff';
  strip.style.fontSize = '12px';
  strip.style.lineHeight = '24px';
  strip.style.textAlign = 'center';
  document.body.appendChild(strip);
}

function tagToolDock(): void {
  const toolBtns = document.querySelector<HTMLElement>('#toolbar .tool-btns');
  console.log('[mobileDock] tool-btns found:', !!toolBtns);
  const group = toolBtns?.parentElement;
  console.log('[mobileDock] parent:', group?.tagName, '/', group?.className);
  if (group) {
    group.classList.add('mobile-tool-dock');
    // Re-parent to <body> so iOS Safari's containing-block bug for
    // position:fixed inside `overflow: auto` ancestors (here, #toolbar)
    // can't drag the dock back into the toolbar's coordinate system.
    // Tool buttons keep their click handlers (event listeners follow
    // the element across moves) so no other wiring needs to change.
    document.body.appendChild(group);
    console.log('[mobileDock] tagged + re-parented. classes now:', group.className);
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
    gap = Math.max(0, window.innerHeight - (vv.height + vv.offsetTop));
  }
  if (isIOSPlatform) gap = Math.max(gap, IOS_MIN_CHROME_PX);
  document.documentElement.style.setProperty('--vv-bottom-offset', `${gap}px`);

  // Belt-and-suspenders: CSS-cascade evidence on real iPhones shows the
  // dock staying at bottom:0 even when the CSS rule should resolve to a
  // larger value (likely var() not propagating into a max() in some
  // iOS WebKit builds). Apply the bottom directly as inline style so
  // it can't be overridden by anything short of !important.
  const dock = document.querySelector<HTMLElement>('.mobile-tool-dock');
  if (dock) dock.style.bottom = `${gap}px`;
  const toggle = document.getElementById('mobile-toolbar-toggle');
  if (toggle) {
    // Toggle sits 64px above the dock's top, plus safe-area.
    // safe-area-inset-bottom isn't readable from JS, but the existing
    // CSS uses env(safe-area-inset-bottom, 0px); we approximate with a
    // separately-rendered probe to read its computed value.
    const safe = getSafeAreaInsetBottomPx();
    const collapsed = document.body.classList.contains('mobile-tools-collapsed');
    toggle.style.bottom = `${(collapsed ? 0 : 64) + safe + gap}px`;
  }

  console.log('[mobileDock] offset set to', gap, 'px; vv:', vv?.height, '/', window.innerHeight);
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
    // Re-sync inline positions so the toggle's bottom tracks the new
    // collapsed/expanded state. Without this the chevron stays where
    // it was at init time and the user sees the icon drift out of
    // sync with the dock.
    syncViewportOffset();
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
