/// <reference lib="webworker" />

/**
 * Web Worker that hosts a full copy of the logflow-sim kernel.
 *
 * The browser SPA can hand it a `{path → content}` bundle and then issue
 * parse / simulate / convert / search requests without involving the
 * server. This is the engine behind the "edit locally, see changes
 * instantly" mode.
 *
 * Messages are JSON-friendly objects with a `type` discriminator and an
 * `id` so the client can match responses to requests.
 */

import { MemoryVFS } from '../../core/vfs/memory.js';
import { load, analyze, validate, simulate, convert, listDialects, detectDialect } from '../../core/kernel.js';
import type { LoadResult } from '../../core/kernel.js';
import type { SyslogMessage } from '../../core/simulate/syslog-message.js';

// Single VFS lives per worker. The client repopulates it on each bundle load.
let vfs = new MemoryVFS();
// Last loaded result is cached so simulate() doesn't need to re-parse on each
// request — only when the bundle changes.
let cached: LoadResult | null = null;
let cacheKey: string | null = null;

interface WorkerRequest {
  id: number;
  type:
    | 'listDialects'
    | 'detectDialect'
    | 'loadBundle'
    | 'parse'
    | 'analyze'
    | 'validate'
    | 'simulate'
    | 'convert'
    | 'search'
    | 'writeFile';
  payload?: unknown;
}

interface WorkerResponse {
  id: number;
  type: 'ok' | 'error';
  payload?: unknown;
  error?: string;
}

function bundleKey(bundle: Record<string, string>): string {
  // Cheap deterministic hash: number of files + total length. Good enough to
  // detect "bundle changed" without crypto.
  const keys = Object.keys(bundle).sort();
  let len = 0;
  for (const k of keys) len += k.length + bundle[k].length;
  return `${keys.length}:${len}`;
}

async function loadBundle(
  bundle: Record<string, string>,
  entrypoint: string,
  dialect?: string
): Promise<LoadResult> {
  vfs = new MemoryVFS(bundle, { label: 'worker' });
  cached = await load(vfs, { entrypoint: '/' + entrypoint.replace(/^\/+/, ''), dialect });
  cacheKey = bundleKey(bundle);
  return cached;
}

async function handle(req: WorkerRequest): Promise<unknown> {
  const p = req.payload as Record<string, unknown> | undefined;
  switch (req.type) {
    case 'listDialects':
      return { dialects: listDialects().map((d) => ({ id: d.id, displayName: d.displayName })) };

    case 'detectDialect': {
      const samples = (p?.samples as { path: string; content: string }[] | undefined) ?? [];
      const hit = detectDialect(samples);
      return hit
        ? { dialect: hit.dialect.id, displayName: hit.dialect.displayName, confidence: hit.confidence }
        : { dialect: null };
    }

    case 'loadBundle': {
      const bundle = (p?.files as Record<string, string>) ?? {};
      const entrypoint = (p?.entrypoint as string) ?? 'rsyslog.conf';
      const dialect = p?.dialect as string | undefined;
      const result = await loadBundle(bundle, entrypoint, dialect);
      return {
        dialect: result.dialect,
        diagnostics: result.diagnostics,
        summary: summarize(result)
      };
    }

    case 'parse': {
      if (!cached) throw new Error('No bundle loaded — call loadBundle first');
      return { dialect: cached.dialect, summary: summarize(cached), diagnostics: cached.diagnostics };
    }

    case 'analyze': {
      if (!cached) throw new Error('No bundle loaded');
      return analyze(cached.model);
    }

    case 'validate': {
      if (!cached) throw new Error('No bundle loaded');
      return validate(cached.model);
    }

    case 'simulate': {
      if (!cached) throw new Error('No bundle loaded');
      const message = (p?.message as SyslogMessage) ?? ({ transport: 'udp', port: 514 } as SyslogMessage);
      // The server route fills `myhostname` from os.hostname(); we have no
      // such option in the browser. Use a stable placeholder that's
      // obvious in the trace so users can see when a value is locally
      // computed vs. coming from the production host.
      if (!message.myhostname) message.myhostname = 'browser';
      const forceRuleset = p?.forceRuleset as string | undefined;
      return simulate({
        model: cached.model,
        lookupTables: cached.lookupTables,
        message,
        forceRuleset
      });
    }

    case 'convert': {
      if (!cached) throw new Error('No bundle loaded');
      const target = (p?.target as string) ?? '';
      if (!target) throw new Error('target dialect required');
      return convert(cached.model, target);
    }

    case 'search': {
      if (!cached) throw new Error('No bundle loaded');
      const q = String(p?.q ?? '');
      const cs = !!p?.cs;
      const isRegex = !!p?.regex;
      return runSearch(q, cs, isRegex);
    }

    case 'writeFile': {
      const path = String(p?.path ?? '');
      const content = String(p?.content ?? '');
      if (!path) throw new Error('path required');
      vfs.write(path, content);
      // Invalidate cache so the next parse re-runs.
      cached = null;
      cacheKey = null;
      return { ok: true, files: vfs.size };
    }

    default:
      throw new Error(`Unknown worker request type: ${req.type}`);
  }
}

function summarize(r: LoadResult) {
  const m = r.model;
  return {
    files: r.files.length,
    inputs: m.inputs.length,
    rulesets: m.rulesets.length,
    templates: m.templates.length,
    lookupTables: m.lookupTables.length,
    modules: m.modules.length,
    outputs: m.outputs.length,
    filters: m.filters.length,
    routes: m.routes.length
  };
}

function runSearch(q: string, cs: boolean, isRegex: boolean) {
  if (!cached) return { query: q, matches: [], truncated: false };
  let matcher: (line: string) => { idx: number; len: number } | null;
  if (isRegex) {
    const re = new RegExp(q, cs ? 'g' : 'gi');
    matcher = (line) => {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) return null;
      return { idx: m.index, len: m[0].length };
    };
  } else {
    const needle = cs ? q : q.toLowerCase();
    matcher = (line) => {
      const hay = cs ? line : line.toLowerCase();
      const idx = hay.indexOf(needle);
      if (idx === -1) return null;
      return { idx, len: q.length };
    };
  }
  const matches: { file: string; line: number; col: number; snippet: string; matchStart: number; matchLen: number }[] = [];
  for (const f of cached.files) {
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const m = matcher(ln);
      if (!m) continue;
      matches.push({
        file: f.path,
        line: i + 1,
        col: m.idx + 1,
        snippet: ln.length > 200 ? ln.slice(0, 200) + '…' : ln,
        matchStart: m.idx,
        matchLen: m.len
      });
      if (matches.length >= 500) {
        return { query: q, total: matches.length, truncated: true, matches };
      }
    }
  }
  return { query: q, total: matches.length, truncated: false, matches };
}

// Wire postMessage protocol
self.addEventListener('message', async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    const payload = await handle(req);
    const resp: WorkerResponse = { id: req.id, type: 'ok', payload };
    (self as unknown as { postMessage: (msg: unknown) => void }).postMessage(resp);
  } catch (e) {
    const resp: WorkerResponse = { id: req.id, type: 'error', error: (e as Error).message };
    (self as unknown as { postMessage: (msg: unknown) => void }).postMessage(resp);
  }
});

// Signal that the worker is ready.
(self as unknown as { postMessage: (msg: unknown) => void }).postMessage({
  id: -1,
  type: 'ok',
  payload: { ready: true }
});

void cacheKey;
