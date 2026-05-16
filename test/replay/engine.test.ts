import { describe, it, expect } from 'vitest';
import { parse, buildIR } from '../../src/core/dialects/rsyslog/index.js';
import { replay } from '../../src/core/replay/engine.js';
import { parseLine } from '../../src/core/replay/parse-line.js';
import type { SyslogMessage } from '../../src/core/simulate/syslog-message.js';

const CONF = `
module(load="imudp")
input(type="imudp" port="514" ruleset="catchall")

ruleset(name="catchall") {
  if $programname == "sshd" then {
    action(type="omfile" file="/var/log/secure")
    stop
  }
  if $programname == "kernel" then {
    action(type="omfile" file="/var/log/kern.log")
    stop
  }
  action(type="omfile" file="/var/log/messages")
}
`;

function buildModel() {
  const ast = parse({ path: 'main.conf', content: CONF }).ast;
  return buildIR([ast]);
}

function lines(text: string): SyslogMessage[] {
  const out: SyslogMessage[] = [];
  for (const l of text.split('\n')) {
    const m = parseLine(l);
    if (m) out.push(m);
  }
  return out;
}

describe('replay/engine', () => {
  it('aggregates routing across programs', () => {
    const model = buildModel();
    const messages = lines(
      [
        'Jun  9 06:06:20 host1 sshd: opened',
        'Jun  9 06:06:21 host1 sshd: closed',
        'Jun  9 06:06:22 host2 kernel: usb 1-1 disconnect',
        'Jun  9 06:06:23 host1 ntpd: drift',
        'Jun  9 06:06:24 host1 ftpd: connection'
      ].join('\n')
    );
    const report = replay({ model, lookupTables: {}, messages });
    expect(report.processed).toBe(5);
    expect(report.delivered).toBe(5);
    expect(report.errors).toBe(0);

    const byKey = Object.fromEntries(report.perOutput.map((o) => [o.target, o.count]));
    expect(byKey['/var/log/secure']).toBe(2);
    expect(byKey['/var/log/kern.log']).toBe(1);
    expect(byKey['/var/log/messages']).toBe(2);

    const programs = Object.fromEntries(report.topPrograms.map((p) => [p.key, p.count]));
    expect(programs['sshd']).toBe(2);
    expect(programs['kernel']).toBe(1);
  });

  it('captures unmatched messages when no input fires', () => {
    const ast = parse({
      path: 'main.conf',
      content: `
        module(load="imudp")
        input(type="imudp" port="6514" ruleset="catchall")
        ruleset(name="catchall") { action(type="omfile" file="/var/log/all") }
      `
    }).ast;
    const model = buildIR([ast]);
    const messages: SyslogMessage[] = [
      { transport: 'udp', port: 514, programname: 'foo', msg: 'x' }
    ];
    const report = replay({ model, lookupTables: {}, messages });
    expect(report.noInputMatch).toBe(1);
    expect(report.delivered).toBe(0);
    expect(report.unmatchedSamples).toHaveLength(1);
  });

  it('honors maxMessages cap', () => {
    const model = buildModel();
    const messages = Array.from({ length: 100 }, (_, i) => parseLine(
      `Jun  9 06:06:20 host${i} sshd: x`
    )!);
    const report = replay({ model, lookupTables: {}, messages, options: { maxMessages: 25 } });
    expect(report.total).toBe(100);
    expect(report.processed).toBe(25);
    expect(report.delivered).toBe(25);
  });
});
