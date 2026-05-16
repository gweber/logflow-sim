/**
 * Promise-based wrapper around the simulator Web Worker.
 *
 * The worker speaks `{id, type, payload}` messages. This client tracks
 * pending requests by ID and resolves them when responses arrive, so the
 * UI code can `await client.simulate(message)` like a normal async call.
 *
 * Lazy-instantiated singleton — the worker only spawns on first use, so
 * users who stay in "Server" mode never pay the worker boot cost.
 *
 * The dispatch is fully typed: `WorkerOps` enumerates every supported
 * method along with its request and response payload shapes. Callers
 * either use one of the convenience wrappers below (`loadBundle`,
 * `simulate`, …) which carry those types through, or call `.call(name,
 * payload)` directly with the response type inferred from `WorkerOps`.
 */

import type { Diagnostic } from '../../core/diagnostics.js';

/**
 * The complete contract between the UI and the simulator worker.
 *
 * Adding a new worker operation is a one-line entry here plus the
 * matching handler in `sim-worker.ts`. The `call()` machinery and the
 * `WorkerClient.*` convenience wrappers then enforce request and
 * response shapes at every call site.
 */
export interface WorkerOps {
  listDialects: {
    req: void;
    res: { dialects: { id: string; displayName: string }[] };
  };
  detectDialect: {
    req: { samples: { path: string; content: string }[] };
    res:
      | { dialect: string; displayName: string; confidence: number }
      | { dialect: null };
  };
  loadBundle: {
    req: { files: Record<string, string>; entrypoint: string; dialect?: string };
    res: {
      dialect: string;
      diagnostics: Diagnostic[];
      summary: Record<string, number>;
    };
  };
  parse: {
    req: void;
    res: {
      dialect: string;
      summary: Record<string, number>;
      diagnostics: Diagnostic[];
    };
  };
  analyze: { req: void; res: unknown };
  validate: { req: void; res: { diagnostics: Diagnostic[] } };
  simulate: { req: { message: unknown; forceRuleset?: string }; res: unknown };
  convert: { req: { target: string }; res: unknown };
  search: {
    req: { q: string; cs: boolean; regex: boolean };
    res: unknown;
  };
  writeFile: { req: { path: string; content: string }; res: { ok: true } };
}

type WorkerMethod = keyof WorkerOps;
type Req<K extends WorkerMethod> = WorkerOps[K]['req'];
type Res<K extends WorkerMethod> = WorkerOps[K]['res'];

interface WorkerResponse {
  id: number;
  type: 'ok' | 'error';
  payload?: unknown;
  error?: string;
}

class WorkerClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readyPromise: Promise<void> | null = null;

  private ensureWorker(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      try {
        // Vite + Preact: `?worker` import returns a constructor.
        this.worker = new Worker(
          new URL('../worker/sim-worker.ts', import.meta.url),
          { type: 'module' }
        );
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.worker.addEventListener('message', (ev: MessageEvent<WorkerResponse>) => {
        const m = ev.data;
        // The initial ready signal arrives with id=-1.
        if (m.id === -1) {
          resolve();
          return;
        }
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'error') p.reject(new Error(m.error ?? 'worker error'));
        else p.resolve(m.payload);
      });
      this.worker.addEventListener('error', (ev) => reject(new Error(String(ev.message))));
    });
    return this.readyPromise;
  }

  async call<K extends WorkerMethod>(
    method: K,
    ...payload: Req<K> extends void ? [] : [Req<K>]
  ): Promise<Res<K>> {
    await this.ensureWorker();
    const id = this.nextId++;
    return new Promise<Res<K>>((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(v as Res<K>), reject });
      this.worker!.postMessage({ id, type: method, payload: payload[0] });
    });
  }

  loadBundle(files: Record<string, string>, entrypoint: string, dialect?: string) {
    return this.call('loadBundle', { files, entrypoint, dialect });
  }
  listDialects() {
    return this.call('listDialects');
  }
  detectDialect(samples: { path: string; content: string }[]) {
    return this.call('detectDialect', { samples });
  }
  simulate(message: unknown, forceRuleset?: string) {
    return this.call('simulate', { message, forceRuleset });
  }
  search(q: string, opts: { cs?: boolean; regex?: boolean } = {}) {
    return this.call('search', { q, cs: !!opts.cs, regex: !!opts.regex });
  }
  analyze() {
    return this.call('analyze');
  }
  validate() {
    return this.call('validate');
  }
  convert(target: string) {
    return this.call('convert', { target });
  }
  writeFile(path: string, content: string) {
    return this.call('writeFile', { path, content });
  }
}

let _instance: WorkerClient | null = null;
export function getWorker(): WorkerClient {
  if (!_instance) _instance = new WorkerClient();
  return _instance;
}
