/**
 * Virtual filesystem abstraction.
 *
 * Everything in `src/core/` is pure TypeScript with no Node-specific imports.
 * File access happens through this interface so the same parser, IR, and
 * simulator can run server-side (NodeVFS over real disk), browser-side
 * (IndexedDB or in-memory VFS), or under test (in-memory VFS).
 *
 * Path semantics:
 *   - Paths are POSIX-style ("/" separators) regardless of host OS.
 *   - Absolute paths begin with "/" and address the VFS root.
 *   - Relative paths are resolved by the caller against a base path it owns
 *     — the VFS itself does not resolve "current working directory".
 *
 * Globs use standard "*", "**", "?" and brace expansion. Implementations
 * MUST return results sorted lexicographically so configuration loading is
 * deterministic across hosts.
 */
export interface VFS {
  /** Return the file's content as a UTF-8 string. Throws if missing. */
  readFile(path: string): Promise<string>;

  /** True if the path exists and is a file. */
  exists(path: string): Promise<boolean>;

  /** Expand a glob pattern to a sorted list of absolute VFS paths. */
  glob(pattern: string): Promise<string[]>;

  /** Recursively list every file under `dir`. Used for basename-fallback indexing. */
  list(dir: string): Promise<{ path: string; size: number }[]>;

  /** Best-effort modification timestamp in ms-since-epoch. 0 if unknown. */
  mtime(path: string): Promise<number>;

  /** A label for diagnostics ("node:/app/conf", "browser:project-foo"). */
  readonly label: string;
}

/**
 * Convenience: synchronous flavors are not part of the core contract because
 * the browser VFS will be async-only. Callers must use the async API.
 */
