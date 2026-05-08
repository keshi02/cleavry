// Tiny i18n. Two languages (ja / en), browser-language autodetection,
// localStorage override for manual switch.
//
// Usage at runtime:
//   import { t } from './i18n';
//   showError(t('error.loadFailed'));
//
// Static markup uses data-* hooks: data-i18n / data-i18n-tip /
// data-i18n-aria. applyI18n() fills them in on init and on language
// change.
//
// Adding a new key: add it to BOTH ja.ts and en.ts. The `Key` type
// is derived from ja.ts so the compiler will flag missing entries.

import ja from './ja';
import en from './en';

const dicts = { ja, en };
export type Lang = keyof typeof dicts;
export type Key = keyof typeof ja;

const STORAGE_KEY = 'cleavry-lang';

function detectLang(): Lang {
  // Manual override takes precedence.
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'ja' || stored === 'en') return stored;
  } catch (_) { /* private mode */ }
  // Browser preference: anything starting with "ja" → Japanese, else English.
  const pref = (navigator.language || 'en').toLowerCase();
  return pref.startsWith('ja') ? 'ja' : 'en';
}

let current: Lang = detectLang();
document.documentElement.lang = current;

export function getLang(): Lang { return current; }

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch (_) {}
  document.documentElement.lang = lang;
  applyI18n();
  // Custom event so other modules (theme, status bar) can re-render.
  window.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
}

export function t(key: Key | string): string {
  const dict = dicts[current] as Record<string, string>;
  return dict[key] ?? key;
}

// Walks the document and substitutes textContent / attributes for each
// `data-i18n-*` hook. Idempotent — safe to call repeatedly (e.g. on
// language change). For elements where the original markup contains
// inline children (e.g. <code>), use `data-i18n-html` instead.
export function applyI18n(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n!;
    el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach(el => {
    const key = el.dataset.i18nHtml!;
    el.innerHTML = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-tip]').forEach(el => {
    const key = el.dataset.i18nTip!;
    el.dataset.tip = t(key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach(el => {
    const key = el.dataset.i18nAria!;
    el.setAttribute('aria-label', t(key));
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle!;
    el.setAttribute('title', t(key));
  });
}
