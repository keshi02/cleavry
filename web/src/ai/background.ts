// AI background removal — runs entirely in the browser. Pure inference
// API: caller hands in an image data-URL, we hand back an alpha mask
// matching the original dimensions. No state, no UI.
//
// Stack: transformers.js v4 (`@huggingface/transformers`) driving
// AutoModel / AutoProcessor directly, against
// `onnx-community/BiRefNet_512x512-ONNX` at fp16 on WebGPU.
//
// Why 512×512 + fp16 + WebGPU: the 1024-input model breaks
// onnxruntime-web's WebGPU shader-buffer ceiling, and fp32 weights
// OOM the WASM 4 GB heap. fp16 + WebGPU sidesteps both.

const TRANSFORMERS_VERSION = '4.2.0';
const BG_MODEL_ID = 'onnx-community/BiRefNet_512x512-ONNX';

export type Phase = 'model-fetch' | 'preparing' | 'inferring' | 'finalizing';

export interface BgProgress {
  phase: Phase;
  progress: number;  // 0..100
}

let bgModule: any = null;
let segmenter: { model: any; processor: any; RawImage: any } | null = null;

async function loadModule(): Promise<any> {
  if (bgModule) return bgModule;
  bgModule = await import(
    /* @vite-ignore */
    `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TRANSFORMERS_VERSION}`
  );
  bgModule.env.allowLocalModels = false;
  bgModule.env.allowRemoteModels = true;
  return bgModule;
}

async function getSegmenter(progressCallback?: (data: any) => void) {
  if (segmenter) return segmenter;
  const mod = await loadModule();
  const { AutoModel, AutoProcessor, RawImage } = mod;
  const hasWebGPU = typeof navigator !== 'undefined'
    && typeof (navigator as any).gpu !== 'undefined';
  if (!hasWebGPU) {
    throw new Error(
      'AI 背景除去には WebGPU 対応ブラウザが必要です。' +
      'Chrome / Edge / Firefox（最新版）でお試しください。' +
      'Safari は現状非対応です。'
    );
  }
  const model = await AutoModel.from_pretrained(BG_MODEL_ID, {
    dtype: 'fp16',
    device: 'webgpu',
    progress_callback: progressCallback,
  });
  const processor = await AutoProcessor.from_pretrained(BG_MODEL_ID, {
    progress_callback: progressCallback,
  });
  segmenter = { model, processor, RawImage };
  return segmenter;
}

// Run the model and return a per-pixel alpha mask (0..255), upsampled to
// outW × outH via canvas bicubic. The caller is responsible for taking
// `imageDataURL` from a canvas / file and for writing the returned mask
// into wherever it needs to land.
export async function segmentBackground(
  imageDataURL: string,
  outW: number,
  outH: number,
  onProgress?: (e: BgProgress) => void,
): Promise<Uint8Array> {
  // transformers.js fires per-file 'progress' events for several
  // shards (weights / config / processor). Each one resets the
  // per-file `progress` back to 0, which the user reads as "the
  // modal restarted." Aggregate by bytes across all files we've
  // seen so the bar advances monotonically 0→100 across the whole
  // model load.
  //
  // 'done' fires once per file too — and the previous code mapped
  // both 'done' and 'ready' to the next phase, which prematurely
  // flipped the cancel hint off the very first time any single file
  // finished. We deliberately ignore 'done' here and rely on the
  // post-`getSegmenter` "inferring" event below, which only fires
  // after every file has actually loaded.
  const bytesByFile = new Map<string, { loaded: number; total: number }>();
  const { model, processor, RawImage } = await getSegmenter(data => {
    if (!data) return;
    if (data.status === 'progress' && typeof data.loaded === 'number' && typeof data.total === 'number') {
      bytesByFile.set(data.file ?? 'unknown', { loaded: data.loaded, total: data.total });
      let loaded = 0, total = 0;
      for (const v of bytesByFile.values()) { loaded += v.loaded; total += v.total; }
      const pct = total > 0 ? (loaded / total) * 100 : 0;
      onProgress?.({ phase: 'model-fetch', progress: Math.min(99, pct) });
    } else if (data.status === 'done' && typeof data.file === 'string') {
      // Pin the just-finished file to 100% so the aggregate doesn't
      // stall under 100 if the last 'progress' event came in below
      // total.
      const e = bytesByFile.get(data.file);
      if (e) bytesByFile.set(data.file, { loaded: e.total, total: e.total });
    }
  });

  onProgress?.({ phase: 'inferring', progress: 0 });

  const image = await RawImage.fromURL(imageDataURL);
  const { pixel_values } = await processor(image);
  const modelOut = await model({ input_image: pixel_values });

  let maskTensor =
       modelOut.logits
    ?? modelOut.output_image
    ?? modelOut.output
    ?? null;
  if (!maskTensor) {
    const vals = Object.values(modelOut)
      .filter((v: any) => v && typeof v.sigmoid === 'function');
    maskTensor = vals[vals.length - 1];
  }
  if (!maskTensor) throw new Error('AI モデルの出力形式を解釈できませんでした');

  const lowMask = await RawImage.fromTensor(
    maskTensor[0].sigmoid().mul(255).to('uint8')
  );

  onProgress?.({ phase: 'finalizing', progress: 99 });

  // Upsample the low-res alpha mask back to the source resolution.
  // Canvas bicubic is good enough for the soft mask edges BiRefNet
  // produces — adding a sharper edge filter tends to look worse.
  const lowW = lowMask.width;
  const lowH = lowMask.height;
  const lowCanvas = document.createElement('canvas');
  lowCanvas.width = lowW;
  lowCanvas.height = lowH;
  const lowCtx = lowCanvas.getContext('2d')!;
  const lowImg = lowCtx.createImageData(lowW, lowH);
  for (let i = 0; i < lowW * lowH; i++) {
    const v = lowMask.data[i] | 0;
    lowImg.data[i * 4]     = v;
    lowImg.data[i * 4 + 1] = v;
    lowImg.data[i * 4 + 2] = v;
    lowImg.data[i * 4 + 3] = 255;
  }
  lowCtx.putImageData(lowImg, 0, 0);

  const hiCanvas = document.createElement('canvas');
  hiCanvas.width = outW;
  hiCanvas.height = outH;
  const hiCtx = hiCanvas.getContext('2d')!;
  hiCtx.imageSmoothingEnabled = true;
  hiCtx.imageSmoothingQuality = 'high';
  hiCtx.drawImage(lowCanvas, 0, 0, outW, outH);
  const hiData = hiCtx.getImageData(0, 0, outW, outH).data;

  // Pack into a flat per-pixel alpha array.
  const N = outW * outH;
  const alpha = new Uint8Array(N);
  for (let i = 0; i < N; i++) alpha[i] = hiData[i * 4];
  return alpha;
}
