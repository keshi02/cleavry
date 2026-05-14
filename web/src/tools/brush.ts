// Brush — paint a single dab (applyBrushDab) or interpolate dabs along
// a line (applyStroke). Coordinates come in as base-canvas coords;
// the brush translates them into the active layer's local space and
// operates on that layer's pixel buffer.
//
// Two modes:
//   - erase  : reduces alpha by `factor` (factor = 1 inside the hard
//              radius, 0 at the outer feather edge, smooth cosine in
//              between)
//   - restore: lerps RGBA toward the layer's origData by `factor`
//
// Color tolerance is a wand-only feature; the brush always paints
// every pixel inside its radius regardless of color.

import { state } from '../state';
import { getActiveLayer } from '../layers/active';
import { invalidateMaterialCache } from '../canvas/render';

export function applyBrushDab(cx: number, cy: number): void {
  const layer = getActiveLayer();
  if (!layer) return;
  // Translate base-canvas coords into the layer's local space.
  const lcx = cx - layer.offsetX;
  const lcy = cy - layer.offsetY;

  const r = state.brushSize;
  const r2 = r * r;
  const hardness = state.brushHardness / 100;
  const innerR = r * hardness;
  const featherSpan = r - innerR;

  const x0 = Math.max(0, Math.floor(lcx - r));
  const y0 = Math.max(0, Math.floor(lcy - r));
  const x1 = Math.min(layer.w - 1, Math.ceil(lcx + r));
  const y1 = Math.min(layer.h - 1, Math.ceil(lcy + r));
  if (x1 < 0 || y1 < 0 || x0 >= layer.w || y0 >= layer.h) return;

  const W = layer.w;
  const data = layer.data;
  const orig = layer.origData;
  const isErase = state.tool === 'erase';

  for (let py = y0; py <= y1; py++) {
    const dy = py - lcy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - lcx;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > r2) continue;
      const dist = Math.sqrt(dist2);
      let factor: number;
      if (dist <= innerR) {
        factor = 1;
      } else if (featherSpan > 0) {
        const t = (dist - innerR) / featherSpan;
        factor = 0.5 + 0.5 * Math.cos(t * Math.PI);
      } else {
        factor = 0;
      }
      const idx = (py * W + px) * 4;
      if (isErase) {
        const oldA = data[idx + 3];
        const newA = oldA * (1 - factor);
        if (newA < oldA) data[idx + 3] = newA | 0;
      } else {
        // restore — lerp toward origData
        for (let k = 0; k < 4; k++) {
          const od = data[idx + k];
          const og = orig[idx + k];
          data[idx + k] = (od + (og - od) * factor) | 0;
        }
      }
    }
  }
  if (layer.isMaterial && layer.materialId) {
    invalidateMaterialCache(layer.materialId);
  }
}

export function applyStroke(x0: number, y0: number, x1: number, y1: number): void {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const stepSize = Math.max(0.5, state.brushSize * 0.25);
  const steps = Math.max(1, Math.ceil(dist / stepSize));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    applyBrushDab(x0 + dx * t, y0 + dy * t);
  }
}
