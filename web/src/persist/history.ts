// Undo / redo stacks.
//
// Two stack shapes:
//   - Base: `state.undo: Uint8ClampedArray[]` — raw pixel snapshots,
//     since base position / size never change.
//   - Material: `m.undo: MaterialSnap[]` — captures (x, y, w, h)
//     always, plus optional pixel buffers when the operation actually
//     mutated them. Lets us roundtrip moves, resizes, and pixel edits
//     through the same stack.
//
// Helpers are exported so callers in main.ts can push specialised
// snapshots (move-only, resize, full) when they know exactly what
// changed. pushUndo() is the catch-all used by brush strokes and
// other pixel-mutating ops.

import { state, MaterialLayer, MaterialSnap } from '../state';
import { getActiveMaterial } from '../layers/active';
import { invalidateMaterialCache } from '../canvas/render';

export interface HistoryHooks {
  redraw(): void;
  updateStatus(): void;
  scheduleAutosave(): void;
  exitSeparateMode(): void;
  exitCleanupMode(): void;
}

let hooks: HistoryHooks | null = null;

export function initHistory(h: HistoryHooks): void {
  hooks = h;
}

function bound(m: MaterialLayer, snap: MaterialSnap): void {
  m.undo.push(snap);
  if (m.undo.length > state.maxUndo) m.undo.shift();
  m.redo = [];
}

// Catch-all push: snapshots data (pre-mutation) plus transform.
// Brushes and wand-on-material use this.
export function pushUndo(): void {
  const m = getActiveMaterial();
  if (m) {
    bound(m, {
      data: new Uint8ClampedArray(m.data),
      x: m.x, y: m.y, w: m.w, h: m.h,
    });
  } else {
    if (!state.workData) return;
    state.undo.push(new Uint8ClampedArray(state.workData));
    if (state.undo.length > state.maxUndo) state.undo.shift();
    state.redo = [];
  }
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}

// Transform-only snapshot — for moves where pixels don't change.
// Caller passes the pre-move x/y; w/h come from the current material.
export function pushMoveUndo(prevX: number, prevY: number): void {
  const m = getActiveMaterial();
  if (!m) return;
  bound(m, { x: prevX, y: prevY, w: m.w, h: m.h });
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}

// Resize snapshot — pre-resize data + origData + transform. Caller is
// expected to call this BEFORE rescaling.
export function pushResizeUndo(): void {
  const m = getActiveMaterial();
  if (!m) return;
  bound(m, {
    data: new Uint8ClampedArray(m.data),
    origData: new Uint8ClampedArray(m.origData),
    x: m.x, y: m.y, w: m.w, h: m.h,
  });
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}

function applyMaterialSnap(m: MaterialLayer, snap: MaterialSnap): MaterialSnap {
  // Build the inverse for the redo stack: capture *current* values for
  // whichever fields the incoming snap is going to touch.
  const inverse: MaterialSnap = { x: m.x, y: m.y, w: m.w, h: m.h };
  if (snap.data !== undefined) inverse.data = m.data;
  if (snap.origData !== undefined) inverse.origData = m.origData;
  // Now apply the snap.
  m.x = snap.x; m.y = snap.y; m.w = snap.w; m.h = snap.h;
  if (snap.data !== undefined) m.data = snap.data;
  if (snap.origData !== undefined) m.origData = snap.origData;
  invalidateMaterialCache(m.id);
  return inverse;
}

export function undo(): void {
  const m = getActiveMaterial();
  if (m) {
    if (m.undo.length === 0) return;
  } else {
    if (state.undo.length === 0 || !state.workData) return;
  }
  if (state.separateMode) hooks?.exitSeparateMode();
  if (state.cleanupMode)  hooks?.exitCleanupMode();
  if (m) {
    const snap = m.undo.pop()!;
    const inverse = applyMaterialSnap(m, snap);
    m.redo.push(inverse);
  } else {
    state.redo.push(new Uint8ClampedArray(state.workData!));
    state.workData = state.undo.pop()!;
  }
  hooks?.redraw();
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}

export function redoFn(): void {
  const m = getActiveMaterial();
  if (m) {
    if (m.redo.length === 0) return;
  } else {
    if (state.redo.length === 0 || !state.workData) return;
  }
  if (state.separateMode) hooks?.exitSeparateMode();
  if (state.cleanupMode)  hooks?.exitCleanupMode();
  if (m) {
    const snap = m.redo.pop()!;
    const inverse = applyMaterialSnap(m, snap);
    m.undo.push(inverse);
  } else {
    state.undo.push(new Uint8ClampedArray(state.workData!));
    state.workData = state.redo.pop()!;
  }
  hooks?.redraw();
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}
