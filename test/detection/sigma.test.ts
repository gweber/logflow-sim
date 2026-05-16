import { describe, it, expect } from 'vitest';
import { parseSigma } from '../../src/core/detection/sigma-parser.js';
import { matches } from '../../src/core/detection/sigma-matcher.js';
import { detectionImpact, detectionDiff } from '../../src/core/detection/engine.js';
import type { SyslogMessage } from '../../src/core/simulate/syslog-message.js';

const SSH_FAIL_RULE = `
title: Linux SSH failed root login attempts
id: 11111111-aaaa-aaaa-aaaa-111111111111
logsource:
  product: linux
  service: auth
detection:
  selection:
    programname:
      - sshd
      - 'sshd(pam_unix)'
    msg|contains:
      - 'Failed password'
      - 'authentication failure'
  condition: selection
level: high
tags:
  - attack.credential_access
`;

const KERN_CRASH_RULE = `
title: Linux kernel OOM killer fires
id: 22222222-bbbb-bbbb-bbbb-222222222222
logsource:
  product: linux
detection:
  selection:
    programname: kernel
    msg|contains|i: 'out of memory'
  condition: selection
level: medium
`;

describe('detection/sigma', () => {
  it('parses a Sigma rule with field modifiers', () => {
    const { rules, diagnostics } = parseSigma({ path: 'r.yml', content: SSH_FAIL_RULE });
    expect(diagnostics).toEqual([]);
    expect(rules).toHaveLength(1);
    const r = rules[0];
    expect(r.title).toContain('SSH failed root');
    expect(r.selections).toHaveLength(1);
    const sel = r.selections[0];
    const progField = sel.fields.find((f) => f.name === 'programname')!;
    expect(progField.values).toEqual(['sshd', 'sshd(pam_unix)']);
    const msgField = sel.fields.find((f) => f.name === 'msg')!;
    expect(msgField.modifiers).toContain('contains');
  });

  it('matches an sshd "Failed password" message', () => {
    const { rules } = parseSigma({ path: 'r.yml', content: SSH_FAIL_RULE });
    const m: SyslogMessage = {
      transport: 'udp',
      port: 514,
      programname: 'sshd',
      msg: 'Failed password for root from 1.2.3.4 port 22 ssh2'
    };
    expect(matches(rules[0], { message: m })).toBe(true);
  });

  it('does NOT match an sshd success message', () => {
    const { rules } = parseSigma({ path: 'r.yml', content: SSH_FAIL_RULE });
    const m: SyslogMessage = {
      transport: 'udp',
      port: 514,
      programname: 'sshd',
      msg: 'Accepted publickey for root'
    };
    expect(matches(rules[0], { message: m })).toBe(false);
  });

  it('case-insensitive |i modifier matches', () => {
    const { rules } = parseSigma({ path: 'r.yml', content: KERN_CRASH_RULE });
    const m: SyslogMessage = {
      transport: 'udp',
      port: 514,
      programname: 'kernel',
      msg: 'Out Of Memory: killed process 1234 (httpd)'
    };
    expect(matches(rules[0], { message: m })).toBe(true);
  });

  it('engine counts fires across a batch with samples', () => {
    const { rules } = parseSigma({ path: 'r.yml', content: SSH_FAIL_RULE });
    const messages: SyslogMessage[] = [
      { transport: 'udp', port: 514, programname: 'sshd', msg: 'Failed password for root' },
      { transport: 'udp', port: 514, programname: 'sshd', msg: 'Accepted publickey for root' },
      { transport: 'udp', port: 514, programname: 'sshd(pam_unix)', msg: 'authentication failure; user=root' },
      { transport: 'udp', port: 514, programname: 'kernel', msg: 'usb 1-1 connect' }
    ];
    const report = detectionImpact({ rules, messages });
    expect(report.rules[0].fires).toBe(2);
    expect(report.rules[0].samples).toHaveLength(2);
    expect(report.rules[0].samples[0].programname).toBe('sshd');
  });

  it('diff reports per-rule baseline vs overlay deltas', () => {
    const { rules } = parseSigma({ path: 'r.yml', content: SSH_FAIL_RULE });
    const baseline: SyslogMessage[] = [
      { transport: 'udp', port: 514, programname: 'sshd', msg: 'Failed password for root' },
      { transport: 'udp', port: 514, programname: 'sshd', msg: 'Failed password for admin' }
    ];
    // Simulating: under overlay, `programname` got normalized away from
    // `sshd` for one of them — detection coverage drops.
    const overlay: SyslogMessage[] = [
      { transport: 'udp', port: 514, programname: 'sshd', msg: 'Failed password for root' },
      { transport: 'udp', port: 514, programname: 'other', msg: 'Failed password for admin' }
    ];
    const diff = detectionDiff({ rules, baselineMessages: baseline, overlayMessages: overlay });
    expect(diff.entries[0].baseline).toBe(2);
    expect(diff.entries[0].overlay).toBe(1);
    expect(diff.entries[0].delta).toBe(-1);
    expect(diff.regressionsCount).toBe(1);
  });

  it('skips Windows-only rules silently (product != linux)', () => {
    const rule = `
title: Windows process creation
logsource:
  product: windows
detection:
  selection:
    Image|endswith: '\\\\powershell.exe'
  condition: selection
`;
    const { rules } = parseSigma({ path: 'win.yml', content: rule });
    const m: SyslogMessage = { transport: 'udp', port: 514, msg: '\\powershell.exe -enc XYZ' };
    expect(matches(rules[0], { message: m })).toBe(false);
  });
});
