import { $ } from '../utils/dom';

let toastTimer: ReturnType<typeof setTimeout> | null = null;

// Brief auto-dismissing notification at the bottom of the viewport.
// Latest call wins — calling again before the previous one fades out
// resets the timer.
export function showToast(msg: string): void {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
