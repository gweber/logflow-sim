import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../../src/core/dialects/rsyslog/index.js';
import { replayDiff, buildOverlayedModel } from '../../src/core/replay/diff.js';
import { parseLine } from '../../src/core/replay/parse-line.js';
import { MemoryVFS } from '../../src/core/vfs/memory.js';
import type { SyslogMessage } from '../../src/core/simulate/syslog-message.js';

const BASELINE = `
module(load="imudp")
input(type="imudp" port="514" ruleset="catchall")
ruleset(name="catchall") {
  action(type="omfile" file="/var/log/messages")
}
`;

const OVERLAY = `
module(load="imudp")
input(type="imudp" port="514" ruleset="catchall")
ruleset(name="catchall") {
  if $programname == "sshd" then {
    action(type="omfile" file="/var/log/secure")
    stop
  }
  action(type="omfile" file="/var/log/messages")
}
`;

function buildModel(src: string) {
  return buildIR([parse({ path: 'main.conf', content: src }).ast]);
}

function lines(text: string): SyslogMessage[] {
  const out: SyslogMessage[] = [];
  for (const l of text.split('\n')) {
    const m = parseLine(l);
    if (m) out.push(m);
  }
  return out;
}

describe('replay/diff', () => {
  it('detects route changes between two model variants', () => {
    const baseline = buildModel(BASELINE);
    const overlay = buildModel(OVERLAY);
    const messages = lines(
      [
        'Jun  9 06:06:20 h1 sshd: opened',
        'Jun  9 06:06:21 h1 sshd: closed',
        'Jun  9 06:06:22 h1 kernel: usb 1-1',
        'Jun  9 06:06:23 h1 ftpd: connection'
      ].join('\n')
    );

    const diff = replayDiff({
      baseline: { model: baseline, lookupTables: {} },
      overlay: { model: overlay, lookupTables: {} },
      messages
    });

    // Both processed equally.
    expect(diff.baseline.processed).toBe(4);
    expect(diff.overlay.processed).toBe(4);

    // Two sshd messages route to a different file in overlay.
    expect(diff.routeChanges).toBe(2);
    // None drop off the matched/delivered axis in this scenario.
    expect(diff.movedToUnmatched).toBe(0);
    expect(diff.movedToDelivered).toBe(0);

    const byKey = Object.fromEntries(diff.outputDeltas.map((o) => [o.target, o]));
    expect(byKey['/var/log/secure']).toMatchObject({ baseline: 0, overlay: 2, delta: 2 });
    expect(byKey['/var/log/messages']).toMatchObject({ baseline: 4, overlay: 2, delta: -2 });

    // Route-change samples should reference the sshd messages.
    expect(diff.routeChangeSamples.length).toBeGreaterThan(0);
    expect(diff.routeChangeSamples[0].programname).toBe('sshd');
  });

  it('flags messages moved from delivered to unmatched (input removed)', () => {
    const baseline = buildModel(BASELINE);
    const overlay = buildModel(`
      module(load="imudp")
      input(type="imudp" port="6514" ruleset="catchall")
      ruleset(name="catchall") {
        action(type="omfile" file="/var/log/messages")
      }
    `);
    const messages = lines('Jun  9 06:06:20 h1 sshd: opened');
    const diff = replayDiff({
      baseline: { model: baseline, lookupTables: {} },
      overlay: { model: overlay, lookupTables: {} },
      messages
    });
    expect(diff.movedToUnmatched).toBe(1);
    expect(diff.movedToDelivered).toBe(0);
    expect(diff.overlay.noInputMatch).toBe(1);
  });

  it('buildOverlayedModel applies overlay on top of a VFS', async () => {
    const base = new MemoryVFS({
      '/rsyslog.conf': BASELINE
    });
    const overlayed = await buildOverlayedModel(
      base,
      { 'rsyslog.conf': OVERLAY },
      { entrypoint: '/rsyslog.conf', dialect: 'rsyslog' }
    );
    // The overlaid model should have the sshd-branch ruleset shape.
    // We don't introspect AST here — just verify it parsed and the kernel
    // produced a model with the expected ruleset name + at least one rule.
    expect(overlayed.model.rulesets.length).toBeGreaterThan(0);
    const ruleset = overlayed.model.rulesets[0];
    expect(ruleset.name).toBe('catchall');
    // Baseline has 1 statement, overlay has 2 (the if + the trailing action).
    expect(ruleset.statements.length).toBe(2);
  });
});
