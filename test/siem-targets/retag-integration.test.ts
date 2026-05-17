import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeVFS } from '../../src/vfs/node.js';
import { load, convert, retag } from '../../src/core/kernel.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'siem-retag-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/**
 * Bootstrap a minimal Splunk-style rsyslog config with a sourcetype lookup.
 * Returns the loaded kernel result.
 *
 * For round-trip data assertions we convert to **filebeat**, which inlines
 * the lookup-table contents directly into the emitted config — making the
 * retag effect visible in the primary output. The rsyslog → rsyslog path
 * keeps the lookup as a separate file reference, which is correct but
 * harder to assert against.
 */
async function loadSplunkLikeConfig() {
  write(
    'lookups/st.json',
    JSON.stringify({
      version: 1,
      nomatch: 'network:unclassified',
      type: 'string',
      table: [
        { index: 'sshd', value: 'linux:secure' },
        { index: 'nginx', value: 'nginx:access' },
        { index: 'named', value: 'bind:query' }
      ]
    })
  );
  write(
    'rsyslog.conf',
    `
module(load="imudp")
lookup_table(name="st" file="lookups/st.json")
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
  set $!sourcetype = lookup("st", $programname);
  action(type="omfile" file="/var/log/messages")
}
`
  );
  return await load(new NodeVFS(root), { entrypoint: '/rsyslog.conf' });
}

describe('convert + retag end-to-end', () => {
  it('no SIEM options → pipeline-only conversion, values verbatim', async () => {
    const ctx = await loadSplunkLikeConfig();
    const result = convert(ctx.model, 'filebeat', { lookupTables: ctx.lookupTables });
    expect(result.sourceSiem).toBeUndefined();
    expect(result.targetSiem).toBeUndefined();
    // Splunk values should be untouched in the emitted filebeat config
    expect(result.output).toContain('linux:secure');
    expect(result.output).toContain('nginx:access');
  });

  it('same source and target SIEM → fast path, values preserved verbatim', async () => {
    const ctx = await loadSplunkLikeConfig();
    const result = convert(ctx.model, 'filebeat', {
      lookupTables: ctx.lookupTables,
      sourceSiem: 'splunk',
      targetSiem: 'splunk'
    });
    expect(result.sourceSiem).toBe('splunk');
    expect(result.targetSiem).toBe('splunk');
    expect(result.output).toContain('linux:secure');
  });

  it('retag to generic preserves originals + emits lossy diagnostic', async () => {
    const ctx = await loadSplunkLikeConfig();
    const result = convert(ctx.model, 'filebeat', {
      lookupTables: ctx.lookupTables,
      sourceSiem: 'splunk',
      targetSiem: 'generic'
    });
    expect(result.sourceSiem).toBe('splunk');
    expect(result.targetSiem).toBe('generic');
    // generic has no taxonomy → every entry is lossy; values fall back
    // to the original Splunk strings.
    const lossy = result.diagnostics.find((d) => d.code === 'SIEM_VALUE_LOSSY');
    expect(lossy).toBeDefined();
    expect(result.output).toContain('linux:secure');
  });

  it('only targetSiem set → auto-detect runs (falls back warned for plain omfile)', async () => {
    const ctx = await loadSplunkLikeConfig();
    // This config's only output is omfile — not a known SIEM driver, so
    // detection should fail and we fall back to "generic" with a warning.
    const result = convert(ctx.model, 'filebeat', {
      lookupTables: ctx.lookupTables,
      targetSiem: 'elastic-ecs'
    });
    expect(result.sourceSiem).toBe('generic');
    expect(result.targetSiem).toBe('elastic-ecs');
    const warned = result.diagnostics.find((d) => d.code === 'SIEM_SOURCE_UNDETECTED');
    expect(warned).toBeDefined();
  });

  it('only sourceSiem set → no-op warning', async () => {
    const ctx = await loadSplunkLikeConfig();
    const result = convert(ctx.model, 'filebeat', {
      lookupTables: ctx.lookupTables,
      sourceSiem: 'splunk'
    });
    expect(result.targetSiem).toBeUndefined();
    const warned = result.diagnostics.find((d) => d.code === 'SIEM_SOURCE_WITHOUT_TARGET');
    expect(warned).toBeDefined();
  });

  it('untagged lookup tables flow through unchanged across retag', async () => {
    write(
      'lookups/plain.json',
      JSON.stringify({
        version: 1,
        nomatch: '',
        type: 'string',
        table: [{ index: 'a', value: 'kept-as-is' }]
      })
    );
    write(
      'rsyslog.conf',
      `
module(load="imudp")
lookup_table(name="plain" file="lookups/plain.json")
input(type="imudp" port="514" ruleset="r")
ruleset(name="r") {
  set $!unrelated = lookup("plain", $programname);
  action(type="omfile" file="/var/log/x")
}
`
    );
    const ctx = await load(new NodeVFS(root), { entrypoint: '/rsyslog.conf' });
    const result = convert(ctx.model, 'filebeat', {
      lookupTables: ctx.lookupTables,
      sourceSiem: 'splunk',
      targetSiem: 'elastic-ecs'
    });
    // The plain table isn't tagged with a known taxonomy → flows through
    // verbatim regardless of the source/target SIEMs.
    expect(result.output).toContain('kept-as-is');
  });

  it('rejects unknown SIEM ids', async () => {
    const ctx = await loadSplunkLikeConfig();
    expect(() =>
      convert(ctx.model, 'filebeat', {
        lookupTables: ctx.lookupTables,
        targetSiem: 'nope'
      })
    ).toThrow(/Unknown target SIEM/);
    expect(() =>
      convert(ctx.model, 'filebeat', {
        lookupTables: ctx.lookupTables,
        sourceSiem: 'nope',
        targetSiem: 'splunk'
      })
    ).toThrow(/Unknown source SIEM/);
  });

  it('retag() keeps the source dialect', async () => {
    const ctx = await loadSplunkLikeConfig();
    const result = retag(ctx.model, {
      lookupTables: ctx.lookupTables,
      sourceSiem: 'splunk',
      targetSiem: 'generic'
    });
    expect(result.targetDialect).toBe('rsyslog');
    expect(result.targetSiem).toBe('generic');
  });
});
