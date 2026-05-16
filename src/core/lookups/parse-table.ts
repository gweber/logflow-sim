import type { LookupTableData, LookupResult } from './types.js';
import type { SourceLoc } from '../source-map.js';
import type { Diagnostic } from '../diagnostics.js';

export interface ParseTableInput {
  name: string;
  /** Path that was used to load the file (kept for diagnostics + UI). */
  filePath: string;
  /** Raw file contents — already read by the caller via VFS. */
  raw: string;
  /** Source location of the `lookup_table(...)` statement that declared this table. */
  source: SourceLoc;
}

export interface ParseTableResult {
  data: LookupTableData;
  diagnostics: Diagnostic[];
}

/**
 * Parse a JSON lookup table file. Supports three formats:
 *
 *   1. Plain object              { "key": "value", ... }
 *   2. Array of objects          [ { "key": "k", "value": "v" }, ... ] (also accepts index/k/name)
 *   3. rsyslog-native             { "version":1, "nomatch":"...", "type":"string",
 *                                   "table":[{"index":"...","value":"..."}] }
 *
 * Tolerates bare `NaN`, `Infinity`, `-Infinity` tokens by substituting `null` —
 * some real-world configs ship invalid JSON that downstream tooling accepts.
 *
 * Pure function: no fs/VFS access. The caller provides the already-read `raw`.
 */
export function parseLookupTable(input: ParseTableInput): ParseTableResult {
  const td: LookupTableData = {
    name: input.name,
    filePath: input.filePath,
    loaded: false,
    entries: {},
    size: 0,
    source: input.source
  };
  const diagnostics: Diagnostic[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    try {
      const sanitized = input.raw.replace(/\b(NaN|Infinity|-Infinity)\b/g, 'null');
      parsed = JSON.parse(sanitized);
    } catch (e2) {
      td.error = `Lookup table is not valid JSON: ${(e2 as Error).message}`;
      diagnostics.push({
        severity: 'warning',
        message: td.error,
        source: input.source,
        code: 'W_LOOKUP_PARSE'
      });
      return { data: td, diagnostics };
    }
  }

  // Format 3: rsyslog-native
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as Record<string, unknown>).table)
  ) {
    const obj = parsed as {
      version?: number;
      nomatch?: string;
      type?: string;
      table: { index?: string; value?: string }[];
    };
    td.format = 'rsyslog-native';
    td.nomatch = typeof obj.nomatch === 'string' ? obj.nomatch : undefined;
    for (const row of obj.table) {
      if (typeof row.index === 'string' && typeof row.value === 'string') {
        td.entries[row.index] = row.value;
      }
    }
    td.loaded = true;
    td.size = Object.keys(td.entries).length;
    return { data: td, diagnostics };
  }

  // Format 1: plain object
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    td.format = 'object';
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') td.entries[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') td.entries[k] = String(v);
    }
    td.loaded = true;
    td.size = Object.keys(td.entries).length;
    return { data: td, diagnostics };
  }

  // Format 2: array of objects
  if (Array.isArray(parsed)) {
    td.format = 'array-of-objects';
    let inferredKey: string | undefined;
    let inferredVal: string | undefined;
    const candKey = ['key', 'index', 'k', 'name'];
    const candVal = ['value', 'val', 'v'];
    for (const row of parsed) {
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        if (!inferredKey) for (const c of candKey) if (c in row) { inferredKey = c; break; }
        if (!inferredVal) for (const c of candVal) if (c in row) { inferredVal = c; break; }
      }
    }
    if (!inferredKey || !inferredVal) {
      td.error = 'Could not infer key/value fields in array-of-objects lookup table';
      diagnostics.push({
        severity: 'warning',
        message: td.error,
        source: input.source,
        code: 'W_LOOKUP_INFER'
      });
      return { data: td, diagnostics };
    }
    for (const row of parsed as Record<string, unknown>[]) {
      const k = row[inferredKey];
      const v = row[inferredVal];
      if (typeof k === 'string' && (typeof v === 'string' || typeof v === 'number')) {
        td.entries[k] = String(v);
      }
    }
    td.loaded = true;
    td.size = Object.keys(td.entries).length;
    return { data: td, diagnostics };
  }

  td.error = 'Unsupported lookup table format';
  diagnostics.push({
    severity: 'warning',
    message: td.error,
    source: input.source,
    code: 'W_LOOKUP_UNSUPPORTED'
  });
  return { data: td, diagnostics };
}

/**
 * Query a (parsed) lookup table. Pure; used by both the evaluator (at sim
 * time) and direct API consumers. Returns the table's `nomatch` default
 * when the key is absent, or empty string if no default is set.
 */
export function performLookup(table: LookupTableData | undefined, key: string): LookupResult {
  if (!table || !table.loaded) {
    return { hit: false, value: '', isDefault: false, tableLoaded: false };
  }
  if (key in table.entries) {
    return {
      hit: true,
      value: table.entries[key],
      isDefault: false,
      tableLoaded: true,
      format: table.format
    };
  }
  if (table.nomatch !== undefined) {
    return {
      hit: false,
      value: table.nomatch,
      isDefault: true,
      tableLoaded: true,
      format: table.format
    };
  }
  return { hit: false, value: '', isDefault: false, tableLoaded: true, format: table.format };
}
