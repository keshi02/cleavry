// Save the working image to disk via a programmatic <a download>.
// Honours format (PNG / WebP / JPEG), the feather toggle, and the
// preserve-canvas toggle (whether to crop to the opaque bounds or
// keep the source dimensions).
//
// Throws on "nothing to save"; caller is expected to surface the
// message via showError().

import { feather } from '../image/feather';

export type SaveFormat = 'png' | 'webp' | 'jpeg';

export interface SaveOptions {
  data: Uint8ClampedArray;
  W: number;
  H: number;
  filename: string;
  format: SaveFormat;
  preserveCanvas: boolean;
  featherActive: boolean;
  featherStrength: number;
}

export interface SaveResult {
  outW: number;
  outH: number;
}

function getOpaqueBounds(data: Uint8ClampedArray, W: number, H: number) {
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

function downloadBlob(blob: Blob, baseName: string, ext: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}_edited.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error('canvas.toBlob failed')), mime, quality);
  });
}

export async function saveImage(opts: SaveOptions): Promise<SaveResult> {
  const { W, H, format, preserveCanvas, featherActive, featherStrength } = opts;

  // Apply feather (if toggled) once on the full canvas, then crop —
  // this way the softened edge can extend a pixel or two beyond the
  // pre-feather bounding box without being clipped off.
  const sourceData = featherActive
    ? feather(opts.data, W, H, (featherStrength | 0) || 1)
    : opts.data;

  let outW: number, outH: number, outData: Uint8ClampedArray;
  if (preserveCanvas) {
    outW = W;
    outH = H;
    outData = sourceData;
  } else {
    const b = getOpaqueBounds(sourceData, W, H);
    if (!b) throw new Error('保存できる内容がありません');
    outW = b.maxX - b.minX + 1;
    outH = b.maxY - b.minY + 1;
    outData = new Uint8ClampedArray(outW * outH * 4);
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
  out.getContext('2d')!.putImageData(
    new ImageData(outData as Uint8ClampedArray<ArrayBuffer>, outW, outH),
    0, 0,
  );

  const mime = `image/${format}`;
  const ext = format === 'jpeg' ? 'jpg' : format;
  const baseName = (opts.filename || 'image').replace(/\.[^.]+$/, '') || 'image';

  let blob: Blob;
  if (format === 'jpeg') {
    // JPEG has no alpha — flatten onto white so the user gets a sane export.
    const flat = document.createElement('canvas');
    flat.width = outW;
    flat.height = outH;
    const fctx = flat.getContext('2d')!;
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, outW, outH);
    fctx.drawImage(out, 0, 0);
    blob = await canvasToBlob(flat, mime, 0.92);
  } else {
    blob = await canvasToBlob(out, mime, format === 'webp' ? 0.92 : undefined);
  }

  downloadBlob(blob, baseName, ext);
  return { outW, outH };
}
