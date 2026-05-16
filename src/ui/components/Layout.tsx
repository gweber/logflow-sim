import type { ComponentChildren } from 'preact';
import { Link, useLocation } from 'wouter-preact';
import { useTheme } from '../hooks/useTheme';
import { useT } from '../i18n/index.js';
import { IconBolt, IconMoon, IconSun } from './Icons';
import { DialectPicker } from './DialectPicker';
import { ModeToggle } from './ModeToggle';
import { LocalePicker } from './LocalePicker';

const NAV_ITEMS = [
  { href: '/', i18n: 'nav.home' },
  { href: '/simulator', i18n: 'nav.simulator' },
  { href: '/replay', i18n: 'nav.replay' },
  { href: '/diff', i18n: 'nav.diff' },
  { href: '/detection', i18n: 'nav.detection' },
  { href: '/migrate', i18n: 'nav.migrate' },
  { href: '/projects', i18n: 'nav.projects' },
  { href: '/config', i18n: 'nav.config' },
  { href: '/tests', i18n: 'nav.tests' },
  { href: '/blog', i18n: 'nav.blog' },
  { href: '/docs', i18n: 'nav.docs' }
];

export function Layout({ children }: { children: ComponentChildren }) {
  const [location] = useLocation();
  const { theme, toggle } = useTheme();
  const { t } = useT();
  // Re-derive NAV labels on every render so a locale-change re-translates
  // the topbar without unmounting the component tree.
  const NAV = NAV_ITEMS.map((n) => ({ href: n.href, label: t(n.i18n) }));

  function isActive(href: string): boolean {
    if (href === '/') return location === '/';
    return location === href || location.startsWith(href + '/');
  }

  return (
    <div class="min-h-screen flex flex-col">
      <header class="sticky top-0 z-30 backdrop-blur bg-bg/80 border-b border-border">
        <div class="max-w-7xl mx-auto px-3 sm:px-6 h-14 flex items-center gap-2 sm:gap-6">
          <Link href="/" class="flex items-center gap-2 text-fg hover:text-accent transition-colors">
            <span class="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-accent text-accent-fg">
              <IconBolt size={16} />
            </span>
            <span class="font-semibold tracking-tight whitespace-nowrap">logflow-sim</span>
          </Link>
          <nav class="hidden md:flex items-center gap-1 ml-2">
            {NAV.map((n) => (
              <Link
                href={n.href}
                class={`px-3 py-1.5 text-sm rounded-md transition-colors ${
                  isActive(n.href)
                    ? 'text-fg bg-bg-subtle'
                    : 'text-fg-muted hover:text-fg hover:bg-bg-subtle'
                }`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div class="flex-1" />
          <DialectPicker />
          <LocalePicker />
          <ModeToggle />
          <button
            class="btn-ghost"
            onClick={toggle}
            aria-label="Toggle theme"
            title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          >
            {theme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
          </button>
        </div>
        {/* Mobile nav row */}
        <nav class="md:hidden border-t border-border overflow-x-auto">
          <div class="flex items-center gap-1 px-4 py-2 min-w-max">
            {NAV.map((n) => (
              <Link
                href={n.href}
                class={`px-3 py-1.5 text-sm rounded-md whitespace-nowrap ${
                  isActive(n.href)
                    ? 'text-fg bg-bg-subtle'
                    : 'text-fg-muted hover:text-fg hover:bg-bg-subtle'
                }`}
              >
                {n.label}
              </Link>
            ))}
          </div>
        </nav>
      </header>

      <main class="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8">{children}</main>

      <footer class="border-t border-border mt-8">
        <div class="max-w-7xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between text-xs text-fg-subtle">
          <div class="flex flex-col sm:flex-row gap-x-3 gap-y-1 sm:items-center">
            <div>
              <span class="font-mono">logflow-sim</span> — {t('footer.tagline')}
            </div>
            <div class="hidden sm:block">·</div>
            <div>
              {t('footer.poweredBy')}{' '}
              <a
                href="https://netverdict.io"
                class="text-accent hover:underline"
                rel="noopener"
              >
                netverdict.io
              </a>
            </div>
          </div>
          <div class="flex items-center gap-3">
            <a
              href="https://github.com/gweber/logflow-sim"
              class="hover:text-fg"
              rel="noopener"
              target="_blank"
            >
              GitHub
            </a>
            <span>·</span>
            <Link href="/docs/limitations" class="hover:text-fg">
              {t('footer.parserLimitations')}
            </Link>
            <span>·</span>
            <Link href="/docs/api" class="hover:text-fg">
              {t('footer.api')}
            </Link>
            <span>·</span>
            <a href="/api/health" class="hover:text-fg">/api/health</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
