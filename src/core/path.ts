/**
 * Tiny POSIX path helpers. Used in core/ where we can't `import 'node:path'`
 * because the same code must run in the browser.
 *
 * Only the subset we actually need: dirname, basename, normalize, resolve,
 * isAbsolute, sep.
 */

export const sep = '/';

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

export function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx === -1) return '.';
  if (idx === 0) return '/';
  return p.slice(0, idx);
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function normalize(p: string): string {
  const abs = p.startsWith('/');
  const segs = p.split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(s);
  }
  return (abs ? '/' : '') + out.join('/');
}

export function resolve(base: string, ...parts: string[]): string {
  let cur = base;
  for (const p of parts) {
    if (isAbsolute(p)) cur = p;
    else cur = cur.replace(/\/+$/, '') + '/' + p;
  }
  return normalize(cur);
}
