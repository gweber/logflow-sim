import type { VFS } from '../vfs.js';
import type { IRLookupTable } from '../ir/model.js';
import type { LookupTableData } from './types.js';
import type { Diagnostic } from '../diagnostics.js';
import { parseLookupTable } from './parse-table.js';
import { basename, isAbsolute } from '../path.js';

/**
 * Load every lookup table referenced by the parsed IR, using only the VFS
 * abstraction — works identically against on-disk files (NodeVFS) and
 * in-memory bundles (MemoryVFS / worker).
 *
 * Path resolution mirrors what real rsyslog does on the production host,
 * with a forgiving fallback so configs that hard-code production paths
 * still parse locally:
 *
 *   1. Try the absolute path as written (`/json/foo.json`).
 *   2. If not found, try the basename anywhere under the VFS root — the
 *      most likely "we copied the files but kept the path strings"
 *      situation. Emit an info diagnostic so the user knows.
 *   3. If multiple basename hits, prefer the candidate whose tail matches
 *      the most segments of the requested path.
 */
export async function loadLookupTables(
  tables: IRLookupTable[],
  vfs: VFS
): Promise<{ data: Record<string, LookupTableData>; diagnostics: Diagnostic[] }> {
  const data: Record<string, LookupTableData> = {};
  const diagnostics: Diagnostic[] = [];
  const basenameIdx = await buildBasenameIndex(vfs);

  for (const t of tables) {
    const resolved = await resolvePath(t.file, vfs, basenameIdx);

    if (!resolved.path || !(await vfs.exists(resolved.path))) {
      const td: LookupTableData = {
        name: t.name,
        filePath: resolved.path,
        loaded: false,
        entries: {},
        size: 0,
        source: t.source,
        error: `Lookup table file not found: ${t.file}`
      };
      diagnostics.push({
        severity: 'warning',
        message: td.error!,
        source: t.source,
        code: 'W_LOOKUP_MISSING'
      });
      data[t.name] = td;
      continue;
    }

    if (resolved.fallback) {
      diagnostics.push({
        severity: 'info',
        message: `Lookup table "${t.name}" resolved by basename fallback: ${t.file} → ${resolved.path}`,
        source: t.source,
        code: 'I_LOOKUP_FALLBACK'
      });
    }

    let raw: string;
    try {
      raw = await vfs.readFile(resolved.path);
    } catch (e) {
      data[t.name] = {
        name: t.name,
        filePath: resolved.path,
        loaded: false,
        entries: {},
        size: 0,
        source: t.source,
        error: `Failed to read lookup table: ${(e as Error).message}`
      };
      diagnostics.push({
        severity: 'warning',
        message: data[t.name].error!,
        source: t.source,
        code: 'W_LOOKUP_READ'
      });
      continue;
    }

    const parsed = parseLookupTable({
      name: t.name,
      filePath: resolved.path,
      raw,
      source: t.source
    });
    data[t.name] = parsed.data;
    diagnostics.push(...parsed.diagnostics);
  }
  return { data, diagnostics };
}

async function buildBasenameIndex(vfs: VFS): Promise<Map<string, string[]>> {
  const idx = new Map<string, string[]>();
  const files = await vfs.list('/');
  for (const f of files) {
    const name = basename(f.path);
    if (!idx.has(name)) idx.set(name, []);
    idx.get(name)!.push(f.path);
  }
  return idx;
}

async function resolvePath(
  spec: string,
  vfs: VFS,
  index: Map<string, string[]>
): Promise<{ path: string; fallback: boolean }> {
  if (!spec) return { path: '', fallback: false };
  const mapped = isAbsolute(spec) ? spec : '/' + spec.replace(/^\.\//, '');
  if (await vfs.exists(mapped)) return { path: mapped, fallback: false };
  const candidates = index.get(basename(spec));
  if (!candidates || candidates.length === 0) return { path: mapped, fallback: false };
  if (candidates.length === 1) return { path: candidates[0], fallback: true };
  const wanted = spec.replace(/^\/+/, '').split('/');
  let best = candidates[0];
  let bestScore = 0;
  for (const c of candidates) {
    const segs = c.split('/');
    let score = 0;
    for (let i = 1; i <= Math.min(wanted.length, segs.length); i++) {
      if (segs[segs.length - i] === wanted[wanted.length - i]) score++;
      else break;
    }
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return { path: best, fallback: true };
}
