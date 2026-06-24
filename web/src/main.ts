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
import { initMobileDock } from './ui/mobileDock';
import { showModal } from './ui/modal';
import { saveSession, loadSession, clearSession } from './persist/autosave';
import { segmentBackground } from './ai/background';
import {
  showOriginalOverlay, hideOriginalOverlay, toggleOriginalOverlay,
  setOriginalOverlayOpacity,
} from './ui/originalOverlay';
import { saveImage } from './io/save';
import { state } from './state';
import { applyBrushDab, applyStroke } from './tools/brush';
import { magicWandAt as runMagicWand, cancelWand, isWandRunning } from './tools/wand';
import { detectComponents, SEPARATE_MIN_AREA } from './components/connected';
import { showProgress, updateProgress, hideProgress, setProgressTitle, setProgressCancelMode } from './ui/progress';
import { showError } from './ui/error';
import { t, applyI18n, setLang } from './i18n';

// Expose the language switcher on window for dev / testing only.
// Run `cleavry.setLang('en')` in the browser Console to override the
// auto-detected language. There is no user-facing UI for this.
(window as any).cleavry = { setLang };
import { initHistory, pushUndo, pushMoveUndo, pushResizeUndo, undo, redoFn } from './persist/history';
import {
  canvas, ctx, canvasWrap, workspace, cursor, rectOverlay,
  setRenderHooks,
  redraw, applyTransform, drawRectOverlay, clearRectSelection,
  fitToScreen as fitToScreenImpl, actualSize as actualSizeImpl,
  screenToImage, updateCursor, drawMaterialOverlay,
  invalidateMaterialCache,
} from './canvas/render';
import { getActiveMaterial, getActiveLayer, nextMaterialId } from './layers/active';
import { MaterialLayer, ResizeHandle } from './state';

// ── External globals ─────────────────────────────────────────────────────
// JSZip is loaded via a <script> tag in index.html. transformers.js is
// loaded dynamically inside the AI background-removal flow.
declare const JSZip: any;

// ============================================================================
// DOM
// ============================================================================
// workspace / canvas / ctx / canvasWrap / cursor / rectOverlay are
// imported from canvas/render. Drop / empty / file inputs and the
// component overlay stay local to main.ts since they're only used here.
const dropOverlay = $('drop-overlay');
const emptyHint = $('empty-hint');
const fileInput = $('file-input');
const componentOverlay = $<HTMLCanvasElement>('component-overlay');
const overlayCtx = componentOverlay.getContext('2d')!;

// ============================================================================
// Helpers
// ============================================================================
function updateStatus() {
  $('size-status').textContent = state.imgW
    ? `${state.imgW} × ${state.imgH} px`
    : '';
  $('zoom-status').textContent = state.imgW
    ? `${Math.round(state.zoom * 100)}%`
    : '';
  $('tool-status').textContent = ({
    erase:       t('status.toolErase'),
    restore:     t('status.toolRestore'),
    wand:        t('status.toolWand'),
    restoreWand: t('status.toolRestoreWand'),
    rectSelect:  t('status.toolRect'),
    move:        t('status.toolMove'),
  })[state.tool] || state.tool;
  // Undo/redo display reflects whichever layer the user is editing.
  const activeMat = getActiveMaterial();
  const uLen = activeMat ? activeMat.undo.length : state.undo.length;
  const rLen = activeMat ? activeMat.redo.length : state.redo.length;
  $('undo-status').textContent = state.imgW
    ? `${t('status.history')}: ${uLen} / ${state.maxUndo}`
    : '';
  // `has-image` flips the workspace cursor from system-default (so the
  // empty-state hint and help overlay show a normal arrow) to `none`
  // (so the brush ring / mode-specific cursors take over).
  workspace.classList.toggle('has-image', !!state.workData);
  // Base-only features stay tied to workData; the material-add button
  // also requires a base image as the host canvas.
  $('save-btn').disabled = !state.workData;
  $('save-format').disabled = !state.workData;
  $('separate-btn').disabled = !state.workData || !!activeMat;
  $('cleanup-btn').disabled = !state.workData || !!activeMat;
  // Auto-cleanup is alpha-wipe-by-component, which makes sense on a
  // material layer too (e.g. trimming AI-segmented stray specks on a
  // pasted-in cutout). The interactive cleanup mode still stays base-
  // only since its overlay UI is built around base-canvas coords.
  $('auto-cleanup-btn').disabled = !state.workData;
  $('ai-bg-btn').disabled = !state.workData || bgRemovalRunning || !!activeMat;
  $('ai-input-btn').disabled = !state.workData || !!activeMat;
  $('show-orig-btn').disabled = !state.workData;
  $('orig-opacity').disabled = !state.workData;
  $('feather-btn').disabled = !state.workData;
  $('feather-strength').disabled = !state.workData;
  const matAddBtn = $('material-add-btn');
  if (matAddBtn) matAddBtn.disabled = !state.workData;
  $('undo-btn').disabled = uLen === 0;
  $('redo-btn').disabled = rLen === 0;
}

// ============================================================================
// Image loading
// ============================================================================
function loadImageFromFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    showError(t('error.imageType'));
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
        title: t('modal.bigImage.title'),
        message: `${img.width} × ${img.height}\n\n${t('modal.bigImage.body')}\n→ ${sw} × ${sh}`,
        buttons: [
          { label: `${t('modal.bigImage.shrink')} ${sw}×${sh}`, value: 'shrink', primary: true },
          { label: t('modal.bigImage.asis'), value: 'asis' },
          { label: t('modal.bigImage.cancel'), value: 'cancel' },
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
    // New base image — drop any materials carried over from a previous
    // session. Their offsets and sizes were tied to the old canvas.
    state.materials = [];
    state.activeMaterialId = null;
    invalidateMaterialCache();
    renderLayerPanel();
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
  img.onerror = () => showError(t('error.loadFailed'));
  img.src = URL.createObjectURL(file);
}

