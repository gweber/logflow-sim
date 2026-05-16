import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLookupTables, performLookup } from '../src/lookups/loader.js';
import { NodeVFS } from '../src/vfs/node.js';
import type { IRLookupTable } from '../src/core/ir/model.js';

function table(name: string, file: string): IRLookupTable {
  return {
    kind: 'LookupTable',
    id: `lt:${name}`,
    name,
    file,
    reloadOnHUP: false,
    params: {},
    source: { file: 't.conf', line: 1, col: 1, offset: 0, length: 0 }
  };
}

function tmpRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rsyslog-lt-'));
  for (const [r, c] of Object.entries(files)) {
    const abs = path.join(root, r);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, c);
  }
  return root;
}

describe('lookup tables', () => {
  it('loads plain JSON object', async () => {
    const root = tmpRoot({ 'lt/plain.json': JSON.stringify({ a: 'A', b: 'B' }) });
    const { data } = await loadLookupTables([table('t', 'lt/plain.json')], new NodeVFS(root));
    expect(data.t.format).toBe('object');
    expect(data.t.entries.a).toBe('A');
    expect(performLookup(data.t, 'a').value).toBe('A');
    expect(performLookup(data.t, 'missing').hit).toBe(false);
  });

  it('loads array-of-objects with inferred keys', async () => {
    const root = tmpRoot({
      'lt/arr.json': JSON.stringify([
        { key: 'k1', value: 'v1' },
        { key: 'k2', value: 'v2' }
      ])
    });
    const { data } = await loadLookupTables([table('t', 'lt/arr.json')], new NodeVFS(root));
    expect(data.t.format).toBe('array-of-objects');
    expect(performLookup(data.t, 'k2').value).toBe('v2');
  });

  it('loads rsyslog-native format with nomatch', async () => {
    const root = tmpRoot({
      'lt/native.json': JSON.stringify({
        version: 1,
        nomatch: 'DEFAULT',
        type: 'string',
        table: [{ index: 'x', value: 'X' }]
      })
    });
    const { data } = await loadLookupTables([table('t', 'lt/native.json')], new NodeVFS(root));
    expect(data.t.format).toBe('rsyslog-native');
    const miss = performLookup(data.t, 'missing');
    expect(miss.value).toBe('DEFAULT');
    expect(miss.isDefault).toBe(true);
  });

  it('reports missing file', async () => {
    const root = tmpRoot({});
    const { data, diagnostics } = await loadLookupTables(
      [table('t', 'lt/missing.json')],
      new NodeVFS(root)
    );
    expect(data.t.loaded).toBe(false);
    expect(diagnostics.some((d) => d.code === 'W_LOOKUP_MISSING')).toBe(true);
  });
});
