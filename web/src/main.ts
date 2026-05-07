// @ts-nocheck
// Phase A migration: this file is the original eraser.html <script> body
// moved verbatim into a TypeScript module so Vite can serve and bundle it.
// Type strictness is intentionally off-by-default until the per-section
// refactor (Phase B) can split this monolith and add real types.

import { clamp } from './utils/clamp';
import { $, isOverlayActive } from './utils/dom';
import { isMac } from './utils/platform';
import { showToast } from './ui/toast';
import { initTheme, cycleTheme } from './ui/theme';
import { showModal } from './ui/modal';
import { saveSession, loadSession, clearSession } from './persist/autosave';
import { segmentBackground } from './ai/background';
import { feather } from './image/feather';
import {
  showOriginalOverlay, hideOriginalOverlay, toggleOriginalOverlay,
  setOriginalOverlayOpacity,
} from './ui/originalOverlay';

// ── External globals ─────────────────────────────────────────────────────
// JSZip is loaded via a <script> tag in index.html. transformers.js is
// loaded dynamically inside the AI background-removal flow.
declare const JSZip: any;

// ============================================================================
// State
// ============================================================================
const state = {
  origData: null,         // Uint8ClampedArray (RGBA), unmodified source
  workData: null,         // Uint8ClampedArray (RGBA), being edited
  imgW: 0,
  imgH: 0,
  filename: '',
  tool: 'erase',          // 'erase' | 'restore' | 'wand' | 'restoreWand' | 'rectSelect'
  lastWandTool: 'wand',   // remembers last picked wand variant — keeps it
                          //   highlighted while user is in rect-select mode
  rectSelection: null,    // { minX, minY, maxX, maxY } in image coords
  rectInverse: false,     // false: wand acts inside rect; true: outside
  rectDragStart: null,    // {x, y} during a rect-select drag
  pendingWandClick: null, // {x, y} held while a wand-tool press could
                          //   still turn into a drag (rect rebuild) instead
  brushSize: 40,
  brushHardness: 70,      // 0..100
  toleranceOn: false,
  tolerance: 20,          // 0..100, percent
  undo: [],
  redo: [],
  maxUndo: 50,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDrawing: false,
  isPanning: false,
  spaceHeld: false,
  lastImgX: null,
  lastImgY: null,
  panStartScreen: null,
  panStartPos: null,
  strokeSnapshotTaken: false,
  smoothPoints: [],
  separateMode: false,
  cleanupMode: false,     // selecting connected components to keep / discard
  components: [],         // [{id, minX, minY, maxX, maxY, area, selected}]
  componentMask: null,    // Uint32Array (W*H), 0 = 背景, 1+ = 成分ID
  preserveCanvas: true,   // saves keep the original canvas size & pixel positions
  featherActive: false,   // export-time feather flag (does not mutate workData)
  featherStrength: 1,     // feather iterations: 1px / 2px / 3px
  autoCleanupThreshold: 16, // default px² for one-shot auto-cleanup
  saveFormat: 'png',      // 'png' | 'webp' | 'jpeg'
  autoSaveEnabled: true,  // overridden from localStorage on init
};
try {
  const v = localStorage.getItem('autosave-enabled');
  if (v === 'false') state.autoSaveEnabled = false;
} catch (_) {}

// ============================================================================
// DOM
// ============================================================================
const workspace = $('workspace');
const canvasWrap = $('canvas-wrap');
const canvas = $('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const cursor = $('cursor-overlay');
const dropOverlay = $('drop-overlay');
const emptyHint = $('empty-hint');
const fileInput = $('file-input');
const componentOverlay = $('component-overlay');
const overlayCtx = componentOverlay.getContext('2d');
const rectOverlay = $('rect-overlay');
const rectOverlayCtx = rectOverlay.getContext('2d');

// ============================================================================
// Helpers
// ============================================================================
function showError(msg) {
  // Fire-and-forget — caller doesn't need to await dismissal.
  showModal({
    title: 'エラー',
    message: String(msg),
    buttons: [{ label: 'OK', value: true, primary: true }],
  });
}

function updateStatus() {
  $('size-status').textContent = state.imgW
    ? `${state.imgW} × ${state.imgH} px`
    : '';
  $('zoom-status').textContent = state.imgW
    ? `${Math.round(state.zoom * 100)}%`
    : '';
  $('tool-status').textContent = ({
    erase: '消しゴム', restore: '復元', wand: 'ワンド',
    restoreWand: '復元ワンド', rectSelect: '範囲選択',
  })[state.tool] || state.tool;
  $('undo-status').textContent = state.imgW
    ? `履歴: ${state.undo.length} / ${state.maxUndo}`
    : '';
  $('save-btn').disabled = !state.workData;
  $('save-format').disabled = !state.workData;
  $('separate-btn').disabled = !state.workData;
  $('cleanup-btn').disabled = !state.workData;
  $('auto-cleanup-btn').disabled = !state.workData;
  $('ai-bg-btn').disabled = !state.workData || bgRemovalRunning;
  $('ai-input-btn').disabled = !state.workData;
  $('show-orig-btn').disabled = !state.workData;
  $('orig-opacity').disabled = !state.workData;
  $('feather-btn').disabled = !state.workData;
  $('feather-strength').disabled = !state.workData;
  $('undo-btn').disabled = state.undo.length === 0;
  $('redo-btn').disabled = state.redo.length === 0;
}

// ============================================================================
// Image loading
// ============================================================================
function loadImageFromFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showError('PNG または JPEG を選択してください');
    return;
  }
  state.filename = file.name;
  const img = new Image();
  img.onload = async () => {
    // Warn + offer downscale on huge images. Above ~16 MP everything
    // (BFS, feather, components, AI inference) gets sluggish, and 4GB
    // WASM heap can OOM. We let the user opt in either way.
    const MAX_PIXELS = 16 * 1024 * 1024;
    let useW = img.width, useH = img.height;
    if (img.width * img.height > MAX_PIXELS) {
      const ratio = Math.sqrt(MAX_PIXELS / (img.width * img.height));
      const sw = Math.floor(img.width * ratio);
      const sh = Math.floor(img.height * ratio);
      const choice = await showModal({
        title: '大きな画像です',
        message:
          `画像サイズ: ${img.width} × ${img.height}\n\n` +
          `そのまま読み込むと処理が重くなる可能性があります。\n` +
          `推奨は ${sw} × ${sh} への縮小です。`,
        buttons: [
          { label: `${sw}×${sh} に縮小`, value: 'shrink', primary: true },
          { label: 'そのまま読込', value: 'asis' },
          { label: 'キャンセル', value: 'cancel' },
        ],
      });
      if (choice === 'cancel') { URL.revokeObjectURL(img.src); return; }
      if (choice === 'shrink') { useW = sw; useH = sh; }
    }
    state.imgW = useW;
    state.imgH = useH;
    canvas.width = useW;
    canvas.height = useH;
    if (useW !== img.width || useH !== img.height) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, useW, useH);
    } else {
      ctx.drawImage(img, 0, 0);
    }
    const data = ctx.getImageData(0, 0, useW, useH);
    state.origData = new Uint8ClampedArray(data.data);
    state.workData = new Uint8ClampedArray(data.data);
    state.undo = [];
    state.redo = [];
    if (state.separateMode) exitSeparateMode();
    if (state.cleanupMode) exitCleanupMode();
    clearFeatherToggle();
    hideOriginalOverlay();
    clearRectSelection();
    setTool('erase');
    emptyHint.style.display = 'none';
    $('filename-status').textContent = state.filename;
    fitToScreen();
    redraw();
    updateStatus();
    URL.revokeObjectURL(img.src);
    // Persist immediately so a freshly-loaded image survives a reload
    // even before the user has touched it.
    scheduleAutosave();
  };
  img.onerror = () => showError('画像の読み込みに失敗しました');
  img.src = URL.createObjectURL(file);
}

// Replace the working canvas with an AI-processed version while keeping the
// original (background-included) source as `origData`. This is what powers the
// "restore what remove.bg deleted" workflow: the restore brush / restore wand
// pull pixels from origData, so anything the AI shaved off can be painted back
// from the genuine source.
function loadAIOutputFile(file) {
  if (!state.origData) {
    showError('先に元画像を読み込んでください');
    return;
  }
  if (!file || !file.type.startsWith('image/')) {
    showError('PNG または JPEG を選択してください');
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (img.width !== state.imgW || img.height !== state.imgH) {
      showError(
        `サイズが元画像と一致しません\n元: ${state.imgW}×${state.imgH}\n選択: ${img.width}×${img.height}\n` +
        '読み込んだ元画像を透過処理した画像のみ取り込めます。'
      );
      URL.revokeObjectURL(img.src);
      return;
    }
    const tmp = document.createElement('canvas');
    tmp.width = img.width;
    tmp.height = img.height;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0);
    const id = tctx.getImageData(0, 0, img.width, img.height);

    // ──────────────────────────────────────────────────────────────
    // Relevance check: confirm the chosen file really is the AI output
    // of the current original image, not a random PNG that happens to
    // share the same dimensions.
    //
    //   (B) Alpha presence — AI background removers always emit
    //       transparency. A fully-opaque image is almost certainly
    //       just another photo that happens to fit.
    //   (A) Pixel similarity in the opaque region — AI removers
    //       usually leave RGB alone, only carving alpha. So the
    //       opaque pixels of the AI output should match the *same
    //       coordinates* in the source image. We average the RGB
    //       distance there and reject if it's clearly a different
    //       picture.
    // ──────────────────────────────────────────────────────────────
    const N = img.width * img.height;
    let opaqueCount = 0;
    let transparentCount = 0;
    let totalDiff = 0;
    const aiData = id.data;
    const orig = state.origData;
    for (let i = 0; i < N; i++) {
      const a = aiData[i * 4 + 3];
      if (a === 0) transparentCount++;
      if (a >= 128) {
        opaqueCount++;
        const dr = orig[i * 4]     - aiData[i * 4];
        const dg = orig[i * 4 + 1] - aiData[i * 4 + 1];
        const db = orig[i * 4 + 2] - aiData[i * 4 + 2];
        totalDiff += Math.sqrt(dr * dr + dg * dg + db * db);
      }
    }

    if (transparentCount === 0) {
      showError(
        '透過情報がありません\n' +
        'この画像は透過処理されていません。\n' +
        '透明ピクセルを含む PNG を選択してください。'
      );
      URL.revokeObjectURL(img.src);
      return;
    }
    if (opaqueCount === 0) {
      showError(
        '中身がありません\n完全に透明な画像のため取り込めません。'
      );
      URL.revokeObjectURL(img.src);
      return;
    }

    const SIMILARITY_THRESHOLD = 50;  // 0..441 (RGB distance)
    const avgDiff = totalDiff / opaqueCount;
    if (avgDiff > SIMILARITY_THRESHOLD) {
      showError(
        '元画像と関連性が低いようです\n' +
        '読み込んだ元画像を透過処理した画像のみ取り込めます。'
      );
      URL.revokeObjectURL(img.src);
      return;
    }

    if (state.separateMode) exitSeparateMode();
    if (state.cleanupMode) exitCleanupMode();
    pushUndo();
    state.workData = new Uint8ClampedArray(id.data);
    redraw();
    updateStatus();
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => showError('画像の読み込みに失敗しました');
  img.src = URL.createObjectURL(file);
}

