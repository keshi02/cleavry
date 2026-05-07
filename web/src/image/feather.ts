// Edge feathering — soften aliased alpha boundaries (e.g. hair tips
// left jagged by an AI cutout).
//
// Operates in *premultiplied alpha* so feathered pixels inherit color
// from neighbouring opaque pixels rather than from RGB(0,0,0). Without
// this, AI-cutout PNGs (where transparent pixels have RGB=0) produce a
// black halo when feathered. The blur runs on (R*A, G*A, B*A, A); we
// unpremultiply at the end, dividing by the new alpha to recover the
// visible color.
//
// Pure: takes RGBA bytes, returns a fresh RGBA buffer.

export function feather(
  src: Uint8ClampedArray,
  W: number,
  H: number,
  iterations = 1,
): Uint8ClampedArray {
  const N = W * H;
  let r = new Float32Array(N);
  let g = new Float32Array(N);
  let b = new Float32Array(N);
  let a = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const ai = src[i * 4 + 3] / 255;
    a[i] = ai;
    r[i] = src[i * 4]     * ai;
    g[i] = src[i * 4 + 1] * ai;
    b[i] = src[i * 4 + 2] * ai;
  }
  let nr = new Float32Array(N), ng = new Float32Array(N),
      nb = new Float32Array(N), na = new Float32Array(N);

  for (let iter = 0; iter < iterations; iter++) {
    for (let y = 0; y < H; y++) {
      const rowBase = y * W;
      const yPrev = y > 0 ? rowBase - W : rowBase;
      const yNext = y < H - 1 ? rowBase + W : rowBase;
      for (let x = 0; x < W; x++) {
        const xPrev = x > 0 ? x - 1 : x;
        const xNext = x < W - 1 ? x + 1 : x;
        const i00 = yPrev + xPrev,   i01 = yPrev + x,   i02 = yPrev + xNext;
        const i10 = rowBase + xPrev, i11 = rowBase + x, i12 = rowBase + xNext;
        const i20 = yNext + xPrev,   i21 = yNext + x,   i22 = yNext + xNext;

        // Boundary detection: only blur where the 3×3 neighborhood mixes
        // transparent and opaque. Pure interior (every neighbor a===1) is
        // copied verbatim — without this, RGB inside an element averages
        // with adjacent pixels and softens line art / textures. Pure
        // exterior (every neighbor a===0) is also skipped (nothing to do).
        const a00 = a[i00], a01 = a[i01], a02 = a[i02];
        const a10 = a[i10], a11 = a[i11], a12 = a[i12];
        const a20 = a[i20], a21 = a[i21], a22 = a[i22];
        const hasTransparent =
          a00 < 1 || a01 < 1 || a02 < 1 ||
          a10 < 1 || a11 < 1 || a12 < 1 ||
          a20 < 1 || a21 < 1 || a22 < 1;
        const hasOpaque =
          a00 > 0 || a01 > 0 || a02 > 0 ||
          a10 > 0 || a11 > 0 || a12 > 0 ||
          a20 > 0 || a21 > 0 || a22 > 0;

        if (!hasTransparent || !hasOpaque) {
          nr[i11] = r[i11];
          ng[i11] = g[i11];
          nb[i11] = b[i11];
          na[i11] = a11;
        } else {
          nr[i11] = (r[i00]+r[i01]+r[i02]+r[i10]+r[i11]+r[i12]+r[i20]+r[i21]+r[i22]) / 9;
          ng[i11] = (g[i00]+g[i01]+g[i02]+g[i10]+g[i11]+g[i12]+g[i20]+g[i21]+g[i22]) / 9;
          nb[i11] = (b[i00]+b[i01]+b[i02]+b[i10]+b[i11]+b[i12]+b[i20]+b[i21]+b[i22]) / 9;
          na[i11] = (a00+a01+a02+a10+a11+a12+a20+a21+a22) / 9;
        }
      }
    }
    let tmp;
    tmp = r; r = nr; nr = tmp;
    tmp = g; g = ng; ng = tmp;
    tmp = b; b = nb; nb = tmp;
    tmp = a; a = na; na = tmp;
  }

  const out = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const ai = a[i];
    if (ai > 0) {
      out[i * 4]     = r[i] / ai;  // Uint8ClampedArray clamps to [0, 255]
      out[i * 4 + 1] = g[i] / ai;
      out[i * 4 + 2] = b[i] / ai;
      out[i * 4 + 3] = ai * 255;
    }
    // ai === 0: out stays zero (transparent black, default-initialised)
  }
  return out;
}
