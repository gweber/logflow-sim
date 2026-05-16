import { describe, it, expect } from 'vitest';
import { parseLine, parseLines } from '../../src/core/replay/parse-line.js';

describe('replay/parse-line', () => {
  it('parses RFC3164 wire form with <PRI>', () => {
    const m = parseLine('<86>Mar 18 15:00:03 host01 sshd[123]: Accepted publickey for root');
    expect(m).not.toBeNull();
    expect(m!.hostname).toBe('host01');
    expect(m!.programname).toBe('sshd');
    expect(m!.syslogtag).toBe('sshd[123]:');
    expect(m!.msg).toContain('Accepted publickey');
    expect(m!.rawmsg).toMatch(/^<86>/);
  });

  it('parses RFC5424 wire form', () => {
    const m = parseLine(
      '<86>1 2019-03-18T15:15:38.467246+01:00 host01 sudo - - -  pam_unix(sudo:session): session closed'
    );
    expect(m).not.toBeNull();
    expect(m!.hostname).toBe('host01');
    expect(m!.programname).toBe('sudo');
  });

  it('parses Loghub-style post-receive lines (no <PRI>)', () => {
    const m = parseLine('Jun  9 06:06:20 combo sshd(pam_unix)[12345]: session opened');
    expect(m).not.toBeNull();
    expect(m!.hostname).toBe('combo');
    expect(m!.programname).toBe('sshd(pam_unix)');
    expect(m!.syslogtag).toBe('sshd(pam_unix)[12345]:');
    expect(m!.msg).toBe('session opened');
    expect(m!.rawmsg).toMatch(/^<13>/); // synthesized default PRI
  });

  it('parses tags with spaces ("syslogd 1.4.1: restart") via the looser fallback', () => {
    const m = parseLine('Jun  9 06:06:20 combo syslogd 1.4.1: restart.');
    expect(m).not.toBeNull();
    expect(m!.hostname).toBe('combo');
    expect(m!.programname).toBe('syslogd'); // first whitespace-bounded token
    expect(m!.syslogtag).toBe('syslogd 1.4.1:');
    expect(m!.msg).toBe('restart.');
  });

  it('handles a line with no tag at all', () => {
    const m = parseLine('this is just some text');
    expect(m).not.toBeNull();
    expect(m!.programname).toBeUndefined();
    expect(m!.msg).toBe('this is just some text');
  });

  it('skips empty and whitespace-only lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   \t')).toBeNull();
  });

  it('parseLines splits on newlines and drops blanks', () => {
    const out = parseLines('Jun  9 06:06:20 combo a: x\n\n<13>Jun  9 06:06:21 combo b: y\n');
    expect(out).toHaveLength(2);
    expect(out[0].programname).toBe('a');
    expect(out[1].programname).toBe('b');
  });
});
