import { describe, it, expect } from 'vitest';
import { parseRawMessage } from '../src/core/simulate/parse-rawmsg.js';

describe('parseRawMessage', () => {
  describe('RFC 3164', () => {
    it('parses classic <PRI>Mmm DD HH:MM:SS HOST TAG[PID]: MSG', () => {
      const r = parseRawMessage(
        '<134>Oct 11 22:14:15 mymachine sshd[1234]: Failed login for root'
      );
      expect(r.format).toBe('rfc3164');
      expect(r.pri).toBe(134);
      expect(r.facility).toBe(16); // local0
      expect(r.severity).toBe(6); // info
      expect(r.hostname).toBe('mymachine');
      expect(r.programname).toBe('sshd');
      expect(r.procid).toBe('1234');
      expect(r.syslogtag).toBe('sshd[1234]:');
      expect(r.msg).toBe('Failed login for root');
    });

    it('parses without PID', () => {
      const r = parseRawMessage('<13>Oct 11 22:14:15 myhost myprog: hello world');
      expect(r.format).toBe('rfc3164');
      expect(r.programname).toBe('myprog');
      expect(r.procid).toBeUndefined();
      expect(r.syslogtag).toBe('myprog:');
      expect(r.msg).toBe('hello world');
    });

    it('falls back gracefully when TAG is missing', () => {
      const r = parseRawMessage('<13>Oct 11 22:14:15 myhost some unformatted message');
      expect(r.format).toBe('rfc3164');
      expect(r.hostname).toBe('myhost');
      expect(r.msg).toBe('some unformatted message');
    });
  });

  describe('RFC 5424', () => {
    it('parses full <PRI>1 TS HOST APP PROCID MSGID [SD] MSG', () => {
      const r = parseRawMessage(
        '<165>1 2003-10-11T22:14:15.003Z mymachine.example.com evntslog 1234 ID47 [exampleSDID@32473 iut="3" eventSource="App"] BOMAn application event log entry'
      );
      expect(r.format).toBe('rfc5424');
      expect(r.pri).toBe(165);
      expect(r.facility).toBe(20); // local4
      expect(r.severity).toBe(5); // notice
      expect(r.version).toBe(1);
      expect(r.timestamp).toBe('2003-10-11T22:14:15.003Z');
      expect(r.hostname).toBe('mymachine.example.com');
      expect(r.programname).toBe('evntslog');
      expect(r.procid).toBe('1234');
      expect(r.msgid).toBe('ID47');
      expect(r.structured).toEqual({
        'exampleSDID@32473_iut': '3',
        'exampleSDID@32473_eventSource': 'App'
      });
      expect(r.msg).toBe('BOMAn application event log entry');
    });

    it('handles NILVALUE "-" tokens', () => {
      const r = parseRawMessage('<14>1 - - - - - - just a message');
      expect(r.format).toBe('rfc5424');
      expect(r.timestamp).toBeUndefined();
      expect(r.hostname).toBeUndefined();
      expect(r.programname).toBeUndefined();
      expect(r.msg).toBe('just a message');
    });

    it('parses multiple SD blocks', () => {
      const r = parseRawMessage(
        '<14>1 2024-01-01T00:00:00Z host app - - [a@1 x="1"][b@2 y="2"] body'
      );
      expect(r.structured).toEqual({
        'a@1_x': '1',
        'b@2_y': '2'
      });
      expect(r.msg).toBe('body');
    });

    it('strips a leading BOM from the body', () => {
      const r = parseRawMessage('<14>1 - - - - - - ﻿hello');
      expect(r.msg).toBe('hello');
    });
  });

  describe('fallback', () => {
    it('keeps PRI when only that is recognizable', () => {
      const r = parseRawMessage('<7>garbled');
      expect(r.pri).toBe(7);
      expect(r.msg).toBe('garbled');
      expect(r.notes.length).toBeGreaterThan(0);
    });

    it('treats input without <PRI> as msg only', () => {
      const r = parseRawMessage('no framing at all');
      expect(r.format).toBe('unknown');
      expect(r.msg).toBe('no framing at all');
    });

    it('returns a stable object for empty input', () => {
      const r = parseRawMessage('');
      expect(r.format).toBe('unknown');
      expect(r.msg).toBeUndefined();
    });
  });
});
