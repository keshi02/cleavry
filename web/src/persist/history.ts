// Undo / redo stacks (snapshot-based).
//
// pushUndo() captures the *current* active-layer pixel buffer before a
// mutation. undo() / redoFn() swap the active layer's data with the most
// recent snapshot from the corresponding stack. Each material layer keeps
// its own pair of stacks, plus state.undo/redo for the base. All stacks
// are bounded by state.maxUndo.
//
// Side effects (redraw, exit-mode cleanup, autosave hook, status bar)
// are injected via initHistory() so this module doesn't import the
// rest of main.ts.

import { state } from '../state';
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

export function pushUndo(): void {
  const m = getActiveMaterial();
  if (m) {
    m.undo.push(new Uint8ClampedArray(m.data));
    if (m.undo.length > state.maxUndo) m.undo.shift();
    m.redo = [];
  } else {
    if (!state.workData) return;
    state.undo.push(new Uint8ClampedArray(state.workData));
    if (state.undo.length > state.maxUndo) state.undo.shift();
    state.redo = [];
  }
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}

export function undo(): void {
  const m = getActiveMaterial();
  if (m) {
    if (m.undo.length === 0) return;
  } else {
    if (state.undo.length === 0 || !state.workData) return;
  }
  // We only exit picking modes once we know an undo will actually fire,
  // so an empty stack doesn't accidentally close them out.
  if (state.separateMode) hooks?.exitSeparateMode();
  if (state.cleanupMode)  hooks?.exitCleanupMode();
  if (m) {
    m.redo.push(new Uint8ClampedArray(m.data));
    m.data = m.undo.pop()!;
    invalidateMaterialCache(m.id);
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
    m.undo.push(new Uint8ClampedArray(m.data));
    m.data = m.redo.pop()!;
    invalidateMaterialCache(m.id);
  } else {
    state.undo.push(new Uint8ClampedArray(state.workData!));
    state.workData = state.redo.pop()!;
  }
  hooks?.redraw();
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}
