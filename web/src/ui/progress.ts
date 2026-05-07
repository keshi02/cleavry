// Modal-style progress overlay shared by long-running operations
// (magic wand BFS, AI background removal, connected-component detect).
// Single instance — only one operation can be running at a time.
import { $ } from '../utils/dom';

const overlay = $('progress-overlay');
const fill    = $('progress-fill');
const title   = $('progress-title');

export function showProgress(label: string): void {
  title.textContent = label || '処理中…';
  fill.style.width = '0%';
  overlay.classList.add('show');
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
