/**
 * Minimal i18n runtime for logflow-sim.
 *
 * Design choices:
 *   • No fremdlib (vue-i18n etc.) — Preact + a 60-line runtime keeps the
 *     bundle small and the dependency tree fully readable.
 *   • Catalogs are plain JSON imported statically so Vite can tree-shake
 *     unused ones and inline the active one with the rest of the bundle.
 *   • Locale is resolved in this order (first hit wins):
 *       1. Persisted `netverdict-locale` (matches the parent site's key)
 *       2. Persisted `logflow-locale` (local override if running standalone)
 *       3. `navigator.language` short code if among `SUPPORTED_LOCALES`
 *       4. `DEFAULT_LOCALE`
 *   • Missing keys fall back to English; missing English keys fall back to
 *     the key itself (debug-aid — operators see exactly which string is
 *     missing rather than a blank label).
 */

import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_LOCALE, isSupported, SUPPORTED_LOCALES, type Locale } from './locales.js';
import en from './locales/en.json';
import de from './locales/de.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import fr from './locales/fr.json';
import hi from './locales/hi.json';
import zh from './locales/zh.json';
import it from './locales/it.json';
import ja from './locales/ja.json';
import ko from './locales/ko.json';
import ru from './locales/ru.json';
import tr from './locales/tr.json';
import vi from './locales/vi.json';

type Catalog = Record<string, string>;

// Every locale ships a catalog file. Stub catalogs (es/pt/fr/hi/zh/it/ja/
// ko/ru/tr/vi) are copies of `en.json` — they unlock the locale in the
// picker so contributors can submit a single-file PR translating the
// strings. Missing translations fall back to English at runtime.
const CATALOGS: Partial<Record<Locale, Catalog>> = {
  en: en as Catalog,
  de: de as Catalog,
  es: es as Catalog,
  pt: pt as Catalog,
  fr: fr as Catalog,
  hi: hi as Catalog,
  zh: zh as Catalog,
  it: it as Catalog,
  ja: ja as Catalog,
  ko: ko as Catalog,
  ru: ru as Catalog,
  tr: tr as Catalog,
  vi: vi as Catalog
};

const STORAGE_KEY = 'logflow-locale';
const SHARED_KEY = 'netverdict-locale';

let currentLocale: Locale = resolveInitialLocale();

function resolveInitialLocale(): Locale {
  try {
    const shared = localStorage.getItem(SHARED_KEY);
    if (shared && isSupported(shared)) return shared;
    const own = localStorage.getItem(STORAGE_KEY);
    if (own && isSupported(own)) return own;
  } catch {
    /* localStorage may be disabled (private mode) — fall through. */
  }
  const browser = typeof navigator !== 'undefined' ? navigator.language?.split('-')[0] : null;
  if (browser && isSupported(browser)) return browser;
  return DEFAULT_LOCALE;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(code: string): void {
  if (!isSupported(code)) return;
  currentLocale = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
  // Inform every t()-consumer hook so the UI re-renders without a reload.
  window.dispatchEvent(new CustomEvent('localechange', { detail: { locale: code } }));
}

/**
 * Translate a key. Returns the resolved string or — if missing in the
 * active catalog AND in English — the key itself as a visible fallback so
 * the gap surfaces immediately during development.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const cat = CATALOGS[currentLocale] ?? CATALOGS[DEFAULT_LOCALE] ?? {};
  const fallback = CATALOGS[DEFAULT_LOCALE] ?? {};
  const raw = cat[key] ?? fallback[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

/**
 * Preact hook that returns the t() function and re-runs the component on
 * locale change. Components should prefer this over the bare t() so they
 * stay in sync with a `setLocale` call from elsewhere.
 */
export function useT(): { t: typeof t; locale: Locale } {
  const [locale, setActive] = useState<Locale>(currentLocale);
  useEffect(() => {
    function onChange(e: Event): void {
      const ev = e as CustomEvent<{ locale: Locale }>;
      setActive(ev.detail.locale);
    }
    window.addEventListener('localechange', onChange);
    return () => window.removeEventListener('localechange', onChange);
  }, []);
  // `locale` is intentionally consumed in the closure of t() — we don't
  // capture it explicitly because the module-level `currentLocale` is the
  // source of truth and the hook's job is just to trigger re-renders.
  void locale;
  return { t, locale: currentLocale };
}

export { SUPPORTED_LOCALES };
export { LOCALE_NATIVE_NAMES } from './locales.js';
export type { Locale };
