import path from 'node:path';
import type { VFS } from '../core/vfs.js';
import type { IRLookupTable } from '../core/ir/model.js';
import type { LookupTableData, LookupResult } from '../core/lookups/types.js';
import type { Diagnostic } from '../core/diagnostics.js';
import { parseLookupTable, performLookup as corePerformLookup } from '../core/lookups/parse-table.js';

// Re-export so existing callers keep working.
export { corePerformLookup as performLookup };

/**
 * Resolve a lookup-file spec against a VFS, with a basename-fallback to
 * absorb production-only absolute paths like `/json/json/foo.json` when the
 * actual file is staged at `conf/json/foo.json`.
 */
async function resolveTablePath(
  spec: string,
  vfs: VFS,
  index: Map<string, string[]>
): Promise<{ path: string; fallback: boolean }> {
  if (!spec) return { path: '', fallback: false };

  // Normalize to a VFS absolute path. Absolute on the host -> map to under root.
  const mapped = spec.startsWith('/') ? spec : '/' + spec.replace(/^\.\//, '');
  if (await vfs.exists(mapped)) return { path: mapped, fallback: false };

  const base = path.posix.basename(spec);
  const candidates = index.get(base);
  if (!candidates || candidates.length === 0) return { path: mapped, fallback: false };
  if (candidates.length === 1) return { path: candidates[0], fallback: true };

  // Prefer the candidate whose path tail matches the most segments of the spec.
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

async function buildBasenameIndex(vfs: VFS): Promise<Map<string, string[]>> {
  const idx = new Map<string, string[]>();
  const files = await vfs.list('/');
  for (const f of files) {
    const name = path.posix.basename(f.path);
    if (!idx.has(name)) idx.set(name, []);
    idx.get(name)!.push(f.path);
  }
  return idx;
}

export async function loadLookupTables(
  tables: IRLookupTable[],
  vfs: VFS
): Promise<{ data: Record<string, LookupTableData>; diagnostics: Diagnostic[] }> {
  const data: Record<string, LookupTableData> = {};
  const diagnostics: Diagnostic[] = [];
  const basenameIdx = await buildBasenameIndex(vfs);

  for (const t of tables) {
    const resolved = await resolveTablePath(t.file, vfs, basenameIdx);
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
      const td: LookupTableData = {
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
        message: td.error!,
        source: t.source,
        code: 'W_LOOKUP_READ'
      });
      data[t.name] = td;
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
