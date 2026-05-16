/**
 * Locale registry — mirrors the shape used by the netverdict.io main app
 * so a logflow-sim deployment under the same domain can share the user's
 * locale preference (via the `netverdict-locale` localStorage key) without
 * needing a dedicated picker.
 *
 * Adding a locale is intentionally a two-step process:
 *   1. Add the code here and to the catalogs map in `index.ts`.
 *   2. Drop a `<code>.json` file under `src/ui/i18n/locales/`.
 *
 * Translations are best-effort: when a key is missing in the active
 * locale, the t() function falls back to the English source string so
 * the UI stays usable mid-translation.
 */

export const DEFAULT_LOCALE = 'en';

/**
 * Codes mirror netverdict.io's 13-locale superset. A logflow-sim build is
 * not required to ship a JSON catalog for every code on day one — missing
 * catalogs fall back to English and a PR can fill them in incrementally.
 */
export const SUPPORTED_LOCALES = [
  'en',
  'de',
  'es',
  'pt',
  'fr',
  'hi',
  'zh',
  'it',
  'ja',
  'ko',
  'ru',
  'tr',
  'vi'
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_NATIVE_NAMES: Record<Locale, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  fr: 'Français',
  hi: 'हिन्दी',
  zh: '中文',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
  tr: 'Türkçe',
  vi: 'Tiếng Việt'
};

export function isSupported(code: string): code is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(code);
}