function redraw() {
  if (!state.workData) return;
  const id = new ImageData(state.workData, state.imgW, state.imgH);
  ctx.putImageData(id, 0, 0);
  applyTransform();
}

function applyTransform() {
  canvasWrap.style.transform =
    `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  canvasWrap.style.width = state.imgW + 'px';
  canvasWrap.style.height = state.imgH + 'px';
  if (state.separateMode) drawComponentOverlay();
  if (state.rectSelection) drawRectOverlay();
}

// ── Rect-selection overlay ──────────────────────────────────────────
function drawRectOverlay() {
  if (!state.rectSelection || !state.imgW) {
    rectOverlay.classList.remove('show');
    return;
  }
  rectOverlay.width = state.imgW;
  rectOverlay.height = state.imgH;
  rectOverlay.classList.add('show');

  const ctx = rectOverlayCtx;
  ctx.clearRect(0, 0, state.imgW, state.imgH);

  const { minX, minY, maxX, maxY } = state.rectSelection;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;

  // Highlight the active region (inside or outside the rect).
  if (state.rectInverse) {
    ctx.fillStyle = 'rgba(220, 70, 70, 0.12)';
    ctx.fillRect(0, 0, state.imgW, state.imgH);
    ctx.clearRect(minX, minY, w, h);
  } else {
    ctx.fillStyle = 'rgba(124, 209, 124, 0.14)';
    ctx.fillRect(minX, minY, w, h);
  }

  // Dashed border.
  const lineW = Math.max(0.5, 2 / state.zoom);
  const dash = Math.max(2, 8 / state.zoom);
  const gap  = Math.max(1, 4 / state.zoom);
  ctx.lineWidth = lineW;
  ctx.strokeStyle = state.rectInverse ? '#dc4646' : '#3aa55a';
  ctx.setLineDash([dash, gap]);
  ctx.strokeRect(minX + lineW / 2, minY + lineW / 2,
                 Math.max(0, w - lineW), Math.max(0, h - lineW));
  ctx.setLineDash([]);
}

function clearRectSelection() {
  state.rectSelection = null;
  state.rectDragStart = null;
  drawRectOverlay();
  // Rect-select button stops being "armed" once the rect is gone.
  refreshToolButtonsActive();
}

// Returns true when (px, py) should be processable under the current
// rectangle restriction. No restriction → always true. Inside mode → only
// pixels inside the rect. Outside mode → only pixels outside.
function rectAllows(px, py) {
  const r = state.rectSelection;
  if (!r) return true;
  const inside = px >= r.minX && px <= r.maxX && py >= r.minY && py <= r.maxY;
  return state.rectInverse ? !inside : inside;
}

function fitToScreen() {
  if (!state.imgW) return;
  const r = workspace.getBoundingClientRect();
  const margin = 40;
  state.zoom = Math.min(
    (r.width - margin) / state.imgW,
    (r.height - margin) / state.imgH
  );
  state.zoom = clamp(state.zoom, 0.05, 16);
  state.panX = (r.width - state.imgW * state.zoom) / 2;
  state.panY = (r.height - state.imgH * state.zoom) / 2;
  applyTransform();
  updateStatus();
}

function actualSize() {
  if (!state.imgW) return;
  const r = workspace.getBoundingClientRect();
  state.zoom = 1;
  state.panX = (r.width - state.imgW) / 2;
  state.panY = (r.height - state.imgH) / 2;
  applyTransform();
  updateStatus();
}

// ============================================================================
// Coordinates
// ============================================================================
function screenToImage(screenX, screenY) {
  const r = workspace.getBoundingClientRect();
  const x = (screenX - r.left - state.panX) / state.zoom;
  const y = (screenY - r.top  - state.panY) / state.zoom;
  return { x, y };
}

function updateCursor(screenX, screenY) {
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
  // Now that pointermove is bound on window, the pointer can sit on the
  // toolbar / status bar / outside the page — don't draw the brush ring there.
  const r = workspace.getBoundingClientRect();
  if (screenX < r.left || screenX > r.right || screenY < r.top || screenY > r.bottom) {
    cursor.style.display = 'none';
    return;
  }
  cursor.style.display = 'block';
  cursor.style.left = (screenX - r.left) + 'px';
  cursor.style.top  = (screenY - r.top) + 'px';
  const screenSize = state.brushSize * state.zoom * 2;  // diameter
  cursor.style.width = screenSize + 'px';
  cursor.style.height = screenSize + 'px';
  cursor.style.borderColor =
    (state.tool === 'restore' || state.tool === 'restoreWand') ? '#7cd17c' : '#fff';
  cursor.classList.toggle('is-restore', state.tool === 'restore');
}

// ============================================================================
// Undo / Redo
// ============================================================================
function clearFeatherToggle() {
  if (!state.featherActive) return;
  state.featherActive = false;
  $('feather-btn').classList.remove('active');
}

function pushUndo() {
  state.undo.push(new Uint8ClampedArray(state.workData));
  if (state.undo.length > state.maxUndo) state.undo.shift();
  state.redo = [];
  updateStatus();
  scheduleAutosave();
}

function undo() {
  if (state.undo.length === 0) return;
  if (state.separateMode) exitSeparateMode();  // mask becomes stale
  if (state.cleanupMode) exitCleanupMode();
  state.redo.push(new Uint8ClampedArray(state.workData));
  state.workData = state.undo.pop();
  redraw();
  updateStatus();
  scheduleAutosave();
}

function redoFn() {
  if (state.redo.length === 0) return;
  if (state.separateMode) exitSeparateMode();
  if (state.cleanupMode) exitCleanupMode();
  state.undo.push(new Uint8ClampedArray(state.workData));
  state.workData = state.redo.pop();
  redraw();
  updateStatus();
  scheduleAutosave();
}

// ============================================================================
// Brush — apply at a single point
// ============================================================================
function colorMatches(idx, refR, refG, refB) {
  const dr = state.workData[idx]   - refR;
  const dg = state.workData[idx+1] - refG;
  const db = state.workData[idx+2] - refB;
  const d2 = dr * dr + dg * dg + db * db;
  // Tolerance percent of max possible distance (~441)
  const max = (state.tolerance / 100) * 441;
  return d2 <= max * max;
}

function applyBrushDab(cx, cy, sampleColor) {
  const r = state.brushSize;
  const r2 = r * r;
  const hardness = state.brushHardness / 100;
  const innerR = r * hardness;          // fully-applied radius
  const featherSpan = r - innerR;       // falloff zone

  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(state.imgW - 1, Math.ceil(cx + r));
  const y1 = Math.min(state.imgH - 1, Math.ceil(cy + r));

  const data = state.workData;
  const orig = state.origData;
  const W = state.imgW;
  const isErase = state.tool === 'erase';
  const useTol = state.toleranceOn && sampleColor;

  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const dist2 = dx*dx + dy*dy;
      if (dist2 > r2) continue;
      const dist = Math.sqrt(dist2);
      let factor;
      if (dist <= innerR) {
        factor = 1;
      } else if (featherSpan > 0) {
        const t = (dist - innerR) / featherSpan;
        // Smooth cosine falloff: nicer than linear
        factor = 0.5 + 0.5 * Math.cos(t * Math.PI);
      } else {
        factor = 0;
      }
      const idx = (py * W + px) * 4;
      if (useTol) {
        if (!colorMatches(idx, sampleColor.r, sampleColor.g, sampleColor.b)) continue;
      }
      if (isErase) {
        const oldA = data[idx + 3];
        const newA = oldA * (1 - factor);
        if (newA < oldA) data[idx + 3] = newA | 0;
      } else {
        // restore — lerp toward original RGBA
        for (let k = 0; k < 4; k++) {
          const od = data[idx + k];
          const og = orig[idx + k];
          data[idx + k] = (od + (og - od) * factor) | 0;
        }
      }
    }
  }
}

// ============================================================================
// Stroke — interpolate between two points
// ============================================================================
function applyStroke(x0, y0, x1, y1, sampleColor) {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.sqrt(dx*dx + dy*dy);
  const stepSize = Math.max(0.5, state.brushSize * 0.25);
  const steps = Math.max(1, Math.ceil(dist / stepSize));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    applyBrushDab(x0 + dx*t, y0 + dy*t, sampleColor);
  }
}

// True while AI background removal is in flight. Used by updateStatus()
// to disable the AI button so the user can't double-fire it.
let bgRemovalRunning = false;

// Cmd+Z / Cmd+Shift+Z auto-repeat governor (~12 ops/sec).
let lastUndoKeyTime = 0;
const UNDO_KEY_THROTTLE_MS = 80;

// [ / ] brush-size accelerator. Holding the key produces faster steps over
// time so users can sweep across the full 1-300 range without RSI, while
// single taps still nudge by exactly 1 px.
const brushKeyAccel = { lastTime: 0, lastDir: 0, runLength: 0 };

// ============================================================================
// Magic wand — async chunked BFS so the UI never freezes
// ============================================================================
let wandJob = null;        // current async job; cancellable via ESC
const progressOverlay = $('progress-overlay');
const progressFill    = $('progress-fill');
const progressTitle   = $('progress-title');

function showProgress(label) {
  progressTitle.textContent = label || 'マジックワンド処理中…';
  progressFill.style.width = '0%';
  progressOverlay.classList.add('show');
}
function updateProgress(percent) {
  progressFill.style.width = percent + '%';
}
function hideProgress() {
  progressOverlay.classList.remove('show');
}

function cancelWand() {
  if (wandJob) wandJob.cancelled = true;
}

function magicWandAt(ix, iy) {
  if (!state.workData) return;
  if (wandJob) return;     // ignore re-entry while one is running

  // If the rect-select tool is the current tool but no rect has been
  // drawn yet, the user has explicitly armed a scope without specifying
  // it — don't quietly fall through to a full-canvas wand.
  if (state.tool === 'rectSelect' && !state.rectSelection) return;

  const px0 = Math.floor(ix), py0 = Math.floor(iy);
  if (px0 < 0 || py0 < 0 || px0 >= state.imgW || py0 >= state.imgH) return;
  const W = state.imgW, H = state.imgH;
  const isRestore = state.tool === 'restoreWand';
  // Restore-wand groups by *original* color (the source artwork). Erase-wand
  // groups by *current* color so it can keep eating into a region after
  // partial edits. Both share the same BFS skeleton.
  const refData = isRestore ? state.origData : state.workData;
  const startIdx = (py0 * W + px0) * 4;
  if (isRestore && refData[startIdx + 3] === 0) {
    // No source pixel here — nothing to restore.
    return;
  }
  // Erase-wand on an already-transparent pixel is a no-op (and would
  // expand into the rest of the transparent region by color match,
  // which is never useful). Bail out silently.
  if (!isRestore && state.workData[startIdx + 3] === 0) {
    return;
  }
  // Respect any rect-selection: bail if the seed point is outside the
  // allowed region. The BFS itself will also be confined by rectAllows
  // when it queues neighbours.
  if (!rectAllows(px0, py0)) {
    return;
  }
  const r0 = refData[startIdx];
  const g0 = refData[startIdx + 1];
  const b0 = refData[startIdx + 2];
  const tolMax = (state.tolerance / 100) * 441;
  const tolMax2 = tolMax * tolMax;

  // Capture the rect-restriction once so the hot BFS loop can inline the
  // bounds check without repeated property lookups.
  const _rect = state.rectSelection;
  const hasRect = !!_rect;
  const rInv = state.rectInverse;
  const rMinX = hasRect ? _rect.minX : 0;
  const rMinY = hasRect ? _rect.minY : 0;
  const rMaxX = hasRect ? _rect.maxX : 0;
  const rMaxY = hasRect ? _rect.maxY : 0;

  // Snapshot for undo BEFORE mutating, and keep it locally so we can roll
  // back on cancel without polluting redo stack.
  const snapshot = new Uint8ClampedArray(state.workData);

  const visited = new Uint8Array(W * H);
  // visited-at-push means each pixel enters the stack at most once → W*H entries
  // (each entry = 2 slots for x,y) is the exact upper bound. No overflow.
  const stack = new Int32Array(W * H * 2);
  let sp = 0;
  stack[sp++] = px0;
  stack[sp++] = py0;
  visited[py0 * W + px0] = 1;

  const totalPixels = W * H;
  let processedPixels = 0;

  const job = { cancelled: false };
  wandJob = job;
  showProgress(isRestore ? '復元ワンド処理中…' : 'マジックワンド処理中…');

  function step() {
    if (job.cancelled) {
      // Roll back: restore the pre-wand snapshot
      state.workData = snapshot;
      redraw();
      hideProgress();
      wandJob = null;
      return;
    }

    const startTime = performance.now();
    const FRAME_BUDGET_MS = 14;   // leave room for redraw + browser

    // Localise hot-loop refs for speed
    const data = state.workData;
    const orig = state.origData;
    while (sp > 0 && performance.now() - startTime < FRAME_BUDGET_MS) {
      const y = stack[--sp];
      const x = stack[--sp];
      const pi = y * W + x;
      const di = pi * 4;
      // For restore-wand, transparent source pixels can't match — skip them
      // before the (cheap) color test so we don't bleed into empty areas.
      if (isRestore && refData[di + 3] === 0) continue;
      const dr = refData[di]     - r0;
      const dg = refData[di + 1] - g0;
      const db = refData[di + 2] - b0;
      if (dr*dr + dg*dg + db*db > tolMax2) continue;
      if (isRestore) {
        data[di]     = orig[di];
        data[di + 1] = orig[di + 1];
        data[di + 2] = orig[di + 2];
        data[di + 3] = orig[di + 3];
      } else {
        data[di + 3] = 0;
      }
      processedPixels++;

      if (x + 1 < W) {
        const ni = pi + 1;
        if (!visited[ni] && (!hasRect || (rInv ? !(x + 1 >= rMinX && x + 1 <= rMaxX && y >= rMinY && y <= rMaxY) : (x + 1 >= rMinX && x + 1 <= rMaxX && y >= rMinY && y <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x + 1; stack[sp++] = y;
        }
      }
      if (x > 0) {
        const ni = pi - 1;
        if (!visited[ni] && (!hasRect || (rInv ? !(x - 1 >= rMinX && x - 1 <= rMaxX && y >= rMinY && y <= rMaxY) : (x - 1 >= rMinX && x - 1 <= rMaxX && y >= rMinY && y <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x - 1; stack[sp++] = y;
        }
      }
      if (y + 1 < H) {
        const ni = pi + W;
        if (!visited[ni] && (!hasRect || (rInv ? !(x >= rMinX && x <= rMaxX && y + 1 >= rMinY && y + 1 <= rMaxY) : (x >= rMinX && x <= rMaxX && y + 1 >= rMinY && y + 1 <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x;     stack[sp++] = y + 1;
        }
      }
      if (y > 0) {
        const ni = pi - W;
        if (!visited[ni] && (!hasRect || (rInv ? !(x >= rMinX && x <= rMaxX && y - 1 >= rMinY && y - 1 <= rMaxY) : (x >= rMinX && x <= rMaxX && y - 1 >= rMinY && y - 1 <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x;     stack[sp++] = y - 1;
        }
      }
    }

    // Progress: roughly fraction of stack processed vs max possible
    updateProgress(Math.min(99, (processedPixels / totalPixels) * 100));
    redraw();

    if (sp === 0) {
      // Done — commit to undo stack via standard path. We push the
      // *snapshot* (pre-wand state) directly instead of calling
      // pushUndo(), because pushUndo() would snapshot the *current*
      // (post-wand) workData and undo wouldn't have anywhere to roll
      // back to. We still need to fire scheduleAutosave() ourselves
      // since we bypassed pushUndo's normal autosave hook.
      state.undo.push(snapshot);
      if (state.undo.length > state.maxUndo) state.undo.shift();
      state.redo = [];
      hideProgress();
      wandJob = null;
      updateStatus();
      scheduleAutosave();
      return;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ============================================================================
// Pointer events
// ============================================================================
function onPointerDown(e) {
  if (!state.workData) return;
  if (e.button !== 0 && e.button !== 1) return;

  // Hard reset of any stale drag state from a previous gesture that lost
  // its pointerup (e.g. the cursor crossed the toolbar / window blur).
  state.isPanning = false;
  state.isDrawing = false;
  workspace.classList.remove('panning');

  // Pan: middle button OR space-held
  if (e.button === 1 || state.spaceHeld) {
    state.isPanning = true;
    state.panStartScreen = { x: e.clientX, y: e.clientY };
    state.panStartPos    = { x: state.panX,  y: state.panY };
    workspace.classList.add('panning');
    e.preventDefault();
    return;
  }

  const { x, y } = screenToImage(e.clientX, e.clientY);

  // Component-picking modes: left-click toggles the component under the cursor.
  if (state.separateMode || state.cleanupMode) {
    const px = Math.floor(x), py = Math.floor(y);
    if (px >= 0 && py >= 0 && px < state.imgW && py < state.imgH) {
      const id = state.componentMask[py * state.imgW + px];
      if (id !== 0) {
        const comp = state.components.find(c => c.id === id);
        if (comp) {
          comp.selected = !comp.selected;
          drawComponentOverlay();
          if (state.separateMode) updateSeparateInfo();
          else updateCleanupInfo();
        }
      }
    }
    e.preventDefault();
    return;
  }

  if (state.tool === 'wand' || state.tool === 'restoreWand') {
    // Hold off on firing the wand: if the user starts dragging, we
    // reinterpret the press as a rect rebuild. A plain click (no drag)
    // falls through to the wand on pointerup.
    const cx = clamp(x, 0, state.imgW - 1);
    const cy = clamp(y, 0, state.imgH - 1);
    state.rectDragStart = { x: cx, y: cy };
    state.pendingWandClick = { x, y };
    state.isDrawing = true;
    e.preventDefault();
    return;
  }

  // Rectangle-selection drag start.
  if (state.tool === 'rectSelect') {
    const cx = clamp(x, 0, state.imgW - 1);
    const cy = clamp(y, 0, state.imgH - 1);
    state.rectDragStart = { x: cx, y: cy };
    state.rectSelection = { minX: cx, minY: cy, maxX: cx, maxY: cy };
    state.isDrawing = true;
    drawRectOverlay();
    e.preventDefault();
    return;
  }

  // Begin stroke
  state.isDrawing = true;
  state.smoothPoints = [];
  pushUndo();
  // Sample color at start for tolerance
  let sample = null;
  if (state.toleranceOn) {
    const px = clamp(Math.floor(x), 0, state.imgW - 1);
    const py = clamp(Math.floor(y), 0, state.imgH - 1);
    const di = (py * state.imgW + px) * 4;
    sample = { r: state.workData[di], g: state.workData[di+1], b: state.workData[di+2] };
  }
  state.strokeSampleColor = sample;
  applyBrushDab(x, y, sample);
  state.lastImgX = x;
  state.lastImgY = y;
  redraw();
  e.preventDefault();
}

function onPointerMove(e) {
  updateCursor(e.clientX, e.clientY);

  if (state.isPanning) {
    const dx = e.clientX - state.panStartScreen.x;
    const dy = e.clientY - state.panStartScreen.y;
    state.panX = state.panStartPos.x + dx;
    state.panY = state.panStartPos.y + dy;
    applyTransform();
    return;
  }

  if (!state.isDrawing) return;

  // Wand tool with a pending click: convert it into a rect drag once the
  // pointer has moved past the click threshold. Below that we just sit
  // tight — the user might still let go without dragging.
  if (state.pendingWandClick) {
    const { x: dx, y: dy } = screenToImage(e.clientX, e.clientY);
    const cx = clamp(dx | 0, 0, state.imgW - 1);
    const cy = clamp(dy | 0, 0, state.imgH - 1);
    const start = state.rectDragStart;
    const moveDist2 = (cx - start.x) ** 2 + (cy - start.y) ** 2;
    const DRAG_THR = 4;
    if (moveDist2 >= DRAG_THR * DRAG_THR) {
      state.pendingWandClick = null;
      state.rectSelection = {
        minX: Math.min(start.x, cx),
        minY: Math.min(start.y, cy),
        maxX: Math.max(start.x, cx),
        maxY: Math.max(start.y, cy),
      };
      drawRectOverlay();
      refreshToolButtonsActive();
    }
    return;
  }

  // Rectangle-selection (or a wand-promoted rect drag): update the rect
  // to the current pointer position.
  const isRectDrag = state.tool === 'rectSelect'
    || ((state.tool === 'wand' || state.tool === 'restoreWand')
        && state.rectDragStart && state.rectSelection);
  if (isRectDrag) {
    const { x: dx, y: dy } = screenToImage(e.clientX, e.clientY);
    const cx = clamp(dx | 0, 0, state.imgW - 1);
    const cy = clamp(dy | 0, 0, state.imgH - 1);
    const start = state.rectDragStart;
    state.rectSelection = {
      minX: Math.min(start.x, cx),
      minY: Math.min(start.y, cy),
      maxX: Math.max(start.x, cx),
      maxY: Math.max(start.y, cy),
    };
    drawRectOverlay();
    return;
  }

  // Pointer-event coordinates can jitter at high sample rates and produce
  // visible stair-stepping under the brush. Average the latest 3 raw points
  // (weighted to the newest) so the painted stroke follows the *intended*
  // trajectory instead of the noisy cursor data.
  const { x: rawX, y: rawY } = screenToImage(e.clientX, e.clientY);
  state.smoothPoints.push({ x: rawX, y: rawY });
  if (state.smoothPoints.length > 3) state.smoothPoints.shift();
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < state.smoothPoints.length; i++) {
    const w = i + 1;
    sx += state.smoothPoints[i].x * w;
    sy += state.smoothPoints[i].y * w;
    sw += w;
  }
  const x = sx / sw, y = sy / sw;

  if (state.lastImgX !== null) {
    applyStroke(state.lastImgX, state.lastImgY, x, y, state.strokeSampleColor);
  } else {
    applyBrushDab(x, y, state.strokeSampleColor);
  }
  state.lastImgX = x;
  state.lastImgY = y;
  redraw();
}

function onPointerUp(e) {
  if (state.isPanning) {
    state.isPanning = false;
    workspace.classList.remove('panning');
  }
  if (state.isDrawing) {
    const wasBrushTool = state.tool === 'erase' || state.tool === 'restore';
    state.isDrawing = false;
    state.lastImgX = state.lastImgY = null;

    // Wand tool: a press that never crossed the drag threshold is a real
    // click — fire the wand now, where the original press happened.
    if (state.pendingWandClick) {
      const { x: ix, y: iy } = state.pendingWandClick;
      state.pendingWandClick = null;
      state.rectDragStart = null;
      magicWandAt(ix, iy);
      return;
    }

    // Finalize a rect drag — either from rect-select tool or from a
    // wand tool press that promoted into a drag. Tiny rects collapse to
    // no-op; rect-select hands control back to the wand it came from;
    // a wand-promoted drag is already in the wand tool, so just refresh
    // the button highlights.
    const wasWandPromotedDrag = (state.tool === 'wand' || state.tool === 'restoreWand')
      && state.rectDragStart && state.rectSelection;
    if ((state.tool === 'rectSelect' || wasWandPromotedDrag) && state.rectSelection) {
      const { minX, minY, maxX, maxY } = state.rectSelection;
      if (maxX - minX < 4 || maxY - minY < 4) {
        clearRectSelection();
      } else if (state.tool === 'rectSelect') {
        setTool(state.lastWandTool);
      } else {
        refreshToolButtonsActive();
      }
      state.rectDragStart = null;
    }
    // pushUndo only fires at the START of a brush stroke; trigger autosave
    // again at the END so all the painted pixels actually get persisted.
    if (wasBrushTool) scheduleAutosave();
  }
}

// ============================================================================
// Wheel zoom — centered at cursor
// ============================================================================
function onWheel(e) {
  if (!state.workData) return;
  // Don't zoom the canvas while an overlay (help panel, custom modal) is on
  // top — wheel events bubble up from those layers since they live inside
  // #workspace, and we want the user to scroll the help-box content (or
  // simply do nothing) instead of moving the image behind the overlay.
  if (isOverlayActive()) return;
  e.preventDefault();
  const r = workspace.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  // Zoom factor: smooth via deltaY
  const factor = Math.exp(-e.deltaY * 0.0015);
  const newZoom = clamp(state.zoom * factor, 0.05, 32);
  // Keep image point under cursor stable
  const ratio = newZoom / state.zoom;
  state.panX = cx - (cx - state.panX) * ratio;
  state.panY = cy - (cy - state.panY) * ratio;
  state.zoom = newZoom;
  applyTransform();
  updateCursor(e.clientX, e.clientY);
  updateStatus();
}

// ============================================================================
// Connected components / Separate-save mode
// ============================================================================
const SEPARATE_MIN_AREA = 4;   // ignore noise specks smaller than this

function detectComponents() {
  const W = state.imgW, H = state.imgH;
  const data = state.workData;
  const mask = new Uint32Array(W * H);
  const components = [];
  let nextId = 1;
  // Worst case: every pixel sits on the stack at most once.
  const stack = new Int32Array(W * H * 2);

  for (let sy = 0; sy < H; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const seedPi = sy * W + sx;
      if (mask[seedPi] !== 0) continue;
      if (data[seedPi * 4 + 3] === 0) continue;

      const id = nextId++;
      let minX = sx, minY = sy, maxX = sx, maxY = sy, area = 0;
      let sp = 0;
      stack[sp++] = sx; stack[sp++] = sy;
      mask[seedPi] = id;

      while (sp > 0) {
        const cy = stack[--sp];
        const cx = stack[--sp];
        area++;
        if (cx < minX) minX = cx;
        if (cy < minY) minY = cy;
        if (cx > maxX) maxX = cx;
        if (cy > maxY) maxY = cy;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= W) continue;
            const ni = ny * W + nx;
            if (mask[ni] !== 0) continue;
            if (data[ni * 4 + 3] === 0) continue;
            mask[ni] = id;
            stack[sp++] = nx; stack[sp++] = ny;
          }
        }
      }

      if (area >= SEPARATE_MIN_AREA) {
        components.push({ id, minX, minY, maxX, maxY, area, selected: true });
      }
      // Tiny specks keep their id in the mask but are not exposed to the UI.
    }
  }

  // Largest first so the user sees the meaningful elements before noise.
  components.sort((a, b) => b.area - a.area);
  return { components, mask };
}

function drawComponentOverlay() {
  if (!state.separateMode && !state.cleanupMode) {
    componentOverlay.style.display = 'none';
    return;
  }
  componentOverlay.width = state.imgW;
  componentOverlay.height = state.imgH;
  componentOverlay.style.display = 'block';

  const o = overlayCtx;
  o.clearRect(0, 0, state.imgW, state.imgH);

  // Line / font sizes are in image-space; divide by zoom so they look
  // consistent regardless of magnification.
  const lineW = Math.max(0.5, 2 / state.zoom);
  const fontSize = Math.max(8, 16 / state.zoom);
  const labelPad = Math.max(2, 4 / state.zoom);

  // Cleanup mode reverses the visual semantics: selected = "keep" (green),
  // unselected = "delete" (red, more alarming). Separate mode still uses
  // amber (selected = will be saved) / grey (will be skipped).
  const isCleanup = state.cleanupMode;
  const selFill   = isCleanup ? 'rgba(124, 209, 124, 0.20)' : 'rgba(216, 160, 76, 0.18)';
  const unselFill = isCleanup ? 'rgba(220, 70, 70, 0.22)'   : 'rgba(120, 120, 120, 0.10)';
  const selStroke   = isCleanup ? '#7cd17c' : '#d8a04c';
  const unselStroke = isCleanup ? '#dc4646' : 'rgba(180,180,180,0.6)';

  for (let i = 0; i < state.components.length; i++) {
    const comp = state.components[i];
    const w = comp.maxX - comp.minX + 1;
    const h = comp.maxY - comp.minY + 1;

    o.fillStyle = comp.selected ? selFill : unselFill;
    o.fillRect(comp.minX, comp.minY, w, h);

    o.lineWidth = lineW;
    o.strokeStyle = comp.selected ? selStroke : unselStroke;
    o.strokeRect(comp.minX + lineW / 2, comp.minY + lineW / 2,
                 w - lineW, h - lineW);

    // Number label
    const label = String(i + 1);
    o.font = `bold ${fontSize}px -apple-system, sans-serif`;
    const tx = comp.minX + labelPad;
    const ty = comp.minY + fontSize + labelPad / 2;
    o.lineWidth = Math.max(1, 3 / state.zoom);
    o.strokeStyle = 'rgba(0,0,0,0.85)';
    o.strokeText(label, tx, ty);
    o.fillStyle = comp.selected ? '#fff' : 'rgba(220,220,220,0.85)';
    o.fillText(label, tx, ty);
  }
}

function updateSeparateInfo() {
  const total = state.components.length;
  const sel = state.components.filter(c => c.selected).length;
  $('separate-count').textContent = sel;
  $('separate-total').textContent = total;
  $('separate-save').disabled = sel === 0;
  $('separate-save-count').textContent = sel === 0 ? '' : ` (${sel})`;
}

async function startSeparateMode() {
  if (!state.workData) return;
  if (state.separateMode || state.cleanupMode) return;
  if (wandJob) return;

  showProgress('要素を検出中…');
  // Yield once so the overlay renders before the synchronous BFS.
  await new Promise(r => setTimeout(r, 30));

  let result;
  try {
    result = detectComponents();
  } catch (err) {
    hideProgress();
    showError('処理に失敗しました');
    return;
  }
  hideProgress();

  if (result.components.length === 0) {
    showError('保存できる内容がありません');
    return;
  }

  state.components = result.components;
  state.componentMask = result.mask;
  state.separateMode = true;

  $('separate-bar').classList.add('show');
  workspace.classList.add('separate-mode');
  cursor.style.display = 'none';

  drawComponentOverlay();
  updateSeparateInfo();
}

function exitSeparateMode() {
  state.separateMode = false;
  state.components = [];
  state.componentMask = null;
  $('separate-bar').classList.remove('show');
  workspace.classList.remove('separate-mode');
  drawComponentOverlay();
}

function selectAllComponents(selected) {
  for (const c of state.components) c.selected = selected;
  drawComponentOverlay();
  if (state.separateMode) updateSeparateInfo();
  else if (state.cleanupMode) updateCleanupInfo();
}

function extractComponentImageData(comp) {
  const W = state.imgW, H = state.imgH;
  const data = state.workData;
  const mask = state.componentMask;

  // Step 1 — isolate this component onto a fresh full-canvas buffer. Keeping
  // it on the original W×H grid means we can run feather across the real edge
  // (extending a pixel beyond the pre-feather bbox if needed) before deciding
  // whether to crop.
  const fullCanvas = new Uint8ClampedArray(W * H * 4);
  for (let y = comp.minY; y <= comp.maxY; y++) {
    const rowBase = y * W;
    for (let x = comp.minX; x <= comp.maxX; x++) {
      const si = rowBase + x;
      if (mask[si] !== comp.id) continue;
      const sdi = si * 4;
      fullCanvas[sdi]     = data[sdi];
      fullCanvas[sdi + 1] = data[sdi + 1];
      fullCanvas[sdi + 2] = data[sdi + 2];
      fullCanvas[sdi + 3] = data[sdi + 3];
    }
  }

  // Step 2 — apply feather per-component, so neighbouring components don't
  // bleed into each other's softened edge.
  const finalData = state.featherActive
    ? feather(fullCanvas, W, H, state.featherStrength | 0 || 1)
    : fullCanvas;

  // Step 3a — preserve mode: keep the original canvas size and pixel position.
  if (state.preserveCanvas) {
    return { width: W, height: H, data: finalData };
  }

  // Step 3b — cropped mode: tight bbox around whatever is opaque after feather.
  const b = getOpaqueBounds(finalData, W, H);
  if (!b) return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const w = b.maxX - b.minX + 1;
  const h = b.maxY - b.minY + 1;
  const cropped = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((b.minY + y) * W + (b.minX + x)) * 4;
      const di = (y * w + x) * 4;
      cropped[di]     = finalData[si];
      cropped[di + 1] = finalData[si + 1];
      cropped[di + 2] = finalData[si + 2];
      cropped[di + 3] = finalData[si + 3];
    }
  }
  return { width: w, height: h, data: cropped };
}

async function saveSelectedComponents() {
  const selected = state.components.filter(c => c.selected);
  if (selected.length === 0) return;
  if (typeof JSZip === 'undefined') {
    showError('ZIP の生成に失敗しました。接続を確認してください');
    return;
  }

  showProgress('PNG を生成中…');
  await new Promise(r => setTimeout(r, 30));

  const zip = new JSZip();
  const base = (state.filename || 'image').replace(/\.[^.]+$/, '') || 'image';
  const pad = String(state.components.length).length;

  for (let i = 0; i < selected.length; i++) {
    const comp = selected[i];
    const idx = state.components.indexOf(comp) + 1;
    const { width, height, data } = extractComponentImageData(comp);
    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    tmp.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
    const blob = await new Promise(res => tmp.toBlob(res, 'image/png'));
    zip.file(`${base}_part${String(idx).padStart(pad, '0')}.png`, blob);
    updateProgress(((i + 1) / selected.length) * 95);
  }

  progressTitle.textContent = 'ZIP を生成中…';
  const zipBlob = await zip.generateAsync(
    { type: 'blob' },
    meta => updateProgress(95 + meta.percent * 0.05)
  );
  hideProgress();

  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${base}_parts.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  exitSeparateMode();
}

// ============================================================================
// Cleanup mode — pick which components to KEEP, everything else is erased.
// Shares detectComponents() / componentMask / drawComponentOverlay() with
// separate mode; the visual semantics flip (green=keep, red=delete) and the
// commit action wipes the alpha of unselected components instead of zipping
// the selected ones.
// ============================================================================
async function startCleanupMode() {
  if (!state.workData) return;
  if (state.separateMode || state.cleanupMode) return;
  if (wandJob) return;

  showProgress('要素を検出中…');
  await new Promise(r => setTimeout(r, 30));

  let result;
  try {
    result = detectComponents();
  } catch (err) {
    hideProgress();
    showError('処理に失敗しました');
    return;
  }
  hideProgress();

  if (result.components.length === 0) {
    showError('削除対象の要素が見つかりません');
    return;
  }

  // Default: keep only the largest component. detectComponents() sorts by
  // area descending, so index 0 is the biggest meaningful element.
  result.components.forEach((c, i) => { c.selected = (i === 0); });

  state.components = result.components;
  state.componentMask = result.mask;
  state.cleanupMode = true;

  $('cleanup-bar').classList.add('show');
  $('cleanup-threshold').value = 0;
  $('cleanup-threshold-display').textContent = '0';
  workspace.classList.add('separate-mode');  // pointer cursor for picking
  cursor.style.display = 'none';

  drawComponentOverlay();
  updateCleanupInfo();
}

function exitCleanupMode() {
  state.cleanupMode = false;
  state.components = [];
  state.componentMask = null;
  $('cleanup-bar').classList.remove('show');
  workspace.classList.remove('separate-mode');
  drawComponentOverlay();
}

function updateCleanupInfo() {
  const total = state.components.length;
  const keep = state.components.filter(c => c.selected).length;
  const remove = total - keep;
  $('cleanup-keep-count').textContent = keep;
  $('cleanup-total').textContent = total;
  $('cleanup-execute').disabled = remove === 0;
  $('cleanup-execute-count').textContent = remove === 0 ? '' : ` (${remove})`;
}

function applyCleanupAreaThreshold(threshold) {
  // Keep components strictly larger than the threshold; everything ≤ becomes
  // a delete candidate. Manual per-component clicks afterward still work,
  // since they only override the components the user touches.
  for (const c of state.components) c.selected = c.area > threshold;
  drawComponentOverlay();
  updateCleanupInfo();
}

// Wipes the alpha of every component-tagged pixel that isn't in the keep set.
// Pixels that were never assigned a component id (truly transparent or below
// SEPARATE_MIN_AREA — i.e. micro-noise) are ALSO wiped, which is exactly what
// the user wanted: "1px の消し残し" gets cleared regardless.
function executeCleanup() {
  if (!state.cleanupMode) return;
  const keep = new Set(state.components.filter(c => c.selected).map(c => c.id));
  const W = state.imgW, H = state.imgH;
  const N = W * H;
  const data = state.workData;
  const mask = state.componentMask;

  pushUndo();

  for (let i = 0; i < N; i++) {
    const id = mask[i];
    if (id === 0) continue;        // already transparent
    if (keep.has(id)) continue;    // explicitly kept
    data[i * 4 + 3] = 0;           // wipe alpha; leave RGB intact so restore-
                                   // brush can still pull it back from origData
                                   // if the user changes their mind via Undo
  }

  exitCleanupMode();
  redraw();
  updateStatus();
}

// ============================================================================
// One-shot auto cleanup — no mode, no overlay. Detect components, drop every
// one whose area ≤ threshold, done. Bound to "🪄 自動ノイズ除去".
// ============================================================================
async function runAutoCleanup() {
  if (!state.workData) return;
  if (state.separateMode || state.cleanupMode) return;
  if (wandJob) return;

  showProgress('ノイズ成分を検出中…');
  await new Promise(r => setTimeout(r, 30));

  let result;
  try {
    result = detectComponents();
  } catch (err) {
    hideProgress();
    showError('処理に失敗しました');
    return;
  }
  hideProgress();

  const threshold = state.autoCleanupThreshold;
  const W = state.imgW, H = state.imgH;
  const N = W * H;
  const mask = result.mask;

  const keep = new Set(
    result.components.filter(c => c.area > threshold).map(c => c.id)
  );
  const removedCount = result.components.length - keep.size;

  if (removedCount === 0) {
    showError('削除できる小さな要素が見つかりませんでした');
    return;
  }

  // Snapshot first (pushUndo), THEN mutate workData. Order matters: the
  // undo stack must capture pre-mutation state.
  pushUndo();
  const data = state.workData;
  for (let i = 0; i < N; i++) {
    const id = mask[i];
    if (id === 0) continue;
    if (keep.has(id)) continue;
    data[i * 4 + 3] = 0;
  }
  redraw();
  updateStatus();
}

// ============================================================================
// AI background removal glue. Inference lives in ai/background.ts —
// here we just manage UI state (progress overlay, button disabling),
// shuttle the canvas image data in, and write the alpha mask back into
// workData so the restore brush / restore wand can recover anything
// the model shaved off too aggressively. Undoable in one step.
// ============================================================================
async function runAIBackgroundRemoval() {
  if (!state.workData) return;
  if (bgRemovalRunning) return;
  if (wandJob) return;
  if (state.separateMode || state.cleanupMode) return;

  bgRemovalRunning = true;
  updateStatus();
  showProgress('AI モデルを準備中…（初回は ~100MB のダウンロード）');

  try {
    // workData → data-URL so transformers.js can decode it via fetch.
    const tmp = document.createElement('canvas');
    tmp.width = state.imgW;
    tmp.height = state.imgH;
    tmp.getContext('2d').putImageData(
      new ImageData(state.workData, state.imgW, state.imgH), 0, 0
    );
    const dataURL = tmp.toDataURL('image/png');

    const alphaMask = await segmentBackground(dataURL, state.imgW, state.imgH, e => {
      const titles = {
        'model-fetch': 'AI モデルを取得中…',
        'preparing':   'AI を準備中…',
        'inferring':   'AI で背景除去中…',
        'finalizing':  '結果を反映中…',
      };
      progressTitle.textContent = titles[e.phase];
      updateProgress(Math.min(99, e.progress));
    });

    if (state.separateMode) exitSeparateMode();
    if (state.cleanupMode) exitCleanupMode();
    pushUndo();
    const N = state.imgW * state.imgH;
    for (let i = 0; i < N; i++) {
      state.workData[i * 4 + 3] = alphaMask[i];
    }
    redraw();
    hideProgress();
  } catch (err) {
    hideProgress();
    showError('AI 背景除去に失敗しました');
  } finally {
    bgRemovalRunning = false;
    updateStatus();
  }
}

// ============================================================================
// Returns workData with feather applied if the toggle is on, otherwise
// workData unchanged. Used by save / export paths.
function workDataForExport() {
  if (!state.featherActive || !state.workData) return state.workData;
  return feather(state.workData, state.imgW, state.imgH, state.featherStrength | 0 || 1);
}

// ============================================================================
// Crop save — write just the rectangle selection out as a fresh image.
// Honours the same feather toggle and saveFormat as the regular save.
// ============================================================================
function saveRectCrop() {
  if (!state.workData) { showError('画像が読み込まれていません'); return; }
  if (!state.rectSelection) { showError('矩形範囲が指定されていません'); return; }

  const { minX, minY, maxX, maxY } = state.rectSelection;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const W = state.imgW;

  const sourceData = workDataForExport();
  const cropped = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((minY + y) * W + (minX + x)) * 4;
      const di = (y * w + x) * 4;
      cropped[di]     = sourceData[si];
      cropped[di + 1] = sourceData[si + 1];
      cropped[di + 2] = sourceData[si + 2];
      cropped[di + 3] = sourceData[si + 3];
    }
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').putImageData(new ImageData(cropped, w, h), 0, 0);

  const fmt = state.saveFormat || 'png';
  const mime = `image/${fmt}`;
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const finish = blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = (state.filename || 'image').replace(/\.[^.]+$/, '');
    a.download = `${base}_crop.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`矩形を保存しました（${w}×${h}）`);
  };
  if (fmt === 'jpeg') {
    const flat = document.createElement('canvas');
    flat.width = w; flat.height = h;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, w, h);
    fctx.drawImage(out, 0, 0);
    flat.toBlob(finish, mime, 0.92);
  } else {
    out.toBlob(finish, mime, fmt === 'webp' ? 0.92 : undefined);
  }
}

