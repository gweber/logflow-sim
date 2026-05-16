import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import type { VFS } from '../core/vfs.js';

/**
 * NodeVFS — VFS backed by a real on-disk directory.
 *
 * VFS-absolute paths ("/", "/etc/rsyslog.d/foo.conf") are resolved against
 * `rootDir`. Path-traversal escapes are rejected by clamping every resolved
 * host path to the root prefix; an attempt to read `/../../etc/passwd` simply
 * raises a "not found" error.
 */
export class NodeVFS implements VFS {
  readonly label: string;

  constructor(public readonly rootDir: string) {
    this.label = `node:${rootDir}`;
  }

  /** Map a VFS path ("/etc/x.conf") to a host filesystem path. */
  toHost(vfsPath: string): string {
    const norm = path.posix.normalize(vfsPath.startsWith('/') ? vfsPath : '/' + vfsPath);
    const host = path.resolve(this.rootDir, '.' + norm);
    const rootResolved = path.resolve(this.rootDir);
    if (host !== rootResolved && !host.startsWith(rootResolved + path.sep)) {
      throw new Error(`Path escapes VFS root: ${vfsPath}`);
    }
    return host;
  }

  /** Map a host path back to a VFS path ("/etc/x.conf"). */
  fromHost(hostPath: string): string {
    const rel = path.relative(this.rootDir, hostPath).split(path.sep).join('/');
    return '/' + rel;
  }

  async readFile(p: string): Promise<string> {
    return fsp.readFile(this.toHost(p), 'utf8');
  }

  async exists(p: string): Promise<boolean> {
    try {
      const st = await fsp.stat(this.toHost(p));
      return st.isFile();
    } catch {
      return false;
    }
  }

  async glob(pattern: string): Promise<string[]> {
    // Translate the VFS-absolute pattern into a host-rooted pattern.
    const hostPattern = this.toHostPattern(pattern);
    const matches = await fg(hostPattern, {
      onlyFiles: true,
      dot: false,
      absolute: true,
      unique: true
    });
    const rootResolved = path.resolve(this.rootDir);
    return matches
      .filter((m) => m === rootResolved || m.startsWith(rootResolved + path.sep))
      .map((m) => this.fromHost(m))
      .sort();
  }

  async list(dir: string): Promise<{ path: string; size: number }[]> {
    const out: { path: string; size: number }[] = [];
    let hostBase: string;
    try {
      hostBase = this.toHost(dir);
    } catch {
      return out;
    }
    if (!fs.existsSync(hostBase)) return out;

    const walk = async (d: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile()) {
          let size = 0;
          try {
            size = (await fsp.stat(full)).size;
          } catch {}
          out.push({ path: this.fromHost(full), size });
        }
      }
    };
    await walk(hostBase);
    return out;
  }

  async mtime(p: string): Promise<number> {
    try {
      const st = await fsp.stat(this.toHost(p));
      return st.mtimeMs;
    } catch {
      return 0;
    }
  }

  /**
   * Recursive max-mtime across the VFS root — used by the server's
   * config-change-detection cache. Synchronous because it's hot-path.
   */
  maxMtimeSync(): number {
    let max = 0;
    const walk = (d: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          try {
            const m = fs.statSync(p).mtimeMs;
            if (m > max) max = m;
          } catch {}
        }
      }
    };
    walk(this.rootDir);
    return max;
  }

  private toHostPattern(vfsPattern: string): string {
    if (!path.posix.isAbsolute(vfsPattern)) {
      throw new Error(`VFS glob pattern must be absolute: ${vfsPattern}`);
    }
    return path.join(this.rootDir, vfsPattern.slice(1)).split(path.sep).join('/');
  }
}
