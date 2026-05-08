// Modal-style progress overlay shared by long-running operations
// (magic wand BFS, AI background removal, connected-component detect).
// Single instance — only one operation can be running at a time.
import { $ } from '../utils/dom';
import { t } from '../i18n';

const overlay = $('progress-overlay');
const fill    = $('progress-fill');
const title   = $('progress-title');
const hint    = overlay.querySelector('.hint') as HTMLElement | null;

export type CancelMode = 'cancel' | 'reload' | 'none';

export function showProgress(
  label: string,
  options: { cancel?: CancelMode } = {},
): void {
  title.textContent = label || '処理中…';
  fill.style.width = '0%';
  setProgressCancelMode(options.cancel ?? 'cancel');
  overlay.classList.add('show');
}

// Switch the cancel-hint label without re-showing the overlay or
// resetting the bar. Used to flip from "Press ESC to cancel the
// download" to "" when the AI flow transitions from the abortable
// model-fetch phase into uncancellable inference.
export function setProgressCancelMode(mode: CancelMode): void {
  if (!hint) return;
  if (mode === 'none') {
    hint.style.display = 'none';
    return;
  }
  hint.style.display = '';
  hint.textContent = mode === 'reload'
    ? t('progress.escHintReload')
    : t('progress.escHint');
}

export function updateProgress(percent: number): void {
  fill.style.width = percent + '%';
}

export function hideProgress(): void {
  overlay.classList.remove('show');
}

// Update the title without resetting the bar — useful when a long task
// transitions through phases (e.g. "downloading model" → "running
// inference" → "applying result").
export function setProgressTitle(label: string): void {
  title.textContent = label;
}
