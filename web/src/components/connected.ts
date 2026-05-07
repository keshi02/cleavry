// Connected-component detection for opaque pixels (8-connectivity).
//
// Returns:
//   - mask:       Uint32Array (W*H), 0 = transparent or noise speck,
//                 1+ = component id
//   - components: array of {id, bbox, area, selected}, sorted largest
//                 area first (so meaningful elements show up before
//                 noise in the UI)
//
// Pure: takes RGBA bytes + dimensions, returns fresh mask + array.
// Caller uses the same id space to map back from mask → component.

import type { ConnectedComponent } from '../state';

export const SEPARATE_MIN_AREA = 4;   // ignore noise specks smaller than this

export interface ConnectedResult {
  components: ConnectedComponent[];
  mask: Uint32Array;
}

export function detectComponents(
  data: Uint8ClampedArray,
  W: number,
  H: number,
): ConnectedResult {
  const mask = new Uint32Array(W * H);
  const components: ConnectedComponent[] = [];
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
      // Tiny specks keep their id in mask but stay out of the UI list.
    }
  }

  components.sort((a, b) => b.area - a.area);
  return { components, mask };
}
