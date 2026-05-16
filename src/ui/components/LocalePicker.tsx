import { useEffect, useRef, useState } from 'preact/hooks';
import { getLocale, setLocale, SUPPORTED_LOCALES, LOCALE_NATIVE_NAMES } from '../i18n/index.js';
import type { Locale } from '../i18n/index.js';

/**
 * Compact locale-picker chip in the topbar.
 *
 * Mirrors the DialectPicker UX so the chip-row stays visually coherent:
 * a small chip with the current locale code, click opens a popover with
 * native names.
 *
 * Locales fall into two qualitative buckets:
 *   • COMMUNITY_REVIEWED — read top-to-bottom by a native or fluent
 *     speaker who confirmed the wording is natural. These show up clean
 *     in the picker.
 *   • Everything else — the catalog has 100% key coverage so nothing
 *     falls back to English, but the wording was produced from the
 *     English source and has not been independently reviewed for
 *     idiom. These show a small "·" marker and a tooltip asking for
 *     PR-based review.
 *
 * The point of surfacing this honestly is twofold: it sets correct
 * expectations for native speakers (so they don't assume an awkward
 * phrase represents the project's intent) and it's a directly
 * actionable invitation to contribute — a single-file PR is enough to
 * promote a locale into the reviewed bucket.
 */
const COMMUNITY_REVIEWED: Locale[] = ['en', 'de'];

export function LocalePicker() {
  const [active, setActive] = useState<Locale>(getLocale());
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(code: Locale): void {
    setActive(code);
    setLocale(code);
    setOpen(false);
  }

  return (
    <div class="relative" ref={wrapRef}>
      <button
        class="chip hover:border-border-strong"
        onClick={() => setOpen((v) => !v)}
        title="Choose language"
        aria-label="Language picker"
      >
        <span class="font-mono uppercase text-fg-subtle">{active}</span>
      </button>
      {open && (
        <div class="absolute right-0 top-full mt-1 z-30 w-52 max-h-[70vh] overflow-auto bg-bg-elev border border-border rounded-lg shadow-lg">
          {SUPPORTED_LOCALES.map((code) => {
            const reviewed = COMMUNITY_REVIEWED.includes(code);
            return (
              <button
                key={code}
                onClick={() => pick(code)}
                class={`w-full text-left px-3 py-2 text-sm flex items-center justify-between gap-2 ${
                  active === code
                    ? 'bg-bg-subtle text-fg'
                    : 'text-fg-muted hover:bg-bg-subtle hover:text-fg'
                }`}
                title={
                  reviewed
                    ? `Switch to ${LOCALE_NATIVE_NAMES[code]}`
                    : `${LOCALE_NATIVE_NAMES[code]} — full catalog, awaiting native-speaker review. Spot something off? PRs welcome.`
                }
              >
                <span class="truncate">{LOCALE_NATIVE_NAMES[code]}</span>
                <span class="flex items-center gap-1 shrink-0">
                  {!reviewed && (
                    <span class="text-[10px] text-fg-subtle" aria-hidden>
                      ·
                    </span>
                  )}
                  <span class="text-[10px] font-mono uppercase text-fg-subtle">{code}</span>
                </span>
              </button>
            );
          })}
          <div class="border-t border-border" />
          <div class="px-3 py-1.5 text-[11px] text-fg-subtle leading-snug">
            <span class="font-mono">·</span> awaiting native-speaker review —{' '}
            <a
              href="https://github.com/gweber/logflow-sim/tree/main/src/ui/i18n/locales"
              target="_blank"
              rel="noopener"
              class="text-accent hover:underline"
            >
              PRs welcome
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
