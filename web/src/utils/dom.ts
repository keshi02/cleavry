// Tiny DOM helper used everywhere. Returns the typed HTMLElement
// (or null) for `document.getElementById(id)`. Most call sites already
// know the element exists, so they treat the return as non-null.
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// True when a UI overlay (help panel, custom modal) is on top of the
// canvas. Canvas-level inputs (wheel zoom, hot-keys) should short-circuit
// while this is true so the user's gesture doesn't bleed through.
export function isOverlayActive(): boolean {
  const help = document.getElementById('help-overlay');
  return (help?.classList.contains('show') ?? false)
    || !!document.querySelector('.app-modal-overlay');
}
