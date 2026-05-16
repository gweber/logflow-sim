import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/loader.js';
import { NodeVFS } from '../src/vfs/node.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsyslog-loader-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const vfsFor = () => new NodeVFS(root);
const stripLead = (p: string) => p.replace(/^\/+/, '');

describe('config loader', () => {
  it('resolves include globs deterministically', async () => {
    write('rsyslog.conf', 'include(file="etc/rsyslog.d/*.conf")\n');
    write('etc/rsyslog.d/30-z.conf', '# z\n');
    write('etc/rsyslog.d/10-a.conf', '# a\n');
    write('etc/rsyslog.d/20-m.conf', '# m\n');
    const r = await loadConfig({ vfs: vfsFor(), entrypoint: '/rsyslog.conf' });
    const paths = r.files.map((f) => stripLead(f.path));
    expect(paths[0]).toBe('rsyslog.conf');
    expect(paths.slice(1)).toEqual([
      'etc/rsyslog.d/10-a.conf',
      'etc/rsyslog.d/20-m.conf',
      'etc/rsyslog.d/30-z.conf'
    ]);
  });

  it('maps absolute /etc/... include paths into VFS root', async () => {
    write('rsyslog.conf', 'include(file="/etc/rsyslog.d/x.conf")\n');
    write('etc/rsyslog.d/x.conf', '# x\n');
    const r = await loadConfig({ vfs: vfsFor(), entrypoint: '/rsyslog.conf' });
    expect(r.files.map((f) => stripLead(f.path))).toEqual([
      'rsyslog.conf',
      'etc/rsyslog.d/x.conf'
    ]);
  });

  it('reports missing includes as warnings without crashing', async () => {
    write('rsyslog.conf', 'include(file="/etc/rsyslog.d/nope.conf")\n');
    const r = await loadConfig({ vfs: vfsFor(), entrypoint: '/rsyslog.conf' });
    expect(r.diagnostics.items.some((d) => d.code === 'W_INCLUDE_MISSING')).toBe(true);
  });

  it('errors when entrypoint is missing', async () => {
    const r = await loadConfig({ vfs: vfsFor(), entrypoint: '/nope.conf' });
    expect(r.diagnostics.items.some((d) => d.code === 'E_ENTRYPOINT_MISSING')).toBe(true);
  });

  it('handles $IncludeConfig legacy syntax', async () => {
    write('rsyslog.conf', '$IncludeConfig etc/rsyslog.d/legacy.conf\n');
    write('etc/rsyslog.d/legacy.conf', '# legacy\n');
    const r = await loadConfig({ vfs: vfsFor(), entrypoint: '/rsyslog.conf' });
    expect(r.files.map((f) => stripLead(f.path))).toContain('etc/rsyslog.d/legacy.conf');
  });
});
