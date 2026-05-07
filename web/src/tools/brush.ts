// Brush — paint a single dab (applyBrushDab) or interpolate dabs along
// a line (applyStroke). Reads state directly: brushSize, brushHardness,
// tolerance, current tool, workData / origData. Writes into workData.
//
// Two modes:
//   - erase  : reduces alpha by `factor` (factor = 1 inside the hard
//              radius, 0 at the outer feather edge, smooth cosine in
//              between)
//   - restore: lerps RGBA toward origData by `factor`
//
// Optional color tolerance: skip pixels that don't match `sampleColor`
// within the tolerance threshold. The sample is captured once at stroke
// start so a moving brush respects the original target color.

import { state } from '../state';

interface SampleColor { r: number; g: number; b: number }

function colorMatches(idx: number, refR: number, refG: number, refB: number): boolean {
  const data = state.workData!;
  const dr = data[idx]     - refR;
  const dg = data[idx + 1] - refG;
  const db = data[idx + 2] - refB;
  const d2 = dr * dr + dg * dg + db * db;
  const max = (state.tolerance / 100) * 441;
  return d2 <= max * max;
}

export function applyBrushDab(cx: number, cy: number, sampleColor: SampleColor | null): void {
  const data = state.workData;
  const orig = state.origData;
  if (!data || !orig) return;
  const r = state.brushSize;
  const r2 = r * r;
  const hardness = state.brushHardness / 100;
  const innerR = r * hardness;
  const featherSpan = r - innerR;

  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(state.imgW - 1, Math.ceil(cx + r));
  const y1 = Math.min(state.imgH - 1, Math.ceil(cy + r));

  const W = state.imgW;
  const isErase = state.tool === 'erase';
  const useTol = state.toleranceOn && !!sampleColor;

  for (let py = y0; py <= y1; py++) {
    const dy = py - cy;
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
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
      if (useTol && !colorMatches(idx, sampleColor!.r, sampleColor!.g, sampleColor!.b)) continue;
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
}

export function applyStroke(
  x0: number, y0: number, x1: number, y1: number,
  sampleColor: SampleColor | null,
): void {
  const dx = x1 - x0, dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const stepSize = Math.max(0.5, state.brushSize * 0.25);
  const steps = Math.max(1, Math.ceil(dist / stepSize));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    applyBrushDab(x0 + dx * t, y0 + dy * t, sampleColor);
  }
}
