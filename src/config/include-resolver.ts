import path from 'node:path';
import type { VFS } from '../core/vfs.js';

export interface ResolveResult {
  files: string[];
  missing: boolean;
  mappedFromAbsolute?: string;
}

const ETC_PREFIX = '/etc/';

/**
 * Resolve an include spec into concrete VFS paths.
 *
 * - Absolute `/etc/...` paths are kept absolute against the VFS root.
 *   In the NodeVFS, the VFS root *is* `conf/`, so `/etc/rsyslog.d/x.conf`
 *   becomes `${confRoot}/etc/rsyslog.d/x.conf` automatically.
 * - Relative paths are resolved against the directory of the including file.
 * - Glob patterns are expanded; results are sorted deterministically by VFS.glob().
 */
export async function resolveInclude(
  spec: string,
  currentFile: string,
  vfs: VFS
): Promise<ResolveResult> {
  let pattern: string;
  let mappedFromAbsolute: string | undefined;

  if (path.posix.isAbsolute(spec)) {
    pattern = spec.startsWith(ETC_PREFIX) ? spec : spec;
    mappedFromAbsolute = spec;
  } else {
    pattern = path.posix.resolve(path.posix.dirname(currentFile), spec);
  }

  // Glob expansion (VFS.glob guarantees sorted output).
  const matches = await vfs.glob(pattern);
  if (matches.length > 0) return { files: matches, missing: false, mappedFromAbsolute };

  // No matches. Distinguish "literal missing file" from "glob with zero hits".
  const hasMagic = /[*?[\]{}]/.test(pattern);
  if (!hasMagic) {
    const exists = await vfs.exists(pattern);
    return { files: [], missing: !exists, mappedFromAbsolute };
  }
  return { files: [], missing: false, mappedFromAbsolute };
}
