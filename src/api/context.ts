import os from 'node:os';

/**
 * Application paths and per-instance metadata threaded into every router.
 *
 * Kept as a plain object (not a class) so individual route modules can
 * destructure exactly the field they need without binding to a class
 * surface that would invite mocking ceremony.
 */
export interface AppPaths {
  /** Root directory of the active configuration tree (mounted into the container). */
  confRoot: string;
  /** Root for blog/docs markdown content. */
  contentDir: string;
  /** Application version from package.json. Surfaced via `/api/health`. */
  version: string;
}

export function getConfRoot(paths: AppPaths): string {
  return paths.confRoot;
}

/**
 * `os.hostname()` can throw in restricted Node environments; this wrapper
 * never does. Used wherever we need a sensible default for `myhostname` —
 * which is the value the simulator surfaces as `$MYHOSTNAME` in templates.
 */
export function safeHostname(): string {
  try {
    return os.hostname();
  } catch {
    return 'localhost';
  }
}

/**
 * Extract the dialect override from a request's `?dialect=` query.
 * Returns `undefined` when no dialect is selected, which means
 * "auto-detect from the entrypoint file."
 */
export function dialectFromQuery(query: Record<string, unknown>): string | undefined {
  return typeof query.dialect === 'string' ? query.dialect : undefined;
}
