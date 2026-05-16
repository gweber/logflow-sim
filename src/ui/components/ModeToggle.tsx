import { useEffect, useState } from 'preact/hooks';
import { apiGet } from '../lib/api';
import { getWorker } from '../lib/worker-client';
import { IconBolt, IconRouter } from './Icons';

/**
 * Compact icon-only toggle for the editing mode.
 *
 * - "Server" (default): API talks to the host's live config. Read-only.
 * - "Local": fetches a bundle once, then parse/simulate/search run inside
 *   the Web Worker — no further server traffic, edits stay browser-local.
 *
 * The toggle lives in the topbar but stays unobtrusive — a single icon
 * button that flips on click. Hover-tooltip explains the active mode.
 */

const STORAGE_KEY = 'logflow.mode';

export type EditMode = 'server' | 'local';

export function getMode(): EditMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'local' ? 'local' : 'server';
  } catch {
    return 'server';
  }
}

export function setMode(m: EditMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, m);
  } catch {}
  window.dispatchEvent(new CustomEvent('modechange', { detail: { mode: m } }));
}

export function ModeToggle() {
  const [mode, setLocalMode] = useState<EditMode>(getMode);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onChange(e: Event): void {
      const ev = e as CustomEvent<{ mode: EditMode }>;
      setLocalMode(ev.detail.mode);
    }
    window.addEventListener('modechange', onChange);
    return () => window.removeEventListener('modechange', onChange);
  }, []);

  async function flip(): Promise<void> {
    const target: EditMode = mode === 'server' ? 'local' : 'server';
    setBusy(true);
    try {
      if (target === 'local') {
        const bundle = await apiGet<{
          dialect: string;
          entrypoint: string;
          files: Record<string, string>;
        }>('/config/bundle');
        await getWorker().loadBundle(bundle.files, bundle.entrypoint, bundle.dialect);
      }
      setMode(target);
    } catch {
      // Errors surface in the next API call rather than blocking the toggle.
    } finally {
      setBusy(false);
    }
  }

  const isLocal = mode === 'local';
  return (
    <button
      class="btn-ghost"
      onClick={flip}
      disabled={busy}
      title={
        isLocal
          ? 'Local mode — edits and simulations run in your browser. Click to return to server mode.'
          : 'Server mode — using live host config. Click to switch to local editing (loads a bundle, then offline).'
      }
      aria-label="Toggle edit mode"
    >
      {isLocal ? (
        <IconBolt size={16} class="text-accent" />
      ) : (
        <IconRouter size={16} />
      )}
    </button>
  );
}
