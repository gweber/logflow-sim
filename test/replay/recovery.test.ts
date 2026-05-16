import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../../src/core/dialects/rsyslog/index.js';
import { replay } from '../../src/core/replay/engine.js';
import { buildOverlayedModel } from '../../src/core/replay/diff.js';
import { MemoryVFS } from '../../src/core/vfs/memory.js';
import { parsePcap } from '../../src/core/replay/parse-pcap.js';
import type { SyslogMessage } from '../../src/core/simulate/syslog-message.js';

/**
 * Recovery-path tests. Every replay/diff entry point must degrade gracefully
 * when the input is malformed — bad pcap headers, broken overlay configs,
 * unparseable rawmsg — without taking the whole batch down.
 */

describe('replay/recovery', () => {
  it('replay engine treats a non-existent forceRuleset as unmatched, not a crash', () => {
    // The simulator is resilient: when forceRuleset names a ruleset that
    // doesn't exist, it returns a noOutput/unmatched result instead of
    // throwing. The replay engine must keep walking the batch either way —
    // a per-message crash recovery path also exists (try/catch inside the
    // engine) but isn't easy to provoke without monkey-patching simulate().
    const model = buildIR([
      parse({
        path: 'main.conf',
        content: `
          module(load="imudp")
          input(type="imudp" port="514" ruleset="catchall")
          ruleset(name="catchall") { action(type="omfile" file="/var/log/messages") }
        `
      }).ast
    ]);
    const messages: SyslogMessage[] = [
      { transport: 'udp', port: 514, msg: 'a' },
      { transport: 'udp', port: 514, msg: 'b' }
    ];
    const report = replay({
      model,
      lookupTables: {},
      messages,
      options: { forceRuleset: 'does_not_exist' }
    });
    // Both messages are processed (no exception escapes the engine).
    expect(report.processed).toBe(2);
    // None should land in `delivered` — the engine reported them as
    // unmatched or no-output rather than crashing the whole batch.
    expect(report.delivered).toBe(0);
    expect(report.noInputMatch + report.noOutput + report.errors).toBe(2);
  });

  it('pcap parser returns a clear diagnostic on truncated headers', () => {
    const out = parsePcap(new Uint8Array([1, 2, 3])); // too short
    expect(out.packets).toEqual([]);
    expect(out.diagnostics.join(' ')).toMatch(/too short/);
  });

  it('pcap parser returns a clear diagnostic on unknown magic', () => {
    const buf = new Uint8Array(32);
    new DataView(buf.buffer).setUint32(0, 0x12345678, true);
    const out = parsePcap(buf);
    expect(out.packets).toEqual([]);
    expect(out.diagnostics.join(' ')).toMatch(/unknown pcap magic/);
  });

  it('buildOverlayedModel surfaces parse diagnostics for syntactically broken overlay', async () => {
    const base = new MemoryVFS({
      '/rsyslog.conf':
        'module(load="imudp")\ninput(type="imudp" port="514" ruleset="r")\n' +
        'ruleset(name="r") { action(type="omfile" file="/var/log/x") }\n'
    });
    const overlayed = await buildOverlayedModel(
      base,
      { 'rsyslog.conf': 'this is not a valid rsyslog config }}}}}{{{ garbage' },
      { entrypoint: '/rsyslog.conf', dialect: 'rsyslog' }
    );
    // We don't require errors specifically — the rsyslog parser is
    // permissive and surfaces unknown constructs as warnings — but we do
    // require *some* diagnostic so the caller has signal that the overlay
    // wasn't a clean parse.
    expect(overlayed.diagnostics.length).toBeGreaterThan(0);
  });
});
