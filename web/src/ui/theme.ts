// Theme cycling: system (follows OS) → light → dark → system → ...
// CSS handles the actual rendering via :root[data-theme=...] and the
// @media (prefers-color-scheme) fallback when the attribute is absent.
// Choice persists in localStorage so reloads keep the picked theme.
import { $ } from '../utils/dom';

type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'eraser-theme';

const THEME_META: Record<Theme, { label: string; tip: string }> = {
  system: { label: 'システム', tip: 'テーマ：システム（クリックでライトに切替）' },
  light:  { label: 'ライト',   tip: 'テーマ：ライト（クリックでダークに切替）' },
  dark:   { label: 'ダーク',   tip: 'テーマ：ダーク（クリックでシステムに切替）' },
};

const THEME_NEXT: Record<Theme, Theme> = {
  system: 'light',
  light:  'dark',
  dark:   'system',
};

let current: Theme = 'system';

function isTheme(v: string): v is Theme {
  return v in THEME_META;
}

function applyTheme(theme: Theme): void {
  current = theme;
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* private mode */ }
  const btn = $('theme-btn');
  if (btn) {
    btn.textContent = THEME_META[theme].label;
    btn.dataset.tip = THEME_META[theme].tip;
  }
}

export function cycleTheme(): void {
  applyTheme(THEME_NEXT[current]);
}

export function initTheme(): void {
  let saved: Theme = 'system';
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v && isTheme(v)) saved = v;
  } catch (_) { /* private mode */ }
  applyTheme(saved);
}
