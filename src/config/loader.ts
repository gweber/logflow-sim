import path from 'node:path';
import type { VFS } from '../core/vfs.js';
import { DiagnosticBag } from '../core/diagnostics.js';
import { offsetToLineCol, type SourceLoc } from '../core/source-map.js';
import { resolveInclude } from './include-resolver.js';

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

/**
 * Walk a configuration tree starting at `entrypoint`, following every
 * `include(file=...)` and `$IncludeConfig` directive transitively.
 *
 * All file IO goes through the VFS — works identically on disk-backed
 * (Node) and in-memory (browser) virtual filesystems. Behavior:
 *
 *   - Missing entrypoint -> single error, no files returned.
 *   - Missing include    -> warning, walk continues.
 *   - Glob with zero hits-> info, walk continues.
 *   - Cycle              -> silently de-duplicated by a visited-set.
 *
 * Display names are VFS paths (POSIX-style) so diagnostics are portable
 * between server and browser.
 */
export async function loadConfig(opts: LoadOptions): Promise<LoadResult> {
  const diagnostics = new DiagnosticBag();
  const files: LoadedFile[] = [];
  const visited = new Set<string>();

  if (!(await opts.vfs.exists(opts.entrypoint))) {
    diagnostics.error(
      `Entrypoint config not found: ${opts.entrypoint}`,
      { file: opts.entrypoint, line: 1, col: 1, offset: 0, length: 0 },
      'E_ENTRYPOINT_MISSING'
    );
    return { entrypoint: opts.entrypoint, files, diagnostics };
  }

  await walk(opts.entrypoint, undefined);
  return { entrypoint: opts.entrypoint, files, diagnostics };

  async function walk(absPath: string, includedFrom: SourceLoc | undefined): Promise<void> {
    const normalized = path.posix.normalize(absPath);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    let content: string;
    try {
      content = await opts.vfs.readFile(normalized);
    } catch (e) {
      if (includedFrom) {
        diagnostics.error(
          `Failed to read included file: ${normalized}: ${(e as Error).message}`,
          includedFrom,
          'E_READ_FAIL'
        );
      }
      return;
    }
    files.push({ path: normalized, content, includedFrom });

    // Pre-scan for includes — the parser will see them too, but resolving
    // them here lets us walk the tree breadth-first before parsing kicks in.
    INCLUDE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INCLUDE_RE.exec(content)) !== null) {
      const matchStart = m.index + (m[1]?.length ?? 0);
      const spec = m[2] ?? m[3]?.trim();
      if (!spec) continue;
      const { line, col } = offsetToLineCol(content, matchStart);
      const loc: SourceLoc = {
        file: normalized,
        line,
        col,
        offset: matchStart,
        length: m[0].length - (m[1]?.length ?? 0)
      };
      const result = await resolveInclude(spec, normalized, opts.vfs);
      if (result.missing) {
        diagnostics.warning(
          `Include not found: ${spec}` +
            (result.mappedFromAbsolute ? ` (mapped from ${result.mappedFromAbsolute})` : ''),
          loc,
          'W_INCLUDE_MISSING'
        );
        continue;
      }
      if (result.files.length === 0) {
        diagnostics.info(
          `Include glob matched no files: ${spec}`,
          loc,
          'I_INCLUDE_EMPTY_GLOB'
        );
        continue;
      }
      for (const f of result.files) await walk(f, loc);
    }
  }
}
