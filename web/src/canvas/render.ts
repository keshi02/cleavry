// Canvas rendering + viewport math.
//
// Owns the DOM references for the workspace canvas, its CSS transform
// wrapper, the rect-selection overlay, and the brush-radius cursor.
// Exposes rendering primitives (redraw, applyTransform, drawRectOverlay)
// and viewport helpers (fitToScreen, actualSize, screenToImage,
// updateCursor).
//
// Side effects that aren't strictly rendering (refreshing tool buttons
// when a rect is cleared, drawing the component overlay on top of the
// transformed canvas) are injected via setRenderHooks().

import { state } from '../state';
import { $ } from '../utils/dom';
import { clamp } from '../utils/clamp';

export const canvas = $<HTMLCanvasElement>('canvas');
export const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
export const canvasWrap = $('canvas-wrap');
export const workspace = $('workspace');
export const cursor = $('cursor-overlay');
export const rectOverlay = $<HTMLCanvasElement>('rect-overlay');
const rectOverlayCtx = rectOverlay.getContext('2d')!;

interface RenderHooks {
  refreshToolButtons?: () => void;
  drawComponentOverlay?: () => void;
}
let hooks: RenderHooks = {};

export function setRenderHooks(h: RenderHooks): void {
  hooks = h;
}

export function redraw(): void {
  if (!state.workData) return;
  ctx.putImageData(
    new ImageData(state.workData as Uint8ClampedArray<ArrayBuffer>, state.imgW, state.imgH),
    0, 0,
  );
  applyTransform();
}

export function applyTransform(): void {
  canvasWrap.style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  canvasWrap.style.width = state.imgW + 'px';
  canvasWrap.style.height = state.imgH + 'px';
  if (state.separateMode || state.cleanupMode) hooks.drawComponentOverlay?.();
  if (state.rectSelection) drawRectOverlay();
}

export function drawRectOverlay(): void {
  if (!state.rectSelection || !state.imgW) {
    rectOverlay.classList.remove('show');
    return;
  }
  rectOverlay.width = state.imgW;
  rectOverlay.height = state.imgH;
  rectOverlay.classList.add('show');

  const c = rectOverlayCtx;
  c.clearRect(0, 0, state.imgW, state.imgH);

  const { minX, minY, maxX, maxY } = state.rectSelection;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  // Highlight the active region (inside or outside the rect).
  if (state.rectInverse) {
    c.fillStyle = 'rgba(220, 70, 70, 0.12)';
    c.fillRect(0, 0, state.imgW, state.imgH);
    c.clearRect(minX, minY, w, h);
  } else {
    c.fillStyle = 'rgba(124, 209, 124, 0.14)';
    c.fillRect(minX, minY, w, h);
  }

  const lineW = Math.max(0.5, 2 / state.zoom);
  const dash = Math.max(2, 8 / state.zoom);
  const gap  = Math.max(1, 4 / state.zoom);
  c.lineWidth = lineW;
  c.strokeStyle = state.rectInverse ? '#dc4646' : '#3aa55a';
  c.setLineDash([dash, gap]);
  c.strokeRect(minX + lineW / 2, minY + lineW / 2,
               Math.max(0, w - lineW), Math.max(0, h - lineW));
  c.setLineDash([]);
}

export function clearRectSelection(): void {
  state.rectSelection = null;
  state.rectDragStart = null;
  drawRectOverlay();
  hooks.refreshToolButtons?.();
}

export function fitToScreen(updateStatus?: () => void): void {
  if (!state.imgW) return;
  const r = workspace.getBoundingClientRect();
  const margin = 40;
  state.zoom = Math.min(
    (r.width - margin) / state.imgW,
    (r.height - margin) / state.imgH,
  );
  state.zoom = clamp(state.zoom, 0.05, 16);
  state.panX = (r.width - state.imgW * state.zoom) / 2;
  state.panY = (r.height - state.imgH * state.zoom) / 2;
  applyTransform();
  updateStatus?.();
}

export function actualSize(updateStatus?: () => void): void {
  if (!state.imgW) return;
  const r = workspace.getBoundingClientRect();
  state.zoom = 1;
  state.panX = (r.width - state.imgW) / 2;
  state.panY = (r.height - state.imgH) / 2;
  applyTransform();
  updateStatus?.();
}

export function screenToImage(screenX: number, screenY: number): { x: number; y: number } {
  const r = workspace.getBoundingClientRect();
  const x = (screenX - r.left - state.panX) / state.zoom;
  const y = (screenY - r.top  - state.panY) / state.zoom;
  return { x, y };
}

export function updateCursor(screenX: number, screenY: number): void {
  if (!state.workData) {
    cursor.style.display = 'none';
    return;
  }
  if (state.isPanning || state.spaceHeld || state.separateMode || state.cleanupMode) {
    cursor.style.display = 'none';
    return;
  }
  // The brush-radius circle only makes sense for the painting tools. Wand
  // and rect-select operate per-click / per-drag so the circle is noise.
  if (state.tool !== 'erase' && state.tool !== 'restore') {
    cursor.style.display = 'none';
    return;
  }
  // pointermove is bound on window, so the cursor can sit on the toolbar
  // / status bar / outside the page — don't draw the brush ring there.
  const r = workspace.getBoundingClientRect();
  if (screenX < r.left || screenX > r.right || screenY < r.top || screenY > r.bottom) {
    cursor.style.display = 'none';
    return;
  }
  cursor.style.display = 'block';
  cursor.style.left = (screenX - r.left) + 'px';
  cursor.style.top  = (screenY - r.top) + 'px';
  const screenSize = state.brushSize * state.zoom * 2;
  cursor.style.width = screenSize + 'px';
  cursor.style.height = screenSize + 'px';
  // Reaching here means tool is 'erase' or 'restore' (others returned above).
  cursor.style.borderColor = state.tool === 'restore' ? '#7cd17c' : '#fff';
  cursor.classList.toggle('is-restore', state.tool === 'restore');
}