// ============================================================================
// Save
// ============================================================================
function getOpaqueBounds(data, W, H) {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      if (data[(rowBase + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

function saveAsPNG() {
  if (!state.workData) return;

  // Apply feather (if toggled on) once on the full canvas, then crop —
  // this way the softened edge can extend a pixel or two beyond the
  // pre-feather bounding box without being clipped off.
  const sourceData = workDataForExport();

  let outW, outH, outData;
  if (state.preserveCanvas) {
    outW = state.imgW;
    outH = state.imgH;
    outData = sourceData;
  } else {
    const b = getOpaqueBounds(sourceData, state.imgW, state.imgH);
    if (!b) {
      showError('保存できる内容がありません');
      return;
    }
    outW = b.maxX - b.minX + 1;
    outH = b.maxY - b.minY + 1;
    outData = new Uint8ClampedArray(outW * outH * 4);
    const W = state.imgW;
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const si = ((b.minY + y) * W + (b.minX + x)) * 4;
        const di = (y * outW + x) * 4;
        outData[di]     = sourceData[si];
        outData[di + 1] = sourceData[si + 1];
        outData[di + 2] = sourceData[si + 2];
        outData[di + 3] = sourceData[si + 3];
      }
    }
  }

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  out.getContext('2d').putImageData(new ImageData(outData, outW, outH), 0, 0);
  const fmt = state.saveFormat || 'png';
  const mime = `image/${fmt}`;
  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  // For JPEG/WebP, flatten transparency onto white so the user gets a
  // sensible export; PNG keeps alpha as-is.
  if (fmt === 'jpeg') {
    const flat = document.createElement('canvas');
    flat.width = outW;
    flat.height = outH;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, outW, outH);
    fctx.drawImage(out, 0, 0);
    flat.toBlob(saveBlobAs, mime, 0.92);
  } else {
    out.toBlob(saveBlobAs, mime, fmt === 'webp' ? 0.92 : undefined);
  }
  function saveBlobAs(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const base = (state.filename || 'image').replace(/\.[^.]+$/, '') || 'image';
    a.download = `${base}_edited.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`保存しました（${outW}×${outH}）`);
  }
}

// ============================================================================
// Tool selection
// ============================================================================
const TOOL_HINTS = {
  erase:       'ドラッグで透明化 / [ ] でサイズ / Space+ドラッグでパン',
  restore:     'ドラッグで元に戻す / [ ] でサイズ',
  wand:        'クリックで連続同色を一括透明化 / 色許容度で範囲調整',
  restoreWand: 'クリックで元画像から連続同色を復元',
  rectSelect:  'ドラッグで矩形範囲を作成 / ESC でクリア',
};

function setTool(name) {
  const prev = state.tool;
  state.tool = name;
  // Switching tools mid-press would leave a stale pending click around;
  // drop it so the next pointerup doesn't fire the previous tool's wand.
  state.pendingWandClick = null;
  // Remember which wand variant was last used so we can keep its button
  // highlighted while the user dips into rect-select.
  if (name === 'wand' || name === 'restoreWand') state.lastWandTool = name;
  // Switching to a non-wand-related tool drops any pending rect, since
  // the rect only exists to scope wand targets.
  if (name === 'erase' || name === 'restore') clearRectSelection();
  // Brush size is meaningless for wand and rect-select (both operate on
  // whole regions), so dim the slider and show "—".
  const sizeIrrelevant = name === 'wand' || name === 'restoreWand' || name === 'rectSelect';
  const sizeSlider = $('size-slider');
  const sizeDisplay = $('size-display');
  if (sizeSlider) sizeSlider.disabled = sizeIrrelevant;
  if (sizeDisplay) sizeDisplay.textContent = sizeIrrelevant ? '—' : state.brushSize;
  // Crosshair cursor while in rect-select mode.
  workspace.classList.toggle('rect-select-mode', name === 'rectSelect');
  // Show the rect controls when a wand or rect-select is active and a
  // rectangle is currently set (or being created).
  updateRectControlsVisibility();
  refreshToolButtonsActive();
  // Tool-specific hint in the status bar.
  const hint = $('tool-hint');
  if (hint) hint.textContent = TOOL_HINTS[name] || '';
  updateStatus();
}

// Active-state and visibility for the tool buttons. Split out from setTool
// so creating or clearing a rect can refresh the highlighting without
// switching the active tool.
function refreshToolButtonsActive() {
  const hasRect = !!state.rectSelection;
  // Rect-select button is meaningful while a wand is in play, while
  // rect-select itself is active, or while a rect already exists.
  const rectBtn = document.querySelector('.tool-btn[data-tool="rectSelect"]');
  if (rectBtn) {
    const showRect = state.tool === 'wand' || state.tool === 'restoreWand'
                  || state.tool === 'rectSelect' || hasRect;
    rectBtn.style.display = showRect ? '' : 'none';
  }
  document.querySelectorAll('.tool-btn').forEach(b => {
    let active = b.dataset.tool === state.tool;
    // While rect-select is the active tool, also light up the wand button
    // the user came from — both are conceptually "on" together.
    if (state.tool === 'rectSelect' && b.dataset.tool === state.lastWandTool) active = true;
    // While a rect exists, keep the rect-select button lit regardless of
    // which tool is currently selected — the rect is "armed".
    if (hasRect && b.dataset.tool === 'rectSelect') active = true;
    b.classList.toggle('active', active);
  });
}

function updateRectControlsVisibility() {
  const ctrl = $('rect-controls');
  if (!ctrl) return;
  const wandActive = state.tool === 'wand' || state.tool === 'restoreWand';
  const isRectSelect = state.tool === 'rectSelect';
  // Show whenever the user might want to act on a rect: rectSelect tool
  // (creation), or wand tools (target restriction).
  ctrl.classList.toggle('show', wandActive || isRectSelect);
}

// ============================================================================
// Drag & drop
// ============================================================================
let dragCounter = 0;
function setupDragDrop() {
  // The browser's default action for a file drop is to navigate to the
  // file (i.e. open the image in the tab, blowing away our app). We
  // have to preventDefault on dragover at the *document* level — if it
  // only fires on #workspace, the browser still grabs drops that land
  // anywhere else on the page, and we never see them.
  document.addEventListener('dragover', e => e.preventDefault());

  // Visual overlay: only light up when the drag is over the canvas area.
  workspace.addEventListener('dragenter', e => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) dropOverlay.classList.add('show');
  });
  workspace.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove('show');
    }
  });

  // Accept drops anywhere on the page. Restricting to #workspace meant
  // the user had to aim precisely; document-level is much more forgiving.
  document.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('show');
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    if (files.length > 1) {
      showToast(`${files.length} 枚のうち最初の 1 枚を読み込みます`);
    }
    loadImageFromFile(files[0]);
  });
}

// ============================================================================
// Bindings
// ============================================================================
function bindUI() {
  $('open-btn').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    if (fileInput.files[0]) loadImageFromFile(fileInput.files[0]);
    fileInput.value = '';
  };
  $('save-btn').onclick = saveAsPNG;
  $('save-format').onchange = e => {
    state.saveFormat = e.target.value;
    e.target.blur();
  };
  $('undo-btn').onclick = undo;
  $('redo-btn').onclick = redoFn;
  $('fit-btn').onclick = fitToScreen;
  $('actual-btn').onclick = actualSize;
  $('help-btn').onclick = () => $('help-overlay').classList.toggle('show');
  $('help-close').onclick = () => $('help-overlay').classList.remove('show');
  // Help category tabs — switch the [data-help-tab] on #help-box, which
  // CSS uses to flip the visibility of each .help-section.
  document.querySelectorAll('#help-tabs button').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.onclick = () => {
      const target = btn.dataset.helpTarget;
      $('help-box').setAttribute('data-help-tab', target);
      document.querySelectorAll('#help-tabs button').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
    };
  });
  $('theme-btn').onclick = cycleTheme;
  $('help-overlay').onclick = e => {
    // Click outside the box closes
    if (e.target.id === 'help-overlay') e.target.classList.remove('show');
  };

  $('separate-btn').onclick = startSeparateMode;
  $('separate-all').onclick = () => selectAllComponents(true);
  $('separate-none').onclick = () => selectAllComponents(false);
  $('separate-save').onclick = saveSelectedComponents;
  $('separate-cancel').onclick = exitSeparateMode;

  $('cleanup-btn').onclick = startCleanupMode;
  $('cleanup-all').onclick = () => selectAllComponents(true);
  $('cleanup-none').onclick = () => selectAllComponents(false);
  $('cleanup-execute').onclick = executeCleanup;
  $('cleanup-cancel').onclick = exitCleanupMode;
  $('cleanup-threshold').oninput = e => {
    const t = +e.target.value;
    $('cleanup-threshold-display').textContent = t;
    applyCleanupAreaThreshold(t);
  };
  $('auto-cleanup-btn').onclick = runAutoCleanup;
  $('auto-cleanup-threshold').oninput = e => {
    const v = +e.target.value;
    if (v >= 1) state.autoCleanupThreshold = v;
  };
  $('auto-cleanup-threshold').addEventListener('change', e => e.target.blur());

  $('ai-bg-btn').onclick = runAIBackgroundRemoval;
  $('ai-input-btn').onclick = () => $('ai-file-input').click();
  $('ai-file-input').onchange = () => {
    const f = $('ai-file-input').files[0];
    if (f) loadAIOutputFile(f);
    $('ai-file-input').value = '';
  };
  $('show-orig-btn').onclick = () => {
    if (!state.origData) return;
    toggleOriginalOverlay(state.origData, state.imgW, state.imgH);
  };
  $('orig-opacity').oninput = e => {
    setOriginalOverlayOpacity(+e.target.value);
  };
  // Drop focus once the user lets go, otherwise the bindKeys input-guard
  // keeps absorbing Cmd+Z / Space / etc. into the slider until they click
  // somewhere else.
  $('orig-opacity').addEventListener('change', e => e.target.blur());
  // Feather is now a *save-time* toggle — it does not modify workData. Flip
  // the flag and the active state; saves / exports run feather() on their way
  // out the door.
  $('feather-btn').onclick = () => {
    state.featherActive = !state.featherActive;
    $('feather-btn').classList.toggle('active', state.featherActive);
  };
  $('feather-strength').onchange = e => {
    state.featherStrength = +e.target.value || 1;
    e.target.blur();
  };

  // Rect-selection controls
  document.querySelectorAll('input[name="rect-mode"]').forEach(radio => {
    radio.onchange = e => {
      state.rectInverse = e.target.value === 'outside';
      drawRectOverlay();
      e.target.blur();
    };
  });

  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.onclick = () => {
      // Rect-select button toggles: if it's currently armed (rect exists
      // or we're already in rect-select mode), tapping it deactivates and
      // clears the rect, returning the user to the last wand tool.
      if (btn.dataset.tool === 'rectSelect'
          && (state.rectSelection || state.tool === 'rectSelect')) {
        clearRectSelection();
        setTool(state.lastWandTool);
        return;
      }
      setTool(btn.dataset.tool);
    };
  });

  // Stop buttons from taking focus on press at all. preventDefault() on
  // mousedown blocks the browser's native focus-on-click while still allowing
  // the click event to fire. This solves two bugs at once:
  //   - Space+drag failing right after picking a tool (button still focused
  //     would absorb Space as its activate key).
  //   - Cmd+Z / Cmd+Y / Space etc. silently routing into the focused button.
  // Belt-and-braces: also blur on click in case mousedown was preempted.
  document.querySelectorAll('#toolbar button, #separate-bar button, #cleanup-bar button').forEach(b => {
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => b.blur());
  });

  $('size-slider').oninput = e => {
    state.brushSize = +e.target.value;
    $('size-display').textContent = state.brushSize;
  };
  $('hardness-slider').oninput = e => {
    state.brushHardness = +e.target.value;
    $('hardness-display').textContent = state.brushHardness;
  };
  $('tolerance-slider').oninput = e => {
    state.tolerance = +e.target.value;
    $('tolerance-display').textContent = state.tolerance;
  };
  // Release focus once the user finishes adjusting a slider, otherwise the
  // bindKeys guard (which ignores keys while an INPUT has focus) keeps Cmd+Z
  // and Space silently routed into the slider until the canvas is clicked.
  ['size-slider', 'hardness-slider', 'tolerance-slider'].forEach(id => {
    $(id).addEventListener('change', e => e.target.blur());
  });
  $('tolerance-toggle').onchange = e => {
    state.toleranceOn = e.target.checked;
    e.target.blur();
  };
  $('preserve-canvas-toggle').onchange = e => {
    state.preserveCanvas = e.target.checked;
    e.target.blur();
  };
  // Reflect persisted autosave setting into the checkbox
  if ($('autosave-toggle')) $('autosave-toggle').checked = state.autoSaveEnabled;
  $('autosave-toggle').onchange = e => {
    state.autoSaveEnabled = e.target.checked;
    try { localStorage.setItem('autosave-enabled', state.autoSaveEnabled ? 'true' : 'false'); } catch (_) {}
    if (!state.autoSaveEnabled) {
      // Cancel any pending debounced save AND wipe what's already in IDB.
      // Without the clearTimeout, a save that was scheduled just before
      // the toggle flip would still fire ~1.5s later.
      clearTimeout(autosaveTimer);
      clearAutosave();
      showToast('自動保存 OFF（保存済みデータをクリア）');
    } else {
      autosaveNow();
      showToast('自動保存 ON');
    }
    e.target.blur();
  };
}

// ============================================================================
// Autosave: capture the current editing session into IndexedDB after a
// debounce, and offer to restore it on next load. IO is in
// persist/autosave.ts; this layer is purely state ↔ session glue.
// ============================================================================
let autosaveTimer = null;

async function autosaveNow() {
  if (!state.workData || !state.origData) return;
  await saveSession({
    filename: state.filename || 'untitled',
    imgW: state.imgW,
    imgH: state.imgH,
    origData: state.origData.buffer.slice(0),
    workData: state.workData.buffer.slice(0),
    savedAt: Date.now(),
  });
}

function scheduleAutosave() {
  if (!state.autoSaveEnabled) return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosaveNow, 1500);
}

async function tryRestoreAutosave() {
  if (!state.autoSaveEnabled) return;
  const session = await loadSession();
  if (!session || !session.imgW) return;
  const ageMin = Math.round((Date.now() - session.savedAt) / 60000);
  const ok = await showModal({
    title: '前回のセッションを復元しますか？',
    message:
      `ファイル: ${session.filename}\n` +
      `サイズ: ${session.imgW} × ${session.imgH}\n` +
      `保存時刻: ${ageMin} 分前`,
    buttons: [
      { label: '復元する', value: true, primary: true },
      { label: '破棄する', value: false },
    ],
  });
  if (!ok) { clearAutosave(); return; }

  state.imgW = session.imgW;
  state.imgH = session.imgH;
  state.filename = session.filename;
  state.origData = new Uint8ClampedArray(session.origData);
  state.workData = new Uint8ClampedArray(session.workData);
  state.undo = []; state.redo = [];
  canvas.width = state.imgW;
  canvas.height = state.imgH;
  emptyHint.style.display = 'none';
  $('filename-status').textContent = state.filename;
  setTool('erase');
  fitToScreen();
  redraw();
  updateStatus();
  showToast('前回のセッションを復元しました');
}

async function clearAutosave() {
  await clearSession();
}

// Drop any in-flight gesture state. Called when the window loses focus or the
// user tabs away — without this, a Space-held pan that crossed the toolbar can
// leave `spaceHeld` / `isPanning` stuck on, freezing future input.
function resetTransientState() {
  state.spaceHeld = false;
  state.isPanning = false;
  state.isDrawing = false;
  state.lastImgX = state.lastImgY = null;
  workspace.classList.remove('pan-mode', 'panning');
}

// Track every active pointer (mouse, pen, touch finger) so we can detect
// two-finger pinches on tablets/phones in addition to single-pointer drags.
const activePointers = new Map();
let pinchState = null;

function bindCanvas() {
  workspace.addEventListener('pointerdown', e => {
    // Floating UI (help / progress / separate-bar) lives inside #workspace.
    // Without this guard, setPointerCapture below would steal the click and
    // those buttons would never fire — the user would see the bar but every
    // button would be dead.
    if (e.target.closest('#help-overlay, #progress-overlay, #separate-bar, #cleanup-bar')) return;
    if (isOverlayActive()) return;

    workspace.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (activePointers.size >= 2) {
      // Pinch start: cancel any in-flight single-finger drag, capture the
      // initial geometry of the two pointers we have.
      if (state.isDrawing || state.isPanning) {
        state.isDrawing = false;
        state.isPanning = false;
        state.lastImgX = state.lastImgY = null;
        workspace.classList.remove('panning');
      }
      const pts = [...activePointers.values()];
      const a = pts[0], b = pts[1];
      pinchState = {
        startDist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        startZoom: state.zoom,
        startPanX: state.panX,
        startPanY: state.panY,
      };
      e.preventDefault();
      return;
    }
    onPointerDown(e);
  });

  // pointermove / pointerup are bound to the *window*, not just #workspace.
  // setPointerCapture should keep events flowing to the workspace, but in
  // practice rapid pointer movement onto the toolbar can drop the capture
  // (browser-dependent), leaving the cursor overlay frozen and isPanning
  // stuck on. Listening on window guarantees we still see the move/up.
  window.addEventListener('pointermove', e => {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchState && activePointers.size >= 2) {
      const pts = [...activePointers.values()];
      const a = pts[0], b = pts[1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const factor = dist / pinchState.startDist;
      const newZoom = clamp(pinchState.startZoom * factor, 0.05, 32);
      // Pinch around the midpoint of the two fingers — that midpoint
      // (image-space) should stay under the user's touch as zoom changes.
      const wsRect = workspace.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - wsRect.left;
      const cy = (a.y + b.y) / 2 - wsRect.top;
      const ratio = newZoom / pinchState.startZoom;
      state.panX = cx - (cx - pinchState.startPanX) * ratio;
      state.panY = cy - (cy - pinchState.startPanY) * ratio;
      state.zoom = newZoom;
      applyTransform();
      updateStatus();
      return;
    }
    onPointerMove(e);
  });
  function endPointer(e) {
    if (activePointers.has(e.pointerId)) {
      activePointers.delete(e.pointerId);
    }
    if (activePointers.size < 2) pinchState = null;
    onPointerUp(e);
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  workspace.addEventListener('wheel', onWheel, { passive: false });
  workspace.addEventListener('mouseleave', () => {
    if (!state.isPanning && !state.isDrawing) cursor.style.display = 'none';
  });
  workspace.addEventListener('contextmenu', e => e.preventDefault());
}

function bindKeys() {
  window.addEventListener('keydown', e => {
    // Ignore when focus is in an input
    if (e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') return;

    // ESC: cancel running wand → exit component-picking mode → clear rect
    // selection → close help
    if (e.key === 'Escape') {
      if (wandJob) { e.preventDefault(); cancelWand(); return; }
      if (state.separateMode) { e.preventDefault(); exitSeparateMode(); return; }
      if (state.cleanupMode) { e.preventDefault(); exitCleanupMode(); return; }
      if (state.rectSelection) { e.preventDefault(); clearRectSelection(); return; }
      if ($('help-overlay').classList.contains('show')) {
        e.preventDefault();
        $('help-overlay').classList.remove('show');
        return;
      }
    }
    // ? toggles the help panel
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
      e.preventDefault();
      $('help-overlay').classList.toggle('show');
      return;
    }

    // While an overlay (help / modal) is on top of the canvas, swallow all
    // remaining keystrokes so editing shortcuts (Cmd+S, [, ], E, R, W…)
    // can't reach behind the overlay. ESC and ? are handled above and
    // continue to work.
    if (isOverlayActive()) return;

    const cmd = isMac() ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();

    // Throttle undo/redo for held Cmd+Z so a long press doesn't blast
    // through 30 history entries in 200ms — but still allow comfortable
    // repeated stepping at ~12 actions/second.
    if (cmd && key === 'z' && !e.shiftKey) {
      e.preventDefault();
      const now = performance.now();
      if (now - lastUndoKeyTime > UNDO_KEY_THROTTLE_MS) { undo(); lastUndoKeyTime = now; }
      return;
    }
    if (cmd && key === 'z' && e.shiftKey) {
      e.preventDefault();
      const now = performance.now();
      if (now - lastUndoKeyTime > UNDO_KEY_THROTTLE_MS) { redoFn(); lastUndoKeyTime = now; }
      return;
    }
    if (cmd && key === 's')                { e.preventDefault(); saveAsPNG(); return; }
    if (cmd && key === 'o')                { e.preventDefault(); fileInput.click(); return; }
    if (cmd && key === '0')                { e.preventDefault(); fitToScreen(); return; }
    if (cmd && key === '1')                { e.preventDefault(); actualSize(); return; }

    if (key === 'e') { setTool('erase'); }
    if (key === 'r' && !cmd) { setTool('restore'); }
    if (key === 'w') { setTool(e.shiftKey ? 'restoreWand' : 'wand'); }
    if (key === '[' || key === ']') {
      const dir = key === '[' ? -1 : 1;
      const now = performance.now();
      // Reset the accelerator if direction changed or input gap > 200ms.
      if (dir !== brushKeyAccel.lastDir || now - brushKeyAccel.lastTime > 200) {
        brushKeyAccel.runLength = 0;
      }
      brushKeyAccel.runLength++;
      brushKeyAccel.lastDir = dir;
      brushKeyAccel.lastTime = now;
      // Acceleration curve: 1px → 2 → 4 → 8 → 16 as the user holds.
      const n = brushKeyAccel.runLength;
      const step = n > 30 ? 16 : n > 18 ? 8 : n > 10 ? 4 : n > 4 ? 2 : 1;
      state.brushSize = clamp(state.brushSize + dir * step, 1, 300);
      $('size-slider').value = state.brushSize;
      $('size-display').textContent = state.brushSize;
      // Live-update the on-canvas cursor circle so the user sees the new
      // size immediately, without having to move the mouse to trigger a
      // pointermove → updateCursor.
      if (cursor.style.display !== 'none') {
        const screenSize = state.brushSize * state.zoom * 2;
        cursor.style.width  = screenSize + 'px';
        cursor.style.height = screenSize + 'px';
      }
    }
    if (e.code === 'Space') {
      // Always swallow Space: prevents both page scroll AND the focused
      // toolbar button from being "activated" (which would also block the
      // subsequent click-drag from starting a pan).
      e.preventDefault();
      // If a button has focus from a recent click, kick it out so future
      // keystrokes don't get redirected into button activation.
      const ae = document.activeElement;
      if (ae && ae !== document.body && typeof ae.blur === 'function'
          && (ae.tagName === 'BUTTON' || ae.tagName === 'SELECT')) {
        ae.blur();
      }
      if (!state.spaceHeld) {
        state.spaceHeld = true;
        workspace.classList.add('pan-mode');
        cursor.style.display = 'none';
      }
    }
  });
  window.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      state.spaceHeld = false;
      workspace.classList.remove('pan-mode');
    }
  });
}

// ============================================================================
// Init
// ============================================================================
window.addEventListener('resize', () => {
  if (state.imgW) updateStatus();
});

// If the window loses focus mid-gesture (alt-tab, devtools, etc.) we may never
// see the matching keyup/pointerup. Drop transient state defensively.
window.addEventListener('blur', resetTransientState);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) resetTransientState();
});

// PWA: register the service worker for offline / install support. Skipped
// when we're loaded via file:// (sw can't run in that protocol).
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => {
    console.warn('Service worker registration failed:', err);
  });
}

// Cmd/Ctrl+V — paste an image from the clipboard. Pairs naturally with
// "download from remove.bg → paste here to fix it up".
window.addEventListener('paste', e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) {
        e.preventDefault();
        loadImageFromFile(blob);
        return;
      }
    }
  }
});

bindUI();
bindCanvas();
bindKeys();
setupDragDrop();
initTheme();
// Apply initial tool state to the DOM (hides the rect-select button until
// a wand is picked, sets the active highlight, etc).
setTool(state.tool);
updateStatus();
// Hide the splash now that the toolbar is wired up and the canvas is
// ready to receive input. requestAnimationFrame defers until paint to
// avoid yanking the splash off before the new UI renders.
requestAnimationFrame(() => {
  const splash = document.getElementById('splash');
  if (splash) splash.classList.add('hidden');
  setTimeout(() => splash && splash.parentNode && splash.parentNode.removeChild(splash), 400);
});
// Try restoring the last session from IndexedDB. Asks the user first,
// runs after binding so we can wire up state via the same setters.
tryRestoreAutosave();

