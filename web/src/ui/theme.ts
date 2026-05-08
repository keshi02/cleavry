// Theme cycling: system (follows OS) → light → dark → system → ...
// CSS handles the actual rendering via :root[data-theme=...] and the
// @media (prefers-color-scheme) fallback when the attribute is absent.
// Choice persists in localStorage so reloads keep the picked theme.
import { $ } from '../utils/dom';
import { t } from '../i18n';

type Theme = 'system' | 'light' | 'dark';

const THEME_KEY = 'eraser-theme';

const THEME_LABEL: Record<Theme, string> = {
  system: 'theme.system',
  light:  'theme.light',
  dark:   'theme.dark',
};
const THEME_TIP: Record<Theme, string> = {
  system: 'tip.themeSystem',
  light:  'tip.themeLight',
  dark:   'tip.themeDark',
};

const THEME_NEXT: Record<Theme, Theme> = {
  system: 'light',
  light:  'dark',
  dark:   'system',
};

let current: Theme = 'system';

function isTheme(v: string): v is Theme {
  return v in THEME_LABEL;
}

function paintButton(): void {
  const btn = $('theme-btn');
  if (!btn) return;
  btn.textContent = t(THEME_LABEL[current]);
  btn.dataset.tip = t(THEME_TIP[current]);
}

function applyTheme(theme: Theme): void {
  current = theme;
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) { /* private mode */ }
  paintButton();
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
  // Re-paint the button when the language flips, since the label and
  // tooltip both come from the i18n dictionary.
  window.addEventListener('langchange', paintButton);
}
