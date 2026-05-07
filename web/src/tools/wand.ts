// Magic wand — flood-fill connected pixels by color similarity.
//
// Async chunked BFS so the UI stays responsive on big images: each frame
// processes pixels for ~14 ms, yields with requestAnimationFrame, and
// updates progress. ESC sets job.cancelled and the next frame rolls
// workData back to the pre-wand snapshot.
//
// Two modes share the BFS skeleton:
//   - erase   : group by *current* workData color, set alpha=0
//   - restore : group by *origData* color, copy origData back
//
// Rect-restriction: if state.rectSelection is set, the BFS is confined
// to (or excludes) that rectangle based on state.rectInverse.

import { state } from '../state';

export interface WandCallbacks {
  showProgress(label: string): void;
  updateProgress(percent: number): void;
  hideProgress(): void;
  redraw(): void;
  updateStatus(): void;
  scheduleAutosave(): void;
}

interface WandJob { cancelled: boolean }

let currentJob: WandJob | null = null;

export function isWandRunning(): boolean {
  return currentJob !== null;
}

export function cancelWand(): void {
  if (currentJob) currentJob.cancelled = true;
}

function rectAllows(px: number, py: number): boolean {
  const r = state.rectSelection;
  if (!r) return true;
  const inside = px >= r.minX && px <= r.maxX && py >= r.minY && py <= r.maxY;
  return state.rectInverse ? !inside : inside;
}

export function magicWandAt(ix: number, iy: number, cb: WandCallbacks): void {
  if (!state.workData) return;
  if (currentJob) return;     // ignore re-entry while one is running

  // If the rect-select tool is active but no rect has been drawn yet,
  // the user has explicitly armed a scope without specifying it —
  // don't quietly fall through to a full-canvas wand.
  if (state.tool === 'rectSelect' && !state.rectSelection) return;

  const px0 = Math.floor(ix), py0 = Math.floor(iy);
  if (px0 < 0 || py0 < 0 || px0 >= state.imgW || py0 >= state.imgH) return;

  const W = state.imgW, H = state.imgH;
  const isRestore = state.tool === 'restoreWand';
  // Restore-wand groups by *original* color; erase-wand groups by
  // *current* color so it can keep eating into a region after partial
  // edits. Both share the same BFS skeleton.
  const refData = isRestore ? state.origData! : state.workData;
  const startIdx = (py0 * W + px0) * 4;
  if (isRestore && refData[startIdx + 3] === 0) return;       // nothing to restore
  if (!isRestore && state.workData[startIdx + 3] === 0) return; // already transparent
  if (!rectAllows(px0, py0)) return;

  const r0 = refData[startIdx];
  const g0 = refData[startIdx + 1];
  const b0 = refData[startIdx + 2];
  const tolMax = (state.tolerance / 100) * 441;
  const tolMax2 = tolMax * tolMax;

  // Capture rect restriction once so the hot loop avoids property lookups.
  const _rect = state.rectSelection;
  const hasRect = !!_rect;
  const rInv = state.rectInverse;
  const rMinX = hasRect ? _rect!.minX : 0;
  const rMinY = hasRect ? _rect!.minY : 0;
  const rMaxX = hasRect ? _rect!.maxX : 0;
  const rMaxY = hasRect ? _rect!.maxY : 0;

  // Snapshot for undo BEFORE mutating, kept locally so we can roll
  // back on cancel without polluting the redo stack.
  const snapshot = new Uint8ClampedArray(state.workData);

  const visited = new Uint8Array(W * H);
  // visited-at-push means each pixel enters at most once → exact upper bound.
  const stack = new Int32Array(W * H * 2);
  let sp = 0;
  stack[sp++] = px0;
  stack[sp++] = py0;
  visited[py0 * W + px0] = 1;

  const totalPixels = W * H;
  let processedPixels = 0;

  const job: WandJob = { cancelled: false };
  currentJob = job;
  cb.showProgress(isRestore ? '復元ワンド処理中…' : 'マジックワンド処理中…');

  function step(): void {
    if (job.cancelled) {
      state.workData = snapshot;
      cb.redraw();
      cb.hideProgress();
      currentJob = null;
      return;
    }

    const startTime = performance.now();
    const FRAME_BUDGET_MS = 14;

    const data = state.workData!;
    const orig = state.origData!;
    while (sp > 0 && performance.now() - startTime < FRAME_BUDGET_MS) {
      const y = stack[--sp];
      const x = stack[--sp];
      const pi = y * W + x;
      const di = pi * 4;
      // For restore-wand, transparent source pixels can't match — skip
      // them before the (cheap) color test so we don't bleed into empties.
      if (isRestore && refData[di + 3] === 0) continue;
      const dr = refData[di]     - r0;
      const dg = refData[di + 1] - g0;
      const db = refData[di + 2] - b0;
      if (dr * dr + dg * dg + db * db > tolMax2) continue;
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
        if (!visited[ni] && (!hasRect || (rInv
          ? !(x + 1 >= rMinX && x + 1 <= rMaxX && y >= rMinY && y <= rMaxY)
          :  (x + 1 >= rMinX && x + 1 <= rMaxX && y >= rMinY && y <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x + 1; stack[sp++] = y;
        }
      }
      if (x > 0) {
        const ni = pi - 1;
        if (!visited[ni] && (!hasRect || (rInv
          ? !(x - 1 >= rMinX && x - 1 <= rMaxX && y >= rMinY && y <= rMaxY)
          :  (x - 1 >= rMinX && x - 1 <= rMaxX && y >= rMinY && y <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x - 1; stack[sp++] = y;
        }
      }
      if (y + 1 < H) {
        const ni = pi + W;
        if (!visited[ni] && (!hasRect || (rInv
          ? !(x >= rMinX && x <= rMaxX && y + 1 >= rMinY && y + 1 <= rMaxY)
          :  (x >= rMinX && x <= rMaxX && y + 1 >= rMinY && y + 1 <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x; stack[sp++] = y + 1;
        }
      }
      if (y > 0) {
        const ni = pi - W;
        if (!visited[ni] && (!hasRect || (rInv
          ? !(x >= rMinX && x <= rMaxX && y - 1 >= rMinY && y - 1 <= rMaxY)
          :  (x >= rMinX && x <= rMaxX && y - 1 >= rMinY && y - 1 <= rMaxY)))) {
          visited[ni] = 1; stack[sp++] = x; stack[sp++] = y - 1;
        }
      }
    }

    cb.updateProgress(Math.min(99, (processedPixels / totalPixels) * 100));
    cb.redraw();

    if (sp === 0) {
      // Done — push the *snapshot* (pre-wand state) directly to undo
      // instead of calling pushUndo(): pushUndo() would snapshot the
      // *current* (post-wand) workData and undo would have nowhere to
      // roll back to. We fire scheduleAutosave manually since we
      // bypassed pushUndo's normal autosave hook.
      state.undo.push(snapshot);
      if (state.undo.length > state.maxUndo) state.undo.shift();
      state.redo = [];
      cb.hideProgress();
      currentJob = null;
      cb.updateStatus();
      cb.scheduleAutosave();
      return;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
