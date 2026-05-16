import type { VFS } from '../vfs.js';

/**
 * MemoryVFS — an in-memory implementation of the VFS contract.
 *
 * Use cases:
 *   - The browser SPA when the user has loaded a config bundle locally.
 *   - The Web Worker (a copy of the bundle lives in the worker's memory).
 *   - A future browser extension where the config comes from clipboard or
 *     content-script extraction.
 *   - Tests, where you want to feed a curated map of files without touching
 *     disk.
 *
 * Path conventions match the rest of the VFS layer: POSIX-style separators,
 * absolute paths begin with `/`, relative paths are caller-resolved.
 */
export class MemoryVFS implements VFS {
  readonly label: string;
  /** path → content. Always keyed on the absolute (leading-`/`) form. */
  private files = new Map<string, string>();
  private mtimes = new Map<string, number>();

  constructor(initial?: Record<string, string>, opts?: { label?: string }) {
    this.label = opts?.label ?? 'memory';
    if (initial) {
      for (const [k, v] of Object.entries(initial)) this.write(k, v);
    }
  }

  // ---- VFS contract --------------------------------------------------

  async readFile(p: string): Promise<string> {
    const abs = this.absolute(p);
    const v = this.files.get(abs);
    if (v === undefined) throw new Error(`MemoryVFS: not found: ${abs}`);
    return v;
  }

  async exists(p: string): Promise<boolean> {
    return this.files.has(this.absolute(p));
  }

  async glob(pattern: string): Promise<string[]> {
    const re = globToRegex(this.absolute(pattern));
    return [...this.files.keys()].filter((k) => re.test(k)).sort();
  }

  async list(dir: string): Promise<{ path: string; size: number }[]> {
    const prefix = this.absolute(dir).replace(/\/+$/, '');
    const acc: { path: string; size: number }[] = [];
    for (const [k, v] of this.files) {
      if (prefix === '' || k === prefix || k.startsWith(prefix + '/')) {
        acc.push({ path: k, size: v.length });
      }
    }
    return acc.sort((a, b) => a.path.localeCompare(b.path));
  }

  async mtime(p: string): Promise<number> {
    return this.mtimes.get(this.absolute(p)) ?? 0;
  }

  // ---- Mutation helpers (not part of VFS) ---------------------------

  /** Write a file. Used by the worker host to hydrate the VFS from a bundle. */
  write(p: string, content: string): void {
    const abs = this.absolute(p);
    this.files.set(abs, content);
    this.mtimes.set(abs, Date.now());
  }

  /** Remove a file. */
  delete(p: string): boolean {
    const abs = this.absolute(p);
    this.mtimes.delete(abs);
    return this.files.delete(abs);
  }

  /** Snapshot the entire VFS as a plain object — useful for postMessage. */
  toBundle(): Record<string, string> {
    return Object.fromEntries(this.files);
  }

  /** Number of files held — handy for debugging and tests. */
  get size(): number {
    return this.files.size;
  }

  // ---- Internal -----------------------------------------------------

  private absolute(p: string): string {
    if (!p) return '/';
    if (p.startsWith('/')) return normalize(p);
    return normalize('/' + p);
  }
}

function normalize(p: string): string {
  // Collapse repeated slashes and resolve `.`/`..` segments.
  const segs = p.split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      out.pop();
      continue;
    }
    out.push(s);
  }
  return '/' + out.join('/');
}

function globToRegex(glob: string): RegExp {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 2;
        if (glob[i] === '/') i++;
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
      i++;
      continue;
    }
    re += c;
    i++;
  }
  re += '$';
  return new RegExp(re);
}
