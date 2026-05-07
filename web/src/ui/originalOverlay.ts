// Original-image overlay — paints state.origData into #orig-overlay
// and toggles its visibility / opacity. Lets the user see exactly
// where pixels have been removed from the working image.
//
// State stays in the DOM (the .show class on the canvas is the source
// of truth for "visible?"). The opacity slider's value is read on
// demand each time we show.
import { $ } from '../utils/dom';

const overlay = $<HTMLCanvasElement>('orig-overlay');
const overlayCtx = overlay.getContext('2d')!;

function paint(orig: Uint8ClampedArray, W: number, H: number): void {
  overlay.width = W;
  overlay.height = H;
  // ImageData's typing demands Uint8ClampedArray<ArrayBuffer>; TS 5.7+
  // defaults TypedArrays to ArrayBufferLike, which the lib.dom rejects.
  // The runtime is fine — cast is purely a type-system bridge.
  overlayCtx.putImageData(
    new ImageData(orig as Uint8ClampedArray<ArrayBuffer>, W, H),
    0, 0,
  );
}

export function showOriginalOverlay(orig: Uint8ClampedArray, W: number, H: number): void {
  paint(orig, W, H);
  overlay.classList.add('show');
  $('show-orig-btn').classList.add('active');
  overlay.style.opacity = String((+($<HTMLInputElement>('orig-opacity').value)) / 100);
}

export function hideOriginalOverlay(): void {
  overlay.classList.remove('show');
  $('show-orig-btn').classList.remove('active');
}

export function toggleOriginalOverlay(orig: Uint8ClampedArray, W: number, H: number): void {
  if (overlay.classList.contains('show')) hideOriginalOverlay();
  else showOriginalOverlay(orig, W, H);
}

// Live update from the opacity slider.
export function setOriginalOverlayOpacity(percent: number): void {
  overlay.style.opacity = String(percent / 100);
}
