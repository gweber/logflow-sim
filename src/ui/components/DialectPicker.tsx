import { useEffect, useRef, useState } from 'preact/hooks';
import { apiGet } from '../lib/api';

interface Dialect {
  id: string;
  displayName: string;
  fileExtensions: string[];
}

const STORAGE_KEY = 'logflow.dialect';

export function getActiveDialect(): string | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && v !== 'auto' ? v : null;
  } catch {
    return null;
  }
}

export function withDialect(path: string): string {
  const id = getActiveDialect();
  if (!id) return path;
  return path + (path.includes('?') ? '&' : '?') + 'dialect=' + encodeURIComponent(id);
}

/**
 * Compact dialect chip in the topbar.
 *
 * Default display: a small chip showing the auto-detected dialect ID. Click
 * opens a tiny dropdown to pick one explicitly or revert to auto-detect.
 * Keeps the topbar tidy — no permanent `<select>` widget cluttering the
 * header row.
 */
export function DialectPicker() {
  const [dialects, setDialects] = useState<Dialect[] | null>(null);
  const [active, setActive] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? 'auto';
    } catch {
      return 'auto';
    }
  });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    apiGet<{ dialects: Dialect[] }>('/dialects')
      .then((r) => setDialects(r.dialects))
      .catch(() => setDialects([]));
  }, []);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(ev: MouseEvent): void {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  function pick(id: string): void {
    setActive(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
    window.dispatchEvent(new CustomEvent('dialectchange', { detail: { id } }));
    setOpen(false);
  }

  if (!dialects) return null;

  const display =
    active === 'auto'
      ? 'auto'
      : dialects.find((d) => d.id === active)?.id ?? active;

  return (
    <div class="relative" ref={wrapRef}>
      <button
        class="chip hover:border-border-strong"
        onClick={() => setOpen((v) => !v)}
        title="Pick the source dialect — auto detects from the entrypoint."
      >
        <span class="text-fg-subtle hidden sm:inline">dialect:</span>
        <span class="font-mono">{display}</span>
      </button>
      {open && (
        <div class="absolute right-0 top-full mt-1 z-30 w-44 bg-bg-elev border border-border rounded-lg shadow-lg overflow-hidden">
          <button
            class={`w-full text-left px-3 py-1.5 text-sm ${
              active === 'auto' ? 'bg-bg-subtle text-fg' : 'text-fg-muted hover:bg-bg-subtle'
            }`}
            onClick={() => pick('auto')}
          >
            Auto-detect
          </button>
          <div class="border-t border-border" />
          {dialects.map((d) => (
            <button
              class={`w-full text-left px-3 py-1.5 text-sm ${
                active === d.id ? 'bg-bg-subtle text-fg' : 'text-fg-muted hover:bg-bg-subtle'
              }`}
              onClick={() => pick(d.id)}
            >
              {d.displayName}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