// Replace the working canvas with an AI-processed version while keeping the
// original (background-included) source as `origData`. This is what powers the
// "restore what remove.bg deleted" workflow: the restore brush / restore wand
// pull pixels from origData, so anything the AI shaved off can be painted back
// from the genuine source.
function loadAIOutputFile(file) {
  if (!state.origData) {
    showError(t('error.notLoaded'));
    return;
  }
  if (!file || !file.type.startsWith('image/')) {
    showError(t('error.imageType'));
    return;
  }
  const img = new Image();
  img.onload = () => {
    if (img.width !== state.imgW || img.height !== state.imgH) {
      showError(
        `${state.imgW}×${state.imgH} / ${img.width}×${img.height}\n` +
        t('modal.sizeMismatch')
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
      showError(t('error.notTransparent'));
      URL.revokeObjectURL(img.src);
      return;
    }
    if (opaqueCount === 0) {
      showError(t('error.empty'));
      URL.revokeObjectURL(img.src);
      return;
    }

    const SIMILARITY_THRESHOLD = 50;  // 0..441 (RGB distance)
    const avgDiff = totalDiff / opaqueCount;
    if (avgDiff > SIMILARITY_THRESHOLD) {
      showError(t('error.unrelated'));
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
  img.onerror = () => showError(t('error.loadFailed'));
  img.src = URL.createObjectURL(file);
}

// fitToScreen / actualSize need updateStatus, which lives in main.ts.
// Rather than forcing every caller to pass it, wrap the canvas-module
// versions once here.
function fitToScreen() { fitToScreenImpl(updateStatus); }
function actualSize()   { actualSizeImpl(updateStatus); }

// ============================================================================
// Undo / Redo
// ============================================================================
function clearFeatherToggle() {
  if (!state.featherActive) return;
  state.featherActive = false;
  $('feather-btn').classList.remove('active');
}


// True while AI background removal is in flight. Used by updateStatus()
// to disable the AI button so the user can't double-fire it.
let bgRemovalRunning = false;
// Tracks where the AI flow currently is so ESC only honours the
// abortable model-fetch phase. Once we transition into preparing /
// inferring / finalizing, transformers.js can't be cancelled.
let bgPhase: 'idle' | 'model-fetch' | 'inferring' = 'idle';

// Cmd+Z / Cmd+Shift+Z auto-repeat governor (~12 ops/sec).
let lastUndoKeyTime = 0;
const UNDO_KEY_THROTTLE_MS = 80;

// [ / ] brush-size accelerator. Holding the key produces faster steps over
// time so users can sweep across the full 1-300 range without RSI, while
// single taps still nudge by exactly 1 px.
const brushKeyAccel = { lastTime: 0, lastDir: 0, runLength: 0 };

// Magic wand: thin glue. The BFS itself lives in tools/wand.ts; here we
// just hand it the progress / redraw / autosave callbacks.
function magicWandAt(ix, iy) {
  runMagicWand(ix, iy, {
    showProgress, updateProgress, hideProgress,
    redraw, updateStatus, scheduleAutosave,
  });
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

  // Move tool: drag the active material around the canvas, or grab a
  // handle to resize. The handle hit-test wins over plain move so the
  // user can grab a corner that's still inside the material bbox.
  if (state.tool === 'move') {
    const mat = getActiveMaterial();
    if (!mat) return;
    const handle = hitTestResizeHandle(x, y, mat);
    if (handle) {
      state.resizeHandle = handle;
      state.resizeStart = {
        x: mat.x, y: mat.y, w: mat.w, h: mat.h,
        pointerX: x, pointerY: y,
      };
      state.resizePreview = { x: mat.x, y: mat.y, w: mat.w, h: mat.h };
      e.preventDefault();
      return;
    }
    state.isMovingMaterial = true;
    state.moveStartScreen = { x: e.clientX, y: e.clientY };
    state.moveStartLayer = { x: mat.x, y: mat.y };
    e.preventDefault();
    return;
  }

  if (state.tool === 'wand' || state.tool === 'restoreWand') {
    // Hold off on firing the wand: if the user starts dragging, we
    // reinterpret the press as a rect rebuild. A plain click (no drag)
    // falls through to the wand on pointerup. Material wand fires
    // immediately on click (no rect support on materials).
    const isMaterial = !!getActiveMaterial();
    if (isMaterial) {
      magicWandAt(x, y);
      e.preventDefault();
      return;
    }
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
  applyBrushDab(x, y);
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

  // Resize in flight: update the live preview bbox. Aspect-lock on
  // corners is the default; Shift toggles to free-form (and re-locks
  // edges, which is a no-op since they're always single-axis).
  if (state.resizeHandle && state.resizeStart) {
    const { x: cx, y: cy } = screenToImage(e.clientX, e.clientY);
    const lockAspect = !e.shiftKey;  // default lock for corners
    state.resizePreview = computeResizePreview(
      state.resizeHandle, state.resizeStart, cx, cy, lockAspect,
    );
    redraw();
    return;
  }

  // Move tool drag: translate the screen-delta back into image coords
  // and apply to the material's offset. Updates the dashed outline +
  // the composite each frame.
  if (state.isMovingMaterial) {
    const mat = getActiveMaterial();
    if (!mat) { state.isMovingMaterial = false; return; }
    const dx = (e.clientX - state.moveStartScreen.x) / state.zoom;
    const dy = (e.clientY - state.moveStartScreen.y) / state.zoom;
    mat.x = Math.round(state.moveStartLayer.x + dx);
    mat.y = Math.round(state.moveStartLayer.y + dy);
    redraw();
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
    applyStroke(state.lastImgX, state.lastImgY, x, y);
  } else {
    applyBrushDab(x, y);
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
  if (state.resizeHandle) {
    // Commit the preview: snapshot the pre-resize material into undo,
    // then re-rasterize at the new dimensions. The rescale only fires
    // if anything actually changed.
    const mat = getActiveMaterial();
    if (mat && state.resizePreview) {
      const p = state.resizePreview;
      const changed = mat.x !== p.x || mat.y !== p.y
        || mat.w !== p.w || mat.h !== p.h;
      if (changed) {
        pushResizeUndo();
        rescaleMaterial(mat, p);
      }
    }
    state.resizeHandle = null;
    state.resizeStart = null;
    state.resizePreview = null;
    redraw();
    updateStatus();
  }
  if (state.isMovingMaterial) {
    // Push the move into undo only if the material actually moved.
    const mat = getActiveMaterial();
    const start = state.moveStartLayer;
    if (mat && start && (mat.x !== start.x || mat.y !== start.y)) {
      pushMoveUndo(start.x, start.y);
    }
    state.isMovingMaterial = false;
    state.moveStartScreen = null;
    state.moveStartLayer = null;
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
  if (isWandRunning()) return;

  showProgress(t('progress.detect'));
  // Yield once so the overlay renders before the synchronous BFS.
  await new Promise(r => setTimeout(r, 30));

  let result;
  try {
    result = detectComponents(state.workData, state.imgW, state.imgH);
  } catch (err) {
    hideProgress();
    showError(t('error.processFailed'));
    return;
  }
  hideProgress();

  if (result.components.length === 0) {
    showError(t('error.noOpaque'));
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
    showError(t('error.zipFailed'));
    return;
  }

  showProgress(t('progress.png'));
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

  setProgressTitle(t('progress.zip'));
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
  if (isWandRunning()) return;

  showProgress(t('progress.detect'));
  await new Promise(r => setTimeout(r, 30));

  let result;
  try {
    result = detectComponents(state.workData, state.imgW, state.imgH);
  } catch (err) {
    hideProgress();
    showError(t('error.processFailed'));
    return;
  }
  hideProgress();

  if (result.components.length === 0) {
    showError(t('error.noCleanupTarget'));
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
  // Auto-cleanup runs on whichever layer the user is editing — base or
  // an active material. detectComponents works on a raw RGBA buffer and
  // a size, so feeding it the active layer's local buffer is enough.
  const layer = getActiveLayer();
  if (!layer) return;
  if (state.separateMode || state.cleanupMode) return;
  if (isWandRunning()) return;

  showProgress(t('progress.detect'));
  await new Promise(r => setTimeout(r, 30));

  let result;
  try {
    result = detectComponents(layer.data, layer.w, layer.h);
  } catch (err) {
    hideProgress();
    showError(t('error.processFailed'));
    return;
  }
  hideProgress();

  const threshold = state.autoCleanupThreshold;
  const N = layer.w * layer.h;
  const mask = result.mask;

  const keep = new Set(
    result.components.filter(c => c.area > threshold).map(c => c.id)
  );

  // Count actually-removable pixels by scanning the mask. The naive
  // components.length - keep.size shortcut undercounts: detectComponents
  // skips sub-SEPARATE_MIN_AREA specks (areas 1-3 px) when building
  // `components`, but those still have ids in `mask` and are valid
  // removal targets here.
  let pixelsToRemove = 0;
  for (let i = 0; i < N; i++) {
    const id = mask[i];
    if (id === 0) continue;
    if (keep.has(id)) continue;
    pixelsToRemove++;
  }

  if (pixelsToRemove === 0) {
    showError(t('error.noSmallElements'));
    return;
  }

  // Snapshot first (pushUndo, which targets the active layer), THEN
  // mutate the active layer's buffer. Order matters: undo must capture
  // pre-mutation state.
  pushUndo();
  const data = layer.data;
  for (let i = 0; i < N; i++) {
    const id = mask[i];
    if (id === 0) continue;
    if (keep.has(id)) continue;
    data[i * 4 + 3] = 0;
  }
  // The material's cached canvas was just invalidated by the alpha
  // wipe — clear it so the next redraw picks up the new pixels.
  if (layer.isMaterial && layer.materialId) {
    invalidateMaterialCache(layer.materialId);
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
  if (isWandRunning()) return;
  if (state.separateMode || state.cleanupMode) return;

  // First-time consent: the AI step needs a one-time ~470MB model
  // download from huggingface.co. Make the download intent explicit
  // so it isn't a surprise to the user (and isn't a surprise to
  // Safe Browsing's "deceptive software download" classifier either).
  if (!(await ensureAIConsent())) return;

  bgRemovalRunning = true;
  bgPhase = 'model-fetch';
  updateStatus();
  // The AI flow starts in the abortable model-fetch phase (the user
  // can hit ESC or the in-overlay cancel button to discard the page
  // and retry later) and switches to non-cancellable once inference
  // begins. Show the model-fetch title from the start so it doesn't
  // flash through a separate "preparing" label.
  showProgress(t('progress.aiFetch'), { cancel: 'reload', onCancel: confirmCancelDownload });

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
        'model-fetch': t('progress.aiFetch'),
        'preparing':   t('progress.aiPrep'),
        'inferring':   t('progress.aiInfer'),
        'finalizing':  t('progress.aiFinalize'),
      };
      setProgressTitle(titles[e.phase]);
      updateProgress(Math.min(99, e.progress));
      // Transition out of the cancellable model-fetch phase as soon as
      // the model is in memory. Hide the ESC-cancel hint once we can no
      // longer honour the cancel.
      if (e.phase !== 'model-fetch' && bgPhase === 'model-fetch') {
        bgPhase = 'inferring';
        setProgressCancelMode('none');
      }
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
    showError(t('error.aiFailed'));
  } finally {
    bgRemovalRunning = false;
    bgPhase = 'idle';
    updateStatus();
  }
}

// transformers.js exposes no AbortSignal we can rely on, so the only
// reliable way to terminate a half-finished model download is to
// reload the tab. Snapshot the current canvas first (in case the
// debounced autosave hasn't fired yet) and mark the reload as
// intentional so the post-reload restore skips the confirm modal —
// otherwise the user gets dumped onto a blank canvas + a "restore?"
// prompt, which is not what cancelling a download should feel like.
const AUTO_RESTORE_KEY = 'cleavry.autoRestoreOnLoad';
async function confirmCancelDownload() {
  const ok = await showModal({
    title: t('modal.cancelDownload.title'),
    message: t('modal.cancelDownload.body'),
    buttons: [
      { label: t('modal.cancelDownload.yes'), value: true, primary: true },
      { label: t('modal.cancelDownload.no'), value: false },
    ],
  });
  if (!ok) return;
  if (state.workData && state.imgW) {
    try { await autosaveNow(); } catch { /* best effort */ }
  }
  try { sessionStorage.setItem(AUTO_RESTORE_KEY, '1'); } catch { /* ignore */ }
  location.reload();
}

// First-time consent for the AI model download. Once accepted, remember
// the choice in localStorage so we don't re-prompt every session.
const AI_CONSENT_KEY = 'cleavry.aiConsent.v1';
async function ensureAIConsent(): Promise<boolean> {
  try {
    if (localStorage.getItem(AI_CONSENT_KEY) === '1') return true;
  } catch { /* private mode, fall through to prompt every time */ }
  const ok = await showModal({
    title: t('modal.aiConsent.title'),
    message: t('modal.aiConsent.body'),
    buttons: [
      { label: t('modal.aiConsent.yes'), value: true, primary: true },
      { label: t('modal.aiConsent.no'), value: false },
    ],
  });
  if (ok) {
    try { localStorage.setItem(AI_CONSENT_KEY, '1'); } catch { /* ignore */ }
  }
  return !!ok;
}

// ============================================================================
// Save
// ============================================================================
async function saveAsPNG() {
  if (!state.workData) return;
  try {
    // Flatten base + materials before save so the export is a single
    // base-sized image with everything composited in.
    const flat = compositeAllLayers();
    if (!flat) return;
    const { outW, outH } = await saveImage({
      data: flat,
      W: state.imgW,
      H: state.imgH,
      filename: state.filename || 'image',
      format: state.saveFormat || 'png',
      preserveCanvas: state.preserveCanvas,
      featherActive: state.featherActive,
      featherStrength: state.featherStrength,
    });
    showToast(`${t('toast.saved')}（${outW}×${outH}）`);
  } catch (err) {
    showError(err.message || t('error.saveFailed'));
  }
}

// ============================================================================
// Material layers
// ============================================================================
// Composite the base + every material onto a fresh base-sized buffer.
// Used by save (so the export is flat) and could be used elsewhere if a
// caller ever needs the visible result rather than the active layer.
function compositeAllLayers(): Uint8ClampedArray | null {
  if (!state.workData) return null;
  if (state.materials.length === 0) return state.workData;
  const c = document.createElement('canvas');
  c.width = state.imgW;
  c.height = state.imgH;
  const cctx = c.getContext('2d')!;
  cctx.putImageData(
    new ImageData(state.workData as Uint8ClampedArray<ArrayBuffer>, state.imgW, state.imgH),
    0, 0,
  );
  for (const m of state.materials) {
    const tmp = document.createElement('canvas');
    tmp.width = m.w;
    tmp.height = m.h;
    tmp.getContext('2d')!.putImageData(
      new ImageData(m.data as Uint8ClampedArray<ArrayBuffer>, m.w, m.h),
      0, 0,
    );
    cctx.drawImage(tmp, m.x, m.y);
  }
  return cctx.getImageData(0, 0, state.imgW, state.imgH).data;
}

// Test whether (imgX, imgY) is close enough to one of the material's
// 8 resize handles to count as a "grab". Tolerance is in image-space
// pixels scaled by the inverse zoom so the hit area stays a constant
// ~12 screen pixels across regardless of how zoomed-in the user is.
function hitTestResizeHandle(imgX: number, imgY: number, m: MaterialLayer): ResizeHandle | null {
  const tol = Math.max(6, 12 / state.zoom);
  const handles: Record<ResizeHandle, [number, number]> = {
    nw: [m.x,           m.y],
    n:  [m.x + m.w / 2, m.y],
    ne: [m.x + m.w,     m.y],
    e:  [m.x + m.w,     m.y + m.h / 2],
    se: [m.x + m.w,     m.y + m.h],
    s:  [m.x + m.w / 2, m.y + m.h],
    sw: [m.x,           m.y + m.h],
    w:  [m.x,           m.y + m.h / 2],
  };
  for (const name in handles) {
    const [hx, hy] = handles[name as ResizeHandle];
    if (Math.abs(imgX - hx) < tol && Math.abs(imgY - hy) < tol) {
      return name as ResizeHandle;
    }
  }
  return null;
}

// Compute the target bbox for a handle drag. Corners default to
// aspect-ratio lock; edges always free-resize one axis. Holding Shift
// inverts the lock (free corner / lock edge — though edges have no
// meaningful aspect to lock and just behave the same).
function computeResizePreview(
  handle: ResizeHandle,
  start: { x: number; y: number; w: number; h: number; pointerX: number; pointerY: number },
  curX: number,
  curY: number,
  lockAspect: boolean,
): { x: number; y: number; w: number; h: number } {
  const MIN = 8;
  // Anchor-based math: each handle has an opposite corner / edge that
  // stays pinned. We compute the live opposite of the dragged point
  // (= the pointer), clamp the resulting size to ≥ MIN, then reproject
  // back into x/y/w/h.
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  let nx = start.x, ny = start.y, nw = start.w, nh = start.h;

  // Horizontal effect
  if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    nx = Math.min(curX, right - MIN);
    nw = right - nx;
  } else if (handle === 'ne' || handle === 'e' || handle === 'se') {
    nw = Math.max(MIN, curX - start.x);
  } // n / s: width unchanged

  // Vertical effect
  if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    ny = Math.min(curY, bottom - MIN);
    nh = bottom - ny;
  } else if (handle === 'sw' || handle === 's' || handle === 'se') {
    nh = Math.max(MIN, curY - start.y);
  } // w / e: height unchanged

  // Corner aspect lock — keep the same w/h ratio as the source.
  const isCorner = handle === 'nw' || handle === 'ne' || handle === 'sw' || handle === 'se';
  if (isCorner && lockAspect) {
    const ratio = start.w / start.h;
    // Drive the bigger relative change so the cursor stays close to the
    // dragged corner.
    if (nw / start.w > nh / start.h) {
      nh = nw / ratio;
    } else {
      nw = nh * ratio;
    }
    nh = Math.max(MIN, nh);
    nw = Math.max(MIN, nw);
    // Re-anchor the bbox so the *opposite* corner stays put.
    if (handle === 'nw') { nx = right  - nw; ny = bottom - nh; }
    if (handle === 'ne') { nx = start.x;     ny = bottom - nh; }
    if (handle === 'sw') { nx = right  - nw; ny = start.y; }
    if (handle === 'se') { nx = start.x;     ny = start.y; }
  }
  return { x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) };
}

// Rebuild a material's data + origData at the preview dimensions via a
// canvas drawImage stretch. Quality stays high on a single resize;
// repeated rounds re-sample from the current (already-scaled) buffer
// rather than a pristine source, so multiple resizes will gradually
// lose detail — same model as Photoshop "free transform" on a
// rasterised layer.
function rescaleMaterial(m: MaterialLayer, target: { x: number; y: number; w: number; h: number }): void {
  if (target.w === m.w && target.h === m.h && target.x === m.x && target.y === m.y) return;
  const src = document.createElement('canvas');
  src.width = m.w; src.height = m.h;
  src.getContext('2d')!.putImageData(
    new ImageData(m.data as Uint8ClampedArray<ArrayBuffer>, m.w, m.h),
    0, 0,
  );
  const srcOrig = document.createElement('canvas');
  srcOrig.width = m.w; srcOrig.height = m.h;
  srcOrig.getContext('2d')!.putImageData(
    new ImageData(m.origData as Uint8ClampedArray<ArrayBuffer>, m.w, m.h),
    0, 0,
  );

  const t = document.createElement('canvas');
  t.width = target.w; t.height = target.h;
  const tctx = t.getContext('2d')!;
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(src, 0, 0, target.w, target.h);
  const newData = new Uint8ClampedArray(tctx.getImageData(0, 0, target.w, target.h).data);
  tctx.clearRect(0, 0, target.w, target.h);
  tctx.drawImage(srcOrig, 0, 0, target.w, target.h);
  const newOrigData = new Uint8ClampedArray(tctx.getImageData(0, 0, target.w, target.h).data);

  m.data = newData;
  m.origData = newOrigData;
  m.w = target.w;
  m.h = target.h;
  m.x = target.x;
  m.y = target.y;
  // Don't clear m.undo / m.redo here: MaterialSnap entries already
  // capture w/h alongside data, so older snapshots remain consistent
  // with the buffer they reference and can still be applied.
  invalidateMaterialCache(m.id);
}

function loadMaterialFromFile(file: File): void {
  if (!state.workData) {
    showError(t('error.notLoaded'));
    return;
  }
  if (!file || !file.type.startsWith('image/')) {
    showError(t('error.imageType'));
    return;
  }
  const img = new Image();
  img.onload = () => {
    // Add the material at its intrinsic size — no downscaling. The user
    // can move / resize it afterwards if it overflows the canvas.
    const w = img.width, h = img.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d')!;
    tctx.drawImage(img, 0, 0);
    const id = tctx.getImageData(0, 0, w, h);

    const m: MaterialLayer = {
      id: nextMaterialId(),
      name: (file.name || '素材').replace(/\.[^.]+$/, '') || '素材',
      data: new Uint8ClampedArray(id.data),
      origData: new Uint8ClampedArray(id.data),
      w, h,
      x: Math.max(0, Math.round((state.imgW - w) / 2)),
      y: Math.max(0, Math.round((state.imgH - h) / 2)),
      undo: [],
      redo: [],
    };
    state.materials.push(m);
    state.activeMaterialId = m.id;
    // A material just became active — surface the move button right away
    // (refreshToolButtonsActive keys its visibility off the active material).
    refreshToolButtonsActive();
    renderLayerPanel();
    redraw();
    updateStatus();
    scheduleAutosave();
    URL.revokeObjectURL(img.src);
  };
  img.onerror = () => showError(t('error.loadFailed'));
  img.src = URL.createObjectURL(file);
}

function removeMaterial(id: string): void {
  const idx = state.materials.findIndex(m => m.id === id);
  if (idx < 0) return;
  state.materials.splice(idx, 1);
  invalidateMaterialCache(id);
  if (state.activeMaterialId === id) {
    state.activeMaterialId = null;
    // The move tool is only meaningful with an active material — bail
    // back to erase so the user has a usable tool selected.
    if (state.tool === 'move') setTool('erase');
    else refreshToolButtonsActive();
  }
  renderLayerPanel();
  redraw();
  updateStatus();
  scheduleAutosave();
}

function setActiveLayer(id: string | null): void {
  if (state.activeMaterialId === id) return;
  // Switching layers mid-stroke / mid-mode would leave stale state.
  if (state.isDrawing || state.isMovingMaterial) return;
  if (id !== null) {
    // Switching to a material clears any rect selection (it's in base
    // coords and would mis-clip material wand operations).
    clearRectSelection();
    // Material editing supports brush/wand/move. If the user was on
    // rect-select, fall back to erase as a sensible default.
    if (state.tool === 'rectSelect') setTool('erase');
  } else {
    // Leaving material → base: move tool isn't meaningful on base, fall back.
    if (state.tool === 'move') setTool('erase');
  }
  state.activeMaterialId = id;
  drawMaterialOverlay();
  refreshToolButtonsActive();
  renderLayerPanel();
  updateStatus();
}

function renderLayerPanel(): void {
  const panel = $('layer-panel');
  const list = $('layer-list');
  if (!panel || !list) return;
  // Only show the panel once a base image is loaded; until then the
  // editor is empty and the panel would be visual noise.
  if (!state.workData) {
    panel.classList.remove('show');
    list.innerHTML = '';
    return;
  }
  panel.classList.add('show');
  list.innerHTML = '';

  type Row = { id: string | null; name: string };
  // Top of the list = topmost in the composite. Materials render over
  // base, so materials come first and base is at the bottom.
  const rows: Row[] = [];
  for (let i = state.materials.length - 1; i >= 0; i--) {
    rows.push({ id: state.materials[i].id, name: state.materials[i].name });
  }
  rows.push({ id: null, name: t('layers.base') });

  for (const r of rows) {
    const li = document.createElement('li');
    if (state.activeMaterialId === r.id) li.classList.add('active');
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = r.name;
    li.appendChild(name);
    if (r.id !== null) {
      const del = document.createElement('button');
      del.className = 'layer-del';
      del.title = t('layers.delete');
      del.innerHTML = '<svg><use href="#i-x"/></svg>';
      del.onclick = e => {
        e.stopPropagation();
        removeMaterial(r.id!);
      };
      li.appendChild(del);
    }
    li.onclick = () => setActiveLayer(r.id);
    list.appendChild(li);
  }
}

// ============================================================================
// Tool selection
// ============================================================================
// Tool-hint keys; the actual translated string is fetched at render
// time via t() so language switches reflect immediately.
const TOOL_HINT_KEY = {
  erase:       'hint.erase',
  restore:     'hint.restore',
  wand:        'hint.wand',
  restoreWand: 'hint.restoreWand',
  rectSelect:  'hint.rect',
  move:        'hint.move',
};

function setTool(name) {
  const prev = state.tool;
  // Save the outgoing brush's size into its dedicated slot so the
  // remembered values stay in sync with whatever the slider currently
  // shows.
  if (prev === 'erase')   state.eraseSize   = state.brushSize;
  if (prev === 'restore') state.restoreSize = state.brushSize;

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
  // Restore the size remembered for the incoming brush.
  if (name === 'erase')   state.brushSize = state.eraseSize;
  if (name === 'restore') state.brushSize = state.restoreSize;
  // Brush size is meaningless for wand, rect-select, and move, so dim
  // the slider and show "—".
  const sizeIrrelevant = name === 'wand' || name === 'restoreWand' || name === 'rectSelect' || name === 'move';
  const sizeSlider = $<HTMLInputElement>('size-slider');
  const sizeDisplay = $('size-display');
  if (sizeSlider) {
    sizeSlider.disabled = sizeIrrelevant;
    if (!sizeIrrelevant) sizeSlider.value = String(state.brushSize);
  }
  if (sizeDisplay) sizeDisplay.textContent = sizeIrrelevant ? '—' : state.brushSize;
  // Color tolerance only applies to wand-class tools. Disable the
  // slider while a brush is selected so the user can't tweak a value
  // that has no effect.
  const isBrush = name === 'erase' || name === 'restore';
  const tolSlider  = $<HTMLInputElement>('tolerance-slider');
  const tolDisplay = $('tolerance-display');
  if (tolSlider)  tolSlider.disabled = isBrush;
  if (tolDisplay) tolDisplay.textContent = isBrush ? '—' : String(state.tolerance);
  // Crosshair cursor while in rect-select mode.
  workspace.classList.toggle('rect-select-mode', name === 'rectSelect');
  // Wand tools have no brush ring, so without this the workspace's
  // `cursor: none` would leave the user without any visible pointer.
  workspace.classList.toggle('wand-mode', name === 'wand' || name === 'restoreWand');
  // Move tool: standard "move" cursor.
  workspace.classList.toggle('move-mode', name === 'move');
  // Show the rect controls when a wand or rect-select is active and a
  // rectangle is currently set (or being created).
  updateRectControlsVisibility();
  refreshToolButtonsActive();
  // Tool-specific hint in the status bar.
  const hint = $('tool-hint');
  if (hint) hint.textContent = TOOL_HINT_KEY[name] ? t(TOOL_HINT_KEY[name]) : '';
  updateStatus();
}

// Active-state and visibility for the tool buttons. Split out from setTool
// so creating or clearing a rect can refresh the highlighting without
// switching the active tool.
function refreshToolButtonsActive() {
  const hasRect = !!state.rectSelection;
  const hasMaterial = !!getActiveMaterial();
  // Rect-select button is meaningful while a wand is in play, while
  // rect-select itself is active, or while a rect already exists.
  // Hide it while a material is active (rect lives in base coords).
  const rectBtn = document.querySelector('.tool-btn[data-tool="rectSelect"]');
  if (rectBtn) {
    const showRect = !hasMaterial && (
      state.tool === 'wand' || state.tool === 'restoreWand'
      || state.tool === 'rectSelect' || hasRect
    );
    rectBtn.style.display = showRect ? '' : 'none';
  }
  // Move tool is only meaningful when a material is active.
  const moveBtn = document.querySelector('.tool-btn[data-tool="move"]');
  if (moveBtn) {
    moveBtn.style.display = hasMaterial ? '' : 'none';
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
// Everything is bound at *document* level. The browser's default action
// for a file drop is to open the file in the tab — we have to
// preventDefault on dragover (and drop) to override that. Tracking
// dragenter/leave on a child element runs into the "leaving parent /
// entering child" problem; document-level dragover/dragleave with
// relatedTarget === null is the simplest way to drive the visual
// overlay reliably.
function setupDragDrop() {
  document.addEventListener('dragover', e => {
    e.preventDefault();
    // Only show the overlay when the drag actually carries files.
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
      dropOverlay.classList.add('show');
    }
  });

  document.addEventListener('dragleave', e => {
    // relatedTarget === null means the cursor left the window entirely
    // (any child-to-child transition keeps a non-null relatedTarget).
    if (e.relatedTarget === null) dropOverlay.classList.remove('show');
  });

  document.addEventListener('drop', e => {
    e.preventDefault();
    dropOverlay.classList.remove('show');
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;
    if (files.length > 1) {
      showToast(`${files.length} ${t('toast.multiDrop')}`);
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
  $('help-btn').onclick = () => {
    const overlay = $('help-overlay');
    // On mobile the shortcut tabs (file / tool / brush / history) are
    // hidden, so the default `file` tab would show an empty panel. Jump
    // to `features`, which contains every feature description, the
    // first time the dialog is opened on a small screen.
    if (!overlay.classList.contains('show') && matchMedia('(max-width: 768px)').matches) {
      $('help-box').setAttribute('data-help-tab', 'features');
      document.querySelectorAll('#help-tabs button').forEach(b => {
        b.classList.toggle('active', (b as HTMLElement).dataset.helpTarget === 'features');
      });
    }
    overlay.classList.toggle('show');
  };
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
  // i18n.setLang() / getLang() remain importable for dev / testing
  // (run `setLang('en')` from the Console if you need to override).
  // No user-facing UI: navigator.language detection handles 99% of cases.
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
  const materialAddBtn = $('material-add-btn');
  if (materialAddBtn) {
    materialAddBtn.onclick = () => $('material-file-input').click();
  }
  const materialFileInput = $('material-file-input');
  if (materialFileInput) {
    materialFileInput.onchange = () => {
      const f = materialFileInput.files[0];
      if (f) loadMaterialFromFile(f);
      materialFileInput.value = '';
    };
  }
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
    const v = +e.target.value;
    state.brushSize = v;
    // Mirror the change into the per-tool memory so switching away and
    // back restores this size.
    if (state.tool === 'erase')   state.eraseSize   = v;
    if (state.tool === 'restore') state.restoreSize = v;
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
  // `change` only fires when the value actually moves — clicks without
  // drag would leave focus stuck. `pointerup` catches that case too.
  ['size-slider', 'hardness-slider', 'tolerance-slider'].forEach(id => {
    const el = $(id);
    el.addEventListener('change',    e => (e.target as HTMLElement).blur());
    el.addEventListener('pointerup', e => (e.target as HTMLElement).blur());
  });
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
      showToast(t('toast.autosaveOff'));
    } else {
      autosaveNow();
      showToast(t('toast.autosaveOn'));
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
    materials: state.materials.map(m => ({
      id: m.id,
      name: m.name,
      data: m.data.buffer.slice(0),
      origData: m.origData.buffer.slice(0),
      w: m.w,
      h: m.h,
      x: m.x,
      y: m.y,
    })),
    activeMaterialId: state.activeMaterialId,
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

  // After a cancel-download reload we know the user was actively
  // working — skip the prompt and restore silently.
  let autoRestore = false;
  try {
    if (sessionStorage.getItem(AUTO_RESTORE_KEY) === '1') {
      autoRestore = true;
      sessionStorage.removeItem(AUTO_RESTORE_KEY);
    }
  } catch { /* private mode: fall through to the modal */ }

  if (!autoRestore) {
    const ageMin = Math.round((Date.now() - session.savedAt) / 60000);
    const ok = await showModal({
      title: t('modal.restore.title'),
      message:
        `${t('modal.restore.file')}: ${session.filename}\n` +
        `${t('modal.restore.size')}: ${session.imgW} × ${session.imgH}\n` +
        `${t('modal.restore.savedAt')}: ${ageMin} ${t('modal.restore.minutesAgo')}`,
      buttons: [
        { label: t('modal.restore.yes'), value: true, primary: true },
        { label: t('modal.restore.no'), value: false },
      ],
    });
    if (!ok) { clearAutosave(); return; }
  }

  state.imgW = session.imgW;
  state.imgH = session.imgH;
  state.filename = session.filename;
  state.origData = new Uint8ClampedArray(session.origData);
  state.workData = new Uint8ClampedArray(session.workData);
  state.undo = []; state.redo = [];
  // Restore materials (v2+ sessions). v1 sessions lack the field and
  // come back with no materials, which is exactly the right behavior.
  state.materials = (session.materials || []).map(m => ({
    id: m.id,
    name: m.name,
    data: new Uint8ClampedArray(m.data),
    origData: new Uint8ClampedArray(m.origData),
    w: m.w,
    h: m.h,
    x: m.x,
    y: m.y,
    undo: [],
    redo: [],
  }));
  state.activeMaterialId = session.activeMaterialId ?? null;
  invalidateMaterialCache();
  canvas.width = state.imgW;
  canvas.height = state.imgH;
  emptyHint.style.display = 'none';
  $('filename-status').textContent = state.filename;
  setTool('erase');
  renderLayerPanel();
  fitToScreen();
  redraw();
  updateStatus();
  if (!autoRestore) showToast(t('toast.restored'));
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
    if (e.target.closest('#help-overlay, #progress-overlay, #separate-bar, #cleanup-bar, #layer-panel')) return;
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
      const wsRect = workspace.getBoundingClientRect();
      pinchState = {
        startDist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
        startZoom: state.zoom,
        startPanX: state.panX,
        startPanY: state.panY,
        // Capture the initial midpoint in workspace coordinates so
        // two-finger drag (translation of the midpoint, no scale
        // change) translates the canvas pan by the same delta. Using
        // the *current* midpoint inside the move formula collapses
        // the pan term to zero when the ratio is 1 — that's why
        // two-finger pan felt frozen even though pinch-zoom worked.
        startCx: ((a.x + b.x) / 2) - wsRect.left,
        startCy: ((a.y + b.y) / 2) - wsRect.top,
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
      const wsRect = workspace.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - wsRect.left;
      const cy = (a.y + b.y) / 2 - wsRect.top;
      const ratio = newZoom / pinchState.startZoom;
      // Combined zoom + pan: keep the image point that was under the
      // starting midpoint anchored to the *current* midpoint. Pan term
      // uses the initial midpoint so that pure midpoint translation
      // (ratio = 1) moves the pan by the same delta — that's the
      // two-finger pan motion the user expects.
      state.panX = cx - (pinchState.startCx - pinchState.startPanX) * ratio;
      state.panY = cy - (pinchState.startCy - pinchState.startPanY) * ratio;
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

    // ESC: cancel running wand → cancel AI download (only during the
    // model-fetch phase; inference is uncancellable in transformers.js)
    // → exit component-picking mode → clear rect selection → close help.
    if (e.key === 'Escape') {
      if (isWandRunning()) { e.preventDefault(); cancelWand(); return; }
      if (bgRemovalRunning && bgPhase === 'model-fetch') {
        e.preventDefault();
        confirmCancelDownload();
        return;
      }
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
    if (key === 'o' && !cmd && state.origData) {
      e.preventDefault();
      toggleOriginalOverlay(state.origData, state.imgW, state.imgH);
      return;
    }
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
      // Keep the per-tool memory in sync with [ / ] adjustments too.
      if (state.tool === 'erase')   state.eraseSize   = state.brushSize;
      if (state.tool === 'restore') state.restoreSize = state.brushSize;
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

// PWA disabled for now. The previous service worker cached
// `eraser.html` and served it as a catch-all, which started
// hijacking /en and /ja once those landing pages shipped. Until the
// caching strategy is redesigned to understand multi-page routing,
// we don't register anything.
//
// Note: existing users who already have the old SW will fetch the
// new (kill-switch) sw.js on their next visit anyway — the browser
// re-checks SW updates on every page load. So we don't need to
// register here just to push the kill switch.
//
// To bring PWA back later, re-introduce a registration here AND
// rewrite public/sw.js to handle multi-page caching properly.

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

// Wire render-side hooks (component overlay redraw on transform, tool-
// button refresh on rect clear) and history hooks first, so anything
// triggered during the rest of init sees the application callbacks.
setRenderHooks({
  refreshToolButtons: refreshToolButtonsActive,
  drawComponentOverlay,
});
initHistory({ redraw, updateStatus, scheduleAutosave, exitSeparateMode, exitCleanupMode });

// Replace static Japanese markup with the chosen language *before*
// any code reads textContent / data-tip / aria-label off the DOM.
applyI18n();

bindUI();
bindCanvas();
bindKeys();
setupDragDrop();
initTheme();
initMobileDock();
// Apply initial tool state to the DOM (hides the rect-select button until
// a wand is picked, sets the active highlight, etc).
setTool(state.tool);
updateStatus();

// React to manual language switches: re-fill DOM, re-render dynamic
// labels (tool-status, tool-hint), re-render the theme button.
window.addEventListener('langchange', () => {
  applyI18n();
  // Re-apply tool-dependent text that lives on state, not on DOM.
  setTool(state.tool);
  updateStatus();
});
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

