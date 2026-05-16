import type { VFS } from './vfs.js';
import { DiagnosticBag } from './diagnostics.js';
import { offsetToLineCol, type SourceLoc } from './source-map.js';
import { resolve, dirname, isAbsolute, normalize } from './path.js';

/**
 * Generic dialect-agnostic configuration loader.
 *
 * Walks the file referenced by `entrypoint`, follows any `include(file=…)`
 * and `$IncludeConfig` directives transitively, and returns a flattened
 * `{path, content, includedFrom}` list ready for a dialect parser.
 *
 * Include resolution:
 *   - Absolute paths (`/etc/rsyslog.d/x.conf`) are kept absolute against the
 *     VFS root; NodeVFS happens to translate `/foo` into `<confRoot>/foo`,
 *     MemoryVFS uses them as-is.
 *   - Relative paths resolve against the directory of the including file.
 *   - Glob patterns (e.g. `*.conf` or recursive `**` patterns) are expanded via `vfs.glob()`,
 *     which returns sorted results so the load order is deterministic.
 *
 * Missing includes produce a warning, not an error — rsyslog itself does the
 * same. Cycles are silently broken via a visited-set.
 */

export interface LoadedFile {
  /** VFS-absolute path of the file (used as display name in diagnostics). */
  path: string;
  content: string;
  /** Source location of the include that pulled this file in (undefined for entrypoint). */
  includedFrom?: SourceLoc;
}

export interface LoadOptions {
  vfs: VFS;
  /** VFS path of the entrypoint, e.g. "/rsyslog.conf". */
  entrypoint: string;
}

export interface LoadResult {
  entrypoint: string;
  files: LoadedFile[];
  diagnostics: DiagnosticBag;
}

const INCLUDE_RE =
  /(^|\n)[ \t]*(?:include\s*\(\s*file\s*=\s*"([^"]+)"\s*\)|\$IncludeConfig[ \t]+([^\n#]+))/g;

const ETC_PREFIX = '/etc/';

export async function loadConfigViaVFS(opts: LoadOptions): Promise<LoadResult> {
  const diagnostics = new DiagnosticBag();
  const files: LoadedFile[] = [];
  const visited = new Set<string>();

  const entry = opts.entrypoint.startsWith('/') ? opts.entrypoint : '/' + opts.entrypoint;
  if (!(await opts.vfs.exists(entry))) {
    diagnostics.error(
      `Entrypoint config not found: ${opts.entrypoint}`,
      { file: entry, line: 1, col: 1, offset: 0, length: 0 },
      'E_ENTRYPOINT_MISSING'
    );
    return { entrypoint: entry, files, diagnostics };
  }

  await walk(entry, undefined);
  return { entrypoint: entry, files, diagnostics };

  async function walk(absPath: string, includedFrom: SourceLoc | undefined): Promise<void> {
    const norm = normalize(absPath);
    if (visited.has(norm)) return;
    visited.add(norm);

    let content: string;
    try {
      content = await opts.vfs.readFile(norm);
    } catch (e) {
      if (includedFrom) {
        diagnostics.error(
          `Failed to read included file: ${norm}: ${(e as Error).message}`,
          includedFrom,
          'E_READ_FAIL'
        );
      }
      return;
    }
    files.push({ path: norm, content, includedFrom });

    INCLUDE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INCLUDE_RE.exec(content)) !== null) {
      const matchStart = m.index + (m[1]?.length ?? 0);
      const spec = m[2] ?? m[3]?.trim();
      if (!spec) continue;
      const { line, col } = offsetToLineCol(content, matchStart);
      const loc: SourceLoc = {
        file: norm,
        line,
        col,
        offset: matchStart,
        length: m[0].length - (m[1]?.length ?? 0)
      };
      const resolved = await resolveInclude(spec, norm, opts.vfs);
      if (resolved.missing) {
        const detail = resolved.mappedFromAbsolute
          ? ' (mapped from ' + resolved.mappedFromAbsolute + ')'
          : '';
        diagnostics.warning(
          'Include not found: ' + spec + detail,
          loc,
          'W_INCLUDE_MISSING'
        );
        continue;
      }
      if (resolved.files.length === 0) {
        diagnostics.info(
          `Include glob matched no files: ${spec}`,
          loc,
          'I_INCLUDE_EMPTY_GLOB'
        );
        continue;
      }
      for (const f of resolved.files) await walk(f, loc);
    }
  }
}

interface ResolveResult {
  files: string[];
  missing: boolean;
  mappedFromAbsolute?: string;
}

async function resolveInclude(spec: string, currentFile: string, vfs: VFS): Promise<ResolveResult> {
  let pattern: string;
  let mappedFromAbsolute: string | undefined;
  if (isAbsolute(spec)) {
    pattern = spec.startsWith(ETC_PREFIX) ? spec : spec;
    mappedFromAbsolute = spec;
  } else {
    pattern = resolve(dirname(currentFile), spec);
  }
  const matches = await vfs.glob(pattern);
  if (matches.length > 0) return { files: matches, missing: false, mappedFromAbsolute };
  const hasMagic = /[*?[\]{}]/.test(pattern);
  if (!hasMagic) {
    const exists = await vfs.exists(pattern);
    return { files: [], missing: !exists, mappedFromAbsolute };
  }
  return { files: [], missing: false, mappedFromAbsolute };
}
