// Undo / redo stacks (snapshot-based).
//
// pushUndo() captures the *current* workData before a mutation. undo() /
// redoFn() swap the active workData with the most recent snapshot from
// the corresponding stack. Both stacks are bounded by state.maxUndo.
//
// Side effects (redraw, exit-mode cleanup, autosave hook, status bar)
// are injected via initHistory() so this module doesn't import the
// rest of main.ts.

import { state } from '../state';

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
  if (!state.workData) return;
  state.undo.push(new Uint8ClampedArray(state.workData));
  if (state.undo.length > state.maxUndo) state.undo.shift();
  state.redo = [];
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}

export function undo(): void {
  if (state.undo.length === 0 || !state.workData) return;
  if (state.separateMode) hooks?.exitSeparateMode();   // mask becomes stale
  if (state.cleanupMode)  hooks?.exitCleanupMode();
  state.redo.push(new Uint8ClampedArray(state.workData));
  state.workData = state.undo.pop()!;
  hooks?.redraw();
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}

export function redoFn(): void {
  if (state.redo.length === 0 || !state.workData) return;
  if (state.separateMode) hooks?.exitSeparateMode();
  if (state.cleanupMode)  hooks?.exitCleanupMode();
  state.undo.push(new Uint8ClampedArray(state.workData));
  state.workData = state.redo.pop()!;
  hooks?.redraw();
  hooks?.updateStatus();
  hooks?.scheduleAutosave();
}
