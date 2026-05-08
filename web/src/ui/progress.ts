// Modal-style progress overlay shared by long-running operations
// (magic wand BFS, AI background removal, connected-component detect).
// Single instance — only one operation can be running at a time.
import { $ } from '../utils/dom';
import { t } from '../i18n';

const overlay   = $('progress-overlay');
const fill      = $('progress-fill');
const title     = $('progress-title');
const hint      = overlay.querySelector('.hint') as HTMLElement | null;
const cancelBtn = document.getElementById('progress-cancel') as HTMLButtonElement | null;

export type CancelMode = 'cancel' | 'reload' | 'none';

// Per-operation cancel handler. Wired up by setProgressCancelMode and
// invoked when the user clicks the in-overlay cancel button (only
// shown for the AI download phase right now — see comment below).
let cancelHandler: (() => void) | null = null;
if (cancelBtn) {
  cancelBtn.addEventListener('click', () => cancelHandler?.());
}

export function showProgress(
  label: string,
  options: { cancel?: CancelMode; onCancel?: () => void } = {},
): void {
  title.textContent = label || '処理中…';
  fill.style.width = '0%';
  setProgressCancelMode(options.cancel ?? 'cancel', options.onCancel);
  overlay.classList.add('show');
}

// Switch the cancel-hint + button without re-showing the overlay or
// resetting the bar. Used to flip from "Press ESC to cancel the
// download" + visible button to plain "" when the AI flow transitions
// from the abortable model-fetch phase into uncancellable inference.
//
// The visible cancel button only shows in 'reload' mode (i.e. AI
// model download). The other long ops (wand, component detect) still
// rely on ESC alone — adding a button there would just mean another
// surface to wire up and the operations are short anyway.
export function setProgressCancelMode(mode: CancelMode, handler?: () => void): void {
  cancelHandler = handler ?? null;
  if (!hint) return;
  if (mode === 'none') {
    hint.style.display = 'none';
    if (cancelBtn) cancelBtn.hidden = true;
    return;
  }
  hint.style.display = '';
  hint.textContent = mode === 'reload'
    ? t('progress.escHintReload')
    : t('progress.escHint');
  if (cancelBtn) {
    if (mode === 'reload') {
      cancelBtn.hidden = false;
      cancelBtn.textContent = t('progress.cancelBtn');
    } else {
      cancelBtn.hidden = true;
    }
  }
}

export function updateProgress(percent: number): void {
  fill.style.width = percent + '%';
}

export function hideProgress(): void {
  overlay.classList.remove('show');
  cancelHandler = null;
  if (cancelBtn) cancelBtn.hidden = true;
}

// Update the title without resetting the bar — useful when a long task
// transitions through phases (e.g. "downloading model" → "running
// inference" → "applying result").
export function setProgressTitle(label: string): void {
  title.textContent = label;
}
