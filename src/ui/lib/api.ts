import { getMode } from '../components/ModeToggle';
import { withDialect } from '../components/DialectPicker';
import { getWorker } from './worker-client';

// API base honors Vite's sub-path (`base=/logflow/` → API at `/logflow/api`).
// Falls back to `/api` for the default root deployment so docker compose,
// the dev server, and existing curl examples all keep working unchanged.
const BASE_URL = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
const API = `${BASE_URL}/api`;

/**
 * Mode-aware API client.
 *
 * In `server` mode, calls hit the Express server over HTTP.
 *
 * In `local` mode, calls are translated to Web Worker invocations so the
 * simulator runs entirely in the browser. The worker mirrors a useful
 * subset of the server's API surface (config/parse, simulate, config/search,
 * convert) — other endpoints fall back to the server even in local mode.
 *
 * `withDialect()` automatically appends the user's chosen dialect to the
 * request path when they've overridden the auto-detect.
 */

async function fetchJson<T>(path: string): Promise<T> {
  const r = await fetch(API + withDialect(path), { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${path}`);
  return (await r.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(API + withDialect(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${path}`);
  return (await r.json()) as T;
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  if (getMode() === 'local') {
    try {
      const local = await tryLocalGet<T>(path);
      if (local !== null) return local;
    } catch {
      // Worker not ready / no bundle / route mismatch: fall through to the
      // server. Keeps the UI responsive when the user lands in local mode
      // without a bundle loaded (e.g. after a fresh tab on an old preference).
    }
  }
  return fetchJson<T>(path);
}

/**
 * Variant of `apiGet` that skips the dialect-picker override. Used when a
 * caller specifically needs the auto-detected source-dialect of the live
 * config (e.g. the Config page comparing source vs picker for live-convert).
 *
 * In local mode the call is still routed through the worker — only the
 * dialect-as-query-param injection is suppressed.
 */
export async function apiGetUnoverridden<T = unknown>(path: string): Promise<T> {
  if (getMode() === 'local') {
    try {
      const local = await tryLocalGet<T>(path);
      if (local !== null) return local;
    } catch {
      // Same fallback as apiGet — see above.
    }
  }
  const r = await fetch(API + path, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${path}`);
  return (await r.json()) as T;
}

export async function apiPost<T = unknown>(path: string, body: unknown): Promise<T> {
  if (getMode() === 'local') {
    try {
      const local = await tryLocalPost<T>(path, body);
      if (local !== null) return local;
    } catch {
      // Same fallback rationale as apiGet above.
    }
  }
  return postJson<T>(path, body);
}

export async function apiGetText(path: string): Promise<string> {
  if (getMode() === 'local') {
    const local = await tryLocalText(path);
    if (local !== null) return local;
  }
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${path}`);
  return await r.text();
}

// ---------------------------------------------------------------------------
// Worker dispatch — translate a small set of server paths into worker calls.
// Everything not in this table falls back to the network.
// ---------------------------------------------------------------------------

async function tryLocalGet<T>(path: string): Promise<T | null> {
  const w = getWorker();
  if (path === '/config/parse' || path.startsWith('/config/parse?')) {
    const r = await w.call('parse');
    return r as unknown as T;
  }
  if (path === '/model') {
    // The worker doesn't expose the full model directly — fall back to
    // network for now (cheap, server still has the data).
    return null;
  }
  if (path.startsWith('/config/search?')) {
    const url = new URL('http://x' + path);
    const q = url.searchParams.get('q') ?? '';
    const cs = url.searchParams.get('cs') === '1';
    const regex = url.searchParams.get('regex') === '1';
    return (await w.search(q, { cs, regex })) as T;
  }
  if (path === '/dialects') return null;
  return null;
}

async function tryLocalPost<T>(path: string, body: unknown): Promise<T | null> {
  const w = getWorker();
  if (path === '/simulate') {
    const b = (body ?? {}) as Record<string, unknown>;
    return (await w.simulate(b.message ?? body, b.forceRuleset as string | undefined)) as T;
  }
  if (path === '/convert') {
    const target = (body as { target?: string })?.target ?? '';
    return (await w.convert(target)) as T;
  }
  return null;
}

async function tryLocalText(path: string): Promise<string | null> {
  // No file-reading worker API for raw text yet — Config page still hits
  // the server for individual file contents.
  void path;
  return null;
}
